# Carapace Brute

The armored front faces glTF +Z. A sloped prow surrounds a keyed central plate with a dark recessed border. The head and charcoal gill bands sit below it. A wide orange grille faces forward beneath the dorsal cowl. Six shouldered greaves cover the leg bearings and taper over wedge-shaped contact pads. The editable sources retain 90 connected anatomical parts in one skinned mesh. The high source has 57,584 triangles.

| Receiver | Triangles | Neutral length × width × height | LOD range |
| --- | ---: | --- | --- |
| LOD0 | 8,904 | 0.52000 × 0.46000 × 0.48000 m | Through 6 m |
| LOD1 | 4,448 | 0.51903 × 0.46000 × 0.48000 m | Beyond 6 m |

Both receivers have one draw primitive, one material and 24 joints. Each rigid plate has a normalized single-bone attachment. Articulated chitin overlaps the bearings between the femur, shin and sole. Each sole contacts an area spanning 39.89 × 48.64 mm at rest. The previous contact outline spanned 34.74 × 44.76 mm. The `Brute` root sits on the support plane. Simulation owns travel, facing, surface alignment, the 0.24 m collision radius and the health bar at 0.60 m.

At 30 authored frames per second, `stomp_walk` loops over 44 frame intervals with alternating tripods. `armor_brace` lowers the shield while all six pads stay planted and then recovers. `attack` opens the jaw and lunges, `hit` recoils laterally, and `death` splays the legs, collapses and holds.

[Shield UV-pole correction](review/shield-pole-comparison.jpg) · [Original and revised armor](review/revision-comparison.jpg) · [Matched half-brace flank and underside](review/brace.jpg) · [Matched oblique, front, flank and underside](review/comparison.jpg) · [Five-clip motion reel](review/motion.mp4) · [Key poses](review/motion.jpg) · [Neutral turntable](review/turntable.mp4) · [Reimport measurements](reimport.json) · [Provenance and independent run hashes](provenance.json)

## Reproduction

Run from the repository root with Blender 5.2.2 LTS and KTX-Software 4.4.2. Use separate empty stage and package directories for the two clean Linux x86_64 production runs. For the prior comparison, set `ORIGINAL` to the Carapace Brute folder exported from commit `80c2b4fe7a0b092d44ec9bc532d8029d1d5976b0`. The review command uses EEVEE on macOS Metal.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 \
  --python blender/carapace_brute_revision.py -- --out "$STAGE"
python3 blender/package_brute.py --stage "$STAGE" --models "$MODELS" --ktx "$KTX"
python3 scripts/validate_glbs.py --manifest "$MODELS/manifest.json" --ktx "$KTX"
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 \
  --python blender/verify_brute_revision.py -- --piece "$MODELS/carapace-brute" --ktx "$KTX"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 \
  --python blender/review_brute_revision.py -- --piece "$MODELS/carapace-brute" --ktx "$KTX" --original "$ORIGINAL" \
  --first-pass-front "$PIECE/review/first-pass-lod0-front.png"
```

The four shared 1024 px charts store sRGB base color and emission, tangent-space normals and linear ORM. Cycles bakes the assembled high source. Matching parametric coordinates transfer the high tangent frame to the finalized low receiver. Each GLB embeds eleven-level UASTC KTX2 and a PNG fallback. The review script decodes the portable maps for both receivers.

The verifier checks both GLBs against the support plane and a vertical surface basis. It measures all six pads, pose endpoints, shield travel, head-to-shield clearance against the actual underside triangles, jaw and leg continuity, limb separation, health-bar clearance, inverse binds, normalized weights and positive-area triangle overlap in both UV and mesh space. The verifier also decodes all eleven levels of each KTX2 map and measures the complete plantar contact patch during the brace. Editable fingerprints cover skin, geometry, topology, UVs, normals, bone hierarchy, animation curves, material graphs and packed images. Independent P3-T7 review scored the revised pair 85/100, up from 79/100. The reviewer noted the bulbous rear armor and the upper shield corner at LOD1. Owner approval remains pending at the batch checkpoint. P4 owns runtime promotion.

Run the source-only command once for each clean package, then regenerate the receipt after copying the first build, verified report and review evidence into the staged asset folder. The first and second arguments point to the individual packaged asset directories. The optional `--assessment` argument accepts an independent assessment naming the SHA-256 of each reviewed GLB.

```sh
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 \
  --python blender/verify_brute_revision.py -- --sources-only "$MODELS/carapace-brute"
python3 blender/document_brute_revision.py --piece "$PIECE" --original "$ORIGINAL" \
  --first "$FIRST_MODELS/carapace-brute" --second "$SECOND_MODELS/carapace-brute"
bunx biome format --write "$PIECE/provenance.json"
```
