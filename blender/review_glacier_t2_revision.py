"""Render both actual fork packages with identical cameras, lights and active mounts."""

import argparse
import json
import subprocess
import sys
from pathlib import Path

import bpy
import gpu
from mathutils import Matrix

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from package_core_bastion import digest, write_json
from review_core_bastion import checked_ktx, import_glb, stage
from review_surface_clamp import decoded
from verify_glacier_t2_revision import MOUNTS


def render(view: dict, file: Path) -> None:
    scene = bpy.context.scene
    scene.camera.matrix_world = Matrix(view["matrix_world"])
    scene.camera.data.ortho_scale = view["orthographic_width_m"]
    bpy.context.view_layer.update()
    assert (
        max(
            abs(scene.camera.matrix_world[i][j] - view["matrix_world"][i][j])
            for i in range(4)
            for j in range(4)
        )
        < 1e-6
    )
    assert abs(scene.camera.data.ortho_scale - view["orthographic_width_m"]) < 1e-6
    scene.render.filepath = str(file)
    bpy.ops.render.render(write_still=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    for name in ("piece", "before", "ktx"):
        parser.add_argument("--" + name, required=True, type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    new, old, ktx = args.piece.resolve(), args.before.resolve(), checked_ktx(args.ktx)
    review = new / "review"
    review.mkdir(exist_ok=True)
    cameras = json.loads((old / "review/cameras.json").read_text())
    cameras["resolved_packages"] = {}
    for name, piece, prefix in (("prior", old, "before-"), ("revision", new, "")):
        bound = {}
        for level in ("high", "lod0", "lod1"):
            if level == "high":
                path = piece / "high.blend"
                bpy.ops.wm.open_mainfile(filepath=str(path))
            else:
                path = piece / f"{piece.name}-{level}.glb"
                import_glb(path)
                decoded(path, ktx)
            bound[path.name] = digest(path)
            stage(False)
            scene = bpy.context.scene
            scene.eevee.taa_render_samples = 16
            scene.render.resolution_x = scene.render.resolution_y = 624
            bpy.data.objects["Review ground"].hide_render = True
            for view_name, view in cameras["heads"].items():
                render(view, review / f"{prefix}{level}-{view_name}.png")
            if level != "lod0":
                continue
            for family, directory in MOUNTS.items():
                mount = (
                    HERE.parent
                    / "assets-source/models"
                    / directory
                    / f"{family}-lod0.glb"
                )
                bpy.ops.import_scene.gltf(filepath=str(mount))
                decoded(mount, ktx)
                root, socket = (
                    bpy.data.objects["glacierHead"],
                    bpy.data.objects["mountSocket"],
                )
                root.parent = socket
                bpy.context.view_layer.update()
                render(
                    cameras["assemblies"][family],
                    review / f"{prefix}mounted-{family}.png",
                )
                root.parent = None
                anchor = socket.parent
                for obj in reversed([anchor, *anchor.children_recursive]):
                    bpy.data.objects.remove(obj, do_unlink=True)
                bound[str(mount.relative_to(HERE.parent))] = digest(mount)
        cameras["resolved_packages"][name] = bound
    cameras.update(
        gpu_backend=gpu.platform.backend_type_get(),
        gpu_renderer=gpu.platform.renderer_get(),
    )
    assert cameras["gpu_backend"] == "METAL"
    write_json(review / "cameras.json", cameras)
    font = subprocess.check_output(
        ["fc-match", "-f", "%{file}", "sans-serif"], text=True
    ).strip()

    def sheet(file: str, tiles: str, panels: list) -> None:
        labels = [
            arg
            for label, path in panels
            for arg in ("-label", label, str(review / (path + ".png")))
        ]
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
                *labels,
                "-geometry",
                "310x310+5+5",
                "-tile",
                tiles,
                "-quality",
                "92",
                str(review / file),
            ],
            check=True,
        )

    sheet(
        "comparison.jpg",
        "4x3",
        [
            (f"{level.upper()} / {view}", f"{level}-{view}")
            for level in ("high", "lod0", "lod1")
            for view in cameras["heads"]
        ],
    )
    sheet(
        "revision-comparison.jpg",
        "5x2",
        [
            (f"{label} / {subject}", prefix + path)
            for label, prefix in (("Prior", "before-"), ("Revised", ""))
            for subject, path in (
                ("high", "high-oblique"),
                ("LOD0", "lod0-oblique"),
                ("LOD1", "lod1-oblique"),
                ("clamp", "mounted-surface-clamp"),
                ("hover", "mounted-hover-pod"),
            )
        ],
    )


if __name__ == "__main__":
    main()
