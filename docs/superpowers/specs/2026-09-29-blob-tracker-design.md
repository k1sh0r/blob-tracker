# Blob Tracker — design

**Date:** 2026-09-29 · **Status:** approved in conversation, awaiting written-spec review
**Repo:** `this repo` → public GitHub `k1sh0r/blob-tracker` · **Licence:** MIT

## 1. Purpose

The blob-tracking look (boxes locked onto what's in the footage, connection
lines, numbers on white chips, a few inverted "window" boxes, all screened into
the picture) was developed for the QuestRunner teaser *USER ACTION PENDING*.
This repo packages it for three audiences:

| audience | gets |
|---|---|
| anyone with Claude, in any project | a discoverable **skill** that picks the right way to apply the effect for *their* project |
| the author, day to day | a **web app**: upload a video → preview with blob tracking → download |
| portfolio readers | an **HTML case study** of how the effect was found, including the dead ends |

Plus a short README.

**Success criteria**
1. `skills/blob-tracking/` installs as a Claude skill and, given only its
   contents, an agent can apply the effect via whichever path fits the project
   (CLI, Python module, browser module, or reimplementation from the method doc).
2. The Python CLI turns any common video (MP4/MOV/WebM, any resolution or
   orientation) into an MP4 with the effect and the original audio.
3. The web app does the same in a browser with no install and no build step.
4. The JS and Python implementations produce the same detections — enforced by
   a test, not asserted.
5. The case study tells the real story, in the author's voice, with images.

## 2. Repository layout

```
blob-tracker/
├─ README.md
├─ LICENSE                                (MIT)
├─ skills/blob-tracking/
│  ├─ SKILL.md
│  ├─ references/method.md                (language-agnostic algorithm spec)
│  ├─ references/traps.md                 (known failure modes and fixes)
│  └─ scripts/
│     ├─ blobtrack.py                     (Python module + CLI)
│     ├─ requirements.txt                 (numpy, opencv-python-headless, pillow)
│     ├─ JetBrainsMono-Regular.ttf        (OFL; label font for both implementations)
│     └─ blobtrack.js                     (browser ES module, OpenCV.js)
├─ app/
│  ├─ index.html
│  ├─ app.js                              (upload → process → preview → download)
│  └─ serve.sh                            (python3 -m http.server wrapper)
├─ casestudy/
│  ├─ index.html
│  └─ assets/                             (stills, sheets, one short clip)
├─ tests/
│  ├─ fixtures/                           (synthetic clips + Python reference JSON)
│  ├─ make_fixtures.py                    (generates clips and reference detections)
│  ├─ test_blobtrack.py                   (pytest: CLI + module behaviour)
│  └─ parity.mjs                          (headless Chrome: JS == Python)
└─ docs/superpowers/{specs,plans}/
```

`app/` imports `../skills/blob-tracking/scripts/blobtrack.js` directly. There is
exactly one JS implementation; the skill and the app cannot drift apart.

## 3. The method (normative; both implementations follow it)

Derived from `video-hf/teaser-pending/tools/blobtrack.py` in the
author's teaser project. What changes from that file is listed in §3.5.

### 3.1 Resolution model
Tuned at 1080×1920. For a frame of size W×H:
- `k = min(W, H) / 1080` — scales every **drawn** size (line widths, label
  font 18·k, corner ticks 18·k, crosshair 9·k, marker squares, chip padding,
  shift distance 36·k, invert-area cap 260·k).
- Detection runs at a **working resolution** whose short side is 540
  (`S = 540 / min(W, H)`, INTER_LINEAR resize of the grey frame). All area
  thresholds below are in working-resolution pixels and need no scaling.
- Box caps are fractions of the frame: `w ≤ W·560/1080`, `h ≤ H·760/1920`
  (exactly the original 560×760 at 1080×1920; ≈0.519·W, ≈0.396·H).
- Tier thresholds (on `sqrt(w·h)` in output px): large > 230·k, medium > 70·k.
- Tracker distance normaliser: 160·k.

### 3.2 Detect (per frame, on the working-res grey image `g`)
1. `gb = GaussianBlur(g, σ=2.2)`.
2. **Bright**: `gb > percentile(gb, bright)` → MORPH_CLOSE 5×5 rect →
   connected components (8-conn), area 40–90000 → kind `B`.
3. **Dark**: `gb < percentile(gb, dark)` → same → kind `D`.
4. **Edge**: `Canny(g, 60, 150)` → dilate 9×9 rect → MORPH_OPEN 5×5 →
   components, area 120–60000 → kind `E`.
5. **Motion** (when a frame 3 back exists): `GaussianBlur(|g − g₋₃|, σ=3) > motion`
   → dilate 5×5 ×2 → components, area 60–120000 → kind `M`.
6. Drop components with w or h ≤ 3 working px or over the §3.1 caps.
   Map boxes to output px (÷S).
7. **Score** = `(2 if M else 1) · sqrt(area) · (8 + std(g over the box))`,
   std = population std. Sort descending (stable).
8. **Pick** with quotas `large / medium / small` by tier, skipping any box whose
   IoU with an already-picked box > 0.45.

Percentile = numpy default (linear interpolation).

### 3.3 Track
- Greedy, in existing-track order: each track takes the unused detection
  maximising `IoU + max(0, 1 − centroid_dist / (160·k)) · 0.6`; accepted if > 0.25.
- Accepted: `x,y,w,h ← 0.45·old + 0.55·new`; take the detection's area/kind.
- Unmatched detections become new tracks with the next integer ID.
  Unmatched tracks are dropped.
- **Corners**: `goodFeaturesToTrack(g, maxCorners=corners, quality=0.02, minDist=22)`,
  followed with `calcOpticalFlowPyrLK(winSize 21×21, maxLevel 3)`; points with
  status 0 are dropped. **Re-seed** when fewer than `corners/2` remain or every
  45 frames (new for long clips — the teaser's shutters were 6 frames).

### 3.4 Draw
Deterministic per-ID randomness: `rnd(i, salt) = frac(sin(i·127.1 + salt·311.7)·43758.5453)`.

1. **Windows** (into the frame, before any overlay): per track, `r = rnd(id,3)`;
   if `r < invert` and box area < (260·k)² → invert the box's pixels;
   elif `r < invert + shift` → fill the box from the frame offset by
   `((rnd(id,4)−.5)·36k, (rnd(id,5)−.5)·36k)`, clamped.
2. **Strokes layer** (white on transparent):
   - lines from each blob centroid to its 2 nearest (alpha 150/255, 2k px), deduped;
   - an x-ordered chain, each link drawn if `rnd(id,9) < .5` (alpha 80, 1k px);
   - corner markers: square of side `6 + trunc(rnd(k,11)·14)` (·k), alpha 200;
     every 5th linked to its nearest blob (alpha 70);
   - box outlines alpha 235, width 3k if large else 2k; corner ticks (18k,
     width+2) on boxes with side > 90k; crosshair (±9k) if `rnd(id,7) < .45`.
3. **Chips layer**: for tracks with `rnd(id,8) < labels` or large: text chosen
   by `v = rnd(id,12)`: `ID nn` (v < .34) · `x.xxx  y.yyy` normalised centroid
   (v < .67) · `Knn  Annnnn` kind+id+area. White filled rect, black text,
   placed above the box (below if it would leave the frame). A chip is skipped
   if it would overlap an existing chip. Plus a readout chip bottom-left:
   `TRACK ffff  nn BLOBS  nn PTS`.
4. **Composite**: strokes **screen**-blended at `screen` opacity
   (`base + (1 − base)·stroke·α·screen`); chips normal-blended at `chip` opacity.

### 3.5 Defaults and changes from the teaser tool

Defaults: `bright 90, dark 9, motion 14, large 6, medium 11, small 15,
corners 28, labels 0.55, invert 0.18, shift 0.12, screen 0.70, chip 0.86`.

Changes from the teaser file:
- The teaser's colour grade, invert grade and CSS-crop emulation (`edgebox.py`)
  are **not** part of the core; the effect runs on the footage as given.
- No pre-roll (whole-clip processing): the first 3 frames have no motion mask.
- §3.1 resolution model replaces fixed 1080×1920 constants.
- Corner re-seeding (§3.3).

## 4. Python module + CLI (`scripts/blobtrack.py`)

```
python blobtrack.py INPUT -o OUTPUT.mp4 [--start SEC] [--duration SEC]
                    [--bright 90] [--dark 9] … every §3.5 parameter
                    [--crf 16] [--no-audio]
```
- Decodes with an `ffmpeg` rawvideo pipe, processes frame by frame (bounded
  memory), encodes with `ffmpeg` libx264 yuv420p + `-movflags +faststart`,
  audio stream copied from the input (AAC re-encode if the codec can't be muxed).
  Preserves the input frame rate.
- Importable API: `BlobTracker(width, height, **params)` with
  `.process(rgb: np.ndarray) -> np.ndarray` and `.last_tracks` (for tests).
- Errors: missing ffmpeg/OpenCV → one clear message naming the install
  command; unreadable input → ffmpeg's error, exit code 1.

## 5. Browser module (`scripts/blobtrack.js`)

```js
import { loadOpenCV, BlobTracker } from "./blobtrack.js";
await loadOpenCV();                        // idempotent
const bt = new BlobTracker(width, height, params);
bt.process(inputImageData, outCtx);         // draws the treated frame into a 2D context
bt.lastTracks;                              // for tests
bt.dispose();                               // frees OpenCV mats
```
- OpenCV.js from jsDelivr `@techstark/opencv-js@4.10.0-release.1` (the
  docs.opencv.org URL 404s). **Never `await cv`** — see traps.md.
- Screen blend via `globalCompositeOperation = "screen"` + `globalAlpha`.
- Every OpenCV `Mat` created per frame is deleted per frame (the spike leaked
  none; the module must not either).

## 6. Web app (`app/`)

Minimal UI by instruction — no parameter controls yet.
1. File input / drop zone → shows name, resolution, duration.
2. **Process** → Mediabunny `Conversion` from the input to MP4 (H.264 via
   WebCodecs), with a per-frame video process hook calling `BlobTracker.process`
   in presentation order; audio passed through. Progress bar = frames done / total.
3. On completion: `<video controls>` plays the result; **Download** saves
   `<name>-blobtrack.mp4`.
4. Errors shown inline: unsupported browser (no WebCodecs/H.264 encoder),
   undecodable file, OpenCV load failure.

Runs from `app/serve.sh` (static server at the repo root so `../skills/...`
resolves). Target: current Chrome/Edge/Safari.

Measured budget (spike, 1080×1920, M-series Mac): ~180 ms/frame in Chrome →
a 10 s 30 fps clip ≈ 1 min. Preview is therefore process-then-play.

## 7. Skill (`skills/blob-tracking/SKILL.md`)

Written with the `skill-creator` skill. Frontmatter `name: blob-tracking`,
description triggering on "blob tracking", "tracking boxes on video",
"TouchDesigner blob track look", "computer-vision HUD overlay", etc.

Body = a decision guide, not a single engine:

| the user's situation | path |
|---|---|
| has a video file and a shell | run the CLI (install requirements if missing) |
| Python project / pipeline | import `BlobTracker` from `blobtrack.py` |
| web or JS project | copy/import `blobtrack.js`; show the OpenCV.js load pattern |
| other tool (TouchDesigner, After Effects, Remotion, HyperFrames, Unity…) | follow `references/method.md` and map each step to that tool's primitives |

Plus: parameters and what they do, how to tune for density, and `traps.md`
(the `await cv` freeze; sub-frame video clips; screen blend needs a white
stroke layer; percentile must be numpy-linear for parity).

## 8. Tests

Written test-first where they gate code.
- **Fixtures** (`tests/make_fixtures.py`): 2 synthetic, licence-free clips
  generated with numpy + ffmpeg — (a) moving bright/dark shapes over noise,
  1080×1920, 30 fps, 2 s; (b) a panning textured scene with text, 1920×1080,
  2 s — plus Python reference detections per frame (`id,x,y,w,h`) as JSON.
- **pytest**: CLI produces an MP4 with the same frame count, fps and duration
  as the input, audio stream present when the input had one; `BlobTracker`
  is deterministic (two runs, identical tracks); resolution scaling (a 2×
  downscaled clip yields boxes at ~½ the coordinates on the same objects).
- **Parity** (`tests/parity.mjs`, playwright-core + system Chrome, headless):
  runs `blobtrack.js` on the fixture frames; per frame ≥ 95 % of Python boxes
  matched at IoU > 0.9 with the same ID, and track counts equal. (Spike result:
  100 % / IoU 1.000.)
- **App smoke**: headless Chrome loads the app, feeds fixture (a), waits for
  completion, checks the output blob decodes to the same frame count.

## 9. Case study (`casestudy/index.html`)

Portfolio piece, author's voice (first person), dead ends included. Built with
`frontend-design` (+ `prose-writing` for copy). Single self-contained page,
works offline, responsive.

Sections:
1. **The brief** — QuestRunner post 2, a flashback burst of eight 0.2 s
   shutters; the note: "tiny distorted rectangles like tiny windows".
2. **Attempt 1: a glitch shader** — block displacement looks like the brief in
   a still and is wrong in motion: the rectangles sit on a fixed lattice and
   never look at the picture. Feedback: it "doesn't react to objects".
3. **Finding the reference** — geometric-art.com's EDGE BOX ARCHITECTURE and
   the pipeline its UI exposes: field extraction → shape → connections → signal.
4. **Attempt 2: an edge-energy field** — Sobel → cell grid → greedy peaks. The
   horizon problem (min–max normalisation put every box on one skyline) and the
   fix (percentile + locally-relative score). It reacted — but every box was
   one size, because a grid decides the size.
5. **Attempt 3: blob tracking** — the TouchDesigner Blob Track method: four
   masks → connected components → a box is the thing's own extent; IDs held
   frame to frame; Lucas-Kanade corners; white chips reading real measurements.
6. **Making it sit in the picture** — screen blend at 0.70, chips at 0.86.
7. **Taking it to the browser** — the three-way spike (Python 138 ms / OpenCV.js
   180 ms / Pyodide 507 ms + 8.9 s load; both ports 100 % box and ID match)
   and the `await cv` freeze.
8. **Result** — stills and one short clip from the teaser; links to the app,
   the skill and the repo.

Images come from the author's own renders and generated sheets
(`teaser-pending/`: `gen/blobtrack/`,
`gen/edgebox/`, `renders/`, and the reference capture
`a local reference capture (not published)`). Assumption: stills from the author's
published teaser are fine to include publicly; raw stock source clips are not
committed.

## 10. README

What it is (one paragraph + one image), then quick start for each path: CLI,
Python, browser module, web app (`./app/serve.sh`), the skill (install), and
a link to the case study. Credits: OpenCV, OpenCV.js build, Mediabunny,
JetBrains Mono (OFL).

## 11. Out of scope (for now)

Parameter UI in the app; real-time live preview; GPU/WebGL implementation;
publishing to a skills marketplace beyond the public repo; npm/PyPI packages.
