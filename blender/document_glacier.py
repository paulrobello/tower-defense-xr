"""Bind editable sources, repeat builds, mount evidence and the review sheet to each Glacier export."""

import argparse
import json
import re
import subprocess
from pathlib import Path

from package_core_bastion import MAPS, ROOT, digest, write_json

SOURCE = [
    "assets-source/concepts/provenance.json",
    "assets-source/materials/provenance.json",
    "assets-source/concepts/sheets/cryo-arc.png",
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
            "glacier_shape",
            "glacier_cryo",
            "package_glacier",
            "review_glacier",
            "verify_glacier",
            "document_glacier",
            "helios_mortar",
            "helios_shape",
            "review_helios",
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
    folder: Path, stages: list[Path], packages: list[Path], final_stage: Path | None
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
            if final_stage and prefix == "stage":
                assert digest(final_stage / name) == a, ("final source replay", name)
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
            "final_source_replay": final_stage is not None,
            "matching_sha256": hashes,
            "generator_sha256": {
                name: digest(ROOT / name)
                for name in ("blender/glacier_cryo.py", "blender/glacier_shape.py")
            },
        },
    )


def view_errors(folder: Path) -> dict:
    results = {}
    for level in ("lod0", "lod1"):
        views = {}
        for view in ("oblique", "front", "side", "underside"):
            source = folder / "review" / f"high-{view}.png"
            imported = source.with_name(f"{level}-{view}.png")
            check = subprocess.run(
                [
                    "magick",
                    "compare",
                    "-metric",
                    "RMSE",
                    str(source),
                    str(imported),
                    "null:",
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            measured = re.search(r"\(([0-9.eE+-]+)\)\s*$", check.stderr)
            if check.returncode not in (0, 1) or measured is None:
                raise ValueError(f"Comparison of {imported} failed: {check.stderr}")
            views[view] = float(measured[1])
        results[level] = views
    return results


def evidence(folder: Path) -> None:
    tier = int(folder.name[-1])
    geo, checks = (read(folder / name) for name in ("geometry.json", "reimport.json"))
    repeat = read(folder / "determinism.json")
    assert repeat["final_source_replay"]
    build_sources = repeat["generator_sha256"]
    assert all(digest(ROOT / name) == value for name, value in build_sources.items())
    cameras = read(folder / "review/cameras.json")
    designs = [
        "one recessed, segmented cyan coil",
        "two separated chamfered electrodes with cyan inward faces",
        "three sleeved pylons enclosing a suspended faceted crystal",
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
    (folder / "README.md").write_text(f"""# Glacier Cryo-Arc T{tier}

The tier {tier} head has {designs[tier - 1]}. The effect socket faces forward at neutral aim. [Approved sheet](../../concepts/sheets/cryo-arc.png) · [Matched views](review/comparison.jpg) · [Surface clamp](review/mounted-surface-clamp.png) · [Hover pod](review/mounted-hover-pod.png)

| Mesh | Head triangles | With surface clamp | With hover pod |
| --- | ---: | ---: | ---: |
{geo_table}

Both levels use one 1024-pixel square atlas with embedded base color, tangent normal, packed ORM and emissive maps. The assembled turret takes two materials. Both mounts accept the identity head root. Runtime yaw, pitch and recoil drive separate nodes. The muzzle faces glTF +Z at rest. LOD1 begins beyond four meters.

[Re-import checks](reimport.json) measure each emitter, mount alignment, moving clearance at three poses, decoded face finish and glow, and UV overlap. The neutral pitching assembly clears the clamp by {1000 * checks["lod0"]["mounts"]["surface-clamp"]["neutral_moving_clearance_m"]:.1f} mm and the hover pod by {1000 * checks["lod0"]["mounts"]["hover-pod"]["neutral_moving_clearance_m"]:.1f} mm. Three scripted poses exercise the exported yaw, pitch and recoil controls. [Bake measurements](geometry.json) record UV coverage and density, projection repairs and source pixel samples. [Repeat build](determinism.json) compares two complete CPU bakes and KTX2 encodes. A fresh run from the final generator matched both uncompressed meshes, the four PNGs and the bake measurements. [Provenance](provenance.json) binds the exact staged files and review images. Owner review and in-game Quest acceptance remain pending.

## Rebuild

From the repository root, choose a new stage and model directory for each run. Use Blender 5.2.2 LTS and KTX-Software 4.4.2.

```sh
tier={tier}
for run in 1 2; do
  stage=".local/glacier-stage/$run/$tier"
  models=".local/glacier-models/$run"
  "$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/glacier_cryo.py -- --tier "$tier" --out "$stage"
  python3 -B blender/package_glacier.py --tier "$tier" --stage "$stage" --models "$models" --ktx "$KTX"
done
piece=".local/glacier-models/1/{folder.name}"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 -P blender/verify_glacier.py -- --piece "$piece" --ktx "$KTX" --repeat-stage ".local/glacier-stage/2/$tier"
RIFT_MODEL_CHECK_KTX="$KTX" make model-check MODEL_CHECK_ARGS="--manifest .local/glacier-models/1/manifest.json --ktx $KTX"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 -P blender/review_glacier.py -- --piece "$piece" --ktx "$KTX"
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/glacier_cryo.py -- --tier "$tier" --out ".local/glacier-stage/final/$tier"
python3 -B blender/document_glacier.py --piece "$piece" --final-stage ".local/glacier-stage/final/$tier" --stages ".local/glacier-stage/1/$tier" ".local/glacier-stage/2/$tier" --packages "$piece" ".local/glacier-models/2/{folder.name}"
```
""")
    write_json(
        folder / "provenance.json",
        {
            "piece": folder.name,
            "stage": "P3-T5c staged candidate",
            "authoring": {
                "model": "GPT-6.2 Astra",
                "reasoning_effort": "high",
                "date": "2026-11-20",
                "tool": "Blender 5.2.2 LTS",
            },
            "approved_reference": {
                "owner": "Paul Robello",
                "date": "2026-11-20",
                "direction": "Bastion Rib and Glacier Cryo-Arc concept sheet",
            },
            "rights": {
                "model": "Original project-authored decorative game geometry",
                "material_library": "Original Rift Bastion finishes and Glacier arc colors",
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
                "orm_uastc": "quality 3, RDO off to preserve the brushed-titanium AO probe"
                if tier == 1
                else "quality 2, RDO on",
            },
            "technical_checks": {
                "reimport": "reimport.json",
                "geometry": "geometry.json",
                "repeat": "determinism.json",
                "decoded_models": "scripts/validate_glbs.py",
                "normalized_high_to_lod_image_rmse": view_errors(folder),
            },
            "design_notes": {
                1: "The recessed cold coil has a segmented cyan face and a protective lip at 1.45 times nominal coil radius.",
                2: "The fork preserves the source width between electrode centers. Each broad collar reaches the nominal electrode radius.",
                3: "The initial three-pylon assembly was revised with the concept sheet’s recessed cyan suspension well behind the faceted crystal before packaging.",
            }[tier],
            "corrections": [
                "The first LOD1 comparison exposed a broad silver strip where a casing profile row had been dropped. Both LODs now preserve all casing finish boundaries."
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
    parse.add_argument("--final-stage", type=Path)
    parse.add_argument("--repeat-only", action="store_true")
    args = parse.parse_args()
    if args.stages or args.packages:
        assert args.stages and args.packages
        determinism(args.piece, args.stages, args.packages, args.final_stage)
    if not args.repeat_only:
        assert (args.piece / "determinism.json").is_file()
        evidence(args.piece)


if __name__ == "__main__":
    main()
