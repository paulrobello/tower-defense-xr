"""Verify exact decoded finishes, support, revised profiles and editable source identity."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

import bpy
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent / "scripts")]
from core_bastion_revision import BELLY, CASSETTE, GRAPHITE, original, pipeline
from package_core_bastion import write_json
from review_core_bastion import decode_ktx2, import_glb
from validate_glbs import Glb
from verify_core_bastion import atlas_metrics, verify


def logical(path: Path) -> str:
    bpy.ops.wm.open_mainfile(filepath=str(path))
    h = hashlib.sha256()

    def add(value: object) -> None:
        h.update(json.dumps(value, separators=(",", ":"), sort_keys=True).encode())

    scene = bpy.context.scene
    add(
        [
            scene.name,
            scene.frame_start,
            scene.frame_end,
            scene.render.fps,
            scene.render.fps_base,
        ]
    )
    for obj in sorted(scene.objects, key=lambda o: o.name):
        add(
            [
                obj.name,
                obj.type,
                obj.parent.name if obj.parent else None,
                list(obj.location),
                list(obj.rotation_euler),
                list(obj.scale),
            ]
        )
        if obj.type != "MESH":
            continue
        mesh = obj.data
        add([m.name for m in mesh.materials])
        add([g.name for g in obj.vertex_groups])
        for v in mesh.vertices:
            add([list(v.co), [(g.group, g.weight) for g in v.groups]])
        for p in mesh.polygons:
            add([list(p.vertices), p.material_index])
        for uv in mesh.uv_layers:
            add([uv.name, [list(c.uv) for c in uv.data]])
        for n in mesh.corner_normals:
            add(list(n.vector))
        if obj.animation_data:
            action = obj.animation_data.action
            curves = (
                action.layers[0]
                .strips[0]
                .channelbag(obj.animation_data.action_slot)
                .fcurves
            )
            add(
                [
                    action.name,
                    [
                        [
                            c.data_path,
                            c.array_index,
                            [(list(p.co), p.interpolation) for p in c.keyframe_points],
                        ]
                        for c in curves
                    ],
                ]
            )
    for mat in sorted(bpy.data.materials, key=lambda m: m.name):
        if not mat.node_tree:
            continue
        add(mat.name)
        for node in sorted(mat.node_tree.nodes, key=lambda n: n.name):
            add([node.name, node.bl_idname])
            for socket in node.inputs:
                value = getattr(socket, "default_value", None)
                if isinstance(value, (int, float, str, bool)):
                    add([socket.identifier, value])
                elif value is not None and hasattr(value, "__len__"):
                    add([socket.identifier, list(value)])
            if node.type == "TEX_IMAGE" and node.image:
                add(
                    [
                        node.image.name,
                        node.image.colorspace_settings.name,
                        hashlib.sha256(bytes(node.image.packed_file.data)).hexdigest(),
                    ]
                )
            if node.type == "VALTORGB":
                add([(e.position, list(e.color)) for e in node.color_ramp.elements])
        add(
            sorted(
                (
                    link.from_node.name,
                    link.from_socket.identifier,
                    link.to_node.name,
                    link.to_socket.identifier,
                )
                for link in mat.node_tree.links
            )
        )
    return h.hexdigest()


def triangle(mesh: bpy.types.Mesh, face: bpy.types.MeshPolygon) -> tuple:
    return tuple(
        sorted(tuple(round(v, 6) for v in mesh.vertices[i].co) for i in face.vertices)
    )


def measurements(high: Path, path: Path, ktx: Path) -> dict:
    bpy.ops.wm.open_mainfile(filepath=str(high))
    obj = bpy.data.objects["pedestal"]
    mesh = obj.data
    surface_faces = {}
    components = {}
    for face in mesh.polygons:
        vert = mesh.vertices[face.vertices[0]]
        group = next(
            obj.vertex_groups[g.group].name[4:]
            for g in vert.groups
            if obj.vertex_groups[g.group].name[:3].isdigit()
        )
        surface = mesh.materials[face.material_index].name
        surface_faces[triangle(mesh, face)] = (group, surface)
        if (
            group.startswith("Calibration contact pad")
            or group == "Octagonal landing shoe"
        ):
            components.setdefault(group, []).append(face)
    support = {}
    for group, faces in components.items():
        edges = Counter(tuple(sorted(pair)) for f in faces for pair in f.edge_keys)
        assert set(edges.values()) == {2}, group
        verts = {i for f in faces for i in f.vertices}
        pts = [mesh.vertices[i].co for i in verts]
        contacts = [p for p in pts if abs(p.z) < 1e-7]
        contact_area = sum(
            f.area
            for f in faces
            if all(abs(mesh.vertices[i].co.z) < 1e-7 for i in f.vertices)
        )
        support[group] = {
            "closed": True,
            "floor_area_m2": round(contact_area, 8),
            "max_ground_radius_m": round(
                max((p.xy.length for p in contacts), default=0), 5
            ),
        }
        if group.startswith("Calibration contact pad"):
            assert (
                contact_area > 0.001
                and abs(max(p.xy.length for p in contacts) - 0.38) < 1e-6
            )
        else:
            profile = {
                h: round(max(p.xy.length for p in pts if abs(p.z - h) < 1e-6), 6)
                for h in (0.016, 0.061, 0.241, 0.4032)
            }
            assert all(
                abs(profile[h] - r) < 1e-5
                for h, r in [
                    (0.016, 0.209),
                    (0.061, 0.269),
                    (0.241, 0.367),
                    (0.4032, 0.3116),
                ]
            )
            support[group]["shell_radii_by_height_m"] = profile
    assert len(support) == 5
    import_glb(path)
    obj = bpy.data.objects["pedestal"]
    mesh = obj.data
    labels = {
        GRAPHITE: "Shoulder ceramic",
        CASSETTE: "Recessed bay",
        BELLY: "Octagonal landing shoe",
        "RB.brushed-titanium": "Paired shoulder spine",
    }
    exported = Counter(triangle(mesh, p) for p in mesh.polygons)
    for name in components:
        expected = Counter(
            key for key, (component, _) in surface_faces.items() if component == name
        )
        assert all(exported[key] == count for key, count in expected.items()), name
        support[name]["exact_exported_triangles"] = sum(expected.values())
    best = {}
    for p in mesh.polygons:
        group, surface = surface_faces.get(triangle(mesh, p), ("", ""))
        if surface == BELLY and not 0.025 < p.center.z < 0.061:
            continue
        if (
            surface in labels
            and group.startswith(labels[surface])
            and (surface not in best or p.area > best[surface][0])
        ):
            uv = np.mean(
                [list(mesh.uv_layers.active.data[i].uv) for i in p.loop_indices], axis=0
            )
            best[surface] = (
                p.area,
                group,
                [round(v, 6) for v in p.center],
                [int(2048 * uv[0]), 2047 - int(2048 * uv[1])],
            )
    assert set(best) == set(labels)
    glb = Glb(path.read_bytes())
    assert not glb.doc.get("skins")
    assert [a["name"] for a in glb.doc["animations"]] == ["ShieldEmitterSweep"]
    (channel,) = glb.doc["animations"][0]["channels"]
    target = channel["target"]
    assert (
        target["path"] == "rotation"
        and glb.doc["nodes"][target["node"]]["name"] == original.EMITTER
    )
    probes = {
        surface: {"component": group, "center_blender_m": center, "texel_top_left": xy}
        for surface, (_, group, center, xy) in best.items()
    }
    for role in ("basecolor", "normal", "orm", "emissive"):
        image = next(im for im in glb.doc["images"] if im["name"] == f"{role} KTX2")
        start, size, _ = glb.view(image["bufferView"])
        raw = bytes(glb.bin[start : start + size])
        assert raw == (path.parent / f"{role}.ktx2").read_bytes()
        decoded = np.frombuffer(decode_ktx2(ktx, raw), dtype=np.uint8).reshape(
            2048, 2048, 4
        )
        for surface, (_, _, _, (x, y)) in best.items():
            probes[surface][role] = decoded[y, x, :3].tolist()
    for surface in (GRAPHITE, CASSETTE, BELLY):
        q = probes[surface]
        assert (
            max(q["basecolor"]) < 100
            and 125 <= q["orm"][1] <= 170
            and q["orm"][2] < 22
            and max(q["emissive"]) < 6
            and max(
                abs(n - expected)
                for n, expected in zip(q["normal"], (128, 128, 255), strict=True)
            )
            < 5
        ), q
    titanium = probes["RB.brushed-titanium"]
    assert (
        titanium["orm"][2] > 195
        and titanium["orm"][1] < 130
        and min(titanium["basecolor"]) > 145
    ), titanium
    # Compare triangulated neutral control geometry independently of atlas UV or vertex splitting.
    controls = {}
    for name, height in original.PIVOTS.items():
        if name == original.PEDESTAL:
            continue
        current = bpy.data.objects[name].data
        actual = Counter(triangle(current, p) for p in current.polygons)
        source = pipeline.object_from_parts(
            "Reference " + name,
            [part for part in original.build(False) if part.group == name],
        )
        for vertex in source.data.vertices:
            vertex.co.z -= height
        reference = Counter(triangle(source.data, p) for p in source.data.polygons)
        assert actual == reference, name
        controls[name] = sum(actual.values())
    return {
        "neutral_control_triangles_equal_to_original": controls,
        "source_support_components": support,
        "decoded_glb_finish_probes": probes,
        "armatures": 0,
        "animation_channels": 1,
        "editables_logical_sha256": {
            label: logical(path.parent / f"{label}.blend") for label in ("high", "low")
        },
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--glb", type=Path, required=True)
    p.add_argument("--ktx", type=Path, required=True)
    p.add_argument("--report", type=Path, required=True)
    args = p.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    path = args.glb.resolve()
    result = verify(path)
    result["budgets"] = atlas_metrics(path, args.ktx)
    result["revision"] = measurements(path.parent / "high.blend", path, args.ktx)
    write_json(args.report, result)


if __name__ == "__main__":
    main()
