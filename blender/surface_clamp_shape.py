"""Bastion Rib mounting shoe, dimensions in metres. Frame: +Z up, -Y forward."""

from itertools import pairwise
from math import cos, pi, sin, tau

from core_bastion_shape import ARMOR, DARK, METAL, TEAL, Part

LEG_ANGLES = tuple(-pi / 4 + i * pi / 2 for i in range(4))
HUB = "turret-clamp-hub"
LEGS = tuple(f"turret-clamp-leg-{i}" for i in range(4))
PIVOTS = {HUB: (0, 0, 0)} | {
    name: (0.0795 * cos(a), 0.0795 * sin(a), 0.032)
    for name, a in zip(LEGS, LEG_ANGLES, strict=True)
}


def radial(a: float, r: float, w: float, z: float) -> tuple:
    return (r * cos(a) - w * sin(a), r * sin(a) + w * cos(a), z)


def hub(segments: int, level: str) -> Part:
    part = Part("Scalloped bearing and machined socket face", HUB)
    # Cut a flat seat normal to each heel. The connecting keys end on these faces.
    profile = [
        (0.028, 0.006, DARK),
        (0.032, 0.005, METAL),
        (0.037, 0.005, DARK),
        (0.040, 0.007, DARK),
        (0.075, 0.007, DARK),
        (0.089, 0.008, DARK),
        (0.097, 0.011, METAL),
        (0.100, 0.014, METAL),
        (0.100, 0.019, METAL),
        (0.097, 0.021, DARK),
        (0.098, 0.023, DARK),
        (0.106, 0.024, DARK),
        (0.110, 0.027, METAL),
        (0.110, 0.029, TEAL),
        (0.110, 0.0304, METAL),
        (0.108, 0.033, METAL),
        (0.102, 0.038, ARMOR),
        (0.090, 0.043, ARMOR),
        (0.074, 0.044, DARK),
        (0.071, 0.046, METAL),
        (0.071, 0.050, DARK),
        (0.069, 0.0525, METAL),
        (0.065, 0.055, METAL),
        (0.058, 0.055, DARK),
        (0.056, 0.053, DARK),
        (0.052, 0.053, METAL),
        (0.050, 0.055, ARMOR),
        (0.016, 0.055, DARK),
        (0.014, 0.053, DARK),
    ]
    # Keep the seating height, outer accent and contact sections on both receivers.
    if level != "high":
        retained = (
            [0, 3, 5, 7, 8, 10, 12, 13, 14, 16, 18, 19, 20, 22, 23, 24, 26, 27, 28]
            if level == "lod0"
            else [0, 5, 7, 8, 10, 12, 13, 14, 16, 18, 20, 22, 23, 24, 26, 28]
        )
        profile = [profile[i] for i in retained]
    rings = []
    for radius, z, _ in profile:
        vertices = []
        for j in range(segments):
            a = tau * j / segments
            delta = abs((a % (pi / 2)) - pi / 4)
            flat = 0.0775 / cos(delta)
            t = min(1, max(0, (delta - 0.32) / 0.23))
            t = t * t * (3 - 2 * t)
            r = min(radius, flat) * (1 - t) + radius * t
            vertices.append(radial(a, r, 0, z))
        rings.append(part.ring(vertices))
    part.face(rings[0][::-1], DARK)
    for i, (bottom, top) in enumerate(pairwise(rings)):
        for j in range(segments):
            k = (j + 1) % segments
            a = tau * (j + 0.5) / segments
            finish = profile[i][2]
            if finish == TEAL and abs((a % (pi / 2)) - pi / 4) < 0.53:
                finish = DARK
            part.face([bottom[j], bottom[k], top[k], top[j]], finish)
    part.face(rings[-1], DARK)
    return part


def shoe(i: int, detail: bool) -> Part:
    a = LEG_ANGLES[i]
    part = Part("Pressure shoe and satin guard", LEGS[i])
    inner, outer = 0.0795, 0.1580
    mid = (inner + outer) / 2
    outline = [
        (inner, -0.014),
        (inner + 0.006, -0.021),
        (outer - 0.009, -0.023),
        (outer, -0.016),
        (outer, 0.016),
        (outer - 0.009, 0.023),
        (inner + 0.006, 0.021),
        (inner, 0.014),
    ]

    def station(r: float) -> float:
        return (r - inner) / (outer - inner)

    def face_height(r: float) -> float:
        return 0.0455 - 0.025 * station(r)

    rings = []
    sections = [
        (0.55, 0.56, lambda r: 0.0017),
        (0.65, 0.66, lambda r: 0.0017),
        (0.68, 0.695, lambda r: 0),
        (0.91, 0.89, lambda r: 0),
        (0.99, 0.98, lambda r: 0.0024),
        (1, 1, lambda r: 0.0065),
        (0.985, 0.98, lambda r: 0.0083),
        (0.955, 0.94, lambda r: 0.0094),
        (0.953, 0.94, lambda r: face_height(r) - 0.004),
        (0.92, 0.89, lambda r: face_height(r) - 0.0018),
        (0.87, 0.79, face_height),
        (0.775, 0.655, face_height),
        (0.753, 0.63, lambda r: face_height(r) - 0.0012),
        (0.724, 0.592, lambda r: face_height(r) - 0.0014),
    ]
    finishes = [
        ARMOR,
        DARK,
        DARK,
        DARK,
        DARK,
        METAL,
        DARK,
        ARMOR,
        METAL,
        METAL,
        METAL,
        DARK,
        DARK,
    ]
    kept = list(range(len(sections))) if detail else [0, 2, 3, 5, 8, 10, 11, 13]
    for index in kept:
        scale_r, scale_w, height = sections[index]
        pts = [(mid + (r - mid) * scale_r, w * scale_w) for r, w in outline]
        rings.append(part.ring([radial(a, r, w, height(r)) for r, w in pts]))
    for n, index in enumerate(kept[:-1]):
        part.bridge(rings[n], rings[n + 1], finishes[index])
    part.face(rings[0][::-1], ARMOR)
    end = rings[-1]
    # Insert is continuous with its rolled lip. Cut grip bars into the toe end.
    part.face([end[0], end[1], end[6], end[7]], ARMOR)
    part.face([end[2], end[3], end[4], end[5]], ARMOR)
    start, stop = (
        mid + (inner + 0.006 - mid) * 0.724,
        mid + (outer - 0.009 - mid) * 0.724,
    )
    strips = (
        [
            (0.10, 0, ARMOR),
            (0.13, -0.0008, TEAL),
            (0.17, -0.0008, DARK),
            (0.19, 0, ARMOR),
            (0.65, 0, ARMOR),
            (0.68, -0.001, DARK),
            (0.73, -0.001, DARK),
            (0.755, 0, ARMOR),
            (0.82, 0, ARMOR),
            (0.845, -0.001, DARK),
            (0.89, -0.001, DARK),
            (0.915, 0, ARMOR),
        ]
        if detail
        else [(0.13, 0, ARMOR), (0.17, 0, TEAL), (0.74, 0, ARMOR), (0.83, 0, DARK)]
    )
    last = [end[1], end[1], end[6], end[6]]
    for t, depression, finish in strips:
        r = start + (stop - start) * t
        w = (0.021 + 0.002 * t) * 0.592
        row = part.ring(
            [
                radial(
                    a,
                    r,
                    side * w,
                    face_height(r) - 0.0014 + (depression if abs(side) < 1 else 0),
                )
                for side in (-1, -0.72, 0.72, 1)
            ]
        )
        for j in range(3):
            face = list(dict.fromkeys([last[j], row[j], row[j + 1], last[j + 1]]))
            part.face(face, finish if j == 1 else ARMOR)
        last = row
    tail = [end[2], end[2], end[5], end[5]]
    for j in range(3):
        part.face(
            list(dict.fromkeys([last[j], tail[j], tail[j + 1], last[j + 1]])), ARMOR
        )
    return part


def key(i: int) -> Part:
    a = LEG_ANGLES[i]
    part = Part("Recessed heel trunnion", LEGS[i])
    # An open-ended bridge meets both housings. Its terminal sections are enclosed.
    half = 0.009
    profile = [
        (-half, 0.024),
        (-half, 0.032),
        (-0.006, 0.036),
        (0.006, 0.036),
        (half, 0.032),
        (half, 0.024),
    ]
    lo, hi = [
        part.ring([radial(a, r, w, z) for w, z in reversed(profile)])
        for r in (0.0775, 0.084)
    ]
    part.bridge(lo, hi, DARK)
    return part


def build(level: str) -> list:
    segments = {"high": 128, "lod0": 32, "lod1": 16}[level]
    return [hub(segments, level)] + [
        part for i in range(4) for part in (shoe(i, level != "lod1"), key(i))
    ]
