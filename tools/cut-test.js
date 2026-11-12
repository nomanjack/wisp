// Cut-detector test (dev only). A false cut makes every fade and notch jump; a missed cut lets the old shot's
// notches linger over the new one. Both are tested on real footage, on a fresh tracker, at the player's rate
// (one analysis per 1/6 s of video):
//   continuous — every demo clip end to end: must report no cuts (pans, running, handheld).
//   splices    — every ordered pair of clips joined mid-motion: must report exactly one cut, at the join.
// Usage (in the page): const {cutTest} = await import('/tools/cut-test.js'); await cutTest()
export async function cutTest(names = ['chase', 'marble', 'studio', 'beachgirl', 'dog', 'desert']) {
  const {createFocusTracker} = await import(`/focus.js?${Date.now()}`);
  const load = async n => { const v = document.createElement('video'); v.muted = true; v.src = `/assets/${n}.mp4`; await new Promise(r => v.onloadeddata = r); return v; };
  const seek = (v, t) => new Promise(r => { v.onseeked = r; v.currentTime = t; });
  const vids = {}; for (const n of names) vids[n] = await load(n);
  const continuous = {};
  for (const n of names) {
    const v = vids[n], F = createFocusTracker(), cuts = [];
    for (let t = 0; t < v.duration - .1; t += 1 / 6) { await seek(v, t); if (F.analyze(v, t, []).cut) cuts.push(+t.toFixed(1)); }
    continuous[n] = cuts.length ? `FALSE CUTS at ${cuts.join(', ')}s` : 'clean';
  }
  const failed = {}; let exact = 0, total = 0;
  for (const a of names) for (const b of names) {
    if (a === b) continue;
    const F = createFocusTracker(), cuts = [], ta = Math.min(4, vids[a].duration - 2);
    for (let i = 0; i < 12; i++) { const v = i < 8 ? vids[a] : vids[b]; await seek(v, i < 8 ? ta + i / 6 : 1 + (i - 8) / 6); if (F.analyze(v, i / 6, []).cut) cuts.push(i); }
    total++; if (cuts.join() === '8') exact++; else failed[`${a}→${b}`] = cuts.length ? `cut at ${cuts.join(',')} (join is 8)` : 'missed';
  }
  return {continuous, splices: `${exact}/${total} exact`, failed};
}
