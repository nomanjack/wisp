// Motion audit: how much the fade moves, frame by frame, as a viewer would see it.
// Input: the per-frame log from tools/record.js (fades and notches as drawn). For each frame it rebuilds the fade
// mask on a coarse grid with the same maths as gpu.js and measures:
//   change  — how much of the picture's visibility changes per second (mean |Δmask| × fps). Calm ≈ < .15/s.
//   jerk    — how fast that change itself changes (a start or stop with no ramp reads as a "jump").
//   breathe — direction reversals of each side's width within 1.5 s (opening then closing again = pumping).
// It flags moments above the limits and draws a chart (fade widths + change rate, flagged spans in red).
// Usage (in the page): const {record} = await import('/tools/record.js'), {audit} = await import('/tools/motion-audit.js');
//   const {log} = await record({encode: false}); await audit(log, {name: 'chase-audit'})
export const LIMITS = {change: .15, jerk: 2.5, breathe: 2};

export const ease = t => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
const smooth = (a, b, x) => ease((x - a) / (b - a));
// visibility of the picture at (u, v) for one logged frame: the same maths as the gpu.js shader
export function visAt(fr, u, v, soft = .4, thin = .05) {
  const [l, r, t, b] = fr.fades.map(x => Math.max(x, 1e-4));
  const e = ease(u / l) * ease((1 - u) / r) * ease(v / t) * ease((1 - v) / b);
  let n = 0;
  for (const q of fr.notches) { if (q.a <= .001) continue; const d = Math.hypot((u - q.x) / Math.max(q.rx, 1e-3), (v - q.y) / Math.max(q.ry, 1e-3)); n = Math.max(n, q.a * (1 - smooth(soft, 1, d))); }
  return Math.max(e, n) * ease(u / thin) * ease((1 - u) / thin) * ease(v / thin) * ease((1 - v) / thin);
}
function mask(fr, GX = 32, GY = 18, soft = .4) {
  const out = new Float32Array(GX * GY), [l, r, t, b] = fr.fades.map(v => Math.max(v, 1e-4));
  for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
    const u = (i + .5) / GX, v = (j + .5) / GY;
    const e = ease(u / l) * ease((1 - u) / r) * ease(v / t) * ease((1 - v) / b);
    let n = 0;
    for (const q of fr.notches) { if (q.a <= .001) continue; const d = Math.hypot((u - q.x) / Math.max(q.rx, 1e-3), (v - q.y) / Math.max(q.ry, 1e-3)); n = Math.max(n, q.a * (1 - smooth(soft, 1, d))); }
    out[j * GX + i] = Math.max(e, n);
  }
  return out;
}

export function analyse(log, fps = 30, limits = LIMITS) {
  const m = log.map(f => mask(f)), change = [0], jerk = [0, 0];
  for (let i = 1; i < m.length; i++) { let s = 0; for (let k = 0; k < m[i].length; k++) s += Math.abs(m[i][k] - m[i - 1][k]); change.push(s / m[i].length * fps); }
  for (let i = 2; i < m.length; i++) jerk.push(Math.abs(change[i] - change[i - 1]) * fps);
  // breathing: per side, count direction reversals (ignoring moves under 0.5% of the frame) inside 1.5 s windows
  const W = Math.round(1.5 * fps), breathe = log.map(() => 0);
  for (let s = 0; s < 4; s++) {
    const turns = []; let dir = 0, anchor = log[0].fades[s];
    log.forEach((f, i) => { const d = f.fades[s] - anchor; if (Math.abs(d) > .005) { const nd = Math.sign(d); if (dir && nd !== dir) turns.push(i); dir = nd; anchor = f.fades[s]; } });
    log.forEach((_, i) => { breathe[i] = Math.max(breathe[i], turns.filter(k => k > i - W && k <= i).length); });
  }
  const flags = [];
  log.forEach((f, i) => {
    const why = [change[i] > limits.change && 'change', jerk[i] > limits.jerk && 'jerk', breathe[i] >= limits.breathe && 'breathe'].filter(Boolean);
    if (!why.length) return;
    const last = flags.at(-1);
    if (last && i - last.end <= 3) { last.end = i; last.to = f.t; for (const w of why) last.why.add(w); last.peak = Math.max(last.peak, change[i]); }
    else flags.push({start: i, end: i, from: f.t, to: f.t, why: new Set(why), peak: change[i]});
  });
  const pct = a => +(a.filter(Boolean).length / log.length * 100).toFixed(1);
  return {
    change, jerk, breathe,
    summary: {
      frames: log.length, meanChange: +(change.reduce((a, b) => a + b, 0) / change.length).toFixed(3), maxChange: +Math.max(...change).toFixed(3),
      maxJerk: +Math.max(...jerk).toFixed(2), flaggedPct: pct(log.map((_, i) => change[i] > limits.change || jerk[i] > limits.jerk || breathe[i] >= limits.breathe)),
      moments: flags.map(f => `${f.from.toFixed(1)}–${f.to.toFixed(1)}s ${[...f.why].join('+')} (peak ${f.peak.toFixed(2)}/s)`),
    },
  };
}

// chart: fade widths per side (top) and change rate with the limit (bottom); flagged frames shaded red
export async function audit(log, {name = 'motion-audit', fps = 30, limits = LIMITS, compare} = {}) {
  const A = analyse(log, fps, limits), B = compare ? analyse(compare, fps, limits) : null;
  const Wd = 1400, Hd = 520, c = new OffscreenCanvas(Wd, Hd), x = c.getContext('2d'), n = log.length, X = i => 50 + i / (n - 1) * (Wd - 70);
  x.fillStyle = '#111'; x.fillRect(0, 0, Wd, Hd); x.font = '13px -apple-system,sans-serif';
  log.forEach((_, i) => { if (A.change[i] > limits.change || A.jerk[i] > limits.jerk || A.breathe[i] >= limits.breathe) { x.fillStyle = '#ff3b3022'; x.fillRect(X(i) - 1, 20, (Wd - 70) / n + 2, Hd - 50); } });
  const plot = (vals, top, h, max, color, w = 2, dash = []) => { x.strokeStyle = color; x.lineWidth = w; x.setLineDash(dash); x.beginPath(); vals.forEach((v, i) => { const y = top + h - Math.min(1, v / max) * h; i ? x.lineTo(X(i), y) : x.moveTo(X(i), y); }); x.stroke(); x.setLineDash([]); };
  const cols = ['#5ac8fa', '#ffcc00', '#34c759', '#ff9f0a'];
  ['left', 'right', 'top', 'bottom'].forEach((s, k) => { if (compare) plot(compare.map(f => f.fades[k]), 30, 250, .32, cols[k] + '55', 1.5, [4, 4]); plot(log.map(f => f.fades[k]), 30, 250, .32, cols[k]); x.fillStyle = cols[k]; x.fillText(s, 60 + k * 70, 22); });
  x.fillStyle = '#aaa'; x.fillText('fade width per side (0–32% of the picture)' + (compare ? ' · dashed = before' : ''), 360, 22);
  if (B) plot(B.change, 300, 180, .6, '#ffffff44', 1.5, [4, 4]);
  plot(A.change, 300, 180, .6, '#fff');
  const ly = 300 + 180 - limits.change / .6 * 180; x.strokeStyle = '#ff3b30'; x.setLineDash([6, 4]); x.beginPath(); x.moveTo(50, ly); x.lineTo(Wd - 20, ly); x.stroke(); x.setLineDash([]);
  x.fillStyle = '#aaa'; x.fillText('how fast the visible fade changes (per s) · red line = calm limit', 60, 296);
  x.fillStyle = '#777'; for (let s = 0; s <= log.at(-1).t; s++) { const i = log.findIndex(f => f.t >= s); if (i >= 0) x.fillText(`${s}s`, X(i) - 6, Hd - 12); }
  const blob = await c.convertToBlob({type: 'image/jpeg', quality: .9});
  await fetch(`/api/debug/save?name=${encodeURIComponent(name)}&ext=jpg`, {method: 'POST', body: blob});
  await fetch(`/api/debug/save?name=${encodeURIComponent(name)}&ext=json`, {method: 'POST', body: JSON.stringify({summary: A.summary, before: B?.summary, log})});
  return {chart: `tools/snaps/${name}.jpg`, ...A.summary, before: B?.summary};
}

// The whole check in one call: the cut test, then a motion audit (chart + JSON in tools/snaps) of every demo
// scene through the real player path. Run after any change to focus.js, gpu.js or a track.
// Usage (in the page, /?debug): const {checkAll} = await import('/tools/motion-audit.js'); await checkAll()
export async function checkAll(scenes = ['chase', 'marble', 'studio', 'desert', 'dog', 'beachgirl']) {
  const {cutTest} = await import(`/tools/cut-test.js?${Date.now()}`), {record} = await import(`/tools/record.js?${Date.now()}`);
  const cuts = await cutTest(), sel = document.getElementById('scene'), video = document.getElementById('video'), out = {};
  for (const sc of scenes) {
    sel.value = sc; sel.dispatchEvent(new Event('change', {bubbles: true}));
    await new Promise(r => video.addEventListener('loadeddata', r, {once: true})); await new Promise(r => setTimeout(r, 800)); video.pause();
    const {log} = await record({encode: false, to: Math.min(video.duration - .05, 14)});
    const r = await audit(log, {name: `audit-${sc}`});
    out[sc] = r.moments.length ? `${r.flaggedPct}% flagged: ${r.moments.join('; ')}` : `calm (max ${r.maxChange}/s)`;
  }
  sel.value = scenes[0]; sel.dispatchEvent(new Event('change', {bubbles: true}));
  return {cuts, motion: out};
}
