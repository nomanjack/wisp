// Content-aware edge analysis.
// Samples a tiny copy of the frame, builds a cheap saliency map, and reports how much
// important content sits in each edge band so the fade can pull back on that side.
// Swap `saliency()` for a model's output (same W×H Float32Array) without touching the rest.

const W = 48, H = 27, N = W * H;
const BAND = 0.24;            // outer fraction of width/height checked on each side
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };

// A focus track (from tools/focus-track.html) is a list of {t, box:{top,bottom,left,right}} in 0–1 units.
// Every sample counts, including ones judged empty: an empty sample means "no subject here", so we never
// carry a box across it (that bug protected the left edge of Marble for 4 s before she arrived).
const HOLD = .5;   // s: how long a box may be held past its own sample towards an empty one / the clip ends
const area = b => (b.right - b.left) * (b.bottom - b.top);
function sampleBox(s, key) {
  if (key === 'box') {
    // Jev's Box can't answer "nothing": on an empty frame it returns ~the whole frame at low confidence.
    if (area(s.box) > .8) return null;
    if (!s.actor && (s.confidence ?? 0) < .5) return null;   // no person/animal/vehicle and unsure: treat as empty
    return s.box;
  }
  // multi-subject tracks (stress scenes, ground truth): key 'subj:i' is subject slot i (null when it's absent)
  if (key.startsWith('subj:')) return s.subjects?.[+key.slice(5)]?.box ?? null;
  const v = s[key];
  return v && (v.confidence ?? 0) >= (key === 'actor' ? tuning.actorMin : 0) ? v.box : null;
}
// Hard cuts (track.cuts, seconds): the shot containing t runs [start, end). Boxes are never held, blended or
// looked ahead across a cut: the old shot's subject is gone the instant the picture changes, and the next shot's
// subject mustn't open its notch over the current one.
const shotOf = (cuts, t) => { let start = -Infinity, end = Infinity; for (const c of cuts || []) { if (c <= t) start = Math.max(start, c); else end = Math.min(end, c); } return {start, end}; };
function boxAt(samples, t, key = 'box', cuts) {
  if (!samples.length) return null;
  let i = samples.findIndex(s => s.t > t);
  if (i === -1) i = samples.length;
  const {start, end} = shotOf(cuts, t);
  const a = samples[i - 1], b = samples[i];
  const A = a && a.t >= start - 1e-6 && sampleBox(a, key), B = b && b.t < end - 1e-6 && sampleBox(b, key);
  if (A && B) {
    const k = (t - a.t) / (b.t - a.t || 1);
    const lerp = side => A[side] + (B[side] - A[side]) * k;
    return {top: lerp('top'), bottom: lerp('bottom'), left: lerp('left'), right: lerp('right')};
  }
  if (A && t - a.t <= HOLD) return A;        // just after a real sample (subject may be leaving)
  if (B && b.t - t <= HOLD) return B;        // just before one (subject arriving; look-ahead adds more lead)
  return null;
}
// How close the subject comes to each edge → how much that side's fade should pull back.
// Protection scale: 1 = the subject *touches* this edge (it's cut off by the frame), so the fade must get out of
// the way almost entirely (~2%). A subject merely near an edge tops out at NEAR (≈ the old ~10% fade). Before this,
// a face running off the top of the frame (Beach girl, 10 s) still sat under a ~10% fade and got dissolved.
const NEAR = .71, TOUCH = .03;
function boxProtect(box, isFace = false) {
  const p = d => d <= TOUCH ? 1 : (1 - smooth(TOUCH, .26, d)) * NEAR;
  // A body running off the bottom (waist-up framing) reads fine dissolving there; spend the budget on the
  // face and the side the subject is heading to instead. Faces are never discounted.
  const bottom = !isFace && box.bottom > .97 && box.bottom - box.top > .5 ? p(1 - box.bottom) * tuning.bottomCut : p(1 - box.bottom);
  return {l: p(box.left), r: p(1 - box.right), t: p(box.top), b: bottom,
          cx: (box.left + box.right) / 2, cy: (box.top + box.bottom) / 2};
}
// Live-tunable values (the dev panel writes these). Defaults tuned on the Marble demo clip against
// hand-checked subject positions (tools note in README): subject 87.9% visible vs 68.5% with no awareness.
export const tuning = {
  lookahead: .9,      // s: open an edge before the subject arrives (Jev tracks)
  notchLead: .4,      // s: a notch leads a subject already in frame by about its easing lag
  budget: 1.8,        // total protection across the four sides
  weakEase: .8,       // opposite-sides rule: how much the weaker side backs off (× overlap)
  strongEase: .4,     // …and the stronger side
  holdThreshold: .18, // a side only revises its shot decision when the target moves this much
  openTime: .3,       // s of video: time constant while making room (fast)
  releaseDelay: .7, 
  holdAhead: 2,       // s of video: with a track, a side stays open if it's needed again within this  // s of video: a side waits this long before closing (no open-close-open pumping)
  notchIn: .4,        // s of video: a new notch fading in
  notchOut: .8,       // s of video: a lost notch fading out
  notchEdgeOut: .45,  // …when its subject walked out at a side edge
  releaseTime: 1.3,   // s of video: time constant while letting go (slow)
  smoothTime: .25,    // s of video: low-pass on each side's target (absorbs face-box wobble)
  liveFloor: .08,     // live-only protection below this is texture noise, not a subject
  liveWeight: .3,     // live analysis weight when a Jev track exists
  actorMin: .12,      // minimum Jev actor-box confidence
  useTrack: true,     // use Jev tracks when present
  liveWeightEmpty: .15, // live weight when the track says nobody is in frame (texture shouldn't tighten edges)
  bottomCut: .5,      // a subject cut off by the bottom edge (waist-up framing) only half-protects the bottom
  aspect: 16 / 9,     // video width / height (set by the player per video)
  boxSide: .25,       // with notches, how much a subject box still narrows its whole edge (a gentle lean)
  notchPad: 1.35,     // notch ellipse size relative to the subject box
  notchSoft: .4,      // fraction of the notch radius that is fully opaque before it feathers out
  notchStrength: .82, // peak opacity a notch adds (below 1 keeps a whisper of the dissolve even over the subject)
};

// Keep the dissolve alive. Edge-awareness should help an off-centre subject, not turn a frame-filling one
// into a hard rectangle (the "cutout" look rejected earlier).
function limitTightening(p) {
  // An edge the subject touches is never traded away: covering the subject is worse than a less dreamy frame.
  const locked = k => p[k] >= .99;
  // Opposite sides both asking means the subject spans the frame: there's no side to make room on.
  // Ease the pair back, the weaker side more, so the stronger side still leans toward the subject.
  for (const [a, b] of [['l', 'r'], ['t', 'b']]) {
    const overlap = Math.min(p[a], p[b]);
    if (overlap <= 0 || (locked(a) && locked(b))) continue;
    const [weak, strong] = p[a] < p[b] ? [a, b] : [b, a];
    if (!locked(weak)) p[weak] = Math.max(0, p[weak] - overlap * tuning.weakEase);
    if (!locked(strong)) p[strong] = Math.max(0, p[strong] - overlap * tuning.strongEase);
  }
  // Shared budget over the unlocked sides: if they still ask for too much, scale them down evenly.
  const free = ['l', 'r', 't', 'b'].filter(k => !locked(k));
  // Locked sides spend budget, but never all of it: other sides the subject is near still get some protection
  // (Beach girl: top and right locked left nothing for her arms at the bottom).
  const room = Math.max(.7, tuning.budget - (4 - free.length) * .5);
  const sum = free.reduce((a, k) => a + p[k], 0);
  if (sum > room) for (const k of free) p[k] *= sum ? room / sum : 0;
}

// ── Notches ──────────────────────────────────────────────────────────────────────────────────────────────
// Instead of clearing a whole edge when a subject touches it (a long hard line across the top for a girl in the
// top-left corner, Chase 8 s), each subject opens a soft local hole in the fade: an ellipse around its box,
// opaque in the middle and feathering out. The rest of every edge keeps the dreamy dissolve.
const SLOTS = 6;   // notch layers in the CSS mask (app.js); faces first, then heads, then bodies
// A subject mostly out of frame: touching a side edge with little width left.
// Leaving the frame: gone after the look-ahead, or visibly narrower there (a parked object at an edge isn't leaving).
const leaving = (now, soon) => !soon || (!!now && sliver(soon) && soon.right - soon.left < now.right - now.left - .01);
const sliver = b => !!b && (b.left <= .03 || b.right >= .97) && b.right - b.left < .14;
const union = (a, b) => a && b ? {left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom)} : a || b;
const overlap = (a, b) => { const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)), y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)); return x * y / Math.min((a.right - a.left) * (a.bottom - a.top), (b.right - b.left) * (b.bottom - b.top) || 1); };
function toNotch(box, isFace) {
  let {left, right, top, bottom} = box;
  // Waist-up body running off the bottom: stop the notch above the waist so the torso still dissolves.
  // Ramped, not switched: a running child's feet bob across the bottom edge, and an on/off cut made the
  // notch jump 28% in height each time (Chase, 4.8–5.4 s).
  if (!isFace) bottom -= (bottom - top) * .28 * smooth(.93, .99, bottom) * smooth(.45, .55, bottom - top);
  const pad = tuning.notchPad;
  return {x: (left + right) / 2, y: (top + bottom) / 2, rx: Math.max(.06, (right - left) / 2 * pad), ry: Math.max(.08, (bottom - top) / 2 * pad), a: 1};
}
// An ellipse around a tall body box leaves the box's top corners in its feathered rim, and that's where heads
// are (Chase: the boy's head dissolved at the top-left). So every body also gets a head notch over its top part.
function headNotch(box, person = false) {
  const w = box.right - box.left, h = box.bottom - box.top;
  // tracks that say their subjects are people (track.people) always get a head notch: deciding from the box
  // shape switched it on and off as a running child's box changed shape (Chase, 1.3 s and 11.2 s)
  // Otherwise only tall, person-shaped boxes: a compact object's own notch covers it (and head notches used up
  // all the slots in the stress crowd scene). Box sides are frame fractions: the aspect converts to pixels.
  if (person ? h < .12 : h < .15 || h < w * 1.3 * tuning.aspect) return null;
  const hh = Math.min(h * .32, Math.max(w * 1.1, .12));
  return {x: (box.left + box.right) / 2, y: box.top + hh * .45, rx: Math.max(.05, w / 2 * 1.15), ry: Math.max(.07, hh * .85), a: 1, head: true};
}

export function createFocusTracker() {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const lum = new Float32Array(N), prev = new Float32Array(N), sal = new Float32Array(N);
  const r = new Float32Array(N), g = new Float32Array(N), b = new Float32Array(N);
  let hasPrev = false, track = null;
  const state = { l: 0, r: 0, t: 0, b: 0, cx: .5, cy: .5 };
  const held = { l: 0, r: 0, t: 0, b: 0, cx: .5, cy: .5 };   // the shot's settled decision
  const needAt = { l: -1e9, r: -1e9, t: -1e9, b: -1e9 };     // video time each side last needed its current opening
  const smoothT = { l: 0, r: 0, t: 0, b: 0 };                // low-passed targets
  let lastTime = null;
  let notches = [], uidSeq = 0, hasPrevChange = false, hasPrevHist = false;
  const recentChanges = [];
  const hist = new Float32Array(64), prevHist = new Float32Array(64);                              // eased notch slots [{x,y,rx,ry,a,uid}]; uid: stable per notch for the renderer
  const touch = { l: 0, r: 0, t: 0, b: 0 };                  // eased: a subject is cut by this edge

  function saliency() {
    let mr = 0, mg = 0, mb = 0;
    for (let i = 0; i < N; i++) { mr += r[i]; mg += g[i]; mb += b[i]; }
    mr /= N; mg /= N; mb /= N;
    const grad = new Float32Array(N), col = new Float32Array(N), mot = new Float32Array(N);
    let sg = 0, sc = 0, sm = 0, cut = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const gx = lum[y * W + Math.min(W - 1, x + 1)] - lum[y * W + Math.max(0, x - 1)];
      const gy = lum[Math.min(H - 1, y + 1) * W + x] - lum[Math.max(0, y - 1) * W + x];
      grad[i] = Math.hypot(gx, gy); sg += grad[i];
      // Distance from the frame's average colour: subjects usually differ from their backdrop.
      col[i] = Math.hypot(r[i] - mr, g[i] - mg, b[i] - mb); sc += col[i];
      const d = hasPrev ? Math.abs(lum[i] - prev[i]) : 0; mot[i] = d; sm += d; cut += d;
    }
    // Remove global motion (camera pans) so only things moving against the scene count.
    const meanMot = sm / N;
    let smr = 0;
    for (let i = 0; i < N; i++) { mot[i] = Math.max(0, mot[i] - meanMot * 1.5); smr += mot[i]; }
    const ng = sg / N + 1e-3, nc = sc / N + 1e-3, nm = smr / N + 4e-3;
    for (let i = 0; i < N; i++) sal[i] = .45 * grad[i] / ng + .35 * col[i] / nc + .20 * Math.min(4, mot[i] / nm);
    return cut / N;   // mean luminance change: a scene-cut signal
  }

  function bandScore(side) {
    const bw = Math.round(W * BAND), bh = Math.round(H * BAND);
    let sum = 0, wsum = 0;
    if (side === 'l' || side === 'r') {
      for (let k = 0; k < bw; k++) {
        const x = side === 'l' ? k : W - 1 - k, w = 1 - k / bw;   // outermost columns weigh most
        for (let y = 0; y < H; y++) { sum += sal[y * W + x] * w; wsum += w; }
      }
    } else {
      for (let k = 0; k < bh; k++) {
        const y = side === 't' ? k : H - 1 - k, w = 1 - k / bh;
        for (let x = 0; x < W; x++) { sum += sal[y * W + x] * w; wsum += w; }
      }
    }
    return sum / wsum;   // 1.0 ≈ as busy as the frame average
  }

  return {
    get map() { return sal; }, W, H, state,
    get track() { return track; },
    setTrack(t) { track = t && Array.isArray(t.samples) && t.samples.length ? t : null; },
    trackBox(time) { return track ? boxAt(track.samples, time, 'box', track.cuts) : null; },
    reset() { hasPrev = false; hasPrevHist = false; recentChanges.length = 0; hasPrevChange = false; lastTime = null; notches = []; Object.assign(touch, { l: 0, r: 0, t: 0, b: 0 }); Object.assign(needAt, { l: -1e9, r: -1e9, t: -1e9, b: -1e9 }); Object.assign(smoothT, { l: 0, r: 0, t: 0, b: 0 }); for (const o of [state, held]) Object.assign(o, { l: 0, r: 0, t: 0, b: 0, cx: .5, cy: .5 }); },
    // extra: boxes that must never be dissolved (e.g. faces), [{top,bottom,left,right}] in 0–1 units.
    analyze(source, time = 0, extra = []) {
      ctx.drawImage(source, 0, 0, W, H);
      const px = ctx.getImageData(0, 0, W, H).data;
      for (let i = 0; i < N; i++) {
        r[i] = px[i * 4] / 255; g[i] = px[i * 4 + 1] / 255; b[i] = px[i * 4 + 2] / 255;
        lum[i] = .2126 * r[i] + .7152 * g[i] + .0722 * b[i];
      }
      const change = saliency();
      prev.set(lum); hasPrev = true;
      // Colour make-up of the frame (4×4×4 RGB bins). A pan or a running child keeps the palette; a cut to another
      // shot usually changes it. histDiff: 0 = same palette, 1 = nothing in common.
      hist.fill(0);
      for (let i = 0; i < N; i++) hist[(Math.min(3, r[i] * 4 | 0) * 4 + Math.min(3, g[i] * 4 | 0)) * 4 + Math.min(3, b[i] * 4 | 0)] += 1 / N;
      let common = 0; for (let k = 0; k < 64; k++) common += Math.min(hist[k], prevHist[k]);
      const histDiff = hasPrevHist ? 1 - common : 0; prevHist.set(hist); hasPrevHist = true;

      // Weighted centroid of the strongest content.
      let sx = 0, sy = 0, sw = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const v = sal[y * W + x], w = v * v * v; sx += w * (x + .5) / W; sy += w * (y + .5) / H; sw += w;
      }
      const cx = sw ? sx / sw : .5, cy = sw ? sy / sw : .5;

      // Protection per side: an edge band that is busier than the other edges (and busy in absolute
      // terms) keeps more of its picture. The centroid lean adds a softer push toward the subject.
      const raw = { l: bandScore('l'), r: bandScore('r'), t: bandScore('t'), b: bandScore('b') };
      const mean = (raw.l + raw.r + raw.t + raw.b) / 4 + 1e-3;
      // Live analysis can't tell a touching subject from texture, so it never asks for more than NEAR.
      const protect = (v) => Math.max(smooth(.9, 1.35, v / mean) * smooth(.5, .8, v), smooth(.95, 1.3, v)) * NEAR;
      const lean = (v) => smooth(.06, .22, v) * .7 * NEAR;
      const target = {
        l: Math.max(protect(raw.l), lean(.5 - cx)),
        r: Math.max(protect(raw.r), lean(cx - .5)),
        t: Math.max(protect(raw.t), lean(.5 - cy)),
        b: Math.max(protect(raw.b), lean(cy - .5)),
        cx, cy,
      };
      let entities = [];
      let futureNeed = null;
      if (track && tuning.useTrack) {
        // Model track plus live analysis, whichever protects a side more.
        // Protect the main-subject box and, where Jev saw one, the people/animals/vehicles box.
        // Jev's actor boxes are often wrong at low confidence (tested on the paddler clip), so only trust confident ones.
        const ACTOR_MIN = tuning.actorMin;
        const near = (key, s, min) => { const i = track.samples.findIndex(x => x.t > s); const a = track.samples[Math.max(0, i - 1)], b = track.samples[i < 0 ? track.samples.length - 1 : i]; return [a, b].some(x => x && x[key] && (x[key].confidence ?? 0) >= min); };
        const actorNear = s => near('actor', s, ACTOR_MIN);
        const at = (t, key) => boxAt(track.samples, t, key, track.cuts);
        const ahead = Math.min(time + tuning.lookahead, shotOf(track.cuts, time).end - .01);   // look ahead only within this shot
        // On-screen text / logos (Jev): must-keep like faces, applied after the cap below.
        if (near('text', time, 0)) extra = [...extra, at(time, 'text')].filter(Boolean);
        const boxes = [at(time), at(ahead)];
        for (const s of [time, ahead]) if (actorNear(s)) boxes.push(at(s, 'actor'));
        // Entities for notches: each box joined with where it will be after the look-ahead (opens the path early).
        // Exiting: don't stretch a notch toward where the subject leaves (that made a tall bright band at the edge).
        // A subject already in frame joins only with where it is notchLead ahead (≈ the easing lag), not the full
        // look-ahead: a fast runner's notch was stretched over 0.9 s of path, its centre ran ahead of him and the
        // easing trailed behind, so he sat in the notch's faint fringe (QA, Chase 9.7 s: his face 41% visible).
        // A subject not in frame yet still uses the full look-ahead, so its notch opens before it arrives.
        // Only for dense named-subject tracks (Chase): sparse tracks' boxes are rough, and the longer stretch was
        // covering for that (QA: Balloons subject 98% → 74% with the short lead).
        const lead = Math.min(time + (track.multi ? tuning.notchLead : tuning.lookahead), shotOf(track.cuts, time).end - .01);
        const join = (now, soon, near) => now ? (near && !sliver(near) ? union(now, near) : now) : soon;
        const main = join(boxes[0], boxes[1], at(lead));
        const actorNow = actorNear(time) ? at(time, 'actor') : null, actorSoon = actorNear(ahead) ? at(ahead, 'actor') : null;
        const actor = join(actorNow, actorSoon, actorNear(lead) ? at(lead, 'actor') : null);
        entities = [main, actor && (!main || overlap(main, actor) < .6) ? actor : null].filter(Boolean)
          .map(b => ({...b, id: b === main ? 'main' : 'actor', sliver: sliver(b), exiting: b === main ? leaving(boxes[0], boxes[1]) : leaving(actorNow, actorSoon)}));
        // A track that lists every subject (track.multi): one entity per subject slot instead of main + person.
        if (track.multi) {
          const slots = Math.max(0, ...track.samples.map(x => x.subjects?.length ?? 0));
          entities = []; boxes.length = 0;
          for (let i = 0; i < slots; i++) {
            const now = at(time, `subj:${i}`), soon = at(ahead, `subj:${i}`);
            const b = join(now, soon, at(lead, `subj:${i}`)); if (!b) continue;
            entities.push({...b, id: `s${i}`, sliver: sliver(b), exiting: leaving(now, soon)}); boxes.push(now || soon);
          }
        }
        // Sides only lean a little toward a subject now; the notch does the real work.
        const ps = boxes.filter(Boolean).map(b => boxProtect(b)).map(p => ({...p, l: p.l * tuning.boxSide, r: p.r * tuning.boxSide, t: p.t * tuning.boxSide, b: p.b * tuning.boxSide}));
        // Union with live analysis (each caught subjects the other missed on Camels), but when the track says the
        // frame is empty, live analysis is mostly reacting to texture (Marble's wall), so it barely counts.
        const lw = ps.length ? tuning.liveWeight : tuning.liveWeightEmpty;
        for (const key of ['l', 'r', 't', 'b']) target[key] = Math.max(...ps.map(p => p[key]), Math.max(0, target[key] * lw - tuning.liveFloor));
        // Plan ahead: the track knows where subjects will be. A side the track will need again within holdAhead
        // (same shot) doesn't close in between: the girl in Chase leaves the left edge at 6 s and is back at 7.5 s,
        // and the left fade closed and reopened (a visible "breath"). Checked every 0.25 s; cheap.
        futureNeed = {l: 0, r: 0, t: 0, b: 0};
        const horizon = Math.min(time + tuning.holdAhead, shotOf(track.cuts, time).end - .01);
        for (let s = time + .25; s <= horizon; s += .25) {
          const bs = track.multi ? track.samples[0]?.subjects ? Array.from({length: Math.max(0, ...track.samples.map(x => x.subjects?.length ?? 0))}, (_, i) => at(s, `subj:${i}`)) : [] : [at(s), actorNear(s) ? at(s, 'actor') : null];
          for (const b of bs.filter(Boolean)) { const p = boxProtect(b); for (const key of ['l', 'r', 't', 'b']) futureNeed[key] = Math.max(futureNeed[key], p[key] * tuning.boxSide); }
        }
        if (ps.length) { target.cx = ps[0].cx; target.cy = ps[0].cy; }
        else { target.cx = .5; target.cy = .5; }   // nobody in frame: halo settles back to centre instead of following texture
      }
      limitTightening(target);
      // Faces and text get their own notches (never traded away by the cap: notches aren't part of it).
      // A sliver of a subject at an edge (mostly out of frame) keeps only a dimmer head notch: a full-height body
      // notch there showed a pale strip of white sweater as a "highlight" (Marble's exit, 11.2 s).
      const want = [...extra.map(b => ({...toNotch(b, true), face: true})),
        ...entities.map(b => { const h = headNotch(b, !!track?.people); return h && {...h, id: `${b.id}:h`, a: b.sliver && b.exiting ? .45 : 1}; }).filter(Boolean),
        ...entities.filter(b => !(b.sliver && b.exiting)).map(b => ({...toNotch(b, false), id: `${b.id}:b`}))].slice(0, SLOTS);   // small things parked at an edge keep their notch; only ones leaving lose it
      const touchT = { l: 0, r: 0, t: 0, b: 0 };
      for (const b of [...extra, ...entities]) { if (b.left <= .03) touchT.l = 1; if (b.right >= .97) touchT.r = 1; if (b.top <= .03) touchT.t = 1; if (b.bottom >= .97 && b.bottom - b.top <= .5) touchT.b = 1; }
      // A hard cut snaps everything (no easing). The live detector is a frame-difference guess, and a fast handheld
      // pan crosses it: in Chase (one continuous shot) it fired a dozen times from 6 s, and each false "cut" made
      // the fades jump instead of glide. A track built cut-aware (it lists its cuts, even none) is the authority.
      // Without such a track, a cut needs two signals: the palette changes (histDiff > .35) and the picture changes
      // (change > .06). A pan or a running subject moves pixels but keeps the palette. Measured on the demo
      // clips: whole continuous clips never exceed histDiff .17; spliced cuts between them score .62–1.0. A fixed
      // brightness threshold alone fired on fast motion (Chase 12×, Studio 9×, Beach girl 4×) and each false cut
      // made the fades jump. Two fallbacks catch cuts between similar-looking shots: a jump well above the last
      // second's motion. Test: 30 spliced pairs of the demo clips + every clip end to end (tools/cut-test.js).
      // recent: the largest change over the last ~1 s of analyses (motion level before this frame)
      const recent = recentChanges.length >= 2 ? Math.max(...recentChanges) : Infinity;
      const cut = (histDiff > .35 && change > .06                                   // new palette
        || histDiff > .15 && change > .1 && change > recent * 1.5                  // similar palette, sudden jump
        || change > .2 && change > recent * 2)                                     // same place, big jump
        && !(track && Array.isArray(track.cuts));
      if (hasPrevChange) { recentChanges.push(change); if (recentChanges.length > 6) recentChanges.shift(); }
      if (cut) recentChanges.length = 0;
      hasPrevChange = true;
      state.raw = { ...raw, cx, cy, change, histDiff, cut, target, source: track ? 'track' : 'live', faces: extra.length, keep: extra };

      // All easing runs on *video* time, so playback speed doesn't change the motion: 0.1x shows exactly the 1x
      // behaviour, slowed down. (Per-step easing snapped to every wobble in slow motion.)
      const dt = lastTime === null ? 0 : time - lastTime;
      const jump = lastTime === null || dt < 0 || dt > 1;            // first frame, seek back, or a skip
      lastTime = time;
      // a cut listed in the track between the last step and this one: switch shots at once, like a seek
      const trackCut = !!track && !jump && (track.cuts || []).some(c => c > time - dt && c <= time);
      const snap = cut || jump || trackCut;
      const ease = (tau) => snap ? 1 : 1 - Math.exp(-Math.max(0, dt) / Math.max(1e-3, tau));
      for (const key of ['l', 'r', 't', 'b']) {
        smoothT[key] += (target[key] - smoothT[key]) * ease(tuning.smoothTime);
        const tgt = smoothT[key];
        // 1 · Hold per shot: only revise a side's decision when the (smoothed) target clearly moves.
        // Release delay: a side only starts closing once its need has stayed lower for releaseDelay. Without it an
        // edge closed as a subject briefly moved off it and reopened when they came back (Chase, left edge at 8 s).
        if (tgt >= held[key] - .02 || (futureNeed && futureNeed[key] >= held[key] - .02)) needAt[key] = time;
        const mayClose = time - needAt[key] >= tuning.releaseDelay;
        if (snap || (tgt > held[key] && (tgt - held[key] > tuning.holdThreshold || tgt > .85)) || (tgt < held[key] && mayClose && held[key] - tgt > tuning.holdThreshold)) { held[key] = tgt; needAt[key] = time; }
        // 2 · Open fast, release slow.
        const d = held[key] - state[key];
        state[key] += d * ease(d > 0 ? tuning.openTime : tuning.releaseTime);
        if (state[key] < .02 && held[key] < .02) state[key] = 0;     // no lingering 1–2% offsets
      }
      for (const key of ['cx', 'cy']) {
        if (snap || Math.abs(target[key] - held[key]) > .08) held[key] = target[key];
        state[key] += (held[key] - state[key]) * ease(1.2);
      }
      // Notches ease on video time too: match each wanted notch to the nearest existing slot, ease its geometry,
      // fade new ones in and lost ones out (no popping holes).
      const next = [];
      // Subject notches carry an id (subject slot + head/body) and only ever match their own id: matched by
      // distance, a child's head and body notches (or two children passing) swapped slots, one restarting from
      // zero while the other faded out as a ghost. Faces (no id) still match the nearest id-less notch.
      for (const w of want) {
        let best = w.id ? notches.find(n => n.id === w.id) || null : null, bd = .3;
        if (!w.id) for (const n of notches) { if (n.id) continue; const d = Math.hypot(n.x - w.x, n.y - w.y); if (d < bd) { best = n; bd = d; } }
        if (best) { notches = notches.filter(n => n !== best); best.head = w.head; best.face = w.face; best.id = w.id; for (const k of ['x', 'y', 'rx', 'ry']) best[k] += (w[k] - best[k]) * ease(.2); const ta = w.a ?? 1; best.a += (ta - best.a) * ease(ta > best.a ? tuning.notchIn : tuning.notchOut); next.push(best); }
        else next.push({...w, a: snap ? 1 : 0, uid: ++uidSeq});
      }
      // A notch lost at a side edge means the subject walked out: let it go fast. Elsewhere, release gently.
      for (const n of notches) { const atEdge = n.x - n.rx * .5 < .06 || n.x + n.rx * .5 > .94; n.a -= n.a * ease(atEdge ? tuning.notchEdgeOut : tuning.notchOut); if (n.a > .02) next.push(n); }
      notches = next.slice(0, SLOTS);
      for (const k of ['l', 'r', 't', 'b']) touch[k] += (touchT[k] - touch[k]) * ease(touchT[k] > touch[k] ? tuning.openTime : tuning.releaseTime);
      state.notches = notches.map(n => ({...n}));
      state.touch = {...touch};
      state.cut = cut || trackCut;
      state.snap = snap;   // also a seek or the first frame: the renderer shows this frame's fades at once
      return state;
    },
  };
}
