#!/usr/bin/env bun
/**
 * Real served production build A -> B upgrade verification.
 *
 * Spawns two real `vite build` production outputs with distinct embedded ids
 * (`RIFT_BASTION_BUILD_ID=0a0a0a0a0a0a` and `0b0b0b0b0b0b`), serves them over localhost, routes
 * `version.json` to B via Playwright `page.route` with `?version-poll=1`, and verifies:
 * 1. Desktop mode automatically reloads to adopt build B (preserving query params, hash fragment,
 *    and persisted user settings) with no stale notice.
 * 2. Immersive XR mode (via IWER) mounts the `Update: Reload` HUD control without auto-reloading,
 *    clears it on rollback to A, handles a simulated `session.end()` failure with `Update: Retry`,
 *    and ends the XR session cleanly before navigating to B when activated.
 */
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { assertRealGpu, getGpuLaunchOptions, probeGpu } from '../e2e/gpu-args.ts';

const BUILD_A_ID = '0a0a0a0a0a0a';
const BUILD_B_ID = '0b0b0b0b0b0b';
const SEATED_HEAD_Y = 1.2;

const root = resolve(import.meta.dirname, '..');

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

function runBuild(outDir: string, buildId: string): void {
  const proc = Bun.spawnSync(['bun', '--bun', 'vite', 'build', '--outDir', outDir], {
    cwd: root,
    env: {
      ...process.env,
      RIFT_BASTION_BUILD_ID: buildId,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `vite build (${buildId}) failed with exit ${proc.exitCode}:\n${proc.stdout.toString()}\n${proc.stderr.toString()}`,
    );
  }
}

function runPrepareAssets(): void {
  const proc = Bun.spawnSync(['bun', 'scripts/prepare-assets.ts'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `prepare-assets failed with exit ${proc.exitCode}:\n${proc.stdout.toString()}\n${proc.stderr.toString()}`,
    );
  }
}

interface SwitchableServer {
  readonly baseUrl: string;
  setRoot(dir: string): void;
  close(): Promise<void>;
}

async function startSwitchableServer(initialDir: string): Promise<SwitchableServer> {
  let currentDir = resolve(initialDir);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = resolve(currentDir, rel);
    if (filePath !== currentDir && !filePath.startsWith(`${currentDir}${sep}`)) {
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

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to resolve ephemeral server port');
  }

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    setRoot(dir: string) {
      currentDir = resolve(dir);
    },
    close() {
      return new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
    },
  };
}

await mkdir(join(root, '.local'), { recursive: true });
const tempRoot = await mkdtemp(join(root, '.local', 'build-upgrade-'));
const dirA = join(tempRoot, 'build-a');
const dirB = join(tempRoot, 'build-b');

let server: SwitchableServer | null = null;
let browser: Browser | null = null;

try {
  runPrepareAssets();
  console.log(`Building production build A (${BUILD_A_ID}) and build B (${BUILD_B_ID})...`);
  runBuild(dirA, BUILD_A_ID);
  runBuild(dirB, BUILD_B_ID);

  const manifestAJson = readFileSync(join(dirA, 'version.json'), 'utf8');
  const manifestBJson = readFileSync(join(dirB, 'version.json'), 'utf8');
  const manifestA = JSON.parse(manifestAJson) as { id: string };
  const manifestB = JSON.parse(manifestBJson) as { id: string };
  assert.equal(manifestA.id, BUILD_A_ID, 'Build A version.json id matches');
  assert.equal(manifestB.id, BUILD_B_ID, 'Build B version.json id matches');
  assert.notEqual(manifestA.id, manifestB.id, 'Build A and B ids must differ');

  server = await startSwitchableServer(dirA);
  browser = await chromium.launch(getGpuLaunchOptions({ headless: true }));

  const iwerUmd = readFileSync(join(root, 'node_modules/iwer/build/iwer.min.js'), 'utf8');
  const pageHooks = readFileSync(join(root, 'scripts/xr-emu/page-hooks.js'), 'utf8');

  let gpuLogged = false;

  for (const xr of [false, true]) {
    server.setRoot(dirA);
    let routedManifestJson = manifestAJson;

    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    if (xr) {
      await context.addInitScript({ content: `${iwerUmd}\n${pageHooks}` });
    }
    const page: Page = await context.newPage();

    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (error) => {
      consoleErrors.push(String(error));
    });

    await page.route('**/version.json*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        headers: { 'Cache-Control': 'no-store' },
        body: routedManifestJson,
      });
    });

    await page.goto(`${server.baseUrl}/?version-poll=1&preserve=1#preserve-fragment`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => Boolean(window.__riftBastionApp), undefined, {
      timeout: 15000,
    });

    if (!gpuLogged) {
      const gpu = assertRealGpu(await probeGpu(page));
      console.log(`UNMASKED_RENDERER_WEBGL: ${gpu.renderer}`);
      gpuLogged = true;
    }

    const initialBuild = await page.evaluate(() => window.__APP_BUILD ?? null);
    assert.equal(initialBuild, BUILD_A_ID, 'Initial loaded page embeds build A');

    // Persist a user setting before upgrade to verify reload preserves preferences.
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.locator('[data-settings-panel="dom"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await dialog.locator('[data-setting-key="playArc"]').selectOption('full-360');
    await dialog.locator('[data-settings-action="done"]').click();
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });

    if (xr) {
      await page.waitForFunction(
        () => {
          const btn = document.querySelector('button[data-control="enter-xr"]');
          return btn instanceof HTMLButtonElement && !btn.disabled;
        },
        undefined,
        { timeout: 15000 },
      );
      await page.evaluate((headY) => {
        const emu = (window as unknown as { __xrEmu: { setHead(y: number): void } }).__xrEmu;
        emu.setHead(headY);
      }, SEATED_HEAD_Y);

      await page.getByRole('button', { name: 'Enter Mixed Reality (Quest 3)' }).click();
      await page.waitForFunction(
        () => window.__riftBastionApp?.shell.xr.presenting === true,
        undefined,
        { timeout: 15000 },
      );

      // Mark session end in sessionStorage so we can verify XR exited before navigation.
      await page.evaluate(() => {
        const session = window.__riftBastionApp?.shell.xr.session;
        session?.addEventListener('end', () => {
          sessionStorage.setItem('upgrade-session-ended', '1');
        });
      });

      const waitForXrReloadLabel = (expected: string | null) =>
        page.waitForFunction(
          (targetLabel) => {
            const app = window.__riftBastionApp;
            const panel = app?.versionNotice.xrPanel ?? null;
            if (targetLabel === null) return panel === null;
            if (!panel) return false;
            const cell = panel.root.getObjectByName('version-update-reload');
            return Boolean(cell?.visible) && cell?.userData?.labelText === targetLabel;
          },
          expected,
          { timeout: 10000 },
        );

      // Publish build B: XR must mount `Update: Reload` and NOT auto-reload.
      server.setRoot(dirB);
      routedManifestJson = manifestBJson;
      await waitForXrReloadLabel('Update: Reload');
      assert.equal(
        await page.locator('[data-version-notice]').count(),
        0,
        'No DOM update banner during XR immersion',
      );

      // Wait >1 poll interval and confirm no auto-reload occurred.
      await page.waitForTimeout(1500);
      assert.equal(
        await page.evaluate(() => window.__riftBastionApp?.shell.xr.presenting),
        true,
        'XR session stays active without auto-reloading',
      );
      assert.equal(
        await page.evaluate(() => window.__APP_BUILD),
        BUILD_A_ID,
        'XR session still runs build A until Reload is activated',
      );

      // Rollback to A clears the XR update control.
      routedManifestJson = manifestAJson;
      await waitForXrReloadLabel(null);

      // Re-publish B so `Update: Reload` remounts.
      routedManifestJson = manifestBJson;
      await waitForXrReloadLabel('Update: Reload');

      // Simulate a one-time `session.end()` failure: must stay in XR and switch label to `Update: Retry`.
      await page.evaluate(() => {
        const session = window.__riftBastionApp?.shell.xr.session;
        if (!session) throw new Error('Expected active XR session');
        const originalEnd = session.end.bind(session);
        session.end = async () => {
          session.end = originalEnd;
          throw new Error('Simulated XR exit failure');
        };
      });
      await page.evaluate(() => {
        window.__riftBastionApp?.versionNotice.xrPanel?.activate('reload');
      });
      await waitForXrReloadLabel('Update: Retry');
      assert.equal(
        await page.evaluate(() => window.__riftBastionApp?.shell.xr.presenting),
        true,
        'Failed XR exit stays in XR without navigating',
      );

      // Activate Reload again -> exits XR cleanly, then navigates to build B.
      await page.evaluate(() => {
        window.__riftBastionApp?.versionNotice.xrPanel?.activate('reload');
      });
    } else {
      // Desktop mode: publish build B -> auto-reloads without user click.
      server.setRoot(dirB);
      routedManifestJson = manifestBJson;
    }

    await page.waitForURL((url) => url.searchParams.get('v') === BUILD_B_ID, { timeout: 15000 });
    await page.waitForFunction(
      (expectedId) => Boolean(window.__riftBastionApp) && window.__APP_BUILD === expectedId,
      BUILD_B_ID,
      { timeout: 15000 },
    );

    const afterUrl = new URL(page.url());
    assert.equal(afterUrl.searchParams.get('v'), BUILD_B_ID, 'Reload cache-bust param matches B');
    assert.equal(afterUrl.searchParams.get('preserve'), '1', 'Existing query param preserved');
    assert.equal(afterUrl.hash, '#preserve-fragment', 'URL hash fragment preserved');

    const afterState = await page.evaluate(() => ({
      build: window.__APP_BUILD ?? null,
      presenting: Boolean(window.__riftBastionApp?.shell.xr.presenting),
      playArc: window.__riftBastionApp?.settings.get().playArc ?? null,
      domNoticeCount: document.querySelectorAll('[data-version-notice]').length,
      xrNoticeMounted: Boolean(window.__riftBastionApp?.versionNotice.xrPanel),
      sessionEnded: sessionStorage.getItem('upgrade-session-ended'),
    }));

    assert.equal(afterState.build, BUILD_B_ID, 'Adopted embedded build B');
    assert.equal(afterState.presenting, false, 'Not presenting after reload');
    assert.equal(afterState.playArc, 'full-360', 'Persisted setting survived reload');
    assert.equal(afterState.domNoticeCount, 0, 'No stale DOM update notice after adopting B');
    assert.equal(afterState.xrNoticeMounted, false, 'No stale XR update notice after adopting B');
    if (xr) {
      assert.equal(
        afterState.sessionEnded,
        '1',
        'XR session ended cleanly before reload navigation',
      );
    }
    assert.equal(
      consoleErrors.length,
      0,
      `Expected zero console/page errors, got: ${consoleErrors.join('; ')}`,
    );

    console.log(
      `PASS ${xr ? 'XR HUD Update: Reload' : 'Desktop auto-reload'}: ${BUILD_A_ID} -> ${afterState.build} (settings + URL preserved)`,
    );
    await context.close();
  }
} finally {
  await browser?.close();
  await server?.close();
  await rm(tempRoot, { recursive: true, force: true });
}
