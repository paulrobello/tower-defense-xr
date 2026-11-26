# Phase 1 — Room-Scale MR, Occlusion & Hybrid Placement

> **PRD Reference:** `PRD.md` §Phases (P1), Decisions D2–D6  
> **Depends On:** [`plans/phase-0-foundation-and-deploy.md`](phase-0-foundation-and-deploy.md)  
> **Goal:** Deliver the complete room-scale mixed-reality spatial foundation: Quest 3 plane/mesh ingestion with graceful virtual room fallback, layered WebXR Depth Sensing + room-mesh occlusion with portal aperture cutouts and real-world shadow catchers, pre-mission Core Anchor calibration, seated/standing Play Arc, and hybrid floor, table, wall, ceiling, and mid-air turret placement with the `@par/xr-workspace` radial menu — matched 1:1 on desktop.

---

## Tasks & Parallel Waves

### Wave 1 (Parallel MR Spatial Core)

#### `P1-T1`: Quest 3 Plane/Mesh Room Ingestion & Virtual Fallback Arena
- **Dependencies:** `plans/phase-0-foundation-and-deploy.md` (`P0-T2`)
- **Scope:**
  - Implement `src/mr/room-scan.ts` ingesting `XRFrame.detectedPlanes` and `XRFrame.detectedMeshes` (`semanticLabel` classification: `floor`, `table`/`couch`/`desk`, `wall`, `ceiling`, `other`).
  - Check granted session features explicitly (`webxr.md`): distinguish *feature unsupported/permission denied* from *empty room scan* and surface a clear, dismissible in-scene status message with one-click fallback to the **Virtual Tactical Arena**.
  - Maintain a unified `RoomSurfaceModel` consumed identically by `nav/`, `mr/`, and `xr/` (storing world-space polygons, normals, bounding boxes, and tracking revision IDs so visual anchors and colliders move together on tracking refinement and hide/restore cleanly on tracking loss).
  - Build the deterministic **Virtual Room Fixture** (`4.8 m × 4.2 m × 2.8 m` room with floor, central/side tables, walls, ceiling) used automatically on desktop, in IWER, and whenever Quest room scan is absent or too small.
- **Verification:** `vitest` verifies surface classification, empty-vs-denied distinction, tracking-loss hide/restore offset stability, and fallback arena synthesis; `make checkall` passes.

#### `P1-T2`: WebXR Depth Sensing Occlusion, Room-Mesh Fallback, Portal Aperture Cutouts & Shadow Catchers
- **Dependencies:** `plans/phase-0-foundation-and-deploy.md` (`P0-T2`, `P0-T3`)
- **Scope:**
  - Implement `src/mr/occlusion.ts` supporting the three Settings modes (`Auto Depth` / `Room Mesh` / `Off`):
    - **Primary (`depth-sensing`):** Acquire per-view `XRDepthInformation` (`gpu-optimized` preferred, `cpu-optimized` upload fallback), bind depth texture + `normDepthBufferFromNormView` matrix + `rawValueToMeters` uniform to an injectable Three.js `onBeforeCompile` occlusion chunk on virtual enemies, projectiles, and turrets.
    - **Portal Aperture Bypass:** Render a dedicated portal-aperture stencil/mask pass so recessed wall/ceiling dimensional rifts bypass physical wall depth inside their opening (`PRD.md` D5, Risk 1) while their outer rim still respects foreground occlusion (e.g., player hands/furniture in front of the wall).
    - **Fallback (`Room Mesh`):** Build depth-only (`colorWrite: false`, `depthWrite: true`) occluder meshes from scanned Quest planes & meshes, cutting openings through **every** co-located host representation (both plane and slightly offset mesh — `webxr.md` line 28) at each active portal aperture.
  - Implement `src/mr/shadow-catchers.ts`: attach `ShadowMaterial` shadow-catcher planes onto scanned horizontal floor/table surfaces (and virtual fallback floor/table) receiving crisp directional shadows without darkening passthrough pixels.
- **Verification:** Unit tests verify aperture cutout geometry across dual plane+mesh hosts, mode fallback transitions (`Auto Depth → Room Mesh → Off`), and depth-uniform binding; visual Playwright/IWER test confirms shadow catcher + portal aperture visibility with zero passthrough seam; `make checkall` passes.

### Wave 2 (Parallel after Wave 1)

#### `P1-T3`: Pre-Mission Core Anchor Calibration & Play Arc (`180° Seated` / `360° Standing`)
- **Dependencies:** `P1-T1`, `P1-T2`
- **Scope:**
  - Implement `src/xr/calibration.ts`: at mission start (`calibrate` state), auto-suggest the Core Bastion anchor on the nearest scanned table or floor `1.2–1.8 m` ahead of the initial headset pose (with horizontal clearance checks from both seated `1.2 m` and standing `1.65 m` heights).
  - Allow the player to reposition the Core via controller laser point-and-trigger or grip-drag (clamped to valid horizontal surfaces or virtual pedestal).
  - Implement Play Arc selection (`Front 180° Seated` auto-defaulted when initial head height `<1.35 m`, `Full 360° Standing` otherwise — user-overridable in Calibration UI and Settings).
  - Validate that at least 2 valid wall/ceiling portal anchors exist at `>=2.0 m` Euclidean distance from the Core within the chosen Play Arc (automatically synthesizing virtual rift gates at `2.6–3.6 m` if scanned walls are closer or missing) and preview those rift locations visually before confirming **Lock Core & Begin**.
- **Verification:** `vitest` tests seated/standing height detection, `>=2.0 m` clearance enforcement, 180° vs 360° angular filtering, and virtual portal fallback when room is smaller than `2.0 m`; `make checkall` passes.

#### `P1-T4`: Hybrid Turret Placement Engine (Auto Surface-Snap + Stick Hover-Pod Depth + 14 Cap)
- **Dependencies:** `P1-T1`, `P1-T3`
- **Scope:**
  - Implement `src/xr/placement.ts` + pure validation helpers in `src/sim/placement-rules.ts`:
    - Cast controller laser (`@par/xr-workspace` `PlacementRays` + `createPointer`) against scanned floors, tables, walls, and ceilings.
    - **Auto Surface-Snap:** When the ray hits a valid surface within range (`0.5–6.0 m`), snap the hologram ghost flush to the surface normal and check the **entire footprint** against the plane boundary / nearby mesh triangles (`webxr.md` line 27 — no half-hanging turret bases!). Render clamp-legs preview + range dome.
    - **Thumbstick Hover-Pod Mode:** Pushing/pulling the aiming thumbstick forward/backward detaches the ghost into mid-air repulsor hover-pod mode at smoothly bounded depth (`0.8–5.0 m`), switching the preview mount to the glowing repulsor ring. Aiming back onto a valid surface with neutral stick re-snaps (or pressing brief B/Y toggle forces re-snap).
    - **Rules & Constraints:** Enforce **hard cap of 14 active turrets**, **`0.35 m` minimum center-to-center spacing**, Core keep-out radius (`0.55 m`), and portal keep-out radius (`0.65 m`). Color-code hologram ghost (cyan = valid surface, violet-cyan = valid hover-pod, crimson + crisp SDF reason label = invalid: `"CAP 14/14"`, `"TOO CLOSE"`, `"OVERHANG"`, `"CORE ZONE"`).
    - Store each placed turret's pose relative to its supporting `RoomSurfaceModel` anchor (or Core frame for hover-pods) so tracking refinements move visual + collider together.
- **Verification:** `vitest` proves footprint overhang rejection, surface normal alignment (floor, table, wall, ceiling), hover-pod depth clamping (`0.8–5.0 m`), `0.35 m` spacing, and 14-turret cap; `make checkall` passes.

### Wave 3 (Parallel after Wave 2)

#### `P1-T5`: Spatial Radial Build/Upgrade Menu, Movable Tactical HUD & Desktop Parity Controls
- **Dependencies:** `P1-T3`, `P1-T4`
- **Scope:**
  - Wire `@par/xr-workspace`'s `createXrRadialMenu` (click either thumbstick to open; deliberate stick tilt or either controller laser + trigger selects; second click dismisses; grip never accidentally activates triggers per `webxr.md` Controller Contract).
  - Build two radial contexts:
    - **Build Wheel** (empty space/surface): 4 turret types (Autocannon, Plasma Mortar, Cryo-Arc, Rail Sniper) with live cost badges + Launch Next Wave + Cancel.
    - **Inspect/Command Wheel** (pointing at an existing turret): Upgrade Tier (`T1→T2→T3`), Target Priority cycle (`First / Strongest / Closest / Air`), Relocate, Sell (`50%` refund), Close.
  - Build compact movable tactical HUD (`@par/xr-workspace` `createMenuPanel` + `CachedTextBatch` + `keepAbove`) displaying Core HP, Requisition Credits, Wave counter, Turrets `N/14`, Settings button, and both-stick 1-second recenter support.
  - Map 100% of Calibration, Surface/Hover Placement (mouse ray + scroll wheel depth), Radial/Hotkeys (`1–4`, `U`, `R`, `X`, `T`, `Space`), and HUD controls onto the shared desktop action bus (`src/desktop/controls.ts`).
- **Verification:** `vitest` verifies controller grip-suppression invariant, radial selection/cancel ownership, and desktop-to-action-bus parity; `make checkall` passes.

#### `P1-T6`: P1 IWER Emulated XR Walk & Verification
- **Dependencies:** `P1-T2`, `P1-T5`
- **Scope:**
  - Extend `scripts/xr-emu/` with a P1 automated walk exercising both **seated (`1.2 m`)** and **standing (`1.65 m`)** head poses:
    1. Enter `immersive-ar` → verify Calibration Core suggestion & Lock Core.
    2. Open thumbstick radial menu → select turret → snap onto floor, table, wall, and ceiling surfaces → verify valid placements.
    3. Push thumbstick to detach into mid-air hover-pod mode → place hover turret → verify repulsor mount state.
    4. Trigger invalid placement (`TOO CLOSE` / `CAP 14/14`) → assert rejection reason label.
    5. Verify portal aperture rendering and occlusion mode toggle (`Auto Depth` / `Room Mesh` / `Off`) without errors.
  - Add desktop Playwright test covering the identical flow via mouse + keyboard.
- **Verification:** `make checkall && make checkall-ci && make xr-emu` all pass on local Metal GPU; screenshots inspected and archived under `output/xr-emu/p1/`.

---

## Phase 1 Exit Criteria

- Players can anchor the Core, choose `180° Seated` or `360° Standing`, place/relocate/sell placeholder turrets across floors, tables, walls, and mid-air hover-pods (respecting the 14-turret cap and `0.35 m` spacing), and see wall/ceiling portal cutouts + floor shadow catchers in both desktop and IWER emulated Quest 3 XR.
- Physical Quest 3 room-scan + depth-sensing occlusion acceptance check is documented and staged for early hardware spot-check (and formally closed in P5).
