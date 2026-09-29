// Blob Tracker web app: pick a video, run the blob-tracking effect on every
// frame in the browser, preview the result and download it as MP4.
//
// Pipeline: Mediabunny `Conversion` (input file -> MP4, H.264 via WebCodecs).
// Its `video.process` hook draws each decoded frame into a canvas, reads it
// back as ImageData and hands it to `BlobTracker.process`, which draws the
// treated frame into a second canvas; that canvas becomes the output frame.
// Audio is copied through untouched (Mediabunny re-encodes only if the source
// codec cannot go into MP4). Frame rate and frame count follow the input: no
// `frameRate` option is set, so every decoded frame is encoded once with its
// own timestamp and duration.
//
// Verified against the Mediabunny 1.60.0 source (src/conversion.ts,
// src/media-source.ts, src/media-sink.ts), not assumed:
//   * Ordering. The transcode path runs one pump per video track:
//       for await (sample of new VideoSampleSink(track).samples(...))
//         await source.add(sample)
//     `samples()` yields in presentation order (the sink reorders decoder
//     output), and `add()` awaits `processAndEncode`, which calls `process`
//     and awaits its result before returning. So `process` is never called
//     concurrently or out of order for one track. `tracks: "primary"` keeps it
//     to one video track, i.e. one tracker. The guard in `process` below still
//     checks that timestamps strictly increase, so a future change would fail
//     loudly instead of silently corrupting the tracker's state.
//   * Canvas reuse. Returning a bare canvas would also be safe today: the
//     returned CanvasImageSource is wrapped with `new VideoSample(canvas, ...)`,
//     which in Chrome is `new VideoFrame(canvas)` (a snapshot), synchronously,
//     before `add()` resolves and the pump fetches the next frame. We do not
//     lean on that internal detail: `process` snapshots the canvas itself into
//     a fresh VideoSample with the source sample's timestamp and duration.
//     Mediabunny closes returned samples after encoding (processAndEncode's
//     `finally`), so nothing leaks.
//   * Rotation. With a `process` hook and rotation metadata, Mediabunny bakes
//     the rotation into the frames it hands to `process` (needsRerender) and
//     writes rotation 0; without rotation the decoded frame is passed as is.
//     Either way `sample.displayWidth/Height` is the upright size, so the
//     tracker is sized from the first sample and every sample is checked
//     against it.

import { loadOpenCV, BlobTracker, MIN_SIDE } from "../skills/blob-tracking/scripts/blobtrack.js";

const MEDIABUNNY_URL = "https://cdn.jsdelivr.net/npm/mediabunny@1.60.0/dist/bundles/mediabunny.min.mjs";

const $ = id => document.getElementById(id);
const ui = {
  drop: $("drop"), file: $("file"), info: $("info"), process: $("process"),
  progressBox: $("progress-box"), progress: $("progress"), status: $("status"),
  error: $("error"), result: $("result"), output: $("output"), download: $("download"),
};

let mb = null;            // the Mediabunny module
let current = null;       // { file, W, H, frames, fps, duration, audio } of the chosen file
let resultUrl = null;     // object URL of the last output
let busy = false;         // a conversion is running
let probeToken = 0;       // ignores stale probes when files are picked quickly

function setState(state) { document.body.dataset.state = state; }

function showError(message) {
  ui.error.textContent = message;
  ui.error.hidden = false;
  setState("error");
}

function clearError() {
  ui.error.hidden = true;
  ui.error.textContent = "";
}

function clearResult() {
  ui.result.hidden = true;
  ui.output.removeAttribute("src");
  ui.output.load();
  ui.download.removeAttribute("href");
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = null;
  delete document.body.dataset.frames;
}

function fmtTime(s) {
  if (!Number.isFinite(s)) return "--";
  const m = Math.floor(s / 60);
  return m ? `${m}:${(s % 60).toFixed(0).padStart(2, "0")}` : `${s.toFixed(1)} s`;
}

// ------------------------------------------------------------------ startup
async function loadMediabunny() {
  if (!mb) mb = await import(MEDIABUNNY_URL);
  return mb;
}

// Start both downloads early; failures are reported when they matter.
loadMediabunny().catch(() => {});
loadOpenCV().catch(() => {});

function webCodecsProblem() {
  if (typeof VideoDecoder === "undefined" || typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined")
    return "This browser does not support WebCodecs, which the app needs to decode and encode video. " +
      "Use a current Chrome, Edge or Safari.";
  if (typeof OffscreenCanvas === "undefined")
    return "This browser does not support OffscreenCanvas. Use a current Chrome, Edge or Safari.";
  return null;
}

// -------------------------------------------------------------- file choice
async function chooseFile(file) {
  if (busy || !file) return;
  const token = ++probeToken;
  clearError();
  clearResult();
  ui.progressBox.hidden = true;
  ui.process.disabled = true;
  current = null;
  ui.info.hidden = false;
  ui.info.textContent = `${file.name} — reading…`;
  setState("probing");

  const problem = webCodecsProblem();
  if (problem) return showError(problem);

  let m;
  try {
    m = await loadMediabunny();
  } catch (e) {
    return showError(`Could not load the Mediabunny library from ${MEDIABUNNY_URL}: ${e.message}`);
  }

  let input;
  try {
    input = new m.Input({ source: new m.BlobSource(file), formats: m.ALL_FORMATS });
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error(`${file.name} has no video track.`);
    if (!(await video.canDecode()))
      throw new Error(`This browser cannot decode the video in ${file.name} (codec: ${await video.getCodec() ?? "unknown"}).`);
    const W = await video.getDisplayWidth(), H = await video.getDisplayHeight();
    const duration = await input.computeDuration();
    const stats = await video.computePacketStats();
    const audioTrack = await input.getPrimaryAudioTrack();
    const audio = audioTrack ? (await audioTrack.getCodec()) ?? "unknown codec" : null;
    if (token !== probeToken) return;

    const info = { file, W, H, frames: stats.packetCount, fps: stats.averagePacketRate, duration, audio };
    ui.info.textContent = `${file.name} — ${W}×${H} — ${fmtTime(duration)} — ${info.frames} frames at ` +
      `${Number(info.fps.toFixed(2))} fps — ${audio ? "audio: " + audio : "no audio"}`;

    if (Math.min(W, H) < MIN_SIDE)
      return showError(`The video is ${W}×${H}; blob tracking needs at least ${MIN_SIDE} px on each side.`);
    const canEncode = await m.canEncodeVideo("avc", { width: W, height: H });
    if (token !== probeToken) return;
    if (!canEncode)
      return showError(`This browser has no H.264 encoder for ${W}×${H} video (WebCodecs reports "avc" as ` +
        "unsupported), so the result cannot be written as MP4. Try a current Chrome, Edge or Safari.");

    current = info;
    ui.process.disabled = false;
    setState("ready");
  } catch (e) {
    if (token !== probeToken) return;
    const unsupported = m && e instanceof m.UnsupportedInputFormatError;
    showError(unsupported
      ? `${file.name} is not a video format this app can read (MP4, MOV, WebM, MKV and similar are supported).`
      : `Could not read ${file.name}: ${e.message}`);
  } finally {
    input?.dispose();
  }
}

ui.file.addEventListener("change", () => chooseFile(ui.file.files[0]));
ui.drop.addEventListener("dragover", e => { e.preventDefault(); ui.drop.classList.add("over"); });
ui.drop.addEventListener("dragleave", () => ui.drop.classList.remove("over"));
ui.drop.addEventListener("drop", e => {
  e.preventDefault();
  ui.drop.classList.remove("over");
  chooseFile(e.dataTransfer.files[0]);
});

// ----------------------------------------------------------------- process
async function run() {
  if (busy || !current) return;
  const job = current;
  busy = true;
  ui.process.disabled = true;
  ui.file.disabled = true;
  clearError();
  clearResult();
  ui.progressBox.hidden = false;
  ui.progress.value = 0;
  ui.status.textContent = "Loading OpenCV…";
  setState("processing");

  let input = null, tracker = null, done = 0, stage = "load", tStart = 0;
  try {
    try {
      await loadOpenCV();
    } catch (e) {
      throw Object.assign(new Error(`Could not load OpenCV.js: ${e.message}`), { reported: true });
    }
    stage = "convert";

    input = new mb.Input({ source: new mb.BlobSource(job.file), formats: mb.ALL_FORMATS });
    const output = new mb.Output({
      format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }),
      target: new mb.BufferTarget(),
    });

    let W = 0, H = 0, srcCtx = null, outCanvas = null, outCtx = null, lastTs = -Infinity;
    tStart = performance.now();         // after OpenCV has loaded: times the conversion itself

    const process = sample => {
      if (!tracker) {                           // sized from the first (upright) frame
        W = sample.displayWidth;
        H = sample.displayHeight;
        tracker = new BlobTracker(W, H);
        srcCtx = new OffscreenCanvas(W, H).getContext("2d", { willReadFrequently: true });
        outCanvas = new OffscreenCanvas(W, H);
        outCtx = outCanvas.getContext("2d");
      }
      if (sample.displayWidth !== W || sample.displayHeight !== H)
        throw new Error(`frame ${done + 1} is ${sample.displayWidth}×${sample.displayHeight}, ` +
          `the video started at ${W}×${H}; videos that change size mid-stream are not supported`);
      if (!(sample.timestamp > lastTs))
        throw new Error(`frames arrived out of order (${sample.timestamp} s after ${lastTs} s); ` +
          "the tracker needs them in presentation order");
      lastTs = sample.timestamp;

      sample.draw(srcCtx, 0, 0, W, H);
      tracker.process(srcCtx.getImageData(0, 0, W, H), outCtx);
      // Snapshot now (VideoFrame from canvas), so the next frame can reuse outCanvas.
      const out = new mb.VideoSample(outCanvas, { timestamp: sample.timestamp, duration: sample.duration });

      done++;
      const elapsed = (performance.now() - tStart) / 1000;
      const total = Math.max(job.frames, done);
      ui.progress.value = done / total;
      ui.status.textContent = `${done} / ${total} frames — ${fmtTime(elapsed)} elapsed — ` +
        `about ${fmtTime(elapsed / done * (total - done))} left`;
      return out;
    };

    const conversion = await mb.Conversion.init({
      input, output,
      tracks: "primary",
      video: { codec: "avc", forceTranscode: true, process },
      showWarnings: false,
    });
    if (!conversion.isValid) {
      const why = conversion.discardedTracks.map(d => `${d.track.type} track: ${d.reason}`).join("; ");
      throw Object.assign(new Error(`This video cannot be converted here (${why}).`), { reported: true });
    }
    const lostAudio = conversion.discardedTracks.filter(d => d.track.type === "audio");

    ui.status.textContent = `0 / ${job.frames} frames`;
    await conversion.execute();

    const blob = new Blob([output.target.buffer], { type: "video/mp4" });
    resultUrl = URL.createObjectURL(blob);
    ui.output.src = resultUrl;
    ui.download.href = resultUrl;
    ui.download.download = `${job.file.name.replace(/\.[^.]+$/, "") || "video"}-blobtrack.mp4`;
    ui.result.hidden = false;
    const secs = (performance.now() - tStart) / 1000;
    ui.progress.value = 1;
    ui.status.textContent = `Done: ${done} frames in ${fmtTime(secs)} (${(secs * 1000 / done).toFixed(0)} ms/frame)` +
      (lostAudio.length ? ` — the audio could not be kept (${lostAudio.map(d => d.reason).join(", ")})` : "");
    document.body.dataset.frames = String(done);
    setState("done");
  } catch (e) {
    console.error(e);
    showError(e.reported ? e.message
      : stage === "load" ? `Could not start: ${e.message}`
      : `Processing failed after ${done} of ${job.frames} frames: ${e.message}`);
  } finally {
    tracker?.dispose();
    input?.dispose();
    busy = false;
    ui.file.disabled = false;
    ui.process.disabled = !current;
  }
}

ui.process.addEventListener("click", run);
