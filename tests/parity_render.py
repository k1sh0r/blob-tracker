#!/usr/bin/env python3
"""
Python half of the parity side-by-side (called by tests/parity.mjs).

    python tests/parity_render.py CLIP FRAME JS_PNG OUT_DIR

Runs a fresh blobtrack.BlobTracker over the clip's fixture PNGs with the
reference params, times every process() call, saves the Python render of
FRAME as OUT_DIR/CLIP-py.png and a labelled Python | JS image as
OUT_DIR/CLIP-py-vs-js.png. Prints one JSON line with the timings and paths.
"""
import json
import os
import sys
import time

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "skills", "blob-tracking", "scripts"))
import blobtrack  # noqa: E402


def main(clip, frame, js_png, out_dir):
    fx = os.path.join(HERE, "fixtures", clip)
    with open(os.path.join(fx, "reference.json")) as fh:
        ref = json.load(fh)
    bt = blobtrack.BlobTracker(ref["width"], ref["height"], **ref["params"])
    ms, shown = [], None
    for i in range(ref["frame_count"]):
        rgb = np.asarray(Image.open(os.path.join(fx, "frames", "%04d.png" % i)).convert("RGB"))
        t0 = time.perf_counter()
        out = bt.process(rgb)
        ms.append((time.perf_counter() - t0) * 1000)
        if i == frame:
            shown = out.copy()
    py_png = os.path.join(out_dir, "%s-py.png" % clip)
    Image.fromarray(shown).save(py_png)

    py_im, js_im = Image.fromarray(shown), Image.open(js_png).convert("RGB")
    W, H = py_im.size
    bar = 44
    sheet = Image.new("RGB", (2 * W + 16, H + bar), (17, 17, 17))
    sheet.paste(py_im, (0, bar))
    sheet.paste(js_im, (W + 16, bar))
    d = ImageDraw.Draw(sheet)
    font = ImageFont.truetype(blobtrack.FONT, 26)
    d.text((8, 8), "PYTHON  blobtrack.py  frame %d" % frame, font=font, fill=(255, 255, 255))
    d.text((W + 24, 8), "JS  blobtrack.js (OpenCV.js)  frame %d" % frame, font=font, fill=(255, 255, 255))
    scale = min(1.0, 2400 / sheet.width)
    if scale < 1:
        sheet = sheet.resize((int(sheet.width * scale), int(sheet.height * scale)), Image.LANCZOS)
    side = os.path.join(out_dir, "%s-py-vs-js.png" % clip)
    sheet.save(side)
    print(json.dumps({"pyMsMean": sum(ms) / len(ms), "pyMsMedian": sorted(ms)[len(ms) // 2],
                      "pyPng": py_png, "sideBySide": side}))


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4])
