"""Generate the Rift Bastion portal in metres. glTF +Z faces into the room."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import core_bastion as baking
from build_materials import png

SIZE = 1024
BRUSH = "brushed-titanium"
DARK = "dark-gunmetal"
STONE = "rift-obsidian"
CYAN = "light-cyan"
VIOLET = "light-violet"

# Offset from the nominal ellipse, forward distance from host, finish leaving the knot.
PROFILE = (
    (0.000, -0.025, DARK),
    (0.007, -0.025, DARK),
    (0.011, 0.000, DARK),
    (0.113, 0.000, DARK),
    (0.120, 0.008, DARK),
    (0.120, 0.021, BRUSH),
    (0.115, 0.032, BRUSH),
    (0.103, 0.041, BRUSH),
    (0.076, 0.047, BRUSH),
    (0.041, 0.046, BRUSH),
    (0.033, 0.039, DARK),
    (0.030, 0.033, STONE),
    (0.021, 0.033, STONE),
    (0.019, 0.030, CYAN),
    (0.016, 0.030, DARK),
    (0.011, 0.025, STONE),
    (0.005, 0.015, STONE),
    (0.002, -0.015, VIOLET),
    (0.000, -0.015, DARK),
)
INLAY = "Rift midnight inlay"
SEAMS = (28, 90, 152, 208, 270, 332)


def section(angle: float, row: int) -> tuple[float, float, str]:
    r, depth, finish = PROFILE[row]
    deg = math.degrees(angle) % 360
    side = min(deg, abs(deg - 180), 360 - deg)
    seam = min(abs(deg - a) for a in SEAMS)
    if 6 <= row <= 10:
        depth -= 0.0028 * max(0.0, 1.0 - seam / 0.35)
    if row in (7, 8) and side < 28:
        taper = min(1.0, (28 - side) / 4.5)
        depth -= taper * 0.004
        r += taper * (0.007 if row == 7 else -0.009)
        if row == 7:
            finish = INLAY
    return r, depth, finish


def angles_for(n: int) -> list[float]:
    degs = sorted(
        {round(i * 360 / n, 7) for i in range(n)}
        | {a + d for a in SEAMS for d in (-0.35, 0, 0.35)}
    )
    return [math.radians(d) for d in degs]


def finish(key: str) -> bpy.types.Material:
    if key == INLAY:
        existing = bpy.data.materials.get(INLAY)
        if existing:
            return existing
        mat = bpy.data.materials.new(INLAY)
        bsdf = mat.node_tree.nodes["Principled BSDF"]
        bsdf.inputs["Base Color"].default_value = baking.color("183342")
        bsdf.inputs["Roughness"].default_value = 0.30
        bsdf.inputs["Metallic"].default_value = 0.61
        return mat

    mat = baking.finish(key)
    if key == BRUSH and mat.node_tree.nodes.get("Pearl titanium tint") is None:
        tree = mat.node_tree
        base = tree.nodes["Principled BSDF"].inputs["Base Color"]
        original = base.links[0].from_socket
        tint = tree.nodes.new("ShaderNodeMixRGB")
        tint.name, tint.blend_type = "Pearl titanium tint", "MULTIPLY"
        tint.inputs[0].default_value = 1
        tint.inputs[2].default_value = (0.49, 0.39, 0.54, 1)
        tree.links.new(original, tint.inputs[1])
        tree.links.new(tint.outputs[0], base)
        for node in tree.nodes:
            if node.type == "NORMAL_MAP":
                node.inputs["Strength"].default_value = 0.42
    return mat


def shell(high: bool) -> bpy.types.Object:
    bpy.context.scene.name = "Rift Portal"
    angles = angles_for(240 if high else 88)
    rows, cols = len(PROFILE), len(angles)
    verts, quads, finishes, coords = [], [], [], []
    total = sum(
        math.dist(p[:2], q[:2]) for p, q in zip(PROFILE, PROFILE[1:] + PROFILE[:1])
    )
    distance = 0
    for j in range(rows):
        for a in angles:
            r, z, _ = section(a, j)
            verts.append(((0.475 + r) * math.cos(a), -z, (0.675 + r) * math.sin(a)))
        next_j = (j + 1) % rows
        length = math.dist(PROFILE[j][:2], PROFILE[next_j][:2])
        for i, a0 in enumerate(angles):
            next_i = (i + 1) % cols
            a1 = angles[next_i] if next_i else math.tau
            quads.append(
                (
                    j * cols + i,
                    j * cols + next_i,
                    next_j * cols + next_i,
                    next_j * cols + i,
                )
            )
            role = section((a0 + a1) / 2, j)[2]
            if 6 <= j < 10 and any(
                abs(math.degrees((a0 + a1) / 2) - s) < 0.36 for s in SEAMS
            ):
                role = DARK
            finishes.append(role)
            quadrant = min(3, int(((a0 + a1) / 2) / (math.pi / 2)))
            coords.append(
                [
                    (float(a / (math.pi / 2) - quadrant), d / total, quadrant)
                    for a, d in (
                        (a0, distance),
                        (a1, distance),
                        (a1, distance + length),
                        (a0, distance + length),
                    )
                ]
            )
        distance += length
    mesh = bpy.data.meshes.new("Rift machined section")
    mesh.from_pydata(verts, [], quads)
    mesh.update()
    obj = bpy.data.objects.new("portalFrame", mesh)
    bpy.context.collection.objects.link(obj)
    obj.vertex_groups.new(name="000 continuous bezel").add(
        list(range(len(verts))), 1, "REPLACE"
    )
    ordered = sorted(set(finishes))
    for key in ordered:
        mesh.materials.append(finish(key))
    machining = mesh.uv_layers.new(name="Finish")
    atlas = mesh.uv_layers.new(name="UV0")
    for face, role, uv in zip(mesh.polygons, finishes, coords, strict=True):
        face.material_index = ordered.index(role)
        tile = baking.SURFACES[role].tile_m if role in baking.SURFACES else 0.12
        for idx, (u, v, q) in zip(face.loop_indices, uv, strict=True):
            machining.data[idx].uv = ((q + u) * 0.94 / tile, v * total / tile)
            atlas.data[idx].uv = (0.012 + 0.976 * u, (q + 0.05 + 0.90 * v) / 4)
    mesh.uv_layers.active = atlas
    atlas.active_render = True
    baking.active(obj)
    mod = obj.modifiers.new("Fixed bake diagonals", "TRIANGULATE")
    mod.quad_method = "FIXED"
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def vortex(out: Path) -> None:
    """A static hand-authored spiral field for the separate shader receiver."""
    t = (np.arange(SIZE) + 0.5) * 2 / SIZE - 1
    x, y = np.meshgrid(t, t)
    r = np.hypot(x, y)
    a = np.arctan2(y, x)
    # Advect seeded noise in polar coordinates to form wisps rather than repeating arms.
    rng = np.random.default_rng(1147)

    def noise(u: np.ndarray, v: np.ndarray, scale: int) -> np.ndarray:
        lattice = rng.random((64, 64))
        U, V = u * scale, v * scale
        i, j = np.floor(U).astype(int), np.floor(V).astype(int)
        f, g = U - i, V - j
        f, g = f * f * (3 - 2 * f), g * g * (3 - 2 * g)
        return (1 - g) * (
            (1 - f) * lattice[j % 64, i % 64] + f * lattice[j % 64, (i + 1) % 64]
        ) + g * (
            (1 - f) * lattice[(j + 1) % 64, i % 64]
            + f * lattice[(j + 1) % 64, (i + 1) % 64]
        )

    bend = a + 5.2 * r + 0.38 * np.sin(2 * a + 3 * r) + 0.23 * np.sin(3 * a - 6 * r)
    warp = 0.27 * (noise(x, y, 3) - 0.5) + 0.09 * (noise(x, y, 8) - 0.5)
    bend += warp
    u, v = r * np.cos(bend), r * np.sin(bend)
    cloud = (
        0.54 * noise(u, v, 4)
        + 0.27 * noise(u, v, 8)
        + 0.13 * noise(u, v, 17)
        + 0.06 * noise(u, v, 33)
    )
    veils = (
        0.54
        + 0.32 * np.sin(3 * bend + 0.8 * np.sin(2 * bend - 2 * r))
        + 0.11 * np.sin(7 * bend + 2 * r)
    )
    wisps = np.clip(0.62 * veils + 1.45 * (cloud - 0.43), 0, 1) ** 1.25
    fade = np.clip((r - 0.025) / 0.33, 0, 1) * np.clip((1.05 - r) / 0.18, 0, 1)
    teal = np.clip((r - 0.42) * 2.0 + 0.40 * np.cos(2 * bend - 1) - 0.32, 0, 1)
    colors = np.array([104, 48, 185]) + teal[:, :, None] * (
        np.array([24, 153, 151]) - np.array([104, 48, 185])
    )
    rgb = np.array([10, 6, 23]) + colors * (fade * (0.11 + 0.96 * wisps))[:, :, None]
    png(out / "vortex.png", np.uint8(np.clip(rgb, 0, 255)), True)


def interior(out: Path, sides: int) -> bpy.types.Object:
    angles = angles_for(sides)
    sides = len(angles)
    verts = [(0, 0, 0)] + [
        (0.475 * math.cos(a), 0, 0.675 * math.sin(a)) for a in angles
    ]
    mesh = bpy.data.meshes.new("Portal shader aperture")
    mesh.from_pydata(verts, [], [(0, i + 1, (i + 1) % sides + 1) for i in range(sides)])
    mesh.update()
    obj = bpy.data.objects.new("portalInterior", mesh)
    bpy.context.collection.objects.link(obj)
    obj.location.y = 0.025
    uv = mesh.uv_layers.new(name="UV0")
    for loop in mesh.loops:
        x, _, z = verts[loop.vertex_index]
        uv.data[loop.index].uv = (0.5 + x / 0.95, 0.5 + z / 1.35)
    mat = bpy.data.materials.new("Rift aperture field")
    tree = mat.node_tree
    surface = tree.nodes["Principled BSDF"]
    surface.inputs["Base Color"].default_value = (0.002, 0.001, 0.005, 1)
    surface.inputs["Roughness"].default_value = 1
    surface.inputs["Emission Strength"].default_value = 1
    image = bpy.data.images.load(str(out / "vortex.png"))
    image.name = "Rift vortex"
    im = tree.nodes.new("ShaderNodeTexImage")
    im.image = image
    tree.links.new(im.outputs["Color"], surface.inputs["Emission Color"])
    mesh.materials.append(mat)
    return obj


def assemble(frame: bpy.types.Object, field: bpy.types.Object) -> None:
    root = bpy.data.objects.new("riftPortal", None)
    bpy.context.collection.objects.link(root)
    frame.parent = field.parent = root
    anchor = bpy.data.objects.new("apertureAnchor", None)
    anchor["socket"] = True
    bpy.context.collection.objects.link(anchor)
    anchor.parent = root


def save(path: Path) -> None:
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.file.pack_all()
    for im in bpy.data.images:
        if im.packed_file:
            filename = Path(im.filepath).name
            if im.name.startswith("Rift "):
                im.filepath = "//" + filename
            elif "." in im.name:
                im.filepath = "//../../materials/" + im.name.replace(".", "/") + ".png"
            for packed in im.packed_files:
                packed.filepath = im.filepath
    bpy.ops.wm.save_as_mainfile(filepath=str(path), compress=True, relative_remap=False)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    baking.SIZE = SIZE
    baking.setup()
    vortex(out)
    high = shell(True)
    high_counts = baking.mesh_counts(high)
    assemble(high, interior(out, 240))
    save(out / "high.blend")
    baking.setup()
    high, low = shell(True), shell(False)
    high.name, low.name = "Matched high source", "portalFrame"
    geom = {
        "high_frame": high_counts,
        "low_frame": baking.mesh_counts(low),
        "receiver_sha256": baking.topology(low),
        "low_aperture_triangles": len(angles_for(88)),
        "high_aperture_triangles": len(angles_for(240)),
    }
    assert geom["low_frame"]["triangles"] + geom["low_aperture_triangles"] <= 4500
    metrics = baking.bake(out, high, low)
    assert baking.topology(low) == geom["receiver_sha256"]
    bpy.data.objects.remove(high, do_unlink=True)
    low.data.uv_layers.remove(low.data.uv_layers["Finish"])
    low.data.materials.clear()
    mat = baking.atlas_material(out)
    mat.name = "Rift segmented bezel"
    for im in bpy.data.images:
        if im.name.startswith("Core Bastion "):
            im.name = im.name.replace("Core Bastion ", "Rift ")
    low.data.materials.append(mat)
    assemble(low, interior(out, 88))
    bpy.ops.outliner.orphans_purge(do_recursive=True)
    save(out / "low.blend")
    bpy.ops.export_scene.gltf(
        filepath=str(out / "source.gltf"),
        export_format="GLTF_SEPARATE",
        export_yup=True,
        export_tangents=True,
        export_extras=True,
        export_animations=False,
    )
    metrics["vortex"] = {"sha256": baking.sha(out / "vortex.png"), "samples": []}
    (out / "geometry.json").write_text(
        json.dumps({**geom, "bake": metrics}, indent=2) + "\n"
    )


if __name__ == "__main__":
    main()
