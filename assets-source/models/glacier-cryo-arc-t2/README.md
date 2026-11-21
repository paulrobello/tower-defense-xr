# Glacier Cryo-Arc T2

Two tapered blades project 127.5 mm beyond the upper casing. A recessed cyan channel runs across the inward bevel of each blade. The outer ridge is titanium and the nose is dark. The fork stays open across both levels of detail, with at least 47.6 mm between the blades. The two tip centers remain 93.6 mm apart.

[Approved Glacier sheet](../../concepts/sheets/cryo-arc.png) · [Prior and revised heads on the active mounts](review/revision-comparison.jpg) · [Revised high source and both exported levels](review/comparison.jpg)

| Mesh | Head triangles | On surface clamp | On revised hover pod |
| --- | ---: | ---: | ---: |
| LOD0 | 1,312 | 3,740 | 3,740 |
| LOD1 | 1,088 | 2,236 | 2,220 |

Both levels share one 1024 × 1024 material with embedded base color, tangent normal, ORM and emissive textures. Each assembled turret uses two materials. At neutral aim the shared muzzle socket remains centered 160 mm forward and 260 mm above the mounting plane. The neutral moving assembly clears the clamp by 45 mm and the revised hover pod by 30 mm.

The [reimport measurements](reimport.json) include three yaw, pitch and recoil poses on each actual mount, checks of both tip centers and widths, decoded emission and metalness at 24 physical finish locations per LOD, all eleven mip levels of each KTX2, and a combined UV-overlap test. The [repeat-build record](determinism.json) compares two independent Linux bakes and encodes. The [provenance](provenance.json) binds these outputs, their predecessors and the matched renders. Independent visual review scored this revision 87/100, up from 75/100. The cyan area appears smaller head-on, and one blade occludes the other in the exact side view. Owner review and runtime Quest acceptance remain pending.

## Rebuilding and reviewing

Use Blender 5.2.2 LTS and KTX-Software 4.4.2. From the repository root, set `BLENDER` and `KTX` to the pinned executables. Start in a fresh staging directory.

```sh
work=.local/glacier-t2-revision
id=glacier-cryo-arc-t2
for run in 1 2; do
  "$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/glacier_t2_revision.py -- --tier 2 --out "$work/stage/$run"
  python3 -B blender/package_glacier.py --tier 2 --stage "$work/stage/$run" --models "$work/packages/$run" --ktx "$KTX"
done
piece="$work/packages/1/$id"
python3 -B scripts/validate_glbs.py --manifest "$work/packages/1/manifest.json" --ktx "$KTX"
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/verify_glacier_t2_revision.py -- --piece "$piece" --repeat-stage "$work/stage/2" --ktx "$KTX"
mkdir -p "$work/old/$id" "$piece/review"
git archive 4f18f1fee8c46f934bc4f980e4bf9b816b652e88 "assets-source/models/$id" | tar -x -C "$work/old/$id" --strip-components=3
cp "$work/old/$id/reimport.json" "$piece/review/prior-reimport.json.orig"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 -P blender/review_glacier_t2_revision.py -- --piece "$piece" --before "$work/old/$id" --ktx "$KTX"
python3 -B blender/document_glacier_t2_revision.py --piece "$piece" --prior "$work/old/$id" --stages "$work/stage/1" "$work/stage/2" --packages "$piece" "$work/packages/2/$id"
```
