# Repulsor Hover-Ring Pod

[Approved turret sheet](../../concepts/sheets/cryo-arc.png) · [High and both LODs](review/comparison.jpg) · [Bake measurements](geometry.json) · [Exact GLB re-import](reimport.json) · [Source and output hashes](provenance.json)

Four graphite ceramic coil jackets wrap a brushed titanium race. The cyan lens faces outward and down, with a dark break at each radial rib. Its central bearing floats inside the race. A recessed underside collector and a second cyan line mark the bearing from below.

## Mount and material

The glTF root is `hoverPod`. Its identity child `mountSocket` attaches the head at the placement origin. Local +Y is up and +Z is forward. The two mesh children match the blockout names `turret-hover-repulsor-ring` and `turret-hover-repulsor-core`. The head takes its tier-specific yaw height from `src/content/turrets.ts`. Runtime owns hover depth, orientation, placement clearance, and the procedural fallback.

The core spans 0.000–0.070 m in height. The nominal emitter radius is 0.145 m, the maximum outer radius is 0.156 m, and the clear space between the core and the race is 0.018 m. Each LOD uses two primitives and one shared material. The shared atlas has four 1024 × 1024 maps, with sRGB base color and emission, a linear tangent-space normal, and linear ambient occlusion, roughness and metalness in RGB. Each GLB embeds its KTX2 mip chains and exact source PNG fallbacks. Instances can share the immutable geometry and material.

| Export | Triangles | Exported vertices | GLB bytes | Remaining head triangles |
| --- | ---: | ---: | ---: | ---: |
| LOD0 | 2,364 | 5,444 | 3,862,052 | 4,136 |
| LOD1, beyond 4 m | 1,148 | 2,673 | 3,721,736 | 1,352 |

The four compressed maps occupy 1,619,838 bytes. The atlas reserves 90.9% of its area for the two LOD receivers. Level-zero decoded color samples found cyan on 84.9% of the underside lens area and 84.9–85.0% of its outer face. All 14,048 sampled base-color values had at least one channel of 36/255 or higher. All 224 decoded samples on the ceramic bearing shoulder measured zero metalness.

## Build and verification

Run from the repository root with Blender 5.2.2 LTS and KTX-Software 4.4.2. Keep the build directory and candidate registry outside the tracked source directory.

```sh
stage=.local/hover-build
models=.local/hover-models
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 -P blender/hover_pod.py -- --out "$stage"
python3 -B blender/package_hover_pod.py --stage "$stage" --models "$models" --ktx "$KTX"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 -P blender/verify_hover_pod.py -- --piece "$models/hover-pod" --ktx "$KTX"
RIFT_MODEL_CHECK_KTX="$KTX" make model-check MODEL_CHECK_ARGS="--manifest $models/manifest.json --ktx $KTX"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 -P blender/review_hover_pod.py -- --piece "$models/hover-pod" --ktx "$KTX"
```

The packed high source preserves the editable geometry and project finish maps. The low file contains the triangulated LOD0 and packed baked maps. Both LOD receivers unwrap together using continuous circumference charts and planar cap islands. The profile chart reserves at least five texels per cross-section step. The four Cycles projections pair each low component with its corresponding high source. An additional Cycles pass compares the high and low material IDs and identifies rays that land across a machined lip. The receiver supplies its physical finish at missed or cross-material rays, and the assembled model supplies contact occlusion.

The re-import check measures world-space upright orientation, facing and socket translation at three hover depths. It checks shell crossings, positive-area coplanar overlap, joint atlas overlap, cyan lens coverage and four decoded color samples per triangle. Matched EEVEE views show both compressed LODs and the editable high source from above, below, in profile and in three-quarter view. Owner Checkpoint 2 and live Quest acceptance remain pending.
