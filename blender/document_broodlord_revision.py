"""Bind F11 to both source stages, portable packages and the exact rendered geometry."""

import argparse
import hashlib
import json
import sys
from itertools import pairwise
from math import dist
from pathlib import Path

from document_broodlord import sources
from package_core_bastion import ROOT, digest, write_json

sys.path.insert(0, str(ROOT / "scripts"))
from validate_glbs import Glb


def channel_layout(path: Path) -> dict:
    glb = Glb(path.read_bytes())
    doc = glb.doc
    result = {}
    for action in doc["animations"]:
        channels = []
        for ch in action["channels"]:
            sampler = action["samplers"][ch["sampler"]]
            target = ch["target"]
            times = [v[0] for v in glb.read(sampler["input"], "SCALAR", (5126,))]
            assert all(a < b for a, b in pairwise(times))
            channels.append(
                (
                    doc["nodes"][target["node"]]["name"],
                    target["path"],
                    sampler.get("interpolation", "LINEAR"),
                    times,
                )
            )
        result[action["name"]] = {
            "channels": len(channels),
            "target_paths_interpolation_and_times_sha256": hashlib.sha256(
                json.dumps(sorted(channels), separators=(",", ":")).encode()
            ).hexdigest(),
        }
    return result


def joint_origins(path: Path) -> dict:
    glb = Glb(path.read_bytes())
    poses, _ = glb.scene()
    return {
        glb.doc["nodes"][j]["name"]: [poses[j][axis][3] for axis in range(3)]
        for j in glb.doc["skins"][0]["joints"]
    }


def raw_receipt(stage: Path) -> dict:
    paths = [
        p
        for p in stage.rglob("*")
        if p.is_file() and p.suffix in (".gltf", ".bin", ".png", ".json")
    ]
    records = {str(p.relative_to(stage)): digest(p) for p in paths}
    assert all(
        f"{lod}/source.{ext}" in records
        for lod in ("lod0", "lod1")
        for ext in ("gltf", "bin")
    )
    assert all(
        n + ".png" in records
        for n in ("basecolor", "normal", "orm", "emissive", "phase2-cracks")
    )
    return dict(sorted(records.items()))


def main() -> None:
    parser = argparse.ArgumentParser()
    for arg in ("piece", "first", "repeat", "original", "raw-stage", "raw-receipt"):
        parser.add_argument("--" + arg, type=Path)
    args = parser.parse_args()
    if args.raw_stage:
        write_json(args.raw_receipt, raw_receipt(args.raw_stage))
        return
    piece, first, repeat, original = (
        getattr(args, n).resolve() for n in ("piece", "first", "repeat", "original")
    )

    def read(p: Path) -> dict:
        return json.loads(p.read_text())

    prior = read(original / "provenance.json")
    a, b = (read(p / "reimport.json") for p in (first, repeat))
    report = read(piece / "reimport.json")
    cameras = read(piece / "review/cameras.json")
    assert a == report
    for k in (
        "lod0",
        "lod1",
        "atlas",
        "phase2_cracks",
        "decoded_mips",
        "editable_overlap",
    ):
        assert a[k] == b[k], k
    for name in ("high.blend", "low.blend"):
        src = a["sources"][name]
        assert digest(piece / name) == src["file_sha256"]
        for k in src.keys() - {"file_sha256"}:
            assert src[k] == b["sources"][name][k], (name, k)
    fixed = read(first.parent / "tangent-export.json")
    assert fixed == read(repeat.parent / "tangent-export.json")
    assert sum(item["repair_count"] for item in fixed.values()) == 5
    raw = read(first.parent / "raw-stage.json")
    raw_b = read(repeat.parent / "raw-stage.json")
    assert raw == raw_b
    files = {
        str(p.relative_to(piece)): digest(p)
        for p in sorted(piece.rglob("*"))
        if p.is_file() and p.name != "provenance.json"
    }
    products = {
        f: sha
        for f, sha in files.items()
        if "/" not in f and Path(f).suffix in (".glb", ".png", ".ktx2")
    }
    assert len(products) == 12
    assert all(
        sha == digest(first / f) == digest(repeat / f) for f, sha in products.items()
    )
    assert (
        read(piece / "geometry.json")
        == read(first / "geometry.json")
        == read(repeat / "geometry.json")
    )
    assert all(
        products[f"apex-broodlord-{n}.glb"]
        == a[n]["sha256"]
        == cameras["reviewed_glb_sha256"][n]
        for n in ("lod0", "lod1")
    )
    assert files["high.blend"] == cameras["reviewed_high_blend_sha256"]
    assert (
        all(len(levels) == 12 for levels in a["decoded_mips"].values())
        and len(a["decoded_mips"]) == 5
    )
    assert len(cameras["phase_proof"]) == 6
    layout = channel_layout(original / "apex-broodlord-lod0.glb")
    for n in ("lod0", "lod1"):
        assert channel_layout(piece / f"apex-broodlord-{n}.glb") == layout
    archived = joint_origins(original / "apex-broodlord-lod0.glb")
    fitted = joint_origins(piece / "apex-broodlord-lod0.glb")
    assert fitted == joint_origins(piece / "apex-broodlord-lod1.glb")
    assert fitted.keys() == archived.keys() and fitted["root"] == archived["root"] == [
        0,
        0,
        0,
    ]
    delta, joint = max((dist(fitted[k], archived[k]), k) for k in fitted)
    reviewed = {
        "lod0": "05d806d99cd9993454b6a98c7c6b7cb0947e32acaaf4660eda48cdf529f98657",
        "lod1": "ba25b69e835fc8c5de4ea5cbcbfcca5e1ea1d9f8627c912890d0056657212e2d",
    }
    assert cameras["reviewed_glb_sha256"] == reviewed
    source_hashes = sources()
    for path in ("docs/art-bible.md", "docs/blender-kit-project.md"):
        source_hashes[path] = digest(ROOT / path)
    record = {
        "piece": "apex-broodlord",
        "stage": "P3-T7 F11 staged revision",
        "authoring": {
            **prior["authoring"],
            "source": "Project-authored integrated brow and sagittal suture, reprofiled swept crest blades, narrow oblique eyes, hooked mandibles, anterior breast collars, swept pleural plates and tapered abdominal scutes over a recessed underplate.",
        },
        "authoring_date": "2026-11-21",
        "reference": prior["reference"],
        "rights": prior["rights"],
        "game_contract": prior["game_contract"],
        "revision_of": {
            "git_commit": "80c2b4fe7a0b092d44ec9bc532d8029d1d5976b0",
            "previous_independent_score": 75,
            "previous_provenance_sha256": digest(original / "provenance.json"),
            "previous_glb_sha256": {
                k: v for k, v in prior["files"].items() if k.endswith(".glb")
            },
        },
        "production": {
            **prior["production"],
            "high_triangles": read(piece / "geometry.json")["high"]["triangles"],
            "lod0_triangles": a["lod0"]["triangles"],
            "lod1_triangles": a["lod1"]["triangles"],
            "review": "EEVEE Metal. Matched high and decoded receivers from oblique, front, flank, underside and raised rear cameras. Both receivers change only the additive fissure factor across the three Phase 1 / Phase 2 camera pairs. The motion reel traverses every authored clip.",
        },
        "failed_attempts_and_corrections": [
            "Independent round one scored 75/100. The oval eyes and exposed thorax competed with the two visually separate crest plates.",
            "The first revision preview improved the facial silhouette and abdominal overlaps, but the sagittal center fell into shadow. Raised and widened the shared brow, introduced one central emissive suture and tapered the side veins. Replaced the side plate's rounded profile with a swept shoulder scale.",
        ],
        "tangent_correction": "The original portable validator rejected five zero-length LOD0 tangents at split cap corners on abdominal scutes 0, 1 and 3. Each corner belongs to exactly one triangle. The packager derives its positive-U direction from that triangle, projects it onto the stored normal plane and normalizes it. It retains the original handedness. The receipt verifies every other GLB byte is identical, including UVs, positions, indices, normals and all images. Both corrected packages pass the original validator.",
        "clearance_correction": "The expanded triangle separation verifier found the distal left valve intersecting the stationary brow at death frame 12 in a rejected preflight. The revision retains the forward brow, trims the trailing shield to the center of the skull, and passes on all half frames in both final packages.",
        "clean_repeat": {
            "platform": "Independent empty Linux x86_64 stages and packages; Blender 5.2.2 CPU, KTX-Software 4.4.2. OPENBLAS_NUM_THREADS=1, OMP_NUM_THREADS=1 and PYTHONHASHSEED=0.",
            "raw_stage_sha256": raw,
            "raw_stage_repeat_sha256": raw_b,
            "products_match_sha256": products,
            "stage_a_editable": a["sources"],
            "stage_b_editable": b["sources"],
            "reimport_report_sha256": {
                "A": digest(first / "reimport.json"),
                "B": digest(repeat / "reimport.json"),
            },
            "comparison": "All raw glTF, bin, texture and geometry-report files and all twelve portable GLB, PNG and KTX2 products match byte for byte. Editable topology, skin, rig, material graphs, packed images and clip fingerprints match.",
        },
        "portable_tangent_frame_receipt": fixed,
        "serialized_clips_match_frozen_channel_contract": layout,
        "neutral_bind_comparison": {
            "world_root_translation_m": fitted["root"],
            "identical_between_revision_lods": True,
            "largest_world_joint_position_change_from_round_one_m": delta,
            "joint": joint,
            "reason": "The original rig generator fits its neutral bearings to the full revised mesh envelope.",
        },
        "checks": {
            "reimport": "reimport.json",
            "review": "review/cameras.json",
            "geometry": "All 98 UV-addressable anatomical patches form a single connected rest assembly. Geometry and UVs on both editable sources and both packaged receivers have zero positive-area coplanar overlaps.",
            "motion": "Evaluated skin positions, supports, crest clearance, joints and distal-to-head and limb separation at half-frame intervals on both exact GLBs. Per-pose triangle partitions establish positive projected separation lower bounds. Three additional staged transitions sample five blend weights.",
            "phase": "Each matching phase pair uses the same decoded receiver and camera. The pixel evidence records where enabling the separately decoded fissure map adds orange.",
            "maps": "All twelve mips of all five 2048 px maps decoded. Unit normal bounds, source recipe probes, opaque alpha and intact/bright grayscale crack probes passed.",
        },
        "creative_score": 82,
        "independent_visual_review": {
            "date": "2026-11-21",
            "score_out_of_100": 82,
            "reviewed_glbs": reviewed,
            "observations": "The crest tips remain tall and symmetric, the underside is smooth and the jaws recessed. The cracks read flatter and LOD1 shows more faceting.",
        },
        "acceptance": {
            "independent_visual_score": 82,
            "creative_owner": "pending combined P3-T7 review",
            "runtime": "pending P4 integration and Quest acceptance",
        },
        "source_sha256": source_hashes,
        "files": files,
    }
    write_json(piece / "provenance.json", record)


if __name__ == "__main__":
    main()
