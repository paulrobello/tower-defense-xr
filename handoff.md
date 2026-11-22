# Rift Bastion developer handoff

## State

- November 22, 2026, Pacific time. Local `main` merges `origin/main` (`1939c78`) together with the unpublished Phase 3 asset and review commits awaiting Owner Checkpoint 2.
- The verified public build on `origin/main` commit `1939c78` is `8fdcd8aad564`. [Live Quest build](https://rift-bastion.pardev.net/?v=8fdcd8aad564) · [CI and deployment](https://github.com/paulrobello/tower-defense-xr/actions/runs/45078687291)
- Local `main` contains unpublished Phase 3 asset and review work. Base public playtest fixes on `origin/main` in a sibling worktree so the release contains only intended changes. The separate `codex/rift-radial-theme` worktree holds candidate `304e811` and its local review evidence. Paul granted standing approval to push and deploy verified Rift Bastion changes. Asset promotion still has its own approval checkpoint.

### Completed in latest review & deploy pass (`origin/main` `1939c78` / build `8fdcd8aad564`)

- **Rendering & occlusion audit and fixes** (224/224 unit tests, `make checkall-ci` + gitleaks, Metal GPU IWER P0/P1/P2 walks, 12/12 desktop campaign checks, and live Metal Chromium verification on `https://rift-bastion.pardev.net/?v=8fdcd8aad564` with zero console/CSP errors):
  - Moved scene lighting (`HemisphereLight`, shadow-casting `DirectionalLight`, rim light, Core glow) out of `test-room` to scene root and added procedural `RoomEnvironment` PMREM reflections + `PCFSoftShadowMap` shadows + `stencil: true` on `WebGLRenderer` (`src/desktop/bootstrap.ts`), fixing pitch-black PBR meshes in XR passthrough and enabling real floor/table shadows.
  - Aligned desktop test room (`4.8 × 4.2 × 2.8 m`, central table, side console table) with `VIRTUAL_ROOM_DIMENSIONS` so portals and turrets sit flush on desktop walls/tables instead of floating.
  - Fixed room-mesh occlusion (`src/mr/occlusion.ts`): switched `roomOccluderMaterial` to `FrontSide` with positive `polygonOffset` (`2, 2`), oriented reversed planar mesh scans outward, switched portal cutouts/masks/GLSL bypass from oversized circles (`1.35 × 1.35 m`) to exact ellipses (`0.95 × 1.35 m`), made aperture stencil masks `DoubleSide`, and synced portal cutouts live during calibration (`src/main.ts`).
  - Re-enabled CPU-optimized WebXR `depth-sensing` (`usagePreference: ['cpu-optimized']`, avoiding Three.js's uncontrolled GPU depth pass), wired `occlusion.updateFromXrFrame(...)`, and added a zero-triangle per-eye `onBeforeRender` hook (`mr-occlusion-eye-bind-hook`) so stereo left/right eyes bind their own depth texture and `normDepthBufferFromNormView` matrix.
  - Fixed blockout & UI rendering bugs (`src/render/blockouts.ts`, `src/xr/placement.ts`, `src/xr/calibration.ts`, `src/main.ts`): roll-free `buildPortalWorldMatrix` portal orientation, hiding closed portal `vortexRingMesh`, transparent pass + render-order + camera-billboarded enemy HP bars, white `blastRingMat` for accurate instance colors, working `enemy-hit` flashes and Disruptor EMP ring rotation, per-entity GPU material/geometry/binding disposal on despawn, distinct XR overlay `renderOrder` tiers (`1000..1050`), `initialActive: false` for turret placement ghost on launch, reduced range-sphere tint, and stick-neutral gating after radial build selection.

## Unfinished work

### Retest the Quest fixes on one build

Use `8fdcd8aad564` for all three open playtest items. Test with **Auto Depth** and **Room Mesh** enabled, and use **Off** as the comparison if geometry disappears. Record the build, occlusion mode, tracked surface, controller hand, and whether the issue appears before or after **Lock Core**. The earlier controller and rendering checks ran in IWER.

| Item | Physical check still needed |
| --- | --- |
| `01a1ffabf1cd74fb930edf36f01a6b49` | Grip-drag the tactical HUD, Settings, and FPS widget. Confirm each stays at its released position and button state stays steady while gripping. Reposition the Core onto the same floor used by a turret. Verify the Core and rifts stay visible with **Room Mesh** enabled. |
| `01a20205fd2a773f9004cc5cfffc9e5d` | Place and relocate floor and wall turrets. Verify their models extend into the room, hover pods cannot be committed through a surface, and portal edges stay stable from an oblique angle. |
| `01a204103a7976208bd4b5dbe9ee4fa7` | Sweep the controller lasers across the room while idle and while placing. Verify placing turrets leaves the mission in prep beyond the former 20-second timeout. Press **Launch Wave** separately and check that shots leave the visible barrel in the direction it points. |

### Unblock and finish Phase 4

- **P3-T6 / P3-T7** still show Owner Checkpoint 2 as open. Reconcile the owner’s approval against the exact reviewed batch SHA-256 `fef4524a7d46821336beecb348e36ecfed3aee20fbac82c27ff7b29a6e7eac09` and record it before promoting the models, materials and icons. The [art review index](docs/art-review-index.md#owner-checkpoint-2) lists what the digest covers and the selected manifests.
- **P4-T1** promotes the approved GLB/KTX2 assets, icon atlas and key art into `public/assets/` with a hash-checked runtime manifest. Add the loader and precompile veil. Check sockets, animation clips, mount orientation, tier and LOD swaps, and shader links after loading. The current public build still uses blockouts.
- **P4-T6** integrates the private radial theme after the icon promotion. Rebase or transplant `304e811` onto the current runtime and repeat the desktop and IWER controller tests. The current runtime routes each XR press to one action, which the theme integration must preserve.
- **P4-T2 / P4-T3** add procedural lighting, shadows, the Rift shader and pooled combat effects after asset promotion. Check portal seams at oblique angles, keep total stereo draw calls at or below 200, and test the VFX budget of 2,500 active effects and 12 additional draw calls at the planned stress load.
- **P4-T5** needs the eight owner-supplied Suno WAVs. Archive their original bytes, master six loops and two stingers, then integrate music and the 28 approved ElevenLabs SFX with spatial playback and bounded voices. The [SFX review](assets-source/audio/sfx/README.md) points to the private source archive and audition build. Keep private takes and review bundles outside the public release.

### Complete Phase 5 on the promoted runtime

- **P5-T1** builds and runs the deterministic Wave 12 stress scene with 14 T3 turrets, four portals and 25 active enemies, including the Phase 2 boss. Cover the full campaign, seated and standing IWER, stereo budgets, and live build reload on a GPU-backed host.
- **P5-T2 / P5-T3** capture the physical Quest baseline, optimize identified bottlenecks, and rerun the identical workload. Collect in-app one-second buckets, VrApi counters, GPU profiling and CDP CPU traces. The gate is **72 Hz with at least 50 delivered FPS in every complete active one-second bin**.
- **P5-T4** records seated 180° and standing 360° wearer acceptance. Include room-scan fallback, settings and score persistence, the in-headset update flow, and a smoke test against the exact live release.

## References

- [Project guide](CLAUDE.md), [PRD](PRD.md), [Phase 3 asset plan](plans/phase-3-art-direction-and-blender-assets.md), [Phase 4 runtime plan](plans/phase-4-aaa-rendering-fx-and-audio.md), [Phase 5 verification plan](plans/phase-5-quest3-tuning-and-release.md), and [Suno music prompts](suno-music-prompt.md).
- [App composition](src/main.ts) wires the XR session, game phase and action bus. See `mountApp` and `initializeMissionFromCalibration`. The session exposes runtime state as `window.__riftBastionApp`.
- [XR trigger and UI ownership](src/xr/radial-controls.ts) in `attachSession`, [placement](src/xr/placement.ts) in `confirmXrPlacement`, and [Core calibration](src/xr/calibration.ts) in `raycastCorePlacement`. [Room scan](src/mr/room-scan.ts) and [occlusion](src/mr/occlusion.ts) keep tracked mesh poses and fitted placement planes separate.
- [Combat simulation](src/sim/engine.ts) computes mount-relative aim and muzzle origin in `aimTurret`; [blockout rendering](src/render/blockouts.ts) consumes those angles and draws the effects. Preserve the pure TypeScript simulation boundary when replacing models. Avoid rebuilding the navigation graph per room scan, which previously caused second-long calibration stalls.
- [Verification commands](Makefile), [IWER walks](scripts/xr-emu/), [desktop campaign](scripts/check-desktop-campaign.ts), [Quest telemetry](scripts/perf-quest.ts), and [deployment checklist](docs/deploy-checklist.md). Use the sibling `mux-xr` checkout at the [pinned toolkit revision](toolkit-release.json). Latest local reports are in `.local/quest-aim-and-trigger-evidence/`.

## Unresolved issues

- The rendering and occlusion fixes are deployed on `origin/main` (`1939c78`, build `8fdcd8aad564`) and verified in unit tests, Metal IWER, and live Metal Chromium, but physical Quest 3 hardware retesting is still required for the three open board items and to compare **Auto Depth** vs **Room Mesh** vs **Off** on real passthrough. Earlier hardware measurements are playtest evidence and leave the full Phase 5 frame floor open.
- Phase 3 runtime promotion is waiting on the recorded batch approval. Phase 4 music is waiting on the owner WAVs.

## Next steps

1. Retest the live build on Quest using the table above. Reopen or close the individual board items based on the observed outcomes and save matching frame traces.
2. Resolve the Phase 3 approval record and verify the selected hashes, then promote the assets and integrate the radial theme against current input handling. Continue lighting, effects, and audio in the Phase 4 dependency order.
3. Run the Phase 5 automated stress suite and physical baseline once the promoted runtime is ready. Run `make checkall-ci` before publishing, watch the Pages job, and verify `version.json` matches the tested candidate.
