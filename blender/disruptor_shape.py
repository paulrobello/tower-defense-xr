"""Closed facet patches, machined polar wells and an independent segmented field ring."""

from itertools import pairwise
from math import cos, sin, tau

import bpy
from mathutils import Vector

PALETTE = {
    "mantle": ("645085", 0.40, 0.10),
    "shield": ("4c327c", 0.41, 0.09),
    "glass": ("27203f", 0.26, 0.08),
    "socket": ("191825", 0.52, 0.06),
    "rim": ("8b779b", 0.31, 0.45),
    "eye": ("42cfff", 0.27, 0.04),
    "spine": ("8aeaff", 0.28, 0.03),
}
# Shared chart interiors for authored color/roughness/emission samples.
SAMPLES = {
    "upper shield": (0.08, 0.63),
    "side glass": (0.08, 0.39),
    "meridian": (0.1712, 0.39),
    "field conductor": (0.20, 0.879),
}


def construct(level: str, finishes: dict | None = None) -> bpy.types.Object:
    quality = ("lod1", "lod0", "high").index(level)
    verts, faces, coords, materials = [], [], [], []
    vertices, bones = {}, {"hull": [], "rotor": []}
    bone = "hull"

    def face(points: list, uv: list, finish: str, reverse: bool = False) -> None:
        ids = []
        for point in points:
            key = (bone, *(round(float(c), 7) for c in point))
            if key not in vertices:
                vertices[key] = len(verts)
                bones[bone].append(len(verts))
                verts.append(key[1:])
            ids.append(vertices[key])
        for i in range(1, len(ids) - 1):
            order = (0, i + 1, i) if reverse else (0, i, i + 1)
            faces.append([ids[k] for k in order])
            coords.append([uv[k] for k in order])
            materials.append(finish)

    def quarter(x: float, y: float, q: int) -> tuple:
        return ((x, y), (-y, x), (-x, -y), (y, -x))[q % 4]

    # Each side has a wide facet, then a chamfer containing a three-tone conductor.
    profile = [(0.075, 0), (0.145, 0.086), (0.145, 0.232), (0.079, 0.32)]
    outline = []
    for q in range(4):
        a = Vector(quarter(1, -0.48, q))
        b = Vector(quarter(1, 0.48, q))
        c = Vector(quarter(1, -0.48, q + 1))
        outline.append(a)
        outline.extend(b.lerp(c, f) for f in (0, 0.33, 0.44, 0.56, 0.67))

    for j, ((r0, z0), (r1, z1)) in enumerate(pairwise(profile)):
        for side, p in enumerate(outline):
            q, sector = divmod(side, 6)
            nxt = outline[(side + 1) % len(outline)]
            du = Vector(((nxt.x - p.x) * r0, (nxt.y - p.y) * r0, 0))
            dv = Vector((p.x * (r1 - r0), p.y * (r1 - r0), z1 - z0))
            normal = du.cross(dv).normalized()
            seam_edges = (0, 0.33, 0.44, 0.56, 0.67, 1)
            x0 = q * 0.25 + 0.005
            xw = 0.18
            if sector:
                x0 += 0.18 + 0.054 * seam_edges[sector - 1]
                xw = 0.054 * (seam_edges[sector] - seam_edges[sector - 1])
            y0, yw = j * 0.24 + 0.025, 0.226

            def patch(
                poly,
                finish,
                p=p,
                nxt=nxt,
                normal=normal,
                x0=x0,
                xw=xw,
                y0=y0,
                yw=yw,
                r0=r0,
                r1=r1,
                z0=z0,
                z1=z1,
            ):
                xyz, uv = [], []
                for u, v, h in poly:
                    xy = p.lerp(nxt, u) * (r0 + v * (r1 - r0))
                    xyz.append(Vector((*xy, z0 + v * (z1 - z0))) + h * normal)
                    uv.append(((x0 + u * xw) * 0.80, y0 + v * yw))
                face(xyz, uv, finish)

            outer = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
            if sector:
                patch(outer, ("socket", "rim", "eye", "rim", "socket")[sector - 1])
                continue

            def octagon(inset, cut, height):
                a, b = inset, 1 - inset
                return [
                    (x, y, height)
                    for x, y in (
                        (a + cut, a),
                        (b - cut, a),
                        (b, a + cut),
                        (b, b - cut),
                        (b - cut, b),
                        (a + cut, b),
                        (a, b - cut),
                        (a, a + cut),
                    )
                ]

            rings = [
                (0.035, 0.13, -0.0009, "mantle"),
                (0.062, 0.13, -0.0028, "socket"),
                (0.086, 0.13, -0.0028, "socket"),
                (0.103, 0.12, -0.0013, "rim" if j == 1 else "shield"),
                (0.119, 0.12, 0.0003, "rim" if j == 1 else "shield"),
            ]
            if quality == 0:
                rings = [rings[0], rings[-1]]
            if quality == 2:
                rings.append((0.132, 0.115, 0.0010, "glass" if j == 1 else "shield"))
            inner = octagon(*rings[0][:3])
            for k in range(4):
                a, b = 2 * k, (2 * k + 1) % 8
                patch([outer[k], outer[(k + 1) % 4], inner[b], inner[a]], "mantle")
                patch([outer[k], inner[a], inner[(a - 1) % 8]], "mantle")
            for inset, cut, h, finish in rings[1:]:
                next_ring = octagon(inset, cut, h)
                for k in range(8):
                    patch(
                        [
                            inner[k],
                            inner[(k + 1) % 8],
                            next_ring[(k + 1) % 8],
                            next_ring[k],
                        ],
                        finish,
                    )
                inner = next_ring
            center = (0.5, 0.5, 0.0017 if quality else 0.0006)
            for k in range(8):
                patch(
                    [inner[k], inner[(k + 1) % 8], center],
                    "glass" if j == 1 else "shield",
                )

    for top in (False, True):
        scale, z = profile[-1 if top else 0]
        sign = 1 if top else -1
        profiles = [
            (1, 0, "mantle"),
            (0.86, 0, "mantle"),
            (0.77, 0.003, "rim"),
            (0.69, 0.010, "socket"),
            (0.61, 0.011, "eye"),
            (0.54, 0.012, "socket"),
            (0.46, 0.019, "rim"),
            (0.37, 0.018, "glass"),
        ]
        for side, p in enumerate(outline):
            n = outline[(side + 1) % len(outline)]

            def polar(pt, band, p=p, n=n, scale=scale, z=z, sign=sign, top=top):
                s, depth, _ = band
                xy = pt * (scale * s) if s == 1 else pt.normalized() * (scale * s)
                uv = (
                    0.90 + xy.x / scale * 0.09,
                    (0.53 if top else 0.23) + xy.y / scale * 0.09,
                )
                return (*xy, z - sign * depth), uv

            for a, b in pairwise(profiles):
                row = [polar(p, a), polar(n, a), polar(n, b), polar(p, b)]
                face([v for v, _ in row], [u for _, u in row], b[-1], not top)
            v, a = polar(p, profiles[-1])
            w, b = polar(n, profiles[-1])
            face(
                [v, w, (0, 0, z - sign * 0.018)],
                [a, b, (0.90, 0.53 if top else 0.23)],
                "shield",
                not top,
            )

    bone = "rotor"
    ring = [
        (0.191, -0.004, "socket"),
        (0.194, -0.008, "rim"),
        (0.211, -0.008, "mantle"),
        (0.216, -0.005, "rim"),
        (0.219, -0.003, "eye"),
        (0.220, 0.001, "eye"),
        (0.218, 0.005, "spine"),
        (0.215, 0.007, "rim"),
        (0.211, 0.008, "mantle"),
        (0.197, 0.008, "mantle"),
        (0.194, 0.006, "rim"),
        (0.191, 0.003, "eye"),
    ]
    # 48 backbone sectors remain at both LODs so the broad index marker and three
    # narrower capacitor ticks survive minification and identify rotor phase.
    count = (48, 96, 192)[quality]
    for i in range(count):
        for j, (a, b) in enumerate(zip(ring, ring[1:] + ring[:1])):
            row = []
            uv = []
            for f, k, p in ((i, j, a), (i + 1, j, a), (i + 1, j + 1, b), (i, j + 1, b)):
                angle = tau * f / count
                row.append(
                    (p[0] * cos(angle), p[0] * sin(angle) * 0.21 / 0.22, 0.16 + p[1])
                )
                uv.append((0.005 + 0.99 * f / count, 0.79 + 0.20 * k / len(ring)))
            sector = i * 48 // count
            finish = b[2]
            if j in (7, 8, 9) and sector in (0, 1, 2, 4, 15, 28, 39):
                finish = "spine" if sector in (0, 1, 2) else "eye"
            if j in (7, 8, 9) and sector in (3, 5, 14, 27, 38):
                finish = "socket"
            face(row, uv, finish)

    mesh = bpy.data.meshes.new("Nested chitin and index rotor")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("Field emitter", mesh)
    bpy.context.collection.objects.link(obj)
    layer = mesh.uv_layers.new(name="UV0")
    names = list(finishes or {})
    for material in (finishes or {}).values():
        mesh.materials.append(material)
    for poly, uv, finish in zip(mesh.polygons, coords, materials, strict=True):
        if finishes:
            poly.material_index = names.index(finish)
        for idx, xy in zip(poly.loop_indices, uv, strict=True):
            layer.data[idx].uv = xy
    for name, indices in bones.items():
        obj.vertex_groups.new(name=name).add(indices, 1, "REPLACE")
    return obj
