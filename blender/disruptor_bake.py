"""Bake assembled rest-pose anatomy with a shared parametric atlas for both LODs."""

from collections.abc import Callable
from pathlib import Path

import bpy
import numpy as np
from build_materials import png
from core_bastion import active, color, sha
from disruptor_shape import PALETTE, SAMPLES
from skitter_bake import tangent_fields

SIZE = 1024


def source_finishes() -> dict:
    out = {}
    for name, (hexcolor, rough, metal) in PALETTE.items():
        mat = bpy.data.materials.new(name)
        tree = mat.node_tree
        sh = tree.nodes["Principled BSDF"]
        pigment = np.array(color(hexcolor)[:3])
        tc = tree.nodes.new("ShaderNodeTexCoord")

        def noise(
            scale: float, detail: float, tree=tree, tc=tc
        ) -> bpy.types.NodeSocket:
            node = tree.nodes.new("ShaderNodeTexNoise")
            node.inputs["Scale"].default_value = scale
            node.inputs["Detail"].default_value = detail
            tree.links.new(tc.outputs["Object"], node.inputs["Vector"])
            return node.outputs["Fac"]

        mottling = noise(115, 3)
        pores = noise(1450, 3)
        ramp = tree.nodes.new("ShaderNodeValToRGB")
        tree.links.new(mottling, ramp.inputs[0])
        ramp.name = "Cuticle pigment"
        ramp.color_ramp.elements[0].position = 0.22
        ramp.color_ramp.elements[0].color = (*(0.50 * pigment), 1)
        ramp.color_ramp.elements[1].position = 0.78
        ramp.color_ramp.elements[1].color = (*(1.45 * pigment), 1)
        tree.links.new(ramp.outputs[0], sh.inputs["Base Color"])
        roughness = tree.nodes.new("ShaderNodeMapRange")
        roughness.name = "Micro roughness"
        tree.links.new(pores, roughness.inputs["Value"])
        roughness.inputs["To Min"].default_value = rough - 0.075
        roughness.inputs["To Max"].default_value = rough + 0.075
        tree.links.new(roughness.outputs[0], sh.inputs["Roughness"])
        sh.inputs["Metallic"].default_value = metal
        bump = tree.nodes.new("ShaderNodeBump")
        bump.inputs["Strength"].default_value = 0.19
        bump.inputs["Distance"].default_value = 0.00034
        tree.links.new(pores, bump.inputs["Height"])
        tree.links.new(bump.outputs["Normal"], sh.inputs["Normal"])
        if name in ("eye", "spine"):
            tree.links.new(ramp.outputs[0], sh.inputs["Emission Color"])
            sh.inputs["Emission Strength"].default_value = 1.0
        out[name] = mat
    return out


def bake(out: Path, high: bpy.types.Object, receiver_factory: Callable) -> dict:
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 1
    mats = list(high.data.materials)
    nodes = []
    for mat in mats:
        tree = mat.node_tree
        nodes.append(tree.nodes.new("ShaderNodeTexImage"))
        tree.nodes.active = nodes[-1]
    active(high)
    metrics = {}
    for role in ("normal", "basecolor", "orm", "emissive"):
        image = bpy.data.images.new(
            f"rest {role}", SIZE, SIZE, float_buffer=True, is_data=True
        )
        for mat, dest in zip(mats, nodes, strict=True):
            tree = mat.node_tree
            dest.image = image
            tree.nodes.active = dest
            output = tree.nodes["Material Output"].inputs["Surface"]
            sh = tree.nodes["Principled BSDF"]
            if role == "normal":
                tree.links.new(sh.outputs[0], output)
                continue
            emit = tree.nodes.get("Bake radiance") or tree.nodes.new(
                "ShaderNodeEmission"
            )
            emit.name = "Bake radiance"
            tree.links.new(emit.outputs[0], output)
            inp = emit.inputs["Color"]
            if inp.links:
                tree.links.remove(inp.links[0])
            inp.default_value = (0, 0, 0, 1)
            if role == "basecolor" or (
                role == "emissive" and mat.name in ("spine", "eye")
            ):
                tree.links.new(tree.nodes["Cuticle pigment"].outputs[0], inp)
            if role == "orm":
                channels = tree.nodes.new("ShaderNodeCombineColor")
                channels.name = "Bake ORM"
                ao = tree.nodes.new("ShaderNodeAmbientOcclusion")
                ao.inputs["Distance"].default_value = 0.023
                ao.samples = 12
                tree.links.new(ao.outputs["AO"], channels.inputs["Red"])
                tree.links.new(
                    tree.nodes["Micro roughness"].outputs[0], channels.inputs["Green"]
                )
                channels.inputs["Blue"].default_value = PALETTE[mat.name][2]
                tree.links.new(channels.outputs[0], inp)
        bpy.ops.object.bake(
            type="NORMAL" if role == "normal" else "EMIT",
            use_selected_to_active=False,
            normal_space="TANGENT",
            margin=3,
            margin_type="EXTEND",
            uv_layer="UV0",
        )
        raw = np.empty((SIZE, SIZE, 4), np.float32)
        image.pixels.foreach_get(raw.ravel())
        rgb = raw[:, :, :3].copy()
        if role == "normal":
            # Matching charts transfer high bevel detail to the coarser receiver.
            h = tangent_fields(high.data)
            receiver = receiver_factory()
            l = tangent_fields(receiver.data)
            bpy.data.objects.remove(receiver, do_unlink=True)
            v = np.einsum("...i,...ij->...j", 2 * rgb - 1, h)
            v = np.einsum("...ij,...j->...i", l, v)
            mask = (np.linalg.norm(l[:, :, -1], axis=2) > 0.9) & (
                np.linalg.norm(h[:, :, -1], axis=2) > 0.9
            )
            # Preserve the high tangent normal wherever either chart lacks a sample.
            v[~mask] = 2 * rgb[~mask] - 1
            v[raw[:, :, 3] < 0.5] = (0, 0, 1)
            # Limit the correction cone to preserve unit length after UASTC interpolation.
            minimum_z = np.linalg.norm(v[:, :, :2], axis=2) / np.tan(np.deg2rad(18))
            v[:, :, 2] = np.maximum(v[:, :, 2], np.maximum(minimum_z, 0.08))
            v /= np.maximum(np.linalg.norm(v, axis=2, keepdims=True), 1e-6)
            rgb = 0.5 + 0.5 * v
            metrics["normal_correspondence_texels"] = int(mask.sum())
        srgb = role in ("basecolor", "emissive")
        if srgb:
            rgb = np.where(
                rgb <= 0.0031308,
                12.92 * rgb,
                1.055 * np.maximum(0, rgb) ** (1 / 2.4) - 0.055,
            )
        pixels = np.rint(np.clip(rgb, 0, 1) * 255).astype(np.uint8)
        png(out / f"{role}.png", pixels, srgb)
        samples = []
        for name, (u, v) in SAMPLES.items():
            x, y = int(u * SIZE), int(v * SIZE)
            samples.append(
                {
                    "surface": name,
                    "x": x,
                    "y": SIZE - 1 - y,
                    "rgb": pixels[y, x].tolist(),
                    "tolerance": 16,
                }
            )
        metrics[role] = {"sha256": sha(out / f"{role}.png"), "samples": samples}
        print("REST BAKE", role, metrics[role]["sha256"], flush=True)
        bpy.data.images.remove(image)
    for mat, dest in zip(mats, nodes, strict=True):
        tree = mat.node_tree
        tree.links.new(
            tree.nodes["Principled BSDF"].outputs[0],
            tree.nodes["Material Output"].inputs["Surface"],
        )
        tree.nodes.remove(dest)
        for node in list(tree.nodes):
            if (
                node.name in ("Bake ORM", "Bake radiance")
                or node.type == "AMBIENT_OCCLUSION"
            ):
                tree.nodes.remove(node)
    return metrics
