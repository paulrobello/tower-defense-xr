# Glacier Cryo-Arc T2

The tier 2 head has two separated chamfered electrodes with cyan inward faces. The effect socket faces forward at neutral aim. [Approved sheet](../../concepts/sheets/cryo-arc.png) · [Matched views](review/comparison.jpg) · [Surface clamp](review/mounted-surface-clamp.png) · [Hover pod](review/mounted-hover-pod.png)

| Mesh | Head triangles | With surface clamp | With hover pod |
| --- | ---: | ---: | ---: |
| LOD0 | 1,640 | 4,068 | 4,004 |
| LOD1 | 936 | 2,084 | 2,084 |

Both levels use one 1024-pixel square atlas with embedded base color, tangent normal, packed ORM and emissive maps. The assembled turret takes two materials. Both mounts accept the identity head root. Runtime yaw, pitch and recoil drive separate nodes. The muzzle faces glTF +Z at rest. LOD1 begins beyond four meters.

[Re-import checks](reimport.json) measure each emitter, mount alignment, moving clearance at three poses, decoded face finish and glow, and UV overlap. The neutral pitching assembly clears the clamp by 45.0 mm and the hover pod by 30.0 mm. Three scripted poses exercise the exported yaw, pitch and recoil controls. [Bake measurements](geometry.json) record UV coverage and density, projection repairs and source pixel samples. [Repeat build](determinism.json) compares two complete CPU bakes and KTX2 encodes. A fresh run from the final generator matched both uncompressed meshes, the four PNGs and the bake measurements. [Provenance](provenance.json) binds the exact staged files and review images. Owner review and in-game Quest acceptance remain pending.

## Rebuild

From the repository root, choose a new stage and model directory for each run. Use Blender 5.2.2 LTS and KTX-Software 4.4.2.

```sh
tier=2
for run in 1 2; do
  stage=".local/glacier-stage/$run/$tier"
  models=".local/glacier-models/$run"
  "$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/glacier_cryo.py -- --tier "$tier" --out "$stage"
  python3 -B blender/package_glacier.py --tier "$tier" --stage "$stage" --models "$models" --ktx "$KTX"
done
piece=".local/glacier-models/1/glacier-cryo-arc-t2"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 -P blender/verify_glacier.py -- --piece "$piece" --ktx "$KTX" --repeat-stage ".local/glacier-stage/2/$tier"
RIFT_MODEL_CHECK_KTX="$KTX" make model-check MODEL_CHECK_ARGS="--manifest .local/glacier-models/1/manifest.json --ktx $KTX"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 -P blender/review_glacier.py -- --piece "$piece" --ktx "$KTX"
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/glacier_cryo.py -- --tier "$tier" --out ".local/glacier-stage/final/$tier"
python3 -B blender/document_glacier.py --piece "$piece" --final-stage ".local/glacier-stage/final/$tier" --stages ".local/glacier-stage/1/$tier" ".local/glacier-stage/2/$tier" --packages "$piece" ".local/glacier-models/2/glacier-cryo-arc-t2"
```
