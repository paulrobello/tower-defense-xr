"""Keep the smart-projected charts; give folded chart faces independent UV space."""

import math
import sys
from collections import defaultdict
from pathlib import Path

import bpy
from mathutils import Vector

sys.path[:0] = [
    str(Path(__file__).resolve().parents[1] / "scripts"),
    str(Path(__file__).resolve().parents[1] / "scripts/assets"),
]
from validate_glbs import intersection_area


def separate_folds(obj: bpy.types.Object) -> int:
    mesh = obj.data
    uv = mesh.uv_layers["UV0"].data
    seen: dict = defaultdict(list)
    moved = []
    for face in mesh.polygons:
        tri = tuple((*uv[i].uv, 0.0) for i in face.loop_indices)
        lo = tuple(min(pt[d] for pt in tri) for d in (0, 1))
        hi = tuple(max(pt[d] for pt in tri) for d in (0, 1))
        cells = [
            (x, y)
            for x in range(math.floor(32 * lo[0]), math.floor(32 * hi[0]) + 1)
            for y in range(math.floor(32 * lo[1]), math.floor(32 * hi[1]) + 1)
        ]
        adjacent = {other for cell in cells for other in seen[cell]}
        area = (
            abs(
                (tri[1][0] - tri[0][0]) * (tri[2][1] - tri[0][1])
                - (tri[1][1] - tri[0][1]) * (tri[2][0] - tri[0][0])
            )
            / 2
        )
        if area * 1024**2 < 4 or any(
            intersection_area(tri, other, 2) > 1e-13 for other in adjacent
        ):
            # Isolated diagonal slivers can miss every texel center on a 1K atlas.
            # Retain the longest edge and give its opposite corner three pixels of altitude.
            a, b = max(
                ((0, 1), (1, 2), (2, 0)),
                key=lambda ab: (Vector(tri[ab[1]]) - Vector(tri[ab[0]])).length,
            )
            c = 3 - a - b
            points = [Vector(v[:2]) for v in tri]
            direction = (points[b] - points[a]).normalized()
            normal = Vector((-direction.y, direction.x))
            altitude = (points[c] - points[a]).dot(normal)
            if abs(altitude) < 3 / 1024:
                points[c] += normal * (math.copysign(3 / 1024, altitude) - altitude)
                uv[face.loop_indices[c]].uv = points[c]
            lo = tuple(min(pt[d] for pt in points) for d in (0, 1))
            hi = tuple(max(pt[d] for pt in points) for d in (0, 1))
            moved.append((face.index, lo, hi))
        else:
            for cell in cells:
                seen[cell].append(tri)
    if not moved:
        return 0
    # Pack displaced triangles by descending height into a narrow shelf above the main atlas.
    pad = 0.006
    x = y = height = 0.0
    new = {}
    for idx, lo, hi in sorted(
        moved, key=lambda entry: (entry[1][1] - entry[2][1], entry[0])
    ):
        w, h = hi[0] - lo[0] + 2 * pad, hi[1] - lo[1] + 2 * pad
        if x + w > 1:
            x, y, height = 0, y + height, 0
        new[idx] = (x + pad - lo[0], y + pad - lo[1])
        height = max(height, h)
        x += w
    split = 1 - (y + height + pad)
    assert split > 0.65, f"Excessive folded charts: {len(moved)} faces, {split=}"
    for face in mesh.polygons:
        for i in face.loop_indices:
            u, v = uv[i].uv
            if face.index in new:
                du, dv = new[face.index]
                uv[i].uv = (u + du, v + dv + split)
            else:
                uv[i].uv = (u, v * split)
    return len(moved)
