"""Continuous side charts and independent planar cap islands for the two M44 LODs."""

from math import dist

import bpy


def distribute(entries: list, rect: tuple[int, int, int, int]) -> dict:
    if len(entries) == 1:
        return {entries[0][0]: rect}
    x, y, w, h = rect
    total = sum(a for _, a in entries)
    amount = 0
    split = 0
    for k, (_, a) in enumerate(entries[:-1]):
        amount += a
        split = k + 1
        if amount >= total * 0.5:
            break
    fraction = amount / total
    if w >= h:
        cut = round(w * fraction)
        first, second = (x, y, cut, h), (x + cut, y, w - cut, h)
    else:
        cut = round(h * fraction)
        first, second = (x, y, w, cut), (x, y + cut, w, h - cut)
    return distribute(entries[:split], first) | distribute(entries[split:], second)


def unwrap(obj: bpy.types.Object, parts: list) -> None:
    mesh = obj.data
    layer = mesh.uv_layers.new(name="UV0")
    mesh.uv_layers.active = layer
    layer.active_render = True
    lookup = {}
    charts = {}
    cursor = 0
    for j, p in enumerate(parts):
        n = p.stations
        nrows = len(p.vertices) // n
        for i in range(len(p.vertices)):
            lookup[cursor + i] = (j, *divmod(i, n))
        cursor += len(p.vertices)
        rows = [p.vertices[k * n : (k + 1) * n] for k in range(nrows)]
        ds = [
            sum(dist(a, b) for a, b in zip(row, rows[(k + 1) % nrows])) / n
            for k, row in enumerate(rows)
            if k + 1 < nrows or p.closed
        ]
        base = [0]
        for step in ds:
            base.append(base[-1] + step)
        charts[j] = base
    faces = []
    areas = {}
    for face in mesh.polygons:
        entries = [lookup[i] for i in face.vertices]
        j = entries[0][0]
        row = entries[0][1]
        cap = all(entry[1] == row for entry in entries)
        key = (j, row if cap else -1)
        areas[key] = areas.get(key, 0) + face.area
        faces.append((key, entries))
    boxes = distribute(
        sorted(
            ((key, max(area, 0.0006) ** 0.75) for key, area in areas.items()),
            key=lambda x: -x[1],
        ),
        (0, 0, 1024, 1024),
    )
    for face, (key, entries) in zip(mesh.polygons, faces):
        j, cap = key
        x, y, w, h = boxes[key]
        x, y, w, h = x + 4, y + 4, w - 8, h - 8
        assert min(w, h) > 3
        p = parts[j]
        n = p.stations
        base = charts[j]
        if cap >= 0:
            ring = p.vertices[cap * n : (cap + 1) * n]
            drop = max(range(3), key=lambda axis: abs(face.normal[axis]))
            a, b = (q for q in range(3) if q != drop)
            lo = [min(pt[q] for pt in ring) for q in (a, b)]
            hi = [max(pt[q] for pt in ring) for q in (a, b)]
        for vid, loop, (_, row, i) in zip(face.vertices, face.loop_indices, entries):
            if cap >= 0:
                vtx = mesh.vertices[vid].co
                u, v = (
                    (vtx[a] - lo[0]) / (hi[0] - lo[0]),
                    (vtx[b] - lo[1]) / (hi[1] - lo[1]),
                )
            else:
                u = i / n
                if i == 0 and any(e[2] == n - 1 for e in entries):
                    u = 1
                if (
                    p.closed
                    and row == 0
                    and any(e[1] == len(base) - 2 for e in entries)
                ):
                    row = len(base) - 1
                v = 0.68 * base[row] / base[-1] + 0.32 * row / (len(base) - 1)
            layer.data[loop].uv = ((x + w * u) / 1024, (y + h * v) / 1024)
