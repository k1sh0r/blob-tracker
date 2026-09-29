---
name: blob-tracking
description: Apply the "blob tracking" video effect (the TouchDesigner Blob Track look from viral edits) - white boxes that lock onto and follow things in the footage, lines connecting them, numbered ID/coordinate chips, a few inverted or shifted "window" boxes, optical-flow corner markers, all screen-blended into the picture. Ships a Python CLI/module and a browser (OpenCV.js) module with identical output, plus a method spec for porting to any tool. Use this whenever someone wants tracking boxes on a video, a blob-track / computer-vision / surveillance / HUD / "tracker" overlay, boxes and lines that follow objects with numbers, a TouchDesigner blob track look without TouchDesigner, or to add that effect to a clip, a web app, a Python pipeline, or a project in TouchDesigner, After Effects, DaVinci Resolve, Remotion, HyperFrames, Unity, Unreal or p5.js - even if they never say "blob".
---

# Blob tracking

Boxes lock onto what is in the footage (bright, dark, edge-dense and moving
regions), keep a stable ID from frame to frame, and are joined by lines. A
few boxes invert or shift their contents, white chips show IDs, coordinates
and areas, and corner markers ride optical flow. Everything is drawn in white
and screen-blended into the picture. The look was tuned at 1080x1920 and
scales to any size and orientation.

Two implementations produce the same detections (a parity test checks this):

- `scripts/blobtrack.py`: Python module and CLI (numpy, OpenCV, Pillow, ffmpeg)
- `scripts/blobtrack.js`: browser ES module (OpenCV.js), no build step

Both need `scripts/JetBrainsMono-Regular.ttf` beside them for the label font.
Paths below are relative to this skill's directory (the folder holding this
file). Commands and code below call it `$SKILL_DIR`, so export it first, e.g.
`export SKILL_DIR=/absolute/path/to/blob-tracking`.

## Pick the path that fits the project

| the user has | do this |
|---|---|
| a video file and a shell | **A. CLI**: one command, MP4 out with the audio |
| a Python project or pipeline | **B. Python module**: `BlobTracker(...).process(rgb)` per frame |
| a web / JS project | **C. Browser module**: `blobtrack.js` on a canvas |
| TouchDesigner, After Effects, Resolve/Fusion, Premiere, Remotion, HyperFrames, Unity, Unreal, p5.js, Processing... | **D. Other tools**: bake with A, or port from `references/method.md` |

If it is unclear, ask what the effect is for (one clip, an app feature, part
of an edit) and what runtime they have. When in doubt, path A gives the
result fastest.

### A. CLI (video file in, video file out)

Needs Python 3.9+ and `ffmpeg` + `ffprobe` on PATH (4.x or newer; macOS
`brew install ffmpeg`, Debian/Ubuntu `sudo apt install ffmpeg`, Windows
`winget install ffmpeg`). Install the three Python packages once, ideally in
a virtual environment:

```sh
python3 -m venv .venv && . .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r "$SKILL_DIR/scripts/requirements.txt"
python "$SKILL_DIR/scripts/blobtrack.py" input.mp4 -o output.mp4
```

Useful flags: `--start SEC --duration SEC` (process a section), `--crf N`
(x264 quality, default 16, lower is better), `--no-audio`, and every
parameter below as `--name value`. `python "$SKILL_DIR/scripts/blobtrack.py" --help`
lists them. It prints `output.mp4: N frames` and exits 1 with a one-line
`blobtrack: ...` message on any error.
The first run after installing is slower (Python compiles and loads the
packages once); later runs go at the speeds under Performance.

For a quick look before a full render, process two seconds and grab a still.
Pick a `--start` inside the clip (it fails with "no frames decoded" when the
start is past the end; use `--start 0` for short clips):

```sh
python "$SKILL_DIR/scripts/blobtrack.py" input.mp4 -o preview.mp4 --start 3 --duration 2
ffmpeg -v error -y -ss 1 -i preview.mp4 -frames:v 1 preview.png
```

### B. Python module (your own frame loop)

`blobtrack.py` imports as a module. Either put `scripts/` on `sys.path` or
copy **both** `blobtrack.py` and `JetBrainsMono-Regular.ttf` into the
project (the font is looked up beside the module). Frames are
`H x W x 3` **RGB** `uint8` arrays fed in order, one tracker per clip:

```python
import os, sys; sys.path.insert(0, os.path.join(os.environ["SKILL_DIR"], "scripts"))
from blobtrack import BlobTracker, probe, read_frames
from PIL import Image

info = probe("input.mp4")                                    # width, height, fps, ...
bt = BlobTracker(info["width"], info["height"])              # optional params: bright=90, ...
for i, rgb in enumerate(read_frames("input.mp4", info)):     # decoded RGB frames via ffmpeg
    out = bt.process(rgb)                                    # treated frame, same shape
    Image.fromarray(out).save(f"frame_{i:04d}.png")
    if i == 4: break
print(bt.last_tracks)    # [{id, x, y, w, h, kind, a, age}, ...] in output px; bt.last_points: [(x, y), ...]
```

- Frames from OpenCV (`cv2.VideoCapture`) are BGR: pass
  `cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)` and convert the result back before
  `cv2.VideoWriter`.
- To process a whole file (with audio) from Python, call
  `blobtrack.run("in.mp4", "out.mp4", params={"small": 25})`; it is what the
  CLI runs.
- `last_tracks` / `last_points` after each `process()` are the per-frame
  data if you want to draw the overlay in another tool (path D).
- Bad parameters raise `BlobTrackError` (a `ValueError`); unknown parameter
  names raise `TypeError`.

### C. Browser / JS project

Copy `scripts/blobtrack.js` **and** `scripts/JetBrainsMono-Regular.ttf`
into the same folder of the web project (without the font the chips fall
back to `monospace`). It is a plain ES module: serve it over HTTP (not
`file://`) and use it on the main thread (not in a worker). It loads
OpenCV.js from jsDelivr on first use.

```js
import { loadOpenCV, BlobTracker } from "./blobtrack.js";

await loadOpenCV();                         // once; loads OpenCV.js + the font. Never `await cv` yourself.
const bt = new BlobTracker(W, H, { small: 15 });   // one per clip, W x H = the frame size
const src = new OffscreenCanvas(W, H).getContext("2d", { willReadFrequently: true });
const out = document.querySelector("canvas").getContext("2d");   // W x H canvas that shows the result

// per frame, in presentation order:
src.drawImage(frame, 0, 0, W, H);           // a VideoFrame, <video>, ImageBitmap, <img>...
bt.process(src.getImageData(0, 0, W, H), out);   // draws the treated frame into `out` at (0, 0)

bt.dispose();                               // when the clip is done (frees OpenCV memory)
```

Getting frames:

- **Whole file -> MP4 download** (the robust route): decode and re-encode
  with Mediabunny's `Conversion` and call the tracker from its
  `video.process` hook, which runs once per frame, in order. The pattern
  (from the repo's working app):

  ```js
  import * as mb from "https://cdn.jsdelivr.net/npm/mediabunny@1.60.0/dist/bundles/mediabunny.min.mjs";
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target: new mb.BufferTarget() });
  let bt, src, outCanvas, outCtx;
  const process = sample => {
    const W = sample.displayWidth, H = sample.displayHeight;
    if (!bt) {
      bt = new BlobTracker(W, H);
      src = new OffscreenCanvas(W, H).getContext("2d", { willReadFrequently: true });
      outCanvas = new OffscreenCanvas(W, H); outCtx = outCanvas.getContext("2d");
    }
    sample.draw(src, 0, 0, W, H);
    bt.process(src.getImageData(0, 0, W, H), outCtx);
    return new mb.VideoSample(outCanvas, { timestamp: sample.timestamp, duration: sample.duration });
  };
  const conversion = await mb.Conversion.init({ input, output, tracks: "primary",
    video: { codec: "avc", forceTranscode: true, process } });
  await conversion.execute();                // audio is passed through
  bt?.dispose();
  const mp4 = new Blob([output.target.buffer], { type: "video/mp4" });
  ```

  `BufferTarget` keeps the whole output in RAM; for long clips stream it to
  OPFS as described in `references/traps.md`. `app/app.js` in the source
  repository (github.com/k1sh0r/blob-tracker) is the complete, tested
  version: progress, errors, OPFS output, timestamp checks.
- **Live `<video>` / webcam** (not measured): drawing the element each
  `requestVideoFrameCallback` should work, but at about 77 ms/frame expect
  roughly 13 frames/s at 1080x1920, so expect playback frames to be skipped
  and motion and optical flow to see bigger jumps than in an offline render.
  For a faithful result, render offline as above.

Errors: a bad argument to `process()` throws and leaves the tracker usable;
any later failure makes it unusable (create a new one). See `traps.md`.

### D. Other tools

Only the Python and browser implementations are tested in this repository.
The tool-specific advice below (TouchDesigner, After Effects, Resolve/Fusion,
Remotion, HyperFrames, Unity/Unreal, p5.js/Processing) is guidance that has
not been tested here. Choose by what the tool can do:

1. **Bake, then composite** (works everywhere, pixel-exact): run path A on
   the exact frames the edit will use and import the result as footage.
   Apply any crop, scale, reframe or speed change **before** running the
   effect: the boxes are measured against the exact pixels, and a transform
   applied afterwards slides every box off its object. For HTML/React video
   frameworks (Remotion, HyperFrames) this is the robust route; keep clip
   durations whole output frames.
2. **Export track data, draw natively**: use path B, dump `last_tracks` and
   `last_points` per frame to JSON, and draw boxes, lines and chips with the
   tool's own layers (After Effects expressions, an SVG/canvas layer in
   Remotion, Fusion shapes). Screen-blend the strokes (see method section 6).
3. **Reimplement**: follow `references/method.md`, which specifies every step
   (masks, kernels, thresholds, tracking, drawing, blend formulas) and maps
   them to TouchDesigner, shaders/game engines and p5.js/Processing. In
   TouchDesigner, the built-in Blob Track TOP gives a close look quickly,
   though its boxes and IDs will differ from this method.

## Parameters

Same names in the CLI (`--name value`), Python (`BlobTracker(w, h, name=value)`)
and JS (`new BlobTracker(w, h, { name: value })`).

| name | default | range | what it does |
|---|---|---|---|
| `large` / `medium` / `small` | 6 / 11 / 15 | int >= 0 | max boxes per frame in each size tier (large > 230 px side, medium > 70 px at 1080 short side) |
| `bright` | 90 | 0..100 | percentile above which pixels count as bright blobs (lower = more/larger bright boxes) |
| `dark` | 9 | 0..100 | percentile below which pixels count as dark blobs (higher = more dark boxes) |
| `motion` | 14 | 0..255 | grey-level change vs 3 frames back that counts as motion (lower = more motion boxes) |
| `corners` | 28 | int >= 0 | optical-flow corner markers (0 = none) |
| `labels` | 0.55 | 0..1 | share of boxes with a chip (large boxes always get one) |
| `invert` | 0.18 | 0..1 | share of boxes whose contents are inverted |
| `shift` | 0.12 | 0..1 | share of boxes whose contents are shifted |
| `screen` | 0.70 | 0..1 | strength of the white strokes (screen-blend opacity) |
| `chip` | 0.86 | 0..1 | opacity of the label chips |

Tuning:

- **Density**: scale all three quotas together (busier:
  `--large 8 --medium 16 --small 30`; calmer: `--large 3 --medium 6 --small 6`).
  If boxes are still sparse, the footage has few candidates: lower `motion`
  (e.g. 8), lower `bright` / raise `dark` a few points.
- **Size mix**: change the ratio between quotas (`--small 0` for only big
  boxes, `--large 0 --small 30` for a fine swarm).
- **Text amount**: `labels` (0 = only the large boxes and the readout keep
  chips; 1 = every box that has room).
- **Blend strength**: `screen` for the lines/boxes, `chip` for the labels;
  `invert 0 --shift 0` turns off the glitchy windows.
- Always check a still at full size before rendering a long clip.

## Output contract

- CLI: H.264 MP4 (yuv420p, BT.709 matrix, CRF 16, `+faststart`), same frame size
  (odd sizes lose one pixel to stay H.264-legal), same frame rate and frame
  count as the input (variable-frame-rate sources are resampled to their
  average rate), audio stream copied (re-encoded to AAC only if the codec
  cannot go in MP4). `--start` / `--duration` trim both picture and sound.
- Module (Python or JS): one treated frame per input frame, same size;
  frames must arrive in order; the first three frames have no motion boxes.
- Deterministic: the same input and parameters give the same output.

## Performance (M-series Mac)

| path | cost |
|---|---|
| Python, 1080x1920 | about 60 ms/frame (a 10 s 30 fps clip in about 20 s) |
| Python, 4K | about 95 ms/frame |
| blobtrack.js in Chrome, 1080x1920 | about 77 ms/frame |
| web app end to end (decode + effect + encode) | about 94 ms/frame |

Detection always runs at a 540 px short side, so 4K costs well under 4x
the 1080p time.

## Before you finish

- Look at a frame of the output (extract a PNG) rather than trusting that
  the command succeeded; check boxes sit on objects and chips are legible.
- If it looks wrong, read `references/traps.md` (OpenCV.js freeze, missing
  font, VFR sources, crop-after-analysis, HDR clips, and more).
- For reimplementation or exact numbers, `references/method.md` is the
  full specification; the code in `scripts/blobtrack.py` is the authority.
