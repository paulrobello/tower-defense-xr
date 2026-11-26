"""Inspect the serialized Rift Spitter skin, clip endpoints and six moving feet."""

import argparse
import hashlib
import json
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from skitter_rig import CLIPS
from verify_skitter import FEET, positions, select_action


def inspect(path: Path) -> dict:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = 30
    bpy.ops.import_scene.gltf(filepath=str(path), bone_heuristic="BLENDER")
    (arm,) = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
    (mesh,) = [
        o
        for o in bpy.context.scene.objects
        if o.type == "MESH" and o.find_armature() == arm
    ]
    ad = arm.animation_data
    assert {t.name for t in ad.nla_tracks} == CLIPS.keys()
    for tr in ad.nla_tracks:
        tr.mute = True
    ad.action = None
    for bone in arm.pose.bones:
        bone.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()
    rest = positions(mesh)
    root = np.array(arm.matrix_world @ arm.pose.bones["root"].matrix)
    feet = {name: [] for name in FEET}
    for v in mesh.data.vertices:
        assert len(v.groups) == 1 and abs(v.groups[0].weight - 1) < 1e-6
        name = mesh.vertex_groups[v.groups[0].group].name
        if name in feet:
            feet[name].append(v.index)
    result = {
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "rest_extent_xyz_m": np.ptp(rest, axis=0).tolist(),
        "min_z_m": float(rest[:, 2].min()),
        "claw_rest_z_m": [float(rest[ids, 2].min()) for ids in feet.values()],
        "joints": len(arm.pose.bones),
        "materials": len(mesh.data.materials),
        "triangles": len(mesh.data.polygons),
        "clips": {},
    }
    assert np.allclose(result["rest_extent_xyz_m"], [0.30, 0.40, 0.24], atol=1e-6)
    assert max(abs(v) for v in result["claw_rest_z_m"]) < 1e-6
    assert result["joints"] == 23 and result["materials"] == 1
    for clip, count in CLIPS.items():
        act = select_action(arm, clip)
        start, end = act.frame_range
        assert abs(end - start - count) < 1e-4, (clip, act.frame_range)
        travel, drift, clearances = 0, 0, []
        for sample, frame in enumerate(np.linspace(start, end, 2 * count + 1)):
            whole = int(frame)
            bpy.context.scene.frame_set(whole, subframe=float(frame - whole))
            pos = positions(mesh)
            if sample == 0:
                first = pos.copy()
            travel = max(travel, float(np.linalg.norm(pos - first, axis=1).max()))
            drift = max(
                drift,
                float(
                    abs(
                        np.array(arm.matrix_world @ arm.pose.bones["root"].matrix)
                        - root
                    ).max()
                ),
            )
            clearances.append([float(pos[ids, 2].min()) for ids in feet.values()])
        foot = np.array(clearances)
        seam = float(np.linalg.norm(pos - first, axis=1).max())
        support_error = float(np.sort(np.abs(foot), axis=1)[:, 2].max())
        min_swing = float(foot.max(axis=0).min())
        assert travel > 0.005 and drift < 2.0e-5
        if clip in ("crawl_floor", "climb_wall"):
            assert seam < 3.0e-5 and min_swing > 0.009, (clip, seam, min_swing)
            assert support_error < 0.00035 and foot.min() > -0.0004, (
                clip,
                support_error,
                foot.min(),
            )
            contact = abs(foot) < 0.00035
            for a, b in ((0, 2), (0, 4), (1, 3), (1, 5)):
                assert np.array_equal(contact[:, a], contact[:, b])
            assert np.any(contact[:, 0] & ~contact[:, 1]) and np.any(
                contact[:, 1] & ~contact[:, 0]
            )
        elif clip == "death":
            assert seam > 0.03
        else:
            assert seam < 3.0e-5
        result["clips"][clip] = {
            "duration_s": count / 30,
            "samples": len(foot),
            "max_vertex_travel_m": travel,
            "root_matrix_drift": drift,
            "first_last_vertex_error_m": seam,
            "min_foot_z_m": float(foot.min()),
            "third_closest_foot_max_plane_error_m": support_error,
            "minimum_across_six_peak_foot_heights_m": min_swing,
        }
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--piece", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    result = {
        f"lod{lod}": inspect((args.piece / f"rift-spitter-lod{lod}.glb").resolve())
        for lod in (0, 1)
    }
    args.report.write_text(json.dumps(result, indent=2) + "\n")
    print(
        "Verified both skins, five actions, six contact trajectories and in-place loops."
    )


if __name__ == "__main__":
    main()
