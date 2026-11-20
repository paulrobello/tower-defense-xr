# Rift Bastion (`tower-defense-xr`)

Room-scale WebXR mixed-reality tactical sci-fi tower defense for Meta Quest 3 (seated or standing, Touch controllers) with full desktop browser parity.

## Planning Artifacts

- **Product Requirements:** [PRD.md](PRD.md)
- **Phase Plans:**
  - [Phase 0 — Foundation & Deploy Pipeline](plans/phase-0-foundation-and-deploy.md)
  - [Phase 1 — Room-Scale MR, Occlusion & Hybrid Placement](plans/phase-1-room-mr-and-placement.md)
  - [Phase 2 — Combat Simulation, Navigation & 12-Wave Slice](plans/phase-2-combat-simulation-and-waves.md)
  - [Phase 3 — Art Direction & Blender AAA Asset Production](plans/phase-3-art-direction-and-blender-assets.md)
  - [Phase 4 — AAA Rendering, FX & Spatial Audio](plans/phase-4-aaa-rendering-fx-and-audio.md)
  - [Phase 5 — Quest 3 Tuning, Verification & Release](plans/phase-5-quest3-tuning-and-release.md)
- **Music Prompts (Suno v6):** [suno-music-prompt.md](suno-music-prompt.md)

## Status

| Phase | Status |
| --- | --- |
| P0 — Foundation & Deploy Pipeline | Local complete (`P0-T1`–`P0-T5` done; `P0-T6` CI ready, awaiting push/DNS approval) |
| P1 — Room-Scale MR, Occlusion & Hybrid Placement | Complete (verified via unit tests + 19/19 seated/standing IWER XR walk; physical Quest check in P5) |
| P2 — Combat Simulation, Navigation & 12-Wave Slice | Complete (218 unit tests + 12/12 desktop campaign + 8/8 IWER combat walk passing) |
| P3 — Art Direction & Blender AAA Asset Production | Ready to start (`P3-T1` Higgsfield style board & art bible next) |
| P4 — AAA Rendering, FX & Spatial Audio | Planned (`P4-T4` ElevenLabs SFX unblocked; includes `P4-T6` radial menu re-skin) |
| P5 — Quest 3 Tuning, Verification & Release | Planned |

*Development ports `4272` (dev) and `4273` (preview) are reserved in `~/.claude/used_ports.md`. Deployment target: `https://rift-bastion.pardev.net/`.*
