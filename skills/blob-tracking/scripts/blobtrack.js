// blobtrack.js -- the blob-tracking video effect in the browser (OpenCV.js).
//
// A line-for-line port of blobtrack.py (same method, same parameters, same
// detections -- tests/parity.mjs checks it). Read that file's docstring and
// references/method.md for the method; this file mirrors its structure and
// names so the two can be read side by side.
//
//   1. DETECT  the grey frame (at a working resolution whose short side is 540)
//              is thresholded four ways: bright, dark, edge-dense, and motion
//              against three frames earlier. Each mask is split into connected
//              components; a blob's box is its component's own bounding box.
//   2. TRACK   blobs are matched frame to frame by overlap and centroid distance
//              and keep a stable ID; boxes are smoothed so they ride the object.
//              Shi-Tomasi corners are followed with pyramidal Lucas-Kanade flow.
//   3. DRAW    windows, then a white strokes layer (screen-blended) and a chips
//              layer (normal-blended).
//
// Usage:
//   import { loadOpenCV, BlobTracker } from "./blobtrack.js";
//   await loadOpenCV();                       // idempotent; also loads the label font
//   const bt = new BlobTracker(width, height, { bright: 90, ... });
//   bt.process(imageData, ctx);               // draws the treated frame into a 2D context
//   bt.lastTracks;                            // [{id, x, y, w, h, kind, a, age}, ...]
//   bt.lastPoints;                            // [[x, y], ...] corner points
//   bt.dispose();                             // frees the OpenCV Mats it holds
//
// Frames must be fed in order, one tracker per clip. Plain ES module, no build
// step. Main thread only: loadOpenCV injects a <script> and uses document.fonts.
//
// Files: ship JetBrainsMono-Regular.ttf beside this module (or pass `fontUrl`)
// for labels identical to the Python tool. Without it loadOpenCV warns and the
// chips fall back to the browser's `monospace`; detections are unaffected.
//
// Content-Security-Policy, if the page has one, must allow:
//   script-src  https://cdn.jsdelivr.net (or wherever `url` points) 'wasm-unsafe-eval'
//   connect-src / font-src  the font's origin (it is fetched, then used as a FontFace)
//
// Errors: a bad argument to process() (wrong-size or malformed ImageData, no
// output context) throws a BlobTrackError/TypeError before anything changes,
// and the tracker stays usable. A failure after that point may leave its state
// half-advanced, so the tracker becomes unusable: every later process() throws
// a BlobTrackError; dispose() still works. Make a new tracker.
//
// Test hooks: tests/parity.html drives these internals directly, so keep their
// names and meaning stable: `S`, `frame`, `hist`, `gray()`, `_setPts()`,
// `_corners()`.

export const OPENCV_URL =
  "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js";
export const FONT_URL = new URL("./JetBrainsMono-Regular.ttf", import.meta.url).href;
const FONT_FAMILY = "BlobTrackMono";

export const DEFAULTS = Object.freeze({
  bright: 90,      // percentile above which a pixel is "bright"
  dark: 9,         // percentile below which a pixel is "dark"
  motion: 14,      // grey-level difference vs 3 frames back that counts as motion
  large: 6,        // quota of large boxes per frame
  medium: 11,      // quota of medium boxes per frame
  small: 15,       // quota of small boxes per frame
  corners: 28,     // optical-flow corner markers
  labels: 0.55,    // share of boxes that get a chip (large ones always do)
  invert: 0.18,    // share of boxes whose contents are inverted
  shift: 0.12,     // share of boxes whose contents are shifted
  screen: 0.70,    // opacity of the screened strokes layer
  chip: 0.86,      // opacity of the chips layer
});
const INT_PARAMS = ["large", "medium", "small", "corners"];
const PERCENT = ["bright", "dark"];
const SHARES = ["labels", "invert", "shift", "screen", "chip"];
export const MIN_SIDE = 60;   // smallest frame side: keeps the 18*k label font at >= 1 px

const REF = 1080;             // short side the look was tuned at
const WORK = 540;             // short side detection runs at
const RESEED_EVERY = 45;      // frames between corner re-seeds

/** A user-facing error: bad parameters or frame size. */
export class BlobTrackError extends Error {
  constructor(message) { super(message); this.name = "BlobTrackError"; }
}

// ================================================================ loading
let loading = null;
let ready = false;
let fontFamily = "monospace";     // becomes FONT_FAMILY once the .ttf has loaded

/**
 * Load OpenCV.js and the label font. Idempotent: every call returns the same
 * promise, and the options of the first call win (later calls' options are
 * ignored). After a failure, the next call retries. A missing font only warns
 * (labels fall back to `monospace`); an OpenCV failure rejects.
 *
 * @param {object} [opts]
 * @param {string} [opts.url]      OpenCV.js build to load (default: jsDelivr); self-host for offline use
 * @param {string} [opts.fontUrl]  JetBrainsMono-Regular.ttf (default: beside this module)
 * @param {number} [opts.timeout]  ms to wait for an already-present <script> tag to finish and for
 *                                 the wasm runtime to initialise (default 120000); the download of a
 *                                 script this call injects is bounded by the browser, not this
 * @returns {Promise<void>}        resolves with nothing -- see the note on `cv` below
 */
export function loadOpenCV(opts = {}) {
  if (!loading) {
    const { url = OPENCV_URL, fontUrl = FONT_URL, timeout = 120000 } = opts;
    loading = Promise.all([loadCv(url, timeout), loadFont(fontUrl)])
      .then(() => { ready = true; })
      .catch(e => { loading = null; throw e; });
  }
  return loading;
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]);
}

/**
 * Wait for an OpenCV.js <script> someone else added (another copy of this
 * module, or the page). `cv` was undefined when we looked, so the tag is still
 * loading, or it finished without defining `cv` (failed). Settle at once when
 * we can tell which: our own tags carry data-blobtrack="loading|loaded|error";
 * for a foreign tag, a finished resource-timing entry means its load is over.
 */
function waitForTag(tag, url, timeout) {
  const failed = () => new Error(`the existing <script src="${url}"> failed to load OpenCV.js`);
  const state = tag.dataset.blobtrack;
  if (state === "error") return Promise.reject(failed());
  if (state === "loaded" || globalThis.cv) return Promise.resolve();
  if (state !== "loading") {
    const entry = performance.getEntriesByName(tag.src, "resource").pop();
    if (entry && entry.responseEnd > 0) {
      // fetched: an async script runs right after its fetch, so give it one task to define cv
      return new Promise(r => setTimeout(r, 0)).then(() => { if (!globalThis.cv) throw failed(); });
    }
  }
  return withTimeout(new Promise((resolve, reject) => {
    tag.addEventListener("load", resolve, { once: true });
    tag.addEventListener("error", () => reject(failed()), { once: true });
  }), timeout, `the existing <script src="${url}"> did not finish within ${timeout} ms`);
}

async function loadCv(url, timeout) {
  if (typeof document === "undefined") throw new Error("loadOpenCV runs on the main thread only (it adds a <script> tag)");
  if (!globalThis.cv) {
    const abs = new URL(url, document.baseURI).href;
    const existing = [...document.scripts].find(s => s.src === abs);
    if (existing) await waitForTag(existing, url, timeout);
    else {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = url;
        s.async = true;
        s.dataset.blobtrack = "loading";             // lets another loader see how this tag ended
        s.onload = () => { s.dataset.blobtrack = "loaded"; resolve(); };
        s.onerror = () => {
          s.dataset.blobtrack = "error";
          s.remove();                                // so a retry starts clean
          reject(new Error(`could not load OpenCV.js from ${url}`));
        };
        document.head.appendChild(s);
      });
    }
  }
  const cv = globalThis.cv;
  if (!cv) throw new Error(`${url} loaded but did not define cv`);
  // NEVER `await cv` (or resolve a promise with it). This build's `cv` is a
  // thenable whose then() resolves with cv itself, so awaiting it unwraps
  // forever: an endless microtask loop that freezes the tab outright. Wait for
  // the runtime callback instead, then remove `then` so nobody can trip on it.
  if (!cv.Mat) {
    await withTimeout(new Promise(resolve => {
      const prev = cv.onRuntimeInitialized;
      cv.onRuntimeInitialized = () => {
        if (typeof prev === "function") prev();
        resolve();
      };
    }), timeout, `OpenCV.js runtime did not initialise within ${timeout} ms`);
  }
  delete cv.then;
}

async function loadFont(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const face = new FontFace(FONT_FAMILY, await res.arrayBuffer());
    await face.load();
    document.fonts.add(face);
    fontFamily = FONT_FAMILY;
  } catch (e) {
    console.warn(`blobtrack: could not load the label font from ${url} (${e.message || e}); ` +
      "labels fall back to monospace. Ship JetBrainsMono-Regular.ttf beside blobtrack.js or pass fontUrl.");
  }
}

// ================================================================ helpers
function checkParams(cfg) {
  for (const [name, val] of Object.entries(cfg)) {
    if (typeof val !== "number") throw new BlobTrackError(`${name} must be a number, got ${JSON.stringify(val) ?? String(val)}`);
    if (!Number.isFinite(val)) throw new BlobTrackError(`${name} must be a finite number, got ${val}`);
    if (INT_PARAMS.includes(name) && !Number.isInteger(val)) throw new BlobTrackError(`${name} must be a whole number, got ${val}`);
  }
  for (const name of PERCENT)
    if (!(cfg[name] >= 0 && cfg[name] <= 100)) throw new BlobTrackError(`${name} is a percentile and must be 0..100, got ${cfg[name]}`);
  for (const name of SHARES)
    if (!(cfg[name] >= 0 && cfg[name] <= 1)) throw new BlobTrackError(`${name} must be 0..1, got ${cfg[name]}`);
  for (const name of INT_PARAMS)
    if (!(cfg[name] >= 0)) throw new BlobTrackError(`${name} must be >= 0, got ${cfg[name]}`);
  if (!(cfg.motion >= 0 && cfg.motion <= 255))
    throw new BlobTrackError(`motion is a grey-level difference and must be 0..255, got ${cfg.motion}`);
}

/** Stable per-ID randomness in [0, 1). */
export function rnd(i, salt) {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Intersection over union of two {x, y, w, h} boxes. */
export function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter + 1e-6);
}

/** np.percentile(u8, q) with numpy's default linear interpolation. */
function percentileU8(data, q) {
  const n = data.length, hist = new Float64Array(256);
  for (let i = 0; i < n; i++) hist[data[i]]++;
  const rank = (q / 100) * (n - 1);                // numpy: virtual index (n-1)*q
  const lo = Math.floor(rank), gamma = rank - lo;
  const hiIdx = Math.min(lo + 1, n - 1);
  // values at sorted positions lo and hiIdx, read off the cumulative histogram
  let a = -1, b = -1;
  for (let v = 0, c = 0; v < 256; v++) {
    c += hist[v];
    if (a < 0 && c > lo) a = v;
    if (c > hiIdx) { b = v; break; }
  }
  const diff = b - a;                              // numpy's _lerp, both branches
  return gamma >= 0.5 ? b - diff * (1 - gamma) : a + diff * gamma;
}

// uint8 `v > t` for a float t is v > floor(t); `v < t` is v <= ceil(t) - 1.
// cv.threshold on 8-bit input compares against floor(thresh) exactly so.
function greater(src, dst, t) { cv.threshold(src, dst, Math.floor(t), 1, cv.THRESH_BINARY); }
function less(src, dst, t) { cv.threshold(src, dst, Math.ceil(t) - 1, 1, cv.THRESH_BINARY_INV); }

/** Python's "%.3f": the exact binary value, exact ties to even (toFixed rounds them up). */
function fmt3(x) {
  const t = x * 16;                                // exact ties at the 4th decimal are odd sixteenths
  if (Number.isInteger(t) && t % 2 !== 0) {
    const lo = Math.floor(Math.abs(x) * 1000), n = lo % 2 === 0 ? lo : lo + 1;
    return (x < 0 ? "-" : "") + (n / 1000).toFixed(3);
  }
  return x.toFixed(3);
}
const pad = (n, width) => String(n).padStart(width, "0");   // "%0Nd" for n >= 0

// =========================================================== BlobTracker
/** Stateful per-clip effect: feed frames in order to `process`. */
export class BlobTracker {
  /**
   * @param {number} width   frame width in px (>= 60)
   * @param {number} height  frame height in px (>= 60)
   * @param {object} [params] any of DEFAULTS' keys
   */
  constructor(width, height, params = {}) {
    if (!ready || !globalThis.cv || !globalThis.cv.Mat)
      throw new Error("OpenCV.js is not loaded: `await loadOpenCV()` before creating a BlobTracker");
    params = params ?? {};
    const unknown = Object.keys(params).filter(k => !Object.hasOwn(DEFAULTS, k)).sort();
    if (unknown.length)
      throw new TypeError(`unknown parameter(s): ${unknown.join(", ")} (known: ${Object.keys(DEFAULTS).join(", ")})`);
    if (!Number.isFinite(width) || !Number.isFinite(height))
      throw new BlobTrackError(`frame size must be numbers, got ${width}x${height}`);
    this.W = Math.trunc(width);
    this.H = Math.trunc(height);
    if (Math.min(this.W, this.H) < MIN_SIDE)
      throw new BlobTrackError(`frame is ${this.W}x${this.H}; blob tracking needs at least ${MIN_SIDE} px on each side`);
    const cfg = { ...DEFAULTS, ...params };
    checkParams(cfg);
    for (const k of INT_PARAMS) cfg[k] = Math.trunc(cfg[k]);
    this.cfg = cfg;

    const short = Math.min(this.W, this.H);
    this.k = short / REF;
    this.S = WORK / short;
    this.work = [Math.trunc(this.W * this.S + 0.5), Math.trunc(this.H * this.S + 0.5)];
    this.capW = this.W * 560 / 1080;
    this.capH = this.H * 760 / 1920;
    this.label = 18 * this.k;
    this._font = `${this.label}px ${fontFamily}`;

    // drawing surfaces, reused every frame (made before any Mat, which could leak)
    const canvas = () => (typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(this.W, this.H)
      : Object.assign(document.createElement("canvas"), { width: this.W, height: this.H }));
    this._strokes = canvas().getContext("2d");
    this._chips = canvas().getContext("2d");
    if (!this._strokes || !this._chips) throw new Error("could not create a 2D canvas context");
    this._chips.font = this._font;
    this._ascent = this._chips.measureText("Ag").fontBoundingBoxAscent;   // Pillow draws text from the ascender
    this._out = new ImageData(this.W, this.H);

    const made = [];                                  // freed if a later allocation throws
    const keep = m => { made.push(m); return m; };
    try {
      this._kernel = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)));
      this._kernel9 = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9)));
      this._rgba = keep(new cv.Mat(this.H, this.W, cv.CV_8UC4));   // reused input buffer
      this.pts = keep(new cv.Mat());                  // corner points, CV_32FC2, one per row
    } catch (e) {
      for (const m of made) m.delete();
      throw e;
    }

    this.frame = 0;          // index of the next frame
    this.tracks = [];
    this.nextId = 1;
    this.hist = [];          // last three working-res greys (cv.Mat), oldest first
    this.reseeds = [];       // frame indices at which corners were (re)seeded
    this.lastTracks = [];
    this.lastPoints = [];
    this._disposed = false;
    this._broken = null;     // the error that made this tracker unusable
  }

  // ---------------------------------------------------------------- detect
  gray(imageData) {
    this._rgba.data.set(imageData.data);
    const g = new cv.Mat();
    let small = null;
    try {
      cv.cvtColor(this._rgba, g, cv.COLOR_RGBA2GRAY);   // same weights as RGB2GRAY
      if (this.W === this.work[0] && this.H === this.work[1]) return g;
      small = new cv.Mat();
      cv.resize(g, small, new cv.Size(this.work[0], this.work[1]), 0, 0, cv.INTER_LINEAR);
      g.delete();
      return small;
    } catch (e) {
      if (!g.isDeleted()) g.delete();
      if (small) small.delete();
      throw e;
    }
  }

  _components(mask, amin, amax, kind) {
    const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
    try {
      const n = cv.connectedComponentsWithStats(mask, labels, stats, cents, 8, cv.CV_32S);
      const st = stats.data32S, S = this.S, out = [];
      for (let i = 1; i < n; i++) {
        const x = st[i * 5], y = st[i * 5 + 1], w = st[i * 5 + 2], h = st[i * 5 + 3], a = st[i * 5 + 4];
        if (amin <= a && a <= amax && w > 3 && h > 3 && w / S <= this.capW && h / S <= this.capH)
          out.push({ x: x / S, y: y / S, w: w / S, h: h / S, a: a / (S * S), kind, _box: [x, y, w, h] });
      }
      return out;
    } finally {
      labels.delete(); stats.delete(); cents.delete();
    }
  }

  detect(g, gprev) {
    const cfg = this.cfg, k5 = this._kernel;
    const tmp = [];                                   // every Mat made here, freed in `finally`
    const mat = () => { const m = new cv.Mat(); tmp.push(m); return m; };
    let blobs = [];
    try {
      const gb = mat();
      cv.GaussianBlur(g, gb, new cv.Size(0, 0), 2.2, 0, cv.BORDER_DEFAULT);
      const hi = percentileU8(gb.data, cfg.bright);
      const lo = percentileU8(gb.data, cfg.dark);
      let m = mat();
      greater(gb, m, hi);
      cv.morphologyEx(m, m, cv.MORPH_CLOSE, k5);
      blobs = blobs.concat(this._components(m, 40, 90000, "B"));
      m = mat();
      less(gb, m, lo);
      cv.morphologyEx(m, m, cv.MORPH_CLOSE, k5);
      blobs = blobs.concat(this._components(m, 40, 90000, "D"));
      const e = mat();
      cv.Canny(g, e, 60, 150);
      cv.dilate(e, e, this._kernel9);
      cv.morphologyEx(e, e, cv.MORPH_OPEN, k5);
      m = mat();
      greater(e, m, 0);
      blobs = blobs.concat(this._components(m, 120, 60000, "E"));
      if (gprev) {
        const d = mat();
        cv.absdiff(g, gprev, d);
        cv.GaussianBlur(d, d, new cv.Size(0, 0), 3, 0, cv.BORDER_DEFAULT);
        m = mat();
        greater(d, m, cfg.motion);
        cv.dilate(m, m, k5, new cv.Point(-1, -1), 2);
        blobs = blobs.concat(this._components(m, 60, 120000, "M"));
      }
    } finally {
      for (const m of tmp) m.delete();
    }

    // contrast: population std of the grey over rows y..y+h, cols x..x+w
    // (inclusive, clipped). Integer sums are exact, so this is the correctly
    // rounded std; numpy's float summation lands within an ulp or two of it.
    const gd = g.data, cols = g.cols, rows = g.rows;
    for (const b of blobs) {
      const [x, y, w, h] = b._box;
      delete b._box;
      const x1 = Math.min(x + w + 1, cols), y1 = Math.min(y + h + 1, rows);
      let sum = 0, sq = 0;
      for (let r = y; r < y1; r++) {
        for (let i = r * cols + x, end = r * cols + x1; i < end; i++) { const v = gd[i]; sum += v; sq += v * v; }
      }
      const n = (x1 - x) * (y1 - y);
      const c = n > 0 ? Math.sqrt((n * sq - sum * sum) / (n * n)) : 0;
      b.score = (b.kind === "M" ? 2 : 1) * Math.sqrt(b.a) * (8 + c);
    }
    blobs.sort((p, q) => q.score - p.score);          // stable, like Python's sort

    const big = 230 * this.k, mid = 70 * this.k;
    const quota = { L: cfg.large, M: cfg.medium, S: cfg.small };
    const picked = [];
    for (const b of blobs) {
      const side = Math.sqrt(b.w * b.h);
      const tier = side > big ? "L" : (side > mid ? "M" : "S");
      if (quota[tier] <= 0) continue;
      if (picked.some(p => iou(b, p) > 0.45)) continue;
      quota[tier] -= 1;
      picked.push(b);
    }
    return picked;
  }

  // ----------------------------------------------------------------- track
  _update(dets) {
    const norm = 160 * this.k;
    const live = [], used = new Set();
    for (const t of this.tracks) {
      let best = null, bs = 0;
      dets.forEach((d, j) => {
        if (used.has(j)) return;
        const dist = Math.hypot(t.x + t.w / 2 - d.x - d.w / 2, t.y + t.h / 2 - d.y - d.h / 2);
        const s = iou(t, d) + Math.max(0, 1 - dist / norm) * 0.6;
        if (s > bs) { bs = s; best = j; }
      });
      if (best !== null && bs > 0.25) {
        const d = dets[best];
        used.add(best);
        for (const key of ["x", "y", "w", "h"]) t[key] = t[key] * 0.45 + d[key] * 0.55;
        t.a = d.a; t.kind = d.kind; t.age += 1;
        live.push(t);
      }
    }
    dets.forEach((d, j) => {
      if (!used.has(j)) {
        live.push({ id: this.nextId, x: d.x, y: d.y, w: d.w, h: d.h, a: d.a, kind: d.kind, age: 0 });
        this.nextId += 1;
      }
    });
    this.tracks = live;
    return live;
  }

  _corners(g) {
    const n = this.cfg.corners;
    if (this.frame > 0 && this.pts.rows) {
      const next = new cv.Mat(), status = new cv.Mat(), err = new cv.Mat();
      try {
        cv.calcOpticalFlowPyrLK(this.hist[this.hist.length - 1], g, this.pts, next, status, err,
          new cv.Size(21, 21), 3);
        const keep = [], p = next.data32F, st = status.data;
        for (let r = 0; r < status.rows; r++) if (st[r] === 1) keep.push(p[r * 2], p[r * 2 + 1]);
        this._setPts(keep.length ? cv.matFromArray(keep.length / 2, 1, cv.CV_32FC2, keep) : new cv.Mat());
      } finally {
        next.delete(); status.delete(); err.delete();
      }
    }
    if (this.frame === 0 || this.pts.rows < n / 2 || this.frame % RESEED_EVERY === 0) {
      const p = new cv.Mat();
      try {
        if (n > 0) cv.goodFeaturesToTrack(g, p, n, 0.02, 22);   // maxCorners 0 would mean "no limit"
      } catch (e) {
        p.delete();
        throw e;
      }
      this._setPts(p);
      this.reseeds.push(this.frame);
    }
    const d = this.pts.data32F, out = [];
    for (let r = 0; r < this.pts.rows; r++) out.push([d[r * 2] / this.S, d[r * 2 + 1] / this.S]);
    return out;
  }

  _setPts(m) { this.pts.delete(); this.pts = m; }

  // ------------------------------------------------------------------ draw
  _lw(n) { return Math.max(1, Math.trunc(n * this.k + 0.5)); }

  draw(imageData, tracks, pts, frameNo, outCtx) {
    const { cfg, W, H, k, label: L } = this;
    const base = imageData.data, o = this._out.data;
    o.set(base);
    // windows: a minority of boxes turn their contents over or slip
    for (const t of tracks) {
      let x0 = Math.trunc(t.x), y0 = Math.trunc(t.y);
      let x1 = Math.trunc(t.x + t.w), y1 = Math.trunc(t.y + t.h);
      x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1);
      const bw = x1 - x0, bh = y1 - y0, r = rnd(t.id, 3);
      if (r < cfg.invert && bw * bh < (260 * k) ** 2) {
        for (let y = y0; y < y1; y++) for (let i = (y * W + x0) * 4, end = (y * W + x1) * 4; i < end; i += 4) {
          o[i] = 255 - base[i]; o[i + 1] = 255 - base[i + 1]; o[i + 2] = 255 - base[i + 2];
        }
      } else if (r < cfg.invert + cfg.shift) {
        const dx = Math.trunc((rnd(t.id, 4) - 0.5) * 36 * k);    // int() truncates toward zero
        const dy = Math.trunc((rnd(t.id, 5) - 0.5) * 36 * k);
        const sx = Math.min(Math.max(x0 + dx, 0), W - bw);
        const sy = Math.min(Math.max(y0 + dy, 0), H - bh);
        for (let y = 0; y < bh; y++) {
          const src = ((sy + y) * W + sx) * 4, dst = ((y0 + y) * W + x0) * 4;
          o.set(base.subarray(src, src + bw * 4), dst);
        }
      }
    }

    // strokes: always white, so the layer carries only alpha. Pillow's
    // ImageDraw overwrites a pixel's alpha rather than blending over it; each
    // stroke here erases its footprint first ("destination-out") and then
    // paints, which does the same.
    const d = this._strokes, dc = this._chips;
    d.clearRect(0, 0, W, H);
    dc.clearRect(0, 0, W, H);
    d.lineCap = "butt";
    const paint = (alpha, width) => {
      d.lineWidth = width;
      d.globalCompositeOperation = "destination-out";
      d.strokeStyle = "#fff";
      d.stroke();
      d.globalCompositeOperation = "source-over";
      d.strokeStyle = `rgba(255,255,255,${alpha / 255})`;
      d.stroke();
    };
    const line = (p, q, alpha, width) => {
      d.beginPath(); d.moveTo(p[0], p[1]); d.lineTo(q[0], q[1]); paint(alpha, width);
    };
    // Pillow's rectangle([x0, y0, x1, y1], width=w) covers x0..x1 inclusive
    // and grows its outline inwards; canvas strokes are centred on the path.
    const rect = (x0, y0, x1, y1, alpha, width) => {
      const rw = x1 - x0 + 1, rh = y1 - y0 + 1;
      d.beginPath();
      d.rect(x0 + width / 2, y0 + width / 2, Math.max(0, rw - width), Math.max(0, rh - width));
      paint(alpha, width);
    };
    const w1 = this._lw(1), w2 = this._lw(2);

    const cen = tracks.map(t => [t.x + t.w / 2, t.y + t.h / 2]);
    const idx = cen.map((_, j) => j);
    const drawn = new Set();
    // Two nearest neighbours by sorting every centroid for every centroid:
    // O(n^2 log n), which is fine because the quotas keep n <= large + medium +
    // small (32 by default). A spatial index would not preserve the stable-sort
    // tie order Python uses, so keep it literal.
    cen.forEach((c, i) => {
      const dist = j => (cen[j][0] - c[0]) ** 2 + (cen[j][1] - c[1]) ** 2;
      const near = [...idx].sort((a, b) => dist(a) - dist(b)).slice(1, 3);   // stable sort
      for (const j of near) {
        const key = `${Math.min(i, j)},${Math.max(i, j)}`;
        if (drawn.has(key)) continue;
        drawn.add(key);
        line(c, cen[j], 150, w2);
      }
    });
    const order = [...idx].sort((a, b) => cen[a][0] - cen[b][0]);
    for (let i = 0; i + 1 < order.length; i++) {
      const a = order[i], b = order[i + 1];
      if (rnd(tracks[a].id, 9) < 0.5) line(cen[a], cen[b], 80, w1);
    }

    pts.forEach(([px, py], n) => {
      const s = (6 + Math.trunc(rnd(n, 11) * 14)) * k;
      rect(px - s / 2, py - s / 2, px + s / 2, py + s / 2, 200, w1);
      if (n % 5 === 0 && cen.length) {
        let j = 0, bd = Infinity;                           // first minimum, like min()
        cen.forEach((c, i) => { const q = (c[0] - px) ** 2 + (c[1] - py) ** 2; if (q < bd) { bd = q; j = i; } });
        line([px, py], cen[j], 70, w1);
      }
    });

    dc.font = this._font;
    dc.textBaseline = "alphabetic";
    const text = (s, x, y) => { dc.fillStyle = "#000"; dc.fillText(s, x, y + this._ascent); };
    const fill = (x0, y0, x1, y1) => { dc.fillStyle = "#fff"; dc.fillRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1); };

    const chips = [];
    const big = 230 * k, tick = 18 * k, cross = 9 * k;
    tracks.forEach((t, i) => {
      const c = cen[i];
      const x0 = t.x, y0 = t.y, x1 = t.x + t.w, y1 = t.y + t.h;
      const side = Math.sqrt(t.w * t.h);
      const wdt = side > big ? this._lw(3) : w2;
      rect(x0, y0, x1, y1, 235, wdt);
      if (side > 90 * k) {
        for (const [cx, cy, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
          line([cx, cy], [cx + sx * tick, cy], 255, wdt + w2);
          line([cx, cy], [cx, cy + sy * tick], 255, wdt + w2);
        }
      }
      if (rnd(t.id, 7) < 0.45) {
        line([c[0] - cross, c[1]], [c[0] + cross, c[1]], 230, w1);
        line([c[0], c[1] - cross], [c[0], c[1] + cross], 230, w1);
      }

      if (rnd(t.id, 8) < cfg.labels || side > big) {
        const v = rnd(t.id, 12);
        let txt;
        if (v < 0.34) txt = `ID ${pad(t.id, 2)}`;
        else if (v < 0.67) txt = `${fmt3(c[0] / W)}  ${fmt3(c[1] / H)}`;
        else txt = `${t.kind}${pad(t.id, 2)}  A${pad(Math.trunc(t.a), 5)}`;
        const tw = dc.measureText(txt).width;
        let lx = x0, ly = y0 - L - 7 * k;
        if (ly < 4 * k) ly = y1 + 3 * k;
        const box = [lx - 4 * k, ly - 4 * k, lx + tw + 12 * k, ly + L + 9 * k];
        if (chips.some(b => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) return;
        chips.push(box);
        fill(lx, ly, lx + tw + 8 * k, ly + L + 5 * k);
        text(txt, lx + 4 * k, ly + 1 * k);
      }
    });

    const txt = `TRACK ${pad(frameNo, 4)}  ${pad(tracks.length, 2)} BLOBS  ${pad(pts.length, 2)} PTS`;
    const tw = dc.measureText(txt).width;
    fill(26 * k, H - 58 * k, 26 * k + tw + 10 * k, H - 58 * k + L + 7 * k);
    text(txt, 31 * k, H - 56 * k);

    this._composite(outCtx);
  }

  /**
   * Blend both layers over the windowed frame, into `outCtx`.
   *   SCREEN, not over, for the strokes:  b = b + (1 - b) * stroke * alpha * screen
   *   normal blend for the chips:         b = b * (1 - ca) + chip * ca
   * With a white stroke, canvas "screen" at globalAlpha = screen is exactly the
   * first line; the chips layer is plain source-over at the chip opacity.
   */
  _composite(outCtx) {
    outCtx.putImageData(this._out, 0, 0);         // ignores the transform
    outCtx.save();
    outCtx.setTransform(1, 0, 0, 1, 0, 0);        // the layers are frame-sized: draw them 1:1
    outCtx.globalCompositeOperation = "screen";
    outCtx.globalAlpha = this.cfg.screen;
    outCtx.drawImage(this._strokes.canvas, 0, 0);
    outCtx.globalCompositeOperation = "source-over";
    outCtx.globalAlpha = this.cfg.chip;
    outCtx.drawImage(this._chips.canvas, 0, 0);
    outCtx.restore();
  }

  // --------------------------------------------------------------- process
  /**
   * Treat one frame; frames must arrive in order.
   * Bad arguments throw and leave the tracker usable; any later failure makes it
   * unusable (see the header).
   * @param {ImageData} imageData  the input frame, width x height RGBA
   * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} outCtx  receives the treated
   *        frame at (0, 0), 1:1 whatever its current transform (it is reset for the draw and restored)
   */
  process(imageData, outCtx) {
    if (this._disposed) throw new BlobTrackError("this BlobTracker has been disposed");
    if (this._broken)
      throw new BlobTrackError(`tracker is unusable after an error; create a new one (first error: ${this._broken.message || this._broken})`);
    // argument checks: nothing has changed yet, so these leave the tracker usable
    if (!imageData || !imageData.data)
      throw new BlobTrackError(`process() needs an ImageData, got ${imageData}`);
    if (imageData.width !== this.W || imageData.height !== this.H)
      throw new BlobTrackError(`expected a ${this.W}x${this.H} frame, got ${imageData.width}x${imageData.height}`);
    if (imageData.data.length !== this.W * this.H * 4)
      throw new BlobTrackError(`expected ${this.W * this.H * 4} bytes of RGBA, got ${imageData.data.length}`);
    if (!outCtx || typeof outCtx.putImageData !== "function")
      throw new TypeError("process(imageData, outCtx) needs a 2D canvas context to draw into");
    try {
      this._process(imageData, outCtx);
    } catch (e) {
      this._broken = e;          // state may be half-advanced from here on
      throw e;
    }
  }

  _process(imageData, outCtx) {
    const g = this.gray(imageData);
    let tracks, pts;
    try {
      tracks = this._update(this.detect(g, this.hist.length === 3 ? this.hist[0] : null));
      pts = this._corners(g);
    } catch (e) {
      g.delete();
      throw e;
    }
    this.hist.push(g);
    if (this.hist.length > 3) this.hist.shift().delete();
    this.lastTracks = tracks.map(({ id, x, y, w, h, kind, a, age }) => ({ id, x, y, w, h, kind, a, age }));
    this.lastPoints = pts;
    this.draw(imageData, tracks, pts, this.frame, outCtx);
    this.frame += 1;
  }

  /** Free the OpenCV Mats this tracker holds. It cannot be used afterwards. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const m of this.hist) m.delete();
    this.hist = [];
    for (const m of [this.pts, this._kernel, this._kernel9, this._rgba]) m.delete();
  }
}
