# Helios Plasma Mortar T3

The tier 3 head has two round thermal chambers surrounded by a wide siege crown. The bright rim tracks the inclination of the orange plasma surface. Its central effect socket retains the game's neutral forward direction. [Approved sheet](../../concepts/sheets/plasma-mortar.png) · [Matched views](review/comparison.jpg) · [Surface clamp](review/mounted-surface-clamp.png) · [Hover pod](review/mounted-hover-pod.png)

| Mesh | Head triangles | With surface clamp | With hover pod |
| --- | ---: | ---: | ---: |
| LOD0 | 4,024 | 6,452 | 6,388 |
| LOD1 | 1,352 | 2,500 | 2,500 |

Both levels use one 1024-pixel square atlas with embedded base color, tangent normal, packed ORM and emissive maps. The assembled turret takes two materials. Both mounts accept the identity head root. Runtime yaw, pitch and recoil drive separate nodes. The muzzle faces glTF +Z at rest. LOD1 begins beyond four meters.

[Re-import checks](reimport.json) measure each chamber rim, mount alignment, face finish and glow, and UV overlap. The neutral pitching assembly clears the clamp by 65.0 mm and the hover pod by 50.0 mm. Three scripted poses exercise the exported yaw, pitch and recoil controls. [Bake measurements](geometry.json) record UV coverage and density, projection repairs and source pixel samples. [Repeat build](determinism.json) compares two complete CPU bakes and KTX2 encodes. A third clean run of the final generator also matched both uncompressed geometry exports, all four PNGs and the bake measurements. [Provenance](provenance.json) binds the exact staged files and review images. Owner review and in-game Quest acceptance remain pending.

## Rebuild

From the repository root, choose a new stage and model directory for each run. Use Blender 5.2.2 LTS and KTX-Software 4.4.2.

```sh
tier=3
for run in 1 2; do
  stage=".local/helios-stage/$run/$tier"
  models=".local/helios-models/$run"
  "$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/helios_mortar.py -- --tier "$tier" --out "$stage"
  python3 -B blender/package_helios.py --tier "$tier" --stage "$stage" --models "$models" --ktx "$KTX"
done
piece=".local/helios-models/1/helios-plasma-mortar-t3"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 -P blender/verify_helios.py -- --piece "$piece" --ktx "$KTX" --repeat-stage ".local/helios-stage/2/$tier"
RIFT_MODEL_CHECK_KTX="$KTX" make model-check MODEL_CHECK_ARGS="--manifest .local/helios-models/1/manifest.json --ktx $KTX"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 -P blender/review_helios.py -- --piece "$piece" --ktx "$KTX"
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/helios_mortar.py -- --tier "$tier" --out ".local/helios-stage/final/$tier"
python3 -B blender/document_helios.py --piece "$piece" --source-replay ".local/helios-stage/final/$tier" --stages ".local/helios-stage/1/$tier" ".local/helios-stage/2/$tier" --packages "$piece" ".local/helios-models/2/helios-plasma-mortar-t3"
```
