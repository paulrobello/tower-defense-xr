#!/usr/bin/env bun
/**
 * P2-T6 Desktop End-to-End Campaign Playthrough Verification (`scripts/check-desktop-campaign.ts`).
 *
 * Serves the production `dist` bundle on an isolated free port (`0`), launches Playwright Chromium
 * on the real Metal GPU via `e2e/gpu-args.ts` (logging `UNMASKED_RENDERER_WEBGL`), opens
 * `/?debug&seed=4242`, and verifies:
 * 1. Clicks `Play Desktop` and locks the Core Anchor during Calibration.
 * 2. Builds all 4 turret types (`autocannon`, `plasma-mortar`, `cryo-arc`, `rail-sniper`) including
 *    a mid-air `hover-pod`, upgrades a turret (`T1 -> T2`), relocates a turret (charging 25 CR and
 *    entering 1.5 s redeploy cooldown), and sells a turret (verifying exact 75% refund).
 * 3. Launches Wave 1, steps real frames, and asserts enemies spawn, turrets fire, enemy kill occurs,
 *    and Requisition credits increase.
 * 4. Uses `?debug` shortcuts (`debugGrantCredits` + `debugJumpToWave(12)` + full turret defense) to
 *    verify Wave 12 Apex Broodlord Boss spawn -> Phase 2 armor-crack transition -> Victory overlay
 *    renders with 1–3 stars + `NEW BEST`.
 * 5. Reloads the page and verifies IndexedDB persisted `bestScore`, `highestWaveCleared === 12`, and
 *    `bestStars`; tests validated JSON backup export, corrupt JSON rejection, and import round-trip.
 * 6. Asserts zero console/page errors and archives screenshots + JSON report in
 *    `output/xr-emu/p2-desktop/`.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, type Page } from 'playwright';
import { assertRealGpu, type GpuInfo, getGpuLaunchOptions, probeGpu } from '../e2e/gpu-args.ts';
import type { TurretKind, Vec3 } from '../src/content/turrets.ts';
import type { AppRuntime } from '../src/main.ts';

declare global {
  interface Window {
    __riftBastionApp?: AppRuntime;
    __APP_BUILD?: string;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const { values: opts } = parseArgs({
  options: {
    dist: { type: 'string', default: join(root, 'dist') },
    out: { type: 'string', default: join(root, 'output/xr-emu/p2-desktop') },
    port: { type: 'string', default: '0' },
    headed: { type: 'boolean', default: false },
  },
});

const MIME_TYPES: Record<string, string> = {
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

const distDir = resolve(opts.dist ?? join(root, 'dist'));
if (!existsSync(join(distDir, 'index.html'))) {
  const proc = Bun.spawnSync(['bun', 'run', 'build'], {
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (proc.exitCode !== 0 || !existsSync(join(distDir, 'index.html'))) {
    throw new Error(`Missing production build at ${distDir}. Run "bun run build" first.`);
  }
}

function listenOnPort(
  server: ReturnType<typeof createServer>,
  preferredPort: number,
): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const tryListen = (port: number, allowFallback: boolean) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (allowFallback && err.code === 'EADDRINUSE') {
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

async function startStaticServer(directory: string, preferredPort: number) {
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

  const port = await listenOnPort(server, preferredPort);
  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}

interface CheckEntry {
  readonly id: string;
  readonly pass: boolean;
  readonly detail: Record<string, unknown>;
}

const checks: CheckEntry[] = [];
const screenshots: string[] = [];
const consoleErrors: string[] = [];
const failedRequests: Array<{ url: string; status: number }> = [];

function record(id: string, pass: boolean, detail: Record<string, unknown> = {}): void {
  checks.push({ id, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id}`, JSON.stringify(detail));
}

async function projectWorldToClient(
  page: Page,
  target: Vec3,
): Promise<{ clientX: number; clientY: number }> {
  return page.evaluate((pt) => {
    const app = window.__riftBastionApp;
    if (!app) throw new Error('App runtime not mounted');
    const cam = app.shell.camera;
    const canvas = app.shell.renderer.domElement;
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();

    // Clone camera position and project 3D point into NDC [-1, 1]
    const v = cam.position.clone().set(pt.x, pt.y, pt.z).project(cam);
    const rect = canvas.getBoundingClientRect();
    return {
      clientX: rect.left + (v.x + 1) * 0.5 * rect.width,
      clientY: rect.top + (-v.y + 1) * 0.5 * rect.height,
    };
  }, target);
}

async function waitAnimationFrames(page: Page, count = 2): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((resolveFrames) => {
        let remaining = Math.max(1, n);
        const step = () => {
          remaining -= 1;
          if (remaining <= 0) resolveFrames();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    count,
  );
}

const outDir = resolve(opts.out ?? join(root, 'output/xr-emu/p2-desktop'));
mkdirSync(outDir, { recursive: true });

const preferredPort = Number.parseInt(opts.port ?? '0', 10);
const staticServer = await startStaticServer(
  distDir,
  Number.isFinite(preferredPort) ? preferredPort : 0,
);
console.log(`Serving ${distDir} at ${staticServer.baseUrl}`);

const browser = await chromium.launch(getGpuLaunchOptions({ headless: !opts.headed }));
let gpu: GpuInfo | null = null;
let buildId: string | null = null;

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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

  const snap = async (filename: string) => {
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
  await page.waitForFunction(() => Boolean(window.__riftBastionApp?.debugEnabled), undefined, {
    timeout: 15000,
  });

  gpu = assertRealGpu(await probeGpu(page));
  console.log(`UNMASKED_RENDERER_WEBGL: ${gpu.renderer}`);
  record('gpu-real-renderer', true, { ...gpu });

  buildId = await page.evaluate(async () => {
    const app = window.__riftBastionApp;
    await app?.persist.init();
    await app?.persist.clearMissionRecords();
    return window.__APP_BUILD ?? null;
  });

  // =========================================================================
  // 1. Click `Play Desktop`, verify Calibration, and Lock Core Anchor
  // =========================================================================
  await page.getByRole('button', { name: 'Play Desktop' }).click();
  await page.waitForFunction(
    () => window.__riftBastionApp?.state.phase === 'calibrate',
    undefined,
    { timeout: 5000 },
  );

  // Position desktop orbit camera inside the virtual room south wall (z = 1.95 < 2.1)
  await page.evaluate(() => {
    const app = window.__riftBastionApp;
    if (!app) return;
    app.shell.camera.position.set(0, 1.65, 1.95);
    app.shell.controls.target.set(0, 0.5, -0.2);
    app.shell.controls.update();
  });

  // Move Core Anchor via mouse click on the tactical floor at (0, 0, 0.85) during calibration
  const coreScreenPt = await projectWorldToClient(page, { x: 0, y: 0, z: 0.85 });
  await page.mouse.move(coreScreenPt.clientX, coreScreenPt.clientY);
  await page.mouse.click(coreScreenPt.clientX, coreScreenPt.clientY);
  await waitAnimationFrames(page, 2);

  const calibrateSnap = await page.evaluate(() => {
    const app = window.__riftBastionApp;
    const primaryBtn = document.querySelector('button[data-hud="primary-action"]');
    return {
      phase: app?.state.phase ?? null,
      isValid: app?.calibration.isValid ?? false,
      portalCount: app?.calibration.portalAnchors.length ?? 0,
      previewVisible: app?.calibrationPreview.group.visible ?? false,
      primaryLabel: primaryBtn?.textContent ?? null,
      corePos: app?.calibration.coreAnchor.position ?? null,
    };
  });
  await snap('01-desktop-calibration.jpg');

  // Lock Core via the Tactical HUD primary button
  await page.locator('button[data-hud="primary-action"]').click();
  await page.waitForFunction(
    () =>
      window.__riftBastionApp?.state.phase === 'prep' &&
      window.__riftBastionApp?.calibration.locked === true,
    undefined,
    { timeout: 5000 },
  );

  const afterLock = await page.evaluate(() => {
    const app = window.__riftBastionApp;
    return {
      phase: app?.state.phase ?? null,
      locked: app?.calibration.locked ?? false,
      previewVisible: app?.calibrationPreview.group.visible ?? true,
      credits: app?.sim.getState().credits ?? 0,
      seed: app?.sim.seed ?? 0,
    };
  });

  record(
    'desktop-calibrate-lock-core',
    calibrateSnap.phase === 'calibrate' &&
      calibrateSnap.isValid &&
      calibrateSnap.portalCount >= 2 &&
      calibrateSnap.previewVisible &&
      calibrateSnap.primaryLabel === 'Lock Core' &&
      afterLock.phase === 'prep' &&
      afterLock.locked &&
      !afterLock.previewVisible &&
      afterLock.credits === 200 &&
      afterLock.seed === 4242,
    { calibrateSnap, afterLock },
  );

  // =========================================================================
  // 2. Build all 4 turret types (including mid-air hover-pod), upgrade T1->T2,
  //    relocate, and sell (verifying exact 75% refund)
  // =========================================================================
  // Grant 450 credits so we can build all 4 turrets + a 5th temp turret + upgrade + relocate in prep
  await page.evaluate(() => {
    window.__riftBastionApp?.debugGrantCredits(450);
  });

  const buildDesktopSurfaceTurret = async (
    hotkey: '1' | '2' | '3' | '4',
    worldPos: Vec3,
  ): Promise<void> => {
    await page.keyboard.press(hotkey);
    const pt = await projectWorldToClient(page, worldPos);
    await page.mouse.move(pt.clientX, pt.clientY);
    await page.mouse.click(pt.clientX, pt.clientY);
    await waitAnimationFrames(page, 2);
  };

  // 2a. Build 3 surface-clamp turrets: Autocannon (floor), Plasma Mortar (floor), Cryo-Arc (table)
  await buildDesktopSurfaceTurret('1', { x: -0.85, y: 0, z: 0.65 });
  await buildDesktopSurfaceTurret('2', { x: 0.85, y: 0, z: 0.65 });
  await buildDesktopSurfaceTurret('3', { x: -0.35, y: 0.78, z: -0.1 });

  // 2b. Build Rail Sniper as a mid-air hover-pod using hotkey '4' + hotkey 'h' + depth pull
  await page.keyboard.press('4');
  const hoverAimPt = await projectWorldToClient(page, { x: 0.35, y: 0.78, z: -0.1 });
  await page.mouse.move(hoverAimPt.clientX, hoverAimPt.clientY);
  await page.keyboard.press('h');
  await page.evaluate(() => {
    window.__riftBastionApp?.desktopControls.adjustHoverDepth(-0.55);
  });
  await page.mouse.click(hoverAimPt.clientX, hoverAimPt.clientY);
  await waitAnimationFrames(page, 2);

  // Toggle back to surface-clamp mode and build a 5th temporary T1 Autocannon (100 CR) for 75% sell refund test
  await page.keyboard.press('h');
  await buildDesktopSurfaceTurret('1', { x: -1.35, y: 0, z: 0.65 });
  await page.keyboard.press('Escape');

  const builtSummary = await page.evaluate(() => {
    const app = window.__riftBastionApp;
    if (!app) throw new Error('Missing app');
    const turrets = app.sim.getState().turrets.map((t) => ({
      id: t.id,
      kind: t.kind,
      tier: t.tier,
      mountProfile: t.mountProfile,
      surfaceKind: t.surfaceKind,
      position: t.position,
      investedCredits: t.investedCredits,
    }));
    const hoverRail = turrets.find((t) => t.kind === 'rail-sniper');
    const railBlockout = hoverRail ? app.blockouts.turrets.get(hoverRail.id) : undefined;
    return {
      count: turrets.length,
      kinds: Array.from(new Set(turrets.map((t) => t.kind))).sort(),
      turrets,
      hoverRailMount: hoverRail?.mountProfile ?? null,
      hoverRailY: hoverRail?.position.y ?? 0,
      hoverPodGroupVisible: railBlockout?.hoverPodGroup.visible ?? false,
      clampGroupVisible: railBlockout?.clampMountGroup.visible ?? true,
    };
  });
  await snap('02-desktop-four-turrets-built.jpg');

  record(
    'desktop-build-all-4-turrets-and-hover-pod',
    builtSummary.count === 5 &&
      builtSummary.kinds.length === 4 &&
      builtSummary.hoverRailMount === 'hover-pod' &&
      builtSummary.hoverRailY > 0.8 &&
      builtSummary.hoverPodGroupVisible === true &&
      builtSummary.clampGroupVisible === false,
    builtSummary,
  );

  // 2d. Upgrade turret-1 (Autocannon) from T1 -> T2 via desktop selection + 'u' hotkey
  const autocannonTurret = builtSummary.turrets.find(
    (t) => t.kind === 'autocannon' && Math.abs(t.position.x - -0.85) < 0.2,
  );
  if (!autocannonTurret) {
    throw new Error('Expected primary autocannon turret');
  }
  const autoSelectPt = await projectWorldToClient(page, {
    x: autocannonTurret.position.x,
    y: autocannonTurret.position.y + 0.12,
    z: autocannonTurret.position.z,
  });
  await page.mouse.move(autoSelectPt.clientX, autoSelectPt.clientY);
  await page.mouse.click(autoSelectPt.clientX, autoSelectPt.clientY);
  await page.keyboard.press('u');
  await waitAnimationFrames(page, 2);

  const upgradeSummary = await page.evaluate((turretId) => {
    const app = window.__riftBastionApp;
    const simTurret = app?.sim.getTurret(turretId);
    const blockout = app?.blockouts.turrets.get(turretId);
    return {
      turretId,
      tier: simTurret?.tier ?? null,
      level: simTurret?.level ?? null,
      investedCredits: simTurret?.investedCredits ?? 0,
      blockoutTier: blockout?.tier ?? null,
      barrelCount: (blockout?.barrelGroup.userData.barrelCount as number | undefined) ?? 0,
    };
  }, autocannonTurret.id);

  record(
    'desktop-turret-upgrade-t1-to-t2',
    upgradeSummary.tier === 'T2' &&
      upgradeSummary.level === 2 &&
      upgradeSummary.investedCredits === 230 &&
      upgradeSummary.blockoutTier === 'T2' &&
      upgradeSummary.barrelCount === 2,
    upgradeSummary,
  );

  // 2e. Relocate Plasma Mortar via desktop selection + 'r' hotkey + click new floor coordinate
  const mortarTurret = builtSummary.turrets.find((t) => t.kind === 'plasma-mortar');
  if (!mortarTurret) {
    throw new Error('Expected plasma-mortar turret');
  }
  const creditsBeforeRelocate = await page.evaluate(
    () => window.__riftBastionApp?.sim.getState().credits ?? 0,
  );
  const mortarSelectPt = await projectWorldToClient(page, {
    x: mortarTurret.position.x,
    y: mortarTurret.position.y + 0.12,
    z: mortarTurret.position.z,
  });
  await page.mouse.move(mortarSelectPt.clientX, mortarSelectPt.clientY);
  await page.mouse.click(mortarSelectPt.clientX, mortarSelectPt.clientY);
  await page.keyboard.press('r');

  const relocateTarget: Vec3 = { x: 0.95, y: 0, z: 0.15 };
  const relocatePt = await projectWorldToClient(page, relocateTarget);
  await page.mouse.move(relocatePt.clientX, relocatePt.clientY);
  await page.mouse.click(relocatePt.clientX, relocatePt.clientY);
  await page.keyboard.press('Escape');
  await waitAnimationFrames(page, 2);

  const relocateSummary = await page.evaluate(
    ({ turretId, prevPos, prevCredits }) => {
      const app = window.__riftBastionApp;
      const simTurret = app?.sim.getTurret(turretId);
      const creditsNow = app?.sim.getState().credits ?? 0;
      const movedDist = simTurret
        ? Math.hypot(
            simTurret.position.x - prevPos.x,
            simTurret.position.y - prevPos.y,
            simTurret.position.z - prevPos.z,
          )
        : 0;
      return {
        turretId,
        previousPosition: prevPos,
        newPosition: simTurret?.position ?? null,
        movedDistanceM: movedDist,
        costCharged: prevCredits - creditsNow,
        redeployCooldownSec: simTurret?.redeployCooldownSec ?? 0,
      };
    },
    {
      turretId: mortarTurret.id,
      prevPos: mortarTurret.position,
      prevCredits: creditsBeforeRelocate,
    },
  );

  record(
    'desktop-turret-relocate',
    relocateSummary.movedDistanceM > 0.3 &&
      relocateSummary.costCharged === 25 &&
      relocateSummary.redeployCooldownSec > 0,
    relocateSummary,
  );

  // 2f. Sell the 5th temporary T1 Autocannon (invested 100 CR) via hotkey 'x' and verify 75% refund (75 CR)
  const tempAutocannon = builtSummary.turrets.find(
    (t) => t.kind === 'autocannon' && t.id !== autocannonTurret.id,
  );
  if (!tempAutocannon) {
    throw new Error('Expected temporary autocannon for sell verification');
  }
  const sellPreState = await page.evaluate((turretId) => {
    const app = window.__riftBastionApp;
    const t = app?.sim.getTurret(turretId);
    return {
      creditsBefore: app?.sim.getState().credits ?? 0,
      investedCredits: t?.investedCredits ?? 0,
      expectedRefund: Math.round((t?.investedCredits ?? 0) * 0.75),
    };
  }, tempAutocannon.id);

  const sellSelectPt = await projectWorldToClient(page, {
    x: tempAutocannon.position.x,
    y: tempAutocannon.position.y + 0.12,
    z: tempAutocannon.position.z,
  });
  await page.mouse.move(sellSelectPt.clientX, sellSelectPt.clientY);
  await page.mouse.click(sellSelectPt.clientX, sellSelectPt.clientY);
  await page.keyboard.press('x');
  await waitAnimationFrames(page, 2);

  const sellSummary = await page.evaluate(
    ({ turretId, pre }) => {
      const app = window.__riftBastionApp;
      const creditsAfter = app?.sim.getState().credits ?? 0;
      const refundReceived = creditsAfter - pre.creditsBefore;
      return {
        turretId,
        stillExists: Boolean(app?.sim.getTurret(turretId)),
        remainingTurretCount: app?.sim.getState().turrets.length ?? 0,
        investedCredits: pre.investedCredits,
        expectedRefund: pre.expectedRefund,
        refundReceived,
        refundRatio: pre.investedCredits > 0 ? refundReceived / pre.investedCredits : 0,
      };
    },
    { turretId: tempAutocannon.id, pre: sellPreState },
  );

  record(
    'desktop-turret-sell-75pct-refund',
    !sellSummary.stillExists &&
      sellSummary.remainingTurretCount === 4 &&
      sellSummary.refundReceived === sellSummary.expectedRefund &&
      Math.abs(sellSummary.refundRatio - 0.75) < 1e-6,
    sellSummary,
  );

  // =========================================================================
  // 3. Launch Wave 1, step real frames, assert enemy spawn, turret fire,
  //    enemy kill, and credit gain
  // =========================================================================
  const creditsAtWave1Launch = await page.evaluate(
    () => window.__riftBastionApp?.sim.getState().credits ?? 0,
  );
  await page.locator('button[data-hud="primary-action"]').click();
  await page.waitForFunction(
    () =>
      window.__riftBastionApp?.state.phase === 'wave' &&
      window.__riftBastionApp?.sim.getState().currentWave === 1,
    undefined,
    { timeout: 5000 },
  );

  // Wait on real requestAnimationFrame combat ticks for enemies to spawn, turrets to fire, and first kill + credit gain
  await page.waitForFunction(
    (initialCredits) => {
      const app = window.__riftBastionApp;
      if (!app) return false;
      const st = app.sim.getState();
      const hist = app.sim.getEventHistory();
      const sawSpawn = hist.some((e) => e.type === 'enemy-spawned');
      const sawFire =
        st.turrets.some((t) => t.shotsFired > 0) && hist.some((e) => e.type === 'turret-fired');
      const sawKill = st.totalEnemiesKilled >= 1 && hist.some((e) => e.type === 'enemy-killed');
      return sawSpawn && sawFire && sawKill && st.credits > initialCredits;
    },
    creditsAtWave1Launch,
    { timeout: 15000 },
  );

  const wave1Summary = await page.evaluate((initialCredits) => {
    const app = window.__riftBastionApp;
    if (!app) throw new Error('Missing app');
    const st = app.sim.getState();
    const hist = app.sim.getEventHistory();
    return {
      phase: app.state.phase,
      wave: st.currentWave,
      activeEnemies: st.enemies.length,
      spawnEvents: hist.filter((e) => e.type === 'enemy-spawned').length,
      fireEvents: hist.filter((e) => e.type === 'turret-fired').length,
      killEvents: hist.filter((e) => e.type === 'enemy-killed').length,
      totalShotsFired: st.turrets.reduce((sum, t) => sum + t.shotsFired, 0),
      totalEnemiesKilled: st.totalEnemiesKilled,
      creditsBefore: initialCredits,
      creditsAfter: st.credits,
      creditGain: st.credits - initialCredits,
    };
  }, creditsAtWave1Launch);
  await snap('03-desktop-wave1-combat.jpg');

  record(
    'desktop-wave1-spawn-fire-kill-credits',
    wave1Summary.wave === 1 &&
      wave1Summary.spawnEvents >= 1 &&
      wave1Summary.fireEvents >= 1 &&
      wave1Summary.killEvents >= 1 &&
      wave1Summary.totalShotsFired >= 1 &&
      wave1Summary.totalEnemiesKilled >= 1 &&
      wave1Summary.creditGain > 0,
    wave1Summary,
  );

  // =========================================================================
  // 4. Use `?debug` shortcuts (`debugGrantCredits` + full 14-turret T3 defense
  //    + `debugJumpToWave(12)`) -> Boss spawn -> Phase 2 -> Victory overlay
  // =========================================================================
  const defenseSetup = await page.evaluate(() => {
    const app = window.__riftBastionApp;
    if (!app) throw new Error('Missing app');

    app.debugGrantCredits(20000);

    const candidateSlots: Array<{
      kind: TurretKind;
      position: Vec3;
      priority: 'first' | 'strongest' | 'closest' | 'air';
    }> = [
      { kind: 'rail-sniper', position: { x: -0.95, y: 0, z: 0.65 }, priority: 'strongest' },
      { kind: 'rail-sniper', position: { x: 0.95, y: 0, z: 0.25 }, priority: 'strongest' },
      { kind: 'cryo-arc', position: { x: 0.0, y: 0.78, z: 0.1 }, priority: 'first' },
      { kind: 'plasma-mortar', position: { x: 0.0, y: 0, z: 0.7 }, priority: 'first' },
      { kind: 'autocannon', position: { x: -0.5, y: 0, z: 0.75 }, priority: 'first' },
      { kind: 'autocannon', position: { x: 0.5, y: 0, z: 0.75 }, priority: 'first' },
      { kind: 'cryo-arc', position: { x: -0.65, y: 0, z: -0.4 }, priority: 'first' },
      { kind: 'plasma-mortar', position: { x: 0.65, y: 0, z: -0.4 }, priority: 'first' },
      { kind: 'rail-sniper', position: { x: -1.3, y: 0, z: 0.35 }, priority: 'strongest' },
      { kind: 'rail-sniper', position: { x: 1.3, y: 0, z: 0.35 }, priority: 'air' },
      { kind: 'autocannon', position: { x: -1.3, y: 0, z: 1.05 }, priority: 'closest' },
      { kind: 'autocannon', position: { x: 1.3, y: 0, z: 1.05 }, priority: 'first' },
      { kind: 'plasma-mortar', position: { x: -0.45, y: 0, z: -0.9 }, priority: 'first' },
      { kind: 'rail-sniper', position: { x: 0.45, y: 0, z: -0.9 }, priority: 'strongest' },
      { kind: 'cryo-arc', position: { x: 0.0, y: 0, z: -0.65 }, priority: 'first' },
      { kind: 'rail-sniper', position: { x: -1.35, y: 0, z: -0.35 }, priority: 'strongest' },
      { kind: 'rail-sniper', position: { x: 1.35, y: 0, z: -0.35 }, priority: 'strongest' },
    ];

    for (const slot of candidateSlots) {
      if (app.sim.getState().turrets.length >= 14) break;
      const surfaceId =
        Math.abs(slot.position.y - 0.78) < 0.05 ? 'virtual-table-central' : 'virtual-floor';
      const placed = app.placement.placeTurret(
        {
          kind: slot.kind,
          position: slot.position,
          surfaceId,
          priority: slot.priority,
        },
        'desktop',
      );
      if (placed) {
        app.bus.dispatch(
          { type: 'turret/set-priority', turretId: placed.id, priority: slot.priority },
          'desktop',
        );
      }
    }

    // Upgrade every placed turret to T3
    for (const tierPass of ['T1', 'T2'] as const) {
      for (const turret of [...app.sim.getState().turrets]) {
        if (turret.tier === tierPass) {
          app.bus.dispatch({ type: 'turret/upgrade', turretId: turret.id }, 'desktop');
        }
      }
    }

    const wave12 = app.debugJumpToWave(12);
    const turrets = app.sim.getState().turrets;
    return {
      waveNumber: wave12.waveNumber,
      waveTitle: wave12.title,
      musicCue: wave12.musicCue,
      turretCount: turrets.length,
      allT3: turrets.every((t) => t.tier === 'T3'),
    };
  });

  // 4a. Advance simulation ticks until the Wave 12 Apex Broodlord Boss spawns in Phase 1
  const bossSpawnSnap = await page.evaluate(() => {
    const app = window.__riftBastionApp;
    if (!app) throw new Error('Missing app');
    let boss = app.sim.getState().enemies.find((e) => e.isBoss);
    for (let i = 0; i < 360 && !boss; i += 1) {
      const stepRes = app.sim.tick();
      const events = app.sim.drainEvents();
      app.blockouts.syncFromSim(stepRes.state, events, 1 / 60);
      boss = stepRes.state.enemies.find((e) => e.isBoss);
    }
    if (!boss) return null;
    const blockout = app.blockouts.enemies.get(boss.id);
    return {
      bossId: boss.id,
      archetypeId: boss.archetypeId,
      hp: boss.hp,
      maxHp: boss.maxHp,
      bossPhase: boss.bossPhase,
      isBossPhase2: boss.isBossPhase2,
      blockoutExists: Boolean(blockout),
      hasCarapace: Boolean(blockout?.group.getObjectByName('broodlord-carapace')),
      hasCrest: Boolean(blockout?.group.getObjectByName('broodlord-matriarch-crest')),
      hasCrackSeams: Boolean(blockout?.group.getObjectByName('broodlord-armor-crack-seams')),
    };
  });
  await waitAnimationFrames(page, 2);
  await snap('04-desktop-wave12-boss-spawn.jpg');

  record(
    'desktop-wave12-boss-spawn',
    defenseSetup.waveNumber === 12 &&
      defenseSetup.allT3 &&
      bossSpawnSnap !== null &&
      bossSpawnSnap.archetypeId === 'apex-broodlord' &&
      bossSpawnSnap.bossPhase === 1 &&
      bossSpawnSnap.isBossPhase2 === false &&
      bossSpawnSnap.blockoutExists &&
      bossSpawnSnap.hasCarapace &&
      bossSpawnSnap.hasCrest &&
      bossSpawnSnap.hasCrackSeams,
    { defenseSetup, bossSpawnSnap },
  );

  // 4b. Advance simulation ticks until the Apex Broodlord enters Phase 2 (<= 50% HP armor crack)
  const bossPhase2Snap = await page.evaluate(() => {
    const app = window.__riftBastionApp;
    if (!app) throw new Error('Missing app');
    let sawPhase2Event = false;
    for (let i = 0; i < 3600; i += 1) {
      const stepRes = app.sim.tick();
      const events = app.sim.drainEvents();
      app.blockouts.syncFromSim(stepRes.state, events, 1 / 60);
      if (events.some((e) => e.type === 'boss-phase2')) {
        sawPhase2Event = true;
      }
      const boss = stepRes.state.enemies.find((e) => e.isBoss);
      if (sawPhase2Event || boss?.isBossPhase2) {
        const blockout = boss ? app.blockouts.enemies.get(boss.id) : undefined;
        return {
          sawPhase2Event:
            sawPhase2Event || app.sim.getEventHistory().some((e) => e.type === 'boss-phase2'),
          bossId: boss?.id ?? null,
          hp: boss?.hp ?? 0,
          maxHp: boss?.maxHp ?? 5600,
          bossPhase: boss?.bossPhase ?? 2,
          isBossPhase2: boss?.isBossPhase2 ?? true,
          blockoutPhase2: blockout?.isBossPhase2 ?? false,
          crackOpacity: blockout?.crackMaterial?.opacity ?? 0,
        };
      }
    }
    return null;
  });
  await waitAnimationFrames(page, 2);
  await snap('05-desktop-wave12-boss-phase2.jpg');

  record(
    'desktop-wave12-boss-phase2',
    bossPhase2Snap !== null &&
      bossPhase2Snap.sawPhase2Event === true &&
      bossPhase2Snap.isBossPhase2 === true &&
      bossPhase2Snap.blockoutPhase2 === true &&
      bossPhase2Snap.crackOpacity > 0.9,
    bossPhase2Snap ?? {},
  );

  // 4c. Advance remaining Wave 12 ticks to Victory and verify the DOM Mission Victory overlay
  await page.evaluate(() => {
    const app = window.__riftBastionApp;
    if (!app) throw new Error('Missing app');
    for (let i = 0; i < 6000; i += 1) {
      if (app.sim.getState().phase === 'victory' || app.sim.getState().phase === 'defeat') {
        break;
      }
      const stepRes = app.sim.tick();
      const events = app.sim.drainEvents();
      app.blockouts.syncFromSim(stepRes.state, events, 1 / 60);
    }
  });

  // Let the real animation frame loop transition app.state to 'victory' and present MissionOverlay
  await page.waitForFunction(
    () => {
      const app = window.__riftBastionApp;
      const overlayEl = document.querySelector('section[data-mission-overlay="dom"]');
      return (
        app?.state.phase === 'victory' &&
        app.missionOverlay.visible === true &&
        overlayEl instanceof HTMLElement &&
        !overlayEl.hidden
      );
    },
    undefined,
    { timeout: 10000 },
  );

  const victoryOverlaySnap = await page.evaluate(() => {
    const app = window.__riftBastionApp;
    const overlayState = app?.missionOverlay.state;
    const titleEl = document.querySelector('[data-mission="outcome-title"]');
    const newBestEl = document.querySelector('[data-mission="new-best"]');
    const starsEl = document.querySelector('[data-mission="stars"]');
    const scoreEl = document.querySelector('[data-mission="score"]');
    const wavesEl = document.querySelector('[data-mission="waves-cleared"]');
    return {
      phase: app?.state.phase ?? null,
      victory: overlayState?.victory ?? false,
      score: overlayState?.score ?? 0,
      wavesCleared: overlayState?.wavesCleared ?? 0,
      stars: overlayState?.stars ?? 0,
      isNewBest: overlayState?.isNewBest ?? false,
      titleText: titleEl?.textContent ?? '',
      newBestText: newBestEl?.textContent ?? '',
      newBestVisible: newBestEl instanceof HTMLElement ? !newBestEl.hidden : false,
      starsText: starsEl?.textContent ?? '',
      scoreText: scoreEl?.textContent ?? '',
      wavesText: wavesEl?.textContent ?? '',
    };
  });
  await snap('06-desktop-victory-overlay.jpg');

  record(
    'desktop-victory-overlay-stars-new-best',
    victoryOverlaySnap.phase === 'victory' &&
      victoryOverlaySnap.victory === true &&
      victoryOverlaySnap.score > 0 &&
      victoryOverlaySnap.wavesCleared === 12 &&
      victoryOverlaySnap.stars >= 1 &&
      victoryOverlaySnap.isNewBest === true &&
      victoryOverlaySnap.titleText.includes('VICTORY') &&
      victoryOverlaySnap.newBestVisible === true &&
      victoryOverlaySnap.newBestText === 'NEW BEST' &&
      victoryOverlaySnap.starsText.includes('★') &&
      victoryOverlaySnap.wavesText === '12 / 12',
    victoryOverlaySnap,
  );

  // =========================================================================
  // 5. Reload page and verify IndexedDB persisted `bestScore`,
  //    `highestWaveCleared === 12`, and stars; test JSON export & import
  // =========================================================================
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__riftBastionApp), undefined, { timeout: 15000 });

  const idbRoundTrip = await page.evaluate(async (expectedVictory) => {
    const app = window.__riftBastionApp;
    if (!app) throw new Error('Missing app after reload');
    await app.persist.init();

    const backendMode = app.persist.getBackendMode();
    const persistedAfterReload = await app.persist.loadMissionRecords();

    // 1. Export validated backup JSON
    const exportedJson = await app.missionOverlay.exportBackup();
    const parsedExport = JSON.parse(exportedJson) as {
      app: string;
      schemaVersion: number;
      missionRecords: {
        bestScore: number;
        highestWaveCleared: number;
        bestStars: number;
      };
    };

    // 2. Verify corrupt JSON is rejected without clobbering IndexedDB data
    let corruptRejected = false;
    try {
      await app.missionOverlay.importBackup('{"app":"rift-bastion","schemaVersion":999}');
    } catch {
      corruptRejected = true;
    }
    const afterCorruptAttempt = await app.persist.loadMissionRecords();

    // 3. Clear mission records, verify zeroed, then import backup JSON and verify restoration
    await app.persist.clearMissionRecords();
    const clearedRecords = await app.persist.loadMissionRecords();

    const importedPayload = await app.missionOverlay.importBackup(exportedJson);
    const restoredRecords = await app.persist.loadMissionRecords();

    return {
      backendMode,
      persistedAfterReload: {
        bestScore: persistedAfterReload.bestScore,
        highestWaveCleared: persistedAfterReload.highestWaveCleared,
        bestStars: persistedAfterReload.bestStars,
        totalRuns: persistedAfterReload.totalRuns,
        victories: persistedAfterReload.victories,
        recentRunsCount: persistedAfterReload.recentRuns.length,
      },
      exportValid:
        parsedExport.app === 'rift-bastion' &&
        parsedExport.schemaVersion === 1 &&
        parsedExport.missionRecords.bestScore === expectedVictory.score &&
        parsedExport.missionRecords.highestWaveCleared === 12,
      corruptRejected,
      unclobberedBestScore: afterCorruptAttempt.bestScore,
      clearedBestScore: clearedRecords.bestScore,
      clearedHighestWave: clearedRecords.highestWaveCleared,
      restored: {
        bestScore: restoredRecords.bestScore,
        highestWaveCleared: restoredRecords.highestWaveCleared,
        bestStars: restoredRecords.bestStars,
        importedBestScore: importedPayload.missionRecords.bestScore,
      },
    };
  }, victoryOverlaySnap);

  record(
    'desktop-indexeddb-persist-and-json-roundtrip',
    idbRoundTrip.backendMode === 'indexeddb' &&
      idbRoundTrip.persistedAfterReload.bestScore === victoryOverlaySnap.score &&
      idbRoundTrip.persistedAfterReload.highestWaveCleared === 12 &&
      idbRoundTrip.persistedAfterReload.bestStars === victoryOverlaySnap.stars &&
      idbRoundTrip.persistedAfterReload.victories >= 1 &&
      idbRoundTrip.persistedAfterReload.recentRunsCount >= 1 &&
      idbRoundTrip.exportValid &&
      idbRoundTrip.corruptRejected &&
      idbRoundTrip.unclobberedBestScore === victoryOverlaySnap.score &&
      idbRoundTrip.clearedBestScore === 0 &&
      idbRoundTrip.clearedHighestWave === 0 &&
      idbRoundTrip.restored.bestScore === victoryOverlaySnap.score &&
      idbRoundTrip.restored.highestWaveCleared === 12 &&
      idbRoundTrip.restored.bestStars === victoryOverlaySnap.stars,
    idbRoundTrip,
  );

  // =========================================================================
  // 6. Zero console/page errors
  // =========================================================================
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
  suite: 'p2-desktop-campaign',
  timestamp: new Date().toISOString(),
  buildId,
  gpu,
  seed: 4242,
  passed,
  checks,
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
