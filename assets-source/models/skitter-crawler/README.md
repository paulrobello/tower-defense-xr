# Skitter Crawler

The staged crawler has five pairs of overlapping scutes, a violet dorsal furrow, a facial shield, two hooked mandibles, and six independently articulated blade legs. The 23-bone FK rig assigns each rigid cuticle panel to its anatomical joint. Its editable high source has 60,720 triangles. The two single-material receivers share UV chart parameters, textures, named bones and clips.

| Receiver | Triangles | Neutral length × width × height | Target switch |
| --- | ---: | --- | --- |
| LOD0 | 4,340 | 0.34000 × 0.26000 × 0.18000 m | Through 6 m |
| LOD1 | 1,836 | 0.34000 × 0.25995 × 0.17849 m | Beyond 6 m |

The identity transform named `Skitter` sits at the support plane, with glTF +Y up and +Z forward. The game owns translation, surface alignment, collision radius (0.14 m) and health-bar offset (0.28 m). The floor and wall clips repeat. `attack` opens the mandibles, lunges and recovers. `hit` rolls and recoils. `death` drops the thorax, tucks the limbs and holds its final pose.

[Matched high and low views](review/comparison.jpg) · [Floor contact](review/crawl_floor.png) · [Wall contact](review/climb_wall.png) · [Five motion sequences](review/motion.jpg) · [Turntable](review/turntable.mp4) · [Exact reimport measurements](reimport.json) · [Source, repeat and review hashes](provenance.json)

## Reproduction

Run from the repository root with Blender 5.2.2 LTS and KTX-Software 4.4.2. Use two empty, independent stage and package directories for a repeat comparison. The clean production reference runs used Linux x86_64. Review ran on macOS Metal. The project manifest already tracks this candidate. An isolated models directory receives its own two-entry manifest.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 \
  --python blender/skitter_crawler.py -- --out "$STAGE"
python3 blender/package_skitter.py --stage "$STAGE" --models "$MODELS" --ktx "$KTX"
python3 scripts/validate_glbs.py --manifest "$MODELS/manifest.json" --ktx "$KTX"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 \
  --python blender/verify_skitter.py -- --piece "$MODELS/skitter-crawler" --ktx "$KTX"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 \
  --python blender/review_skitter.py -- --piece "$MODELS/skitter-crawler" --ktx "$KTX"
```

Blender retains the high-source procedural finish. Cycles bakes its assembled, undeformed surface into four shared 1K charts. A UV-space comparison of high and LOD0 tangent frames transfers the source normals to the receiver. Roughness and metalness come from independent source channels. The red ORM channel captures short-range assembled ambient occlusion. The portable maps use UASTC with all eleven mip levels. Embedded PNG fallbacks allow ordinary Blender glTF import. The review script replaces those fallbacks with decoded KTX2 pixels.

The verifier compares each joint and its inverse bind to the skinned object's bind transform. It measures all deformed feet against the actual floor or rotated wall basis, checks the wound-down death pose, and samples mesh-to-mesh contact at 18 articulations and separation between all six legs. The `--sources-only <piece-folder>` option writes a logical fingerprint for each editable file covering hierarchy, geometry, material assignment, UVs, weights, bone rest matrices and animation curves.
