# Wisp

A web video player whose edges dissolve softly into the page, lit by the video's own colours, without ever fading over the people in the shot.

![Wisp](docs/preview.jpg)

## How it works

- **Soft edges.** A WebGL renderer feathers the picture into the page, with a blurred halo taken from the same frame.
- **Subjects stay clear.** Where a person, animal or face reaches an edge, the fade pulls back and opens a soft gap around them.
- **Smooth motion.** Fades move on springs and snap cleanly on scene cuts.

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
