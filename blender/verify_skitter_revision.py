"""Exercise the imported wall transform and decode every level of all four maps."""

import argparse
import hashlib
import json
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent / "scripts/assets")]
from ktx2 import checked_ktx, ktx_run
from review_core_bastion import import_glb
from review_skitter import WALL
from verify_skitter import FEET, positions, select_action


def oriented_support(glb: Path) -> dict:
    import_glb(glb)
    arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
    mesh = next(o for o in bpy.context.scene.objects if o.type == "MESH")
    root = arm.matrix_world.copy()
    summary = {}
    for clip, transform in (("crawl_floor", Matrix.Identity(4)), ("climb_wall", WALL)):
        arm.matrix_world = transform @ root
        for track in arm.animation_data.nla_tracks:
            track.mute = True
        arm.animation_data.action = None
        for bone in arm.pose.bones:
            bone.matrix_basis = Matrix.Identity(4)
        bpy.context.view_layer.update()
        base = positions(mesh)
        normal = np.asarray(transform)[:3, 2]
        forward = -np.asarray(transform)[:3, 1]
        assert np.array_equal(normal, (0, 1, 0) if clip == "climb_wall" else (0, 0, 1))
        assert np.array_equal(
            forward, (0, 0, -1) if clip == "climb_wall" else (0, -1, 0)
        )
        extent = np.ptp(base, axis=0)
        expected = (0.26, 0.18, 0.34) if clip == "climb_wall" else (0.26, 0.34, 0.18)
        assert abs(extent - expected).max() < 0.002
        groups = {mesh.vertex_groups[n].index: n for n in FEET}
        foot = {name: [] for name in FEET}
        for v in mesh.data.vertices:
            name = groups.get(v.groups[0].group)
            if name:
                foot[name].append(v.index)
        tips = [
            indices[int(np.argmin(base[indices] @ normal))] for indices in foot.values()
        ]
        act = select_action(arm, clip)
        start, end = act.frame_range
        samples = np.linspace(start, end, 2 * round(end - start) + 1)
        min_contacts, lowest = 6, 1
        for f in samples:
            bpy.context.scene.frame_set(int(f), subframe=float(f - int(f)))
            heights = positions(mesh) @ normal
            min_contacts = min(min_contacts, int((abs(heights[tips]) < 0.00035).sum()))
            lowest = min(lowest, float(heights.min()))
        assert min_contacts >= 3 and lowest > -0.0004, (clip, min_contacts, lowest)
        summary[clip] = {
            "evaluated_world_extent_m": extent.tolist(),
            "world_support_normal": normal.tolist(),
            "world_forward": forward.tolist(),
            "world_minimum_all_vertex_plane_distance_m": lowest,
            "minimum_supporting_feet": min_contacts,
            "evaluated_samples": len(samples),
        }
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--piece", type=Path, required=True)
    parser.add_argument("--ktx", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    piece, ktx = args.piece.resolve(), checked_ktx(args.ktx.resolve())
    report = json.loads((piece / "reimport.json").read_text())
    for lod in ("lod0", "lod1"):
        report[lod]["oriented_mesh"] = oriented_support(
            piece / f"skitter-crawler-{lod}.glb"
        )
    chains = {}
    for role in ("normal", "orm", "basecolor", "emissive"):
        maps = []
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
            rgb = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 4)[:, :3]
            rec = {
                "level": level,
                "edge": edge,
                "rgba_sha256": hashlib.sha256(raw).hexdigest(),
                "rgb_min": rgb.min(axis=0).tolist(),
                "rgb_max": rgb.max(axis=0).tolist(),
            }
            if role == "normal":
                lengths = np.linalg.norm(rgb.astype(float) / 127.5 - 1, axis=1)
                rec["decoded_unit_length_range"] = [
                    float(lengths.min()),
                    float(lengths.max()),
                ]
                assert lengths.min() > 0.88 and lengths.max() < 1.12
            maps.append(rec)
        chains[role] = maps
    report["decoded_mip_chains"] = chains
    (piece / "reimport.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
