"""Reimport the revised fork, measure exposed channels, and pose it on both active mounts."""

import argparse
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import verify_glacier as family
from glacier_t2_revision import build, recessed_housing
from ktx2 import ktx_run
from package_core_bastion import MAPS, digest, write_json
from review_core_bastion import checked_ktx, decode_ktx2
from verify_core_bastion import points
from verify_m44 import EPS, verify_sources

MOUNTS = {"surface-clamp": "surface-clamp", "hover-pod": "hover-pod-revision"}


def exposed_fork(vertices: list, contract: dict, tier: int, neutral: Vector) -> list:
    assert tier == 2
    hull = bpy.data.objects["turret-head"]
    hv = points(hull)
    # Clip casing edges to the fork-height band before measuring the free projection.
    low = neutral.z - 0.026
    limits = [p.y for p in hv if p.z >= low]
    for edge in hull.data.edges:
        a, b = [hv[i] for i in edge.vertices]
        if (a.z - low) * (b.z - low) < 0:
            limits.append(a.lerp(b, (low - a.z) / (b.z - a.z)).y)
    free = min(limits) - neutral.y
    assert free > 0.109, free
    rec = []
    for sign in (-1, 1):
        tip_x = sign * contract["headWidthM"] * 0.26
        section_widths = []
        half = [v for v in vertices if v.x * sign > 0]
        for v in half:
            assert abs(v.x) > 0.023 and abs(v.x - tip_x) <= contract["barrelRadiusM"]
        assert abs(min(v.y for v in half) - neutral.y) < EPS
        assert abs(max(v.y for v in half) - neutral.y - contract["barrelLengthM"]) < EPS
        for fraction in (0.45, 0.78, 1.0):
            y = neutral.y + (1 - fraction) * contract["barrelLengthM"]
            ring = [v for v in half if abs(v.y - y) < EPS]
            lo, hi = min(v.x for v in ring), max(v.x for v in ring)
            assert abs((lo + hi) / 2 - tip_x) < EPS
            section_widths.append(hi - lo)
            if fraction == 1:
                assert (
                    abs(
                        (min(v.z for v in ring) + max(v.z for v in ring)) / 2
                        - neutral.z
                    )
                    < EPS
                )
        assert section_widths[0] > section_widths[1] > 2 * section_widths[2]
        rec.append(
            {
                "tip_center_blender_m": [tip_x, neutral.y, neutral.z],
                "axial_length_m": contract["barrelLengthM"],
                "exposed_beyond_casing_m": free,
                "minimum_half_gap_m": min(abs(p.x) for p in half),
                "blade_widths_at_45_78_100_percent_m": section_widths,
            }
        )
    return rec


def sample_strips(obj: bpy.types.Object, maps: dict) -> list:
    positions = points(obj)
    mesh = obj.data
    tree = BVHTree.FromPolygons(
        positions, [tuple(p.vertices) for p in mesh.polygons], all_triangles=True
    )
    uv_layer = mesh.uv_layers.active
    records = []
    for side in (-1, 1):
        center = side * 0.0468
        for y in (-0.084, -0.105, -0.126, -0.145):
            for label, origin, direction in (
                ("upper channel", (center - side * 0.008, y, 0.32), (0, 0, -1)),
                ("inward channel", (0, y, 0.263), (side, 0, 0)),
                ("outer titanium", (side * 0.10, y, 0.263), (-side, 0, 0)),
            ):
                hit, _, idx, _ = tree.ray_cast(Vector(origin), Vector(direction))
                assert hit is not None, (label, y)
                face = mesh.polygons[idx]
                uv = barycentric_transform(
                    hit,
                    *[positions[i] for i in face.vertices],
                    *[uv_layer.data[i].uv.to_3d() for i in face.loop_indices],
                )
                row, col = 1023 - int(1024 * uv.y), int(1024 * uv.x)
                emission = [int(c) for c in maps["emissive"][row, col, :3]]
                metallic = int(maps["orm"][row, col, 2])
                red, green, blue = emission
                if label == "outer titanium":
                    assert max(emission) < 35 and metallic > 180, (
                        label,
                        y,
                        emission,
                        metallic,
                    )
                else:
                    assert (
                        blue > 145
                        and green > 130
                        and green > 1.32 * red
                        and 33 < metallic < 70
                    ), (label, y, emission, metallic)
                records.append(
                    {
                        "side": side,
                        "strip": label,
                        "point_m": list(hit),
                        "pixel": [col, row],
                        "emissive_rgb": emission,
                        "metallic_u8": metallic,
                    }
                )
    return records


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--piece", required=True, type=Path)
    parser.add_argument("--repeat-stage", required=True, type=Path)
    parser.add_argument("--ktx", required=True, type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    piece, repeat = args.piece.resolve(), args.repeat_stage.resolve()
    ktx = checked_ktx(args.ktx)
    sources, second = verify_sources(piece), verify_sources(repeat)
    for name, src in sources.items():
        key = "geometry_uv_hierarchy_material_slots_sha256"
        assert src[key] == second[name][key]
        src["repeat_archive_sha256"] = second[name]["sha256"]
    maps = {
        role: np.frombuffer(
            decode_ktx2(ktx, (piece / f"{role}.ktx2").read_bytes()), np.uint8
        ).reshape(1024, 1024, 4)
        for role in MAPS
    }
    family.build, family.housing, family.optics = build, recessed_housing, exposed_fork
    mip_chains = {}
    for role in MAPS:
        levels = [int(maps[role].nbytes)]
        for level in range(1, 11):
            data = ktx_run(
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
            assert len(data) == 4 * (1024 >> level) ** 2
            levels.append(len(data))
        mip_chains[role] = {"levels_decoded": len(levels), "level_bytes": levels}
    report, charts = {"editable_sources": sources, "decoded_mip_chains": mip_chains}, []
    with TemporaryDirectory() as temp:
        models = Path(temp) / "assets-source/models"
        models.mkdir(parents=True)
        family.HERE = Path(temp) / "blender"
        for name, directory in MOUNTS.items():
            (models / name).symlink_to(
                HERE.parent / "assets-source/models" / directory,
                target_is_directory=True,
            )
        for level in ("lod0", "lod1"):
            path = piece / f"{piece.name}-{level}.glb"
            result, faces = family.geometry(path, 2, ktx, maps)
            for name, directory in MOUNTS.items():
                mount = (
                    HERE.parent
                    / "assets-source/models"
                    / directory
                    / f"{name}-{level}.glb"
                )
                assert result["mounts"][name]["mount_sha256"] == digest(mount)
                result["mounts"][name]["active_file"] = str(
                    mount.relative_to(HERE.parent)
                )
            bpy.context.view_layer.update()
            result["finish_strip_probes"] = sample_strips(
                bpy.data.objects["forward-assembly"], maps
            )
            report[level] = result
            charts.extend(faces)
    family.check_overlap(charts)
    report["combined_positive_area_uv_overlaps"] = 0
    write_json(piece / "reimport.json", report)


if __name__ == "__main__":
    main()
