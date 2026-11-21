"""Original Bastion Rib machining profiles, in metres in Blender coordinates."""

from __future__ import annotations

import itertools
from math import cos, pi, sin, tan, tau

from mathutils import Vector

PEDESTAL = "pedestal"
COLLAR = "containmentCollar"
CRYSTAL = "energyCrystal"
EMITTER = "shieldEmitterRing"
PIVOTS = {PEDESTAL: 0, COLLAR: 0.4032, CRYSTAL: 0.57, EMITTER: 0.012}

METAL, ARMOR, DARK = "brushed-titanium", "tactical-ceramic", "dark-gunmetal"
TEAL, VIOLET = "light-cyan", "light-violet"
ANGLES = [pi / 180 * a for a in [-123, -57, -33, 33, 57, 123, 147, 213]]


class Part:
    def __init__(self, name: str, group: str):
        self.name, self.group = name, group
        self.vertices: list[tuple] = []
        self.faces: list[tuple] = []
        self.finishes: list[str] = []

    def ring(self, points: list[tuple]) -> list[int]:
        start = len(self.vertices)
        self.vertices.extend(points)
        return list(range(start, len(self.vertices)))

    def face(self, ids: list[int], finish: str) -> None:
        self.faces.append(tuple(ids))
        self.finishes.append(finish)

    def bridge(
        self, lower: list[int], upper: list[int], finish: str, closed: bool = True
    ) -> None:
        for i in range(len(lower) if closed else len(lower) - 1):
            j = (i + 1) % len(lower)
            self.face([lower[i], lower[j], upper[j], upper[i]], finish)


def lathe(
    name: str,
    group: str,
    angles: list[float],
    profile: list[tuple],
    *,
    ends: bool = False,
) -> Part:
    """Closed section. Each finish belongs to the segment leaving its profile point."""
    part = Part(name, group)
    rings = [
        part.ring([(r * cos(a), r * sin(a), z) for a in angles]) for r, z, _ in profile
    ]
    for i, ring in enumerate(rings):
        part.bridge(ring, rings[(i + 1) % len(rings)], profile[i][2], not ends)
    if ends:
        part.face([r[0] for r in rings], DARK)
        part.face([r[-1] for r in rings][::-1], DARK)
    return part


def disk(name: str, angles: list[float], profile: list[tuple]) -> Part:
    part = Part(name, PEDESTAL)
    rings = [
        part.ring([(r * cos(a), r * sin(a), z) for a in angles]) for r, z, _ in profile
    ]
    for i in range(len(rings) - 1):
        part.bridge(rings[i], rings[i + 1], profile[i][2])
    part.face(rings[0][::-1], DARK)
    part.face(rings[-1], DARK)
    return part


def panel(
    name: str,
    face: int,
    outline: list[tuple],
    lower: tuple,
    upper: tuple,
    stack: list[tuple],
    center: str,
) -> Part:
    """Concentric chamfer contours follow the sloped plane of an octagonal bay."""
    left, right = ANGLES[face], ANGLES[face + 1] if face != 7 else ANGLES[0] + tau
    mid = (left + right) * 0.5
    n = Vector((cos(mid), sin(mid), 0))
    t = Vector((-sin(mid), cos(mid), 0))
    z0, r0 = lower
    z1, r1 = upper
    half = (right - left) / 2
    slope = (r1 - r0) * cos(half) / (z1 - z0)
    normal = (n - Vector((0, 0, slope))).normalized()
    part = Part(name, PEDESTAL)

    def frame(u: float, v: float, depth: float) -> tuple:
        radius = r0 + (r1 - r0) * v
        return tuple(
            n * (radius * cos(half))
            + t * (radius * sin(half) * u)
            + Vector((0, 0, z0 + (z1 - z0) * v))
            + depth * normal
        )

    rings = [
        part.ring([frame(u * s, (v - 0.5) * s + 0.5, depth) for u, v in outline])
        for s, depth, _ in stack
    ]
    for i in range(len(rings) - 1):
        part.bridge(rings[i], rings[i + 1], stack[i][2])
    part.face(rings[-1], center)
    return part


def circle(segments: int) -> list[float]:
    return [tau * i / segments for i in range(segments)]


def crystal() -> Part:
    part = Part("Prism", CRYSTAL)
    rings = []
    for r, z, twist in [
        (0.032, 0.466, 0),
        (0.081, 0.545, 0.19),
        (0.073, 0.578, -0.08),
        (0.038, 0.662, 0.19),
    ]:
        rings.append(
            part.ring(
                [
                    (
                        r * cos(a + twist),
                        r * sin(a + twist),
                        z + 0.008 * sin(2 * a + 0.3),
                    )
                    for a in circle(7)
                ]
            )
        )
    bottom = part.ring([(0, 0, 0.42)])[0]
    top = part.ring([(0, 0, 0.72)])[0]
    for j in range(7):
        k = (j + 1) % 7
        part.face([bottom, rings[0][k], rings[0][j]], f"gem-{(j + 1) % 7}")
        for i in range(3):
            a, b, c, d = rings[i][j], rings[i][k], rings[i + 1][k], rings[i + 1][j]
            part.face([a, b, d], f"gem-{(3 * j + i) % 7}")
            part.face([b, c, d], f"gem-{(3 * j + i + 2) % 7}")
        part.face([rings[-1][j], rings[-1][k], top], f"gem-{(2 * j + 3) % 7}")
    return part


def shoulder_rib(edge: int) -> Part:
    """Twin satin rails straddle each fold and bend onto the service deck."""
    angle = ANGLES[edge]
    previous = (angle - ANGLES[edge - 1]) % tau
    following = (ANGLES[(edge + 1) % 8] - angle) % tau
    n = Vector((cos(angle), sin(angle), 0))
    t = Vector((-sin(angle), cos(angle), 0))
    part = Part(f"Paired shoulder spine {edge + 1}", PEDESTAL)
    section = [
        (-0.012, 0.0007, DARK),
        (-0.010, 0.0031, METAL),
        (-0.008, 0.0055, METAL),
        (-0.005, 0.0055, METAL),
        (-0.0033, 0.0028, DARK),
        (0.0033, 0.0028, METAL),
        (0.005, 0.0055, METAL),
        (0.008, 0.0055, METAL),
        (0.010, 0.0031, DARK),
        (0.012, 0.0007, DARK),
    ]
    stations = [
        (0.368, 0.050, 1, 0, 0.74),
        (0.369, 0.075, 1, 0, 1),
        (0.367, 0.241, 1, 0, 1),
        (0.363, 0.254, 0.90, 0.41, 1),
        (0.3116, 0.397, 0.85, 0.54, 1),
        (0.3116, 0.4032, 0.65, 0.80, 1),
        (0.301, 0.405, 0.16, 1, 1),
        (0.293, 0.402, 0.02, 1, 0.95),
        (0.219, 0.402, 0, 1, 0.78),
        (0.215, 0.402, 0, 1, 0.58),
    ]
    rings = []
    for r, z, nr, nz, width in stations:
        points = []
        for u, h, _ in section:
            u *= width
            delta = following if u >= 0 else previous
            point = (
                n * (r - abs(u) * tan(delta / 2) + nr * h)
                + t * u
                + Vector((0, 0, z + nz * h))
            )
            points.append(tuple(point))
        rings.append(part.ring(points))
    for a, b in itertools.pairwise(rings):
        for j in range(len(a) - 1):
            part.face([a[j], a[j + 1], b[j + 1], b[j]], section[j][2])
    return part


def service_lock(index: int) -> Part:
    a = ANGLES[index]
    x, y = 0.270 * cos(a), 0.270 * sin(a)
    part = Part(f"Service captive {index + 1}", PEDESTAL)
    rings = []
    for r, z in [
        (0.012, 0.0056),
        (0.012, 0.0044),
        (0.010, 0.0033),
        (0.0055, 0.0033),
        (0.0045, 0.0051),
    ]:
        rings.append(
            part.ring([(x + r * cos(b), y + r * sin(b), z) for b in circle(6)])
        )
    for i in range(len(rings) - 1):
        part.bridge(rings[i + 1], rings[i], METAL if i in (1, 2) else DARK)
    part.face(rings[-1][::-1], DARK)
    return part


def build(high: bool) -> list[Part]:
    seg = 192 if high else 64
    parts = [
        disk(
            "Octagonal landing shoe",
            ANGLES,
            [
                (0.085, 0.013, DARK),
                (0.098, 0.013, METAL),
                (0.105, 0.009, DARK),
                (0.213, 0.009, DARK),
                (0.220, 0.0045, METAL),
                (0.228, 0.0045, DARK),
                (0.238, 0.006, DARK),
                (0.320, 0.006, DARK),
                (0.325, 0, DARK),
                (0.380, 0, DARK),
                (0.380, 0.009, METAL),
                (0.377, 0.014, DARK),
                (0.363, 0.022, DARK),
                (0.359, 0.038, DARK),
                (0.365, 0.043, METAL),
                (0.368, 0.049, DARK),
                (0.369, 0.075, DARK),
                (0.367, 0.241, METAL),
                (0.363, 0.254, METAL),
                (0.3116, 0.397, METAL),
                (0.3116, 0.4032, METAL),
                (0.301, 0.405, DARK),
                (0.293, 0.402, DARK),
                (0.213, 0.402, DARK),
                (0.201, 0.393, DARK),
                (0.162, 0.393, DARK),
                (0.155, 0.401, METAL),
                (0.145, 0.401, DARK),
                (0.140, 0.393, DARK),
                (0.137, 0.374, DARK),
                (0.119, 0.367, DARK),
                (0.091, 0.367, DARK),
                (0.081, 0.371, DARK),
            ],
        )
    ]
    bay = [
        (-0.70, 0.055),
        (0.59, 0.055),
        (0.88, 0.18),
        (0.88, 0.68),
        (0.62, 0.934),
        (-0.53, 0.934),
        (-0.88, 0.74),
        (-0.88, 0.22),
    ]
    shoulder = [
        (-0.69, 0.04),
        (0.63, 0.04),
        (0.90, 0.21),
        (0.90, 0.69),
        (0.64, 0.945),
        (-0.60, 0.945),
        (-0.90, 0.72),
        (-0.90, 0.19),
    ]
    for i in range(8):
        parts += [shoulder_rib(i), service_lock(i)]
        parts.append(
            panel(
                f"Recessed bay {i + 1}",
                i,
                bay,
                (0.049, 0.368),
                (0.241, 0.367),
                [
                    (1, 0.001, DARK),
                    (0.98, 0.0038, METAL),
                    (0.912, 0.0038, DARK),
                    (0.888, 0.0025, DARK),
                    (0.836, 0.0025, DARK),
                    (0.805, 0.0048, "carbon-inset"),
                ],
                "carbon-inset",
            )
        )
        parts.append(
            panel(
                f"Shoulder ceramic {i + 1}",
                i,
                shoulder,
                (0.254, 0.363),
                (0.397, 0.3116),
                [(1, 0.0008, DARK), (0.98, 0.003, DARK), (0.945, 0.0052, ARMOR)],
                ARMOR,
            )
        )
        # Three slot cuts are carried on a replaceable insert inside the dark side bay.
        for j in range(3):
            y = 0.27 + 0.106 * j
            line = [(-0.48, y), (0.40, y), (0.48, y + 0.034), (-0.40, y + 0.034)]
            parts.append(
                panel(
                    f"Vent {i + 1}.{j + 1}",
                    i,
                    line,
                    (0.049, 0.368),
                    (0.241, 0.367),
                    [(1, 0.0057, DARK)],
                    DARK,
                )
            )
        # A single status bar identifies the front at the calibration anchor.
        if i == 0:
            for j in range(3):
                x = -0.30 + j * 0.21
                bar = [
                    (x, 0.745),
                    (x + 0.13, 0.745),
                    (x + 0.16, 0.773),
                    (x + 0.03, 0.773),
                ]
                parts.append(
                    panel(
                        f"Calibration indicator {j + 1}",
                        i,
                        bar,
                        (0.049, 0.368),
                        (0.241, 0.367),
                        [(1, 0.0059, TEAL)],
                        TEAL if j == 0 else DARK,
                    )
                )
    # Separate machined bearing, crystal well and slotted rotating collar.
    parts.append(
        lathe(
            "Crown bearing",
            PEDESTAL,
            circle(seg),
            [
                (0.151, 0.4031, DARK),
                (0.153, 0.405, METAL),
                (0.153, 0.413, METAL),
                (0.148, 0.416, DARK),
                (0.133, 0.416, DARK),
                (0.128, 0.411, TEAL),
                (0.128, 0.405, DARK),
            ],
        )
    )
    for i in range(12):
        arc = [
            tau * (i + 0.012 + 0.969 * j / (seg // 12)) / 12
            for j in range(seg // 12 + 1)
        ]
        finish = TEAL if i % 4 != 1 else VIOLET
        parts.append(
            lathe(
                f"Containment vane {i + 1}",
                COLLAR,
                arc,
                [
                    (0.191, 0.448, DARK),
                    (0.197, 0.450, METAL),
                    (0.200, 0.454, METAL),
                    (0.200, 0.457, finish),
                    (0.200, 0.460, METAL),
                    (0.197, 0.463, METAL),
                    (0.185, 0.464, METAL),
                    (0.181, 0.461, DARK),
                    (0.181, 0.452, DARK),
                ],
                ends=True,
            )
        )
    parts.append(
        lathe(
            "Containment carrier",
            COLLAR,
            circle(seg),
            [
                (0.1805, 0.4523, DARK),
                (0.184, 0.4506, DARK),
                (0.184, 0.462, DARK),
                (0.1805, 0.460, DARK),
            ],
        )
    )
    parts.append(crystal())
    for i in range(8):
        arc = [
            tau * (i + 0.17 + 0.66 * j / (seg // 8)) / 8 for j in range(seg // 8 + 1)
        ]
        parts.append(
            lathe(
                f"Field footprint arc {i + 1}",
                EMITTER,
                arc,
                [
                    (0.489, 0.0115, DARK),
                    (0.499, 0.0115, DARK),
                    (0.499, 0.012, DARK),
                    (0.4984, 0.01245, TEAL),
                    (0.4955, 0.01245, DARK),
                    (0.489, 0.012, DARK),
                ],
                ends=True,
            )
        )
    return parts
