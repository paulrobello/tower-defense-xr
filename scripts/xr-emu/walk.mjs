#!/usr/bin/env bun
// Emulated-XR P0 verification walk: serves the isolated `dist-iwer` build on port 4273 (or a free
// fallback port), launches headless Chromium on the real GPU via `e2e/gpu-args.ts`, injects Meta's
// IWER Quest 3 runtime + `page-hooks.js`, verifies desktop shell / Settings / `?perf` / immersive
// `immersive-ar` entry + foveation/scale + clean exit, and writes a JSON report + screenshots to
// `output/xr-emu/p0/`.
//
// Emulator evidence only: IWER renders stereo into the page canvas without applying real Quest 3
// compositor foveation or framebuffer scaling. Physical Quest 3 headset acceptance remains separate.
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
    out: { type: 'string', default: join(root, 'output/xr-emu/p0') },
    port: { type: 'string', default: '4273' },
    headed: { type: 'boolean', default: false },
  },
});

const SEATED_HEAD_Y = 1.2;
const EXPECTED_OPTIONAL_FEATURES = [
  'plane-detection',
  'mesh-detection',
  'depth-sensing',
  'anchors',
  'local-floor',
];
const EXPECTED_FRAMEBUFFER_SCALE = 1.15;
const EXPECTED_FOVEATION = 0.5;

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
    tryListen(preferredPort, true);
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
  Number.isFinite(preferredPort) ? preferredPort : 4273,
);
console.log(`Serving ${distDir} at ${staticServer.baseUrl}`);

const browser = await chromium.launch(getGpuLaunchOptions({ headless: !opts.headed }));
let gpu = null;
let buildId = null;
let xrCapture = null;

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript({ content: `${iwerUmd}\n${pageHooks}` });
  await context.addInitScript(() => {
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      const result = start.apply(this, args);
      if (this.loop && this.buffer) {
        const samples = this.buffer.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < samples.length; i += 257) {
          peak = Math.max(peak, Math.abs(samples[i]));
        }
        window.__previewMusicPlayback = {
          duration: this.buffer.duration,
          running: this.context.state === 'running',
          peak,
        };
      }
      return result;
    };
  });
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

  // 1. Desktop boot + GPU guard
  await page.goto(`${staticServer.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__riftBastionApp), undefined, { timeout: 15000 });

  gpu = assertRealGpu(await probeGpu(page));
  console.log(`UNMASKED_RENDERER_WEBGL: ${gpu.renderer}`);
  record('gpu-real-renderer', true, gpu);

  buildId = await page.evaluate(() => window.__APP_BUILD ?? null);

  // Wait for XR support probe to enable the Enter Mixed Reality button.
  const enterXrBtn = page.getByRole('button', { name: 'Enter Mixed Reality (Quest 3)' });
  const playDesktopBtn = page.getByRole('button', { name: 'Play Desktop' });
  const settingsBtn = page.getByRole('button', { name: 'Settings' });

  await page.waitForFunction(
    () => {
      const btn = document.querySelector('button[data-control="enter-xr"]');
      return btn instanceof HTMLButtonElement && !btn.disabled;
    },
    undefined,
    { timeout: 15000 },
  );

  const overlayChecks = {
    enterVisible: await enterXrBtn.isVisible(),
    enterEnabled: await enterXrBtn.isEnabled(),
    playDesktopVisible: await playDesktopBtn.isVisible(),
    settingsVisible: await settingsBtn.isVisible(),
    perfBadgeInitiallyHidden: !(await page.locator('[data-perf-badge="desktop"]').isVisible()),
  };
  record('desktop-launch-overlay', Object.values(overlayChecks).every(Boolean), overlayChecks);
  await snap('01-desktop-launch.jpg');

  // 2. Settings toggle (Show FPS, Play Arc, Room Occlusion) + persistence
  await settingsBtn.click();
  const settingsDialog = page.locator('[data-settings-panel="dom"]');
  await settingsDialog.waitFor({ state: 'visible', timeout: 5000 });

  const showFpsCheckbox = settingsDialog.locator('[data-setting-key="showFps"]');
  const playArcSelect = settingsDialog.locator('[data-setting-key="playArc"]');
  const occlusionSelect = settingsDialog.locator('[data-setting-key="roomOcclusion"]');

  await showFpsCheckbox.check();
  await playArcSelect.selectOption('full-360');
  await occlusionSelect.selectOption('room-mesh');

  const settingsAfterToggle = await page.evaluate(() => {
    const s = window.__riftBastionApp?.settings.get();
    const badge = document.querySelector('[data-perf-badge="desktop"]');
    return {
      showFps: s?.showFps ?? null,
      playArc: s?.playArc ?? null,
      roomOcclusion: s?.roomOcclusion ?? null,
      badgeVisible: badge instanceof HTMLElement ? !badge.hidden : false,
    };
  });
  record(
    'desktop-settings-toggle',
    settingsAfterToggle.showFps === true &&
      settingsAfterToggle.playArc === 'full-360' &&
      settingsAfterToggle.roomOcclusion === 'room-mesh' &&
      settingsAfterToggle.badgeVisible === true,
    settingsAfterToggle,
  );
  await snap('02-desktop-settings.jpg');

  await settingsDialog.locator('[data-settings-action="done"]').click();
  await settingsDialog.waitFor({ state: 'hidden', timeout: 5000 });

  // Verify settings survive page reload.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__riftBastionApp), undefined, { timeout: 15000 });
  const persistedSettings = await page.evaluate(() => {
    const s = window.__riftBastionApp?.settings.get();
    return {
      showFps: s?.showFps ?? null,
      playArc: s?.playArc ?? null,
      roomOcclusion: s?.roomOcclusion ?? null,
    };
  });
  record(
    'desktop-settings-persist',
    persistedSettings.showFps === true &&
      persistedSettings.playArc === 'full-360' &&
      persistedSettings.roomOcclusion === 'room-mesh',
    persistedSettings,
  );

  // Reset settings to defaults so subsequent ?perf and XR checks start clean.
  await page.getByRole('button', { name: 'Settings' }).click();
  await settingsDialog.waitFor({ state: 'visible', timeout: 5000 });
  await settingsDialog.locator('[data-settings-action="reset"]').click();
  await settingsDialog.locator('[data-settings-action="done"]').click();
  await settingsDialog.waitFor({ state: 'hidden', timeout: 5000 });

  // 3. `?perf` badge readout
  await page.goto(`${staticServer.baseUrl}/?perf`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__riftBastionApp), undefined, { timeout: 15000 });
  await page.waitForFunction(
    () => {
      const badge = document.querySelector('[data-perf-badge="desktop"]');
      if (!(badge instanceof HTMLElement) || badge.hidden) return false;
      const snapData = window.__riftBastionPerf?.snapshot() ?? null;
      const text = badge.textContent ?? '';
      return (
        (snapData?.stats.completeSeconds ?? 0) >= 1 &&
        /[1-9]\d*\s+FPS/.test(text) &&
        text.includes('draws') &&
        text.includes('p95')
      );
    },
    undefined,
    { timeout: 10000 },
  );
  const perfCheck = await page.evaluate(() => {
    const badge = document.querySelector('[data-perf-badge="desktop"]');
    const snapData = window.__riftBastionPerf?.snapshot() ?? null;
    const totalBuckets =
      (snapData?.seconds?.length ?? 0) +
      (snapData?.partialSeconds?.length ?? 0) +
      (snapData?.current ? 1 : 0);
    return {
      badgeVisible: badge instanceof HTMLElement ? !badge.hidden : false,
      badgeText: badge?.textContent ?? '',
      bucketCount: totalBuckets,
      completeSeconds: snapData?.stats.completeSeconds ?? 0,
      build: snapData?.build ?? null,
    };
  });
  record(
    'desktop-perf-badge',
    perfCheck.badgeVisible &&
      /[1-9]\d*\s+FPS/.test(perfCheck.badgeText) &&
      perfCheck.badgeText.includes('p95') &&
      perfCheck.badgeText.includes('draws') &&
      perfCheck.completeSeconds >= 1,
    perfCheck,
  );
  await snap('03-desktop-perf.jpg');

  // 4. Immersive `immersive-ar` entry via IWER at seated 1.2 m height
  await page.goto(`${staticServer.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('button[data-control="enter-xr"]');
      return Boolean(window.__riftBastionApp) && btn instanceof HTMLButtonElement && !btn.disabled;
    },
    undefined,
    { timeout: 15000 },
  );

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

  // Advance XR frames deterministically via session.requestAnimationFrame.
  const framesStepped = await page.evaluate(() => window.__xrEmu.frames(6));
  await page.waitForFunction(() => window.__previewMusicPlayback?.running);
  const musicPlayback = await page.evaluate(() => window.__previewMusicPlayback);
  record('xr-preview-music-started', musicPlayback.duration >= 8 && musicPlayback.peak >= 0.05, {
    ...musicPlayback,
  });
  await snap('04-xr-immersive-ar.jpg');

  xrCapture = await page.evaluate(() => {
    const emu = window.__xrEmu;
    const { renderer, app } = emu.ctx();
    const xrCamera = renderer?.xr.getCamera();
    xrCamera?.updateWorldMatrix(true, false);
    const camY = xrCamera ? xrCamera.matrixWorld.elements[13] : null;
    const lastRequest = emu.requests.at(-1) ?? null;
    const lastLayer = emu.layerInits.at(-1) ?? null;
    const lastFoveation = emu.foveationWrites.at(-1) ?? null;
    return {
      framesStepped: emu.passes.length,
      presenting: Boolean(renderer?.xr.isPresenting),
      deviceHeadY: emu.device.position.y,
      cameraWorldY: camY,
      lastRequest,
      lastLayer,
      foveationWrites: emu.foveationWrites,
      lastFoveation,
      overlayVisible: Boolean(app?.shell.overlay.visible),
      roomVisible: Boolean(app?.shell.room.visible),
      xrState: app?.shell.xr.state ?? null,
    };
  });

  record('xr-frames-stepped', framesStepped === 6 && xrCapture.presenting, {
    framesStepped,
    passesRecorded: xrCapture.framesStepped,
  });

  record('xr-session-mode', xrCapture.lastRequest?.mode === 'immersive-ar', {
    mode: xrCapture.lastRequest?.mode ?? null,
  });

  const requestedFeatures = xrCapture.lastRequest?.optionalFeatures ?? [];
  const missingFeatures = EXPECTED_OPTIONAL_FEATURES.filter((f) => !requestedFeatures.includes(f));
  record(
    'xr-optional-features',
    missingFeatures.length === 0 && xrCapture.lastRequest?.hasDepthSensing === true,
    {
      requested: requestedFeatures,
      missing: missingFeatures,
      hasDepthSensing: xrCapture.lastRequest?.hasDepthSensing ?? false,
    },
  );

  const scaleFactor = xrCapture.lastLayer?.framebufferScaleFactor ?? null;
  record(
    'xr-framebuffer-scale',
    typeof scaleFactor === 'number' && Math.abs(scaleFactor - EXPECTED_FRAMEBUFFER_SCALE) < 1e-6,
    {
      expected: EXPECTED_FRAMEBUFFER_SCALE,
      recorded: scaleFactor,
      layerInit: xrCapture.lastLayer,
    },
  );

  const foveationVal = xrCapture.lastFoveation?.value ?? null;
  const foveationCount = xrCapture.lastFoveation?.count ?? 0;
  record(
    'xr-fixed-foveation',
    typeof foveationVal === 'number' &&
      Math.abs(foveationVal - EXPECTED_FOVEATION) < 1e-6 &&
      foveationCount >= 2,
    {
      expected: EXPECTED_FOVEATION,
      recorded: foveationVal,
      writeCount: foveationCount,
      allWrites: xrCapture.foveationWrites,
    },
  );

  const seatedHeightOk =
    Math.abs(xrCapture.deviceHeadY - SEATED_HEAD_Y) < 1e-4 &&
    typeof xrCapture.cameraWorldY === 'number' &&
    Math.abs(xrCapture.cameraWorldY - SEATED_HEAD_Y) < 0.05;
  record('xr-seated-height', seatedHeightOk, {
    expectedY: SEATED_HEAD_Y,
    deviceHeadY: xrCapture.deviceHeadY,
    cameraWorldY: xrCapture.cameraWorldY,
  });

  record(
    'xr-passthrough-presentation',
    xrCapture.overlayVisible === false && xrCapture.roomVisible === false,
    {
      overlayVisible: xrCapture.overlayVisible,
      roomVisible: xrCapture.roomVisible,
    },
  );

  // 5. Clean XR session exit
  await page.evaluate(() => window.__riftBastionApp?.shell.xr.exit());
  await page.waitForFunction(
    () =>
      window.__xrEmu.session?.ended === true &&
      window.__riftBastionApp?.shell.xr.presenting === false,
    undefined,
    { timeout: 10000 },
  );

  const afterExit = await page.evaluate(() => ({
    sessionEnded: Boolean(window.__xrEmu.session?.ended),
    presenting: Boolean(window.__riftBastionApp?.shell.xr.presenting),
    overlayVisible: Boolean(window.__riftBastionApp?.shell.overlay.visible),
    roomVisible: Boolean(window.__riftBastionApp?.shell.room.visible),
  }));
  record(
    'xr-clean-exit',
    afterExit.sessionEnded &&
      !afterExit.presenting &&
      afterExit.overlayVisible &&
      afterExit.roomVisible,
    afterExit,
  );
  await snap('05-xr-after-exit.jpg');

  // 6. Zero console/page errors
  record('zero-console-errors', consoleErrors.length === 0, {
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
  timestamp: new Date().toISOString(),
  buildId,
  gpu,
  seatedHeightM: SEATED_HEAD_Y,
  passed,
  checks,
  xrCapture,
  screenshots,
  consoleErrors,
};

const reportPath = join(outDir, 'report.json');
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Report written to ${reportPath} (passed=${passed})`);

if (!passed) {
  process.exitCode = 1;
}
