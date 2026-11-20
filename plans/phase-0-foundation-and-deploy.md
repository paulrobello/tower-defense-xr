# Phase 0 — Foundation & Deploy Pipeline

> **PRD Reference:** `PRD.md` §Phases (P0)  
> **Goal:** Establish a clean, pinned, verifiable WebXR MR + Desktop TypeScript repository with `@par/xr-workspace` asset staging, mandatory pre-commit/Gitleaks hygiene, Settings page, `?perf` 1-second frame recorder, new-version Reload notice, CI workflow, and live GitHub Pages deployment at `https://rift-bastion.pardev.net/`.

---

## Pinned Dependency Baseline (to install in P0-T1)

| Package | Exact Version | Role |
| --- | --- | --- |
| `three` | `0.186.1` | WebGL2 + raw `WebXRManager` renderer (peer of `@par/xr-workspace`) |
| `@par/xr-workspace` | `file:../mux-xr/packages/xr-workspace` | Shared XR session, radial menu, panels, perf gauge, SDF labels (`toolkit-release.json` pinned to `paulrobello/mux-xr` SHA `9e2bd1817e2ec5e1b7ef2b318963b07c21305281`) |
| `troika-three-text` | `0.52.5` | Local-font SDF text (`configureTextBuilder({ useWorker: false })`) |
| `bun` | `1.4.4` | Package manager & script runner (`packageManager: "bun@1.4.4"`) |
| `vite` | `8.3.5` | Dev server (`4272`), production bundler, preview (`4273`), `--mode iwer` isolated build |
| `typescript` | `7.0.2` | Strict typechecking (`tsc --noEmit`) |
| `@biomejs/biome` | `2.5.15` | Linting and formatting (`biome check --error-on-warnings .`) |
| `vitest` | `5.0.3` | Unit & simulation test runner |
| `happy-dom` | `21.0.4` | DOM test environment |
| `fake-indexeddb` | `6.2.8` | Deterministic IndexedDB persistence tests |
| `playwright` | `1.63.0` | Local GPU browser & IWER emulated XR verification |
| `iwer` | `2.8.0` | Meta Quest 3 WebXR runtime emulation (dev-only; gated out of prod) |
| `@types/three` | `0.186.0` | Three.js types |
| `@types/webxr` | `0.5.24` | WebXR + `XRPlane` / `XRMesh` / `XRDepthInformation` types |
| `@types/node` | `26.6.4` | Build/tooling script types |

---

## Tasks & Parallel Waves

### Wave 1 (Independent Bootstrap)

#### `P0-T1`: Repo Scaffold, Pinned Toolchain, Makefile & Pre-Commit Gate
- **Dependencies:** None
- **Scope:**
  - Create `package.json`, `tsconfig.json` (strict), `biome.json`, `vite.config.ts`, `vitest.config.ts`, `toolkit-release.json` (pinning `paulrobello/mux-xr` at `9e2bd1817e2ec5e1b7ef2b318963b07c21305281`), `CLAUDE.md`, `.gitignore`, and `.pre-commit-config.yaml` (`gitleaks` + `detect-private-key` + local lint/typecheck hooks).
  - Create `scripts/prepare-assets.ts` invoking `@par/xr-workspace/stage-assets` so bundled fonts and workspace assets stage cleanly into `public/` before `dev` and `build` (never committing generated staged copies).
  - Create `Makefile` with all standard house targets (`build`, `test`, `lint`, `fmt`, `typecheck`, `checkall`, `checkall-ci`, `pre-commit`, `dev`, `dev-start`, `dev-stop`, `dev-restart`, `preview`, `xr-emu`, `quest-perf`). Ensure `dev-stop`/`dev-restart` resolves port `4272` via `lsof` and polls until free (bounded 2 s + `SIGKILL` escalation per `greenfield.md`).
  - Configure `dev` on port `4272` (`--host 0.0.0.0 --strictPort`) and `preview` on port `4273`.
  - Install `pre-commit` hooks and verify clean `bun install`.
- **Verification:** `make checkall && make checkall-ci && make pre-commit` all exit 0; `make dev-start && make dev-restart && make dev-stop` cleanly bind and release port `4272`.

### Wave 2 (Parallel after `P0-T1`)

#### `P0-T2`: Core Entry Shell (WebXR MR + Desktop Test Room) & Action Bus
- **Dependencies:** `P0-T1`
- **Scope:**
  - Create `src/core/` (seeded PRNG with named streams, top-level game state machine stub `title → calibrate → prep → wave → intermission → victory | defeat`, typed action bus shared by desktop and XR).
  - Create `src/xr/session.ts` wrapping `@par/xr-workspace`'s `createXrSession` for `immersive-ar` (`optionalFeatures: ['plane-detection', 'mesh-detection', 'depth-sensing', 'anchors', 'local-floor']`), framebuffer scale applied at layer creation (`1.15` default, configurable via settings/URL), fixed foveation (`0.5` default) re-asserted every frame, and `session.updateTargetFrameRate(72)` with negotiated-rate readback.
  - Create `src/desktop/bootstrap.ts` rendering a stylized dark tactical test room on desktop with orbit/aim camera and explicit **Enter Mixed Reality (Quest 3)**, **Play Desktop**, and **Settings** controls (single shared XR entry request, clearable errors, no duplicate session requests per `webxr.md`).
  - Configure `troika-three-text` with `configureTextBuilder({ useWorker: false })` and local fonts.
- **Verification:** `make checkall` passes; unit tests cover seeded PRNG determinism, state transitions, and XR entry error/dedup handling; desktop app boots cleanly on `4272`.

#### `P0-T3`: Settings Panel, Device-Local Prefs Stub & `?perf` 1-Second Frame Recorder
- **Dependencies:** `P0-T1`
- **Scope:**
  - Implement launch-screen and in-XR **Settings** view backed by a versioned preferences store (`Show FPS` default off, `Fixed Foveation` Off/0.5/1.0, `Framebuffer Scale` 1.0/1.1/1.15/1.2 with "takes effect on XR re-entry" notice, `Play Arc` Front 180° / Full 360°, `Room Occlusion` Auto Depth / Room Mesh / Off, `Quality Tier` Balanced / Max Beauty / High FPS, Master/Music/SFX volumes).
  - Implement `src/perf/recorder.ts` per `webxr.md`: contiguous 1-second monotonic buckets, separate partial vs complete seconds, segment reset on visibility loss / XR entry-exit, lowest-complete-second floor tracking (`50 fps`), event markers, bounded local trace ring buffer + JSON export, and `createPerfGaugeWidget` HUD toggle (`Show FPS` or `?perf`).
  - Add `scripts/perf-quest.ts` (following `audio-probe-xr` / `portal-xr`) for one-shot USB/CDP retrieval of stored perf recordings and `VrApi` snapshot parsing.
- **Verification:** `vitest` verifies 1 s bucket accounting (known cadence, visible stall, hidden interval pause/resume, JSON export/reload) and settings persistence across reload; `make checkall` green.

#### `P0-T4`: Production New-Version Reload Notice & Build Stamping
- **Dependencies:** `P0-T1`
- **Scope:**
  - Add Vite build-time plugin / script stamping a deterministic content hash into `window.__APP_BUILD` and emitting same-origin `version.json` (`{"id": "<hex>"}`) covering runtime bundles, package version, and `public/` assets (`webxr.md`, `node-typescript.md`).
  - Implement `src/ui/version-check.ts`: immediate check + 30 s interval (shortenable via `?version-poll=<sec>` min `1`), 5 s request+body timeout, non-overlapping cache-bypassing fetches (`cache: "no-store"`), silent failure retaining existing notice, rollback clear, disposal on teardown.
  - Desktop behavior: auto-reload on detected newer build (or explicit Reload notice when unsaved/in-wave state exists). Immersive XR behavior: **never auto-reload** — show compact `Update: Reload` control on the movable XR HUD (rendered in overlay pass via `keepAbove`) that awaits `session.end()` (10 s timeout) before cache-busting navigation.
- **Verification:** Unit tests with fake clock + fetch pass every edge case (same id, newer id once, error/offline silent, rollback clears, throttle/in-flight skip, dev mode skip); `make checkall` green.

### Wave 3 (Parallel after Wave 2)

#### `P0-T5`: Shared GPU Playwright + IWER Emulated XR Harness
- **Dependencies:** `P0-T2`, `P0-T3`, `P0-T4`
- **Scope:**
  - Create shared GPU args & guard module (`e2e/gpu-args.ts` exporting `GPU_ARGS`, `probeGpu`, `gpuProblems`) plus Playwright `globalSetup` asserting native Metal GPU (`UNMASKED_RENDERER_WEBGL`, failing on SwiftShader unless `PW_GPU=swiftshader`).
  - Create isolated `--mode iwer` Vite build and `scripts/xr-emu/` (following `rogue-xr`: `iwer` 2.8.0 `new XRDevice(metaQuest3, { stereoEnabled: true }).installRuntime({ forceInstall: true })`, `__THREE_DEVTOOLS__` hook, `XRWebGLLayer` subclass recording framebuffer scale and `fixedFoveation`, frame-synchronized `frames(n)` helper).
  - Write P0 smoke specs: desktop boot + Settings toggle + `?perf` readout, IWER `immersive-ar` entry + foveation/scale capture, and real served production build A→B version-update check (both desktop and XR HUD Reload paths).
- **Verification:** `make xr-emu` passes on local GPU (logging `UNMASKED_RENDERER_WEBGL`); screenshots and JSON report saved under `output/xr-emu/`.

#### `P0-T6`: GitHub Actions CI & GitHub Pages Deploy (`rift-bastion.pardev.net`)
- **Dependencies:** `P0-T1`, `P0-T4`
- **Scope:**
  - Add `.github/workflows/ci.yml`: checks out `paulrobello/mux-xr` at the SHA pinned in `toolkit-release.json` as `../mux-xr`, installs bun `1.4.4`, runs `make checkall-ci` (Biome, strict `tsc`, Vitest, production build, Gitleaks), and deploys `dist/` to GitHub Pages on `main`.
  - Follow the house `*.pardev.net` recipe (`reference-projects.md`) strictly in order:
    1. Create DNS-only CNAME `rift-bastion.pardev.net → paulrobello.github.io` in Cloudflare (`pardev.net` zone).
    2. Commit `public/CNAME` containing `rift-bastion.pardev.net` **only after** DNS resolves.
    3. Explicitly register custom domain via `PUT /repos/paulrobello/tower-defense-xr/pages`.
    4. Verify live browser render (not merely HTTP 200) over HTTPS once Let's Encrypt cert issues.
- **Verification:** GitHub Actions CI green on `main`; live Playwright/agentchrome render confirms `https://rift-bastion.pardev.net/` loads with zero console/CSP errors and valid `version.json`.

---

## Phase 0 Exit Criteria

- `make checkall` and `make checkall-ci` pass locally and in CI.
- `make xr-emu` passes on local Metal GPU proving `immersive-ar` entry, layer framebuffer scale, foveation write, Settings persistence, `?perf` recorder, and build A→B Reload notice.
- `https://rift-bastion.pardev.net/` renders live in a real browser with valid HTTPS.
