"""Reuse the mount packager with each Glacier tier's muzzle and head-only budgets."""

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import package_surface_clamp as packaging


def runtime_contract(tier: int) -> dict:
    source = (packaging.ROOT / "src/content/turrets.ts").read_text()
    cryo = source.split("const CRYO_ARC_TIERS:", 1)[1].split(
        "const RAIL_SNIPER_TIERS:", 1
    )[0]
    block = (
        cryo.split(f"T{tier}: {{", 1)[1]
        .split("blockout: {", 1)[1]
        .split("meshBudget:", 1)[0]
    )
    return {key: float(val) for key, val in re.findall(r"(\w+):\s*([0-9.]+)", block)}


def encode_orm(ktx: Path, source: Path, target: Path) -> None:
    # RDO shifts a brushed-metal AO reference by 13/255 on this tier's dark-to-light edge.
    with tempfile.TemporaryDirectory(dir=target.parent) as tmp:
        out = Path(tmp) / target.name
        subprocess.run(
            [
                str(ktx),
                "create",
                "--format",
                "R8G8B8_UNORM",
                "--assign-tf",
                "linear",
                "--assign-primaries",
                "none",
                "--assign-texcoord-origin",
                "top-left",
                "--convert-texcoord-origin",
                "top-left",
                "--encode",
                "uastc",
                "--uastc-quality",
                "3",
                "--threads",
                "1",
                "--zstd",
                "18",
                "--generate-mipmap",
                str(source),
                str(out),
            ],
            check=True,
        )
        subprocess.run([str(ktx), "validate", "--gltf-basisu", str(out)], check=True)
        out.replace(target)


def package(
    stage: Path, models: Path, ktx: Path, tier: int, *, refresh_orm: bool = False
) -> None:
    asset_id = f"glacier-cryo-arc-t{tier}"
    target = models / asset_id
    target.mkdir(parents=True, exist_ok=True)
    metrics = json.loads((stage / "geometry.json").read_text())
    textures = []
    for role in packaging.MAPS:
        png = stage / f"{role}.png"
        encoded = target / f"{role}.ktx2"
        assert packaging.digest(png) == metrics["bake"][role]["sha256"]
        if tier == 1 and role == "orm":
            encode_orm(ktx, png, encoded)
        elif not refresh_orm:
            with tempfile.TemporaryDirectory(dir=target) as tmp:
                out = Path(tmp) / encoded.name
                subprocess.run(
                    [
                        sys.executable,
                        str(packaging.ROOT / "scripts/assets/encode_ktx2.py"),
                        "--role",
                        role,
                        "--ktx",
                        str(ktx),
                        str(png),
                        str(out),
                    ],
                    check=True,
                )
                out.replace(encoded)
        shutil.copy2(png, target / png.name)
        textures.append(
            {
                "file": f"{asset_id}/{encoded.name}",
                "role": role,
                "sha256": packaging.digest(encoded),
                "width": 1024,
                "height": 1024,
                "samples": metrics["bake"][role]["samples"],
            }
        )
    old_id = packaging.ID
    packaging.ID = asset_id
    try:
        rows = [packaging.pack(stage, target, lod) for lod in (0, 1)]
    finally:
        packaging.ID = old_id
    contract = runtime_contract(tier)
    for r in rows:
        r["sockets"] = {
            "muzzleSocket": {
                "parent": "recoilGroup",
                "position": [contract[axis] for axis in ("x", "y", "z")],
                "tolerance": 0.000002,
            }
        }
        r["limits"].update(triangles=(4072 if r["lod"] == 0 else 1352), materials=1)
        r["material_textures"] = {
            f"Glacier T{tier} satin armor": {
                role: f"{asset_id}/{role}.ktx2" for role in packaging.MAPS
            }
        }
    for name in ("geometry.json", "low.blend", "high.blend"):
        shutil.copy2(stage / name, target / name)
    index = models / "manifest.json"
    data = (
        json.loads(index.read_text())
        if index.exists()
        else {"version": 1, "textures": [], "models": []}
    )
    assert data["version"] == 1
    data["textures"] = [
        r for r in data["textures"] if not r["file"].startswith(asset_id + "/")
    ] + textures
    data["models"] = [r for r in data["models"] if r["id"] != asset_id] + rows
    packaging.write_json(index, data)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tier", type=int, choices=(1, 2, 3), required=True)
    for arg in ("stage", "models", "ktx"):
        parser.add_argument("--" + arg, type=Path, required=True)
    args = parser.parse_args()
    package(args.stage.resolve(), args.models.resolve(), args.ktx.resolve(), args.tier)


if __name__ == "__main__":
    main()
