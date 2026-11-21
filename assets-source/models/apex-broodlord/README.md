# Apex Broodlord

The Wave 12 matriarch stands on four recurved blade legs. A broad angular brow carries a single magenta suture into the swept, split crest. Narrow eyes and hooked mandibles sit above the raised, three-fingered foreclaws. Lapped breast plates and pointed abdominal scutes cover the dark underplate. Magenta veins and eyes identify Phase 1. At half health the same armor shows an additional network of molten-orange fissures.

| Receiver | Triangles | Neutral length × width × height | Range |
| --- | ---: | --- | --- |
| LOD0 | 23,480 | 0.92000 × 0.78000 × 0.84000 m | Through 8 m |
| LOD1 | 7,840 | 0.92000 × 0.77982 × 0.84000 m | Beyond 8 m |

The [approved three-view concept](../../concepts/sheets/apex-broodlord.png) guides the silhouette and the two phases. The 80,016-triangle editable high source and both receivers contain 98 surface patches. Each receiver has one material, one skinned primitive, 28 joints and one normalized influence per vertex. Both LODs share the same bind. Fitting the revised outline moved the right hind blade joint by 15.85 mm from round one. The six actions retain their original channel targets, sampling times and interpolation. The root sits on the support plane. Blender +Z up and −Y forward map to glTF +Y up and +Z forward. Simulation owns travel, facing, the 0.42 m collision radius and the health bar at 1.02 m.

The four embedded 2048 px maps supply sRGB base color, linear tangent normal, linear occlusion/roughness/metalness and sRGB magenta emission. Both LODs reuse the same UV0 charts. The area-weighted density of their single chitin material is 914 texels/m at LOD0 and 895 texels/m at LOD1. The independent `phase2-cracks.ktx2` has a lossless PNG fallback. Its grayscale values encode linear crack coverage with the sRGB transfer function, including fractional edge coverage. Sample it through an sRGB texture view, tint the decoded intensity with linearized sRGB `#ff4d00` and add it to native emission. The phase factor is zero at rest and one in Phase 2. Its binding belongs to P4.

| Clip | Intervals at 30 fps | Performance |
| --- | ---: | --- |
| `boss_march` | 54 | Alternates diagonal leg pairs with a brief full-support interval and returns to its starting pose. |
| `spawn_adds` | 46 | Lowers the chest, lifts the segmented abdomen and spreads the foreclaws, then recovers. |
| `emp_roar` | 42 | Raises the head and chest, thrusts both foreclaws upward and recovers. |
| `phase2_shift` | 48 | Opens the crest halves and flexes the foreclaws as the fissure mask takes effect. The skeletal pose returns to neutral. |
| `hit` | 20 | Recoils to one side and recovers with all four points planted. |
| `death` | 52 | Splays the feet, lowers the body, folds the crest and holds the terminal pose. |

[Original and revised LOD0](review/revision-comparison.jpg) · [Source and both receivers under five matching cameras](review/comparison.jpg) · [Both phases on both receivers](review/phases.jpg) · [Six-clip motion reel](review/motion.mp4) · [Key poses](review/motion.jpg) · [Turntable](review/turntable.mp4) · [Reimport measurements](reimport.json) · [Provenance and clean-repeat hashes](provenance.json)

## Reproduction

From the project root, use Blender 5.2.2 LTS and KTX-Software 4.4.2. Repeat with two empty Linux x86_64 stage and package directories. The review command uses EEVEE on macOS Metal.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 PYTHONHASHSEED=0
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 --python blender/apex_broodlord_revision.py -- --out "$STAGE"
python3 blender/package_broodlord.py --stage "$STAGE" --models "$MODELS" --ktx "$KTX"
python3 blender/package_broodlord_revision.py --models "$MODELS"
python3 scripts/validate_glbs.py --manifest "$MODELS/manifest.json" --ktx "$KTX"
"$BLENDER" -b -t 1 --factory-startup --python-exit-code 1 --python blender/verify_broodlord.py -- --piece "$MODELS/apex-broodlord" --ktx "$KTX"
"$BLENDER" -b -t 1 --factory-startup --python-exit-code 1 --python blender/verify_broodlord_revision.py -- --piece "$MODELS/apex-broodlord"
python3 blender/document_broodlord_revision.py --raw-stage "$STAGE" --raw-receipt "$MODELS/raw-stage.json"
```

Extract the original candidate from commit `80c2b4fe7a0b092d44ec9bc532d8029d1d5976b0` into `$ORIGINAL`. Copy the first package files into the candidate folder containing this README and set `$CANDIDATE` to that folder. Render that exact copy on Metal and bind the result to both clean packages.

```sh
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 --python blender/review_broodlord_revision.py -- --piece "$CANDIDATE" --original "$ORIGINAL" --ktx "$KTX"
python3 blender/document_broodlord_revision.py --piece "$CANDIDATE" --first "$FIRST_MODELS/apex-broodlord" --repeat "$REPEAT_MODELS/apex-broodlord" --original "$ORIGINAL"
```

Each half-frame sweep tests 26 joint bearings and the clearance of the distal crest, foreclaws and leg blades. The verifier exercises three staged skeletal blends at five weights each. The roar-to-hit interruption showed the deepest transient contact, approximately 0.61 mm below the support plane. The deepest sampled penetration in an authored clip was 0.014 mm.

The independent review scored the hash-bound F11 revision 82/100, up from 75/100. It noted the tall symmetric tips, smooth underside, recessed jaws, flatter cracks and LOD1 faceting. The combined owner review is pending. P4 owns runtime phase switching, lifecycle tests and Quest acceptance.
