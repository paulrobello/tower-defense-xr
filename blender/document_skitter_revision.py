"""Bind the F8 archive to two clean builds, the imported meshes and their renders."""

import argparse
import json
from pathlib import Path

from package_core_bastion import ROOT, digest, write_json

BASELINE = "a8894e87923fb7856f5ffafe654bfc46f8f632e2"
LOGICAL = "logical_geometry_hierarchy_skin_animation_sha256"


def main() -> None:
    parser = argparse.ArgumentParser()
    for arg in ("piece", "first", "second", "original"):
        parser.add_argument("--" + arg, type=Path, required=True)
    args = parser.parse_args()
    piece, first, second, original = (
        getattr(args, n).resolve() for n in ("piece", "first", "second", "original")
    )
    prior = json.loads((original / "provenance.json").read_text())
    checks = json.loads((piece / "reimport.json").read_text())
    reviewed = json.loads((piece / "review/cameras.json").read_text())
    geometry = json.loads((piece / "geometry.json").read_text())
    files = {
        str(p.relative_to(piece)): digest(p)
        for p in sorted(piece.rglob("*"))
        if p.is_file() and p.name != "provenance.json"
    }
    names = [
        name
        for name in files
        if "/" not in name
        and (name.endswith((".glb", ".png", ".ktx2")) or name == "geometry.json")
    ]
    repeated = {n: digest(first / n) for n in names}
    assert all(digest(second / n) == repeated[n] == files[n] for n in names)
    sources = [
        json.loads((build / "editable-hashes.json").read_text())
        for build in (first, second)
    ]
    for n in ("high.blend", "low.blend"):
        assert sources[0][n] == checks["sources"][n]
        assert sources[1][n][LOGICAL] == sources[0][n][LOGICAL]
        assert files[n] == sources[0][n]["file_sha256"]
    for lod in ("lod0", "lod1"):
        n = f"skitter-crawler-{lod}.glb"
        assert checks[lod]["sha256"] == reviewed["reviewed_glb_sha256"][lod] == files[n]
    scored_glbs = {
        "lod0": "ebc4e139f071d3957c6b7657e86b0db2024911e79d7fc761e2385440da740670",
        "lod1": "efa45b81ba64766c0feac792d9cbc5961f96028c72f25d90b2ec7db70d9c370a",
    }
    assert scored_glbs == reviewed["reviewed_glb_sha256"]
    assert all(len(c) == 11 for c in checks["decoded_mip_chains"].values())
    code = set(prior["source_sha256"]) | {
        str(p.relative_to(ROOT))
        for p in (ROOT / "blender").glob("*skitter*revision.py")
    }
    write_json(
        piece / "provenance.json",
        {
            "piece": "skitter-crawler",
            "stage": "P3-T7 F8 staged revision",
            "authoring": {
                "model": "GPT-6.2 Astra",
                "reasoning_effort": "high",
                "date": "2026-11-21",
                "tools": ["Blender 5.2.2 LTS d13f752e3b9c", "KTX-Software 4.4.2"],
            },
            "reference": prior["reference"],
            "rights": prior["rights"],
            "frame": prior["frame"],
            "revision_of": {
                "git_commit": BASELINE,
                "previous_score": 77,
                "previous_provenance_sha256": digest(original / "provenance.json"),
                "previous_glb_sha256": {
                    n: prior["files"][n] for n in prior["files"] if n.endswith(".glb")
                },
            },
            "corrections": [
                "Ten bilateral valves have graded sweep, a thin trailing margin and a curved backing with a widening dorsal channel.",
                "A sloping visor covers the smaller articulated mask. Six fixed-to-tibia guards overlap the knee articulations, and the tapered abdominal backing uses additional longitudinal stations at both LODs.",
                "The exposed violet organ follows the shell arc with locally widening tissue and raised tapered nodes. The original tripod timings, joints and skin group names are retained.",
            ],
            "production": {
                "high_triangles": geometry["high"]["triangles"],
                "receiver_triangles": {
                    k: geometry[k]["triangles"] for k in ("lod0", "lod1")
                },
                "bones": 23,
                "materials": 1,
                "maps": "Four 1024 px shared UASTC2 maps with 11 mip levels, original PNG fallbacks embedded.",
                "stage": "Cycles CPU rest material and assembled AO bake, high-to-low tangent-frame transfer. EEVEE Metal for posed source/LOD render comparisons and both motion videos.",
            },
            "checks": {
                "reimport": "reimport.json",
                "oriented_floor_and_wall": True,
                "all_mip_levels_decoded": True,
                "joint_contacts_and_separation": "18 connected articulations and separation for each pair of independent legs at five posed samples per clip and LOD.",
            },
            "clean_repeat": {
                "platform": "Independent Linux x86_64 stage and packaging runs with Blender 5.2.2 and KTX-Software 4.4.2; maximum three CPU threads per Blender process.",
                "products_match_sha256": repeated,
                "stage_a_editable": sources[0],
                "stage_b_editable": sources[1],
            },
            "creative_score": 83,
            "independent_visual_review": {
                "date": "2026-11-21",
                "score_out_of_100": 83,
                "reviewed_glbs": scored_glbs,
                "observations": "The legs remain straight. LOD1 loses some eye and shoulder detail.",
            },
            "acceptance": {
                "creative_owner": "pending batch review",
                "independent_visual_score": 83,
                "runtime": "staged only; P4 and physical Quest acceptance pending",
            },
            "source_sha256": {n: digest(ROOT / n) for n in sorted(code)},
            "files": files,
        },
    )


if __name__ == "__main__":
    main()
