"""Measure the reimported Skitter skin, inverse binds, support and clip endpoints."""

import argparse
import hashlib
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
from skitter_rig import CLIPS
from validate_glbs import Glb, check_overlap
from verify_core_bastion import atlas_metrics

SIDES = ("L", "R")
ROWS = ("fore", "mid", "hind")
FEET = [f"claw_{row}.{side}" for side in SIDES for row in ROWS]


def editable(path: Path) -> dict:
    bpy.ops.wm.open_mainfile(filepath=str(path))
    arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
    obj = next(o for o in bpy.context.scene.objects if o.type == "MESH")
    h = hashlib.sha256()

    def add(value: object) -> None:
        h.update(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())

    add(
        [
            (o.name, o.type, o.parent.name if o.parent else None)
            for o in sorted(bpy.context.scene.objects, key=lambda o: o.name)
        ]
    )
    for b in arm.data.bones:
        add(
            [
                b.name,
                b.parent.name if b.parent else None,
                [list(r) for r in b.matrix_local],
            ]
        )
    mesh = obj.data
    for v in mesh.vertices:
        add(
            [
                list(v.co),
                [(obj.vertex_groups[g.group].name, g.weight) for g in v.groups],
            ]
        )
    for p in mesh.polygons:
        add(
            [
                p.material_index,
                list(p.vertices),
                [list(mesh.uv_layers.active.data[i].uv) for i in p.loop_indices],
            ]
        )
    for a in sorted(bpy.data.actions, key=lambda a: a.name):
        add([a.name, list(a.frame_range)])
        for layer in a.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    for fc in bag.fcurves:
                        add(
                            [
                                fc.data_path,
                                fc.array_index,
                                [list(k.co) for k in fc.keyframe_points],
                            ]
                        )
    return {
        "file_sha256": digest(path),
        "logical_geometry_hierarchy_skin_animation_sha256": h.hexdigest(),
    }


def select_action(arm: bpy.types.Object, clip: str) -> bpy.types.Action:
    ad = arm.animation_data
    for tr in ad.nla_tracks:
        tr.mute = True
    act = next(
        a
        for a in bpy.data.actions
        if a.name == clip
        or a.name.startswith(clip + "_")
        or a.name.startswith(clip + "|")
    )
    ad.action = act
    if len(act.slots):
        ad.action_slot = act.slots[0]
    return act


def positions(obj: bpy.types.Object) -> np.ndarray:
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    points = np.empty(len(evaluated.data.vertices) * 3, np.float32)
    evaluated.data.vertices.foreach_get("co", points)
    world = np.array(evaluated.matrix_world)
    return points.reshape(-1, 3) @ world[:3, :3].T + world[:3, 3]


def shell_contacts(points: np.ndarray, faces: dict) -> None:
    """Check mechanical continuity and separation on the deformed cuticle triangles."""
    trees = {
        name: BVHTree.FromPolygons(points.tolist(), triangles, all_triangles=True)
        for name, triangles in faces.items()
        if triangles
    }
    legs = []
    for foot in FEET:
        suffix = foot.removeprefix("claw_")
        chain = [f"{part}_{suffix}" for part in ("femur", "tibia", "claw")]
        for a, b in zip(["thorax", *chain[:2]], chain, strict=True):
            assert trees[a].overlap(trees[b]), ("disconnected", a, b)
        assert not trees["thorax"].overlap(trees[foot]), ("claw enters thorax", foot)
        legs.append(chain)
    for a, b in combinations(legs, 2):
        assert not any(trees[i].overlap(trees[j]) for i in a for j in b), (
            "crossed legs",
            a,
            b,
        )


def supports(path: Path) -> dict:
    import_glb(path)
    arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
    obj = next(o for o in bpy.context.scene.objects if o.type == "MESH")
    ad = arm.animation_data
    for tr in ad.nla_tracks:
        tr.mute = True
    ad.action = None
    for p in arm.pose.bones:
        p.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()
    rest = positions(obj)
    extent = np.ptp(rest, axis=0)
    assert np.max(abs(extent - [0.26, 0.34, 0.18])) < 0.002, extent
    bind_root = arm.matrix_world @ arm.pose.bones["root"].matrix
    groups = {
        g.name: [
            v.index
            for v in obj.data.vertices
            if any(x.group == g.index and x.weight > 0.97 for x in v.groups)
        ]
        for g in obj.vertex_groups
    }
    faces = {g.name: [] for g in obj.vertex_groups}
    for poly in obj.data.polygons:
        groups_on_face = {
            obj.vertex_groups[obj.data.vertices[i].groups[0].group].name
            for i in poly.vertices
        }
        assert len(groups_on_face) == 1
        faces[groups_on_face.pop()].append(tuple(poly.vertices))
    tips = {name: min(groups[name], key=lambda v: rest[v, 2]) for name in FEET}
    assert all(abs(rest[v, 2]) < 1e-5 for v in tips.values()), tips
    result = {
        "neutral_xyz_m": extent.tolist(),
        "minimum_z_m": float(rest[:, 2].min()),
        "clips": {},
    }
    for clip in CLIPS:
        act = select_action(arm, clip)
        start, end = act.frame_range
        prev = None
        metrics = {n: [] for n in FEET}
        max_move = 0
        chest_z = []
        max_root = 0
        min_supports = 6
        # In Blender +Z is local support normal and -Y forward. Orient the root
        # onto a vertical wall with outward +Y normal and downward -Z travel.
        # X must reverse too for this right-handed surface/travel basis.
        wall = np.array([[-1, 0, 0], [0, 0, 1], [0, 1, 0]], float)
        assert np.linalg.det(wall) == 1 and np.all(wall @ [0, -1, 0] == [0, 0, -1])
        fixture = wall if clip == "climb_wall" else np.eye(3)
        plane = fixture @ np.array([0, 0, 1])
        frames = np.linspace(start, end, 2 * round(end - start) + 1)
        contact_samples = {
            0,
            len(frames) // 4,
            len(frames) // 2,
            3 * len(frames) // 4,
            len(frames) - 1,
        }
        for sample, frame in enumerate(frames):
            whole = int(frame)
            bpy.context.scene.frame_set(whole, subframe=float(frame - whole))
            pos = positions(obj)
            if sample in contact_samples:
                shell_contacts(pos, faces)
            current_root = arm.matrix_world @ arm.pose.bones["root"].matrix
            max_root = max(
                max_root,
                float(np.abs(np.array(current_root) - np.array(bind_root)).max()),
            )
            if prev is None:
                first = pos.copy()
            max_move = max(max_move, float(np.linalg.norm(pos - first, axis=1).max()))
            prev = pos
            chest_z.append(float(pos[groups["thorax"], 2].mean()))
            distances = (pos[[tips[n] for n in FEET]] @ fixture.T) @ plane
            for n, d in zip(FEET, distances, strict=True):
                metrics[n].append(float(d))
            min_supports = min(min_supports, int((abs(distances) < 0.00035).sum()))
        ends = float(np.linalg.norm(prev - first, axis=1).max())
        end_neutral = float(np.linalg.norm(prev - rest, axis=1).max())
        first_neutral = float(np.linalg.norm(first - rest, axis=1).max())
        assert max_move > 0.005 and max_root < 2.0e-5, (clip, max_move, max_root)
        summary = {
            "samples": len(frames),
            "mesh_joint_and_leg_clearance_samples": len(contact_samples),
            "max_vertex_travel_m": max_move,
            "first_last_vertex_error_m": ends,
            "start_rest_error_m": first_neutral,
            "end_rest_error_m": end_neutral,
            "root_matrix_drift": max_root,
        }
        if clip in ("crawl_floor", "climb_wall"):
            assert ends < 0.00003, (clip, ends)
            assert min_supports >= 3, (clip, min_supports, metrics)
            assert min(min(h) for h in metrics.values()) > -0.0004
            assert all(max(h) > 0.009 and min(h) < 0.00015 for h in metrics.values())
            contacts = np.array([np.array(metrics[n]) < 0.00035 for n in FEET])
            assert all(
                np.array_equal(contacts[i], contacts[j])
                for i, j in ((0, 2), (0, 4), (1, 3), (1, 5))
            )
            assert np.any(contacts[0] & ~contacts[1]) and np.any(
                contacts[1] & ~contacts[0]
            )
            summary.update(
                minimum_simultaneous_contacts=min_supports,
                fixture_matrix=fixture.tolist(),
                world_normal=plane.tolist(),
                foot_excursions_m={n: [min(h), max(h)] for n, h in metrics.items()},
            )
        else:
            assert first_neutral < 0.00006
            if clip == "death":
                assert chest_z[-1] < chest_z[0] - 0.025 and end_neutral > 0.03
            else:
                assert end_neutral < 0.00006
        result["clips"][clip] = summary
    return result


def contract(path: Path) -> dict:
    glb = Glb(path.read_bytes())
    poses, _parents = glb.scene()
    doc = glb.doc
    assert len(doc["skins"]) == len(doc["meshes"]) == len(doc["materials"]) == 1
    skin = doc["skins"][0]
    joints = {doc["nodes"][j]["name"]: j for j in skin["joints"]}
    expected = {
        "root": "Skitter",
        "thorax": "root",
        "head": "thorax",
        "mandible.L": "head",
        "mandible.R": "head",
    }
    for foot in FEET:
        suffix = foot.removeprefix("claw_")
        femur, tibia = f"femur_{suffix}", f"tibia_{suffix}"
        expected.update({femur: "thorax", tibia: femur, foot: tibia})
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
        path = piece / f"skitter-crawler-lod{lod}.glb"
        report[f"lod{lod}"] = {**contract(path), **supports(path)}
    assert (
        report["lod0"]["joints"] == report["lod1"]["joints"]
        and len(report["lod0"]["joints"]) == 23
    )
    report["atlas"] = atlas_metrics(path, args.ktx.resolve())
    report["sources"] = {n: editable(piece / n) for n in ("high.blend", "low.blend")}
    write_json(piece / "reimport.json", report)


if __name__ == "__main__":
    main()
