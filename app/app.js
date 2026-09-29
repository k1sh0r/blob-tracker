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
//
// Output storage. The MP4 is written through a Mediabunny `StreamTarget` into a
// file in the origin-private file system (OPFS): StreamTarget writes
// `{type: "write", data, position}` chunks, which is exactly what a
// FileSystemWritableFileStream accepts, and closes the stream on finalize
// (commit) or cancel. `fastStart: false` puts the moov box at the end, so the
// muxer never holds the whole file in RAM; with `chunked: true` it buffers at
// most a few 16 MiB chunks. The committed OPFS `File` backs both the preview's
// object URL and the download, so a long clip costs disk space, not memory.
// Without OPFS writable streams (older Safari) it falls back to a BufferTarget
// (whole file in RAM, plus one copy into a Blob) and warns when the estimated
// output is large. Each run's OPFS file is removed when the next run starts
// or another file is chosen; files left over by a closed tab are removed on
// load once they are a day old (younger ones may belong to another open tab).

import { loadOpenCV, BlobTracker, MIN_SIDE } from "../skills/blob-tracking/scripts/blobtrack.js";

const MEDIABUNNY_URL = "https://cdn.jsdelivr.net/npm/mediabunny@1.60.0/dist/bundles/mediabunny.min.mjs";
const OPFS_PREFIX = "blobtrack-";        // our output files in OPFS
const STALE_MS = 24 * 3600 * 1000;       // leftovers older than this are removed on load
const WARN_BYTES = 1e9;                  // in-memory fallback: warn above ~1 GB of output
// ?target=memory forces the in-memory fallback (used by tests/app-smoke.mjs).
const FORCE_MEMORY = new URLSearchParams(location.search).get("target") === "memory";

const $ = id => document.getElementById(id);
const ui = {
  drop: $("drop"), file: $("file"), info: $("info"), process: $("process"),
  progressBox: $("progress-box"), progress: $("progress"), status: $("status"),
  error: $("error"), warning: $("warning"), result: $("result"), output: $("output"),
  download: $("download"), announce: $("announce"),
};

let mb = null;            // the Mediabunny module
let current = null;       // { file, W, H, frames, fps, duration, audio } of the chosen file
let resultUrl = null;     // object URL of the last output
let outName = null;       // OPFS file name of the last output
let busy = false;         // a conversion is running
let probeToken = 0;       // ignores stale probes when files are picked quickly

function setState(state) { document.body.dataset.state = state; }

// Screen readers hear only outcomes (done, failed), not the per-frame status.
function announce(text) { ui.announce.textContent = text; }

function showError(message) {
  ui.error.textContent = message;
  ui.error.hidden = false;
  announce(message);
  setState("error");
}

function clearError() {
  ui.error.hidden = true;
  ui.error.textContent = "";
  ui.warning.hidden = true;
  ui.warning.textContent = "";
}

function showWarning(message) {
  ui.warning.textContent = message;
  ui.warning.hidden = false;
}

async function clearResult() {
  ui.result.hidden = true;
  ui.output.removeAttribute("src");
  ui.output.load();
  ui.download.removeAttribute("href");
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = null;
  delete document.body.dataset.frames;
  if (outName) await removeOpfsFile(outName);
  outName = null;
}

function fmtTime(s) {
  if (!Number.isFinite(s)) return "--";
  if (s < 60) return `${s.toFixed(1)} s`;
  const r = Math.round(s);
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")}`;
}

// --------------------------------------------------------------- OPFS output
function opfsSupported() {
  return !FORCE_MEMORY && typeof navigator.storage?.getDirectory === "function"
    && typeof FileSystemFileHandle !== "undefined" && "createWritable" in FileSystemFileHandle.prototype;
}

async function removeOpfsFile(name) {
  try {
    await (await navigator.storage.getDirectory()).removeEntry(name);
  } catch (e) {
    if (e.name !== "NotFoundError") console.warn(`could not remove OPFS file ${name}:`, e);
  }
}

async function removeStaleOutputs() {
  if (!opfsSupported()) return;
  try {
    const dir = await navigator.storage.getDirectory();
    for await (const [name, handle] of dir.entries()) {
      if (!name.startsWith(OPFS_PREFIX) || handle.kind !== "file") continue;
      const file = await handle.getFile().catch(() => null);
      if (file && Date.now() - file.lastModified > STALE_MS) await removeOpfsFile(name);
    }
  } catch (e) {
    console.warn("could not clean up old OPFS outputs:", e);
  }
}

/** A fresh OPFS file with an open writable stream, or null when OPFS is unusable. */
async function openOpfsOutput() {
  if (!opfsSupported()) return null;
  const name = `${OPFS_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
  try {
    const dir = await navigator.storage.getDirectory();
    const handle = await dir.getFileHandle(name, { create: true });
    return { name, handle, writable: await handle.createWritable() };
  } catch (e) {
    console.warn("OPFS unavailable, keeping the output in memory:", e);
    await removeOpfsFile(name);
    return null;
  }
}

/**
 * Rough output size in bytes: Mediabunny 1.60.0's bitrate for Quality "high"
 * (src/encode.ts computeVideoBitrate: 3 Mbps at 1920x1080, scaled by
 * pixels^0.95, times the "high" factor 0.3 * e^(2.5538 * 0.75)) plus the
 * copied audio, over the clip's duration.
 */
function estimateBytes(job) {
  const video = 3e6 * Math.pow(job.W * job.H / (1920 * 1080), 0.95) * 0.3 * Math.exp(2.5538 * 0.75);
  return (video + (job.audioBitrate || 0)) * job.duration / 8;
}

function memoryWarning(job) {
  const bytes = estimateBytes(job);
  return bytes > WARN_BYTES
    ? `This browser cannot write the result to disk storage, so the whole output (about ` +
      `${(bytes / 1e9).toFixed(1)} GB) will be held in memory; the tab may run out of memory and crash. ` +
      "A shorter or smaller clip, or a current Chrome or Edge, avoids this."
    : null;
}

// ------------------------------------------------------------------ startup
async function loadMediabunny() {
  if (!mb) mb = await import(MEDIABUNNY_URL);
  return mb;
}

// Start both downloads early; failures are reported when they matter.
loadMediabunny().catch(() => {});
loadOpenCV().catch(() => {});
removeStaleOutputs();

addEventListener("beforeunload", e => {
  if (busy) e.preventDefault();          // ask before throwing away a running job
});

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
  await clearResult();
  ui.progressBox.hidden = true;
  ui.process.disabled = true;
  current = null;
  ui.info.hidden = false;
  ui.info.textContent = `${file.name} — reading…`;
  setState("probing");

  const problem = webCodecsProblem();
  if (problem) {
    ui.info.textContent = file.name;
    return showError(problem);
  }

  let m;
  try {
    m = await loadMediabunny();
  } catch (e) {
    ui.info.textContent = file.name;
    return showError(`Could not load the Mediabunny library from ${MEDIABUNNY_URL} (${e.message}). ` +
      "Check your connection and reload the page.");
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
    const audioBitrate = audioTrack ? await audioTrack.getBitrate() : 0;
    if (token !== probeToken) return;

    const info = { file, W, H, frames: stats.packetCount, fps: stats.averagePacketRate, duration, audio, audioBitrate };
    ui.info.textContent = `${file.name} — ${W}×${H} — ${fmtTime(duration)} — ${info.frames} frames at ` +
      `${Number(info.fps.toFixed(2))} fps — ${audio ? "audio: " + audio : "no audio"}`;

    if (Math.min(W, H) < MIN_SIDE)
      return showError(`The video is ${W}×${H}; blob tracking needs at least ${MIN_SIDE} px on each side.`);
    const canEncode = await m.canEncodeVideo("avc", { width: W, height: H });
    if (token !== probeToken) return;
    if (!canEncode)
      return showError(`This browser has no H.264 encoder for ${W}×${H} video (WebCodecs reports "avc" as ` +
        "unsupported), so the result cannot be written as MP4. Try a current Chrome, Edge or Safari.");

    if (!info.frames) return showError(`${file.name} has a video track with no frames.`);

    current = info;
    ui.process.disabled = false;
    if (!opfsSupported()) {
      const warning = memoryWarning(info);
      if (warning) showWarning(warning);
    }
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
  announce("");
  await clearResult();
  ui.progressBox.hidden = false;
  ui.progress.value = 0;
  ui.status.textContent = "Loading OpenCV…";
  setState("processing");

  let input = null, tracker = null, opfs = null, output = null, done = 0, stage = "load", tStart = 0;
  try {
    try {
      await loadOpenCV();
    } catch (e) {
      throw Object.assign(new Error(`Could not load OpenCV.js: ${e.message}`), { reported: true });
    }
    stage = "convert";

    input = new mb.Input({ source: new mb.BlobSource(job.file), formats: mb.ALL_FORMATS });
    opfs = await openOpfsOutput();
    if (!opfs) {
      const warning = memoryWarning(job);
      if (warning) showWarning(warning);
    }
    output = new mb.Output({
      format: new mb.Mp4OutputFormat({ fastStart: false }),   // moov at the end: nothing held back in RAM
      target: opfs ? new mb.StreamTarget(opfs.writable, { chunked: true }) : new mb.BufferTarget(),
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
        throw new Error(`the source file has a repeated or out-of-order frame timestamp ` +
          `(${sample.timestamp} s after ${lastTs} s), and the tracker needs frames in presentation order. ` +
          "Re-muxing it often fixes this, e.g. ffmpeg -i in.mp4 -c copy out.mp4");
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
    if (done === 0) throw new Error("no video frames were decoded from this file");

    // execute() finalized the output, which closed (committed) the OPFS stream.
    const result = opfs ? await opfs.handle.getFile() : new Blob([output.target.buffer], { type: "video/mp4" });
    output = null;                                   // drop the in-memory buffer (fallback) now
    if (opfs) outName = opfs.name;
    resultUrl = URL.createObjectURL(result);
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
    announce(`Done: ${done} frames processed. The result is ready to play or download.`);
    ui.download.focus();
  } catch (e) {
    console.error(e);
    showError(e.reported ? e.message
      : stage === "load" ? `Could not start: ${e.message}`
      : `Processing failed after ${done} of ${job.frames} frames: ${e.message}`);
    if (opfs) {
      // A failed Conversion.execute cancels the output, which closes the stream; if we never got that far,
      // the stream is still open and must be aborted before the file can be removed.
      if (output && output.state !== "canceled" && output.state !== "finalized") await output.cancel().catch(() => {});
      await opfs.writable.abort().catch(() => {});
      await removeOpfsFile(opfs.name);
    }
  } finally {
    tracker?.dispose();
    input?.dispose();
    busy = false;
    ui.file.disabled = false;
    ui.process.disabled = !current;
  }
}

ui.process.addEventListener("click", run);
