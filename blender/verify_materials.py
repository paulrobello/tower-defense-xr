"""Reopen the material library and export a scratch GLB to check each texture binding."""

import argparse
import hashlib
import json
import struct
import sys
import tempfile
from pathlib import Path

import bpy
import numpy as np
import OpenImageIO as oiio

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from materials import LIBRARY, SURFACES

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "assets"))
from ktx2 import (
    DEFAULT_KTX,
    checked_ktx,
    decode_ktx2,
    validate_pixels,
    validate_texture,
)


def inspect(directory: Path) -> dict:
    bpy.ops.wm.open_mainfile(filepath=str(directory / "bastion-materials.blend"))
    report = json.loads((directory / "maps.json").read_text())
    names = {f"RB.{slug}" for slug in SURFACES}
    if names != {m.name for m in bpy.data.materials if m.asset_data}:
        raise ValueError(
            "Editable Blender asset catalog differs from the five surfaces"
        )
    for index, (slug, spec) in enumerate(SURFACES.items()):
        mat = bpy.data.materials[f"RB.{slug}"]
        if abs(mat["tile_m"] - spec.tile_m) > 1e-7:
            raise ValueError(f"{slug}: tile scale differs")
        roles = report["materials"][slug]["maps"]
        for role, record in roles.items():
            image = bpy.data.images[f"{slug}.{role}"]
            path = Path(bpy.path.abspath(image.filepath))
            if path.resolve() != directory / slug / f"{role}.png":
                raise ValueError(
                    f"{slug}: wrong or non-relocatable {role} image path {image.filepath}"
                )
            if hashlib.sha256(path.read_bytes()).hexdigest() != record["sha256"]:
                raise ValueError(f"{slug}: {role} hash differs from the bake")
            space = "sRGB" if role in {"basecolor", "emissive"} else "Non-Color"
            if image.colorspace_settings.name != space or tuple(image.size) != (
                256,
                256,
            ):
                raise ValueError(
                    f"{slug}: {role} transfer function or dimensions differ"
                )
        bpy.ops.mesh.primitive_plane_add(size=spec.tile_m, location=(index, 0, 0))
        bpy.context.object.data.materials.append(mat)
    with tempfile.TemporaryDirectory(prefix="rift-material-export-") as tmp:
        glb = Path(tmp) / "bindings.glb"
        bpy.ops.export_scene.gltf(
            filepath=str(glb),
            export_format="GLB",
            export_tangents=True,
            use_active_scene=True,
            export_image_format="AUTO",
        )
        data = glb.read_bytes()
        json_len = struct.unpack_from("<I", data, 12)[0]
        doc = json.loads(data[20 : 20 + json_len])
        binary = data[28 + json_len :]
        textures = doc["textures"]

        def map_hash(slot: dict) -> str:
            image = doc["images"][textures[slot["index"]]["source"]]
            view = doc["bufferViews"][image["bufferView"]]
            start = view.get("byteOffset", 0)
            if slot.get("texCoord", 0) != 0 or image["mimeType"] != "image/png":
                raise ValueError("Scratch GLB changed image format or UV0")
            return hashlib.sha256(
                binary[start : start + view["byteLength"]]
            ).hexdigest()

        bindings = {}
        for mat in doc["materials"]:
            slug = mat["name"].removeprefix("RB.")
            pbr = mat["pbrMetallicRoughness"]
            slots = {
                "basecolor": pbr["baseColorTexture"],
                "normal": mat["normalTexture"],
                "orm": pbr["metallicRoughnessTexture"],
            }
            if map_hash(mat["occlusionTexture"]) != map_hash(slots["orm"]):
                raise ValueError(
                    f"{slug}: AO and metallic/roughness use different images"
                )
            if "emissiveTexture" in mat:
                slots["emissive"] = mat["emissiveTexture"]
            actual = {role: map_hash(slot) for role, slot in slots.items()}
            expected = {
                role: rec["sha256"]
                for role, rec in report["materials"][slug]["maps"].items()
            }
            if expected != actual:
                raise ValueError(
                    f"{slug}: exported texture bindings differ from source: {actual}"
                )
            bindings[slug] = actual
        if set(bindings) != set(SURFACES):
            raise ValueError("Scratch GLB dropped a material")
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(glb))
        imported = {m.name for m in bpy.data.materials if m.name.startswith("RB.")}
        if imported != names or len(
            [o for o in bpy.data.objects if o.type == "MESH"]
        ) != len(names):
            raise ValueError("glTF re-import dropped a mesh or material")
    return bindings


def image_metrics(directory: Path) -> dict:
    ktx = checked_ktx(DEFAULT_KTX)
    manifest = json.loads((directory / "manifest.json").read_text())
    metrics = {}
    for record in manifest["textures"]:
        path = directory / record["file"]
        source = oiio.ImageInput.open(str(path.with_suffix(".png")))
        try:
            pixels = source.read_image(oiio.UINT8).astype(float)
        finally:
            source.close()
        if not (
            np.array_equal(pixels[0], pixels[-1])
            and np.array_equal(pixels[:, 0], pixels[:, -1])
        ):
            raise ValueError(f"{path}: opposite source edges differ")
        data = path.read_bytes()
        decoded = decode_ktx2(ktx, data)
        width, height = validate_texture(data, record, None)
        validate_pixels(decoded, width, height, record)
        rgb = (
            np.frombuffer(decoded, dtype=np.uint8)
            .reshape(256, 256, 4)[:, :, :3]
            .astype(float)
        )
        errors = rgb - pixels
        seam = np.abs(np.vstack((rgb[0] - rgb[-1], rgb[:, 0] - rgb[:, -1])))
        stats = {
            "rmse_rgb_levels": np.sqrt(np.mean(errors**2, axis=(0, 1)))
            .round(3)
            .tolist(),
            "wrap_rgb_absolute_p95_levels": np.percentile(seam, 95, axis=0)
            .round(3)
            .tolist(),
            "wrap_rgb_absolute_max_levels": seam.max(axis=0).tolist(),
        }
        if record["role"] == "normal":
            norm = np.linalg.norm(rgb / 127.5 - 1, axis=-1)
            stats["decoded_normal_length"] = [
                round(float(f(norm)), 5) for f in (np.min, np.max)
            ]
        metrics[record["file"]] = stats
    return metrics


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=LIBRARY)
    ap.add_argument(
        "--metrics", type=Path, help="Write decoded KTX2-vs-PNG measurements."
    )
    args = ap.parse_args(
        sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    )
    directory = args.out.resolve()
    result = inspect(directory)
    metrics = image_metrics(directory)
    if args.metrics:
        args.metrics.write_text(json.dumps(metrics, indent=2) + "\n")
    print(
        f"Verified {len(result)} editable materials and {sum(map(len, result.values()))} exact GLB image bindings."
    )
