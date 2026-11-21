"""Measure the reimported Disruptor skin, inverse binds, detached ring and clip endpoints."""

import argparse
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix
from mathutils.bvhtree import BVHTree

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path[:0] = [
    str(HERE),
    str(HERE.parent / "scripts"),
    str(HERE.parent / "scripts/assets"),
]
from disruptor_rig import CLIPS
from ktx2 import decode_ktx2, ktx_run
from package_core_bastion import digest, write_json
from validate_glbs import Glb, check_overlap
from verify_core_bastion import atlas_metrics
from verify_skitter import editable, positions, select_action


def source_fingerprint(path: Path) -> dict:
    record = editable(path)
    arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
    obj = next(o for o in bpy.context.scene.objects if o.type == "MESH")
    groups = {g.name for g in obj.vertex_groups}
    skeleton = [
        (b.name, b.parent.name if b.parent else None, list(map(list, b.matrix_local)))
        for b in arm.data.bones
    ]
    clips = {}
    for action in bpy.data.actions:
        curves = [
            (fc.data_path, fc.array_index, [list(k.co) for k in fc.keyframe_points])
            for layer in action.layers
            for strip in layer.strips
            for bag in strip.channelbags
            for fc in bag.fcurves
        ]
        clips[action.name] = hashlib.sha256(json.dumps(curves).encode()).hexdigest()
    assert clips.keys() == CLIPS.keys()
    assert all(
        1 <= len(v.groups) <= 4 and abs(sum(g.weight for g in v.groups) - 1) < 1e-5
        for v in obj.data.vertices
    )
    record.update(
        skeleton_and_groups_sha256=hashlib.sha256(
            json.dumps([skeleton, sorted(groups)]).encode()
        ).hexdigest(),
        clips_sha256=clips,
    )
    return record


def closed_component(tris: np.ndarray, positions: np.ndarray) -> None:
    _, ids = np.unique(np.round(positions, 6), axis=0, return_inverse=True)
    tris = ids[tris]
    edges = Counter(
        tuple(sorted((a, b)))
        for face in tris
        for a, b in zip(face, np.roll(face, 1), strict=True)
    )
    assert set(edges.values()) == {2}, (
        "open or nonmanifold surface",
        Counter(edges.values()),
    )
    neighbors = {}
    for a, b in edges:
        neighbors.setdefault(a, set()).add(b)
        neighbors.setdefault(b, set()).add(a)
    seen, pending = set(), [next(iter(neighbors))]
    while pending:
        node = pending.pop()
        if node not in seen:
            seen.add(node)
            pending.extend(neighbors[node] - seen)
    assert len(seen) == len(neighbors), "disconnected authored shell"


def supports(path: Path) -> dict:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = 30
    assert bpy.ops.import_scene.gltf(filepath=str(path)) == {"FINISHED"}
    arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
    obj = next(o for o in bpy.context.scene.objects if o.type == "MESH")
    for track in arm.animation_data.nla_tracks:
        track.mute = True
    arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()
    rest = positions(obj)
    extent = np.ptp(rest, axis=0)
    assert np.max(abs(extent - [0.44, 0.42, 0.32])) < 0.00002
    root = np.array(arm.matrix_world @ arm.pose.bones["root"].matrix)
    by_bone = np.array(
        [
            obj.vertex_groups[max(v.groups, key=lambda g: g.weight).group].name
            for v in obj.data.vertices
        ]
    )
    tri = np.array([p.vertices[:] for p in obj.data.polygons])
    assert np.all(by_bone[tri[:, 0]] == by_bone[tri[:, 1]]) and np.all(
        by_bone[tri[:, 0]] == by_bone[tri[:, 2]]
    )
    faces = {n: tri[by_bone[tri[:, 0]] == n] for n in ("rotor", "hull")}
    for fs in faces.values():
        closed_component(fs, rest)
    result = {
        "neutral_xyz_m": extent.tolist(),
        "closed_rigid_components": list(faces),
        "clips": {},
    }
    for name in CLIPS:
        act = select_action(arm, name)
        a, b = act.frame_range
        spin = []
        hull_z = []
        ring_z = []
        sideways = []
        peak = dist = drift = distortion = hold = 0.0
        gap = 1.0
        samples = np.linspace(a, b, 2 * round(b - a) + 1)
        verts_at_hold = None
        for f in samples:
            bpy.context.scene.frame_set(int(f), subframe=float(f - int(f)))
            v = positions(obj)
            peak = max(peak, float(v[:, 2].max()))
            if f == a:
                first = v.copy()
            dist = max(dist, float(np.linalg.norm(v - first, axis=1).max()))
            drift = max(
                drift,
                float(
                    np.abs(
                        np.array(arm.matrix_world @ arm.pose.bones["root"].matrix)
                        - root
                    ).max()
                ),
            )
            mats = {}
            for n in faces:
                pb = arm.pose.bones[n]
                m = np.array(
                    arm.matrix_world
                    @ pb.matrix
                    @ pb.bone.matrix_local.inverted()
                    @ arm.matrix_world.inverted()
                )
                mats[n] = m
                neutral = rest[by_bone == n]
                distortion = max(
                    distortion,
                    float(
                        np.linalg.norm(
                            v[by_bone == n] - (neutral @ m[:3, :3].T + m[:3, 3]), axis=1
                        ).max()
                    ),
                )
            trees = {
                n: BVHTree.FromPolygons(v.tolist(), fs.tolist(), all_triangles=True)
                for n, fs in faces.items()
            }
            assert not trees["rotor"].overlap(trees["hull"]), (
                name,
                f,
                "rotor intersects hull",
            )
            # Bound the radial separation of whole triangles in a rotor-aligned slab.
            # Every point on a hull triangle lies within its furthest projected vertex.
            inv = np.linalg.inv(mats["rotor"])
            r = v @ inv[:3, :3].T + inv[:3, 3]
            ring = r[faces["rotor"]]
            hull = r[faces["hull"]]
            minz, maxz = ring[:, :, 2].min(), ring[:, :, 2].max()
            slab = 0.006
            relevant = hull[
                (hull[:, :, 2].min(1) <= maxz + slab)
                & (hull[:, :, 2].max(1) >= minz - slab)
            ]
            # Clip every candidate triangle to the slab before projecting it. A
            # vertex outside the slab can extend beyond the ring without contact.
            flat = relevant.reshape(-1, 3)
            clipped = [flat[(flat[:, 2] >= minz - slab) & (flat[:, 2] <= maxz + slab)]]
            ends = np.roll(relevant, 1, axis=1).reshape(-1, 3)
            for plane in (minz - slab, maxz + slab):
                cross = (flat[:, 2] - plane) * (ends[:, 2] - plane) < 0
                starts, stops = flat[cross], ends[cross]
                t = (plane - starts[:, 2]) / (stops[:, 2] - starts[:, 2])
                clipped.append(starts + t[:, None] * (stops - starts))
            # The rotor outline is an ellipse. Stretch its short axis before
            # measuring and restore the minimum metric scale for a world bound.
            scale = np.array([1, 0.22 / 0.21])
            xy = ring[:, :, :2] * scale
            edge = np.roll(xy, -1, axis=1) - xy
            ll = np.einsum("...i,...i->...", edge, edge)
            u = np.clip(
                -np.einsum("...i,...i->...", xy, edge) / np.maximum(ll, 1e-16), 0, 1
            )
            inner = np.linalg.norm(xy + u[:, :, None] * edge, axis=2).min()
            assert (np.einsum("...i,...i->...", xy, np.roll(xy, 1, axis=1)) > 0).all()
            outer = np.linalg.norm(np.concatenate(clipped)[:, :2] * scale, axis=1).max()
            margin = min(slab, (inner - outer) * 0.21 / 0.22)
            assert margin > 0.002, (name, f, "uncertified clearance", margin)
            gap = min(gap, float(margin))
            delta = np.linalg.inv(mats["hull"]) @ mats["rotor"]
            spin.append(np.arctan2(delta[1, 0], delta[0, 0]))
            center = np.array([0, 0, 0.16, 1])
            ring_z.append(float((delta @ center)[2]))
            hull_z.append(float((mats["hull"] @ center)[2]))
            sideways.append(float((mats["hull"] @ center)[0]))
            if (f - a) / (b - a) >= 0.80:
                if verts_at_hold is None:
                    verts_at_hold = v.copy()
                hold = max(hold, float(np.linalg.norm(v - verts_at_hold, axis=1).max()))
        start = float(np.linalg.norm(first - rest, axis=1).max())
        end = float(np.linalg.norm(v - rest, axis=1).max())
        angular = np.unwrap(spin)
        assert start < 3e-5 and peak < 0.44 and drift < 2e-5 and distortion < 2e-5
        if name == "death":
            assert end > 0.12 and hold < 2e-5 and hull_z[-1] < hull_z[0] - 0.06
        else:
            assert end < 3e-5
        if name == "hover_glide":
            assert np.ptp(hull_z) > 0.015 and np.ptp(sideways) > 0.018
            assert abs(angular[-1] - 2 * np.pi) < 1e-4 and min(np.diff(angular)) > 0.02
        if name == "emp_pulse":
            assert (
                min(ring_z) < 0.137
                and max(ring_z) > 0.192
                and np.argmin(ring_z) < np.argmax(ring_z)
            )
        if name == "hit":
            assert max(sideways) > 0.018 and dist > 0.065
        result["clips"][name] = {
            "samples": len(samples),
            "intersection_pairs": 0,
            "certified_minimum_air_gap_m": gap,
            "peak_z_m": peak,
            "peak_vertex_travel_m": dist,
            "maximum_rigid_skin_error_m": distortion,
            "root_matrix_drift": drift,
            "start_rest_error_m": start,
            "end_rest_error_m": end,
            "hull_vertical_range_m": [min(hull_z), max(hull_z)],
            "ring_relative_height_m": [min(ring_z), max(ring_z)],
            "rotor_unwrapped_z_rotation_degrees": [
                float(np.degrees(angular.min())),
                float(np.degrees(angular.max())),
            ],
            "final_hold_vertex_drift_m": hold if name == "death" else None,
        }
    return result


def contract(path: Path) -> dict:
    glb = Glb(path.read_bytes())
    poses, _parents = glb.scene()
    doc = glb.doc
    assert {a["name"] for a in doc["animations"]} == CLIPS.keys()
    assert len(doc["skins"]) == len(doc["meshes"]) == len(doc["materials"]) == 1
    skin = doc["skins"][0]
    joints = {doc["nodes"][j]["name"]: j for j in skin["joints"]}
    expected = {"root": "Disruptor", "hull": "root", "rotor": "hull"}
    assert joints.keys() == expected.keys()
    assert all(
        doc["nodes"][_parents[i]]["name"] == expected[name]
        for name, i in joints.items()
    )
    assert np.max(abs(np.array(poses[_parents[joints["root"]]]) - np.eye(4))) < 1e-7
    assert np.max(abs(np.array(poses[joints["root"]])[:3, 3])) < 1e-7
    bind = glb.read(skin["inverseBindMatrices"], "MAT4", (5126,))
    node = next(i for i, n in enumerate(doc["nodes"]) if "mesh" in n)
    error = max(
        float(
            np.max(abs(np.array(poses[j]) @ np.array(m).reshape(4, 4).T - poses[node]))
        )
        for j, m in zip(skin["joints"], bind, strict=True)
    )
    assert error < 2e-5, error
    prim = doc["meshes"][0]["primitives"]
    assert len(prim) == 1
    attr = prim[0]["attributes"]
    uv = np.array(glb.read(attr["TEXCOORD_0"], "VEC2", (5126,)))
    pos = np.array(glb.read(attr["POSITION"], "VEC3", (5126,)))
    w = np.array(
        glb.read(attr["WEIGHTS_0"], "VEC4", (5126, 5121, 5123), normalized=True)
    )
    assert np.all(np.isfinite(w)) and np.max(abs(w.sum(axis=1) - 1)) < 1e-5
    slots = np.array(glb.read(attr["JOINTS_0"], "VEC4", (5121, 5123)))
    assert np.all((slots >= 0) & (slots < len(joints))) and np.all((w >= 0) & (w <= 1))
    idx = np.array(glb.read(prim[0]["indices"], "SCALAR", (5123, 5125))).reshape(-1, 3)
    uv3 = np.column_stack([uv, np.zeros(len(uv))])
    for coords in (uv3, pos):
        faces = []
        for n, tri in enumerate(coords[idx]):
            normal = np.cross(tri[1] - tri[0], tri[2] - tri[0])
            normal /= np.linalg.norm(normal)
            faces.append((tuple(tuple(p) for p in tri), tuple(normal), str(n)))
        check_overlap(faces)
    du, dv = uv[idx[:, 1]] - uv[idx[:, 0]], uv[idx[:, 2]] - uv[idx[:, 0]]
    uv_area = 0.5 * np.abs(du[:, 0] * dv[:, 1] - dv[:, 0] * du[:, 1]).sum()
    area = (
        0.5
        * np.linalg.norm(
            np.cross(pos[idx[:, 1]] - pos[idx[:, 0]], pos[idx[:, 2]] - pos[idx[:, 0]]),
            axis=1,
        ).sum()
    )
    return {
        "sha256": digest(path),
        "triangles": len(idx),
        "joints": [doc["nodes"][j]["name"] for j in skin["joints"]],
        "inverse_bind_max_matrix_error": error,
        "influences": [int((w > 0).sum(1).min()), int((w > 0).sum(1).max())],
        "positive_area_uv_or_coplanar_pairs": 0,
        "mean_texels_per_meter": float(1024 * (uv_area / area) ** 0.5),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--piece", type=Path)
    parser.add_argument("--ktx", type=Path)
    parser.add_argument("--motion-only", type=Path)
    parser.add_argument("--sources-only", type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    if args.motion_only:
        print(json.dumps(supports(args.motion_only.resolve())))
        return
    if args.sources_only:
        d = args.sources_only.resolve()
        write_json(
            d / "editable-hashes.json",
            {n: source_fingerprint(d / n) for n in ("high.blend", "low.blend")},
        )
        return
    piece = args.piece.resolve()
    report = {}
    for lod in (0, 1):
        path = piece / f"rift-disruptor-lod{lod}.glb"
        report[f"lod{lod}"] = {**contract(path), **supports(path)}
    assert (
        report["lod0"]["joints"] == report["lod1"]["joints"]
        and len(report["lod0"]["joints"]) == 3
    )
    report["atlas"] = atlas_metrics(path, args.ktx.resolve())
    report["sources"] = {
        n: source_fingerprint(piece / n) for n in ("high.blend", "low.blend")
    }
    for key in ("skeleton_and_groups_sha256", "clips_sha256"):
        assert (
            report["sources"]["high.blend"][key] == report["sources"]["low.blend"][key]
        ), key
    for role, stats in report["atlas"]["textures"].items():
        pixels = np.frombuffer(
            decode_ktx2(args.ktx.resolve(), (piece / f"{role}.ktx2").read_bytes()),
            dtype=np.uint8,
        ).reshape(1024, 1024, 4)
        mips = []
        for level in range(stats["mip_levels"]):
            side = max(1, 1024 >> level)
            if level:
                raw = ktx_run(
                    args.ktx.resolve(),
                    "extract",
                    "--raw",
                    "--transcode",
                    "rgba8",
                    "--level",
                    str(level),
                    str(piece / f"{role}.ktx2"),
                    "-",
                )
                pixels = np.frombuffer(raw, np.uint8).reshape(side, side, 4)
            assert np.all(pixels[:, :, 3] == 255), (role, level)
            row = {
                "level": level,
                "decoded_rgba8_texels": side * side,
                "alpha": [255, 255],
            }
            if role == "normal":
                v = pixels[:, :, :3].astype(np.float32) / 127.5 - 1
                lens = np.linalg.norm(v, axis=2)
                row["unit_length"] = [float(lens.min()), float(lens.max())]
                assert (
                    np.min(v[:, :, 2]) >= -1 / 255
                    and np.min(lens) >= 0.88
                    and np.max(lens) <= 1.12
                ), (level, row)
            mips.append(row)
        assert len(mips) == 11
        stats["decoded_alpha_range"] = [255, 255]
        stats["decoded_mips"] = mips
    write_json(piece / "reimport.json", report)


if __name__ == "__main__":
    main()
