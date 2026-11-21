"""Bind the F10 candidate to the original concept, exact outputs and repeat-source evidence."""

import argparse
import json
import subprocess
from pathlib import Path

from package_core_bastion import ROOT, digest, write_json

PIECE = "carapace-brute"
BASELINE = "80c2b4fe7a0b092d44ec9bc532d8029d1d5976b0"


def read(path: Path) -> dict:
    return json.loads(path.read_text())


def orange_vent_pixels(front: Path) -> int:
    rgb = subprocess.check_output(
        ["magick", str(front), "-alpha", "off", "-depth", "8", "rgb:-"]
    )
    assert len(rgb) == 512 * 512 * 3
    count = 0
    for y in range(145):
        for x in range(151, 360):
            i = 3 * (y * 512 + x)
            r, g, b = rgb[i : i + 3]
            count += r > 90 and r > 1.2 * g and g > 1.4 * b and r - b > 68
    return count


def main() -> None:
    parser = argparse.ArgumentParser()
    for key in ("piece", "original", "first", "second"):
        parser.add_argument("--" + key, type=Path, required=True)
    parser.add_argument("--assessment", type=Path)
    args = parser.parse_args()
    piece, previous = args.piece.resolve(), args.original.resolve()
    prior = read(previous / "provenance.json")
    geometry = read(piece / "geometry.json")
    report = read(piece / "reimport.json")
    renders = read(piece / "review/cameras.json")
    files = {
        str(p.relative_to(piece)): digest(p)
        for p in sorted(piece.rglob("*"))
        if p.is_file() and p.name != "provenance.json"
    }
    products = {
        n: sha
        for n, sha in files.items()
        if "/" not in n
        and (n.endswith((".glb", ".ktx2", ".png")) or n == "geometry.json")
    }
    assert len(products) == 11
    assert all(
        digest(stage / n) == sha
        for stage in (args.first, args.second)
        for n, sha in products.items()
    )
    first, second = [
        read(stage / "editable-hashes.json") for stage in (args.first, args.second)
    ]
    for n in ("high.blend", "low.blend"):
        assert first[n] == report["sources"][n] and first[n]["file_sha256"] == files[n]
        assert {k: v for k, v in first[n].items() if k != "file_sha256"} == {
            k: v for k, v in second[n].items() if k != "file_sha256"
        }
    candidate = {lod: files[f"{PIECE}-{lod}.glb"] for lod in ("lod0", "lod1")}
    assert renders["reviewed_glb_sha256"] == candidate
    assert {lod: report[lod]["sha256"] for lod in candidate} == candidate
    assert all(len(v) == 11 for v in report["decoded_mip_chains"].values())
    assert digest(ROOT / prior["reference"]["path"]) == prior["reference"]["sha256"]
    for path, old_hash in prior["source_sha256"].items():
        assert digest(ROOT / path) == old_hash, path
    code = (
        set(prior["source_sha256"])
        | {
            str(p.relative_to(ROOT))
            for p in (ROOT / "blender").glob("*brute*revision*.py")
        }
        | {
            "blender/verify_core_bastion_revision.py",
            "blender/core_bastion_revision.py",
        }
    )
    old_count, new_count = [
        orange_vent_pixels(folder / "review/lod0-front.png")
        for folder in (previous, piece)
    ]
    assert new_count > old_count * 2
    production = prior["production"] | {
        "high_triangles": geometry["high"]["triangles"],
        "measured_lod0_triangles": geometry["lod0"]["triangles"],
        "measured_lod1_triangles": geometry["lod1"]["triangles"],
        "weighting": "Rigid shell and greave sections use one normalized anatomical joint per vertex. Each tarsal sole is attached to its claw joint.",
    }
    current = piece / "provenance.json"
    existing = (
        read(current).get("independent_visual_review") if current.is_file() else None
    )
    assessment = (
        existing if existing and existing.get("reviewed_glbs") == candidate else None
    )
    if args.assessment:
        assessment = read(args.assessment)
    if assessment:
        assert assessment["reviewed_glbs"] == candidate
        assert 0 <= assessment["score_out_of_100"] <= 100
    write_json(
        piece / "provenance.json",
        {
            "piece": PIECE,
            "stage": "P3-T7 F10 staged revision",
            "authoring_date": "2026-11-21",
            "authoring": prior["authoring"]
            | {
                "source": "Original contour-lofted prow and greaves, reshaped dorsal inlet and retained articulated anatomy and five performances."
            },
            "reference": prior["reference"],
            "rights": prior["rights"],
            "frame": prior["frame"],
            "revision_of": {
                "git_commit": BASELINE,
                "previous_score": 79,
                "previous_provenance_sha256": digest(previous / "provenance.json"),
                "previous_glb_sha256": {
                    lod: digest(previous / f"{PIECE}-{lod}.glb") for lod in candidate
                },
            },
            "corrections": [
                "The articulated prow has a keyed face, recessed dark border, rolled perimeter and thicker forward edge.",
                "The dorsal intake has a wider exposed orange grille under a swept cowl. The cuticle has less mottling across its broad plates.",
                "Six tapered, shouldered greaves overlap their patellar bearings and broad wedge-shaped soles.",
            ],
            "production": production,
            "checks": {
                "candidate_verifier": "blender/verify_brute_revision.py",
                "reimport": "reimport.json",
                "both_imported_lods": True,
                "matched_front_dorsal_grille_pixels": {
                    "original": old_count,
                    "revised": new_count,
                    "region": "512 px LOD0 front with x=151..359 and y=0..144, counting R>90, R>1.2G, G>1.4B and R-B>68 in 8-bit RGB",
                },
                "all_mips_decoded": True,
                "coverage": "Actual posed head-to-shield clearance, thorax and leg attachment, leg separation, rigid skin and inverse binds, footprint, six-sole brace contact, root stability, floor and vertical-wall orientation, and positive-area mesh and UV overlap.",
            },
            "development_checks": [
                "The first LOD0 probe exceeded its ceiling by 16 triangles. Fewer rings on buried shin cores restored margin.",
                "The first distant mesh lost the upper gill attachment and its broadest shin station. Moving the gill root inward and retaining that contact station restored the verified assembly and neutral width.",
                "The first-pass soles lengthened the hoof body but narrowed its load patch. The final sole is broader in both directions than the original and its full plantar outline is measured on both imported GLBs.",
                "Matched first-pass Metal renders exposed a dark UV-pole mark on the main shield face. A final support ring localizes the pole to a small smooth cap. The first and final front crops are preserved in review/shield-pole-comparison.jpg.",
            ],
            "clean_repeat": {
                "platform": "Two clean Linux x86_64 Blender 5.2.2 Cycles CPU builds and KTX-Software 4.4.2 packages. Each Blender process used up to three threads.",
                "products_match_sha256": products,
                "first_editable": first,
                "second_editable": second,
            },
            "creative_score": assessment["score_out_of_100"] if assessment else None,
            "independent_visual_review": assessment,
            "acceptance": {
                "creative_owner": "pending complete batch review",
                "independent_visual_score": assessment["score_out_of_100"]
                if assessment
                else "pending independent review",
                "runtime": "staged candidate; P4 and physical Quest acceptance pending",
            },
            "source_sha256": {n: digest(ROOT / n) for n in sorted(code)},
            "files": files,
        },
    )


if __name__ == "__main__":
    main()
