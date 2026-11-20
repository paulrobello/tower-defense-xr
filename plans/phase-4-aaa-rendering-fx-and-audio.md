# Phase 4 — AAA Rendering, FX & Spatial Audio

> **PRD Reference:** `PRD.md` §Phases (P4), §Quest 3 Budgets, `suno-music-prompt.md`  
> **Depends On:** [`plans/phase-3-art-direction-and-blender-assets.md`](phase-3-art-direction-and-blender-assets.md) (approved assets), [`plans/phase-2-combat-simulation-and-waves.md`](phase-2-combat-simulation-and-waves.md) (combat sim)  
> **Goal:** Promote the approved Blender GLB/KTX2 assets and Higgsfield icons into the live Three.js WebGL2 engine, layer AAA lighting, dimensional rift shaders, GPU-instanced combat VFX, shader precompilation, off-thread asset streaming, ~28 spatialized ElevenLabs SFX, and mastered Suno music with `audition.html` verification.

---

## Tasks & Parallel Waves

### Wave 1 (Parallel Runtime Asset Pipeline, Lighting & Audio Generation)

#### `P4-T1`: Runtime GLB/KTX2 Asset Promotion, Off-Thread Streaming & Shader Precompilation Veil
- **Dependencies:** `plans/phase-3-art-direction-and-blender-assets.md` (`P3-T2`, `P3-T4`, `P3-T5`, `P3-T6` owner-approved)
- **Scope:**
  - Promote validated KTX2 GLBs, UI icon atlas, and key art from `assets-source/` to `public/assets/` with a checked-in runtime asset manifest (`public/assets/manifest.json`) verified against SHA-256 hashes.
  - Implement `src/render/asset-loader.ts` using `KTX2Loader` + `GLTFLoader` + `createImageBitmap` off-thread decoding and spread-frame GPU uploads (`≤2` texture/buffer uploads per frame per `webxr.md`).
  - Replace P2 blockout meshes with final articulated turrets (yaw/pitch tracking, recoil kick, T1→T3 tier swaps, clamp vs repulsor hover-ring attachment, LOD0/LOD1 swap at `4 m`) and skinned/animated enemies (`AnimationMixer` driven by sim state, LOD + animation update throttling >`6 m`).
  - Implement a clean load veil that runs `renderer.compileAsync` across every turret, enemy, portal, shadow-catcher, occlusion, and FX shader variant before Wave 1 begins (zero mid-combat shader compilation hitches).
- **Verification:** Automated test verifies manifest hash integrity, zero missing bone/muzzle sockets, and zero new WebGL program links after load-veil dismissal; `make checkall` passes.

#### `P4-T2`: AAA Lighting, Procedural IBL, Shadow-Catcher Tuning & Dimensional Rift Shader
- **Dependencies:** `P4-T1`, `plans/phase-1-room-mr-and-placement.md` (`P1-T2`)
- **Scope:**
  - Build `src/render/lighting.ts`: generate a crisp tactical procedural `PMREMGenerator` environment map (so brushed titanium and ceramic PBR metallic/roughness surfaces pop vividly in passthrough MR without heavy HDR downloads), 1 directional key light casting a tuned `1024×1024` PCF shadow map onto Core, turrets, enemies, and real-room shadow-catchers, plus a pool of `≤2` transient dynamic point lights for Plasma explosions and Broodlord pulses.
  - Build `src/render/portal-shader.ts`: custom GLSL raw/injected shader rendering swirling multi-layer violet/teal dimensional rift parallax depth inside each wall/ceiling portal aperture, rim energy distortion, spawn surge pulse, and clean aperture-mask integration with WebXR Depth Sensing + Room-Mesh occlusion.
  - Tune Boss Phase-2 armor-crack emissive uniform, Cryo-Arc frost shader tint uniform, and Disruptor EMP flicker uniform (all uniform-driven — zero runtime defines/recompiles).
- **Verification:** Visual GPU Playwright capture verifies metallic/ceramic reflections, floor/table shadow catchers, oblique-angle portal parallax with zero passthrough seam, and draw-call count `≤200` (both eyes); `make checkall` passes.

#### `P4-T3`: GPU-Instanced Combat VFX & Particle Pools
- **Dependencies:** `P4-T1`
- **Scope:**
  - Implement `src/render/vfx-pool.ts` with pre-allocated zero-GC ring buffers across `InstancedMesh` batches (`≤2,500` active particles/tracers total):
    - **Autocannon:** Rapid amber kinetic tracer bolts, muzzle flash starbursts, shell-casing flicks, metallic spark impacts.
    - **Plasma Mortar:** Glowing molten shell arc, expanding plasma shockwave ring, lingering ember/burn decals on floors/tables.
    - **Cryo-Arc:** Procedural jagged cyan chain-lightning ribbons jumping turret → primary → chained enemies + ice-crystal shatter bursts.
    - **Rail Sniper:** Razor-sharp cobalt/white hypervelocity beam with fading ionized smoke ring + armor-pierce exit flash.
    - **Invaders & Core:** Chitin/ichor hit bursts, death dissolution/debris chunks, Disruptor EMP dome pulse, Core Bastion hex-shield ripple on impact.
- **Verification:** Unit test proves zero runtime heap/geometry allocations in steady-state `tick()`, strict `≤2,500` cap enforcement, and clean disposal; GPU Playwright stress capture verifies draw-call overhead stays `≤12` extra draws for full Wave 12 VFX; `make checkall` passes.

#### `P4-T4`: ElevenLabs Spatial SFX Production (~28 Cues) & `audition.html`
- **Dependencies:** `plans/phase-2-combat-simulation-and-waves.md` (`P2-T4`)
- **Scope:**
  - Execute `$create-game-audio-assets` → `$elevenlabs` (`eleven_text_to_sound_v2`) within the PRD pre-approved spend boundary (~28 SFX cues with 3× retry headroom):
    - Turrets (10): Autocannon burst + impact, Plasma launch + detonation, Cryo-Arc charge + chain zap, Rail charge + hypervelocity crack, turret rotate servo, tier upgrade power-up.
    - Placement & UI (6): Surface clamp lock, hover-pod repulsor hum/deploy, invalid buzz, relocate teleport, sell chime, radial tick/confirm.
    - Portals & Enemies (8): Rift tear open, rift ambient loop (`--loop`), Skitter hiss/death, Wasp buzz/pop, Brute stomp/armor clang, Disruptor EMP discharge, Broodlord roar, Boss death collapse.
    - Core & Waves (4): Wave incoming horn, Core shield hit, Core critical alarm, Victory/Defeat UI confirm.
  - Preserve immutable raw files under `assets-source/audio/sfx/raw/` with sidecar prompts/parameters/hashes; trim/pad deterministically with FFmpeg, encode Opus (`.ogg` with `+bitexact`) + MP3 fallback (`Lavc` header intact), verify LUFS/true-peak/silence/mono-mix (`0.5L + 0.5R`).
  - Build dedicated `audition.html` (following `portal-xr` / `rogue-xr`) allowing side-by-side playback, loudness/duration inspection, and Quest speaker auditioning of every SFX and music cue.
- **Verification:** `$validate-generated-assets` audio predicate suite passes (including negative mutation checks for clipping, silence, wrong hash, phase cancellation); **Owner Checkpoint:** Paul auditions and approves SFX takes on `audition.html`.

### Wave 2 (Audio Integration & Music Mastering after `P4-T4` + Owner Suno WAVs)

#### `P4-T5`: Suno Music Mastering & Spatial Web Audio Bus Integration
- **Dependencies:** `P4-T1`, `P4-T4`, owner-supplied Suno WAVs from [`suno-music-prompt.md`](../suno-music-prompt.md)
- **Scope:**
  - Archive Paul's downloaded Suno WAVs untouched under `assets-source/audio/music/raw/` with complete `provenance.json` (song ID, link, date, model `v6`, plan at generation, SHA-256).
  - Master the 6 loops (`Tactical Command Deck`, `Perimeter Scan`, `First Contact`, `Breach Protocol`, `Perimeter Overload`, `Broodlord Siege`) and 2 stingers (`Sector Secured`, `Bastion Lost`) per `~/.claude/guides/suno.md`: `-16 LUFS ±1`, `≤-1.0 dBTP`, `48 kHz` stereo, `≤2 MiB` runtime file, true post-intro crossfade loop wrap, Opus (`.ogg` `+bitexact`) + MP3 (`Lavc` gapless header).
  - Implement `src/audio/engine.ts`: Web Audio API spatial `PannerNode` (HRTF/equalpower tunable) synced to Three.js listener pose, strict voice-pool caps per cue family (preventing Quest speaker clipping during 14-turret volleys), priority ducking (Core alarm & Boss roar duck ambient/turret bed slightly), seamless bar-aligned or smooth crossfade music transitions driven by game state/wave, gesture unlock, focus/visibility pause-resume, independent Music/SFX volume/mute controls, and full cleanup on reset/exit.
- **Verification:** Automated audio validator verifies post-encode LUFS, peak, gapless loop seam, and `0.5L + 0.5R` mono compatibility; Playwright browser audio test verifies gesture unlock, bounded voice count, mute/volume persistence, and clean missing-file resilience; `make checkall` passes.

#### `P4-T6`: Tactical Sci-Fi Radial Menu Re-Skin (`RadialMenuTheme` + Higgsfield Icon Badges)
- **Dependencies:** `plans/phase-1-room-mr-and-placement.md` (`P1-T5`), `plans/phase-3-art-direction-and-blender-assets.md` (`P3-T2` approved Higgsfield UI icons)
- **Scope:**
  - Opt the `@par/xr-workspace` Build Wheel and Turret Command Wheel (`src/xr/radial-controls.ts`) into a bespoke **Rift Bastion Tactical Sci-Fi** `RadialMenuTheme` matching `docs/art-bible.md` (gunmetal/brushed-titanium wedge backing, subtle chamfered bezel ring, high-contrast cyan hover / amber affordability / crimson disabled states, crisp Troika SDF cost badges, and promoted Higgsfield RGBA turret & command icon decals on each wedge).
  - Preserve 100% of `@par/xr-workspace`'s input convention (thumbstick open/tilt/laser/trigger selection, grip suppression, hit areas without coplanar depth fighting per `webxr.md`).
  - Keep desktop quick-build bar / command strip visually harmonized with the same palette and icon atlas.
- **Verification:** GPU Playwright + IWER capture verifies Build Wheel and Turret Command Wheel readability at working distance and oblique angles with zero z-fighting, intact hit areas, and `make checkall && make checkall-ci` green.

---

## Phase 4 Exit Criteria

- Full AAA visual + audio vertical slice runs cleanly on desktop and in IWER emulated XR with promoted Blender GLBs, KTX2 textures, procedural IBL, shadow catchers, rift shaders, GPU-instanced VFX, ~28 approved ElevenLabs spatial SFX, and mastered Suno soundtrack.
- `audition.html` verified and signed off by Paul; zero mid-combat shader compilation stalls; `make checkall && make checkall-ci` green.
