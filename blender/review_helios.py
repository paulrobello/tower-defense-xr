"""Matched EEVEE front, side, underside and three-quarter views of the three Helios sources."""

import argparse
import json
import subprocess
import sys
from pathlib import Path

import bpy
import gpu
from mathutils import Vector

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from review_core_bastion import checked_ktx, import_glb, stage
from review_m44 import frame
from review_surface_clamp import decoded

VIEWS = {
    "oblique": (0.69, -0.86, 0.70),
    "front": (0, -1.10, 0.03),
    "side": (1.2, 0.02, 0.01),
    "underside": (-0.68, -0.70, -0.54),
}


def fit(direction: tuple, objects: list) -> tuple:
    points = [
        obj.matrix_world @ vertex.co
        for obj in objects
        if obj.type == "MESH"
        for vertex in obj.data.vertices
    ]
    rotation = Vector(direction).to_track_quat("Z", "Y")
    view = [rotation.inverted() @ point for point in points]
    low = Vector(tuple(min(p[i] for p in view) for i in range(3)))
    high = Vector(tuple(max(p[i] for p in view) for i in range(3)))
    return tuple(rotation @ ((low + high) / 2)), max(
        high.x - low.x, high.y - low.y
    ) * 1.18


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--piece", type=Path, required=True)
    parser.add_argument("--ktx", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    piece, ktx = args.piece.resolve(), checked_ktx(args.ktx)
    out = piece / "review"
    out.mkdir(exist_ok=True)
    cameras, frames, assemblies = {}, {}, {}
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
            if label == "high":
                frames[name] = fit(
                    position, bpy.data.objects["heliosHead"].children_recursive
                )
            state = frame(scene, position, *frames[name])
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
                bpy.data.objects["heliosHead"].parent = socket
                bpy.context.view_layer.update()
                direction = VIEWS["oblique"]
                assemblies[family] = frame(
                    scene, direction, *fit(direction, socket.parent.children_recursive)
                )
                scene.render.filepath = str(out / f"mounted-{family}.png")
                bpy.ops.render.render(write_still=True)
                bpy.data.objects["heliosHead"].parent = None
                mount = socket.parent
                for item in reversed([mount, *mount.children_recursive]):
                    bpy.data.objects.remove(item, do_unlink=True)
    (out / "cameras.json").write_text(
        json.dumps(
            {
                "heads": cameras,
                "assemblies": assemblies,
                "gpu_backend": gpu.platform.backend_type_get(),
                "gpu_renderer": gpu.platform.renderer_get(),
            },
            indent=2,
        )
        + "\n"
    )
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
