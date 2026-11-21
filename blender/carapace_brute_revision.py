"""F10 shield, dorsal inlet and articulated greaves for the Carapace Brute."""

import sys
from math import cos, pi, sin, tau
from pathlib import Path
from unittest.mock import patch

from mathutils import Vector

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import brute_bake
import carapace_brute
from brute_shape import CHAINS, PALETTE
from brute_shape import anatomy as original_anatomy
from skitter_shape import LEVELS, Part


def symmetric(half: list[tuple]) -> list[Vector]:
    return [Vector(p) for p in [*half, *((-x, y) for x, y in half[-2:0:-1])]]


PROW = symmetric(
    [
        (0, -265),
        (38, -260),
        (76, -237),
        (126, -150),
        (158, -68),
        (161, -33),
        (145, -9),
        (82, 8),
        (0, 15),
    ]
)
INSET = symmetric(
    [
        (0, -231),
        (30, -235),
        (62, -227),
        (83, -178),
        (130, -97),
        (142, -64),
        (123, -42),
        (116, -28),
        (75, -30),
        (47, -18),
        (0, -19),
    ]
)


def outline(points: list[Vector], steps: int, trim: float) -> list[Vector]:
    result = []
    for i, p in enumerate(points):
        a = p.lerp(points[i - 1], trim)
        b = p.lerp(points[(i + 1) % len(points)], trim)
        for k in range(steps + 1):
            t = k / steps if steps else 0.5
            result.append(a.lerp(p, t).lerp(p.lerp(b, t), t))
    return result


def prow(part: Part, detail: int) -> None:
    face = part.name in ("Prow face", "Prow reveal")
    pts = outline(INSET if face else PROW, (0, 1, 4)[detail], 0.24)
    center = Vector((0, -113))
    profile = {
        "Shield gasket": ((0.77, -17), (0.96, -14), (0.992, -9), (0.97, -4), (0.72, 0)),
        "Prow shield": (
            (0.79, -11),
            (0.985, -9),
            (1, -5),
            (0.992, -1),
            (0.95, 1),
            (0.65, 2),
        ),
        "Prow reveal": (
            (0.87, -3),
            (1.012, 0.6),
            (1.019, 3.5),
            (0.96, 4.1),
            (0.77, 4.7),
        ),
        "Prow face": (
            (0.86, 1.5),
            (0.966, 3.1),
            (0.979, 5.2),
            (0.955, 8),
            (0.84, 9.5),
            (0.51, 11),
            (0.052, 12),
        ),
    }[part.name]

    def point(q: Vector, r: float, rise: float) -> Vector:
        x, y = center.lerp(q, r)
        a = (y + 122) / 143
        z = 326 + 0.555 * (y + 122) + 39 * (1 - a * a) - 0.00124 * x * x
        return Vector((x, y, z + rise))

    part.rings = [[point(q, r, z) for q in pts] for r, z in profile]
    part.start = point(center, 0, profile[0][1] - 2)
    part.end = point(
        center, 0, profile[-1][1] + (0.02 if part.name == "Prow face" else 1)
    )


def prism(
    part: Part, rows: list[tuple], detail: int, bottom: float, top: float
) -> None:
    # A forward keel and a chamfered outer shoulder give each ring distinct facets.
    section = symmetric(
        [(0, -1.06), (0.67, -0.91), (1, -0.47), (0.94, 0.58), (0.59, 0.91), (0, 1)]
    )
    shape = outline(section, (1, 1, 3)[detail], 0.34) if detail == 2 else section
    if detail == 0:
        rows = [rows[0], rows[1], rows[2], rows[-1]]
    part.rings = [
        [Vector((x + p.x * w, y + p.y * length, z + rake * p.y)) for p in shape]
        for x, y, z, w, length, rake in rows
    ]
    part.start = Vector((*rows[0][:2], bottom))
    part.end = Vector((*rows[-1][:2], top))


def greave(part: Part, i: int, s: int, detail: int) -> None:
    _, knee, ankle, toe = CHAINS[i]
    if part.name.startswith("Contact pad"):
        x, y = s * toe[0], toe[1]
        prism(
            part,
            [
                (x, y - 5, 0, 20, 24, 0),
                (x, y - 8, 4, 22.5, 29, 0),
                (x, y - 7, 13, 23.5, 31, -1),
                (x - s * 2, y, 28, 19, 25, 3),
                (s * ankle[0], ankle[1] + 2, 37, 14, 20, 1),
            ],
            detail,
            0,
            40,
        )
        return
    a, b = Vector(ankle), Vector(knee)
    main = part.name.startswith("Shin armor")
    stations = (
        [
            (0.03, 16, 24, -3),
            (0.14, 20, 28, -4),
            (0.56, 25, 34, -5),
            (0.8, 28, 37, -4),
            (0.965, 24, 32, 3),
            (1.045, 13, 19, 4),
        ]
        if main
        else [
            (0.19, 9, 9, -2),
            (0.29, 13, 11, -3),
            (0.7, 19, 15, -5),
            (0.86, 18, 14, -3),
            (0.965, 10, 9, 4),
        ]
    )
    rows = []
    for t, w, length, rake in stations:
        x, y, z = a.lerp(b, t)
        x += (8 if main else 13) + 4 * sin(pi * t)
        y -= 2 if main else (19 + 9 * sin(pi * t))
        rows.append((s * x, y, z, w, length, rake))
    prism(part, rows, detail, rows[0][2] - 5, rows[-1][2] + 5)


def anatomy(level: str) -> list[Part]:
    parts = original_anatomy(level)
    detail = LEVELS[level]
    face = next(p for p in parts if p.name == "Prow face")
    a, b, c, d = face.uv
    face.uv = (a, b, a + 0.72 * (c - a), d)
    reveal = Part("Prow reveal", "tissue", "shield", [], Vector(), Vector(), len(parts))
    reveal.uv = (face.uv[2] + 0.006, b, c, d)
    parts.append(reveal)
    for p in parts:
        if p.name.startswith(("Prow", "Shield gasket")):
            prow(p, detail)
        elif p.name.startswith(("Shin armor", "Shin brow", "Contact pad")):
            row, side = map(int, p.name.split()[-2:])
            greave(p, row, side, detail)
        elif p.name.startswith("Gill lamella 2 "):
            side = int(p.name.split()[-1])
            for q in [p.start, p.end, *(v for ring in p.rings for v in ring)]:
                q.x -= side * 13
                q.z -= 4
        elif p.name == "Intake cowl":
            # An arched roof is open across its full forward section.
            profile = [
                (-15, 55, 5, 454),
                (-11, 58, 6, 455),
                (5, 61, 8, 454),
                (41, 57, 13, 443),
                (64, 46, 11, 431),
                (72, 37, 7, 426),
            ]
            p.rings = []
            for y, w, h, z in profile:
                ring = []
                for j in range((12, 16, 48)[detail]):
                    theta = tau * j / (12, 16, 48)[detail]
                    x = cos(theta)
                    ring.append(
                        Vector((w * x, y, z - 11 * abs(x) ** 3 + h * sin(theta)))
                    )
                p.rings.append(ring)
            p.start, p.end = Vector((0, -17, 454)), Vector((0, 76, 425))
        elif p.name.startswith(("Dorsal vent", "Intake vane", "Intake housing")):
            for q in [p.start, p.end, *(v for ring in p.rings for v in ring)]:
                if p.name == "Intake housing":
                    q.x *= 1.38
                    q.z -= 4
                    q.y += 4
                else:
                    q.x *= 1.55
                    q.y = -7 + (q.y - 12) * 1.18
                    q.z = 437 + (q.z - 439) * 1.04
        elif level != "high" and p.name.startswith(
            ("Hip collar", "Ankle", "Patella", "Intake vane", "Shin core")
        ):
            # Buried bearings need fewer rings than the exterior armor.
            p.rings = p.rings[::2]
    return parts


def finishes() -> dict:
    mats = original_finishes()
    for mat in mats.values():
        ramp = mat.node_tree.nodes["Cuticle pigment"].color_ramp
        low, high = ramp.elements[0], ramp.elements[1]
        left, right = list(low.color), list(high.color)
        low.color = [a * 0.64 + b * 0.36 for a, b in zip(left, right, strict=True)]
        high.color = [a * 0.25 + b * 0.75 for a, b in zip(left, right, strict=True)]
    return mats


original_finishes = brute_bake.source_finishes


def main() -> None:
    palette = {
        "edge": ("505965", 0.36, 0.12),
        "plate": ("354051", 0.38, 0.10),
        "tissue": ("181a21", 0.51, 0.045),
        "joint": ("61432b", 0.45, 0.095),
    }
    with (
        patch.dict(PALETTE, palette),
        patch.object(brute_bake, "source_finishes", finishes),
        patch.object(brute_bake, "anatomy", anatomy),
        patch.object(carapace_brute, "anatomy", anatomy),
    ):
        carapace_brute.main()


if __name__ == "__main__":
    main()
