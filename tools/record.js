// Frame-exact recorder for the Ambient Fade player (dev only; needs /?debug).
// The browser pane throttles hidden pages, so a screen capture stutters. Instead this drives a virtual clock:
// each output frame seeks the video, runs the player's own paint/analysis at its normal cadence (~12/s paint,
// ~6/s analysis), draws the WebGL picture with real spring easing, then composites the halo, edge glow, shade
// and picture the way style.css stacks them, and encodes H.264 with WebCodecs + mp4-muxer.
// Usage (in the page): const {record} = await import('/tools/record.js'); await record({name:'chase-1x'})
import {Muxer, ArrayBufferTarget} from '/node_modules/mp4-muxer/build/mp4-muxer.mjs';

export async function record({name = 'recording', from = 0, to, rate = 1, fps = 30, encode = true, capture = 0, bitrate = 10e6} = {}) {
  // capture: every this many seconds of video, keep the original frame and the composited player frame as JPEG
  // (base64, 768 px wide) for the QA judge (tools/qa.js). 0 = off.
  const captures = []; let nextCapture = from;
  const log = [];   // per frame: what is on screen (for the motion audit, tools/motion-audit.js)
  const video = document.getElementById('video'), player = video.closest('.player') || video.parentElement;
  const amb = document.getElementById('ambient'), glow = document.getElementById('edgeGlow'), film = document.getElementById('gpuFilm');
  if (!window.__gpu?.drawNow || !film) throw new Error('needs ?debug and the WebGL renderer');
  to ??= video.duration - .05;
  const seek = t => new Promise(r => { video.addEventListener('seeked', r, {once: true}); video.currentTime = t; });

  // virtual clock and a visible page
  const realNow = performance.now.bind(performance); let vt = realNow();
  performance.now = () => vt;
  Object.defineProperty(document, 'hidden', {configurable: true, get: () => false});
  video.pause(); window.__rec = false; window.__focus.reset();
  await seek(from);                       // the normal seek path: halo and glow snap to this frame
  window.__rec = true;

  const pr = player.getBoundingClientRect(), rel = el => { const r = el.getBoundingClientRect(); return {x: r.left - pr.left, y: r.top - pr.top, w: r.width, h: r.height}; };
  const S = Math.min(2, 1920 / pr.width), W = Math.round(pr.width * S / 2) * 2, H = Math.round(pr.height * S / 2) * 2;
  const out = new OffscreenCanvas(W, H), o = out.getContext('2d'), tmp = new OffscreenCanvas(W, H), tc = tmp.getContext('2d');
  const css = getComputedStyle(player), num = (v, d) => parseFloat(v) || d;
  const ambOp = num(css.getPropertyValue('--ambient-opacity'), .7);
  let bg = 'transparent';
  for (let el = player; el && /rgba\(0, 0, 0, 0\)|transparent/.test(bg); el = el.parentElement) bg = getComputedStyle(el).backgroundColor;
  if (/rgba\(0, 0, 0, 0\)/.test(bg)) bg = '#101214';
  const halo = {x: 50, y: 50};
  const shade = player.querySelector('.shade'), shadeOn = !!shade && getComputedStyle(shade).backgroundImage !== 'none';   // Ambient Fade has no bottom shade

  // one masked, filtered layer: draw into tmp, apply mask with destination-in, put on out
  function layer(src, r, filter, alpha, mask) {
    tc.globalCompositeOperation = 'source-over'; tc.clearRect(0, 0, W, H); tc.filter = filter;
    tc.drawImage(src, r.x * S, r.y * S, r.w * S, r.h * S); tc.filter = 'none';
    tc.globalCompositeOperation = 'destination-in'; mask(tc, r.x * S, r.y * S, r.w * S, r.h * S);
    o.globalAlpha = alpha; o.drawImage(tmp, 0, 0); o.globalAlpha = 1;
  }
  const ambMask = (c, x, y, w, h) => {   // radial-gradient(ellipse 50% 50% at halo, …)
    c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip();
    c.translate(x + w * halo.x / 100, y + h * halo.y / 100); c.scale(w * .5, h * .5);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
    for (const [s, a] of [[.1, 1], [.28, .94], [.45, .7], [.62, .38], [.79, .12], [1, 0]]) g.addColorStop(s, `rgba(0,0,0,${a})`);
    c.fillStyle = g; c.fillRect(-4, -4, 8, 8); c.restore();
    c.save(); c.globalCompositeOperation = 'destination-out'; c.beginPath(); c.rect(0, 0, W, H); c.rect(x, y, w, h); c.fill('evenodd'); c.restore();
  };
  const glowMask = (c, x, y, w, h) => {  // two 8% linear edges, intersected
    for (const [x0, y0, x1, y1] of [[x, 0, x + w, 0], [0, y, 0, y + h]]) {
      const g = c.createLinearGradient(x0, y0, x1, y1); g.addColorStop(0, '#0000'); g.addColorStop(.08, '#000'); g.addColorStop(.92, '#000'); g.addColorStop(1, '#0000');
      c.fillStyle = g; c.fillRect(0, 0, W, H);
    }
  };

  const muxer = new Muxer({target: new ArrayBufferTarget(), video: {codec: 'avc', width: W, height: H}, fastStart: 'in-memory'});
  const enc = new VideoEncoder({output: (c, m) => muxer.addVideoChunk(c, m), error: e => { throw e; }});
  enc.configure({codec: 'avc1.640033', width: W, height: H, bitrate, framerate: fps});

  const frames = Math.floor((to - from) / rate * fps);
  let lastPaint = -1e9;
  for (let i = 0; i <= frames; i++) {
    vt += 1000 / fps;
    await seek(Math.min(to, from + i / fps * rate));
    if (vt - lastPaint >= 83) { window.__paint(); lastPaint = vt; }
    window.__gpu.drawNow();
    { const d = window.__gpu.debugState, f = window.__focus.state; log.push({t: +video.currentTime.toFixed(3), fades: d.fades.map(v => +v.toFixed(4)), notches: d.notches.map(n => ({x: +n.x.toFixed(4), y: +n.y.toFixed(4), rx: +n.rx.toFixed(4), ry: +n.ry.toFixed(4), a: +n.a.toFixed(3)})), protect: ['l', 'r', 't', 'b'].map(k => +(f[k] ?? 0).toFixed(3))}); }
    // halo centre: the page eases --halo-x/y with a 600 ms CSS transition, which the virtual clock can't drive
    const k = 1 - Math.exp(-(1 / fps) / .3);
    halo.x += (num(amb.style.getPropertyValue('--halo-x'), 50) - halo.x) * k; halo.y += (num(amb.style.getPropertyValue('--halo-y'), 50) - halo.y) * k;
    const grab = capture > 0 && video.currentTime >= nextCapture - 1e-3;
    if (!encode && !grab) continue;

    o.fillStyle = bg; o.fillRect(0, 0, W, H);
    layer(amb, rel(amb), `blur(${num(css.getPropertyValue('--ambient-blur'), 34) * S}px) saturate(.95)`, ambOp, ambMask);
    if (glow && getComputedStyle(glow).display !== 'none') layer(glow, rel(glow), `blur(${num(css.getPropertyValue('--edge-glow-blur'), 30) * S}px) saturate(.6)`, Math.min(1, ambOp * 1.25), glowMask);
    const fr = rel(film); o.drawImage(film, fr.x * S, fr.y * S, fr.w * S, fr.h * S);
    // the page clips everything to the player (overflow: clip); a blurred layer otherwise leaks a faint grey line
    // past its bottom edge when the player's height isn't a whole number of output pixels
    o.fillStyle = bg; o.fillRect(0, Math.floor(pr.height * S), W, H); o.fillRect(Math.floor(pr.width * S), 0, W, H);
    if (shadeOn) { const sg = o.createLinearGradient(0, 0, 0, H); sg.addColorStop(.55, '#080d1600'); sg.addColorStop(1, '#080d1644'); o.fillStyle = sg; o.fillRect(0, 0, W, H); }

    if (grab) {
      nextCapture += capture;
      const jpeg = async (src, sw, sh) => { const c = new OffscreenCanvas(768, Math.round(768 * sh / sw)); c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
        const b = await c.convertToBlob({type: 'image/jpeg', quality: .82}); const u8 = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let j = 0; j < u8.length; j += 32768) s += String.fromCharCode(...u8.subarray(j, j + 32768)); return btoa(s); };
      // The player image, independent of page layout: the backdrop colour with the rendered picture (fades and
      // notches) at the video's own aspect ratio, plus a margin so the judge sees the dissolve.
      const m = .08, vw = video.videoWidth, vh = video.videoHeight, crop = new OffscreenCanvas(Math.round(vw * (1 + 2 * m)), Math.round(vh * (1 + 2 * m)));
      const cc = crop.getContext('2d'); cc.fillStyle = bg; cc.fillRect(0, 0, crop.width, crop.height);
      cc.drawImage(film, vw * m, vh * m, vw, vh);
      captures.push({t: +video.currentTime.toFixed(2), frame: log.length - 1, margin: m, original: await jpeg(video, video.videoWidth, video.videoHeight), shown: await jpeg(crop, crop.width, crop.height)});
    }
    if (!encode) continue;
    const vf = new VideoFrame(out, {timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps)});
    enc.encode(vf, {keyFrame: i % 60 === 0}); vf.close();
    if (enc.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 0));
  }
  performance.now = realNow; delete document.hidden; window.__rec = false;
  if (!encode) { enc.close(); return {log, captures}; }
  await enc.flush(); muxer.finalize();
  const buf = muxer.target.buffer;
  const res = await fetch(`/api/debug/save?name=${encodeURIComponent(name)}`, {method: 'POST', body: buf});
  return {log, name: `tools/snaps/${name}.mp4`, frames: frames + 1, size: `${W}x${H}`, mb: +(buf.byteLength / 1e6).toFixed(1), saved: res.ok};
}
