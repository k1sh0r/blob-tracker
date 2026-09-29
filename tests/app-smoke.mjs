#!/usr/bin/env node
// App smoke test: the web app in app/ turns a fixture clip into a treated MP4.
//
//     npm run test:app               (or: node tests/app-smoke.mjs)
//     npm run test:app -- --headed   (visible Chrome window, if headless lacks an encoder)
//
// Serves the repo root on a free port, opens app/ in headless system Chrome
// (playwright-core, channel "chrome"), and for each fixture, in one page (so it
// also covers processing a second file without a reload): chooses the file,
// clicks Process, waits for completion, clicks Download and saves the file to
// tests/out/app-<clip>.mp4. Then, with ffprobe/ffmpeg, checks the output
// against the source clip:
//   * H.264 video at the same width, height and frame rate;
//   * the same number of decoded frames;
//   * an audio stream exactly when the source has one, with the source's audio
//     packets copied bit for bit (AAC fits MP4, so nothing needs re-encoding);
//   * the middle frame differs from the source's (mean absolute difference
//     above MIN_DIFF), i.e. the effect was applied, and is not a flat image.
// Writes the middle output frames to tests/out/app-frame.png (shapes) and
// tests/out/app-frame-pan.png. It also checks two failure paths show an
// inline error: a non-video file (before the clips, so the page must stay
// usable afterwards), and OpenCV.js failing to load (a fresh page with the CDN
// request blocked). Exits non-zero on any failure.

import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, serve, withTimeout, launchChrome, forwardConsole } from "./harness.mjs";

const OUT = join(ROOT, "tests", "out");
const CLIPS = [
  { clip: "shapes", png: "app-frame.png" },
  { clip: "pan", png: "app-frame-pan.png" },
];
const MIN_DIFF = 2.0;           // mean |out - src| over RGB, 0..255: the effect changed the frame
const MIN_STD = 10;             // output frame is not a flat image
const LOAD_TIMEOUT = 60_000, CLIP_TIMEOUT = 300_000;
const headed = process.argv.includes("--headed");

// ------------------------------------------------------------------ ffmpeg
function run(cmd, args, binary = false) {
  const r = spawnSync(cmd, args, { encoding: binary ? "buffer" : "utf8", maxBuffer: 1 << 28 });
  if (r.error) throw new Error(`${cmd} could not run (${r.error.message}); install ffmpeg`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr.toString().trim().slice(-400)}`);
  return r.stdout;
}

function probe(file) {
  const j = JSON.parse(run("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", file]));
  const v = j.streams.find(s => s.codec_type === "video");
  const a = j.streams.find(s => s.codec_type === "audio");
  const rate = r => { const [n, d] = r.split("/").map(Number); return d ? n / d : NaN; };
  return {
    vcodec: v?.codec_name, width: v?.width, height: v?.height,
    fps: v ? rate(v.avg_frame_rate) : NaN, rFps: v ? rate(v.r_frame_rate) : NaN,
    frames: v ? Number(v.nb_read_frames) : NaN,
    duration: Number(j.format.duration),
    acodec: a?.codec_name ?? null,
  };
}

function audioMd5(file) {
  return run("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a:0", "-c", "copy", "-f", "md5", "-"]).trim();
}

function frameRgb(file, n, w, h) {
  const buf = run("ffmpeg", ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${n})`, "-fps_mode", "passthrough",
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], true);
  if (buf.length !== w * h * 3) throw new Error(`frame ${n} of ${file}: got ${buf.length} bytes, expected ${w * h * 3}`);
  return buf;
}

function savePng(file, n, png) {
  run("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", `select=eq(n\\,${n})`, "-fps_mode", "passthrough",
    "-frames:v", "1", png]);
}

function check(src, outFile, pngOut) {
  const fails = [];
  const o = probe(outFile);
  if (o.vcodec !== "h264") fails.push(`video codec is ${o.vcodec}, expected h264`);
  if (o.width !== src.width || o.height !== src.height) fails.push(`size ${o.width}x${o.height}, source ${src.width}x${src.height}`);
  if (Math.abs(o.fps - src.fps) > 0.01) fails.push(`avg frame rate ${o.fps}, source ${src.fps}`);
  if (Math.abs(o.rFps - src.rFps) > 0.01) fails.push(`r_frame_rate ${o.rFps}, source ${src.rFps}`);
  if (o.frames !== src.frames) fails.push(`${o.frames} decoded frames, source has ${src.frames}`);
  if (!!o.acodec !== !!src.acodec) fails.push(`audio: output ${o.acodec ?? "none"}, source ${src.acodec ?? "none"}`);
  else if (src.acodec && audioMd5(outFile) !== audioMd5(src.file)) fails.push("audio packets differ from the source's (re-encoded?)");

  let diff = NaN, std = NaN;
  if (o.width === src.width && o.height === src.height && o.frames === src.frames) {
    const mid = Math.floor(src.frames / 2);
    const a = frameRgb(src.file, mid, src.width, src.height), b = frameRgb(outFile, mid, o.width, o.height);
    let sum = 0, s1 = 0, s2 = 0;
    for (let i = 0; i < a.length; i++) { sum += Math.abs(a[i] - b[i]); s1 += b[i]; s2 += b[i] * b[i]; }
    diff = sum / a.length;
    std = Math.sqrt(s2 / b.length - (s1 / b.length) ** 2);
    if (!(diff > MIN_DIFF)) fails.push(`middle frame differs from the source by ${diff.toFixed(2)} (mean abs), expected > ${MIN_DIFF}`);
    if (!(std > MIN_STD)) fails.push(`middle output frame is flat (std ${std.toFixed(2)})`);
    savePng(outFile, mid, pngOut);
  }
  return { o, diff, std, fails };
}

// --------------------------------------------------------------------- main
await mkdir(OUT, { recursive: true });
const server = await serve();
const url = `http://127.0.0.1:${server.address().port}/app/`;
const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
console.log(`serving ${ROOT} at ${url}${headed ? " (headed)" : ""}`);

const browser = await launchChrome({ headless: !headed });
if (!browser) {
  server.close();
  process.exit(1);
}
let failed = false;
const rows = [];
try {
  const page = await browser.newPage({ acceptDownloads: true });
  forwardConsole(page, stamp);
  await page.goto(url, { timeout: 30_000 });

  // A file that is not a video: expect an inline error, not a hang or a crash.
  await page.setInputFiles("#file", join(ROOT, "package.json"));
  await page.waitForFunction(() => ["ready", "error"].includes(document.body.dataset.state),
    null, { timeout: LOAD_TIMEOUT, polling: 100 });
  const bad = await page.evaluate(() => ({ state: document.body.dataset.state,
    msg: document.getElementById("error").textContent, disabled: document.getElementById("process").disabled }));
  console.log(`${stamp()} non-video file -> ${bad.state}: ${bad.msg}`);
  if (bad.state !== "error" || !bad.msg || !bad.disabled) {
    failed = true;
    console.log("  - FAIL: a non-video file should show an inline error and keep Process disabled");
  }

  for (const { clip, png } of CLIPS) {
    const srcFile = join(ROOT, "tests", "fixtures", `${clip}.mp4`);
    const src = { file: srcFile, ...probe(srcFile) };
    const outFile = join(OUT, `app-${clip}.mp4`);

    await page.setInputFiles("#file", srcFile);
    await page.waitForFunction(() => ["ready", "error"].includes(document.body.dataset.state),
      null, { timeout: LOAD_TIMEOUT, polling: 100 });
    let err = await page.evaluate(() => document.body.dataset.state === "error" && document.getElementById("error").textContent);
    if (err) throw new Error(`${clip}: the app rejected the file: ${err}`);
    console.log(`${stamp()} ${clip}: ${await page.textContent("#info")}`);

    const tClick = Date.now();
    await page.click("#process");
    await withTimeout(page.waitForFunction(() => ["done", "error"].includes(document.body.dataset.state),
      null, { timeout: 0, polling: 250 }), CLIP_TIMEOUT, `processing ${clip}`);
    const wall = (Date.now() - tClick) / 1000;
    err = await page.evaluate(() => document.body.dataset.state === "error" && document.getElementById("error").textContent);
    if (err) throw new Error(`${clip}: processing failed: ${err}`);
    console.log(`${stamp()} ${clip}: ${await page.textContent("#status")}`);

    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), page.click("#download")]);
    await download.saveAs(outFile);
    const name = download.suggestedFilename();

    // The preview element must be able to play the result.
    const playable = await page.evaluate(() => new Promise(resolve => {
      const v = document.getElementById("output");
      if (v.readyState >= 2) return resolve(true);
      v.addEventListener("loadeddata", () => resolve(true), { once: true });
      v.addEventListener("error", () => resolve(false), { once: true });
      setTimeout(() => resolve(false), 10_000);
    }));

    const r = check(src, outFile, join(OUT, png));
    if (name !== `${clip}-blobtrack.mp4`) r.fails.push(`download is named ${name}, expected ${clip}-blobtrack.mp4`);
    if (!playable) r.fails.push("the <video> preview did not load the result");
    const appFrames = Number(await page.evaluate(() => document.body.dataset.frames));
    if (appFrames !== src.frames) r.fails.push(`the app processed ${appFrames} frames, source has ${src.frames}`);
    rows.push({ clip, src, wall, name, png, ...r });
    if (r.fails.length) failed = true;
  }

  // OpenCV.js unavailable: the app must say so inline instead of hanging.
  const page2 = await browser.newPage();
  forwardConsole(page2, stamp);
  await page2.route(/opencv\.js$/, r => r.abort("connectionfailed"));
  await page2.goto(url, { timeout: 30_000 });
  await page2.setInputFiles("#file", join(ROOT, "tests", "fixtures", "pan.mp4"));
  await page2.waitForFunction(() => ["ready", "error"].includes(document.body.dataset.state),
    null, { timeout: LOAD_TIMEOUT, polling: 100 });
  await page2.click("#process");
  await withTimeout(page2.waitForFunction(() => ["done", "error"].includes(document.body.dataset.state),
    null, { timeout: 0, polling: 250 }), 60_000, "the OpenCV-failure case");
  const cvErr = await page2.evaluate(() => ({ state: document.body.dataset.state,
    msg: document.getElementById("error").textContent, disabled: document.getElementById("process").disabled }));
  console.log(`${stamp()} OpenCV blocked -> ${cvErr.state}: ${cvErr.msg}`);
  if (cvErr.state !== "error" || !/OpenCV/.test(cvErr.msg) || cvErr.disabled) {
    failed = true;
    console.log("  - FAIL: a failed OpenCV load should show an inline error and leave Process enabled to retry");
  }
} catch (e) {
  failed = true;
  console.error(`${stamp()} ERROR ${e.stack || e}`);
} finally {
  await browser.close();
  server.close();
}

console.log("\n==== app smoke: app/ in Chrome -> MP4 ====");
for (const { clip, src, o, wall, name, png, diff, std, fails } of rows) {
  console.log(`\n${clip}: ${fails.length ? "FAIL" : "PASS"}   (${name})`);
  console.log(`  video     ${o.vcodec} ${o.width}x${o.height}   source ${src.vcodec} ${src.width}x${src.height}`);
  console.log(`  fps       ${o.fps.toFixed(3)} (r ${o.rFps.toFixed(3)})   source ${src.fps.toFixed(3)}`);
  console.log(`  frames    ${o.frames}   source ${src.frames}`);
  console.log(`  duration  ${o.duration.toFixed(3)} s   source ${src.duration.toFixed(3)} s`);
  console.log(`  audio     ${o.acodec ?? "none"}   source ${src.acodec ?? "none"}${src.acodec ? "   (packets identical to the source)" : ""}`);
  console.log(`  mid frame mean abs diff ${diff.toFixed(2)} (> ${MIN_DIFF}), output std ${std.toFixed(1)}  -> tests/out/${png}`);
  console.log(`  wall      ${wall.toFixed(1)} s from Process to done, ${(wall * 1000 / src.frames).toFixed(0)} ms/frame`);
  for (const f of fails) console.log("  - " + f);
}
console.log(`\n${failed ? "FAIL" : "PASS"} in ${stamp()}`);
process.exit(failed ? 1 : 0);
