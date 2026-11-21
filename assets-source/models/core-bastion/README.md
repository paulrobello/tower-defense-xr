# Core Bastion

[Approved Bastion Rib sheet](../../concepts/sheets/core-bastion.png) · [Matched high and staged GLB views](review/comparison.jpg) · [Emitter motion](review/emitter-motion.webp) · [Geometry and bake data](geometry.json) · [Blender re-import and motion](reimport.json) · [Source and candidate hashes](provenance.json)

An octagonal graphite ceramic housing with paired brushed-titanium spines, recessed side cassettes and a keyed service cover. A seven-sided cyan–violet prism floats within the slotted containment collar. The pale segmented ground emitter occupies the shield annulus. Each independently controlled part exports as one mesh primitive.

| glTF node | Pivot height | Function |
| --- | ---: | --- |
| `coreBastion` | 0 m | Place the root at the calibrated surface anchor. glTF +Y is up and +Z is forward. The three indicator marks face forward. |
| `pedestal` | 0 m | The octagonal foot contacts the plane at radius 0.38 m. The taper reaches radius 0.3116 m at y = 0.4032 m. The cover is recessed on the underside. |
| `energyCrystal` | 0.57 m | Local Y is the spin axis. Neutral tip height is 0.72 m. The blockout supplies 0.9 rad/s spin and ±0.018 m bob around the nominal pivot. |
| `containmentCollar` | 0.4032 m | The separate carrier and twelve luminous vanes sit above the pedestal crown. The pivot uses the source collar elevation. |
| `shieldEmitterRing` | 0.012 m | Eight interrupted arcs rotate on local Y. The `ShieldEmitterSweep` action turns once in eight seconds. The arcs lie within the blockout ground-ring annulus of 0.485–0.52 m. |

The staged low has 6,826 triangles, 15,034 exported vertices, four primitives, three materials and no bones. The editable high has 13,554 triangles. The GLB is 11,029,476 bytes with its embedded PNG fallbacks. The four compressed map files total 4,561,016 bytes and carry twelve mip levels each. Their UASTC blocks occupy 22,369,728 bytes before Zstandard compression. Actual device texture residency depends on the P4 transcoder and renderer.

All four controls are children of the placement root. The runtime owns the translucent 0.52 m hit dome, hit flash, and 0.55 m placement keep-out. The source geometry includes no collider or skeleton. The prism and emitter have distinct material bindings for state-driven effects. The future runtime loader should clone mutable materials per instance.

## Source and bake

The shape generator builds an editable high source and a lower tessellation of the same machining profiles. Each blend contains the named controls and packed textures. Mesh vertex groups identify the individual shell, insert, vane and fastener components. The surface UVs use the project material library's physical tile dimensions. The final low carries one unique packed UV0 atlas.

Blender triangulates the receiver before UV projection. Cycles casts the high-to-low rays in an isolated cell for each physical part, then restores its vertex coordinates. The generator checks that positions, topology, corner normals and UV0 retain their original hash. Directions deviating by more than 12° from the independent receiver finish identify a ray crossing a hard seam. These texels use the receiver's own material sample in all four channels. Short-range contact AO is evaluated on the assembled model and multiplied into the library AO. Texture dilation covers ten pixels around each island.

The self-contained GLB embeds four 2048² UASTC/Zstandard KTX2 textures and matching original PNG fallbacks. RGB color and emission use sRGB. The tangent normal and packed ORM use linear transfer. The ORM channels contain occlusion, roughness and metalness, in that order. Each material binds the same ORM image for glTF occlusion and metallic/roughness. Blender uses the PNG fallback for direct re-import. The low review renderer replaces its image samples with decoded KTX2 level zero for the matched comparison.

## Reproduce

Run from the repository root. Use Blender 5.2.2 LTS and KTX-Software 4.4.2. Use fresh build and packaging directories for each run. The archived candidate used a Linux x86-64 CPU for the Cycles bake and encoder, and an Apple Silicon GPU for the EEVEE review.

```sh
stage=$(mktemp -d)
models=$(mktemp -d)
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/core_bastion.py -- --out "$stage"
python3 -B blender/package_core_bastion.py --stage "$stage" --models "$models" --ktx "$KTX"
python3 -B scripts/validate_glbs.py --manifest "$models/manifest.json" --ktx "$KTX"
asset="$models/core-bastion"
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/verify_core_bastion.py -- --glb "$asset/core-bastion.glb" --report "$asset/reimport.json" --ktx "$KTX"
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/review_core_bastion.py -- --source "$asset/high.blend" --label high --out "$asset/review"
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/review_core_bastion.py -- --source "$asset/core-bastion.glb" --label low --motion --out "$asset/review" --ktx "$KTX"
```

Run `make model-check` against the registered staging set. The review uses fixed front, isometric, crystal detail and underside orthographic views with 24 EEVEE samples at 768 × 768. The one-second overhead motion loop shows one sector of the eightfold emitter sweep at 12 frames per second. P3-T7 owns the independent visual score and Paul's hash-bound sign-off. P4 owns the runtime swap, play-distance review, failure fallback and Quest checks.
