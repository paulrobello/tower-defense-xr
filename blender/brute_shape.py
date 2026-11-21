"""Armored siege insect with a sloped prow, a protected dorsal intake and six load-bearing legs."""

from collections.abc import Callable
from math import copysign, cos, pi, sin, tau

from mathutils import Vector
from skitter_shape import Part, interpolate, key

V = Vector
__all__ = ["CHAINS", "PALETTE", "anatomy", "key"]
CHAINS = (
    ((106, -112, 165), (165, -150, 172), (190, -173, 29), (193, -176, 0)),
    ((130, 8, 174), (182, 10, 173), (204, 9, 30), (207, 8, 0)),
    ((106, 128, 164), (158, 158, 174), (177, 186, 29), (181, 189, 0)),
)
PALETTE = {
    "plate": ("354253", 0.38, 0.11),
    "slate": ("1e293b", 0.44, 0.09),
    "edge": ("454e5a", 0.36, 0.12),
    "cuticle": ("262831", 0.50, 0.06),
    "joint": ("78502e", 0.44, 0.11),
    "tissue": ("221f23", 0.56, 0.035),
    "spine": ("f97316", 0.36, 0.035),
    "eye": ("ff9a29", 0.30, 0.045),
}


def power(x: float, a: float) -> float:
    return copysign(abs(x) ** a, x)


def anatomy(level: str) -> list[Part]:
    detail = ("lod1", "lod0", "high").index(level)
    parts = []

    def surface(
        name: str, finish: str, bone: str, rows: tuple, sides: tuple, fn: Callable
    ):
        m, n = rows[detail], sides[detail]
        rings = [[V(fn(j / m, i / n)) for i in range(n)] for j in range(1, m)]
        parts.append(
            Part(name, finish, bone, rings, V(fn(0, 0)), V(fn(1, 0)), len(parts))
        )

    def plate(
        name: str,
        finish: str,
        bone: str,
        center: tuple,
        radii: tuple,
        slope: float = 0,
        camber: float = 0,
        roll: float = 0,
        shear: float = 0,
        taper: float = 0,
        square: float = 0.70,
        big: bool = False,
    ):
        x, y, z = center
        w, l, h = radii

        def fn(t, u):
            angle = pi * t
            r = sin(angle) ** square if 0 < t < 1 else 0
            a = -power(cos(angle), square)
            c = r * power(cos(tau * u), square)
            b = r * power(sin(tau * u), square)
            return (
                x + w * c * (1 + taper * a),
                y + l * a + shear * c,
                z
                + slope * a
                + camber * (1 - a * a) * (1 - 0.78 * c * c)
                + roll * c
                + h * b,
            )

        surface(
            name,
            finish,
            bone,
            (5, 8, 20) if big else (3, 5, 14),
            (8, 12, 32) if big else (6, 8, 20),
            fn,
        )

    def limb(name, finish, bone, a, b, w, h, bend=(0, 0, 0), tip=0.50):
        a, b = V(a), V(b)
        axis = (b - a).normalized()
        lateral = axis.cross(V((0, 1, 0))).normalized()
        forward = axis.cross(lateral).normalized()

        def fn(t, u):
            r = interpolate(
                (
                    (0, 0),
                    (0.12, 0.78),
                    (0.30, 1),
                    (0.57, 0.95),
                    (0.84, tip),
                    (0.95, tip * 0.72),
                    (1, 0),
                ),
                t,
            )
            return (
                a.lerp(b, t)
                + V(bend) * sin(pi * t)
                + lateral * (w * r * power(cos(tau * u), 0.65))
                + forward * (h * r * power(sin(tau * u), 0.68))
            )

        surface(name, finish, bone, (4, 6, 16), (6, 8, 20), fn)

    plate(
        "Ventral thorax",
        "tissue",
        "thorax",
        (0, 7, 215),
        (148, 215, 94),
        camber=10,
        big=True,
    )
    plate("Sternal keel", "cuticle", "thorax", (0, 14, 140), (73, 155, 31), big=True)
    plate(
        "Posterior mantle",
        "cuticle",
        "thorax",
        (0, 105, 274),
        (137, 147, 68),
        slope=-38,
        camber=34,
        big=True,
    )
    # The prow spans the face. Its lower edge exposes the eye slits and staggered gill lamellae.
    plate(
        "Shield gasket",
        "cuticle",
        "shield",
        (0, -119, 301),
        (154, 142, 19),
        slope=79,
        camber=47,
        taper=0.32,
        big=True,
    )
    plate(
        "Prow shield",
        "edge",
        "shield",
        (0, -123, 310),
        (156, 140, 17),
        slope=79,
        camber=48,
        taper=0.33,
        big=True,
    )
    plate(
        "Prow face",
        "plate",
        "shield",
        (0, -126, 321),
        (148, 132, 15),
        slope=74,
        camber=46,
        taper=0.33,
        big=True,
    )
    plate(
        "Dorsal saddle",
        "edge",
        "thorax",
        (0, 56, 346),
        (150, 119, 40),
        slope=-12,
        camber=49,
        big=True,
    )
    plate(
        "Crown plate",
        "slate",
        "thorax",
        (0, 49, 385),
        (91, 95, 35),
        slope=-5,
        camber=13,
        big=True,
    )
    plate(
        "Aft shingle",
        "slate",
        "thorax",
        (0, 175, 282),
        (128, 86, 37),
        slope=-45,
        camber=28,
        big=True,
    )
    plate(
        "Intake housing",
        "cuticle",
        "thorax",
        (0, 37, 432),
        (46, 42, 18),
        slope=-10,
        camber=5,
        square=0.43,
    )
    plate(
        "Dorsal vent",
        "spine",
        "thorax",
        (0, 12, 439),
        (35, 16, 12),
        slope=10,
        square=0.43,
    )
    for x in (-25, -15, -5, 5, 15, 25):
        plate(
            f"Intake vane {x}",
            "tissue",
            "thorax",
            (x, 10, 441),
            (2.2, 17, 12),
            slope=10,
            square=0.5,
        )
    plate(
        "Intake cowl",
        "slate",
        "thorax",
        (0, 37, 449),
        (45, 34, 9),
        slope=-5,
        camber=4,
        square=0.42,
    )
    plate(
        "Head mask",
        "cuticle",
        "head",
        (0, -189, 206),
        (88, 64, 47),
        slope=-6,
        camber=12,
        big=True,
    )
    for s in (-1, 1):
        side = "L" if s > 0 else "R"
        jaw = f"mandible.{side}"
        plate(
            f"Cheek {s}",
            "slate",
            "head",
            (s * 64, -195, 215),
            (27, 48, 21),
            slope=9,
            roll=-s * 6,
            shear=s * 12,
        )
        plate(
            f"Orbital slot {s}",
            "tissue",
            "head",
            (s * 72, -212, 225),
            (26, 35, 18),
            roll=-s * 7,
            shear=s * 17,
        )
        plate(
            f"Eye slit {s}",
            "eye",
            "head",
            (s * 77, -223, 232),
            (23, 25, 9),
            roll=-s * 9,
            shear=s * 17,
        )
        limb(
            f"Jaw root {s}",
            "joint",
            jaw,
            (s * 52, -209, 184),
            (s * 66, -251, 166),
            16,
            15,
            (s * 6, 0, -3),
            0.72,
        )
        limb(
            f"Hook {s}",
            "cuticle",
            jaw,
            (s * 66, -242, 169),
            (s * 26, -260, 171),
            13,
            12,
            (s * 3, -6, -1),
            0.35,
        )
        for j, (y, w, z, l, drop) in enumerate(
            ((11, 65, 344, 61, 34), (95, 61, 325, 53, 35), (167, 47, 281, 53, 28))
        ):
            plate(
                f"Flank shingle {j} {s}",
                "slate" if j != 1 else "plate",
                "thorax",
                (s * (111 if j < 2 else 98), y, z),
                (w, l, 25),
                slope=-j * 6,
                camber=18,
                roll=-s * drop,
                shear=s * 11,
                taper=-0.10,
                big=True,
            )
        for j in range(3):
            plate(
                f"Gill lamella {j} {s}",
                "cuticle" if j != 1 else "tissue",
                "thorax",
                (s * (111 + j * 5), -95, 248 + j * 23),
                (37, 100 - j * 8, 10),
                slope=28,
                roll=-s * 12,
                shear=s * 13,
                square=0.53,
            )
        for i, chain in enumerate(CHAINS):
            hip, knee, ankle, toe = [V((s * x, y, z)) for x, y, z in chain]
            fem, tib, pad = [key(n, i, s) for n in ("femur", "tibia", "claw")]
            plate(f"Hip collar {i} {s}", "cuticle", fem, hip, (32, 33, 31))
            limb(
                f"Femur {i} {s}", "joint", fem, hip, knee, 20, 22, (s * 3, 0, -13), 0.9
            )
            plate(f"Patella {i} {s}", "joint", tib, knee, (25, 23, 23))
            limb(
                f"Shin core {i} {s}",
                "joint",
                tib,
                knee,
                ankle,
                19,
                20,
                (s * 4, 0, -2),
                0.65,
            )
            limb(
                f"Shin armor {i} {s}",
                "slate",
                tib,
                knee + V((s * 4, 0, 15)),
                ankle + V((s * 4, -4, -2)),
                23,
                27,
                (s * 10, -5, 2),
                0.70,
            )
            limb(
                f"Shin brow {i} {s}",
                "plate",
                tib,
                knee + V((s * 10, -13, 8)),
                ankle + V((s * 9, -15, 19)),
                14,
                14,
                (s * 8, -6, 4),
                0.52,
            )
            plate(f"Ankle {i} {s}", "joint", pad, ankle, (16, 18, 18))
            # A flattened hoof sole occupies a finite area. The support pole stays on its contact plane.
            x, y, _ = toe

            def hoof(t, u, x=x, y=y):
                r = interpolate(
                    ((0, 0), (0.20, 0.91), (0.38, 1), (0.72, 0.88), (1, 0)), t
                )
                return (
                    x + 19 * r * power(cos(tau * u), 0.66),
                    y - 4 + 25 * r * power(sin(tau * u), 0.66),
                    0 if t <= 0.20 else 34 * (t - 0.2) / 0.8,
                )

            surface(
                f"Contact pad {i} {s}", "cuticle", pad, (5, 10, 20), (8, 12, 24), hoof
            )
    # The head hangs beneath the prow gasket. Keep the bearing centers with the assembled mask.
    for part in parts:
        if part.bone == "head" or part.bone.startswith("mandible."):
            for point in (
                part.start,
                part.end,
                *(v for row in part.rings for v in row),
            ):
                point.z -= 32
    groups = [
        [p for p in parts if p.name.startswith(n)]
        for n in (
            ("Prow", "Shield gasket"),
            (
                "Dorsal saddle",
                "Crown plate",
                "Flank shingle",
                "Aft shingle",
                "Ventral thorax",
                "Posterior mantle",
            ),
        )
    ]
    groups.append([p for p in parts if p not in groups[0] + groups[1]])
    for group, cols, bottom, top in zip(
        groups, (3, 6, 9), (0, 248, 535), (248, 535, 1024), strict=True
    ):
        rows = (len(group) + cols - 1) // cols
        for i, p in enumerate(group):
            c, r = i % cols, i // cols
            p.uv = (
                (1024 * c / cols + 3) / 1024,
                (bottom + (top - bottom) * r / rows + 3) / 1024,
                (1024 * (c + 1) / cols - 3) / 1024,
                (bottom + (top - bottom) * (r + 1) / rows - 3) / 1024,
            )
    return parts
