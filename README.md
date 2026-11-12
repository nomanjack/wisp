# Wisp

Wisp is a video player with subject-aware edge fades, powered by [Jev](https://typesafe.ai), the image model by TypeSafe.

The picture dissolves softly into the page, lit by its own colours. Soft edges usually come with a catch: whatever sits at the edge gets softened too, so a child running into frame or a face near the top vanishes into the haze. Wisp uses Jev to find the people, animals and faces in every shot, sees them coming before they reach an edge, and opens the fade around them. They stay sharp while everything else drifts away.

![Wisp](docs/preview.jpg)

## How it works

1. **It knows who's in the shot.** Each clip comes with a focus track: TypeSafe's Jev image model marks every person, animal and face through the clip, ahead of time. A clip without a track falls back to on-device face detection (MediaPipe) and a live map of where the detail is.
2. **It plans ahead.** The player reads the track up to two seconds ahead. An edge starts opening before someone walks in, and it doesn't close while they're about to come back.
3. **It shapes the fade around them.** A WebGL shader draws every frame with four soft edges, plus soft oval openings around anyone at an edge. Even an opening fades out before the frame's border, so there's never a hard line.
4. **It moves gently.** Every edge and opening eases on a spring, so changes start and stop smoothly instead of jumping. Scene cuts are detected, and the fade resets instantly instead of sliding across.
5. **It lights the page.** A blurred halo and an edge glow, both taken from the same frame, carry the picture's colours out into the page.
6. **It checks its own work.** `tools/qa.js` plays every clip through the real player. It shows Jev the original frame and what Wisp drew, measures whether each person and face stayed visible, and flags sudden moves and hard edges.

## Run it

```bash
npm install
npm start
```

Open http://127.0.0.1:4173, then use **Open video** (or drop a file) to play your own clip. One sample clip is included.

## Better subject tracking (optional)

On their own, videos use on-device face and detail detection. For tighter tracking, Wisp can use a focus track built with TypeSafe's Jev image model:

1. Copy `.env.example` to `.env.local` and add your `TYPESAFE_API_KEY`. The key stays on the local server.
2. Put your clip in `assets/` and open `/tools/focus-track.html` to build `assets/<name>.focus.json`.

## Credits

[Video.js](https://videojs.org) controls, [DialKit](https://www.npmjs.com/package/dialkit) panel, [MediaPipe](https://developers.google.com/mediapipe) face detection. Sample clip: [MDN](https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4) (CC0).

## License

[MIT](LICENSE)
