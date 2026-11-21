# Skitter Crawler

The F8 revision gives the crawler five pairs of swept, overlapping obsidian shields. A tapered frontal visor covers the jaw muscles. Pointed guards at the six knees follow their tibiae. Violet tissue widens into raised nodes along the recessed dorsal channel.

| Source or receiver | Triangles | Neutral length × width × height |
| --- | ---: | --- |
| Editable high source | 60,752 | 0.34000 × 0.26004 × 0.18098 m |
| LOD0 | 3,904 | 0.34000 × 0.26000 × 0.18000 m |
| LOD1 | 1,994 | 0.34000 × 0.25995 × 0.17967 m |

Both GLBs use one material, 23 joints and four shared 1024 px atlases. The identity root named `Skitter` sits at the support plane, with glTF +Y up and +Z forward. The game owns translation, surface alignment, the 0.14 m collision radius and the 0.28 m health-bar offset. The staged LOD switch is 6 m.

[Original and revised model](review/revision-comparison.jpg) · [Matched source and both LODs](review/comparison.jpg) · [Matched floor and wall poses](review/locomotion.jpg) · [Five clip sequences](review/motion.jpg) · [Clip playback](review/motion.mp4) · [Turntable](review/turntable.mp4)

`crawl_floor` and `climb_wall` alternate supporting tripods in place. `attack` opens the mandibles, lunges and recovers. `hit` rolls and recoils. `death` drops the thorax, tucks the legs and holds the last pose. Re-import checks cover joint hierarchy, inverse binds, normalized single-joint weighting, idle bounds, visible movement, root stability, clip endpoints, six foot trajectories, connected articulations and leg separation. The oriented fixture evaluates the complete deformed mesh and all six contact tips after applying the floor or wall transform to the actual armature.

[Imported geometry, clip and texture measurements](reimport.json) · [Build hashes and editable-source fingerprints](provenance.json) · [Art direction](../../../docs/art-bible.md)

## Reproduction

Run from the repository root with Blender 5.2.2 LTS and KTX-Software 4.4.2. The reference bakes used Linux x86_64. Set `OUT` to an empty working directory outside the candidate package. Supply `BLENDER` and `KTX` as absolute executable paths. `ORIGINAL` is the Skitter package from Git commit `a8894e87923fb7856f5ffafe654bfc46f8f632e2`.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
for build in a b; do
  "$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 \
    -P blender/skitter_crawler_revision.py -- --out "$OUT/$build"
  python3 blender/package_skitter.py --stage "$OUT/$build" \
    --models "$OUT/models-$build" --ktx "$KTX"
  "$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 \
    -P blender/verify_skitter.py -- --sources-only "$OUT/models-$build/skitter-crawler"
done

PIECE="$OUT/models-a/skitter-crawler"
python3 scripts/validate_glbs.py --manifest "$OUT/models-a/manifest.json" --ktx "$KTX"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 \
  -P blender/verify_skitter.py -- --piece "$PIECE" --ktx "$KTX"
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 \
  -P blender/verify_skitter_revision.py -- --piece "$PIECE" --ktx "$KTX"
```

Generate the visual evidence with the pinned Blender and KTX on a Metal host with FFmpeg and ImageMagick. Run the documentation command against a final package containing the first build, its reimport report, review directory and this README. The two independent source-fingerprint receipts remain in their respective build directories.

```sh
"$BLENDER" -b -t 3 --factory-startup --python-exit-code 1 \
  -P blender/review_skitter_revision.py -- --piece "$PIECE" --ktx "$KTX" --original "$ORIGINAL"
python3 -B blender/document_skitter_revision.py --piece "$FINAL_PIECE" --first "$PIECE" \
  --second "$OUT/models-b/skitter-crawler" --original "$ORIGINAL"
```

The portable GLBs embed both the original PNG and KTX2 for each role. The review reloads decoded KTX2 pixels. The revision received an independent score of 83/100, up from 77/100. The reviewer noted the straight legs and slight loss of eye and shoulder detail at LOD1. Batch owner approval, P4 runtime integration and physical Quest acceptance remain pending.
