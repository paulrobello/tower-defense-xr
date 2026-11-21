"""Bind the two independent builds, decoded checks and Metal views to each Valkyrie tier."""

import argparse
import subprocess
from pathlib import Path

from document_glacier import SOURCE as GLACIER_INPUTS
from document_glacier import read, view_errors
from package_core_bastion import MAPS, ROOT, digest, write_json

TOOLS = [
    "valkyrie_shape",
    "valkyrie_rail",
    "package_valkyrie",
    "review_valkyrie",
    "verify_valkyrie",
    "document_valkyrie",
]
INPUTS = [
    item
    for item in GLACIER_INPUTS
    if "/glacier" not in item
    and "cryo-arc.png" not in item
    and not any(
        name in item for name in ("package_glacier", "review_glacier", "verify_glacier")
    )
] + [
    "assets-source/concepts/sheets/rail-sniper.png",
    "blender/glacier_shape.py",
    *[f"blender/{module}.py" for module in TOOLS],
    "biome.json",
    "bun.lock",
]
DESIGNS = {
    1: "The compact single rail has a fine cobalt ribbon with a blue-white center recessed between two silver edges.",
    2: "A longer rail runs between a separate swept dorsal fin and ventral fin. Dark divisions cross the two fins.",
    3: "Two distinct runners surround an open slot. The bright inlays face each other across the slot.",
}


def document(
    piece: Path,
    tiers: list[Path],
    packages: list[Path],
    technical_only: bool = False,
    final_stage: Path | None = None,
    paired_source: Path | None = None,
) -> None:
    tier = int(piece.name[-1])
    if not technical_only:
        assert final_stage is not None, (
            "Final review requires replaying the checked-in generator."
        )
    paired_source = paired_source or ROOT / "blender"
    stages = [
        "geometry.json",
        *[f"{r}.png" for r in MAPS],
        *[
            f"lod{level}/source.{extension}"
            for level in (0, 1)
            for extension in ("gltf", "bin")
        ],
    ]
    outputs = [
        *[f"{r}.ktx2" for r in MAPS],
        *[f"{piece.name}-lod{level}.glb" for level in (0, 1)],
    ]
    hashes = {}
    for prefix, dirs, names in (
        ("stage", tiers, stages),
        ("models", packages, outputs),
    ):
        for name in names:
            a, b = [digest(d / name) for d in dirs]
            assert a == b, (prefix, name)
            if prefix == "models" or name == "geometry.json" or name.endswith(".png"):
                assert digest(piece / name) == a
            if prefix == "stage" and final_stage is not None:
                assert digest(final_stage / name) == a, ("final source replay", name)
            hashes[f"{prefix}/{name}"] = a
    write_json(
        piece / "determinism.json",
        {
            "blender": "5.2.2 LTS (d13f752e3b9c)",
            "ktx_software": "4.4.2",
            "architecture": "Linux x86_64 CPU",
            "blender_threads": 2,
            "encode_threads": 1,
            "independent_builds": 2,
            "final_source_replay": final_stage is not None,
            "paired_build_generator_sha256": {
                f"blender/{n}.py": digest(paired_source / f"{n}.py") for n in TOOLS[:2]
            },
            "matching_sha256": hashes,
            "generator_sha256": {
                f"blender/{n}.py": digest(ROOT / f"blender/{n}.py") for n in TOOLS[:2]
            },
        },
    )
    checks, runs = read(piece / "reimport.json"), read(piece / "geometry.json")
    assert checks["combined_positive_area_uv_overlaps"] == 0
    for level in ("lod0", "lod1"):
        assert checks[level]["sha256"] == hashes[f"models/{piece.name}-{level}.glb"]
    if technical_only:
        return
    cameras = read(piece / "review/cameras.json")
    assert cameras["gpu_backend"] == "METAL"
    mount_names = ("surface-clamp", "hover-pod")
    mounts = [
        read(ROOT / f"assets-source/models/{m}/geometry.json") for m in mount_names
    ]
    rows = []
    for level in ("lod0", "lod1"):
        n = runs[level]["triangles"]
        rows.append(
            f"| {level.upper()} | {n:,} | {n + mounts[0][level]['triangles']:,} | {n + mounts[1][level]['triangles']:,} |"
        )
    table = "\n".join(rows)
    clearance = min(
        min(checks[level]["mounts"][mount]["posed_moving_clearances_m"])
        for level in ("lod0", "lod1")
        for mount in mount_names
    )
    slot = checks["lod0"]["emitters"].get("clear_slot_min_width_m")
    slot_note = (
        f" The unobstructed T3 slot is at least {slot * 1000:.1f} mm wide."
        if slot
        else ""
    )
    (piece / "README.md").write_text(f"""# Valkyrie Rail Sniper T{tier}

{DESIGNS[tier]}{slot_note} [Approved concept](../../concepts/sheets/rail-sniper.png) · [Matched high and both LODs](review/comparison.jpg) · [Clamp](review/mounted-surface-clamp.png) · [Hover pod](review/mounted-hover-pod.png)

| Mesh | Head triangles | With surface clamp | With hover pod |
| --- | ---: | ---: | ---: |
{table}

The root attaches at identity on both mounts. Separate yaw, pitch and recoil nodes carry the muzzle socket, which faces glTF +Z at rest. Four sampled poses include full 55 mm recoil. The smallest verified lower bound on moving-head clearance across both LODs and mounts is {clearance * 1000:.1f} mm. The head uses one material, and either assembled turret uses two. Both LODs share four portable 1024 px maps. LOD1 starts beyond four meters.

[Exact re-import and decoded texel probes](reimport.json) · [Bake and geometry measurements](geometry.json) · [Two independent export and encode runs plus a final-source bake replay](determinism.json) · [Authorship and hashes](provenance.json)

## Rebuild

Run the following from the repository root using Blender 5.2.2 LTS and KTX-Software 4.4.2. Run the review command on a Metal host with ImageMagick and Fontconfig.

```sh
tier={tier}
for run in 1 2; do
  stage=".local/valkyrie-stage/$run/$tier"
  models=".local/valkyrie-models/$run"
  "$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/valkyrie_rail.py -- --tier "$tier" --out "$stage"
  python3 -B blender/package_valkyrie.py --tier "$tier" --stage "$stage" --models "$models" --ktx "$KTX"
done
piece=".local/valkyrie-models/1/{piece.name}"
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/verify_valkyrie.py -- --piece "$piece" --ktx "$KTX" --repeat-stage ".local/valkyrie-stage/2/$tier"
python3 scripts/validate_glbs.py --manifest .local/valkyrie-models/1/manifest.json --ktx "$KTX"
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/review_valkyrie.py -- --piece "$piece" --ktx "$KTX"
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/valkyrie_rail.py -- --tier "$tier" --out ".local/valkyrie-stage/final/$tier"
python3 -B blender/document_valkyrie.py --piece "$piece" --final-stage ".local/valkyrie-stage/final/$tier" --stages ".local/valkyrie-stage/1/$tier" ".local/valkyrie-stage/2/$tier" --packages "$piece" ".local/valkyrie-models/2/{piece.name}"
```
""")
    write_json(
        piece / "provenance.json",
        {
            "piece": piece.name,
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
                "direction": "Bastion Rib and Valkyrie Rail Sniper concept sheet",
            },
            "rights": {
                "model": "Original project-authored decorative game geometry",
                "material_library": "Original Rift Bastion finishes and Valkyrie cobalt-white inlays",
                "project_license": "MIT (package.json)",
            },
            "outputs": {
                "high": runs["high"],
                "review": {
                    "renderer": "EEVEE",
                    "backend": cameras["gpu_backend"],
                    "device": cameras["gpu_renderer"],
                    "samples": 16,
                    "resolution": [624, 624],
                },
                "bake": "Cycles CPU, isolated normal and finish projection, assembled contact AO, physical receiver correction.",
                "encoding": "KTX-Software 4.4.2 UASTC, Zstandard and a full top-left mip chain. Four embedded PNG fallbacks.",
            },
            "technical_checks": {
                "reimport": "reimport.json",
                "geometry": "geometry.json",
                "repeat": "determinism.json",
                "decoded_models": "scripts/validate_glbs.py",
                "normalized_high_to_lod_image_rmse": view_errors(piece),
            },
            "design_notes": DESIGNS[tier],
            "corrections": [
                "A matched side and oblique review exposed a capsule silhouette and visually continuous side band. The final housing has a recessed graphite cheek, closed titanium perimeter and central silver rib. The author retained the same meter envelope and all gameplay pivots.",
                "The initial LOD1 profile removed a carbon-to-gunmetal border at the rail root. The final LOD1 retains that station. Both final builds use the restored profile, and the decoded re-import samples both sides of the border.",
                *(
                    [
                        "The tier-two fins were raised and lowered symmetrically to expose their separate silhouettes."
                    ]
                    if tier == 2
                    else []
                ),
            ],
            "verification_notes": [
                "On the earlier T3 LOD1, Blender's float32 BVH placed forward-assembly face 844 at 3.016381697 micrometers from source triangle 1284. Reopening the exported face and original physical source showed the same Y plane, a float64 point-to-plane distance of zero, and interior barycentric weights 0.33313, 0.33351 and 0.33336. The checker recomputes only on that same candidate triangle and preserves the original 3 micrometer tolerance."
            ]
            if tier == 3
            else [],
            "creative_score": None,
            "owner_approval": "pending",
            "runtime_quest": "pending P4 runtime integration",
            "source_sha256": {s: digest(ROOT / s) for s in sorted(set(INPUTS))},
            "output_sha256": {
                str(f.relative_to(piece)): digest(f)
                for f in sorted(piece.rglob("*"))
                if f.is_file() and f.name != "provenance.json"
            },
        },
    )

    provenance = piece / "provenance.json"
    formatted = subprocess.run(
        [
            str(ROOT / "node_modules/.bin/biome"),
            "format",
            "--stdin-file-path",
            f"assets-source/models/{piece.name}/provenance.json",
        ],
        cwd=ROOT,
        input=provenance.read_bytes(),
        capture_output=True,
        check=True,
    )
    provenance.write_bytes(formatted.stdout)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for key in ("stages", "packages"):
        parser.add_argument("--" + key, type=Path, nargs=2, required=True)
    parser.add_argument("--piece", type=Path, required=True)
    parser.add_argument("--technical-only", action="store_true")
    parser.add_argument("--final-stage", type=Path)
    parser.add_argument("--paired-source", type=Path)
    args = parser.parse_args()
    document(
        args.piece,
        args.stages,
        args.packages,
        args.technical_only,
        args.final_stage,
        args.paired_source,
    )
