"""Valkyrie's fluted armor, compact illuminated spine, swept fins and split T3 runners."""

from core_bastion_shape import ARMOR, DARK, METAL, Part
from glacier_shape import bearing
from m44_shape import CARBON, Tier, swept

COBALT = "Valkyrie cobalt"
WHITE = "Valkyrie white core"
FORWARD = "forward-assembly"
TIERS = {
    1: Tier(0.15, 0.12, 0.28, 0.085, 0.25, 0.28, 0.020, 0.19, 0.34),
    2: Tier(0.17, 0.13, 0.31, 0.090, 0.27, 0.32, 0.022, 0.20, 0.38),
    3: Tier(0.19, 0.14, 0.34, 0.095, 0.29, 0.36, 0.024, 0.21, 0.42),
}


def housing(t: Tier) -> Part:
    outline = [
        (-1, -0.32),
        (-0.56, -0.81),
        (0.035, -1),
        (0.10, -0.995),
        (0.67, -0.74),
        (1, -0.32),
        (1, 0.29),
        (0.61, 0.82),
        (0.10, 1),
        (0.035, 1),
        (-0.52, 0.78),
        (-1, 0.29),
    ]
    half = [
        (-0.945, 0.54, CARBON),
        (-0.991, 0.575, METAL),
        (-1, 0.609, DARK),
        (-0.983, 0.650, METAL),
        (-0.916, 0.702, ARMOR),
        (-0.71, 0.884, METAL),
        (-0.64, 0.918, ARMOR),
        (0, 1, ARMOR),
    ]
    sections = half + [
        (-x, s, half[j - 1][2]) for j, (x, s, _) in reversed(list(enumerate(half[:-1])))
    ]
    rows = [
        [
            (
                x * t.width / 2,
                y * scale * t.length / 2,
                t.total + (z * scale - 1) * t.height / 2,
            )
            for y, z in outline
        ]
        for x, scale, _ in sections
    ]

    def finish(j: int, i: int) -> str:
        surface = sections[j][2]
        if i in (2, 8) and surface in (CARBON, ARMOR):
            return METAL
        if i in (0, 1, 3, 4) and surface == ARMOR:
            return DARK
        return surface

    part = swept(
        "Faceted flank shields with inset split cheeks",
        "turret-head",
        rows,
        finish,
        True,
    )
    # The central silver rib crosses both inset faces and the top and bottom of the hull.
    del part.faces[-2:]
    del part.finishes[-2:]
    panels = [
        ((0, 1, 2, 9, 10, 11), CARBON),
        ((2, 3, 8, 9), METAL),
        ((3, 4, 5, 6, 7, 8), CARBON),
    ]
    for end in (0, len(rows) - 1):
        for ids, material in panels:
            points = [end * len(outline) + i for i in ids]
            part.face(points if end else points[::-1], material)
    return part


def runner(t: Tier, tier: int, side: int, level: str) -> Part:
    center = side * t.width * 0.22
    width = t.radius * (0.70 if tier == 3 else 1)
    height = t.radius * (0.95 if tier == 3 else 0.77)
    # The side recess and its two bright edges are part of a single shell.
    contour = [
        (-0.76, -1),
        (0.76, -1),
        (1, -0.68),
        (1, -0.36),
        (0.86, -0.25),
        (0.84, -0.075),
        (0.84, 0.075),
        (0.86, 0.25),
        (1, 0.36),
        (1, 0.68),
        (0.76, 1),
        (-0.76, 1),
        (-1, 0.68),
        (-1, 0.36),
        (-0.86, 0.25),
        (-0.84, 0.075),
        (-0.84, -0.075),
        (-0.86, -0.25),
        (-1, -0.36),
        (-1, -0.68),
    ]
    stations = [
        (0, 0.87, CARBON),
        (0.18, 1.04, DARK),
        (0.30, 1.10, METAL),
        (0.34, 1.10, ARMOR),
        (0.39, 1, DARK),
        (0.41, 0.93, ARMOR),
        (0.73, 0.88, METAL),
        (0.746, 0.88, ARMOR),
        (0.91, 0.84, DARK),
        (0.927, 0.94, METAL),
        (0.975, 0.94, METAL),
        (1, 0.82, DARK),
    ]
    if level == "lod1":
        stations = [pair for idx, pair in enumerate(stations) if idx != 10]
    rows = [
        [
            (
                center + x * width * s,
                -t.muzzle_forward + (1 - d) * t.span,
                t.muzzle_height + z * height * s,
            )
            for x, z in contour
        ]
        for d, s, _ in stations
    ]

    def finish(j: int, i: int) -> str:
        d, _, material = stations[j]
        if i in (4, 5, 6, 14, 15, 16):
            face_on_slot = (i < 10) == (side < 0)
            if 0.39 <= d < 0.91 and (tier != 3 or face_on_slot):
                return WHITE if i in (5, 15) else COBALT
            return CARBON
        if i in (3, 7, 13, 17):
            return DARK
        if i in (1, 9, 11, 19) and material == ARMOR:
            return METAL
        return material

    return swept(f"Chamfered rail {side:+d}", FORWARD, rows, finish, True)


def fin(t: Tier, sign: int) -> Part:
    # Swept fin perimeter, with straight dark seams cutting across each silver edge.
    stations = [
        (0.22, 0.18, DARK),
        (0.32, 0.90, METAL),
        (0.36, 1, ARMOR),
        (0.55, 1, DARK),
        (0.567, 1, ARMOR),
        (0.71, 1, DARK),
        (0.727, 1, ARMOR),
        (0.85, 0.86, METAL),
        (0.935, 0.12, DARK),
    ]
    rows = []
    for along, scale, _ in stations:
        row = []
        for x, z in [
            (-1, -0.65),
            (-0.65, -1),
            (0.65, -1),
            (1, -0.65),
            (1, 0.65),
            (0.65, 1),
            (-0.65, 1),
            (-1, 0.65),
        ]:
            row.append(
                (
                    x * t.radius * 0.52,
                    -t.muzzle_forward + (1 - along) * t.span,
                    t.muzzle_height + sign * t.radius * 1.48 + z * 0.010 * scale,
                )
            )
        rows.append(row)
    return swept(
        f"Swept {'dorsal' if sign > 0 else 'ventral'} fin",
        FORWARD,
        rows,
        lambda j, i: METAL if i in (0, 2, 4, 6) else stations[j][2],
        True,
    )


def build(tier: int, level: str) -> list[Part]:
    t = TIERS[tier]
    parts = [housing(t), bearing(t, level)]
    parts.extend(runner(t, tier, s, level) for s in ((-1, 1) if tier == 3 else (0,)))
    if tier == 2:
        parts.extend(fin(t, s) for s in (-1, 1))
    return parts
