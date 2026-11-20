# Emulated XR Harness (IWER)

> **Emulator Evidence Only:** Results from `scripts/xr-emu/` are strictly **emulator evidence**.
> Meta's [IWER](https://github.com/meta-quest/immersive-web-emulation-runtime) (`iwer`, pinned in
> `devDependencies`) renders stereo into the page canvas inside headless Chromium and does **not**
> apply physical Quest 3 compositor fixed foveation, framebuffer scaling, room tracking, or optical
> comfort. Physical Meta Quest 3 headset acceptance criteria always remain separate.

## What It Proves

- Desktop launch overlay, Settings persistence (`Show FPS`, `Play Arc`, `Room Occlusion`), and `?perf` badge readout with zero console/page errors.
- `immersive-ar` session request mode and `optionalFeatures` (`plane-detection`, `mesh-detection`, `depth-sensing`, `anchors`, `local-floor` + `depthSensing` init).
- `XRWebGLLayer` initialization (`framebufferScaleFactor === 1.15`) and per-frame `fixedFoveation` re-assertion (`0.5`).
- Seated (`1.2 m`) head pose propagation, passthrough presentation (virtual test room and DOM overlay hidden), and clean session exit.
- Real production build `A -> B` upgrade behavior via `scripts/check-build-upgrade.ts` (desktop auto-reload vs. XR HUD `Update: Reload` with rollback and exit-failure retry).

## Commands

```sh
# Build isolated dist-iwer bundle and run the P0 emulated XR walk on native Metal GPU
make xr-emu

# Optional flags for walk.mjs
bun scripts/xr-emu/walk.mjs --out output/xr-emu/p0 --port 4273
bun scripts/xr-emu/walk.mjs --headed

# Real served production build A -> B upgrade check (desktop + XR HUD Reload)
bun scripts/check-build-upgrade.ts

# Software WebGL override (ONLY for GPU-less hosts; never the default)
PW_GPU=swiftshader make xr-emu
```

## GPU Guard (`e2e/gpu-args.ts`)

Both `walk.mjs` and `check-build-upgrade.ts` import `e2e/gpu-args.ts`, launch Chromium with
`channel: 'chromium'` and `--use-angle=metal --enable-gpu --ignore-gpu-blocklist` on macOS, log
`UNMASKED_RENDERER_WEBGL`, and throw immediately if SwiftShader appears without `PW_GPU=swiftshader`.

## How `page-hooks.js` Works

`page-hooks.js` is injected via `context.addInitScript` immediately after
`node_modules/iwer/build/iwer.min.js` before any app scripts run:

1. Instantiates `new XRDevice(metaQuest3, { stereoEnabled: true }).installRuntime({ forceInstall: true })` so desktop Chromium's native `navigator.xr` does not win.
2. Attaches `window.__THREE_DEVTOOLS__ = new EventTarget()` to capture Three.js renderers and scenes without mutating app code.
3. Wraps `navigator.xr.requestSession` to record session mode, `optionalFeatures`, and end events.
4. Subclasses `XRWebGLLayer` (and wraps `XRWebGLBinding.prototype.createProjectionLayer`) to capture `framebufferScaleFactor` and define a `fixedFoveation` getter/setter so Three.js writes are observable.
5. Exposes `window.__xrEmu.frames(n)` backed by `session.requestAnimationFrame` for deterministic frame-synchronized assertions after pose writes.

## Outputs

Reports and screenshots are written to `output/xr-emu/p0/` (`report.json` and `01-*.jpg`..`05-*.jpg`).
`output/` is gitignored; never commit emulator screenshots or reports.
