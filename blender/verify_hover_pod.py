"""Re-import the exact GLBs and measure their neutral mount, world pose and decoded maps."""

import argparse
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path[:0] = [
    str(HERE),
    str(HERE.parent / "scripts"),
    str(HERE.parent / "scripts/assets"),
]
from hover_pod_shape import CORE, RING
from package_core_bastion import digest, write_json
from review_core_bastion import checked_ktx, decode_ktx2, import_glb
from validate_glbs import check_overlap, cross, subtract, unit
from verify_core_bastion import atlas_metrics, points
from verify_surface_clamp import verify_albedo

EPS = 0.000002


def shells(nodes: list) -> dict:
    faces = []
    for node in nodes:
        coords = points(node)
        indices = [tuple(face.vertices) for face in node.data.polygons]
        tree = BVHTree.FromPolygons(coords, indices, all_triangles=True)
        # glTF may split one geometric vertex at a hard normal or UV seam.
        keys = [
            {tuple(round(v, 7) for v in coords[i]) for i in face} for face in indices
        ]
        crossings = [
            (a, b)
            for a, b in tree.overlap(tree)
            if a < b and keys[a].isdisjoint(keys[b])
        ]
        assert not crossings, (node.name, crossings[:5])
        for face in node.data.polygons:
            tri = tuple(tuple(coords[i]) for i in face.vertices)
            normal = unit(cross(subtract(tri[1], tri[0]), subtract(tri[2], tri[0])))
            faces.append((tri, normal, f"{node.name}.{face.index}"))
    check_overlap(faces)
    return {
        "triangles": len(faces),
        "positive_area_coplanar_pairs": 0,
        "nonadjacent_triangle_intersections": 0,
    }


def measure(path: Path, decoded: dict) -> tuple:
    import_glb(path)
    root = bpy.data.objects["hoverPod"]
    socket = bpy.data.objects["mountSocket"]
    ring, core = bpy.data.objects[RING], bpy.data.objects[CORE]
    assert {n.name for n in root.children} == {RING, CORE, "mountSocket"}
    assert root.matrix_world == socket.matrix_world == Matrix.Identity(4)
    assert socket.parent == root and socket.get("socket") is True
    assert (
        ring.active_material == core.active_material
        and len(ring.data.materials) == len(core.data.materials) == 1
    )
    assert ring.active_material.name == "Hover Pod satin armor"
    radial = [p.xy.length for p in points(ring)]
    core_points = points(core)
    top, bottom = max(p.z for p in core_points), min(p.z for p in core_points)
    assert abs(top - 0.070) < EPS and abs(bottom) < EPS
    assert (
        0.150 < max(radial) < 0.16
        and min(radial) - max(p.xy.length for p in core_points) > 0.017
    )
    ring_pts = [p.xy.length for p in points(ring) if abs(p.z - 0.026) < EPS]
    assert ring_pts and all(abs(r - 0.145) < EPS for r in ring_pts)
    evidence = shells([ring, core])
    uv_faces, lit, bearing_metal = [], {}, []
    for obj in (ring, core):
        uv = obj.data.uv_layers.active
        assert len(obj.data.uv_layers) == 1
        pts = points(obj)
        for f in obj.data.polygons:
            tri = tuple((*uv.data[j].uv, 0.0) for j in f.loop_indices)
            assert all(0 <= x <= 1 for v in tri for x in v[:2])
            uv_faces.append((tri, (0.0, 0.0, 1.0), f"{obj.name}.{f.index}"))
            if obj == core:
                heights = [pts[i].z for i in f.vertices]
                if abs(min(heights) - 0.038) < EPS and abs(max(heights) - 0.054) < EPS:
                    for weights in (
                        (1 / 3, 1 / 3, 1 / 3),
                        (0.6, 0.2, 0.2),
                        (0.2, 0.6, 0.2),
                        (0.2, 0.2, 0.6),
                    ):
                        u, v, _ = np.asarray(weights) @ np.asarray(tri)
                        bearing_metal.append(
                            int(decoded["orm"][1023 - int(v * 1024), int(u * 1024), 2])
                        )
                continue
            radii = [pts[i].xy.length for i in f.vertices]
            peak = max(radii)
            if (
                abs(peak - 0.145) < EPS
                and abs(min(radii) - 0.140) < EPS
                and max(pts[i].z for i in f.vertices) < 0.027
            ):
                side = "underside"
            elif abs(peak - 0.149) < EPS and abs(min(radii) - 0.145) < EPS:
                side = "outer_face"
            else:
                continue
            center = np.mean(np.array(tri), axis=0)
            rgb = decoded["emissive"][
                1023 - int(1024 * center[1]), int(1024 * center[0]), :3
            ]
            lit.setdefault(side, []).append(
                (bool(rgb[1] > 95 and rgb[2] > 120 and rgb[2] > rgb[0] * 1.4), f.area)
            )
    luminous = {
        side: round(
            sum(area for on, area in samples if on) / sum(area for _, area in samples),
            4,
        )
        for side, samples in lit.items()
    }
    assert (
        set(luminous) == {"outer_face", "underside"} and min(luminous.values()) > 0.78
    ), luminous
    assert bearing_metal and max(bearing_metal) < 36, (
        "ceramic shoulder metallic range",
        min(bearing_metal),
        max(bearing_metal),
    )
    poses = {}
    root.rotation_mode = "XYZ"
    for depth, yaw in ((0.8, 0.0), (2.3, 0.65), (5, -1.21)):
        root.location = (0.24, -depth, 1.2)
        root.rotation_euler = (0, 0, yaw)
        bpy.context.view_layer.update()
        forward = socket.matrix_world.to_3x3() @ Vector((0, -1, 0))
        up = socket.matrix_world.to_3x3() @ Vector((0, 0, 1))
        assert (up - Vector((0, 0, 1))).length < EPS
        assert (forward - Vector((math.sin(yaw), -math.cos(yaw), 0))).length < EPS
        assert (
            socket.matrix_world.translation - Vector((0.24, -depth, 1.2))
        ).length < EPS
        assert abs(max(p.z for p in points(core)) - 1.27) < EPS
        poses[str(depth)] = {
            "yaw_degrees": round(math.degrees(yaw), 4),
            "world_forward_blender": list(forward),
        }
    return {
        **evidence,
        "glb_sha256": digest(path),
        "radius_m": round(max(radial), 7),
        "bottom_m": round(bottom, 7),
        "height_m": round(top, 7),
        "emitter_radius_m": round(max(ring_pts), 7),
        "radial_air_gap_m": round(
            min(radial) - max(p.xy.length for p in core_points), 7
        ),
        "decoded_cyan_area_fraction": luminous,
        "poses": poses,
        "ceramic_shoulder_metallic_u8": {
            "interior_samples": len(bearing_metal),
            "min": min(bearing_metal),
            "max": max(bearing_metal),
        },
        "unlit_albedo": verify_albedo(uv_faces, decoded["basecolor"]),
    }, uv_faces


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--piece", type=Path, required=True)
    parser.add_argument("--ktx", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    piece, ktx = args.piece.resolve(), checked_ktx(args.ktx)
    assert bpy.app.version == (5, 2, 2)
    bpy.ops.wm.open_mainfile(filepath=str(piece / "high.blend"))
    evidence = {"high": shells([bpy.data.objects[RING], bpy.data.objects[CORE]])}
    decoded = {
        role: np.frombuffer(
            decode_ktx2(ktx, (piece / f"{role}.ktx2").read_bytes()), np.uint8
        ).reshape(1024, 1024, 4)
        for role in ("basecolor", "emissive", "orm")
    }
    charts = []
    for level in ("lod0", "lod1"):
        path = piece / f"hover-pod-{level}.glb"
        evidence[level], uv = measure(path, decoded)
        evidence[level]["atlas"] = atlas_metrics(path, ktx)
        charts.extend(uv)
    check_overlap(charts)
    evidence["combined_uv0_positive_area_overlaps"] = 0
    write_json(piece / "reimport.json", evidence)


if __name__ == "__main__":
    main()
