import {
  createPerfGaugeWidget,
  createScalableLabel,
  disposeScalableLabel,
  keepAbove,
  OVERLAY_RENDER_ORDER,
  PERF_GAUGE_HEIGHT,
  PERF_GAUGE_WIDTH,
  type PerfGaugeWidget,
  updateScalableLabel,
} from '@par/xr-workspace';
import * as THREE from 'three';
import type { SettingsStore } from '../settings/store';
import {
  type FrameBucket,
  PERF_FLOOR_FPS,
  type PerfMode,
  type PerfRecorder,
  type PerfTraceExport,
} from './recorder';

export interface PerfHudOptions {
  /** Update interval in milliseconds (500..1000 ms = 1-2 Hz). Defaults to 500 ms. */
  updateIntervalMs?: number;
  container?: HTMLElement | null;
  envMap?: THREE.Texture | null;
  renderOrder?: number;
  initialMode?: PerfMode;
  attachWindowHandle?: boolean;
}

export interface PerfDebugHandle {
  snapshot(): PerfTraceExport;
  exportJson(pretty?: boolean): string;
  mark(kind: string, detail?: string): void;
  clear(): void;
  setShowFps(enabled: boolean): void;
}

export interface PerfHud {
  /** Spatial XR HUD root containing `PerfGaugeWidget` and compact telemetry readout. */
  readonly xrRoot: THREE.Group;
  readonly gauge: PerfGaugeWidget;
  /** Lightweight desktop DOM FPS badge (null when headless / no container). */
  readonly desktopBadge: HTMLElement | null;
  readonly enabled: boolean;
  readonly mode: PerfMode;
  setMode(mode: PerfMode): void;
  /**
   * Refreshes the XR gauge and desktop badge when enabled and the 1-2 Hz cadence has elapsed.
   * Returns `true` when the readout was updated.
   */
  update(timeMs: number, force?: boolean): boolean;
  /** Resets sparkline history (e.g. after visibility loss or XR mode switch). */
  reset(): void;
  activate(target: THREE.Object3D): void;
  dispose(): void;
}

const BADGE_STYLE_ID = 'rift-bastion-perf-badge-styles';
const DEFAULT_UPDATE_INTERVAL_MS = 500;

declare global {
  interface Window {
    __riftBastionPerf?: PerfDebugHandle;
  }
}

function clampUpdateInterval(ms: number | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return DEFAULT_UPDATE_INTERVAL_MS;
  return Math.min(1000, Math.max(250, ms));
}

function formatTriangles(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(Math.round(count));
}

function formatTier(bucket: FrameBucket): string {
  return bucket.effectiveTier !== bucket.qualityTier
    ? `${bucket.qualityTier}->${bucket.effectiveTier}`
    : bucket.qualityTier;
}

function formatHz(bucket: FrameBucket): string {
  const rep = bucket.reportedHz !== null ? `${Math.round(bucket.reportedHz)}` : '--';
  return `${Math.round(bucket.requestedHz)}/${rep}Hz`;
}

function formatXrDetails(bucket: FrameBucket | null, trace: PerfTraceExport): string {
  if (!bucket) return 'p95 -- ms | worst -- ms\ndraws -- | tris -- | floor --';
  const low =
    trace.stats.lowestCompleteSecondFps !== null
      ? `${Math.round(trace.stats.lowestCompleteSecondFps)}`
      : '--';
  const line1 = `p95 ${bucket.p95Ms.toFixed(1)}ms | worst ${bucket.worstMs.toFixed(1)}ms | ${formatHz(bucket)}`;
  const line2 = `${bucket.draws} draws | ${formatTriangles(bucket.triangles)} tris | ${formatTier(bucket)} | min ${low} (<${trace.floorFps}:${trace.stats.secondsBelowFloor}s)`;
  return `${line1}\n${line2}`;
}

function formatDesktopBadge(bucket: FrameBucket | null, trace: PerfTraceExport): string {
  if (!bucket) return 'FPS -- | awaiting frames';
  const fps = Math.round(bucket.fps);
  const low =
    trace.stats.lowestCompleteSecondFps !== null
      ? `${Math.round(trace.stats.lowestCompleteSecondFps)}`
      : '--';
  const floorTag =
    bucket.complete && bucket.fps < trace.floorFps ? ` | <${trace.floorFps} FLOOR` : '';
  return [
    `${fps} FPS (${formatHz(bucket)})${floorTag}`,
    `p95 ${bucket.p95Ms.toFixed(1)}ms · worst ${bucket.worstMs.toFixed(1)}ms`,
    `${bucket.draws} draws · ${formatTriangles(bucket.triangles)} tris · ${formatTier(bucket)}`,
    `min ${low} fps · <${trace.floorFps}: ${trace.stats.secondsBelowFloor}s`,
  ].join('\n');
}

function ensureBadgeStyles(doc: Document): void {
  if (doc.getElementById(BADGE_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = BADGE_STYLE_ID;
  style.textContent = `
.rb-perf-badge[hidden] {
  display: none !important;
}
.rb-perf-badge {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 8500;
  pointer-events: none;
  margin: 0;
  padding: 8px 11px;
  border-radius: 8px;
  border: 1px solid #2d4c61;
  background: rgba(11, 20, 29, 0.86);
  color: #e3f3fb;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.4;
  white-space: pre;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.rb-perf-badge[data-tone="warn"] {
  border-color: #d9a441;
}
.rb-perf-badge[data-tone="bad"] {
  border-color: #d8605a;
  color: #ffd7d4;
}
`;
  doc.head.appendChild(style);
}

/**
 * Integrates `PerfRecorder` with `@par/xr-workspace`'s `createPerfGaugeWidget` (for XR)
 * and a lightweight DOM FPS badge (for desktop), toggled live by `settingsStore.showFps`
 * (including `?perf` URL overrides) and updated at 1-2 Hz.
 */
export function createPerfHud(
  recorder: PerfRecorder,
  settingsStore: SettingsStore,
  options: PerfHudOptions = {},
): PerfHud {
  const updateIntervalMs = clampUpdateInterval(options.updateIntervalMs);
  const renderOrder = options.renderOrder ?? OVERLAY_RENDER_ORDER;
  let mode: PerfMode = options.initialMode ?? 'desktop';
  let enabled = settingsStore.get().showFps;
  let lastUpdateMs = -Infinity;
  let disposed = false;

  // Spatial XR HUD root
  const xrRoot = new THREE.Group();
  xrRoot.name = 'rift-bastion-perf-hud';
  const gauge = createPerfGaugeWidget(options.envMap ?? null, {
    onClose: () => {
      settingsStore.set('showFps', false);
    },
  });

  const detailHeight = 0.095;
  const detailLabel = createScalableLabel(
    'p95 -- ms | worst -- ms\ndraws -- | tris -- | floor --',
    PERF_GAUGE_WIDTH,
    detailHeight,
    {
      wrap: true,
      align: 'left',
      background: '#101d27',
      border: '#243c4c',
      fontSize: 0.017,
      name: 'perf-hud-details',
    },
  );
  detailLabel.position.set(0, -(PERF_GAUGE_HEIGHT / 2 + detailHeight / 2 + 0.012), 0.01);
  xrRoot.add(gauge.root, detailLabel);
  const stopKeepAbove = keepAbove(xrRoot, renderOrder);

  // Desktop DOM FPS badge
  const container =
    options.container !== undefined
      ? options.container
      : typeof document !== 'undefined'
        ? document.body
        : null;
  let desktopBadge: HTMLElement | null = null;
  if (container) {
    const doc = container.ownerDocument;
    ensureBadgeStyles(doc);
    desktopBadge = doc.createElement('output');
    desktopBadge.className = 'rb-perf-badge';
    desktopBadge.dataset.perfBadge = 'desktop';
    desktopBadge.setAttribute('aria-live', 'off');
    desktopBadge.textContent = 'FPS -- | awaiting frames';
    container.appendChild(desktopBadge);
  }

  const syncVisibility = (): void => {
    xrRoot.visible = enabled && mode === 'xr';
    if (desktopBadge) {
      desktopBadge.hidden = !(enabled && mode === 'desktop');
    }
  };

  const renderReadout = (): void => {
    const trace = recorder.snapshot();
    const bucket = recorder.getLatestCompleteSecond() ?? recorder.getLatestBucket();
    const targetHz = bucket?.reportedHz ?? bucket?.requestedHz ?? (mode === 'xr' ? 72 : 60);

    gauge.setPerfSample({
      fps: bucket ? bucket.fps : null,
      worstFrameMs: bucket ? bucket.worstMs : 0,
      targetHz,
    });

    const detailText = formatXrDetails(bucket, trace);
    if (detailLabel.userData.labelText !== detailText) {
      updateScalableLabel(detailLabel, detailText);
    }

    if (desktopBadge) {
      desktopBadge.textContent = formatDesktopBadge(bucket, trace);
      const tone = !bucket
        ? 'unknown'
        : bucket.fps < (trace.floorFps ?? PERF_FLOOR_FPS)
          ? 'bad'
          : bucket.fps < targetHz * 0.9
            ? 'warn'
            : 'good';
      desktopBadge.dataset.tone = tone;
    }
  };

  const unsubscribe = settingsStore.subscribe((next, _prev, changedKeys) => {
    if (!changedKeys.includes('showFps')) return;
    enabled = next.showFps;
    syncVisibility();
    if (enabled) {
      renderReadout();
      lastUpdateMs = -Infinity;
    }
  });

  const attachHandle = options.attachWindowHandle ?? true;
  if (attachHandle && typeof window !== 'undefined') {
    window.__riftBastionPerf = {
      snapshot: () => recorder.snapshot(),
      exportJson: (pretty) => recorder.exportJson(pretty),
      mark: (kind, detail) => {
        recorder.mark(kind, detail);
      },
      clear: () => {
        recorder.clear();
        gauge.resetPerf();
      },
      setShowFps: (show) => {
        settingsStore.set('showFps', show);
      },
    };
  }

  syncVisibility();

  return {
    xrRoot,
    gauge,
    desktopBadge,
    get enabled() {
      return enabled;
    },
    get mode() {
      return mode;
    },
    setMode(nextMode) {
      if (disposed || mode === nextMode) return;
      mode = nextMode;
      gauge.resetPerf();
      lastUpdateMs = -Infinity;
      syncVisibility();
    },
    update(timeMs, force = false) {
      if (disposed || !enabled || !Number.isFinite(timeMs)) return false;
      if (!force && timeMs - lastUpdateMs < updateIntervalMs) return false;
      lastUpdateMs = timeMs;
      renderReadout();
      return true;
    },
    reset() {
      if (disposed) return;
      gauge.resetPerf();
      lastUpdateMs = -Infinity;
    },
    activate(target) {
      if (!disposed) gauge.activate?.(target);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      stopKeepAbove();
      disposeScalableLabel(detailLabel);
      gauge.dispose();
      xrRoot.clear();
      xrRoot.removeFromParent();
      desktopBadge?.remove();
      if (attachHandle && typeof window !== 'undefined' && window.__riftBastionPerf) {
        delete window.__riftBastionPerf;
      }
    },
  };
}
