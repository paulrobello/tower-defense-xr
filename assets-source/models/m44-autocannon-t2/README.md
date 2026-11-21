# M44 Autocannon T2

[Approved M44 reference](../../concepts/sheets/autocannon.png) · [Matched high and low views](review/comparison.jpg) · [Surface clamp assembly](review/mounted-surface-clamp.png) · [Hover assembly](review/mounted-hover-pod.png)

The tier 2 head has linked twin amber-rimmed apertures. Inset graphite cheek panels sit inside a titanium rim. The low-poly atlas combines material projections from matched components with assembled contact occlusion. Both LODs use the same four 1024 × 1024 maps. Each GLB embeds the KTX2 mip chains and source PNG fallbacks.

The identity root attaches to the placement-origin `mountSocket` on either delivered mount. The `yawRing` carries `pitchCradle`, whose `recoilGroup` carries the shared `muzzleSocket`. Neutral aim is glTF +Z and up is +Y. The runtime owns yaw, pitch, recoil and placement.

| Export | Head triangles | Largest assembled count | Head materials | Exported vertices | GLB bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| LOD0 | 2,816 | 5,244 | 1 | 5,495 | 4,813,816 |
| LOD1 | 944 | 2,092 | 1 | 1,820 | 4,626,156 |

LOD1 starts beyond 4 m. An assembled turret uses two materials. The final re-import also compares decoded metalness on every triangle against its source finish. [Re-import evidence](reimport.json) records decoded color, exact dimensions, animated world-space socket checks and both attachment checks. [Bake measurements](geometry.json) include per-finish UV density and source texel samples. [Repeat hashes](determinism.json) cover two independent CPU bakes and encodes. The two editable Blender archives have different file hashes across staging directories. Their mesh data, UVs, node transforms, material assignments and packed images match in both builds. The [provenance record](provenance.json) identifies the delivered copies and review images.

## Rebuild

Run from the repository root with Blender 5.2.2 LTS and KTX-Software 4.4.2. Use a fresh staging directory for each independent rebuild.

```sh
stage=.local/m44-build-2
models=.local/m44-models
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 -P blender/m44_autocannon.py -- --tier 2 --out "$stage"
python3 -B blender/package_m44.py --tier 2 --stage "$stage" --models "$models" --ktx "$KTX"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 -P blender/verify_m44.py -- --piece "$models/m44-autocannon-t2" --ktx "$KTX"
RIFT_MODEL_CHECK_KTX="$KTX" make model-check MODEL_CHECK_ARGS="--manifest $models/manifest.json --ktx $KTX"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 -P blender/review_m44.py -- --piece "$models/m44-autocannon-t2" --ktx "$KTX"
```

Pass `--repeat-stage` with a second build directory to the re-import verifier to check the editable geometry and packed maps independently of the archive bytes. The four matched EEVEE views share camera transforms, lighting and framing across the editable high source and both decoded low exports. The additional assembly views show the head seated on the two delivered LOD0 mounts. Independent visual scoring, owner review and live Quest acceptance remain pending.
