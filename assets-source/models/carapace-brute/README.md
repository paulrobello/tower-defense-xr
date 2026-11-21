# Carapace Brute

The armored front faces glTF +Z. A single sloping shield covers the head, charcoal gill bands and two amber eye slits. A louvered orange intake sits on the dorsal saddle. Six short armored shins end in broad contact pads. The editable sources retain 89 anatomical parts in one skinned mesh. The high source has 62,008 triangles.

| Receiver | Triangles | Neutral length × width × height | LOD range |
| --- | ---: | --- | --- |
| LOD0 | 8,720 | 0.52000 × 0.46000 × 0.48000 m | Through 6 m |
| LOD1 | 3,352 | 0.51903 × 0.46000 × 0.47837 m | Beyond 6 m |

Both receivers have one draw primitive, one material and 24 joints. Each rigid plate has a normalized single-bone attachment. Overlapping capsules keep the articulated leg segments connected. The `Brute` root sits on the support plane. Simulation owns travel, facing, surface alignment, the 0.24 m collision radius and the health bar at 0.60 m.

At 30 authored frames per second, `stomp_walk` loops over 44 frame intervals with alternating tripods. `armor_brace` lowers the shield while all six pads stay planted and then recovers. `attack` opens the jaw and lunges, `hit` recoils laterally, and `death` splays the legs, collapses and holds.

[Matched oblique, front, flank and underside](review/comparison.jpg) · [Five-clip motion reel](review/motion.mp4) · [Key poses](review/motion.jpg) · [Neutral turntable](review/turntable.mp4) · [Reimport measurements](reimport.json) · [Provenance and independent run hashes](provenance.json)

## Reproduction

Run from the repository root with Blender 5.2.2 LTS and KTX-Software 4.4.2. Use separate empty stage and package directories for the two clean Linux x86_64 production runs. The review command uses EEVEE on macOS Metal.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 \
  --python blender/carapace_brute.py -- --out "$STAGE"
python3 blender/package_brute.py --stage "$STAGE" --models "$MODELS" --ktx "$KTX"
python3 scripts/validate_glbs.py --manifest "$MODELS/manifest.json" --ktx "$KTX"
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 \
  --python blender/verify_brute.py -- --piece "$MODELS/carapace-brute" --ktx "$KTX"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 \
  --python blender/review_brute.py -- --piece "$MODELS/carapace-brute" --ktx "$KTX"
```

The four shared 1024 px charts store sRGB base color and emission, tangent-space normals and linear ORM. Cycles bakes the assembled high source. Matching parametric coordinates transfer the high tangent frame to the finalized low receiver. Each GLB embeds eleven-level UASTC KTX2 and a PNG fallback. The review script decodes the portable maps for both receivers.

The verifier checks both GLBs against the support plane and a vertical surface basis. It measures all six pads, pose endpoints, shield travel, head-to-shield clearance against the actual underside triangles, jaw and leg continuity, limb separation, health-bar clearance, inverse binds, normalized weights and positive-area triangle overlap in both UV and mesh space. The editable fingerprints cover skin, geometry, topology, UVs, bone hierarchy and animation curves. P3-T7 owns creative acceptance and P4 owns runtime promotion.
