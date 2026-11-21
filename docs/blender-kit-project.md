# Rift Bastion Blender project

Use the approved [art bible](art-bible.md), [product requirements](../PRD.md) and [Phase 3 plan](../plans/phase-3-art-direction-and-blender-assets.md) for asset authoring.

## Owner decisions and agent policy

- On November 20, 2026, Paul approved Bastion Rib and the eleven concept sheets for Phase 3. Use GPT-6.2 Astra at high for visual work and Blender, and GPT-6.2 Sol for most tooling. Use one Blender authoring agent at a time, following the Phase 3 sequence.
- Use Blender 5.2.2 LTS. Preserve deterministic generators and separate high- and low-poly sources under `assets-source/`. Use sibling Git worktrees and bootstrap with `bun install --frozen-lockfile`.
- Paul approves the complete asset batch at Owner Checkpoint 2. Provenance records the actual authoring model and effort. Before and after a timing run, the one-minute host load must be at most 15.

## Frame, pivots and seams

One Blender unit equals one meter. Blender +Z up and −Y forward map to glTF +Y up and +Z forward. The Core and turrets root at the anchor or mount plane. The portal roots at its aperture plane and faces the host surface normal in runtime +Z. Keep its frame opening and all occlusion masks aligned. The art bible and `src/content/` specify dimensions, socket offsets and clearances.

Surface and hover mounts share the head pivot. Keep `yawRing`, `pitchCradle` and `muzzleSocket` at their documented positions. Preserve all meeting profiles when deriving a lower LOD. There is no terrain grid. Tileable materials must be periodic on each shared UV0 boundary. Record the physical tile scale with each set.

## Textures and budgets

| Role | Color space | Data |
| --- | --- | --- |
| Base color | sRGB | Unlit material color |
| Emissive | sRGB | Glow mask or color |
| Normal | Linear | Normalized tangent-space RGB. Flat is `(0.5, 0.5, 1.0)`. |
| ORM | Linear | Ambient occlusion in R, roughness in G and metalness in B |

Bind names by exact role. KTX2 material maps use top-left orientation (`rd`) for the [glTF Basis Universal extension](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_texture_basisu#additional-requirements). P3 produces staged candidates with portable maps. P4 owns runtime registration. Set UV density from the approved dimensions and document measured density per material. There is no separate per-asset byte or LOD2 ceiling in the current plan.

| Asset | Maximum LOD0 triangles | Additional limits |
| --- | ---: | --- |
| Core Bastion | 14,000 | 2048 px maps |
| Rift frame | 4,500 | 1024 px maps |
| Turret | 6,500 | LOD1 2,500 tris, two materials, 1024 px maps, LOD1 beyond 4 m |
| Skitter / Wasp / Brute / Disruptor | 4,500 / 6,500 / 9,000 / 6,500 | 24 / 24 / 28 / 24 bones, two materials, 1024 px maps |
| Apex Broodlord | 28,000 | 48 bones, three materials, 2048 px maps |

The Phase 3 plan supersedes the standard enemy budget with its exact per-archetype ceilings. The runtime cap is 200 total stereo draw calls. Use the PRD and phase plans for other scene-wide and Quest budgets.

## Files and commands

| Item | Location or command |
| --- | --- |
| Approved references | `docs/art-bible.md`, `assets-source/concepts/` |
| Generators and material library | `blender/` and `blender/materials.py`, tracked |
| Sources, portable maps, review renders and provenance | Tracked under `assets-source/` by asset family. Use `.local/` for intermediate and rejected working builds. |
| Headless generation | `"$BLENDER" -b --factory-startup --python-exit-code 1 --python <generator>`, with `BLENDER` pointing to the pinned 5.2.2 binary |
| Render and bake | EEVEE for review, Cycles for baking. Record the device and render settings. |
| Compress and validate | KTX-Software 4.4.2 via `scripts/assets/encode_ktx2.py`, GLB and texture checks via `make model-check` in P3-T3 |
| Candidate and runtime registries | `docs/art-review-index.md` in Phase 3, `public/assets/manifest.json` in Phase 4 |

Record asset-specific build, rebake, determinism and re-import commands beside each generator. Use Bun 1.4.4 for the project gate. Record failures and corrections with the asset evidence.

## Verification and release

Plug new piece kinds into the GLB validator before using their output. Verify degree of coplanar overlap (zero positive area), planar corner normals, UV0, exact texture roles, sRGB/linear handling, tangent-normal neutrality on flat samples, ORM channels, hierarchy, sockets, and the budgets above. Exercise the exact export again after source, UV, normal, or material changes. Renew changed hashes before review. Phase 3 automated gates are complemented by an independent score of at least 80/100 and owner sign-off.

P4 will load GLB/KTX2 with Three.js `GLTFLoader` and `KTX2Loader`. The blockout renderer supplies the current fallback and remains the source of alignment, articulations and spawns until promotion. Preserve the gameplay definitions in `src/content/` and rerun placement, portal-mask and campaign checks after runtime swaps.

Each review entry records the approved reference, exported and source hashes, fixed camera views, measured budgets, reimport and channel checks, and relevant motion evidence. Compare high and low versions from the same view. Record authorship and rights for each asset and retain Paul's approval against the reviewed hashes.
