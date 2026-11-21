# Rift Bastion art review

## Tactical icons and launch art

**P3-T7 owner sign-off is pending.** This set applies the approved Bastion Rib direction to the Build wheel, Turret Command wheel, mission status, and two launch surfaces. The previews below show the staged files. The game still uses its existing UI until the separately approved integration.

### Menu and status icons

![Eighteen tactical icons with 24 px proofs on dark and light fields](../assets-source/ui/review/icon-proof.png)

The large samples show shape and finish. The small pair under each name shows the same RGBA file at 24 px over dark and light backgrounds. The M44 uses a short horizontal amber muzzle, Helios a broad angled orange mouth, Glacier an open cyan fork and Valkyrie a long slotted blue rail. The tier chevrons increase in count. A hollow star keeps its center transparent.

The atlas is **768 × 384**, with six 128 px cells per row and transparent gutters. Coordinates are top-left pixel rectangles. Each [individual PNG](../assets-source/ui/candidates/icons/) matches the corresponding [atlas](../assets-source/ui/candidates/tactical-atlas.png) cell byte for byte after decoding. The [atlas metadata](../assets-source/ui/candidates/atlas.json) gives each icon’s immutable sheet and crop rectangle, packed rectangle, desktop actions, radial action IDs, and state-dependent selections.

| Atlas row | Columns from left to right |
| --- | --- |
| 0 | M44, Helios, Glacier, Valkyrie, launch wave, wave warning |
| 1 | Tier 1, tier 2, tier 3, relocate, sell, EMP disrupted |
| 2 | First target, strongest target, closest target, air target, earned star, empty star |

All nine wheel actions have mappings. Upgrade selects the next tier, or the tier 3 icon when capped. Target priority selects the currently active mode. The radial center keeps its existing Cancel/Close behavior. Desktop quick-build keys 1–4 select the matching turret; U, T, R, X and Space use the corresponding command or wave art. [Radial action definitions](../src/xr/radial-controls.ts) · [Desktop controls](../src/desktop/controls.ts)

### Desktop and Quest launch art

![Independently composed desktop and Quest candidates with sample live title overlays](../assets-source/ui/review/title-proof.jpg)

The desktop scene places the defense on a living-room sideboard and reserves the shaded sofa wall on the left for type. The Quest card puts the crystal and rift above the title. Both staged JPEGs are text-free. Their safe rectangles are given as left, top, right, bottom pixels, with the last two coordinates exclusive.

| Surface | Candidate | White title safe rectangle | Lowest white-text contrast within rectangle |
| --- | --- | --- | --- |
| Desktop, 16:9 | [1920 × 1080 JPEG](../assets-source/ui/candidates/desktop-title.jpg) | 76, 248, 749, 810 | 15.36:1 |
| Quest, square | [1024 × 1024 JPEG](../assets-source/ui/candidates/quest-title.jpg) | 102, 768, 922, 963 | 17.55:1 |

### Evidence and status

The three Nano Banana Pro sheets contain six icons each. Three background-removal jobs supplied the alpha mattes. The remover dropped disconnected objects on the Build sheet, so the deterministic packer restores missing ink from the corresponding white-background original. Tight crops and two isolation polygons exclude stray reference art. The thin titanium outline keeps the dark silhouettes visible over a dark radial segment. At 24 px, every candidate has at least 18 rendered pixels at 3:1 contrast on each review field. The glyph proof above supports visual inspection alongside that measurement.

Higgsfield billed **15 credits**. That includes one replacement desktop illustration. The first desktop source had a hard vertical seam across the scene. All nine provider originals remain unchanged. The [source manifest](../assets-source/ui/provenance.json) records each prompt, input hash, source hash, settings, job ID, cost, and provider rights references. [SHA-256 inventory](../assets-source/ui/checksums.json)

From a bootstrapped repository root, run these commands to reproduce the 22 candidate files in a temporary directory and check staging against the nine provider sources, references, atlas pixels, title contrast and 27 hashes. The build uses the repository's pinned Biome to format atlas metadata.

```sh
uv run --no-project --python 3.13 --with pillow==12.3.0 python assets-source/ui/build.py --check
uv run --no-project --python 3.13 --with pillow==12.3.0 python assets-source/ui/verify.py
```

The independent P3-T7 score and Paul’s approval remain open. Physical Quest review and live overlay integration belong to the subsequent runtime phase.

## Shared Bastion Rib materials

![Five shared materials shown on curved coupons and 2×2 repeats under two light angles](../assets-source/materials/review/surfaces.jpg)

The Blender 5.2.2 library contains brushed titanium, matte ceramic, dark gunmetal, obsidian chitin and rift obsidian. A fresh build produced the same 16 source PNGs and 16 KTX2 files. Blender export and re-import preserved all five materials and 16 texture bindings. The KTX2 set totals 465,162 bytes. See the [material review and authoring instructions](../assets-source/materials/README.md), [map inventory](../assets-source/materials/manifest.json) and [decoded texture measurements](../assets-source/materials/quality.json). Independent scoring and the owner's release approval remain open at P3-T7.

## Core Bastion

![Matching high and re-imported low Core Bastion views](../assets-source/models/core-bastion/review/comparison.jpg)

The 6,826-triangle staged Core uses four 2048 px maps. Blender re-import preserved the 0.38 m base radius, 0.72 m visual height, separate shield envelope and emitter animation. The low views use decoded KTX2 textures. See the [Core sources, hashes and re-import checks](../assets-source/models/core-bastion/README.md) and [emitter motion](../assets-source/models/core-bastion/review/emitter-motion.webp). The Core remains staged for independent scoring and owner approval at P3-T7.

## Dimensional Rift Portal

![Matching high and re-imported low Rift portal views, including the oblique host and open aperture](../assets-source/models/rift-portal/review/comparison.jpg)

The staged frame is 4,056 triangles and uses five 1024 px maps. The 0.95 × 1.35 m aperture disk shares all 104 boundary positions with the frame. The in-plane rim is 0.12 m wide at both axes. Its 72 mm axial span runs from the −25 mm shader surface to the +47 mm crown and rests against the anchor at Z = 0. The oblique proof uses a synthetic host plane cut to the same ellipse. The current circular runtime stencil and scanned-wall sampling remain Phase 4 verification work. [Rift sources, hashes and re-import checks](../assets-source/models/rift-portal/README.md)
