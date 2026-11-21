"""Reimport both GLBs and verify the mount frame, contact pads, pivot pose and UV atlas."""

import argparse
import math
import sys
from itertools import combinations
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
from package_core_bastion import digest, write_json
from review_core_bastion import decode_ktx2, import_glb
from surface_clamp_shape import HUB, LEG_ANGLES, LEGS, PIVOTS
from validate_glbs import check_overlap, cross, subtract, unit
from verify_core_bastion import atlas_metrics

EPS = 0.000002


def points(obj: bpy.types.Object) -> list:
    return [obj.matrix_world @ v.co for v in obj.data.vertices]


def check_shells(nodes: dict) -> dict:
    trees = {}
    coords = {}
    faces = []
    for name, node in nodes.items():
        pts = points(node)
        coords[name] = pts
        indices = [tuple(face.vertices) for face in node.data.polygons]
        trees[name] = BVHTree.FromPolygons(pts, indices, all_triangles=True)
        for i, idx in enumerate(indices):
            tri = tuple(tuple(pts[k]) for k in idx)
            n = unit(cross(subtract(tri[1], tri[0]), subtract(tri[2], tri[0])))
            faces.append((tri, n, f"{name}.{i}"))
    check_overlap(faces)
    for a, b in combinations(LEGS, 2):
        assert not trees[a].overlap(trees[b])
    seams = {}
    for name, angle in zip(LEGS, LEG_ANGLES, strict=True):
        hits = trees[HUB].overlap(trees[name])
        for _, i in hits:
            for vi in nodes[name].data.polygons[i].vertices:
                p = coords[name][vi]
                radial = p.x * math.cos(angle) + p.y * math.sin(angle)
                across = -p.x * math.sin(angle) + p.y * math.cos(angle)
                assert (
                    0.0775 - EPS <= radial <= 0.084 + EPS
                    and abs(across) <= 0.009 + EPS
                    and 0.024 - EPS <= p.z <= 0.036 + EPS
                ), (name, i, radial, across, p.z)
        seams[name] = len(hits)
    return {
        "positive_area_coplanar_pairs": 0,
        "inter_leg_intersections": 0,
        "hub_intersections_outside_recessed_heel_key": 0,
        "key_to_hub_triangle_pairs": seams,
    }


def geometry(path: Path) -> tuple:
    import_glb(path)
    root, socket = bpy.data.objects["surfaceClamp"], bpy.data.objects["mountSocket"]
    assert root.matrix_world == socket.matrix_world == Matrix.Identity(4)
    assert socket.parent == root and socket.get("socket") is True
    nodes = {n.name: n for n in root.children if n.type == "MESH"}
    assert set(nodes) == set(PIVOTS)
    for name, node in nodes.items():
        assert (node.location - Vector(PIVOTS[name])).length < EPS
        assert (node.matrix_local.to_quaternion().angle) < EPS
    radius = max(p.xy.length for node in nodes.values() for p in points(node))
    assert 0.157 < radius <= 0.16 + EPS
    top = max(p.z for p in points(nodes[HUB]))
    assert abs(top - 0.055) < EPS
    lip = [
        p.xy.length
        for p in points(nodes[HUB])
        if abs(p.z - 0.029) < EPS or abs(p.z - 0.0304) < EPS
    ]
    assert abs(max(lip) - 0.11) < EPS
    uv_faces = []
    for name, node in nodes.items():
        data = node.data
        assert len(data.uv_layers) == 1
        uv = data.uv_layers.active
        for face in data.polygons:
            tri = tuple((*uv.data[j].uv, 0.0) for j in face.loop_indices)
            assert all(-1e-7 <= value <= 1 + 1e-7 for pt in tri for value in pt[:2])
            uv_faces.append((tri, (0.0, 0.0, 1.0), f"{name}.{face.index}"))
    shells = check_shells(nodes)
    root.rotation_mode = "XYZ"
    contact = {}
    for label, position, rotation in (
        ("floor", (0, 0, 0), (0, 0, 0)),
        ("table", (0.32, 0.26, 0.76), (0, 0, 0.57)),
        ("wall", (-0.48, 0.44, 1.24), (math.pi / 2, 0, 0.31)),
    ):
        root.location, root.rotation_euler = position, rotation
        bpy.context.view_layer.update()
        normal = root.matrix_world.to_3x3() @ Vector((0, 0, 1))
        expected = Vector(
            (math.sin(0.31), -math.cos(0.31), 0) if label == "wall" else (0, 0, 1)
        )
        assert (normal - expected).length < EPS, (label, normal, expected)
        origin = socket.matrix_world.translation
        assert (origin - Vector(position)).length < EPS
        assert (
            socket.matrix_world.to_3x3() @ Vector((0, -1, 0))
            - root.matrix_world.to_3x3() @ Vector((0, -1, 0))
        ).length < EPS
        soles = {}
        for name in LEGS:
            node = nodes[name]
            pts = points(node)
            depths = [(p - origin).dot(normal) for p in pts]
            assert abs(min(depths)) < EPS
            area = sum(
                p.area
                for p in node.data.polygons
                if all(abs(depths[i]) < EPS for i in p.vertices)
            )
            assert area > 0.0004
            soles[name] = round(area, 8)
        hub_depth = min((p - origin).dot(normal) for p in points(nodes[HUB]))
        assert hub_depth > 0
        contact[label] = {
            "origin_blender_m": position,
            "normal_blender": list(normal),
            "sole_areas_m2": soles,
            "hub_clearance_m": round(hub_depth, 6),
        }
    return {
        "glb_sha256": digest(path),
        "max_radius_m": round(radius, 7),
        "central_top_m": round(top, 7),
        "ring_radius_m": round(max(lip), 7),
        "contact": contact,
        "shells": shells,
        "geometry_triangles": len(uv_faces),
    }, uv_faces


def verify_albedo(uv_faces: list, decoded: np.ndarray) -> dict:
    # Every approved finish on this mount has nonblack unlit color.
    uv = np.asarray([tri for tri, _, _ in uv_faces])[:, :, :2]
    weights = np.array(
        [[1 / 3, 1 / 3, 1 / 3], [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6]]
    )
    samples = np.einsum("ij,kjl->kil", weights, uv)
    pixels = np.clip((samples * 1024).astype(int), 0, 1023)
    colors = decoded[1023 - pixels[:, :, 1], pixels[:, :, 0], :3].max(axis=-1)
    empty = int((colors < 12).sum())
    assert empty == 0, f"{empty} unlit samples landed on a black projection miss"
    return {
        "interior_samples": int(colors.size),
        "minimum_peak_rgb8": int(colors.min()),
        "black_samples": empty,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--piece", required=True, type=Path)
    parser.add_argument("--ktx", required=True, type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    assert bpy.app.version == (5, 2, 2)
    folder = args.piece.resolve()
    result = {}
    bpy.ops.wm.open_mainfile(filepath=str(folder / "high.blend"))
    result["high_shells"] = check_shells({n: bpy.data.objects[n] for n in PIVOTS})
    decoded = np.frombuffer(
        decode_ktx2(args.ktx, (folder / "basecolor.ktx2").read_bytes()), np.uint8
    ).reshape(1024, 1024, 4)
    atlas = []
    for level in range(2):
        path = folder / f"surface-clamp-lod{level}.glb"
        result[f"lod{level}"], uv = geometry(path)
        result[f"lod{level}"]["atlas"] = atlas_metrics(path, args.ktx)
        result[f"lod{level}"]["unlit_color"] = verify_albedo(uv, decoded)
        atlas.extend(uv)
    check_overlap(atlas)
    result["combined_uv0_positive_area_overlaps"] = 0
    write_json(folder / "reimport.json", result)
