// Dev panel: DialKit (plain-JS build) docked on the right, always available.
// Every control writes straight into the live player through `hooks`, so changes show while video plays.
import {createDialKit, createDialRoot} from 'dialkit/vanilla';
import 'dialkit/vanilla/styles.css';

const WIDTH = 320;

export function mountDevPanel(hooks) {
  const aside = document.createElement('aside');
  aside.id = 'devPanel'; aside.setAttribute('aria-label', 'Dev panel');
  const tab = document.createElement('button');
  tab.id = 'devTab'; tab.type = 'button'; tab.textContent = 'Dev';
  tab.setAttribute('aria-controls', 'devPanel'); tab.setAttribute('aria-expanded', 'false');
  tab.onclick = () => { const open = !document.body.classList.contains('dev-open'); document.body.classList.toggle('dev-open', open); tab.setAttribute('aria-expanded', String(open)); };
  document.body.append(aside, tab);
  document.body.classList.add('has-dev');
  document.documentElement.style.setProperty('--dev-width', `${WIDTH}px`);

  createDialRoot({mode: 'inline', target: aside, theme: 'light', versions: 'menu'});

  // Each panel calls only the hooks whose values changed (so e.g. switching mode doesn't re-fire on every slider move).
  // While `syncing`, values are coming *from* the player, so the panel updates its display without calling back.
  const kits = {};
  let syncing = false;
  function panel(name, config, apply, options = {}) {
    let prev = null;
    const kit = createDialKit(name, config, options);
    kit.subscribe(values => {
      const flat = flatten(values);
      if (!syncing) for (const [path, v] of Object.entries(flat)) if (!prev || prev[path] !== v) apply[path]?.(v);
      prev = flat;
    });
    kits[name] = kit;
    return kit;
  }

  const t = hooks.tuning, g = hooks.edgeGlow;

  // Player: the handful of things a viewer would change. Everything tuned for the demo lives under Advanced
  // (collapsed by default) with the tested defaults.
  panel('Player', {
    scene: {type: 'select', options: hooks.scenes, default: hooks.current.scene},
    backdrop: {type: 'select', options: ['dark', 'light', 'sand', 'blue'], default: 'light'},
    softness: [hooks.current.softness, 0, 100, 1],
    atmosphere: [hooks.current.atmosphere, 0, 100, 1],
    contentAware: true,
    reframe: false,
    openVideo: {type: 'action', label: 'Open video'},
    restart: {type: 'action'},
  }, {
    scene: hooks.setScene, backdrop: hooks.setBackdrop,
    softness: hooks.setSoftness, atmosphere: hooks.setAtmosphere,
    contentAware: hooks.setContentAware, reframe: hooks.setReframe,
  }, {onAction: a => { if (/openVideo$/.test(a)) hooks.openVideo(); if (/restart$/.test(a)) hooks.restart(); }});

  panel('Advanced', {
    fade: {_collapsed: true, protection: [.93, 0, 1, .01], budget: [t.budget, .5, 2, .05], weaker: [t.weakEase, 0, 1, .05], stronger: [t.strongEase, 0, 1, .05]},
    timing: {_collapsed: true, hold: [t.holdThreshold, 0, .5, .01], open: [t.openTime, .05, 2, .01], release: [t.releaseTime, .1, 5, .05], smooth: [t.smoothTime, 0, 1, .01], notchIn: [t.notchIn, .05, 2, .01], notchOut: [t.notchOut, .05, 3, .05]},
    notches: {_collapsed: true, size: [t.notchPad, .8, 2.5, .05], soft: [t.notchSoft, .1, .95, .01], strength: [t.notchStrength, 0, 1, .01]},
    glow: {_collapsed: true, liveGlow: true, ambientBlur: [34, 0, 80, 1], edgeGlow: [g.max, 0, 1, .05], edgeGlowBlur: [30, 0, 80, 1]},
    detectors: {_collapsed: true, jevTrack: t.useTrack, liveWeight: [t.liveWeight, 0, 1, .05], lookahead: [t.lookahead, 0, 2, .1], actorMin: [t.actorMin, 0, 1, .01], faces: true, debugMap: hooks.current.debug, resetTracker: {type: 'action'}},
    render: {_collapsed: true, reframeZoom: [1.1, 1, 1.3, .01], gpuRenderer: true},
  }, {
    'fade.protection': hooks.setKeep,
    'fade.budget': v => { t.budget = v; hooks.refresh(); },
    'fade.weaker': v => { t.weakEase = v; hooks.refresh(); },
    'fade.stronger': v => { t.strongEase = v; hooks.refresh(); },
    'timing.hold': v => { t.holdThreshold = v; },
    'timing.open': v => { t.openTime = v; },
    'timing.notchIn': v => { t.notchIn = v; },
    'timing.notchOut': v => { t.notchOut = v; },
    'timing.release': v => { t.releaseTime = v; },
    'timing.smooth': v => { t.smoothTime = v; },
    'notches.size': v => { t.notchPad = v; hooks.refresh(); },
    'notches.soft': hooks.setNotchSoft,
    'notches.strength': v => { t.notchStrength = v; hooks.refresh(); },
    'glow.liveGlow': hooks.setLiveGlow, 'glow.ambientBlur': hooks.setAmbientBlur,
    'glow.edgeGlow': v => { g.max = v; hooks.refresh(); }, 'glow.edgeGlowBlur': hooks.setEdgeGlowBlur,
    'detectors.jevTrack': v => { t.useTrack = v; hooks.refresh(); },
    'detectors.liveWeight': v => { t.liveWeight = v; hooks.refresh(); },
    'detectors.lookahead': v => { t.lookahead = v; hooks.refresh(); },
    'detectors.actorMin': v => { t.actorMin = v; hooks.refresh(); },
    'detectors.faces': hooks.setFaces, 'detectors.debugMap': hooks.setDebug,
    'render.reframeZoom': hooks.setReframeZoom, 'render.gpuRenderer': hooks.setGpu,
  }, {defaultCollapsed: true, onAction: a => { if (/resetTracker$/.test(a)) hooks.resetTracker(); }});

  const api = {
    // Reflect changes made elsewhere (mode presets, drag-and-drop) without re-triggering the player.
    sync(byPanel) {
      syncing = true;
      try {
        for (const [name, values] of Object.entries(byPanel)) {
          const kit = kits[name]; if (!kit) continue;
          const cur = flatten(kit.getValues());
          for (const [path, v] of Object.entries(values)) if (v !== undefined && cur[path] !== v) kit.setValue(path, v);
        }
      } finally { syncing = false; }
    },
  };

  return api;
}

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, path, out); else out[path] = v;
  }
  return out;
}
