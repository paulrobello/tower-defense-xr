"""Glacier's insulated ceramic casing, cold coil, fork electrodes and captive prism."""

from math import cos, pi, sin, tau

from core_bastion_shape import ARMOR, DARK, METAL, Part
from m44_shape import CARBON, Tier, radial, swept

CYAN = "Glacier arc cyan"
ICE = "Glacier ice facet"
TIERS = {
    1: Tier(0.16, 0.18, 0.16, 0.085, 0.28, 0.14, 0.028, 0.24, 0.14),
    2: Tier(0.18, 0.20, 0.18, 0.090, 0.30, 0.16, 0.026, 0.26, 0.16),
    3: Tier(0.20, 0.22, 0.20, 0.095, 0.32, 0.18, 0.025, 0.28, 0.18),
}
FORWARD = "forward-assembly"


def housing(t: Tier) -> Part:
    # The broad dark side shield is inset inside a bright sloping perimeter.
    outline = [
        (-1, -0.30),
        (-0.62, -0.81),
        (-0.05, -1),
        (0.55, -0.87),
        (0.93, -0.54),
        (1, -0.28),
        (0.86, 0.48),
        (0.47, 0.87),
        (0.15, 1),
        (-0.43, 0.92),
        (-0.91, 0.56),
        (-1, 0.26),
    ]
    profile = [
        (-0.96, 0.55, CARBON),
        (-1, 0.59, METAL),
        (-1, 0.65, DARK),
        (-0.98, 0.69, METAL),
        (-0.94, 0.73, ARMOR),
        (-0.81, 0.91, METAL),
        (-0.75, 0.94, ARMOR),
        (-0.48, 1, ARMOR),
        (-0.10, 0.97, DARK),
        (-0.070, 0.985, METAL),
        (-0.035, 1, DARK),
        (0, 0.985, METAL),
    ]
    section = profile + [
        (-x, s, profile[i - 1][2])
        for i, (x, s, _) in reversed(list(enumerate(profile))[:-1])
    ]
    rows = [
        [
            (
                x * t.width / 2,
                y * r * t.length / 2,
                t.total + (z * r - 1) * t.height / 2,
            )
            for y, z in outline
        ]
        for x, r, _ in section
    ]
    return swept(
        "Nested chamfer shields",
        "turret-head",
        rows,
        lambda j, i: (
            CARBON if i in (0, 1, 2, 3) and section[j][2] == ARMOR else section[j][2]
        ),
        True,
    )


def bearing(t: Tier, level: str) -> Part:
    n = {"high": 64, "lod0": 24, "lod1": 8}[level]
    profile = [
        (0.048, 0.051, DARK),
        (0.052, 0.055, METAL),
        (0.051, t.base - 0.011, DARK),
        (0.059, t.base - 0.007, METAL),
        (0.057, t.base - 0.001, CARBON),
        (0.044, t.base + 0.006, DARK),
        (0.044, t.total - t.height + 0.021, METAL),
    ]
    return radial("Azimuth collar", "yaw-bearing", profile, n, (0, 0, 0))


def coil(t: Tier, level: str) -> Part:
    profile = [
        (0.65, 0, CARBON),
        (0.82, 0.40, DARK),
        (1.12, 0.50, METAL),
        (1.18, 0.56, CYAN),
        (1.18, 0.60, DARK),
        (1.35, 0.64, METAL),
        (1.45, 0.69, ARMOR),
        (1.45, 0.82, DARK),
        (1.41, 0.86, CYAN),
        (1.4, 0.90, METAL),
        (1.27, 0.96, ARMOR),
        (1.12, 1, METAL),
        (0.87, 1, CYAN),
        (0.70, 0.979, CYAN),
        (0.60, 0.952, DARK),
        (0.49, 0.90, DARK),
        (0.38, 0.905, CYAN),
        (0.27, 0.92, DARK),
    ]
    if level == "lod1":
        profile = [profile[i] for i in (0, 2, 3, 4, 6, 7, 8, 9, 11, 12, 14, 16, 17)]
    n = {"high": 96, "lod0": 48, "lod1": 24}[level]

    def finish(j: int, i: int) -> str:
        _, pos, surface = profile[j]
        if 0.97 < pos <= 1 and surface == CYAN and i % (n // 12) == 0:
            return DARK
        return surface

    p = radial(
        "Recessed twelve-sector cold coil",
        FORWARD,
        [(r * t.radius, along * t.span, m) for r, along, m in profile],
        n,
        (0, t.span - t.muzzle_forward, t.muzzle_height),
        axis="y",
        zone=finish,
    )
    p.vertices = [
        (x, y, t.muzzle_height + 0.97 * (z - t.muzzle_height)) for x, y, z in p.vertices
    ]
    return p


def offsets(t: Tier, tier: int) -> list[tuple[float, float]]:
    if tier == 2:
        return [(s * 0.26 * t.width, 0) for s in (-1, 1)]
    return [
        (0.30 * t.width * cos(a), 0.30 * t.width * sin(a))
        for a in (pi / 6, 5 * pi / 6, 3 * pi / 2)
    ]


def prong(t: Tier, tier: int, level: str, x: float, z: float) -> Part:
    profile = [
        (0, 0.66, CARBON),
        (0.38, 0.81, DARK),
        (0.45, 1, METAL),
        (0.50, 1, DARK),
        (0.53, 0.97, CYAN),
        (0.58, 0.95, METAL),
        (0.61, 0.91, ARMOR),
        (0.73, 0.80, ARMOR),
        (0.89, 0.62, DARK),
        (0.915, 0.61, CYAN),
        (0.94, 0.60, METAL),
        (1, 0.43, DARK),
    ]
    if level == "lod1":
        profile = [profile[i] for i in (0, 2, 4, 5, 6, 8, 9, 10, 11)]
    n = {"high": 48, "lod0": 16, "lod1": 8}[level]
    rows = []
    for along, r, _ in profile:
        row = []
        for i in range(n):
            a = tau * i / n
            u, v = cos(a), sin(a)
            if tier == 2:
                # Soft rectangular electrode sections surround an open fork.
                u = (1 if u >= 0 else -1) * abs(u) ** 0.48
                v = (1 if v >= 0 else -1) * abs(v) ** 0.48
            row.append(
                (
                    x + r * t.radius * u,
                    -t.muzzle_forward + (1 - along) * t.span,
                    t.muzzle_height
                    + z
                    - (0.024 if tier == 3 else 0.006) * (1 - along)
                    + r * t.radius * v * (0.72 if tier == 2 else 0.76),
                )
            )
        rows.append(row)

    def finish(j: int, i: int) -> str:
        along, _, m = profile[j]
        toward_center = -cos(tau * (i + 0.5) / n) * x - sin(tau * (i + 0.5) / n) * z
        if (
            along >= 0.61
            and m == ARMOR
            and toward_center > 0.62 * (x * x + z * z) ** 0.5
        ):
            return CYAN
        return m

    p = swept(f"Shaped arc prong {x:+.3f} {z:+.3f}", FORWARD, rows, finish, True)
    p.finishes[-1] = CYAN
    return p


def field_socket(t: Tier, level: str) -> Part:
    profile = [
        (0.69, 0.40, CARBON),
        (0.94, 0.46, METAL),
        (1.04, 0.48, DARK),
        (1.06, 0.51, ARMOR),
        (1.06, 0.55, METAL),
        (1.0, 0.58, DARK),
        (0.79, 0.58, CYAN),
        (0.66, 0.566, CYAN),
        (0.55, 0.545, DARK),
        (0.35, 0.536, CARBON),
    ]
    if level == "lod1":
        profile = [profile[i] for i in (0, 1, 3, 4, 5, 6, 8, 9)]
    return radial(
        "Crystal suspension well",
        FORWARD,
        [(r * t.radius * 1.22, d * t.span, finish) for r, d, finish in profile],
        {"high": 64, "lod0": 32, "lod1": 12}[level],
        (0, t.span - t.muzzle_forward, t.muzzle_height),
        axis="y",
    )


def prism(t: Tier, level: str) -> Part:
    # The crystal stays clear of all three free ends and the nozzle behind it.
    n = 6
    rows = []
    for r, d, spin in [
        (0.045, 0.59, 0),
        (0.68, 0.74, 0.17),
        (1, 0.82, 0),
        (0.82, 0.88, -0.13),
        (0.045, 0.99, 0),
    ]:
        row = [
            (
                0.026 * r * cos(tau * i / n + spin),
                -d * t.muzzle_forward,
                t.muzzle_height + 0.022 * r * sin(tau * i / n + spin),
            )
            for i in range(n)
        ]
        rows.append(row)
    p = swept(
        "Suspended glacier prism",
        FORWARD,
        rows,
        lambda j, i: ICE if (j + 2 * i) % 5 < 3 else CYAN,
        True,
    )
    p.finishes[-2:] = [ICE, ICE]
    return p


def build(tier: int, level: str) -> list[Part]:
    t = TIERS[tier]
    parts = [housing(t), bearing(t, level)]
    if tier == 1:
        parts.append(coil(t, level))
    else:
        parts.extend(prong(t, tier, level, x, z) for x, z in offsets(t, tier))
        if tier == 3:
            parts.extend((field_socket(t, level), prism(t, level)))
    return parts
