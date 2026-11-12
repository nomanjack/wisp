// 4 · Faces first: on-device face detection (MediaPipe BlazeFace, short range, ~230 KB model).
// Loaded lazily from /vendor so it never weighs down the main bundle. Faces are passed to the focus
// tracker as must-keep boxes, applied after the tightening cap, so a face is never dissolved.
const BASE = '/vendor/mediapipe';
let detector = null, loading = null, failed = false;

async function load() {
  if (detector || failed) return detector;
  loading ??= (async () => {
    try {
      const {FilesetResolver, FaceDetector} = await import(/* external */ `${BASE}/vision_bundle.mjs`);
      const files = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
      const options = (delegate) => ({
        baseOptions: {modelAssetPath: `${BASE}/blaze_face_short_range.tflite`, delegate},
        runningMode: 'VIDEO', minDetectionConfidence: .7,
      });
      try { detector = await FaceDetector.createFromOptions(files, options('GPU')); }
      catch { detector = await FaceDetector.createFromOptions(files, options('CPU')); }
    } catch (e) { failed = true; console.warn('Face detection unavailable:', e); }
    return detector;
  })();
  return loading;
}

let lastTs = -1, faces = [], tracked = [];   // tracked: [{box, seen}] smoothed across frames
const iou = (a, b) => { const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)), y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)); const i = x * y; return i / ((a.right - a.left) * (a.bottom - a.top) + (b.right - b.left) * (b.bottom - b.top) - i || 1); };
// Raw detections wobble frame to frame and sometimes drop out for a frame; seen in slow motion that pumps the
// top fade. Match each detection to the previous face, ease the box toward it, and hold a lost face 0.6 s
// (video time, so it behaves the same at any playback speed).
const EASE = .35, HOLD_S = .6;
function smoothFaces(raw, t) {
  const next = [];
  for (const box of raw) {
    let best = null, bestIou = .2;
    for (const f of tracked) { const o = iou(f.box, box); if (o > bestIou) { best = f; bestIou = o; } }
    if (best) { for (const k of ['left', 'right', 'top', 'bottom']) best.box[k] += (box[k] - best.box[k]) * EASE; best.seen = t; best.hits = (best.hits || 0) + 1; next.push(best); tracked = tracked.filter(f => f !== best); }
    else next.push({box: {...box}, seen: t, hits: 0});
  }
  for (const f of tracked) if (Math.abs(t - f.seen) <= HOLD_S) next.push(f);   // briefly hold faces that dropped out
  tracked = next;
  // a face only counts once it's been seen twice in a row: one-off detections on drawings and textures are ignored
  return tracked.filter(f => f.hits >= 1).map(f => ({...f.box}));
}
// Returns the latest face boxes in 0–1 units (padded to include hair and chin). Never blocks playback:
// if the model is still loading, returns the previous result.
export function detectFaces(video) {
  if (!detector) { load(); return faces; }
  if (video.readyState < 2 || !video.videoWidth) return faces;
  const ts = Math.max(lastTs + 1, Math.round(performance.now()));
  lastTs = ts;
  try {
    const res = detector.detectForVideo(video, ts);
    const W = video.videoWidth, H = video.videoHeight;
    const raw = res.detections.map(d => {
      const b = d.boundingBox, padX = b.width * .25, padTop = b.height * .45, padBottom = b.height * .2;
      return {
        left: Math.max(0, (b.originX - padX) / W), right: Math.min(1, (b.originX + b.width + padX) / W),
        top: Math.max(0, (b.originY - padTop) / H), bottom: Math.min(1, (b.originY + b.height + padBottom) / H),
      };
    });
    faces = smoothFaces(raw, video.currentTime);
  } catch { /* a bad frame shouldn't stop playback */ }
  return faces;
}
export function clearFaces() { faces = []; tracked = []; }
export const facesReady = () => !!detector;
