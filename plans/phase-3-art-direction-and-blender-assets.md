# Phase 3 — Art Direction & Blender AAA Asset Production

> **PRD Reference:** `PRD.md` §Phases (P3), §Asset Pipeline & Spend Boundary, §Quest 3 Budgets  
> **Depends On:** [`plans/phase-2-combat-simulation-and-waves.md`](phase-2-combat-simulation-and-waves.md) (blockout dimensions locked)  
> **Goal:** Establish the unified Tactical Sci-Fi Hard-Surface Military art bible via Higgsfield, author all 3D models, PBR/ORM bakes, rigs, and animations in Blender 5.2.2 LTS (`create-modular-3d-assets` / `blender-kit-pieces` / `create-rigged-character-assets`), pass automated `$validate-generated-assets` and Quest 3 budget gates, and secure owner creative sign-off prior to runtime promotion.

---

## Asset Production Rules (Non-Negotiable)

- **Workflow Routing (`~/.claude/guides/game-assets.md`):**
  - Style board, concepts, UI icons, title key art → `$art` / `$create-game-key-art` (Higgsfield CLI).
  - Core, Rift Portal, 4 Turrets × 3 Tiers + clamp/hover mounts → `$create-modular-3d-assets` + `$blender-kit-pieces`.
  - 5 Rigged Invaders → `$create-rigged-character-assets`.
  - Tileable materials → `$create-tileable-pbr-materials`.
  - Every asset finishes with `$validate-generated-assets` before promotion to `public/assets/`.
- **Blender Authoring Rules (`~/.claude/guides/blender-mcp.md`, `blender-game-export.md`):**
  - Keep checked-in deterministic Python generators (`blender/`), separate high-poly and low-poly `.blend` sources under `assets-source/`, and unique staging folders.
  - Finalize low-poly topology, corner normals, UVs, and triangulation before baking; bake Cycles portable maps (`baseColor` sRGB, `emissive` sRGB, tangent `normal` linear neutral `(0.5, 0.5, 1.0)`, packed `ORM` linear R=AO / G=Roughness / B=Metallic; metallic base-color baked via temporary emission pass to prevent darkening).
  - Bind maps by exact role filename (never substring match). Re-import exported GLBs to assert node/mesh/bone/clip/triangle/material budgets and deterministic geometry/normal checks. Convert runtime textures to **KTX2 (UASTC)**.
  - **Spend boundary:** Stay strictly within the PRD pre-approved vertical-slice Higgsfield counts (3× retry headroom); **never** use Meshy.
  - **Owner creative sign-off:** Never self-approve aesthetics; batch renders + hashes into `docs/art-review-index.md` for Paul's approval before promoting to `public/assets/`.

---

## Tasks & Parallel Waves

### Wave 1 (Art Direction Gate — Must Approve Before 3D Batch)

#### `P3-T1`: Higgsfield Style-Reference Board, Concept Sheets & Art Bible
- **Dependencies:** `plans/phase-2-combat-simulation-and-waves.md` (`P2-T5` blockout dimensions)
- **Scope:**
  - Generate ~6 master style-reference board explorations via Higgsfield `cinematic_studio_2_5` establishing the Tactical Sci-Fi Hard-Surface Military palette (brushed titanium, matte tactical ceramic, carbon frame, high-contrast energy emissives: amber kinetic, molten orange plasma, cyan cryo-arc, cobalt-white rail, violet-teal dimensional rift, obsidian-chitin bio-mechanical invaders).
  - Generate 11 orthographic/three-quarter concept sheets aligned to the approved style board: Core Bastion, Dimensional Rift Portal, 4 Turrets (showing T1→T3 silhouette progression + clamp/hover mounts), and 5 Invaders.
  - Author `docs/art-bible.md` locking silhouette language, emissive color coding, PBR roughness/metallic ranges, and exact meter dimensions matching `src/render/blockouts.ts`.
  - Record full Higgsfield provenance, prompts, costs, and SHA-256 hashes under `assets-source/concepts/`.
- **Verification:** Automated provenance/hash check passes; **Owner Checkpoint:** Paul reviews and approves `docs/art-bible.md` and concept sheets before 3D modeling starts.

### Wave 2 (Parallel 2D Art & Shared PBR Materials after `P3-T1` Approval)

#### `P3-T2`: Higgsfield Tactical UI Icons & Title Key Art
- **Dependencies:** `P3-T1` (approved art bible)
- **Scope:**
  - Generate ~18 high-contrast tactical UI icons (4 turrets, T1/T2/T3 upgrade pips, target modes, relocate, sell, EMP disrupted, wave warning, star icons) via Higgsfield `nano_banana_pro` + `image_background_remover` for crisp RGBA cutouts.
  - Generate 2 Title / Launch key art banners (`16:9` desktop hero + square Quest launch card) via `cinematic_studio_2_5` (`$create-game-key-art`).
  - Pack UI icons into an atlas + generate KTX2/WebP runtime derivatives with provenance manifest.
- **Verification:** `$validate-generated-assets` passes alpha matte, resolution, crispness, and provenance checks; queued for owner visual review.

#### `P3-T3`: Blender Shared Tactical PBR Material Library & Validation Scripts
- **Dependencies:** `P3-T1` (approved art bible)
- **Scope:**
  - Build checked-in Blender material library (`blender/materials.py`) and export validator (`scripts/validate_glbs.py`) enforcing `blender-game-export.md` rules: positive-area coplanar overlap checks, planar normal deviation checks, neutral tangent-normal check, ORM R/G/B channel verification, sRGB base/emissive verification, triangle/material/bone budget checks, and KTX2 conversion (`toktx`).
  - Author reusable tileable PBR materials (brushed titanium, matte ceramic armor, dark gunmetal frame, bio-mechanical chitin, rift obsidian) via `$create-tileable-pbr-materials`.
- **Verification:** `scripts/validate_glbs.py` passes positive & negative mutation tests (rejects bad ORM channel, over-budget tris, coplanar overlap, missing UV0) and `make model-check` integrates cleanly into `Makefile`.

### Wave 3 (Blender 3D Production — Serial Workers per `blender-mcp.md`, Organized by Asset Family)

#### `P3-T4`: Core Bastion & Dimensional Rift Portal Kit Pieces (Blender)
- **Dependencies:** `P3-T3`
- **Scope:**
  - Author checked-in Blender 5.2.2 LTS generators for:
    1. **Core Bastion** (`≤14,000 tris`, 2048 px KTX2 ORM, articulated energy-core crystal + animated shield emitter ring + pedestal foot matching Calibration anchor footprint).
    2. **Dimensional Rift Portal Frame** (`≤4,500 tris`, 1024 px KTX2 ORM, flush wall/ceiling anchor bezel aligned to exact aperture plane so zero passthrough seam occurs at oblique angles, plus clean UV-mapped inner aperture mesh for the P4 parallax shader).
  - Generate fixed high-vs-low comparison renders (front, isometric, detail, underside) and export deterministic GLB + KTX2.
- **Verification:** `make model-check` + `$validate-generated-assets` pass all geometry, bake, and budget gates; added to `docs/art-review-index.md`.

#### `P3-T5`: 4 Tactical Turrets × 3 Upgrade Tiers + Clamp & Repulsor Hover Mounts (Blender)
- **Dependencies:** `P3-T3`
- **Scope:**
  - Author checked-in Blender generators (separate high/low `.blend` + Cycles ORM bakes + LOD0 `≤6,500 tris` / LOD1 `≤2,500 tris`, ≤2 materials, 1024 px KTX2) for all 4 turrets with clean hierarchical yaw-ring / pitch-cradle / muzzle-socket nodes so runtime tracking and recoil animate directly:
    1. **M44 Autocannon** (T1 single barrel, T2 twin linked, T3 rotary gatling + thermal vents).
    2. **Helios Plasma Mortar** (T1 single tube, T2 dual chamber, T3 heavy siege emitter).
    3. **Glacier Cryo-Arc** (T1 single coil, T2 dual arcing prongs, T3 tri-pylon cryo conduit).
    4. **Valkyrie Rail Sniper** (T1 compact rail, T2 extended capacitor rails, T3 twin accelerator).
  - Author shared modular **Surface Clamp Base** (conforms to floor/table/wall normal) and **Repulsor Hover-Ring Pod** (subtle emissive thruster ring for mid-air mode) socketed cleanly onto every turret root.
- **Verification:** Every turret + tier + mount passes `make model-check`, silhouette/normal/ORM checks, and high-vs-low render comparisons; added to `docs/art-review-index.md`.

#### `P3-T6`: 5 Rigged & Animated Bio-Mechanical Invaders (Blender)
- **Dependencies:** `P3-T3`
- **Scope:**
  - Author checked-in Blender generators + armatures + skin weights + animation clips (`$create-rigged-character-assets`, Cycles ORM bakes, KTX2) for all 5 invaders:
    1. **Skitter Crawler** (`≤4,500 tris`, `≤24 bones`): `crawl_floor`, `climb_wall`, `attack`, `hit`, `death`.
    2. **Wasp Skimmer** (`≤6,500 tris`, `≤24 bones`): `hover_fly`, `bank_turn`, `attack`, `hit`, `death`.
    3. **Carapace Brute** (`≤9,000 tris`, `≤28 bones`): `stomp_walk`, `armor_brace`, `attack`, `hit`, `death`.
    4. **Rift Disruptor** (`≤6,500 tris`, `≤24 bones`): `hover_glide`, `emp_pulse`, `hit`, `death`.
    5. **Apex Broodlord Boss** (`≤28,000 tris`, `≤48 bones`, 2048 px KTX2, uniform-driven Phase-2 armor-crack emissive mask): `boss_march`, `spawn_adds`, `emp_roar`, `phase2_shift`, `hit`, `death`.
  - Generate motion-turntable/keyframe evidence renders for every clip.
- **Verification:** Every rigged GLB passes bone-count, triangle, skin-weight normalization, clip playback, and `$validate-generated-assets` checks; batch compiled in `docs/art-review-index.md` for **Owner Creative Approval Checkpoint** before P4 runtime promotion.

---

## Phase 3 Exit Criteria

- `docs/art-bible.md` and `docs/art-review-index.md` contain every asset's hash, budget metrics, high/low renders, and motion evidence.
- Every 2D and 3D asset passes `make model-check` and `$validate-generated-assets`.
- Paul approves the vertical-slice asset batch for runtime promotion into `public/assets/`.
