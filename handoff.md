# Handoff — Rift Bastion (`tower-defense-xr`)

> **Read before starting work:** `PRD.md`, `CLAUDE.md`, `plans/phase-3-art-direction-and-blender-assets.md`, and `plans/phase-4-aaa-rendering-fx-and-audio.md`.

---

## State

- **Updated:** November 21, 2026 (Pacific time)
- **Repo:** `/Users/probello/Repos/tower-defense-xr`, branch `main`. The existing local formatting edit in the Phase 4 plan is separate from this handoff.
- **Public build:** [GitHub](https://github.com/paulrobello/tower-defense-xr) and [live test build](https://rift-bastion.pardev.net/). The Quest widget and room geometry update was deployed at commit `2e75df0`, build `c3fc3a3dc21b`, on November 21, 2026. GitHub Actions passed Linux parity and Pages deploy. The live manifest matched the verified content hash. The local backup branch `codex/rift-pre-publication-history` retains the original history. [Deployment run](https://github.com/paulrobello/tower-defense-xr/actions/runs/44944025679)
- **Completed work:**
  - **Phase 0 complete:** `P0-T1`–`P0-T6` closed. The local gates, 14/14 IWER smoke and build A→B Reload checks passed. [GitHub Actions](https://github.com/paulrobello/tower-defense-xr/actions/runs/44874742012) passed the pinned Linux gate and Pages deployment. The live manifest matched the verified build and Quest Browser rendered desktop calibration on its Adreno GPU. Immersive play and physical performance remain Phase 5 work.
  - **Phase 1 (100% complete):** `P1-T1`–`P1-T6` closed. `bun scripts/xr-emu/walk-p1.mjs` passes **19/19** checks (seated `1.2 m` `front-180` + standing `1.65 m` `full-360` calibration, floor/table/wall surface-clamp + thumbstick hover-pod `0.8–5.0 m`, `TOO_CLOSE` & `CAP 14/14` SDF labels, `auto-depth → room-mesh → off` cutouts).
  - **Phase 2 (100% complete):** `P2-T1`–`P2-T6` closed. **218/218 Vitest tests** pass; `bun scripts/check-desktop-campaign.ts` passes **12/12** checks (full 12-wave + Wave 12 Apex Broodlord Boss Phase 2 → Victory `3/3` stars → IndexedDB reload + JSON backup); `bun scripts/xr-emu/walk-p2.mjs` passes **8/8** checks (`150 ≤ 200` draws, `12,080` tris, zero console errors).
- **Note on workspace directory:** `/Users/probello/tower-defense-xr` is an empty folder where the session opened; the actual git repository lives at `/Users/probello/Repos/tower-defense-xr` (so `file:../mux-xr/packages/xr-workspace` resolves cleanly). Always run commands and create sibling worktrees under `/Users/probello/Repos/`.

---

## Owner Preferences & Directives (Carry Forward)

1. **Model routing:** Paul moved this work to Codex on November 20, 2026. Use **GPT-6.2 Astra** for visual work and Blender modeling, and **GPT-6.2 Sol** for most other work, including audio wiring, scripts, tests, and performance tooling. Higgsfield and ElevenLabs remain the asset generators.
2. **Time & quota reporting:** Use Pacific time and include live provider balances at wave updates when available.
3. **Spend & asset boundaries:** Paid Higgsfield and ElevenLabs generation inside the vertical-slice table in `PRD.md` is pre-approved with 3× retry headroom. **Meshy is strictly forbidden** (all 3D goes through Blender 5.2.2 LTS). Never self-record owner creative sign-off.
4. **Radial menu re-skin:** Tracked explicitly in `PRD.md`, `plans/phase-4-aaa-rendering-fx-and-audio.md`, and kanban card `P4-T6` (`01a1fb37b41e73dfa3f531303c243df5`).
5. **Git / kanban hygiene:** Create sibling git worktrees under `/Users/probello/Repos/tower-defense-xr-wt-<slug>` (bootstrapped with `bun install --frozen-lockfile`), rebase and squash-merge verified work, delete merged worktrees immediately, and never add `Co-Authored-By:` trailers. Paul granted standing approval on November 21, 2026 to merge and deploy Rift Bastion when needed. Kanban CLI invocation is `bun /Users/probello/Repos/kanban/cli/kanban.ts ...`. Use a session-unique `--claimed-by` token.

---

## Remaining Work (Kanban Project: `tower-defense-xr`)

### Quest calibration recovery and follow-up

- The first hotfix restored some menu elements. The 11:25 AM PST retest showed a clipped HUD and an invisible Core, and the matching headset trace averaged 1.9 FPS over 34 complete calibration seconds. The production navigation rebuild took 1.16–1.40 seconds on the 68 tracked room surfaces.
- Build `e6c5dd826115` defers navigation to **Lock Core** and displays the live Core and portal suggestions independently. On the same Quest and room data, the revised path checks took 116–193 ms with identical navigation grids and routes. The new single-pass renderer gives HUD text precedence over button and panel backgrounds. The default **Auto (Off)** keeps scanned geometry for placement while bypassing room-depth masking. **Room Mesh** remains selectable in Settings.
- The pinned Linux `make checkall-ci` passed all 218 tests. Metal-backed IWER passed 14/14 smoke, 19/19 calibration and placement, and 8/8 combat checks. The controller walk confirmed the rendered Core followed its proposed position while the navigation graph stayed steady, and confirmed that locking rebuilt the graph at the selected position. Both eyes show readable HUD and Settings in the emulator captures.
- The physical retest of build `e6c5dd826115` showed the full HUD and Core in **Auto (Off)**. The controller opened Settings and placed floor turrets. The 141-second trace averaged 69.6 FPS during 72 Hz calibration with a 64 FPS minimum. The single 90 Hz startup second recorded 42 FPS. The initial recovery card `01a1ff7656077486ab8170491b772b37` is complete. The same captures showed an elevated Core and rifts disappearing with **Room Mesh** enabled.
- Build `c3fc3a3dc21b` adds controller grip dragging to the HUD, Settings, and FPS display. Holding both thumbsticks for a second recenters them. The Core starts on a suitable tracked floor and uses the turret surface picker for manual placement. Room Mesh uses each classified scan mesh's original pose. Unclassified scan geometry stays outside the depth pass.
- Linux parity passed 219 tests and Metal IWER passed 14/14 smoke, 20/20 calibration and placement, and 8/8 combat checks. Regression fixtures verify the Core's contact height for a flipped, tilted floor, separate mesh and fitted surface transforms for portal openings, and trigger suppression while moving all three widgets. Follow-up card `01a1ffabf1cd74fb930edf36f01a6b49` awaits a physical check of grip moves, floor placement, and **Room Mesh** visibility. Phase 5 still owns instrumented pacing and both-posture acceptance.

### Next Up — Phase 3: Art Direction & Blender AAA Assets (2 open cards, `plans/phase-3-art-direction-and-blender-assets.md`)
- **Wave 1 complete.**
  - `P3-T1` (`01a1fadb0b8b7467b36c14f730c1d52d`): Paul approved **Bastion Rib**, the [art bible](docs/art-bible.md), and all eleven concept sheets in chat on November 20, 2026. This clears Owner Checkpoint 1. All 20 original images decoded and matched their [recorded hashes](assets-source/concepts/provenance.json). The turret tier and muzzle, invader, mount, Core and Rift dimensions matched the blockouts.
- **Wave 2 complete.**
  - `P3-T2` complete (`01a1fadb0d97705ab0b67aaed9726f4d`). [Art review index](docs/art-review-index.md) includes 18 tactical RGBA icons covering all nine radial actions, a validated 768 × 384 atlas, and separately composed desktop and Quest key art. All 22 candidates reproduced byte for byte. The provider ledger confirmed 15 credits. Production promotion still awaits the P3-T7 batch approval.
  - `P3-T3` complete (`01a1fadb108874ef8dd9dda60e64c92f`). The [material library](assets-source/materials/README.md) contains five finishes, an editable Blender 5.2.2 library and 16 portable maps in PNG and KTX2. A second bake matched all 32 map hashes. The [model validator](scripts/assets/model-check.md) checks texture roles, colors, decoded pixels, geometry, overlaps, skin structure, sockets, LODs and budgets. `make model-check` verified the staged textures and seven positive and negative tests. Blender export and re-import verified texture bindings. Measured gameplay performance and final owner approval remain downstream.
- **Wave 3 (serial Blender workers per `blender-mcp.md` after `P3-T3`, using GPT-6.2 Astra):**
  - `P3-T4` complete (`01a1fadb12f5733a8eccefeb99e1f8b2`). The revised [Core Bastion](assets-source/models/core-bastion/README.md) is 6,858 tris with four 2048 px maps and an eight-second emitter sweep. The [Rift frame](assets-source/models/rift-portal/README.md) is 4,056 tris with five 1024 px maps, a flush anchor and the exact 0.95 × 1.35 m shared aperture. Both packages passed model-check, Blender re-import, byte-identical rebuilds and matched EEVEE views. The [art review index](docs/art-review-index.md) carries the evidence for P3-T7.
  - `P3-T5a` complete (`01a1fb3c841c708784a64a42cd4d0dcf`). The [Surface Clamp Base](assets-source/models/surface-clamp/README.md) uses 2,428/1,148 triangles and preserves four-foot contact on floor, table and wall fixtures. The revised [Repulsor Hover-Ring Pod](assets-source/models/hover-pod-revision/README.md) uses 2,428/1,132 triangles with a 0.145 m emitter radius. Both use the same origin socket, one material per LOD and four 1024 px maps per asset. Each pair of exports rebuilt byte for byte on the pinned Linux backend. The clamp leaves 4,072 and 1,352 triangles for the turret head at the respective 6,500/2,500 assembly limits.
  - `P3-T5b` complete (`01a1fb3c87547701ac5685baf143b252`). All three [M44](docs/art-review-index.md#m44-autocannon) and [Helios](docs/art-review-index.md#helios-plasma-mortar) tiers are staged, with editable high/low sources, two GLB LODs per tier and matching view sets. Re-import verified both mounts and the tier transforms. Their largest assemblies measure M44 6,036/2,452 and Helios 6,452/2,500 triangles. The visual approval gate is P3-T7.
  - `P3-T5c` complete (`01a1fb3c897177268bcaedf2577ed3d4`). All three [Glacier](docs/art-review-index.md#glacier-cryo-arc) and [Valkyrie](docs/art-review-index.md#valkyrie-rail-sniper) tiers are staged with editable high and low sources, repeat-matched GLBs and maps, and views on both mounts. Re-import verified the neutral muzzle and articulated yaw, pitch and recoil. Their largest assemblies measure Glacier 5,140/2,468 and Valkyrie 4,068/2,484 triangles. Valkyrie T3 retains a 46.64 mm minimum open rail gap.
  - `P3-T5` complete (`01a1fadb16977224a3f5072a8ba38175`). All 48 combinations of four heads, three tiers, two LODs and two mounts pass the assembly budget. The largest uses 6,452/2,500 triangles and two materials. The full model gate checks 30 GLBs and 81 KTX2 textures, including the shared material library. Final turret approval remains at `P3-T7`.
  - `P3-T6a` complete (`01a1fb3c8b1071cf8430eb90a84fa8ba`). Revised [Skitter Crawler](docs/art-review-index.md#skitter-crawler) is staged at 3,904/1,994 tris and 23 bones. Revised [Wasp Skimmer](docs/art-review-index.md#wasp-skimmer) is staged at 6,208/2,204 tris and nine bones. Both use one material. Both LODs passed re-import for all five named clips and the contact, articulation and root-motion checks. The art index links their matched views, motion poses, turntables, and source and export hashes.
  - `P3-T6b` complete (`01a1fb3c8def7766a0bd37d25c39874d`). Revised [Carapace Brute](docs/art-review-index.md#carapace-brute) is staged at 8,904/4,448 tris and 24 bones. [Rift Disruptor](docs/art-review-index.md#rift-disruptor) is staged at 4,152/2,424 tris and three bones. Both use one material. Both LODs passed re-import for all required clips. Brute's wider contact pads hold through the brace and the head clears the shield. Disruptor retains at least 6 mm of hull-to-ring clearance at all 320 sampled poses per LOD. Matched Metal renders, motion and provenance are linked in the review index.
  - `P3-T6c` complete (`01a1fb3c91067130bdb8af122f51b91a`). [Apex Broodlord](docs/art-review-index.md#apex-broodlord) is staged at 23,480/7,840 tris with 28 bones, one material, four 2048 px maps and a standalone Phase 2 crack mask. Both imported LODs play the six clips with matched two-phase views and motion evidence.
  - `P3-T6` (`01a1fadb18be76c79209166e054aeb93`): Technical and evidence criteria passed for all five invaders. Both LODs of each play their required clips after re-import, and exact repeated exports and matched proof are indexed for `P3-T7`. The rollup closes when Paul approves the combined package at Owner Checkpoint 2.
- **Wave 4 (Owner Checkpoint #2 before P4 promotion):**
  - `P3-T7` (`01a1fb3c93b976f4850cfb761acebef9`): **Awaiting Paul at [Owner Checkpoint 2](docs/art-review-index.md#owner-checkpoint-2).** All 46 assets scored 80–97/100 after the eleven [revisions](docs/art-review-index.md#passed-revisions). The pinned Linux gate passed 40 GLBs, 102 KTX2 textures and 218 tests. Approve batch `fef4524a7d46821336beecb348e36ecfed3aee20fbac82c27ff7b29a6e7eac09` before Phase 4 promotion.

### Phase 4 sound effects approved

- **`P4-T4` complete** (`01a1fadb229176818b2c3bc81999c4a6`). Paul approved all 28 cues in chat on November 20, 2026. The [audio review record](assets-source/audio/sfx/README.md) binds the approval to the catalog hash. The original 29 takes, 28 lossless masters and 56 Opus/MP3 derivatives passed hash, codec, loudness, true-peak, silence, mono and loop checks. The four negative controls rejected clipping, silence, phase cancellation and a hash mismatch. ElevenLabs reconciled 538 included credits and zero overage.
- Desktop Chrome verified both formats, original playback, stop/reset and rift repeat. Quest 3 Browser loaded all cues over USB and reported support for both formats. Independent Quest playback was not observed because its tab was hidden. The isolated audio stays under the private, gitignored `assets-source/audio/sfx/` archive. Suno mastering and in-game mixing belong to `P4-T5`.

### Remaining Phase 4 & Phase 5 cards
- **Phase 4 (`plans/phase-4-aaa-rendering-fx-and-audio.md`):**
  - `P4-T1` (`01a1fadb1b4d7398ada36dbe2c6c5c32`): Promote KTX2 GLBs (`public/assets/manifest.json`), `createImageBitmap` off-thread streaming, `compileAsync` load veil.
  - `P4-T2` (`01a1fadb1e057789a2cd2aeff05ad76b`): Procedural PMREM IBL, dynamic hero lighting, shadow tuning, and Rift Portal depth-parallax shader. *(GPT-6.2 Astra)*
    - Align the room openings and depth bypass with the authored 0.95 × 1.35 m ellipse on the same anchor. The blockout currently passes a 0.675 m radius to the circular stencil in `src/mr/occlusion.ts`. Verify wall and ceiling views at oblique angles after the runtime swap.
  - `P4-T3` (`01a1fadb1fbb775e8869325f0aa84716`): GPU-instanced combat VFX & zero-GC particle pools (`≤2,500` active, `≤12` extra draws). *(GPT-6.2 Astra)*
  - `P4-T6` (`01a1fb37b41e73dfa3f531303c243df5`): Private theme candidate committed at `304e811` on `codex/rift-radial-theme`. The IWER review passed 28 checks on Apple M4 Max Metal with staged atlas fixtures, zero console or request errors, and front and oblique XR captures. The desktop follow-up verified native Space activation and clear key-label spacing down to 320 px. Final `make checkall-ci` passed 222 tests. Keep the active sibling worktree for its ignored `output/xr-emu/radial-theme/` evidence. Transplant the candidate commit onto the published history when P3-T7 and P4-T1 unblock promotion.
  - `P4-T5` (`01a1fadb25b776d480b53b7d6268f972`): Master Paul's owner-generated Suno WAVs (from `suno-music-prompt.md`) into Opus (`+bitexact`) + MP3 (`Lavc` intact) and wire spatial Web Audio `PannerNode` engine.
- **Phase 5 (`plans/phase-5-quest3-tuning-and-release.md`):**
  - `P5-T1` (`01a1fadb27d0716e842dcc65551536b4`): `?stress` Wave 12 worst-case suite (14× T3 turrets, 4 portals, 25 enemies + Boss Phase 2) on desktop + IWER XR.
  - `P5-T2` (`01a1fadb2a89740abe5863e62605bf2d`): Physical Quest 3 baseline (`VrApi`, `ovrgpuprofiler`, CDP JS, A/B occlusion & framebuffer scale).
  - `P5-T3` (`01a1fadb2da870738b89b1dececddd28`): Quest 3 optimization pass clearing **72 Hz target / ≥50 delivered FPS in every complete 1-second active bin**.
  - `P5-T4` (`01a1fadb306b7557b611b3d2d4e2e2c8`): Physical Quest 3 seated (`180°`) + standing (`360°`) acceptance & live release smoke on `https://rift-bastion.pardev.net/`.

---

## References

### Project Files
- Planning & specs: `PRD.md`, `CLAUDE.md`, `README.md`, `plans/phase-*.md`, `suno-music-prompt.md`, `docs/deploy-checklist.md`
- Entry & live loop: `src/main.ts` (`mountApp`, `window.__riftBastionApp`), `src/desktop/bootstrap.ts`, `src/desktop/controls.ts`
- Core & content: `src/core/{prng,state,action-bus}.ts`, `src/content/{turrets,enemies,waves,index}.ts`
- Pure-TS sim & nav (zero Three.js): `src/sim/{placement-rules,spatial-hash,engine}.ts`, `src/nav/graph.ts`
- Mixed reality & occlusion: `src/mr/{room-scan,virtual-room,occlusion,shadow-catchers}.ts`
- XR controls & UI: `src/xr/{session,calibration,placement,radial-controls}.ts`, `src/ui/{fonts,tactical-hud,threat-chevrons,mission-overlay,version-check,version-notice}.ts`
- Blockouts (dimension source of truth for P3 Blender models): `src/render/blockouts.ts` (`createBlockoutRenderer`, turret/invader exact footprints & `yawRing`/`pitchCradle`/`muzzleSocket` hierarchy)
- Settings, perf, persistence: `src/settings/{store,panel}.ts`, `src/perf/{recorder,hud}.ts`, `src/persist/store.ts`
- Verification scripts: `e2e/gpu-args.ts`, `scripts/xr-emu/{walk.mjs,walk-p1.mjs,walk-p2.mjs}`, `scripts/check-desktop-campaign.ts`, `scripts/check-build-upgrade.ts`, `scripts/perf-quest.ts`

### Local Tools & Prior-Art Scripts Verified Ready
- **Blender 5.2.2 LTS:** `/Applications/Blender.app/Contents/MacOS/Blender` (community MCP client: `python3 ~/.claude/guides/blender-bl.py`, TCP `9876`)
- **KTX2 Encoder v4.4.2:** `~/.local/opt/ktx-software-4.4.2/bin/ktx`
- **Higgsfield CLI:** `/Users/probello/.nvm/versions/node/v24.18.0/bin/higgsfield`
- **FFmpeg:** `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg`
- **ElevenLabs API Key:** Present in `~/.env` / `~/.claude/.env`; generator script at `~/.claude/skills/elevenlabs/scripts/generate.py`
- **Reference asset scripts (`~/Repos/rogue-xr/scripts/assets/`):** `gen_style.ts` (Higgsfield provenance runner), `encode_materials_ktx2.py` (UASTC KTX2 encoding), `asset-check.py` (standalone stdlib GLB/KTX2/provenance validator), `generate_sfx.py`, `build_audio.py`
- **Shared XR toolkit:** `~/Repos/mux-xr/packages/xr-workspace` (`@par/xr-workspace` `0.2.0`, pinned at SHA `9e2bd1817e2ec5e1b7ef2b318963b07c21305281` in `toolkit-release.json`)
- **Reserved ports (`~/.claude/used_ports.md`):** `4272` (dev + Quest USB `adb reverse`), `4273` (preview / isolated Playwright)

---

## Unresolved Issues & Open Gates

1. **Provider balances (November 20, 2026):** The concept and UI batches used 40 and 15 included Higgsfield credits. ElevenLabs Starter had 59,998 included credits remaining after the SFX batch, with overage disabled.
2. **Blender live MCP add-on (`TCP 9876`):** Was not listening during the 2:34 PM PST probe; start Blender with the community "MCP for Blender" add-on (or run headless `--background --factory-startup --python-exit-code 1`) before `P3-T3`–`P3-T6c`.
3. **Physical Quest 3 acceptance:** All IWER passes (`P0`, `P1`, `P2`) are emulator evidence only. Real room scans, live WebXR `depth-sensing` GPU cost vs `room-mesh` fallback, comfort, and sustained `≥50 delivered FPS` stay open for Phase 5 (`P5-T2`–`P5-T4`).
4. **Suno music WAVs (`P4-T5`):** `suno-music-prompt.md` is ready for Paul to generate the 6 loops + 2 stingers on Suno Custom v6; archive his downloaded WAVs untouched under `assets-source/audio/music/raw/` when delivered.

---

## Next Steps (Recommended Resume Order)

1. **Collect the Quest retest** on build `c3fc3a3dc21b`. Grip-move the HUD, Settings, and FPS display, re-place the Core on the floor, then enable Room Mesh and verify the Core and rifts remain visible.
2. **Obtain approval at Owner Checkpoint 2.** Paul’s approval of the exact batch recorded in the art review closes the remaining creative criteria on `P3-T6` and `P3-T7`. `P4-T1` then promotes the approved package. The private radial theme candidate remains ready for its later transplant.
