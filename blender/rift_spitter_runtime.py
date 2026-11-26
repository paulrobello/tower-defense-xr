"""Derive two skinned Rift Spitter LODs from its approved sculpt and Skitter actions."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from collections import defaultdict
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_materials import png
from core_bastion import MAPS, active, atlas_material
from skitter_rig import triangulate_leg
from skitter_shape import key

SCULPT = "210a25294783f6ae9ac368ce6b3bf77a393a5d5b4910267c72edb159dad61316"
SKITTER = "288dcbcdb4d4ab75e2dbf581652c8c422a71199c5c8e53adc038c23b26388574"
LEGS = (
    (-0.69, -0.99, -1.34, 1.13, 1.38),
    (0.005, 0.09, 0.19, 1.35, 1.51),
    (0.66, 1.03, 1.32, 1.22, 1.39),
)
SIZE = 1024
CLIPS = {"attack", "climb_wall", "crawl_floor", "death", "hit"}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def materials(out: Path, source: list[bpy.types.Material]) -> dict:
    """Bake the approved procedural finishes onto reusable UV swatches."""
    verts, faces = [], []
    for i in range(len(source)):
        x, y = i % 4, i // 4
        faces.append(tuple(range(len(verts), len(verts) + 4)))
        verts.extend(
            (a * 0.06, b * 0.06, 0)
            for a, b in ((x, y), (x + 1, y), (x + 1, y + 1), (x, y + 1))
        )
    mesh = bpy.data.meshes.new("Finish swatches")
    mesh.from_pydata(verts, [], faces)
    obj = bpy.data.objects.new(mesh.name, mesh)
    bpy.context.collection.objects.link(obj)
    active(obj)
    uv = mesh.uv_layers.new(name="UV0")
    for i, face in enumerate(mesh.polygons):
        mesh.materials.append(source[i].copy())
        face.material_index = i
        for idx in face.loop_indices:
            co = mesh.vertices[mesh.loops[idx].vertex_index].co
            uv.data[idx].uv = (co.x / 0.24, co.y / 0.12)
    trees = []
    for i, mat in enumerate(mesh.materials):
        tree = mat.node_tree
        coord = tree.nodes.new("ShaderNodeTexCoord")
        scaled = tree.nodes.new("ShaderNodeVectorMath")
        scaled.operation = "MULTIPLY_ADD"
        tree.links.new(coord.outputs["UV"], scaled.inputs[0])
        scaled.inputs[1].default_value = (4, 2, 1)
        scaled.inputs[2].default_value = (-(i % 4), -(i // 4), 0.47)
        for node in list(tree.nodes):
            if node.type == "TEX_NOISE" and not node.inputs["Vector"].is_linked:
                tree.links.new(scaled.outputs[0], node.inputs["Vector"])
            if node.type == "TEX_COORD" and node != coord:
                for link in list(node.outputs["Generated"].links):
                    tree.links.new(scaled.outputs[0], link.to_socket)
        shader = tree.nodes["Principled BSDF"]
        emit = tree.nodes.new("ShaderNodeEmission")
        dest = tree.nodes.new("ShaderNodeTexImage")
        trees.append((tree, shader, emit, dest))
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 1
    result = {}
    for role in MAPS:
        image = bpy.data.images.new(role, SIZE, SIZE, float_buffer=True, is_data=True)
        for tree, shader, emit, dest in trees:
            dest.image = image
            tree.nodes.active = dest
            output = tree.nodes["Material Output"].inputs["Surface"]
            tree.links.new((shader if role == "normal" else emit).outputs[0], output)
            inp = emit.inputs["Color"]
            for link in list(inp.links):
                tree.links.remove(link)
            if role == "basecolor":
                tree.links.new(shader.inputs["Base Color"].links[0].from_socket, inp)
            elif role == "emissive":
                rgb = shader.inputs["Emission Color"].default_value[:3]
                intensity = shader.inputs["Emission Strength"].default_value
                inp.default_value = (*(x * intensity for x in rgb), 1)
            elif role == "orm":
                channels = tree.nodes.new("ShaderNodeCombineColor")
                channels.inputs[0].default_value = 1
                rough = shader.inputs["Roughness"]
                if rough.is_linked:
                    tree.links.new(rough.links[0].from_socket, channels.inputs[1])
                else:
                    channels.inputs[1].default_value = rough.default_value
                channels.inputs[2].default_value = shader.inputs[
                    "Metallic"
                ].default_value
                tree.links.new(channels.outputs[0], inp)
        bpy.ops.object.bake(
            type="NORMAL" if role == "normal" else "EMIT",
            margin=0,
            use_selected_to_active=False,
        )
        pixel = np.empty((SIZE, SIZE, 4), np.float32)
        image.pixels.foreach_get(pixel.ravel())
        rgb = pixel[:, :, :3]
        if role == "normal":
            rgb = rgb.copy()
            xy = rgb[:, :, :2] * 2 - 1
            xy *= np.minimum(1, 0.33 / np.maximum(0.0001, np.linalg.norm(xy, axis=2)))[
                :, :, None
            ]
            rgb[:, :, :2] = 0.5 + 0.5 * xy
            rgb[:, :, 2] = 0.5 + 0.5 * np.sqrt(1 - np.sum(xy * xy, axis=2))
        color = role in ("basecolor", "emissive")
        if color:
            rgb = np.where(
                rgb <= 0.0031308,
                rgb * 12.92,
                1.055 * np.maximum(0, rgb) ** (1 / 2.4) - 0.055,
            )
        pixels = np.uint8(np.rint(np.clip(rgb, 0, 1) * 255))
        png(out / f"{role}.png", pixels, color)
        samples = []
        for i, finish in enumerate(source):
            x, y = (i % 4) * (SIZE // 4) + SIZE // 8, (i // 4) * (SIZE // 2) + SIZE // 4
            samples.append(
                {
                    "surface": finish.name,
                    "x": x,
                    "y": SIZE - 1 - y,
                    "rgb": pixels[y, x].tolist(),
                    "tolerance": 16,
                }
            )
        result[role] = {"sha256": sha(out / f"{role}.png"), "samples": samples}
        print("BAKED", role, flush=True)
    bpy.data.objects.remove(obj, do_unlink=True)
    return result


def part_budget(name: str, lod: int) -> int:
    # Allocate geometry to the silhouette, open throat and articulated joints.
    if "lamination" in name:
        return (9 if name.endswith(("0", "2")) else 0) if lod == 0 else 0
    if name.startswith("Oropharynx"):
        return (80, 55)[lod] if name.endswith(("1", "4", "7")) else 0
    for prefix, near, far in (
        ("Abdomen", 105, 55),
        ("Mantle", 74, 48),
        ("Vertebral", 46, 26),
        ("Pharynx", 72, 34),
        ("Deep chamber", 38, 22),
        ("Corona", 118, 88),
        ("Throat", 54, 32),
        ("Incurved", 18, 10),
        ("Split barrel", 104, 62),
        ("Lower fork", 44, 24),
        ("Lateral optic", 32, 18),
        ("Optic •", 38, 24),
        ("Supraorbital", 88, 54),
        ("Phosphor alveolus", 57, 38),
        ("Alveolus housing", 40, 20),
        ("Caudal", 30, 18),
        ("Pleural", 38, 22),
        ("Thoracic", 40, 22),
        ("Mandibular", 42, 24),
        ("Barrel flange", 16, 0),
    ):
        if name.startswith(prefix):
            return (near, far)[lod]
    for part, near, far in (
        ("coxa", 26, 16),
        ("femoral", 52, 35),
        ("condyle", 26, 16),
        ("patella", 28, 16),
        ("patellar pore", 16, 10),
        ("keeled", 54, 36),
        ("tarsal joint", 16, 10),
        ("paired tarsal", 22, 14),
        ("patellar horn", 30, 20),
        ("upper limb leaf", 26, 16),
        ("imbricate tibial scale 1", 18, 0),
    ):
        if re.match(rf"[LR][123] \| {part}", name):
            return (near, far)[lod]
    return 0


def bone_name(ob: bpy.types.Object) -> str:
    name = ob.name
    leg = re.match(r"([LR])([123]) \| (.+)", name)
    if leg:
        side, number, part = leg.groups()
        chain = (
            "femur"
            if part.startswith(("coxa", "femoral", "upper limb"))
            else ("claw" if part.startswith(("tarsal", "paired tarsal")) else "tibia")
        )
        return key(chain, int(number) - 1, 1 if side == "R" else -1)
    if name.startswith("Lower fork"):
        return (
            "mandible.L"
            if name.endswith("1") and not name.endswith("-1")
            else "mandible.R"
        )
    if ob.users_collection[0].name.startswith("02"):
        return "head"
    return "thorax"


def detail_parent(ob: bpy.types.Object) -> str | None:
    if " | cuticular lamination " in ob.name:
        return ob.name.split(" | cuticular lamination ")[0]
    if ob.name.startswith("Alveolar reticulum ") and "capillary" not in ob.name:
        side, gland = ob.name.split()[2:4]
        return f"Phosphor alveolus {side} {gland}"
    return None


def surface_strip(ob: bpy.types.Object, surface: BVHTree, segments: int) -> tuple:
    """Reproject raised cuticle ridges and gland vessels onto the decimated host."""
    bezier = ob.data.splines[0].bezier_points
    control = np.array([list(ob.matrix_world @ p.co) for p in bezier])
    lengths = np.r_[0.0, np.linalg.norm(np.diff(control, axis=0), axis=1).cumsum()]
    # Crossing vessel branches sit at different depths in the gland membrane.
    relief = (
        0.00053
        if ob.name.startswith("Alveolar reticulum ") and ob.name.endswith(" -1")
        else 0.00028
    )
    points, surface_normals, radii = [], [], []
    for distance in np.linspace(0.0, lengths[-1], segments + 1):
        k = min(len(lengths) - 2, max(0, np.searchsorted(lengths, distance) - 1))
        t = (distance - lengths[k]) / (lengths[k + 1] - lengths[k])
        point, normal, _, _ = surface.find_nearest(
            Vector(control[k] * (1 - t) + control[k + 1] * t)
        )
        points.append(point + normal * relief)
        surface_normals.append(normal)
        radii.append(
            ob.data.bevel_depth
            * ((1 - t) * bezier[k].radius + t * bezier[k + 1].radius)
            * ob.matrix_world.to_scale().length
            / 3**0.5
        )
    vertices, normals, faces = [], [], []
    for i, (point, normal, radius) in enumerate(
        zip(points, surface_normals, radii, strict=True)
    ):
        tangent = points[min(i + 1, segments)] - points[max(0, i - 1)]
        width = normal.cross(tangent).normalized() * max(0.000045, radius)
        vertices.extend((list(point - width), list(point + width)))
        normals.extend((list(normal), list(normal)))
        if i:
            a = 2 * i - 2
            faces.extend(((a, a + 2, a + 3), (a, a + 3, a + 1)))
    return vertices, normals, faces


def receiver(parts: list, source: list, mat: bpy.types.Material, lod: int) -> tuple:
    dg = bpy.context.evaluated_depsgraph_get()
    decorations = [
        (o, parent, 4 if "lamination" in o.name else 5)
        for o in parts
        if (parent := detail_parent(o)) and lod == 0
    ]
    surfaces = {}
    target = (4440, 2170)[lod] - sum(2 * n for _, _, n in decorations)
    rated = [
        (o, w)
        for o in parts
        if not detail_parent(o) and (w := part_budget(o.name, lod))
    ]
    ratio = target / sum(w for _, w in rated)
    coords, faces, uvs, normals = [], [], [], []
    toe_parts = {}
    weights = defaultdict(list)
    receivers = []
    for ob, budget in rated:
        evaluated = ob.evaluated_get(dg)
        geo = bpy.data.meshes.new_from_object(evaluated, depsgraph=dg)
        geo.calc_loop_triangles()
        temp = bpy.data.objects.new("decimation", geo)
        bpy.context.collection.objects.link(temp)
        dec = temp.modifiers.new("Silhouette", "DECIMATE")
        dec.ratio = min(1, max(6, round(budget * ratio)) / len(geo.loop_triangles))
        dec.use_collapse_triangulate = True
        receivers.append((ob, temp, geo))
    dg.update()
    for ob, temp, geo in receivers:
        owner = temp.evaluated_get(dg)
        low = owner.to_mesh()
        low.calc_loop_triangles()
        positions = np.array([list(ob.matrix_world @ v.co) for v in low.vertices])
        uvco = (positions - positions.min(axis=0)) / np.maximum(
            np.ptp(positions, axis=0), 1e-7
        )
        high_coords = [v.co.copy() for v in geo.vertices]
        high_normals = [v.normal.copy() for v in geo.vertices]
        high_triangles = [tuple(t.vertices) for t in geo.loop_triangles]
        tree = BVHTree.FromPolygons(high_coords, high_triangles, all_triangles=True)
        normal_matrix = ob.matrix_world.to_3x3().inverted().transposed()
        for vertex in low.vertices:
            near, _, idx, _ = tree.find_nearest(vertex.co)
            ids = high_triangles[idx]
            sampled = barycentric_transform(
                near, *(high_coords[i] for i in ids), *(high_normals[i] for i in ids)
            )
            normals.append(list((normal_matrix @ sampled).normalized()))
        offset = len(coords)
        bone = bone_name(ob)
        weights[bone].extend(range(offset, offset + len(positions)))
        if "paired tarsal claw" in ob.name:
            toe_parts[(bone, ob.name.endswith(" 1"))] = list(
                range(offset, offset + len(positions))
            )
        coords.extend(positions.tolist())
        for tri in low.loop_triangles:
            ids = list(tri.vertices)
            normal = np.cross(
                positions[ids[1]] - positions[ids[0]],
                positions[ids[2]] - positions[ids[0]],
            )
            if np.linalg.norm(normal) < 1e-12:
                continue
            faces.append([offset + i for i in ids])
            slot = source.index(ob.data.materials[tri.material_index])
            axes = [axis for axis in range(3) if axis != int(np.argmax(np.abs(normal)))]
            uvs.append(
                [
                    (
                        (slot % 4 + 0.032 + 0.936 * uvco[i, axes[0]]) / 4,
                        (slot // 4 + 0.032 + 0.936 * uvco[i, axes[1]]) / 2,
                    )
                    for i in ids
                ]
            )
        if ob.name.startswith(("Mantle ", "Split barrel", "Phosphor alveolus")):
            surfaces[ob.name] = BVHTree.FromPolygons(
                positions.tolist(),
                [tuple(t.vertices) for t in low.loop_triangles],
                all_triangles=True,
            )
        owner.to_mesh_clear()
        bpy.data.objects.remove(temp, do_unlink=True)
        bpy.data.meshes.remove(geo)
    for ob, parent, segments in decorations:
        vertices, nrm, triangles = surface_strip(ob, surfaces[parent], segments)
        base = len(coords)
        coords.extend(vertices)
        normals.extend(nrm)
        weights[bone_name(ob)].extend(range(base, len(coords)))
        slot = source.index(ob.data.materials[0])
        for ids in triangles:
            faces.append([base + idx for idx in ids])
            uvs.append(
                [
                    (
                        (slot % 4 + 0.12 + 0.76 * (idx // 2) / segments) / 4,
                        (slot // 4 + 0.40 + 0.20 * (idx % 2)) / 2,
                    )
                    for idx in ids
                ]
            )
    pts = np.array(coords)
    extent = np.ptp(pts, axis=0)
    center = (pts.max(axis=0) + pts.min(axis=0)) / 2
    center[2] = pts[:, 2].min()
    scale = np.array([0.30, 0.40, 0.24]) / extent
    pts = (pts - center) * scale
    contacts = {}
    for (bone, front), indices in toe_parts.items():
        idx = indices[np.argmin(pts[indices, 2])]
        pts[indices, 2] -= pts[idx, 2]
        if front:
            contacts[bone] = Vector(pts[idx])
    mesh = bpy.data.meshes.new(f"Spitter LOD{lod}")
    mesh.from_pydata(pts.tolist(), [], faces)
    mesh.update()
    obj = bpy.data.objects.new(mesh.name, mesh)
    bpy.context.collection.objects.link(obj)
    mesh.materials.append(mat)
    uv = mesh.uv_layers.new(name="UV0")
    for p, tri_uv in zip(mesh.polygons, uvs, strict=True):
        p.use_smooth = True
        for loop, xy in zip(p.loop_indices, tri_uv, strict=True):
            uv.data[loop].uv = xy
    adjusted_normals = np.array(normals) / scale
    adjusted_normals /= np.maximum(
        1.0e-9, np.linalg.norm(adjusted_normals, axis=1)[:, None]
    )
    mesh.normals_split_custom_set_from_vertices(adjusted_normals.tolist())
    for group, vertices in weights.items():
        obj.vertex_groups.new(name=group).add(vertices, 1, "REPLACE")
    print(
        "GEOMETRY",
        lod,
        len(faces),
        len(pts),
        "SOURCE EXTENT",
        extent.tolist(),
        flush=True,
    )
    assert len(faces) <= (4500, 2200)[lod]
    return obj, center, scale, contacts


def fit_actions(rig: bpy.types.Object, donor: bpy.types.Object) -> None:
    """Keep donor body channels and solve its measured contact tracks on the new legs."""
    rest = {p.name: p.bone.matrix_local.copy() for p in rig.pose.bones}
    donor_ad = donor.animation_data
    ad = rig.animation_data
    originals = []
    for track in ad.nla_tracks:
        source = track.strips[0].action
        name = source.name
        originals.append(source)
        source.name = "Donor " + name
        action = source.copy()
        action.name = name
        track.strips[0].action = action
        donor_ad.action = source
        donor_ad.action_slot = source.slots[0]
        ad.action = action
        ad.action_slot = action.slots[0]
        prev = {}
        for frame in range(
            round(source.frame_range[0]), round(source.frame_range[1]) + 1
        ):
            bpy.context.scene.frame_set(frame)
            chest = rig.pose.bones["thorax"].matrix.copy()
            delta = chest @ rest["thorax"].inverted()
            for side in (-1, 1):
                for j in range(3):
                    fem, tib, claw = [
                        key(part, j, side) for part in ("femur", "tibia", "claw")
                    ]
                    hip, knee, ankle = [rest[n].translation for n in (fem, tib, claw)]
                    toe = rig.data.bones[claw].tail_local
                    original_foot = donor.pose.bones[claw]
                    travel = original_foot.tail - original_foot.bone.tail_local
                    turn = (
                        original_foot.matrix.to_quaternion()
                        @ original_foot.bone.matrix_local.to_quaternion().inverted()
                    )
                    new_toe = toe + travel
                    new_ankle = new_toe - turn @ (toe - ankle)
                    new_hip = delta @ hip
                    new_knee = triangulate_leg(new_hip, knee, ankle, new_ankle, hip)
                    parent_pose = chest
                    for n, parent, start, end, axis in (
                        (fem, "thorax", new_hip, new_knee, knee - hip),
                        (tib, fem, new_knee, new_ankle, ankle - knee),
                        (claw, tib, new_ankle, new_toe, toe - ankle),
                    ):
                        world_rot = (
                            turn if n == claw else axis.rotation_difference(end - start)
                        )
                        pose = (
                            Matrix.Translation(start)
                            @ world_rot.to_matrix().to_4x4()
                            @ rest[n].to_quaternion().to_matrix().to_4x4()
                        )
                        local = (
                            rest[n].inverted()
                            @ rest[parent]
                            @ parent_pose.inverted()
                            @ pose
                        )
                        rotation = local.to_quaternion()
                        if n in prev:
                            rotation.make_compatible(prev[n])
                        prev[n] = rotation.copy()
                        pb = rig.pose.bones[n]
                        pb.rotation_quaternion = rotation
                        pb.keyframe_insert(
                            data_path="rotation_quaternion", frame=frame, group=n
                        )
                        parent_pose = pose
        ad.action = None
    bpy.data.objects.remove(donor, do_unlink=True)
    for act in originals:
        bpy.data.actions.remove(act)
    for pb in rig.pose.bones:
        pb.matrix_basis = Matrix.Identity(4)
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()


def rigging(
    skitter: Path, mount: Matrix, origin: np.ndarray, scale: np.ndarray, contacts: dict
) -> bpy.types.Object:
    with bpy.data.libraries.load(str(skitter), link=False) as (src, dest):
        assert "Skitter" in src.objects
        dest.objects = ["Skitter"]
    rig = dest.objects[0]
    bpy.context.collection.objects.link(rig)
    donor = rig.copy()
    donor.data = rig.data.copy()
    bpy.context.collection.objects.link(donor)
    donor.name = "Donor"
    rig.name = "Rift Spitter"
    active(rig)
    bpy.ops.object.mode_set(mode="EDIT")
    bones = rig.data.edit_bones

    def at(point: tuple) -> Vector:
        return Vector((np.array(mount @ Vector(point)) - origin) * scale)

    for b in bones:
        b.use_connect = False
    for side in (-1, 1):
        for j, (hy, ky, fy, kx, fx) in enumerate(LEGS):
            points = [
                at((side * x, y, z))
                for x, y, z in (
                    (0.49, hy, 1.075),
                    (kx, ky, 1.12 + 0.08 * (j == 1)),
                    (fx, fy, 0.18),
                    (fx + 0.086, fy - 0.241, 0.002),
                )
            ]
            points[3] = contacts[key("claw", j, side)]
            for idx, label in enumerate(("femur", "tibia", "claw")):
                b = bones[key(label, j, side)]
                b.head, b.tail = points[idx : idx + 2]
                if idx:
                    b.use_connect = True
        jaw = bones[f"mandible.{'L' if side > 0 else 'R'}"]
        jaw.head, jaw.tail = (
            at((side * 0.27, -0.90, 1.14)),
            at((side * 0.18, -1.99, 1.47)),
        )
    bones["thorax"].head, bones["thorax"].tail = (
        at((0, 0.10, 1.2)),
        at((0, -0.55, 1.38)),
    )
    bones["head"].head, bones["head"].tail = at((0, -0.55, 1.38)), at((0, -1.6, 1.57))
    bpy.ops.object.mode_set(mode="OBJECT")
    assert {t.name for t in rig.animation_data.nla_tracks} == CLIPS
    fit_actions(rig, donor)
    return rig


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for key_ in ("sculpt", "skitter", "out"):
        parser.add_argument("--" + key_, type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    assert sha(args.sculpt) == SCULPT and sha(args.skitter) == SKITTER
    shutil.copyfile(args.sculpt, out / "high.blend")
    bpy.ops.wm.open_mainfile(filepath=str(args.sculpt.resolve()))
    root = bpy.data.collections["Rift Spitter | editable anatomy"]
    parts = sorted(
        [o for o in root.all_objects if o.type in {"CURVE", "MESH"}],
        key=lambda o: o.name,
    )
    mount = next(o for o in root.all_objects if o.type == "EMPTY").matrix_world.copy()
    finishes = sorted(
        {m for o in parts for m in o.data.materials}, key=lambda m: m.name
    )
    assert len(finishes) == 8
    bake_metrics = materials(out, finishes)
    mat = atlas_material(out)
    mat.name = "Spitter chitin and phosphor"
    for n in mat.node_tree.nodes:
        if n.type == "TEX_IMAGE":
            n.image.name = n.label
    scene = bpy.context.scene
    scene.render.fps = 30
    rig = None
    metrics = {
        "bake": bake_metrics,
        "blender": bpy.app.version_string,
        "sculpt_sha256": SCULPT,
        "rig_and_actions_sha256": SKITTER,
    }
    for lod in range(2):
        obj, center, scale, contacts = receiver(parts, finishes, mat, lod)
        if rig is None:
            rig = rigging(args.skitter.resolve(), mount, center, scale, contacts)
        obj.parent = rig
        obj.modifiers.new("Articulated chitin", "ARMATURE").object = rig
        active(rig)
        obj.select_set(True)
        if lod == 0:
            near = obj
        folder = out / f"lod{lod}"
        folder.mkdir(exist_ok=True)
        stem = f"rift-spitter-lod{lod}.glb"
        for path, fmt in (
            (folder / "source.gltf", "GLTF_SEPARATE"),
            (out / stem, "GLB"),
        ):
            bpy.ops.export_scene.gltf(
                filepath=str(path),
                export_format=fmt,
                use_selection=True,
                use_active_scene=True,
                export_skins=True,
                export_yup=True,
                export_texcoords=True,
                export_tangents=True,
                export_animation_mode="ACTIONS",
                export_rest_position_armature=True,
                export_force_sampling=True,
                export_optimize_animation_size=False,
            )
        doc = json.loads((folder / "source.gltf").read_text())
        assert {a["name"] for a in doc["animations"]} == CLIPS
        assert len(doc["skins"]) == 1 and len(doc["skins"][0]["joints"]) == 23
        metrics[f"lod{lod}"] = {
            "triangles": len(obj.data.polygons),
            "sha256": sha(out / stem),
        }
        if lod == 1:
            obj.hide_render = True
    (out / "geometry.json").write_text(json.dumps(metrics, indent=2) + "\n")
    for o in parts:
        o.hide_render = True
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 12
    scene.render.resolution_percentage = 60
    scene.render.filepath = str(out / "runtime-angle.png")
    bpy.ops.render.render(write_still=True)
    for ob in list(scene.objects):
        if ob not in (near, rig):
            bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.orphans_purge(do_recursive=True)
    scene.name = "Rift Spitter runtime"
    bpy.ops.file.pack_all()
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(out / "low.blend"), compress=True)


if __name__ == "__main__":
    main()
