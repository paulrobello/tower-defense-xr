"""Embed the portal's exact PNG fallbacks and encoded KTX2 maps into its staged GLB."""

from __future__ import annotations

import argparse
import json
import shutil
import struct
import subprocess
import sys
from pathlib import Path

from package_core_bastion import digest, write_json

ROOT = Path(__file__).resolve().parents[1]
ID = "rift-portal"
ROLES = {
    "basecolor": "basecolor",
    "normal": "normal",
    "orm": "orm",
    "emissive": "emissive",
    "vortex": "emissive",
}


def package(stage: Path, models: Path, ktx: Path) -> None:
    target = models / ID
    target.mkdir(parents=True, exist_ok=True)
    document = json.loads((stage / "source.gltf").read_text())
    geometry = json.loads((stage / "geometry.json").read_text())
    payload = bytearray((stage / document["buffers"][0]["uri"]).read_bytes())

    def embed(path: Path) -> int:
        payload.extend(bytes(-len(payload) % 4))
        views = document["bufferViews"]
        views.append(
            {"buffer": 0, "byteOffset": len(payload), "byteLength": path.stat().st_size}
        )
        payload.extend(path.read_bytes())
        return len(views) - 1

    textures = []
    for name, role in ROLES.items():
        source, compressed = stage / f"{name}.png", target / f"{name}.ktx2"
        record = geometry["bake"][name]
        if digest(source) != record["sha256"]:
            raise ValueError(f"{name} hash differs from the fresh bake")
        subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/assets/encode_ktx2.py"),
                "--ktx",
                str(ktx),
                "--role",
                role,
                str(source),
                str(compressed),
            ],
            check=True,
        )
        shutil.copy2(source, target / source.name)
        textures.append(
            {
                "file": f"{ID}/{compressed.name}",
                "role": role,
                "sha256": digest(compressed),
                "width": 1024,
                "height": 1024,
                "samples": record["samples"],
            }
        )
        indices = [
            i for i, im in enumerate(document["images"]) if im.get("uri") == source.name
        ]
        if len(indices) != 1:
            raise ValueError(f"Missing fallback {source.name} in {document['images']}")
        idx = indices[0]
        document["images"][idx] = {
            "name": f"{name} PNG",
            "mimeType": "image/png",
            "bufferView": embed(source),
        }
        ktx_index = len(document["images"])
        document["images"].append(
            {
                "name": f"{name} KTX2",
                "mimeType": "image/ktx2",
                "bufferView": embed(compressed),
            }
        )
        for tex in document["textures"]:
            if tex["source"] == idx:
                tex.setdefault("extensions", {})["KHR_texture_basisu"] = {
                    "source": ktx_index
                }
    document["extensionsUsed"] = sorted(
        set(document.get("extensionsUsed", [])) | {"KHR_texture_basisu"}
    )
    payload.extend(bytes(-len(payload) % 4))
    document["buffers"] = [{"byteLength": len(payload)}]
    header = json.dumps(document, separators=(",", ":")).encode()
    header += b" " * (-len(header) % 4)
    glb = target / "rift-portal.glb"
    glb.write_bytes(
        struct.pack("<4sII", b"glTF", 2, 28 + len(payload) + len(header))
        + struct.pack("<I4s", len(header), b"JSON")
        + header
        + struct.pack("<I4s", len(payload), b"BIN\0")
        + payload
    )
    for name in ("high.blend", "low.blend", "geometry.json"):
        shutil.copy2(stage / name, target / name)
    model = {
        "id": ID,
        "lod": 0,
        "file": f"{ID}/{glb.name}",
        "sha256": digest(glb),
        "limits": {
            "triangles": 4500,
            "materials": 2,
            "bones": 0,
            "sockets": 1,
            "texture_size": 1024,
        },
        "sockets": {
            "apertureAnchor": {
                "parent": "riftPortal",
                "position": [0, 0, 0],
                "tolerance": 0.0001,
            }
        },
        "animations": [],
        "planar_primitives": [
            {"node": "portalInterior", "primitive": 0, "max_degrees": 1}
        ],
        "material_textures": {
            "Rift segmented bezel": {
                name: f"{ID}/{name}.ktx2" for name in ROLES if name != "vortex"
            },
            "Rift aperture field": {"emissive": f"{ID}/vortex.ktx2"},
        },
    }
    manifest = models / "manifest.json"
    catalog = (
        json.loads(manifest.read_text())
        if manifest.exists()
        else {"version": 1, "textures": [], "models": []}
    )
    if catalog["version"] != 1:
        raise ValueError("Unexpected manifest version")
    catalog["textures"] = [
        t for t in catalog["textures"] if not t["file"].startswith(ID + "/")
    ] + textures
    catalog["models"] = [m for m in catalog["models"] if m["id"] != ID] + [model]
    write_json(manifest, catalog)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ("stage", "models", "ktx"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    package(args.stage.resolve(), args.models.resolve(), args.ktx.resolve())
