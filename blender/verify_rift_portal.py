"""Inspect the exported frame, host interface and UV-registered field after Blender re-import."""

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
from mathutils import Matrix, Vector

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from review_core_bastion import checked_ktx, decode_ktx2, import_glb
from verify_core_bastion import atlas_metrics

EPSILON = 0.000002


def gltf_point(p: Vector) -> tuple:
    return tuple(round(float(v), 7) for v in (p.x, p.z, -p.y))


def bounds(verts: list[tuple]) -> list[list]:
    return [[min(c), max(c)] for c in zip(*verts, strict=True)]


def verify(path: Path, ktx: Path) -> dict:
    if bpy.app.version != (5, 2, 2):
        raise ValueError("Blender 5.2.2 required")
    import_glb(path)
    root, frame, field, anchor = (
        bpy.data.objects[n]
        for n in ("riftPortal", "portalFrame", "portalInterior", "apertureAnchor")
    )
    assert set(root.children) == {frame, field, anchor}
    assert root.matrix_world == Matrix.Identity(4)
    assert anchor.get("socket") is True and anchor.matrix_world == Matrix.Identity(4)
    assert gltf_point(field.location) == (0.0, 0.0, -0.025)
    frame_pts = [gltf_point(frame.matrix_world @ v.co) for v in frame.data.vertices]
    field_pts = [gltf_point(field.matrix_world @ v.co) for v in field.data.vertices]
    outer = bounds(frame_pts)
    aperture = bounds(field_pts)
    assert np.allclose(
        outer, [[-0.595, 0.595], [-0.795, 0.795], [-0.025, 0.047]], atol=EPSILON, rtol=0
    )
    assert np.allclose(
        aperture,
        [[-0.475, 0.475], [-0.675, 0.675], [-0.025, -0.025]],
        atol=EPSILON,
        rtol=0,
    )
    disk_uv = field.data.uv_layers.active
    assert len(field.data.uv_layers) == len(frame.data.uv_layers) == 1
    for loop in field.data.loops:
        x, y, _ = field_pts[loop.vertex_index]
        u, v = disk_uv.data[loop.index].uv
        assert math.isclose(u, 0.5 + x / 0.95, abs_tol=EPSILON) and math.isclose(
            v, 0.5 + y / 1.35, abs_tol=EPSILON
        )
    assert all(p.normal.y < -0.99999 for p in field.data.polygons)
    ring = {p for p in field_pts if abs(p[0]) + abs(p[1]) > EPSILON}
    frame_rear = {p for p in frame_pts if p[2] == -0.025}
    assert ring <= frame_rear
    assert all(
        abs((x / 0.475) ** 2 + (y / 0.675) ** 2 - 1) < EPSILON for x, y, _ in ring
    )
    assert all(
        (x / 0.475) ** 2 + (y / 0.675) ** 2 >= 1 - EPSILON for x, y, _ in frame_pts
    )
    angles = sorted(math.atan2(y / 0.675, x / 0.475) % math.tau for x, y, _ in ring)
    max_angle = max((b - a) % math.tau for a, b in zip(angles, angles[1:] + angles[:1]))
    wall_contacts = {p for p in frame_pts if p[2] == 0.0}
    assert len(wall_contacts) == len(ring) * 2
    for pitch, spin in ((0, 0), (90, 0), (34, 59)):
        root.rotation_euler = (math.radians(pitch), 0, math.radians(spin))
        bpy.context.view_layer.update()
        forward = (root.matrix_world.to_3x3() @ Vector((0, -1, 0))).normalized()
        depth = (field.matrix_world.translation - anchor.matrix_world.translation).dot(
            forward
        )
        assert abs(depth + 0.025) < EPSILON
    packed = {
        hashlib.sha256(bytes(im.packed_file.data)).digest()
        for im in bpy.data.images
        if im.packed_file
    }
    maps = ["basecolor", "normal", "orm", "emissive", "vortex"]
    for name in maps:
        assert (
            hashlib.sha256(path.with_name(name + ".png").read_bytes()).digest()
            in packed
        )
    budget = atlas_metrics(path, ktx)
    data = path.with_name("vortex.ktx2").read_bytes()
    levels = struct.unpack_from("<I", data, 40)[0]
    uncompressed = sum(
        struct.unpack_from("<3Q", data, 80 + i * 24)[2] for i in range(levels)
    )
    raw = decode_ktx2(checked_ktx(ktx), data)
    assert len(raw) == 1024 * 1024 * 4
    image = bpy.data.images.load(str(path.with_name("vortex.png")))
    image.colorspace_settings.name = "Non-Color"
    source = np.empty((1024, 1024, 4), np.float32)
    image.pixels.foreach_get(source.ravel())
    reference = np.rint(source[::-1, :, :3] * 255)
    decoded = np.frombuffer(raw, np.uint8).reshape((1024, 1024, 4))[:, :, :3]
    rmse = float(np.sqrt(np.mean((decoded - reference) ** 2)))
    assert rmse < 3
    budget["textures"]["vortex"] = {
        "level0_rmse_rgb8": round(rmse, 3),
        "bytes": len(data),
        "mip_levels": levels,
        "uastc_mip_bytes_before_zstd": uncompressed,
    }
    budget["ktx2_bytes"] += len(data)
    budget["uastc_bytes_before_zstd"] += uncompressed
    tris = {o.name: len(o.data.polygons) for o in (frame, field)}
    assert sum(tris.values()) <= 4500
    return {
        "glb_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "blender": bpy.app.version_string,
        "root": root.name,
        "socket": anchor.name,
        "triangles": tris,
        "gltf_frame_bounds_m": outer,
        "gltf_aperture_bounds_m": aperture,
        "rim_width_m_at_axes": 0.12,
        "anchor_plane_m": 0.0,
        "frontmost_m": outer[2][1],
        "inner_bezel_m": -0.015,
        "shader_plane_m": -0.025,
        "boundary_vertices_shared_with_frame": len(ring),
        "wall_contact_vertices": len(wall_contacts),
        "maximum_ellipse_chord_error_bound_m": 0.675 * (1 - math.cos(max_angle / 2)),
        "shader_uv": "u=0.5+x/0.95, Blender v=0.5+y/1.35; glTF v=0.5-y/1.35",
        "tested_transform_pitch_spin_degrees": [[0, 0], [90, 0], [34, 59]],
        "embedded_png_fallbacks_verified": len(maps),
        "budgets": budget,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ("glb", "ktx", "report"):
        parser.add_argument("--" + name, required=True, type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    args.report.write_text(
        json.dumps(verify(args.glb.resolve(), args.ktx.resolve()), indent=2) + "\n"
    )
