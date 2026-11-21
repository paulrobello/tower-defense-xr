"""Offline GLB mutations and opt-in roundtrip through the pinned KTX binary."""

from __future__ import annotations

import copy
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path
from typing import Any

SCRIPT = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT))

from assets.ktx2 import checked_ktx, decode_ktx2, digest, read_ktx2, validate_pixels
from validate_glbs import Glb, validate_model, verify_manifest

Json = dict[str, Any]


def fixture(
    *, duplicate: bool = False, skew_normals: bool = False, skin: bool = False
) -> tuple[Json, bytes, Json]:
    doc: Json = {
        "asset": {"version": "2.0"},
        "nodes": [
            {"name": "assembly", "children": [1, 2], "translation": [2, 0, 0], "scale": [2, 1, 1]},
            {"name": "panel", "mesh": 0},
            {"name": "muzzle", "translation": [0.25, 0, 0], "extras": {"socket": True}},
        ],
        "scenes": [{"nodes": [0]}],
        "scene": 0,
        "buffers": [{}],
        "bufferViews": [],
        "accessors": [],
        "materials": [{"name": "Ceramic"}],
    }
    data = bytearray()
    component = {"f": 5126, "H": 5123, "B": 5121}

    def accessor(kind: str, fmt: str, rows: list[tuple]) -> int:
        data.extend(bytes(-len(data) % 4))
        start = len(data)
        for row in rows:
            data.extend(struct.pack("<" + fmt * len(row), *row))
        view = len(doc["bufferViews"])
        doc["bufferViews"].append(
            {"buffer": 0, "byteLength": len(data) - start, "byteOffset": start}
        )
        index = len(doc["accessors"])
        doc["accessors"].append(
            {"bufferView": view, "componentType": component[fmt], "count": len(rows), "type": kind}
        )
        return index

    positions = accessor("VEC3", "f", [(0, 0, 0), (1, 0, 0), (0, 1, 0), (1, 1, 0)])
    doc["accessors"][positions].update(min=[0, 0, 0], max=[1, 1, 0])
    attributes = {
        "POSITION": positions,
        "NORMAL": accessor("VEC3", "f", [(0, 0.6, 0.8) if skew_normals else (0, 0, 1)] * 4),
        "TEXCOORD_0": accessor("VEC2", "f", [(0, 0), (1, 0), (0, 1), (1, 1)]),
    }
    indices = [0, 1, 2, 0, 1, 2] if duplicate else [0, 1, 2, 1, 3, 2]
    doc["meshes"] = [
        {
            "primitives": [
                {
                    "attributes": attributes,
                    "indices": accessor("SCALAR", "H", [(i,) for i in indices]),
                    "material": 0,
                }
            ]
        }
    ]
    if skin:
        doc["nodes"][0]["children"].append(3)
        doc["nodes"][1]["skin"] = 0
        doc["nodes"].append({"name": "RootJoint"})
        attributes["JOINTS_0"] = accessor("VEC4", "B", [(0, 0, 0, 0)] * 4)
        attributes["WEIGHTS_0"] = accessor("VEC4", "f", [(1, 0, 0, 0)] * 4)
        doc["skins"] = [{"joints": [3], "skeleton": 3}]
    record = {
        "id": "fixture",
        "lod": 0,
        "file": "fixture.glb",
        "limits": {"triangles": 2, "materials": 1, "bones": 1 if skin else 0, "sockets": 1},
        "sockets": {"muzzle": {"parent": "assembly", "position": [2.5, 0, 0]}},
        "planar_primitives": [{"node": "panel", "primitive": 0, "max_degrees": 2}],
    }
    return doc, bytes(data), record


def glb_bytes(doc: Json, payload: bytes) -> bytes:
    doc["buffers"][0]["byteLength"] = len(payload)
    json_data = json.dumps(doc, separators=(",", ":")).encode()
    json_data += b" " * (-len(json_data) % 4)
    payload += bytes(-len(payload) % 4)
    return (
        struct.pack("<4s2I", b"glTF", 2, 28 + len(json_data) + len(payload))
        + struct.pack("<I4s", len(json_data), b"JSON")
        + json_data
        + struct.pack("<I4s", len(payload), b"BIN\0")
        + payload
    )


def color_png(rgb: tuple[int, int, int], *, alternate: tuple[int, int, int] | None = None) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    top = (b"\0" + bytes(rgb) * 8) * 4
    bottom = (b"\0" + bytes(alternate or rgb) * 8) * 4
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">2I5B", 8, 8, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(top + bottom))
        + chunk(b"IEND", b"")
    )


class TempAssets(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def write_model(self, doc: Json, data: bytes, record: Json) -> Json:
        glb = glb_bytes(doc, data)
        (self.root / record["file"]).write_bytes(glb)
        return {**record, "sha256": digest(glb)}

    def verify_model(self, doc: Json, data: bytes, record: Json) -> dict[str, int]:
        return validate_model(self.root, self.write_model(doc, data, record), {})


class ModelChecks(TempAssets):
    def test_adjacent_triangles_and_transformed_socket_are_valid(self) -> None:
        doc, data, record = fixture(skin=True)
        stats = self.verify_model(doc, data, record)
        self.assertEqual(
            (stats["triangles"], stats["materials"], stats["bones"], stats["sockets"]), (2, 1, 1, 1)
        )

    def test_geometry_mutations(self) -> None:
        doc, data, record = fixture(duplicate=True)
        with self.assertRaisesRegex(ValueError, "positive-area coplanar overlap"):
            self.verify_model(doc, data, record)
        doc, data, record = fixture(skew_normals=True)
        with self.assertRaisesRegex(ValueError, "planar corner normal"):
            self.verify_model(doc, data, record)
        doc, data, record = fixture()
        attributes = doc["meshes"][0]["primitives"][0]["attributes"]
        uv = attributes.pop("TEXCOORD_0")
        with self.assertRaisesRegex(ValueError, "UV0"):
            self.verify_model(doc, data, record)
        attributes["TEXCOORD_0"] = uv
        record["limits"]["triangles"] = 1
        with self.assertRaisesRegex(ValueError, "triangles over budget"):
            self.verify_model(doc, data, record)

    def test_overlap_across_transformed_instances(self) -> None:
        doc, data, record = fixture()
        doc["nodes"][0]["children"].append(3)
        doc["nodes"].append({"name": "copy", "mesh": 0, "translation": [2, 0, 0]})
        record["limits"]["triangles"] = 4
        self.assertEqual(self.verify_model(doc, data, record)["triangles"], 4)
        doc["nodes"][3]["translation"] = [0.49, 0.49, 0]
        with self.assertRaisesRegex(ValueError, "positive-area coplanar overlap"):
            self.verify_model(doc, data, record)

    def test_range_and_budget_mutations(self) -> None:
        doc, data, record = fixture(skin=True)
        for key in ("materials", "bones", "sockets"):
            with self.subTest(budget=key):
                mutated = copy.deepcopy(record)
                mutated["limits"][key] = 0
                with self.assertRaisesRegex(ValueError, f"{key} over budget"):
                    self.verify_model(doc, data, mutated)
        record["sockets"]["muzzle"]["position"] = [0.25, 0, 0]
        with self.assertRaisesRegex(ValueError, "socket 'muzzle' is at"):
            self.verify_model(doc, data, record)
        with self.assertRaisesRegex(ValueError, "file length"):
            Glb(glb_bytes(doc, data)[:-1])
        doc["accessors"][0]["count"] = 5
        with self.assertRaisesRegex(ValueError, "accessor byte range"):
            Glb(glb_bytes(doc, data))

    def test_lod_uses_measured_triangle_count(self) -> None:
        doc, data, near = fixture()
        doc_near = copy.deepcopy(doc)
        far = {**near, "file": "far.glb", "lod": 1}
        idx = doc["meshes"][0]["primitives"][0]["indices"]
        doc["accessors"][idx]["count"] = 3
        path = self.root / "manifest.json"
        near = self.write_model(doc_near, data, near)
        far = self.write_model(doc, data, far)
        path.write_text(json.dumps({"version": 1, "textures": [], "models": [near, far]}))
        self.assertEqual(verify_manifest(path, None), (2, 0))
        far = self.write_model(doc_near, data, far)
        path.write_text(json.dumps({"version": 1, "textures": [], "models": [near, far]}))
        with self.assertRaisesRegex(ValueError, "does not reduce triangle count"):
            verify_manifest(path, None)

    def test_pixel_checks_reject_orm_swap_and_bad_normal(self) -> None:
        orm = {"role": "orm", "samples": [{"x": 0, "y": 0, "rgb": [224, 80, 16]}]}
        validate_pixels(bytes((224, 80, 16, 255)), 1, 1, orm)
        with self.assertRaisesRegex(ValueError, "ORM R/G/B"):
            validate_pixels(bytes((80, 224, 16, 255)), 1, 1, orm)
        normal = {"role": "normal", "flat_normal": True}
        validate_pixels(bytes((128, 128, 255, 255)), 1, 1, normal)
        with self.assertRaisesRegex(ValueError, "non-unit tangent normal"):
            validate_pixels(bytes((128, 128, 160, 255)), 1, 1, normal)
        with self.assertRaisesRegex(ValueError, "flat tangent normal"):
            validate_pixels(bytes((128, 255, 128, 255)), 1, 1, normal)


@unittest.skipUnless(
    os.environ.get("RIFT_MODEL_CHECK_KTX"),
    "set RIFT_MODEL_CHECK_KTX to the pinned KTX 4.4.2 executable",
)
class KtxRoundtrip(TempAssets):
    def encode(
        self,
        stem: str,
        role: str,
        rgb: tuple[int, int, int],
        alternate: tuple[int, int, int] | None = None,
    ) -> tuple[Path, Path]:
        source = self.root / f"{stem}.png"
        target = self.root / f"{stem}.ktx2"
        source.write_bytes(color_png(rgb, alternate=alternate))
        executable = checked_ktx(Path(os.environ["RIFT_MODEL_CHECK_KTX"]))
        subprocess.run(
            [
                sys.executable,
                str(SCRIPT / "assets/encode_ktx2.py"),
                "--role",
                role,
                "--ktx",
                str(executable),
                str(source),
                str(target),
            ],
            capture_output=True,
            check=True,
            timeout=15,
        )
        return executable, target

    def test_real_ktx_roundtrip_and_exact_role_binding(self) -> None:
        ktx, base = self.encode("ceramic", "basecolor", (190, 100, 60), (110, 40, 100))
        _, orm = self.encode("packed", "orm", (224, 80, 16), (192, 120, 48))
        _, neutral = self.encode("neutral", "normal", (128, 128, 255))
        _, orm_swapped = self.encode("swapped", "orm", (80, 224, 16), (120, 192, 48))
        _, bad_normal = self.encode("badnormal", "orm", (128, 128, 160))
        _, determinism = self.encode("second-encode", "orm", (224, 80, 16), (192, 120, 48))
        self.assertEqual(orm.read_bytes(), determinism.read_bytes())

        def manifest_entry(path: Path, role: str, **checks: Any) -> Json:
            return {
                "file": path.name,
                "role": role,
                "sha256": digest(path.read_bytes()),
                "width": 8,
                "height": 8,
                **checks,
            }

        samples = [{"x": 0, "y": 0, "rgb": [224, 80, 16]}, {"x": 0, "y": 7, "rgb": [192, 120, 48]}]
        textures = [
            manifest_entry(base, "basecolor", samples=[{"x": 0, "y": 0, "rgb": [190, 100, 60]}]),
            manifest_entry(orm, "orm", samples=samples),
            manifest_entry(neutral, "normal", flat_normal=True),
        ]
        doc, data, record = fixture()
        doc["extensionsUsed"] = doc["extensionsRequired"] = ["KHR_texture_basisu"]
        doc["images"] = [{"uri": base.name}, {"uri": orm.name}]
        doc["textures"] = [{"extensions": {"KHR_texture_basisu": {"source": i}}} for i in range(2)]
        doc["materials"][0].update(
            pbrMetallicRoughness={
                "baseColorTexture": {"index": 0},
                "metallicRoughnessTexture": {"index": 1},
            },
            occlusionTexture={"index": 1},
        )
        record["material_textures"] = {"Ceramic": {"basecolor": base.name, "orm": orm.name}}
        models = [self.write_model(doc, data, record)]
        path = self.root / "manifest.json"

        def validate(entries: list[Json]) -> tuple[int, int]:
            path.write_text(json.dumps({"version": 1, "textures": entries, "models": models}))
            return verify_manifest(path, lambda raw: decode_ktx2(ktx, raw))

        self.assertEqual(validate(textures), (1, 3))
        with self.assertRaisesRegex(ValueError, "ORM R/G/B"):
            validate(
                [textures[0], manifest_entry(orm_swapped, "orm", samples=samples), textures[2]]
            )
        with self.assertRaisesRegex(ValueError, "non-unit tangent normal"):
            validate([*textures[:2], manifest_entry(bad_normal, "normal")])
        doc["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"] = 1
        models[0] = self.write_model(doc, data, record)
        with self.assertRaisesRegex(ValueError, "basecolor texture binary/path"):
            validate(textures)
        with self.assertRaisesRegex(ValueError, "wrong KTX2 transfer"):
            read_ktx2(base.read_bytes(), "orm")
        mutated_orientation = base.read_bytes().replace(
            b"KTXorientation\0rd", b"KTXorientation\0ru"
        )
        with self.assertRaisesRegex(ValueError, "top-left KTX2 orientation"):
            read_ktx2(mutated_orientation, "basecolor")


if __name__ == "__main__":
    unittest.main()
