"""Rebuild the staged Wasp with clipped flight panels and overlapping nose armor."""

import sys
from collections.abc import Callable
from math import cos, pi, sin, tau
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wasp_bake
import wasp_skimmer
from skitter_shape import LEVELS, Part, interpolate
from wasp_rig import actions as original_actions
from wasp_shape import WINGS
from wasp_shape import anatomy as original_anatomy


def rebuild(part: Part, sample: Callable[[float, float], Vector]) -> None:
    count, sides = len(part.rings) + 1, len(part.rings[0])
    part.rings = [
        [sample(j / count, i / sides) for i in range(sides)] for j in range(1, count)
    ]
    part.start, part.end = sample(0, 0), sample(1, 0)


def flight_panel(part: Part) -> None:
    sign, upper = WINGS[part.bone]
    limits = (
        (0, 0),
        (0.055, 27),
        (0.13, 40),
        (0.30, 46),
        (0.50, 44),
        (0.69, 37),
        (0.86, 25),
        (0.96, 16),
        (1, 0),
    )

    def skin(t: float, c: float, height: float) -> Vector:
        span = 155 if upper else 148
        # The clipped distal section puts the closed tip at a shallow spanwise angle.
        x = 49 + span * (1.0 - (1.0 - t) ** 1.22)
        sweep = -31 + (25 if upper else -25) + 160 * t - 15 * t * t
        chord = interpolate(limits, t)
        tilt = 24 + 12 * t if upper else -23 - 52 * t + 10 * sin(pi * t) ** 0.6
        y = sweep + c * chord * (0.94 if c < 0 else 1.08)
        return Vector((sign * x, y, tilt - 0.07 * (y - sweep) + height))

    if part.name.startswith(("Perimeter", "Inner airfoil")):
        rim = part.name.startswith("Perimeter")

        def surface(t: float, u: float) -> Vector:
            q = t if rim else 0.025 + 0.952 * t
            cap = min(1.0, t * 17, (1 - t) * 17)
            return skin(
                q,
                (1 if rim else 0.85) * cos(tau * u) * cap,
                (4.3 if rim else 6.2) * sin(tau * u) * cap,
            )

        rebuild(part, surface)
    elif part.name.startswith("Bioluminescent"):
        face = int(part.name.split()[-1])

        def vein(t: float, u: float) -> Vector:
            q = 0.075 + 0.820 * t
            course = interpolate(
                (
                    (0, -0.20),
                    (0.10, -0.58),
                    (0.35, -0.64),
                    (0.43, -0.43),
                    (0.85, -0.53),
                    (1, -0.44),
                ),
                t,
            )
            cap = min(1.0, t * 12, (1 - t) * 12)
            return skin(
                q,
                course + 0.055 * cos(tau * u) * cap,
                face * (5.7 + 1.5 * sin(tau * u) * cap),
            )

        rebuild(part, vein)
    else:
        # Paired lacquered gussets wrap the hinge and taper into the flight panel.
        for ring in part.rings:
            center = sum(ring, Vector()) / len(ring)
            for p in ring:
                p.y = center.y + (p.y - center.y) * 2.65
                p.z = center.z + (p.z - center.z) * 1.20
        if not part.name.startswith("Spar crest"):
            part.finish = "chitin"


def nose_plate(level: str, name: str, finish: str, sign: int) -> Part:
    sections = (4, 7, 20)[LEVELS[level]]
    sides = (6, 8, 18)[LEVELS[level]]

    def sample(t: float, u: float) -> Vector:
        radius = interpolate(
            ((0, 0), (0.12, 0.50), (0.45, 0.91), (0.76, 1), (0.89, 0.93), (1, 0)), t
        )
        if sign:
            return Vector(
                (
                    sign * (8 + 14 * t + 6 * sin(pi * t)) + 10 * radius * cos(tau * u),
                    -159 + 115 * t,
                    -6 + 34 * t + 9 * sin(pi * t) + 8 * radius * sin(tau * u),
                )
            )
        return Vector(
            (
                22 * radius * cos(tau * u),
                -166 + 101 * t,
                -5 + 40 * t + 9 * sin(pi * t) + 9 * radius * sin(tau * u),
            )
        )

    part = Part(
        name, finish, "thorax", [[None] * sides] * (sections - 1), Vector(), Vector(), 0
    )
    rebuild(part, sample)
    return part


def anatomy(level: str) -> list[Part]:
    parts = [p for p in original_anatomy(level) if p.name != "Crown gem"]
    for part in parts:
        if part.bone in WINGS:
            flight_panel(part)
        elif part.name.startswith("Compound eye"):
            sign = 1 if part.name.endswith(" L") else -1
            for p in (part.start, part.end, *(v for ring in part.rings for v in ring)):
                p.x += sign * 1.8
    parts += [
        nose_plate(level, "Facial brow L", "membrane", 1),
        nose_plate(level, "Facial brow R", "membrane", -1),
        nose_plate(level, "Clypeus shield", "chitin", 0),
    ]
    main = [p for p in parts if p.name.startswith(("Perimeter", "Inner airfoil"))]
    other = [p for p in parts if p not in main]
    for group, cols, base, height in ((main, 4, 0, 470), (other, 8, 470, 554)):
        rows = (len(group) + cols - 1) // cols
        for i, part in enumerate(group):
            col, row = i % cols, i // cols
            part.uv = (
                (1024 * col / cols + 3) / 1024,
                (base + height * row / rows + 3) / 1024,
                (1024 * (col + 1) / cols - 3) / 1024,
                (base + height * (row + 1) / rows - 3) / 1024,
            )
    return parts


def flight_actions(arm: bpy.types.Object) -> None:
    original_actions(arm)
    # The runtime air bob can add another 25 mm above the baked local pose.
    local = arm.data.bones["thorax"].matrix_local.to_quaternion().inverted()
    for clip, height in (("bank_turn", -0.014), ("hover_fly", 0.004)):
        delta = local @ Vector((0, 0, height))
        act = bpy.data.actions[clip]
        start, end = act.frame_range
        for bag in act.layers[0].strips[0].channelbags:
            for curve in bag.fcurves:
                if curve.data_path == 'pose.bones["thorax"].location':
                    for key in curve.keyframe_points:
                        phase = (key.co.x - start) / (end - start)
                        factor = (
                            sin(pi * phase) ** 2
                            if clip == "bank_turn"
                            else sin(tau * phase)
                        )
                        key.co.y += delta[curve.array_index] * factor
                    curve.update()


def finishes() -> dict:
    mats = original_finishes()
    for mat in mats.values():
        ramp = mat.node_tree.nodes["Cuticle pigment"].color_ramp
        first, last = ramp.elements
        for i in range(3):
            mid = (first.color[i] + last.color[i]) / 2
            first.color[i] = 0.86 * mid
            last.color[i] = 1.14 * mid
    return mats


original_finishes = wasp_bake.source_finishes

if __name__ == "__main__":
    wasp_bake.anatomy = wasp_skimmer.anatomy = anatomy
    wasp_bake.source_finishes = finishes
    wasp_skimmer.actions = flight_actions
    wasp_skimmer.main()
