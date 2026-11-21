# Helios Plasma Mortar T1

The revised single-chamber head retains its orange lip around a dark 10 mm-deep well. A small plasma emitter sits at the bottom. The lip and core remain distinct in the front, axial and three-quarter views of both exported levels. The original LOD1 filled the center with a peach disk. [Approved concept](../../concepts/sheets/plasma-mortar.png) · [Original and revised](review/revision-comparison.jpg) · [Matched high, LOD0 and LOD1](review/comparison.jpg) · [Surface clamp](review/mounted-surface-clamp.png) · [Active hover pod](review/mounted-hover-pod.png)

| Mesh | Head triangles | With surface clamp | With active hover pod |
| --- | ---: | ---: | ---: |
| LOD0 | 3,020 | 5,448 | 5,448 |
| LOD1 | 1,300 | 2,448 | 2,432 |

Both levels share one material with 1024 × 1024 base color, tangent normal, packed ORM and emissive maps. Each assembly uses two materials. The head is 0.18 m wide, 0.16 m tall and 0.20 m long. Its neutral effect socket faces glTF +Z at (0, 0.25, 0.16) m. LOD1 begins beyond four meters.

The original clamp and revised hover pod both accept the identity head root. [Reimport evidence](reimport.json) records mounted yaw, pitch and recoil, neutral clearance, material coverage, planar and curved corner normals, zero positive-area UV overlap, physical mouth samples and the decoded RGBA8 hash of each complete mip chain. [Repeat evidence](determinism.json) records two independent Linux builds and editable-source fingerprints. [Provenance](provenance.json) identifies the model inputs and outputs. The [prior receipt](review/prior-reimport.json.orig) preserves the original T1 reimport evidence used by the hover-pod compatibility report. Independent visual review scored this revision 83/100. The reviewer noted gray mottling on the LOD1 shell and visible pivot corners. Owner approval and in-game Quest acceptance are pending.

## Rebuild

Use Blender 5.2.2 LTS (d13f752e3b9c), KTX-Software 4.4.2 and two fresh staging paths. Export the baseline review package from the stated commit. Run the EEVEE review on a Metal GPU. The Linux bake uses two CPU threads and each encoder uses one.

```sh
root=".local/helios-t1-revision"
id="helios-plasma-mortar-t1"
mkdir -p "$root/original"
git archive 4f18f1fee8c46f934bc4f980e4bf9b816b652e88 "assets-source/models/$id" | tar -x -C "$root/original"
old="$root/original/assets-source/models/$id"
for run in 1 2; do
  "$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/helios_t1_revision.py -- --tier 1 --out "$root/stage/$run"
  python3 -B blender/package_helios_t1_revision.py --stage "$root/stage/$run" --models "$root/packages/$run" --ktx "$KTX"
done
piece="$root/packages/1/$id"
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/verify_helios_t1_revision.py -- --piece "$piece" --repeat "$root/packages/2/$id" --ktx "$KTX"
python3 -B scripts/validate_glbs.py --manifest "$root/packages/1/manifest.json" --ktx "$KTX"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 -P blender/review_helios_t1_revision.py -- --piece "$piece" --original "$old" --ktx "$KTX"
```

Copy the candidate package into its tracked directory, format determinism.json using the project Biome formatter, then rebuild the receipt and format provenance.json.

```sh
piece="assets-source/models/$id"
python3 -B blender/document_helios_t1_revision.py --piece "$piece" --original "$old"
bunx biome format --write "$piece/provenance.json"
```
