import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('troika-three-text', async (importOriginal) => {
  const actual = await importOriginal<typeof import('troika-three-text')>();
  const THREE = await import('three');
  return {
    ...actual,
    configureTextBuilder: vi.fn(),
    Text: class MockText extends THREE.Mesh {
      text = '';
      font: string | null = null;
      fontSize = 0;
      maxWidth = 0;
      anchorX: number | string = 0;
      anchorY: number | string = 0;
      textAlign = '';
      whiteSpace = '';
      lineHeight: number | string = 'normal';
      overflowWrap = '';
      color: number | string = 0;
      depthOffset = 0;
      constructor() {
        super(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
      }
      sync(callback?: () => void): void {
        queueMicrotask(() => callback?.());
      }
      dispose(): void {
        this.geometry.dispose();
      }
    },
  };
});

import {
  buildPerfReport,
  isMatchingTargetUrl,
  parseVrApiLine,
  summarizeVrApi,
} from '../scripts/perf-quest';
import { createPerfHud } from '../src/perf/hud';
import {
  computePerfFloorStats,
  createPerfRecorder,
  importPerfTrace,
  PERF_FLOOR_FPS,
  PERF_STORAGE_KEY,
  type PerfContext,
} from '../src/perf/recorder';
import { createMemoryStorageAdapter, createSettingsStore } from '../src/settings/store';

function makeContext(overrides: Partial<PerfContext> = {}): PerfContext {
  return {
    mode: 'xr',
    phase: 'wave-3',
    requestedHz: 72,
    reportedHz: 72,
    qualityTier: 'max-beauty',
    effectiveTier: 'max-beauty',
    framebufferScale: 1.15,
    fixedFoveation: 0.5,
    ...overrides,
  };
}

describe('perf/recorder', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('counts exact 1-second monotonic buckets at steady 72 fps and 60 fps cadences', () => {
    const recorder = createPerfRecorder({
      build: 'abc123',
      storage: null,
      nowWallMs: () => 1_700_000_000_000,
      nowMonotonicMs: () => 0,
    });
    const ctx = makeContext({ requestedHz: 72, reportedHz: 72 });
    const stepMs = 1000 / 72;

    // Feed 3 full seconds (216 intervals -> frames 0..216; frame 216 closes second 3)
    const completed = [];
    for (let i = 0; i <= 216; i += 1) {
      completed.push(...recorder.recordFrame(i * stepMs, ctx, 140, 180_000));
    }

    expect(completed).toHaveLength(3);
    for (const bucket of completed) {
      expect(bucket.complete).toBe(true);
      expect(bucket.durationMs).toBe(1000);
      expect(bucket.fps).toBe(72);
      expect(bucket.frames).toBe(72);
      expect(bucket.draws).toBe(140);
      expect(bucket.triangles).toBe(180_000);
      expect(bucket.p95Ms).toBeCloseTo(13.89, 1);
      expect(bucket.worstMs).toBeCloseTo(13.89, 1);
      expect(bucket.requestedHz).toBe(72);
      expect(bucket.reportedHz).toBe(72);
      expect(bucket.qualityTier).toBe('max-beauty');
    }

    const snap = recorder.snapshot();
    expect(snap.seconds).toHaveLength(3);
    expect(snap.partialSeconds).toHaveLength(0);
    expect(snap.current?.complete).toBe(false);
    expect(snap.current?.frames).toBe(1);
    expect(snap.stats.lowestCompleteSecondFps).toBe(72);
    expect(snap.stats.secondsBelowFloor).toBe(0);
    expect(snap.stats.zeroFrameSeconds).toBe(0);
    expect(snap.hitches).toHaveLength(0);
  });

  it('captures injected stalls, hitches, and exact 50 fps floor boundary counting', () => {
    const recorder = createPerfRecorder({ build: 'abc123', storage: null });
    const ctx = makeContext({ requestedHz: 72, reportedHz: 72 });

    // Second 0: exact 50 fps (20ms cadence) -> NOT below 50 fps floor
    for (let i = 0; i < 50; i += 1) {
      recorder.recordFrame(i * 20, ctx, 120, 150_000);
    }

    // Second 1: starts at 1000ms with an injected 260ms stall, then 48 more frames -> 49 frames total (<50 floor)
    let t = 1000;
    recorder.recordFrame(t, ctx, 150, 210_000); // closes second 0 (50 fps)
    t += 260; // injected 260ms visible stall
    recorder.recordFrame(t, ctx, 150, 210_000);
    for (let i = 0; i < 47; i += 1) {
      t += 15;
      recorder.recordFrame(t, ctx, 150, 210_000);
    }
    // Close second 1 at t = 2000
    const closed = recorder.recordFrame(2000, ctx, 150, 210_000);
    expect(closed).toHaveLength(1);
    expect(closed[0].fps).toBe(49);
    expect(closed[0].worstMs).toBe(260);

    const snap = recorder.snapshot();
    expect(snap.seconds).toHaveLength(2);
    expect(snap.seconds[0].fps).toBe(50);
    expect(snap.seconds[1].fps).toBe(49);
    expect(snap.stats.floorFps).toBe(PERF_FLOOR_FPS);
    expect(snap.stats.lowestCompleteSecondFps).toBe(49);
    expect(snap.stats.secondsBelowFloor).toBe(1);
    expect(snap.hitches.some((h) => h.ms === 260)).toBe(true);
  });

  it('records explicit zero-frame active seconds across a multi-second freeze', () => {
    const recorder = createPerfRecorder({ build: 'abc123', storage: null });
    const ctx = makeContext();

    // Active second [0, 1000) with 60 frames
    for (let i = 0; i < 60; i += 1) {
      recorder.recordFrame(i * (1000 / 60), ctx, 100, 120_000);
    }

    // Active gameplay freezes for ~2.5s without visibility loss; next frame arrives at t = 3500ms
    const closed = recorder.recordFrame(3500, ctx, 100, 120_000);
    // Should close [0, 1000) (60 fps), [1000, 2000) (0 fps), and [2000, 3000) (0 fps)
    expect(closed).toHaveLength(3);
    expect(closed[0].fps).toBe(60);
    expect(closed[1].fps).toBe(0);
    expect(closed[1].frames).toBe(0);
    expect(closed[1].complete).toBe(true);
    expect(closed[2].fps).toBe(0);
    expect(closed[2].frames).toBe(0);

    const snap = recorder.snapshot();
    expect(snap.stats.lowestCompleteSecondFps).toBe(0);
    expect(snap.stats.zeroFrameSeconds).toBe(2);
    expect(snap.stats.secondsBelowFloor).toBe(2);
    // The recovery frame at 3500ms also records the massive stall hitch
    expect(snap.hitches.some((h) => h.ms > 2500)).toBe(true);
  });

  it('separates partial seconds and resets segments cleanly on visibility loss and XR transitions', () => {
    const recorder = createPerfRecorder({ build: 'abc123', storage: null });
    const desktopCtx = makeContext({ mode: 'desktop', requestedHz: 60, reportedHz: null });

    // Record 400ms of desktop frames (partial second only)
    for (let i = 0; i < 24; i += 1) {
      recorder.recordFrame(i * (1000 / 60), desktopCtx, 50, 40_000);
    }

    // Tab becomes hidden for 10 full seconds
    recorder.onVisibilityChange(false, 400);
    let snap = recorder.snapshot();
    expect(snap.seconds).toHaveLength(0);
    expect(snap.partialSeconds).toHaveLength(1);
    expect(snap.partialSeconds[0].complete).toBe(false);
    expect(snap.partialSeconds[0].endReason).toBe('visibility-hidden');
    expect(snap.current).toBeNull();
    // Partial bucket must NOT pollute complete-second floor stats
    expect(snap.stats.completeSeconds).toBe(0);
    expect(snap.stats.lowestCompleteSecondFps).toBeNull();

    // Resume after 10s hidden gap -> must NOT emit zero-frame seconds or hitches!
    recorder.onVisibilityChange(true, 10_400);
    for (let i = 0; i <= 60; i += 1) {
      recorder.recordFrame(10_400 + i * (1000 / 60), desktopCtx, 50, 40_000);
    }
    snap = recorder.snapshot();
    expect(snap.seconds).toHaveLength(1);
    expect(snap.seconds[0].fps).toBe(60);
    expect(snap.stats.zeroFrameSeconds).toBe(0);
    expect(snap.hitches).toHaveLength(0);

    // Transition into XR session -> cleanly ends segment and separates XR buckets
    recorder.onXrSessionStart(11_500);
    const xrCtx = makeContext({ mode: 'xr', requestedHz: 72, reportedHz: 72 });
    for (let i = 0; i <= 72; i += 1) {
      recorder.recordFrame(15_000 + i * (1000 / 72), xrCtx, 130, 175_000);
    }
    recorder.onXrSessionEnd(16_100);

    snap = recorder.snapshot();
    expect(snap.seconds).toHaveLength(2);
    expect(snap.seconds[0].mode).toBe('desktop');
    expect(snap.seconds[1].mode).toBe('xr');
    expect(snap.seconds[1].fps).toBe(72);
    expect(snap.seconds[1].segmentId).toBeGreaterThan(snap.seconds[0].segmentId);
    expect(snap.stats.zeroFrameSeconds).toBe(0);
    expect(snap.hitches).toHaveLength(0);
  });

  it('records event markers without erasing the triggering hitch or resetting the active bucket', () => {
    const recorder = createPerfRecorder({ build: 'abc123', storage: null });
    const ctx = makeContext({ phase: 'wave-12-boss' });

    recorder.recordFrame(0, ctx, 180, 290_000);
    recorder.recordFrame(14, ctx, 180, 290_000);
    // Big 120ms hitch when portal opens / boss phase shifts
    recorder.recordFrame(134, ctx, 195, 340_000);
    recorder.mark('grab', 'rail-sniper-1', 134);
    recorder.mark('wave-start', 'wave-12', 134);
    recorder.mark('portal-open', 'ceiling-north', 134);
    recorder.mark('boss-phase', 'broodlord-phase-2', 134);

    // Continue frames to finish the second
    let t = 134;
    for (let i = 0; i < 60; i += 1) {
      t += 14.5;
      recorder.recordFrame(t, ctx, 180, 290_000);
    }

    const snap = recorder.snapshot();
    expect(snap.seconds).toHaveLength(1);
    expect(snap.seconds[0].worstMs).toBe(120);
    expect(snap.hitches.some((h) => h.ms === 120)).toBe(true);
    expect(snap.events.map((e) => e.kind)).toEqual([
      'grab',
      'wave-start',
      'portal-open',
      'boss-phase',
    ]);
  });

  it('persists bounded traces to localStorage with retention truncation metadata and supports JSON export/import', () => {
    const recorder = createPerfRecorder({
      build: 'deadbeef',
      storage: window.localStorage,
      limits: { maxSeconds: 3, maxHitches: 2, maxEvents: 2 },
    });
    const ctx = makeContext();

    // Generate 5 complete seconds (exceeds maxSeconds: 3)
    for (let s = 0; s < 5; s += 1) {
      for (let f = 0; f < 60; f += 1) {
        recorder.recordFrame(s * 1000 + f * (1000 / 60), ctx, 110, 140_000);
      }
    }
    // Close the 5th second
    recorder.recordFrame(5000, ctx, 110, 140_000);
    // Add 3 events (exceeds maxEvents: 2)
    recorder.mark('grab', 'a', 5010);
    recorder.mark('wave-start', 'b', 5020);
    recorder.mark('portal-open', 'c', 5030);
    recorder.flush();

    const raw = window.localStorage.getItem(PERF_STORAGE_KEY);
    expect(raw).not.toBeNull();

    const snap = recorder.snapshot();
    expect(snap.seconds).toHaveLength(3);
    expect(snap.retention.maxSeconds).toBe(3);
    expect(snap.retention.truncated).toBe(true);
    expect(snap.retention.droppedSeconds).toBe(2);
    expect(snap.retention.droppedEvents).toBe(1);

    // Reload into a fresh recorder instance from localStorage
    const reloaded = createPerfRecorder({
      build: 'deadbeef',
      storage: window.localStorage,
      limits: { maxSeconds: 3, maxHitches: 2, maxEvents: 2 },
    });
    const reloadedSnap = reloaded.snapshot();
    expect(reloadedSnap.seconds).toHaveLength(3);
    expect(reloadedSnap.retention.truncated).toBe(true);
    expect(reloadedSnap.retention.droppedSeconds).toBe(2);
    expect(reloadedSnap.events).toHaveLength(2);

    // JSON export & import round-trip
    const exported = recorder.exportJson(true);
    const parsed = importPerfTrace(exported);
    expect(parsed.build).toBe('deadbeef');
    expect(parsed.seconds).toHaveLength(3);
    expect(parsed.retention.truncated).toBe(true);
    expect(parsed.stats.completeSeconds).toBe(3);

    const targetRecorder = createPerfRecorder({ build: 'fresh', storage: null });
    const importedSnap = targetRecorder.importJson(exported);
    expect(importedSnap.seconds).toHaveLength(3);
    expect(importedSnap.retention.droppedSeconds).toBe(2);

    // Invalid JSON / wrong version throws
    expect(() => importPerfTrace('{bad')).toThrow();
    expect(() => importPerfTrace(JSON.stringify({ version: 99, seconds: [] }))).toThrow();
  });

  it('enforces maxJsonChars retention cap during persistence', () => {
    const recorder = createPerfRecorder({
      build: 'cap-test',
      storage: window.localStorage,
      limits: { maxSeconds: 100, maxJsonChars: 1200 },
    });
    const ctx = makeContext();
    for (let s = 0; s < 10; s += 1) {
      for (let f = 0; f < 60; f += 1) {
        recorder.recordFrame(s * 1000 + f * (1000 / 60), ctx, 100, 120_000);
      }
    }
    recorder.recordFrame(10_000, ctx, 100, 120_000);
    recorder.flush();

    const stored = window.localStorage.getItem(PERF_STORAGE_KEY);
    expect(stored).not.toBeNull();
    expect((stored as string).length).toBeLessThanOrEqual(1200);
    expect(recorder.snapshot().retention.truncated).toBe(true);
    expect(recorder.snapshot().retention.droppedSeconds).toBeGreaterThan(0);
  });

  it('computes floor stats strictly over complete 1-second buckets', () => {
    const recorder = createPerfRecorder({ build: 'stats', storage: null });
    const ctx = makeContext();
    for (let i = 0; i <= 72; i += 1) {
      recorder.recordFrame(i * (1000 / 72), ctx, 90, 95_000);
    }
    const snap = recorder.snapshot();
    const stats = computePerfFloorStats(
      [...snap.seconds, ...(snap.current ? [snap.current] : [])],
      50,
    );
    expect(stats.completeSeconds).toBe(1);
    expect(stats.lowestCompleteSecondFps).toBe(72);
    expect(stats.secondsBelowFloor).toBe(0);
  });
});

describe('perf/hud', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.body.innerHTML = '';
  });

  it('integrates PerfGaugeWidget and desktop badge, respects showFps / ?perf, and throttles updates', () => {
    const store = createSettingsStore({
      adapter: createMemoryStorageAdapter(),
      search: '?perf',
    });
    const recorder = createPerfRecorder({ build: 'hud-test', storage: null });
    const hud = createPerfHud(recorder, store, {
      container: document.body,
      updateIntervalMs: 500,
      initialMode: 'desktop',
    });

    expect(hud.enabled).toBe(true);
    expect(hud.desktopBadge?.hidden).toBe(false);
    expect(hud.xrRoot.visible).toBe(false);
    expect(window.__riftBastionPerf).toBeDefined();

    // Record 1 complete 72 fps second
    const ctx = makeContext({ requestedHz: 72, reportedHz: 72, qualityTier: 'max-beauty' });
    for (let i = 0; i <= 72; i += 1) {
      recorder.recordFrame(i * (1000 / 72), ctx, 142, 185_000);
    }

    // First update refreshes; second within 500ms is throttled; third at +500ms refreshes
    expect(hud.update(1000)).toBe(true);
    expect(hud.update(1200)).toBe(false);
    expect(hud.update(1500)).toBe(true);

    expect(hud.desktopBadge?.textContent).toContain('72 FPS');
    expect(hud.desktopBadge?.textContent).toContain('72/72Hz');
    expect(hud.desktopBadge?.textContent).toContain('142 draws');
    expect(hud.desktopBadge?.textContent).toContain('185k tris');
    expect(hud.desktopBadge?.textContent).toContain('max-beauty');

    // Switch to XR mode -> shows spatial XR gauge and hides DOM badge
    hud.setMode('xr');
    expect(hud.xrRoot.visible).toBe(true);
    expect(hud.desktopBadge?.hidden).toBe(true);
    expect(hud.update(2000)).toBe(true);

    const detailLabel = hud.xrRoot.getObjectByName('perf-hud-details');
    expect(detailLabel?.userData.labelText).toContain('142 draws');
    expect(detailLabel?.userData.labelText).toContain('185k tris');

    // Closing the XR gauge via its close button disables showFps in the shared store
    const closeMesh = hud.gauge.root.getObjectByName('perf-gauge-close');
    expect(closeMesh).toBeTruthy();
    if (closeMesh) hud.activate(closeMesh);
    expect(store.get().showFps).toBe(false);
    expect(hud.enabled).toBe(false);
    expect(hud.xrRoot.visible).toBe(false);
    expect(hud.update(3000)).toBe(false);

    hud.dispose();
    expect(window.__riftBastionPerf).toBeUndefined();
    expect(hud.desktopBadge?.isConnected).toBe(false);
  });
});

describe('scripts/perf-quest helpers', () => {
  it('matches Rift Bastion origins and rejects unrelated tabs', () => {
    expect(isMatchingTargetUrl('https://rift-bastion.pardev.net/')).toBe(true);
    expect(isMatchingTargetUrl('https://rift-bastion.pardev.net/?perf')).toBe(true);
    expect(isMatchingTargetUrl('http://localhost:4272/?perf')).toBe(true);
    expect(isMatchingTargetUrl('http://127.0.0.1:4273/')).toBe(true);
    expect(isMatchingTargetUrl('https://example.com/')).toBe(false);
    expect(isMatchingTargetUrl('https://portal-works.pardev.net/')).toBe(false);
    expect(isMatchingTargetUrl('http://192.0.2.20:4272/', '192.0.2.20')).toBe(true);
  });

  it('parses and summarizes Quest VrApi logcat lines cleanly including 5s warmup drop', () => {
    const sampleLines = [
      'noise line without metrics',
      '11-20 12:00:01.000 I/VrApi (1234): FPS=40/72,Prd=41ms,Stale=12,Fov=2,CPU4/GPU=4/4,Temp=35.0C/0.0C,App=19.50ms,GPU%=0.95,SF=1.15',
      '11-20 12:00:02.000 I/VrApi (1234): FPS=72/72,Prd=41ms,Stale=0,Fov=2,CPU4/GPU=4/4,Temp=36.0C/0.0C,App=10.50ms,GPU%=0.64,DSF=1.15',
      '11-20 12:00:03.000 I/VrApi (1234): FPS=70/72,Prd=41ms,Stale=2,Fov=2,CPU4/GPU=4/4,Temp=36.5C/0.0C,App=12.20ms,GPU%=0.74,DSF=1.15',
      '11-20 12:00:04.000 I/VrApi (1234): FPS=48/72,Prd=41ms,Stale=6,Fov=2,CPU4/GPU=4/4,Temp=37.2C/0.0C,App=18.10ms,GPU%=0.91,DSF=1.15',
    ];

    const parsed = parseVrApiLine(sampleLines[2]);
    expect(parsed).toMatchObject({
      fpsDelivered: 72,
      fpsTarget: 72,
      appGpuMs: 10.5,
      gpuPercent: 64,
      stale: 0,
      scaleFactor: 1.15,
      foveation: 2,
      cpuGpuLevels: '4/4',
      tempC: 36,
    });

    // Drop first 1 warmup line (the 40 fps entry)
    const summary = summarizeVrApi(sampleLines, 1);
    expect(summary.totalLines).toBe(4);
    expect(summary.droppedWarmup).toBe(1);
    expect(summary.samples).toBe(3);
    expect(summary.fpsMin).toBe(48);
    expect(summary.secondsBelow50).toBe(1);
    expect(summary.appGpuMaxMs).toBe(18.1);
    expect(summary.staleTotal).toBe(8);
    expect(summary.scaleFactor).toBe(1.15);
    expect(summary.foveation).toBe(2);
    expect(summary.maxTempC).toBe(37.2);
  });

  it('groups complete 1-second buckets into phase/tier/Hz report rows', () => {
    const recorder = createPerfRecorder({ build: 'rep', storage: null });
    const ctx = makeContext({ phase: 'wave-12', reportedHz: 72, qualityTier: 'max-beauty' });
    for (let i = 0; i <= 144; i += 1) {
      recorder.recordFrame(i * (1000 / 72), ctx, 160, 220_000);
    }
    const report = buildPerfReport(recorder.snapshot().seconds, 'xr');
    expect(report['wave-12 / max-beauty / 72Hz']).toEqual({
      seconds: 2,
      minimumFps: 72,
      meanFps: 72,
      under50: 0,
      worstMs: 13.9,
      maxP95Ms: 13.9,
      avgDraws: 160,
      avgTriangles: 220_000,
    });
  });
});
