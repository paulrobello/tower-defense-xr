"""Generate the editable Brute sources and both in-place animated glTF receivers."""

import argparse
import json
import sys
from collections.abc import Callable
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from brute_rig import actions, rig
from brute_shape import anatomy
from core_bastion import atlas_material, setup

MATERIAL = "Brute slate carapace"


def mapping() -> Callable:
    points = np.array(
        [
            tuple(p)
            for part in anatomy("lod0")
            for p in [part.start, part.end, *[v for row in part.rings for v in row]]
        ]
    )
    lo, hi = points.min(axis=0), points.max(axis=0)
    center = (lo + hi) / 2
    center[2] = lo[2]
    scale = np.array((0.46, 0.52, 0.48)) / (hi - lo)
    return lambda p: Vector((np.asarray(p) - center) * scale)


def construct(
    level: str, xyz: Callable, finishes: dict | None = None
) -> bpy.types.Object:
    verts, faces, coords, bones, indices = [], [], [], {}, []
    for part in anatomy(level):
        base = len(verts)
        rown = len(part.rings)
        n = len(part.rings[0])
        pverts = [part.start, *[v for row in part.rings for v in row], part.end]
        verts.extend([xyz(v) for v in pverts])
        bones.setdefault(part.bone, []).extend(range(base, len(verts)))

        def vert(j: int, i: int, rown=rown, n=n, pverts=pverts) -> int:
            if j == 0:
                return 0
            if j == rown + 1:
                return len(pverts) - 1
            return 1 + (j - 1) * n + i % n

        local = []
        uv = []
        u0, v0, u1, v1 = part.uv
        for j in range(rown + 1):
            for i in range(n):
                quad = ((j, i), (j, i + 1), (j + 1, i + 1), (j + 1, i))
                for tri in ((0, 1, 2), (0, 2, 3)):
                    ids = tuple(vert(*quad[k]) for k in tri)
                    if len(set(ids)) < 3:
                        continue
                    local.append(ids)
                    uv.append(
                        [
                            (
                                u0
                                + (u1 - u0)
                                * ((i + 0.5) if a in (0, rown + 1) else b)
                                / n,
                                v0 + (v1 - v0) * a / (rown + 1),
                            )
                            for a, b in [quad[k] for k in tri]
                        ]
                    )
        volume = sum(pverts[a].dot(pverts[b].cross(pverts[c])) for a, b, c in local)
        for f, uvs in zip(local, uv, strict=True):
            if volume < 0:
                f, uvs = f[::-1], uvs[::-1]
            faces.append(tuple(base + i for i in f))
            coords.append(uvs)
            indices.append(part.finish)
    mesh = bpy.data.meshes.new("Brute cuticle")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("Carapace", mesh)
    bpy.context.collection.objects.link(obj)
    layer = mesh.uv_layers.new(name="UV0")
    groups = list(finishes or {})
    for mat in (finishes or {}).values():
        mesh.materials.append(mat)
    for poly, uvs, finish in zip(mesh.polygons, coords, indices, strict=True):
        poly.use_smooth = True
        if finishes:
            poly.material_index = groups.index(finish)
        for l, uv in zip(poly.loop_indices, uvs, strict=True):
            layer.data[l].uv = uv
    for name, verts in bones.items():
        obj.vertex_groups.new(name=name).add(verts, 1, "REPLACE")
    return obj


def save(path: Path) -> None:
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(path), compress=True, relative_remap=False)


def main() -> None:
    from brute_bake import bake, source_finishes

    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    xyz = mapping()
    stats = {}
    for level in ("high", "lod0", "lod1"):
        setup()
        bpy.context.scene.name = "Carapace Brute"
        mat = source_finishes()
        mesh = construct(level, xyz, mat)
        pts = np.array([list(v.co) for v in mesh.data.vertices])
        stats[level] = {
            "triangles": len(mesh.data.polygons),
            "extent_XYZ_m": np.ptp(pts, axis=0).tolist(),
            "support_z_m": float(pts[:, 2].min()),
        }
        print("NEUTRAL", level, stats[level], flush=True)
        if level == "lod0":
            assert len(mesh.data.polygons) <= 9000
        if level == "high" and not args.smoke:
            stats["bake"] = bake(out, mesh, lambda: construct("lod0", xyz))
        if level != "high" and not args.smoke:
            for p in mesh.data.polygons:
                p.material_index = 0
            mesh.data.materials.clear()
            atlas = atlas_material(out)
            atlas.name = MATERIAL
            mesh.data.materials.append(atlas)
            for node in atlas.node_tree.nodes:
                if node.type == "TEX_IMAGE":
                    node.image.name = node.label
        arm = rig(mesh, xyz)
        actions(arm)
        if level == "high":
            if not args.smoke:
                save(out / "high.blend")
        else:
            folder = out / level
            folder.mkdir(exist_ok=True)
            bpy.ops.object.select_all(action="DESELECT")
            for obj in (arm, mesh):
                obj.select_set(True)
            bpy.context.view_layer.objects.active = arm
            if level == "lod0" and not args.smoke:
                save(out / "low.blend")
            bpy.ops.export_scene.gltf(
                filepath=str(folder / "source.gltf"),
                export_format="GLTF_SEPARATE",
                use_selection=True,
                export_animations=True,
                export_animation_mode="ACTIONS",
                export_rest_position_armature=True,
                export_skins=True,
                export_tangents=True,
                export_force_sampling=True,
                export_optimize_animation_size=False,
            )
            doc = json.loads((folder / "source.gltf").read_text())
            print(
                "EXPORTED",
                level,
                [a["name"] for a in doc.get("animations", [])],
                flush=True,
            )
    (out / "geometry.json").write_text(json.dumps(stats, indent=2) + "\n")


if __name__ == "__main__":
    main()
