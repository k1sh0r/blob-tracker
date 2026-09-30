---
name: blob-tracking
description: Apply the "blob tracking" video effect (the TouchDesigner Blob Track look from viral edits) - white boxes that lock onto and follow things in the footage, connecting lines, numbered ID/coordinate chips, a few inverted "window" boxes and optical-flow corner markers, screen-blended into the picture. Bundles a Python CLI/module and a browser (OpenCV.js) module with identical output, plus a porting spec. Use it whenever someone wants tracking boxes on a video, a blob-track / computer-vision / surveillance / HUD / "tracker" overlay look, boxes and lines that follow objects with numbers, or that effect in a clip, a web app, a Python pipeline or a creative tool (TouchDesigner, After Effects, Resolve, Remotion, HyperFrames, game engines, p5.js), even if they never say "blob". Not for real object detection, recognition or analytics (YOLO, SORT, people counting, security-camera analytics), issue or bug tracking, or blob/object storage.
---

# Blob tracking

Boxes lock onto what is in the footage (bright, dark, edge-dense and moving
regions), keep a stable ID from frame to frame, and are joined by lines. A
few boxes invert or shift their contents, white chips show IDs, coordinates
and areas, and corner markers ride optical flow. Everything is drawn in white
and screen-blended into the picture. The look was tuned at 1080x1920 and
scales to any size and orientation. It is a visual effect: the boxes follow
image regions, not recognised objects.

Two implementations produce the same detections (a parity test checks this):
`scripts/blobtrack.py` (Python module and CLI) and `scripts/blobtrack.js`
(browser ES module on OpenCV.js). Each needs `scripts/JetBrainsMono-Regular.ttf`
beside it for the label font.

**Skill directory.** Commands below write it as `${CLAUDE_SKILL_DIR}`, which
Claude Code replaces with the absolute path. Other agents: it is the folder
containing this SKILL.md (Claude Code also shows it as "Base directory for
this skill"); write that absolute path into every command yourself. Do not
rely on `export` or an activated venv: each shell command may run in a fresh
shell.

## Requirements

- Paths A and B: Python 3.9+, and `ffmpeg` + `ffprobe` on PATH. 4.1 or newer
  is recommended; 4.x works, but builds older than 4.1 skip the frame-level
  colour tags (the H.264 stream is still tagged BT.709).
- Path C: pages served over HTTP (not `file://`), network access to
  cdn.jsdelivr.net for OpenCV.js (about 10 MB, about 3 MB compressed), a
  browser with WebCodecs for whole-file encoding. Only Chrome has been
  measured.
- Never install Python packages with `--break-system-packages`. Ask the user
  before installing system packages such as ffmpeg (macOS
  `brew install ffmpeg`, Debian/Ubuntu `sudo apt install ffmpeg`, Windows
  `winget install ffmpeg`).

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

Keep the tool's packages in their own venv outside the user's project, and
call that venv's interpreter directly. Once:

```sh
python3 -m venv ~/.cache/blob-tracking/venv
~/.cache/blob-tracking/venv/bin/python -m pip install -r "${CLAUDE_SKILL_DIR}/scripts/requirements.txt"
```

On Windows a venv keeps its interpreter in `Scripts\python.exe`, not
`bin/python`, and `python3` may not exist. In Git Bash (Claude Code's shell
on Windows), create the venv with `py -m venv ~/.cache/blob-tracking/venv`
and write `~/.cache/blob-tracking/venv/Scripts/python.exe` wherever the
commands here say `~/.cache/blob-tracking/venv/bin/python`. In PowerShell,
use `py -m venv "$HOME\.cache\blob-tracking\venv"` and
`& "$HOME\.cache\blob-tracking\venv\Scripts\python.exe"`.

Then, for a file `clip.mp4`:

```sh
~/.cache/blob-tracking/venv/bin/python "${CLAUDE_SKILL_DIR}/scripts/blobtrack.py" clip.mp4 -o clip-blobtrack.mp4
```

- Name the output `<input-stem>-blobtrack.mp4`. The CLI refuses an existing
  output file unless you pass `--overwrite`; only pass it when the user
  wants that file replaced. It writes to a temporary file and renames it
  into place on success, so a failed run leaves no partial file.
- Other flags: `--start SEC --duration SEC` (a section), `--crf N` (x264
  quality, default 16, lower is better), `--no-audio`, and every parameter
  below as `--name value`; `--help` lists them.
- It prints `clip-blobtrack.mp4: N frames` and exits 0. A malformed
  command line (unknown flag, `--crf abc`, a missing `-o`) exits 2 with
  argparse's usage and a `blobtrack.py: error: ...` line. Any other failure (bad
  input, an existing output, a parameter out of range, a write error)
  exits 1 with one line `blobtrack: ...`.
- The first run after installing is slower (Python loads the packages for
  the first time).

For a quick look before a full render, process two seconds into the temp
directory and grab a still. Pick a `--start` inside the clip (a start past
the end fails with "no frames decoded"; use `--start 0` for short clips).
`${TMPDIR:-/tmp}` is the temp directory in a POSIX shell (macOS, Linux,
Git Bash on Windows); in PowerShell write `$env:TEMP` instead:

```sh
~/.cache/blob-tracking/venv/bin/python "${CLAUDE_SKILL_DIR}/scripts/blobtrack.py" clip.mp4 -o "${TMPDIR:-/tmp}/clip-blobtrack-preview.mp4" --start 0 --duration 2 --overwrite
ffmpeg -v error -y -ss 1 -i "${TMPDIR:-/tmp}/clip-blobtrack-preview.mp4" -frames:v 1 "${TMPDIR:-/tmp}/clip-blobtrack-preview.png"
```

### B. Python module (your own frame loop)

In project code, copy the module, its font and the font licence into the
project (installed skill paths are versioned and change on update):

```sh
cp "${CLAUDE_SKILL_DIR}/scripts/blobtrack.py" "${CLAUDE_SKILL_DIR}/scripts/JetBrainsMono-Regular.ttf" "${CLAUDE_SKILL_DIR}/scripts/JetBrainsMono-OFL.txt" path/in/project/
```

Add its dependencies to the project's own environment: `numpy>=1.24`,
`opencv-python-headless>=4.8,<5`, `pillow>=10.1` (from
`scripts/requirements.txt`). If the project already has `opencv-python` or
`opencv-contrib-python`, do not add `opencv-python-headless`: both provide
`cv2` and conflict. For a throwaway script only, you can skip the copy and
put `sys.path.insert(0, r"${CLAUDE_SKILL_DIR}/scripts")` at the top (a raw
string, so a Windows path's backslashes survive).

Frames are `H x W x 3` **RGB** `uint8` arrays, fed in order, one tracker per
clip:

```python
import os, tempfile
from contextlib import closing
from blobtrack import BlobTracker, probe, read_frames
from PIL import Image

info = probe("clip.mp4")                                  # width, height, fps, audio, ...
bt = BlobTracker(info["width"], info["height"])           # optional params: small=25, ...
out_dir = tempfile.mkdtemp(prefix="blobtrack-")
with closing(read_frames("clip.mp4", info)) as frames:    # decoded RGB frames via ffmpeg
    for i, rgb in enumerate(frames):
        out = bt.process(rgb)                             # treated frame, same shape
        Image.fromarray(out).save(os.path.join(out_dir, f"frame_{i:04d}.png"))
        if i == 4:
            break
print(out_dir, bt.last_tracks)  # tracks: [{id, x, y, w, h, kind, a, age}] in output px; bt.last_points: [(x, y)]
```

- Frames from `cv2.VideoCapture` are BGR: pass
  `cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)`, and convert the result back
  before `cv2.VideoWriter`.
- Whole file with audio from Python:
  `blobtrack.run("clip.mp4", "clip-blobtrack.mp4", params={"small": 25})`
  (what the CLI runs; `overwrite=False` by default, so an existing output
  raises `OutputExistsError`, a `BlobTrackError`).
- `last_tracks` / `last_points` after each `process()` are the per-frame
  data for drawing the overlay in another tool (path D).
- All the module's own errors are `BlobTrackError` (a `ValueError`). Two
  subclasses carry details: `ParamError` for a bad parameter (`.param` is
  its name, e.g. `"small"` or `"crf"`; the message starts with it) and
  `OutputExistsError` from `run()` (`.path` is the existing file). Unknown
  parameter names raise `TypeError`. The errors pickle, so they cross
  `multiprocessing` intact.

### C. Browser / JS project

Copy `scripts/blobtrack.js` **and** `scripts/JetBrainsMono-Regular.ttf` into
the same folder of the web project; the module finds the font beside itself
(without it the chips fall back to `monospace`). It is a plain ES module with
no build step; use it on the main thread (not in a worker). In a bundled
project (Vite, webpack, Next.js...), ship both files as static assets (e.g.
`public/`) so `import.meta.url` still points next to the font, or pass
`loadOpenCV({ fontUrl })`; for Mediabunny, `npm i mediabunny@1.60.0` and
`import * as mb from "mediabunny"`.

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

**Whole file -> MP4** (the robust route): decode and re-encode with
Mediabunny's `Conversion` and call the tracker from its `video.process`
hook, which runs once per frame, in order. Condensed from the repo's tested
app (`app/app.js` at github.com/k1sh0r/blob-tracker, which adds progress UI
and OPFS output):

```js
import * as mb from "https://cdn.jsdelivr.net/npm/mediabunny@1.60.0/dist/bundles/mediabunny.min.mjs";
import { loadOpenCV, BlobTracker } from "./blobtrack.js";

async function blobtrackFile(file) {                 // File or Blob in, MP4 Blob out
  await loadOpenCV();
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target: new mb.BufferTarget() });
  let bt = null, W = 0, H = 0, src, outCanvas, outCtx, lastTs = -Infinity;
  const process = sample => {
    if (!bt) {                                       // sized from the first (upright) frame
      W = sample.displayWidth; H = sample.displayHeight;
      bt = new BlobTracker(W, H);
      src = new OffscreenCanvas(W, H).getContext("2d", { willReadFrequently: true });
      outCanvas = new OffscreenCanvas(W, H); outCtx = outCanvas.getContext("2d");
    }
    if (sample.displayWidth !== W || sample.displayHeight !== H)
      throw new Error("the video changes size mid-stream");
    if (!(sample.timestamp > lastTs))                // the tracker needs frames in presentation order
      throw new Error("repeated or out-of-order frame timestamp; remux it: ffmpeg -i in.mp4 -c copy out.mp4");
    lastTs = sample.timestamp;
    sample.draw(src, 0, 0, W, H);
    bt.process(src.getImageData(0, 0, W, H), outCtx);
    return new mb.VideoSample(outCanvas, { timestamp: sample.timestamp, duration: sample.duration });
  };
  try {
    const conversion = await mb.Conversion.init({ input, output, tracks: "primary",
      video: { codec: "avc", forceTranscode: true, process } });
    if (!conversion.isValid)
      throw new Error("cannot convert: " + conversion.discardedTracks.map(d => `${d.track.type}: ${d.reason}`).join("; "));
    // conversion.discardedTracks lists any audio that could not be kept
    await conversion.execute();                      // audio is passed through
    return new Blob([output.target.buffer], { type: "video/mp4" });
  } finally {
    bt?.dispose();
    input.dispose();
  }
}
```

`BufferTarget` holds the whole output in RAM; for long clips stream it to
OPFS (see `references/traps.md`).

**Live `<video>` / webcam** (not measured): drawing the element each
`requestVideoFrameCallback` should work, but at about 77 ms/frame expect
roughly 13 frames/s at 1080x1920, so expect skipped playback frames and
bigger jumps for motion and optical flow than in an offline render. For a
faithful result, render offline as above.

Errors: a bad argument to `process()` throws and leaves the tracker usable;
any later failure makes it unusable (create a new one). See `traps.md`.

### D. Other tools

Only the Python and browser implementations are tested in this repository;
the advice for other tools is untested guidance. Choose by what the tool can
do:

1. **Bake, then composite** (pixel-exact, works everywhere): run path A on
   the exact frames the edit will use and import the result as footage.
   Apply any crop, scale, reframe or speed change **before** running the
   effect; a transform applied afterwards slides every box off its object.
   For HTML/React video frameworks (Remotion, HyperFrames) this is the
   robust route; keep clip durations whole output frames.
2. **Export track data, draw natively**: use path B, dump `last_tracks` and
   `last_points` per frame to JSON (output px of the analysed frame size),
   and draw boxes, lines and chips with the tool's own layers (After Effects
   expressions, an SVG/canvas layer in Remotion, Fusion shapes), with the
   strokes screen-blended. The invert/shift windows need pixel access;
   approximate them or leave them out.
3. **Reimplement**: follow `references/method.md`, which specifies every step
   and ends with a table of likely building blocks in TouchDesigner, game
   engines/shaders and p5.js/Processing. TouchDesigner's built-in Blob Track
   TOP should give a similar look quickly, with different boxes and IDs.

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
  `--invert 0 --shift 0` turns off the glitchy windows.
- Check a still at full size before rendering a long clip.

## Output contract

- CLI: H.264 MP4 (yuv420p, tagged BT.709 primaries, transfer and matrix,
  limited/tv range; CRF 16, `+faststart`), same frame size (odd sizes lose
  one pixel to stay H.264-legal), same frame rate and frame count as the
  input (variable-frame-rate sources are resampled to their average rate),
  audio stream copied (re-encoded to AAC only if the codec cannot go in
  MP4). `--start` / `--duration` trim both picture and sound.
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

## Before you finish

- Look at a frame of the output (extract a PNG into the temp directory)
  rather than trusting that the command succeeded; check boxes sit on
  objects and chips are legible.
- If it looks wrong, read `references/traps.md` (OpenCV.js freeze, missing
  font, VFR sources, crop-after-analysis, HDR clips, and more).
- For reimplementation or exact numbers, `references/method.md` is the full
  specification; the code in `scripts/blobtrack.py` is the authority.
