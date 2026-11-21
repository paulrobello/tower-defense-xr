"""Prove bearing contact and separating distances throughout both serialized performances."""

import argparse
import json
import sys
from collections import defaultdict
from functools import cached_property
from itertools import combinations, product
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix
from mathutils.bvhtree import BVHTree

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import verify_broodlord as original
from broodlord_rig import CLIPS
from package_core_bastion import digest, write_json
from review_core_bastion import import_glb
from review_skitter import neutral
from validate_glbs import PLANE_TOLERANCE, check_overlap
from verify_skitter import positions, select_action


class Cluster:
    """Triangle partition held in bind space; every split keeps whole triangles."""

    def __init__(self, points: np.ndarray, faces: np.ndarray) -> None:
        self.faces = faces
        self.vertices = np.unique(faces)
        self.points = points

    @cached_property
    def children(self) -> tuple:
        centers = self.points[self.faces].mean(axis=1)
        order = np.argsort(centers[:, np.ptp(centers, axis=0).argmax()])
        split = len(order) // 2
        return tuple(
            Cluster(self.points, self.faces[s]) for s in (order[:split], order[split:])
        )


def triangle_gap(a: np.ndarray, b: np.ndarray) -> float:
    ea, eb = np.roll(a, -1, axis=0) - a, np.roll(b, -1, axis=0) - b
    na, nb = np.cross(ea[0], ea[1]), np.cross(eb[0], eb[1])
    axes = np.concatenate(
        (
            [na, nb],
            np.cross(ea[:, None], eb).reshape(-1, 3),
            np.cross(ea, na),
            np.cross(eb, nb),
        )
    )
    lengths = np.linalg.norm(axes, axis=1)
    axes = axes[lengths > 1e-14] / lengths[lengths > 1e-14, None]
    pa, pb = a @ axes.T, b @ axes.T
    return float(np.maximum(pa.min(0) - pb.max(0), pb.min(0) - pa.max(0)).max())


class PoseProbe:
    def __init__(self, points: np.ndarray, axes: np.ndarray) -> None:
        self.points = points
        self.projected = points @ axes.T
        self.bounds = {}

    def gap(self, a: Cluster, b: Cluster) -> float:
        for cluster in (a, b):
            if cluster not in self.bounds:
                p = self.projected[cluster.vertices]
                self.bounds[cluster] = (p.min(0), p.max(0))
        la, ha = self.bounds[a]
        lb, hb = self.bounds[b]
        distance = float(np.maximum(la - hb, lb - ha).max())
        if distance > 1.0e-6:
            return distance
        if len(a.faces) == len(b.faces) == 1:
            return triangle_gap(self.points[a.faces[0]], self.points[b.faces[0]])
        if len(b.faces) > len(a.faces):
            a, b = b, a
        return min(self.gap(child, b) for child in a.children)


def motion(path: Path) -> dict:
    import_glb(path)
    obj = next(o for o in bpy.context.scene.objects if o.type == "MESH")
    arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
    neutral(arm)
    bind = positions(obj)
    faces = {}
    uv = obj.data.uv_layers.active.data
    charts = {p.name: p.uv for p in original.anatomy("lod0")}
    for p in obj.data.polygons:
        indices = tuple(p.vertices)
        bone = obj.vertex_groups[obj.data.vertices[indices[0]].groups[0].group].name
        faces.setdefault(bone, []).append(indices)
        if bone.startswith("crest."):
            side = bone[-1]
            a, b, c, d = charts[f"Swept crest {side}"]
            coords = [uv[i].uv for i in p.loop_indices]
            if all(
                a - 1e-6 <= v.x <= c + 1e-6 and b - 1e-6 <= v.y <= d + 1e-6
                for v in coords
            ) and min(v.y for v in coords) >= b + 0.72 * (d - b):
                faces.setdefault(f"tip.{side}", []).append(indices)
    sides = ("L", "R")
    legs = {
        f"leg_{r}.{s}": [
            f"{segment}_{r}.{s}" for segment in ("coxa", "femur", "tibia", "blade")
        ]
        for r in ("fore", "hind")
        for s in sides
    }
    joins = [("head", "thorax"), ("abdomen", "thorax")]
    free = {
        "distal-valves": [("tip.L", "tip.R")],
        "distal-valve-to-head": [(f"tip.{s}", "head") for s in sides],
        "leg-to-leg": list(combinations(legs, 2)),
        "palm-to-other-palm": [("palm.L", "palm.R")],
        "palm-to-shell": [],
        "palm-to-legs": [],
        "distal-legs-to-thorax": [],
    }
    for key, chain in legs.items():
        faces[key] = [f for n in chain for f in faces[n]]
        joins.extend(zip(["thorax", *chain[:-1]], chain, strict=True))
        free["distal-legs-to-thorax"].extend((n, "thorax") for n in chain[2:])
    for s in sides:
        arm_chain = [f"{n}.{s}" for n in ("brachium", "forearm", "palm")]
        joins.extend(zip(["thorax", *arm_chain[:-1]], arm_chain, strict=True))
        joins.append(("head", f"crest.{s}"))
        free["palm-to-shell"].extend(
            (arm_chain[-1], n) for n in ("head", "thorax", f"crest.{s}")
        )
        free["palm-to-legs"].extend((arm_chain[-1], n) for n in legs)
    clusters = {n: Cluster(bind, np.array(tris)) for n, tris in faces.items()}
    topology = {}
    for n in {v for pair in joins for v in pair}:
        idx, faces_local = np.unique(clusters[n].faces, return_inverse=True)
        topology[n] = (idx, faces_local.reshape(-1, 3).tolist())

    axes = np.array(
        [v for v in product((-1, 0, 1), repeat=3) if next((i for i in v if i), 0) == 1],
        dtype=float,
    )
    axes /= np.linalg.norm(axes, axis=1)[:, None]

    def test_pose(clip: str, f: float, minima: dict) -> None:
        points = positions(obj)
        probe = PoseProbe(points, axes)
        for kind, pairs in free.items():
            for a, b in pairs:
                measure = probe.gap(clusters[a], clusters[b])
                assert measure > 1.0e-7, (clip, float(f), a, b, measure)
                minima[kind] = min(minima[kind], measure)
        trees = {
            n: BVHTree.FromPolygons(points[idx].tolist(), local, all_triangles=True)
            for n, (idx, local) in topology.items()
        }
        for a, b in joins:
            assert trees[a].overlap(trees[b]), (clip, float(f), "bearing", a, b)

    report = {}
    for clip, frames in CLIPS.items():
        start, end = select_action(arm, clip).frame_range
        minima = {n: 1.0 for n in free}
        samples = np.linspace(start, end, frames * 2 + 1)
        for f in samples:
            bpy.context.scene.frame_set(int(f), subframe=float(f - int(f)))
            test_pose(clip, float(f), minima)
        report[clip] = {
            "half_frame_samples": len(samples),
            "positive_clearance_lower_bounds_m": minima,
            "joint_bearings_in_contact_at_every_sample": len(joins),
        }

    def snapshot(name: str, ratio: float) -> dict:
        begin, end = select_action(arm, name).frame_range
        at = begin + ratio * (end - begin)
        bpy.context.scene.frame_set(int(at), subframe=float(at - int(at)))
        return {bone.name: bone.matrix_basis.decompose() for bone in arm.pose.bones}

    blends = {}
    for source, src_time, destination, dst_time in (
        ("boss_march", 0.31, "spawn_adds", 0.10),
        ("emp_roar", 0.35, "hit", 0.30),
        ("phase2_shift", 0.42, "death", 0.17),
    ):
        start, end = snapshot(source, src_time), snapshot(destination, dst_time)
        arm.animation_data.action = None
        minima = {n: 1.0 for n in free}
        name = f"{source}_to_{destination}"
        for weight in (0, 0.25, 0.5, 0.75, 1):
            for bone in arm.pose.bones:
                t, q, scale = start[bone.name]
                t2, q2, scale2 = end[bone.name]
                bone.matrix_basis = Matrix.LocRotScale(
                    t.lerp(t2, weight), q.slerp(q2, weight), scale.lerp(scale2, weight)
                )
            bpy.context.view_layer.update()
            test_pose(name, weight, minima)
        blends[name] = {
            "sampled_weights": [0, 0.25, 0.5, 0.75, 1],
            "positive_clearance_lower_bounds_m": minima,
            "joint_bearings_in_contact_at_every_sample": len(joins),
        }
    return {"sha256": digest(path), "clips": report, "transitions": blends}


def editable_overlap(path: Path) -> dict:
    bpy.ops.wm.open_mainfile(filepath=str(path))
    obj = next(o for o in bpy.context.scene.objects if o.type == "MESH")
    mesh = obj.data
    triangles = np.array([tuple(face.vertices) for face in mesh.polygons])
    geometry = np.array([list(v.co) for v in mesh.vertices])[triangles]
    uv_data = mesh.uv_layers.active.data
    uv = np.array(
        [[(*uv_data[i].uv, 0) for i in face.loop_indices] for face in mesh.polygons]
    )
    for coords in (geometry, uv):
        # Apply the same project predicate to local buckets. Every candidate
        # pair whose bounds are within tolerance shares at least one bucket.
        bounds = np.ptp(coords, axis=(0, 1))
        axes = np.argsort(bounds)[-2:]
        origin = coords.min(axis=(0, 1))[axes]
        width = bounds[axes] / 32
        lo = np.floor(
            (coords.min(axis=1)[:, axes] - origin - PLANE_TOLERANCE) / width
        ).astype(int)
        hi = np.floor(
            (coords.max(axis=1)[:, axes] - origin + PLANE_TOLERANCE) / width
        ).astype(int)
        normals = np.cross(coords[:, 1] - coords[:, 0], coords[:, 2] - coords[:, 0])
        lens = np.linalg.norm(normals, axis=1)
        assert np.all(lens > 1.0e-14)
        normals /= lens[:, None]
        cells = defaultdict(list)
        for i, (minimum, maximum) in enumerate(zip(lo, hi, strict=True)):
            face = tuple(map(tuple, coords[i])), tuple(normals[i]), str(i)
            for x in range(minimum[0], maximum[0] + 1):
                for y in range(minimum[1], maximum[1] + 1):
                    cells[x, y].append(face)
        for faces in cells.values():
            if len(faces) > 1:
                check_overlap(faces)
    return {"triangles": len(triangles), "positive_area_uv_or_coplanar_pairs": 0}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--piece", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    piece = args.piece.resolve()
    report = json.loads((piece / "reimport.json").read_text())
    for n in ("lod0", "lod1"):
        row = motion(piece / f"apex-broodlord-{n}.glb")
        assert row["sha256"] == report[n]["sha256"]
        report[n]["continuous_clearance"] = row
    report["editable_overlap"] = {
        n: editable_overlap(piece / n) for n in ("high.blend", "low.blend")
    }
    write_json(piece / "reimport.json", report)


if __name__ == "__main__":
    main()
