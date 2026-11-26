# Phase 2 — Combat Simulation, Navigation & 12-Wave Slice

> **PRD Reference:** `PRD.md` §Phases (P2), Decisions D7–D9, D11–D12  
> **Depends On:** [`plans/phase-1-room-mr-and-placement.md`](phase-1-room-mr-and-placement.md)  
> **Goal:** Implement the complete deterministic pure-TypeScript tower-defense simulation, hybrid 3D wall/ceiling-to-floor + aerial room navigation, all 4 turrets × 3 tiers, all 5 invader archetypes (including turret-disrupting Disruptors and the Wave 12 Apex Broodlord Boss), directional threat chevrons, and IndexedDB persistence — delivering a fully playable, end-to-end 12-wave game with clean tactical blockout meshes before AAA art production begins.

---

## Tasks & Parallel Waves

### Wave 1 (Parallel Pure Logic — Zero Three.js)

#### `P2-T1`: Hybrid 3D Room Navigation Graph (`src/nav/`)
- **Dependencies:** `plans/phase-1-room-mr-and-placement.md` (`P1-T1`, `P1-T3`)
- **Scope:**
  - Implement `src/nav/graph.ts` building two synchronized pathing layers from `RoomSurfaceModel` + Core pose + Portal anchors:
    - **Crawler Surface Layer:** Computes smooth wall/ceiling descent splines from each portal aperture down to the nearest walkable floor/table surface, then builds an obstacle-aware navigation grid/waypoint mesh around furniture footprints to the Core Bastion, with stuck-unit recovery (leap/re-path fallback if a dynamic room update breaks a link).
    - **Aerial Corridor Layer:** Computes 3D obstacle-clearing flight splines (with slight lateral spread lanes to prevent visual stacking) from every wall/ceiling portal straight through open room air to the Core (and for Disruptors, patrol detours toward nearby active turrets).
  - Precompute deterministic path lengths (`distanceToCore`) so turret `"First"` targeting is exact, O(1), and consistent across ground and air units.
- **Verification:** `vitest` tests crawler descent from wall & ceiling portals, obstacle avoidance around table footprints, aerial 3D clearance corridors, stuck-unit recovery, and `distanceToCore` monotonicity across 5 randomized room layouts; `make checkall` passes.

#### `P2-T2`: Content Data Tables & 12-Wave Mission Script (`src/content/`)
- **Dependencies:** `plans/phase-0-foundation-and-deploy.md` (`P0-T2`)
- **Scope:**
  - Author `src/content/turrets.ts`: exact balanced stats, build/upgrade/relocate costs, range, fire rate, damage, AoE radius, cryo slow factor/chain count, armor pierce, and air-bonus multipliers for all 4 turrets × 3 tiers (`M44 Autocannon`, `Helios Plasma Mortar`, `Glacier Cryo-Arc`, `Valkyrie Rail Sniper`).
  - Author `src/content/enemies.ts`: stats, armor rules (`Carapace Brute` 50% kinetic armor), movement layer (`surface` / `air`), credit bounties, Core damage, and special abilities (`Rift Disruptor` 4 s EMP pulse disabling turrets within `1.2 m`; `Apex Broodlord` Phase 2 armor-crack at 50% HP + Skitter add spawns + suppression pulse) for all 5 archetypes.
  - Author `src/content/waves.ts`: complete 12-wave + Boss mission paced for **10–15 minutes** (Waves 1–4 introductory crawlers/skimmers; Waves 5–8 armored brutes + multi-portal pressure; Waves 9–11 disruptors + saturated air/ground; Wave 12 Apex Broodlord Boss with escort waves), including intermission countdowns (`15 s` skippable via **Launch Early** bonus credits) and active portal schedules (up to 4 concurrent portals).
- **Verification:** Pure balance simulation test in `vitest` validates economy curve (starting credits + wave bounties afford a viable 10–14 turret T2/T3 defense), zero invalid IDs, and deterministic duration estimates (10–15 min target); `make checkall` passes.

#### `P2-T3`: Versioned IndexedDB Persistence & JSON Backup (`src/persist/`)
- **Dependencies:** `plans/phase-0-foundation-and-deploy.md` (`P0-T3`)
- **Scope:**
  - Implement `src/persist/store.ts` using IndexedDB (with schema versioning & migration hooks):
    - Stores `settings` (all Settings page options from P0-T3) and `missionRecords` (best score, highest wave cleared, 1–3 star rating based on remaining Core HP, total runs, recent run history capped at 20 entries).
    - Never stores room scan meshes, planes, or camera frames.
    - Provides validated **Export JSON** and **Import JSON** (rejecting corrupt/future-version payloads gracefully without clobbering good data).
- **Verification:** `vitest` + `fake-indexeddb` verifies read/write, schema migration, star calculation, corrupt-JSON rejection, and round-trip export/import; `make checkall` passes.

### Wave 2 (Simulation Engine after Wave 1)

#### `P2-T4`: Deterministic 60 Hz Combat Simulation Engine (`src/sim/`)
- **Dependencies:** `P2-T1`, `P2-T2`, `plans/phase-1-room-mr-and-placement.md` (`P1-T4`)
- **Scope:**
  - Implement `src/sim/engine.ts` with fixed-timestep (`dt = 1/60 s`) accumulator, spatial hash grid for fast neighbor queries (AoE splash, Cryo-Arc chains, Disruptor EMP radius), and seeded PRNG tie-breaking:
    - Live & intermission build, upgrade (`T1→T2→T3`), target-priority switch, relocate (with brief redeploy cooldown), and sell (`50%` refund).
    - All 4 weapon systems: Autocannon rapid tracers, Plasma Mortar parabolic splash + burn DoT, Cryo-Arc slow (`35–55%`) + chain lightning (`2–4` jumps), Rail Sniper instant piercing line-of-sight beam with armor penetration & anti-air bonus.
    - Enemy spawning from active portals, path advancement, Disruptor turret-EMP status (`4 s` disable + immunity cooldown so a single disruptor cannot permastun), Broodlord Phase 2 transition + add spawns, Core damage, Victory/Defeat transitions, and typed event stream (`TurretFired`, `EnemyHit`, `EnemyKilled`, `TurretDisrupted`, `PortalOpened`, `CoreHit`, `WaveStarted`, `BossPhase2`, `MissionEnded`) for rendering and audio consumers.
- **Verification:** Headless `vitest` suite runs a full deterministic 12-wave scripted defense to Victory AND a zero-turret run to Defeat, asserting identical final state hashes across repeated runs with the same seed, plus targeted unit tests for every turret role, armor reduction, cryo slow/chain, disruptor stun/recovery, and Boss Phase 2; `make checkall` passes.

### Wave 3 (Presentation & Playable Integration after Wave 2)

#### `P2-T5`: High-Readability Tactical Blockout Visuals, World Health Bars & Threat Chevrons
- **Dependencies:** `P2-T4`, `plans/phase-1-room-mr-and-placement.md` (`P1-T5`)
- **Scope:**
  - Implement clean, dimension-locked tactical blockout meshes in `src/render/blockouts.ts` matching exact target footprints/silhouettes for Core Bastion, Rift Portals, 4 Turrets × 3 Tiers (with yaw/pitch tracking + clamp/hover base distinction), and 5 Invaders (distinct shapes/scales/colors + disrupted/slowed/armored visual indicators) so P3 Blender assets drop in 1:1.
  - Add instanced projectile tracers, mortar arcs, cryo-arc beams, rail beams, enemy HP bars (instanced), turret EMP-disrupted spark icons, and Core shield ring.
  - Add compact **edge-of-view HUD directional threat chevrons** pointing toward off-FOV newly opened portals and enemies within `1.8 m` of the Core (`PRD.md` D4).
  - Connect Mission Victory / Defeat overlays to `src/persist/store.ts` (displaying score, wave, 1–3 stars, New Best badge, Replay, and Settings).
- **Verification:** `make checkall` passes; desktop manual/automated play confirms every turret, enemy, upgrade, disruptor EMP, boss phase, and Victory/Defeat flow renders cleanly.

#### `P2-T6`: P2 End-to-End Playthrough Verification (Desktop + IWER XR)
- **Dependencies:** `P2-T3`, `P2-T5`
- **Scope:**
  - Add `?debug` shortcuts (jump to wave, grant credits, spawn boss) strictly gated behind debug flag for automated test speed while keeping core interactions ray-driven (`webxr.md`).
  - Add Playwright desktop e2e spec playing through calibration → build all 4 turrets → upgrade → relocate → sell → Wave 1 → Wave 12 Boss → Victory → verify IndexedDB persistence across page reload + JSON export/import.
  - Extend `scripts/xr-emu/` walk to run an emulated Quest 3 combat sequence (seated `1.2 m` Front 180° Arc): open radial menu, build Autocannon + Rail Sniper (one surface, one mid-air hover-pod), launch Wave 1, verify enemy kill + credit gain + threat chevron + Wave 12 Boss spawn via `?debug`, assert zero uncaught errors and valid render-pass order.
- **Verification:** `make checkall && make checkall-ci && make xr-emu` all pass on local Metal GPU; screenshots archived under `output/xr-emu/p2/`.

---

## Phase 2 Exit Criteria

- **Complete playable vertical slice** from title → room calibration → Waves 1–12 + Apex Broodlord Boss → Victory/Defeat → persisted high score, running identically on desktop and emulated Quest 3 XR.
- Pure simulation determinism and full 12-wave balance verified by unit tests before investing in AAA Blender/Higgsfield/ElevenLabs/Suno asset production in P3–P4.
