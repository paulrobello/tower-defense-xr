"""Check planar lips, curved optical housing normals and two clean editable archives."""

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path
from unittest.mock import patch

import bpy
import numpy as np
from mathutils.bvhtree import BVHTree

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path[:0] = [
    str(HERE),
    str(HERE.parent / "scripts"),
    str(HERE.parent / "scripts/assets"),
]

import verify_hover_pod as pod
from hover_pod_revision import build, curved_object
from package_core_bastion import digest, write_json
from review_core_bastion import import_glb
from verify_m44 import verify_sources


def normals(path: Path) -> dict:
    import_glb(path)
    level = path.stem.split("-")[-1]
    parts = build(level)
    for part in parts:
        part.group = level + "." + part.group
    source = curved_object("Revision expected shading", parts).data
    tree = BVHTree.FromPolygons(
        [v.co for v in source.vertices],
        [tuple(f.vertices) for f in source.polygons],
        all_triangles=True,
    )
    max_planar = 0.0
    planar_count = 0
    flats, smooth, stations = 0, [], set()
    for obj in (bpy.data.objects[pod.RING], bpy.data.objects[pod.CORE]):
        mesh = obj.data
        for face in mesh.polygons:
            pts = [mesh.vertices[i].co for i in face.vertices]
            z = [p.z for p in pts]
            radial = [p.xy.length for p in pts]
            if max(z) - min(z) < 1e-7:
                flats += 1
            _, _, face_id, error = tree.find_nearest(face.center)
            assert (
                error < 2e-6
                and source.polygons[face_id].normal.dot(face.normal) > 0.9999
            )
            if not source.polygons[face_id].use_smooth:
                planar_count += 1
                for index in face.loop_indices:
                    n = mesh.corner_normals[index].vector
                    max_planar = max(max_planar, math.degrees(n.angle(face.normal)))
            if (
                obj.name == pod.CORE
                and min(radial) >= 0.05799
                and max(radial) <= 0.07501
                and min(z) < 0.013
                and max(z) > 0.008
            ):
                for index in face.loop_indices:
                    n = mesh.corner_normals[index].vector
                    p = mesh.vertices[mesh.loops[index].vertex_index].co
                    assert n.z < 0 and n.xy.dot(p.xy) > 0
                    smooth.append(math.degrees(n.xy.angle(p.xy)))
                    stations.add(round(math.atan2(p.y, p.x), 5))
    assert planar_count > flats > 50 and max_planar < 0.1, (
        planar_count,
        flats,
        max_planar,
    )
    assert len(smooth) >= 200 and max(smooth) < 1, (len(smooth), max(smooth))
    return {
        "authored_planar_triangles": planar_count,
        "horizontal_planar_triangles": flats,
        "worst_planar_normal_degrees": round(max_planar, 5),
        "underside_titanium_corner_samples": len(smooth),
        "worst_normal_azimuth_error_degrees": round(max(smooth), 5),
        "bearing_radial_stations": len(stations),
    }


def source_fingerprint(folder: Path) -> dict:
    result = verify_sources(folder)
    for name in ("high", "low"):
        bpy.ops.wm.open_mainfile(filepath=str(folder / f"{name}.blend"))
        h = hashlib.sha256(
            bytes.fromhex(result[name]["geometry_uv_hierarchy_material_slots_sha256"])
        )
        for obj in sorted(
            (o for o in bpy.context.scene.objects if o.type == "MESH"),
            key=lambda o: o.name,
        ):
            h.update(
                np.asarray(
                    [c.vector[:] for c in obj.data.corner_normals], dtype="<f4"
                ).tobytes()
            )
        h.update(
            b"".join(
                sorted(
                    hashlib.sha256(im.packed_file.data).digest()
                    for im in bpy.data.images
                    if im.packed_file
                )
            )
        )
        result[name][
            "geometry_slots_uv_hierarchy_corner_normals_packed_textures_sha256"
        ] = h.hexdigest()
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    for arg in ("piece", "repeat", "ktx"):
        parser.add_argument("--" + arg, type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    piece, repeat = args.piece.resolve(), args.repeat.resolve()
    with patch.object(
        sys, "argv", [__file__, "--", "--piece", str(piece), "--ktx", str(args.ktx)]
    ):
        pod.main()
    evidence = json.loads((piece / "reimport.json").read_text())
    hashes = {}
    for path in sorted(piece.iterdir()):
        if path.suffix in (".ktx2", ".png", ".glb") or path.name == "geometry.json":
            assert digest(path) == digest(repeat / path.name), path.name
            hashes[path.name] = digest(path)
    assert len(hashes) == 11
    a, b = source_fingerprint(piece), source_fingerprint(repeat)
    for name in a:
        key = "geometry_slots_uv_hierarchy_corner_normals_packed_textures_sha256"
        assert a[name][key] == b[name][key]
        a[name]["repeat_archive_sha256"] = b[name]["sha256"]
    for level, limit in (("lod0", 2476), ("lod1", 1148)):
        value = evidence[level]
        assert value["triangles"] <= limit
        assert (
            abs(value["radius_m"] - 0.156) < 2e-6
            and abs(value["radial_air_gap_m"] - 0.018) < 2e-6
        )
        value["normal_checks"] = normals(piece / f"hover-pod-{level}.glb")
    write_json(piece / "reimport.json", evidence)
    write_json(
        piece / "determinism.json",
        {
            "platform": "Linux x86_64, Blender 5.2.2 Cycles CPU, 3 threads, KTX-Software 4.4.2",
            "independent_portable_output_hashes": hashes,
            "editable_sources": a,
        },
    )


if __name__ == "__main__":
    main()
