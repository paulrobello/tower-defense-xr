"""Rebuild the collector with round bearing stations and separated machined finishes."""

import sys
from math import cos, sin, tau
from pathlib import Path

import bpy

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

import hover_pod as original
import hover_pod_shape as design
from core_bastion_shape import DARK, Part
from hover_pod_uv import unwrap

BEARING_COUNT = {"lod0": 32, "lod1": 20}
BEARING_ROWS = {
    "lod0": (0, 1, 2, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 16, 18, 20, 21, 25),
    "lod1": (1, 2, 4, 5, 6, 7, 8, 9, 12, 13, 14, 16, 20, 25),
}
COIL_ROWS = {
    "lod0": (0, 2, 3, 5, 6, 7, 8, 10, 13, 14, 15, 16, 17, 18, 19, 21),
    "lod1": (0, 2, 3, 5, 6, 7, 8, 10, 15, 16, 19, 21),
}
BASE_OBJECT = original.pipeline.object_from_parts


def build(level: str) -> list[Part]:
    coil, bearing = design.build("high")
    if level == "high":
        return [coil, bearing]
    result = Part(bearing.name, bearing.group)
    rings = []
    count = BEARING_COUNT[level]
    for row in BEARING_ROWS[level]:
        radius, _, z = bearing.vertices[128 * row]
        rings.append(
            result.ring(
                [
                    (radius * cos(i * tau / count), radius * sin(i * tau / count), z)
                    for i in range(count)
                ]
            )
        )
    result.face(rings[0][::-1], DARK)
    for i, row in enumerate(BEARING_ROWS[level][:-1]):
        result.bridge(rings[i], rings[i + 1], bearing.finishes[1 + row * 128])
    result.face(rings[-1], DARK)

    race = Part(coil.name, coil.group)
    offsets = (
        [0, 3, 6, 20, 30, 40, 50, 60, 74, 77]
        if level == "lod0"
        else [0, 6, 23, 40, 57, 74]
    )
    stations = [bay * 80 + offset for bay in range(4) for offset in offsets]
    rings = [
        race.ring([coil.vertices[row * 320 + j] for j in stations])
        for row in COIL_ROWS[level]
    ]
    for i, row in enumerate(COIL_ROWS[level]):
        lower, upper = rings[i], rings[(i + 1) % len(rings)]
        for j, start in enumerate(stations):
            k = (j + 1) % len(stations)
            midpoint = (start + (stations[k] - start) % 320 // 2) % 320
            race.face(
                [lower[j], lower[k], upper[k], upper[j]],
                coil.finishes[row * 320 + midpoint],
            )
    return [race, result]


def curved_object(name: str, parts: list[Part]) -> bpy.types.Object:
    obj = BASE_OBJECT(name, parts)
    mesh = obj.data
    vertex_info = []
    for part in parts:
        core = part.group.endswith(design.CORE)
        level = part.group.split(".")[0]
        high = len(part.vertices) > 2000
        count = (
            (128 if core else 320)
            if high
            else (BEARING_COUNT[level] if core else len(design.stations(level)))
        )
        rows = (
            range(len(part.vertices) // count)
            if high
            else (BEARING_ROWS[level] if core else COIL_ROWS[level])
        )
        vertex_info.extend((core, rows[i // count]) for i in range(len(part.vertices)))
    boundaries = {}
    for face in mesh.polygons:
        rows = {vertex_info[v][1] for v in face.vertices}
        core = vertex_info[face.vertices[0]][0]
        z = [mesh.vertices[v].co.z for v in face.vertices]
        # Preserve the actual planar caps, panel faces and the hard edge at each finish lip.
        row = min(rows)
        curved = (
            len(rows) == 2
            and max(z) - min(z) > 1e-7
            and (core or (row <= 9 and max(rows) < 19))
        )
        face.use_smooth = curved
        # Both titanium segments of the curved collector share their middle profile normal.
        segment = 6 if core and row in (6, 7) else row
        for key in face.edge_keys:
            boundaries.setdefault(key, set()).add((curved, segment))
    for edge in mesh.edges:
        edge.use_edge_sharp = len(boundaries[edge.key]) > 1
    mesh.update()
    return obj


def revision_unwrap(obj: bpy.types.Object, sections: list) -> None:
    unwrap(
        obj,
        [
            (part, count if closed else BEARING_COUNT[part.group.split(".")[0]], closed)
            for part, count, closed in sections
        ],
    )


if __name__ == "__main__":
    original.build = build
    original.unwrap = revision_unwrap
    original.pipeline.object_from_parts = curved_object
    original.main()
