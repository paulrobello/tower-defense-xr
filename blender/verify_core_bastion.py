"""Measure the exact staged GLB after Blender import and sample both controls."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from core_bastion_shape import COLLAR, CRYSTAL, EMITTER, PEDESTAL, PIVOTS
from review_core_bastion import DEFAULT_KTX, checked_ktx, decode_ktx2, import_glb


def near(a: float, b: float) -> bool:
    return abs(a - b) < 1e-5


def points(obj: bpy.types.Object) -> list[Vector]:
    return [obj.matrix_world @ v.co for v in obj.data.vertices]


def bounds(obj: bpy.types.Object) -> dict:
    xyz = points(obj)
    r = [math.hypot(p.x, p.y) for p in xyz]
    return {
        "radial_min_m": min(r),
        "radial_max_m": max(r),
        "bottom_m": min(p.z for p in xyz),
        "top_m": max(p.z for p in xyz),
        "triangles": len(obj.data.polygons),
    }


def verify(path: Path) -> dict:
    import_glb(path)
    scene = bpy.context.scene
    scene.frame_set(0)
    root = bpy.data.objects["coreBastion"]
    assert root.parent is None and root.location.length < 1e-7
    assert {obj.name for obj in root.children} == set(PIVOTS)
    result = {}
    for name, height in PIVOTS.items():
        obj = bpy.data.objects[name]
        assert (
            near(obj.location.z, height)
            and near(obj.location.x, 0)
            and near(obj.location.y, 0)
        )
        assert len(obj.data.uv_layers) == 1 and all(
            len(p.vertices) == 3 for p in obj.data.polygons
        )
        result[name] = bounds(obj)
    shoe, gem, ring = result[PEDESTAL], result[CRYSTAL], result[EMITTER]
    assert near(shoe["bottom_m"], 0) and near(shoe["radial_max_m"], 0.38)
    assert near(gem["top_m"], 0.72) and near(gem["bottom_m"], 0.42)
    assert (
        max(
            (p - Vector((0, 0, 0.57))).length for p in points(bpy.data.objects[CRYSTAL])
        )
        <= 0.15001
    )
    assert 0.485 - 1e-5 <= ring["radial_min_m"] <= ring["radial_max_m"] <= 0.52 + 1e-5
    assert ring["radial_min_m"] > shoe["radial_max_m"]
    assert sum(v["triangles"] for v in result.values()) <= 14000
    collars = result[COLLAR]
    assert (
        collars["radial_min_m"] > gem["radial_max_m"]
        and collars["bottom_m"] > shoe["top_m"]
    )
    # Save the neutral coordinates and verify animation from the imported GLB NLA tracks.
    emitter = bpy.data.objects[EMITTER]
    scene.frame_set(0)
    original = points(emitter)[0]
    rotations = []
    for sec in (0, 0.5, 1, 2, 4, 6, 8):
        scene.frame_set(int(sec * scene.render.fps))
        bpy.context.view_layer.update()
        p = points(emitter)[0]
        angle = math.atan2(
            original.x * p.y - original.y * p.x, original.x * p.x + original.y * p.y
        )
        expected = sec * math.tau / 8
        assert math.cos(angle - expected) > 0.997, (sec, angle)
        assert near(p.z, original.z) and near(
            math.hypot(p.x, p.y), math.hypot(original.x, original.y)
        )
        rotations.append(
            {"seconds": sec, "world_angle_deg": round(math.degrees(angle) % 360, 3)}
        )
    scene.frame_set(0)
    crystal = bpy.data.objects[CRYSTAL]
    crystal.rotation_mode = "XYZ"
    rest = crystal.location.copy()
    sample_idx = max(
        range(len(crystal.data.vertices)),
        key=lambda i: crystal.data.vertices[i].co.xy.length,
    )
    lateral = points(crystal)[sample_idx].xy
    neutral_pedestal = points(bpy.data.objects[PEDESTAL])
    for offset in (-0.018, 0, 0.018):
        crystal.location.z = rest.z + offset
        crystal.rotation_euler.z = 0.9
        bpy.context.view_layer.update()
        assert near(bounds(crystal)["top_m"], 0.72 + offset)
        sample = points(crystal)[sample_idx].xy
        assert near(sample.length, lateral.length) and near(lateral.angle(sample), 0.9)
        assert all(
            (a - b).length < 1e-7
            for a, b in zip(
                neutral_pedestal, points(bpy.data.objects[PEDESTAL]), strict=True
            )
        )
    contents = {
        hashlib.sha256(bytes(img.packed_file.data)).hexdigest()
        for img in bpy.data.images
        if img.packed_file
    }
    for role in ("basecolor", "normal", "orm", "emissive"):
        assert (
            hashlib.sha256((path.parent / f"{role}.png").read_bytes()).hexdigest()
            in contents
        )
    return {
        "glb_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "blender": bpy.app.version_string,
        "controls_blender_z_up": result,
        "emitter_motion": rotations,
        "sampled_crystal_bob_m": [-0.018, 0, 0.018],
        "embedded_png_fallbacks_verified": 4,
        "root": "coreBastion",
        "placement_keepout_m": 0.55,
        "runtime_shield_dome_radius_m": 0.52,
    }


def atlas_metrics(path: Path, ktx: Path) -> dict:
    ktx = checked_ktx(ktx)
    maps = {}
    for role in ("basecolor", "normal", "orm", "emissive"):
        source = path.parent / f"{role}.png"
        image = bpy.data.images.load(str(source), check_existing=False)
        image.colorspace_settings.name = "Non-Color"
        width, height = image.size
        rgba = np.empty((height, width, 4), np.float32)
        image.pixels.foreach_get(rgba.ravel())
        ref = np.rint(rgba[::-1, :, :3] * 255)
        bpy.data.images.remove(image)
        data = (path.parent / f"{role}.ktx2").read_bytes()
        level_count = struct.unpack_from("<I", data, 40)[0]
        level_bytes = sum(
            struct.unpack_from("<3Q", data, 80 + i * 24)[2] for i in range(level_count)
        )
        decoded = np.frombuffer(decode_ktx2(ktx, data), np.uint8).reshape(
            (height, width, 4)
        )[:, :, :3]
        stats = {
            "bytes": len(data),
            "mip_levels": level_count,
            "uastc_mip_bytes_before_zstd": level_bytes,
            "level0_rmse_rgb8": round(float(np.sqrt(np.mean((decoded - ref) ** 2))), 3),
        }
        if role == "normal":
            v = decoded.astype(np.float32) / 127.5 - 1
            lengths = np.linalg.norm(v, axis=2)
            stats["decoded_unit_length_range"] = [
                round(float(lengths.min()), 6),
                round(float(lengths.max()), 6),
            ]
        maps[role] = stats
    raw = path.read_bytes()
    json_length = struct.unpack_from("<I", raw, 12)[0]
    gltf = json.loads(raw[20 : 20 + json_length])
    primitives = [p for m in gltf["meshes"] for p in m["primitives"]]
    return {
        "textures": maps,
        "file_bytes": len(raw),
        "primitives": len(primitives),
        "gltf_vertices": sum(
            gltf["accessors"][p["attributes"]["POSITION"]]["count"] for p in primitives
        ),
        "ktx2_bytes": sum(m["bytes"] for m in maps.values()),
        "uastc_bytes_before_zstd": sum(
            m["uastc_mip_bytes_before_zstd"] for m in maps.values()
        ),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--glb", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--ktx", type=Path, default=DEFAULT_KTX)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    if bpy.app.version != (5, 2, 2):
        raise ValueError("Expected Blender 5.2.2 LTS")
    report = verify(args.glb.resolve())
    report["budgets"] = atlas_metrics(args.glb.resolve(), args.ktx)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
