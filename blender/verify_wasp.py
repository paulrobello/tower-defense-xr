"""Measure the reimported Wasp skin, inverse binds, wing separation and clip endpoints."""

import argparse
import json
import sys
from itertools import combinations
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
from package_core_bastion import digest, write_json
from review_core_bastion import import_glb
from validate_glbs import Glb, check_overlap
from verify_core_bastion import atlas_metrics
from verify_skitter import editable, positions, select_action
from wasp_rig import CLIPS
from wasp_shape import WINGS


def supports(path: Path) -> dict:
    import_glb(path)
    arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
    obj = next(o for o in bpy.context.scene.objects if o.type == "MESH")
    ad = arm.animation_data
    for track in ad.nla_tracks:
        track.mute = True
    ad.action = None
    for pb in arm.pose.bones:
        pb.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()
    rest = positions(obj)
    extent = np.ptp(rest, axis=0)
    assert np.max(np.abs(extent - [0.42, 0.38, 0.22])) < 0.002
    assert abs(rest[:, 2].min()) < 0.001 and rest[:, 2].max() < 0.32
    rest_root = np.array(arm.matrix_world @ arm.pose.bones["root"].matrix)
    groups = {
        g.name: np.array(
            [
                v.index
                for v in obj.data.vertices
                if any(x.group == g.index and x.weight > 0.97 for x in v.groups)
            ]
        )
        for g in obj.vertex_groups
    }
    faces = {g.name: [] for g in obj.vertex_groups}
    for f in obj.data.polygons:
        ids = tuple(f.vertices)
        names = {
            obj.vertex_groups[obj.data.vertices[i].groups[0].group].name for i in ids
        }
        assert len(names) == 1
        faces[names.pop()].append(ids)
    result = {
        "neutral_xyz_m": extent.tolist(),
        "minimum_z_m": float(rest[:, 2].min()),
        "clips": {},
    }
    for clip in CLIPS:
        act = select_action(arm, clip)
        start, end = act.frame_range
        frames = np.linspace(start, end, 2 * round(end - start) + 1)
        max_root = max_travel = max_roll = 0.0
        excursion = {name: 0.0 for name in WINGS}
        wing_angles = {name: 0.0 for name in WINGS}
        body_height = []
        peak_z = 0.0
        touch_count = 0
        for i, f in enumerate(frames):
            bpy.context.scene.frame_set(int(f), subframe=float(f - int(f)))
            verts = positions(obj)
            peak_z = max(peak_z, float(verts[:, 2].max()))
            if i == 0:
                first = verts.copy()
            travel = np.linalg.norm(verts - first, axis=1)
            max_travel = max(max_travel, travel.max())
            max_root = max(
                max_root,
                np.abs(
                    np.array(arm.matrix_world @ arm.pose.bones["root"].matrix)
                    - rest_root
                ).max(),
            )
            mat = (
                arm.pose.bones["thorax"].matrix
                @ arm.data.bones["thorax"].matrix_local.inverted()
            )
            max_roll = max(max_roll, abs(np.arctan2(mat[2][0], mat[0][0])))
            body_height.append(float(verts[groups["thorax"], 2].mean()))
            for name in WINGS:
                current = (
                    arm.pose.bones[name].matrix
                    @ arm.data.bones[name].matrix_local.inverted()
                )
                relative = mat.inverted() @ current
                wing_angles[name] = max(
                    wing_angles[name], float(np.degrees(relative.to_quaternion().angle))
                )
                excursion[name] = max(
                    excursion[name], float(travel[groups[name]].max())
                )
            if i % 2 == 0 or i == len(frames) - 1:
                trees = {
                    k: BVHTree.FromPolygons(verts.tolist(), fs, all_triangles=True)
                    for k, fs in faces.items()
                    if fs
                }
                for a, b in combinations(WINGS, 2):
                    assert not trees[a].overlap(trees[b]), (
                        clip,
                        f,
                        "wing collision",
                        a,
                        b,
                    )
                for k in (*WINGS, "abdomen", "stylet.L", "stylet.R"):
                    assert trees["thorax"].overlap(trees[k]), (
                        clip,
                        f,
                        "lost root contact",
                        k,
                    )
                touch_count += 1
        endpoint = float(np.max(np.linalg.norm(verts - first, axis=1)))
        start_rest = float(np.max(np.linalg.norm(first - rest, axis=1)))
        end_rest = float(np.max(np.linalg.norm(verts - rest, axis=1)))
        assert (
            start_rest < 0.00006 and max_root < 2e-5 and min(excursion.values()) > 0.005
        )
        assert peak_z < 0.32, (clip, peak_z)
        if clip == "death":
            assert end_rest > 0.08 and body_height[-1] < body_height[0] - 0.025
        else:
            assert end_rest < 0.00006 and endpoint < 0.00006
        if clip in ("bank_turn", "hover_fly"):
            assert min(wing_angles.values()) > 5.0, (clip, wing_angles)
        if clip == "bank_turn":
            assert np.degrees(max_roll) > 32
        if clip == "hover_fly":
            assert np.ptp(body_height) > 0.006
        result["clips"][clip] = {
            "samples": len(frames),
            "triangle_contact_and_clearance_samples": touch_count,
            "max_vertex_travel_m": float(max_travel),
            "maximum_thorax_roll_deg": float(np.degrees(max_roll)),
            "thorax_vertical_excursion_m": float(np.ptp(body_height)),
            "wing_peak_vertex_travel_m": excursion,
            "peak_wing_articulation_relative_to_thorax_deg": wing_angles,
            "root_matrix_drift": float(max_root),
            "maximum_z_m": peak_z,
            "first_last_vertex_error_m": endpoint,
            "start_rest_error_m": start_rest,
            "end_rest_error_m": end_rest,
        }
    return result


def contract(path: Path) -> dict:
    glb = Glb(path.read_bytes())
    poses, _parents = glb.scene()
    doc = glb.doc
    assert len(doc["skins"]) == len(doc["meshes"]) == len(doc["materials"]) == 1
    skin = doc["skins"][0]
    joints = {doc["nodes"][j]["name"]: j for j in skin["joints"]}
    expected = {
        "root": "Wasp",
        "thorax": "root",
        "abdomen": "thorax",
        "stylet.L": "thorax",
        "stylet.R": "thorax",
        **{name: "thorax" for name in WINGS},
    }
    assert sorted(a["name"] for a in doc["animations"]) == sorted(CLIPS)
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
    joint_ids = np.array(glb.read(attr["JOINTS_0"], "VEC4", (5121, 5123)))
    assert (w >= 0).all() and (w <= 1).all() and np.all(joint_ids[w > 0] < len(joints))
    assert 1 <= (w > 0).sum(1).min() <= (w > 0).sum(1).max() <= 4
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
            {n: editable(d / n) for n in ("high.blend", "low.blend")},
        )
        return
    piece = args.piece.resolve()
    report = {}
    for lod in (0, 1):
        path = piece / f"wasp-skimmer-lod{lod}.glb"
        report[f"lod{lod}"] = {**contract(path), **supports(path)}
    assert (
        report["lod0"]["joints"] == report["lod1"]["joints"]
        and len(report["lod0"]["joints"]) == 9
    )
    report["atlas"] = atlas_metrics(path, args.ktx.resolve())
    lo, hi = report["atlas"]["textures"]["normal"]["decoded_unit_length_range"]
    assert lo >= 0.88 and hi <= 1.12, (lo, hi)
    assert all(v["mip_levels"] == 11 for v in report["atlas"]["textures"].values())
    report["sources"] = {n: editable(piece / n) for n in ("high.blend", "low.blend")}
    write_json(piece / "reimport.json", report)


if __name__ == "__main__":
    main()
