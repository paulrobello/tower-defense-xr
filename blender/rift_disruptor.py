"""Generate the editable Disruptor sources and both in-place animated glTF receivers."""

import argparse
import json
import sys
from pathlib import Path

import bpy
import numpy as np

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from core_bastion import atlas_material, setup
from disruptor_rig import actions, rig
from disruptor_shape import construct

MATERIAL = "Disruptor field chitin"


def save(path: Path) -> None:
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(path), compress=True, relative_remap=False)


def main() -> None:
    from disruptor_bake import bake, source_finishes

    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    stats = {}
    for level in ("high", "lod0", "lod1"):
        setup()
        bpy.context.scene.name = "Rift Disruptor"
        mat = source_finishes()
        mesh = construct(level, mat)
        pts = np.array([list(v.co) for v in mesh.data.vertices])
        stats[level] = {
            "triangles": len(mesh.data.polygons),
            "extent_XYZ_m": np.ptp(pts, axis=0).tolist(),
            "support_z_m": float(pts[:, 2].min()),
        }
        print("NEUTRAL", level, stats[level], flush=True)
        if level == "lod0":
            assert len(mesh.data.polygons) <= 6500
        if level == "high" and not args.smoke:
            stats["bake"] = bake(out, mesh, lambda: construct("lod0"))
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
        arm = rig(mesh)
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
