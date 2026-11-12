// Wisp QA: does every video get the Chase treatment? (dev only; open the player with /?debug)
//
// For each scene it plays the whole clip through the real player on a virtual clock (tools/record.js) and runs:
//   measured, every frame (free) ........ calm motion, dreamy edges kept, no hard edges, smooth start
//   Jev, on a few chosen frames (paid) .. Jev looks at the ORIGINAL frame and finds the main subject, the person
//                                         or animal nearest an edge, and the face nearest an edge. The renderer's
//                                         own maths (visAt) then says how visible each one is in the player.
//                                         Jev also gives a second opinion on the PLAYER image (washed out? dreamy?
//                                         seams?), calibrated against Chase, the reference.
//   track ............................... how dense the Jev track is (Chase: 10 samples/s, named subjects)
// Frames for Jev are chosen smartly: the moments the track says a subject is closest to an edge or least visible,
// plus evenly spaced ones, so ~4 calls cover a clip.
//
// Usage: const {runQA} = await import('/tools/qa.js'); await runQA()            (all scenes)
//        await runQA({scenes: ['chase', 'redtop'], jevFrames: 4})
// Report: /tools/qa.html (reads tools/snaps/qa-report.json and the qa-*.jpg frames)
import {analyse, visAt} from './motion-audit.js';

// The checklist. Each check: what it means, how it's measured, and the bar to pass.
export const CHECKLIST = [
  {id: 'subject', name: 'Subject never covered', how: 'Jev finds the main subject in the original frame; the mask says how visible it is in the player', pass: 'visible ≥ 85% (inside the thin 5% feather every picture has)'},
  {id: 'edgeActor', name: 'People and animals at the edges stay visible', how: 'Jev finds the person/animal/vehicle nearest an edge', pass: 'visible ≥ 75%'},
  {id: 'face', name: 'Faces never faded', how: 'Jev finds the face nearest an edge', pass: 'visible ≥ 90%'},
  {id: 'judge', name: 'Jev\'s opinion (info)', how: 'Jev looks at the player image: anything washed out? any seam?', pass: 'information only: Jev says yes to the intentional haze on good frames too (Chase .6–.9), so it can\'t pass or fail a video'},
  {id: 'dreamy', name: 'Dreamy look kept', how: 'how faded the outer 6% of the picture is, over time; plus Jev: soft dreamy edges?', pass: 'edges mostly dissolved (avg visibility ≤ .5) and Jev ≥ .7'},
  {id: 'seams', name: 'No hard edges', how: 'steepest fade slope inside the picture (notch rims, fade lines), relative to a default 30% fade', pass: 'no steeper than Chase (the reference) + 25%'},
  {id: 'motion', name: 'No sudden moves', how: 'motion audit: visible-change rate, jerk, breathing edges', pass: '≤ 2% of frames flagged, fastest change ≤ .2/s'},
  {id: 'track', name: 'Good Jev track', how: 'samples per second in assets/<scene>.focus.json', pass: '≥ 2/s (Chase has 10/s with named subjects)'},
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64ToBytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const save = (name, ext, body) => fetch(`/api/debug/save?name=${name}&ext=${ext}`, {method: 'POST', body});

// visibility of a box: mean over its interior, inside the always-on thin feather (box clipped to 5–95%)
// core: judge only the central part of the box (a full-body box always reaches into the faded border by design)
function boxVis(fr, b, core = 1) {
  if (!b) return null;
  const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2, hw = (b.right - b.left) * core / 2, hh = (b.bottom - b.top) * core / 2;
  const l = Math.max(.05, cx - hw), r = Math.min(.95, cx + hw), t = Math.max(.05, cy - hh), bo = Math.min(.95, cy + hh);
  if (r - l < .01 || bo - t < .01) return null;   // entirely inside the feather: nothing to judge
  let s = 0, n = 0;
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) { s += visAt(fr, l + (r - l) * (i + .5) / 10, t + (bo - t) * (j + .5) / 10); n++; }
  return s / n;
}
// the frame's measured properties
function edgeVis(fr) { let s = 0, n = 0; for (let k = 0; k < 40; k++) { const p = (k + .5) / 40; for (const [u, v] of [[.03, p], [.97, p], [p, .03], [p, .97]]) { s += visAt(fr, u, v); n++; } } return s / n; }
function maxSlope(fr) {
  const G = 64, H = 36, at = (i, j) => visAt(fr, i / G, j / H); let m = 0;
  // inside the border only: an edge sharpens on purpose when a subject touches it
  for (let j = 4; j < H - 3; j++) for (let i = 5; i < G - 4; i++) { const v = at(i, j); m = Math.max(m, Math.abs(v - at(i - 1, j)) * G, Math.abs(v - at(i, j - 1)) * H); }
  return m;
}
const FEATHER_SLOPE = 1.5 / .3;   // steepest slope of a default 30% fade: anything much steeper inside the picture reads as a line

// where the track puts subjects at time t (any version): used only to pick risky frames
function trackBoxes(track, t) {
  if (!track) return [];
  const S = track.samples; let i = S.findIndex(x => x.t > t); if (i < 0) i = S.length - 1; const a = S[Math.max(0, i - 1)], b = S[i];
  const near = Math.abs(a.t - t) <= Math.abs(b.t - t) ? a : b;
  return [near.box && (near.confidence ?? 1) > .1 ? near.box : null, near.actor?.box, ...(near.subjects || []).map(x => x?.box)].filter(Boolean);
}

async function loadScene(sc) {
  const sel = document.getElementById('scene'), video = document.getElementById('video'), before = window.__focus.track;
  sel.value = sc; sel.dispatchEvent(new Event('change', {bubbles: true}));
  await new Promise(r => video.addEventListener('loadeddata', r, {once: true}));
  for (let i = 0; i < 30 && window.__focus.track === before; i++) await sleep(100);   // the track loads separately
  await sleep(300); video.pause();
  return {video, track: window.__focus.track};
}

// Jev's answers describe the ORIGINAL frame, which never changes: cache them per scene and moment, so re-running
// QA after a fix costs no Jev calls (only the measured checks re-run). tools/snaps/qa-jev-cache.json
let cache = null;
async function judge(c, key) {
  cache ??= await fetch(`/tools/snaps/qa-jev-cache.json?${Date.now()}`).then(r => r.ok ? r.json() : {}).catch(() => ({}));
  if (cache[key]) return {...cache[key], cached: true};
  const j = await askJudge(c);
  if (!j.error) { cache[key] = j; await save('qa-jev-cache', 'json', JSON.stringify(cache)); }
  return j;
}
async function askJudge(c) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('/api/qa/judge', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({original: c.original, shown: c.shown})});
    if (r.ok) return r.json();
    if (r.status < 500 && r.status !== 429) return {error: `${r.status} ${(await r.text()).slice(0, 200)}`};
    await sleep(1500 * (attempt + 1));
  }
  return {error: 'Jev unavailable'};
}

// draw the judged frame with Jev's boxes and their measured visibility, for the report
async function annotate(c, j, vis, name) {
  const img = await createImageBitmap(new Blob([b64ToBytes(c.shown)], {type: 'image/jpeg'})), m = c.margin;
  const cv = new OffscreenCanvas(img.width, img.height), x = cv.getContext('2d'); x.drawImage(img, 0, 0);
  const W = img.width / (1 + 2 * m), H = img.height / (1 + 2 * m), ox = W * m, oy = H * m;
  x.lineWidth = 2; x.font = '600 13px -apple-system,sans-serif';
  for (const [k, col] of [['subject', '#5ac8fa'], ['actor', '#ffcc00'], ['face', '#ff5fa2']]) {
    const b = j[k]; if (!b) continue;
    const v = vis[k], bad = v != null && v < ({subject: .85, actor: .75, face: .9})[k];
    x.strokeStyle = bad ? '#ff3b30' : col; x.strokeRect(ox + b.left * W, oy + b.top * H, (b.right - b.left) * W, (b.bottom - b.top) * H);
    const label = `${k} ${v == null ? '–' : Math.round(v * 100) + '%'}`; x.fillStyle = '#000a'; x.fillRect(ox + b.left * W, oy + b.top * H - 17, x.measureText(label).width + 8, 17);
    x.fillStyle = bad ? '#ff6b60' : col; x.fillText(label, ox + b.left * W + 4, oy + b.top * H - 4);
  }
  await save(name, 'jpg', await cv.convertToBlob({type: 'image/jpeg', quality: .8}));
  return `${name}.jpg`;
}

export async function runQA({scenes, jevFrames = 4, fps = 15, onProgress = () => {}} = {}) {
  const {record} = await import(`/tools/record.js?${Date.now()}`);
  scenes ??= [...document.querySelectorAll('#scene option')].map(o => o.value);
  // Chase first: it's the reference that Jev's opinions are calibrated against
  scenes = ['chase', ...scenes.filter(s => s !== 'chase')];
  // the face detector loads lazily; results differ while it's still loading, so wait for it (up to 15 s)
  for (let i = 0; i < 150 && !window.__facesReady?.(); i++) { if (i % 10 === 0) document.getElementById('video').play().then(() => document.getElementById('video').pause()).catch(() => {}); await sleep(100); }
  const report = {when: new Date().toISOString(), checklist: CHECKLIST, scenes: {}, calibration: null};
  for (const sc of scenes) {
    onProgress(`${sc}: playing`);
    const {video, track} = await loadScene(sc);
    const dur = video.duration;
    const {log, captures} = await record({encode: false, fps, to: dur - .05, capture: Math.max(.5, dur / 16)});
    // measured checks over every frame
    const motion = analyse(log, fps).summary;
    const edge = log.map(edgeVis), slopes = log.filter((_, i) => i % 5 === 0).map(maxSlope);
    const dreamyMeasured = edge.reduce((a, b) => a + b, 0) / edge.length, slopeRatio = Math.max(...slopes) / FEATHER_SLOPE;
    const density = track ? track.samples.length / Math.max(1, track.samples.at(-1).t - track.samples[0].t) : 0;
    // pick frames for Jev: riskiest by the track (subject nearest an edge / least visible), then evenly spaced
    const risk = captures.map(c => {
      const fr = log[c.frame], bs = trackBoxes(track, c.t);
      const edgeNear = bs.length ? Math.max(...bs.map(b => 1 - Math.min(b.left, 1 - b.right, b.top, 1 - b.bottom) * 5)) : 0;
      const minVis = bs.length ? Math.min(...bs.map(b => boxVis(fr, b) ?? 1)) : 1;
      return {c, score: edgeNear + (1 - minVis) * 2};
    });
    const chosen = new Set([...risk].sort((a, b) => b.score - a.score).slice(0, Math.ceil(jevFrames / 2)).map(r => r.c));
    for (let k = 0; chosen.size < Math.min(jevFrames, captures.length); k++) chosen.add(captures[Math.round((k + .5) / jevFrames * (captures.length - 1)) % captures.length]);
    const frames = [];
    for (const c of [...chosen].sort((a, b) => a.t - b.t)) {
      onProgress(`${sc}: Jev judging ${c.t}s`);
      const j = await judge(c, `${sc}@${c.t}`), fr = log[c.frame];
      if (j.error) { frames.push({t: c.t, error: j.error}); continue; }
      const vis = {subject: boxVis(fr, j.subject, .6), actor: boxVis(fr, j.actor, .6), face: boxVis(fr, j.face)};
      const img = await annotate(c, j, vis, `qa-${sc}-${String(c.t).replace('.', '-')}`);
      frames.push({t: c.t, vis, p: j.p, cached: !!j.cached, boxes: {subject: j.subject, actor: j.actor, face: j.face}, fades: fr.fades, notches: fr.notches.filter(n => n.a > .01), img});
    }
    const ok = frames.filter(f => !f.error), min = k => { const v = ok.map(f => f.vis[k]).filter(v => v != null); return v.length ? Math.min(...v) : null; };
    const maxP = k => { const v = ok.map(f => f.p[k]).filter(v => v != null); return v.length ? Math.max(...v) : null; };
    const avgP = k => { const v = ok.map(f => f.p[k]).filter(v => v != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    if (sc === 'chase') report.calibration = {hazed: maxP('hazed'), seam: maxP('seam'), dreamy: avgP('dreamy'), slope: slopeRatio};
    const cal = report.calibration || {hazed: .5, seam: .5};
    const r2 = v => v == null ? null : +v.toFixed(2);
    const res = {
      duration: +dur.toFixed(1),
      checks: {
        subject: {value: r2(min('subject')), pass: min('subject') == null || min('subject') >= .85},
        edgeActor: {value: r2(min('actor')), pass: min('actor') == null || min('actor') >= .8},
        face: {value: r2(min('face')), pass: min('face') == null || min('face') >= .85},
        judge: {value: `washed out ${r2(maxP('hazed'))} · seam ${r2(maxP('seam'))}`, pass: true, info: true, note: `Chase: ${r2(cal.hazed)} · ${r2(cal.seam)}`},
        dreamy: {value: `${r2(dreamyMeasured)} · Jev ${r2(avgP('dreamy'))}`, pass: dreamyMeasured <= .5 && (avgP('dreamy') ?? 1) >= .7},
        seams: {value: `${r2(slopeRatio)}× a 30% fade`, pass: slopeRatio <= Math.max(3, (cal.slope ?? 3) * 1.25), note: `Chase: ${r2(cal.slope)}×`},
        motion: {value: `${motion.flaggedPct}% · max ${motion.maxChange}/s`, pass: motion.flaggedPct <= 2 && motion.maxChange <= .2, moments: motion.moments},
        track: {value: `${r2(density)}/s${track?.multi ? ' · named subjects' : ''}`, pass: density >= 2},
      },
      frames,
    };
    res.pass = Object.values(res.checks).every(c => c.pass);
    report.scenes[sc] = res;
    await save('qa-report', 'json', JSON.stringify(report));   // saved after every scene, so the report fills in live
  }
  await loadScene(scenes[0]);
  const summary = Object.fromEntries(Object.entries(report.scenes).map(([k, v]) => [k, v.pass ? 'PASS' : 'fail: ' + Object.entries(v.checks).filter(([, c]) => !c.pass).map(([id]) => id).join(', ')]));
  return {summary, report: '/tools/qa.html'};
}
