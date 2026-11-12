# Wisp

Wisp is a content-aware video player that softly fades the edges of a video into the page, giving the video a dreamy feel.

It uses [Jev](https://typesafe.ai/), TypeSafe’s image model, to detect when a person or animal is about to move into the fade. Wisp adjusts the fade around them so they stay sharp as the rest of the picture blends into the page.

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
