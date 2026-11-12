// Picture renderer for Ambient Fade (WebGL2). Draws the video through the fade computed per pixel:
//   thin 5% feather × max( soft edges , notches )
// Soft edges: the four eased edge fades (widths from the animated --fade-* properties).
// Notches: up to 6 soft ellipses around subjects (focus.js), so only the part of an edge near a subject clears.
// Why not CSS masks: an 8-layer mask with mask-composite on a <video> element rendered blank in Chrome
// whenever the notch layers were present (the same stack on a plain <div> was correct), and Safari/Firefox
// differ again. Doing the maths here is exact and identical everywhere. The <video> stays (invisible) for
// playback, controls, fullscreen and picture-in-picture.
const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = vec2(p.x*.5+.5, .5-p.y*.5); gl_Position = vec4(p,0,1); }`;
const FS = `#version 300 es
precision mediump float;
in vec2 uv; out vec4 o;
uniform sampler2D frame;
uniform vec4 fade;        // l, r, t, b widths as fractions of the picture
uniform vec4 notch[6];    // x, y, rx, ry (fractions)
uniform float notchA[6];  // strength 0..1
uniform float soft;       // opaque core as a fraction of the notch radius
uniform float thin;       // thin feather width on every side
uniform vec4 view;        // reframe crop in texture space: x0, y0, w, h (0,0,1,1 = whole frame)
float ease(float t){ t = clamp(t,0.,1.); return t*t*(3.-2.*t); }
void main(){
  vec4 c = texture(frame, view.xy + uv * view.zw);
  vec4 f = max(fade, vec4(1e-4));
  float edges = ease(uv.x/f.x) * ease((1.-uv.x)/f.y) * ease(uv.y/f.z) * ease((1.-uv.y)/f.w);
  float n = 0.;
  for (int i = 0; i < 6; i++) {
    vec4 q = notch[i];
    if (notchA[i] <= 0.001) continue;
    float d = length((uv - q.xy) / max(q.zw, vec2(1e-3)));
    n = max(n, notchA[i] * (1. - smoothstep(soft, 1., d)));
  }
  float t = max(thin, 1e-4);
  float feather = ease(uv.x/t) * ease((1.-uv.x)/t) * ease(uv.y/t) * ease((1.-uv.y)/t);
  float a = max(edges, n) * feather;
  o = vec4(c.rgb * a, a);   // premultiplied
}`;

// Next frame, whichever comes first: a display refresh or a 40 ms timer. Inside the desktop app's browser
// pane, refresh callbacks (and video-frame callbacks) can stop entirely while the page has nothing visibly
// animating (the real <video> sits invisible under this canvas), and the picture froze on one frame while
// playback carried on. Timers keep running, and each draw makes the page animate again. Returns a cancel function.
export function scheduleFrame(cb) {
  let done = false, raf = 0, timer = 0;
  const run = () => { if (done) return; done = true; cancelAnimationFrame(raf); clearTimeout(timer); cb(performance.now()); };
  raf = requestAnimationFrame(run); timer = setTimeout(run, 40);
  return () => { done = true; cancelAnimationFrame(raf); clearTimeout(timer); };
}

export function createGpuFilm(video, host) {
  const canvas = document.createElement('canvas');
  canvas.id = 'gpuFilm'; canvas.setAttribute('aria-hidden', 'true');
  const gl = canvas.getContext('webgl2', {premultipliedAlpha: true, alpha: true, antialias: false});
  if (!gl) return null;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  const U = n => gl.getUniformLocation(prog, n);
  gl.uniform1i(U('frame'), 0);
  let on = false, frameId, soft = .4, thin = .05, view = [0, 0, 1, 1], viewShown = [0, 0, 1, 1];
  // Notches and fades arrive ~6×/s from the tracker. Each value follows its target on a critically damped
  // spring (per drawn frame): unlike plain exponential easing, motion starts and stops with no jump in speed,
  // so a fade opening, a notch arriving or a notch leaving all ramp in and out.
  const target = [], slotUid = [0, 0, 0, 0, 0, 0];
  const mk = () => ({x: .5, y: .5, rx: .1, ry: .1, a: 0});
  const shown = slotUid.map(mk), vel = slotUid.map(() => ({x: 0, y: 0, rx: 0, ry: 0, a: 0}));
  let lastDraw = 0, uploadedAt = -1, uploaded = false;
  for (const ev of ['loadeddata', 'seeked', 'emptied']) video.addEventListener(ev, () => { uploaded = false; });
  const fade = [.278, .278, .285, .285], fadeShown = [.278, .278, .285, .285], fadeVel = [0, 0, 0, 0], viewVel = [0, 0, 0, 0];
  const SPRING = {geo: .26, a: .3, fade: .3, view: .55};   // s: smooth time (≈ time to reach the target)
  // One step of a critically damped spring toward t (game-programming "SmoothDamp"); returns [value, velocity].
  function spring(x, v, t, st, dt) {
    const o = 2 / st, k = o * dt, e = 1 / (1 + k + .48 * k * k + .235 * k * k * k), c = x - t, tmp = (v + o * c) * dt;
    return [t + (c + tmp) * e, (v - o * tmp) * e];
  }
  function snapAll() {
    for (let i = 0; i < 6; i++) { Object.assign(shown[i], target[i] || {a: 0}); for (const key in vel[i]) vel[i][key] = 0; }
    for (let i = 0; i < 4; i++) { fadeShown[i] = fade[i]; fadeVel[i] = 0; }
  }

  function size() {
    const r = video.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    Object.assign(canvas.style, {width: video.style.width, height: video.style.height});
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  function draw() {
    if (!on || video.readyState < 2) return;
    const now = performance.now(), dt = Math.min(.1, Math.max(.001, (now - (lastDraw || now - 16)) / 1000));
    lastDraw = now;
    for (let i = 0; i < 6; i++) {
      const t = target[i] || {...shown[i], a: 0}, n = shown[i], v = vel[i];
      for (const key of ['x', 'y', 'rx', 'ry']) [n[key], v[key]] = spring(n[key], v[key], t[key], SPRING.geo, dt);
      [n.a, v.a] = spring(n.a, v.a, t.a, SPRING.a, dt); n.a = Math.min(1, Math.max(0, n.a));
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    // upload only when the video has moved on (the loop runs at display rate; the video is usually 24–30 fps)
    if (video.currentTime !== uploadedAt || !uploaded) { try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video); uploaded = true; uploadedAt = video.currentTime; } catch { return; } }
    for (let i = 0; i < 4; i++) [fadeShown[i], fadeVel[i]] = spring(fadeShown[i], fadeVel[i], fade[i], SPRING.fade, dt);   // no style reads per frame
    gl.uniform4f(U('fade'), ...fadeShown);
    gl.uniform4fv(U('notch'), new Float32Array(shown.flatMap(n => [n.x, n.y, n.rx, n.ry])));
    gl.uniform1fv(U('notchA'), new Float32Array(shown.map(n => n.a)));
    for (let i = 0; i < 4; i++) [viewShown[i], viewVel[i]] = spring(viewShown[i], viewVel[i], view[i], SPRING.view, dt);
    gl.uniform4f(U('view'), ...viewShown);
    gl.uniform1f(U('soft'), soft); gl.uniform1f(U('thin'), thin);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  // Display-refresh loop. It used requestVideoFrameCallback, but the <video> is invisible under this canvas
  // (opacity 0) and Chrome may stop presenting its frames: the callbacks stopped and the picture froze while
  // playback (and the controls) carried on.
  function loop() { draw(); frameId = scheduleFrame(loop); }
  function stop() { if (frameId === undefined) return; frameId(); frameId = undefined; }
  // While paused, keep drawing briefly so eased notches and CSS fade transitions still settle on screen.
  let settleUntil = 0;
  function settle() { settleUntil = performance.now() + 900; const tick = () => { draw(); if (on && video.paused && performance.now() < settleUntil) requestAnimationFrame(tick); }; requestAnimationFrame(tick); }

  return {
    canvas,
    get on() { return on; },
    drawNow() { draw(); },   // debug: draw one frame now (the recorder drives time)
    get debugState() { return {notches: shown.map(n => ({...n})), fades: [...fadeShown], targets: target.map(n => ({...n})), fadeTargets: [...fade]}; },   // debug: what is on screen now
    set soft(v) { soft = v; }, set thin(v) { thin = v; },
    // Reframe: crop window in 0–1 texture units; eased in draw() so the pan glides.
    // fades in percent of the picture: {l,r,t,b}
    setFades(f) { fade[0] = f.l / 100; fade[1] = f.r / 100; fade[2] = f.t / 100; fade[3] = f.b / 100; if (on && video.paused) settle(); },
    setView(x0, y0, w, h) { view = [x0, y0, w, h]; if (on && video.paused) settle(); },
    enable(v) {
      on = v; canvas.hidden = !v; host.classList.toggle('gpu-film', v);
      if (v) { if (!canvas.isConnected) video.after(canvas); size(); settle(); if (!video.paused) { stop(); loop(); } }
      else stop();
    },
    resize() { if (on) { size(); settle(); } },
    play() { if (on) { stop(); loop(); } },
    pause() { stop(); settle(); },
    // Debug: draw one frame with everything settled and return it as a PNG (works in a hidden tab, where
    // animation frames don't run).
    snapshot() { snapAll(); for (let i = 0; i < 4; i++) viewShown[i] = view[i];
      const was = on; on = true; lastDraw = 0; draw(); on = was; return canvas.toDataURL('image/png'); },
    // notches: [{x,y,rx,ry,a}] in 0–1 units (already scaled by notch strength). snap: a hard cut, so show the new
    // shot's notches and fades at once instead of easing the old shot's away over the new picture.
    update(notches = [], snap = false) {
      // Keep each notch in its own slot (by uid): the tracker's list order changes as subjects come and go,
      // and by index a slot would glide from one subject's notch to another's.
      const list = notches.slice(0, 6), next = [null, null, null, null, null, null];
      for (const n of list) { const i = n.uid ? slotUid.indexOf(n.uid) : -1; if (i >= 0) next[i] = n; }
      for (const n of list) {
        if (next.includes(n)) continue;
        // a free slot: prefer one already faded out, else the faintest
        let i = -1, best = 2;
        for (let j = 0; j < 6; j++) if (!next[j] && !list.some(m => m.uid && m.uid === slotUid[j] && m !== n) && shown[j].a < best) { best = shown[j].a; i = j; }
        if (i < 0) continue;
        next[i] = n; slotUid[i] = n.uid || 0;
        if (shown[i].a < .02) { Object.assign(shown[i], {x: n.x, y: n.y, rx: n.rx, ry: n.ry}); for (const key of ['x', 'y', 'rx', 'ry']) vel[i][key] = 0; }   // a new notch starts where it is, then fades in
      }
      target.length = 0;
      for (let i = 0; i < 6; i++) target[i] = next[i] ? {x: next[i].x, y: next[i].y, rx: next[i].rx, ry: next[i].ry, a: next[i].a} : {...shown[i], a: 0};
      if (snap) snapAll();
      if (on && video.paused) settle();
    },
  };
}
