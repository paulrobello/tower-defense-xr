"""Exercise the packaged T1 throat, normals and all moving nodes on both active mounts."""

import argparse
import hashlib
import json
import sys
import tempfile
from contextlib import contextmanager
from math import cos, degrees, sin, tau
from pathlib import Path
from unittest.mock import patch

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import verify_helios as base
from helios_t1_revision import LIP_ANGLE, build, curved_object
from ktx2 import ktx_run
from package_core_bastion import MAPS, digest, write_json
from verify_hover_pod_revision import source_fingerprint
from verify_m44 import close
from verify_m44 import verify_mount as aligned_mount


@contextmanager
def active_mounts():
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        models = root / "assets-source/models"
        models.mkdir(parents=True)
        for name, directory in (
            ("surface-clamp", "surface-clamp"),
            ("hover-pod", "hover-pod-revision"),
        ):
            (models / name).symlink_to(
                HERE.parent / "assets-source/models" / directory,
                target_is_directory=True,
            )
        yield root / "blender"


def mounted_motion(path: Path, head: bpy.types.Object) -> dict:
    result = aligned_mount(path, head)
    bpy.ops.import_scene.gltf(filepath=str(path))
    socket = bpy.data.objects["mountSocket"]
    mount = socket.parent
    head.parent = socket
    mount.rotation_mode = "XYZ"
    mount.rotation_euler = (0.62, -0.23, 0.71)
    mount.location = (0.35, -0.4, 0.77)
    yaw, pitch, recoil, muzzle = (
        bpy.data.objects[n]
        for n in ("yawRing", "pitchCradle", "recoilGroup", "muzzleSocket")
    )
    contract = base.runtime_contract(1)
    c = Vector((0, 0, contract["baseHeightM"] + contract["headHeightM"] / 2))
    neutral = Vector((contract["x"], -contract["z"], contract["y"]))
    fwd = Vector((0, -1, 0))
    samples = []
    for turn, tilt, shift in ((0.7, -0.42, 0.012), (-1.13, 0.32, 0.008), (0, 0, 0)):
        yaw.rotation_euler.z, pitch.rotation_euler.x, recoil.location.y = (
            turn,
            tilt,
            shift,
        )
        bpy.context.view_layer.update()
        rotation = Matrix.Rotation(turn, 3, "Z") @ Matrix.Rotation(tilt, 3, "X")
        expected = mount.matrix_world @ (
            c + rotation @ (neutral - c + Vector((0, shift, 0)))
        )
        close(muzzle.matrix_world.translation, expected)
        close(
            muzzle.matrix_world.to_3x3() @ fwd,
            mount.matrix_world.to_3x3() @ rotation @ fwd,
        )
        samples.append(
            {
                "yaw_rad": turn,
                "pitch_rad": tilt,
                "recoil_m": shift,
                "muzzle_blender_world_m": list(expected),
            }
        )
    head.parent = None
    for obj in reversed([mount, *mount.children_recursive]):
        bpy.data.objects.remove(obj, do_unlink=True)
    return result | {
        "path": str(path.resolve().relative_to(HERE.parent)),
        "mounted_poses": samples,
    }


def chamber_samples(obj: bpy.types.Object, decoded: dict) -> dict:
    c = base.runtime_contract(1)
    center = Vector((0, -c["z"], c["y"]))
    n = Vector((0, -cos(LIP_ANGLE), sin(LIP_ANGLE)))
    up = Vector((0, sin(LIP_ANGLE), cos(LIP_ANGLE)))
    right = Vector((1, 0, 0))
    uv = obj.data.uv_layers.active
    data = {}
    for region, radii in (
        ("orange_lip", (0.82, 0.91)),
        ("dark_throat", (0.40, 0.51, 0.57)),
        ("plasma_center", (0.06, 0.15)),
    ):
        depths, colors = [], []
        for radius in radii:
            for i in range(16):
                angle = (i + 0.31) * tau / 16
                point = (
                    center
                    + (right * cos(angle) + up * sin(angle))
                    * radius
                    * c["barrelRadiusM"]
                )
                hit, local, _, index = obj.ray_cast(
                    obj.matrix_world.inverted() @ (point + 0.04 * n), -n
                )
                assert hit
                face = obj.data.polygons[index]
                st = barycentric_transform(
                    local,
                    *[obj.data.vertices[j].co for j in face.vertices],
                    *[uv.data[j].uv.to_3d() for j in face.loop_indices],
                )
                col, row = int(st.x * 1024), 1023 - int(st.y * 1024)
                colors.append(decoded["emissive"][row, col, :3].astype(int).tolist())
                depth = (point - obj.matrix_world @ local).dot(n)
                depths.append(depth)
        a = np.asarray(colors)
        if region == "dark_throat":
            assert min(depths) > 0.009 and a.max() < 55, (region, depths, colors)
        else:
            assert a[:, 0].min() > 190 and a[:, 2].max() < 120, (region, colors)
            assert (
                max(map(abs, depths)) < 0.00001
                if region == "orange_lip"
                else min(depths) > 0.008
            )
        data[region] = {
            "radii_fraction": radii,
            "sample_count": len(colors),
            "depth_range_mm": [round(v * 1000, 3) for v in (min(depths), max(depths))],
            "decoded_emissive_rgb8_range": [
                a.min(axis=0).tolist(),
                a.max(axis=0).tolist(),
            ],
        }
    return data


def surfaces(meshes: list, tier: int, level: str, decoded: dict) -> tuple:
    charts, record = BASE_SURFACES(meshes, tier, level, decoded)
    record["chamber_optics"] = chamber_samples(
        bpy.data.objects["forward-assembly"], decoded
    )
    ref = curved_object("Physical normals", build(1, level))
    tree = BVHTree.FromPolygons(
        [v.co for v in ref.data.vertices],
        [tuple(p.vertices) for p in ref.data.polygons],
        all_triangles=True,
    )
    planar, curved = [], []
    for obj in meshes:
        mesh = obj.data
        for face in mesh.polygons:
            _, _, index, distance = tree.find_nearest(obj.matrix_world @ face.center)
            assert distance < 2e-6
            expected = ref.data.polygons[index]
            angles = [
                degrees(mesh.corner_normals[i].vector.angle(face.normal))
                for i in face.loop_indices
            ]
            if not expected.use_smooth:
                planar.extend(angles)
            elif obj.name == "turret-head":
                curved.extend(angles)
    assert len(planar) > 100 and max(planar) < 0.1
    assert sum(a > 1 for a in curved) > 250
    record["normals"] = {
        "planar_corners": len(planar),
        "max_planar_error_degrees": round(max(planar), 5),
        "curved_head_corners_over_one_degree": sum(a > 1 for a in curved),
    }
    bpy.data.objects.remove(ref, do_unlink=True)
    return charts, record


BASE_SURFACES = base.check_surfaces


def main() -> None:
    parser = argparse.ArgumentParser()
    for arg in ("piece", "repeat", "ktx"):
        parser.add_argument("--" + arg, required=True, type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    piece, repeat = args.piece.resolve(), args.repeat.resolve()
    with (
        active_mounts() as here,
        patch.object(base, "HERE", here),
        patch.object(base, "build", build),
        patch.object(base, "verify_mount", mounted_motion),
        patch.object(base, "check_surfaces", surfaces),
        patch.object(
            sys,
            "argv",
            [
                __file__,
                "--",
                "--piece",
                str(piece),
                "--repeat-stage",
                str(repeat),
                "--ktx",
                str(args.ktx),
            ],
        ),
    ):
        base.main()
    a, b = source_fingerprint(piece), source_fingerprint(repeat)
    for name, item in a.items():
        key = "geometry_slots_uv_hierarchy_corner_normals_packed_textures_sha256"
        assert item[key] == b[name][key]
        item["repeat_archive_sha256"] = b[name]["sha256"]
    outputs = {}
    for name in [
        "geometry.json",
        *[f"{role}.{ext}" for role in MAPS for ext in ("png", "ktx2")],
        *[f"{piece.name}-lod{i}.glb" for i in (0, 1)],
    ]:
        outputs[name] = digest(piece / name)
        assert outputs[name] == digest(repeat / name)
    chains = {}
    for role in MAPS:
        chain = hashlib.sha256()
        for level in range(11):
            raw = ktx_run(
                args.ktx,
                "extract",
                "--raw",
                "--transcode",
                "rgba8",
                "--level",
                str(level),
                str(piece / f"{role}.ktx2"),
                "-",
            )
            assert len(raw) == 4 * (1024 >> level) ** 2
            chain.update(raw)
        chains[role] = {"levels_decoded": 11, "rgba8_chain_sha256": chain.hexdigest()}
    report = json.loads((piece / "reimport.json").read_text())
    report["decoded_mip_chains"] = chains
    write_json(piece / "reimport.json", report)
    geometry = json.loads((piece / "geometry.json").read_text())
    assert all(
        geometry[f"lod{i}"]["triangles"] <= limit
        for i, limit in enumerate((4072, 1352))
    )
    write_json(
        piece / "determinism.json",
        {
            "platform": "Linux x86_64, Blender 5.2.2 LTS (d13f752e3b9c), Cycles CPU 2 threads, KTX-Software 4.4.2",
            "independent_builds": 2,
            "independent_portable_output_hashes": outputs,
            "editable_sources": a,
        },
    )


if __name__ == "__main__":
    main()
