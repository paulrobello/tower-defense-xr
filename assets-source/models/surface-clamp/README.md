# Surface Clamp Base

[Approved shared mount](../../concepts/sheets/autocannon.png) · [High and LOD0 comparison](review/comparison.jpg) · [Bake measurements](geometry.json) · [Re-import measurements](reimport.json) · [Source and output hashes](provenance.json)

The four pressure shoes follow the diagonal layout of the shared Bastion Rib turret sheets. Each has a recessed tread, a silver rolled lip, a dark contact sole and a trunnion seated in the scalloped bearing. A segmented cyan line follows the exposed 0.11 m-radius arcs. The central deck is 0.055 m above the surface. The outermost toe has a measured radial extent of 0.1588081 m inside the 0.16 m placement radius.

## Attachment and cost

`surfaceClamp` and its child `mountSocket` coincide at the host-plane origin. In glTF, +Y points away from the surface and +Z faces forward. Parent the head assembly in this frame and apply its tier-specific `yawRing` height from `src/content/turrets.ts` (0.080–0.100 m). The deck height describes the mesh. Runtime content owns head rotation, recoil, placement collision and the procedural fallback.

`turret-clamp-hub` and `turret-clamp-leg-0` through `turret-clamp-leg-3` are five mesh children with one shared material. Each heel origin is at radial 0.0795 m and height 0.032 m. Leg indices and neutral orientations follow the blockout. All feet stay in their seated pose during gameplay. The baked PBR atlas and shared geometry are intended for read-only use at runtime. A per-instance tint would require material ownership in the P4 loader.

| Export | Triangles | Exported vertices | Primitives | GLB bytes |
| --- | ---: | ---: | ---: | ---: |
| LOD0 | 2,428 | 5,244 | 5 | 4,196,052 |
| LOD1 | 1,148 | 2,394 | 5 | 4,051,552 |

The four 1024 px maps occupy 1,781,812 bytes in KTX2 and 5,592,512 bytes across UASTC mip blocks before Zstandard. Each self-contained GLB embeds this shared atlas and PNG fallbacks. P4 owns cross-LOD texture reuse. The complete turret budgets leave 4,072 LOD0 and 1,352 LOD1 triangles for its paired head. The prescribed distance switch is beyond 4 m.

## Build and evidence

From the repository root, set `BLENDER` to Blender 5.2.2 LTS and `KTX` to KTX-Software 4.4.2. Use a fresh staging directory for each independent build.

```sh
stage=.local/clamp-build
models=.local/clamp-models
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 -P blender/surface_clamp.py -- --out "$stage"
python3 -B blender/package_surface_clamp.py --stage "$stage" --models "$models" --ktx "$KTX"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 -P blender/verify_surface_clamp.py -- --piece "$models/surface-clamp" --ktx "$KTX"
"$BLENDER" -b --factory-startup --python-exit-code 1 -P blender/review_surface_clamp.py -- --piece "$models/surface-clamp" --ktx "$KTX"
make model-check MODEL_CHECK_ARGS="--manifest $models/manifest.json --ktx $KTX"
```

The packed high source preserves the machining profiles and stage materials. The packed low source preserves the triangulated LOD0 receiver with its final UV0 and baked maps. The generator rebuilds the separate distance mesh on the same atlas. A second independent run checks map, receiver and GLB reproducibility. The editable Blender files are identified by delivery hashes.

Projection pairs use isolated component cells. Assembled contact AO is baked before separation. The generator relocates folded chart faces to separate atlas space and gives isolated slivers at least three texels of altitude before baking. Any black color ray miss on a known nonblack finish gets its four channels from the receiver material, including assembled contact AO. An independent decoded-color check samples four interior points on every exported triangle. Re-import checks cover both LODs and jointly test the entire atlas for positive-area overlap. The high source and both exported meshes are checked for coincident visible shells, intersections between feet and any hub crossing outside the recessed trunnions. Floor, table and wall specimens each return 0.00113164 m² of contact per shoe.

EEVEE high and re-imported low views use identical camera transforms and lighting. The low images use decoded level-zero KTX2 texels. The floor and wall checks compare the transformed surface normal against the requested world-space normal. The independent visual score and owner decision belong to P3-T7. P4 owns live integration and Quest acceptance.
