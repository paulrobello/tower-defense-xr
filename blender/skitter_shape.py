"""Parametric cuticle plates, tapered limbs and ventral anatomy in millimeters."""

from collections.abc import Callable
from dataclasses import dataclass
from itertools import pairwise
from math import cos, pi, sin, tau

from mathutils import Vector

V = Vector
LEVELS = {"high": 2, "lod0": 1, "lod1": 0}
# Hip, elbow, ankle, and contact at neutral. Coordinates are mirrored across X.
CHAINS = (
    ((40, -55, 87), (76, -95, 106), (100, -119, 26), (109, -135, 0)),
    ((48, 0, 89), (88, -5, 114), (119, 0, 27), (130, 5, 0)),
    ((41, 54, 84), (78, 81, 106), (98, 114, 26), (108, 130, 0)),
)
NAMES = ("fore", "mid", "hind")
PALETTE = {
    "plate": ("3f3f46", 0.39, 0.080),
    "ridge": ("5b5963", 0.35, 0.090),
    "cuticle": ("34303a", 0.43, 0.070),
    "joint": ("493b39", 0.49, 0.105),
    "tissue": ("2f272e", 0.57, 0.025),
    "blade": ("494752", 0.32, 0.100),
    "spine": ("9651c3", 0.28, 0.035),
    "eye": ("cb8eff", 0.24, 0.055),
}


def key(prefix: str, i: int, sign: int) -> str:
    return f"{prefix}_{NAMES[i]}.{'L' if sign > 0 else 'R'}"


@dataclass
class Part:
    name: str
    finish: str
    bone: str
    rings: list
    start: Vector
    end: Vector
    slot: int
    uv: tuple = ()


def interpolate(points: tuple, t: float) -> float:
    for (a, x), (b, y) in pairwise(points):
        if t <= b:
            f = (t - a) / (b - a)
            return x * (1 - f) + y * f
    return points[-1][1]


def anatomy(level: str) -> list[Part]:
    detail = LEVELS[level]
    parts = []

    def surface(
        name: str,
        finish: str,
        bone: str,
        sections: tuple,
        sides: tuple,
        sample: Callable,
    ) -> None:
        rows, count = sections[detail], sides[detail]
        rings = [
            [V(sample(j / rows, i / count)) for i in range(count)]
            for j in range(1, rows)
        ]
        parts.append(
            Part(
                name, finish, bone, rings, V(sample(0, 0)), V(sample(1, 0)), len(parts)
            )
        )

    def oval(
        name: str,
        finish: str,
        bone: str,
        center: tuple,
        radii: tuple,
        accent: float = 0.0,
    ) -> None:
        def sample(t: float, u: float) -> tuple | Vector:
            theta, phi = pi * t, tau * u
            r = sin(theta)
            x, y, z = center
            return (
                x + radii[0] * r * cos(phi),
                y - radii[1] * cos(theta),
                z + radii[2] * r * sin(phi) + accent * r * r,
            )

        surface(name, finish, bone, (3, 4, 16), (6, 10, 32), sample)

    def horn(
        name: str,
        finish: str,
        bone: str,
        start: Vector | tuple,
        end: Vector | tuple,
        w: float,
        h: float,
        profile: tuple,
        bend: tuple = (0, 0, 0),
        blade: bool = False,
    ) -> None:
        a, b = V(start), V(end)
        axis = (b - a).normalized()
        across = axis.cross(V((0, 0, 1))).normalized()
        normal = across.cross(axis).normalized()

        def sample(t: float, u: float) -> tuple | Vector:
            p = a.lerp(b, t) + V(bend) * sin(pi * t)
            r = interpolate(profile, t)
            c, s = cos(tau * u), sin(tau * u)
            ridge = 1 + 0.12 * cos(3 * tau * u + 0.6) * sin(pi * t) if blade else 1
            return p + across * (w * r * c) + normal * (h * r * s * ridge)

        surface(name, finish, bone, (4, 6, 20), (5, 7, 20), sample)

    oval("Ventral thorax", "tissue", "thorax", (0, 2, 90), (51, 99, 39), 4)
    oval("Abdominal shield", "cuticle", "thorax", (0, 70, 88), (45, 56, 33))
    oval("Facial mask", "plate", "head", (0, -90, 89), (36, 35, 32), 2)
    oval("Facial crown", "ridge", "head", (0, -94, 101), (31, 28, 25))
    # Separate bilateral plates sweep down around the torso. The rearward rake
    # increases at the skirt and the tip thins into a free overlapping lip.
    for i, (y, w, h, span) in enumerate(
        (
            (-58, 57, 48, 27),
            (-20, 64, 54, 30),
            (18, 63, 52, 30),
            (53, 57, 46, 27),
            (82, 44, 37, 24),
        )
    ):
        for s in (-1, 1):

            def plate(t: float, u: float, i=i, y=y, s=s, w=w, h=h, span=span) -> tuple:
                a = 0.065 + 1.67 * t
                rake = (13 * t * t + 4 * sin(pi * t)) * (1 if i < 3 else 0.7)
                r = sin(pi * t) ** 0.32 if 0 < t < 1 else 0
                c, breath = cos(tau * u), sin(tau * u)
                thick = (5.1 + 2 * sin(pi * t)) * r * breath
                return (
                    s * (sin(a) * (w + thick)),
                    y + rake + span * r * c * (1 - 0.16 * t),
                    93 + cos(a) * (h + thick) + 2.0 * r * (1 - c * c),
                )

            surface(
                f"Scute {i + 1} {s}",
                "plate" if i % 2 == 0 else "ridge",
                "thorax",
                (4, 6, 24),
                (7, 9, 28),
                plate,
            )
    # The spine is a single uninterrupted tissue bed with five raised segments.
    oval("Dorsal furrow", "spine", "thorax", (0, 5, 118), (7, 102, 28), 2)
    for i, (y, z, w) in enumerate(
        (
            (-58, 137, 4.7),
            (-22, 145, 5.7),
            (16, 143, 6.6),
            (52, 137, 5.2),
            (80, 127, 3.8),
        )
    ):
        oval(f"Photophore {i + 1}", "spine", "thorax", (0, y, z), (w, 20, 4.9))
    for s in (-1, 1):
        jaw = f"mandible.{'L' if s > 0 else 'R'}"
        oval(f"Ocular boss {s}", "cuticle", "head", (s * 22, -111, 95), (10, 9, 8))
        oval(
            f"Lateral ocellus {s}",
            "eye",
            "head",
            (s * 23, -117.6, 97.5),
            (4.7, 3.6, 2.7),
        )
        oval(
            f"Median ocellus {s}", "eye", "head", (s * 12, -120.7, 100), (2.7, 2.3, 2.0)
        )
        horn(
            f"Recurved fang {s}",
            "blade",
            jaw,
            (s * 19, -111, 83),
            (s * 11, -143, 68),
            7,
            8,
            ((0, 0), (0.18, 0.88), (0.36, 1), (0.67, 0.67), (1, 0)),
            (s * 7, -3, -3),
            True,
        )
        for i, chain in enumerate(CHAINS):
            hip, knee, ankle, toe = [V((s * x, y, z)) for x, y, z in chain]
            femur, tibia, claw = [key(p, i, s) for p in ("femur", "tibia", "claw")]
            oval(f"Coxa {i} {s}", "joint", femur, hip, (12, 12, 12))
            horn(
                f"Femur {i} {s}",
                "cuticle",
                femur,
                hip,
                knee,
                9.7,
                9.4,
                ((0, 0), (0.16, 1), (0.35, 0.84), (0.61, 0.65), (0.85, 0.84), (1, 0)),
                (s * 1, 0, -3),
            )
            oval(f"Knee {i} {s}", "joint", tibia, knee, (8.4, 8.9, 8))
            # The keeled tapered tibia rises past the knee before the blade descends.
            horn(
                f"Bladed tibia {i} {s}",
                "plate",
                tibia,
                knee + (knee - ankle) * 0.115,
                ankle,
                11.3,
                9.1,
                ((0, 0), (0.20, 0.66), (0.37, 1), (0.62, 0.69), (0.84, 0.36), (1, 0)),
                (s * 4, -2, 2),
                True,
            )
            oval(f"Ankle {i} {s}", "joint", claw, ankle, (4.5, 5.3, 4.7))
            horn(
                f"Terminal sickle {i} {s}",
                "blade",
                claw,
                ankle + (ankle - toe) * 0.18,
                toe,
                5.1,
                5.4,
                ((0, 0), (0.25, 1), (0.45, 0.82), (0.72, 0.40), (1, 0)),
                (s * 2, 0, 1),
                True,
            )
    # Stable non-overlapping rectangular charts, with extra area for the large sheaths.
    shell = [p for p in parts if p.name.startswith("Scute")]
    rest = [p for p in parts if p not in shell]
    for group, cols, base, height in ((shell, 5, 0, 430), (rest, 8, 430, 594)):
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
