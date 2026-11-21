"""Reject rays crossing a coil lip onto a different physical finish."""

from pathlib import Path

import bpy
import core_bastion as pipeline
import numpy as np
from surface_clamp_bake import raw


def repair_boundaries(
    out: Path,
    high: bpy.types.Object,
    low: bpy.types.Object,
    materials: list,
    slots: list,
    metrics: dict,
) -> None:
    receiver = low.data.materials[0]
    # Packed finish IDs compare the two ray hits independently of their colour and lighting.
    for idx, mat in enumerate(materials, 1):
        tree = mat.node_tree
        node = tree.nodes.new("ShaderNodeEmission")
        node.name = "Hover finish identity"
        node.inputs["Color"].default_value = (idx / 8, 0, 0, 1)
        tree.links.new(node.outputs[0], tree.nodes["Material Output"].inputs["Surface"])
    original_high, original_low = pipeline.exploded(high), pipeline.exploded(low)
    high.hide_render = False
    pipeline.active(low)
    high.select_set(True)
    image = bpy.data.images.new(
        "Projected hover finish identity", 1024, 1024, float_buffer=True, is_data=True
    )
    tree = receiver.node_tree
    dest = tree.nodes.new("ShaderNodeTexImage")
    dest.image = image
    tree.nodes.active = dest
    bpy.ops.object.bake(
        type="EMIT",
        use_selected_to_active=True,
        cage_extrusion=0.0017,
        max_ray_distance=0.004,
        margin=10,
        margin_type="EXTEND",
        uv_layer="UV0",
    )
    projection = np.empty((1024, 1024, 4), np.float32)
    image.pixels.foreach_get(projection.ravel())
    tree.nodes.remove(dest)
    bpy.data.images.remove(image)
    physical = pipeline.receiver_finish(low, materials, slots, receiver, "identifier")
    mask = (physical[:, :, 0] > 0.08) & (
        np.abs(projection[:, :, 0] - physical[:, :, 0]) > 0.02
    )
    metrics["cross_finish_ray_replacements"] = int(mask.sum())
    for obj, coords in ((high, original_high), (low, original_low)):
        for v, xyz in zip(obj.data.vertices, coords, strict=True):
            v.co = xyz
        obj.data.update()
    high.hide_render = True
    for role in pipeline.MAPS:
        for mat in materials:
            pipeline.emission_channel(mat, role)
        correct = pipeline.receiver_finish(low, materials, slots, receiver, role)
        path = out / f"{role}.png"
        actual = raw(path)
        if role in ("basecolor", "emissive"):
            correct = np.where(
                correct <= 0.0031308,
                12.92 * correct,
                1.055 * correct ** (1 / 2.4) - 0.055,
            )
        if role == "normal":
            vec = correct * 2 - 1
            correct = (
                vec / np.maximum(np.linalg.norm(vec, axis=2, keepdims=True), 1e-8) + 1
            ) / 2
        patched = np.rint(np.clip(correct, 0, 1) * 255).astype(np.uint8)
        if role == "orm":
            patched[:, :, 0] = actual[:, :, 0]  # Preserve the assembled contact pass.
        actual[mask] = patched[mask]
        pipeline.png(path, actual, role in ("basecolor", "emissive"))
        metrics[role]["sha256"] = pipeline.sha(path)
        for sample in metrics[role]["samples"]:
            sample["rgb"] = actual[1023 - sample["y"], sample["x"]].tolist()
