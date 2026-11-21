"""Bake the authored UV fields on a triangulated unit square with Cycles."""

import argparse
import hashlib
import json
import struct
import sys
import zlib
from pathlib import Path

import bpy
import numpy as np

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from materials import LIBRARY, SURFACES, material
from surface_fields import channels


def png(path: Path, pixels: np.ndarray, srgb: bool) -> None:
    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload))
        )

    height, width = pixels.shape[:2]
    raw = b"".join(b"\x00" + row.tobytes() for row in pixels[::-1])
    transfer = (
        chunk(b"sRGB", b"\x00") if srgb else chunk(b"gAMA", struct.pack(">I", 100000))
    )
    header = struct.pack(">2I5B", width, height, 8, 2, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + transfer
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def bake_map(
    role: str, field: np.ndarray, path: Path, tree: bpy.types.ShaderNodeTree
) -> np.ndarray:
    encoded = np.pad(field, ((0, 1), (0, 1), (0, 0)), mode="wrap")
    size = len(encoded)
    rgba = np.ones((size, size, 4), dtype=np.float32)
    is_color = role in {"basecolor", "emissive"}
    rgba[:, :, :3] = (
        np.where(
            encoded <= 0.04045, encoded / 12.92, ((encoded + 0.055) / 1.055) ** 2.4
        )
        if is_color
        else encoded
    )
    source = bpy.data.images.new(
        "SurfaceField", size, size, float_buffer=True, is_data=True
    )
    source.pixels.foreach_set(rgba.ravel())
    source.update()
    source_node = tree.nodes.new("ShaderNodeTexImage")
    source_node.image = source
    source_node.interpolation = "Closest"
    emit = tree.nodes["Emission"]
    normal = tree.nodes["Normal Map"]
    shader = tree.nodes["Principled BSDF"]
    output = tree.nodes["Material Output"]
    tree.links.new(
        source_node.outputs["Color"],
        normal.inputs["Color"] if role == "normal" else emit.inputs["Color"],
    )
    tree.links.new(
        shader.outputs["BSDF"] if role == "normal" else emit.outputs["Emission"],
        output.inputs["Surface"],
    )
    target = bpy.data.images.new(
        "CyclesBake", size, size, float_buffer=True, is_data=True
    )
    dest = tree.nodes.new("ShaderNodeTexImage")
    dest.image = target
    tree.nodes.active = dest
    bpy.ops.object.bake(
        type="NORMAL" if role == "normal" else "EMIT",
        normal_space="TANGENT",
        margin=0,
        use_clear=True,
    )
    result = np.empty_like(rgba)
    target.pixels.foreach_get(result.ravel())
    rgb = np.clip(result[:, :, :3], 0, 1)
    if is_color:
        rgb = np.where(rgb <= 0.0031308, 12.92 * rgb, 1.055 * rgb ** (1 / 2.4) - 0.055)
    pixels = np.rint(rgb * 255).astype(np.uint8)
    reference = np.rint(np.clip(encoded, 0, 1) * 255).astype(np.uint8)
    error = np.max(np.abs(pixels.astype(int) - reference.astype(int)))
    if error > 1:
        raise ValueError(
            f"{path}: bake deviated from the source by {error} byte levels"
        )
    if not (
        np.array_equal(pixels[0], pixels[-1])
        and np.array_equal(pixels[:, 0], pixels[:, -1])
    ):
        raise ValueError(f"{path}: opposite tile edges differ")
    png(path, pixels, role in {"basecolor", "emissive"})
    tree.nodes.remove(source_node)
    tree.nodes.remove(dest)
    bpy.data.images.remove(source)
    bpy.data.images.remove(target)
    return pixels


def build(out: Path) -> None:
    if bpy.app.version != (5, 2, 2):
        raise ValueError(f"Expected Blender 5.2.2, got {bpy.app.version_string}")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 1
    scene.render.threads_mode = "FIXED"
    scene.render.threads = 2
    bpy.ops.mesh.primitive_plane_add()
    plane = bpy.context.object
    modifier = plane.modifiers.new("Fixed bake diagonal", "TRIANGULATE")
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    bake = bpy.data.materials.new("Field transfer")
    plane.data.materials.append(bake)
    tree = bake.node_tree
    normal = tree.nodes.new("ShaderNodeNormalMap")
    tree.links.new(
        normal.outputs["Normal"], tree.nodes["Principled BSDF"].inputs["Normal"]
    )
    emit = tree.nodes.new("ShaderNodeEmission")
    tree.links.new(
        emit.outputs["Emission"], tree.nodes.get("Material Output").inputs["Surface"]
    )
    summary = {}
    for key, spec in SURFACES.items():
        folder = out / key
        folder.mkdir(parents=True, exist_ok=True)
        records = {}
        for role, field in channels(key, 255, spec.tile_m).items():
            image = folder / f"{role}.png"
            pixels = bake_map(role, field, image, tree)
            probe_positions = [(29, 37), (127, 83), (210, 190)]
            facts = {}
            if role == "normal":
                normals = pixels.astype(float) / 127.5 - 1
                lengths = np.linalg.norm(normals, axis=-1)
                if np.max(np.abs(lengths - 1)) > 0.007 or normals[:, :, 2].min() <= 0:
                    raise ValueError(f"{key}: invalid tangent normals")
                flat_index = np.argmin(np.linalg.norm(normals[:, :, :2], axis=-1))
                y, x = np.unravel_index(flat_index, lengths.shape)
                probe_positions.append((int(x), 255 - int(y)))
                facts["normal_length"] = [
                    round(float(f(lengths)), 6) for f in (np.min, np.max)
                ]
            elif role == "emissive":
                for index in (1, 2):
                    y, x = np.unravel_index(
                        np.argmax(pixels[:, :, index]), pixels.shape[:2]
                    )
                    probe_positions.append((int(x), 255 - int(y)))
            elif role == "orm":
                for index, bounds in [(1, spec.roughness), (2, spec.metallic)]:
                    measured = pixels[:, :, index] / 255
                    if measured.min() < bounds[0] or measured.max() > bounds[1]:
                        raise ValueError(f"{key}: outside {bounds}")
                for extreme, index in [(np.argmin, 0), (np.argmax, 1)]:
                    y, x = np.unravel_index(
                        extreme(pixels[:, :, index]), pixels.shape[:2]
                    )
                    probe_positions.append((int(x), 255 - int(y)))
                facts["ao_mean_p05"] = [
                    round(float(v), 5)
                    for v in (
                        pixels[:, :, 0].mean() / 255,
                        np.percentile(pixels[:, :, 0], 5) / 255,
                    )
                ]
            samples = [
                {"x": x, "y": y, "rgb": pixels[255 - y, x].tolist(), "tolerance": 12}
                for x, y in probe_positions
            ]
            if role == "normal":
                samples[-1]["tolerance"] = 4
            records[role] = {
                "sha256": sha(image),
                "min_rgb": pixels.min(axis=(0, 1)).tolist(),
                "max_rgb": pixels.max(axis=(0, 1)).tolist(),
                "samples": samples,
                **facts,
            }
        summary[key] = {
            "tile_m": spec.tile_m,
            "texels_per_m": round(256 / spec.tile_m, 3),
            "maps": records,
        }
    bpy.data.objects.remove(plane, do_unlink=True)
    bpy.data.materials.remove(bake)
    for key in SURFACES:
        mat = material(key, out)
        mat.use_fake_user = True
        mat.asset_mark()
    # The source .blend is relocatable next to its map directories.
    scene.render.engine = "BLENDER_EEVEE"
    bpy.context.preferences.filepaths.save_version = 0
    for image in bpy.data.images:
        if image.filepath:
            image.filepath = "//" + Path(image.filepath).relative_to(out).as_posix()
    bpy.ops.wm.save_as_mainfile(
        filepath=str(out / "bastion-materials.blend"),
        compress=True,
        relative_remap=False,
    )
    report = {
        "generator": "Blender 5.2.2 LTS, Cycles CPU, 2 threads, 1 sample, EMIT and tangent NORMAL",
        "resolution": [256, 256],
        "normal_convention": "OpenGL tangent +Y",
        "orm_channels": ["ambientOcclusion", "roughness", "metallic"],
        "materials": summary,
    }
    (out / "maps.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=LIBRARY)
    args = ap.parse_args(
        sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    )
    build(args.out.resolve())
