"""Bind the fork revision, two Linux builds, active mounts and matched review frames."""

import argparse
import json
from pathlib import Path

from document_glacier import SOURCE, view_errors
from package_core_bastion import MAPS, ROOT, digest, write_json

BASELINE = "4f18f1fee8c46f934bc4f980e4bf9b816b652e88"


def read(path: Path) -> dict:
    return json.loads(path.read_text())


def matches(dirs: list[Path], names: list[str]) -> dict:
    assert len(dirs) == 2 and dirs[0].resolve() != dirs[1].resolve()
    result = {}
    for name in names:
        a, b = (digest(d / name) for d in dirs)
        assert a == b, name
        result[name] = a
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--piece", required=True, type=Path)
    parser.add_argument("--prior", required=True, type=Path)
    parser.add_argument("--stages", required=True, type=Path, nargs=2)
    parser.add_argument("--packages", required=True, type=Path, nargs=2)
    args = parser.parse_args()
    p, old = args.piece.resolve(), args.prior.resolve()
    proof = read(p / "reimport.json")
    build_hashes = matches(
        args.stages,
        [
            "geometry.json",
            *[f"{r}.png" for r in MAPS],
            *[f"lod{i}/source.{ext}" for i in (0, 1) for ext in ("gltf", "bin")],
        ],
    )
    portable = matches(
        args.packages,
        [
            *[f"{r}.{ext}" for r in MAPS for ext in ("png", "ktx2")],
            *[f"{p.name}-lod{i}.glb" for i in (0, 1)],
        ],
    )
    assert all(digest(p / name) == value for name, value in portable.items())
    assert digest(p / "geometry.json") == build_hashes["geometry.json"]
    for level, src in proof["editable_sources"].items():
        first = args.stages[0] / f"{level}.blend"
        second = args.stages[1] / f"{level}.blend"
        assert digest(first) == src["sha256"] == digest(p / first.name)
        assert digest(second) == src["repeat_archive_sha256"]
    write_json(
        p / "determinism.json",
        {
            "independent_builds": 2,
            "architecture": "Linux x86_64 CPU",
            "blender": "5.2.2 LTS d13f752e3b9c",
            "ktx_software": "4.4.2",
            "blender_threads": 2,
            "encode_threads": 1,
            "generator_sha256": {
                f"blender/{n}": digest(ROOT / "blender" / n)
                for n in [
                    "glacier_cryo.py",
                    "glacier_shape.py",
                    "glacier_t2_revision.py",
                ]
            },
            "independent_stage_output_hashes": build_hashes,
            "independent_portable_output_hashes": portable,
            "editable_source_checks": proof["editable_sources"],
        },
    )
    geo = read(p / "geometry.json")
    cameras = read(p / "review/cameras.json")
    prior_cameras = read(old / "review/cameras.json")
    assert all(cameras[k] == prior_cameras[k] for k in ("heads", "assemblies"))
    for key, origin in (("prior", old), ("revision", p)):
        for name, value in cameras["resolved_packages"][key].items():
            assert (
                digest((ROOT if name.startswith("assets-source/") else origin) / name)
                == value
            )
    archive = p / "review/prior-reimport.json.orig"
    assert archive.read_bytes() == (old / "reimport.json").read_bytes()
    for level in ("lod0", "lod1"):
        for mount in proof[level]["mounts"].values():
            assert digest(ROOT / mount["active_file"]) == mount["mount_sha256"]
        assert proof[level]["sha256"] == digest(p / f"{p.name}-{level}.glb")
    reviewed = {
        "lod0": "bd46f13a9f0dd74d7a3279a62ab3a7a897a81bed1507fd66d7052f555d9cca77",
        "lod1": "3572096d78e177d0becbf03a0c9e859a11d107a43da296afac31e73fc2d534c1",
    }
    assert all(proof[level]["sha256"] == value for level, value in reviewed.items())
    review_sheet = "9153daf5cee26646d4fdc9eb9d053bde05df2554111d0e7d8ddc969e93d461ae"
    assert digest(p / "review/revision-comparison.jpg") == review_sheet
    sources = {s.replace("/hover-pod/", "/hover-pod-revision/") for s in SOURCE}
    sources.update(
        str(file.relative_to(ROOT))
        for file in (ROOT / "blender").glob("*glacier*t2*revision*.py")
    )
    source_hashes = {name: digest(ROOT / name) for name in sorted(sources)}
    assert all(
        "hover-pod/provenance" not in s and "hover-pod-revision/provenance" not in s
        for s in sources
    )
    write_json(
        p / "provenance.json",
        {
            "piece": p.name,
            "stage": "P3-T7 F7 revision of P3-T5c",
            "authoring": {
                "model": "GPT-6.2 Astra",
                "reasoning_effort": "high",
                "date": "2026-11-21",
                "tool": "Blender 5.2.2 LTS",
            },
            "revision_of": {
                "git_commit": BASELINE,
                "initial_visual_score": 75,
                "reimport_archive": str(archive.relative_to(p)),
                "previous_glb_sha256": {
                    level: digest(old / f"{p.name}-{level}.glb")
                    for level in ("lod0", "lod1")
                },
            },
            "rights": read(old / "provenance.json")["rights"],
            "approved_reference": read(old / "provenance.json")["approved_reference"],
            "design_notes": "The recessed upper housing exposes two tapering blades. Each has a stepped cyan inner channel, titanium outboard edge and dark nose.",
            "outputs": {
                "high": geo["high"],
                "bake": "Cycles CPU, two independent full 1024 px bakes with isolated tangent/material projection and assembled AO.",
                "encoding": "UASTC and Zstandard with embedded PNG fallbacks.",
                "review": {
                    "engine": "EEVEE",
                    "backend": cameras["gpu_backend"],
                    "width_px": 624,
                    "height_px": 624,
                    "samples": 16,
                    "matched_review_sheet": "review/revision-comparison.jpg",
                    "glb_sha256": {
                        level: proof[level]["sha256"] for level in ("lod0", "lod1")
                    },
                },
            },
            "technical_checks": {
                "geometry": "geometry.json",
                "reimport": "reimport.json",
                "repeat": "determinism.json",
                "camera_matrices_and_reviewed_geometry": "review/cameras.json",
                "normalized_high_to_lod_image_rmse": view_errors(p),
            },
            "creative_score": 87,
            "independent_visual_review": {
                "date": "2026-11-21",
                "score_out_of_100": 87,
                "reviewed_glbs": reviewed,
                "comparison_sheet_sha256": review_sheet,
                "observations": "The cyan area appears smaller head-on. At the exact side profile, one blade occludes the other.",
            },
            "owner_approval": "pending",
            "runtime_quest": "pending P4 runtime integration",
            "source_sha256": source_hashes,
            "output_sha256": {
                str(f.relative_to(p)): digest(f)
                for f in sorted(p.rglob("*"))
                if f.is_file() and f.name != "provenance.json"
            },
        },
    )


if __name__ == "__main__":
    main()
