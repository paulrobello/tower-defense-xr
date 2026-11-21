# Valkyrie Rail Sniper T1

The compact single rail has a fine cobalt ribbon with a blue-white center recessed between two silver edges. [Approved concept](../../concepts/sheets/rail-sniper.png) · [Matched high and both LODs](review/comparison.jpg) · [Clamp](review/mounted-surface-clamp.png) · [Hover pod](review/mounted-hover-pod.png)

| Mesh | Head triangles | With surface clamp | With hover pod |
| --- | ---: | ---: | ---: |
| LOD0 | 1,164 | 3,592 | 3,528 |
| LOD1 | 900 | 2,048 | 2,048 |

The root attaches at identity on both mounts. Separate yaw, pitch and recoil nodes carry the muzzle socket, which faces glTF +Z at rest. Four sampled poses include full 55 mm recoil. The smallest verified lower bound on moving-head clearance across both LODs and mounts is 1.3 mm. The head uses one material, and either assembled turret uses two. Both LODs share four portable 1024 px maps. LOD1 starts beyond four meters.

[Exact re-import and decoded texel probes](reimport.json) · [Bake and geometry measurements](geometry.json) · [Two independent export and encode runs plus a final-source bake replay](determinism.json) · [Authorship and hashes](provenance.json)

## Rebuild

Run the following from the repository root using Blender 5.2.2 LTS and KTX-Software 4.4.2. Run the review command on a Metal host with ImageMagick and Fontconfig.

```sh
tier=1
for run in 1 2; do
  stage=".local/valkyrie-stage/$run/$tier"
  models=".local/valkyrie-models/$run"
  "$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/valkyrie_rail.py -- --tier "$tier" --out "$stage"
  python3 -B blender/package_valkyrie.py --tier "$tier" --stage "$stage" --models "$models" --ktx "$KTX"
done
piece=".local/valkyrie-models/1/valkyrie-rail-sniper-t1"
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/verify_valkyrie.py -- --piece "$piece" --ktx "$KTX" --repeat-stage ".local/valkyrie-stage/2/$tier"
python3 scripts/validate_glbs.py --manifest .local/valkyrie-models/1/manifest.json --ktx "$KTX"
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/review_valkyrie.py -- --piece "$piece" --ktx "$KTX"
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/valkyrie_rail.py -- --tier "$tier" --out ".local/valkyrie-stage/final/$tier"
python3 -B blender/document_valkyrie.py --piece "$piece" --final-stage ".local/valkyrie-stage/final/$tier" --stages ".local/valkyrie-stage/1/$tier" ".local/valkyrie-stage/2/$tier" --packages "$piece" ".local/valkyrie-models/2/valkyrie-rail-sniper-t1"
```
