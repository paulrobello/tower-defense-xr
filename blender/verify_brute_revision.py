"""Validate the revised anatomy with the original posed Brute checks and all decoded mips."""

import hashlib
import json
import sys
from pathlib import Path
from unittest.mock import patch

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.geometry import convex_hull_2d

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent / "scripts/assets")]
import verify_brute
from carapace_brute_revision import anatomy
from ktx2 import checked_ktx, ktx_run
from package_core_bastion import write_json
from review_core_bastion import import_glb
from verify_core_bastion_revision import logical
from verify_skitter import positions, select_action

original_fingerprint = verify_brute.source_fingerprint


def editable(path: Path) -> dict:
    record = original_fingerprint(path)
    record["scene_normals_material_nodes_packed_images_sha256"] = logical(path)
    return record


def heel_contact(path: Path) -> dict:
    import_glb(path)
    arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
    mesh = next(o for o in bpy.context.scene.objects if o.type == "MESH")
    for track in arm.animation_data.nla_tracks:
        track.mute = True
    arm.animation_data.action = None
    for bone in arm.pose.bones:
        bone.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()
    neutral = positions(mesh)
    soles = {}
    patches = {}
    for name in verify_brute.FEET:
        slot = mesh.vertex_groups[name].index
        ids = sorted(
            {
                v.index
                for v in mesh.data.vertices
                if v.groups[0].group == slot and abs(neutral[v.index, 2]) < 0.00001
            }
        )
        xy = neutral[ids, :2]
        outline = xy[convex_hull_2d([Vector(v) for v in xy])]
        following = np.roll(outline, -1, axis=0)
        area = (
            abs(
                np.sum(
                    outline[:, 0] * following[:, 1] - outline[:, 1] * following[:, 0]
                )
            )
            / 2
        )
        width, length = np.ptp(xy, axis=0)
        # The previous receivers seated on 34.74 × 44.76 mm patches.
        assert width > 0.038 and length > 0.046 and area > 0.0014
        patches[name] = {
            "width_m": float(width),
            "length_m": float(length),
            "convex_area_m2": float(area),
        }
        soles[name] = ids
    action = select_action(arm, "armor_brace")
    first, last = action.frame_range
    frames = np.linspace(first, last, 2 * round(last - first) + 1)
    largest = 0
    for frame in frames:
        bpy.context.scene.frame_set(int(frame), subframe=float(frame - int(frame)))
        posed = positions(mesh)
        for ids in soles.values():
            largest = max(largest, float(abs(posed[ids, 2]).max()))
    assert largest < 0.00015
    return {
        "samples": len(frames),
        "neutral_contact_patches": patches,
        "maximum_sole_plane_residual_m": largest,
    }


def main() -> None:
    with (
        patch.object(verify_brute, "anatomy", anatomy),
        patch.object(verify_brute, "source_fingerprint", editable),
    ):
        verify_brute.main()
    if "--piece" not in sys.argv:
        return
    piece = Path(sys.argv[sys.argv.index("--piece") + 1])
    ktx = checked_ktx(Path(sys.argv[sys.argv.index("--ktx") + 1]).resolve())
    report = json.loads((piece / "reimport.json").read_text())
    for lod in ("lod0", "lod1"):
        report[lod]["brace_heel_contact"] = heel_contact(
            piece / f"carapace-brute-{lod}.glb"
        )
    chains = {}
    for role in ("basecolor", "emissive", "normal", "orm"):
        levels = []
        for i in range(11):
            raw = ktx_run(
                ktx,
                "extract",
                "--raw",
                "--transcode",
                "rgba8",
                "--level",
                str(i),
                str(piece / f"{role}.ktx2"),
                "-",
            )
            edge = 1024 >> i
            pixels = np.frombuffer(raw, dtype=np.uint8).reshape(edge, edge, 4)
            assert np.all(pixels[:, :, 3] == 255)
            entry = {
                "level": i,
                "edge": edge,
                "rgba_sha256": hashlib.sha256(raw).hexdigest(),
            }
            if role == "normal":
                lengths = np.linalg.norm(
                    pixels[:, :, :3].astype(float) / 127.5 - 1, axis=2
                )
                entry["decoded_unit_length_range"] = [
                    float(lengths.min()),
                    float(lengths.max()),
                ]
                assert 0.88 < lengths.min() and lengths.max() < 1.12
            levels.append(entry)
        chains[role] = levels
    report["decoded_mip_chains"] = chains
    write_json(piece / "reimport.json", report)


if __name__ == "__main__":
    main()
