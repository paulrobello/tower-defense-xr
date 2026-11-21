"""Unwrap each machined axial section as a continuous circumference on the shared atlas."""

from math import atan2, hypot, tau

import bpy


def unwrap(obj: bpy.types.Object, sections: list) -> None:
    mesh = obj.data
    uv = mesh.uv_layers.new(name="UV0")
    mesh.uv_layers.active = uv
    uv.active_render = True
    cursor = 0
    mapping = {}
    caps = {}
    # The two LODs occupy independent bands; every profile step receives at least five pixels.
    for (part, count, closed), (bottom, top) in zip(
        sections, [(8, 280), (292, 542), (554, 777), (789, 1016)], strict=True
    ):
        points = part.vertices
        rows = len(points) // count
        xx, yy, _ = points[0]
        mean_x = sum(pt[0] for pt in points[:count]) / count
        mean_y = sum(pt[1] for pt in points[:count]) / count
        origin = atan2(yy - mean_y, xx - mean_x)
        coords = [(hypot(x - mean_x, y - mean_y), z) for x, y, z in points[::count]]
        steps = [
            hypot(coords[(j + 1) % rows][0] - r, coords[(j + 1) % rows][1] - z)
            for j, (r, z) in enumerate(coords)
            if closed or j + 1 < rows
        ]
        free = (top - bottom) - 5 * len(steps)
        assert free > 0
        heights = [float(bottom)]
        for step in steps:
            heights.append(heights[-1] + 5 + free * step / sum(steps))
        # The right margin of each spindle band accommodates its two planar bearing caps.
        right = 1016 if closed else 892
        for i, (x, y, z) in enumerate(points):
            row, station = divmod(i, count)
            a = (atan2(y - mean_y, x - mean_x) - origin) % tau
            fraction = 0 if station == 0 else a / tau
            mapping[cursor + i] = (
                row,
                station,
                rows,
                count,
                8 + (right - 8) * fraction,
                heights[row],
                heights[-1],
                right,
            )
            if not closed and row in (0, rows - 1):
                cap_y = bottom + 59 if row == 0 else top - 59
                radius = coords[row][0]
                caps[cursor + i] = (
                    (956 + 52 * (x - mean_x) / radius) / 1024,
                    (cap_y + 52 * (y - mean_y) / radius) / 1024,
                )
        cursor += len(points)
    assert cursor == len(mesh.vertices)
    for face in mesh.polygons:
        idx = list(face.vertices)
        entries = [mapping[i] for i in idx]
        rows = {e[0] for e in entries}
        if len(rows) == 1 and all(i in caps for i in idx):
            for i, loop in zip(idx, face.loop_indices, strict=True):
                uv.data[loop].uv = caps[i]
            continue
        stations = {e[1] for e in entries}
        for (row, station, nrows, count, x, y, end_y, right), loop in zip(
            entries, face.loop_indices, strict=True
        ):
            if station == 0 and count - 1 in stations:
                x = right
            if row == 0 and nrows - 1 in rows:
                y = end_y
            uv.data[loop].uv = (x / 1024, y / 1024)
