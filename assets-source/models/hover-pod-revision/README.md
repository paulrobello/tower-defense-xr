# Repulsor Hover-Ring Pod, underside revision

The suspended bearing has 32 radial stations at LOD0 and 20 at LOD1. The titanium collector shares normals across its curved profile. Its flat faces and ceramic boundaries retain separate normals. The revised race keeps all four interruptions in the cyan field lens. The outer radius is 0.156 m, the emitter radius is 0.145 m, the central bearing is 0.070 m tall and the radial air gap is 0.018 m. Both LODs retain the identity `hoverPod/mountSocket` anchor, the two named mesh controls and one material.

| Export | Triangles | GLB bytes | Whole-assembly budget |
| --- | ---: | ---: | ---: |
| LOD0 | 2,428 | 3,699,748 | 6,500 |
| LOD1 beyond 4 m | 1,132 | 3,586,352 | 2,500 |

The Helios T3 is the largest registered head in both LODs. Its assembly totals 6,452 and 2,484 triangles, leaving 48 and 16 triangles of headroom.

[Original and revised undersides](review/underside-comparison.jpg) · [High and both LODs from four angles](review/comparison.jpg) · [Approved reference](../../concepts/sheets/cryo-arc.png)

The [archived first pass](../hover-pod/README.md) retains its original files for prior head receipts. The current candidate keeps the same registry ID and carries a separate [receipt for all twelve heads](head-compatibility.json). Each head's original family verifier reimports its exact LOD0 and LOD1 against this mount. A second posed reimport measures a conservative lower bound on separation between the moving head and the actual mount at the original sampled poses and neutral. It uses vertical clearance where positive and per-triangle enclosing boxes where their height ranges overlap. The smallest sampled lower bound is 1.29 mm for Valkyrie T1 at LOD0.

The [reimport measurements](reimport.json) cover the socket at three placement distances, shell intersections, atlas overlap, decoded cyan coverage on both exposed lens faces, ceramic shoulder metalness, flat-face normals and radial normals in the collector. The [repeat receipt](determinism.json) covers the exact deliverable hashes and editable Blender fingerprints. [Source and output inventory](provenance.json).

## Reproduce

Use Blender 5.2.2 LTS and KTX-Software 4.4.2. The Linux runs used three Blender threads, Cycles CPU, two fresh stage directories and two fresh package directories. Run the commands from the repository root.

```sh
for run in a b; do
  "$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 \
    -P blender/hover_pod_revision.py -- --out ".local/hover-stage-$run"
  python3 -B blender/package_hover_pod_revision.py \
    --stage ".local/hover-stage-$run" --models ".local/hover-models-$run" --ktx "$KTX"
done
piece=.local/hover-models-a/hover-pod-revision
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 \
  -P blender/verify_hover_pod_revision.py -- --piece "$piece" \
  --repeat .local/hover-models-b/hover-pod-revision --ktx "$KTX"
RIFT_MODEL_CHECK_KTX="$KTX" make model-check \
  MODEL_CHECK_ARGS="--manifest .local/hover-models-a/manifest.json --ktx $KTX"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 \
  -P blender/verify_hover_pod_revision_heads.py -- --piece "$piece" \
  --registry assets-source/models --ktx "$KTX"
bunx --no-install biome format --write "$piece/head-compatibility.json"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 \
  -P blender/review_hover_pod_revision.py -- --piece "$piece" \
  --original assets-source/models/hover-pod --ktx "$KTX"
```

The review images use EEVEE on Apple Metal. The four fixed 624 px orthographic views and 16 samples match the original camera settings. Runtime registration and physical Quest acceptance belong to Phase 4. The independent reviewer scored this exact pair 81/100. Owner Checkpoint 2 is pending.
