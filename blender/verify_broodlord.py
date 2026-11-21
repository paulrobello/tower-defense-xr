"""Measure the reimported Broodlord skin, inverse binds, support and clip endpoints."""

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
from broodlord_rig import CLIPS
from broodlord_shape import PALETTE, anatomy
from core_bastion import color
from ktx2 import decode_ktx2, ktx_run
from package_core_bastion import digest, write_json
from review_core_bastion import import_glb
from validate_glbs import Glb, check_overlap
from verify_core_bastion import atlas_metrics
from verify_skitter import editable, positions, select_action

SIDES = ("L", "R")
ROWS = ("fore", "hind")
FEET = [f"blade_{row}.{side}" for side in SIDES for row in ROWS]


def assembly(mesh: bpy.types.Mesh, points: np.ndarray) -> int:
    parts = anatomy("lod0")
    groups = {p.name: [] for p in parts}
    chart_bounds = {p.name: [1.0, 1.0, 0.0, 0.0] for p in parts}
    uvs = mesh.uv_layers.active.data
    for poly in mesh.polygons:
        uv = (
            sum((uvs[i].uv for i in poly.loop_indices), uvs[poly.loop_start].uv * 0) / 3
        )
        part = next(
            p for p in parts if p.uv[0] < uv.x < p.uv[2] and p.uv[1] < uv.y < p.uv[3]
        )
        groups[part.name].append(tuple(poly.vertices))
        bounds = chart_bounds[part.name]
        for l in poly.loop_indices:
            u, v = uvs[l].uv
            bounds[0] = min(bounds[0], u)
            bounds[1] = min(bounds[1], v)
            bounds[2] = max(bounds[2], u)
            bounds[3] = max(bounds[3], v)
    assert len(mesh.uv_layers) == 1
    for part in parts:
        assert np.max(np.abs(np.array(chart_bounds[part.name]) - part.uv)) < 2e-6, (
            "atlas drift",
            part.name,
        )
    for part in parts:
        triangles = groups[part.name]
        assert triangles, part.name
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

    def scalar(value: object) -> object:
        if isinstance(value, (str, int, float, bool)) or value is None:
            return value
        return list(value)

    materials = {}
    for mat in obj.data.materials:
        tree = mat.node_tree
        graph = []
        for node in sorted(tree.nodes, key=lambda n: n.name):
            record_node = {
                "type": node.bl_idname,
                "name": node.name,
                "inputs": [
                    (i.identifier, scalar(i.default_value))
                    for i in node.inputs
                    if hasattr(i, "default_value")
                    and (
                        not hasattr(i.default_value, "bl_rna")
                        or hasattr(i.default_value, "__iter__")
                    )
                ],
            }
            if node.type == "VALTORGB":
                record_node["ramp"] = [
                    (el.position, list(el.color)) for el in node.color_ramp.elements
                ]
            if node.type == "TEX_IMAGE" and node.image is not None:
                record_node["image"] = [
                    node.image.colorspace_settings.name,
                    hashlib.sha256(bytes(node.image.packed_file.data)).hexdigest(),
                ]
            graph.append(record_node)
        links = sorted(
            (
                l.from_node.name,
                l.from_socket.identifier,
                l.to_node.name,
                l.to_socket.identifier,
            )
            for l in tree.links
        )
        materials[mat.name] = [graph, links]
    record["editable_material_graphs_sha256"] = hashlib.sha256(
        json.dumps(materials, sort_keys=True).encode()
    ).hexdigest()
    record.update(
        skeleton_and_groups_sha256=hashlib.sha256(
            json.dumps([skeleton, sorted(groups)]).encode()
        ).hexdigest(),
        clips_sha256=clips,
    )
    return record


def anatomy_contacts(points: np.ndarray, faces: dict) -> None:
    verts = points.tolist()
    trees = {
        n: BVHTree.FromPolygons(verts, ix, all_triangles=True)
        for n, ix in faces.items()
        if ix
    }

    def touches(a: str, b: str) -> bool:
        return bool(trees[a].overlap(trees[b]))

    pairs = [("thorax", "abdomen"), ("thorax", "head")]
    for side in SIDES:
        pairs.extend(
            [
                ("head", f"crest.{side}"),
                ("thorax", f"brachium.{side}"),
                (f"brachium.{side}", f"forearm.{side}"),
                (f"forearm.{side}", f"palm.{side}"),
            ]
        )
    legs = []
    for foot in FEET:
        suffix = foot.removeprefix("blade_")
        chain = [f"{p}_{suffix}" for p in ("coxa", "femur", "tibia", "blade")]
        pairs.extend(zip(["thorax", *chain[:-1]], chain, strict=True))
        legs.append(chain)
    for a, b in pairs:
        assert touches(a, b), ("broken bearing", a, b)
    for a, b in combinations(legs, 2):
        assert not any(touches(i, j) for i in a for j in b), ("crossed legs", a, b)
    for side in SIDES:
        for n in (
            "head",
            "thorax",
            f"crest.{side}",
            f"palm.{'R' if side == 'L' else 'L'}",
            *(p for chain in legs for p in chain),
        ):
            assert not touches(f"palm.{side}", n), ("claw interference", side, n)
        # The distal leg blades must remain outside the shell.
        for row in ROWS:
            for segment in ("tibia", "blade"):
                assert not touches(f"{segment}_{row}.{side}", "thorax")


def supports(path: Path) -> dict:
    from review_skitter import neutral

    import_glb(path)
    arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
    obj = next(o for o in bpy.context.scene.objects if o.type == "MESH")
    neutral(arm)
    rest = positions(obj)
    extent = np.ptp(rest, axis=0)
    assert np.max(abs(extent - [0.78, 0.92, 0.84])) < 0.002, extent
    faces = {g.name: [] for g in obj.vertex_groups}
    for poly in obj.data.polygons:
        group = obj.vertex_groups[
            obj.data.vertices[poly.vertices[0]].groups[0].group
        ].name
        faces[group].append(tuple(poly.vertices))
    groups = {n: np.unique(f) for n, f in faces.items() if f}
    result = {
        "neutral_width_length_height_m": extent.tolist(),
        "neutral_min_z_m": float(rest[:, 2].min()),
        "anatomical_parts": assembly(obj.data, rest),
        "atlas": "Reimported UV0 bounds match every authored patch within 2e-6 UV at both LODs.",
        "clips": {},
    }
    tips = {}
    parts = anatomy("lod0")
    uv = obj.data.uv_layers.active.data
    for side in SIDES:
        chart = next(p.uv for p in parts if p.name == f"Swept crest {side}")
        threshold = chart[1] + 0.72 * (chart[3] - chart[1])
        tips[side] = np.unique(
            [
                obj.data.loops[i].vertex_index
                for poly in obj.data.polygons
                for i in poly.loop_indices
                if chart[0] - 1e-7 <= uv[i].uv.x <= chart[2] + 1e-7
                and threshold <= uv[i].uv.y <= chart[3] + 1e-7
            ]
        )
        assert len(tips[side]) >= 6
    bind_head = np.array(arm.matrix_world @ arm.pose.bones["head"].matrix)
    bind_root = np.array(arm.matrix_world @ arm.pose.bones["root"].matrix)
    maxdim = {
        "spawn_adds": "abdomen",
        "emp_roar": "palm.L",
        "phase2_shift": "crest.L",
        "hit": "head",
        "death": "thorax",
    }
    for clip in CLIPS:
        act = select_action(arm, clip)
        start, end = act.frame_range
        times = np.linspace(start, end, 2 * CLIPS[clip] + 1)
        clearance_times = {
            times[i]
            for i in (
                0,
                1,
                len(times) // 4,
                len(times) // 2,
                len(times) // 2 + 1,
                3 * len(times) // 4,
                -1,
            )
        }
        foot_z = []
        height = []
        lows = []
        root_errors = []
        wall_errors = []
        tip_gaps = []
        drift = []
        parts_travel = []
        first = None
        hold = None
        hold_error = 0.0
        for t in times:
            bpy.context.scene.frame_set(int(t), subframe=float(t - int(t)))
            v = positions(obj)
            head_pose = np.array(arm.matrix_world @ arm.pose.bones["head"].matrix)
            head_delta = head_pose @ np.linalg.inv(bind_head)
            side_axis = head_delta[:3, 0]
            tip_gaps.append(
                float(
                    np.min(v[tips["L"]] @ side_axis) - np.max(v[tips["R"]] @ side_axis)
                )
            )
            assert tip_gaps[-1] > 0.010, (
                "distal crest crossing",
                clip,
                t,
                tip_gaps[-1],
            )
            if first is None:
                first = v.copy()
            if clip == "boss_march" and t in clearance_times:
                wall = Matrix(((-1, 0, 0, 0), (0, 0, 1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
                previous = arm.matrix_world.copy()
                arm.matrix_world = wall @ previous
                bpy.context.view_layer.update()
                rotated = positions(obj)
                err = float(np.max(np.abs(rotated - v @ np.array(wall)[:3, :3].T)))
                assert err < 2e-5 and np.min(rotated[:, 1]) > -0.0005, (
                    "surface basis",
                    err,
                )
                wall_errors.append(err)
                arm.matrix_world = previous
                bpy.context.view_layer.update()
            if t in clearance_times:
                try:
                    anatomy_contacts(v, faces)
                except AssertionError as err:
                    raise AssertionError((clip, t, *err.args)) from err
            foot_z.append([float(v[groups[n], 2].min()) for n in FEET])
            height.append(float(v[:, 2].max()))
            lows.append(float(v[:, 2].min()))
            if lows[-1] < -0.0005:
                group = min(groups, key=lambda n: v[groups[n], 2].min())
                raise AssertionError((clip, t, "below ground", group, lows[-1]))
            root_errors.append(
                float(
                    np.max(
                        abs(
                            np.array(arm.matrix_world @ arm.pose.bones["root"].matrix)
                            - bind_root
                        )
                    )
                )
            )
            drift.append(float(np.linalg.norm(v - first, axis=1).max()))
            if clip in maxdim:
                relevant = groups[maxdim[clip]]
                parts_travel.append(
                    float(np.linalg.norm(v[relevant] - rest[relevant], axis=1).max())
                )
            if clip == "death" and t >= start + 0.85 * (end - start):
                if hold is None:
                    hold = v.copy()
                hold_error = max(
                    hold_error, float(np.linalg.norm(v - hold, axis=1).max())
                )
        fz = np.array(foot_z)
        contacts = fz < 0.0005
        assert min(lows) > -0.0005 and max(height) < 1.02, (
            clip,
            min(lows),
            max(height),
        )
        assert max(root_errors) < 2e-5 and max(drift) > 0.012
        if clip == "boss_march":
            assert drift[-1] < 4e-5 and min(contacts.sum(axis=1)) >= 2, (
                drift[-1],
                contacts.sum(axis=1).min(),
                start,
                end,
                fz.max(axis=0),
            )
            assert all(fz.max(axis=0) > 0.035) and all(fz.min(axis=0) < 0.0001)
            assert np.all(contacts[:, 0] == contacts[:, 3]) and np.all(
                contacts[:, 1] == contacts[:, 2]
            )
            assert np.any(contacts[:, 0] & ~contacts[:, 1]) and np.any(
                contacts[:, 1] & ~contacts[:, 0]
            )
        else:
            assert np.max(np.abs(fz)) < 0.0005, (
                clip,
                "blade planted",
                fz.max(),
                fz.min(),
            )
            assert np.linalg.norm(first - rest, axis=1).max() < 0.0001
            if clip == "death":
                assert max(height) - height[-1] > 0.11 and hold_error < 0.0001, (
                    height[0],
                    height[-1],
                    hold_error,
                )
            else:
                assert drift[-1] < 0.0001 and max(parts_travel) > 0.023, (
                    clip,
                    max(parts_travel),
                )
        result["clips"][clip] = {
            "half_frame_samples": len(times),
            "mesh_clearance_and_connectivity_samples": len(clearance_times),
            "min_supports": int(contacts.sum(axis=1).min()),
            "foot_min_max_m": np.stack(
                (fz.min(axis=0), fz.max(axis=0)), axis=1
            ).tolist(),
            "bounds_z_range_m": [min(lows), max(height)],
            "peak_vertex_travel_m": max(drift),
            "endpoint_delta_m": drift[-1],
            "root_matrix_drift": max(root_errors),
            "distal_crest_minimum_separating_gap_m": min(tip_gaps),
            "wall_basis_skin_max_error_m": max(wall_errors) if wall_errors else None,
            "prominent_region": maxdim.get(clip, "blade tips"),
            "prominent_region_peak_travel_m": max(parts_travel)
            if parts_travel
            else float(fz.max()),
            "terminal_hold_error_m": hold_error,
        }

    def snapshot(clip: str, t: float) -> dict:
        action = select_action(arm, clip)
        start, end = action.frame_range
        time = start + (end - start) * t
        bpy.context.scene.frame_set(int(time), subframe=time - int(time))
        return {bone.name: bone.matrix_basis.decompose() for bone in arm.pose.bones}

    result["transition_previews"] = {}
    for first_clip, a, last_clip, b in (
        ("boss_march", 0.31, "spawn_adds", 0.10),
        ("emp_roar", 0.35, "hit", 0.30),
        ("phase2_shift", 0.42, "death", 0.17),
    ):
        begin = snapshot(first_clip, a)
        end_pose = snapshot(last_clip, b)
        arm.animation_data.action = None
        lowest = 1.0
        highest = 0.0
        root_error = 0.0
        for mix in (0.0, 0.25, 0.5, 0.75, 1.0):
            for bone in arm.pose.bones:
                t1, q1, s1 = begin[bone.name]
                t2, q2, s2 = end_pose[bone.name]
                bone.matrix_basis = Matrix.LocRotScale(
                    t1.lerp(t2, mix), q1.slerp(q2, mix), s1.lerp(s2, mix)
                )
            bpy.context.view_layer.update()
            points = positions(obj)
            anatomy_contacts(points, faces)
            lowest = min(lowest, float(points[:, 2].min()))
            highest = max(highest, float(points[:, 2].max()))
            root_error = max(
                root_error,
                float(
                    np.max(
                        abs(
                            np.array(arm.matrix_world @ arm.pose.bones["root"].matrix)
                            - bind_root
                        )
                    )
                ),
            )
        assert highest < 1.02 and lowest > -0.002 and root_error < 2e-5, (
            first_clip,
            last_clip,
            lowest,
            highest,
            root_error,
        )
        result["transition_previews"][f"{first_clip}_to_{last_clip}"] = {
            "normalized_clip_times": [a, b],
            "blend_samples": 5,
            "minimum_z_m": lowest,
            "maximum_z_m": highest,
            "root_drift": root_error,
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
    expected = {
        "root": "Broodlord",
        "thorax": "root",
        "head": "thorax",
        "abdomen": "thorax",
    }
    for side in SIDES:
        expected.update(
            {
                f"crest.{side}": "head",
                f"brachium.{side}": "thorax",
                f"forearm.{side}": f"brachium.{side}",
                f"palm.{side}": f"forearm.{side}",
            }
        )
    for foot in FEET:
        suffix = foot.removeprefix("blade_")
        coxa, femur, tibia = [f"{n}_{suffix}" for n in ("coxa", "femur", "tibia")]
        expected.update({coxa: "thorax", femur: coxa, tibia: femur, foot: tibia})
    assert joints.keys() == expected.keys()
    assert all(
        doc["nodes"][_parents[i]]["name"] == expected[name]
        for name, i in joints.items()
    )
    assert "phase2-cracks" not in json.dumps(doc["images"])
    assert np.max(abs(np.array(poses[_parents[joints["root"]]]) - np.eye(4))) < 1e-7
    assert np.max(abs(np.array(poses[joints["root"]])[:3, 3])) < 1e-7
    forward = float(poses[joints["head"]][2][3] - poses[joints["thorax"]][2][3])
    assert forward > 0.10, ("glTF +Z forward", forward)
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
        "mean_texels_per_meter": float(2048 * (uv_area / area) ** 0.5),
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
        path = piece / f"apex-broodlord-lod{lod}.glb"
        report[f"lod{lod}"] = {**contract(path), **supports(path)}
    assert (
        report["lod0"]["joints"] == report["lod1"]["joints"]
        and len(report["lod0"]["joints"]) == 28
    )
    report["atlas"] = atlas_metrics(path, args.ktx.resolve())
    report["sources"] = {
        n: source_fingerprint(piece / n) for n in ("high.blend", "low.blend")
    }
    for key in ("skeleton_and_groups_sha256", "clips_sha256"):
        assert (
            report["sources"]["high.blend"][key] == report["sources"]["low.blend"][key]
        ), key
    for role in ("basecolor", "normal", "orm", "emissive", "phase2-cracks"):
        texture_path = piece / f"{role}.ktx2"
        mips = []
        for level in range(12):
            side = 2048 >> level
            raw = ktx_run(
                args.ktx.resolve(),
                "extract",
                "--raw",
                "--transcode",
                "rgba8",
                "--level",
                str(level),
                str(texture_path),
                "-",
            )
            pixels = np.frombuffer(raw, np.uint8).reshape(side, side, 4)
            assert np.all(pixels[:, :, 3] == 255), (role, level)
            row = {
                "level": level,
                "decoded_rgba8_texels": side * side,
                "alpha": [255, 255],
            }
            if level == 0 and role in ("basecolor", "orm", "emissive"):
                parts = anatomy("lod0")
                checks = []
                for name in (
                    "Swept crest L",
                    "Ventral thorax",
                    "Eye L",
                    "Crest vein L",
                ):
                    part = next(p for p in parts if p.name == name)
                    a, b, c, d = part.uv
                    x = int((0.45 * a + 0.55 * c) * side)
                    y = side - 1 - int((0.45 * b + 0.55 * d) * side)
                    rgb = pixels[y, x, :3].astype(int)
                    pigment, rough, metal = PALETTE[part.finish]
                    if role == "orm":
                        assert (
                            abs(rgb[2] / 255 - metal) <= 0.065
                            and abs(rgb[1] / 255 - rough) <= 0.14
                        ), (name, role, rgb)
                    elif role == "emissive" and part.finish not in ("spine", "eye"):
                        assert np.max(rgb) <= 8, (name, role, rgb)
                    else:
                        linear = np.array(color(pigment)[:3])

                        def srgb(v: np.ndarray) -> np.ndarray:
                            return 255 * np.where(
                                v <= 0.0031308,
                                12.92 * v,
                                1.055 * np.maximum(0, v) ** (1 / 2.4) - 0.055,
                            )

                        assert np.all(rgb >= srgb(0.50 * linear) - 14) and np.all(
                            rgb <= srgb(1.45 * linear) + 14
                        ), (name, role, rgb)
                    checks.append(
                        {
                            "surface": name,
                            "source_finish": part.finish,
                            "decoded_rgb8": rgb.tolist(),
                        }
                    )
                row["source_recipe_probes"] = checks
            if role == "normal":
                v = pixels[:, :, :3].astype(np.float32) / 127.5 - 1
                lens = np.linalg.norm(v, axis=2)
                row["normal_length_range"] = [float(lens.min()), float(lens.max())]
                assert (
                    np.min(v[:, :, 2]) >= -1 / 255
                    and np.min(lens) >= 0.88
                    and np.max(lens) <= 1.12
                ), (level, row)
            mips.append(row)
        report.setdefault("decoded_mips", {})[role] = mips
    data = np.frombuffer(
        decode_ktx2(args.ktx.resolve(), (piece / "phase2-cracks.ktx2").read_bytes()),
        np.uint8,
    ).reshape(2048, 2048, 4)
    assert (
        np.all(data[:, :, 3] == 255)
        and np.max(np.ptp(data[:, :, :3].astype(np.int16), axis=2)) <= 3
    )
    checks = json.loads((piece / "geometry.json").read_text())["bake"]["phase2-cracks"][
        "samples"
    ]
    for item in checks:
        assert (
            np.max(np.abs(data[item["y"], item["x"], :3].astype(int) - item["rgb"]))
            <= item["tolerance"]
        ), item
    report["phase2_cracks"] = {
        "sha256": digest(piece / "phase2-cracks.ktx2"),
        "decoded_rgba_bytes": data.size,
        "intact_and_bright_probes": checks,
        "alpha_range": [255, 255],
        "srgb": True,
    }
    write_json(piece / "reimport.json", report)


if __name__ == "__main__":
    main()
