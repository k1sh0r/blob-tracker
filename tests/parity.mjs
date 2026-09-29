#!/usr/bin/env node
// Parity test: the browser module (blobtrack.js, OpenCV.js) must produce the
// same detections as the Python reference (blobtrack.py) on the committed
// fixtures.
//
//     npm run test:parity            (or: node tests/parity.mjs)
//     OPENCV_URL=http://.../opencv.js npm run test:parity    (self-hosted build)
//
// Serves the repo root on a free port, opens tests/parity.html in headless
// system Chrome (playwright-core, channel "chrome"), runs a fresh BlobTracker
// over each clip's lossless PNG frames with the reference params, and checks
// per frame against tests/fixtures/<clip>/reference.json:
//   * the same number of tracks;
//   * >= 95 % of the Python tracks have a JS track with IoU > 0.9 AND the same ID;
//   * the same number of corner points (end to end, every frame);
//   * one step of the corner stage, started from Python's previous-frame
//     points, lands on Python's points (same count, within 0.5 px). This
//     isolates the port from float drift that accumulates across frames.
// Also checks that no OpenCV Mat leaks (live Mat count flat from frame 10 to
// the last frame, and back to zero after dispose()).
// Writes, for eyeballing, tests/out/<clip>-js.png (one JS output frame) and
// tests/out/<clip>-py-vs-js.png (Python render | JS render of that frame,
// made with the repo venv). Exits non-zero on any failure.

import { createServer } from "node:http";
import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { extname, join, normalize, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "tests", "out");
const CLIPS = ["shapes", "pan"];
const SHOW_FRAME = 40;               // the frame rendered for eyeballing
const LEAK_FROM = 10;                // live-Mat count must not grow after this frame
const MIN_MATCH = 0.95, MIN_IOU = 0.9, MAX_PT_DEV = 0.5;
const LOAD_TIMEOUT = 180_000, CLIP_TIMEOUT = 120_000;

// ------------------------------------------------------------ static server
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".ttf": "font/ttf", ".css": "text/css", ".mp4": "video/mp4",
};

function serve() {
  const server = createServer(async (req, res) => {
    try {
      const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
      const file = join(ROOT, path);
      if (file !== ROOT && !file.startsWith(ROOT + sep)) throw Object.assign(new Error("outside root"), { code: "ENOENT" });
      if (!(await stat(file)).isFile()) throw Object.assign(new Error("not a file"), { code: "ENOENT" });
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r(server)));
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms); }),
  ]);
}

// ------------------------------------------------------------------ compare
function iou(a, b) {                 // same formula as blobtrack.py
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter + 1e-6);
}

function compareClip(ref, js) {
  const fails = [];
  if (js.frames.length !== ref.frame_count || ref.tracks.length !== ref.frame_count || ref.points.length !== ref.frame_count)
    return { fails: [`frame counts differ: JS processed ${js.frames.length}, reference.json has frame_count ` +
      `${ref.frame_count} with ${ref.tracks.length} track and ${ref.points.length} point frames`], stats: null };
  let pyTotal = 0, matched = 0, sameId = 0, iouSum = 0, kindDiff = 0, maxDev = 0, maxStep = 0, drifted = 0, ptTotal = 0;
  for (let f = 0; f < ref.frame_count; f++) {
    const py = ref.tracks[f], got = js.frames[f].tracks;
    if (py.length !== got.length) fails.push(`frame ${f}: ${got.length} JS tracks vs ${py.length} Python`);
    let okFrame = 0;
    for (const p of py) {
      let best = 0, bestT = null;
      for (const t of got) { const v = iou(p, t); if (v > best) { best = v; bestT = t; } }
      pyTotal++;
      if (best > MIN_IOU) {
        matched++;
        iouSum += best;
        if (bestT.id === p.id) { sameId++; okFrame++; }
        if (bestT.kind !== p.kind) kindDiff++;
      }
    }
    if (py.length && okFrame / py.length < MIN_MATCH)
      fails.push(`frame ${f}: only ${okFrame}/${py.length} Python tracks matched at IoU>${MIN_IOU} with the same ID`);

    const pp = ref.points[f], jp = js.frames[f].points;
    if (pp.length !== jp.length) fails.push(`frame ${f}: ${jp.length} JS corner points vs ${pp.length} Python`);
    else for (let i = 0; i < pp.length; i++) {
      const d = Math.hypot(pp[i][0] - jp[i][0], pp[i][1] - jp[i][1]);
      maxDev = Math.max(maxDev, d);
      ptTotal++;
      // Not gated. Native OpenCV (NEON on arm64) and the scalar-wasm OpenCV.js
      // sum LK's floats in a different order; each step differs by ~1e-4 px,
      // which compounds on low-texture corners (tiny min eigenvalue) until LK
      // settles elsewhere. The re-seed every 45 frames re-syncs them. The
      // gated single-step check below is what proves the port is right.
      if (d > MAX_PT_DEV) drifted++;
    }
    const sp = js.frames[f].stepPoints;
    if (sp.length !== pp.length) fails.push(`frame ${f}: one corner step from Python's points gives ${sp.length} points vs ${pp.length}`);
    else for (let i = 0; i < pp.length; i++) {
      const d = Math.hypot(pp[i][0] - sp[i][0], pp[i][1] - sp[i][1]);
      maxStep = Math.max(maxStep, d);
      if (d > MAX_PT_DEV) fails.push(`frame ${f}: one corner step puts point ${i} ${d.toFixed(3)} px from Python's`);
    }
  }
  const fr = js.frames, last = fr.length - 1;
  const leak = fr[last].liveMats - fr[LEAK_FROM - 1].liveMats;
  if (leak !== 0) fails.push(`Mat leak: ${fr[LEAK_FROM - 1].liveMats} live Mats after frame ${LEAK_FROM}, ${fr[last].liveMats} after frame ${last + 1}`);
  if (js.liveAfterDispose !== 0) fails.push(`dispose() left ${js.liveAfterDispose} live Mats`);
  const ms = fr.map(x => x.ms);
  return {
    fails,
    stats: {
      pyTracks: pyTotal,
      matchPct: 100 * matched / pyTotal,
      sameIdPct: 100 * sameId / pyTotal,
      meanIoU: matched ? iouSum / matched : 0,
      kindDiff,
      maxPointDev: maxDev,
      maxStepDev: maxStep,
      drifted: `${drifted}/${ptTotal}`,
      jsMsMean: ms.reduce((a, b) => a + b, 0) / ms.length,
      jsMsMedian: [...ms].sort((a, b) => a - b)[ms.length >> 1],
      liveMats: `${fr[LEAK_FROM - 1].liveMats} @${LEAK_FROM} -> ${fr[last].liveMats} @${last + 1}, ${js.liveAfterDispose} after dispose`,
      heapMB: `${(fr[LEAK_FROM - 1].heapBytes / 2 ** 20).toFixed(0)} -> ${(fr[last].heapBytes / 2 ** 20).toFixed(0)}`,
    },
  };
}

// ------------------------------------------------------- python side-by-side
function pythonSide(clip, jsPng) {
  const py = join(ROOT, ".venv", "bin", "python");
  if (!existsSync(py)) return { note: "no .venv/bin/python; skipped the Python render and side-by-side" };
  const r = spawnSync(py, [join(ROOT, "tests", "parity_render.py"), clip, String(SHOW_FRAME), jsPng, OUT],
    { encoding: "utf8", timeout: 300_000 });
  if (r.status !== 0) return { note: `Python render failed: ${(r.stderr || r.error || "").toString().trim()}` };
  try {
    return JSON.parse(r.stdout.trim().split("\n").pop());
  } catch {
    return { note: `Python render printed no result line: ${r.stdout.trim().slice(-200)}` };
  }
}

// --------------------------------------------------------------------- main
const server = await serve();
const port = server.address().port;
const opencv = process.env.OPENCV_URL;
const url = `http://127.0.0.1:${port}/tests/parity.html${opencv ? "?opencv=" + encodeURIComponent(opencv) : ""}`;
const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
console.log(`serving ${ROOT} on :${port}`);

let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
} catch (e) {
  console.error("Could not start Google Chrome. This test drives the system Chrome (playwright channel " +
    "\"chrome\"); install Google Chrome from https://www.google.com/chrome/ and re-run.\n\n" + e.message);
  server.close();
  process.exit(1);
}
let failed = false;
try {
  const page = await browser.newPage();
  page.on("console", m => console.log(`${stamp()} ${m.type() === "log" ? "" : m.type() + ": "}${m.text()}`));
  page.on("pageerror", e => console.log(`${stamp()} PAGEERROR ${e.message}`));
  page.on("crash", () => console.log(`${stamp()} PAGE CRASHED`));
  await page.goto(url, { timeout: 30_000 });
  await page.waitForFunction(() => window.PARITY && (window.PARITY.ready || window.PARITY.error),
    null, { timeout: LOAD_TIMEOUT, polling: 500 });
  const err = await page.evaluate(() => window.PARITY.error);
  if (err) throw new Error("harness failed to start: " + err);

  await mkdir(OUT, { recursive: true });
  const rows = [];
  for (const clip of CLIPS) {
    const ref = JSON.parse(await readFile(join(ROOT, "tests", "fixtures", clip, "reference.json"), "utf8"));
    const js = await withTimeout(page.evaluate(([c, f]) => window.PARITY.runClip(c, f), [clip, SHOW_FRAME]),
      CLIP_TIMEOUT, `clip ${clip}`);
    const jsPng = join(OUT, `${clip}-js.png`);
    await writeFile(jsPng, Buffer.from(js.showPng, "base64"));
    const { fails, stats } = compareClip(ref, js);
    const pyside = pythonSide(clip, jsPng);
    rows.push({ clip, W: js.W, H: js.H, n: ref.frame_count, stats, pyside, fails });
    if (fails.length) failed = true;
  }

  console.log("\n==== parity: blobtrack.js vs blobtrack.py ====");
  for (const { clip, W, H, n, stats: s, pyside, fails } of rows) {
    if (!s) {
      console.log(`\n${clip} (${W}x${H}): FAIL`);
      for (const f of fails) console.log("  - " + f);
      continue;
    }
    console.log(`\n${clip} (${W}x${H}, ${s.pyTracks} Python tracks over ${n} frames): ${fails.length ? "FAIL" : "PASS"}`);
    console.log(`  matched IoU>${MIN_IOU}      ${s.matchPct.toFixed(2)} %   (same ID ${s.sameIdPct.toFixed(2)} %)`);
    console.log(`  mean IoU of matches  ${s.meanIoU.toFixed(6)}   kind differs on ${s.kindDiff}`);
    console.log(`  one-step point dev   ${s.maxStepDev.toExponential(2)} px for one step from Python's points (gated <= ${MAX_PT_DEV})`);
    console.log(`  end-to-end points    ${s.maxPointDev.toExponential(2)} px max, ${s.drifted} over ${MAX_PT_DEV} px -- informational — native NEON vs scalar-wasm float drift on low-texture corners; re-syncs at re-seed`);
    console.log(`  ms/frame             JS ${s.jsMsMean.toFixed(1)} (median ${s.jsMsMedian.toFixed(1)})` +
      (pyside.pyMsMean ? `   Python ${pyside.pyMsMean.toFixed(1)} (median ${pyside.pyMsMedian.toFixed(1)})` : ""));
    console.log(`  live Mats            ${s.liveMats}   wasm heap ${s.heapMB} MB`);
    console.log(`  renders              ${pyside.sideBySide ? pyside.sideBySide : pyside.note}`);
    for (const f of fails.slice(0, 20)) console.log("  - " + f);
    if (fails.length > 20) console.log(`  ... and ${fails.length - 20} more`);
  }
  console.log(`\n${failed ? "FAIL" : "PASS"} in ${stamp()}`);
} catch (e) {
  failed = true;
  console.error(`${stamp()} ERROR ${e.stack || e}`);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
