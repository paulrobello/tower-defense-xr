"""Render five physical samples and compare two-by-two repeats at two light angles."""

import argparse
import math
import subprocess
import sys
import tempfile
from pathlib import Path

import bpy
from mathutils import Vector

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from materials import LIBRARY, SURFACES, material


def aim(obj: bpy.types.Object, target: tuple[float, float, float]) -> None:
    obj.rotation_euler = (
        (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()
    )


def area(
    name: str, pos: tuple, energy: float, width: float, height: float
) -> bpy.types.Object:
    light = bpy.data.lights.new(name, "AREA")
    light.energy = energy
    light.shape = "RECTANGLE"
    light.size, light.size_y = width, height
    obj = bpy.data.objects.new(name, light)
    bpy.context.collection.objects.link(obj)
    obj.location = pos
    aim(obj, (0, 0, 0))
    return obj


def profile() -> bpy.types.Object:
    """Turn a machined coupon with a convex top, a crisp bevel and an inset shoulder."""
    rings = [
        (0.001, 0.010),
        (0.082, 0.010),
        (0.091, 0.016),
        (0.091, 0.025),
        (0.088, 0.029),
        (0.085, 0.030),
        (0.085, 0.034),
        (0.091, 0.036),
        (0.093, 0.039),
        (0.093, 0.044),
        (0.089, 0.050),
        (0.076, 0.057),
        (0.064, 0.064),
        (0.050, 0.075),
        (0.034, 0.083),
        (0.017, 0.087),
        (0.001, 0.088),
    ]
    count = 96
    vertices, faces = [], []
    for radius, z in rings:
        for i in range(count):
            angle = math.tau * i / count
            vertices.append((radius * math.cos(angle), radius * math.sin(angle), z))
    for i in range(len(rings) - 1):
        for j in range(count):
            a, b = i * count + j, i * count + (j + 1) % count
            faces.append((a, b, b + count, a + count))
    faces += [
        tuple(reversed(range(count))),
        tuple(range(len(vertices) - count, len(vertices))),
    ]
    mesh = bpy.data.meshes.new("Coupon")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    for face in mesh.polygons:
        face.use_smooth = face.index // count >= 10
    mesh.uv_layers.new(name="UV0")
    obj = bpy.data.objects.new("Coupon", mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def uv_coupon(obj: bpy.types.Object, tile_m: float) -> None:
    mesh = obj.data
    uvs = mesh.uv_layers.active.data
    for poly in mesh.polygons:
        for loop_id in poly.loop_indices:
            loop = mesh.loops[loop_id]
            x, y, z = mesh.vertices[loop.vertex_index].co
            if abs(poly.normal.z) > 0.55:
                uvs[loop_id].uv = (x / tile_m + 0.5, y / tile_m + 0.5)
            else:
                ring_index = loop.vertex_index % 96
                if ring_index == 0 and poly.index % 96 == 95:
                    ring_index = 96
                uvs[loop_id].uv = (
                    math.tau * 0.09 * ring_index / (96 * tile_m),
                    z / tile_m,
                )


def render_review(out: Path, font: str) -> None:
    if bpy.app.version != (5, 2, 2):
        raise ValueError("Expected Blender 5.2.2 LTS")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = 12
    scene.render.resolution_x = scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.use_stamp = False
    world = bpy.data.worlds.new("Neutral studio")
    scene.world = world
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (
        0.12,
        0.13,
        0.15,
        1,
    )
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.65
    camera = bpy.data.objects.new("Orthographic", bpy.data.cameras.new("Orthographic"))
    bpy.context.collection.objects.link(camera)
    camera.data.type = "ORTHO"
    camera.data.clip_start = 0.001
    scene.camera = camera
    coupon = profile()
    bpy.ops.mesh.primitive_plane_add(size=1)
    plane = bpy.context.object
    plane.name = "Two UV tiles each axis"
    for uv in plane.data.uv_layers.active.data:
        uv.uv *= 2
    bpy.ops.mesh.primitive_plane_add(size=100, location=(0, 0, 0.0097))
    floor = bpy.context.object
    floor_mat = bpy.data.materials.new("Studio floor")
    floor_shader = floor_mat.node_tree.nodes["Principled BSDF"]
    floor_shader.inputs["Base Color"].default_value = (0.055, 0.065, 0.081, 1)
    floor_shader.inputs["Roughness"].default_value = 0.71
    floor.data.materials.append(floor_mat)
    key = area("Large softbox", (-0.29, -0.18, 0.41), 7, 0.32, 0.17)
    fill = area("Vertical strip", (0.19, 0.18, 0.29), 6.5, 0.075, 0.34)
    front = area("Front bounce", (-0.1, -0.42, 0.24), 2.5, 0.48, 0.33)
    review = out / "review"
    review.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="bastion-coupons-") as tmp:
        temp = Path(tmp)
        rows = []
        for slug, spec in SURFACES.items():
            mat = material(slug, out)
            coupon.data.materials.clear()
            coupon.data.materials.append(mat)
            plane.data.materials.clear()
            plane.data.materials.append(mat)
            uv_coupon(coupon, spec.tile_m)
            frames = []
            for view in ("form", "soft", "raking"):
                form = view == "form"
                coupon.hide_render = floor.hide_render = not form
                plane.hide_render = form
                fill.hide_render = front.hide_render = not form
                if form:
                    camera.location = (0.22, -0.34, 0.29)
                    aim(camera, (0, 0, 0.044))
                    camera.data.ortho_scale = 0.234
                    key.location, key.data.energy, key.data.size, key.data.size_y = (
                        (-0.29, -0.18, 0.41),
                        7,
                        0.32,
                        0.17,
                    )
                else:
                    # The plane and camera have the same width: 512 screen pixels = 2 x 256 source pixels.
                    plane.scale = (2 * spec.tile_m, 2 * spec.tile_m, 1)
                    camera.location = (0, 0, 1)
                    camera.rotation_euler = (0, 0, 0)
                    camera.data.ortho_scale = 2 * spec.tile_m
                    if view == "soft":
                        (
                            key.location,
                            key.data.energy,
                            key.data.size,
                            key.data.size_y,
                        ) = (-0.37, 0.11, 0.61), 8, 0.29, 0.56
                    else:
                        (
                            key.location,
                            key.data.energy,
                            key.data.size,
                            key.data.size_y,
                        ) = (0.68, -0.12, 0.20), 34, 0.12, 0.80
                aim(key, (0, 0, 0))
                frame = temp / f"{slug}-{view}.png"
                scene.render.filepath = str(frame)
                bpy.ops.render.render(write_still=True)
                frames.append(str(frame))
            row = review / f"{slug}.webp"
            subprocess.run(
                [
                    "magick",
                    *frames,
                    "+append",
                    "-define",
                    "webp:lossless=true",
                    str(row),
                ],
                check=True,
            )
            caption = temp / f"{slug}-caption.png"
            subprocess.run(
                [
                    "magick",
                    "-size",
                    "295x300",
                    "xc:#172028",
                    "-font",
                    font,
                    "-fill",
                    "#f2f1eb",
                    "-pointsize",
                    "23",
                    "-annotate",
                    "+20+137",
                    spec.label,
                    "-fill",
                    "#b3bfc5",
                    "-pointsize",
                    "18",
                    "-annotate",
                    "+20+170",
                    f"{round(1000 * spec.tile_m)} mm / tile",
                    str(caption),
                ],
                check=True,
            )
            strip = temp / f"{slug}-overview.png"
            subprocess.run(
                ["magick", str(row), "-resize", "900x300!", str(temp / "scaled.png")],
                check=True,
            )
            subprocess.run(
                [
                    "magick",
                    str(caption),
                    str(temp / "scaled.png"),
                    "+append",
                    str(strip),
                ],
                check=True,
            )
            rows.append(str(strip))
        heading = temp / "header.png"
        subprocess.run(
            [
                "magick",
                "-size",
                "1195x90",
                "xc:#172028",
                "-font",
                font,
                "-fill",
                "#f2f1eb",
                "-pointsize",
                "27",
                "-annotate",
                "+20+52",
                "Bastion Rib",
                "-pointsize",
                "17",
                "-annotate",
                "+310+52",
                "Form / studio light",
                "-annotate",
                "+608+52",
                "2 × 2 / soft light",
                "-annotate",
                "+907+52",
                "2 × 2 / raking light",
                str(heading),
            ],
            check=True,
        )
        subprocess.run(
            [
                "magick",
                str(heading),
                *rows,
                "-append",
                "-quality",
                "93",
                str(review / "surfaces.jpg"),
            ],
            check=True,
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=LIBRARY)
    parser.add_argument(
        "--font", default="/System/Library/Fonts/Supplemental/Arial.ttf"
    )
    args = parser.parse_args(
        sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    )
    render_review(args.out.resolve(), args.font)
