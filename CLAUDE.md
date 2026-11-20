# Rift Bastion (`tower-defense-xr`)

Room-scale WebXR mixed-reality tactical sci-fi tower defense for Meta Quest 3 (seated or standing, Touch controllers) with full desktop browser parity.

## Authority & Planning

- Product requirements: `PRD.md`
- Phase plans: `plans/phase-0-foundation-and-deploy.md` through `plans/phase-5-quest3-tuning-and-release.md`
- Music prompt pack: `suno-music-prompt.md`
- Guides: `~/.claude/guides/webxr.md`, `node-typescript.md`, `game-assets.md`, `blender-mcp.md`, `blender-game-export.md`, `suno.md`, `greenfield.md`, `git-ci.md`

## Stack & Ports

- `three` `0.186.1` (WebGL2, raw `WebXRManager`), `@par/xr-workspace` (`file:../mux-xr/packages/xr-workspace`, pinned SHA in `toolkit-release.json`), `troika-three-text` `0.52.5` (`configureTextBuilder({ useWorker: false })` with local staged fonts).
- `bun` `1.4.4`, `vite` `8.3.5`, `typescript` `7.0.2` (strict), `@biomejs/biome` `2.5.15`, `vitest` `5.0.3`, `playwright` `1.63.0`, `iwer` `2.8.0`.
- Pure TypeScript simulation under `src/sim/` and `src/nav/` (zero Three.js or WASM dependencies).
- Reserved ports (`~/.claude/used_ports.md`): `4272` (dev + Quest USB/LAN preview), `4273` (production preview + isolated browser verification).

## Verification Gates

- Fast gate: `make checkall` (`lint` + `typecheck` + `test` + `build`)
- CI-parity gate: `make checkall-ci` (`checkall` + `gitleaks`)
- Pre-commit: `make pre-commit`
- Local GPU Playwright + IWER emulated XR: `make xr-emu` (always on local Metal GPU, never SwiftShader by default)
- Quest 3 USB perf retrieval: `make quest-perf`

## Non-Negotiables

- Hand tracking is out of scope; Touch controllers only.
- Target 72 Hz / hard ≥50 delivered FPS floor in every complete 1-second active gameplay bin on physical Quest 3.
- Framebuffer scale applied at XR layer creation; fixed foveation `0.5` re-asserted every frame; shaders precompiled behind load veil; `createImageBitmap` off-thread decode.
- All 3D models/rigs/animations go through Blender 5.2.2 LTS (never Meshy). Immutable sources stay under `assets-source/`; promote to `public/assets/` only after `$validate-generated-assets` and owner approval.
