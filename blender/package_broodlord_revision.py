"""Recover singular glTF cap tangents from the owning triangle's positions and UVs."""

import argparse
import hashlib
import json
import struct
import sys
from math import sqrt
from pathlib import Path

from package_core_bastion import ROOT, digest, write_json

sys.path.insert(0, str(ROOT / "scripts"))
from validate_glbs import Glb, dot


def frames(path: Path) -> dict:
    source = path.read_bytes()
    glb = Glb(source)
    (primitive,) = glb.doc["meshes"][0]["primitives"]
    attr = primitive["attributes"]
    pos = glb.read(attr["POSITION"], "VEC3", (5126,))
    normals = glb.read(attr["NORMAL"], "VEC3", (5126,))
    uv = glb.read(attr["TEXCOORD_0"], "VEC2", (5126,))
    tangents = glb.read(attr["TANGENT"], "VEC4", (5126,))
    indices = [i for (i,) in glb.read(primitive["indices"], "SCALAR", (5123, 5125))]
    cap_corners = {i: [] for i, t in enumerate(tangents) if t[:3] == (0.0, 0.0, 0.0)}
    for p in range(0, len(indices), 3):
        face = indices[p : p + 3]
        for corner in face:
            if corner in cap_corners:
                cap_corners[corner].append(face)
    output = bytearray(source)
    unchanged = bytearray(source)
    _, start, stride, _ = glb.layouts[attr["TANGENT"]]
    binary = 28 + struct.unpack_from("<I", source, 12)[0]
    repairs = []
    for i, faces in cap_corners.items():
        # glTF seam splits leave each singular pole corner in exactly one triangle.
        [face] = faces
        a, b, c = face
        eu = [q - p for p, q in zip(pos[a], pos[b], strict=True)]
        ev = [q - p for p, q in zip(pos[a], pos[c], strict=True)]
        du1, dv1 = [q - p for p, q in zip(uv[a], uv[b], strict=True)]
        du2, dv2 = [q - p for p, q in zip(uv[a], uv[c], strict=True)]
        det = du1 * dv2 - du2 * dv1
        assert abs(det) > 1e-12
        derivative = tuple(
            (x * dv2 - y * dv1) / det for x, y in zip(eu, ev, strict=True)
        )
        normal = normals[i]
        tangent = tuple(
            x - dot(derivative, normal) * n / dot(normal, normal)
            for x, n in zip(derivative, normal, strict=True)
        )
        length = sqrt(dot(tangent, tangent))
        assert length > 1e-4
        tangent = tuple(x / length for x in tangent)
        assert abs(dot(tangent, normal)) < 1e-6
        offset = binary + start + stride * i
        assert struct.unpack_from("<4f", source, offset) == tangents[i]
        struct.pack_into("<3f", output, offset, *tangent)
        unchanged[offset : offset + 12] = bytes(12)
        repairs.append(
            {
                "vertex": i,
                "triangle": face,
                "uv": uv[i],
                "original_length": 0,
                "uv_derivative_projected_length": length,
                "normalized_tangent": tangent,
                "stored_handedness": tangents[i][3],
            }
        )
    masked = bytearray(output)
    for i in cap_corners:
        offset = binary + start + stride * i
        masked[offset : offset + 12] = bytes(12)
    assert masked == unchanged
    if repairs:
        path.write_bytes(output)
    return {
        "original_glb_sha256": hashlib.sha256(source).hexdigest(),
        "glb_sha256": digest(path),
        "all_bytes_outside_repaired_xyz_sha256": hashlib.sha256(masked).hexdigest(),
        "repair_count": len(repairs),
        "repaired_cap_corners": repairs,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", type=Path, required=True)
    models = parser.parse_args().models.resolve()
    index = models / "manifest.json"
    manifest = json.loads(index.read_text())
    receipt_path = models / "tangent-export.json"
    rows = [row for row in manifest["models"] if row["id"] == "apex-broodlord"]
    assert len(rows) == 2
    old = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
    receipt = {}
    for row in rows:
        name = row["file"]
        p = models / name
        current = digest(p)
        if name in old and current == old[name]["glb_sha256"]:
            item = old[name]
        else:
            assert current == row["sha256"]
            item = frames(p)
        row["sha256"] = item["glb_sha256"]
        receipt[name] = item
    assert len(receipt) == 2
    write_json(receipt_path, receipt)
    write_json(index, manifest)


if __name__ == "__main__":
    main()
