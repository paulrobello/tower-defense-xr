"""Matched EEVEE calibration views of the source and both decoded, re-imported LODs."""

import argparse
import json
import math
import sys
import tempfile
from hashlib import sha256
from pathlib import Path

import bpy
import numpy as np

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from build_materials import png
from package_core_bastion import MAPS, digest
from package_surface_clamp import comparison
from review_core_bastion import checked_ktx, decode_ktx2, import_glb, stage
from review_materials import aim

VIEWS = {
    "front": ((0, -1.8, 0.211), (0, 0, 0.024), 0.345),
    "isometric": ((0.28, -0.78, 0.48), (0, 0, 0.021), 0.355),
    "detail": ((0.27, -0.65, 0.43), (0.058, -0.054, 0.026), 0.205),
    "underside": ((0.13, -0.52, -0.70), (0, 0, 0.017), 0.349),
    "wall": ((0.50, -0.68, 0.28), (0, 0, 0), 0.354),
}


def decoded(glb: Path, ktx: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        for role in MAPS:
            pattern = digest(glb.with_name(role + ".png"))

            images = [
                im
                for im in bpy.data.images
                if im.packed_file
                and sha256(bytes(im.packed_file.data)).hexdigest() == pattern
            ]
            assert len(images) == 1
            rgba = np.frombuffer(
                decode_ktx2(ktx, glb.with_name(role + ".ktx2").read_bytes()), np.uint8
            ).reshape(1024, 1024, 4)
            path = Path(tmp) / (role + ".png")
            color = role in ("basecolor", "emissive")
            png(path, rgba[::-1, :, :3], color)
            replacement = bpy.data.images.load(str(path))
            replacement.colorspace_settings.name = "sRGB" if color else "Non-Color"
            replacement.pack()
            images[0].user_remap(replacement)


def render(source: Path, label: str, out: Path, ktx: Path) -> None:
    if source.suffix == ".blend":
        bpy.ops.wm.open_mainfile(filepath=str(source))
    else:
        import_glb(source)
        decoded(source, ktx)
    stage(False)
    scene = bpy.context.scene
    scene.eevee.taa_render_samples = 16
    scene.render.resolution_x = scene.render.resolution_y = 624
    ground = bpy.data.objects["Review ground"]
    root = bpy.data.objects["surfaceClamp"]
    root.rotation_mode = "XYZ"
    evidence = {}
    for name, (position, target, scale) in VIEWS.items():
        if label == "lod1" and name not in ("isometric", "underside", "wall"):
            continue
        wall = name == "wall"
        root.rotation_euler = (math.pi / 2 if wall else 0, 0, 0)
        ground.rotation_euler = root.rotation_euler
        ground.location = (0, 0.00002, 0) if wall else (0, 0, -0.00002)
        ground.hide_render = name == "underside"
        cam = scene.camera
        cam.location = position
        aim(cam, target)
        cam.data.ortho_scale = scale
        bpy.context.view_layer.update()
        evidence[name] = {
            "camera_world": [list(row) for row in cam.matrix_world],
            "ortho_scale_m": scale,
            "host": "wall" if wall else "floor",
            "host_visible": not ground.hide_render,
        }
        scene.render.filepath = str(out / f"{label}-{name}.png")
        bpy.ops.render.render(write_still=True)
    (out / f"{label}-cameras.json").write_text(json.dumps(evidence, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--piece", type=Path, required=True)
    parser.add_argument("--ktx", type=Path, required=True)
    parser.add_argument(
        "--levels",
        nargs="+",
        choices=("high", "lod0", "lod1"),
        default=["high", "lod0", "lod1"],
    )
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    assert bpy.app.version == (5, 2, 2)
    piece = args.piece.resolve()
    out = piece / "review"
    out.mkdir(parents=True, exist_ok=True)
    for label in args.levels:
        source = piece / (
            "high.blend" if label == "high" else f"surface-clamp-{label}.glb"
        )
        render(source, label, out, checked_ktx(args.ktx))

    if set(args.levels) == {"high", "lod0", "lod1"}:
        comparison(out, list(VIEWS))
