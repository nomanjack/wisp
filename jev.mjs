// Local-only API used by tools/focus-track.html.
//   POST /api/focus/box   { jpegBase64, mock? }      -> { box:{top,bottom,left,right}, confidence }
//   POST /api/focus/save  { scene, track }           -> writes assets/<scene>.focus.json
// The TypeSafe key is read from the environment (or .env.local) and never sent to the browser.
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-1.14.0';   // pinned: Box questions need 1.14; aliases can move under us
const PLACEHOLDER = 'asset_9c41e2';

function loadKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY.trim();
  const file = root + '.env.local';
  if (!existsSync(file)) return '';
  const m = /^\s*TYPESAFE_API_KEY\s*=\s*"?([^"\n]+)"?/m.exec(readFileSync(file, 'utf8'));
  return m ? m[1].trim() : '';
}

const INSTRUCTIONS =
  'Find the main subject of this video frame: the region a viewer looks at first. ' +
  'Include the whole subject (an entire face or person, a whole landmark, a full horizon feature), ' +
  'not just its brightest part. If nothing stands out, box the area with the most detail.';

async function askJev(jpegBase64, key) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'TypeSafe-Danger-Zone-Images': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      state: `A single frame from a video is attached: ${PLACEHOLDER}`,
      assets: {[PLACEHOLDER]: {type: 'image', format: 'jpeg', data_base64: jpegBase64}},
      questions: {
        subject: {type: 'box', instructions: INSTRUCTIONS},
        // Box can't answer "none", so ask whether a living/moving subject exists before trusting its box.
        has_actor: {type: 'noul', instructions: 'Is there at least one person, animal, or vehicle visible anywhere in this frame, even if it is very small?'},
        has_text: {type: 'noul', instructions: 'Is there any readable on-screen text, caption, subtitle, watermark, or logo in this frame?'},
        text: {type: 'box', instructions: 'Find the on-screen text, caption, subtitle, watermark, or logo in this frame. If there are several, use one box that contains all of them.'},
        actor: {type: 'box', instructions: 'Find the single person, animal, or vehicle that is farthest from the center of this frame, even if it is very small. Draw a tight box around just that one, not the scenery around it.'},
      },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`TypeSafe ${res.status}: ${text.slice(0, 400)}`), {status: res.status});
  const data = JSON.parse(text);
  const a = data.answers?.subject;
  if (!a?.box) throw new Error(`Unexpected response: ${text.slice(0, 400)}`);
  const has = data.answers?.has_actor, actor = data.answers?.actor;
  // Noul answer shape isn't documented in what we read; accept the plausible forms and keep the raw value.
  const v = has && (has.answer ?? has.value ?? has.result ?? has.noul);
  const hasActor = v === true || v === 'yes' || v === 'true' || (typeof v === 'number' && v >= .5);
  const ht = data.answers?.has_text, tx = data.answers?.text;
  const hasText = typeof ht?.noul === 'number' ? ht.noul >= .5 : false;
  return {text: hasText && tx?.box ? {box: tx.box, confidence: tx.confidence ?? null, p: ht.noul} : null, box: a.box, confidence: a.confidence ?? null, model: data.model, usage: data.usage,
          actor: hasActor && actor?.box ? {box: actor.box, confidence: actor.confidence ?? null} : null,
          rawHasActor: has};
}

// Named subjects (dense multi-subject tracks for a hero clip): for each described subject, ask whether it's
// visible and for a tight box around it, so every subject keeps its own slot over time.
async function askJevSubjects(jpegBase64, key, subjects) {
  const questions = {};
  for (const {id, describe} of subjects) {
    questions[`${id}_seen`] = {type: 'noul', instructions: `Is ${describe} visible anywhere in this frame, even partly (an arm, a leg, part of the body at the edge)?`};
    questions[`${id}_box`] = {type: 'box', instructions: `Draw a tight box around ${describe}: every visible part of them, head to feet, including arms and legs cut off by the frame edge. Not the scenery around them.`};
  }
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'TypeSafe-Danger-Zone-Images': 'true'},
    body: JSON.stringify({model: MODEL, state: `A single frame from a video is attached: ${PLACEHOLDER}`,
      assets: {[PLACEHOLDER]: {type: 'image', format: 'jpeg', data_base64: jpegBase64}}, questions}),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`TypeSafe ${res.status}: ${text.slice(0, 400)}`), {status: res.status});
  const a = JSON.parse(text).answers || {};
  return {subjects: subjects.map(({id}) => ({id, p: typeof a[`${id}_seen`]?.noul === 'number' ? a[`${id}_seen`].noul : null, box: a[`${id}_box`]?.box ?? null, confidence: a[`${id}_box`]?.confidence ?? null}))};
}


// QA judge (tools/qa.js): Jev checks the player's output. Two images of the same moment: the original video frame
// and what the player shows (fades, notches, halo). From the original it finds what matters (fresh, independent of
// the stored track); on the player image it judges what a viewer would notice. The renderer's own mask then says
// exactly how visible each found box is, so "is the subject covered" is measured, not guessed.
const ORIG = 'asset_orig_51d2', SHOWN = 'asset_shown_7be0';
async function askJevJudge(origB64, shownB64, key) {
  const q = (type, instructions) => ({type, instructions});
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'TypeSafe-Danger-Zone-Images': 'true'},
    body: JSON.stringify({model: MODEL,
      state: `Two images of the same video moment. ${ORIG} is the original frame. ${SHOWN} is how a video player displays it: the picture's edges dissolve into a soft haze on purpose, and the haze should open up around people and the main subject.`,
      assets: {[ORIG]: {type: 'image', format: 'jpeg', data_base64: origB64}, [SHOWN]: {type: 'image', format: 'jpeg', data_base64: shownB64}},
      questions: {
        subject: q('box', `In ${ORIG}, find the main subject: the region a viewer looks at first. Include the whole subject (an entire person, animal or object), not just its brightest part.`),
        has_actor: q('noul', `In ${ORIG}, is there at least one person, animal, or vehicle visible, even if small or partly cut off by the frame edge?`),
        actor: q('box', `In ${ORIG}, find the person, animal, or vehicle that is closest to any edge of the frame (the one most at risk of being cut off). Tight box around just that one.`),
        has_face: q('noul', `In ${ORIG}, is any human face visible (at least partly)?`),
        face: q('box', `In ${ORIG}, find the human face closest to any edge of the frame. Tight box around the head.`),
        hazed: q('noul', `Compare ${SHOWN} with ${ORIG}. In ${SHOWN}, is any person, animal, face, or the main subject noticeably washed out, hazed over, or faded compared with ${ORIG}? Ignore small bits right at the very border such as a hand or foot leaving the frame.`),
        dreamy: q('noul', `Does ${SHOWN} keep soft, dreamy, faded edges (the picture dissolves gently into the surroundings on most of its border) rather than looking like a plain sharp rectangle?`),
        seam: q('noul', `In ${SHOWN}, is there any visible hard line, seam, ring, or sharp-edged hole in the haze?`),
      }}),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`TypeSafe ${res.status}: ${text.slice(0, 400)}`), {status: res.status});
  const a = JSON.parse(text).answers || {}, p = k => typeof a[k]?.noul === 'number' ? a[k].noul : null, box = k => a[k]?.box ?? null;
  return {subject: box('subject'), actor: p('has_actor') >= .5 ? box('actor') : null, face: p('has_face') >= .5 ? box('face') : null,
    p: {actor: p('has_actor'), face: p('has_face'), hazed: p('hazed'), dreamy: p('dreamy'), seam: p('seam')}};
}

// Plumbing test without a key: a box that drifts slowly so the player visibly reacts.
function mockBox(t = 0) {
  const x = .5 + .3 * Math.sin(t / 3), y = .45 + .2 * Math.cos(t / 4);
  return {box: {top: y - .2, bottom: y + .2, left: x - .18, right: x + .18}, confidence: null, model: 'mock'};
}

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((ok, fail) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { fail(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { fail(e); } });
    req.on('error', fail);
  });
}

const send = (res, code, obj) => { res.writeHead(code, {'Content-Type': 'application/json'}); res.end(JSON.stringify(obj)); };

export async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/focus/status') return send(res, 200, {hasKey: !!loadKey(), model: MODEL});
  if (req.method !== 'POST') return send(res, 405, {error: 'POST only'});
  // Debug: save a recorded stress scene (raw video bytes) as assets/<name>.<mp4|webm>.
  if (pathname === '/api/debug/video') {
    const u = new URL(req.url, 'http://localhost'), name = u.searchParams.get('name') || '', ext = u.searchParams.get('ext') || '';
    if (!/^stress-[a-z0-9-]{1,40}$/.test(name) || !['mp4', 'webm'].includes(ext)) return send(res, 400, {error: 'bad name'});
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 80 * 1024 * 1024) return send(res, 413, {error: 'too large'}); chunks.push(c); }
    writeFileSync(root + `assets/${name}.${ext}`, Buffer.concat(chunks));
    return send(res, 200, {saved: `assets/${name}.${ext}`, bytes: size});
  }
  try {
    const body = await readBody(req);
    if (pathname === '/api/focus/box') {
      if (body.mock) return send(res, 200, mockBox(body.t));
      const key = loadKey();
      if (!key) return send(res, 400, {error: 'No TYPESAFE_API_KEY. Add it to .env.local and restart the server.'});
      if (typeof body.jpegBase64 !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(body.jpegBase64)) return send(res, 400, {error: 'jpegBase64 must be plain base64'});
      return send(res, 200, await askJev(body.jpegBase64, key));
    }
    if (pathname === '/api/focus/subjects') {
      const key = loadKey();
      if (!key) return send(res, 400, {error: 'No TYPESAFE_API_KEY. Add it to .env.local and restart the server.'});
      if (typeof body.jpegBase64 !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(body.jpegBase64)) return send(res, 400, {error: 'jpegBase64 must be plain base64'});
      const subs = Array.isArray(body.subjects) ? body.subjects.slice(0, 4).filter(x => /^[a-z]{1,20}$/.test(x?.id ?? '') && typeof x.describe === 'string' && x.describe.length < 200) : [];
      if (!subs.length) return send(res, 400, {error: 'subjects: [{id, describe}] required'});
      return send(res, 200, await askJevSubjects(body.jpegBase64, key, subs));
    }
    if (pathname === '/api/qa/judge') {
      const key = loadKey();
      if (!key) return send(res, 400, {error: 'No TYPESAFE_API_KEY. Add it to .env.local and restart the server.'});
      const ok = v => typeof v === 'string' && /^[A-Za-z0-9+/=]+$/.test(v);
      if (!ok(body.original) || !ok(body.shown)) return send(res, 400, {error: 'original and shown must be plain base64 JPEG'});
      return send(res, 200, await askJevJudge(body.original, body.shown, key));
    }
    // Debug: save a rendered preview frame (data URL) under tools/snaps/ for review.
    if (pathname === '/api/debug/snap') {
      if (!/^[a-z0-9-]{1,60}$/.test(body.name ?? '') || !/^data:image\/(jpeg|png);base64,/.test(body.dataUrl ?? '')) return send(res, 400, {error: 'bad snap'});
      const {mkdirSync} = await import('node:fs');
      mkdirSync(root + 'tools/snaps', {recursive: true});
      const ext = body.dataUrl.startsWith('data:image/png') ? 'png' : 'jpg';
      writeFileSync(root + `tools/snaps/${body.name}.${ext}`, Buffer.from(body.dataUrl.split(',')[1], 'base64'));
      return send(res, 200, {saved: `tools/snaps/${body.name}.${ext}`});
    }
    if (pathname === '/api/focus/save') {
      if (!/^[a-z0-9-]{1,40}$/.test(body.scene ?? '')) return send(res, 400, {error: 'Bad scene name'});
      if (!Array.isArray(body.track?.samples)) return send(res, 400, {error: 'track.samples missing'});
      const file = `assets/${body.scene}.focus.json`;
      writeFileSync(root + file, JSON.stringify(body.track, null, 1));
      return send(res, 200, {saved: file, samples: body.track.samples.length});
    }
    send(res, 404, {error: 'Unknown route'});
  } catch (e) {
    send(res, e.status === 401 || e.status === 403 ? e.status : 500, {error: String(e.message || e)});
  }
}
