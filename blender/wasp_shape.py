"""Wasp cuticle, lenticular flight vanes and paired articulated dorsal spars (mm)."""

from collections.abc import Callable
from math import cos, pi, sin, tau

from mathutils import Vector
from skitter_shape import LEVELS, Part, interpolate

PALETTE = {
    "chitin": ("312e81", 0.40, 0.07),
    "keel": ("241f51", 0.41, 0.08),
    "leading": ("847f91", 0.34, 0.64),
    "membrane": ("353346", 0.43, 0.21),
    "hinge": ("282635", 0.39, 0.52),
    "spine": ("2dd4bf", 0.28, 0.07),
    "eye": ("52e6df", 0.24, 0.04),
}
WINGS = {
    f"{pair}.{side}": (sign, pair == "dorsal")
    for side, sign in (("L", 1), ("R", -1))
    for pair in ("dorsal", "ventral")
}


def socket(s: int, upper: bool) -> Vector:
    return Vector((s * 25, 7 if upper else -14, 13 if upper else -12))


def anatomy(level: str) -> list[Part]:
    detail = LEVELS[level]
    parts = []

    def shell(
        name: str, finish: str, joint: str, fn: Callable, rows: tuple, sides: tuple
    ) -> None:
        nr, ns = rows[detail], sides[detail]
        rings = [[Vector(fn(j / nr, i / ns)) for i in range(ns)] for j in range(1, nr)]
        parts.append(
            Part(
                name,
                finish,
                joint,
                rings,
                Vector(fn(0, 0)),
                Vector(fn(1, 0)),
                len(parts),
            )
        )

    def lance(
        name: str,
        finish: str,
        joint: str,
        start: tuple,
        end: tuple,
        w: float,
        h: float,
        profile: tuple,
        curve=(0, 0, 0),
        roll=0.0,
        large=False,
    ) -> None:
        a, b = Vector(start), Vector(end)
        d = (b - a).normalized()
        across = d.cross(Vector((0, 0, 1))).normalized()
        top = across.cross(d).normalized()

        def sample(t: float, u: float) -> Vector:
            radius = interpolate(profile, t)
            angle = tau * u + roll
            return (
                a.lerp(b, t)
                + Vector(curve) * sin(pi * t)
                + radius * (across * (w * cos(angle)) + top * (h * sin(angle)))
            )

        shell(
            name,
            finish,
            joint,
            sample,
            (5, 9, 28) if large else (3, 5, 15),
            (7, 11, 30) if large else (5, 7, 16),
        )

    body = (
        (0, 0),
        (0.08, 0.49),
        (0.23, 0.84),
        (0.43, 1),
        (0.60, 0.94),
        (0.82, 0.61),
        (0.95, 0.26),
        (1, 0),
    )
    needle = ((0, 0), (0.10, 0.87), (0.24, 1), (0.63, 0.55), (0.85, 0.24), (1, 0))
    oval = (
        (0, 0),
        (0.10, 0.60),
        (0.24, 0.93),
        (0.45, 1),
        (0.73, 0.82),
        (0.93, 0.38),
        (1, 0),
    )
    lance(
        "Underslung keel",
        "keel",
        "thorax",
        (0, -168, -9),
        (0, 153, 14),
        33,
        32,
        body,
        (0, -3, -4),
        large=True,
    )
    lance(
        "Prismatic dorsal mantle",
        "chitin",
        "thorax",
        (0, -162, -10),
        (0, 111, 35),
        39,
        29,
        body,
        (0, -6, 12),
        large=True,
    )
    lance(
        "Abdominal vanishing point",
        "chitin",
        "abdomen",
        (0, 30, 19),
        (0, 188, 24),
        32,
        20,
        needle,
        (0, 6, 10),
        large=True,
    )
    lance(
        "Abdominal armor lap",
        "membrane",
        "abdomen",
        (0, 37, 38),
        (0, 129, 38),
        20,
        10,
        oval,
        (0, 0, 6),
        large=True,
    )
    lance(
        "Crown saddle",
        "membrane",
        "thorax",
        (0, -83, 28),
        (0, 55, 51),
        19,
        8,
        oval,
        (0, -5, 9),
        large=True,
    )
    lance(
        "Crown gem",
        "spine",
        "thorax",
        (0, -75, 35),
        (0, -36, 48),
        9,
        3,
        oval,
        (0, 0, 4),
    )
    for s in (-1, 1):
        side = "L" if s > 0 else "R"
        lance(
            f"Facial cheek {side}",
            "keel",
            "thorax",
            (s * 10, -160, -10),
            (s * 28, -55, 13),
            12,
            15,
            oval,
            (s * 6, -5, 2),
            large=True,
        )
        lance(
            f"Compound eye {side}",
            "eye",
            "thorax",
            (s * 16, -149, -7),
            (s * 33, -96, 6),
            5.0,
            5.2,
            oval,
            (s * 7, -1, 4),
        )
        lance(
            f"Stylet {side}",
            "leading",
            f"stylet.{side}",
            (s * 9, -126, -8),
            (s * 16, -192, -30),
            3.7,
            4.5,
            needle,
            (s * 2, -2, -3),
        )
        lance(
            f"Flank pauldron {side}",
            "leading",
            "thorax",
            (s * 15, -80, 13),
            (s * 16, 66, 19),
            16,
            13,
            body,
            (s * 18, 0, 2),
            large=True,
        )
        lance(
            f"Flank cutout {side}",
            "spine",
            "thorax",
            (s * 30, -56, 13),
            (s * 40, -1, 23),
            5.7,
            7.8,
            oval,
            (s * 6, 0, 3),
        )
        lance(
            f"Ventral running light {side}",
            "spine",
            "thorax",
            (s * 12, -108, -20),
            (s * 24, 34, -18),
            2.8,
            2.5,
            oval,
            (s * 3, 0, -11),
        )
        lance(
            f"Tail lumen {side}",
            "spine",
            "abdomen",
            (s * 22, 63, 16),
            (s * 10, 143, 21),
            4,
            4,
            oval,
            (s * 3, 0, -2),
        )

    for joint, (s, upper) in WINGS.items():
        mount = socket(s, upper)
        offset = 19 if upper else -17

        def wingpoint(
            t: float, c: float, thickness: float = 0, s=s, upper=upper, offset=offset
        ) -> Vector:
            # Asymmetric chords dogleg near the root, then narrow to the swept tip.
            x = 68 + 136 * t - (0 if upper else 8 * t)
            center = -30 + offset + 103 * t + 42 * t * t
            chord = interpolate(
                (
                    (0, 0),
                    (0.055, 25),
                    (0.13, 33),
                    (0.28, 38),
                    (0.40, 32),
                    (0.60, 25),
                    (0.84, 14),
                    (0.955, 7),
                    (1, 0),
                ),
                t,
            )
            leading = (
                chord * (0.92 + 0.15 * sin(pi * t))
                if c < 0
                else chord * (1.11 - 0.18 * t)
            )
            z = (
                (24 + 12 * t if upper else -23 - 52 * t)
                - 0.07 * (leading * c)
                + 3.3 * sin(pi * t)
            )
            return Vector((s * x, center + leading * c, z + thickness))

        for i, (origin_y, t, edge) in enumerate(((-18, 0.13, -0.65), (15, 0.25, 0.27))):
            start = (mount.x, mount.y + origin_y, mount.z)
            tip = wingpoint(t, edge)
            lance(
                f"Spar {joint} {i}",
                "hinge",
                joint,
                start,
                tip,
                5.0,
                5.4,
                oval,
                (s * 2, 2, -1),
            )
            lance(
                f"Spar crest {joint} {i}",
                "leading",
                joint,
                (start[0] + s * 3, start[1], start[2] + 2.5),
                tip,
                2.2,
                2.7,
                oval,
                (s * 2, 2, 1),
            )
        for name, finish, t0, t1, cscale, thick in [
            ("Perimeter", "leading", 0, 1, 1, 4.5),
            ("Inner airfoil", "membrane", 0.023, 0.973, 0.82, 6.0),
        ]:

            def vane(
                t: float,
                u: float,
                t0=t0,
                t1=t1,
                cscale=cscale,
                thick=thick,
                wingpoint=wingpoint,
            ) -> Vector:
                axial = t0 + (t1 - t0) * t
                edge = min(1, t * 14, (1 - t) * 14)
                return wingpoint(
                    axial, cscale * cos(tau * u) * edge, thick * sin(tau * u) * edge
                )

            shell(f"{name} {joint}", finish, joint, vane, (8, 15, 36), (6, 9, 20))
        for face in (-1, 1):

            def vein(t: float, u: float, face=face, wingpoint=wingpoint) -> Vector:
                q = 0.078 + 0.75 * t
                a = interpolate(
                    (
                        (0, -0.19),
                        (0.12, -0.61),
                        (0.39, -0.62),
                        (0.48, -0.43),
                        (0.82, -0.53),
                        (1, -0.57),
                    ),
                    t,
                )
                width = min(1, t * 13, (1 - t) * 13)
                return wingpoint(
                    q,
                    a + 0.055 * width * cos(tau * u),
                    face * (5.55 + 1.35 * width * sin(tau * u)),
                )

            shell(
                f"Bioluminescent channel {joint} {face}",
                "spine",
                joint,
                vein,
                (6, 10, 26),
                (5, 6, 12),
            )
    main = [p for p in parts if p.name.startswith(("Perimeter", "Inner airfoil"))]
    other = [p for p in parts if p not in main]
    for group, cols, base, height in ((main, 4, 0, 470), (other, 8, 470, 554)):
        rows = (len(group) + cols - 1) // cols
        for i, p in enumerate(group):
            col, row = i % cols, i // cols
            p.uv = (
                (1024 * col / cols + 3) / 1024,
                (base + height * row / rows + 3) / 1024,
                (1024 * (col + 1) / cols - 3) / 1024,
                (base + height * (row + 1) / rows - 3) / 1024,
            )
    return parts
