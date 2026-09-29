# Known traps and their fixes

Every entry here happened while building this effect or is handled in the
bundled code. Read the section for the path you are on.

Contents

- Browser / OpenCV.js: `await cv` freeze · the 404ing docs URL · main thread only · label font · poisoned tracker · long clips · HDR clips
- Drawing: screen blend needs a white stroke layer
- Porting / parity: percentile · trunc vs floor · uint8 thresholds · corner drift between native and wasm
- Video I/O: VFR and duplicate timestamps · old ffmpeg · odd frame sizes
- Compositing in other tools: crop/scale after analysis · clip durations in HTML video frameworks

---

## Browser / OpenCV.js

### `await cv` freezes the tab

The OpenCV.js build's global `cv` is a thenable whose `then()` resolves with
`cv` itself. `await cv`, `Promise.resolve(cv)`, or returning `cv` from an
async function unwraps it forever: an endless microtask loop, the tab
freezes with no error.

Fix: never await or resolve with `cv`. Wait for the runtime callback, then
delete `then`:

```js
if (!cv.Mat) await new Promise(r => { cv.onRuntimeInitialized = r; });
delete cv.then;
```

`loadOpenCV()` in `scripts/blobtrack.js` does exactly this (and chains any
existing `onRuntimeInitialized`). Use it rather than writing your own loader.

### The docs.opencv.org script URL 404s

The `https://docs.opencv.org/<version>/opencv.js` URL that tutorials use
returns 404. `blobtrack.js` loads the pinned jsDelivr build
`https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js`
(exported as `OPENCV_URL`). To self-host (offline, strict CSP), download that
file and pass `loadOpenCV({ url: "/path/opencv.js" })`. The page's CSP must
allow the script origin and `'wasm-unsafe-eval'`.

### Main thread only

`loadOpenCV()` injects a `<script>` tag and registers the label font with
`document.fonts`, so it throws in a Web Worker ("runs on the main thread
only"). Run the tracker on the main thread; keep frames flowing with an async
pipeline (Mediabunny, as in `app/app.js` of the source repository,
github.com/k1sh0r/blob-tracker) rather than a worker.

### Labels come out in the wrong font

The chips use `JetBrainsMono-Regular.ttf`, fetched from beside
`blobtrack.js` (or from `loadOpenCV({ fontUrl })`). If it is not there,
`loadOpenCV` only warns and the chips fall back to the browser's
`monospace`, so the look changes silently (detections are unaffected).
Copy the `.ttf` next to `blobtrack.js` whenever you copy the module, and
check the console for `could not load the label font`. The Python module has
the same rule: the font must sit beside `blobtrack.py`.

### The tracker keeps throwing after one error

A bad argument to `process()` (wrong-size ImageData, missing output
context) throws before any state changes, and the tracker stays usable. Any
error after that point may leave its state half-advanced, so the tracker
marks itself unusable: every later `process()` throws
`tracker is unusable after an error; create a new one`. That is deliberate.
Create a new `BlobTracker` (and `dispose()` the old one) and restart the
clip from its first frame.

### Long clips run out of memory in the browser

Encoding into an in-memory buffer holds the whole output file in RAM (plus a
copy when it becomes a Blob). For anything longer than a short clip, stream
the output into a file in the origin-private file system (OPFS) with a
Mediabunny `StreamTarget` over a `FileSystemWritableFileStream`,
`Mp4OutputFormat({ fastStart: false })` and `{ chunked: true }`, as the repo's
`app/app.js` does. Fall back to `BufferTarget` only where OPFS writable
streams are missing (older Safari), and warn on large outputs.

### HDR / HLG phone clips (untested)

Browsers tone-map HDR (HLG/PQ) video to SDR when it is drawn into a 2D
canvas, and the ffmpeg path decodes to 8-bit RGB. The `bright`, `dark` and
`motion` thresholds were tuned on SDR footage; HDR sources have not been
tested with this effect. If boxes look too sparse or too dense on an iPhone
HDR clip, convert it to SDR first or retune `bright`/`dark`/`motion`, and
check the result by eye.

## Drawing

### Screen blend needs a separate white stroke layer

Screen-blending each stroke straight onto the frame (or drawing
semi-transparent white "over" it) gives a different, flatter look, and
overlapping strokes accumulate. The method draws every stroke **white** into
its own frame-sized layer, where a later stroke *replaces* the alpha under
it, and then screens the whole layer once at opacity `screen`. The chips are
a second layer, blended normally at opacity `chip`, after the strokes.

- Canvas: draw the strokes into an offscreen canvas; to replace rather than
  accumulate alpha, stroke once with `globalCompositeOperation =
  "destination-out"` and then again with `"source-over"`. Composite with
  `globalCompositeOperation = "screen"` and `globalAlpha = screen`.
- Pillow: draw on a single-channel `"L"` image (fill = alpha).
- Compositors: a white stroke layer in Screen mode at the `screen` opacity.

## Porting / parity

Only matters if a port must reproduce the reference detections exactly.

- **Percentile** must be numpy's default linear interpolation, not
  nearest-rank or a histogram bin. `blobtrack.js` computes it from a 256-bin
  histogram and then interpolates the way numpy does.
- **Truncate, don't floor.** Python `int()` truncates toward zero; the window
  shift `dx, dy` is negative about half the time, so `Math.floor` moves those
  windows by one pixel. Use `Math.trunc`.
- **uint8 vs float thresholds.** `gray > 187.6` on an 8-bit image is
  `gray > floor(187.6)`; `gray < t` is `gray <= ceil(t) - 1`. OpenCV's
  `threshold` on 8-bit input compares against `floor(thresh)`, so use
  `THRESH_BINARY` at `floor(t)` and `THRESH_BINARY_INV` at `ceil(t) - 1`.
- **Corner drift between native OpenCV and OpenCV.js.** Lucas-Kanade in
  native OpenCV (SIMD) and in the scalar wasm build sums floats in a different
  order. On low-texture corners (tiny minimum eigenvalue) the difference
  compounds over frames until a point settles somewhere else. Only the drawn
  corner markers are affected; the boxes and IDs are not, and the re-seed
  every 45 frames re-syncs the points. The parity test therefore gates one
  flow step at a time and only reports end-to-end drift.

## Video I/O

### Variable frame rate and duplicate timestamps

The tracker needs every frame once, in presentation order.

- The CLI treats a file as constant-frame-rate when its nominal and average
  rates agree within 0.5 %. Otherwise it resamples to the average rate
  (ffmpeg `fps` filter), so a VFR phone clip's frame count can change.
- In the repo's web app (`app/app.js`), a repeated or out-of-order timestamp stops
  the run with an explanation instead of corrupting the tracker.

Fix for either: remux the source, which often normalises the timestamps:

```sh
ffmpeg -i in.mp4 -c copy out.mp4
```

### Old ffmpeg builds (before 5.1 / 4.1)

- `-fps_mode` arrived in ffmpeg 5.1. The CLI detects the version and uses
  `-vsync passthrough` on older builds.
- `setparams` (which tags the frames BT.709) arrived in ffmpeg 4.1. On older
  builds the CLI leaves it out; the H.264 stream is still tagged BT.709
  through `-x264-params`.
- So 4.1 or newer is recommended and 4.x works. Git/unknown builds are
  treated as new. Needs `ffmpeg` and `ffprobe` on PATH.

### Odd frame sizes

H.264 in yuv420p needs even dimensions, so the CLI crops an odd width or
height by one pixel (`crop=trunc(iw/2)*2:trunc(ih/2)*2`) at encode time,
after the effect has been drawn. The boxes stay on their objects; the output
is at most one pixel narrower/shorter than the input.

## Compositing in other tools

### Don't crop or scale after analysis

The boxes are measured against the exact pixels that were analysed; a crop,
scale or reframe applied after the effect slides every box off its object.
Transform the source first, then run the effect.

### Clip durations in HTML video frameworks

In HTML/React video frameworks (HyperFrames, Remotion and similar), a clip
whose duration is not a whole number of output frames can render as blank
frames, and only a full render shows it. Keep every baked clip's duration at
`whole_frames / fps`.
