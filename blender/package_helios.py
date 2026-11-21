"""Reuse the mount packager with each Helios tier's muzzle and head-only budgets."""

import argparse
import re
import sys
from pathlib import Path

import package_surface_clamp as packaging


def runtime_contract(tier: int) -> dict:
    source = (packaging.ROOT / "src/content/turrets.ts").read_text()
    plasma = source.split("const PLASMA_MORTAR_TIERS:", 1)[1].split(
        "const CRYO_ARC_TIERS:", 1
    )[0]
    block = (
        plasma.split(f"T{tier}: {{", 1)[1]
        .split("blockout: {", 1)[1]
        .split("meshBudget:", 1)[0]
    )
    return {key: float(val) for key, val in re.findall(r"(\w+):\s*([0-9.]+)", block)}


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--tier", choices=(1, 2, 3), type=int, required=True)
    tier_args, common = parser.parse_known_args()
    tier = tier_args.tier
    asset_id = f"helios-plasma-mortar-t{tier}"
    original_id, pack = packaging.ID, packaging.pack
    original_args = sys.argv

    def record(stage: Path, target: Path, lod: int) -> dict:
        result = pack(stage, target, lod)
        contract = runtime_contract(tier)
        result["sockets"] = {
            "muzzleSocket": {
                "parent": "recoilGroup",
                "position": [contract[axis] for axis in ("x", "y", "z")],
                "tolerance": 0.000002,
            }
        }
        result["limits"].update(triangles=4072 if lod == 0 else 1352, materials=1)
        result["material_textures"] = {
            f"Helios T{tier} satin armor": {
                r: f"{asset_id}/{r}.ktx2" for r in packaging.MAPS
            }
        }
        return result

    try:
        sys.argv = [sys.argv[0], *common]
        packaging.ID, packaging.pack = asset_id, record
        packaging.main()
    finally:
        sys.argv = original_args
        packaging.ID, packaging.pack = original_id, pack


if __name__ == "__main__":
    main()
