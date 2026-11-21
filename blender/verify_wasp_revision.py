"""Sample the exported dorsal seam and measure the authored projected flight chords."""

import argparse
import hashlib
import json
import sys
from itertools import combinations
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform

HERE = Path(__file__).resolve().parent
sys.path[:0] = [
    str(HERE),
    str(HERE.parent / "scripts"),
    str(HERE.parent / "scripts/assets"),
]
from ktx2 import checked_ktx, decode_ktx2, ktx_run
from package_core_bastion import digest, write_json
from review_core_bastion import import_glb
from review_skitter import neutral
from validate_glbs import Glb
from verify_skitter import positions, select_action
from wasp_rig import CLIPS
from wasp_shape import WINGS


def shape(glb_path: Path, ktx: Path) -> dict:
    glb = Glb(glb_path.read_bytes())
    material = glb.doc["materials"][0]
    levels = {}
    for role, binding in (
        ("emissive", material["emissiveTexture"]),
        ("basecolor", material["pbrMetallicRoughness"]["baseColorTexture"]),
    ):
        encoded, _ = glb.texture_source(glb_path.parent, glb_path, binding)
        assert encoded == (glb_path.parent / f"{role}.ktx2").read_bytes()
        levels[role] = np.frombuffer(decode_ktx2(ktx, encoded), np.uint8).reshape(
            1024, 1024, 4
        )
    import_glb(glb_path)
    arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
    neutral(arm)
    obj = next(o for o in bpy.context.scene.objects if o.type == "MESH")
    mesh = obj.data
    rest = [Vector(v) for v in positions(obj)]
    tree = BVHTree.FromPolygons(
        rest, [tuple(p.vertices) for p in mesh.polygons], all_triangles=True
    )
    counts = {"dorsal": 0, "left": 0, "right": 0}
    cyan = counts.copy()
    max_emission = 0
    for x in np.linspace(-0.055, 0.055, 89):
        for y in np.linspace(-0.15, 0.065, 121):
            hit, _, idx, _ = tree.ray_cast(Vector((x, y, 0.4)), Vector((0, 0, -1)))
            if hit is None:
                continue
            if abs(x) <= 0.013 and -0.115 < y < 0.048:
                area = "dorsal"
            elif abs(x) > 0.018:
                area = "left" if x > 0 else "right"
            else:
                continue
            face = mesh.polygons[idx]
            uv = barycentric_transform(
                hit,
                *[rest[i] for i in face.vertices],
                *[mesh.uv_layers.active.data[i].uv.to_3d() for i in face.loop_indices],
            )
            col, row = int(1024 * uv.x), 1023 - int(1024 * uv.y)
            r, g, b = (int(c) for c in levels["basecolor"][row, col, :3])
            emission = int(levels["emissive"][row, col, :3].max())
            counts[area] += 1
            cyan[area] += int(g > r + 27 and b > r + 27 and g > 70)
            if area == "dorsal":
                max_emission = max(max_emission, emission)
    assert counts["dorsal"] > 1500 and min(cyan["left"], cyan["right"]) > 10
    chord = {}
    for joint, (sign, _) in WINGS.items():
        rows = []
        group = obj.vertex_groups[joint].index
        for station in (0.105, 0.145, 0.178):
            hits = []
            for edge in mesh.edges:
                a, b = edge.vertices
                if mesh.vertices[a].groups[0].group != group:
                    continue
                p, q = rest[a], rest[b]
                plane = sign * station
                if (p.x - plane) * (q.x - plane) < 0:
                    hits.append(p.lerp(q, (plane - p.x) / (q.x - p.x)).y)
            assert hits
            rows.append(max(hits) - min(hits))
        chord[joint] = rows
    return {
        "sha256": digest(glb_path),
        "dorsal_and_flank_samples": counts,
        "cyan_dorsal_and_flank_samples": cyan,
        "dorsal_peak_emission_rgb8": max_emission,
        "wing_chord_at_105_145_178mm_span_m": chord,
    }


def authored_pose_contacts(path: Path) -> dict:
    import_glb(path)
    arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
    obj = next(o for o in bpy.context.scene.objects if o.type == "MESH")
    groups = {k: [] for k in ("thorax", *WINGS, "abdomen", "stylet.L", "stylet.R")}
    for face in obj.data.polygons:
        ids = tuple(face.vertices)
        group = obj.vertex_groups[obj.data.vertices[ids[0]].groups[0].group].name
        groups[group].append(ids)
    result = {}
    for clip, duration in CLIPS.items():
        start, end = select_action(arm, clip).frame_range
        frames = 2 * duration + 1
        peak = 0.0
        for frame in np.linspace(start, end, frames):
            bpy.context.scene.frame_set(int(frame), subframe=float(frame - int(frame)))
            points = positions(obj)
            peak = max(peak, float(points[:, 2].max()))
            vertices = points.tolist()
            trees = {
                k: BVHTree.FromPolygons(vertices, faces, all_triangles=True)
                for k, faces in groups.items()
            }
            for a, b in combinations(WINGS, 2):
                assert not trees[a].overlap(trees[b]), (clip, frame, a, b)
            for name in (*WINGS, "abdomen", "stylet.L", "stylet.R"):
                assert trees["thorax"].overlap(trees[name]), (clip, frame, name)
        assert 0.32 - 0.025 - peak > 0
        result[clip] = {
            "poses_at_60hz_including_endpoints": frames,
            "wing_pair_tests": 6 * frames,
            "attachment_tests": 7 * frames,
            "minimum_clearance_after_25mm_air_bob_m": 0.32 - 0.025 - peak,
        }
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    for arg in ("piece", "original", "ktx"):
        parser.add_argument("--" + arg, type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    piece = args.piece.resolve()
    ktx = checked_ktx(args.ktx.resolve())
    data = json.loads((piece / "reimport.json").read_text())
    for lod in ("lod0", "lod1"):
        filename = f"wasp-skimmer-{lod}.glb"
        before = shape(args.original.resolve() / filename, ktx)
        after = shape(piece / filename, ktx)
        print("DORSAL", lod, before, after, flush=True)
        assert (
            after["dorsal_peak_emission_rgb8"] <= 3
            and after["cyan_dorsal_and_flank_samples"]["dorsal"] == 0
        )
        if lod == "lod1":
            assert before["cyan_dorsal_and_flank_samples"]["dorsal"] > 12
        for joint in WINGS:
            a, b = [
                np.array(v["wing_chord_at_105_145_178mm_span_m"][joint])
                for v in (before, after)
            ]
            assert np.all(b > a * 1.10), (joint, a, b)
        clearances = {
            name: 0.32 - 0.025 - clip["maximum_z_m"]
            for name, clip in data[lod]["clips"].items()
        }
        assert min(clearances.values()) > 0.0
        data[lod]["revision"] = {
            "authored_pose_contacts": authored_pose_contacts(piece / filename),
            "original": before,
            "revised": after,
            "clearance_with_runtime_air_bob_m": clearances,
        }
    chains = {}
    for role in ("normal", "basecolor", "emissive", "orm"):
        chain = []
        for level in range(11):
            edge = 1024 >> level
            raw = ktx_run(
                ktx,
                "extract",
                "--raw",
                "--transcode",
                "rgba8",
                "--level",
                str(level),
                str(piece / f"{role}.ktx2"),
                "-",
            )
            assert len(raw) == 4 * edge**2
            rec = {
                "level": level,
                "edge": edge,
                "rgba_sha256": hashlib.sha256(raw).hexdigest(),
            }
            if role == "normal":
                rgb = np.frombuffer(raw, np.uint8).reshape(-1, 4)[:, :3]
                lengths = np.linalg.norm(rgb.astype(float) / 127.5 - 1, axis=1)
                rec["decoded_unit_length_range"] = [
                    float(lengths.min()),
                    float(lengths.max()),
                ]
                assert lengths.min() >= 0.88 and lengths.max() <= 1.12
            chain.append(rec)
        chains[role] = chain
    data["decoded_mip_chains"] = chains
    write_json(piece / "reimport.json", data)


if __name__ == "__main__":
    main()
