"""M44 decorative game meshes. Coordinates are Blender metres, neutral front along −Y."""

from collections.abc import Callable
from dataclasses import dataclass
from math import cos, sin, tau

from core_bastion_shape import ARMOR, DARK, METAL, Part

AMBER = "M44 amber"
CARBON = "carbon-inset"


@dataclass(frozen=True)
class Tier:
    width: float
    height: float
    length: float
    base: float
    total: float
    span: float
    radius: float
    muzzle_height: float
    muzzle_forward: float


TIERS = {
    1: Tier(0.16, 0.12, 0.22, 0.08, 0.24, 0.18, 0.022, 0.18, 0.26),
    2: Tier(0.19, 0.13, 0.24, 0.085, 0.26, 0.21, 0.020, 0.19, 0.29),
    3: Tier(0.21, 0.145, 0.26, 0.09, 0.28, 0.24, 0.036, 0.20, 0.32),
}


def swept(
    name: str, group: str, rings: list, finishes: Callable[[int, int], str], caps: bool
) -> Part:
    part = Part(name, group)
    rows = [part.ring(points) for points in rings]
    part.stations = len(rows[0])
    part.closed = not caps
    for j in range(len(rows) - int(caps)):
        for i in range(part.stations):
            k = (i + 1) % part.stations
            nxt = rows[(j + 1) % len(rows)]
            part.face((rows[j][i], rows[j][k], nxt[k], nxt[i]), finishes(j, i))
    if caps:
        part.face(rows[0][::-1], CARBON)
        part.face(rows[-1], CARBON)
    return part


def radial(
    name: str,
    group: str,
    profile: list,
    n: int,
    center: tuple,
    axis: str = "z",
    caps: bool = True,
    zone: Callable[[int, int], str] | None = None,
) -> Part:
    rings = []
    for r, along, _ in profile:
        ring = []
        for i in range(n):
            a = tau * i / n
            u, v = r * cos(a), r * sin(a)
            p = (u, v, along) if axis == "z" else (u, -along, v)
            ring.append(tuple(c + s for c, s in zip(center, p)))
        rings.append(ring)
    return swept(
        name, group, rings, lambda j, i: zone(j, i) if zone else profile[j][2], caps
    )


def body(t: Tier, tier: int, level: str) -> Part:
    # The long top facet, outward-sloping flanks and chamfered tail trace the reference's shell.
    outline = [
        (-1, -0.40),
        (-0.77, -0.79),
        (-0.43, -1),
        (0.54, -1),
        (0.85, -0.70),
        (1, -0.37),
        (1, 0.37),
        (0.64, 0.87),
        (0.30, 1),
        (-0.53, 1),
        (-0.84, 0.80),
        (-1, 0.38),
    ]
    profile = [
        (-1, 0.69, CARBON),
        (-1, 0.77, METAL),
        (-0.972, 0.82, DARK),
        (-0.95, 0.87, METAL),
        (-0.90, 0.95, METAL),
        (-0.82, 1, ARMOR),
        (-0.64, 1, ARMOR),
        (-0.61, 1, METAL),
        (-0.585, 0.985, DARK),
        (-0.56, 0.992, ARMOR),
        (-0.28, 1, ARMOR),
        (0, 1, ARMOR),
    ]
    if level == "lod1":
        profile = [profile[i] for i in (0, 1, 3, 5, 7, 9, 11)]
    section = profile + [
        (-x, s, profile[i - 1][2])
        for i, (x, s, f) in reversed(list(enumerate(profile))[0:-1])
    ]
    rings = [
        [
            (
                x * (t.width / 2 - 0.0041),
                y * s * t.length / 2,
                t.total - t.height / 2 + z * s * t.height / 2,
            )
            for y, z in outline
        ]
        for x, s, _ in section
    ]

    def finish(j: int, i: int) -> str:
        name = section[j][2]
        if (
            tier == 3
            and i in (7, 8, 9)
            and abs((section[j][0] + section[j + 1][0]) / 2) < 0.55
        ):
            return AMBER if i == 8 and abs(section[j][0]) > 0.08 else DARK
        return name

    return swept("Faceted graphite carriage", "turret-head", rings, finish, True)


def build(tier: int, level: str) -> list[Part]:
    t = TIERS[tier]
    fine = level != "lod1"
    n = {"high": 64, "lod0": 24, "lod1": 12}[level]
    parts = [body(t, tier, level)]
    joint = [
        (0.051, 0.051, DARK),
        (0.055, 0.055, METAL),
        (0.055, t.base - 0.009, DARK),
        (0.059, t.base - 0.006, METAL),
        (0.060, t.base - 0.002, DARK),
        (0.056, t.base + 0.003, CARBON),
        (0.046, t.base + 0.008, DARK),
        (0.044, t.total - t.height + 0.014, METAL),
        (0.040, t.total - t.height + 0.018, DARK),
    ]
    parts.append(
        radial(
            "Stepped azimuth bearing", "yaw-bearing", joint, n if fine else 8, (0, 0, 0)
        )
    )
    # Opposing raised cheek insets cast their own edge shadows against the inset shell.
    for side in (-1, 1):
        x = side * (t.width / 2 - 0.0041)
        runs = [
            (0.018, 0, DARK),
            (0.022, 0.0015, METAL),
            (0.023, 0.003, METAL),
            (0.020, 0.0045, DARK),
            (0.016, 0.0045, CARBON),
            (0.015, 0.002, DARK),
        ]
        cheek = radial(
            "Cheek medallion " + str(side),
            "turret-head",
            runs,
            n if fine else 8,
            (0, 0, 0),
        )
        for i, (u, v, w) in enumerate(cheek.vertices):
            cheek.vertices[i] = (
                x + side * (w - 0.0004),
                side * u + t.length * 0.13,
                v + t.total - t.height * 0.50,
            )
        parts.append(cheek)
    radius = t.radius
    count = (1, 2, 6)[tier - 1]
    ring = radius * 0.68
    for i in range(count):
        x = (
            (i - 0.5) * t.width * 0.48
            if tier == 2
            else ring * cos(tau * i / 6)
            if tier == 3
            else 0
        )
        h = t.muzzle_height + (ring * sin(tau * i / 6) if tier == 3 else 0)
        r = radius * 0.34 if tier == 3 else radius
        # Blind, shallow decorative apertures keep the interior of the visual shell closed.
        profile = [
            (0.82, 0, DARK),
            (1.16, 0.08, METAL),
            (1.16, 0.19, DARK),
            (1.04, 0.22, DARK),
            (0.88, 0.27, ARMOR),
            (0.88, 0.70, ARMOR),
            (0.92, 0.73, DARK),
            (0.90, 0.76, METAL),
            (0.93, 0.79, AMBER),
            (0.93, 0.945, AMBER),
            (0.99, 0.95, METAL),
            (0.99, 0.985, DARK),
            (0.92, 1, METAL),
            (0.66, 1, CARBON),
            (0.64, 0.965, DARK),
            (0.61, 0.925, CARBON),
        ]
        if tier == 3:
            profile = [
                (0.90, 0, DARK),
                (0.98, 0.10, DARK),
                (0.96, 0.78, DARK),
                (1, 0.90, ARMOR),
                (0.99, 0.985, METAL),
                (0.92, 1, METAL),
                (0.69, 1, AMBER),
                (0.65, 0.965, CARBON),
                (0.62, 0.925, CARBON),
            ]
            if not fine:
                profile = [profile[k] for k in (0, 2, 4, 5, 6, 8)]
        elif not fine:
            profile = [profile[k] for k in (0, 1, 3, 4, 5, 8, 9, 12, 13, 15)]
        segments = (
            {"high": 64, "lod0": 20, "lod1": 8}[level]
            if tier != 3
            else {"high": 48, "lod0": 12, "lod1": 6}[level]
        )
        parts.append(
            radial(
                f"Recessed optic {i + 1}",
                "rotor-face" if tier == 3 else "forward-assembly",
                [(r * a, t.span * b, c) for a, b, c in profile],
                segments,
                (x, -(t.muzzle_forward - t.span), h),
                "front",
            )
        )
    if tier == 3:
        profile = [
            (0.043, 0.11, DARK),
            (0.049, 0.123, METAL),
            (0.050, 0.133, ARMOR),
            (0.049, 0.154, DARK),
            (0.049, 0.158, AMBER),
            (0.049, 0.183, AMBER),
            (0.050, 0.185, METAL),
            (0.048, 0.202, DARK),
            (0.044, 0.213, METAL),
            (0.039, 0.213, CARBON),
            (0.039, 0.11, CARBON),
        ]
        n3 = {"high": 96, "lod0": 36, "lod1": 12}[level]

        def vents(j: int, i: int) -> str:
            if j in (4, 5) and i % (n3 // 6) == 0:
                return DARK
            return profile[j][2]

        parts.append(
            radial(
                "Six interrupted thermal windows",
                "forward-assembly",
                profile,
                n3,
                (0, 0, t.muzzle_height),
                "front",
                False,
                vents,
            )
        )
    return parts
