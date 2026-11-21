"""Package the two clamp LODs with one verified, self-contained set of portable maps."""

import argparse
import json
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

from package_core_bastion import MAPS, ROOT, digest, write_json

ID = "surface-clamp"


def pack(stage: Path, target: Path, lod: int) -> dict:
    folder = stage / f"lod{lod}"
    document = json.loads((folder / "source.gltf").read_text())
    data = bytearray((folder / document["buffers"][0]["uri"]).read_bytes())

    def embed(path: Path, mime: str) -> dict:
        data.extend(bytes(-len(data) % 4))
        index = len(document["bufferViews"])
        document["bufferViews"].append(
            {"buffer": 0, "byteOffset": len(data), "byteLength": path.stat().st_size}
        )
        data.extend(path.read_bytes())
        return {"name": path.name, "mimeType": mime, "bufferView": index}

    for role in MAPS:
        png = target / f"{role}.png"
        candidates = [
            i
            for i, im in enumerate(document["images"])
            if "uri" in im and digest(folder / im["uri"]) == digest(png)
        ]
        if len(candidates) != 1:
            raise ValueError(f"{role} PNG does not match a unique exported image")
        idx = candidates[0]
        document["images"][idx] = embed(png, "image/png")
        basis = len(document["images"])
        document["images"].append(embed(target / f"{role}.ktx2", "image/ktx2"))
        for tex in document["textures"]:
            if tex.get("source") == idx:
                tex.setdefault("extensions", {})["KHR_texture_basisu"] = {
                    "source": basis
                }
    document["extensionsUsed"] = sorted(
        set(document.get("extensionsUsed", [])) | {"KHR_texture_basisu"}
    )
    data.extend(bytes(-len(data) % 4))
    document["buffers"] = [{"byteLength": len(data)}]
    header = json.dumps(document, separators=(",", ":")).encode()
    header += b" " * (-len(header) % 4)
    path = target / f"{ID}-lod{lod}.glb"
    path.write_bytes(
        struct.pack("<4sII", b"glTF", 2, 28 + len(header) + len(data))
        + struct.pack("<I4s", len(header), b"JSON")
        + header
        + struct.pack("<I4s", len(data), b"BIN\0")
        + data
    )
    return {
        "id": ID,
        "lod": lod,
        "file": f"{ID}/{path.name}",
        "sha256": digest(path),
        "limits": {
            "triangles": 6500 if lod == 0 else 2500,
            "materials": 2,
            "bones": 0,
            "sockets": 1,
            "texture_size": 1024,
        },
        "sockets": {
            "mountSocket": {
                "parent": "surfaceClamp",
                "position": [0, 0, 0],
                "tolerance": 0.00001,
            }
        },
        "animations": [],
        "planar_primitives": [
            {"node": n["name"], "primitive": 0, "max_degrees": 1}
            for n in document["nodes"]
            if "mesh" in n
        ],
        "material_textures": {
            "Surface Clamp satin armor": {r: f"{ID}/{r}.ktx2" for r in MAPS}
        },
    }


def comparison(out: Path, views: list[str]) -> None:
    cameras = [
        json.loads((out / f"{level}-cameras.json").read_text())
        for level in ("high", "lod0", "lod1")
    ]
    for level in cameras[1:]:
        assert all(cameras[0][view] == camera for view, camera in level.items())
    font = subprocess.check_output(
        ["fc-match", "-f", "%{file}", "sans-serif"], text=True
    ).strip()
    if not Path(font).is_file():
        raise ValueError(
            "Could not resolve a local sans-serif font for the comparison labels"
        )
    images = []
    for level in ("high", "lod0"):
        for name in views:
            images.extend(
                [
                    "-label",
                    f"{level.upper()}  /  {name.title()}",
                    str(out / f"{level}-{name}.png"),
                ]
            )
    subprocess.run(
        [
            "magick",
            "montage",
            "-background",
            "#222833",
            "-fill",
            "#f4f5f6",
            "-font",
            font,
            "-pointsize",
            "16",
            *images,
            "-geometry",
            "304x304+4+4",
            "-tile",
            "5x2",
            "-quality",
            "91",
            str(out / "comparison.jpg"),
        ],
        check=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    for name in ("stage", "models", "ktx"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    stage, models, ktx = args.stage.resolve(), args.models.resolve(), args.ktx.resolve()
    target = models / ID
    target.mkdir(parents=True, exist_ok=True)
    metrics = json.loads((stage / "geometry.json").read_text())
    textures = []
    with tempfile.TemporaryDirectory(dir=target) as tmp:
        for role in MAPS:
            png = stage / f"{role}.png"
            if digest(png) != metrics["bake"][role]["sha256"]:
                raise ValueError(f"{role}: bake source has changed")
            dest = Path(tmp) / f"{role}.ktx2"
            subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts/assets/encode_ktx2.py"),
                    "--ktx",
                    str(ktx),
                    "--role",
                    role,
                    str(png),
                    str(dest),
                ],
                check=True,
            )
            shutil.copy2(png, target / png.name)
            dest.replace(target / dest.name)
            textures.append(
                {
                    "file": f"{ID}/{dest.name}",
                    "role": role,
                    "sha256": digest(target / dest.name),
                    "width": 1024,
                    "height": 1024,
                    "samples": metrics["bake"][role]["samples"],
                }
            )
    records = [pack(stage, target, lod) for lod in (0, 1)]
    for name in ("high.blend", "low.blend", "geometry.json"):
        shutil.copy2(stage / name, target / name)
    index = models / "manifest.json"
    data = (
        json.loads(index.read_text())
        if index.exists()
        else {"version": 1, "textures": [], "models": []}
    )
    if data["version"] != 1:
        raise ValueError("Unknown registry version")
    data["textures"] = [
        t for t in data["textures"] if not t["file"].startswith(ID + "/")
    ] + textures
    data["models"] = [m for m in data["models"] if m["id"] != ID] + records
    write_json(index, data)


if __name__ == "__main__":
    main()
