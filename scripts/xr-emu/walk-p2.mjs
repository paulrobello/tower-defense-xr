#!/usr/bin/env bun
// Emulated-XR P2 combat verification walk (`scripts/xr-emu/walk-p2.mjs`):
// Serves the isolated `dist-iwer` bundle on a free port (`0`), launches headless Chromium on the
// real Metal GPU via `e2e/gpu-args.ts`, injects Meta's IWER Quest 3 runtime + `page-hooks.js`,
// opens `/?debug&seed=4242`, enters `immersive-ar` at seated `1.2 m` (`front-180` Play Arc), and
// verifies:
// 1. Locks Core, builds an `autocannon` (`surface-clamp`) and a `rail-sniper` (`hover-pod`) via
//    the live controllers / radial build wheel / trigger action flow.
// 2. Launches Wave 1, advances XR frames until enemy kill + credit gain occur, and verifies
//    off-FOV directional threat chevron state activates on portal open / near-Core enemy.
// 3. Triggers Wave 12 Apex Broodlord Boss via `?debug` (`debugJumpToWave(12)` + `debugSpawnBoss`),
//    asserts Boss blockout renders cleanly, checks render-pass order and `draws <= 200` /
//    `zero console errors`, and writes an emulator-evidence JSON report + screenshots to
//    `output/xr-emu/p2/`.
//
// Emulator evidence only: physical Meta Quest 3 headset acceptance remains separate.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { assertRealGpu, getGpuLaunchOptions, probeGpu } from '../../e2e/gpu-args.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

const { values: opts } = parseArgs({
  options: {
    dist: { type: 'string', default: join(root, 'dist-iwer') },
    out: { type: 'string', default: join(root, 'output/xr-emu/p2') },
    port: { type: 'string', default: '0' },
    headed: { type: 'boolean', default: false },
  },
});

const SEATED_HEAD_Y = 1.2;
const MAX_QUEST3_DRAW_CALLS = 200;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

const distDir = resolve(opts.dist);
if (!existsSync(join(distDir, 'index.html'))) {
  throw new Error(
    `Missing isolated IWER build at ${distDir}. Run "make iwer-build" (or "bun run iwer-build") first.`,
  );
}

function listenOnPreferredOrFreePort(server, preferredPort) {
  return new Promise((resolvePort, reject) => {
    const tryListen = (port, allowFallback) => {
      const onError = (err) => {
        server.off('listening', onListening);
        if (allowFallback && err && err.code === 'EADDRINUSE') {
          tryListen(0, false);
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        const addr = server.address();
        resolvePort(typeof addr === 'object' && addr ? addr.port : port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    };
    tryListen(preferredPort, preferredPort !== 0);
  });
}

function startStaticServer(directory, preferredPort) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = resolve(directory, relativePath);
    if (filePath !== directory && !filePath.startsWith(`${directory}${sep}`)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      if (pathname === '/favicon.ico') {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const mime = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-store',
    });
    res.end(readFileSync(filePath));
  });

  return listenOnPreferredOrFreePort(server, preferredPort).then((port) => ({
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolveClose) => {
        server.close(() => resolveClose());
      }),
  }));
}

const checks = [];
const screenshots = [];
const consoleErrors = [];
const failedRequests = [];

const record = (id, pass, detail = {}) => {
  checks.push({ id, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id}`, JSON.stringify(detail));
};

const outDir = resolve(opts.out);
mkdirSync(outDir, { recursive: true });

const iwerUmd = readFileSync(join(root, 'node_modules/iwer/build/iwer.min.js'), 'utf8');
const pageHooks = readFileSync(join(here, 'page-hooks.js'), 'utf8');

const preferredPort = Number.parseInt(opts.port, 10);
const staticServer = await startStaticServer(
  distDir,
  Number.isFinite(preferredPort) ? preferredPort : 0,
);
console.log(`Serving ${distDir} at ${staticServer.baseUrl}`);

const browser = await chromium.launch(getGpuLaunchOptions({ headless: !opts.headed }));
let gpu = null;
let buildId = null;
let xrCombatCapture = null;

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript({ content: `${iwerUmd}\n${pageHooks}` });
  const page = await context.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(String(error));
  });
  page.on('response', (res) => {
    if (res.status() >= 400) {
      failedRequests.push({ url: res.url(), status: res.status() });
    }
  });

  const snap = async (filename) => {
    const filePath = join(outDir, filename);
    await page.screenshot({ path: filePath, type: 'jpeg', quality: 85 });
    screenshots.push(filePath);
    console.log(`  screenshot ${filePath}`);
  };

  // =========================================================================
  // 0. Boot `/?debug&seed=4242` & verify real Metal GPU
  // =========================================================================
  await page.goto(`${staticServer.baseUrl}/?debug&seed=4242`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('button[data-control="enter-xr"]');
      return (
        Boolean(window.__riftBastionApp?.debugEnabled) &&
        btn instanceof HTMLButtonElement &&
        !btn.disabled
      );
    },
    undefined,
    { timeout: 15000 },
  );

  gpu = assertRealGpu(await probeGpu(page));
  console.log(`UNMASKED_RENDERER_WEBGL: ${gpu.renderer}`);
  record('gpu-real-renderer', true, gpu);

  buildId = await page.evaluate(() => window.__APP_BUILD ?? null);

  // =========================================================================
  // 1. Enter `immersive-ar` at seated 1.2 m (`front-180` Play Arc), Lock Core,
  //    and build `autocannon` (surface-clamp) + `rail-sniper` (hover-pod) via
  //    live controllers / radial menu / trigger action flow
  // =========================================================================
  await page.evaluate((headY) => {
    window.__xrEmu.setHead(headY, 0, 0);
  }, SEATED_HEAD_Y);

  await page.getByRole('button', { name: 'Enter Mixed Reality (Quest 3)' }).click();
  await page.waitForFunction(
    () =>
      window.__xrEmu.ctx().renderer?.xr.isPresenting === true &&
      window.__riftBastionApp?.shell.xr.presenting === true,
    undefined,
    { timeout: 15000 },
  );

  await page.evaluate(() => window.__xrEmu.frames(6));

  // Sync calibration to the live seated 1.2 m XR camera pose and verify seated `front-180` Play Arc
  const calibrationCheck = await page.evaluate(async () => {
    const emu = window.__xrEmu;
    const { renderer, app } = emu.ctx();
    if (!renderer || !app) throw new Error('Missing XR renderer or app');
    const xrCamera = renderer.xr.getCamera();
    xrCamera.updateWorldMatrix(true, false);
    const camY = xrCamera.matrixWorld.elements[13];

    app.calibration.beginCalibration({
      position: { x: 0, y: camY, z: 0 },
      yaw: 0,
    });
    app.tacticalHud.recenterToHeadset({
      position: { x: 0, y: camY, z: 0 },
      yaw: 0,
    });
    await emu.frames(3);

    return {
      phase: app.state.phase,
      cameraWorldY: camY,
      posture: app.calibration.state.posture,
      playArc: app.calibration.playArc,
      isValid: app.calibration.isValid,
      portalCount: app.calibration.portalAnchors.length,
      corePosition: app.calibration.coreAnchor.position,
      previewVisible: app.calibrationPreview.group.visible,
    };
  });
  await snap('01-xr-seated-calibration.jpg');

  // Lock Core via the spatial Tactical HUD `Lock Core` primary action button
  const lockCheck = await page.evaluate(async () => {
    const emu = window.__xrEmu;
    const { app } = emu.ctx();
    if (!app) throw new Error('Missing app');
    const activated = app.tacticalHud.activate('primary-action');
    await emu.frames(4);
    return {
      activated,
      phase: app.state.phase,
      locked: app.calibration.locked,
      previewVisible: app.calibrationPreview.group.visible,
      credits: app.sim.getState().credits,
    };
  });

  record(
    'xr-seated-calibration-lock-core',
    calibrationCheck.phase === 'calibrate' &&
      Math.abs(calibrationCheck.cameraWorldY - SEATED_HEAD_Y) < 0.05 &&
      calibrationCheck.posture === 'seated' &&
      calibrationCheck.playArc === 'front-180' &&
      calibrationCheck.isValid === true &&
      calibrationCheck.portalCount >= 2 &&
      lockCheck.activated === true &&
      lockCheck.phase === 'prep' &&
      lockCheck.locked === true &&
      lockCheck.previewVisible === false &&
      lockCheck.credits === 320,
    { calibrationCheck, lockCheck },
  );

  // Helper to open the Radial Build Wheel via right thumbstick click, select a turret wedge via
  // stick tilt + trigger press/release, and confirm selection.
  const selectBuildActionFromRadialWheel = async (targetActionId, screenshotName = null) => {
    const opened = await page.evaluate(async () => {
      const emu = window.__xrEmu;
      const { app } = emu.ctx();
      const right = emu.device.controllers.right;
      if (!app || !right) throw new Error('Missing app or right controller');

      // Aim right controller forward into open space so Build Wheel (not Turret Command) opens
      right.position.set(0.25, 1.05, -0.25);
      right.quaternion.set(0, 0, 0, 1);
      right.updateAxes('thumbstick', 0, 0);
      right.updateButtonValue('trigger', 0);
      right.updateButtonValue('squeeze', 0);
      await emu.frames(2);

      // Click and release right thumbstick to open the Build Wheel
      right.updateButtonValue('thumbstick', 1);
      await emu.frames(2);
      right.updateButtonValue('thumbstick', 0);
      await emu.frames(2);

      return {
        isOpen: app.radialControls.isOpen,
        context: app.radialControls.context,
      };
    });

    // Wait for the radial wheel's 0.64 s opening transition to reach `interactive === true`
    await page.waitForFunction(
      () => window.__riftBastionApp?.radialControls.interactive === true,
      undefined,
      { timeout: 5000 },
    );

    if (screenshotName) {
      await snap(screenshotName);
    }

    // Sweep thumbstick tilt angles to hover the requested action wedge, then pull trigger
    const selected = await page.evaluate(async (actionId) => {
      const emu = window.__xrEmu;
      const { app } = emu.ctx();
      const right = emu.device.controllers.right;
      if (!app || !right) throw new Error('Missing app or right controller');

      let matchedHover = null;
      const sampleCount = 20;
      for (let i = 0; i < sampleCount; i += 1) {
        const theta = (i * Math.PI * 2) / sampleCount;
        right.updateAxes('thumbstick', Math.cos(theta) * 0.9, Math.sin(theta) * 0.9);
        await emu.frames(2);
        if (app.radialControls.hoveredAction === actionId) {
          matchedHover = app.radialControls.hoveredAction;
          break;
        }
      }

      // Press and release trigger to confirm the hovered radial wedge
      right.updateButtonValue('trigger', 1);
      await emu.frames(2);
      right.updateButtonValue('trigger', 0);
      await emu.frames(2);
      right.updateAxes('thumbstick', 0, 0);
      await emu.frames(2);

      return {
        matchedHover,
        placementActive: app.placement.state.active,
        selectedKind: app.placement.selectedKind,
      };
    }, targetActionId);

    // Wait for the radial wheel's closing transition to complete (`isModal === false`)
    // so `shouldSuppressWorldTrigger()` clears before world placement begins.
    await page.waitForFunction(
      () => window.__riftBastionApp?.radialControls.isModal === false,
      undefined,
      { timeout: 5000 },
    );

    return { opened, selected };
  };

  // 1a. Select `build:autocannon` via live Radial Build Wheel and place it on a room surface (`surface-clamp`)
  const radialAutocannon = await selectBuildActionFromRadialWheel(
    'build:autocannon',
    '02-xr-radial-build-wheel.jpg',
  );

  const placeAutocannonSurface = await page.evaluate(async () => {
    const emu = window.__xrEmu;
    const { app } = emu.ctx();
    const right = emu.device.controllers.right;
    if (!app || !right) throw new Error('Missing app or right controller');

    right.position.set(0.25, 1.05, -0.25);
    right.updateAxes('thumbstick', 0, 0);

    // Sweep controller pitch/yaw postures to aim onto a valid attachable room surface in surface-clamp mode
    const candidatePitches = [-0.45, -0.3, -0.6, -0.15, 0.0, 0.2];
    const candidateYaws = [0.35, -0.35, 0.55, -0.55, 0.0];
    for (const pitch of candidatePitches) {
      let foundValid = false;
      for (const yaw of candidateYaws) {
        const sp = Math.sin(pitch / 2);
        const cp = Math.cos(pitch / 2);
        const sy = Math.sin(yaw / 2);
        const cy = Math.cos(yaw / 2);
        right.quaternion.set(cy * sp, sy * cp, -sy * sp, cy * cp);
        await emu.frames(2);
        if (
          app.placement.mountMode === 'surface-clamp' &&
          app.placement.lastValidation?.valid === true
        ) {
          foundValid = true;
          break;
        }
      }
      if (foundValid) break;
    }

    const ghostBeforeTrigger = {
      valid: app.placement.lastValidation?.valid ?? false,
      mountProfile: app.placement.mountMode,
      surfaceKind: app.placement.lastValidation?.surfaceKind ?? null,
    };

    // Pull and release right trigger to place the surface-clamp Autocannon
    right.updateButtonValue('trigger', 1);
    await emu.frames(2);
    right.updateButtonValue('trigger', 0);
    await emu.frames(2);

    const placed = app.sim.getState().turrets.find((t) => t.kind === 'autocannon');
    const blockout = placed ? app.blockouts.turrets.get(placed.id) : undefined;
    return {
      ghostBeforeTrigger,
      placedId: placed?.id ?? null,
      mountProfile: placed?.mountProfile ?? null,
      surfaceKind: placed?.surfaceKind ?? null,
      position: placed?.position ?? null,
      clampGroupVisible: blockout?.clampMountGroup.visible ?? false,
      hoverGroupVisible: blockout?.hoverPodGroup.visible ?? true,
    };
  });

  // 1b. Select `build:rail-sniper` via live Radial Build Wheel, push thumbstick to detach into
  //     mid-air `hover-pod` mode, and pull trigger to deploy
  const radialRailSniper = await selectBuildActionFromRadialWheel('build:rail-sniper');

  const placeRailHoverPod = await page.evaluate(async () => {
    const emu = window.__xrEmu;
    const { app } = emu.ctx();
    const right = emu.device.controllers.right;
    if (!app || !right) throw new Error('Missing app or right controller');

    // Aim right controller from (0.25, 1.05, -0.25) toward elevated air corridor (0.85, 0.92, -1.15)
    const origin = { x: 0.25, y: 1.05, z: -0.25 };
    const target = { x: 0.85, y: 0.92, z: -1.15 };
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;
    const dz = target.z - origin.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const fx = dx / len;
    const fy = dy / len;
    const fz = dz / len;
    const dot = -fz;
    const s = Math.sqrt((1 + dot) * 2);
    const invS = 1 / s;
    const q = { x: -fy * invS, y: fx * invS, z: 0, w: s * 0.5 };

    right.position.set(origin.x, origin.y, origin.z);
    right.quaternion.set(q.x, q.y, q.z, q.w);
    await emu.frames(2);

    // Push right thumbstick forward/pull to detach into mid-air `hover-pod` mode at ~1.35 m depth
    right.updateAxes('thumbstick', 0, -0.75);
    await emu.frames(3);
    app.placement.setHoverDepth(1.35);
    await emu.frames(2);

    const ghostBeforeTrigger = {
      valid: app.placement.lastValidation?.valid ?? false,
      mountProfile: app.placement.mountMode,
      hoverDepthM: app.placement.hoverDepthM,
    };

    // Pull trigger while in hover-pod mode
    right.updateButtonValue('trigger', 1);
    await emu.frames(2);
    right.updateButtonValue('trigger', 0);
    right.updateAxes('thumbstick', 0, 0);
    app.placement.cancelPlacement();
    await emu.frames(2);

    const placed = app.sim.getState().turrets.find((t) => t.kind === 'rail-sniper');
    const blockout = placed ? app.blockouts.turrets.get(placed.id) : undefined;
    return {
      ghostBeforeTrigger,
      placedId: placed?.id ?? null,
      mountProfile: placed?.mountProfile ?? null,
      position: placed?.position ?? null,
      hoverGroupVisible: blockout?.hoverPodGroup.visible ?? false,
      clampGroupVisible: blockout?.clampMountGroup.visible ?? true,
      totalTurrets: app.sim.getState().turrets.length,
    };
  });
  await snap('03-xr-turrets-built.jpg');

  record(
    'xr-build-autocannon-surface-and-rail-hover-pod',
    radialAutocannon.opened.context === 'build' &&
      radialAutocannon.selected.selectedKind === 'autocannon' &&
      placeAutocannonSurface.ghostBeforeTrigger.valid === true &&
      placeAutocannonSurface.mountProfile === 'surface-clamp' &&
      placeAutocannonSurface.clampGroupVisible === true &&
      placeAutocannonSurface.hoverGroupVisible === false &&
      radialRailSniper.selected.selectedKind === 'rail-sniper' &&
      placeRailHoverPod.ghostBeforeTrigger.valid === true &&
      placeRailHoverPod.mountProfile === 'hover-pod' &&
      (placeRailHoverPod.position?.y ?? 0) > 0.7 &&
      placeRailHoverPod.hoverGroupVisible === true &&
      placeRailHoverPod.clampGroupVisible === false &&
      placeRailHoverPod.totalTurrets === 2,
    {
      radialAutocannon,
      placeAutocannonSurface,
      radialRailSniper,
      placeRailHoverPod,
    },
  );

  // =========================================================================
  // 2. Launch Wave 1, advance XR frames until enemy kill + credit gain occur,
  //    and verify off-FOV directional threat chevron state activates on
  //    portal open / near-Core enemy
  // =========================================================================
  const wave1AndChevronCheck = await page.evaluate(async (headY) => {
    const emu = window.__xrEmu;
    const { app } = emu.ctx();
    if (!app) throw new Error('Missing app');

    const creditsBeforeLaunch = app.sim.getState().credits;

    // Launch Wave 1 via the spatial Tactical HUD primary button (`Launch Wave`)
    const launched = app.tacticalHud.activate('primary-action');
    await emu.frames(3);

    // Feed the initial Wave 1 `portal-opened` event from eventHistory into threatChevrons and
    // turn head yaw 90 deg left so both the opened portal and approaching near-Core enemies lie off-FOV
    const portalOpenEvents = app.sim.getEventHistory().filter((e) => e.type === 'portal-opened');
    app.threatChevrons.ingestEvents(portalOpenEvents);

    emu.setHead(headY, 0, Math.PI * 0.55);
    await emu.frames(3);

    const portalChevronSnap = {
      activeCount: app.threatChevrons.activeThreats.length,
      kinds: app.threatChevrons.activeThreats.map((t) => t.kind),
      xrRootVisible: app.threatChevrons.xrRoot.visible,
    };

    // Advance combat ticks + XR frames until an enemy enters within 1.8 m of the Core (off-FOV chevron)
    // and our turrets score a kill + credit gain
    let nearCoreChevronSnap = null;
    for (let i = 0; i < 900; i += 1) {
      const stepRes = app.sim.tick();
      const events = app.sim.drainEvents();
      app.blockouts.syncFromSim(stepRes.state, events, 1 / 60);

      // Check when an active enemy is within 1.8 m of Core while viewer head is turned 99 deg
      const hasNearCoreEnemy = stepRes.state.enemies.some(
        (e) =>
          e.hp > 0 &&
          Math.hypot(
            e.position.x - stepRes.state.corePosition.x,
            e.position.y - stepRes.state.corePosition.y,
            e.position.z - stepRes.state.corePosition.z,
          ) <= 1.8,
      );
      if (hasNearCoreEnemy && !nearCoreChevronSnap) {
        await emu.frames(2);
        if (app.threatChevrons.activeThreats.some((t) => t.kind === 'near-core')) {
          nearCoreChevronSnap = {
            activeCount: app.threatChevrons.activeThreats.length,
            kinds: app.threatChevrons.activeThreats.map((t) => t.kind),
            labels: app.threatChevrons.activeThreats.map((t) => t.label),
            xrRootVisible: app.threatChevrons.xrRoot.visible,
            visibleMeshCount: app.threatChevrons.xrRoot.children.filter((c) => c.visible).length,
          };
        }
      }

      if (
        stepRes.state.totalEnemiesKilled >= 1 &&
        stepRes.state.credits > creditsBeforeLaunch &&
        nearCoreChevronSnap
      ) {
        break;
      }
    }

    // If the Rail Sniper one-shot every crawler before it reached 1.8 m of Core, spawn one
    // crawler at 1.1 m from Core while head is still turned off-FOV to verify near-Core chevron
    if (!nearCoreChevronSnap) {
      const corePos = app.sim.getState().corePosition;
      app.debugSpawnEnemy('skitter-crawler', {
        position: { x: corePos.x, y: corePos.y, z: corePos.z + 1.0 },
        hp: 400,
      });
      await emu.frames(3);
      nearCoreChevronSnap = {
        activeCount: app.threatChevrons.activeThreats.length,
        kinds: app.threatChevrons.activeThreats.map((t) => t.kind),
        labels: app.threatChevrons.activeThreats.map((t) => t.label),
        xrRootVisible: app.threatChevrons.xrRoot.visible,
        visibleMeshCount: app.threatChevrons.xrRoot.children.filter((c) => c.visible).length,
      };
    }

    // Return headset yaw to forward (0) after capturing off-FOV threat chevrons
    emu.setHead(headY, 0, 0);
    await emu.frames(3);

    const st = app.sim.getState();
    const hist = app.sim.getEventHistory();
    return {
      launched,
      phase: app.state.phase,
      wave: st.currentWave,
      totalEnemiesKilled: st.totalEnemiesKilled,
      shotsFired: st.turrets.reduce((sum, t) => sum + t.shotsFired, 0),
      creditsBeforeLaunch,
      creditsAfter: st.credits,
      creditGain: st.credits - creditsBeforeLaunch,
      killEvents: hist.filter((e) => e.type === 'enemy-killed').length,
      portalChevronSnap,
      nearCoreChevronSnap,
    };
  }, SEATED_HEAD_Y);
  await snap('04-xr-wave1-combat-and-chevrons.jpg');

  record(
    'xr-wave1-kill-credits-and-threat-chevrons',
    wave1AndChevronCheck.launched === true &&
      wave1AndChevronCheck.wave === 1 &&
      wave1AndChevronCheck.totalEnemiesKilled >= 1 &&
      wave1AndChevronCheck.shotsFired >= 1 &&
      wave1AndChevronCheck.creditGain > 0 &&
      wave1AndChevronCheck.portalChevronSnap.activeCount >= 1 &&
      wave1AndChevronCheck.portalChevronSnap.kinds.includes('portal-opened') &&
      wave1AndChevronCheck.portalChevronSnap.xrRootVisible === true &&
      Boolean(wave1AndChevronCheck.nearCoreChevronSnap?.kinds.includes('near-core')) &&
      wave1AndChevronCheck.nearCoreChevronSnap?.xrRootVisible === true &&
      (wave1AndChevronCheck.nearCoreChevronSnap?.visibleMeshCount ?? 0) >= 1,
    wave1AndChevronCheck,
  );

  // =========================================================================
  // 3. Trigger Wave 12 Apex Broodlord Boss via `?debug` (`debugJumpToWave(12)`
  //    + `debugSpawnBoss`), assert Boss blockout renders cleanly, check
  //    render-pass order and `draws <= 200` / `zero console errors`
  // =========================================================================
  xrCombatCapture = await page.evaluate(async () => {
    const emu = window.__xrEmu;
    const { renderer, app } = emu.ctx();
    if (!renderer || !app) throw new Error('Missing renderer or app');

    // Switch occlusion to 'room-mesh' briefly to verify full layered renderOrder hierarchy
    // (-100 room occluder < -10 portal mask < -5 shadow catcher < 0 world blockouts < 1000 HUD overlays)
    app.settings.set('roomOcclusion', 'room-mesh');
    const waveDef = app.debugJumpToWave(12);
    const boss = app.debugSpawnBoss({ distanceAlongPath: 0.45 });

    // Step 8 XR frames so turrets target/fire at the Boss and render metrics settle
    await emu.frames(8);

    const bossBlockout = app.blockouts.enemies.get(boss.id);
    const carapace = bossBlockout?.group.getObjectByName('broodlord-carapace') ?? null;
    const crest = bossBlockout?.group.getObjectByName('broodlord-matriarch-crest') ?? null;
    const crackSeams = bossBlockout?.group.getObjectByName('broodlord-armor-crack-seams') ?? null;

    // Inspect scene render-pass order hierarchy
    const occluderMeshes = app.occlusion.roomMeshRoot.children;
    const roomOccluderOrder =
      occluderMeshes.length > 0 ? (occluderMeshes[0]?.renderOrder ?? null) : null;

    let portalMaskOrder = null;
    for (const portal of app.blockouts.portals.values()) {
      if (portal.apertureMaskMesh) {
        portalMaskOrder = portal.apertureMaskMesh.renderOrder;
        break;
      }
    }

    const shadowMeshes = app.shadowCatchers.root.children;
    const shadowCatcherOrder =
      shadowMeshes.length > 0 ? (shadowMeshes[0]?.renderOrder ?? null) : null;

    const bossWorldOrder = carapace?.renderOrder ?? 0;
    const hudOverlayOrder = app.tacticalHud.xrRoot.renderOrder;
    const chevronOverlayOrder = app.threatChevrons.xrRoot.renderOrder;
    const radialOverlayOrder = app.radialControls.root.renderOrder;

    const renderInfo = renderer.info.render;
    const perfSnap = app.perfRecorder.snapshot();

    return {
      presenting: renderer.xr.isPresenting,
      waveNumber: waveDef.waveNumber,
      musicCue: waveDef.musicCue,
      boss: {
        id: boss.id,
        archetypeId: boss.archetypeId,
        isBoss: boss.isBoss,
        hp: boss.hp,
        maxHp: boss.maxHp,
        blockoutMounted: Boolean(bossBlockout?.group.parent),
        blockoutVisible: Boolean(bossBlockout?.group.visible),
        hasCarapace: Boolean(carapace),
        hasCrest: Boolean(crest),
        hasCrackSeams: Boolean(crackSeams),
        hpBarCount: app.blockouts.hpFillInstancedMesh.count,
      },
      renderOrderHierarchy: {
        roomOccluderOrder,
        portalMaskOrder,
        shadowCatcherOrder,
        bossWorldOrder,
        hudOverlayOrder,
        chevronOverlayOrder,
        radialOverlayOrder,
      },
      renderBudget: {
        drawCalls: renderInfo.calls,
        maxAllowedDrawCalls: 200,
        triangles: renderInfo.triangles,
        maxAllowedTriangles: 150000,
        xrPassesRecorded: emu.passes.length,
        latestPerfDrawsMax: perfSnap.current?.drawsMax ?? null,
      },
    };
  });
  await snap('05-xr-wave12-boss-blockout.jpg');

  record(
    'xr-wave12-boss-blockout',
    xrCombatCapture.presenting === true &&
      xrCombatCapture.waveNumber === 12 &&
      xrCombatCapture.musicCue === 'broodlord-siege' &&
      xrCombatCapture.boss.archetypeId === 'apex-broodlord' &&
      xrCombatCapture.boss.isBoss === true &&
      xrCombatCapture.boss.blockoutMounted === true &&
      xrCombatCapture.boss.blockoutVisible === true &&
      xrCombatCapture.boss.hasCarapace === true &&
      xrCombatCapture.boss.hasCrest === true &&
      xrCombatCapture.boss.hasCrackSeams === true &&
      xrCombatCapture.boss.hpBarCount >= 1,
    xrCombatCapture.boss,
  );

  const ord = xrCombatCapture.renderOrderHierarchy;
  const renderOrderValid =
    typeof ord.roomOccluderOrder === 'number' &&
    typeof ord.portalMaskOrder === 'number' &&
    typeof ord.shadowCatcherOrder === 'number' &&
    typeof ord.bossWorldOrder === 'number' &&
    typeof ord.hudOverlayOrder === 'number' &&
    typeof ord.chevronOverlayOrder === 'number' &&
    ord.roomOccluderOrder < ord.portalMaskOrder &&
    ord.portalMaskOrder < ord.shadowCatcherOrder &&
    ord.shadowCatcherOrder < ord.bossWorldOrder &&
    ord.bossWorldOrder < ord.hudOverlayOrder &&
    ord.chevronOverlayOrder >= 1000;

  record('xr-render-pass-order', renderOrderValid, ord);

  const budget = xrCombatCapture.renderBudget;
  record(
    'xr-draw-call-budget',
    budget.drawCalls > 0 &&
      budget.drawCalls <= MAX_QUEST3_DRAW_CALLS &&
      budget.triangles <= 150000 &&
      budget.xrPassesRecorded >= 20,
    budget,
  );

  // Clean XR session exit
  await page.evaluate(() => window.__riftBastionApp?.shell.xr.exit());
  await page.waitForFunction(
    () =>
      window.__xrEmu.session?.ended === true &&
      window.__riftBastionApp?.shell.xr.presenting === false,
    undefined,
    { timeout: 10000 },
  );

  record('zero-console-errors', consoleErrors.length === 0 && failedRequests.length === 0, {
    count: consoleErrors.length,
    errors: consoleErrors,
    failedRequests,
  });
} finally {
  await browser.close();
  await staticServer.close();
}

const passed = checks.length > 0 && checks.every((c) => c.pass);
const report = {
  evidenceClass: 'emulator-evidence',
  disclaimer:
    'IWER Quest 3 emulator evidence only. IWER renders stereo into the page canvas and applies neither hardware fixed foveation nor compositor framebuffer scaling. Physical Quest 3 headset acceptance remains separate.',
  suite: 'p2-xr-combat-walk',
  timestamp: new Date().toISOString(),
  buildId,
  gpu,
  seed: 4242,
  seatedHeightM: SEATED_HEAD_Y,
  passed,
  checks,
  xrCombatCapture,
  screenshots,
  consoleErrors,
  failedRequests,
};

const reportPath = join(outDir, 'report.json');
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Report written to ${reportPath} (passed=${passed})`);

if (!passed) {
  process.exitCode = 1;
}
