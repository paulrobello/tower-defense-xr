"""Exercise exported M44 controls, illumination, UVs and both delivered mount interfaces."""

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path[:0] = [
    str(HERE),
    str(HERE.parent / "scripts"),
    str(HERE.parent / "scripts/assets"),
]
from core_bastion import object_from_parts
from m44_shape import build
from package_core_bastion import digest, write_json
from package_m44 import runtime_contract
from review_core_bastion import checked_ktx, decode_ktx2, import_glb
from validate_glbs import check_overlap
from verify_core_bastion import atlas_metrics, points
from verify_surface_clamp import verify_albedo

EPS = 0.000003


def close(actual: tuple | Vector, expected: tuple | Vector) -> None:
    assert (Vector(actual) - Vector(expected)).length < EPS, (
        list(actual),
        list(expected),
    )


def verify_mount(path: Path, head: bpy.types.Object) -> dict:
    bpy.ops.import_scene.gltf(filepath=str(path))
    socket = bpy.data.objects["mountSocket"]
    mount = socket.parent
    assert socket.get("socket") is True and socket.matrix_world == Matrix.Identity(4)
    head.parent = socket
    mount.rotation_mode = "XYZ"
    mount.rotation_euler = (0.62, -0.23, 0.71)
    mount.location = (0.35, -0.4, 0.77)
    bpy.context.view_layer.update()
    neutral = head.matrix_world.copy()
    assert all(
        abs(neutral[r][c] - mount.matrix_world[r][c]) < EPS
        for r in range(4)
        for c in range(4)
    )
    head.parent = None
    for item in reversed([mount, *mount.children_recursive]):
        bpy.data.objects.remove(item, do_unlink=True)
    return {"mount_sha256": digest(path), "origin_alignment_on_rotated_anchor": True}


def finish_reference(tier: int, level: str) -> tuple[BVHTree, list[str]]:
    source = object_from_parts("M44 reference finishes", build(tier, level))
    tree = BVHTree.FromPolygons(
        [v.co for v in source.data.vertices],
        [tuple(p.vertices) for p in source.data.polygons],
        all_triangles=True,
    )
    labels = []
    for face in source.data.polygons:
        labels.append(source.data.materials[face.material_index].name)
    bpy.data.objects.remove(source, do_unlink=True)
    return tree, labels


def geometry(
    path: Path, tier: int, ktx: Path, decoded: dict, contract: dict
) -> tuple[dict, list]:
    import_glb(path)
    root, yaw, pitch, recoil, socket = [
        bpy.data.objects[key]
        for key in ("m44Head", "yawRing", "pitchCradle", "recoilGroup", "muzzleSocket")
    ]
    assert root.matrix_world == Matrix.Identity(4) and socket.get("socket") is True
    assert (
        yaw.parent == root
        and pitch.parent == yaw
        and recoil.parent == pitch
        and socket.parent == recoil
    )
    h = contract["headHeightM"]
    base = contract["baseHeightM"]
    py = base + h / 2
    forward = Vector((0, -1, 0))
    neutral = Vector((contract["x"], -contract["z"], contract["y"]))
    close(yaw.location, (0, 0, base))
    close(pitch.location, (0, 0, h / 2))
    close(socket.matrix_world.translation, neutral)
    close(socket.matrix_world.to_3x3() @ forward, forward)
    meshes = [obj for obj in root.children_recursive if obj.type == "MESH"]
    assert all(
        len(obj.data.materials) == 1
        and obj.active_material.name == f"M44 T{tier} satin armor"
        for obj in meshes
    )
    shape = np.asarray(points(bpy.data.objects["turret-head"]))
    extent = shape.max(axis=0) - shape.min(axis=0)
    close(extent, (contract["headWidthM"], contract["headLengthM"], h))
    assert abs(shape[:, 2].max() - contract["totalHeightM"]) < EPS
    # Measure all distinct lip centers independently of the named socket.
    optic = bpy.data.objects["rotor-face" if tier == 3 else "forward-assembly"]
    tips = [p for p in points(optic) if abs(p.y - neutral.y) < EPS]
    expected = int(contract["barrelCount"])
    tip_centers = []
    for i in range(expected):
        radius = contract["barrelRadiusM"]
        dx = (
            (i - 0.5) * contract["headWidthM"] * 0.48
            if tier == 2
            else (0.68 * radius * math.cos(math.tau * i / 6) if tier == 3 else 0)
        )
        dz = 0.68 * radius * math.sin(math.tau * i / 6) if tier == 3 else 0
        radius *= 0.34 if tier == 3 else 1
        center = neutral + Vector((dx, 0, dz))
        ring = [p for p in tips if abs((p - center).length - 0.92 * radius) < EPS]
        assert ring
        box = np.asarray(ring)
        close((box.min(axis=0) + box.max(axis=0)) * 0.5, center)
        tip_centers.append([round(z, 6) for z in center])
    world = points(optic)
    span = max(p.y for p in world) - min(p.y for p in world)
    assert abs(span - contract["barrelLengthM"]) < EPS
    charts = []
    amber_samples = {}
    finish_tree, labels = finish_reference(tier, path.stem.split("-")[-1])
    areas = {}
    ranges = {
        "RB.brushed-titanium": (0.73, 1.0),
        "RB.dark-gunmetal": (0.69, 1.0),
        "Core carbon inserts": (0, 0.15),
        "RB.tactical-ceramic": (0, 0.15),
        "M44 amber": (0.16, 0.42),
    }
    for obj in meshes:
        uv = obj.data.uv_layers.active
        assert len(obj.data.uv_layers) == 1
        values = []
        for face in obj.data.polygons:
            tri = tuple((*uv.data[loop].uv, 0) for loop in face.loop_indices)
            assert all(0 <= q <= 1 for p in tri for q in p[:2])
            charts.append((tri, (0, 0, 1), f"{obj.name}.{face.index}"))
            center = np.mean(tri, axis=0)
            _, _, face_id, error = finish_tree.find_nearest(
                obj.matrix_world @ face.center
            )
            assert error < EPS, (obj.name, face.index, error)
            label = labels[face_id]
            metal = (
                float(
                    decoded["orm"][
                        1023 - int(1024 * center[1]), int(1024 * center[0]), 2
                    ]
                )
                / 255
            )
            totals = areas.setdefault(label, [0.0, 0.0])
            lo, hi = ranges[label]
            totals[0] += face.area * int(lo <= metal <= hi)
            totals[1] += face.area
            rgb = decoded["emissive"][
                1023 - int(1024 * center[1]), int(1024 * center[0]), :3
            ].astype(float)
            if (
                rgb[0] > 150
                and rgb[0] > 1.25 * rgb[1]
                and rgb[1] > 70
                and rgb[1] > 3 * rgb[2]
            ):
                values.append((face.area, rgb))
        amber_samples[obj.name] = {
            "triangles": len(values),
            "visible_area_m2": round(sum(a for a, _ in values), 8),
        }
    assert amber_samples["forward-assembly"]["triangles"] >= 6
    if tier == 3:
        assert (
            amber_samples["turret-head"]["triangles"] >= 2
            and amber_samples["rotor-face"]["triangles"] >= 6
        )
    finish_coverage = {
        label: round(hit / total, 6) for label, (hit, total) in areas.items()
    }
    assert (
        set(finish_coverage) == set(ranges) and min(finish_coverage.values()) > 0.90
    ), finish_coverage
    material = verify_albedo(charts, decoded["basecolor"])
    poses = []
    pitch.rotation_mode = yaw.rotation_mode = "XYZ"
    mesh_sample = optic.data.vertices[0].co.copy()
    rest = optic.matrix_world @ mesh_sample
    if tier == 3:
        rotor = bpy.data.objects["rotaryCluster"]
        assert rotor.parent == recoil and optic.parent == rotor
        rotor.rotation_mode = "XYZ"
        rotor_center = rotor.matrix_world.translation.copy()
    for turn, tilt, slide, spin in (
        (0.7, -0.42, 0.012, 0.53),
        (-1.13, 0.32, 0.008, 2.8),
    ):
        yaw.rotation_euler.z = turn
        pitch.rotation_euler.x = tilt
        recoil.location.y = slide
        yaw_matrix = Matrix.Rotation(turn, 3, "Z")
        pitch_matrix = Matrix.Rotation(tilt, 3, "X")

        def world_at(
            v: Vector,
            yaw_basis: Matrix = yaw_matrix,
            pitch_basis: Matrix = pitch_matrix,
            recoil_distance: float = slide,
        ) -> Vector:
            return Vector((0, 0, base)) + yaw_basis @ (
                Vector((0, 0, h / 2))
                + pitch_basis @ (v - Vector((0, 0, py)) + Vector((0, recoil_distance, 0)))
            )

        if tier == 3:
            rotor.rotation_euler.y = spin
            local_probe = rotor_center + Matrix.Rotation(spin, 3, "Y") @ (
                rest - rotor_center
            )
        else:
            local_probe = rest
        bpy.context.view_layer.update()
        close(socket.matrix_world.translation, world_at(neutral))
        close(
            socket.matrix_world.to_3x3() @ forward, yaw_matrix @ pitch_matrix @ forward
        )
        close(optic.matrix_world @ mesh_sample, world_at(local_probe))
        poses.append(
            {
                "yaw_rad": turn,
                "pitch_rad": tilt,
                "recoil_m": slide,
                "rotor_rad": spin if tier == 3 else None,
                "muzzle_blender_m": list(socket.matrix_world.translation),
            }
        )
    mounts = {
        m: verify_mount(
            HERE.parent
            / "assets-source/models"
            / m
            / f"{m}-{path.stem.split('-')[-1]}.glb",
            root,
        )
        for m in ("surface-clamp", "hover-pod")
    }
    return {
        "sha256": digest(path),
        "head_dimensions_blender_m": extent.tolist(),
        "bore_centers_blender_m": tip_centers,
        "emitter_span_m": span,
        "poses": poses,
        "mounts": mounts,
        "amber": amber_samples,
        "unlit_color": material,
        "decoded_metalness_correct_area_fraction": finish_coverage,
        "atlas": atlas_metrics(path, ktx),
    }, charts


def editable_geometry_hash() -> str:
    h = hashlib.sha256()
    for obj in sorted(bpy.context.scene.objects, key=lambda node: node.name):
        h.update(
            json.dumps(
                [obj.name, obj.parent.name if obj.parent else None, obj.type]
            ).encode()
        )
        h.update(np.array(obj.matrix_local, dtype="<f4").tobytes())
        if obj.type != "MESH":
            continue
        mesh = obj.data
        h.update(json.dumps([m.name for m in mesh.materials]).encode())
        h.update(np.array([v.co for v in mesh.vertices], dtype="<f4").tobytes())
        h.update(
            np.array(
                [tuple(face.vertices) for face in mesh.polygons], dtype="<u4"
            ).tobytes()
        )
        h.update(
            np.array(
                [face.material_index for face in mesh.polygons], dtype="<u4"
            ).tobytes()
        )
        h.update(
            np.array(
                [loop.uv for loop in mesh.uv_layers.active.data], dtype="<f4"
            ).tobytes()
        )
    return h.hexdigest()


def verify_sources(folder: Path) -> dict:
    geometry = json.loads((folder / "geometry.json").read_text())
    measured = {}
    for label, reference in (("high", "high"), ("low", "lod0")):
        path = folder / f"{label}.blend"
        bpy.ops.wm.open_mainfile(filepath=str(path))
        meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
        assert all(obj.type in ("MESH", "EMPTY") for obj in bpy.context.scene.objects)
        count = sum(len(obj.data.polygons) for obj in meshes)
        assert count == geometry[reference]["triangles"]
        assert all(
            len(obj.data.uv_layers) == 1
            and obj.data.uv_layers.active.name
            == ("Finish" if label == "high" else "UV0")
            for obj in meshes
        )
        packed = {
            hashlib.sha256(bytes(im.packed_file.data)).hexdigest()
            for im in bpy.data.images
            if im.packed_file
        }
        inputs = (
            list(folder.glob("*.png"))
            if label == "low"
            else [
                HERE.parent / "assets-source/materials" / finish / f"{role}.png"
                for finish in ("tactical-ceramic", "brushed-titanium", "dark-gunmetal")
                for role in ("basecolor", "normal", "orm")
            ]
        )
        assert packed == {digest(p) for p in inputs}
        measured[label] = {
            "sha256": digest(path),
            "triangles": count,
            "embedded_source_images": len(packed),
            "geometry_uv_hierarchy_material_slots_sha256": editable_geometry_hash(),
        }
    return measured


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--piece", required=True, type=Path)
    parser.add_argument("--ktx", required=True, type=Path)
    parser.add_argument("--repeat-stage", type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    folder = args.piece.resolve()
    ktx = checked_ktx(args.ktx)
    tier = int(folder.name[-1])
    contract = runtime_contract(tier)
    decoded = {
        r: np.frombuffer(
            decode_ktx2(ktx, (folder / f"{r}.ktx2").read_bytes()), np.uint8
        ).reshape(1024, 1024, 4)
        for r in ("basecolor", "emissive", "orm")
    }
    report = {"editable_sources": verify_sources(folder)}
    if args.repeat_stage:
        repeat = verify_sources(args.repeat_stage.resolve())
        for level, original in report["editable_sources"].items():
            assert (
                original["geometry_uv_hierarchy_material_slots_sha256"]
                == repeat[level]["geometry_uv_hierarchy_material_slots_sha256"]
            )
            original["repeat_archive_sha256"] = repeat[level]["sha256"]
    charts = []
    for level in ("lod0", "lod1"):
        report[level], uv = geometry(
            folder / f"{folder.name}-{level}.glb", tier, ktx, decoded, contract
        )
        charts.extend(uv)
    check_overlap(charts)
    report["combined_positive_area_uv_overlaps"] = 0
    write_json(folder / "reimport.json", report)


if __name__ == "__main__":
    main()
