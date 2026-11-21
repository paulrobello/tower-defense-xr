"""Original inclined plasma crucibles in Blender metres, with front toward -Y."""

from math import copysign, cos, radians, sin, tau

from core_bastion_shape import ARMOR, DARK, METAL, Part
from m44_shape import CARBON, Tier, radial, swept

PLASMA = "Helios molten orange"
HOT = "Helios incandescent heart"
TIERS = {
    1: Tier(0.18, 0.16, 0.20, 0.09, 0.27, 0.16, 0.042, 0.25, 0.16),
    2: Tier(0.21, 0.175, 0.22, 0.095, 0.29, 0.18, 0.038, 0.27, 0.18),
    3: Tier(0.23, 0.19, 0.25, 0.10, 0.31, 0.21, 0.052, 0.29, 0.20),
}
# The glTF socket remains forward-facing. The flared cup faces incline independently.
ASCENT = radians(35)
LIP_ANGLE = radians(70)


def pressure_hull(t: Tier, level: str) -> Part:
    # A raised, rearward egg-shaped crown falls away toward the exposed chamber throats.
    shape = [
        (-1.0, 0, 0.49, CARBON),
        (-0.94, 0, 0.62, DARK),
        (-0.83, 0, 0.77, METAL),
        (-0.73, 0, 0.82, CARBON),
        (-0.65, 0, 0.86, ARMOR),
        (-0.34, 0, 0.97, ARMOR),
        (-0.26, 0, 1.0, METAL),
        (-0.20, 0, 1.0, DARK),
        (-0.15, 0, 0.97, METAL),
        (-0.10, 0, 0.985, ARMOR),
        (0.16, 0.02, 0.96, ARMOR),
        (0.47, 0.07, 0.87, ARMOR),
        (0.70, 0.13, 0.70, DARK),
        (0.76, 0.14, 0.67, METAL),
        (0.82, 0.15, 0.63, ARMOR),
        (0.96, 0.2, 0.43, METAL),
        (1.0, 0.21, 0.34, CARBON),
    ]
    if level == "lod1":
        shape = [shape[i] for i in (0, 2, 4, 6, 7, 9, 11, 13, 16)]
    n = {"high": 64, "lod0": 16, "lod1": 12}[level]
    rings = []
    for h, shift, scale, _ in shape:
        row = []
        for i in range(n):
            a = tau * i / n
            row.append(
                (
                    0.81 * t.width * scale * cos(a) / 2,
                    t.length * (shift + scale * sin(a)) / 2,
                    t.total + (h - 1) * t.height / 2,
                )
            )
        rings.append(row)
    return swept(
        "Swept pressure vessel", "turret-head", rings, lambda j, _: shape[j][3], True
    )


def chamber(t: Tier, tier: int, level: str, x: float, collar: bool = False) -> Part:
    if collar and tier == 2:
        profile = [
            (1.03, 0.53, DARK),
            (1.1, 0.55, METAL),
            (1.1, 0.575, ARMOR),
            (1.10, 0.63, METAL),
            (1.06, 0.65, DARK),
            (0.86, 0.64, CARBON),
            (0.87, 0.53, DARK),
        ]
        if level == "lod1":
            profile = [profile[i] for i in (0, 1, 3, 4, 5, 6)]
        n = {"high": 64, "lod0": 16, "lod1": 8}[level]
    elif collar:
        # The siege crown surrounds both emitter cups; its recessed belly is open.
        profile = [
            (1.01, 0.63, DARK),
            (1.10, 0.68, METAL),
            (1.10, 0.72, DARK),
            (1.09, 0.74, ARMOR),
            (1.10, 0.84, DARK),
            (1.10, 0.86, PLASMA),
            (1.10, 0.89, METAL),
            (1.12, 0.91, METAL),
            (1.10, 0.94, ARMOR),
            (0.94, 0.94, CARBON),
            (0.95, 0.64, DARK),
        ]
        if level == "lod1":
            profile = [profile[i] for i in (0, 1, 3, 5, 6, 8, 9, 10)]
        n = {"high": 64, "lod0": 24, "lod1": 12}[level]
    else:
        profile = [
            (0.66, 0, CARBON),
            (0.83, 0.06, METAL),
            (0.95, 0.12, ARMOR),
            (1.03, 0.29, METAL),
            (1.04, 0.33, DARK),
            (0.94, 0.35, PLASMA),
            (0.95, 0.47, METAL),
            (1.02, 0.49, ARMOR),
            (1.01, 0.69, DARK),
            (0.97, 0.72, PLASMA),
            (0.97, 0.88, METAL),
            (1.05, 0.89, ARMOR),
            (1.04, 0.97, METAL),
            (1, 1, METAL),
            (0.82, 1, DARK),
            (0.77, 0.985, PLASMA),
            (0.68, 0.935, PLASMA),
            (0.49, 0.885, HOT),
            (0.30, 0.86, DARK),
            (0.23, 0.884, HOT),
        ]
        if level == "lod1":
            profile = [profile[i] for i in (0, 3, 5, 6, 8, 9, 10, 13, 14, 16, 17, 19)]
        n = {"high": 64, "lod0": 28, "lod1": 12}[level]
    rings = []
    for r, fraction, _ in profile:
        along = (fraction - 1) * t.span
        row = []
        for i in range(n):
            a = tau * i / n
            u, v = cos(a), sin(a)
            # T2 has rounded rectangular plasma cells; the common T3 rim is a wide capsule.
            power = 0.52 if tier == 2 else 0.62 if collar else 1.0
            u, v = (copysign(abs(q) ** power, q) for q in (u, v))
            perimeter_x = (t.width * 0.24 + t.radius) if collar else t.radius
            cross = v * t.radius * r
            row.append(
                (
                    x + u * perimeter_x * r,
                    -t.muzzle_forward - along * cos(ASCENT) + cross * sin(LIP_ANGLE),
                    t.muzzle_height + along * sin(ASCENT) + cross * cos(LIP_ANGLE),
                )
            )
        rings.append(row)

    def finish(j: int, i: int) -> str:
        _, pos, surface = profile[j]
        if not collar and surface == PLASMA and pos < 0.89:
            if tier == 1 and 0.7 < pos:
                return PLASMA
            if i % (n // 4) == 0:
                return DARK
        return surface

    piece = swept(
        ("Siege field crown" if tier == 3 else "Linked cell bridge")
        if collar
        else f"Plasma crucible {x:+.4f}",
        "forward-assembly",
        rings,
        finish,
        not collar,
    )
    if not collar:
        piece.finishes[-1] = HOT
    return piece


def pivot(t: Tier, level: str, side: int) -> list[Part]:
    z = t.base + t.height / 2
    # The bearing arm follows yaw while its capped trunnion follows the pitching vessel.
    outline = [
        (-0.027, -0.004),
        (-0.023, -0.033),
        (-0.019, -0.069),
        (0.021, -0.073),
        (0.031, -0.026),
        (0.030, 0.009),
        (0.015, 0.027),
        (-0.012, 0.028),
    ]
    rows = []
    for fraction, scale in ((0.74, 0.89), (0.84, 1), (0.89, 1), (0.91, 0.90)):
        ring = []
        for y, dz in outline:
            taper = max(0, -dz / 0.073) * 0.25
            ring.append(
                (
                    side * t.width / 2 * (fraction - taper),
                    side * y * scale,
                    z + dz * scale,
                )
            )
        rows.append(ring)
    arm = swept(
        f"Forked gimbal cheek {side}",
        "yaw-bearing",
        rows,
        lambda j, _: (DARK, METAL, ARMOR)[j],
        True,
    )
    n = {"high": 48, "lod0": 16, "lod1": 8}[level]
    profile = [
        (0.026, 0.875, DARK),
        (0.028, 0.90, METAL),
        (0.028, 0.94, DARK),
        (0.025, 0.956, METAL),
        (0.021, 0.966, CARBON),
        (0.019, 0.977, ARMOR),
        (0.018, 1, METAL),
    ]
    if level == "lod1":
        profile = [profile[i] for i in (0, 1, 3, 5, 6)]
    disk = radial(
        f"Recessed pitch hub {side}",
        "turret-head",
        [(r, t.width / 2 * x, mat) for r, x, mat in profile],
        n,
        (0, 0, 0),
    )
    disk.vertices = [(side * w, side * u, z + v) for u, v, w in disk.vertices]
    disk.finishes[-1] = ARMOR
    return [arm, disk]


def build(tier: int, level: str) -> list[Part]:
    t = TIERS[tier]
    n = {"high": 64, "lod0": 12, "lod1": 8}[level]
    joint = [
        (0.049, 0.051, DARK),
        (0.052, 0.053, DARK),
        (0.052, t.base - 0.014, METAL),
        (0.060, t.base - 0.010, METAL),
        (0.061, t.base - 0.003, CARBON),
        (0.053, t.base + 0.0005, DARK),
        (0.047, t.total - t.height + 0.015, METAL),
    ]
    parts = [
        pressure_hull(t, level),
        radial("Floating pivot saddle", "yaw-bearing", joint, n, (0, 0, 0)),
    ]
    for side in (-1, 1):
        parts.extend(pivot(t, level, side))
    spread = 0 if tier == 1 else t.width * (0.25 if tier == 2 else 0.24)
    for x in (0,) if tier == 1 else (-spread, spread):
        parts.append(chamber(t, tier, level, x))
    if tier > 1:
        parts.append(chamber(t, tier, level, 0, collar=True))
    return parts
