"""Bind the staged review to checked asset, generator, reference and clean-repeat hashes."""

import argparse
import ast
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ID = "rift-disruptor"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path: Path) -> dict:
    return json.loads(path.read_text())


def sources() -> dict:
    roots = [ROOT / "blender", ROOT / "scripts", ROOT / "scripts/assets"]
    pending = [
        *roots[0].glob("*disruptor*.py"),
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
    assert all(b[k] == c[k] for k in ("lod0", "lod1", "atlas"))
    for file in ("high.blend", "low.blend"):
        for key in (
            "clips_sha256",
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
    assert len(products) == 10
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
        "stage": "P3-T6b staged animated character",
        "authoring_date": "2026-11-21",
        "authoring": {
            "model": "GPT-6.2 Astra",
            "reasoning_effort": "high",
            "tools": ["Blender 5.2.2 LTS d13f752e3b9c", "KTX-Software 4.4.2"],
            "source": "Original closed faceted emitter shell, recessed polar wells, segmented free rotor, procedural materials and four rigid-body performances.",
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
            "neutral_length_width_height_m": [0.42, 0.44, 0.32],
            "collision_radius_m": 0.20,
            "health_bar_m": 0.44,
            "lod_swap_m": 6,
            "origin": "Neutral support plane, glTF +Y up, +Z forward. Simulation owns flight, facing, collision, health bar and the 1.2 m EMP field.",
        },
        "production": {
            "high_triangles": 6648,
            "lod0_triangles": b["lod0"]["triangles"],
            "lod1_triangles": b["lod1"]["triangles"],
            "materials_per_receiver": 1,
            "draws": 1,
            "skeleton": ["root", "hull", "rotor"],
            "weights": "One rigid normalized influence per vertex.",
            "clips_fps": 30,
            "loop_clips": ["hover_glide"],
            "one_shots": ["emp_pulse", "hit", "death"],
            "maps": "Four 1024px UASTC maps with eleven mips and embedded PNG fallback. High rest mesh Cycles CPU emission, surface normal and AO/roughness/metallic baking. Parametric tangent correspondence with a bounded 18-degree correction cone.",
            "review": "EEVEE Metal, fixed oblique, top, flank and underside. KTX2-decoded LOD0 and LOD1 matched to the editable high geometry. Neutral orbit and four performed clips.",
        },
        "failed_attempts_and_corrections": [
            "The first death prototype used a 28-degree independent rotor tilt and 47 mm drop. Its subframe measurements could not establish the required clearance. The final rotor tilts 8 degrees and drops 27 mm relative to a collapsing hull. Both receivers pass the triangle separation bound at every half-frame.",
            "Reallocated the cap charts before baking to leave space between the polar wells and outer housing islands, and removed a redundant inset loop from LOD1. The first matched Metal close-up subsequently exposed cyan stair-stepping at the wells. Replaced the 39-pixel-high cap strips with two square 184-pixel charts, rebaked both clean stages, and captured a same-camera comparison.",
        ],
        "clean_repeat": {
            "platform": "Two independent empty Linux x86_64 stages and packages D and E.",
            "products_match_sha256": products,
            "stage_d_editable": b["sources"],
            "stage_e_editable": c["sources"],
            "comparison": "GLBs, PNGs and KTX2 are byte-identical. Geometry measurements, skeleton, weights, topology, UVs and animation fingerprints match across repeats.",
        },
        "checks": {
            "reimport": "reimport.json",
            "candidate_verifier": "blender/verify_disruptor.py",
            "continuity": "Both complete rigid surfaces are closed, edge-manifold and connected. Every sampled posed vertex follows the correct rigid component. Triangle BVHs test collision and projected slab clipping certifies a conservative 3D minimum air gap.",
            "texture": "Vendor RGBA8 decoded and checked on every mip of all four maps. Decoded mip-zero atlas compared against lossless bake. Color and scalar semantic probes recorded in geometry.json.",
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
