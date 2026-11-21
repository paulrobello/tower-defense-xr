"""Measure the reimported Brute skin, inverse binds, support and clip endpoints."""

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
from brute_rig import CLIPS
from brute_shape import anatomy
from ktx2 import decode_ktx2
from package_core_bastion import digest, write_json
from review_core_bastion import import_glb
from validate_glbs import Glb, check_overlap
from verify_core_bastion import atlas_metrics
from verify_skitter import editable, positions, select_action

SIDES = ("L", "R")
ROWS = ("fore", "mid", "hind")
FEET = [f"claw_{row}.{side}" for side in SIDES for row in ROWS]


def assembly(mesh: bpy.types.Mesh, points: np.ndarray) -> int:
    parts = anatomy("lod0")
    groups = {p.name: [] for p in parts}
    uvs = mesh.uv_layers.active.data
    for poly in mesh.polygons:
        uv = (
            sum((uvs[i].uv for i in poly.loop_indices), uvs[poly.loop_start].uv * 0) / 3
        )
        part = next(
            p for p in parts if p.uv[0] < uv.x < p.uv[2] and p.uv[1] < uv.y < p.uv[3]
        )
        groups[part.name].append(tuple(poly.vertices))
    verts = points.tolist()
    trees = {
        n: BVHTree.FromPolygons(verts, faces, all_triangles=True)
        for n, faces in groups.items()
    }
    neighbors = {n: set() for n in groups}
    for a, b in combinations(groups, 2):
        if trees[a].overlap(trees[b]):
            neighbors[a].add(b)
            neighbors[b].add(a)
    reached = {"Ventral thorax"}
    frontier = list(reached)
    while frontier:
        new = neighbors[frontier.pop()] - reached
        reached.update(new)
        frontier.extend(new)
    assert reached == groups.keys(), ("unattached plating", groups.keys() - reached)
    return len(reached)


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


def shell_contacts(points: np.ndarray, faces: dict) -> None:
    """Check mechanical continuity and separation on the deformed cuticle triangles."""
    trees = {
        name: BVHTree.FromPolygons(points.tolist(), triangles, all_triangles=True)
        for name, triangles in faces.items()
        if triangles
    }
    for a, b in (
        ("thorax", "shield"),
        ("thorax", "head"),
        ("head", "mandible.L"),
        ("head", "mandible.R"),
    ):
        assert trees[a].overlap(trees[b]), ("disconnected armor or head", a, b)
    assert not trees["mandible.L"].overlap(trees["mandible.R"]), "crossed mandibles"
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
    assert np.max(abs(extent - [0.46, 0.52, 0.48])) < 0.002, extent
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
        "connected_anatomical_parts": assembly(obj.data, rest),
        "clips": {},
    }
    for clip in CLIPS:
        act = select_action(arm, clip)
        start, end = act.frame_range
        prev = None
        metrics = {n: [] for n in FEET}
        minimum_clearance = 1.0
        maximum_head_step = 0.0
        previous_head = None
        wall_skin_error = 0.0
        original_world = arm.matrix_world.copy()
        max_move = 0
        pad_slide = 0
        chest_z = []
        max_root = 0
        min_supports = 6
        min_ground, max_height = 1, 0
        leading_shield = min(groups["shield"], key=lambda i: rest[i, 1])
        armor_height = []
        wall_residual = 0
        hold = None
        hold_drift = 0
        # In Blender +Z is local support normal and -Y forward. Orient the root
        # onto a vertical wall with outward +Y normal and downward -Z travel.
        # X must reverse too for this right-handed surface/travel basis.
        wall = np.array([[-1, 0, 0], [0, 0, 1], [0, 1, 0]], float)
        assert np.linalg.det(wall) == 1 and np.all(wall @ [0, -1, 0] == [0, 0, -1])
        plane = wall @ np.array([0, 0, 1])
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
            verts = pos.tolist()
            shield = BVHTree.FromPolygons(verts, faces["shield"], all_triangles=True)
            head = BVHTree.FromPolygons(verts, faces["head"], all_triangles=True)
            thorax = BVHTree.FromPolygons(verts, faces["thorax"], all_triangles=True)
            assert not shield.overlap(head) and thorax.overlap(head), (
                clip,
                frame,
                "head contact",
            )
            head_points = pos[groups["head"]]
            if previous_head is not None:
                maximum_head_step = max(
                    maximum_head_step,
                    float(np.linalg.norm(head_points - previous_head, axis=1).max()),
                )
            previous_head = head_points
            clearances = []
            for x, y, z in head_points:
                underside = shield.ray_cast((x, y, -1), (0, 0, 1))[0]
                if underside is not None:
                    clearances.append(float(underside.z - z))
            assert clearances and min(clearances) > 0.001, (
                clip,
                frame,
                "head/shield underside clearance",
                min(clearances),
            )
            minimum_clearance = min(minimum_clearance, min(clearances))
            if clip == "armor_brace":
                pad_slide = max(
                    pad_slide,
                    max(
                        float(
                            np.linalg.norm(
                                pos[groups[n]] - rest[groups[n]], axis=1
                            ).max()
                        )
                        for n in FEET
                    ),
                )
            if sample in contact_samples:
                shell_contacts(pos, faces)
                fixture = Matrix(wall.tolist()).to_4x4()
                fixture.translation = (0.2, 0.35, -0.1)
                arm.matrix_world = fixture @ original_world
                bpy.context.view_layer.update()
                posed_wall = positions(obj)
                wall_skin_error = max(
                    wall_skin_error,
                    float(
                        np.linalg.norm(
                            posed_wall
                            - (pos @ wall.T + np.asarray(fixture.translation)),
                            axis=1,
                        ).max()
                    ),
                )
                arm.matrix_world = original_world
                bpy.context.view_layer.update()
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
            min_ground = min(min_ground, float(pos[:, 2].min()))
            max_height = max(max_height, float(pos[:, 2].max()))
            armor_height.append(float(pos[leading_shield, 2]))
            if sample >= len(frames) * 0.84 and clip == "death":
                if hold is None:
                    hold = pos.copy()
                hold_drift = max(
                    hold_drift, float(np.linalg.norm(pos - hold, axis=1).max())
                )
            distances = np.array([pos[groups[n], 2].min() for n in FEET])
            rotated = pos @ wall.T
            wall_distances = np.array(
                [(rotated[groups[n]] @ plane).min() for n in FEET]
            )
            wall_residual = max(
                wall_residual, float(np.abs(distances - wall_distances).max())
            )
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
        assert min_ground > -0.00045 and max_height < 0.60, (
            clip,
            min_ground,
            max_height,
        )
        assert wall_residual < 1e-7 and wall_skin_error < 2e-5, (
            clip,
            wall_residual,
            wall_skin_error,
        )
        assert maximum_head_step < 0.017, (clip, maximum_head_step)
        summary.update(
            minimum_simultaneous_contacts=min_supports,
            maximum_height_m=max_height,
            minimum_surface_distance_m=min_ground,
            head_under_shield_minimum_clearance_m=minimum_clearance,
            maximum_head_subframe_travel_m=maximum_head_step,
            actual_wall_root_skin_max_error_m=wall_skin_error,
            wall_normal=plane.tolist(),
            wall_contact_residual_m=wall_residual,
        )
        if clip == "stomp_walk":
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
                wall_fixture_matrix=wall.tolist(),
                world_normal=plane.tolist(),
                foot_excursions_m={n: [min(h), max(h)] for n, h in metrics.items()},
            )
        else:
            assert first_neutral < 0.00006
            if clip == "armor_brace":
                assert min_supports == 6 and armor_height[0] - min(armor_height) > 0.045
                assert pad_slide < 0.00015, ("brace pad slid", pad_slide)
                summary["maximum_pad_slip_m"] = pad_slide
                summary["leading_shield_drop_m"] = armor_height[0] - min(armor_height)
            if clip == "death":
                assert hold_drift < 0.00003
                summary["collapsed_hold_drift_m"] = hold_drift
                assert chest_z[-1] < chest_z[0] - 0.025 and end_neutral > 0.03
            else:
                assert end_neutral < 0.00006
        result["clips"][clip] = summary
    return result


def contract(path: Path) -> dict:
    glb = Glb(path.read_bytes())
    poses, _parents = glb.scene()
    doc = glb.doc
    assert {a["name"] for a in doc["animations"]} == CLIPS.keys()
    assert len(doc["skins"]) == len(doc["meshes"]) == len(doc["materials"]) == 1
    skin = doc["skins"][0]
    joints = {doc["nodes"][j]["name"]: j for j in skin["joints"]}
    expected = {
        "root": "Brute",
        "shield": "thorax",
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
    forward = float(poses[joints["head"]][2][3] - poses[joints["thorax"]][2][3])
    assert forward > 0.12, ("glTF +Z forward", forward)
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
        "head_forward_of_thorax_gltf_z_m": forward,
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
        path = piece / f"carapace-brute-lod{lod}.glb"
        report[f"lod{lod}"] = {**contract(path), **supports(path)}
    assert (
        report["lod0"]["joints"] == report["lod1"]["joints"]
        and len(report["lod0"]["joints"]) == 24
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
        assert np.all(pixels[:, :, 3] == 255), role
        stats["decoded_alpha_range"] = [
            int(pixels[:, :, 3].min()),
            int(pixels[:, :, 3].max()),
        ]
    write_json(piece / "reimport.json", report)


if __name__ == "__main__":
    main()
