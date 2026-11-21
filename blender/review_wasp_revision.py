"""Matched neutral and peak-bank evidence, with an actual five-clip decoded playback."""

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
import review_wasp as studio
from package_core_bastion import digest
from review_skitter import montage, neutral, render
from verify_skitter import select_action


def pose(arm: bpy.types.Object, clip: str, time: float) -> None:
    start, end = select_action(arm, clip).frame_range
    frame = start + time * (end - start)
    bpy.context.scene.frame_set(int(frame), subframe=frame - int(frame))


def main() -> None:
    parser = argparse.ArgumentParser()
    for arg in ("piece", "original", "ktx"):
        parser.add_argument("--" + arg, type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    piece, old = args.piece.resolve(), args.original.resolve()
    out = piece / "review"
    out.mkdir(exist_ok=True)
    baseline = json.loads((old / "provenance.json").read_text())["artifact_sha256"]
    bank_cameras = {}

    def still(path: Path, view: tuple) -> dict:
        camera = render(path, view)
        if path.name in [f"{lod}-underside.png" for lod in ("high", "lod0", "lod1")]:
            lod = path.stem.split("-")[0]
            arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
            pose(arm, "bank_turn", 0.5)
            bank_cameras[lod] = render(
                out / f"{lod}-bank.png", studio.VIEWS["underside"]
            )
            neutral(arm)
        return camera

    pos = sys.argv.index("--original")
    del sys.argv[pos : pos + 2]
    with patch.object(studio, "render", still):
        studio.main()
    report = json.loads((out / "cameras.json").read_text())
    assert (
        report["matched_views"]
        == json.loads((old / "review/cameras.json").read_text())["matched_views"]
    )
    assert all(v == report["matched_views"]["underside"] for v in bank_cameras.values())
    report["bank_view_at_half_clip"] = bank_cameras
    report["revised_glb_sha256"] = {
        n: digest(piece / f"wasp-skimmer-{n}.glb") for n in ("lod0", "lod1")
    }
    report["original_glb_sha256"] = {
        n: baseline[f"wasp-skimmer-{n}.glb"] for n in ("lod0", "lod1")
    }
    shots = []
    for level in ("high", "lod0", "lod1"):
        for label, root in (("Original", old / "review"), ("Revision", out)):
            for angle in ("top", "oblique", "underside"):
                name = f"{level}-{angle}.png"
                if label == "Original":
                    assert digest(root / name) == baseline["review/" + name]
                shots.append((f"{label} {level.upper()}   {angle}", root / name))
    montage(shots, 3, out / "revision-comparison.jpg")
    montage(
        [
            (n.upper() + "   underside bank", out / f"{n}-bank.png")
            for n in ("high", "lod0", "lod1")
        ],
        3,
        out / "bank.jpg",
    )
    arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
    scene = bpy.context.scene
    scene.render.resolution_x = scene.render.resolution_y = 360
    scene.eevee.taa_render_samples = 12
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp)
        frames = 0
        for clip in studio.POSES:
            ground = bpy.data.objects["Review ground"]
            ground.hide_render = clip == "bank_turn"
            for i in range(9):
                pose(arm, clip, i / 8)
                render(
                    folder / f"frame-{frames:03d}.png",
                    studio.VIEWS["underside" if ground.hide_render else "oblique"],
                )
                frames += 1
        subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-y",
                "-framerate",
                "9",
                "-i",
                str(folder / "frame-%03d.png"),
                "-c:v",
                "libx264",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                str(out / "flight-clips.mp4"),
            ],
            check=True,
        )
    report["performed_playback"] = {
        "frames_per_clip": 9,
        "fps": 9,
        "clip_order": list(studio.POSES),
        "lod": "lod0",
    }
    (out / "cameras.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
