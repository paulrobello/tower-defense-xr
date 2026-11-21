"""Bind the staged Rift Bastion maps to a portable glTF Principled material in Blender."""

from dataclasses import dataclass
from pathlib import Path

import bpy
from io_scene_gltf2.blender.com import material_helpers

LIBRARY = Path(__file__).resolve().parents[1] / "assets-source" / "materials"


@dataclass(frozen=True)
class Surface:
    label: str
    tile_m: float
    roughness: tuple[float, float]
    metallic: tuple[float, float]
    emissive: bool = False


SURFACES = {
    "brushed-titanium": Surface("Brushed titanium", 0.12, (0.25, 0.42), (0.85, 1)),
    "tactical-ceramic": Surface(
        "Matte tactical ceramic", 0.16, (0.52, 0.76), (0, 0.05)
    ),
    "dark-gunmetal": Surface("Dark gunmetal", 0.10, (0.28, 0.48), (0.75, 1)),
    "obsidian-chitin": Surface("Obsidian chitin", 0.18, (0.32, 0.53), (0, 0.12)),
    "rift-obsidian": Surface("Rift obsidian", 0.22, (0.14, 0.30), (0, 0.10), True),
}


def material(surface_id: str, library: Path = LIBRARY) -> bpy.types.Material:
    """Use with active UV0 scaled by the piece author so one repeat spans tile_m."""
    spec = SURFACES[surface_id]
    name = f"RB.{surface_id}"
    existing = bpy.data.materials.get(name)
    if existing:
        return existing
    roles = ["basecolor", "normal", "orm"] + (["emissive"] if spec.emissive else [])
    images = {}
    for role in roles:
        path = library / surface_id / f"{role}.png"
        image = bpy.data.images.load(str(path), check_existing=True)
        image.name = f"{surface_id}.{role}"
        image.colorspace_settings.name = (
            "sRGB" if role in {"basecolor", "emissive"} else "Non-Color"
        )
        images[role] = image

    mat = bpy.data.materials.new(name)
    mat["tile_m"] = spec.tile_m
    tree = mat.node_tree
    shader = tree.nodes.get("Principled BSDF")
    shader.location = (300, 250)
    tree.nodes.get("Material Output").location = (660, 250)
    maps = {}
    for index, (role, image) in enumerate(images.items()):
        node = tree.nodes.new("ShaderNodeTexImage")
        node.location = (-640, 410 - index * 280)
        node.label = role
        node.image = image
        node.extension = "REPEAT"
        maps[role] = node.outputs["Color"]

    tree.links.new(maps["basecolor"], shader.inputs["Base Color"])
    normal = tree.nodes.new("ShaderNodeNormalMap")
    normal.location = (-260, 110)
    tree.links.new(maps["normal"], normal.inputs["Color"])
    tree.links.new(normal.outputs["Normal"], shader.inputs["Normal"])
    orm = tree.nodes.new("ShaderNodeSeparateColor")
    orm.location = (-260, -130)
    tree.links.new(maps["orm"], orm.inputs["Color"])
    tree.links.new(orm.outputs["Green"], shader.inputs["Roughness"])
    tree.links.new(orm.outputs["Blue"], shader.inputs["Metallic"])
    output_name = material_helpers.get_gltf_node_name()
    gltf = tree.nodes.new("ShaderNodeGroup")
    gltf.node_tree = bpy.data.node_groups.get(
        output_name
    ) or material_helpers.create_settings_group(output_name)
    gltf.location = (20, -170)
    tree.links.new(orm.outputs["Red"], gltf.inputs["Occlusion"])
    if spec.emissive:
        tree.links.new(maps["emissive"], shader.inputs["Emission Color"])
        shader.inputs["Emission Strength"].default_value = 1.0
    return mat
