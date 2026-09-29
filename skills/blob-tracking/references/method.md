# The blob-tracking method

A language-agnostic specification of the effect, complete enough to
reimplement it in any tool. `scripts/blobtrack.py` is the reference
implementation and the authority: where this document and the code disagree,
the code wins. `scripts/blobtrack.js` is a line-for-line port of it, checked
by a parity test.

Contents

1. Pipeline at a glance
2. Resolution model
3. Detect
4. Track
5. Draw
6. Composite
7. Parameters and constants
8. Porting checklist (for pixel/ID parity)
9. Mapping the method onto other tools

---

## 1. Pipeline at a glance

Per frame, in order, with state carried from frame to frame (one tracker per
clip, frames fed in presentation order):

```
rgb (W x H, 8-bit)
  -> grey, resized to the working resolution            (g)
  -> DETECT: 4 masks -> connected components -> scored candidates -> picked boxes
  -> TRACK:  match picked boxes to last frame's tracks -> smoothed boxes with stable IDs
             follow corner points with Lucas-Kanade optical flow
  -> history: keep the last 3 working greys
  -> DRAW:   windows (invert / shift) into a copy of the frame
             strokes layer (white lines, boxes, ticks, markers; alpha only)
             chips layer (white label rects with black text)
  -> COMPOSITE: strokes screen-blended, chips normal-blended
```

Frame indices start at 0. `rnd(i, salt)` (section 5) supplies every "random"
choice, so the same track ID always gets the same look.

## 2. Resolution model

The look was tuned at 1080x1920 and scales to any frame size W x H
(minimum 60 px on each side).

| symbol | value | used for |
|---|---|---|
| `k` | `min(W, H) / 1080` | every **drawn** size |
| `S` | `540 / min(W, H)` | output px -> working px |
| working size | `(int(W*S + 0.5), int(H*S + 0.5))` | detection and corners |
| `lw(n)` | `max(1, int(n*k + 0.5))` | every drawn **line width** |
| `L` | `18*k` | label font size (px) |
| `cap_w` | `W * 560 / 1080` | max box width, output px (about 0.519 W) |
| `cap_h` | `H * 760 / 1920` | max box height, output px (about 0.396 H) |

- Grey: `cvtColor(RGB2GRAY)` (weights 0.299 R, 0.587 G, 0.114 B), then
  `resize` to the working size with bilinear (`INTER_LINEAR`) interpolation.
  The resize is skipped when the frame is already at the working size.
- All detection **areas** are in working pixels and need no scaling.
- Boxes, tracks, centroids and corner points are converted to **output**
  pixels (divide working coordinates by `S`, areas by `S*S`). Tier sizes,
  the tracker's distance normaliser and everything drawn use output pixels.
- Every other drawn size (tick length, crosshair, marker square, chip
  padding, shift distance, invert-area cap) is `n*k` without rounding.

## 3. Detect

On the working-resolution grey `g` of the current frame, and `gprev` = the
working grey of the frame **three frames earlier** (none for frames 0, 1, 2).

### 3.1 The four masks

| # | kind | mask | clean-up | component area (working px, inclusive) |
|---|---|---|---|---|
| 1 | `B` bright | `gb > percentile(gb, bright)` | MORPH_CLOSE, 5x5 rect | 40 .. 90000 |
| 2 | `D` dark | `gb < percentile(gb, dark)` | MORPH_CLOSE, 5x5 rect | 40 .. 90000 |
| 3 | `E` edge | `Canny(g, 60, 150)` | dilate 9x9 rect (1x), then MORPH_OPEN 5x5 rect; mask = `> 0` | 120 .. 60000 |
| 4 | `M` motion | `GaussianBlur(absdiff(g, gprev), sigma 3) > motion` | dilate 5x5 rect, 2 iterations | 60 .. 120000 |

- `gb = GaussianBlur(g, sigma = 2.2)` (kernel size derived from sigma; OpenCV
  picks 15x15 for sigma 2.2 and 19x19 for sigma 3 on 8-bit input; default
  border, reflect-101). Masks 1 and 2 use `gb`; Canny runs on the unblurred `g`
  (aperture 3, L1 gradient).
- `percentile` is numpy's default: linear interpolation between order
  statistics at virtual index `(n - 1) * q / 100`.
- Comparisons are strict (`>` and `<`) between the 8-bit image and the
  float threshold.
- Mask 4 only exists once three earlier frames exist (from frame 3 on).

### 3.2 Components -> candidates

Each mask is split into 8-connected components (label 0, the background, is
skipped). A component becomes a candidate when **all** hold:

- area (pixel count) within the mask's range above;
- bounding-box width `> 3` and height `> 3` (working px);
- `w / S <= cap_w` and `h / S <= cap_h` (output px).

The candidate's box is the component's own bounding box `(x, y, w, h)`,
mapped to output px: `x/S, y/S, w/S, h/S`; its area `a = area / S^2`.
Candidates are collected in mask order B, D, E, M, and within a mask in
component-label order.

### 3.3 Score

```
c     = population std of g over rows y .. y+h and columns x .. x+w
        (working px, INCLUSIVE of y+h and x+w, clipped to the image)
score = (2 if kind == M else 1) * sqrt(a) * (8 + c)
```

`a` is the output-px area. Sort candidates by descending score with a
**stable** sort (ties keep collection order).

### 3.4 Pick (tiers, quotas, de-duplication)

```
side = sqrt(w * h)                       (output px)
tier = L if side > 230*k else (M if side > 70*k else S)
quota = {L: large, M: medium, S: small}

for b in candidates (score order):
    if quota[tier(b)] <= 0: skip
    if IoU(b, p) > 0.45 for any already-picked p (any tier): skip
    quota[tier(b)] -= 1; pick b
```

Tier thresholds are in **output** px scaled by `k` (230 and 70 at a 1080
short side), not working px. The quota check comes first, and a box skipped
for overlap does not use up quota. `IoU(a, b) = inter / (a.w*a.h + b.w*b.h - inter + 1e-6)`.

The picked list, in pick order, is this frame's detections.

## 4. Track

### 4.1 Box tracks

Each track holds `id, x, y, w, h, a, kind, age` in output px.

```
norm = 160*k
live, used = [], {}
for t in tracks (existing order):
    best = none, bs = 0
    for j, d in detections, j not in used:
        dist = distance between the centres of t and d
        s = IoU(t, d) + max(0, 1 - dist / norm) * 0.6
        if s > bs: bs, best = s, j                  (strict: the first maximum wins)
    if best exists and bs > 0.25:
        mark best used
        x, y, w, h = 0.45 * old + 0.55 * detection  (each of the four)
        a, kind = the detection's; age += 1
        append t to live
for j, d in detections, j not in used (detection order):
    append {id: next_id++, box of d, a, kind, age: 0} to live
tracks = live
```

- IDs start at 1 and are never reused.
- Unmatched tracks are dropped at once (no coasting).
- Track order = surviving tracks in their previous order, then new ones.
  Later steps (drawing, chips, readout) use this order.

### 4.2 Corner points

`n = corners` (a parameter). Points live in working px.

```
if frame > 0 and there are points:
    points = pyramidal Lucas-Kanade from the previous frame's working grey to g
             (window 21x21, maxLevel 3, OpenCV default termination: 30 iterations or eps 0.01)
    keep only points with status 1
if frame == 0 or len(points) < n / 2 or frame % 45 == 0:
    points = goodFeaturesToTrack(g, maxCorners = n, qualityLevel = 0.02, minDistance = 22)
             (Shi-Tomasi, blockSize 3; no points at all when n == 0)
drawn points = points / S   (output px), in the order returned
```

On a re-seed frame the flow step still runs first, then its result is
replaced. The re-seed every 45 frames keeps long clips populated.

### 4.3 Frame order

For each frame: detect (with the grey from 3 frames back) -> update tracks ->
corners (flow from the previous grey) -> push `g` into the 3-frame history
(drop the oldest) -> draw with this frame's index -> frame index + 1.

## 5. Draw

### 5.1 Stable randomness

```
rnd(i, salt) = frac(sin(i*127.1 + salt*311.7) * 43758.5453)      frac(x) = x - floor(x)
```

| salt | argument `i` | decides |
|---|---|---|
| 3 | track id | window: invert / shift / none |
| 4, 5 | track id | shift offset dx, dy |
| 7 | track id | crosshair |
| 8 | track id | gets a chip |
| 9 | track id of the chain link's left end | chain link drawn |
| 11 | **point index** in the corner list | marker size |
| 12 | track id | chip text variant |

### 5.2 Windows (into a copy of the frame, before any overlay)

For each track, in track order. Every read comes from the **original**
frame, so windows never compound:

```
x0, y0 = int(x), int(y); x1, y1 = int(x + w), int(y + h)       (truncate)
clip to 0..W and 0..H
r = rnd(id, 3)
if r < invert and (x1-x0)*(y1-y0) < (260*k)^2:
    pixels = 255 - original pixels                  (all three channels)
elif r < invert + shift:
    dx = int((rnd(id, 4) - 0.5) * 36*k); dy = int((rnd(id, 5) - 0.5) * 36*k)   (truncate toward zero)
    sx = clamp(x0 + dx, 0, W - (x1-x0)); sy = clamp(y0 + dy, 0, H - (y1-y0))
    pixels = original region of the same size at (sx, sy)
```

### 5.3 Strokes layer

One frame-sized layer holding **alpha only**; every stroke is white. A
later stroke **replaces** the alpha under it (it does not accumulate), the
way drawing on a single-channel image does. Draw in this order, with
`w1 = lw(1)`, `w2 = lw(2)`, `cen[i]` = centre of track i:

| element | geometry | alpha (/255) | width |
|---|---|---|---|
| neighbour lines | for each i: sort all indices by squared distance to `cen[i]` (stable), take sorted positions 1 and 2; line `cen[i]`-`cen[j]`; each unordered pair drawn once | 150 | `w2` |
| chain | indices sorted by `cen.x` (stable); for consecutive (a, b): line if `rnd(id_a, 9) < 0.5` | 80 | `w1` |
| corner markers | for point n at (px, py): `s = (6 + int(rnd(n, 11) * 14)) * k`; square outline `[px - s/2, py - s/2, px + s/2, py + s/2]` | 200 | `w1` |
| marker links | every point with `n % 5 == 0`, when tracks exist: line to the nearest `cen` (first minimum) | 70 | `w1` |

Then per track, in track order (`side = sqrt(w*h)`, `big = 230*k`):

| element | geometry | alpha | width |
|---|---|---|---|
| box outline | rectangle `[x, y, x+w, y+h]` | 235 | `wdt = lw(3)` if `side > big` else `w2` |
| corner ticks (if `side > 90*k`) | at each corner, one horizontal and one vertical line of length `18*k` pointing into the box | 255 | `wdt + w2` (i.e. `wdt + round(2k)`: "+2" only at k = 1) |
| crosshair (if `rnd(id, 7) < 0.45`) | horizontal and vertical lines through `cen`, `+-9*k` | 230 | `w1` |

Rectangle semantics follow Pillow: the rectangle covers x0..x1 and y0..y1
inclusive and the outline grows **inwards** from that edge. Lines are
centred on their path with butt ends.

Neighbour-line edge cases (the code does not exclude `i` explicitly; it
relies on `i` sorting first at distance 0):

- 1 track: no neighbour lines and no chain. 2 tracks: each has one
  neighbour, so the pair is drawn once, plus at most one chain link.
- Coincident centres: an earlier index at distance 0 sorts ahead of `i`, so
  `i`'s slice can contain `i` itself (a zero-length line, which Pillow draws
  as a single pixel) and miss a real neighbour. Keep this behaviour for
  parity; it is harmless visually.

### 5.4 Chips layer

A separate frame-sized RGBA layer. Font: JetBrains Mono Regular at `L = 18*k`
px, text drawn from the top of the ascender (Pillow anchor `la`; in canvas,
`fillText` at `y + fontBoundingBoxAscent` with an alphabetic baseline). Text
width `tw` is the advance width: Pillow `ImageDraw.textlength(text, font)`,
canvas `measureText(text).width`. Filled rects `[x0, y0, x1, y1]` are
inclusive of both corners, as Pillow fills them (canvas:
`fillRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1)`); the `guard` box is only used
for the overlap test and is never drawn. For each track, in track order:

```
if rnd(id, 8) < labels or side > big:            (large boxes always get one)
    v = rnd(id, 12)
    text = "ID %02d" % id                         if v < 0.34
         = "%.3f  %.3f" % (cx / W, cy / H)        if v < 0.67   (normalised centre, two spaces)
         = "%s%02d  A%05d" % (kind, id, int(a))   otherwise     e.g. "B07  A01234"
    tw = advance width of text (textlength / measureText)
    lx, ly = x, y - L - 7*k
    if ly < 4*k: ly = y + h + 3*k                 (below the box instead)
    guard = (lx - 4*k, ly - 4*k, lx + tw + 12*k, ly + L + 9*k)
    if guard overlaps any earlier guard (closed intervals): skip this chip
    keep guard
    white opaque rect [lx, ly, lx + tw + 8*k, ly + L + 5*k]
    black text at (lx + 4*k, ly + 1*k)
```

Chips are not clamped to the frame. Then the **readout**, always drawn and
not collision-checked:

```
text = "TRACK %04d  %02d BLOBS  %02d PTS" % (frame_index, number_of_tracks, number_of_points)
white rect [26*k, H - 58*k, 26*k + tw + 10*k, H - 58*k + L + 7*k]
black text at (31*k, H - 56*k)
```

## 6. Composite

Over the windowed frame `b` (channels scaled to 0..1), per pixel:

```
s  = stroke_alpha / 255 * screen                  (stroke colour is white = 1)
b  = b + (1 - b) * s                              SCREEN, not "over"
ca = chip_alpha / 255 * chip
b  = b * (1 - ca) + chip_rgb * ca                 normal blend
out = int(clip(b, 0, 1) * 255 + 0.5)
```

Strokes first, chips second. Where neither layer has alpha the pixel is
unchanged. In an engine with blend modes: a white stroke layer in **Screen**
mode at opacity `screen`, then the chips layer in **Normal** mode at opacity
`chip`.

## 7. Parameters and constants

The twelve parameters (`bright`, `dark`, `motion`, `large`, `medium`,
`small`, `corners`, `labels`, `invert`, `shift`, `screen`, `chip`), their
defaults, valid ranges and tuning advice are in the **Parameters** table of
`SKILL.md`. `large`, `medium`, `small` and `corners` must be whole numbers.

Fixed constants: reference short side 1080, working short side 540, box caps
560/1080 of W and 760/1920 of H, tier sides 230*k and 70*k, tracker distance
normaliser 160*k, match threshold 0.25, smoothing 0.45 old / 0.55 new, IoU
de-dup 0.45, corner re-seed every 45 frames, minimum frame side 60.

## 8. Porting checklist (for pixel/ID parity)

Only needed if the port must match the reference detections; a port "in
the spirit" of the look can skip these.

- Working size is `(int(W*S + 0.5), int(H*S + 0.5))`; grey is RGB2GRAY then
  INTER_LINEAR, skipped when the size already matches.
- Box caps are `w <= W*560/1080`, `h <= H*760/1920` in **output** px.
- Contrast `c` is the **population** std over the **inclusive** patch
  `y..y+h`, `x..x+w` (working px, clipped).
- Percentiles are numpy-linear (not nearest-rank, not a histogram bin).
- Drawn widths are `max(1, int(n*k + 0.5))`; every other drawn size is `n*k`.
  Corner ticks are `wdt + lw(2)` wide.
- Truncate toward zero (`int()` / `Math.trunc`, not `floor`): the window
  shift `dx, dy` is negative about half the time.
- Stable sorts at three sites: candidates by descending score, the two nearest
  neighbours of each centroid, the chain by x. Ties keep insertion order.
- `rnd()` takes `sin()` of arguments in the tens of thousands; platform libm
  results can differ in the last ulp, which only matters when a value lands
  exactly on a threshold (0.45, 0.5, `labels`, `invert`, ...).
- Chip text is printf `%.3f` / `%02d` / `%05d`. `%.3f` rounds exact binary
  ties to even the way C does; JavaScript `toFixed` differs in the last digit
  on those ties (blobtrack.js has a `fmt3` helper for it).
- Tracks are matched greedily in track order; the first maximum wins; the
  acceptance threshold is strict (`> 0.25`).
- `gprev` is the grey from **three** frames earlier; optical flow uses the
  grey from **one** frame earlier.
- Corner re-seed rule: frame 0, fewer than `n/2` points, or `frame % 45 == 0`.

`tests/parity.mjs` in the source repository shows how the JS port was
checked against Python: per frame, equal track counts, >= 95 % of boxes at
IoU > 0.9 with the same ID, and equal corner counts.

## 9. Mapping the method onto other tools

Untested guidance: only the Python and browser implementations are tested in
this repository, and none of these mappings has been tried here. Baking the
effect with the CLI, or exporting track data and drawing it natively, is
often simpler; see "D. Other tools" in `SKILL.md`. For a native
reimplementation, these are each tool's likely building blocks; check each
one's behaviour against sections 3 to 6:

| step | TouchDesigner | Unity / Unreal / shader | p5.js / Processing |
|---|---|---|---|
| grey + resize | Monochrome TOP, Resolution TOP | GPU downsample | `pixels[]` / OpenCV for Processing |
| bright/dark masks | Threshold TOP (percentile computed on CPU in a Script) | compute shader + histogram | loop over pixels |
| components | Blob Track TOP (built-in, approximate) or a Script TOP running OpenCV in Python | CPU (OpenCV plugin) or a GPU labelling pass | OpenCV for Processing `findContours` |
| tracking + IDs | Blob Track TOP's IDs, or a Script DAT with section 4.1 | C# / C++ port of 4.1 | JS port of 4.1 |
| optical flow corners | Script TOP running OpenCV in Python | OpenCV plugin | OpenCV / skip |
| strokes + chips | Script SOP/TOP or Text TOP + Rectangle TOP | UI / line renderer / SDF text | `line`, `rect`, `text` |
| screen composite | Composite TOP, operation Screen | blend `One, OneMinusSrcColor` | `blendMode(SCREEN)` |

TouchDesigner's Blob Track TOP should give the general look quickly, but its
detections and IDs will not match this method; follow sections 3 and 4 for
the same boxes.
