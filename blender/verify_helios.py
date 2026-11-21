"""Re-import and exercise the staged Helios heads, mounts and decoded atlases."""

import argparse
import sys
from math import cos, sin
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path[:0] = [
    str(HERE),
    str(HERE.parent / "scripts"),
    str(HERE.parent / "scripts/assets"),
]
from core_bastion import object_from_parts
from helios_shape import ASCENT, HOT, LIP_ANGLE, PLASMA, build
from package_core_bastion import digest, write_json
from package_helios import runtime_contract
from review_core_bastion import checked_ktx, decode_ktx2, import_glb
from validate_glbs import check_overlap
from verify_core_bastion import atlas_metrics, points
from verify_m44 import EPS, close, verify_mount, verify_sources
from verify_surface_clamp import verify_albedo


def optics(vertices: list[Vector], contract: dict, tier: int, neutral: Vector) -> list:
    lip_normal = Vector((0, -cos(LIP_ANGLE), sin(LIP_ANGLE)))
    lip_up = Vector((0, sin(LIP_ANGLE), cos(LIP_ANGLE)))
    ascent = Vector((0, -cos(ASCENT), sin(ASCENT)))
    spread = contract["headWidthM"] * (0.25 if tier == 2 else 0.24)
    radius = contract["barrelRadiusM"]
    span = contract["barrelLengthM"]
    records = []
    for dx in (0,) if tier == 1 else (-spread, spread):
        tip = neutral + Vector((dx, 0, 0))
        base = tip - span * ascent
        for anchor, r in ((tip, radius), (base, 0.66 * radius)):
            for offset in (
                Vector((r, 0, 0)),
                Vector((-r, 0, 0)),
                r * lip_up,
                -r * lip_up,
            ):
                assert min((p - anchor - offset).length for p in vertices) < EPS
        records.append(
            {
                "lip_center_blender_m": list(tip),
                "base_center_blender_m": list(base),
                "aperture_radius_m": radius,
                "axial_span_m": (tip - base).length,
                "lip_normal_blender": list(lip_normal),
            }
        )
    assert len(records) == contract["barrelCount"]
    if tier == 3:
        assert max(abs(p.x) for p in vertices) > spread + radius
    return records


def check_surfaces(meshes: list, tier: int, level: str, decoded: dict) -> tuple:
    source = object_from_parts("Physical receiver finishes", build(tier, level))
    labels = [
        source.data.materials[p.material_index].name for p in source.data.polygons
    ]
    tree = BVHTree.FromPolygons(
        [v.co for v in source.data.vertices],
        [tuple(p.vertices) for p in source.data.polygons],
        all_triangles=True,
    )
    bpy.data.objects.remove(source, do_unlink=True)
    # Measure the actual exported UV centroids against independent physical face assignments.
    ranges = {
        "RB.brushed-titanium": (0.73, 1),
        "RB.dark-gunmetal": (0.69, 1),
        "RB.tactical-ceramic": (0, 0.15),
        "Core carbon inserts": (0, 0.15),
        PLASMA: (0.13, 0.27),
        HOT: (0.13, 0.27),
    }
    coverage = {name: [0.0, 0.0] for name in ranges}
    orange = {name: [0.0, 0.0] for name in (PLASMA, HOT)}
    charts = []
    for mesh in meshes:
        assert len(mesh.data.uv_layers) == 1
        uv = mesh.data.uv_layers.active
        for face in mesh.data.polygons:
            tri = tuple((*uv.data[i].uv, 0) for i in face.loop_indices)
            assert all(0 <= a <= 1 for p in tri for a in p[:2])
            charts.append((tri, (0, 0, 1), f"{mesh.name}.{face.index}"))
            u, v = np.mean(tri, axis=0)[:2]
            row, col = 1023 - int(1024 * v), int(1024 * u)
            _, _, idx, err = tree.find_nearest(mesh.matrix_world @ face.center)
            assert err < EPS
            finish = labels[idx]
            metal = decoded["orm"][row, col, 2] / 255
            lo, hi = ranges[finish]
            coverage[finish][0] += face.area * int(lo <= metal <= hi)
            coverage[finish][1] += face.area
            if finish in orange:
                r, g, b = map(int, decoded["emissive"][row, col, :3])
                orange[finish][0] += face.area * int(
                    r > 170 and r > 1.2 * g and g > 2 * b
                )
                orange[finish][1] += face.area
    metallic = {k: a / b for k, (a, b) in coverage.items()}
    emissive = {k: a / b for k, (a, b) in orange.items()}
    assert min(metallic.values()) > 0.90, metallic
    assert min(emissive.values()) > 0.90, emissive
    return charts, {
        "metalness_correct_area_fraction": metallic,
        "molten_emission_correct_area_fraction": emissive,
        "unlit_probes": verify_albedo(charts, decoded["basecolor"]),
    }


def geometry(path: Path, tier: int, ktx: Path, decoded: dict) -> tuple:
    c = runtime_contract(tier)
    import_glb(path)
    root, yaw, pitch, recoil, muzzle = [
        bpy.data.objects[key]
        for key in (
            "heliosHead",
            "yawRing",
            "pitchCradle",
            "recoilGroup",
            "muzzleSocket",
        )
    ]
    assert root.matrix_world == Matrix.Identity(4)
    assert yaw.parent == root and pitch.parent == yaw and recoil.parent == pitch
    assert muzzle.parent == recoil and muzzle.get("socket") is True
    neutral = Vector((c["x"], -c["z"], c["y"]))
    fwd = Vector((0, -1, 0))
    height = c["headHeightM"]
    origin = Vector((0, 0, c["baseHeightM"]))
    pivot = Vector((0, 0, height / 2))
    close(yaw.location, origin)
    close(pitch.location, pivot)
    close(muzzle.matrix_world.translation, neutral)
    close(muzzle.matrix_world.to_3x3() @ fwd, fwd)
    meshes = [obj for obj in root.children_recursive if obj.type == "MESH"]
    assert all(
        len(obj.data.materials) == 1
        and obj.active_material.name == f"Helios T{tier} satin armor"
        for obj in meshes
    )
    hull, optic = bpy.data.objects["turret-head"], bpy.data.objects["forward-assembly"]
    bearing = bpy.data.objects["yaw-bearing"]
    assert bearing.parent == yaw and hull.parent == pitch and optic.parent == recoil
    fork_probe = max(bearing.data.vertices, key=lambda v: abs(v.co.x)).co.copy()
    rest_fork = bearing.matrix_world @ fork_probe
    coords = np.asarray(points(hull))
    extent = coords.max(axis=0) - coords.min(axis=0)
    close(extent, (c["headWidthM"], c["headLengthM"], height))
    overall_top = max(p.z for obj in meshes for p in points(obj))
    assert abs(overall_top - c["totalHeightM"]) < EPS
    moving_bottom = min(p.z for obj in (hull, optic) for p in points(obj))
    tip_records = optics(points(optic), c, tier, neutral)
    level = path.stem.split("-")[-1]
    charts, finishes = check_surfaces(meshes, tier, level, decoded)
    probes = [
        (
            obj,
            obj.data.vertices[0].co.copy(),
            obj.matrix_world @ obj.data.vertices[0].co,
        )
        for obj in (hull, optic)
    ]
    yaw.rotation_mode = pitch.rotation_mode = "XYZ"
    poses = []
    for turn, tilt, shift in ((0.7, -0.42, 0.012), (-1.13, 0.32, 0.008), (0, 0, 0)):
        yaw.rotation_euler.z, pitch.rotation_euler.x, recoil.location.y = (
            turn,
            tilt,
            shift,
        )
        bpy.context.view_layer.update()
        ymat, pmat = Matrix.Rotation(turn, 3, "Z"), Matrix.Rotation(tilt, 3, "X")

        def world(
            v: Vector,
            slide: float,
            yaw_basis: Matrix = ymat,
            pitch_basis: Matrix = pmat,
        ) -> Vector:
            return origin + yaw_basis @ (
                pivot + pitch_basis @ (v - origin - pivot + Vector((0, slide, 0)))
            )

        close(muzzle.matrix_world.translation, world(neutral, shift))
        close(muzzle.matrix_world.to_3x3() @ fwd, ymat @ pmat @ fwd)
        close(bearing.matrix_world @ fork_probe, origin + ymat @ (rest_fork - origin))
        for obj, local, rest in probes:
            close(obj.matrix_world @ local, world(rest, shift if obj == optic else 0))
        poses.append(
            {
                "yaw_blender_rad": turn,
                "pitch_blender_rad": tilt,
                "recoil_m": shift,
                "muzzle_world_blender_m": list(muzzle.matrix_world.translation),
                "fork_world_blender_m": list(bearing.matrix_world @ fork_probe),
            }
        )
    mounts = {}
    for name in ("surface-clamp", "hover-pod"):
        mount = HERE.parent / "assets-source/models" / name / f"{name}-{level}.glb"
        bpy.ops.import_scene.gltf(filepath=str(mount))
        socket = bpy.data.objects["mountSocket"]
        mount_parts = [socket.parent, *socket.parent.children_recursive]
        mount_top = max(
            p.z for obj in mount_parts if obj.type == "MESH" for p in points(obj)
        )
        clearance = moving_bottom - mount_top
        assert clearance > 0.03, (name, clearance)
        for obj in reversed(mount_parts):
            bpy.data.objects.remove(obj, do_unlink=True)
        mounts[name] = verify_mount(mount, root) | {
            "mount_top_m": mount_top,
            "neutral_moving_clearance_m": clearance,
        }
    return {
        "sha256": digest(path),
        "head_dimensions_blender_m": extent.tolist(),
        "overall_height_m": overall_top,
        "chambers": tip_records,
        "poses": poses,
        "mounts": mounts,
        "finishes": finishes,
        "atlas": atlas_metrics(path, ktx),
    }, charts


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--piece", required=True, type=Path)
    parser.add_argument("--repeat-stage", required=True, type=Path)
    parser.add_argument("--ktx", required=True, type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    piece = args.piece.resolve()
    ktx = checked_ktx(args.ktx)
    sources, repeat = verify_sources(piece), verify_sources(args.repeat_stage.resolve())
    for name, original in sources.items():
        key = "geometry_uv_hierarchy_material_slots_sha256"
        assert original[key] == repeat[name][key]
        original["repeat_archive_sha256"] = repeat[name]["sha256"]
    decoded = {
        role: np.frombuffer(
            decode_ktx2(ktx, (piece / f"{role}.ktx2").read_bytes()), np.uint8
        ).reshape(1024, 1024, 4)
        for role in ("basecolor", "emissive", "orm")
    }
    charts = []
    report = {"editable_sources": sources}
    for level in ("lod0", "lod1"):
        report[level], faces = geometry(
            piece / f"{piece.name}-{level}.glb", int(piece.name[-1]), ktx, decoded
        )
        charts.extend(faces)
    check_overlap(charts)
    report["combined_positive_area_uv_overlaps"] = 0
    write_json(piece / "reimport.json", report)


if __name__ == "__main__":
    main()
