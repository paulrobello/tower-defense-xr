# Rift Spitter

`high.blend` is the editable sculpt approved on November 26, 2026. `low.blend` contains the fitted LOD0 receiver, packed maps and retargeted armature. Both runtime LODs use one skinned mesh, one material and 23 joints. Their neutral dimensions are 0.40 m long, 0.30 m wide and 0.24 m tall. The glTF root is at the support plane with +Y up and +Z forward.

| Level | Triangles |
| --- | ---: |
| LOD0 | 4,380 |
| LOD1 | 2,070 |

The five clips reuse the Skitter Crawler performances. Crawl and climb stay in place so the simulation can drive translation along the room surfaces. Ranged fire triggers the attack clip once per shot. Both GLBs embed four 1024 × 1024 maps as KTX2 with PNG fallbacks. The ORM map uses neutral ambient occlusion.

`geometry.json` records the baked maps and Blender's intermediate exports. The two tangent receipts identify the published GLBs and record the single cap tangent repaired in LOD0. `reimport.json` records the measurements from the packaged files, including both locomotion loops and all six claw contacts. Astra at high effort authored the sculpt and runtime model. An independent Astra review scored the final model 88/100 at tabletop scale.

## Reproduction

Run from the repository root with Blender 5.2.2 LTS and KTX-Software 4.4.2. Set `OUT` to an empty staging directory and `BLENDER` and `KTX` to the executable paths. The source bakes ran on Linux x86_64.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 \
  -P blender/rift_spitter_runtime.py -- \
  --sculpt assets-source/models/rift-spitter/high.blend \
  --skitter assets-source/models/skitter-crawler/low.blend --out "$OUT/stage"
cp assets-source/models/rift-spitter/high.blend "$OUT/stage/high.blend"
python3 -B blender/package_rift_spitter.py --stage "$OUT/stage" \
  --models "$OUT/models" --ktx "$KTX"
python3 -B scripts/validate_glbs.py --manifest "$OUT/models/manifest.json" --ktx "$KTX"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 \
  -P blender/verify_rift_spitter_runtime.py -- \
  --piece "$OUT/models/rift-spitter" --report "$OUT/reimport.json"
```
