"""Build a matched Valkyrie tier with one 1024px atlas shared by its two LODs."""

import argparse
import json
import sys
from pathlib import Path

import bpy

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import core_bastion as pipeline
import helios_mortar as rig
from hover_pod_bake import repair_boundaries
from m44_uv import unwrap
from surface_clamp_bake import restore_misses
from valkyrie_shape import COBALT, TIERS, WHITE, build


def setup(tier: int) -> None:
    pipeline.setup()
    pipeline.SIZE = 1024
    bpy.context.scene.name = f"Valkyrie T{tier}"
    for key, base, emitted in (
        (COBALT, "23479c", "3b82f6"),
        (WHITE, "a4c9f9", "c6deff"),
    ):
        material = bpy.data.materials.new(key)
        shader = material.node_tree.nodes["Principled BSDF"]
        shader.inputs["Base Color"].default_value = pipeline.color(base)
        shader.inputs["Emission Color"].default_value = pipeline.color(emitted)
        shader.inputs["Emission Strength"].default_value = 1
        shader.inputs["Roughness"].default_value = 0.32
        shader.inputs["Metallic"].default_value = 0.20


def hierarchy(
    source: bpy.types.Object, tier: int, level: str = ""
) -> list[bpy.types.Object]:
    nodes = rig.hierarchy(source, tier, level)
    nodes[0].name = "valkyrieHead"
    return nodes


def main() -> None:
    parse = argparse.ArgumentParser()
    parse.add_argument("--tier", type=int, choices=TIERS, required=True)
    parse.add_argument("--out", type=Path, required=True)
    parse.add_argument("--geometry-only", action="store_true")
    args = parse.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    out, tier = args.out.resolve(), args.tier
    out.mkdir(parents=True, exist_ok=True)
    rig.TIERS, rig.build = TIERS, build
    setup(tier)
    high = pipeline.object_from_parts("Valkyrie original source", build(tier, "high"))
    metrics = {"high": pipeline.mesh_counts(high)}
    if not args.geometry_only:
        hierarchy(high, tier)
        bpy.data.objects.remove(high, do_unlink=True)
        pipeline.save(out / "high.blend")
    setup(tier)
    src = pipeline.object_from_parts(
        "Valkyrie projection pairs", rig.combined(tier, True)
    )
    parts = rig.combined(tier, False)
    low = pipeline.object_from_parts("Valkyrie receivers", parts)
    unwrap(low, parts)
    metrics.update(
        receiver_sha256=pipeline.topology(low),
        combined_receivers=pipeline.mesh_counts(low),
    )
    for level, limit in (("lod0", 4072), ("lod1", 1352)):
        tris = sum(
            len(f) - 2 for p in parts if p.group.startswith(level) for f in p.faces
        )
        metrics[level] = {"triangles": tris}
        print(tier, level, tris, limit, flush=True)
        assert tris <= limit
    if args.geometry_only:
        return
    mats = list(low.data.materials)
    slots = [p.material_index for p in low.data.polygons]
    metrics["bake"] = pipeline.bake(out, src, low)
    src.hide_render = True
    restore_misses(out, low, mats, slots, metrics["bake"])
    repair_boundaries(out, src, low, mats, slots, metrics["bake"])
    assert metrics["receiver_sha256"] == pipeline.topology(low)
    bpy.data.objects.remove(src, do_unlink=True)
    low.data.uv_layers.remove(low.data.uv_layers["Finish"])
    low.data.materials.clear()
    atlas = pipeline.atlas_material(out)
    atlas.name = f"Valkyrie T{tier} satin armor"
    low.data.materials.append(atlas)
    for node in atlas.node_tree.nodes:
        if node.type == "TEX_IMAGE":
            node.image.name = f"Valkyrie T{tier} {node.label}"
    for level in ("lod1", "lod0"):
        nodes = hierarchy(low, tier, level)
        bpy.ops.object.select_all(action="DESELECT")
        for node in nodes:
            node.select_set(True)
        folder = out / level
        folder.mkdir(exist_ok=True)
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
    (out / "geometry.json").write_text(json.dumps(metrics, indent=2) + "\n")


if __name__ == "__main__":
    main()
