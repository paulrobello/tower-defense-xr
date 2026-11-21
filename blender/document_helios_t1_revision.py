"""Bind the two clean builds, current mounts and camera evidence to the staged T1."""

import argparse
import ast
import json
from pathlib import Path

from document_helios import SOURCE
from package_core_bastion import MAPS, ROOT, digest, write_json

BASELINE = "4f18f1fee8c46f934bc4f980e4bf9b816b652e88"


def source_files() -> list[str]:
    files = {
        name.replace("/hover-pod/", "/hover-pod-revision/")
        for name in SOURCE
        if not name.startswith("blender/")
    }
    pending = list((ROOT / "blender").glob("*helios*t1*revision*.py"))
    while pending:
        script = pending.pop()
        key = str(script.relative_to(ROOT))
        if key in files:
            continue
        files.add(key)
        for node in ast.walk(ast.parse(script.read_text())):
            names = (
                [alias.name for alias in node.names]
                if isinstance(node, ast.Import)
                else [node.module]
                if isinstance(node, ast.ImportFrom) and node.module
                else []
            )
            for name in names:
                child = script.with_name(name.split(".")[0] + ".py")
                if child.is_file() and str(child.relative_to(ROOT)) not in files:
                    pending.append(child)
    return sorted(files)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--piece", type=Path, required=True)
    parser.add_argument("--original", type=Path, required=True)
    args = parser.parse_args()
    p, old = args.piece.resolve(), args.original.resolve()
    comparison = p / "review/revision-comparison.jpg"
    assert comparison.is_file()
    archive = p / "review/prior-reimport.json.orig"
    archive.write_bytes((old / "reimport.json").read_bytes())
    evidence = json.loads((p / "reimport.json").read_text())
    repeat = json.loads((p / "determinism.json").read_text())
    cameras = json.loads((p / "review/cameras.json").read_text())
    assert (
        cameras["heads"]
        == json.loads((old / "review/cameras.json").read_text())["heads"]
    )
    for path, value in repeat["independent_portable_output_hashes"].items():
        assert digest(p / path) == value
    reviewed = {
        "lod0": "bd90a619dabd3e48157e64b0a20bb78c33fb04cf2992bbd5c02c631d95e0f7c5",
        "lod1": "acb97ddf626e3f1b7f7e155a89165c6d3041f756b0fb66434e35b66f319b042d",
    }
    for level in ("lod0", "lod1"):
        assert evidence[level]["sha256"] == reviewed[level]
        for mount in evidence[level]["mounts"].values():
            assert digest(ROOT / mount["path"]) == mount["mount_sha256"]
    write_json(
        p / "provenance.json",
        {
            "piece": p.name,
            "stage": "P3-T7 F6 staged revision of P3-T5b",
            "authoring": {
                "model": "GPT-6.2 Astra",
                "reasoning_effort": "high",
                "date": "2026-11-21",
                "tool": "Blender 5.2.2 LTS (d13f752e3b9c)",
            },
            "revision_of": {
                "git_commit": BASELINE,
                "initial_visual_score": 76,
                "reimport_archive": str(archive.relative_to(p)),
                "previous_glb_sha256": {
                    lod: digest(old / f"{p.name}-{lod}.glb") for lod in ("lod0", "lod1")
                },
            },
            "approved_reference": {
                "owner": "Paul Robello",
                "date": "2026-11-20",
                "direction": "Bastion Rib and Helios Plasma Mortar concept sheet",
            },
            "rights": {
                "model": "Original project-authored game geometry",
                "textures": "Original Rift Bastion finishes and Helios plasma colors",
                "project_license": "MIT (package.json)",
            },
            "corrections": [
                "The previous T1 LOD1 collapsed the recess into a peach disk. The rim, dark tapered well and smaller inset bright core are now separate physical profile regions at all three levels.",
                "Revised curved normals and explicit finish boundaries counter the original triangular highlights on the pressure vessel.",
            ],
            "outputs": {
                "bake": "Cycles CPU, two threads. High-to-low tangent and material projection, receiver finish repair and assembled AO.",
                "encoding": "KTX-Software 4.4.2, one encode thread. Four 1024 px maps shared between LODs. Both GLBs embed original PNG fallback and KTX2.",
                "review": {
                    "engine": "EEVEE",
                    "backend": cameras["gpu_backend"],
                    "renderer": cameras["gpu_renderer"],
                    "samples": 16,
                    "resolution": [624, 624],
                    "glb_sha256": {
                        lod: evidence[lod]["sha256"] for lod in ("lod0", "lod1")
                    },
                    "comparison": str(comparison.relative_to(p)),
                    "camera_record": "review/cameras.json",
                },
            },
            "technical_checks": {
                "reimport": "reimport.json",
                "blend_repeat_and_export_hashes": "determinism.json",
                "geometry_and_bakes": "geometry.json",
                "all_mip_chains_decoded": all(
                    evidence["decoded_mip_chains"][r]["levels_decoded"] == 11
                    for r in MAPS
                ),
            },
            "creative_score": 83,
            "independent_visual_review": {
                "date": "2026-11-21",
                "score_out_of_100": 83,
                "reviewed_glbs": reviewed,
                "observations": "The revised dark opening and orange lip read at both LODs. The LOD1 shell retains gray mottling and the pivot corners remain visible.",
            },
            "owner_approval": "pending",
            "runtime_quest": "pending P4 runtime integration",
            "source_sha256": {name: digest(ROOT / name) for name in source_files()},
            "output_sha256": {
                str(path.relative_to(p)): digest(path)
                for path in sorted(p.rglob("*"))
                if path.is_file() and path.name != "provenance.json"
            },
        },
    )


if __name__ == "__main__":
    main()
