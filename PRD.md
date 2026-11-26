# Rift Bastion — Product Requirements

| Field | Value |
| --- | --- |
| Product | **Rift Bastion** (working title) — room-scale WebXR mixed-reality tower defense for Meta Quest 3 |
| Repo | `~/Repos/tower-defense-xr` (deploys to `https://rift-bastion.pardev.net/`) |
| Owner | Paul Robello |
| Status | Planned — vertical-slice PRD, phase plans (P0–P5), Suno prompt pack, and kanban backlog ready for P0 execution |
| Date | 2026-11-20 |

---

## Overview

**Rift Bastion** is a single-player, tactical sci-fi mixed-reality tower defense game built for **Meta Quest 3 in Quest Browser** (`immersive-ar`). Dimensional rift portals tear open across the player's actual walls and ceiling (or virtual rift anchors when a room scan is unavailable), disgorging bio-mechanical and insectoid invaders that descend onto floors, navigate around real furniture, and swarm through open air toward the player's **Core Bastion**.

Players command a four-role hard-surface military turret kit using Touch controllers alone (hand tracking is out of scope). Every interaction works identically **seated or standing**: point a controller laser anywhere in the room to auto-snap turrets flush onto scanned floors, tables, or walls, or push/pull the thumbstick to detach a turret into mid-air repulsor hover-pod mode; open the thumbstick radial menu to pick turrets and upgrades; and reposition or sell units live during combat or between waves.

The first deliverable is an **AAA-grade vertical slice**: one complete 12-wave + Apex Broodlord Boss mission (10–15 minutes), 4 distinct turrets with 3 upgrade tiers each, and 5 rigged/animated invader archetypes. It pushes Quest 3 WebGL2 rendering to its practical limits — high-to-low Blender PBR/ORM assets, KTX2 textures, WebXR depth-sensing + room-mesh occlusion with portal aperture cutouts, real-time shadow catchers onto real furniture, GPU-instanced projectiles/FX, ElevenLabs spatial SFX, and an adaptive Suno soundtrack — while holding a measured **72 Hz target and 50 fps floor** on physical hardware.

---

## Goals

1. **G1 — Convincing Hybrid Room-Scale MR.** Dimensional rifts open on distant real walls and ceilings with recessed parallax depth that is never clipped by the host wall; real furniture and hands occlude invaders via WebXR depth-sensing (with room-mesh occluder fallback); and turrets/enemies cast crisp shadows onto real floors and tables.
2. **G2 — Seamless Seated & Standing Controller Play.** Every placement, upgrade, sell, relocate, and wave-control action is comfortably executable while seated at a desk or standing in a room, using controller lasers and the `@par/xr-workspace` thumbstick radial menu. Seated players default to a Front 180° Play Arc; standing players can switch to Full 360° Room.
3. **G3 — AAA Tactical Sci-Fi Visuals Within Measured Quest 3 Budgets.** Brushed titanium and ceramic hard-surface turrets, emissive plasma/rail/cryo coils, and rigged bio-mechanical invaders authored in Blender 5.2.2 LTS under a single Higgsfield-driven art bible. Target **72 delivered FPS** with a hard **≥50 delivered FPS floor** in every complete 1-second active gameplay bin through Wave 12 Boss.
4. **G4 — Deep, Readable 12-Wave Tactical Loop.** Four distinct turret roles (Autocannon, Plasma Mortar, Cryo-Arc, Rail Sniper) × 3 visual/functional upgrade tiers counter 5 distinct enemy archetypes (crawlers, flyers, armored brutes, turret-targeting disruptors, and the Wave 12 Broodlord boss) in a replayable 10–15 minute mission.
5. **G5 — Full Desktop Playability Parity.** Every game action routes through one shared action bus so desktop mouse + keyboard can play the complete 12-wave mission inside a stylized virtual test room for rapid development, deterministic balancing, and automated testing.
6. **G6 — Spatial Audio & Cohesive Score.** ~28 ElevenLabs spatialized SFX cues (reviewed on `audition.html`) paired with an original tactical sci-fi Suno soundtrack (`suno-music-prompt.md`) engineered to leave headroom for combat cues.
7. **G7 — Verifiable Engineering & Live Deployment.** Strict TypeScript, Biome, Vitest, Gitleaks, local GPU Playwright + IWER emulated XR walks, Quest 3 USB performance capture (`VrApi` + `ovrgpuprofiler` + CDP), production-build new-version Reload notice, and GitHub Pages deployment at `rift-bastion.pardev.net`.

---

## Non-Goals (Vertical Slice)

- **Hand tracking** — explicitly excluded; Touch controllers are the sole XR input path.
- **Artificial locomotion** — stationary seated/standing play (optional physical walking when standing); no stick-walk or teleport locomotion.
- **Multiplayer, co-op, leaderboards, or cloud accounts** — single-player with device-local IndexedDB persistence only.
- **Persisting raw room meshes or camera images** — room scan data lives only for the active session; calibration runs cleanly per session.
- **Multiple campaigns, endless mode, or branching Tier-3 turret evolutions** — post-slice expansions; v1 ships one tightly tuned 12-wave mission and linear 3-tier upgrades.
- **PCVR or separate desktop-ultra art tier** — Quest 3 standalone defines the visual and performance bar.
- **Meshy or third-party AI 3D generation** — all 3D authoring, texturing, rigging, and animation go through Blender 5.2.2 LTS (`blender-mcp.md`, `blender-game-export.md`).
- **Mid-wave checkpoint resume across XR sessions** — persistence stores settings and mission records/stars, not live wave snapshots.

---

## Reference Projects

All repos surveyed via `parsight` and direct inspection; each entry specifies exact reuse:

| Repo | What is reused |
| --- | --- |
| `~/Repos/mux-xr` → `packages/xr-workspace` (`@par/xr-workspace` `0.2.0`, pinned at SHA `9e2bd1817e2ec5e1b7ef2b318963b07c21305281` via `toolkit-release.json`) | `createXrSession` (foveation + session lifecycle), `createPointer`, `createButtonEdges`, `createAxisRepeat`, `createXrRadialMenu` / `createRadialMenu` / `createStickRadialNavigation`, `createMenuPanel`, `createPerfGaugeWidget`, `CachedTextBatch` / `createScalableLabel` / `troika-three-text` (`0.52.5`), `PlacementRays`, `keepAbove` / `OVERLAY_RENDER_ORDER`, `findControl` / `setControlId`, `stageWorkspaceAssets`. Public exports only — never `/internal/*`. |
| `~/Repos/portal-xr` (Portal Works) | `immersive-ar` room-scale plane/mesh detection + graceful virtual fallback when spatial data is unavailable or denied; cutting portal openings through every host surface representation (`webxr.md` Room-scale MR contract); `toolkit-release.json` sibling-toolkit CI pinning; `vite build --mode iwer` isolated emulator build; `audition.html` SFX review flow; `SUNO-PROMPTS.md` prompt-pack structure. |
| `~/Repos/gogh-xr` | Quest 3 throughput benchmarks (`docs/perf.md`, `docs/verification.md`) and `webxr.md` Quest 3 discipline: framebuffer scale fixed at layer creation (`viewport-scale.ts`), fixed foveation `0.5` re-asserted every frame, shader program precompilation behind a veil, spread-frame uploads, off-thread `createImageBitmap` decoding, `VrApi` + `ovrgpuprofiler` + CDP profiling, and production-build A→B new-version Reload test. |
| `~/Repos/rogue-xr` (Clockwork Spire) | Pinned toolchain versions (`three` `0.186.1`, `bun` `1.4.4`, `vite` `8.3.5`, `typescript` `7.0.2`, `biome` `2.5.15`, `vitest` `5.0.3`, `playwright` `1.63.0`, `iwer` `2.8.0`), Blender 5.2.2 LTS high-to-low PBR/ORM + rigged enemy pipeline (`create-modular-3d-assets`, `create-rigged-character-assets`, `blender-kit-pieces`), Higgsfield single style-board governance, Quest 3 max-beauty 72 Hz / 50 fps floor budgets, `scripts/xr-emu/` IWER Playwright harness, IndexedDB persistence + JSON export/import. |
| `~/Repos/audio-probe-xr` | `Makefile` split between CI-parity gate (`make checkall-ci`) and GPU-backed browser tests, plus `scripts/perf-quest.ts` one-shot USB/CDP Quest 3 performance log retrieval. |

---

## Architecture Direction

### Stack (pinned in plans; manifests created in P0)

- **Runtime:** `three` **0.186.1** (exact peer of `@par/xr-workspace`), WebGL2, raw `WebXRManager` (`immersive-ar` with `optionalFeatures: ['plane-detection', 'mesh-detection', 'depth-sensing', 'anchors', 'local-floor']`).
- **XR Toolkit:** `@par/xr-workspace` **0.2.0** (`file:../mux-xr/packages/xr-workspace`, pinned SHA `9e2bd1817e2ec5e1b7ef2b318963b07c21305281` in `toolkit-release.json`) + `troika-three-text` **0.52.5** (`configureTextBuilder({ useWorker: false })` with bundled local fonts for production CSP compliance).
- **Simulation & Physics:** Deterministic pure-TypeScript fixed-timestep simulation (`60 Hz` sim tick), spatial hash grid + swept analytic ray/sphere/capsule collision + 3D hybrid room navigation graph. **No WASM physics engine** (zero Rapier overhead, maximizing Quest 3 CPU headroom).
- **Tooling:** `bun` **1.4.4**, `vite` **8.3.5**, `typescript` **7.0.2** (strict), `@biomejs/biome` **2.5.15**, `vitest` **5.0.3**, `happy-dom` **21.0.4**, `fake-indexeddb` **6.2.8**, `@types/three` **0.186.0**, `@types/webxr` **0.5.24**, `playwright` **1.63.0**, `iwer` **2.8.0**.
- **Asset Toolchain:** Blender **5.2.2 LTS** (checked-in headless Python generators, high/low `.blend`, Cycles ORM/normal/AO bakes, rigging/animation, deterministic GLB + KTX2/UASTC), Higgsfield CLI (`cinematic_studio_2_5` / `nano_banana_pro` / `image_background_remover`), ElevenLabs (`eleven_text_to_sound_v2`), Suno Custom v6 (`suno-music-prompt.md`).
- **Ports (reserved in `~/.claude/used_ports.md`):** `4272` (Vite dev server + LAN / `adb reverse` Quest 3 preview), `4273` (Vite production preview / isolated Playwright + IWER browser verification).

### Module Layout (`src/`)

| Module | Owns |
| --- | --- |
| `core/` | Seeded PRNG (deterministic streams for waves, targeting tie-breaks, FX variance), top-level state machine (`title → calibrate → prep → wave → intermission → victory \| defeat`), shared typed action bus consumed identically by XR and desktop inputs. |
| `content/` | Declarative data definitions: 4 turrets × 3 tiers (stats, costs, targeting modes, attach profiles), 5 enemy archetypes (HP, armor, speed, surface/air capability, disruptor behavior), 12-wave mission timeline, quality tier tables. |
| `sim/` | Pure deterministic fixed-step tower-defense simulation: economy (Requisition credits), turret placement/cap/clearance validation, target acquisition (First / Strongest / Closest / Air-Priority), projectiles, AoE splash, Cryo-Arc slow + chain lightning, Rail armor-piercing beams, turret disruption/recovery, Core HP, wave spawner, scoring/stars. Zero Three.js imports; 100% unit-testable. |
| `nav/` | Hybrid 3D room navigation graph: ingests Quest planes/meshes (or virtual room geometry), classifies floor/table/wall/ceiling surfaces, computes portal anchor candidates (`>=2.0 m` from Core, filtered by Play Arc), generates wall/ceiling-to-floor descent paths + obstacle-avoiding surface waypoints for crawlers and 3D clearance corridors for flyers. |
| `mr/` | WebXR `immersive-ar` session integration, plane/mesh detection ingestion, **WebXR Depth Sensing** GPU texture pipeline + automatic fallback to depth-only room-mesh occluders, portal aperture cutouts through host surfaces, floor/table real-time shadow-catcher planes, and virtual test-room fallback. |
| `render/` | AAA Three.js presentation: GLB + KTX2 asset loader with `createImageBitmap` off-thread decode and spread-frame uploads, procedural PMREM studio/tactical IBL, dynamic hero lighting & shadow budget, instanced projectile/tracer/particle/debris/beam pools, dimensional rift portal shader (parallax interior + aperture mask), turret recoil/tracking/upgrade visuals, enemy skinned animation mixer & hit/slow/death shaders, shader precompilation veil. |
| `xr/` | Controller raycasting (`PlacementRays`, `createPointer`), auto surface-snap + thumbstick push/pull mid-air hover-pod placement (`0.8–5.0 m`), `@par/xr-workspace` thumbstick radial build/upgrade menu, pre-mission Core Anchor positioning, edge-of-view threat chevrons, both-stick recenter, seated/standing Play Arc handling. |
| `desktop/` | Stylized virtual room (walls, ceiling, table, floor) + mouse/keyboard mapping onto the exact same action bus (click-to-place, scroll wheel for mid-air depth, radial wheel/hotkeys `1–4`, `U` upgrade, `X` sell, `Space` launch wave, `Tab` settings). |
| `ui/` | Movable in-world spatial HUD & Settings panels built on `@par/xr-workspace` (`createMenuPanel`, `CachedTextBatch`, `keepAbove`), Settings page (`Show FPS`, `Fixed Foveation`, `Play Arc`, `Room Occlusion`, `Quality Tier`, audio volumes), new-version Reload notice (desktop auto-reload vs XR HUD Reload button). |
| `audio/` | Web Audio spatialized `PannerNode` SFX bus with voice caps and distance attenuation, ElevenLabs SFX bank, Suno dynamic intensity music crossfader (Briefing / Prep / Early / Mid / Late / Boss + Victory/Defeat stingers), `audition.html` entry point. |
| `persist/` | Versioned IndexedDB store (settings, mission best score/wave/stars, preferences) + validated JSON export/import. Never stores room meshes or camera data. |
| `perf/` | Continuous 1-second monotonic frame-bucket recorder (`?perf`), `createPerfGaugeWidget` HUD readout (FPS, requested/reported Hz, p95/worst ms, draw calls, tris, effective tier), local ring buffer + JSON export + `scripts/perf-quest.ts` USB/CDP collector. |

### Settled Design Decisions (D1–D12)

- **D1 — Tactical Sci-Fi Hard-Surface Aesthetic.** Brushed titanium and matte ceramic military hardware with crisp bevels, readable faction silhouettes, high-contrast emissive energy accents (amber kinetic muzzle flash, molten orange plasma, cyan cryo-arc, cobalt/white railgun), swirling violet/teal dimensional rifts, and chitinous bio-mechanical invaders. Governed by one approved Higgsfield style-reference board before 3D production. The `@par/xr-workspace` radial Build & Turret Command wheels opt into a custom Tactical Sci-Fi `RadialMenuTheme` (titanium/slate segments, cyan/amber selection highlights, and Higgsfield turret/action icon badges) in P4 while keeping the toolkit's input convention intact (`webxr.md`).
- **D2 — Hybrid Room-Scale MR (Wall/Ceiling Portals + Universal Turrets).** Dimensional rift portals anchor on distant real walls and ceilings (at least `2.0 m` from the Core Base; falling back to virtual rift gates when room scan is missing/declined/too small). Every turret type can clamp flush to scanned floors, tables, or walls (aligned to surface normal via articulated clamp legs) OR deploy a compact repulsor hover-ring in mid-air (`0.8–5.0 m`).
- **D3 — Pre-Mission Core Anchor & Safety Envelope.** Mission start opens a brief Calibration/Core Anchor phase that auto-suggests the nearest scanned table or floor `1.2–1.8 m` ahead of the player (or a virtual tactical pedestal if no scan exists). The player can move it via laser or grip; the system validates `>=2.0 m` clearance for at least 2 portal anchors before unlocking Wave 1.
- **D4 — Seated & Standing Play Arc.** Settings and pre-mission setup expose **Play Arc**: **Front 180° Seated Arc** (default when seated height `<1.35 m` or chosen explicitly — all portals spawn inside the forward hemisphere so seated players never spin 180° behind a chair) and **Full 360° Room** (for standing room-scale play). Both modes include spatialized ElevenLabs portal cues and compact edge-of-view HUD directional threat chevrons.
- **D5 — Layered MR Occlusion & Real-World Shadow Catchers.** Primary occlusion attempts WebXR `depth-sensing` (`gpu-optimized` preferred, `cpu-optimized` fallback) so real hands, furniture, and unscanned clutter dynamically occlude virtual enemies/projectiles, with an explicit **portal aperture bypass mask** so recessed wall/ceiling rifts are not clipped by the physical wall behind them. When `depth-sensing` is unavailable or disabled, the renderer falls back cleanly to depth-only occluder meshes built from Quest room meshes/planes with `portal-xr`-style openings cut through every host representation. Scanned floors and tables receive lightweight shadow-catcher planes so turrets and invaders cast grounding shadows onto the real room. Exposed in Settings as `Room Occlusion: Auto Depth / Room Mesh / Off`.
- **D6 — Auto Surface-Snap + Stick Depth Mid-Air Placement & 14-Turret Cap.** During turret placement, the controller laser auto-snaps flush to any valid scanned surface (floor, table, wall, or ceiling) with a hologram ghost preview showing range sphere and clamp orientation. Pushing/pulling the thumbstick detaches the ghost into hover-pod mode at adjustable depth (`0.8–5.0 m`), switching its preview base to the repulsor ring. Placement enforces a **hard cap of 14 active turrets** and **`0.35 m` minimum center-to-center spacing** (plus Core keep-out radius) to protect both tactical balance and the Quest 3 frame budget.
- **D7 — 4-Role Tactical Turret Kit × 3 Tiers (Live + Intermission Play).**
  1. **M44 Autocannon (Kinetic):** High fire rate, hitscan/fast-tracer sustained DPS, effective against swarms and unarmored targets; Tier 2 twin barrels, Tier 3 rotary gatling + overheated barrel glow.
  2. **Helios Plasma Mortar (AoE):** High-arcing explosive plasma shells with splash damage and brief burn DoT; counters clustered crawlers; Tier 2 dual-chamber, Tier 3 heavy siege mortar + shockwave ring.
  3. **Glacier Cryo-Arc (Slow + Chain):** Emits continuous/pulsed cryo-electric arcs that slow movement by 35–55% and chain across 2–4 nearby enemies (ground and air); Tier 2 dual coils, Tier 3 tri-pylon cryo conduit.
  4. **Valkyrie Rail Sniper (Anti-Air + Armor-Piercing):** Long-range high-velocity rail slug that pierces armor and deals bonus damage to flying units, Disruptors, and the Boss; Tier 2 extended capacitor rails, Tier 3 twin-rail accelerator.
  Players can build, upgrade (3 tiers), change target priority, relocate (for a small credit fee), or sell (50% refund) both between waves and live mid-wave.
- **D8 — 5 Rigged Invader Archetypes & 12-Wave Mission.**
  1. **Skitter Crawler** (Fast Swarm): Climbs out of wall/ceiling portals down onto floors/furniture and sprints in packs toward the Core.
  2. **Wasp Skimmer** (Aerial Striker): Flies directly from wall/ceiling portals through 3D room corridors; ignores floor obstacles.
  3. **Carapace Brute** (Armored Heavy): High HP + frontal armor plate (50% kinetic reduction; vulnerable to Rail Sniper & Plasma); stomps along floor lanes.
  4. **Rift Disruptor** (Tactical Support — aerial/hover): Pulses EMP fields that temporarily disable nearby turrets (4 s) unless prioritized and destroyed quickly.
  5. **Apex Broodlord** (Wave 12 Boss): Massive bio-mechanical matriarch emerging from a super-rift, spawns Skitter adds, periodically fires turret-suppressing pulses, and features a 2-phase armor-crack visual transition at 50% HP.
- **D9 — Deterministic Pure-TS Simulation.** All combat math, wave spawns, navigation, and targeting run on a fixed `60 Hz` step in `src/sim/` + `src/nav/` with seeded PRNG streams and zero Three.js or WASM dependencies. Visual explosions/debris are purely cosmetic GPU-instanced pools.
- **D10 — Max-Beauty Quest 3 Performance Discipline.** Follows `rogue-xr` and `gogh-xr` verified Quest 3 findings (`webxr.md`): request **72 Hz**, target **72 fps**, hard acceptance floor **≥50 delivered FPS** in every complete 1-second active gameplay bin; framebuffer scale `1.1–1.2` set at session/layer creation (never mid-session); fixed foveation `0.5` re-asserted every frame; zero runtime shader compilation (precompiled behind load veil); KTX2/UASTC textures decoded via `createImageBitmap` and uploaded across frames.
- **D11 — Full Desktop Parity & Agent-Operable Testing.** Mouse + keyboard drive the exact same `core/` action bus inside a stylized virtual room. URL flags (`?perf`, `?debug`, `?seed=`, `?version-poll=`, `?quality=`) support automated Playwright + IWER walks and deterministic verification.
- **D12 — Device-Local IndexedDB Persistence.** Versioned IndexedDB schema stores player settings (Show FPS, Fixed Foveation, Play Arc, Room Occlusion, Quality Tier, SFX/Music volume) and mission results (best score, highest wave cleared, 1–3 star rating, total runs) with validated JSON export/import. No cloud backend, no stored room geometry.

### Quest 3 AAA Performance Budgets (Vertical Slice)

Grounded in `gogh-xr` (`docs/perf.md`, `docs/verification.md`) and `rogue-xr` (`PRD.md`) physical Quest 3 measurements (Adreno tiler, three.js `0.186.1` WebGL2 without multiview so every draw submits once per eye):

| Metric / Asset Class | Budget | Notes |
| --- | --- | --- |
| Frame cadence | **72 Hz target (13.9 ms)**; **≥50 delivered FPS floor (20.0 ms)** in every complete 1-second active gameplay bin | Reprojected (`Stale`) frames do not count as delivered. Measured on physical Quest 3 via in-app 1 s buckets + `VrApi` (`adb logcat -s VrApi:I`). |
| Framebuffer scale | `1.15` default (`1.0` / `1.1` / `1.2` via Settings/URL, applied at layer creation) | Chosen at session start; `requestViewportScale` mid-session is ignored on Quest Browser. |
| Fixed foveation | `0.5` default (`Off` / `0.5` / `1.0` in Settings), re-asserted every frame | `0.5` gives ~16% GPU savings without level-1 edge blockiness (`gogh-xr` A/B). |
| Total draw calls | **≤200 per frame** (both eyes counted = ≤100 scene draws/eye) | Instanced projectiles/particles/muzzle flashes/debris + `CachedTextBatch` UI + merged static kit parts. |
| Visible triangles | **≤350k per eye** in worst Wave 12 Boss combat frame (14 active turrets + 25 active enemies + 4 active rifts) | Geometry/binning bound as well as fill on Adreno (`gogh-xr`). |
| Turret model (per tier) | **≤6,500 tris** (LOD0), **≤2,500 tris** (LOD1 >4 m), ≤2 materials (1 PBR ORM + 1 emissive/shared), 1024 px KTX2 | Articulated yaw/pitch rig + clamp/hover attachment swap. |
| Standard enemy (rigged) | **≤8,000 tris** (Swarm Crawler ≤4,500; Skimmer/Disruptor ≤6,500; Brute ≤9,000), ≤28 bones, ≤2 materials, 1024 px KTX2 | Max 25 concurrent active enemies; LOD swap + animation throttling >6 m. |
| Wave 12 Boss (Broodlord) | **≤28,000 tris**, ≤48 bones, ≤3 materials, 2048 px KTX2 | Single instance; phase-2 armor-crack emissive driven by uniform (no shader recompile). |
| Core Bastion + Rift Portal | Core **≤14,000 tris** (2048 px KTX2); Portal rim **≤4,500 tris** + procedural depth-parallax interior shader | Max 4 simultaneous active portals. |
| Dynamic lights & shadows | **≤3 dynamic lights** (1 directional key light casting one `1024×1024` PCF shadow map onto Core/turrets/enemies/shadow-catchers + 2 pooled transient point lights for explosions/boss) + procedural PMREM IBL | No per-projectile point lights (use additive emissive ground decals + instanced glow sprites). |
| Particles & projectiles | **≤2,500 active GPU-instanced particles/tracers** across pooled `InstancedMesh` batches | Zero per-frame allocations; pre-allocated ring buffers. |
| Shaders & uploads | 100% precompiled via `renderer.compileAsync` behind load veil; variants driven by uniforms; textures decoded via `createImageBitmap` and uploaded ≤2 per frame | Eliminates first-sighting Quest 3 hitches. |

*Desktop numbers rank variants only; physical Quest 3 measurements close every performance criterion (`~/.claude/guides/webxr.md`).*

### Asset Pipeline & Pre-Approved Vertical-Slice Spend Boundary

Follows `~/.claude/guides/game-assets.md`, `blender-mcp.md`, `blender-game-export.md`, `suno.md`, `art/SKILL.md`, and `elevenlabs/SKILL.md`. Sources stay immutable under `assets-source/<asset>/`; runtime copies promote to `public/assets/` only after `$validate-generated-assets` passes. Technical validation and owner creative sign-off are tracked separately.

| Asset Class | Owning Workflow | Execution Tool |
| --- | --- | --- |
| Style-reference board, turret/enemy/portal concept sheets, UI icons, title key art | `$art`, `$create-game-key-art` | Higgsfield CLI (`cinematic_studio_2_5`, `nano_banana_pro`, `image_background_remover`) |
| Core Bastion, Dimensional Rift Portal frame, 4 Turrets × 3 Tiers + clamp/hover pods | `$create-modular-3d-assets` → `$blender-kit-pieces` | Blender 5.2.2 LTS headless scripts (`high` + `low` `.blend`, Cycles PBR/ORM bakes, deterministic GLB + KTX2) |
| 5 Rigged/Animated Invaders (Crawler, Wasp Skimmer, Brute, Disruptor, Broodlord Boss) | `$create-rigged-character-assets` | Blender 5.2.2 LTS (rig, skin, locomotion/climb/fly, attack, hit, death clips + Cycles bakes → GLB + KTX2) |
| Sci-fi titanium, ceramic, chitin, glowing coil PBR materials | `$create-tileable-pbr-materials` | Blender procedural + Cycles bakes (plus Higgsfield detail references as needed) |
| Spatial combat, placement, portal, Core, and UI SFX | `$create-game-audio-assets` → `$elevenlabs` | ElevenLabs (`eleven_text_to_sound_v2`), mastered & reviewed on `audition.html` |
| Adaptive mission music + Victory/Defeat stingers | `$create-game-audio-assets` + `guides/suno.md` | Suno Custom v6 — prompts in [`suno-music-prompt.md`](suno-music-prompt.md), owner-generated WAVs mastered into Opus + MP3 |
| Release gate for every asset | `$validate-generated-assets` | Automated budget/hash/encoding checks + live-engine inspection + owner approval record |

**Standing Spend Pre-Approval (Vertical Slice):** Paid generation within the table below is pre-approved by Paul (with up to **3× retry headroom** per category). Any generation outside this list requires explicit new approval. **Meshy is NOT authorized.** Final creative and runtime promotion remain gated on owner review.

| Provider | Asset Category | Target Count |
| --- | --- | --- |
| Higgsfield | Master style-reference board explorations | ~6 |
| Higgsfield | Concept sheets (Core Bastion, Rift Portal, 4 turrets, 5 invaders) | 11 |
| Higgsfield | Tactical UI icons (4 turrets, upgrades, sell, relocate, target modes, statuses, wave/warning) | ~18 |
| Higgsfield | Title / launch key art + splash banner | 2 |
| ElevenLabs | SFX cues (4 turret fire/impact families × 2–3, portal tear/ambient/spawn, 5 enemy vocal/hit/death, placement clamp/hover/upgrade/sell/invalid, Core hit/shield/alarm, UI click/radial, wave horn) | ~28 |
| Suno (owner-run) | Music cues documented in [`suno-music-prompt.md`](suno-music-prompt.md) (6 loops + 2 stingers) | 8 |

---

## Phases

Each phase ends with the repo gate green and a demonstrable, testable increment. Physical Quest 3 acceptance criteria remain explicitly tracked and open until verified on hardware.

| Phase | Plan File | Demonstrable Result | Key Acceptance Gate |
| --- | --- | --- | --- |
| **P0 — Foundation & Deploy Pipeline** | [`plans/phase-0-foundation-and-deploy.md`](plans/phase-0-foundation-and-deploy.md) | Scaffolded repo, pinned `@par/xr-workspace` (`toolkit-release.json`), Makefile + pre-commit/Gitleaks, empty MR + Desktop harness, Settings page, `?perf` 1 s recorder, new-version Reload notice, CI + live deploy at `rift-bastion.pardev.net`. | `make checkall` & `make checkall-ci` green; desktop + IWER smoke boots; live HTTPS render verified on `rift-bastion.pardev.net`. |
| **P1 — Room-Scale MR, Occlusion & Hybrid Placement** | [`plans/phase-1-room-mr-and-placement.md`](plans/phase-1-room-mr-and-placement.md) | Quest 3 `immersive-ar` plane/mesh ingestion + virtual fallback, WebXR Depth Sensing + room-mesh occluder fallback + portal aperture cutouts + shadow catchers, Core Anchor calibration (`>=2.0 m` clearance), Play Arc (`180°` / `360°`), laser auto-snap + stick mid-air hover-pod placement (14 cap, `0.35 m` spacing), radial build menu, desktop parity. | IWER emulated XR walk proves seated (`1.2 m`) & standing placement on floor, table, wall, ceiling, and in mid-air + radial menu + occlusion fallback; unit tests cover placement & clearance geometry. |
| **P2 — Combat Simulation, Navigation & 12-Wave Slice** | [`plans/phase-2-combat-simulation-and-waves.md`](plans/phase-2-combat-simulation-and-waves.md) | Complete deterministic 12-wave + Boss game playable end-to-end (with high-readability tactical blockouts): 3D wall-to-floor + aerial navigation, all 4 turrets × 3 tiers + sell/relocate, 5 enemy archetypes (including turret-disrupting Disruptors & Broodlord Boss), economy, threat chevrons, IndexedDB persistence + JSON export/import. | Full 12-wave deterministic sim tests pass (`vitest`); desktop & IWER playthrough reaches Victory & Defeat cleanly; IndexedDB save/export/import verified. |
| **P3 — Art Direction & Blender AAA Asset Production** | [`plans/phase-3-art-direction-and-blender-assets.md`](plans/phase-3-art-direction-and-blender-assets.md) | Approved Higgsfield style board, concepts, icons & key art; all Blender 5.2.2 LTS high-to-low modular models (Core, Rift Portal, 4 Turrets × 3 Tiers + clamp/hover pods) & 5 rigged/animated invaders baked to KTX2/ORM GLBs, passing `$validate-generated-assets` and owner review. | Every GLB meets triangle, bone, material, ORM/sRGB encoding, normal, and deterministic export checks; owner approves art bible and asset batch before runtime promotion. |
| **P4 — AAA Rendering, FX & Spatial Audio** | [`plans/phase-4-aaa-rendering-fx-and-audio.md`](plans/phase-4-aaa-rendering-fx-and-audio.md) | Final visual & audio experience: promoted Blender assets integrated with procedural IBL, tuned shadow catchers, dimensional rift depth-parallax shader, GPU-instanced projectiles/beams/cryo-arcs/explosions/debris, Tactical Sci-Fi re-skinned XR radial menu (`RadialMenuTheme` + Higgsfield icon badges), shader precompilation veil, `createImageBitmap` streaming, ~28 ElevenLabs spatial SFX + mastered Suno music (`audition.html`). | Zero first-frame shader hitches in profiling; `audition.html` passes codec/LUFS/peak/seam checks and owner sign-off; desktop + IWER full visual capture green. |
| **P5 — Quest 3 Tuning, Verification & Release** | [`plans/phase-5-quest3-tuning-and-release.md`](plans/phase-5-quest3-tuning-and-release.md) | Measured release candidate on physical Quest 3: full local GPU Playwright + IWER 12-wave seated/standing walks, production build A→B update-notice verification, Quest 3 `VrApi` + `ovrgpuprofiler` + CDP profiling & optimization proving **72 Hz target / ≥50 fps floor**, live smoke on `https://rift-bastion.pardev.net/`. | Physical Quest 3 seated (`180°`) and standing (`360°`) runs pass comfort, occlusion, readability, and **≥50 delivered FPS in every complete 1-second active bin** through Wave 12 Boss; release smoke recorded. |

---

## Risks

| Risk | Mitigation / Verification Proof |
| --- | --- |
| **WebXR depth-sensing clips recessed wall/ceiling portals** — physical wall depth sits in front of the portal's virtual interior depth. | Render portal interior with an explicit aperture stencil/mask pass that bypasses physical depth-texture testing inside the portal rim (`mr/` + `render/`). Verify on physical Quest 3 against real walls in P1 and P5; retain `Room Occlusion: Room Mesh / Off` fallback. |
| **WebXR depth-sensing fragment cost pushes Adreno past 20 ms** during heavy Wave 12 combat. | Profile depth-sensing ON vs Room-Mesh fallback vs OFF with `ovrgpuprofiler` and `VrApi` on Quest 3 during P1/P5; gate depth-sensing under Quality Tier if needed while keeping Room-Mesh occluders + shadow catchers active. |
| **Empty, denied, or noisy Quest 3 room scans** break portal spawning or floor navigation. | Detect granted session features explicitly; distinguish missing permission from empty scan (`webxr.md`). Provide instant virtual tactical arena + virtual rift gates so all 12 waves remain 100% playable from any chair or room without scanning. |
| **Hybrid wall/ceiling crawler pathing snags on messy room furniture** (gaps between scanned wall and floor planes). | Build the `nav/` graph with stitched portal-descent splines onto the nearest floor/table plane + resilient clearance-checked waypoints and stuck-unit recovery (leap/re-path fallback) so no enemy ever stalls out of bounds. |
| **Wave 12 Boss + 14 active turrets + 25 enemies + VFX exceeds Quest 3 draw-call or vertex budgets.** | Hard cap of 14 turrets and 25 active enemies; GPU-instanced projectiles/particles/muzzle flashes/debris; LOD swaps >4–6 m; strict Blender triangle/material budgets enforced in P3 validator; verified with worst-case stress scene on Quest 3 before P5 sign-off. |
| **Seated players get blindsided by portals** behind their chair. | Default seated posture to `Front 180° Arc` (selectable in Calibration & Settings), pair with spatialized ElevenLabs portal cues and edge-of-view HUD directional threat chevrons. |
| **Clean CI checkout cannot resolve local `file:../mux-xr/packages/xr-workspace` dependency.** | Mirror `rogue-xr` / `portal-xr` CI workflow: pin `mux-xr` commit SHA in `toolkit-release.json` and check out `paulrobello/mux-xr` as a sibling in CI before `bun install` and `stageWorkspaceAssets`. Prove in P0. |
| **Dense combat SFX masks warning cues or clips Quest speakers.** | Voice-pool caps per SFX class, ducking priority (Core alarm / Boss cue > Turret fire), Suno score engineered for midrange/transient space (`suno-music-prompt.md`), loudness/true-peak checks (`-16 LUFS`, `≤-1 dBTP`) + Quest speaker audition on `audition.html`. |

---

## Open Questions

1. **Final Product Title:** *Rift Bastion* (`rift-bastion.pardev.net`) is the working title. Confirm before P3 title key art generation and P0 Cloudflare/GitHub Pages custom-domain provisioning if a different name is preferred.
2. **Optimal Default Framebuffer Scale (`1.1` vs `1.15` vs `1.2`):** Will be settled empirically on physical Quest 3 during P5 Wave 12 Boss profiling to maximize crispness while holding the ≥50 delivered FPS floor.
3. **Depth-Sensing vs Room-Mesh Default on Quest 3:** `Auto Depth → Room Mesh fallback` is the planned default; physical Quest 3 testing in P1/P5 will confirm whether Quest Browser's live depth-sensing quality and GPU cost beat room-mesh occluders in typical living-room lighting.
4. **Creative Sign-Offs:** Style-reference board (P3), Blender turret/enemy models & animations (P3), ElevenLabs SFX takes (P4), and owner-generated Suno WAV takes (P4) all remain explicitly open for Paul's approval before runtime promotion.
