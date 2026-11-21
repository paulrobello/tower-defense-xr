"""Render the imported Brute at the established matched cameras and compare its predecessor."""

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import bpy

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import review_brute
from package_core_bastion import digest, write_json


def main() -> None:
    piece = Path(sys.argv[sys.argv.index("--piece") + 1]).resolve()
    i = sys.argv.index("--original")
    original = Path(sys.argv[i + 1]).resolve()
    del sys.argv[i : i + 2]
    j = sys.argv.index("--first-pass-front")
    first_pass = Path(sys.argv[j + 1]).resolve()
    assert (
        digest(first_pass)
        == "e8ad6a9d78e26b7f0e25f94abaf2118d5fc89dadc9df3a62ea5ea65ab537852c"
    )
    del sys.argv[j : j + 2]
    out = piece / "review"
    pose_cameras = {}
    render = review_brute.render

    def capture(path: Path, view: tuple) -> dict:
        camera = render(path, view)
        if path.name in {
            f"{level}-underside.png" for level in ("high", "lod0", "lod1")
        }:
            level = path.stem.split("-")[0]
            arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
            ground = bpy.data.objects["Review ground"]
            action = review_brute.select_action(arm, "armor_brace")
            start, end = action.frame_range
            frame = (start + end) * 0.5
            bpy.context.scene.frame_set(int(frame), subframe=frame - int(frame))
            shots = {}
            for name, camera_view in (
                ("brace-flank", review_brute.VIEWS["flank"]),
                ("brace-below", ((0.32, -0.96, -0.20), (0, -0.05, 0.17), 0.62)),
            ):
                ground.hide_render = name == "brace-below"
                shots[name] = render(out / f"{level}-{name}.png", camera_view)
            pose_cameras[level] = shots
            review_brute.neutral(arm)
        return camera

    with patch.object(review_brute, "render", capture):
        review_brute.main()
    cameras = json.loads((out / "cameras.json").read_text())
    previous = json.loads((original / "review/cameras.json").read_text())
    assert cameras["matched_views"] == previous["matched_views"]
    files = json.loads((original / "provenance.json").read_text())["files"]
    shots = []
    for name, folder in (("Original", original), ("Revision", piece)):
        for view in review_brute.VIEWS:
            relative = f"review/lod0-{view}.png"
            if name == "Original":
                assert digest(folder / relative) == files[relative]
            shots.append((f"{name}   {view}", folder / relative))
    review_brute.montage(shots, 4, out / "revision-comparison.jpg")
    cameras["reviewed_glb_sha256"] = {
        lod: digest(piece / f"carapace-brute-{lod}.glb") for lod in ("lod0", "lod1")
    }
    assert pose_cameras["high"] == pose_cameras["lod0"] == pose_cameras["lod1"]
    cameras["matched_half_brace_views"] = pose_cameras["high"]
    review_brute.montage(
        [
            (f"{level.upper()}   {view}", out / f"{level}-{view}.png")
            for level in ("high", "lod0", "lod1")
            for view in ("brace-flank", "brace-below")
        ],
        2,
        out / "brace.jpg",
    )
    archived = out / "first-pass-lod0-front.png"
    if first_pass != archived:
        shutil.copyfile(first_pass, archived)
    with tempfile.TemporaryDirectory() as directory:
        crops = []
        for name, image in (
            ("First pass", archived),
            ("Corrected", out / "lod0-front.png"),
        ):
            crop = Path(directory) / f"{name}.png"
            subprocess.run(
                [
                    "magick",
                    str(image),
                    "-crop",
                    "140x120+185+100",
                    "+repage",
                    "-resize",
                    "280x240",
                    str(crop),
                ],
                check=True,
            )
            crops.append((name, crop))
        review_brute.montage(crops, 2, out / "shield-pole-comparison.jpg")
    cameras["first_pass_shield_detail"] = {
        "lod0_sha256": "beeec4e26cf4c33e58d0619fc2cb5a939813dce8136f722823b3b842b6e93649",
        "front_png_sha256": digest(archived),
        "matched_crop_xywh": [185, 100, 140, 120],
    }
    cameras["original_lod0_sha256"] = digest(original / "carapace-brute-lod0.glb")
    write_json(out / "cameras.json", cameras)


if __name__ == "__main__":
    main()
