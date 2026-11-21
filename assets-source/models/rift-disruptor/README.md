# Rift Disruptor

Four violet shields wrap each shoulder of the faceted hull. A recessed central window on each side sits between cyan meridians. Polar wells close both ends. The outer field ring has a broad index sector followed by a short second mark and three offset ticks, making its phase visible from above.

| Receiver | Triangles | Neutral length × width × height | LOD range |
| --- | ---: | --- | --- |
| LOD0 | 4,152 | 0.42 × 0.44 × 0.32 m | Through 6 m |
| LOD1 | 2,424 | 0.42 × 0.44 × 0.32 m | Beyond 6 m |

The editable high source has 6,648 triangles. Each receiver uses one draw primitive, one material, three joints and one normalized rigid influence per vertex. The closed hull and the detached ring are independent connected surfaces. The gameplay root sits at the neutral underside, with glTF +Y up and +Z forward. Simulation supplies flight and facing, collision radius 0.20 m and health bar height 0.44 m.

The four clips use 30 authored frames per second. The two-second `hover_glide` loop rolls and lifts the hull during one complete rotor turn. The 1.2-second `emp_pulse` draws the rotor down, then throws it upward and returns to neutral. The 20-frame `hit` recoils laterally and recovers. The 42-frame `death` banks and drops the hull by 72 mm, tilts and lowers the rotor, then holds the final pose. The 1.2 m gameplay EMP field belongs to Phase 4.

[Matched source and receiver views](review/comparison.jpg) · [Four-clip motion reel](review/motion.mp4) · [Key poses](review/motion.jpg) · [Neutral orbit](review/turntable.mp4) · [Polar well atlas revision](review/polar-well-comparison.jpg) · [Reimport measurements](reimport.json) · [Source and repeat hashes](provenance.json)

## Reproduction

Run from the repository root. Use Blender 5.2.2 LTS and KTX-Software 4.4.2 with two separate empty stage and package directories on Linux x86_64. Generate the review once from the first verified package on macOS with Metal.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 \
  --python blender/rift_disruptor.py -- --out "$STAGE"
python3 blender/package_disruptor.py --stage "$STAGE" --models "$MODELS" --ktx "$KTX"
python3 scripts/validate_glbs.py --manifest "$MODELS/manifest.json" --ktx "$KTX"
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 \
  --python blender/verify_disruptor.py -- --piece "$MODELS/rift-disruptor" --ktx "$KTX"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 \
  --python blender/review_disruptor.py -- --piece "$MODELS/rift-disruptor" --ktx "$KTX"
```

The rest-pose bake transfers high tangent frames onto the receiver through the shared UV charts. Base color and emission use sRGB. Normal and packed occlusion, roughness and metallic use linear channels. Both GLBs embed four 1024 px UASTC textures with eleven mip levels and PNG fallbacks. The verifier decodes every mip to RGBA8, checks normal length and opacity, compares the lossless bake with the decoded base level, and measures the reopened receivers at every authored frame and half-frame. The review remains staged for the combined P3-T7 visual score and owner decision.
