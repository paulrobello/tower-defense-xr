"""Recover projection misses against the final receiver's physical surface fields."""

from pathlib import Path

import bpy
import core_bastion as pipeline
import numpy as np


def raw(path: Path) -> np.ndarray:
    im = bpy.data.images.load(str(path), check_existing=False)
    im.colorspace_settings.name = "Non-Color"
    field = np.empty((pipeline.SIZE, pipeline.SIZE, 4), np.float32)
    im.pixels.foreach_get(field.ravel())
    bpy.data.images.remove(im)
    return np.rint(field[:, :, :3] * 255).astype(np.uint8)


def restore_misses(
    out: Path, low: bpy.types.Object, materials: list, slots: list, metrics: dict
) -> None:
    # The low carrier can lie beyond the projection cage near a fine scallop.
    # A missed color ray is black, while every physical clamp finish has nonzero albedo.
    receiver = low.data.materials[0]
    ao_tree = receiver.node_tree
    ao_image = bpy.data.images.new(
        "Receiver contact AO",
        pipeline.SIZE,
        pipeline.SIZE,
        float_buffer=True,
        is_data=True,
    )
    target = ao_tree.nodes.new("ShaderNodeTexImage")
    target.image = ao_image
    ao_tree.nodes.active = target
    pipeline.active(low)
    bpy.ops.object.bake(
        type="EMIT",
        use_selected_to_active=False,
        margin=10,
        margin_type="EXTEND",
        uv_layer="UV0",
    )
    ao = np.empty((pipeline.SIZE, pipeline.SIZE, 4), np.float32)
    ao_image.pixels.foreach_get(ao.ravel())
    bpy.data.images.remove(ao_image)
    mask = None
    for role in ("basecolor", "normal", "orm", "emissive"):
        for m in materials:
            pipeline.emission_channel(m, role)
        physical = pipeline.receiver_finish(low, materials, slots, receiver, role)
        if role in ("basecolor", "emissive"):
            physical = np.where(
                physical <= 0.0031308,
                12.92 * physical,
                1.055 * physical ** (1 / 2.4) - 0.055,
            )
        if role == "orm":
            physical[:, :, 0] *= ao[:, :, 0]
        if role == "normal":
            v = physical * 2 - 1
            physical = (
                v / np.maximum(np.linalg.norm(v, axis=2, keepdims=True), 1e-8) + 1
            ) * 0.5
        expected = np.rint(np.clip(physical, 0, 1) * 255).astype(np.uint8)
        path = out / f"{role}.png"
        actual = raw(path)
        if role == "basecolor":
            mask = (actual.max(axis=2) < 10) & (expected.max(axis=2) > 24)
            metrics["empty_projection_replacements"] = int(mask.sum())
        actual[mask] = expected[mask]
        pipeline.png(path, actual, role in ("basecolor", "emissive"))
        metrics[role]["sha256"] = pipeline.sha(path)
        for sample in metrics[role]["samples"]:
            sample["rgb"] = actual[
                pipeline.SIZE - 1 - sample["y"], sample["x"]
            ].tolist()
