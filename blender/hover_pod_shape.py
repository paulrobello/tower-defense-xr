"""Four ribbed field coils surrounding the suspended central bearing, in metres."""

from itertools import pairwise
from math import cos, pi, sin

from core_bastion_shape import ARMOR, DARK, METAL, TEAL, Part

JACKET = "carbon-inset"

CORE = "turret-hover-repulsor-core"
RING = "turret-hover-repulsor-ring"
GROUPS = (RING, CORE)


def stations(level: str) -> list[float]:
    # Each 90-degree bay has broad ceramic faces and a narrow radial metal rib.
    offsets = {
        "high": [i * 1.125 for i in range(81)],
        "lod0": [0, 3.375, 6.75, 22.5, 33.75, 45, 56.25, 67.5, 83.25, 86.625, 90],
        "lod1": [0, 6.75, 22.5, 45, 67.5, 83.25, 90],
    }[level]
    return [(bay * 90 + d - 45) * pi / 180 for bay in range(4) for d in offsets[:-1]]


def coil(level: str) -> Part:
    part = Part("Four graphite coil jackets and recessed field lens", RING)
    # A single swept closed section seats the titanium lips directly against the lens.
    # z relief is angularly modulated only on the jackets; the emitter stays concentric.
    profile = [
        (0.106, 0.018, 0, DARK),
        (0.109, 0.015, 0, METAL),
        (0.114, 0.012, -1, ARMOR),
        (0.129, 0.011, -1, METAL),
        (0.134, 0.013, -1, DARK),
        (0.137, 0.017, 0, METAL),
        (0.140, 0.020, 0, TEAL),
        (0.145, 0.026, 0, TEAL),
        (0.149, 0.035, 0, DARK),
        (0.153, 0.036, 0, METAL),
        (0.156, 0.037, 1, METAL),
        (0.157, 0.039, 1, DARK),
        (0.155, 0.040, 1, METAL),
        (0.151, 0.045, 1, METAL),
        (0.147, 0.047, 1, DARK),
        (0.145, 0.046, 1, ARMOR),
        (0.120, 0.046, 1, ARMOR),
        (0.118, 0.047, 1, METAL),
        (0.111, 0.045, 1, METAL),
        (0.105, 0.039, 0, DARK),
        (0.104, 0.034, 0, TEAL),
        (0.104, 0.031, 0, DARK),
    ]
    keep = {
        "high": range(len(profile)),
        "lod0": [0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
        "lod1": [0, 2, 3, 5, 6, 7, 8, 10, 12, 14, 15, 16, 17, 19, 21],
    }[level]
    angles = stations(level)
    rings = []
    for k in keep:
        r, z, relief, _ = profile[k]
        points = []
        for a in angles:
            center = (a + pi / 4) % (pi / 2) - pi / 4
            from_seam = pi / 4 - abs(center)
            raised = min(1, from_seam / (pi / 24))
            # Flatten the four leading edges of the upper housing while retaining a round lens.
            weight = max(0.0, min(1.0, (r - 0.135) / 0.022)) if relief else 0.0
            trim = max(0.0, 0.157 - 0.150 / cos(center)) if relief > 0 else 0.0
            rr = r - weight * (trim + (1 - raised) * 0.004)
            zz = z + relief * 0.004 * raised
            points.append((rr * cos(a), rr * sin(a), zz))
        rings.append(part.ring(points))
    for j, k in enumerate(keep):
        lower, upper = rings[j], rings[(j + 1) % len(rings)]
        for i, a in enumerate(angles):
            end = (i + 1) % len(angles)
            mid = a + ((angles[end] - a) % (2 * pi)) / 2
            seam = (mid + pi / 4) % (pi / 2)
            seam = min(seam, pi / 2 - seam)
            finish = profile[k][3]
            if seam < pi / 26 and finish in (ARMOR, TEAL):
                finish = METAL if finish == ARMOR else DARK
            part.face(
                [lower[i], lower[end], upper[end], upper[i]],
                JACKET if finish == ARMOR else finish,
            )
    return part


def bearing(level: str) -> Part:
    part = Part("Suspended bearing with concentric flux collector", CORE)
    # The lowest annulus is proud of the center lens. Both faces remain visible in flight.
    profile = [
        (0.019, 0.008, METAL),
        (0.023, 0.007, TEAL),
        (0.027, 0.007, DARK),
        (0.030, 0.009, METAL),
        (0.037, 0.009, ARMOR),
        (0.051, 0.000, DARK),
        (0.058, 0.000, METAL),
        (0.071, 0.009, METAL),
        (0.075, 0.014, ARMOR),
        (0.084, 0.023, DARK),
        (0.086, 0.026, METAL),
        (0.086, 0.030, DARK),
        (0.084, 0.032, TEAL),
        (0.084, 0.035, DARK),
        (0.086, 0.038, ARMOR),
        (0.082, 0.047, ARMOR),
        (0.074, 0.054, METAL),
        (0.070, 0.055, DARK),
        (0.067, 0.058, METAL),
        (0.067, 0.066, METAL),
        (0.063, 0.070, DARK),
        (0.053, 0.070, DARK),
        (0.050, 0.066, METAL),
        (0.047, 0.066, ARMOR),
        (0.045, 0.068, ARMOR),
        (0.017, 0.068, METAL),
        (0.015, 0.065, DARK),
    ]
    keep = {
        "high": range(len(profile)),
        "lod0": [
            0,
            1,
            2,
            3,
            4,
            5,
            6,
            7,
            9,
            10,
            11,
            12,
            13,
            14,
            16,
            17,
            18,
            19,
            20,
            21,
            22,
            24,
            25,
            26,
        ],
        "lod1": [0, 1, 2, 4, 5, 6, 9, 10, 12, 13, 14, 16, 18, 20, 21, 22, 24, 26],
    }[level]
    segments = {"high": 128, "lod0": 16, "lod1": 12}[level]
    rings = []
    for k in keep:
        radius, z, _ = profile[k]
        rings.append(
            part.ring(
                [
                    (
                        radius * cos(i * 2 * pi / segments),
                        radius * sin(i * 2 * pi / segments),
                        z,
                    )
                    for i in range(segments)
                ]
            )
        )
    part.face(rings[0][::-1], DARK)
    for k, (a, b) in zip(keep, pairwise(rings)):
        part.bridge(a, b, profile[k][2])
    part.face(rings[-1], DARK)
    return part


def build(level: str) -> list[Part]:
    return [coil(level), bearing(level)]
