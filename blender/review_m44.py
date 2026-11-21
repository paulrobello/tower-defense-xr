"""Matched EEVEE front, side, underside and three-quarter views of the three M44 sources."""

import argparse
import json
import subprocess
import sys
from pathlib import Path

import bpy

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from m44_shape import TIERS
from review_core_bastion import checked_ktx, import_glb, stage
from review_materials import aim
from review_surface_clamp import decoded

VIEWS = {
    "oblique": (0.68, -0.80, 0.40),
    "front": (0, -1.10, 0.03),
    "side": (1.2, 0.02, 0.01),
    "underside": (-0.68, -0.70, -0.54),
}


def frame(scene: bpy.types.Scene, position: tuple, target: tuple, scale: float) -> dict:
    camera = scene.camera
    camera.location = tuple(a + b for a, b in zip(position, target))
    aim(camera, target)
    camera.data.ortho_scale = scale
    bpy.context.view_layer.update()
    return {
        "matrix_world": [list(row) for row in camera.matrix_world],
        "orthographic_width_m": scale,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--piece", type=Path, required=True)
    parser.add_argument("--ktx", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    piece, ktx = args.piece.resolve(), checked_ktx(args.ktx)
    out = piece / "review"
    out.mkdir(exist_ok=True)
    t = TIERS[int(piece.name[-1])]
    target = (0, (-t.muzzle_forward + t.length / 2) / 2, (t.total + 0.051) / 2)
    scale = (t.muzzle_forward + t.length / 2) * 1.18
    cameras = {}
    for label in ("high", "lod0", "lod1"):
        if label == "high":
            bpy.ops.wm.open_mainfile(filepath=str(piece / "high.blend"))
        else:
            path = piece / f"{piece.name}-{label}.glb"
            import_glb(path)
            decoded(path, ktx)
        stage(False)
        scene = bpy.context.scene
        scene.eevee.taa_render_samples = 16
        scene.render.resolution_x = scene.render.resolution_y = 624
        bpy.data.objects["Review ground"].hide_render = True
        for name, position in VIEWS.items():
            state = frame(scene, position, target, scale)
            if label == "high":
                cameras[name] = state
            else:
                assert cameras[name] == state
            scene.render.filepath = str(out / f"{label}-{name}.png")
            bpy.ops.render.render(write_still=True)
        if label == "lod0":
            for family in ("surface-clamp", "hover-pod"):
                path = (
                    HERE.parent / "assets-source/models" / family / f"{family}-lod0.glb"
                )
                bpy.ops.import_scene.gltf(filepath=str(path))
                decoded(path, ktx)
                socket = bpy.data.objects["mountSocket"]
                bpy.data.objects["m44Head"].parent = socket
                frame(
                    scene, VIEWS["oblique"], (0, target[1], t.total * 0.5), scale * 1.13
                )
                scene.render.filepath = str(out / f"mounted-{family}.png")
                bpy.ops.render.render(write_still=True)
                bpy.data.objects["m44Head"].parent = None
                mount = socket.parent
                for item in reversed([mount, *mount.children_recursive]):
                    bpy.data.objects.remove(item, do_unlink=True)
    (out / "cameras.json").write_text(json.dumps(cameras, indent=2) + "\n")
    font = subprocess.check_output(
        ["fc-match", "-f", "%{file}", "sans-serif"], text=True
    ).strip()
    images = []
    for label in ("high", "lod0", "lod1"):
        for view in VIEWS:
            images.extend(
                [
                    "-label",
                    f"{label.upper()}  /  {view.title()}",
                    str(out / f"{label}-{view}.png"),
                ]
            )
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
            "16",
            *images,
            "-geometry",
            "310x310+5+5",
            "-tile",
            "4x3",
            "-quality",
            "92",
            str(out / "comparison.jpg"),
        ],
        check=True,
    )


if __name__ == "__main__":
    main()
