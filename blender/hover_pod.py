"""Generate one shared hover pod atlas with both triangulated LOD receivers."""

import argparse
import json
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import core_bastion as pipeline
from hover_pod_bake import repair_boundaries
from hover_pod_shape import GROUPS, build, stations
from hover_pod_uv import unwrap
from surface_clamp_bake import restore_misses

LEVELS = ("lod0", "lod1")
SIZE = 1024
OFFSET = 0.5


def install_scene() -> None:
    pipeline.setup()
    bpy.context.scene.name = "Hover Pod"
    pipeline.SIZE = SIZE


def pair(level: str, source: bool) -> list:
    parts = build("high" if source else level)
    for part in parts:
        part.group = f"{level}.{part.group}"
        if level == "lod1":
            part.vertices = [(x + OFFSET, y, z) for x, y, z in part.vertices]
    return parts


def hierarchy(combined: bpy.types.Object, prefix: str) -> list:
    root = bpy.data.objects.new("hoverPod", None)
    socket = bpy.data.objects.new("mountSocket", None)
    bpy.context.collection.objects.link(root)
    bpy.context.collection.objects.link(socket)
    socket.parent = root
    socket["socket"] = True
    objects = [root, socket]
    for name in GROUPS:
        node = combined.copy()
        node.data = combined.data.copy()
        node.name = name
        bpy.context.collection.objects.link(node)
        bm = bmesh.new()
        bm.from_mesh(node.data)
        weights = bm.verts.layers.deform.active
        index = node.vertex_groups[prefix + name].index
        bmesh.ops.delete(
            bm, geom=[v for v in bm.verts if index not in v[weights]], context="VERTS"
        )
        shift = Vector((OFFSET if prefix == "lod1." else 0, 0, 0))
        for v in bm.verts:
            v.co -= shift
        bm.to_mesh(node.data)
        bm.free()
        node.data.update()
        node.parent = root
        objects.append(node)
    return objects


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--geometry-only", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    install_scene()
    high = pipeline.object_from_parts("Hover Pod machined high source", build("high"))
    high_counts = pipeline.mesh_counts(high)
    if not args.geometry_only:
        hierarchy(high, "")
        bpy.data.objects.remove(high, do_unlink=True)
        pipeline.save(out / "high.blend")
    install_scene()
    src = pipeline.object_from_parts(
        "Hover Pod projection source",
        [part for level in LEVELS for part in pair(level, True)],
    )
    receivers = [part for level in LEVELS for part in pair(level, False)]
    low = pipeline.object_from_parts("Hover Pod receiver", receivers)
    dimensions = [
        (len(stations("lod0")), True),
        (16, False),
        (len(stations("lod1")), True),
        (12, False),
    ]
    unwrap(
        low,
        [(p, n, closed) for p, (n, closed) in zip(receivers, dimensions, strict=True)],
    )
    counts = pipeline.mesh_counts(low)
    geometry = {
        "high": high_counts,
        "continuous_profile_charts": 4,
        "planar_cap_charts": 4,
        "combined_receivers": counts,
        "receiver_sha256": pipeline.topology(low),
    }
    print(json.dumps(geometry), flush=True)
    if args.geometry_only:
        return
    materials = list(low.data.materials)
    slots = [p.material_index for p in low.data.polygons]
    geometry["bake"] = pipeline.bake(out, src, low)
    src.hide_render = True
    restore_misses(out, low, materials, slots, geometry["bake"])
    repair_boundaries(out, src, low, materials, slots, geometry["bake"])
    assert pipeline.topology(low) == geometry["receiver_sha256"]
    bpy.data.objects.remove(src, do_unlink=True)
    low.data.uv_layers.remove(low.data.uv_layers["Finish"])
    low.data.materials.clear()
    atlas = pipeline.atlas_material(out)
    atlas.name = "Hover Pod satin armor"
    for node in atlas.node_tree.nodes:
        if node.type == "TEX_IMAGE":
            node.image.name = f"Hover Pod {node.label}"
            node.image.filepath = str(out / f"{node.label}.png")
    low.data.materials.append(atlas)
    for level in reversed(LEVELS):
        nodes = hierarchy(low, level + ".")
        bpy.ops.object.select_all(action="DESELECT")
        for node in nodes:
            node.select_set(True)
        folder = out / level
        folder.mkdir(exist_ok=True)
        tris = sum(len(n.data.polygons) for n in nodes if n.type == "MESH")
        assert tris <= (3000 if level == "lod0" else 1250)
        geometry[level] = {"triangles": tris}
        bpy.ops.export_scene.gltf(
            filepath=str(folder / "source.gltf"),
            export_format="GLTF_SEPARATE",
            use_selection=True,
            use_active_scene=True,
            export_tangents=True,
            export_extras=True,
            export_animations=False,
        )
        if level == "lod0":
            bpy.data.objects.remove(low, do_unlink=True)
            bpy.ops.outliner.orphans_purge(do_recursive=True)
            pipeline.save(out / "low.blend")
        for node in reversed(nodes):
            bpy.data.objects.remove(node, do_unlink=True)
    (out / "geometry.json").write_text(json.dumps(geometry, indent=2) + "\n")


if __name__ == "__main__":
    main()
