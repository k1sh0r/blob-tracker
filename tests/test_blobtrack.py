"""
pytest suite for skills/blob-tracking/scripts/blobtrack.py (spec §8).

Fixtures are committed under tests/fixtures/; regenerate them with
`python tests/make_fixtures.py` (the suite does so automatically if missing).
"""
import importlib.util
import json
import os
import subprocess
import sys

import cv2
import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")
SCRIPT = os.path.join(HERE, "..", "skills", "blob-tracking", "scripts", "blobtrack.py")
sys.path.insert(0, HERE)
import make_fixtures as mf  # noqa: E402  (also puts blobtrack on sys.path)
import blobtrack  # noqa: E402

# The golden test compares against the original teaser tool, which is not part
# of this repo: point BLOBTRACK_TEASER_DIR at the directory holding that
# blobtrack.py (its fonts/ directory is expected beside it, one level up).
TEASER_DIR = os.environ.get("BLOBTRACK_TEASER_DIR")
TEASER_TOOL = os.path.join(TEASER_DIR, "blobtrack.py") if TEASER_DIR else None
TEASER_FONT = os.path.join(TEASER_DIR, "..", "fonts", "JetBrainsMono.ttf") if TEASER_DIR else None

FFMPEG = blobtrack.ffmpeg_version()


def reference(clip):
    with open(os.path.join(FIX, clip, "reference.json")) as fh:
        return json.load(fh)


def skip_unless_reference_opencv():
    want = reference("shapes")["opencv"]
    if cv2.__version__ != want:
        pytest.skip("reference detections were made with OpenCV %s, this is %s; "
                    "install tests/requirements-dev.txt for exact comparisons" % (want, cv2.__version__))


@pytest.fixture(scope="session", autouse=True)
def fixtures_present():
    """Make sure the committed fixtures exist.

    If any are missing this regenerates them by running make_fixtures.py,
    which writes into the source tree (tests/fixtures/), not a temp dir.
    """
    need = [os.path.join(FIX, c, "reference.json") for c in ("shapes", "pan")]
    if not all(os.path.exists(p) for p in need):
        subprocess.run([sys.executable, os.path.join(HERE, "make_fixtures.py")], check=True)


@pytest.fixture(scope="session")
def shapes_frames():
    return mf.load_frames("shapes")


@pytest.fixture(scope="session")
def pan_frames():
    return mf.load_frames("pan")


def ffprobe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-show_streams", "-show_format",
                          "-of", "json", path], capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    v = [s for s in j["streams"] if s["codec_type"] == "video"]
    a = [s for s in j["streams"] if s["codec_type"] == "audio"]
    return v[0], a, float(j["format"]["duration"])


def run_cli(*args):
    return subprocess.run([sys.executable, SCRIPT, *args], capture_output=True, text=True)


# ------------------------------------------------------------------------ CLI
def test_cli_preserves_frames_fps_duration_and_audio(tmp_path):
    src = os.path.join(FIX, "shapes.mp4")
    dst = str(tmp_path / "out.mp4")
    r = run_cli(src, "-o", dst)
    assert r.returncode == 0, r.stderr
    vi, ai, di = ffprobe(src)
    vo, ao, do = ffprobe(dst)
    assert int(vo["nb_read_frames"]) == int(vi["nb_read_frames"]) == 60
    assert vo["r_frame_rate"] == vi["r_frame_rate"] == "30/1"
    assert (vo["width"], vo["height"]) == (1080, 1920)
    assert vo["codec_name"] == "h264" and vo["pix_fmt"] == "yuv420p"
    assert (vo.get("color_space"), vo.get("color_primaries"), vo.get("color_transfer"), vo.get("color_range")) \
        == ("bt709", "bt709", "bt709", "tv")
    assert abs(do - di) < 0.1, (do, di)
    assert len(ai) == 1 and len(ao) == 1
    assert ao[0]["codec_name"] == ai[0]["codec_name"] == "aac"      # copied, not dropped


def test_cli_no_audio_start_and_duration(tmp_path):
    dst = str(tmp_path / "out.mp4")
    r = run_cli(os.path.join(FIX, "shapes.mp4"), "-o", dst, "--start", "1", "--duration", "0.5", "--no-audio")
    assert r.returncode == 0, r.stderr
    vo, ao, do = ffprobe(dst)
    assert int(vo["nb_read_frames"]) == 15
    assert ao == []
    assert abs(do - 0.5) < 0.05


def test_cli_landscape_input_without_audio(tmp_path):
    dst = str(tmp_path / "out.mp4")
    r = run_cli(os.path.join(FIX, "pan.mp4"), "-o", dst, "--duration", "0.4", "--large", "3", "--screen", "0.9")
    assert r.returncode == 0, r.stderr
    vo, ao, _ = ffprobe(dst)
    assert (vo["width"], vo["height"]) == (1920, 1080)
    assert int(vo["nb_read_frames"]) == 12
    assert ao == []


@pytest.mark.skipif(FFMPEG is not None and FFMPEG < (6, 0),
                    reason="building the rotated input needs ffmpeg >= 6 (-display_rotation)")
def test_cli_rotated_and_odd_sized_input(tmp_path):
    # a phone-style file: odd coded size plus a 90-degree display rotation
    src = str(tmp_path / "rot.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-t", "0.2", "-i", os.path.join(FIX, "pan.mp4"),
                    "-vf", "scale=641:361", "-c:v", "libx264", "-pix_fmt", "yuv444p", "-an", str(tmp_path / "odd.mp4")],
                   check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-display_rotation", "90", "-i", str(tmp_path / "odd.mp4"),
                    "-c", "copy", src], check=True)
    dst = str(tmp_path / "out.mp4")
    r = run_cli(src, "-o", dst)
    assert r.returncode == 0, r.stderr
    vo, _, _ = ffprobe(dst)
    # rotated to portrait, cropped to even for yuv420p
    assert (vo["width"], vo["height"]) == (360, 640)
    assert int(vo["nb_read_frames"]) == 6


def test_cli_reencodes_audio_mp4_cannot_carry(tmp_path):
    # PCM in a .mov cannot be stream-copied into MP4, so it becomes AAC
    src = str(tmp_path / "pcm.mov")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-t", "0.3", "-i", os.path.join(FIX, "shapes.mp4"),
                    "-c:v", "copy", "-c:a", "pcm_s16le", src], check=True)
    vi, ai, _ = ffprobe(src)
    assert ai[0]["codec_name"] == "pcm_s16le"
    dst = str(tmp_path / "out.mp4")
    r = run_cli(src, "-o", dst, "--bright", "92.5")
    assert r.returncode == 0, r.stderr
    vo, ao, _ = ffprobe(dst)
    assert vo["nb_read_frames"] == vi["nb_read_frames"]
    assert [a["codec_name"] for a in ao] == ["aac"]


def test_cli_rejects_out_of_range_params(tmp_path):
    src = os.path.join(FIX, "pan.mp4")
    for args, needle in ((["--bright", "150"], "--bright"), (["--labels", "1.5"], "--labels"),
                         (["--corners", "-1"], "--corners"), (["--motion", "300"], "--motion")):
        r = run_cli(src, "-o", str(tmp_path / "out.mp4"), *args)
        assert r.returncode == 1, (args, r.stderr)
        assert needle in r.stderr and "Traceback" not in r.stderr, r.stderr
    assert not (tmp_path / "out.mp4").exists()
    r = run_cli(src, "-o", str(tmp_path / "out.mp4"), "--crf", "60")
    assert r.returncode == 2 and "--crf" in r.stderr


def test_cli_rejects_tiny_input(tmp_path):
    src = str(tmp_path / "tiny.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=6x6:d=0.2:r=30",
                    "-c:v", "libx264", "-pix_fmt", "yuv444p", src], check=True)
    r = run_cli(src, "-o", str(tmp_path / "out.mp4"))
    assert r.returncode == 1
    assert "6x6" in r.stderr and "Traceback" not in r.stderr, r.stderr


def test_cli_refuses_to_overwrite_input_through_a_symlink(tmp_path):
    src = tmp_path / "in.mp4"
    src.write_bytes(open(os.path.join(FIX, "pan.mp4"), "rb").read())
    before = src.read_bytes()
    link = tmp_path / "link.mp4"
    link.symlink_to(src)
    for s, d in ((src, link), (link, src)):
        r = run_cli(str(s), "-o", str(d))
        assert r.returncode == 1 and "overwrite the input" in r.stderr, r.stderr
    hard = tmp_path / "hard.mp4"
    os.link(src, hard)
    r = run_cli(str(src), "-o", str(hard))
    assert r.returncode == 1 and "overwrite the input" in r.stderr
    assert src.read_bytes() == before


def test_cli_warns_on_truncated_input(tmp_path):
    src = tmp_path / "trunc.mp4"
    src.write_bytes(open(os.path.join(FIX, "shapes.mp4"), "rb").read()[:1_000_000])
    dst = str(tmp_path / "out.mp4")
    r = run_cli(str(src), "-o", dst, "--no-audio")
    assert r.returncode == 0, r.stderr
    assert "truncated" in r.stderr
    n = int(ffprobe(dst)[0]["nb_read_frames"])
    assert 0 < n < 54


def test_cli_no_truncation_warning_when_duration_runs_past_the_end(tmp_path):
    dst = str(tmp_path / "out.mp4")
    r = run_cli(os.path.join(FIX, "pan.mp4"), "-o", dst, "--start", "1.5", "--duration", "10")
    assert r.returncode == 0, r.stderr
    assert "truncated" not in r.stderr, r.stderr
    assert int(ffprobe(dst)[0]["nb_read_frames"]) == 15


def test_cli_refuses_existing_output_without_overwrite(tmp_path):
    dst = tmp_path / "out.mp4"
    dst.write_bytes(b"precious user file")
    r = run_cli(os.path.join(FIX, "pan.mp4"), "-o", str(dst), "--duration", "0.2")
    assert r.returncode == 1 and "--overwrite" in r.stderr, r.stderr
    assert dst.read_bytes() == b"precious user file"
    assert os.listdir(tmp_path) == ["out.mp4"]


def test_cli_overwrite_replaces_existing_output(tmp_path):
    dst = tmp_path / "out.mp4"
    dst.write_bytes(b"old")
    os.chmod(dst, 0o640)
    r = run_cli(os.path.join(FIX, "pan.mp4"), "-o", str(dst), "--duration", "0.2", "--overwrite")
    assert r.returncode == 0, r.stderr
    assert int(ffprobe(str(dst))[0]["nb_read_frames"]) == 6
    assert os.stat(dst).st_mode & 0o777 == 0o640              # keeps the replaced file's permissions
    assert os.listdir(tmp_path) == ["out.mp4"]                # no temp file left behind


def test_cli_failed_run_keeps_existing_output(tmp_path):
    dst = tmp_path / "out.mp4"
    dst.write_bytes(b"precious user file")
    # starting past the end decodes no frames: the run fails after encoding began
    r = run_cli(os.path.join(FIX, "pan.mp4"), "-o", str(dst), "--start", "100", "--overwrite")
    assert r.returncode == 1 and "no frames decoded" in r.stderr, r.stderr
    assert dst.read_bytes() == b"precious user file"
    assert os.listdir(tmp_path) == ["out.mp4"]


def test_setparams_only_on_ffmpeg_that_has_its_colour_options():
    # setparams and its colour options first shipped in FFmpeg 4.1 (commit 8d3f364630)
    parse = blobtrack.parse_ffmpeg_version
    old = blobtrack._encode_filters(parse("ffmpeg version 4.0.6 Copyright"))
    assert "setparams" not in old and "out_color_matrix=bt709" in old
    for text in ("ffmpeg version 4.1 Copyright", "ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright",
                 "ffmpeg version 7.1.1 Copyright", "ffmpeg version N-112233-gabcdef Copyright"):
        assert "setparams=color_primaries=bt709" in blobtrack._encode_filters(parse(text)), text


def test_ffmpeg_version_and_passthrough_flag():
    assert blobtrack.parse_ffmpeg_version("ffmpeg version 7.1.1 Copyright (c) 2000-2025") == (7, 1)
    assert blobtrack.parse_ffmpeg_version("ffmpeg version n4.4.2 Copyright") == (4, 4)
    assert blobtrack.parse_ffmpeg_version("ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright") == (4, 4)
    assert blobtrack.parse_ffmpeg_version("ffmpeg version N-112233-gabcdef Copyright") is None
    assert blobtrack.passthrough_args((4, 4)) == ["-vsync", "passthrough"]
    assert blobtrack.passthrough_args((5, 0)) == ["-vsync", "passthrough"]
    assert blobtrack.passthrough_args((5, 1)) == ["-fps_mode", "passthrough"]
    assert blobtrack.passthrough_args(None) == ["-fps_mode", "passthrough"]
    assert FFMPEG is None or FFMPEG >= (4, 0)


def test_cli_unreadable_input_exits_1(tmp_path):
    bad = tmp_path / "bad.mp4"
    bad.write_bytes(b"not a video")
    r = run_cli(str(bad), "-o", str(tmp_path / "out.mp4"))
    assert r.returncode == 1
    assert r.stderr.strip()
    assert not (tmp_path / "out.mp4").exists()


# --------------------------------------------------------------------- module
def test_process_contract(shapes_frames):
    bt = blobtrack.BlobTracker(1080, 1920)
    for f in shapes_frames[:5]:
        out = bt.process(f)
    assert out.shape == f.shape and out.dtype == np.uint8
    assert not np.array_equal(out, f)                    # something was drawn
    assert bt.last_tracks
    for t in bt.last_tracks:
        assert {"id", "x", "y", "w", "h", "kind", "a"} <= set(t)
        assert t["kind"] in ("B", "D", "E", "M")
    with pytest.raises(ValueError):
        bt.process(np.zeros((100, 100, 3), np.uint8))
    with pytest.raises(TypeError):
        blobtrack.BlobTracker(1080, 1920, brite=90)


@pytest.mark.parametrize("params", [
    {"bright": 150}, {"dark": -1}, {"labels": 1.5}, {"invert": -0.1}, {"screen": 2},
    {"chip": float("nan")}, {"large": float("inf")}, {"medium": float("nan")}, {"bright": float("-inf")},
    {"large": -1}, {"corners": 2.5}, {"motion": 256}, {"small": "many"},
])
def test_rejects_out_of_range_params(params):
    with pytest.raises(blobtrack.BlobTrackError) as e:
        blobtrack.BlobTracker(1080, 1920, **params)
    assert next(iter(params)) in str(e.value)


def test_rejects_tiny_frames():
    with pytest.raises(blobtrack.BlobTrackError, match="6x6"):
        blobtrack.BlobTracker(6, 6)
    for w, h in ((60, 60), (61, 107)):            # the smallest accepted sizes still run
        bt = blobtrack.BlobTracker(w, h)
        for _ in range(4):
            assert bt.process(np.full((h, w, 3), 128, np.uint8)).shape == (h, w, 3)


def test_deterministic(shapes_frames):
    runs = []
    for _ in range(2):
        bt = blobtrack.BlobTracker(1080, 1920)
        tr, px = [], []
        for f in shapes_frames[:30]:
            o = bt.process(f)
            tr.append([dict(t) for t in bt.last_tracks])
            px.append(o)
        runs.append((tr, px))
    assert runs[0][0] == runs[1][0]
    assert all(np.array_equal(a, b) for a, b in zip(runs[0][1], runs[1][1]))


def test_motion_mask_needs_three_frames(shapes_frames):
    bt = blobtrack.BlobTracker(1080, 1920)
    kinds = []
    for f in shapes_frames[:6]:
        bt.process(f)
        kinds.append({t["kind"] for t in bt.last_tracks})
    assert all("M" not in k for k in kinds[:3])
    assert any("M" in k for k in kinds[3:])


def test_corner_reseed(shapes_frames):
    bt = blobtrack.BlobTracker(1080, 1920, corners=28)
    counts = []
    for f in shapes_frames:
        bt.process(f)
        counts.append(len(bt.last_points))
    assert all(c >= 14 for c in counts), counts                   # never allowed to thin out
    assert bt.reseeds[0] == 0 and 45 in bt.reseeds


def test_resolution_scaling(shapes_frames):
    """A 2x-downscaled copy yields boxes at ~1/2 the coordinates on the same objects."""
    full = blobtrack.BlobTracker(1080, 1920)
    half = blobtrack.BlobTracker(540, 960)
    ious, hits, total = [], 0, 0
    for i, f in enumerate(shapes_frames):
        full.process(f)
        half.process(cv2.resize(f, (540, 960), interpolation=cv2.INTER_AREA))
        if i < 5:
            continue
        hb = [{k: t[k] * 2 for k in "xywh"} for t in half.last_tracks]
        for gx, gy, gw, gh in mf.shape_boxes(i / mf.FPS):
            gt = {"x": gx, "y": gy, "w": gw, "h": gh}
            fb = max(full.last_tracks, key=lambda t: blobtrack.iou(t, gt))
            if blobtrack.iou(fb, gt) < 0.5:
                continue                               # full-res run didn't pick this object
            total += 1
            best = max(blobtrack.iou(fb, b) for b in hb)
            ious.append(best)
            hits += best > 0.7
    assert total > 200
    assert hits / total > 0.9, (hits, total)
    assert np.median(ious) > 0.85


def test_reference_json_is_current(shapes_frames, pan_frames):
    """The committed reference detections (consumed by the JS parity test) match the module."""
    skip_unless_reference_opencv()
    for clip, frames in (("shapes", shapes_frames), ("pan", pan_frames)):
        ref = reference(clip)
        assert ref["frame_count"] == len(frames) == 60
        tracks, points = mf.track_frames(frames, ref["params"])
        assert tracks == ref["tracks"], clip
        assert points == ref["points"], clip
        assert all(len(t) > 5 for t in tracks), clip


# ------------------------------------------------------ golden vs the teaser
@pytest.mark.skipif(not (TEASER_TOOL and os.path.exists(TEASER_TOOL)),
                    reason="set BLOBTRACK_TEASER_DIR to the original teaser tools/ directory to run")
def test_matches_teaser_original(shapes_frames):
    """At 1080x1920 with the teaser config, detections, tracks, corners and pixels match the original."""
    sys.dont_write_bytecode = True                      # the teaser repo is read-only
    try:
        sys.path.insert(0, os.path.dirname(TEASER_TOOL))
        spec = importlib.util.spec_from_file_location("teaser_blobtrack", TEASER_TOOL)
        orig = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(orig)
    finally:
        sys.path.remove(os.path.dirname(TEASER_TOOL))
        sys.dont_write_bytecode = False

    cfg = {"bright": 90, "dark": 9, "motion": 14, "large": 6, "medium": 11, "small": 15, "corners": 28,
           "labels": 0.55, "label": 18, "invert": 0.18, "shift": 0.12, "screen": 0.70, "chip": 0.86}
    params = {k: v for k, v in cfg.items() if k != "label"}
    assert params == blobtrack.DEFAULTS
    bt = blobtrack.BlobTracker(1080, 1920, font_path=TEASER_FONT, **params)
    trk = orig.Tracker()
    grays, p, compared = [], None, 0
    for i, f in enumerate(shapes_frames):
        out = bt.process(f)
        grays.append(cv2.resize(cv2.cvtColor(f, cv2.COLOR_RGB2GRAY), (540, 960)))
        tracks = trk.update(orig.detect(grays[i], grays[i - 3] if i >= 3 else None, cfg))
        mine = [(t["id"], t["x"], t["y"], t["w"], t["h"], t["kind"], t["a"]) for t in bt.last_tracks]
        theirs = [(t["id"], t["x"], t["y"], t["w"], t["h"], t["kind"], t["a"]) for t in tracks]
        assert mine == theirs, "frame %d" % i
        # The original seeds corners once and never re-seeds; the new module
        # re-seeds (spec 3.3), so corners and pixels are compared up to then.
        if i > 0 and i in bt.reseeds:
            continue
        if compared < i:
            continue
        if i == 0:
            p = cv2.goodFeaturesToTrack(grays[0], 28, 0.02, 22)
        else:
            p, st, _ = cv2.calcOpticalFlowPyrLK(grays[i - 1], grays[i], p, None, winSize=(21, 21), maxLevel=3)
            p = p[st.ravel() == 1].reshape(-1, 1, 2)
        pts = [(float(x) / 0.5, float(y) / 0.5) for x, y in p.reshape(-1, 2)]
        assert bt.last_points == pts, "frame %d" % i
        ref = np.asarray(orig.draw(f, tracks, pts, i, cfg))
        assert np.array_equal(out, ref), "frame %d: max diff %d" % (i, np.abs(out.astype(int) - ref).max())
        compared += 1
    assert compared >= 30, compared
