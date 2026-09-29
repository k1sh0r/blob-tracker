#!/usr/bin/env python3
"""
Generate the synthetic, licence-free test clips and their reference detections.

    python tests/make_fixtures.py

Two clips, both 30 fps and 2 s (60 frames):

  shapes   1080x1920  bright and dark shapes moving over a noise field, with a
                      440 Hz sine audio track (exercises the audio-copy path)
  pan      1920x1080  a tiled, windowed scene with drawn text, panning left to
                      right, no audio

For each clip this writes, under tests/fixtures/:

  <clip>/frames/NNNN.png     the generated frames: the input of record
  <clip>.mp4                 the same frames encoded (H.264 yuv420p, BT.709)
  <clip>/reference.json      Python reference tracks and corner points, per
                             frame, for the PNG frames

The PNGs, not the MP4, are what the reference detections were computed on.
Decoding H.264 to RGB is not bit-identical across ffmpeg builds or browsers;
decoding PNG is. Any other implementation (tests/parity.mjs) must read the PNGs
in order, frame 0 first, into a fresh tracker with the params in the JSON.
The noise is blocky rather than smooth because smooth noise does not compress
in PNG, and the frames have to stay small enough to commit.
"""
import argparse
import json
import os
import subprocess
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")
SCRIPTS = os.path.join(HERE, "..", "skills", "blob-tracking", "scripts")
sys.path.insert(0, SCRIPTS)
import blobtrack  # noqa: E402

FPS = 30
N = 60

# --------------------------------------------------------------------- shapes
# (shape, grey value, cx0, cy0, vx, vy, w, h) — velocities in px/s at 1080x1920.
SHAPES = [
    ("ellipse", 245, 220, 300, 160, 90, 180, 180),
    ("rect", 18, 760, 420, -140, 60, 240, 150),
    ("rect", 238, 540, 1000, 0, -220, 360, 260),
    ("ellipse", 12, 300, 1450, 200, -40, 220, 300),
    ("rect", 250, 850, 1600, -120, -150, 90, 90),
    ("ellipse", 22, 820, 900, -60, 180, 110, 110),
    ("rect", 230, 150, 700, 90, 240, 60, 140),
    ("ellipse", 240, 600, 250, -30, 110, 70, 70),
]


def shape_boxes(t):
    """Ground-truth (x, y, w, h) of every clip-a shape at time t, 1080x1920 px."""
    out = []
    for _, _, cx, cy, vx, vy, w, h in SHAPES:
        x = cx + vx * t - w / 2
        y = cy + vy * t - h / 2
        out.append((x, y, float(w), float(h)))
    return out


def frame_shapes(i, tiles):
    W, H = 1080, 1920
    t = i / FPS
    # noise: coarse 40 px tiles drifting 2 px/frame, plus per-frame 8 px grain
    img = cv2.resize(tiles, (W, H), interpolation=cv2.INTER_NEAREST)
    img = np.roll(img, int(i * 2), axis=1).astype(np.float32)
    grain = np.random.default_rng(1000 + i).integers(-7, 8, (H // 8, W // 8)).astype(np.float32)
    img += cv2.resize(grain, (W, H), interpolation=cv2.INTER_NEAREST)
    for (kind, val, *_), (x, y, w, h) in zip(SHAPES, shape_boxes(t)):
        x0, y0, x1, y1 = int(round(x)), int(round(y)), int(round(x + w)), int(round(y + h))
        if kind == "rect":
            cv2.rectangle(img, (x0, y0), (x1 - 1, y1 - 1), float(val), -1)
        else:
            cv2.ellipse(img, (((x0 + x1) / 2, (y0 + y1) / 2), (x1 - x0, y1 - y0), 0), float(val), -1)
    g = np.clip(img, 0, 255).astype(np.uint8)
    rgb = np.stack([g, g, g], -1)
    # a little colour so the grey conversion is exercised
    rgb[..., 0] = np.clip(g.astype(np.int16) + 10, 0, 255)
    rgb[..., 2] = np.clip(g.astype(np.int16) - 10, 0, 255)
    return rgb


# ------------------------------------------------------------------------ pan
def pan_scene():
    W, H = 3000, 1080
    rng = np.random.default_rng(7)
    base = cv2.resize(rng.uniform(40, 120, (H // 60, W // 60)).astype(np.float32), (W, H),
                      interpolation=cv2.INTER_NEAREST)
    rgb = np.stack([base * 0.8, base * 0.9, base * 1.1], -1)
    rgb = np.clip(rgb, 0, 255).astype(np.uint8)
    im = Image.fromarray(rgb)
    d = ImageDraw.Draw(im)
    # "buildings": blocks with lit windows
    for bx in range(80, W - 200, 260):
        bw = int(rng.integers(140, 230))
        bh = int(rng.integers(300, 820))
        top = H - bh
        d.rectangle([bx, top, bx + bw, H], fill=(28, 30, 38))
        for wy in range(top + 30, H - 40, 70):
            for wx in range(bx + 20, bx + bw - 40, 50):
                if rng.random() < 0.45:
                    d.rectangle([wx, wy, wx + 26, wy + 38], fill=(250, 232, 180))
    # a stripe band and checker patch for texture
    for sx in range(0, W, 40):
        d.rectangle([sx, 60, sx + 18, 120], fill=(210, 210, 215))
    for cy in range(4):
        for cx in range(12):
            if (cx + cy) % 2 == 0:
                d.rectangle([1400 + cx * 30, 180 + cy * 30, 1430 + cx * 30, 210 + cy * 30], fill=(235, 235, 235))
    font = ImageFont.truetype(blobtrack.FONT, 72)
    small = ImageFont.truetype(blobtrack.FONT, 36)
    d.text((200, 200), "BLOB TRACKER", font=font, fill=(255, 255, 255))
    d.text((1900, 260), "SYNTHETIC FIXTURE 02", font=small, fill=(240, 240, 240))
    d.text((900, 420), "0123456789", font=font, fill=(10, 10, 10))
    return np.asarray(im)


def frame_pan(i, scene):
    x = int(round(i * 500 / FPS))          # 500 px/s
    return np.ascontiguousarray(scene[:, x:x + 1920])


# --------------------------------------------------------------------- encode
def encode(path, frames_iter, w, h, audio):
    cmd = ["ffmpeg", "-y", "-v", "error",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (w, h), "-r", str(FPS), "-i", "-"]
    if audio:
        cmd += ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=%g" % (N / FPS)]
    cmd += ["-map", "0:v"] + (["-map", "1:a"] if audio else [])
    cmd += ["-vf", "scale=out_color_matrix=bt709:out_range=tv",
            "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
            "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
            "-threads", "1", "-movflags", "+faststart"]
    if audio:
        cmd += ["-c:a", "aac", "-b:a", "128k"]
    cmd += [path]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for f in frames_iter:
        p.stdin.write(np.ascontiguousarray(f, np.uint8).tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise SystemExit("ffmpeg failed encoding %s" % path)


def clip_frames(clip):
    if clip == "shapes":
        tiles = np.random.default_rng(3).uniform(92, 128, (1920 // 40, 1080 // 40)).astype(np.float32)
        return (frame_shapes(i, tiles) for i in range(N)), 1080, 1920, True
    scene = pan_scene()
    return (frame_pan(i, scene) for i in range(N)), 1920, 1080, False


def write_frames(clip):
    fdir = os.path.join(FIXTURES, clip, "frames")
    os.makedirs(fdir, exist_ok=True)
    for n in os.listdir(fdir):
        os.remove(os.path.join(fdir, n))
    frames, w, h, audio = clip_frames(clip)
    for i, f in enumerate(frames):
        Image.fromarray(f).save(os.path.join(fdir, "%04d.png" % i), compress_level=9)
    return w, h, audio


# ------------------------------------------------------------------ reference
def load_frames(clip):
    d = os.path.join(FIXTURES, clip, "frames")
    names = sorted(n for n in os.listdir(d) if n.endswith(".png"))
    return [np.asarray(Image.open(os.path.join(d, n)).convert("RGB")) for n in names]


def track_frames(frames, params=None):
    """Run a fresh BlobTracker over frames; return per-frame tracks and points."""
    h, w = frames[0].shape[:2]
    bt = blobtrack.BlobTracker(w, h, **(params or {}))
    tracks, points = [], []
    for f in frames:
        bt.process(f)
        tracks.append([{k: t[k] for k in ("id", "x", "y", "w", "h", "kind", "a")} for t in bt.last_tracks])
        points.append([[float(x), float(y)] for x, y in bt.last_points])
    return tracks, points


def make_reference(clip, w, h):
    frames = load_frames(clip)
    tracks, points = track_frames(frames)
    ref = {
        "clip": clip,
        "width": w,
        "height": h,
        "fps": FPS,
        "frame_count": len(frames),
        "frames_dir": "%s/frames" % clip,
        "params": dict(blobtrack.DEFAULTS),
        "opencv": cv2.__version__,
        "tracks": tracks,     # per frame: [{id, x, y, w, h, kind, a}, ...]
        "points": points,     # per frame: [[x, y], ...] optical-flow corners
    }
    with open(os.path.join(FIXTURES, clip, "reference.json"), "w") as fh:
        json.dump(ref, fh, separators=(",", ":"))
    return ref


def main():
    argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter).parse_args()
    for clip in ("shapes", "pan"):
        w, h, audio = write_frames(clip)
        encode(os.path.join(FIXTURES, clip + ".mp4"), load_frames(clip), w, h, audio)
        ref = make_reference(clip, w, h)
        print("%s: %d frames, %d tracks on the last frame" % (clip, ref["frame_count"], len(ref["tracks"][-1])))


if __name__ == "__main__":
    main()
