// 8 · Glow continues the protected edge.
// When a side's fade tightens to keep content visible, the picture can stop abruptly against the page
// (e.g. a head running off the top of the frame). This layer extends that side's edge pixels outward,
// fading with distance, with strength = that side's protection, so the image seems to carry on into the page.
const SIDES = ['t', 'b', 'l', 'r'];
let MAX = .5;    // strongest a side's continuation glow gets (higher made a coloured ghost of a subject at the edge)
export const edgeGlowSettings = { get max() { return MAX; }, set max(v) { MAX = v; } };

export function createEdgeGlow(video, host) {
  const canvas = document.createElement('canvas');
  canvas.id = 'edgeGlow'; canvas.setAttribute('aria-hidden', 'true');
  const out = canvas.getContext('2d');
  // Each frame is composed on a stage canvas and blended into the visible one over ~0.15 s (like the halo):
  // drawn straight, the glow shimmered during fast handheld pans. snap: the next frame replaces it outright.
  const stage = document.createElement('canvas'), ctx = stage.getContext('2d');
  let snap = true, last = 0;
  const tmp = document.createElement('canvas'), tctx = tmp.getContext('2d', {willReadFrequently: true});
  let geom = null;
  const lumCache = {};

  function measure() {
    const cr = canvas.getBoundingClientRect(), vr = video.getBoundingClientRect();
    if (!cr.width || !vr.width || !video.videoWidth) { geom = null; return; }
    const w = 200, h = Math.max(30, Math.round(200 * cr.height / cr.width));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; tmp.width = w; tmp.height = h; stage.width = w; stage.height = h; snap = true; }
    const k = w / cr.width;
    geom = {x: (vr.left - cr.left) * k, y: (vr.top - cr.top) * k, w: vr.width * k, h: vr.height * k};
  }

  // Draw one side's strip: the outermost few source rows/columns stretched from just inside the picture
  // (under its fade) out to the canvas edge, then faded with distance from the picture.
  function side(s, strength, fade) {
    const smooth01 = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
    const {x, y, w, h} = geom, W = canvas.width, H = canvas.height, vw = video.videoWidth, vh = video.videoHeight;
    // Sample a band ~6% deep, not the outermost 3 px: stretched, it averages into the scene's tone instead of
    // smearing whatever touches the edge (Marble's hat left a tan ghost beside the picture).
    const depthX = Math.max(3, Math.round(vw * .06)), depthY = Math.max(3, Math.round(vh * .06)), depth = 3;
    tctx.clearRect(0, 0, W, H);
    let g;
    if (s === 't') { const inside = h * fade, y0 = Math.max(0, y - h * .35), y1 = y + inside;   // reach capped like the halo
      tctx.drawImage(video, 0, 0, vw, depthY, x - w * .04, y0, w * 1.08, y1 - y0);
      g = tctx.createLinearGradient(0, y1, 0, y0); }
    if (s === 'b') { const inside = h * fade, y0 = y + h - inside, y1 = Math.min(H, y + h + h * .35);
      tctx.drawImage(video, 0, vh - depthY, vw, depthY, x - w * .04, y0, w * 1.08, y1 - y0);
      g = tctx.createLinearGradient(0, y0, 0, y1); }
    if (s === 'l') { const inside = w * fade, x0 = Math.max(0, x - w * .35), x1 = x + inside;
      tctx.drawImage(video, 0, 0, depthX, vh, x0, y - h * .04, x1 - x0, h * 1.08);
      g = tctx.createLinearGradient(x1, 0, x0, 0); }
    if (s === 'r') { const inside = w * fade, x0 = x + w - inside, x1 = Math.min(W, x + w + w * .35);
      tctx.drawImage(video, vw - depthX, 0, depthX, vh, x0, y - h * .04, x1 - x0, h * 1.08);
      g = tctx.createLinearGradient(x0, 0, x1, 0); }
    // On a light page, a dark continuation (hair, shadow) reads as a smudge, not light spilling out: dim it by
    // how dark the strip is. (Beach girl: her dark hair, stretched upward, made a grey cloud over the frame.)
    const light = ['light', 'sand'].includes(document.body.dataset.backdrop);
    if (light) {
      const rx = s === 'l' ? 0 : s === 'r' ? Math.floor(x + w * (1 - fade)) : Math.floor(x), ry = s === 't' ? 0 : s === 'b' ? Math.floor(y + h * (1 - fade)) : Math.floor(y);
      const rw = Math.max(1, Math.floor(s === 'l' || s === 'r' ? (s === 'l' ? x + w * fade : W - rx) : w)), rh = Math.max(1, Math.floor(s === 't' || s === 'b' ? (s === 't' ? y + h * fade : H - ry) : h));
      // Reading pixels back stalls the GPU (~3 ms per strip), so refresh each side's brightness at most twice a second.
      const now = performance.now(), cached = lumCache[s];
      let lum = cached && now - cached.at < 500 ? cached.v : null;
      if (lum === null || snap) {
        const d = tctx.getImageData(Math.max(0, rx), Math.max(0, ry), Math.min(rw, W), Math.min(rh, H)).data;
        let sum = 0, n = 0; for (let i = 0; i < d.length; i += 16) if (d[i + 3]) { sum += (.2126 * d[i] + .7152 * d[i + 1] + .0722 * d[i + 2]) / 255; n++; }
        lum = n ? sum / n : 1; lumCache[s] = {v: lum, at: now, shown: cached && !snap ? cached.shown : lum};
      }
      // ease toward each new measurement instead of stepping to it every half second
      const c = lumCache[s]; c.shown += (c.v - c.shown) * .12; lum = c.shown;
      strength *= smooth01((lum - .3) / .4);   // ≤30% luminance: off; ≥70%: full
      if (strength < .02) return;
    }
    // strong right at the picture, gone about two thirds of the way to the canvas edge
    g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(.15, 'rgba(0,0,0,.7)');
    g.addColorStop(.35, 'rgba(0,0,0,.25)'); g.addColorStop(.55, 'rgba(0,0,0,0)');
    tctx.globalCompositeOperation = 'destination-in'; tctx.fillStyle = g; tctx.fillRect(0, 0, W, H);
    // Taper along the strip too, so its ends melt away instead of making rectangular corners.
    const along = (s === 't' || s === 'b') ? tctx.createLinearGradient(x - w * .04, 0, x + w * 1.04, 0)
                                           : tctx.createLinearGradient(0, y - h * .04, 0, y + h * 1.04);
    along.addColorStop(0, 'rgba(0,0,0,0)'); along.addColorStop(.3, 'rgba(0,0,0,1)');
    along.addColorStop(.7, 'rgba(0,0,0,1)'); along.addColorStop(1, 'rgba(0,0,0,0)');
    tctx.fillStyle = along; tctx.fillRect(0, 0, W, H);
    tctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = strength; ctx.drawImage(tmp, 0, 0); ctx.globalAlpha = 1;
  }

  return {
    canvas,
    reset() { geom = null; snap = true; out.clearRect(0, 0, canvas.width, canvas.height); },
    // protect: {l,r,t,b} 0–1 (eased); fades: {l,r,t,b} widths as fractions of the picture
    draw(protect, fades) {
      if (video.readyState < 2) return;
      if (!geom) measure(); if (!geom) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const s of SIDES) {
        const strength = MAX * Math.min(1, Math.max(0, (protect[s] - .1) / .7));   // nothing until a side is clearly protected
        if (strength > .02) try { side(s, strength, fades[s]); } catch { /* frame not ready */ }
      }
      const now = performance.now(), dt = Math.min(.25, (now - (last || now)) / 1000); last = now;
      const k = snap || protect.cut ? 1 : 1 - Math.exp(-dt / .15); snap = false;
      out.globalCompositeOperation = 'destination-in'; out.fillStyle = `rgba(0,0,0,${1 - k})`; out.fillRect(0, 0, canvas.width, canvas.height);
      out.globalCompositeOperation = 'lighter'; out.globalAlpha = k; out.drawImage(stage, 0, 0); out.globalAlpha = 1; out.globalCompositeOperation = 'source-over';
    },
  };
}
