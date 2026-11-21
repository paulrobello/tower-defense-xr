"""Author the Glacier T2 fork within its original mount and muzzle envelope."""

import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

import glacier_cryo
from core_bastion_shape import ARMOR, DARK, METAL, Part
from glacier_shape import CYAN, FORWARD, TIERS, bearing, housing, offsets
from m44_shape import CARBON, Tier, swept


def recessed_housing(t: Tier) -> Part:
    part = housing(t)
    part.vertices = [
        (x, y - min(y, 0) * 0.70 * min(1.0, max(0.0, (z - 0.174) / 0.060)), z)
        for x, y, z in part.vertices
    ]
    return part


def blade(t: Tier, x: float) -> Part:
    # Outboard ridge, recessed channel floor and inward-facing luminous wall.
    section = [
        (1.00, 0.49, METAL),
        (0.69, 1.00, ARMOR),
        (-0.12, 1.00, DARK),
        (-0.30, 0.59, CYAN),
        (-0.73, 0.48, CYAN),
        (-0.96, 0.30, CYAN),
        (-1.00, -0.39, DARK),
        (-0.78, -0.56, METAL),
        (-0.56, -1.00, CARBON),
        (0.64, -0.93, METAL),
        (1.00, -0.47, METAL),
    ]
    # Distances are metres. The narrow nose ends at the gameplay tip center.
    stations = [
        (0.00, 0.013, 0.021, -0.006),
        (0.17, 0.019, 0.024, -0.004),
        (0.22, 0.023, 0.024, -0.002),
        (0.27, 0.023, 0.024, -0.002),
        (0.31, 0.020, 0.019, 0.000),
        (0.45, 0.019, 0.015, 0.002),
        (0.78, 0.0155, 0.012, 0.0035),
        (0.89, 0.0135, 0.0105, 0.004),
        (0.97, 0.0095, 0.0068, 0.002),
        (1.00, 0.0055, 0.003, 0.000),
    ]
    sign = 1 if x > 0 else -1
    indices = list(range(len(section)))
    if sign < 0:
        indices.reverse()
    rows = [
        [
            (
                x + sign * section[i][0] * width,
                -t.muzzle_forward + (1 - along) * t.span,
                t.muzzle_height + rise + section[i][1] * height,
            )
            for i in indices
        ]
        for along, width, height, rise in stations
    ]

    def finish(row: int, i: int) -> str:
        side = indices[i if sign > 0 else (i + 1) % len(section)]
        if row <= 3:
            return (CARBON, DARK, METAL, DARK)[row]
        if row == 8:
            return METAL if section[side][2] == METAL else DARK
        return section[side][2]

    p = swept(f"Glacier fork blade {sign:+d}", FORWARD, rows, finish, True)
    p.finishes[-1] = DARK
    return p


def build(tier: int, level: str) -> list[Part]:
    if tier != 2:
        raise ValueError("This revision owns only Glacier T2")
    t = TIERS[tier]
    return [
        recessed_housing(t),
        bearing(t, level),
        *[blade(t, x) for x, _ in offsets(t, tier)],
    ]


if __name__ == "__main__":
    glacier_cryo.build = build
    glacier_cryo.main()
