/**
 * One-shot USB/CDP Quest 3 performance collector for Rift Bastion.
 *
 * Reads the stored or live perf trace from Quest Browser over `adb forward` CDP
 * (scoped strictly to the Rift Bastion origin) and parses Quest `VrApi` logcat lines.
 *
 * Usage:
 *   bun scripts/perf-quest.ts                       # forward, read, print, save
 *   bun scripts/perf-quest.ts --logcat 60           # record VrApi for 60s before reading CDP
 *   bun scripts/perf-quest.ts --vrapi-dump          # also parse buffered VrApi logcat lines
 *   bun scripts/perf-quest.ts --no-adb --port 9222  # read from local Chromium CDP
 *   bun scripts/perf-quest.ts --clear               # clear stored perf trace in the tab
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type FrameBucket,
  importPerfTrace,
  PERF_FLOOR_FPS,
  PERF_STORAGE_KEY,
  type PerfTraceExport,
} from '../src/perf/recorder';

export interface CdpTarget {
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl?: string;
}

export interface VrApiSample {
  readonly raw: string;
  readonly fpsDelivered: number | null;
  readonly fpsTarget: number | null;
  readonly appGpuMs: number | null;
  readonly gpuPercent: number | null;
  readonly stale: number | null;
  readonly scaleFactor: number | null;
  readonly foveation: number | null;
  readonly cpuGpuLevels: string | null;
  readonly tempC: number | null;
}

export interface VrApiSummary {
  readonly totalLines: number;
  readonly droppedWarmup: number;
  readonly samples: number;
  readonly fpsMean: number | null;
  readonly fpsMin: number | null;
  readonly secondsBelow50: number;
  readonly appGpuMeanMs: number | null;
  readonly appGpuMaxMs: number | null;
  readonly staleMean: number | null;
  readonly staleTotal: number;
  readonly gpuPercentMean: number | null;
  readonly scaleFactor: number | null;
  readonly foveation: number | null;
  readonly maxTempC: number | null;
}

export interface PerfGroupReport {
  readonly seconds: number;
  readonly minimumFps: number;
  readonly meanFps: number;
  readonly under50: number;
  readonly worstMs: number;
  readonly maxP95Ms: number;
  readonly avgDraws: number;
  readonly avgTriangles: number;
}

const DEFAULT_ORIGIN_PATTERN =
  /^(https:\/\/rift-bastion\.pardev\.net|https?:\/\/(localhost|127\.0\.0\.1):(4272|4273))(\/|$)/;

function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function meanOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, v) => sum + v, 0);
  return Math.round((total / values.length) * 100) / 100;
}

function minOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let low = values[0];
  for (const v of values) if (v < low) low = v;
  return low;
}

function maxOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let high = values[0];
  for (const v of values) if (v > high) high = v;
  return high;
}

/**
 * Matches Rift Bastion production or local dev/preview origins unless a custom matcher is provided.
 */
export function isMatchingTargetUrl(url: string, customMatch?: string): boolean {
  if (customMatch) return url.includes(customMatch);
  return DEFAULT_ORIGIN_PATTERN.test(url);
}

/**
 * Parses one Quest `VrApi` logcat line into structured counters, ignoring unknown fields.
 */
export function parseVrApiLine(line: string): VrApiSample | null {
  const start = line.indexOf('FPS=');
  if (start < 0) return null;

  const fields: Record<string, string> = {};
  for (const token of line.slice(start).split(',')) {
    const eq = token.indexOf('=');
    if (eq > 0) {
      const key = token.slice(0, eq).trim();
      const value = token.slice(eq + 1).trim();
      fields[key] = value;
    }
  }

  if (!fields.FPS) return null;
  const [deliveredRaw, targetRaw] = fields.FPS.split('/');
  const gpuPctRaw = parseNumber(fields['GPU%']);
  const gpuPercent =
    gpuPctRaw === null
      ? null
      : gpuPctRaw <= 1.0 && !fields['GPU%']?.includes('%')
        ? Math.round(gpuPctRaw * 1000) / 10
        : gpuPctRaw;

  const scaleRaw = fields.SF ?? fields.DSF;
  const tempFirst = fields.Temp?.split('/')[0]?.replace(/C$/i, '');

  return {
    raw: line.trim(),
    fpsDelivered: parseNumber(deliveredRaw),
    fpsTarget: parseNumber(targetRaw),
    appGpuMs: parseNumber(fields.App?.replace(/ms$/i, '')),
    gpuPercent,
    stale: parseNumber(fields.Stale),
    scaleFactor: parseNumber(scaleRaw),
    foveation: parseNumber(fields.Fov),
    cpuGpuLevels: fields['CPU4/GPU'] ?? fields['CPU2/GPU'] ?? null,
    tempC: parseNumber(tempFirst),
  };
}

/**
 * Summarizes `VrApi` per-second logcat lines, dropping the initial 5 s XR warmup by default.
 */
export function summarizeVrApi(lines: readonly string[], dropWarmup = 5): VrApiSummary {
  const parsed = lines
    .map(parseVrApiLine)
    .filter((sample): sample is VrApiSample => sample !== null);
  const dropped = Math.min(parsed.length, Math.max(0, Math.floor(dropWarmup)));
  const active = parsed.slice(dropped);

  const fps = active.map((s) => s.fpsDelivered).filter((v): v is number => v !== null);
  const appGpu = active.map((s) => s.appGpuMs).filter((v): v is number => v !== null);
  const stale = active.map((s) => s.stale).filter((v): v is number => v !== null);
  const gpuPct = active.map((s) => s.gpuPercent).filter((v): v is number => v !== null);
  const temps = active.map((s) => s.tempC).filter((v): v is number => v !== null);

  const lastScale = [...active].reverse().find((s) => s.scaleFactor !== null)?.scaleFactor ?? null;
  const lastFov = [...active].reverse().find((s) => s.foveation !== null)?.foveation ?? null;

  return {
    totalLines: parsed.length,
    droppedWarmup: dropped,
    samples: active.length,
    fpsMean: meanOf(fps),
    fpsMin: minOf(fps),
    secondsBelow50: fps.filter((v) => v < PERF_FLOOR_FPS).length,
    appGpuMeanMs: meanOf(appGpu),
    appGpuMaxMs: maxOf(appGpu),
    staleMean: meanOf(stale),
    staleTotal: stale.reduce((sum, v) => sum + v, 0),
    gpuPercentMean: meanOf(gpuPct),
    scaleFactor: lastScale,
    foveation: lastFov,
    maxTempC: maxOf(temps),
  };
}

/**
 * Groups complete 1-second buckets by phase / effective tier / reported Hz for terminal reporting.
 */
export function buildPerfReport(
  seconds: readonly FrameBucket[],
  modeFilter?: 'xr' | 'desktop',
): Record<string, PerfGroupReport> {
  const rows = seconds.filter(
    (s) => s.complete && s.durationMs === 1000 && (!modeFilter || s.mode === modeFilter),
  );
  const acc = new Map<
    string,
    {
      seconds: number;
      minimumFps: number;
      fpsSum: number;
      under50: number;
      worstMs: number;
      maxP95Ms: number;
      drawsSum: number;
      trianglesSum: number;
    }
  >();

  for (const row of rows) {
    const key = [
      row.phase,
      row.mixedSettings ? 'mixed settings' : row.effectiveTier,
      row.reportedHz !== null
        ? `${Math.round(row.reportedHz)}Hz`
        : `${Math.round(row.requestedHz)}Hz(req)`,
    ].join(' / ');
    const group = acc.get(key) ?? {
      seconds: 0,
      minimumFps: Number.POSITIVE_INFINITY,
      fpsSum: 0,
      under50: 0,
      worstMs: 0,
      maxP95Ms: 0,
      drawsSum: 0,
      trianglesSum: 0,
    };
    group.seconds += 1;
    group.minimumFps = Math.min(group.minimumFps, row.fps);
    group.fpsSum += row.fps;
    if (row.fps < PERF_FLOOR_FPS) group.under50 += 1;
    group.worstMs = Math.max(group.worstMs, row.worstMs);
    group.maxP95Ms = Math.max(group.maxP95Ms, row.p95Ms);
    group.drawsSum += row.draws;
    group.trianglesSum += row.triangles;
    acc.set(key, group);
  }

  const out: Record<string, PerfGroupReport> = {};
  for (const [key, g] of acc.entries()) {
    out[key] = {
      seconds: g.seconds,
      minimumFps: g.minimumFps,
      meanFps: Math.round((g.fpsSum / g.seconds) * 10) / 10,
      under50: g.under50,
      worstMs: Math.round(g.worstMs * 10) / 10,
      maxP95Ms: Math.round(g.maxP95Ms * 10) / 10,
      avgDraws: Math.round(g.drawsSum / g.seconds),
      avgTriangles: Math.round(g.trianglesSum / g.seconds),
    };
  }
  return out;
}

function adb(...args: string[]): string {
  return execFileSync('adb', args, { encoding: 'utf8', timeout: 8000 }).trim();
}

async function cdpEvaluate(
  webSocketUrl: string,
  expression: string,
  timeoutMs = 10_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketUrl);
    let settled = false;
    const finish = (cb: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Ignore close errors.
      }
      cb();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error('Quest Browser did not respond within 10 seconds')));
    }, timeoutMs);

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true },
        }),
      );
    };
    ws.onerror = () => {
      finish(() => reject(new Error('Quest Browser CDP WebSocket connection failed')));
    };
    ws.onclose = () => {
      finish(() => reject(new Error('Quest Browser tab closed before capture arrived')));
    };
    ws.onmessage = (event) => {
      try {
        const reply = JSON.parse(String(event.data)) as {
          id?: number;
          error?: { message?: string };
          result?: { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
        };
        if (reply.id !== 1) return;
        if (reply.error) {
          finish(() => reject(new Error(reply.error?.message ?? 'CDP evaluation error')));
        } else if (reply.result?.exceptionDetails) {
          finish(() =>
            reject(new Error(reply.result?.exceptionDetails?.text ?? 'Page script error')),
          );
        } else {
          finish(() => resolve(reply.result?.result?.value));
        }
      } catch (error) {
        finish(() => reject(error));
      }
    };
  });
}

async function readCaptureFromTarget(
  target: CdpTarget,
): Promise<{ trace: PerfTraceExport; pageBuild: string }> {
  const wsUrl = target.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error(`Target ${target.url} has no webSocketDebuggerUrl`);

  const expression = `(() => {
    const pageBuild = typeof window.__APP_BUILD === 'string' ? window.__APP_BUILD : 'unknown';
    if (window.__riftBastionPerf && typeof window.__riftBastionPerf.snapshot === 'function') {
      return { pageBuild, trace: window.__riftBastionPerf.snapshot() };
    }
    const raw = window.localStorage.getItem(${JSON.stringify(PERF_STORAGE_KEY)});
    if (!raw) return { pageBuild, trace: null };
    return { pageBuild, trace: JSON.parse(raw) };
  })()`;

  const result = (await cdpEvaluate(wsUrl, expression)) as {
    pageBuild?: string;
    trace?: unknown;
  } | null;

  if (!result?.trace) {
    throw new Error(
      `No Rift Bastion perf trace found on ${target.url}. Enable Show FPS or open ?perf first.`,
    );
  }

  return {
    pageBuild: typeof result.pageBuild === 'string' ? result.pageBuild : 'unknown',
    trace: importPerfTrace(result.trace),
  };
}

async function clearTargetTrace(target: CdpTarget): Promise<void> {
  const wsUrl = target.webSocketDebuggerUrl;
  if (!wsUrl) return;
  await cdpEvaluate(
    wsUrl,
    `(() => {
      window.localStorage.removeItem(${JSON.stringify(PERF_STORAGE_KEY)});
      window.__riftBastionPerf?.clear();
      return true;
    })()`,
  );
}

async function recordVrApiLogcat(seconds: number): Promise<string[]> {
  console.log(`Recording Quest VrApi logcat for ${seconds}s...`);
  return new Promise((resolve, reject) => {
    const child = spawn('adb', ['logcat', '-v', 'time', '-s', 'VrApi:I'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, seconds * 1000);
    child.on('close', () => {
      clearTimeout(timer);
      if (!stdout && stderr.trim()) {
        reject(new Error(`adb logcat failed: ${stderr.trim()}`));
        return;
      }
      resolve(stdout.split('\n').filter((line) => line.includes('FPS=')));
    });
  });
}

function dumpVrApiLogcat(): string[] {
  try {
    const output = adb('logcat', '-d', '-v', 'time', '-s', 'VrApi:I');
    return output.split('\n').filter((line) => line.includes('FPS='));
  } catch {
    return [];
  }
}

function parseCliOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useAdb = !args.includes('--no-adb');
  const clearOnly = args.includes('--clear');
  const vrapiDump = args.includes('--vrapi-dump');
  const customMatch = parseCliOption(args, 'match');
  const outOverride = parseCliOption(args, 'out');
  const vrapiFile = parseCliOption(args, 'vrapi-file');
  const logcatSeconds = Number(parseCliOption(args, 'logcat') ?? '0');

  let forwardedPort: string | null = null;
  let port = parseCliOption(args, 'port') ?? '9222';

  if (useAdb) {
    const devices = adb('devices')
      .split('\n')
      .filter((line) => /\tdevice$/.test(line));
    if (devices.length === 0) {
      throw new Error('No Quest device attached over adb. Connect USB and authorize debugging.');
    }
    forwardedPort = adb('forward', 'tcp:0', 'localabstract:chrome_devtools_remote');
    port = forwardedPort;
  }

  try {
    let vrapiSummary: VrApiSummary | null = null;
    if (vrapiFile) {
      const text = await readFile(vrapiFile, 'utf8');
      vrapiSummary = summarizeVrApi(text.split('\n'));
    } else if (useAdb && Number.isFinite(logcatSeconds) && logcatSeconds > 0) {
      const lines = await recordVrApiLogcat(logcatSeconds);
      vrapiSummary = summarizeVrApi(lines);
    } else if (useAdb && vrapiDump) {
      const lines = dumpVrApiLogcat();
      if (lines.length > 0) vrapiSummary = summarizeVrApi(lines);
    }

    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) {
      throw new Error(`CDP target list unavailable (HTTP ${response.status})`);
    }
    const pages = (await response.json()) as CdpTarget[];
    const targets = pages.filter(
      (p) =>
        p.type === 'page' &&
        Boolean(p.webSocketDebuggerUrl) &&
        isMatchingTargetUrl(p.url, customMatch),
    );
    if (targets.length === 0) {
      throw new Error(
        'No open Rift Bastion tab found in Quest Browser. Open https://rift-bastion.pardev.net/ or http://localhost:4272/ first.',
      );
    }

    if (clearOnly) {
      for (const target of targets) {
        await clearTargetTrace(target);
        console.log(`Cleared stored perf trace on ${target.url}`);
      }
      return;
    }

    const deviceModel = useAdb ? adb('shell', 'getprop', 'ro.product.model') : 'desktop-cdp';
    const stamp = new Date().toISOString().replaceAll(':', '-');

    for (const [index, target] of targets.entries()) {
      const { trace, pageBuild } = await readCaptureFromTarget(target);
      const filename =
        outOverride ?? join('.local', 'evidence', `rift-bastion-perf-${stamp}-${index}.json`);
      await mkdir(dirname(filename), { recursive: true });

      const bundle = {
        capturedAt: new Date().toISOString(),
        captureMethod: useAdb ? 'quest-usb-cdp' : 'local-cdp',
        deviceModel,
        url: target.url,
        pageBuild,
        vrapi: vrapiSummary,
        trace,
      };
      await Bun.write(filename, `${JSON.stringify(bundle, null, 2)}\n`);

      const xrSeconds = trace.seconds.filter((s) => s.mode === 'xr' && s.build === pageBuild);
      const desktopSeconds = trace.seconds.filter(
        (s) => s.mode === 'desktop' && s.build === pageBuild,
      );
      const rows = xrSeconds.length > 0 ? xrSeconds : desktopSeconds;
      const modeLabel = xrSeconds.length > 0 ? 'XR' : 'desktop';

      console.log(
        `${target.url} · build ${pageBuild} · ${rows.length} complete ${modeLabel} seconds · saved ${filename}`,
      );
      if (trace.retention.truncated) {
        console.log(
          `Retention truncated: dropped ${trace.retention.droppedSeconds}s complete, ${trace.retention.droppedHitches} hitches, ${trace.retention.droppedEvents} events.`,
        );
      }

      if (rows.length > 0) {
        const grouped = buildPerfReport(rows, xrSeconds.length > 0 ? 'xr' : 'desktop');
        console.table(grouped);
        const minFps = Math.min(...rows.map((r) => r.fps));
        const belowFloor = rows.filter((r) => r.fps < PERF_FLOOR_FPS).length;
        console.log(
          `Minimum ${minFps} app FPS; ${belowFloor} complete seconds below the ${PERF_FLOOR_FPS} FPS floor.`,
        );
      } else {
        console.log(
          'No complete 1-second buckets for this build yet. Enable Show FPS (or ?perf) and play in MR.',
        );
      }

      if (vrapiSummary) {
        console.log(
          `VrApi (${vrapiSummary.samples}s, dropped ${vrapiSummary.droppedWarmup}s warmup): mean ${vrapiSummary.fpsMean ?? '--'} fps, min ${vrapiSummary.fpsMin ?? '--'} fps (<50: ${vrapiSummary.secondsBelow50}s), App GPU mean ${vrapiSummary.appGpuMeanMs ?? '--'}ms / max ${vrapiSummary.appGpuMaxMs ?? '--'}ms, Stale total ${vrapiSummary.staleTotal}, SF=${vrapiSummary.scaleFactor ?? '--'}, Fov=${vrapiSummary.foveation ?? '--'}`,
        );
      }
    }
  } finally {
    if (forwardedPort) {
      try {
        adb('forward', '--remove', `tcp:${forwardedPort}`);
      } catch {
        // Ignore cleanup failure.
      }
    }
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
