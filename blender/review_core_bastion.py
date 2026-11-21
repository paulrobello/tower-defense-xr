"""Fixed, matched Bastion Rib high/low views; the draft uses a CPU Cycles studio."""

import argparse
import hashlib
import subprocess
import sys
import tempfile
from pathlib import Path

import bpy
import numpy as np

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_materials import png
from review_materials import aim, area

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "assets"))
from ktx2 import DEFAULT_KTX, checked_ktx, decode_ktx2

VIEWS = {
    "front": ((0, -2.2, 0.50), (0, 0, 0.34), 1.15),
    "isometric": ((1.17, -1.82, 1.12), (0, 0, 0.34), 1.16),
    "detail": ((0.61, -1.02, 0.91), (0, 0, 0.48), 0.64),
    "underside": ((0.78, -1.38, -1.03), (0, 0, 0.20), 1.16),
}


def import_glb(path: Path) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if bpy.ops.import_scene.gltf(filepath=str(path)) != {"FINISHED"}:
        raise ValueError("Blender did not finish glTF import")


def use_decoded_maps(glb: Path, ktx: Path) -> None:
    """Blender imports PNG fallbacks. Render the verified KTX2 level-zero texels."""
    ktx = checked_ktx(ktx)
    with tempfile.TemporaryDirectory(prefix="core-ktx-review-") as temp:
        for role in ("basecolor", "normal", "orm", "emissive"):
            source_hash = hashlib.sha256(
                (glb.parent / f"{role}.png").read_bytes()
            ).digest()
            matches = [
                im
                for im in bpy.data.images
                if im.packed_file
                and hashlib.sha256(bytes(im.packed_file.data)).digest() == source_hash
            ]
            if len(matches) != 1:
                raise ValueError(f"{role}: expected one exact embedded source")
            raw = decode_ktx2(ktx, (glb.parent / f"{role}.ktx2").read_bytes())
            pixels = np.frombuffer(raw, np.uint8).reshape((2048, 2048, 4))
            path = Path(temp) / f"{role}.png"
            is_color = role in ("basecolor", "emissive")
            png(path, pixels[::-1, :, :3], is_color)
            replacement = bpy.data.images.load(str(path))
            replacement.colorspace_settings.name = "sRGB" if is_color else "Non-Color"
            replacement.pack()
            matches[0].user_remap(replacement)


def stage(cpu: bool) -> None:
    scene = bpy.context.scene
    scene.render.engine = "CYCLES" if cpu else "BLENDER_EEVEE"
    if cpu:
        scene.cycles.device, scene.cycles.samples = "CPU", 6
        scene.cycles.use_denoising = True
    else:
        scene.eevee.taa_render_samples = 24
    scene.render.resolution_x = scene.render.resolution_y = 512 if cpu else 768
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.use_stamp = False
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("Core studio world")
    scene.world = world
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (
        0.185,
        0.215,
        0.27,
        1,
    )
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.65
    scene.view_settings.view_transform = "AgX"
    area("Core key", (-0.95, -1.04, 1.5), 56, 1.20, 0.62)
    area("Core satin strip", (0.85, 0.20, 1.18), 48, 0.25, 1.25)
    area("Core face bounce", (0.10, -1.32, 0.60), 25, 0.81, 0.38)
    area("Core back rim", (-0.41, 0.82, 0.64), 26, 0.70, 0.24)
    area("Underbody bounce", (-0.42, -0.44, -0.64), 12, 0.52, 0.48)
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.001))
    floor = bpy.context.object
    floor.name = "Review ground"
    mat = bpy.data.materials.new("Core studio slate")
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (
        0.07,
        0.083,
        0.105,
        1,
    )
    mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.8
    floor.data.materials.append(mat)
    cam = bpy.data.objects.new("Core review camera", bpy.data.cameras.new("Core ortho"))
    scene.collection.objects.link(cam)
    cam.data.type, cam.data.clip_start = "ORTHO", 0.02
    scene.camera = cam


def render_file(
    path: Path,
    label: str,
    out: Path,
    cpu: bool,
    views: list[str],
    ktx: Path,
    motion: bool,
) -> None:
    if path.suffix == ".glb":
        import_glb(path)
        use_decoded_maps(path, ktx)
    else:
        bpy.ops.wm.open_mainfile(filepath=str(path))
    stage(cpu)
    scene = bpy.context.scene
    scene.frame_set(0)
    for name in views:
        pos, target, scale = VIEWS[name]
        cam = scene.camera
        cam.location = pos
        aim(cam, target)
        cam.data.ortho_scale = scale
        bpy.data.objects["Review ground"].hide_render = name == "underside"
        scene.render.filepath = str(out / f"{label}-{name}.png")
        bpy.ops.render.render(write_still=True)
    if motion:
        cam = scene.camera
        cam.location = (0.42, -0.68, 2.05)
        aim(cam, (0, 0, 0.23))
        cam.data.ortho_scale = 1.13
        bpy.data.objects["Review ground"].hide_render = False
        scene.render.resolution_x = scene.render.resolution_y = 384
        with tempfile.TemporaryDirectory(prefix="core-ring-motion-") as tmp:
            frames = []
            for frame in range(0, 24, 2):
                scene.frame_set(frame)
                image = Path(tmp) / f"{frame:02d}.png"
                scene.render.filepath = str(image)
                bpy.ops.render.render(write_still=True)
                frames.append(str(image))
            subprocess.run(
                [
                    "magick",
                    "-delay",
                    "1x12",
                    *frames,
                    "-loop",
                    "0",
                    "-quality",
                    "92",
                    str(out / "emitter-motion.webp"),
                ],
                check=True,
            )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--cpu-draft", action="store_true")
    parser.add_argument(
        "--motion",
        action="store_true",
        help="Render one second of the eightfold emitter sweep",
    )
    parser.add_argument("--ktx", type=Path, default=DEFAULT_KTX)
    parser.add_argument("--views", nargs="+", choices=VIEWS, default=list(VIEWS))
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    if bpy.app.version != (5, 2, 2):
        raise ValueError("Blender version mismatch")
    args.out.mkdir(parents=True, exist_ok=True)
    render_file(
        args.source.resolve(),
        args.label,
        args.out.resolve(),
        args.cpu_draft,
        args.views,
        args.ktx,
        args.motion,
    )


if __name__ == "__main__":
    main()
