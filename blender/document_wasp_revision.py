"""Bind the reviewed exports to their repeated Linux builds and decoded checks."""

import argparse
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True

from package_core_bastion import MAPS, ROOT, digest, write_json

BASELINE = "e80efd5d81134743c691656cbbc262ebd9be5fdf"


def main() -> None:
    parser = argparse.ArgumentParser()
    for arg in ("piece", "original", "first", "second"):
        parser.add_argument("--" + arg, type=Path, required=True)
    args = parser.parse_args()
    piece, old, a, b = [
        getattr(args, k).resolve() for k in ("piece", "original", "first", "second")
    ]
    assert a != b
    prior = json.loads((old / "provenance.json").read_text())
    check = json.loads((piece / "reimport.json").read_text())
    cams = json.loads((piece / "review/cameras.json").read_text())
    runs = [json.loads((p / "reimport.json").read_text()) for p in (a, b)]
    sources = [r.pop("sources") for r in runs]
    assert runs[0] == runs[1]
    assert {k: v for k, v in check.items() if k != "sources"} == runs[0]
    for n in ("high.blend", "low.blend"):
        assert sources[0][n] == check["sources"][n]
        assert digest(a / n) == digest(piece / n) == sources[0][n]["file_sha256"]
        assert digest(b / n) == sources[1][n]["file_sha256"]
        key = "logical_geometry_hierarchy_skin_animation_sha256"
        assert sources[0][n][key] == sources[1][n][key]
    paths = [
        "geometry.json",
        *[f"{r}.{ext}" for r in MAPS for ext in ("png", "ktx2")],
        *[f"wasp-skimmer-lod{i}.glb" for i in (0, 1)],
    ]
    repeated = {n: digest(a / n) for n in paths}
    assert all(digest(b / n) == digest(piece / n) == s for n, s in repeated.items())
    for lod in ("lod0", "lod1"):
        expected = repeated[f"wasp-skimmer-{lod}.glb"]
        assert cams["revised_glb_sha256"][lod] == check[lod]["sha256"] == expected
        assert (
            check[lod]["revision"]["original"]["sha256"]
            == cams["original_glb_sha256"][lod]
        )
    scored = {
        "lod0": "e842938ade4ca80383b509c704a4cf3cb9772b09a35b250ac02fc29dd7bddacb",
        "lod1": "fdfad8f771f27acd627a71afab3c0acd76f2773f10b8baecae42c7881857050a",
    }
    assert scored == cams["revised_glb_sha256"]
    assert all(len(c) == 11 for c in check["decoded_mip_chains"].values())
    code = set(prior["source_sha256"]) | {
        str(p.relative_to(ROOT)) for p in (ROOT / "blender").glob("*wasp*revision.py")
    }
    geo = json.loads((piece / "geometry.json").read_text())
    inputs = {n: digest(ROOT / n) for n in sorted(code)}
    assert all(inputs[n] == s for n, s in prior["source_sha256"].items())
    write_json(
        piece / "provenance.json",
        {
            "piece": "wasp-skimmer",
            "stage": "P3-T7 F9 staged revision",
            "authoring": {
                "date": "2026-11-21",
                "model": "GPT-6.2 Astra",
                "reasoning_effort": "high",
                "tools": prior["authoring"]["tools"],
            },
            "revision_of": {
                "git_commit": BASELINE,
                "initial_visual_score": 77,
                "original_provenance_sha256": digest(old / "provenance.json"),
                "glb_sha256": cams["original_glb_sha256"],
            },
            "reference": prior["reference"],
            "rights": prior["rights"],
            "frame": prior["frame"],
            "changes": [
                "Four wider clipped airfoils begin at the inner gussets. Independent planform, rib and channel surfaces share the same analytic chord positions.",
                "A forward clypeus and two overlapping brow plates layer the nose. Removing the old intersecting crown gem restores a dark central seam. Indigo skin variation is reduced to preserve the silhouette.",
                "The bank lowers its visual thorax another 14 mm at mid-clip, and the hover adds 4 mm to its oscillation. Gameplay facing, health bar and root position remain code-owned.",
            ],
            "production": {
                "high_triangles": geo["high"]["triangles"],
                "receiver_triangles": {
                    l: geo[l]["triangles"] for l in ("lod0", "lod1")
                },
                "joints": 9,
                "materials": 1,
                "rig": "One normalized influence per vertex, five original clip names and timing.",
                "portable_maps": "Four 1024 px UASTC KTX2s with all eleven mips and embedded PNG fallbacks. Cycles CPU rest-pose bake.",
                "review": "EEVEE Metal. Matched high and decoded LOD0/LOD1 stills, underside bank at 50%, 24-frame turntable, 15 keyframes and five-clip decoded LOD0 playback.",
            },
            "clean_repeat": {
                "platform": "Two separate Linux x86_64 Blender 5.2.2 and KTX 4.4.2 builds with three allocated CPU cores.",
                "products_match_sha256": repeated,
                "stage_a_editable": sources[0],
                "stage_b_editable": sources[1],
                "exact_decoded_reimport_except_editable_container_hashes": True,
            },
            "checks": {
                "report": "reimport.json",
                "cameras": "review/cameras.json",
                "portable": "Both independent GLB packages passed validate_glbs.py with the KTX RGBA8 decoder.",
                "posed_samples": "Six independent wing pairs checked for intersections, and all seven appendages for thorax contact, at twice the authored 30 Hz including both endpoints. Peak vertex bounds and fixed root verified at half-frame intervals. All clip maxima also fit below the health bar including 25 mm runtime air bob.",
                "seam": "Top-surface rays compare exact bound emissive and basecolor texels with the original at both LODs. Bilateral positive controls land on native cyan and the original LOD1 exposes the rejected patch.",
            },
            "reproduction": {
                "original": "Extract assets-source/models/wasp-skimmer from the pinned revision_of git commit into $ORIGINAL.",
                "generate": "$BLENDER -b -t 3 --factory-startup --python-exit-code 1 -P blender/wasp_skimmer_revision.py -- --out $STAGE",
                "package": prior["reproduction"]["package"],
                "validate": prior["reproduction"]["validate"],
                "reimport": prior["reproduction"]["reimport"],
                "revision_check": "$BLENDER -b -t 3 --factory-startup --python-exit-code 1 -P blender/verify_wasp_revision.py -- --piece $PIECE --original $ORIGINAL --ktx $KTX",
                "metal_review": "$BLENDER -b -t 3 --factory-startup --python-exit-code 1 -P blender/review_wasp_revision.py -- --piece $PIECE --original $ORIGINAL --ktx $KTX",
                "receipt": "python3 blender/document_wasp_revision.py --piece $PIECE --first $FIRST --second $SECOND --original $ORIGINAL && node_modules/.bin/biome format --write $PIECE/provenance.json",
            },
            "creative_score": 84,
            "independent_visual_review": {
                "date": "2026-11-21",
                "score_out_of_100": 84,
                "reviewed_glbs": scored,
                "observations": "The hull remains thicker and simpler than the approved sheet, the teal reads flat near the roots, and the LOD1 tips retain some angularity.",
            },
            "acceptance": {
                "independent_visual_score": 84,
                "creative_owner": "pending complete batch review",
                "runtime": "P4 integration and physical Quest acceptance pending",
            },
            "source_sha256": inputs,
            "artifact_sha256": {
                str(p.relative_to(piece)): digest(p)
                for p in sorted(piece.rglob("*"))
                if p.is_file() and p.name != "provenance.json"
            },
        },
    )


if __name__ == "__main__":
    main()
