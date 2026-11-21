"""Parametric matriarch with a swept split casque, articulated pincers and four blade stilts."""

from collections.abc import Callable
from math import copysign, cos, pi, sin, tau

from mathutils import Vector
from skitter_shape import Part, interpolate

V = Vector
PALETTE = {
    "shell": ("25252d", 0.39, 0.08),
    "obsidian": ("18181b", 0.43, 0.06),
    "ridge": ("34323d", 0.36, 0.09),
    "tissue": ("201b26", 0.53, 0.03),
    "keratin": ("38333d", 0.32, 0.08),
    "spine": ("ec4899", 0.37, 0.04),
    "eye": ("ff53b1", 0.29, 0.02),
}
# Coxa, hock, high knee, distal spur and fixed ground point, in millimetres before fit.
LEGS = (
    (
        (95, -91, 340),
        (133, -137, 197),
        (229, -244, 340),
        (292, -283, 77),
        (295, -293, 0),
    ),
    ((101, 125, 326), (144, 159, 202), (229, 259, 337), (307, 294, 79), (309, 307, 0)),
)
ARM = ((85, -121, 435), (155, -188, 405), (174, -288, 387), (187, -325, 364))


def side_name(s: int) -> str:
    return "L" if s == 1 else "R"


def leg(n: str, i: int, s: int) -> str:
    return f"{n}_{('fore', 'hind')[i]}.{side_name(s)}"


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
            (8, 14, 22) if big else (4, 7, 12),
            (12, 20, 36) if big else (8, 12, 24),
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

        surface(name, finish, bone, (5, 9, 16), (8, 12, 24), fn)

    plate(
        "Ventral thorax",
        "tissue",
        "thorax",
        (0, -28, 377),
        (123, 154, 103),
        slope=34,
        camber=9,
        big=True,
    )
    plate(
        "Hanging abdomen",
        "tissue",
        "abdomen",
        (0, 171, 320),
        (109, 158, 85),
        slope=-45,
        camber=17,
        big=True,
    )
    # These sloped posterior shingles have free knife edges over a shared organic core.
    for i, (y, z, w, l) in enumerate(
        (
            (80, 390, 119, 80),
            (153, 371, 122, 91),
            (221, 338, 108, 90),
            (261, 301, 81, 74),
        )
    ):
        plate(
            f"Abdominal shingle {i}",
            "shell" if i % 2 == 0 else "obsidian",
            "abdomen",
            (0, y, z),
            (w, l, 43),
            slope=-31,
            camber=28,
            taper=-0.24,
            big=True,
        )
    plate(
        "Cervical mantle",
        "obsidian",
        "thorax",
        (0, -31, 475),
        (108, 99, 85),
        slope=-18,
        camber=20,
        big=True,
    )
    for i in range(3):
        plate(
            f"Neck lamina {i}",
            "shell",
            "thorax",
            (0, 8 - i * 25, 501 + i * 13),
            (100 - i * 4, 66, 29),
            slope=20,
            camber=12,
            big=False,
        )
    plate(
        "Head core", "tissue", "head", (0, -138, 519), (94, 121, 66), slope=15, big=True
    )
    plate(
        "Face mask",
        "shell",
        "head",
        (0, -194, 531),
        (68, 96, 46),
        slope=25,
        camber=8,
        taper=0.28,
        big=True,
    )
    plate(
        "Occipital seam",
        "spine",
        "head",
        (0, -67, 564),
        (63, 124, 28),
        slope=65,
        camber=13,
        big=True,
    )
    plate(
        "Frontal keel",
        "obsidian",
        "head",
        (0, -156, 570),
        (49, 118, 32),
        slope=55,
        camber=17,
        taper=0.12,
        big=True,
    )
    for s in (-1, 1):
        side = side_name(s)
        crown = f"crest.{side}"

        # A blade swells into an overlapping swept wing and narrows to a lifted rear tip.
        def casque(t, u, s=s):
            w = interpolate(
                (
                    (0, 0),
                    (0.09, 17),
                    (0.27, 49),
                    (0.47, 67),
                    (0.68, 75),
                    (0.78, 72),
                    (0.92, 42),
                    (1, 0),
                ),
                t,
            )
            h = interpolate(
                (
                    (0, 0),
                    (0.12, 15),
                    (0.35, 24),
                    (0.60, 29),
                    (0.83, 20),
                    (0.94, 10),
                    (1, 0),
                ),
                t,
            )
            c = power(cos(tau * u), 0.78)
            b = power(sin(tau * u), 0.76)
            return (
                s * (20 + 89 * t + 6 * sin(pi * t) + w * c),
                -253 + 436 * t + 14 * c * w / 60,
                546 + 186 * t + 29 * sin(pi * t) + h * b - 11 * c * (w / 60),
            )

        surface(
            f"Swept crest {side}", "shell", crown, (12, 20, 36), (12, 20, 40), casque
        )

        def wing_seam(t, u, s=s, casque=casque):
            pos = V(casque(0.085 + 0.82 * t, 0.17))
            radius = sin(pi * t) ** 0.45 if 0 < t < 1 else 0
            return pos + V(
                (
                    s * 3.2 * radius * cos(tau * u),
                    0,
                    3.3 * radius * sin(tau * u) + 0.65 * radius,
                )
            )

        surface(
            f"Crest vein {side}", "spine", crown, (10, 20, 32), (6, 8, 14), wing_seam
        )

        def branch_seam(t, u, s=s, casque=casque):
            fraction = interpolate(
                ((0, 0.27), (0.32, 0.24), (0.57, 0.20), (0.64, 0.15), (1, 0.09)), t
            )
            pos = V(casque(0.24 + 0.54 * t, fraction))
            r = sin(pi * t) ** 0.53 if 0 < t < 1 else 0.0
            return pos + V(
                (s * 2 * r * cos(tau * u), 0, 3 * r * sin(tau * u) + 0.5 * r)
            )

        surface(
            f"Crest tributary {side}",
            "spine",
            crown,
            (11, 18, 27),
            (6, 8, 16),
            branch_seam,
        )
        plate(
            f"Rear pelvic socket {side}",
            "obsidian",
            "thorax",
            (s * 76, 91, 339),
            (50, 67, 47),
            slope=-12,
            camber=8,
        )
        # The rear sweep and knife edge sit above a shorter secondary temporal plate.
        plate(
            f"Temple blade {side}",
            "obsidian",
            crown,
            (s * 80, -30, 590),
            (67, 148, 24),
            slope=69,
            camber=26,
            roll=-s * 18,
            shear=s * 31,
            taper=0.10,
            big=True,
        )
        plate(
            f"Orbital tissue {side}",
            "tissue",
            "head",
            (s * 42, -228, 515),
            (29, 59, 29),
            slope=14,
            roll=-s * 7,
            shear=s * 15,
        )
        plate(
            f"Eye {side}",
            "eye",
            "head",
            (s * 53, -243, 522),
            (22, 42, 11),
            slope=10,
            roll=-s * 8,
            shear=s * 17,
        )
        for i in range(3):
            plate(
                f"Maxillary fold {side} {i}",
                "keratin",
                "head",
                (s * (33 + i * 5), -226 - i * 8, 498 - i * 4),
                (13, 37 - i * 4, 11),
                slope=6,
                shear=s * 4,
            )
        limb(
            f"Mandible {side}",
            "keratin",
            "head",
            (s * 31, -235, 498),
            (s * 23, -284, 468),
            10,
            9,
            (s * 6, 0, -3),
            0.20,
        )
        plate(
            f"Pleural shield {side}",
            "shell",
            "thorax",
            (s * 89, -40, 418),
            (47, 105, 40),
            slope=24,
            camber=18,
            roll=-s * 24,
            shear=s * 14,
            big=True,
        )
        limb(
            f"Pleural seam {side}",
            "spine",
            "thorax",
            (s * 100, -144, 408),
            (s * 119, -93, 404),
            4,
            5,
            (s * 4, 0, 3),
            0.6,
        )
        a, b, c, d = [V((s * x, y, z)) for x, y, z in ARM]
        upper, fore, palm = [f"{n}.{side}" for n in ("brachium", "forearm", "palm")]
        plate(f"Shoulder {side}", "keratin", upper, a, (31, 31, 29))
        limb(f"Brachium {side}", "obsidian", upper, a, b, 23, 17, (s * 4, 1, -6), 0.76)
        plate(f"Foreclaw elbow {side}", "keratin", fore, b, (19, 21, 19))
        limb(
            f"Forearm vambrace {side}", "shell", fore, b, c, 19, 16, (s * 4, 2, 4), 0.54
        )
        plate(f"Foreclaw wrist {side}", "keratin", palm, c, (14, 14, 12))
        limb(
            f"Foreclaw palm {side}", "obsidian", palm, c, d, 15, 13, (s * 2, 0, 2), 0.77
        )
        for j in range(3):
            spread = (j - 1) * 12
            knuckle = d + V((s * (spread * 0.62 - 3), 12 + abs(spread) * 0.16, 4))
            tip = d + V(
                (s * (spread * 1.65 + 4), -33 + (j - 1) * 5, -39 + abs(spread) * 0.45)
            )
            limb(
                f"Hook finger {side} {j}",
                "keratin",
                palm,
                knuckle,
                tip,
                5.5,
                5.8,
                (s * 3, -7, 9),
                0.14,
            )
        for i, chain in enumerate(LEGS):
            a, b, c, d, e = [V((s * x, y, z)) for x, y, z in chain]
            coxa, fem, tib, claw = [
                leg(n, i, s) for n in ("coxa", "femur", "tibia", "blade")
            ]
            plate(f"Hip {i} {side}", "tissue", coxa, a, (39, 37, 40))
            limb(
                f"Descending thigh {i} {side}",
                "shell",
                coxa,
                a,
                b,
                34,
                33,
                (s * 4, 2, 3),
                0.56,
            )
            plate(f"Hock {i} {side}", "keratin", fem, b, (23, 23, 21))
            limb(
                f"Ascending shank {i} {side}",
                "obsidian",
                fem,
                b,
                c,
                23,
                23,
                (s * 4, 2, -5),
                0.77,
            )
            plate(f"Blade knee {i} {side}", "keratin", tib, c, (26, 26, 24))
            limb(
                f"Outer blade {i} {side}",
                "shell",
                tib,
                c + V((s * 3, 0, 20)),
                d,
                33,
                27,
                (s * 12, (i * 2 - 1) * 12, 4),
                0.36,
            )
            limb(
                f"Knee spur {i} {side}",
                "obsidian",
                tib,
                c + V((s * 4, 0, -11)),
                c + V((s * 11, 8, 52)),
                14,
                14,
                (s * 2, 0, 1),
                0.2,
            )
            plate(f"Distal hinge {i} {side}", "keratin", claw, d, (14, 14, 13))
            limb(
                f"Ground knife {i} {side}",
                "obsidian",
                claw,
                d + V((0, 0, 5)),
                e,
                14,
                14,
                (s * 3, -2, 0),
                0.14,
            )
            limb(
                f"Ankle spur {i} {side}",
                "shell",
                claw,
                d + V((0, 0, -11)),
                d + V((s * 11, 6, 26)),
                8,
                9,
                (s * 1, 0, 0),
                0.18,
            )
    primary = [
        p
        for p in parts
        if p.name.startswith(
            (
                "Swept crest",
                "Temple blade",
                "Abdominal shingle",
                "Face mask",
                "Frontal keel",
            )
        )
    ]
    medium = [
        p
        for p in parts
        if p not in primary
        and p.name.startswith(
            (
                "Ventral",
                "Head core",
                "Cervical",
                "Hanging",
                "Outer blade",
                "Descending",
                "Pleural shield",
                "Ascending",
            )
        )
    ]
    minor = [p for p in parts if p not in primary + medium]
    for group, cols, bottom, top in (
        (primary, 4, 0, 800),
        (medium, 5, 800, 1220),
        (minor, 9, 1220, 2048),
    ):
        rows = (len(group) + cols - 1) // cols
        for i, p in enumerate(group):
            c, r = i % cols, i // cols
            p.uv = (
                (2048 * c / cols + 5) / 2048,
                (bottom + (top - bottom) * r / rows + 5) / 2048,
                (2048 * (c + 1) / cols - 5) / 2048,
                (bottom + (top - bottom) * (r + 1) / rows - 5) / 2048,
            )
    return parts
