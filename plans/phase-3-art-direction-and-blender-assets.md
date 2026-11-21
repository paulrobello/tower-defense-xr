# Phase 3 — Art Direction & Blender AAA Asset Production

> **PRD Reference:** `PRD.md` §Phases (P3), §Asset Pipeline & Spend Boundary, §Quest 3 Budgets  
> **Depends On:** [`plans/phase-2-combat-simulation-and-waves.md`](phase-2-combat-simulation-and-waves.md) (blockout dimensions locked in `src/render/blockouts.ts`)  
> **Goal:** Establish the unified Tactical Sci-Fi Hard-Surface Military art bible via Higgsfield, author all 3D models, PBR/ORM bakes, rigs, and animations in Blender 5.2.2 LTS (`create-modular-3d-assets` / `blender-kit-pieces` / `create-rigged-character-assets`), pass automated `$validate-generated-assets`, independent `>=80/100` visual scoring, and Quest 3 budget gates, and secure owner creative sign-off prior to runtime promotion in Phase 4.

---

## Verified Local Toolchain & Precedents

- **Blender:** `/Applications/Blender.app/Contents/MacOS/Blender` (**5.2.2 LTS**, verified 2026-11-20); live community MCP on TCP `9876` via `python3 ~/.claude/guides/blender-bl.py`.
- **KTX2 encoder:** `~/.local/opt/ktx-software-4.4.2/bin/ktx` (**v4.4.2**, verified 2026-11-20). Use UASTC q2, RDO, Zstd 18 and generated mips. glTF material maps use top-left orientation (`rd`). Encode `baseColor` and `emissive` as sRGB, `normal` and `ORM` as linear, and normalize tangent normals. [Khronos orientation and color rules](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_texture_basisu#additional-requirements)
- **Higgsfield CLI:** `/Users/probello/.nvm/versions/node/v24.18.0/bin/higgsfield` (reference provenance runner: `~/Repos/rogue-xr/scripts/assets/gen_style.ts`).
- **Asset Validator Precedent:** `~/Repos/rogue-xr/scripts/assets/asset-check.py` (standalone stdlib Python gate verifying hashes, KTX2 headers, budgets, and provenance without requiring Blender).

---

## Asset Production Rules (Non-Negotiable)

- **Workflow Routing (`~/.claude/guides/game-assets.md`):**
  - Style board, concepts, UI icons, title key art → `$art` / `$create-game-key-art` (Higgsfield CLI).
  - Core, Rift Portal, 4 Turrets × 3 Tiers + clamp/hover mounts → `$create-modular-3d-assets` + `$blender-kit-pieces`.
  - 5 Rigged Invaders → `$create-rigged-character-assets`.
  - Tileable materials → `$create-tileable-pbr-materials`.
  - Every asset finishes with `$validate-generated-assets` before promotion to `public/assets/`.
- **Model routing:** Use **GPT-6.2 Astra** for visual authoring, art direction, and Blender. Use **GPT-6.2 Sol** for most nonvisual work, including asset validation tooling.
- **Blender Authoring Rules (`~/.claude/guides/blender-mcp.md`, `blender-game-export.md`):**
  - Keep checked-in deterministic Python generators (`blender/`), separate high-poly and low-poly `.blend` sources under `assets-source/`, and unique staging folders.
  - Finalize low-poly topology, corner normals, UVs, and triangulation before baking; bake Cycles portable maps (`baseColor` sRGB, `emissive` sRGB, tangent `normal` linear neutral `(0.5, 0.5, 1.0)`, packed `ORM` linear R=AO / G=Roughness / B=Metallic; metallic base-color baked via temporary emission pass to prevent darkening).
  - Bind maps by exact role filename (never substring match). Re-import exported GLBs to assert node/mesh/bone/clip/triangle/material budgets and deterministic geometry/normal checks.
  - **Spend boundary:** Stay strictly within the PRD pre-approved vertical-slice Higgsfield counts (3× retry headroom); **never** use Meshy.
  - **Owner creative sign-off:** Never self-approve aesthetics; compile renders + hashes + independent `>=80/100` visual scores into `docs/art-review-index.md` (`P3-T7`) for Paul's approval before promoting to `public/assets/`.

---

## Tasks & Parallel Waves

### Wave 1 (Art Direction Gate — Must Approve Before 3D Batch)

#### `P3-T1`: Higgsfield Style-Reference Board, Concept Sheets & Art Bible
- **Kanban ID:** `01a1fadb0b8b7467b36c14f730c1d52d`
- **Dependencies:** `plans/phase-2-combat-simulation-and-waves.md` (`P2-T5` — DONE)
- **Scope:**
  - Generate ~6 master style-reference board explorations via Higgsfield `cinematic_studio_2_5` establishing the Tactical Sci-Fi Hard-Surface Military palette (brushed titanium, matte tactical ceramic, carbon frame, high-contrast energy emissives: amber kinetic, molten orange plasma, cyan cryo-arc, cobalt-white rail, violet-teal dimensional rift, obsidian-chitin bio-mechanical invaders).
  - Generate 11 orthographic/three-quarter concept sheets aligned to the approved style board: Core Bastion, Dimensional Rift Portal, 4 Turrets (showing T1→T3 silhouette progression + clamp/hover mounts), and 5 Invaders.
  - Author `docs/art-bible.md` locking silhouette language, emissive color coding, PBR roughness/metallic ranges, and exact meter dimensions matching `src/render/blockouts.ts`.
  - Record full Higgsfield provenance, prompts, costs, and SHA-256 hashes under `assets-source/concepts/`.
- **Verification:** Automated provenance/hash check passes; **Owner Checkpoint #1:** Paul reviews and approves `docs/art-bible.md` and concept sheets before 3D modeling starts.

### Wave 2 (Parallel 2D Art & Shared PBR/Validation Tooling after `P3-T1` Approval)

#### `P3-T2`: Higgsfield Tactical UI Icons & Title Key Art
- **Kanban ID:** `01a1fadb0d97705ab0b67aaed9726f4d`
- **Dependencies:** `P3-T1` (approved art bible)
- **Scope:**
  - Generate ~18 high-contrast tactical UI icons (4 turrets, T1/T2/T3 upgrade pips, target modes, relocate, sell, EMP disrupted, wave warning, star icons) via Higgsfield `nano_banana_pro` + `image_background_remover` for crisp RGBA cutouts (also consumed by `P4-T6` radial menu re-skin).
  - Generate 2 Title / Launch key art banners (`16:9` desktop hero + square Quest launch card) via `cinematic_studio_2_5` (`$create-game-key-art`).
  - Pack UI icons into an atlas + generate runtime derivatives with provenance manifest.
- **Verification:** `$validate-generated-assets` passes alpha matte, resolution, crispness, and provenance checks; queued for `P3-T7` owner visual review.

#### `P3-T3`: Blender Shared Tactical PBR Material Library, KTX2 Encoder & GLB Validator
- **Kanban ID:** `01a1fadb108874ef8dd9dda60e64c92f`
- **Dependencies:** `P3-T1` (approved art bible)
- **Scope:**
  - Build checked-in Blender material library (`blender/materials.py`), KTX2 encoder wrapper (`scripts/assets/encode_ktx2.py` using `~/.local/opt/ktx-software-4.4.2/bin/ktx`), and standalone export validator (`scripts/validate_glbs.py` + `make model-check`) enforcing `blender-game-export.md` rules: positive-area coplanar overlap checks, planar normal deviation checks, neutral tangent-normal `(0.5, 0.5, 1.0)` check, ORM R/G/B channel verification, sRGB base/emissive verification, KTX2 header/transfer-function check, and exact triangle/material/bone/socket budget checks.
  - Author reusable tileable PBR materials (brushed titanium, matte ceramic armor, dark gunmetal frame, bio-mechanical chitin, rift obsidian) via `$create-tileable-pbr-materials`.
- **Verification:** `scripts/validate_glbs.py` passes positive & negative mutation tests (rejects bad ORM channel, over-budget tris, coplanar overlap, missing UV0) and `make model-check` integrates cleanly into `Makefile`.

### Wave 3 (Blender 3D Production — Focused Serial Workers per `blender-mcp.md`)

#### `P3-T4`: Core Bastion & Dimensional Rift Portal Kit Pieces (Blender)
- **Kanban ID:** `01a1fadb12f5733a8eccefeb99e1f8b2`
- **Dependencies:** `P3-T3`
- **Scope:**
  - Author checked-in Blender 5.2.2 LTS generators for:
    1. **Core Bastion** (`≤14,000 tris`, 2048 px KTX2 ORM, articulated energy-core crystal + animated shield emitter ring + pedestal foot matching Calibration anchor footprint).
    2. **Dimensional Rift Portal Frame** (`≤4,500 tris`, 1024 px KTX2 ORM, flush wall/ceiling anchor bezel aligned to exact aperture plane so zero passthrough seam occurs at oblique angles, plus clean UV-mapped inner aperture mesh for the P4 parallax shader).
  - Generate fixed high-vs-low comparison renders (front, isometric, detail, underside) and export deterministic GLB + KTX2.
- **Verification:** `make model-check` + `$validate-generated-assets` pass all geometry, bake, and budget gates; logged for `P3-T7`.

#### `P3-T5`: Tactical Turret Kit Rollup (`P3-T5a` + `P3-T5b` + `P3-T5c`)
- **Rollup Kanban ID:** `01a1fadb16977224a3f5072a8ba38175`
- **Sub-cards (serial Blender workers, `≤6,500 tris` LOD0 / `≤2,500 tris` LOD1, `≤2` materials, 1024 px KTX2 ORM, verified `yawRing`/`pitchCradle`/`muzzleSocket` hierarchy matching `src/render/blockouts.ts`):**
  - **`P3-T5a`** (`01a1fb3c841c708784a64a42cd4d0dcf`): Shared modular **Surface Clamp Base** (`0.16 m` footprint radius) + **Repulsor Hover-Ring Pod** (mid-air thruster ring).
  - **`P3-T5b`** (`01a1fb3c87547701ac5685baf143b252`): **M44 Autocannon** (T1 single / T2 twin linked / T3 rotary gatling + thermal vents) + **Helios Plasma Mortar** (T1 single tube / T2 dual chamber / T3 heavy siege emitter).
  - **`P3-T5c`** (`01a1fb3c897177268bcaedf2577ed3d4`): **Glacier Cryo-Arc** (T1 single coil / T2 dual prongs / T3 tri-pylon conduit) + **Valkyrie Rail Sniper** (T1 compact rail / T2 extended capacitor rails / T3 twin accelerator).
- **Verification:** Every sub-card passes `make model-check`, `$validate-generated-assets`, GLB re-import socket verification, and high-vs-low renders.

#### `P3-T6`: Rigged & Animated Bio-Mechanical Invaders Rollup (`P3-T6a` + `P3-T6b` + `P3-T6c`)
- **Rollup Kanban ID:** `01a1fadb18be76c79209166e054aeb93`
- **Sub-cards (serial Blender rigging/animation workers via `$create-rigged-character-assets`, Cycles ORM + KTX2 bakes, turntable & keyframe motion renders):**
  - **`P3-T6a`** (`01a1fb3c8b1071cf8430eb90a84fa8ba`): **Skitter Crawler** (`≤4,500 tris`, `≤24 bones`; `crawl_floor`, `climb_wall`, `attack`, `hit`, `death`) + **Wasp Skimmer** (`≤6,500 tris`, `≤24 bones`; `hover_fly`, `bank_turn`, `attack`, `hit`, `death`).
  - **`P3-T6b`** (`01a1fb3c8def7766a0bd37d25c39874d`): **Carapace Brute** (`≤9,000 tris`, `≤28 bones`; `stomp_walk`, `armor_brace`, `attack`, `hit`, `death`) + **Rift Disruptor** (`≤6,500 tris`, `≤24 bones`; `hover_glide`, `emp_pulse`, `hit`, `death`).
  - **`P3-T6c`** (`01a1fb3c91067130bdb8af122f51b91a`): **Wave 12 Boss — Apex Broodlord** (`≤28,000 tris`, `≤48 bones`, `≤3` materials, 2048 px KTX2 ORM + uniform-driven Phase-2 armor-crack emissive mask; `boss_march`, `spawn_adds`, `emp_roar`, `phase2_shift`, `hit`, `death`).
- **Verification:** Every sub-card passes bone/triangle/skin-weight/clip playback checks, `make model-check`, and `$validate-generated-assets`.

### Wave 4 (Batch Audit & Owner Sign-Off Gate — Blocks `P4-T1`)

#### `P3-T7`: Combined Hash-Bound Asset Audit, Independent Visual Scores (`>=80/100`) & Owner Sign-Off
- **Kanban ID:** `01a1fb3c93b976f4850cfb761acebef9`
- **Dependencies:** `P3-T2`, `P3-T4`, `P3-T5a`, `P3-T5b`, `P3-T5c`, `P3-T6a`, `P3-T6b`, `P3-T6c`
- **Scope:**
  - Compile `docs/art-review-index.md` indexing every P3 2D & 3D asset: fixed high/low renders, turntable/motion renders, measured tri/bone/material/texture-memory budgets, SHA-256 hashes, independent `>=80/100` visual scores (`blender-kit-pieces`), and pending owner approval column.
  - Present the complete batch to Paul and record explicit creative sign-off before promoting any asset into `public/assets/` in `P4-T1`.
- **Verification:** Every asset passes `$validate-generated-assets` and independent `>=80/100` visual scoring; Paul approves batch for Phase 4 runtime promotion.

---

## Phase 3 Exit Criteria

- `docs/art-bible.md` and `docs/art-review-index.md` contain every asset's hash, budget metrics, high/low renders, motion evidence, and independent `>=80/100` visual scores.
- Every 2D and 3D asset passes `make model-check` and `$validate-generated-assets`.
- Paul approves the vertical-slice asset batch (`P3-T7`) authorizing runtime promotion into `public/assets/`.
