"""Model the Broodlord's integrated crown, slanted face and nested abdominal armor."""

import sys
from collections.abc import Callable
from functools import partial
from math import cos, pi, sin, tau
from pathlib import Path

from mathutils import Vector

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

import apex_broodlord
import broodlord_bake
from broodlord_shape import anatomy as original_anatomy
from skitter_shape import Part, interpolate


# A section has an anterior/posterior position, a half-width, a dorsal ridge
# and a depth. Closing both ends gives each lapped knife edge a true underside.
def case(t: float, u: float, stations: tuple, sweep: float, drop: float) -> Vector:
    y, w, z, h = (
        interpolate(tuple((a[0], a[i]) for a in stations), t) for i in range(1, 5)
    )
    c, b = cos(tau * u), sin(tau * u)
    x = w * c
    rim = abs(c)
    return Vector(
        (x, y + sweep * (w / 100) * rim**1.6, z + h * b - drop * (w / 100) * rim**1.25)
    )


BROW = (
    (0, -307, 0, 502, 0),
    (0.10, -289, 42, 526, 11),
    (0.24, -254, 82, 548, 18),
    (0.44, -208, 113, 581, 23),
    (0.64, -155, 128, 616, 22),
    (0.77, -102, 120, 647, 20),
    (0.89, -53, 75, 663, 14),
    (1, -12, 0, 672, 0),
)
SNOUT = (
    (0, -312, 0, 477, 0),
    (0.16, -286, 36, 496, 13),
    (0.37, -253, 63, 509, 22),
    (0.70, -187, 75, 538, 34),
    (0.86, -153, 52, 541, 26),
    (1, -109, 0, 535, 0),
)


def wing(side: int, t: float, u: float) -> Vector:
    # The proximal valves nest beneath the head-owned brow. At the ends the
    # outer rim hooks back, leaving the central split open during its flare.
    table = (
        (0, -268, 31, 0, 538, 0),
        (0.12, -226, 46, 37, 554, 15),
        (0.32, -142, 62, 60, 598, 24),
        (0.51, -50, 81, 76, 642, 27),
        (0.70, 35, 98, 75, 678, 24),
        (0.82, 84, 115, 65, 699, 22),
        (0.93, 141, 132, 39, 718, 17),
        (1, 176, 137, 0, 745, 0),
    )
    y, center, width, z, depth = (
        interpolate(tuple((a[0], a[i]) for a in table), t) for i in range(1, 6)
    )
    c, b = cos(tau * u), sin(tau * u)
    return Vector(
        (
            side * (center + width * c),
            y + width * 0.47 * c,
            z + depth * b - width * (0.30 * c + 0.19 * abs(c) ** 1.45),
        )
    )


def seam(side: int, trunk: bool, t: float, u: float) -> Vector:
    if trunk:
        v = 0.23 + 0.69 * t
        circum = interpolate(
            ((0, 0.33), (0.38, 0.32), (0.63, 0.28), (0.83, 0.23), (1, 0.20)), t
        )
    else:
        v = 0.28 + 0.60 * t
        circum = interpolate(
            ((0, 0.055), (0.40, 0.10), (0.58, 0.13), (0.69, 0.20), (1, 0.29)), t
        )
    p = wing(side, v, circum)
    r = sin(pi * t) ** 0.62 if 0 < t < 1 else 0
    return p + Vector(
        (
            side * r * (4.0 if trunk else 2.9) * cos(tau * u),
            0,
            r * (3.4 if trunk else 2.6) * sin(tau * u) + 0.65 * r,
        )
    )


def shingle(row: int, t: float, u: float) -> Vector:
    y, z, width, span, rise = (
        (34, 435, 130, 147, 24),
        (92, 426, 143, 152, 29),
        (157, 402, 137, 146, 33),
        (217, 360, 119, 131, 41),
    )[row]
    # A pointed posterior shield, deep wrap, raised ridge and recurved corners.
    w = width * interpolate(
        (
            (0, 0),
            (0.12, 0.48),
            (0.29, 0.85),
            (0.47, 1),
            (0.63, 0.98),
            (0.78, 0.82),
            (0.90, 0.54),
            (1, 0),
        ),
        t,
    )
    depth = interpolate(
        ((0, 0), (0.20, 17), (0.45, 20), (0.71, 15), (0.91, 7), (1, 0)), t
    )
    c, b = cos(tau * u), sin(tau * u)
    return Vector(
        (
            w * c,
            y + span * t + 39 * abs(c) ** 2 * (w / width) * (1 - t**4),
            z
            + 15 * sin(pi * t)
            - rise * t
            + depth * b
            - (w / width) * 60 * abs(c) ** 1.55,
        )
    )


def dorsal_suture(t: float, u: float) -> Vector:
    # A single raised sagittal suture opens at the shared brow before the valves fork.
    v = 0.12 + 0.82 * t
    center = case(v, 0.25, BROW, 31, 22)
    r = sin(pi * t) ** 0.59 if 0 < t < 1 else 0
    return center + Vector((8.7 * r * cos(tau * u), 0, (3.4 * sin(tau * u) - 0.45) * r))


def pleuron(side: int, t: float, u: float) -> Vector:
    # In sagittal section the margin rises steeply at the shoulder, then cuts
    # back towards the hip. The dorsoventral section is a thin overlapping scale.
    table = (
        (0, 95, -158, 405, 0, 0),
        (0.18, 101, -137, 422, 12, 22),
        (0.40, 110, -100, 429, 21, 35),
        (0.54, 116, -64, 425, 24, 39),
        (0.70, 118, -28, 413, 21, 31),
        (0.85, 110, 16, 391, 15, 20),
        (1, 92, 77, 381, 0, 0),
    )
    x, y, z, w, h = (
        interpolate(tuple((a[0], a[i]) for a in table), t) for i in range(1, 6)
    )
    c, b = cos(tau * u), sin(tau * u)
    return Vector(
        (
            side * (x + w * c - 8 * b * (h / 39)),
            y + 26 * (h / 39) * abs(b),
            z + h * b - 13 * (w / 24) * c,
        )
    )


def cheek(side: int, eye: bool, t: float, u: float) -> Vector:
    r = sin(pi * t) ** 0.79 if 0 < t < 1 else 0
    c, b = cos(tau * u), sin(tau * u)
    thick, wide = (9.5, 5.5) if eye else (12, 11)
    return Vector(
        (
            side * (26 + 62 * t + 5 * sin(pi * t) + thick * r * c),
            -302 + 74 * t + (-2 if eye else 6) - 4 * r * b,
            506 + 34 * t + 5 * sin(pi * t) + wide * r * b - (2 if eye else 4),
        )
    )


def fang(side: int, t: float, u: float) -> Vector:
    stations = (
        (0, 39, -235, 494, 0),
        (0.18, 51, -252, 496, 13),
        (0.40, 58, -269, 487, 11),
        (0.60, 56, -284, 464, 7.8),
        (0.78, 44, -297, 451, 5),
        (1, 27, -306, 443, 0),
    )
    x, y, z, r = (
        interpolate(tuple((a[0], a[i]) for a in stations), t) for i in range(1, 5)
    )
    return Vector(
        (
            side * (x + r * cos(tau * u)),
            y + r * 0.76 * sin(tau * u),
            z + r * 0.42 * sin(tau * u),
        )
    )


def thoracic_rib(row: int, t: float, u: float) -> Vector:
    # Across the anterior breast, each collar folds into a low center point.
    # Its swept lateral ends insert behind the shoulder and under the next rib.
    across = 2 * t - 1
    r = sin(pi * t) ** 0.52 if 0 < t < 1 else 0
    c, b = cos(tau * u), sin(tau * u)
    return Vector(
        (
            (110 + 3 * row) * across,
            -180 + 98 * abs(across) ** 1.65 + 3 * row + (16 * c + 7 * b) * r,
            329 + 35 * row + 28 * abs(across) ** 1.3 + (25 * b + 4 * c) * r,
        )
    )


def revise(part: Part, sample: Callable) -> None:
    count, sides = len(part.rings) + 1, len(part.rings[0])
    part.start, part.end = sample(0, 0), sample(1, 0)
    part.rings = [
        [sample(j / count, i / sides) for i in range(sides)] for j in range(1, count)
    ]


def anatomy(level: str) -> list[Part]:
    parts = original_anatomy(level)
    for p in parts:
        n = p.name
        side = 1 if n.endswith(" L") else -1
        if n == "Frontal keel":
            p.finish = "shell"
            revise(p, lambda t, u: case(t, u, BROW, 31, 22))
        elif n == "Occipital seam":
            revise(p, dorsal_suture)
        elif n == "Face mask":
            revise(p, lambda t, u: case(t, u, SNOUT, 23, 19))
        elif n.startswith("Swept crest"):
            revise(p, partial(wing, side))
        elif n.startswith(("Crest vein", "Crest tributary")):
            revise(p, partial(seam, side, n.startswith("Crest vein")))
        elif n.startswith("Abdominal shingle"):
            revise(p, partial(shingle, int(n.rsplit(" ", 1)[1])))
        elif n.startswith("Neck lamina"):
            revise(p, partial(thoracic_rib, int(n.rsplit(" ", 1)[1])))
        elif n.startswith(("Eye ", "Orbital tissue")):
            revise(p, partial(cheek, side, n.startswith("Eye ")))
        elif n.startswith("Mandible"):
            revise(p, partial(fang, side))
        elif n.startswith("Temple blade"):
            for v in [p.start, p.end, *(v for row in p.rings for v in row)]:
                v.z -= 13
                v.x *= 1.12
        elif n in ("Hanging abdomen", "Ventral thorax", "Cervical mantle", "Head core"):
            for v in [p.start, p.end, *(v for row in p.rings for v in row)]:
                if n == "Hanging abdomen":
                    v.x *= 0.89
                    v.z = 325 + (v.z - 320) * 0.76
                elif n == "Ventral thorax":
                    v.x *= 0.93
                    v.z = 378 + (v.z - 377) * 0.83
                elif n == "Cervical mantle":
                    v.x *= 0.80
                    v.z = 471 + (v.z - 475) * 0.88
                else:
                    v.x *= 0.83
        elif n.startswith("Pleural shield"):
            revise(p, partial(pleuron, side))
    return parts


if __name__ == "__main__":
    apex_broodlord.anatomy = broodlord_bake.anatomy = anatomy
    apex_broodlord.main()
