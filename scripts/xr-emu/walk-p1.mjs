#!/usr/bin/env bun
// Emulated-XR P1 verification walk: serves the isolated `dist-iwer` build on an OS-assigned free
// port (`0` by default so parallel Playwright runs never collide on 4273), launches headless
// Chromium on the real GPU via `e2e/gpu-args.ts`, injects Meta's IWER Quest 3 runtime +
// `page-hooks.js`, exercises BOTH standing (`1.65 m`) and seated (`1.2 m`) poses across
// calibration, radial Build Wheel, floor/table/wall surface-clamp placement, thumbstick hover-pod
// detachment, TOO_CLOSE + CAP_REACHED (14/14) SDF invalid-reason labels, and Room Occlusion
// cycling (`auto-depth` -> `room-mesh` -> `off`) with portal aperture cutout verification.
//
// Emulator evidence only: IWER renders stereo into the page canvas without applying real Quest 3
// compositor foveation, framebuffer scaling, or hardware room tracking / depth sensing. Physical
// Quest 3 headset acceptance remains separate.
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
    out: { type: 'string', default: join(root, 'output/xr-emu/p1') },
    port: { type: 'string', default: '0' },
    headed: { type: 'boolean', default: false },
  },
});

const SEATED_HEAD_Y = 1.2;
const STANDING_HEAD_Y = 1.65;
const PLAYER_Z = 1.45;
const HARD_TURRET_CAP = 14;

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

function listenOnPort(server, port) {
  return new Promise((resolvePort, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
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
  });
}

function startStaticServer(directory, requestedPort) {
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

  return listenOnPort(server, requestedPort).then((port) => ({
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

const requestedPort = Number.parseInt(opts.port, 10);
const staticServer = await startStaticServer(
  distDir,
  Number.isFinite(requestedPort) && requestedPort >= 0 ? requestedPort : 0,
);
console.log(`Serving ${distDir} at ${staticServer.baseUrl}`);

const browser = await chromium.launch(getGpuLaunchOptions({ headless: !opts.headed }));
let gpu = null;
let buildId = null;

async function createEmulatedPage(url) {
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

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('button[data-control="enter-xr"]');
      return Boolean(window.__riftBastionApp) && btn instanceof HTMLButtonElement && !btn.disabled;
    },
    undefined,
    { timeout: 15000 },
  );

  // Inject deterministic controller pose + ray helpers onto `window.__p1Helpers`.
  await page.evaluate(() => {
    function basisToQuat(xx, xy, xz, yx, yy, yz, zx, zy, zz) {
      const trace = xx + yy + zz;
      let x;
      let y;
      let z;
      let w;
      if (trace > 0) {
        const s = 0.5 / Math.sqrt(trace + 1);
        w = 0.25 / s;
        x = (yz - zy) * s;
        y = (zx - xz) * s;
        z = (xy - yx) * s;
      } else if (xx > yy && xx > zz) {
        const s = 2 * Math.sqrt(1 + xx - yy - zz);
        w = (yz - zy) / s;
        x = 0.25 * s;
        y = (yx + xy) / s;
        z = (zx + xz) / s;
      } else if (yy > zz) {
        const s = 2 * Math.sqrt(1 + yy - xx - zz);
        w = (zx - xz) / s;
        x = (yx + xy) / s;
        y = 0.25 * s;
        z = (zy + yz) / s;
      } else {
        const s = 2 * Math.sqrt(1 + zz - xx - yy);
        w = (xy - yx) / s;
        x = (zx + xz) / s;
        y = (zy + yz) / s;
        z = 0.25 * s;
      }
      const len = Math.hypot(x, y, z, w) || 1;
      return { x: x / len, y: y / len, z: z / len, w: w / len };
    }

    function lookQuatMinusZ(origin, target) {
      let dx = target.x - origin.x;
      let dy = target.y - origin.y;
      let dz = target.z - origin.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len;
      dy /= len;
      dz /= len;

      // Local +Z = -dir
      const zx = -dx;
      const zy = -dy;
      const zz = -dz;

      // World up reference
      const upX = Math.abs(dy) > 0.98 ? 1 : 0;
      const upY = Math.abs(dy) > 0.98 ? 0 : 1;
      const upZ = 0;

      // Local +X = normalize(cross(up, zAxis))
      let xx = upY * zz - upZ * zy;
      let xy = upZ * zx - upX * zz;
      let xz = upX * zy - upY * zx;
      const xLen = Math.hypot(xx, xy, xz) || 1;
      xx /= xLen;
      xy /= xLen;
      xz /= xLen;

      // Local +Y = cross(zAxis, xAxis)
      const yx = zy * xz - zz * xy;
      const yy = zz * xx - zx * xz;
      const yz = zx * xy - zy * xx;

      return basisToQuat(xx, xy, xz, yx, yy, yz, zx, zy, zz);
    }

    window.__p1Helpers = {
      async dragWidget(widget, handleName) {
        const handle = widget.getObjectByName(handleName);
        if (!handle) throw new Error(`Missing grab handle ${handleName}`);
        const controller = window.__xrEmu.device.controllers.right;
        const head = window.__xrEmu.device.position;
        const target = handle.getWorldPosition(handle.position.clone());
        const start = widget.getWorldPosition(widget.position.clone());
        this.aimController('right', { x: head.x + 0.2, y: head.y - 0.23, z: head.z }, target);
        await window.__xrEmu.frames(3);
        controller.updateButtonValue('squeeze', 1);
        await window.__xrEmu.frames(3);
        controller.position.x += 0.18;
        controller.position.y += 0.13;
        await window.__xrEmu.frames(3);
        await this.pressButton('right', 'trigger');
        const moved = widget.getWorldPosition(widget.position.clone());
        controller.updateButtonValue('squeeze', 0);
        await window.__xrEmu.frames(3);
        controller.position.x += 0.15;
        await window.__xrEmu.frames(3);
        const released = widget.getWorldPosition(widget.position.clone());
        return (
          Math.abs(moved.x - start.x - 0.18) < 0.02 &&
          Math.abs(moved.y - start.y - 0.13) < 0.02 &&
          released.distanceTo(moved) < 0.005
        );
      },
      async aimControl(name) {
        const app = window.__riftBastionApp;
        const control = app.shell.xrOverlayRoot.getObjectByName(name);
        if (!control) throw new Error(`Missing XR control ${name}`);
        const target = control.getWorldPosition(control.position.clone());
        const head = window.__xrEmu.device.position;
        this.aimController('right', { x: head.x + 0.2, y: head.y - 0.23, z: head.z }, target);
        await window.__xrEmu.frames(3);
      },
      async pressControl(name) {
        await this.aimControl(name);
        await this.pressButton('right', 'trigger', 2, 3);
      },
      setHeadPose(x, y, z, pitch = 0, yaw = 0) {
        const device = window.__xrEmu.device;
        device.position.set(x, y, z);
        const sp = Math.sin(pitch / 2);
        const cp = Math.cos(pitch / 2);
        const sy = Math.sin(yaw / 2);
        const cy = Math.cos(yaw / 2);
        device.quaternion.set(cy * sp, sy * cp, -sy * sp, cy * cp);
      },
      aimController(hand, origin, target) {
        const ctrl = window.__xrEmu.device.controllers[hand];
        if (!ctrl) throw new Error(`Missing IWER ${hand} controller`);
        ctrl.position.set(origin.x, origin.y, origin.z);
        const q = lookQuatMinusZ(origin, target);
        ctrl.quaternion.set(q.x, q.y, q.z, q.w);
      },
      async pressButton(hand, buttonId, holdFrames = 2, releaseFrames = 2) {
        const ctrl = window.__xrEmu.device.controllers[hand];
        if (!ctrl) throw new Error(`Missing IWER ${hand} controller`);
        ctrl.updateButtonValue(buttonId, 1);
        await window.__xrEmu.frames(holdFrames);
        ctrl.updateButtonValue(buttonId, 0);
        await window.__xrEmu.frames(releaseFrames);
      },
      setStick(hand, x, y) {
        const ctrl = window.__xrEmu.device.controllers[hand];
        if (!ctrl) throw new Error(`Missing IWER ${hand} controller`);
        ctrl.updateAxes('thumbstick', x, y);
      },
    };
  });

  return { context, page };
}

async function snap(page, filename) {
  const filePath = join(outDir, filename);
  await page.screenshot({ path: filePath, type: 'jpeg', quality: 85 });
  screenshots.push(filePath);
  console.log(`  screenshot ${filePath}`);
}

try {
  // =========================================================================
  // PASS 1: STANDING (1.65 m) — Calibration Core suggestion -> full-360 -> Lock
  // =========================================================================
  const standingSession = await createEmulatedPage(`${staticServer.baseUrl}/?debug`);
  try {
    const { page } = standingSession;

    gpu = assertRealGpu(await probeGpu(page));
    console.log(`UNMASKED_RENDERER_WEBGL: ${gpu.renderer}`);
    record('gpu-real-renderer', true, gpu);

    buildId = await page.evaluate(() => window.__APP_BUILD ?? null);

    await page.evaluate(
      ({ y, z }) => {
        window.__p1Helpers.setHeadPose(0, y, z, -0.15, 0);
      },
      { y: STANDING_HEAD_Y, z: PLAYER_Z },
    );

    await page.getByRole('button', { name: 'Enter Mixed Reality (Quest 3)' }).click();
    await page.waitForFunction(
      () =>
        window.__xrEmu.ctx().renderer?.xr.isPresenting === true &&
        window.__riftBastionApp?.shell.xr.presenting === true,
      undefined,
      { timeout: 15000 },
    );
    await page.evaluate(() => window.__xrEmu.frames(6));
    await snap(page, '01-xr-standing-calibrate.jpg');

    const standingCalib = await page.evaluate(() => {
      const app = window.__riftBastionApp;
      const emu = window.__xrEmu;
      const xrCam = emu.ctx().renderer?.xr.getCamera();
      xrCam?.updateWorldMatrix(true, false);
      const camY = xrCam ? xrCam.matrixWorld.elements[13] : null;
      const st = app.calibration.state;
      const horizDist = Math.hypot(
        st.coreAnchor.position.x - st.headsetPose.position.x,
        st.coreAnchor.position.z - st.headsetPose.position.z,
      );
      return {
        phase: app.state.phase,
        deviceHeadY: emu.device.position.y,
        cameraWorldY: camY,
        headsetPoseY: st.headsetPose.position.y,
        posture: st.posture,
        playArc: st.playArc,
        isValid: st.isValid,
        coreSurfaceKind: st.coreAnchor.surfaceKind,
        coreSurfaceId: st.coreAnchor.surfaceId,
        corePos: st.coreAnchor.position,
        coreHorizDistM: Number(horizDist.toFixed(3)),
        portalCount: st.portalAnchors.length,
        duplicatePortalPreview: Boolean(
          app.shell.scene.getObjectByName('calibration-portal-frames'),
        ),
        mountedRiftsInRoom: st.portalAnchors
          .filter((portal) => portal.hostKind !== 'virtual-rift')
          .every((portal) => {
            const rendered = app.blockouts.portals.get(portal.id)?.group.position;
            if (!rendered) return false;
            return (
              (rendered.x - portal.position.x) * portal.normal.x +
                (rendered.y - portal.position.y) * portal.normal.y +
                (rendered.z - portal.position.z) * portal.normal.z >
              0.06
            );
          }),
        minPortalDistM: Number(
          Math.min(...st.portalAnchors.map((p) => p.distanceFromCore)).toFixed(3),
        ),
      };
    });

    record(
      'xr-standing-calibration',
      standingCalib.phase === 'calibrate' &&
        Math.abs(standingCalib.cameraWorldY - STANDING_HEAD_Y) < 0.05 &&
        standingCalib.posture === 'standing' &&
        standingCalib.playArc === 'full-360' &&
        standingCalib.isValid === true &&
        standingCalib.coreHorizDistM >= 1.2 &&
        standingCalib.coreHorizDistM <= 1.8 &&
        standingCalib.portalCount >= 2 &&
        !standingCalib.duplicatePortalPreview &&
        standingCalib.mountedRiftsInRoom &&
        standingCalib.minPortalDistM >= 2.0,
      standingCalib,
    );

    const standingLocked = await page.evaluate(async () => {
      const app = window.__riftBastionApp;
      const initialCore = { ...app.calibration.coreAnchor.position };
      const initialGraph = app.nav;
      const controls = window.__p1Helpers;
      const head = window.__xrEmu.device.position;
      controls.aimController(
        'right',
        { x: head.x + 0.2, y: head.y - 0.23, z: head.z },
        { x: 0.9, y: 0, z: 0.25 },
      );
      await window.__xrEmu.frames(3);
      await controls.pressButton('right', 'trigger', 2, 3);
      const movedCore = Math.abs(app.calibration.coreAnchor.position.x - initialCore.x) > 0.2;
      const renderFollowedCore =
        Math.abs(
          app.blockouts.coreBastion.group.position.x - app.calibration.coreAnchor.position.x,
        ) < 0.01;
      const graphUnchangedWhileCalibrating = app.nav === initialGraph;
      await window.__p1Helpers.pressControl('tactical-hud-primary-action');
      return {
        movedCore,
        renderFollowedCore,
        graphUnchangedWhileCalibrating,
        graphMatchesCore: app.nav.corePosition.x === app.calibration.coreAnchor.position.x,
        phase: app.state.phase,
        locked: app.calibration.locked,
        playArc: app.calibration.playArc,
        portalCount: app.occlusion.getPortals().length,
      };
    });
    record(
      'xr-standing-lock-core',
      standingLocked.movedCore &&
        standingLocked.renderFollowedCore &&
        standingLocked.graphUnchangedWhileCalibrating &&
        standingLocked.graphMatchesCore &&
        standingLocked.phase === 'prep' &&
        standingLocked.locked === true &&
        standingLocked.playArc === 'full-360' &&
        standingLocked.portalCount >= 2,
      standingLocked,
    );
    await snap(page, '02-xr-standing-locked.jpg');

    await page.evaluate(() => window.__riftBastionApp?.shell.xr.exit());
    await page.waitForFunction(
      () =>
        window.__xrEmu.session?.ended === true &&
        window.__riftBastionApp?.shell.xr.presenting === false,
      undefined,
      { timeout: 10000 },
    );
  } finally {
    await standingSession.context.close();
  }

  // =========================================================================
  // PASS 2: SEATED (1.2 m) — Full P1 Walk (Calibration, Radial Menu, Surface
  // Placement, Hover-Pod, Invalid Rejections + SDF Labels, Occlusion Cycle)
  // =========================================================================
  const seatedSession = await createEmulatedPage(`${staticServer.baseUrl}/?debug`);
  try {
    const { page } = seatedSession;

    await page.evaluate(
      ({ y, z }) => {
        window.__p1Helpers.setHeadPose(0, y, z, -0.1, 0);
      },
      { y: SEATED_HEAD_Y, z: PLAYER_Z },
    );

    await page.getByRole('button', { name: 'Enter Mixed Reality (Quest 3)' }).click();
    await page.waitForFunction(
      () =>
        window.__xrEmu.ctx().renderer?.xr.isPresenting === true &&
        window.__riftBastionApp?.shell.xr.presenting === true,
      undefined,
      { timeout: 15000 },
    );
    await page.evaluate(() => window.__xrEmu.frames(6));
    await snap(page, '03-xr-seated-calibrate.jpg');

    // 1. Seated Calibration Core suggestion -> front-180 -> Lock Core
    const seatedCalib = await page.evaluate(() => {
      const app = window.__riftBastionApp;
      const emu = window.__xrEmu;
      const xrCam = emu.ctx().renderer?.xr.getCamera();
      xrCam?.updateWorldMatrix(true, false);
      const camY = xrCam ? xrCam.matrixWorld.elements[13] : null;
      const st = app.calibration.state;
      const horizDist = Math.hypot(
        st.coreAnchor.position.x - st.headsetPose.position.x,
        st.coreAnchor.position.z - st.headsetPose.position.z,
      );
      return {
        phase: app.state.phase,
        deviceHeadY: emu.device.position.y,
        cameraWorldY: camY,
        headsetPoseY: st.headsetPose.position.y,
        posture: st.posture,
        playArc: st.playArc,
        isValid: st.isValid,
        coreSurfaceKind: st.coreAnchor.surfaceKind,
        coreSurfaceId: st.coreAnchor.surfaceId,
        corePos: st.coreAnchor.position,
        coreHorizDistM: Number(horizDist.toFixed(3)),
        portalCount: st.portalAnchors.length,
        minPortalDistM: Number(
          Math.min(...st.portalAnchors.map((p) => p.distanceFromCore)).toFixed(3),
        ),
        portals: st.portalAnchors.map((p) => ({
          id: p.id,
          hostKind: p.hostKind,
          surfaceId: p.surfaceId,
          position: p.position,
          normal: p.normal,
        })),
      };
    });

    record(
      'xr-seated-calibration',
      seatedCalib.phase === 'calibrate' &&
        Math.abs(seatedCalib.cameraWorldY - SEATED_HEAD_Y) < 0.05 &&
        seatedCalib.posture === 'seated' &&
        seatedCalib.playArc === 'front-180' &&
        seatedCalib.isValid === true &&
        seatedCalib.coreHorizDistM >= 1.2 &&
        seatedCalib.coreHorizDistM <= 1.8 &&
        seatedCalib.portalCount >= 2 &&
        seatedCalib.minPortalDistM >= 2.0,
      {
        ...seatedCalib,
        portals: seatedCalib.portals.map((p) => ({
          id: p.id,
          hostKind: p.hostKind,
          surfaceId: p.surfaceId,
        })),
      },
    );

    const widgetDrag = await page.evaluate(async () => {
      const app = window.__riftBastionApp;
      const controls = window.__p1Helpers;
      app.settings.set('showFps', true);
      await window.__xrEmu.frames(4);
      const startingCore = app.calibration.coreAnchor;
      const hudMoved = await controls.dragWidget(app.tacticalHud.xrRoot, 'tactical-hud-settings');
      const settingsStayedClosed = !app.xrSettings.visible;
      await controls.pressControl('tactical-hud-settings');
      const settingsMoved = await controls.dragWidget(app.xrSettings.root, 'settings-close');
      const settingsStayedOpen = app.xrSettings.visible;
      await controls.pressControl('settings-close');
      const fpsMoved = await controls.dragWidget(app.perfHud.xrRoot, 'perf-hud-details');
      return {
        hudMoved,
        settingsMoved,
        fpsMoved,
        settingsStayedClosed,
        settingsStayedOpen,
        coreStayedPut: app.calibration.coreAnchor === startingCore,
        turretCount: app.placement.placedTurrets.length,
      };
    });
    const fpsClose = await page.evaluate(async () => {
      const app = window.__riftBastionApp;
      const controls = window.__p1Helpers;
      const wasVisible = app.perfHud.xrRoot.visible;
      const core = app.calibration.coreAnchor;
      await controls.pressControl('perf-gauge-close');
      const closed = !app.perfHud.xrRoot.visible && !app.settings.get().showFps;

      await controls.pressControl('tactical-hud-settings');
      await controls.pressControl('settings-show-fps');
      const reopened = app.perfHud.xrRoot.visible && app.settings.get().showFps;
      await controls.pressControl('perf-gauge-close');
      const closedFromSettings = !app.perfHud.xrRoot.visible && app.xrSettings.visible;
      await controls.pressControl('settings-close');
      return {
        wasVisible,
        closed,
        reopened,
        closedFromSettings,
        noWorldAction: app.calibration.coreAnchor === core && app.state.phase === 'calibrate',
      };
    });
    record(
      'xr-controller-closes-fps-widget-and-can-reopen',
      fpsClose.wasVisible &&
        fpsClose.closed &&
        fpsClose.reopened &&
        fpsClose.closedFromSettings &&
        fpsClose.noWorldAction,
      fpsClose,
    );
    record(
      'xr-grip-moves-widgets-without-trigger-actions',
      widgetDrag.hudMoved &&
        widgetDrag.settingsMoved &&
        widgetDrag.fpsMoved &&
        widgetDrag.settingsStayedClosed &&
        widgetDrag.settingsStayedOpen &&
        widgetDrag.coreStayedPut &&
        widgetDrag.turretCount === 0,
      widgetDrag,
    );

    const seatedLocked = await page.evaluate(async () => {
      const app = window.__riftBastionApp;
      await window.__p1Helpers.pressControl('tactical-hud-settings');
      const openedSettings = app.xrSettings.visible && !app.tacticalHud.xrRoot.visible;
      await window.__p1Helpers.pressControl('settings-close');
      const closedSettings = !app.xrSettings.visible && app.tacticalHud.xrRoot.visible;
      await window.__p1Helpers.pressControl('tactical-hud-primary-action');
      for (let i = 0; i < 25 * 60; i += 1) app.sim.tick();
      return {
        openedSettings,
        closedSettings,
        phase: app.state.phase,
        locked: app.calibration.locked,
        waveAfter25Seconds: app.sim.getState().currentWave,
        playArc: app.calibration.playArc,
      };
    });
    record(
      'xr-seated-lock-core',
      seatedLocked.openedSettings === true &&
        seatedLocked.closedSettings === true &&
        seatedLocked.phase === 'prep' &&
        seatedLocked.locked === true &&
        seatedLocked.waveAfter25Seconds === 0,
      seatedLocked,
    );

    // 2. Open thumbstick radial Build Wheel -> select turret -> place surface-clamp on floor, table, wall
    const radialOpen = await page.evaluate(async () => {
      const app = window.__riftBastionApp;
      const origin = { x: 0.25, y: 0.98, z: 1.15 };
      // Aim into open space above the table so Build Wheel (not Turret Command Wheel) opens.
      window.__p1Helpers.aimController('right', origin, { x: 0, y: 1.4, z: -1.5 });
      window.__p1Helpers.setStick('right', 0, 0);
      await window.__xrEmu.frames(2);
      await window.__p1Helpers.pressButton('right', 'thumbstick', 2, 2);

      // Step XR frames until the radial open animation settles (~640 ms).
      for (let i = 0; i < 60 && !app.radialControls.interactive; i += 1) {
        await window.__xrEmu.frames(2);
      }
      // Tilt stick straight up (WebXR y = -0.9) to highlight top wedge ('build:autocannon').
      window.__p1Helpers.setStick('right', 0, -0.9);
      await window.__xrEmu.frames(4);

      return {
        isOpen: app.radialControls.isOpen,
        interactive: app.radialControls.interactive,
        context: app.radialControls.context,
        itemIds: app.radialControls.items.map((item) => item.id),
        hoveredAction: app.radialControls.hoveredAction,
      };
    });
    await snap(page, '04-xr-radial-build-wheel.jpg');
    record(
      'xr-radial-build-wheel-open',
      radialOpen.isOpen === true &&
        radialOpen.interactive === true &&
        radialOpen.context === 'build' &&
        radialOpen.hoveredAction === 'build:autocannon',
      radialOpen,
    );

    const radialSelect = await page.evaluate(async () => {
      const app = window.__riftBastionApp;
      // Pull and release trigger while hovering 'build:autocannon'.
      await window.__p1Helpers.pressButton('right', 'trigger', 2, 3);
      window.__p1Helpers.setStick('right', 0, 0);
      await window.__xrEmu.frames(3);
      return {
        radialClosed: !app.radialControls.isOpen,
        placementActive: app.placement.state.active,
        selectedKind: app.placement.selectedKind,
        mountMode: app.placement.mountMode,
      };
    });
    record(
      'xr-radial-select-turret',
      radialSelect.radialClosed === true &&
        radialSelect.placementActive === true &&
        radialSelect.selectedKind === 'autocannon' &&
        radialSelect.mountMode === 'surface-clamp',
      radialSelect,
    );

    // Helper inside page to aim controller at target, verify validation, pull trigger, and inspect placed record.
    const surfacePlacements = await page.evaluate(async () => {
      const app = window.__riftBastionApp;
      const rightOrigin = { x: 0.25, y: 1.05, z: 1.1 };

      // Helper to pick a safe wall point >= 0.9 m away from all portals and >= 0.65 m from Core.
      const portals = app.calibration.portalAnchors;
      const core = app.calibration.coreAnchor.position;
      const wallCandidates = [
        { x: -2.4, y: 1.35, z: 0.6 },
        { x: -2.4, y: 1.35, z: -0.9 },
        { x: 2.4, y: 1.35, z: 0.6 },
        { x: -1.4, y: 1.35, z: -2.1 },
        { x: 1.4, y: 1.35, z: -2.1 },
      ];
      let chosenWallTarget = wallCandidates[0];
      for (const pt of wallCandidates) {
        const minPortalDist = Math.min(
          ...portals.map((p) =>
            Math.hypot(p.position.x - pt.x, p.position.y - pt.y, p.position.z - pt.z),
          ),
        );
        const coreDist = Math.hypot(core.x - pt.x, core.y - pt.y, core.z - pt.z);
        if (minPortalDist >= 0.9 && coreDist >= 0.7) {
          chosenWallTarget = pt;
          break;
        }
      }

      app.debugGrantCredits(100);
      const targets = [
        { label: 'floor', expectedKind: 'floor', point: { x: -0.9, y: 0.0, z: -0.55 } },
        { label: 'table', expectedKind: 'table', point: { x: 1.6, y: 0.74, z: 0.0 } },
        { label: 'wall', expectedKind: 'wall', point: chosenWallTarget },
        { label: 'ceiling', expectedKind: 'ceiling', point: { x: 1.25, y: 2.8, z: 0.55 } },
      ];

      function rotateYByQuat(q) {
        // Local +Y = (0, 1, 0) rotated by unit quaternion q
        return {
          x: 2 * (q.x * q.y - q.w * q.z),
          y: 1 - 2 * (q.x * q.x + q.z * q.z),
          z: 2 * (q.y * q.z + q.w * q.x),
        };
      }

      const results = [];
      for (const target of targets) {
        const beforeCount = app.placement.turretCount;
        window.__p1Helpers.setStick('right', 0, 0);
        window.__p1Helpers.aimController('right', rightOrigin, target.point);
        await window.__xrEmu.frames(4);

        const preValidation = app.placement.lastValidation;
        await window.__p1Helpers.pressButton('right', 'trigger', 2, 3);
        await window.__xrEmu.frames(2);

        const afterCount = app.placement.turretCount;
        const placed = app.placement.placedTurrets.at(-1) ?? null;
        const surface = placed?.surfaceId ? app.roomModel.getSurface(placed.surfaceId) : null;
        const anchor = placed?.surfaceAnchor
          ? app.roomModel.getAnchor(placed.surfaceAnchor.id)
          : null;
        const simTurret = placed
          ? (app.sim.getState().turrets.find((t) => t.id === placed.id) ?? null)
          : null;

        let normalDot = null;
        if (placed && surface) {
          const up = rotateYByQuat(placed.quaternion);
          normalDot = Number(
            (up.x * surface.normal.x + up.y * surface.normal.y + up.z * surface.normal.z).toFixed(
              4,
            ),
          );
        }

        results.push({
          label: target.label,
          expectedKind: target.expectedKind,
          preValid: preValidation?.valid ?? false,
          preReason: preValidation?.reason ?? null,
          placedNew: afterCount === beforeCount + 1,
          turretId: placed?.id ?? null,
          mountProfile: placed?.mountProfile ?? null,
          surfaceKind: placed?.surfaceKind ?? null,
          surfaceId: placed?.surfaceId ?? null,
          normalDot,
          hasAnchor: Boolean(anchor?.tracked),
          inSim: simTurret?.mountProfile === 'surface-clamp',
          position: placed?.position ?? null,
        });
      }
      return results;
    });

    await snap(page, '05-xr-surface-turrets.jpg');
    for (const res of surfacePlacements) {
      record(
        `xr-surface-clamp-${res.label}`,
        res.preValid === true &&
          res.placedNew === true &&
          res.mountProfile === 'surface-clamp' &&
          res.surfaceKind === res.expectedKind &&
          typeof res.normalDot === 'number' &&
          res.normalDot > 0.999 &&
          res.hasAnchor === true &&
          res.inSim === true,
        res,
      );
    }

    // 3. Push thumbstick to detach into hover-pod mode (0.8–5.0 m) & place mid-air hover-pod turret
    const hoverPreview = await page.evaluate(async () => {
      const app = window.__riftBastionApp;
      // Grant extra credits via ?debug so hover-pod and 14/14 cap tests are never credit-blocked.
      app.debugGrantCredits(3000);

      const rightOrigin = { x: 0.25, y: 1.05, z: 1.1 };
      window.__p1Helpers.aimController('right', rightOrigin, { x: -0.75, y: 1.45, z: -1.1 });
      await window.__xrEmu.frames(3);

      // Push thumbstick forward (WebXR y = -0.9 => pushPullStick = +0.9) to detach into hover-pod mode.
      window.__p1Helpers.setStick('right', 0, -0.9);
      await window.__xrEmu.frames(10);
      // The wall blocks the forward push. Trigger must not commit the hidden turret.
      const blockedReason = app.placement.lastValidation?.reason;
      const turretCount = app.placement.turretCount;
      await window.__p1Helpers.pressButton('right', 'trigger');
      const blockedCommit = app.placement.turretCount === turretCount;
      // Pull the hover pod in front of that wall until it enters a valid mid-air depth, then release.
      window.__p1Helpers.setStick('right', 0, 0.9);
      for (let i = 0; i < 45; i += 1) {
        await window.__xrEmu.frames(1);
        if (app.placement.lastValidation?.valid && app.placement.hoverDepthM <= 2.1) {
          break;
        }
      }
      window.__p1Helpers.setStick('right', 0, 0);
      await window.__xrEmu.frames(2);

      return {
        mountMode: app.placement.mountMode,
        hoverDepthM: Number(app.placement.hoverDepthM.toFixed(3)),
        valid: app.placement.lastValidation?.valid ?? false,
        reason: app.placement.lastValidation?.reason ?? null,
        blockedReason,
        blockedCommit,
        ghostHoverVisible: app.placement.ghost.hoverPodGroup.visible,
        ghostClampVisible: app.placement.ghost.clampMountGroup.visible,
      };
    });
    await snap(page, '06-xr-hover-pod-preview.jpg');
    record(
      'xr-hover-pod-detach',
      hoverPreview.mountMode === 'hover-pod' &&
        hoverPreview.hoverDepthM >= 0.8 &&
        hoverPreview.hoverDepthM <= 5.0 &&
        hoverPreview.valid === true &&
        hoverPreview.blockedReason === 'BLOCKED_BY_SURFACE' &&
        hoverPreview.blockedCommit &&
        hoverPreview.ghostHoverVisible === true &&
        hoverPreview.ghostClampVisible === false,
      hoverPreview,
    );

    const hoverPlaced = await page.evaluate(async () => {
      const app = window.__riftBastionApp;
      const beforeCount = app.placement.turretCount;
      await window.__p1Helpers.pressButton('right', 'trigger', 2, 3);
      await window.__xrEmu.frames(2);
      const afterCount = app.placement.turretCount;
      const placed = app.placement.placedTurrets.at(-1) ?? null;
      const simTurret = placed
        ? (app.sim.getState().turrets.find((t) => t.id === placed.id) ?? null)
        : null;
      return {
        placedNew: afterCount === beforeCount + 1,
        turretId: placed?.id ?? null,
        mountProfile: placed?.mountProfile ?? null,
        controllerMountMode: app.placement.mountMode,
        hasCoreLocalOffset: Boolean(placed?.coreLocalOffset),
        surfaceAnchorNull: placed?.surfaceAnchor === null,
        simMountProfile: simTurret?.mountProfile ?? null,
        position: placed?.position ?? null,
      };
    });
    record(
      'xr-hover-pod-place',
      hoverPlaced.placedNew === true &&
        hoverPlaced.mountProfile === 'hover-pod' &&
        hoverPlaced.controllerMountMode === 'hover-pod' &&
        hoverPlaced.hasCoreLocalOffset === true &&
        hoverPlaced.surfaceAnchorNull === true &&
        hoverPlaced.simMountProfile === 'hover-pod',
      hoverPlaced,
    );

    // 4a. Invalid placement rejection: TOO_CLOSE + explicit SDF reason label text
    const tooCloseCheck = await page.evaluate(async () => {
      const app = window.__riftBastionApp;
      // Press B button on right controller to re-snap from hover-pod to surface-clamp.
      await window.__p1Helpers.pressButton('right', 'b-button', 2, 2);

      const floorTurret = app.placement.placedTurrets.find((t) => t.surfaceKind === 'floor');
      const rightOrigin = { x: 0.25, y: 1.05, z: 1.1 };
      const closeTarget = {
        x: floorTurret.position.x + 0.08,
        y: floorTurret.position.y,
        z: floorTurret.position.z,
      };
      window.__p1Helpers.aimController('right', rightOrigin, closeTarget);
      await window.__xrEmu.frames(4);

      const countBefore = app.placement.turretCount;
      const validation = app.placement.lastValidation;
      const ghostState = app.placement.ghost.state;
      const labelMesh = app.placement.ghost.reasonLabel;
      const sdfText = labelMesh.userData?.labelTextObject?.text ?? null;
      const labelDataText = labelMesh.userData?.labelText ?? null;

      // Attempt trigger pull — must be rejected.
      await window.__p1Helpers.pressButton('right', 'trigger', 2, 2);
      const countAfter = app.placement.turretCount;

      return {
        mountMode: app.placement.mountMode,
        valid: validation?.valid ?? null,
        reason: validation?.reason ?? null,
        reasonLabel: validation?.reasonLabel ?? null,
        ghostReasonLabelText: ghostState.reasonLabelText,
        labelVisible: labelMesh.visible,
        labelDataText,
        sdfText,
        rejectedTrigger: countAfter === countBefore,
      };
    });
    await snap(page, '07-xr-invalid-too-close.jpg');
    record(
      'xr-invalid-too-close',
      tooCloseCheck.mountMode === 'surface-clamp' &&
        tooCloseCheck.valid === false &&
        tooCloseCheck.reason === 'TOO_CLOSE' &&
        tooCloseCheck.reasonLabel === 'TOO CLOSE' &&
        tooCloseCheck.ghostReasonLabelText === 'TOO CLOSE' &&
        tooCloseCheck.labelVisible === true &&
        tooCloseCheck.labelDataText === 'TOO CLOSE' &&
        tooCloseCheck.sdfText === 'TOO CLOSE' &&
        tooCloseCheck.rejectedTrigger === true,
      tooCloseCheck,
    );

    // 4b. Fill up to 14/14 turrets and test CAP_REACHED + explicit SDF label text
    const capCheck = await page.evaluate(async () => {
      const app = window.__riftBastionApp;
      const rightOrigin = { x: 0.25, y: 1.05, z: 1.1 };

      // Candidate well-spaced floor points across the 4.8 x 4.2 m arena (>= 0.45 m apart, away from Core).
      const floorGrid = [];
      for (const z of [-1.45, -1.0, -0.5, 0.0, 0.55, 1.05, 1.5]) {
        for (const x of [-1.85, -1.35, -0.85, 0.85, 1.35, 1.85]) {
          floorGrid.push({ x, y: 0, z });
        }
      }

      for (const pt of floorGrid) {
        if (app.placement.turretCount >= 14) break;
        window.__p1Helpers.aimController('right', rightOrigin, pt);
        await window.__xrEmu.frames(2);
        if (app.placement.lastValidation?.valid) {
          await window.__p1Helpers.pressButton('right', 'trigger', 2, 2);
        }
      }

      // Now aim at an open valid floor point while at 14/14 cap to trigger CAP_REACHED.
      let capTarget = null;
      const core = app.calibration.coreAnchor.position;
      for (const pt of floorGrid) {
        const minTurretDist = Math.min(
          ...app.placement.placedTurrets.map((t) =>
            Math.hypot(t.position.x - pt.x, t.position.y - pt.y, t.position.z - pt.z),
          ),
        );
        const coreDist = Math.hypot(core.x - pt.x, core.y - pt.y, core.z - pt.z);
        if (minTurretDist >= 0.45 && coreDist >= 0.7) {
          capTarget = pt;
          break;
        }
      }

      if (capTarget) {
        window.__p1Helpers.aimController('right', rightOrigin, capTarget);
        await window.__xrEmu.frames(4);
      }

      const countBefore = app.placement.turretCount;
      const simCountBefore = app.sim.getState().turrets.length;
      const validation = app.placement.lastValidation;
      const ghostState = app.placement.ghost.state;
      const labelMesh = app.placement.ghost.reasonLabel;
      const sdfText = labelMesh.userData?.labelTextObject?.text ?? null;
      const labelDataText = labelMesh.userData?.labelText ?? null;

      await window.__p1Helpers.pressButton('right', 'trigger', 2, 2);
      const countAfter = app.placement.turretCount;

      return {
        turretCount: countBefore,
        simTurretCount: simCountBefore,
        capTarget,
        valid: validation?.valid ?? null,
        reason: validation?.reason ?? null,
        reasonLabel: validation?.reasonLabel ?? null,
        ghostReasonLabelText: ghostState.reasonLabelText,
        labelVisible: labelMesh.visible,
        labelDataText,
        sdfText,
        rejectedTrigger: countAfter === countBefore,
      };
    });
    await snap(page, '08-xr-invalid-cap-14.jpg');
    record(
      'xr-invalid-cap-reached',
      capCheck.turretCount === HARD_TURRET_CAP &&
        capCheck.simTurretCount === HARD_TURRET_CAP &&
        capCheck.valid === false &&
        capCheck.reason === 'CAP_REACHED' &&
        capCheck.reasonLabel === 'CAP 14/14' &&
        capCheck.ghostReasonLabelText === 'CAP 14/14' &&
        capCheck.labelVisible === true &&
        capCheck.labelDataText === 'CAP 14/14' &&
        capCheck.sdfText === 'CAP 14/14' &&
        capCheck.rejectedTrigger === true,
      capCheck,
    );

    const worldScale = await page.evaluate(() => {
      const app = window.__riftBastionApp;
      const core = app.blockouts.coreBastion.group;
      const portals = [...app.blockouts.portals.values()];
      const turrets = [...app.blockouts.turrets.values()];
      const ghost = app.placement.ghost;
      const { x, y, z } = app.sim.getState().corePosition;
      return {
        core: core.scale.toArray(),
        coreAtAnchor: core.position.x === x && core.position.y === y && core.position.z === z,
        portals: portals.map((portal) => portal.group.scale.toArray()),
        turrets: turrets.map((turret) => turret.group.scale.toArray()),
        preview: ghost.group.getObjectByName('turret-ghost-body').scale.toArray(),
        hud: app.tacticalHud.xrRoot.scale.toArray(),
        settings: app.xrSettings.root.scale.toArray(),
      };
    });
    record(
      'xr-half-size-world-objects',
      worldScale.coreAtAnchor &&
        worldScale.portals.length > 0 &&
        worldScale.turrets.length > 0 &&
        [worldScale.core, worldScale.preview, ...worldScale.portals, ...worldScale.turrets].every(
          (scale) => scale.every((axis) => axis === 0.5),
        ) &&
        [worldScale.hud, worldScale.settings].every((scale) =>
          scale.every((axis) => Math.abs(axis - 1) < 1e-6),
        ),
      worldScale,
    );

    // 5. Exercise room-mesh fallback, GPU sensor data, and live switching via the XR controller.
    const occlusionStart = await page.evaluate(async () => {
      const app = window.__riftBastionApp;
      app.placement.cancelPlacement();
      await window.__p1Helpers.pressControl('tactical-hud-settings');
      await window.__p1Helpers.pressControl('settings-next');
      return {
        xrSettingsVisible: app.xrSettings.visible,
        settingMode: app.settings.get().roomOcclusion,
        requestedMode: app.occlusion.requestedMode,
        effectiveMode: app.occlusion.effectiveMode,
        label: app.xrSettings.root.getObjectByName('settings-room-occlusion')?.userData.labelText,
      };
    });
    record(
      'xr-occlusion-initial-auto-depth',
      occlusionStart.xrSettingsVisible === true &&
        occlusionStart.settingMode === 'auto-depth' &&
        occlusionStart.requestedMode === 'auto-depth' &&
        occlusionStart.effectiveMode === 'room-mesh' &&
        occlusionStart.label === 'Auto Depth · Room Mesh',
      occlusionStart,
    );

    const gpuDepth = await page.evaluate(async () => {
      const app = window.__riftBastionApp;
      const xr = app.shell.renderer.xr;
      const gl = app.shell.renderer.getContext();
      const binding = xr.getBinding();
      const texture = gl.createTexture();
      const priorTexture = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        gl.R32F,
        1,
        1,
        2,
        0,
        gl.RED,
        gl.FLOAT,
        new Float32Array([0.25, 0.35]),
      );
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, priorTexture);

      const transform = new XRRigidTransform();
      binding.getDepthInformation = (view) => ({
        texture,
        textureType: 'texture-array',
        imageIndex: view.eye === 'right' ? 1 : 0,
        width: 1,
        height: 1,
        normDepthBufferFromNormView: transform,
        rawValueToMeters: 1,
        depthNear: app.shell.xr.session.renderState.depthNear,
        depthFar: app.shell.xr.session.renderState.depthFar,
        isValid: true,
      });
      // The runtime owns its depth texture until XR ends, just as it would on the device.
      app.shell.xr.session.addEventListener('end', () => gl.deleteTexture(texture), { once: true });
      await window.__xrEmu.frames(3);
      return {
        mode: app.occlusion.effectiveMode,
        source: app.occlusion.state.depthSource,
        viewLayers: [0, 1].map((view) => app.occlusion.getViewDepthState(view)?.arrayLayer),
        roomMeshVisible: app.occlusion.roomMeshRoot.visible,
        automaticDepthVisible: xr.getDepthSensingMesh()?.visible,
        label: app.xrSettings.root.getObjectByName('settings-room-occlusion')?.userData.labelText,
      };
    });
    await snap(page, '09a-xr-occlusion-sensor.jpg');
    record(
      'xr-occlusion-auto-uses-stereo-gpu-sensor',
      gpuDepth.mode === 'depth-sensing' &&
        gpuDepth.source === 'gpu' &&
        gpuDepth.viewLayers[0] === 0 &&
        gpuDepth.viewLayers[1] === 1 &&
        gpuDepth.roomMeshVisible === false &&
        gpuDepth.automaticDepthVisible === false &&
        gpuDepth.label === 'Auto Depth · Sensor active',
      gpuDepth,
    );

    const occlusionRoomMesh = await page.evaluate(async () => {
      const app = window.__riftBastionApp;
      await window.__p1Helpers.pressControl('settings-room-occlusion');
      const activated = app.settings.get().roomOcclusion === 'room-mesh';

      // Pure ray-triangle intersection (Moller-Trumbore) against occluder mesh world triangles
      // to prove a genuine aperture hole exists at each portal center while surrounding wall exists.
      function rayHitsGeometry(origin, dir, positionAttr) {
        const eps = 1e-6;
        let hits = 0;
        for (let i = 0; i + 2 < positionAttr.count; i += 3) {
          const ax = positionAttr.getX(i);
          const ay = positionAttr.getY(i);
          const az = positionAttr.getZ(i);
          const bx = positionAttr.getX(i + 1);
          const by = positionAttr.getY(i + 1);
          const bz = positionAttr.getZ(i + 1);
          const cx = positionAttr.getX(i + 2);
          const cy = positionAttr.getY(i + 2);
          const cz = positionAttr.getZ(i + 2);

          const e1x = bx - ax;
          const e1y = by - ay;
          const e1z = bz - az;
          const e2x = cx - ax;
          const e2y = cy - ay;
          const e2z = cz - az;

          const hx = dir.y * e2z - dir.z * e2y;
          const hy = dir.z * e2x - dir.x * e2z;
          const hz = dir.x * e2y - dir.y * e2x;
          const a = e1x * hx + e1y * hy + e1z * hz;
          if (Math.abs(a) < eps) continue;
          const f = 1 / a;
          const sx = origin.x - ax;
          const sy = origin.y - ay;
          const sz = origin.z - az;
          const u = f * (sx * hx + sy * hy + sz * hz);
          if (u < -eps || u > 1 + eps) continue;

          const qx = sy * e1z - sz * e1y;
          const qy = sz * e1x - sx * e1z;
          const qz = sx * e1y - sy * e1x;
          const v = f * (dir.x * qx + dir.y * qy + dir.z * qz);
          if (v < -eps || u + v > 1 + eps) continue;

          const t = f * (e2x * qx + e2y * qy + e2z * qz);
          if (t > eps) hits += 1;
        }
        return hits;
      }

      const portals = app.occlusion.getPortals();
      const cutoutChecks = [];
      for (const portal of portals) {
        if (!portal.hostSurfaceId) continue;
        const mesh = app.occlusion.getOccluderMesh(portal.hostSurfaceId);
        if (!mesh) continue;
        const posAttr = mesh.geometry.getAttribute('position');
        const triCount = posAttr ? Math.floor(posAttr.count / 3) : 0;
        const n = portal.normal;
        const c = portal.center;

        // Ray straight through the portal aperture center must hit ZERO wall triangles.
        const rayDir = { x: -n.x, y: -n.y, z: -n.z };
        const centerOrigin = {
          x: c.x + n.x * 0.5,
          y: c.y + n.y * 0.5,
          z: c.z + n.z * 0.5,
        };
        const centerHits = posAttr ? rayHitsGeometry(centerOrigin, rayDir, posAttr) : -1;

        // Ray outside the portal radius (shifted along tangent within wall bounds) must hit wall.
        const refY = Math.abs(n.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
        let tx = refY.y * n.z - refY.z * n.y;
        let ty = refY.z * n.x - refY.x * n.z;
        let tz = refY.x * n.y - refY.y * n.x;
        const tLen = Math.hypot(tx, ty, tz) || 1;
        tx /= tLen;
        ty /= tLen;
        tz /= tLen;

        const offsetDist = portal.radius + 0.25;
        let outsideHits = 0;
        for (const sign of [1, -1]) {
          const rimOrigin = {
            x: centerOrigin.x + tx * offsetDist * sign,
            y: centerOrigin.y + ty * offsetDist * sign,
            z: centerOrigin.z + tz * offsetDist * sign,
          };
          outsideHits += posAttr ? rayHitsGeometry(rimOrigin, rayDir, posAttr) : 0;
        }

        const mat = mesh.material;
        const anchor = app.calibration.portalAnchors.find((entry) => entry.id === portal.id);
        const halfScale =
          portal.radiusX === anchor?.width / 4 && portal.radiusY === anchor?.height / 4;
        cutoutChecks.push({
          portalId: portal.id,
          hostSurfaceId: portal.hostSurfaceId,
          triCount,
          depthOnly: mat.colorWrite === false && mat.depthWrite === true,
          halfScale,
          centerHits,
          outsideHits,
        });
      }

      return {
        activated,
        settingMode: app.settings.get().roomOcclusion,
        requestedMode: app.occlusion.requestedMode,
        effectiveMode: app.occlusion.effectiveMode,
        roomMeshVisible: app.occlusion.roomMeshRoot.visible,
        occluderMeshCount: app.occlusion.state.occluderMeshCount,
        portalCount: portals.length,
        cutoutChecks,
      };
    });
    await snap(page, '09-xr-occlusion-room-mesh.jpg');
    record(
      'xr-occlusion-room-mesh-cutouts',
      occlusionRoomMesh.activated === true &&
        occlusionRoomMesh.settingMode === 'room-mesh' &&
        occlusionRoomMesh.requestedMode === 'room-mesh' &&
        occlusionRoomMesh.effectiveMode === 'room-mesh' &&
        occlusionRoomMesh.roomMeshVisible === true &&
        occlusionRoomMesh.portalCount >= 2 &&
        occlusionRoomMesh.cutoutChecks.length >= 2 &&
        occlusionRoomMesh.cutoutChecks.every(
          (c) =>
            c.triCount > 2 && c.depthOnly && c.halfScale && c.centerHits === 0 && c.outsideHits > 0,
        ),
      occlusionRoomMesh,
    );

    const occlusionOff = await page.evaluate(async () => {
      const app = window.__riftBastionApp;
      await window.__p1Helpers.pressControl('settings-room-occlusion');
      const activated = app.settings.get().roomOcclusion === 'off';
      await window.__p1Helpers.pressControl('settings-close');
      return {
        activated,
        settingMode: app.settings.get().roomOcclusion,
        requestedMode: app.occlusion.requestedMode,
        effectiveMode: app.occlusion.effectiveMode,
        roomMeshVisible: app.occlusion.roomMeshRoot.visible,
        automaticDepthVisible: app.shell.renderer.xr.getDepthSensingMesh()?.visible,
        shaderDepthEnabled: app.occlusion.uniforms.uRbOccEnabled.value,
        xrSettingsClosed: !app.xrSettings.visible,
      };
    });
    await snap(page, '10-xr-occlusion-off.jpg');
    record(
      'xr-occlusion-off',
      occlusionOff.activated === true &&
        occlusionOff.settingMode === 'off' &&
        occlusionOff.requestedMode === 'off' &&
        occlusionOff.effectiveMode === 'off' &&
        occlusionOff.roomMeshVisible === false &&
        occlusionOff.automaticDepthVisible === false &&
        occlusionOff.shaderDepthEnabled === 0 &&
        occlusionOff.xrSettingsClosed === true,
      occlusionOff,
    );

    const inputOwnership = await page.evaluate(async () => {
      const app = window.__riftBastionApp;
      const controls = window.__p1Helpers;
      const { device, frames } = window.__xrEmu;
      const right = device.controllers.right;
      app.settings.set('roomOcclusion', 'room-mesh');
      app.placement.cancelPlacement();
      const count = app.placement.turretCount;
      const stillPreparing = app.state.phase === 'prep' && app.sim.getState().currentWave === 0;
      const rays = app.shell.xrOverlayRoot.getObjectByName('rift-bastion-radial-rays');
      const idleBeamWitnesses = [];
      for (const x of [-2, 2]) {
        controls.aimController('right', { x: 0.25, y: 1.15, z: 1.2 }, { x, y: 0.5, z: -0.6 });
        await frames(3);
        const beam = rays
          .getObjectByName('placement-ray-right')
          ?.getObjectByName('placement-ray-beam');
        idleBeamWitnesses.push(
          Boolean(beam?.visible && beam.parent.visible && !beam.material.depthTest),
        );
      }

      // A press that starts in the room may not activate the HUD if the controller crosses it.
      app.placement.beginBuild('autocannon');
      await frames(3);
      right.updateButtonValue('trigger', 1);
      await frames(3);
      const noCommitOnPress = app.placement.turretCount === count;
      await controls.aimControl('tactical-hud-primary-action');
      right.updateButtonValue('trigger', 0);
      await frames(3);
      const crossedHudWithoutLaunch = app.state.phase === 'prep';
      await controls.pressControl('tactical-hud-primary-action');
      return {
        stillPreparing,
        idleBeamWitnesses,
        noCommitOnPress,
        crossedHudWithoutLaunch,
        deliberateLaunch: app.state.phase === 'wave' && app.sim.getState().currentWave === 1,
        turretCountUnchanged: app.placement.turretCount === count,
      };
    });
    record(
      'xr-visible-idle-rays-and-distinct-wave-launch',
      inputOwnership.stillPreparing &&
        inputOwnership.idleBeamWitnesses.every(Boolean) &&
        inputOwnership.noCommitOnPress &&
        inputOwnership.crossedHudWithoutLaunch &&
        inputOwnership.deliberateLaunch &&
        inputOwnership.turretCountUnchanged,
      inputOwnership,
    );
    const enemyScale = await page.evaluate(() => {
      const app = window.__riftBastionApp;
      const enemy = app.debugSpawnEnemy('skitter-crawler');
      return app.blockouts.enemies.get(enemy.id)?.group.scale.toArray() ?? null;
    });
    record('xr-half-size-enemies', enemyScale?.every((axis) => axis === 0.5) ?? false, {
      enemyScale,
    });
    await snap(page, '11-xr-room-mesh-controller-rays.jpg');

    // Clean XR session exit
    await page.evaluate(() => window.__riftBastionApp?.shell.xr.exit());
    await page.waitForFunction(
      () =>
        window.__xrEmu.session?.ended === true &&
        window.__riftBastionApp?.shell.xr.presenting === false,
      undefined,
      { timeout: 10000 },
    );
    record('xr-seated-clean-exit', true, { sessionEnded: true });
  } finally {
    await seatedSession.context.close();
  }

  // Zero console/page errors and zero failed HTTP requests
  record('zero-console-errors', consoleErrors.length === 0 && failedRequests.length === 0, {
    consoleErrorCount: consoleErrors.length,
    errors: consoleErrors,
    failedRequestCount: failedRequests.length,
    failedRequests,
  });
} finally {
  await browser.close();
  await staticServer.close();
}

const passed = checks.length > 0 && checks.every((c) => c.pass);
const report = {
  evidenceClass: 'emulator-evidence',
  phase: 'P1',
  disclaimer:
    'IWER Quest 3 emulator evidence only. IWER renders stereo into the page canvas and applies neither hardware fixed foveation, compositor framebuffer scaling, nor physical Quest 3 room tracking / depth sensing. Physical Quest 3 headset acceptance remains separate.',
  timestamp: new Date().toISOString(),
  buildId,
  gpu,
  serverPort: staticServer.port,
  posesTested: { seatedHeadY: SEATED_HEAD_Y, standingHeadY: STANDING_HEAD_Y },
  passed,
  passedCount: checks.filter((c) => c.pass).length,
  totalChecks: checks.length,
  checks,
  screenshots,
  consoleErrors,
  failedRequests,
};

const reportPath = join(outDir, 'report.json');
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(
  `Report written to ${reportPath} (passed=${passed}, ${report.passedCount}/${report.totalChecks})`,
);

if (!passed) {
  process.exitCode = 1;
}
