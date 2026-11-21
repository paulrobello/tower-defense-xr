"""Render the same camera, lights and 1K decoded atlas for each hover pod LOD."""

import argparse
import json
import subprocess
import sys
from pathlib import Path

import bpy

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from review_core_bastion import checked_ktx, import_glb, stage
from review_materials import aim
from review_surface_clamp import decoded

VIEWS = {
    "isometric": ((0.29, -0.55, 0.40), (0, 0, 0.030), 0.365),
    "front": ((0, -0.66, 0.120), (0, 0, 0.034), 0.348),
    "underside": ((0.29, -0.55, -0.46), (0, 0, 0.025), 0.358),
    "top": ((0, -0.01, 0.65), (0, 0, 0.03), 0.350),
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--piece", required=True, type=Path)
    parser.add_argument("--ktx", required=True, type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    assert bpy.app.version == (5, 2, 2)
    piece, ktx = args.piece.resolve(), checked_ktx(args.ktx)
    out = piece / "review"
    out.mkdir(exist_ok=True)
    evidence = {}
    for label in ("high", "lod0", "lod1"):
        if label == "high":
            bpy.ops.wm.open_mainfile(filepath=str(piece / "high.blend"))
        else:
            path = piece / f"hover-pod-{label}.glb"
            import_glb(path)
            decoded(path, ktx)
        stage(False)
        scene = bpy.context.scene
        scene.eevee.taa_render_samples = 16
        scene.render.resolution_x = scene.render.resolution_y = 624
        bpy.data.objects["Review ground"].hide_render = True
        for name, (position, target, scale) in VIEWS.items():
            camera = scene.camera
            camera.location = position
            aim(camera, target)
            camera.data.ortho_scale = scale
            bpy.context.view_layer.update()
            state = {
                "camera_world": [list(row) for row in camera.matrix_world],
                "orthographic_width_m": scale,
            }
            if label == "high":
                evidence[name] = state
            else:
                assert evidence[name] == state
            scene.render.filepath = str(out / f"{label}-{name}.png")
            bpy.ops.render.render(write_still=True)
    (out / "cameras.json").write_text(json.dumps(evidence, indent=2) + "\n")
    font = subprocess.check_output(
        ["fc-match", "-f", "%{file}", "sans-serif"], text=True
    ).strip()
    inputs = []
    for label in ("high", "lod0", "lod1"):
        for view in VIEWS:
            inputs.extend(
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
            *inputs,
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
