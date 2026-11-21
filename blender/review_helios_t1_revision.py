"""Render the revised T1 from the original cameras and compare the lip and shell."""

import argparse
import json
import subprocess
import sys
from math import cos, sin
from pathlib import Path
from unittest.mock import patch

import bpy
from mathutils import Matrix

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import review_helios as review
from helios_shape import LIP_ANGLE
from review_core_bastion import import_glb, stage
from review_surface_clamp import decoded
from verify_helios_t1_revision import active_mounts


def sheet(paths: list, target: Path, tile: str) -> None:
    font = subprocess.check_output(
        ["fc-match", "-f", "%{file}", "sans-serif"], text=True
    ).strip()
    inputs = [value for label, path in paths for value in ("-label", label, str(path))]
    subprocess.run(
        [
            "magick",
            "montage",
            "-background",
            "#222833",
            "-fill",
            "#f4f5f6",
            "-font",
            font,
            "-pointsize",
            "18",
            *inputs,
            "-geometry",
            "408x408+5+5",
            "-tile",
            tile,
            "-quality",
            "94",
            str(target),
        ],
        check=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    for arg in ("piece", "original", "ktx"):
        parser.add_argument("--" + arg, required=True, type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    old, new = args.original.resolve(), args.piece.resolve()
    ktx = review.checked_ktx(args.ktx)
    out = new / "review"
    states = json.loads((old / "review/cameras.json").read_text())["heads"]
    direction_names = {v: k for k, v in review.VIEWS.items()}
    original_frame = review.frame

    def frame(scene, direction, target, scale):
        if bpy.data.objects["heliosHead"].parent:
            return original_frame(scene, direction, target, scale)
        desired = states[direction_names[direction]]
        scene.camera.matrix_world = Matrix(desired["matrix_world"])
        scene.camera.data.ortho_scale = desired["orthographic_width_m"]
        bpy.context.view_layer.update()
        actual = scene.camera.matrix_world
        assert (
            max(
                abs(actual[i][j] - desired["matrix_world"][i][j])
                for i in range(4)
                for j in range(4)
            )
            < 1e-6
        )
        return desired

    with (
        active_mounts() as here,
        patch.object(review, "HERE", here),
        patch.object(review, "frame", frame),
        patch.object(
            sys, "argv", [__file__, "--", "--piece", str(new), "--ktx", str(ktx)]
        ),
    ):
        review.main()
    cameras = json.loads((out / "cameras.json").read_text())
    axial = None
    for label, folder in (("original", old), ("revised", new)):
        for level in ("lod0", "lod1"):
            path = folder / f"{folder.name}-{level}.glb"
            import_glb(path)
            decoded(path, ktx)
            stage(False)
            scene = bpy.context.scene
            bpy.data.objects["Review ground"].hide_render = True
            scene.eevee.taa_render_samples = 16
            scene.render.resolution_x = scene.render.resolution_y = 624
            camera = original_frame(
                scene, (0, -cos(LIP_ANGLE), sin(LIP_ANGLE)), (0, -0.16, 0.25), 0.103
            )
            if axial is None:
                axial = camera
            assert axial == camera
            scene.render.filepath = str(out / f"{label}-{level}-axial.png")
            bpy.ops.render.render(write_still=True)
    cameras["axial"] = axial
    (out / "cameras.json").write_text(json.dumps(cameras, indent=2) + "\n")
    sheet(
        [
            (
                f"{label.title()}  /  {level.upper()}  /  {view.title()}",
                out / f"{label}-{level}-axial.png"
                if view == "axial"
                else folder / "review" / f"{level}-{view}.png",
            )
            for label, folder in (("original", old), ("revised", new))
            for level in ("lod0", "lod1")
            for view in ("oblique", "axial")
        ],
        out / "revision-comparison.jpg",
        "4x2",
    )


if __name__ == "__main__":
    main()
