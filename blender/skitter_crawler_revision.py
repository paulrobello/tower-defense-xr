"""Shape revision for the Skitter's dorsal valves, recessed organ and leg guards."""

import sys
from collections.abc import Callable
from math import cos, pi, sin, tau
from pathlib import Path

from mathutils import Vector

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

import skitter_bake
import skitter_crawler
from skitter_shape import CHAINS, LEVELS, PALETTE, Part
from skitter_shape import anatomy as original_anatomy

# center Y, shell width, crown height, longitudinal half-span, sweep, wrap angle.
VALVES = (
    (-58, 61, 52, 28, 15, 1.49),
    (-22, 68, 58, 29, 27, 1.58),
    (14, 65, 55, 27, 32, 1.70),
    (48, 58, 48, 25, 35, 1.82),
    (78, 44, 38, 23, 36, 1.95),
)


def resurface(p: Part, rows: int, sides: int, sample: Callable) -> None:
    p.start, p.end = Vector(sample(0, 0)), Vector(sample(1, 0))
    p.rings = [
        [Vector(sample(j / rows, i / sides)) for i in range(sides)]
        for j in range(1, rows)
    ]


def valve(i: int, side: int, t: float, u: float) -> tuple:
    y, width, height, span, sweep, wrap = VALVES[i]
    r = sin(pi * t) ** 0.29 if 0 < t < 1 else 0
    c, s = cos(tau * u), sin(tau * u)
    # The leading margin rises into the next shingle. The free trailing lip
    # projects past a concave flank and over the next valve's lower shoulder.
    arc = 0.08 + t * wrap
    lean = t**1.7 * sweep - 6 * sin(pi * t)
    length = span * (1.08 - 0.24 * t)
    along = c * length * r
    lip = r * (3.5 * c + 2.4 * s + 2.6 * max(0, s) * (1 - abs(c)))
    x = 2 + sin(arc) * (width + lip)
    z = 88 + cos(arc) * (height + lip) + 2.6 * r * c
    return side * x, y + lean + along, z


def spindle(
    t: float, u: float, y: float, span: float, width: float, z: float, depth: float
) -> tuple:
    r = sin(pi * t)
    return (
        width * r**0.75 * cos(tau * u),
        y + (2 * t - 1) * span,
        z + depth * r * sin(tau * u),
    )


def anatomy(level: str) -> list[Part]:
    parts = original_anatomy(level)
    d = LEVELS[level]
    for p in parts:
        if p.name.startswith("Scute"):
            _, row, side = p.name.split()
            p.finish = "plate" if int(row) != 1 else "ridge"
            resurface(
                p,
                (5, 7, 24)[d],
                (7, 9, 28)[d],
                lambda t, u, row=row, side=side: valve(int(row) - 1, int(side), t, u),
            )
        elif p.name in ("Facial crown", "Facial mask", "Abdominal shield"):

            def shield(t: float, u: float, name=p.name) -> tuple:
                r = sin(pi * t) ** 0.76
                c, s = cos(tau * u), sin(tau * u)
                if name == "Abdominal shield":
                    return (
                        42 * r * (1.25 - 0.58 * t) * c,
                        15 + 112 * t,
                        85 + (23 * r * s) - 5 * t,
                    )
                if name == "Facial mask":
                    return (32 * r * c, -128 + 60 * t, 80 + 10 * t + 18 * r * s)
                # An anteriorly pointed, swept, peaked visor over the jaw muscles.
                return (
                    38 * r * c * (0.82 + 0.33 * t),
                    -131 + 65 * t + 8 * abs(c) * r,
                    91 + 17 * t + 23 * r * s - 8 * r * abs(c) ** 1.7,
                )

            resurface(p, (6, 7, 22)[d], (8, 10, 32)[d], shield)
        elif p.name == "Dorsal furrow":

            def organ(t: float, u: float) -> tuple:
                y = -87 + 197 * t
                r = sin(pi * t) ** 0.65
                z = 109 + 34 * sin(pi * (0.10 + 0.93 * t))
                # Widen and neck the tissue between the five pairs of valves.
                w = r * (7.9 + 1.9 * cos(9 * pi * t - 0.6))
                return w * cos(tau * u), y, z + 4 * r * sin(tau * u)

            resurface(p, (12, 14, 52)[d], (6, 8, 20)[d], organ)
        elif p.name.startswith("Photophore"):
            i = int(p.name.split()[-1]) - 1
            y = (-59, -24, 11, 45, 77)[i]
            t0 = (y + 87) / 197
            z = 109 + 34 * sin(pi * (0.10 + 0.93 * t0)) + 1.3

            def nodule(t: float, u: float, y=y, i=i, z=z, t0=t0) -> tuple:
                x, by, bz = spindle(
                    t, u, y, (13, 16, 16, 14, 12)[i], (4, 5.6, 6, 5, 3.8)[i], z, 3.9
                )
                slope = 34 * pi * 0.93 / 197 * cos(pi * (0.10 + 0.93 * t0))
                return (
                    x,
                    by,
                    bz + slope * (by - y) + 0.7 * cos(4 * pi * t) * sin(pi * t),
                )

            resurface(p, (4, 5, 20)[d], (5, 7, 20)[d], nodule)
        elif p.name.startswith("Knee"):
            _, row, sign = p.name.split()
            side = int(sign)
            _, k, a, _ = CHAINS[int(row)]
            knee = Vector((side * k[0], k[1], k[2]))
            axis = Vector((side * (a[0] - k[0]), a[1] - k[1], a[2] - k[2])).normalized()
            wide = axis.cross(Vector((0, 0, 1))).normalized()
            outer = wide.cross(axis).normalized()

            def guard(
                t: float, u: float, knee=knee, axis=axis, wide=wide, outer=outer
            ) -> Vector:
                r = sin(pi * t) ** 0.78 * (0.63 + 0.65 * t)
                return (
                    knee
                    + axis * (-15 + 35 * t)
                    + wide * (9.6 * r * cos(tau * u))
                    + outer * (2.3 + 8.4 * r * sin(tau * u) + 4 * (1 - t) ** 3)
                )

            p.finish = "blade"
            resurface(p, (4, 5, 20)[d], (5, 7, 20)[d], guard)
        elif p.name.startswith(
            ("Coxa", "Ankle", "Ocular boss", "Median ocellus", "Lateral ocellus")
        ):
            if level != "high":
                # Allocate the distant mesh's triangles to the shell silhouette.
                chosen = p.rings[len(p.rings) // 2]
                p.rings = [chosen[::2]]
        elif p.name == "Ventral thorax":
            for vertex in [p.start, p.end, *(v for ring in p.rings for v in ring)]:
                vertex.z = 88 + (vertex.z - 88) * 0.9
    return parts


def main() -> None:
    PALETTE.update(
        plate=("383842", 0.38, 0.085),
        ridge=("45434e", 0.37, 0.085),
        joint=("332c32", 0.47, 0.065),
        spine=("a05ad5", 0.35, 0.035),
    )
    skitter_crawler.anatomy = skitter_bake.anatomy = anatomy
    skitter_crawler.main()


if __name__ == "__main__":
    main()
