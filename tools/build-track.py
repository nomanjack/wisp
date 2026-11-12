#!/usr/bin/env python3
"""Turn a raw named-subject Jev track (assets/<scene>-raw.focus.json, one answer per subject every 0.2 s)
into the smooth multi-subject track the player reads (assets/<scene>.focus.json, version 3, multi).

Why: raw answers wobble a few % frame to frame and occasionally drop a subject for one sample (the girl at
1.6 s in Chase). Played back, that wobble shows as notches breathing and fades pumping. Here each subject gets:
  1. presence with hysteresis (appears at p >= .6, disappears below .35), single-sample gaps filled,
     appearances shorter than 0.4 s dropped
  2. each box edge median-filtered (kills one-sample outliers), then Gaussian-smoothed over time
     (sigma 0.15 s) within each visible run
  3. edges that really touch the frame stay on it (smoothing would pull them 1-2% inside, and the player
     uses "touches the edge" to open that side fully)
  4. resampled every 0.1 s
Usage: python3 tools/build-track.py chase
"""
import json, math, sys

scene = sys.argv[1]
raw = json.load(open(f'assets/{scene}-raw.focus.json'))
S = raw['samples']; ids = [x['id'] for x in S[0]['subjects']]
T = [s['t'] for s in S]; n = len(S)
ON, OFF, MIN_RUN, SIGMA, STEP, EDGE = .6, .35, .4, .15, .1, .025
SIDES = ['left', 'right', 'top', 'bottom']

def presence(ps):
    vis, on = [], False
    for p in ps:
        p = p or 0
        on = p >= ON if not on else p >= OFF
        vis.append(on)
    for i in range(1, n - 1):                       # fill one-sample dropouts
        if not vis[i] and vis[i - 1] and vis[i + 1]: vis[i] = True
    runs, i = [], 0                                 # drop runs shorter than MIN_RUN
    while i < n:
        if vis[i]:
            j = i
            while j + 1 < n and vis[j + 1]: j += 1
            if T[j] - T[i] + .2 < MIN_RUN:
                for k in range(i, j + 1): vis[k] = False
            else: runs.append((i, j))
            i = j + 1
        else: i += 1
    return vis, runs

def median3(a):
    return [a[0]] + [sorted(a[i - 1:i + 2])[1] for i in range(1, len(a) - 1)] + [a[-1]] if len(a) >= 3 else a[:]

def gauss(ts, vs, t):
    w = [math.exp(-((x - t) ** 2) / (2 * SIGMA ** 2)) for x in ts]
    return sum(a * b for a, b in zip(w, vs)) / sum(w)

tracks = {}
for k, sid in enumerate(ids):
    subj = [s['subjects'][k] for s in S]
    vis, runs = presence([x['p'] for x in subj])
    segs = []
    for i, j in runs:
        ts = T[i:j + 1]
        # a dropped sample inside a run (filled above) may have a junk box: borrow the neighbour's
        boxes = [subj[m]['box'] if (subj[m]['p'] or 0) >= OFF and subj[m]['box'] else None for m in range(i, j + 1)]
        for m in range(len(boxes)):
            if boxes[m] is None: boxes[m] = next(b for b in boxes[m:] + boxes[:m][::-1] if b)
        edges = {sd: median3([b[sd] for b in boxes]) for sd in SIDES}
        segs.append((ts, edges))
    tracks[sid] = segs

def box_at(sid, t):
    for ts, edges in tracks[sid]:
        if ts[0] - 1e-6 <= t <= ts[-1] + 1e-6:
            b = {sd: gauss(ts, edges[sd], t) for sd in SIDES}
            # keep real edge contact: if the nearest raw sample touches the frame, so does the smoothed box
            near = min(range(len(ts)), key=lambda m: abs(ts[m] - t))
            for sd in SIDES:
                raw_v = edges[sd][near]
                if sd in ('left', 'top') and raw_v <= EDGE: b[sd] = 0
                if sd in ('right', 'bottom') and raw_v >= 1 - EDGE: b[sd] = 1
            return {sd: round(min(1, max(0, b[sd])), 4) for sd in SIDES}
    return None

area = lambda b: (b['right'] - b['left']) * (b['bottom'] - b['top'])
out = []
for i in range(int(round(T[-1] / STEP)) + 1):
    t = round(i * STEP, 2)
    subs = [{'box': b, 'confidence': 1} if (b := box_at(sid, t)) else None for sid in ids]
    present = [x for x in subs if x]
    main = max(present, key=lambda x: area(x['box'])) if present else None
    out.append({'t': t, 'box': main['box'], 'confidence': 1, 'actor': main, 'subjects': subs} if main else
               {'t': t, 'box': {'left': 0, 'right': 1, 'top': 0, 'bottom': 1}, 'confidence': 0, 'subjects': []})

track = {'version': 3, 'scene': scene, 'model': raw.get('model'), 'sampling': 'named-subjects, smoothed',
         'multi': True, 'people': raw.get('people', True), 'cuts': raw.get('cuts', []), 'subjectIds': ids, 'samples': out}
json.dump(track, open(f'assets/{scene}.focus.json', 'w'))
for sid in ids: print(sid, [(segs[0][0], segs[0][-1]) for segs in tracks[sid]])
print(len(out), 'samples')
