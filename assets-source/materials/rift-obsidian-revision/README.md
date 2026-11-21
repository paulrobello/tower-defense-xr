# Revised Rift obsidian

This candidate keeps a 220 mm tile, 256 × 256 texels and the Rift’s dark violet dielectric glass. The original 24-face field had a bright teal junction that repeated on a square grid. The revised field uses 77 unevenly spaced facets and tapers the emissive fill as three fractures meet. Short inclusions vary in length, hue and intensity. A minimum distance between seeds prevents nearly coincident planes from creating broad glowing patches.

## Selecting the material

In a fresh Blender build, call `materials.material("rift-obsidian", Path("assets-source/materials/rift-obsidian-revision").resolve())` before binding another material with the same Blender name. The binding helper caches by name. Alternatively, append `RB.rift-obsidian` from the editable library next to this README. One metre spans 4.545 repeats. Base color and emission are sRGB, the tangent normal is linear OpenGL +Y, and linear ORM holds occlusion, roughness and metallic in RGB order.

The earlier Rift Portal GLB was reviewed against the original four PNGs in the sibling `../rift-obsidian/` directory. Its generator continues to read them through the original library. The historic source receipt, maps, gallery, library and Portal remain available at their original paths. [Original manifest bytes](original-manifest.json) use paths relative to the parent materials directory and match the hash in the original [library receipt](../provenance.json). The active [material manifest](../manifest.json) selects the four revised staged KTX2s. Runtime registration and owner review are pending.

## Regenerate

Run from the repository root with Blender 5.2.2 LTS and KTX-Software 4.4.2. The package step expects the pinned encoder at the default location specified in `scripts/assets/ktx2.py`.

```sh
stage=$(mktemp -d)
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/rift_obsidian_revision.py -- build --out "$stage"
python3 blender/package_materials.py --out "$stage"
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/rift_obsidian_revision.py -- verify --out "$stage"
python3 scripts/validate_glbs.py --manifest "$stage/manifest.json"
"$BLENDER" -b -t 2 --factory-startup --python-exit-code 1 -P blender/rift_obsidian_revision.py -- review --out "$stage"
```

The review uses the original EEVEE studio and scale. The [comparison strip](review/rift-obsidian.webp) contains the curved coupon, the full soft-lit 2 × 2 and the full raking-lit 2 × 2, each at 512 × 512. Each planar render samples a 440 mm square at one screen pixel per source texel. [Earlier comparison](../review/rift-obsidian.webp) · [Channel measurements](quality.json) · [Source, inputs and proof hashes](provenance.json).
