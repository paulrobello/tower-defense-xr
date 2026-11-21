"""T1-only pressure shell and recessed orange crucible, in Blender metres."""

import sys
from math import cos, sin, tau
from pathlib import Path

import bpy

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

import helios_mortar as original
import helios_shape as design
from core_bastion_shape import ARMOR, DARK, METAL, Part
from helios_shape import ASCENT, HOT, LIP_ANGLE, PLASMA
from m44_shape import CARBON, Tier, swept

BASE_OBJECT = original.pipeline.object_from_parts


def hull(t: Tier, level: str) -> Part:
    high = design.pressure_hull(t, "high")
    count = {"high": 64, "lod0": 32, "lod1": 16}[level]
    rows = range(len(high.vertices) // 64)
    if level == "lod1":
        rows = [0, 2, 4, 5, 6, 7, 9, 11, 12, 13, 14, 15, 16]
    return swept(
        high.name,
        high.group,
        [
            [high.vertices[j * 64 + i * (64 // count)] for i in range(count)]
            for j in rows
        ],
        lambda j, _: high.finishes[rows[j] * 64],
        True,
    )


def crucible(t: Tier, level: str) -> Part:
    count = {"high": 96, "lod0": 32, "lod1": 16}[level]
    # Outer casing rows use the actuator axis. Inside the rim the well retreats
    # along its own normal, keeping the bright core centered inside the lip.
    profile = [
        (0.66, -t.span, 0, CARBON),
        (0.82, -0.147, 0, METAL),
        (1.04, -0.113, 0, METAL),
        (1.03, -0.107, 0, DARK),
        (0.96, -0.101, 0, ARMOR),
        (0.93, -0.071, 0, DARK),
        (0.94, -0.068, 0, PLASMA),
        (0.98, -0.041, 0, METAL),
        (1.03, -0.039, 0, DARK),
        (1.03, -0.031, 0, PLASMA),
        (1.04, -0.008, 0, METAL),
        (1.04, -0.003, 0, METAL),
        (1.00, 0, 0, PLASMA),
        (0.77, 0, 0, DARK),
        (0.73, 0, -0.002, CARBON),
        (0.60, 0, -0.010, CARBON),
        (0.30, 0, -0.011, METAL),
        (0.24, 0, -0.010, PLASMA),
        (0.20, 0, -0.0095, HOT),
    ]
    if level == "lod1":
        profile = [
            profile[i] for i in (0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 15, 16, 17, 18)
        ]
    rings = []
    for radial, along, depth, _ in profile:
        row = []
        for i in range(count):
            a = tau * i / count
            r = radial * t.radius
            row.append(
                (
                    r * cos(a),
                    -t.muzzle_forward
                    - along * cos(ASCENT)
                    - depth * cos(LIP_ANGLE)
                    + r * sin(a) * sin(LIP_ANGLE),
                    t.muzzle_height
                    + along * sin(ASCENT)
                    + depth * sin(LIP_ANGLE)
                    + r * sin(a) * cos(LIP_ANGLE),
                )
            )
        rings.append(row)
    part = swept(
        "Plasma crucible", "forward-assembly", rings, lambda j, _: profile[j][3], True
    )
    part.finishes[-1] = HOT
    return part


def build(tier: int, level: str) -> list[Part]:
    assert tier == 1
    t = design.TIERS[tier]
    parts = design.build(tier, level)
    parts[0], parts[-1] = hull(t, level), crucible(t, level)
    return parts


def curved_object(name: str, parts: list[Part]) -> bpy.types.Object:
    obj = BASE_OBJECT(name, parts)
    mesh = obj.data
    rows = [
        (part.name, i // part.stations)
        for part in parts
        for i in range(len(part.vertices))
    ]
    edges = {}
    for face in mesh.polygons:
        part = rows[face.vertices[0]][0]
        section = {rows[i][1] for i in face.vertices}
        curved = len(section) > 1 and "gimbal cheek" not in part.lower()
        face.use_smooth = curved
        for key in face.edge_keys:
            edges.setdefault(key, []).append(
                (face.normal.copy(), curved, face.material_index)
            )
    for edge in mesh.edges:
        pair = edges[edge.key]
        if len(pair) == 2:
            a, b = pair
            edge.use_edge_sharp = a[1:] != b[1:] or a[0].dot(b[0]) < 0.75
    mesh.update()
    return obj


if __name__ == "__main__":
    original.build = build
    original.pipeline.object_from_parts = curved_object
    original.main()
