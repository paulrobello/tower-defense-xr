"""Build the Core Bastion's editable high and triangulated low receiver, bake and export."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Vector

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from build_materials import png
from core_bastion_shape import CRYSTAL, EMITTER, PIVOTS, Part, build
from io_scene_gltf2.blender.com import material_helpers
from materials import SURFACES, material

SIZE = 2048
MAPS = ("basecolor", "normal", "orm", "emissive")


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def color(hex_value: str) -> tuple:
    values = [int(hex_value[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(
        (v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4) for v in values
    ) + (1,)


def finish(name: str) -> bpy.types.Material:
    if name == "carbon-inset" and bpy.data.materials.get("Core carbon inserts"):
        return bpy.data.materials["Core carbon inserts"]
    if name in SURFACES:
        mat = material(name)
        if not mat.node_tree.nodes.get("Machining UV"):
            tree = mat.node_tree
            uv = tree.nodes.new("ShaderNodeUVMap")
            uv.name, uv.uv_map = "Machining UV", "Finish"
            for node in list(tree.nodes):
                if node.type == "TEX_IMAGE":
                    tree.links.new(uv.outputs[0], node.inputs["Vector"])
                elif node.type == "NORMAL_MAP":
                    node.uv_map = "Finish"
        return mat
    existing = bpy.data.materials.get(name)
    if existing:
        return existing
    mat = bpy.data.materials.new(name)
    tree = mat.node_tree
    shader = tree.nodes["Principled BSDF"]
    if name == "carbon-inset":
        source = finish("tactical-ceramic")
        mat = source.copy()
        mat.name = "Core carbon inserts"
        tree = mat.node_tree
        shader = tree.nodes["Principled BSDF"]
        original = shader.inputs["Base Color"].links[0].from_socket
        tint = tree.nodes.new("ShaderNodeMixRGB")
        tint.blend_type = "MULTIPLY"
        tint.inputs[0].default_value = 1
        tint.inputs[2].default_value = (0.24, 0.23, 0.28, 1)
        tree.links.new(original, tint.inputs[1])
        tree.links.new(tint.outputs[0], shader.inputs["Base Color"])
    elif name.startswith("gem-"):
        palettes = [
            ("2a0e54", "64349e"),
            ("00687d", "24bed3"),
            ("4c247a", "945ac6"),
            ("143555", "1c809d"),
            ("380c65", "7227ac"),
            ("11385c", "2b698d"),
            ("27104b", "53267f"),
        ]
        dark, bright = palettes[int(name[-1])]
        uv = tree.nodes.new("ShaderNodeUVMap")
        uv.uv_map = "Finish"
        noise = tree.nodes.new("ShaderNodeTexNoise")
        noise.inputs["Scale"].default_value = 2.6
        noise.inputs["Detail"].default_value = 2.2
        tree.links.new(uv.outputs[0], noise.inputs["Vector"])
        ramp = tree.nodes.new("ShaderNodeValToRGB")
        ramp.color_ramp.elements[0].position, ramp.color_ramp.elements[0].color = (
            0.22,
            color(dark),
        )
        ramp.color_ramp.elements[1].position, ramp.color_ramp.elements[1].color = (
            0.78,
            color(bright),
        )
        tree.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
        for key in ("Base Color", "Emission Color"):
            tree.links.new(ramp.outputs[0], shader.inputs[key])
        shader.inputs["Roughness"].default_value = 0.18
        shader.inputs["Specular IOR Level"].default_value = 0.28
        shader.inputs["Metallic"].default_value = 0.07
        shader.inputs["Emission Strength"].default_value = 0.85
    else:
        for key in ("Base Color", "Emission Color"):
            shader.inputs[key].default_value = color(
                "2de2ff" if name.endswith("cyan") else "8b5cf6"
            )
        shader.inputs["Emission Strength"].default_value = 1
        shader.inputs["Roughness"].default_value = 0.28
    return mat


def object_from_parts(name: str, parts: list[Part]) -> bpy.types.Object:
    vertices, faces, finishes, spans = [], [], [], []
    for part in parts:
        start = len(vertices)
        vertices.extend(part.vertices)
        faces.extend([tuple(i + start for i in f) for f in part.faces])
        finishes.extend(part.finishes)
        spans.append((part, list(range(start, len(vertices)))))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    names = sorted(set(finishes))
    for key in names:
        mesh.materials.append(finish(key))
    layer = mesh.uv_layers.new(name="Finish")
    for poly, key in zip(mesh.polygons, finishes, strict=True):
        poly.material_index = names.index(key)
        normal = poly.normal
        tangent = (
            Vector((1, 0, 0))
            if abs(normal.z) > 0.85
            else Vector((0, 0, 1)).cross(normal).normalized()
        )
        tangent = (tangent - normal * tangent.dot(normal)).normalized()
        bitangent = normal.cross(tangent)
        scale = SURFACES[key].tile_m if key in SURFACES else 0.075
        for loop_id in poly.loop_indices:
            pt = mesh.vertices[mesh.loops[loop_id].vertex_index].co
            layer.data[loop_id].uv = (
                pt.dot(tangent) / scale,
                pt.dot(bitangent) / scale,
            )
    for index, (part, indices) in enumerate(spans):
        partgroup = obj.vertex_groups.new(name=f"{index:03d} {part.name}")
        partgroup.add(indices, 1, "REPLACE")
        parent = obj.vertex_groups.get(part.group) or obj.vertex_groups.new(
            name=part.group
        )
        parent.add(indices, 1, "REPLACE")
    active(obj)
    mod = obj.modifiers.new("Fixed bake diagonal", "TRIANGULATE")
    mod.quad_method, mod.ngon_method = "FIXED", "CLIP"
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def active(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)


def atlas(obj: bpy.types.Object) -> None:
    mesh = obj.data
    layer = mesh.uv_layers.new(name="UV0")
    mesh.uv_layers.active = layer
    layer.active_render = True
    active(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(
        angle_limit=math.radians(42),
        island_margin=0.006,
        area_weight=0.2,
        margin_method="FRACTION",
    )
    bpy.ops.object.mode_set(mode="OBJECT")
    bad = [p.index for p in mesh.polygons if uv_area(mesh, p) < 1e-12]
    if bad:
        raise ValueError(f"Degenerate UV triangles: {bad[:30]}")


def uv_area(mesh: bpy.types.Mesh, poly: bpy.types.MeshPolygon) -> float:
    a, b, c = [mesh.uv_layers["UV0"].data[i].uv for i in poly.loop_indices]
    return abs((b - a).cross(c - a)) * 0.5


def mesh_counts(obj: bpy.types.Object) -> dict:
    m = obj.data
    result = {"triangles": len(m.polygons), "source_vertices": len(m.vertices)}
    if m.uv_layers.get("UV0"):
        surface_areas: dict[str, list] = {}
        for p in m.polygons:
            label = m.materials[p.material_index].name
            entry = surface_areas.setdefault(label, [0, 0])
            entry[0] += uv_area(m, p)
            entry[1] += p.area
        result["uv_texels_per_m"] = {
            k: round(SIZE * math.sqrt(a / b), 1) for k, (a, b) in surface_areas.items()
        }
        result["uv_area_fraction"] = round(sum(a for a, _ in surface_areas.values()), 6)
    return result


def animate_emitter(part: bpy.types.Object) -> None:
    part.rotation_mode = "XYZ"
    for frame, angle in ((0, 0), (192, math.tau)):
        part.rotation_euler.z = angle
        part.keyframe_insert(data_path="rotation_euler", index=2, frame=frame)
    action = part.animation_data.action
    action.name = "ShieldEmitterSweep"
    bag = action.layers[0].strips[0].channelbag(part.animation_data.action_slot)
    for curve in bag.fcurves:
        for key in curve.keyframe_points:
            key.interpolation = "LINEAR"
    scene = bpy.context.scene
    scene.frame_start, scene.frame_end, scene.render.fps = 0, 192, 24
    scene.frame_set(0)


def split_controls(obj: bpy.types.Object) -> list[bpy.types.Object]:
    root = bpy.data.objects.new("coreBastion", None)
    bpy.context.collection.objects.link(root)
    controls = []
    for name, height in PIVOTS.items():
        part = obj.copy()
        part.data = obj.data.copy()
        part.name = name
        bpy.context.collection.objects.link(part)
        bm = bmesh.new()
        bm.from_mesh(part.data)
        weights = bm.verts.layers.deform.active
        index = part.vertex_groups[name].index
        bmesh.ops.delete(
            bm, geom=[v for v in bm.verts if index not in v[weights]], context="VERTS"
        )
        for v in bm.verts:
            v.co.z -= height
        bm.to_mesh(part.data)
        bm.free()
        part.data.update()
        part.location.z, part.parent = height, root
        if name == EMITTER:
            animate_emitter(part)
        controls.append(part)
    bpy.data.objects.remove(obj, do_unlink=True)
    return controls


def save(path: Path) -> None:
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.file.pack_all()
    if path.name == "high.blend":
        for image in bpy.data.images:
            if image.packed_file:
                surface, role = image.name.split(".")
                relative = f"//../../materials/{surface}/{role}.png"
                image.filepath = relative
                for packed in image.packed_files:
                    packed.filepath = relative
    bpy.ops.wm.save_as_mainfile(
        filepath=str(path), compress=True, relative_remap=path.name != "high.blend"
    )


def setup() -> None:
    if bpy.app.version != (5, 2, 2):
        raise ValueError(f"Requires Blender 5.2.2 LTS, found {bpy.app.version_string}")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.name = "Core Bastion"
    bpy.context.scene.unit_settings.system = "METRIC"


def exploded(obj: bpy.types.Object) -> list[Vector]:
    """Pair each physical part in its own bake cell. Preserve original floats exactly."""
    original = [v.co.copy() for v in obj.data.vertices]
    for v in obj.data.vertices:
        keys = [obj.vertex_groups[g.group].name for g in v.groups]
        i = int(next(k[:3] for k in keys if k[:3].isdigit()))
        v.co += Vector(((i % 8) * 1.5, (i // 8) * 1.5, 0))
    obj.data.update()
    return original


def emission_channel(mat: bpy.types.Material, role: str) -> None:
    tree = mat.node_tree
    shader = tree.nodes["Principled BSDF"]
    out = tree.nodes["Material Output"].inputs["Surface"]
    if role == "normal":
        tree.links.new(shader.outputs[0], out)
        return
    emit = tree.nodes.get("Bake emission") or tree.nodes.new("ShaderNodeEmission")
    emit.name = "Bake emission"
    tree.links.new(emit.outputs[0], out)
    source = None
    if role == "orm":
        source = next(
            (
                n.outputs["Color"]
                for n in tree.nodes
                if n.type == "TEX_IMAGE" and n.label == "orm"
            ),
            None,
        )
        default = (
            1,
            shader.inputs["Roughness"].default_value,
            shader.inputs["Metallic"].default_value,
            1,
        )
    else:
        inp = shader.inputs["Base Color" if role == "basecolor" else "Emission Color"]
        default = tuple(inp.default_value)
        if inp.is_linked:
            source = inp.links[0].from_socket
        if role == "emissive" and shader.inputs["Emission Strength"].default_value == 0:
            source, default = None, (0, 0, 0, 1)
    target = emit.inputs["Color"]
    if target.is_linked:
        tree.links.remove(target.links[0])
    target.default_value = default
    if source is not None:
        tree.links.new(source, target)


def receiver_finish(
    low: bpy.types.Object,
    materials: list,
    face_slots: list[int],
    receiver: bpy.types.Material,
    role: str,
) -> np.ndarray:
    """Read the matching low face's own physical material across a hard seam."""
    active(low)
    low.data.materials.clear()
    for mat in materials:
        low.data.materials.append(mat)
    for face, slot in zip(low.data.polygons, face_slots, strict=True):
        face.material_index = slot
    image = bpy.data.images.new(
        "Matched receiver finish", SIZE, SIZE, float_buffer=True, is_data=True
    )
    targets = []
    for mat in materials:
        node = mat.node_tree.nodes.new("ShaderNodeTexImage")
        node.image = image
        mat.node_tree.nodes.active = node
        targets.append(node)
    bpy.ops.object.bake(
        type="NORMAL" if role == "normal" else "EMIT",
        use_selected_to_active=False,
        normal_space="TANGENT",
        margin=10,
        margin_type="EXTEND",
        uv_layer="UV0",
    )
    rgba = np.empty((SIZE, SIZE, 4), np.float32)
    image.pixels.foreach_get(rgba.ravel())
    for mat, node in zip(materials, targets, strict=True):
        mat.node_tree.nodes.remove(node)
    bpy.data.images.remove(image)
    low.data.materials.clear()
    low.data.materials.append(receiver)
    return np.clip(rgba[:, :, :3], 0, 1)


def bake(out: Path, high: bpy.types.Object, low: bpy.types.Object) -> dict:
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device, scene.cycles.samples = "CPU", 1
    source_materials = list(high.data.materials)
    source_face_material = [p.material_index for p in low.data.polygons]
    target_mat = bpy.data.materials.new("Atlas receiver")
    low.data.materials.clear()
    low.data.materials.append(target_mat)
    dest = target_mat.node_tree.nodes.new("ShaderNodeTexImage")
    target_mat.node_tree.nodes.active = dest
    # Component projection and assembled contact occlusion have different ray semantics.
    probes = []
    for slot, mat in enumerate(source_materials):
        faces = [p for p in high.data.polygons if p.material_index == slot]
        if not faces:
            continue
        low_faces = [
            p for p in low.data.polygons if source_face_material[p.index] == slot
        ]
        if not low_faces:
            continue
        poly = max(low_faces, key=lambda p: uv_area(low.data, p))
        u, v = (
            sum(
                (low.data.uv_layers["UV0"].data[i].uv for i in poly.loop_indices),
                Vector((0.0, 0.0)),
            )
            / 3
        )
        probes.append((mat.name, int(u * SIZE), int(v * SIZE)))
    high.hide_render = True
    active(low)
    ao = target_mat.node_tree.nodes.new("ShaderNodeAmbientOcclusion")
    ao.inputs["Distance"].default_value = 0.026
    ao.samples = 12
    emit = target_mat.node_tree.nodes.new("ShaderNodeEmission")
    target_mat.node_tree.links.new(ao.outputs["Color"], emit.inputs["Color"])
    target_mat.node_tree.links.new(
        emit.outputs[0], target_mat.node_tree.nodes["Material Output"].inputs["Surface"]
    )
    ao_image = bpy.data.images.new(
        "Assembled contact AO", SIZE, SIZE, float_buffer=True, is_data=True
    )
    dest.image = ao_image
    bpy.ops.object.bake(
        type="EMIT",
        use_selected_to_active=False,
        margin=10,
        margin_type="EXTEND",
        uv_layer="UV0",
    )
    ao_pixels = np.empty((SIZE, SIZE, 4), np.float32)
    ao_image.pixels.foreach_get(ao_pixels.ravel())
    ao_field = np.clip(ao_pixels[:, :, 0].copy(), 0, 1)
    del ao_pixels
    bpy.data.images.remove(ao_image)
    high.hide_render = False
    high_coords, low_coords = exploded(high), exploded(low)
    active(low)
    high.select_set(True)
    metrics = {}
    misprojected = None
    for role in ("normal", "basecolor", "orm", "emissive"):
        high.select_set(True)
        for mat in source_materials:
            emission_channel(mat, role)
        image = bpy.data.images.new(role, SIZE, SIZE, float_buffer=True, is_data=True)
        dest.image = image
        bpy.ops.object.bake(
            type="NORMAL" if role == "normal" else "EMIT",
            use_selected_to_active=True,
            normal_space="TANGENT",
            cage_extrusion=0.0017,
            max_ray_distance=0.004,
            margin=10,
            margin_type="EXTEND",
            use_clear=True,
            uv_layer="UV0",
        )
        pixels = np.empty((SIZE, SIZE, 4), np.float32)
        image.pixels.foreach_get(pixels.ravel())
        field = np.clip(pixels[:, :, :3], 0, 1)
        reference = receiver_finish(
            low, source_materials, source_face_material, target_mat, role
        )
        if role == "normal":
            projected = field * 2 - 1
            physical = reference * 2 - 1
            denominator = np.maximum(
                np.linalg.norm(projected, axis=2) * np.linalg.norm(physical, axis=2),
                1e-8,
            )
            agreement = np.sum(projected * physical, axis=2) / denominator
            # The 64-sided carrier differs by at most 2.82 degrees from the high.
            # Larger jumps at hard seams indicate a projection onto an adjacent face.
            misprojected = agreement < math.cos(math.radians(12))
            metrics["matched_receiver_replacements"] = {
                "pixels": int(misprojected.sum()),
                "max_angle_deg": 12,
            }
        field[misprojected] = reference[misprojected]
        if role == "orm":
            field[:, :, 0] *= ao_field
        covered = pixels[:, :, 3] > 0.5
        is_color = role in ("basecolor", "emissive")
        if is_color:
            field = np.where(
                field <= 0.0031308, 12.92 * field, 1.055 * field ** (1 / 2.4) - 0.055
            )
        if role == "normal":
            vector = field * 2 - 1
            lengths = np.linalg.norm(vector, axis=2)
            invalid = (lengths < 0.1) | (vector[:, :, 2] <= 0)
            bad = int((invalid & covered).sum())
            metrics["normal_lower_hemisphere_pixels"] = bad
            if bad:
                raise ValueError(
                    f"{bad} covered tangent normals point below the receiver"
                )
            vector[invalid] = [0, 0, 1]
            field = (
                vector / np.maximum(np.linalg.norm(vector, axis=2, keepdims=True), 1e-8)
                + 1
            ) * 0.5
        rgb = np.rint(field * 255).astype(np.uint8)
        png(out / f"{role}.png", rgb, is_color)
        samples = [
            {
                "surface": name,
                "x": x,
                "y": SIZE - 1 - y,
                "rgb": rgb[y, x].tolist(),
                "tolerance": 12,
            }
            for name, x, y in probes
        ]
        metrics[role] = {"sha256": sha(out / f"{role}.png"), "samples": samples}
        bpy.data.images.remove(image)
    for obj, coords in [(high, high_coords), (low, low_coords)]:
        for v, xyz in zip(obj.data.vertices, coords, strict=True):
            v.co = xyz
        obj.data.update()
        assert all(
            v.co == xyz for v, xyz in zip(obj.data.vertices, coords, strict=True)
        )
    metrics["contact_AO"] = {
        "ray_length_m": 0.026,
        "samples": 12,
        "mean_of_occupied": float(ao_field[ao_field > 0].mean()),
    }
    return metrics


def atlas_material(out: Path) -> bpy.types.Material:
    mat = bpy.data.materials.new("Bastion Rib")
    mat.use_backface_culling = True
    tree = mat.node_tree
    shader = tree.nodes["Principled BSDF"]
    maps = {}
    for i, role in enumerate(MAPS):
        image = bpy.data.images.load(str(out / f"{role}.png"))
        image.colorspace_settings.name = (
            "sRGB" if role in ("basecolor", "emissive") else "Non-Color"
        )
        image.name = f"Core Bastion {role}"
        node = tree.nodes.new("ShaderNodeTexImage")
        node.image, node.label, node.location = image, role, (-650, 350 - i * 260)
        maps[role] = node.outputs["Color"]
    tree.links.new(maps["basecolor"], shader.inputs["Base Color"])
    tree.links.new(maps["emissive"], shader.inputs["Emission Color"])
    shader.inputs["Emission Strength"].default_value = 1
    normal = tree.nodes.new("ShaderNodeNormalMap")
    normal.uv_map = "UV0"
    tree.links.new(maps["normal"], normal.inputs["Color"])
    tree.links.new(normal.outputs["Normal"], shader.inputs["Normal"])
    orm = tree.nodes.new("ShaderNodeSeparateColor")
    tree.links.new(maps["orm"], orm.inputs[0])
    tree.links.new(orm.outputs["Green"], shader.inputs["Roughness"])
    tree.links.new(orm.outputs["Blue"], shader.inputs["Metallic"])
    occ = tree.nodes.new("ShaderNodeGroup")
    key = material_helpers.get_gltf_node_name()
    occ.node_tree = bpy.data.node_groups.get(
        key
    ) or material_helpers.create_settings_group(key)
    tree.links.new(orm.outputs["Red"], occ.inputs["Occlusion"])
    return mat


def topology(obj: bpy.types.Object) -> str:
    h = hashlib.sha256()
    for v in obj.data.vertices:
        h.update(struct.pack("<3f", *v.co))
    for p in obj.data.polygons:
        h.update(struct.pack("<3I", *p.vertices))
    for n in obj.data.corner_normals:
        h.update(struct.pack("<3f", *n.vector))
    for uv in obj.data.uv_layers["UV0"].data:
        h.update(struct.pack("<2f", *uv.uv))
    return h.hexdigest()


def export_gltf(out: Path) -> None:
    bpy.ops.export_scene.gltf(
        filepath=str(out / "source.gltf"),
        export_format="GLTF_SEPARATE",
        export_yup=True,
        export_tangents=True,
        export_texcoords=True,
        export_normals=True,
        export_animations=True,
        export_force_sampling=True,
        export_frame_step=4,
        export_frame_range=True,
        export_animation_mode="ACTIONS",
        export_extras=False,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--geometry-only", action="store_true")
    parser.add_argument(
        "--high-only", action="store_true", help="Rebuild only the packed high source"
    )
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    setup()
    high = object_from_parts("High source", build(True))
    high_counts = mesh_counts(high)
    split_controls(high)
    if not args.geometry_only:
        save(out / "high.blend")
    if args.high_only:
        return
    setup()
    high = object_from_parts("High source", build(True))
    low = object_from_parts("Low receiver", build(False))
    atlas(low)
    high_counts["parts"] = len(build(True))
    geometry = {
        "high": high_counts,
        "low": mesh_counts(low),
        "receiver_sha256": topology(low),
    }
    print(json.dumps(geometry, indent=2), flush=True)
    assert geometry["low"]["triangles"] <= 14000
    if args.geometry_only:
        return
    metrics = bake(out, high, low)
    assert topology(low) == geometry["receiver_sha256"]
    bpy.data.objects.remove(high, do_unlink=True)
    low.data.uv_layers.remove(low.data.uv_layers["Finish"])
    low.data.materials.clear()
    low.data.materials.append(atlas_material(out))
    controls = split_controls(low)
    for part in controls:
        if part.name in (CRYSTAL, EMITTER):
            distinct = part.data.materials[0].copy()
            distinct.name = "Bastion Prism" if part.name == CRYSTAL else "Bastion Field"
            part.data.materials[0] = distinct
    bpy.ops.outliner.orphans_purge(do_recursive=True)
    save(out / "low.blend")
    export_gltf(out)
    (out / "geometry.json").write_text(
        json.dumps({**geometry, "bake": metrics}, indent=2) + "\n"
    )


if __name__ == "__main__":
    main()
