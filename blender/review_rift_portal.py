"""Render the high and re-imported, KTX2-decoded portal from matched studio cameras."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import tempfile
from pathlib import Path

import bpy
import numpy as np

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_materials import png
from review_core_bastion import DEFAULT_KTX, checked_ktx, decode_ktx2, import_glb
from review_materials import aim, area
from rift_portal import angles_for

VIEWS = {
    "front": ((0, -3.0, 0), (0, 0, 0), 1.85),
    "isometric": ((1.65, -2.55, 0.97), (0, 0, 0), 1.92),
    "detail": ((0.93, -1.40, 0.45), (0.39, 0, 0.27), 0.72),
    "underside": ((-1.43, 2.70, -0.94), (0, 0, 0), 1.92),
    "wall-oblique": ((2.70, -1.30, 0.68), (0, 0, 0), 2.12),
    "wall-aperture": ((2.70, -1.30, 0.68), (0, 0, 0), 2.12),
}


def decoded(glb: Path, ktx: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="rift-portal-review-") as tmp:
        for name in ("basecolor", "normal", "orm", "emissive", "vortex"):
            src = glb.with_name(name + ".png")
            digest = hashlib.sha256(src.read_bytes()).digest()
            matches = [
                im
                for im in bpy.data.images
                if im.packed_file
                and hashlib.sha256(bytes(im.packed_file.data)).digest() == digest
            ]
            if len(matches) != 1:
                raise ValueError(f"{name}: PNG fallback mismatch")
            pixels = decode_ktx2(ktx, src.with_suffix(".ktx2").read_bytes())
            color = name in ("basecolor", "emissive", "vortex")
            path = Path(tmp) / src.name
            png(
                path,
                np.frombuffer(pixels, np.uint8).reshape((1024, 1024, 4))[::-1, :, :3],
                color,
            )
            replacement = bpy.data.images.load(str(path))
            replacement.colorspace_settings.name = "sRGB" if color else "Non-Color"
            replacement.pack()
            matches[0].user_remap(replacement)


def wall() -> bpy.types.Object:
    """A masked host surface. Only its external edge returns down the side of the panel."""
    angles = angles_for(88)
    n = len(angles)
    verts = []
    for edge, depth in (("aperture", 0.0003), ("outer", 0.0003), ("outer", 0.09)):
        for a in angles:
            x, h = math.cos(a), math.sin(a)
            t = 1 / max(abs(x) / 0.80, abs(h) / 0.89)
            verts.append(
                (
                    0.475 * x if edge == "aperture" else t * x,
                    depth,
                    0.675 * h if edge == "aperture" else t * h,
                )
            )
    faces = []
    for i in range(n):
        k = (i + 1) % n
        faces.extend([(i, n + i, n + k, k), (n + i, 2 * n + i, 2 * n + k, n + k)])
    mesh = bpy.data.meshes.new("Host through aperture")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("Calibration wall", mesh)
    bpy.context.collection.objects.link(obj)
    mat = bpy.data.materials.new("Neutral architectural panel")
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (
        0.26,
        0.28,
        0.31,
        1,
    )
    mesh.materials.append(mat)
    return obj


def studio(cpu: bool) -> tuple:
    scene = bpy.context.scene
    scene.render.engine = "CYCLES" if cpu else "BLENDER_EEVEE"
    if cpu:
        scene.cycles.device, scene.cycles.samples = "CPU", 4
        scene.cycles.use_denoising = True
    else:
        scene.eevee.taa_render_samples = 24
    scene.render.resolution_x = scene.render.resolution_y = 384 if cpu else 768
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("Neutral studio")
    scene.world = world
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (
        0.22,
        0.25,
        0.31,
        1,
    )
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.48
    area("Wide key", (-1.3, -1.4, 1.7), 120, 1.40, 1.12)
    area("Metal strip", (1.6, -2.0, 0.26), 95, 0.26, 2.4)
    area("Crown rim", (0.60, 0.60, 1.62), 105, 0.8, 0.28)
    area("Bottom fill", (-0.75, -0.60, -1.32), 48, 0.98, 0.46)
    area("Rear light", (-0.60, 1.32, 0.41), 60, 0.82, 1.50)
    cam = bpy.data.objects.new(
        "Portal orthographic studio", bpy.data.cameras.new("Portal review lens")
    )
    bpy.context.collection.objects.link(cam)
    cam.data.type = "ORTHO"
    scene.camera = cam
    return cam, wall()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--ktx", type=Path, default=DEFAULT_KTX)
    parser.add_argument("--cpu-draft", action="store_true")
    parser.add_argument("--views", nargs="+", choices=VIEWS, default=list(VIEWS))
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    if bpy.app.version != (5, 2, 2):
        raise ValueError("Blender 5.2.2 required")
    src = args.source.resolve()
    if src.suffix == ".glb":
        import_glb(src)
        decoded(src, checked_ktx(args.ktx))
    else:
        bpy.ops.wm.open_mainfile(filepath=str(src))
    args.out.mkdir(exist_ok=True, parents=True)
    cam, host = studio(args.cpu_draft)
    scene = bpy.context.scene
    views = {}
    for view in args.views:
        pos, target, size = VIEWS[view]
        cam.location = pos
        aim(cam, target)
        cam.data.ortho_scale = size
        host.hide_render = not view.startswith("wall-")
        for name in ("Crown rim", "Rear light"):
            bpy.data.objects[name].hide_render = not host.hide_render
        bpy.data.objects["portalInterior"].hide_render = view == "wall-aperture"
        scene.render.filepath = str((args.out / f"{args.label}-{view}.png").resolve())
        bpy.context.view_layer.update()
        pose = cam.matrix_world.copy()
        bpy.context.view_layer.update()
        assert pose == cam.matrix_world
        views[view] = {
            "camera_world_blender": [list(row) for row in pose],
            "ortho_width_m": cam.data.ortho_scale,
            "wall": not host.hide_render,
            "field": not bpy.data.objects["portalInterior"].hide_render,
        }
        bpy.ops.render.render(write_still=True)
    record = {
        "source_sha256": hashlib.sha256(src.read_bytes()).hexdigest(),
        "engine": scene.render.engine,
        "resolution": scene.render.resolution_x,
        "views": views,
    }
    (args.out / f"{args.label}-cameras.json").write_text(
        json.dumps(record, indent=2) + "\n"
    )


if __name__ == "__main__":
    main()
