"""Replay each registered head verifier against the revised pod in an isolated mount tree."""

import argparse
import json
import sys
import tempfile
from pathlib import Path
from types import ModuleType
from unittest.mock import patch

import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path[:0] = [
    str(HERE),
    str(HERE.parent / "scripts"),
    str(HERE.parent / "scripts/assets"),
]
import verify_glacier
import verify_helios
import verify_m44
import verify_valkyrie
from package_core_bastion import digest, write_json
from review_core_bastion import checked_ktx, decode_ktx2, import_glb
from verify_core_bastion import points

FAMILIES = {
    "m44": verify_m44,
    "helios": verify_helios,
    "glacier": verify_glacier,
    "valkyrie": verify_valkyrie,
}


def pose_clearances(
    head: Path, mount: Path, poses: list[dict]
) -> tuple[list[float], int]:
    import_glb(head)
    head_tris = sum(
        len(obj.data.polygons)
        for obj in bpy.context.scene.objects
        if obj.type == "MESH"
    )
    yaw, pitch, recoil, muzzle = [
        bpy.data.objects[key]
        for key in ("yawRing", "pitchCradle", "recoilGroup", "muzzleSocket")
    ]
    moving = [child for child in pitch.children_recursive if child.type == "MESH"]
    neutral = list(muzzle.matrix_world.translation)
    assert bpy.ops.import_scene.gltf(filepath=str(mount)) == {"FINISHED"}
    socket = bpy.data.objects["mountSocket"]
    assert socket.matrix_world == Matrix.Identity(4)
    mount_meshes = [obj for obj in socket.parent.children if obj.type == "MESH"]
    yaw.parent.parent = socket
    socket.parent.location = (0.35, -0.4, 0.77)
    socket.parent.rotation_euler = (0.62, -0.23, 0.71)
    yaw.rotation_mode = pitch.rotation_mode = "XYZ"
    bpy.context.view_layer.update()
    inverse = socket.matrix_world.inverted()
    roof = max((inverse @ p).z for obj in mount_meshes for p in points(obj))
    results = []
    for sample in [
        *poses,
        {"yaw_rad": 0, "pitch_rad": 0, "recoil_m": 0, "muzzle_blender_m": neutral},
    ]:
        yaw.rotation_euler.z = sample.get("yaw_blender_rad", sample.get("yaw_rad"))
        pitch.rotation_euler.x = sample.get(
            "pitch_blender_rad", sample.get("pitch_rad")
        )
        recoil.location.y = sample["recoil_m"]
        rotor = bpy.data.objects.get("rotaryCluster")
        if rotor:
            rotor.rotation_mode = "XYZ"
            rotor.rotation_euler.y = sample.get("rotor_rad") or 0
        bpy.context.view_layer.update()
        expected = sample.get("muzzle_world_blender_m", sample.get("muzzle_blender_m"))
        assert (
            (inverse @ muzzle.matrix_world.translation) - Vector(expected)
        ).length < 3e-6
        gap = min((inverse @ p).z for obj in moving for p in points(obj)) - roof
        if gap <= 0:
            gap = verify_valkyrie.lower_bound_clearance(moving, mount_meshes, inverse)
        assert gap > 0, (head.name, sample, gap)
        results.append(round(gap, 8))
    return results, head_tris


def examine(
    module: ModuleType, row: dict, registry: Path, piece: Path, ktx: Path
) -> dict:
    head = registry / row["file"]
    tier, level = int(row["id"][-1]), "lod" + str(row["lod"])
    assert digest(head) == row["sha256"]
    receipt_path = head.parent / "reimport.json"
    archived = json.loads(receipt_path.read_text())[level]
    assert archived["sha256"] == row["sha256"]
    maps = {
        r: np.frombuffer(
            decode_ktx2(ktx, (head.parent / f"{r}.ktx2").read_bytes()), np.uint8
        ).reshape(1024, 1024, 4)
        for r in ("basecolor", "emissive", "orm")
    }
    extra = [module.runtime_contract(tier)] if module is verify_m44 else []
    result, _ = module.geometry(head, tier, ktx, maps, *extra)
    mount = piece / f"hover-pod-{level}.glb"
    checks = result["mounts"]["hover-pod"]
    assert (
        checks["mount_sha256"] == digest(mount)
        and checks["origin_alignment_on_rotated_anchor"]
    )
    assert result["poses"] == archived["poses"]
    for key in ("bore_centers_blender_m", "chambers", "emitters"):
        if key in result:
            assert json.loads(json.dumps(result[key])) == archived[key], (
                head.name,
                key,
            )
    clearances, assembly_tris = pose_clearances(head, mount, result["poses"])
    geometry = json.loads((piece / "geometry.json").read_text())
    assembly_tris += geometry[level]["triangles"]
    assert assembly_tris <= [6500, 2500][row["lod"]]
    return {
        "head_sha256": digest(head),
        "archived_receipt_sha256": digest(receipt_path),
        "mount_sha256": digest(mount),
        "combined_triangles": assembly_tris,
        "native_facing_optics_and_controls_passed": True,
        "pose_table_matches_original_receipt": True,
        "native_mount_checks": checks,
        "posed_moving_clearance_lower_bounds_m_including_neutral": clearances,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    for arg in ("piece", "registry", "ktx"):
        parser.add_argument("--" + arg, type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    piece, registry, ktx = (
        args.piece.resolve(),
        args.registry.resolve(),
        checked_ktx(args.ktx),
    )
    assert bpy.app.version == (5, 2, 2)
    rows = [
        row
        for row in json.loads((registry / "manifest.json").read_text())["models"]
        if row["id"].split("-")[0] in FAMILIES
    ]
    assert len(rows) == len({(row["id"], row["lod"]) for row in rows}) == 24
    evidence = {}
    with tempfile.TemporaryDirectory() as tmp:
        models = Path(tmp) / "assets-source/models"
        models.mkdir(parents=True)
        (models / "surface-clamp").symlink_to(
            registry / "surface-clamp", target_is_directory=True
        )
        (models / "hover-pod").symlink_to(piece, target_is_directory=True)
        for row in rows:
            mod = FAMILIES[row["id"].split("-")[0]]
            with patch.object(mod, "HERE", Path(tmp) / "blender"):
                evidence.setdefault(row["id"], {})["lod" + str(row["lod"])] = examine(
                    mod, row, registry, piece, ktx
                )
            print("Head compatibility verified:", row["id"], row["lod"], flush=True)
    write_json(piece / "head-compatibility.json", evidence)


if __name__ == "__main__":
    main()
