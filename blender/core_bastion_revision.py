"""Build the undercut Bastion on the original calibrated hardware and bake pipeline."""

from __future__ import annotations

import math
import sys
from pathlib import Path

import bpy

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import core_bastion as pipeline
import core_bastion_shape as original

GRAPHITE = "Core graphite ceramic"
CASSETTE = "Core carbon cassette"
BELLY = "Core underbody composite"
FINISHES = {
    GRAPHITE: ("394352", 0.61, 0.025),
    CASSETTE: ("20242c", 0.54, 0.035),
    BELLY: ("171c23", 0.56, 0.040),
}
standard_finish = pipeline.finish


def finish(name: str) -> bpy.types.Material:
    if name not in FINISHES:
        return standard_finish(name)
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    rgb, roughness, metallic = FINISHES[name]
    shader = mat.node_tree.nodes["Principled BSDF"]
    shader.inputs["Base Color"].default_value = pipeline.color(rgb)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    return mat


def landing_shoe(shell: original.Part) -> original.Part:
    # The service hatch is above the ground pads, leaving the underside visible.
    profile = [
        (0.058, 0.031, BELLY),
        (0.066, 0.031, original.DARK),
        (0.070, 0.027, BELLY),
        (0.140, 0.027, original.DARK),
        (0.146, 0.022, BELLY),
        (0.153, 0.022, original.DARK),
        (0.161, 0.024, BELLY),
        (0.194, 0.024, original.DARK),
        (0.200, 0.016, BELLY),
        (0.209, 0.016, BELLY),
        (0.219, 0.021, BELLY),
        (0.246, 0.039, BELLY),
        (0.269, 0.061, BELLY),
        (0.367, 0.241, original.DARK),
        (0.363, 0.254, GRAPHITE),
    ]
    count = len(original.ANGLES)
    for index in range(19, len(shell.vertices) // count):
        x, y, z = shell.vertices[index * count]
        coating = (
            shell.finishes[index * count]
            if index * count < len(shell.finishes) - 2
            else original.DARK
        )
        if index in (19, 20):
            coating = original.DARK
        profile.append((math.hypot(x, y), z, coating))
    return original.disk(shell.name, original.ANGLES, profile)


def pad(index: int, angle: float) -> original.Part:
    part = original.Part(f"Calibration contact pad {index}", original.PEDESTAL)
    # Each pad is widest under the hull and tapers to a calibrated toe.
    outline = [
        (0.184, -0.014),
        (0.215, -0.018),
        (0.354, -0.008),
        (0.38, 0),
        (0.354, 0.008),
        (0.215, 0.018),
        (0.184, 0.014),
    ]

    def ring(top: bool) -> list[int]:
        points = []
        for r, t in outline:
            z = (0.031 if r < 0.22 else 0.004) if top else 0.0
            u = r - (0.001 if top else 0)
            points.append(
                (
                    u * math.cos(angle) - t * math.sin(angle),
                    u * math.sin(angle) + t * math.cos(angle),
                    z,
                )
            )
        return part.ring(points)

    floor, upper = ring(False), ring(True)
    part.face(floor[::-1], BELLY)
    part.bridge(floor, upper, BELLY)
    part.face(upper, BELLY)
    return part


def build(high: bool) -> list[original.Part]:
    parts = original.build(high)
    parts[0] = landing_shoe(parts[0])
    for part in parts[1:]:
        if part.name.startswith("Service captive"):
            part.vertices = [
                (x * 0.65, y * 0.65, z + 0.0195) for x, y, z in part.vertices
            ]
            continue
        if part.group != original.PEDESTAL or part.name == "Crown bearing":
            continue
        reshaped = []
        for x, y, z in part.vertices:
            if 0.048 <= z < 0.241:
                v = (z - 0.049) / (0.241 - 0.049)
                ratio = (0.269 + v * (0.367 - 0.269)) / (0.368 + v * (0.367 - 0.368))
                x, y, z = x * ratio, y * ratio, 0.061 + v * (0.241 - 0.061)
            reshaped.append((x, y, z))
        part.vertices = reshaped
        if part.name.startswith("Shoulder ceramic"):
            part.finishes = [
                GRAPHITE if f == original.ARMOR else f for f in part.finishes
            ]
        elif part.name.startswith("Recessed bay"):
            part.finishes = [
                CASSETTE
                if f == "carbon-inset"
                else original.DARK
                if f == original.METAL
                else f
                for f in part.finishes
            ]
    parts.extend(pad(i + 1, original.ANGLES[2 * i]) for i in range(4))
    return parts


if __name__ == "__main__":
    pipeline.build = build
    pipeline.finish = finish
    pipeline.main()
