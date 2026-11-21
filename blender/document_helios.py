"""Bind editable sources, repeat builds, mount evidence and the review sheet to each Helios export."""

import argparse
import json
from pathlib import Path

from package_core_bastion import MAPS, ROOT, digest, write_json

FAMILY = "helios-plasma-mortar"
SOURCE = [
    "assets-source/concepts/provenance.json",
    "assets-source/materials/provenance.json",
    "assets-source/concepts/sheets/plasma-mortar.png",
    "assets-source/concepts/boards/bastion-rib.png",
    "docs/art-bible.md",
    "docs/blender-kit-project.md",
    "plans/phase-3-art-direction-and-blender-assets.md",
    "src/content/turrets.ts",
    "src/render/blockouts.ts",
    "scripts/assets/model-check.md",
    "scripts/validate_glbs.py",
    "scripts/assets/ktx2.py",
    "scripts/assets/encode_ktx2.py",
    "package.json",
    *[
        f"blender/{name}.py"
        for name in (
            "helios_shape",
            "helios_mortar",
            "package_helios",
            "review_helios",
            "verify_helios",
            "document_helios",
            "m44_shape",
            "m44_uv",
            "verify_m44",
            "package_m44",
            "review_m44",
            "core_bastion",
            "core_bastion_shape",
            "materials",
            "surface_fields",
            "build_materials",
            "hover_pod_bake",
            "surface_clamp_bake",
            "package_surface_clamp",
            "package_core_bastion",
            "review_core_bastion",
            "review_surface_clamp",
            "review_materials",
            "verify_core_bastion",
            "verify_surface_clamp",
            "surface_clamp_shape",
        )
    ],
    *[
        f"assets-source/materials/{finish}/{role}.png"
        for finish in ("tactical-ceramic", "brushed-titanium", "dark-gunmetal")
        for role in ("basecolor", "normal", "orm")
    ],
    *[
        f"assets-source/models/{mount}/{mount}-lod{level}.glb"
        for mount in ("surface-clamp", "hover-pod")
        for level in (0, 1)
    ],
    *[
        f"assets-source/models/{mount}/{role}.{ext}"
        for mount in ("surface-clamp", "hover-pod")
        for role in MAPS
        for ext in ("png", "ktx2")
    ],
]


def read(path: Path) -> dict:
    return json.loads(path.read_text())


def determinism(
    folder: Path, stages: list[Path], packages: list[Path], source_replay: Path
) -> None:
    hashes = {}
    for prefix, dirs, names in [
        (
            "stage",
            stages,
            [
                "geometry.json",
                *[f"{r}.png" for r in MAPS],
                *[
                    f"lod{level}/source.{ext}"
                    for level in (0, 1)
                    for ext in ("bin", "gltf")
                ],
            ],
        ),
        (
            "models",
            packages,
            [
                *[f"{r}.ktx2" for r in MAPS],
                *[f"{folder.name}-lod{i}.glb" for i in (0, 1)],
            ],
        ),
    ]:
        for name in names:
            a, b = (digest(p / name) for p in dirs)
            assert a == b, name
            if prefix == "stage":
                assert digest(source_replay / name) == a, ("final source replay", name)
            hashes[f"{prefix}/{name}"] = a
    write_json(
        folder / "determinism.json",
        {
            "blender": "5.2.2 LTS (d13f752e3b9c)",
            "ktx_software": "4.4.2",
            "architecture": "Linux x86_64 CPU",
            "blender_threads": 2,
            "encode_threads": 1,
            "independent_builds": 2,
            "matching_sha256": hashes,
            "final_source_replay_sha256": {
                name: digest(ROOT / name)
                for name in ("blender/helios_mortar.py", "blender/helios_shape.py")
            },
        },
    )


def evidence(folder: Path) -> None:
    tier = int(folder.name[-1])
    geo, checks = (read(folder / name) for name in ("geometry.json", "reimport.json"))
    replay_sources = read(folder / "determinism.json")["final_source_replay_sha256"]
    assert all(digest(ROOT / name) == value for name, value in replay_sources.items())
    cameras = read(folder / "review/cameras.json")
    designs = [
        "one broad orange crucible",
        "a pair of linked, rounded-square cells",
        "two round thermal chambers surrounded by a wide siege crown",
    ]

    def row(lod: int) -> str:
        key = f"lod{lod}"
        n = geo[key]["triangles"]
        mounts = [
            read(ROOT / f"assets-source/models/{m}/geometry.json")[key]["triangles"]
            for m in ("surface-clamp", "hover-pod")
        ]
        return f"| LOD{lod} | {n:,} | {n + mounts[0]:,} | {n + mounts[1]:,} |"

    geo_table = "\n".join(row(i) for i in (0, 1))
    (folder / "README.md").write_text(f"""# Helios Plasma Mortar T{tier}

The tier {tier} head has {designs[tier - 1]}. The bright rim tracks the inclination of the orange plasma surface. Its central effect socket retains the game's neutral forward direction. [Approved sheet](../../concepts/sheets/plasma-mortar.png) · [Matched views](review/comparison.jpg) · [Surface clamp](review/mounted-surface-clamp.png) · [Hover pod](review/mounted-hover-pod.png)

| Mesh | Head triangles | With surface clamp | With hover pod |
| --- | ---: | ---: | ---: |
{geo_table}

Both levels use one 1024-pixel square atlas with embedded base color, tangent normal, packed ORM and emissive maps. The assembled turret takes two materials. Both mounts accept the identity head root. Runtime yaw, pitch and recoil drive separate nodes. The muzzle faces glTF +Z at rest. LOD1 begins beyond four meters.

[Re-import checks](reimport.json) measure each chamber rim, mount alignment, face finish and glow, and UV overlap. The neutral pitching assembly clears the clamp by {1000 * checks["lod0"]["mounts"]["surface-clamp"]["neutral_moving_clearance_m"]:.1f} mm and the hover pod by {1000 * checks["lod0"]["mounts"]["hover-pod"]["neutral_moving_clearance_m"]:.1f} mm. Three scripted poses exercise the exported yaw, pitch and recoil controls. [Bake measurements](geometry.json) record UV coverage and density, projection repairs and source pixel samples. [Repeat build](determinism.json) compares two complete CPU bakes and KTX2 encodes. A third clean run of the final generator also matched both uncompressed geometry exports, all four PNGs and the bake measurements. [Provenance](provenance.json) binds the exact staged files and review images. Owner review and in-game Quest acceptance remain pending.

## Rebuild

From the repository root, choose a new stage and model directory for each run. Use Blender 5.2.2 LTS and KTX-Software 4.4.2.

```sh
tier={tier}
for run in 1 2; do
  stage=".local/helios-stage/$run/$tier"
  models=".local/helios-models/$run"
  "$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/helios_mortar.py -- --tier "$tier" --out "$stage"
  python3 -B blender/package_helios.py --tier "$tier" --stage "$stage" --models "$models" --ktx "$KTX"
done
piece=".local/helios-models/1/{folder.name}"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 -P blender/verify_helios.py -- --piece "$piece" --ktx "$KTX" --repeat-stage ".local/helios-stage/2/$tier"
RIFT_MODEL_CHECK_KTX="$KTX" make model-check MODEL_CHECK_ARGS="--manifest .local/helios-models/1/manifest.json --ktx $KTX"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 -P blender/review_helios.py -- --piece "$piece" --ktx "$KTX"
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/helios_mortar.py -- --tier "$tier" --out ".local/helios-stage/final/$tier"
python3 -B blender/document_helios.py --piece "$piece" --source-replay ".local/helios-stage/final/$tier" --stages ".local/helios-stage/1/$tier" ".local/helios-stage/2/$tier" --packages "$piece" ".local/helios-models/2/{folder.name}"
```
""")
    write_json(
        folder / "provenance.json",
        {
            "piece": folder.name,
            "stage": "P3-T5b staged candidate",
            "authoring": {
                "model": "GPT-6.2 Astra",
                "reasoning_effort": "high",
                "date": "2026-11-20",
                "tool": "Blender 5.2.2 LTS",
            },
            "approved_reference": {
                "owner": "Paul Robello",
                "date": "2026-11-20",
                "direction": "Bastion Rib and Helios Plasma Mortar concept sheet",
            },
            "rights": {
                "model": "Original project-authored decorative game geometry",
                "material_library": "Original Rift Bastion finishes and Helios plasma colors",
                "project_license": "MIT (package.json)",
            },
            "outputs": {
                "high": geo["high"],
                "review": {
                    "renderer": "EEVEE",
                    "backend": cameras["gpu_backend"],
                    "device": cameras["gpu_renderer"],
                    "samples": 16,
                    "resolution": [624, 624],
                },
                "bake": "Cycles CPU. Component-isolated normal and material projection plus assembled contact AO. Physical receiver material restores projection misses and cross-finish rays.",
                "encoding": "KTX-Software 4.4.2 UASTC and Zstandard, top-left and full mip chains. Embedded source PNG fallbacks.",
            },
            "technical_checks": {
                "reimport": "reimport.json",
                "geometry": "geometry.json",
                "repeat": "determinism.json",
                "decoded_models": "scripts/validate_glbs.py",
            },
            "corrections": [
                "First EEVEE review exposed a plain pressure-vessel flank. Added fork cheeks and capped pitch trunnions to all tiers. Linked the two T2 cells with a distinct ceramic bridge and reran the full bake and export twice."
            ],
            "creative_score": None,
            "owner_approval": "pending",
            "runtime_quest": "pending P4 runtime integration",
            "source_sha256": {s: digest(ROOT / s) for s in SOURCE},
            "output_sha256": {
                str(p.relative_to(folder)): digest(p)
                for p in sorted(folder.rglob("*"))
                if p.is_file() and p.name != "provenance.json"
            },
        },
    )


def main() -> None:
    parse = argparse.ArgumentParser()
    parse.add_argument("--piece", type=Path, required=True)
    parse.add_argument("--stages", type=Path, nargs=2)
    parse.add_argument("--packages", type=Path, nargs=2)
    parse.add_argument("--source-replay", type=Path)
    parse.add_argument("--repeat-only", action="store_true")
    args = parse.parse_args()
    if args.stages or args.packages:
        assert args.stages and args.packages and args.source_replay
        determinism(args.piece, args.stages, args.packages, args.source_replay)
    if not args.repeat_only:
        assert (args.piece / "determinism.json").is_file()
        evidence(args.piece)


if __name__ == "__main__":
    main()
