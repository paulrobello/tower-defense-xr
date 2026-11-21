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
| P0 — Foundation & Deploy Pipeline | Complete. GitHub Actions and Pages passed, with HTTPS live. |
| P1 — Room-Scale MR, Occlusion & Hybrid Placement | Complete (verified via unit tests + 19/19 seated/standing IWER XR walk; physical Quest check in P5) |
| P2 — Combat Simulation, Navigation & 12-Wave Slice | Complete (218 unit tests + 12/12 desktop campaign + 8/8 IWER combat walk passing) |
| P3 — Art Direction & Blender AAA Asset Production | Art direction approved. UI art, shared materials, Core, Rift frame and both mounts are staged. |
| P4 — AAA Rendering, FX & Spatial Audio | Sound effects approved. The radial theme passed private IWER verification and awaits asset promotion. |
| P5 — Quest 3 Tuning, Verification & Release | Planned |

[Play the current test build](https://rift-bastion.pardev.net/). The final art and sound packages are staged for a later runtime release.

Development uses port `4272` for dev and `4273` for preview.
