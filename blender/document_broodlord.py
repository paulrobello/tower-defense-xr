"""Bind the staged review to checked asset, generator, reference and clean-repeat hashes."""

import argparse
import ast
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ID = "apex-broodlord"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path: Path) -> dict:
    return json.loads(path.read_text())


def sources() -> dict:
    roots = [ROOT / "blender", ROOT / "scripts", ROOT / "scripts/assets"]
    pending = [
        *roots[0].glob("*broodlord*.py"),
        roots[1] / "validate_glbs.py",
        roots[2] / "encode_ktx2.py",
    ]
    seen = set()
    while pending:
        file = pending.pop()
        if file in seen:
            continue
        seen.add(file)
        for node in ast.walk(ast.parse(file.read_text())):
            if isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            elif isinstance(node, ast.Import):
                names = [n.name for n in node.names]
            else:
                continue
            for name in names:
                pending.extend(
                    candidate
                    for base in roots
                    if (candidate := base / (name + ".py")).is_file()
                )
    return {str(p.relative_to(ROOT)): digest(p) for p in sorted(seen)}


def main() -> None:
    parser = argparse.ArgumentParser()
    for arg in ("piece", "first", "repeat"):
        parser.add_argument("--" + arg, type=Path, required=True)
    args = parser.parse_args()
    piece, first, repeat = args.piece, args.first, args.repeat
    b, c = (read(p / "reimport.json") for p in (first, repeat))
    published = read(piece / "reimport.json")
    assert b == published
    assert all(
        b[k] == c[k] for k in ("lod0", "lod1", "atlas", "phase2_cracks", "decoded_mips")
    )
    for file in ("high.blend", "low.blend"):
        for key in (
            "clips_sha256",
            "editable_material_graphs_sha256",
            "logical_geometry_hierarchy_skin_animation_sha256",
            "skeleton_and_groups_sha256",
        ):
            assert b["sources"][file][key] == c["sources"][file][key]
        assert digest(piece / file) == b["sources"][file]["file_sha256"]
    products = {
        p.name: digest(p)
        for p in sorted(first.iterdir())
        if p.suffix in (".glb", ".png", ".ktx2")
    }
    assert len(products) == 12
    assert all(
        value == digest(repeat / name) == digest(piece / name)
        for name, value in products.items()
    )
    assert (
        read(first / "geometry.json")
        == read(repeat / "geometry.json")
        == read(piece / "geometry.json")
    )
    concept = ROOT / "assets-source/concepts/sheets" / (ID + ".png")
    result = {
        "piece": ID,
        "stage": "P3-T6c staged animated boss",
        "authoring_date": "2026-11-21",
        "authoring": {
            "model": "GPT-6.2 Astra",
            "reasoning_effort": "high",
            "tools": ["Blender 5.2.2 LTS d13f752e3b9c", "KTX-Software 4.4.2"],
            "source": "Original four-stilt matriarch with articulated foreclaws, swept split casque, overlapping posterior shingles, six in-place actions and a hand-parameterized branching fracture mask.",
        },
        "reference": {
            "approved_direction": "Bastion Rib",
            "concept_approved": "2026-11-20",
            "path": str(concept.relative_to(ROOT)),
            "sha256": digest(concept),
            "rights_inventory": "assets-source/concepts/provenance.json",
        },
        "rights": {
            "geometry_animation_textures": "Original project-authored geometry, animation and procedural textures.",
            "license": "MIT as declared in package.json.",
        },
        "game_contract": {
            "content_and_alignment_source_sha256": {
                n: digest(ROOT / n)
                for n in (
                    "src/content/enemies.ts",
                    "src/render/blockouts.ts",
                )
            },
            "neutral_length_width_height_m": [0.92, 0.78, 0.84],
            "collision_radius_m": 0.42,
            "health_bar_m": 1.02,
            "lod_swap_m": 8,
            "origin": "Neutral support plane, glTF +Y up, +Z forward. Simulation owns movement and facing on the support surface, collision, health-bar placement, add spawning, EMP suppression and the 50% HP phase trigger.",
        },
        "production": {
            "high_triangles": read(piece / "geometry.json")["high"]["triangles"],
            "lod0_triangles": b["lod0"]["triangles"],
            "lod1_triangles": b["lod1"]["triangles"],
            "materials_per_receiver": 1,
            "draws": 1,
            "skeleton": b["lod0"]["joints"],
            "weights": "One rigid normalized influence per vertex.",
            "clips_fps": 30,
            "loop_clips": ["boss_march"],
            "one_shots": ["spawn_adds", "emp_roar", "phase2_shift", "hit", "death"],
            "maps": "Four 2048px UASTC maps with twelve mips and embedded PNG fallback. Cycles CPU bakes high rest-surface base color, tangent normal, native magenta emission and AO/roughness/metallic. A bounded 24-degree normal correction transfers the high tangent field to LOD0. The standalone 2048px phase2-cracks map stores linear coverage encoded with the sRGB transfer function, including antialias texels. A single UV0 sample decoded as sRGB multiplies linear #ff4d00 and adds to native emission when enabled. The phase scalar is zero in Phase 1.",
            "review": "EEVEE Metal, fixed oblique, front, flank and underside. Both GLBs use decoded KTX2 maps and the same studio cameras. The phase comparison reuses each mesh and camera, changing only the additive fissure factor. Neutral orbit and six performed clips.",
        },
        "failed_attempts_and_corrections": [
            "Neutral triangle connectivity exposed two free outer fingers. Seated each proximal knuckle farther into its palm and added a thorax-owned pelvic socket to bridge the rear coxa throughout abdominal motion.",
            "The initial front projection separated the crest halves too far along their mid-length. Widened the paired armor plates, narrowed their center gap and introduced a second branching magenta seam on each.",
            "The first summon pose swept the palm into the front blade. Raised the brachia during the summon and shortened their outward arc. The revised posed reimports pass foreclaw-leg separation.",
            "The initial all-mip verifier reused its texture path variable for a surface label at mip zero. Kept independent texture and probe variables and reran both complete reimport reports.",
            "The first Metal underside framing clipped a toe. Recentered that single matched camera and expanded its orthographic width from 1.19 to 1.30 m. Per-view projected vertex margins in review/cameras.json cover all tips on the high source and both reimports.",
            "The first death collapse pushed a front femur below the support plane. Reduced the thorax drop to 140 mm, eased its pitch and folded the crest while settling. Both LODs hold the terminal pose on four feet.",
        ],
        "clean_repeat": {
            "platform": "Two independent empty Linux x86_64 stages and packages A and B.",
            "products_match_sha256": products,
            "final_verifier_sha256": digest(ROOT / "blender/verify_broodlord.py"),
            "clean_reimport_report_sha256": {
                "A": digest(first / "reimport.json"),
                "B": digest(repeat / "reimport.json"),
            },
            "verification_environment": "Linux x86_64 Blender 5.2.2 / KTX 4.4.2, OPENBLAS_NUM_THREADS=1, OMP_NUM_THREADS=1, PYTHONHASHSEED=0. Each final report ran in a separate one-core process.",
            "stage_a_editable": b["sources"],
            "stage_b_editable": c["sources"],
            "comparison": "GLBs, PNGs and KTX2 are byte-identical. Geometry measurements, skeleton, weights, topology, UVs and animation fingerprints match across repeats.",
        },
        "checks": {
            "reimport": "reimport.json",
            "candidate_verifier": "blender/verify_broodlord.py",
            "continuity": "Rest-pose triangle BVHs connect all 98 anatomical patches into one graph. Posed triangle BVHs test adjacent control-chain contacts, foreclaw clearance, and inter-leg separation at seven poses per clip per LOD. All authored half-frames are measured for root drift, blade contact, health-bar clearance, principal articulation travel and endpoints. Additional tests rotate the march to a vertical support surface, measure distal crest separation in head-transverse space and exercise three interrupted/recovery blends at five interpolation weights each.",
            "texture": "Vendor RGBA8 decoded and checked on every mip of all five maps. Decoded mip-zero atlas compared against lossless bake. Color and scalar semantic probes recorded in geometry.json.",
        },
        "acceptance": {
            "creative_owner": "pending combined P3-T7 review",
            "runtime": "pending P4 integration",
            "independent_visual_score": "tracked by the phase review owner",
        },
        "source_sha256": sources(),
        "files": {
            str(p.relative_to(piece)): digest(p)
            for p in sorted(piece.rglob("*"))
            if p.is_file() and p.name != "provenance.json"
        },
    }
    (piece / "provenance.json").write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
