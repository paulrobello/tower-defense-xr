"""Encode the baked atlas and pack Blender geometry, PNG fallback and BasisU into a GLB."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import struct
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAPS = ("basecolor", "normal", "orm", "emissive")
ID = "core-bastion"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, data: object) -> None:
    path.write_text(json.dumps(data, indent=2) + "\n")


def pack(
    stage: Path, out: Path, ktx: Path, verified_maps: Path | None = None
) -> tuple[list, dict]:
    geometry = json.loads((stage / "geometry.json").read_text())
    document = json.loads((stage / "source.gltf").read_text())
    if [clip["name"] for clip in document.get("animations", [])] != [
        "ShieldEmitterSweep"
    ]:
        raise ValueError("Missing eight-second emitter sweep in the staged export")
    out.mkdir(parents=True, exist_ok=True)
    previous = {}
    if verified_maps:
        manifest = json.loads((verified_maps / "manifest.json").read_text())
        previous = {entry["file"]: entry["sha256"] for entry in manifest["textures"]}
    textures = []
    data = bytearray((stage / document["buffers"][0]["uri"]).read_bytes())

    def embed(path: Path) -> int:
        data.extend(b"\x00" * (-len(data) % 4))
        view = len(document["bufferViews"])
        document["bufferViews"].append(
            {"buffer": 0, "byteOffset": len(data), "byteLength": path.stat().st_size}
        )
        data.extend(path.read_bytes())
        return view

    def encode(role: str) -> None:
        record = geometry["bake"][role]
        source = stage / f"{role}.png"
        if digest(source) != record["sha256"]:
            raise ValueError(f"{role} differs from the projection bake")
        shutil.copy2(source, out / source.name)
        output = out / f"{role}.ktx2"
        if verified_maps:
            old = verified_maps / ID / output.name
            if (
                digest(old.with_suffix(".png")) != record["sha256"]
                or digest(old) != previous[f"{ID}/{output.name}"]
            ):
                raise ValueError(f"{role}: previous map is stale")
            shutil.copy2(old, output)
            return
        subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/assets/encode_ktx2.py"),
                "--ktx",
                str(ktx),
                "--role",
                role,
                str(source),
                str(output),
            ],
            check=True,
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(encode, MAPS))
    for role in MAPS:
        record = geometry["bake"][role]
        source = stage / f"{role}.png"
        output = out / f"{role}.ktx2"
        textures.append(
            {
                "file": f"{ID}/{output.name}",
                "role": role,
                "sha256": digest(output),
                "width": 2048,
                "height": 2048,
                "samples": record["samples"],
            }
        )
        fallback = next(
            i
            for i, img in enumerate(document["images"])
            if img.get("uri") == source.name
        )
        png_view = embed(source)
        document["images"][fallback] = {
            "name": f"{role} PNG",
            "mimeType": "image/png",
            "bufferView": png_view,
        }
        basis = len(document["images"])
        document["images"].append(
            {
                "name": f"{role} KTX2",
                "mimeType": "image/ktx2",
                "bufferView": embed(output),
            }
        )
        for texture in document["textures"]:
            if texture["source"] == fallback:
                texture.setdefault("extensions", {})["KHR_texture_basisu"] = {
                    "source": basis
                }
    document["extensionsUsed"] = sorted(
        set(document.get("extensionsUsed", [])) | {"KHR_texture_basisu"}
    )
    data.extend(b"\x00" * (-len(data) % 4))
    document["buffers"] = [{"byteLength": len(data)}]
    info = json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode()
    info += b" " * (-len(info) % 4)
    glb = out / "core-bastion.glb"
    glb.write_bytes(
        struct.pack("<4sII", b"glTF", 2, 28 + len(info) + len(data))
        + struct.pack("<I4s", len(info), b"JSON")
        + info
        + struct.pack("<I4s", len(data), b"BIN\0")
        + data
    )
    for name in ("high.blend", "low.blend", "geometry.json"):
        shutil.copy2(stage / name, out / name)
    model = {
        "id": ID,
        "lod": 0,
        "file": f"{ID}/{glb.name}",
        "sha256": digest(glb),
        "limits": {
            "triangles": 14000,
            "materials": 3,
            "bones": 0,
            "sockets": 0,
            "texture_size": 2048,
        },
        "sockets": {},
        "animations": ["ShieldEmitterSweep"],
        "planar_primitives": [
            {"node": node["name"], "primitive": 0, "max_degrees": 2}
            for node in document["nodes"]
            if "mesh" in node
        ],
        "material_textures": {
            mat["name"]: {role: f"{ID}/{role}.ktx2" for role in MAPS}
            for mat in document["materials"]
        },
    }
    return textures, model


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument(
        "--verified-maps",
        type=Path,
        help="Reuse a registered set after verifying source and encoded hashes",
    )
    parser.add_argument(
        "--ktx",
        type=Path,
        default=Path.home() / ".local/opt/ktx-software-4.4.2/bin/ktx",
    )
    args = parser.parse_args()
    folder = args.models.resolve()
    textures, model = pack(
        args.stage.resolve(), folder / ID, args.ktx.resolve(), args.verified_maps
    )
    path = folder / "manifest.json"
    manifest = (
        json.loads(path.read_text())
        if path.exists()
        else {"version": 1, "textures": [], "models": []}
    )
    if manifest["version"] != 1:
        raise ValueError("Unexpected model manifest version")
    manifest["textures"] = [
        t for t in manifest["textures"] if not t["file"].startswith(ID + "/")
    ] + textures
    manifest["models"] = [m for m in manifest["models"] if m["id"] != ID] + [model]
    write_json(path, manifest)


if __name__ == "__main__":
    main()
