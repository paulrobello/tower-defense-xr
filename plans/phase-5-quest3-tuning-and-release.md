# Phase 5 — Quest 3 Tuning, Verification & Release

> **PRD Reference:** `PRD.md` §Phases (P5), §Quest 3 Budgets, §Risks  
> **Depends On:** [`plans/phase-4-aaa-rendering-fx-and-audio.md`](phase-4-aaa-rendering-fx-and-audio.md)  
> **Goal:** Run exhaustive automated GPU Playwright + IWER emulated XR verification, conduct physical Meta Quest 3 seated (`180°`) and standing (`360°`) profiling (`VrApi`, `ovrgpuprofiler`, CDP main-thread profiler), tune Quest 3 budgets until every complete 1-second active gameplay bin holds the **72 Hz target / ≥50 delivered FPS floor** through Wave 12 Boss, verify production A→B live-update reloads, and sign off the public release on `https://rift-bastion.pardev.net/`.

---

## Tasks & Parallel Waves

### Wave 1 (Automated Emulated XR & Stress Verification — Local Metal GPU)

#### `P5-T1`: Full 12-Wave + Worst-Case Stress Suite (Desktop + IWER Emulated XR)
- **Dependencies:** `plans/phase-4-aaa-rendering-fx-and-audio.md` (`P4-T2`, `P4-T3`, `P4-T5`)
- **Scope:**
  - Build a deterministic `?stress` Wave 12 worst-case fixture (14 active T3 turrets — mix of surface & mid-air hover-pods — 4 simultaneous portals, 25 active enemies including Apex Broodlord Phase 2, Disruptor EMP pulses, and full combat VFX firing concurrently).
  - Run full GPU-backed Playwright + IWER (`make xr-emu`) walks covering:
    - Seated (`1.2 m`, Front 180° Arc) and Standing (`1.65 m`, Full 360° Room) flows.
    - Render-pass ordering assertions (portal aperture mask → world → shadow catchers → UI → overlay/laser/Update notice).
    - Draw call (`≤200` both eyes) and visible triangle (`≤350k`/eye) automated budget assertions on the `?stress` frame.
    - Real production build A→B update-notice verification (desktop auto-reload + XR HUD `Update: Reload` awaiting `session.end()` and adopting new build hash).
- **Verification:** Book host window if needed per `infrastructure.md`; `make checkall && make checkall-ci && make xr-emu` pass with `UNMASKED_RENDERER_WEBGL` logged and 1-min host load `≤15` before/after; report + screenshots archived in `docs/verification/p5-emulator-report.md`.

### Wave 2 (Physical Meta Quest 3 Profiling & Tuning — Owner Hardware Session)

#### `P5-T2`: Physical Quest 3 Baseline Measurement (`VrApi`, `ovrgpuprofiler`, CDP)
- **Dependencies:** `P5-T1`
- **Scope:**
  - Connect Quest 3 via USB (`adb reverse tcp:4272 tcp:4272` or preview on `https://rift-bastion.pardev.net/?perf`).
  - Run `?stress` and full 12-wave playthroughs capturing:
    - In-app 1-second frame buckets retrieved via `bun scripts/perf-quest.ts` (min, median, p95, worst complete 1 s bin, dropped/below-50 count).
    - Simultaneous `adb logcat -v time -s VrApi:I` (`FPS=got/target`, `App=`, `GPU%`, `Stale=`, `SF=`, `Fov=`, `Temp=`).
    - `ovrgpuprofiler` vertex vs fragment split and primitives/sec.
    - CDP `Profiler.start`/`stop` folded against source maps for main-thread JS hotspots.
  - Run controlled A/B measurements on Quest 3:
    1. `Room Occlusion`: `Auto Depth` (WebXR depth-sensing) vs `Room Mesh` vs `Off`.
    2. `Framebuffer Scale`: `1.1` vs `1.15` vs `1.2` at `Fixed Foveation 0.5`.
    3. Shadow-map cost (`1024×1024` vs `512×512`) and LOD distance thresholds.
- **Verification:** Raw measurements and folded profiles saved to `docs/verification/p5-quest3-perf.md` (with actual before numbers, negotiated Hz, `SF`, `Fov`, and `Stale` counts — never estimates per Engineering R12).

#### `P5-T3`: Quest 3 Performance & Comfort Optimization Pass
- **Dependencies:** `P5-T2`
- **Scope:**
  - Address every bottleneck identified in `P5-T2` (e.g., adjusting default framebuffer scale `1.1–1.2`, tuning `Room Occlusion` default or quality-tier gating if depth-sensing exceeds fragment budget, tightening LOD distances/animation throttle, batching any UI draw outliers, eliminating any GC/main-thread spikes in `sim/` or `render/`).
  - Re-measure on physical Quest 3 under the **identical** `?stress` and full 12-wave mission workloads, recording before/after numbers in `docs/verification/p5-quest3-perf.md`.
  - Verify all three Quality Tiers (`Balanced`, `Max Beauty`, `High FPS`) produce measurable, monotonic cost steps on hardware without breaking interaction targets.
- **Verification:** Re-measured physical Quest 3 run clears **72 Hz target / ≥50 delivered FPS in every complete 1-second active gameplay bin** across the full 12-wave mission through Wave 12 Boss, with `make checkall && make checkall-ci && make xr-emu` still green.

### Wave 3 (Final Physical Acceptance & Release Sign-Off)

#### `P5-T4`: Physical Quest 3 Seated & Standing Acceptance + Live Release Smoke
- **Dependencies:** `P5-T3`
- **Scope:**
  - Complete and record Paul's physical Quest 3 acceptance checklist (`docs/verification/p5-quest3-acceptance.md`):
    - **Seated (`Front 180° Arc`):** Comfortable Core placement, zero behind-the-back blind-siding, smooth floor, table, wall, ceiling, and mid-air hover-pod turret placement, readable SDF text and icons, comfortable 10–15 min pacing to Wave 12 Boss Victory.
    - **Standing (`Full 360° Room`):** Wall/ceiling portal cutouts visually convincing at oblique angles, physical hand/furniture occlusion clean, floor/table shadows grounded, spatialized ElevenLabs SFX + Suno score clearly audible and unclipped on Quest speakers.
    - **Fallback & Persistence:** Test room-scan-denied virtual fallback, Settings survival across XR exit/re-entry, IndexedDB best score/stars persistence, and in-XR `Update: Reload` flow.
  - Deploy final verified release build to `https://rift-bastion.pardev.net/` (after explicit push approval per Git Workflow), run live production browser smoke + Quest Browser live-URL verification, and update `PRD.md` status and `README.md` phase table.
- **Verification:** Every physical Quest 3 acceptance criterion checked off with recorded evidence; live `https://rift-bastion.pardev.net/` smoke green; zero open P0–P5 blockers on kanban board.

---

## Phase 5 Exit Criteria

- Measured physical Quest 3 evidence proves **≥50 delivered FPS in every complete 1-second active gameplay bin** (target 72 Hz) through Wave 12 Boss.
- Both seated (`180°`) and standing (`360°`) Quest 3 playthroughs accepted by Paul.
- Public release live and verified at `https://rift-bastion.pardev.net/`.
