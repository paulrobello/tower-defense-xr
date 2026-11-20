import type { QualityTierOption } from '../settings/store';

export const PERF_TRACE_VERSION = 1 as const;
export const PERF_STORAGE_KEY = 'rift-bastion:perf-trace';
export const PERF_FLOOR_FPS = 50;
export const DEFAULT_TARGET_HZ = 60;
export const HITCH_BUDGET_FACTOR = 1.5;

export const DEFAULT_RETENTION_LIMITS = Object.freeze({
  maxSeconds: 1800,
  maxPartialSeconds: 200,
  maxHitches: 500,
  maxEvents: 500,
  maxJsonChars: 2_000_000,
});

export type PerfMode = 'desktop' | 'xr';

export type PerfEventKind =
  | 'grab'
  | 'wave-start'
  | 'portal-open'
  | 'boss-phase'
  | 'segment-end'
  | 'quality-change'
  | 'refresh-change'
  | 'custom';

export interface PerfContext {
  readonly mode: PerfMode;
  readonly phase: string;
  readonly requestedHz: number;
  readonly reportedHz: number | null;
  readonly qualityTier: QualityTierOption;
  readonly effectiveTier?: QualityTierOption;
  readonly framebufferScale: number;
  readonly fixedFoveation: number | null;
}

export interface FrameBucket {
  readonly complete: boolean;
  readonly segmentId: number;
  readonly sessionId: string;
  readonly build: string;
  readonly mode: PerfMode;
  readonly phase: string;
  readonly requestedHz: number;
  readonly reportedHz: number | null;
  readonly qualityTier: QualityTierOption;
  readonly effectiveTier: QualityTierOption;
  readonly framebufferScale: number;
  readonly fixedFoveation: number | null;
  readonly mixedSettings: boolean;
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
  readonly wallMs: number;
  readonly frames: number;
  readonly fps: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly worstMs: number;
  /** Average draw calls per frame (both eyes combined in XR). */
  readonly draws: number;
  /** Average triangles per frame (both eyes combined in XR). */
  readonly triangles: number;
  readonly maxDraws: number;
  readonly maxTriangles: number;
  readonly endReason?: string;
}

export interface PerfHitch {
  readonly build: string;
  readonly sessionId: string;
  readonly segmentId: number;
  readonly mode: PerfMode;
  readonly phase: string;
  readonly ms: number;
  readonly budgetMs: number;
  readonly timeMs: number;
  readonly wallMs: number;
  readonly requestedHz: number;
  readonly reportedHz: number | null;
}

export interface PerfEvent {
  readonly build: string;
  readonly sessionId: string;
  readonly segmentId: number;
  readonly kind: PerfEventKind | string;
  readonly label: string;
  readonly detail?: string;
  readonly timeMs: number;
  readonly wallMs: number;
}

export interface PerfRetentionLimits {
  readonly maxSeconds: number;
  readonly maxPartialSeconds: number;
  readonly maxHitches: number;
  readonly maxEvents: number;
  readonly maxJsonChars: number;
}

export interface PerfRetentionMeta extends PerfRetentionLimits {
  readonly truncated: boolean;
  readonly droppedSeconds: number;
  readonly droppedPartialSeconds: number;
  readonly droppedHitches: number;
  readonly droppedEvents: number;
}

export interface PerfFloorStats {
  readonly floorFps: number;
  readonly completeSeconds: number;
  readonly lowestCompleteSecondFps: number | null;
  readonly secondsBelowFloor: number;
  readonly zeroFrameSeconds: number;
  readonly meanFps: number | null;
  readonly worstFrameMs: number;
  readonly maxP95Ms: number;
}

export interface PerfTraceExport {
  readonly version: typeof PERF_TRACE_VERSION;
  readonly storageKey: string;
  readonly build: string;
  readonly sessionId: string;
  readonly exportedAt: string;
  readonly floorFps: number;
  readonly retention: PerfRetentionMeta;
  readonly stats: PerfFloorStats;
  readonly seconds: readonly FrameBucket[];
  readonly partialSeconds: readonly FrameBucket[];
  readonly current: FrameBucket | null;
  readonly hitches: readonly PerfHitch[];
  readonly events: readonly PerfEvent[];
}

export interface PerfRecorderOptions {
  build?: string;
  storage?: Storage | null;
  storageKey?: string;
  floorFps?: number;
  limits?: Partial<PerfRetentionLimits>;
  persistIntervalMs?: number;
  nowWallMs?: () => number;
  nowMonotonicMs?: () => number;
}

export interface PerfRecorder {
  readonly build: string;
  readonly sessionId: string;
  readonly storageKey: string;
  readonly floorFps: number;
  /**
   * Records a rendered frame at monotonic timestamp `timeMs` (ms).
   * Returns any newly completed 1-second bucket(s) in chronological order (including
   * zero-frame active seconds across a visible stall).
   */
  recordFrame(
    timeMs: number,
    ctx: PerfContext,
    draws: number,
    triangles: number,
  ): readonly FrameBucket[];
  /**
   * Ends the current timing segment (e.g., on visibility loss or XR session entry/exit).
   * Any in-progress partial second is archived into `partialSeconds` and never mixed into
   * complete 1-second buckets.
   */
  endSegment(reason: string, timeMs?: number): FrameBucket | null;
  /** Alias for `endSegment` for compatibility with visibility/lifecycle hooks. */
  pause(reason: string, timeMs?: number): FrameBucket | null;
  onVisibilityChange(visible: boolean, timeMs?: number): void;
  onXrSessionStart(timeMs?: number): void;
  onXrSessionEnd(timeMs?: number): void;
  /**
   * Marks an application event (e.g. `grab`, `wave-start`, `portal-open`, `boss-phase`)
   * without resetting the active bucket or erasing hitches.
   */
  mark(kind: PerfEventKind | string, detail?: string, timeMs?: number, flush?: boolean): PerfEvent;
  snapshot(): PerfTraceExport;
  getLatestCompleteSecond(): FrameBucket | null;
  getLatestBucket(): FrameBucket | null;
  exportJson(pretty?: boolean): string;
  importJson(json: string): PerfTraceExport;
  flush(): void;
  clear(): void;
  dispose(): void;
}

interface ActiveBucket {
  segmentId: number;
  startMs: number;
  lastMs: number;
  frames: number;
  intervals: number[];
  drawsSum: number;
  trianglesSum: number;
  maxDraws: number;
  maxTriangles: number;
  ctx: PerfContext;
  mixedSettings: boolean;
}

interface StoredTracePayload {
  version: typeof PERF_TRACE_VERSION;
  build: string;
  retention: PerfRetentionMeta;
  seconds: FrameBucket[];
  partialSeconds: FrameBucket[];
  hitches: PerfHitch[];
  events: PerfEvent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function sanitizeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function settingsDiffer(a: PerfContext, b: PerfContext): boolean {
  return (
    a.mode !== b.mode ||
    a.requestedHz !== b.requestedHz ||
    a.reportedHz !== b.reportedHz ||
    a.qualityTier !== b.qualityTier ||
    (a.effectiveTier ?? a.qualityTier) !== (b.effectiveTier ?? b.qualityTier) ||
    a.framebufferScale !== b.framebufferScale ||
    a.fixedFoveation !== b.fixedFoveation
  );
}

function isValidFrameBucket(value: unknown): value is FrameBucket {
  if (!isRecord(value)) return false;
  return (
    typeof value.complete === 'boolean' &&
    typeof value.segmentId === 'number' &&
    typeof value.sessionId === 'string' &&
    typeof value.build === 'string' &&
    (value.mode === 'desktop' || value.mode === 'xr') &&
    typeof value.phase === 'string' &&
    typeof value.requestedHz === 'number' &&
    Number.isFinite(value.requestedHz) &&
    (value.reportedHz === null ||
      (typeof value.reportedHz === 'number' && Number.isFinite(value.reportedHz))) &&
    typeof value.qualityTier === 'string' &&
    typeof value.effectiveTier === 'string' &&
    typeof value.framebufferScale === 'number' &&
    (value.fixedFoveation === null || typeof value.fixedFoveation === 'number') &&
    typeof value.startMs === 'number' &&
    typeof value.endMs === 'number' &&
    typeof value.durationMs === 'number' &&
    typeof value.frames === 'number' &&
    Number.isFinite(value.fps) &&
    Number.isFinite(value.p95Ms) &&
    Number.isFinite(value.worstMs)
  );
}

function isValidHitch(value: unknown): value is PerfHitch {
  if (!isRecord(value)) return false;
  return (
    typeof value.build === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.ms === 'number' &&
    Number.isFinite(value.ms) &&
    typeof value.timeMs === 'number'
  );
}

function isValidEvent(value: unknown): value is PerfEvent {
  if (!isRecord(value)) return false;
  return (
    typeof value.build === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.label === 'string' &&
    typeof value.timeMs === 'number'
  );
}

export function computePerfFloorStats(
  seconds: readonly FrameBucket[],
  floorFps = PERF_FLOOR_FPS,
): PerfFloorStats {
  const completeOnly = seconds.filter((bucket) => bucket.complete && bucket.durationMs === 1000);
  if (completeOnly.length === 0) {
    return {
      floorFps,
      completeSeconds: 0,
      lowestCompleteSecondFps: null,
      secondsBelowFloor: 0,
      zeroFrameSeconds: 0,
      meanFps: null,
      worstFrameMs: 0,
      maxP95Ms: 0,
    };
  }

  let lowest = Number.POSITIVE_INFINITY;
  let belowFloor = 0;
  let zeroFrames = 0;
  let fpsSum = 0;
  let worstMs = 0;
  let maxP95 = 0;

  for (const bucket of completeOnly) {
    if (bucket.fps < lowest) lowest = bucket.fps;
    if (bucket.fps < floorFps) belowFloor += 1;
    if (bucket.frames === 0) zeroFrames += 1;
    fpsSum += bucket.fps;
    if (bucket.worstMs > worstMs) worstMs = bucket.worstMs;
    if (bucket.p95Ms > maxP95) maxP95 = bucket.p95Ms;
  }

  return {
    floorFps,
    completeSeconds: completeOnly.length,
    lowestCompleteSecondFps: lowest,
    secondsBelowFloor: belowFloor,
    zeroFrameSeconds: zeroFrames,
    meanFps: Math.round((fpsSum / completeOnly.length) * 100) / 100,
    worstFrameMs: roundMs(worstMs),
    maxP95Ms: roundMs(maxP95),
  };
}

function normalizeRetention(raw: unknown, fallbackLimits: PerfRetentionLimits): PerfRetentionMeta {
  const r = isRecord(raw) ? raw : {};
  const positiveInt = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
  const nonNegInt = (value: unknown): number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

  const droppedSeconds = nonNegInt(r.droppedSeconds);
  const droppedPartialSeconds = nonNegInt(r.droppedPartialSeconds);
  const droppedHitches = nonNegInt(r.droppedHitches);
  const droppedEvents = nonNegInt(r.droppedEvents);
  const truncated =
    r.truncated === true ||
    droppedSeconds > 0 ||
    droppedPartialSeconds > 0 ||
    droppedHitches > 0 ||
    droppedEvents > 0;

  return {
    maxSeconds: positiveInt(r.maxSeconds, fallbackLimits.maxSeconds),
    maxPartialSeconds: positiveInt(r.maxPartialSeconds, fallbackLimits.maxPartialSeconds),
    maxHitches: positiveInt(r.maxHitches, fallbackLimits.maxHitches),
    maxEvents: positiveInt(r.maxEvents, fallbackLimits.maxEvents),
    maxJsonChars: positiveInt(r.maxJsonChars, fallbackLimits.maxJsonChars),
    truncated,
    droppedSeconds,
    droppedPartialSeconds,
    droppedHitches,
    droppedEvents,
  };
}

/**
 * Parses and validates an exported perf trace JSON string or object.
 * Throws an `Error` if the payload is invalid or uses an unsupported version.
 */
export function importPerfTrace(input: string | unknown): PerfTraceExport {
  let parsed: unknown;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch (error) {
      throw new Error(`Invalid perf trace JSON: ${(error as Error).message}`);
    }
  } else {
    parsed = input;
  }

  if (!isRecord(parsed)) {
    throw new Error('Perf trace payload must be a JSON object.');
  }
  if (parsed.version !== PERF_TRACE_VERSION) {
    throw new Error(`Unsupported perf trace version: ${String(parsed.version)}`);
  }
  if (!Array.isArray(parsed.seconds)) {
    throw new Error('Perf trace payload is missing complete "seconds" array.');
  }

  const floorFps =
    typeof parsed.floorFps === 'number' && Number.isFinite(parsed.floorFps) && parsed.floorFps > 0
      ? parsed.floorFps
      : PERF_FLOOR_FPS;

  const seconds = parsed.seconds.filter(
    (entry): entry is FrameBucket =>
      isValidFrameBucket(entry) && entry.complete && entry.durationMs === 1000,
  );
  const partialSeconds = Array.isArray(parsed.partialSeconds)
    ? parsed.partialSeconds.filter(
        (entry): entry is FrameBucket => isValidFrameBucket(entry) && !entry.complete,
      )
    : [];
  const current =
    parsed.current !== null && parsed.current !== undefined && isValidFrameBucket(parsed.current)
      ? parsed.current
      : null;
  const hitches = Array.isArray(parsed.hitches) ? parsed.hitches.filter(isValidHitch) : [];
  const events = Array.isArray(parsed.events) ? parsed.events.filter(isValidEvent) : [];

  const retention = normalizeRetention(parsed.retention, DEFAULT_RETENTION_LIMITS);
  const stats = computePerfFloorStats(seconds, floorFps);

  return {
    version: PERF_TRACE_VERSION,
    storageKey: typeof parsed.storageKey === 'string' ? parsed.storageKey : PERF_STORAGE_KEY,
    build: typeof parsed.build === 'string' ? parsed.build : 'unknown',
    sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : 'imported',
    exportedAt:
      typeof parsed.exportedAt === 'string' ? parsed.exportedAt : new Date().toISOString(),
    floorFps,
    retention,
    stats,
    seconds,
    partialSeconds,
    current,
    hitches,
    events,
  };
}

function defaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function createPerfRecorder(options: PerfRecorderOptions = {}): PerfRecorder {
  const build = options.build ?? (typeof __APP_BUILD === 'string' ? __APP_BUILD : 'dev');
  const storage = options.storage !== undefined ? options.storage : defaultStorage();
  const storageKey = options.storageKey ?? PERF_STORAGE_KEY;
  const floorFps = options.floorFps ?? PERF_FLOOR_FPS;
  const persistIntervalMs = options.persistIntervalMs ?? 15_000;
  const nowWallMs = options.nowWallMs ?? (() => Date.now());
  const nowMonotonicMs =
    options.nowMonotonicMs ??
    (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));

  const limits: PerfRetentionLimits = {
    maxSeconds: Math.max(
      1,
      Math.floor(options.limits?.maxSeconds ?? DEFAULT_RETENTION_LIMITS.maxSeconds),
    ),
    maxPartialSeconds: Math.max(
      1,
      Math.floor(options.limits?.maxPartialSeconds ?? DEFAULT_RETENTION_LIMITS.maxPartialSeconds),
    ),
    maxHitches: Math.max(
      1,
      Math.floor(options.limits?.maxHitches ?? DEFAULT_RETENTION_LIMITS.maxHitches),
    ),
    maxEvents: Math.max(
      1,
      Math.floor(options.limits?.maxEvents ?? DEFAULT_RETENTION_LIMITS.maxEvents),
    ),
    maxJsonChars: Math.max(
      512,
      Math.floor(options.limits?.maxJsonChars ?? DEFAULT_RETENTION_LIMITS.maxJsonChars),
    ),
  };

  const sessionId = `${nowWallMs()}-${Math.random().toString(36).slice(2, 8)}`;
  const timeOrigin = nowWallMs() - nowMonotonicMs();

  let seconds: FrameBucket[] = [];
  let partialSeconds: FrameBucket[] = [];
  let hitches: PerfHitch[] = [];
  let events: PerfEvent[] = [];

  let droppedSeconds = 0;
  let droppedPartialSeconds = 0;
  let droppedHitches = 0;
  let droppedEvents = 0;

  let segmentId = 1;
  let activeBucket: ActiveBucket | null = null;
  let previousMs: number | null = null;
  let paused = false;
  let lastPersistMs = -Infinity;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const currentRetention = (): PerfRetentionMeta => ({
    ...limits,
    truncated:
      droppedSeconds > 0 || droppedPartialSeconds > 0 || droppedHitches > 0 || droppedEvents > 0,
    droppedSeconds,
    droppedPartialSeconds,
    droppedHitches,
    droppedEvents,
  });

  const pushCompleteSecond = (bucket: FrameBucket): void => {
    seconds.push(bucket);
    if (seconds.length > limits.maxSeconds) {
      const overflow = seconds.length - limits.maxSeconds;
      seconds.splice(0, overflow);
      droppedSeconds += overflow;
    }
  };

  const pushPartialSecond = (bucket: FrameBucket): void => {
    partialSeconds.push(bucket);
    if (partialSeconds.length > limits.maxPartialSeconds) {
      const overflow = partialSeconds.length - limits.maxPartialSeconds;
      partialSeconds.splice(0, overflow);
      droppedPartialSeconds += overflow;
    }
  };

  const pushHitch = (hitch: PerfHitch): void => {
    hitches.push(hitch);
    if (hitches.length > limits.maxHitches) {
      const overflow = hitches.length - limits.maxHitches;
      hitches.splice(0, overflow);
      droppedHitches += overflow;
    }
  };

  const pushEvent = (event: PerfEvent): void => {
    events.push(event);
    if (events.length > limits.maxEvents) {
      const overflow = events.length - limits.maxEvents;
      events.splice(0, overflow);
      droppedEvents += overflow;
    }
  };

  const summarizeActiveBucket = (
    bucket: ActiveBucket,
    complete: boolean,
    endReason?: string,
  ): FrameBucket => {
    const sorted = bucket.intervals.slice().sort((a, b) => a - b);
    const durationMs = complete ? 1000 : Math.max(0, roundMs(bucket.lastMs - bucket.startMs));
    const endMs = complete ? bucket.startMs + 1000 : bucket.lastMs;
    const fps = complete
      ? bucket.frames
      : durationMs > 0
        ? Math.round(((bucket.frames * 1000) / durationMs) * 100) / 100
        : 0;

    return {
      complete,
      segmentId: bucket.segmentId,
      sessionId,
      build,
      mode: bucket.ctx.mode,
      phase: bucket.ctx.phase,
      requestedHz: bucket.ctx.requestedHz,
      reportedHz: bucket.ctx.reportedHz,
      qualityTier: bucket.ctx.qualityTier,
      effectiveTier: bucket.ctx.effectiveTier ?? bucket.ctx.qualityTier,
      framebufferScale: bucket.ctx.framebufferScale,
      fixedFoveation: bucket.ctx.fixedFoveation,
      mixedSettings: bucket.mixedSettings,
      startMs: roundMs(bucket.startMs),
      endMs: roundMs(endMs),
      durationMs,
      wallMs: Math.round(timeOrigin + bucket.startMs),
      frames: bucket.frames,
      fps,
      p50Ms: roundMs(percentile(sorted, 0.5)),
      p95Ms: roundMs(percentile(sorted, 0.95)),
      p99Ms: roundMs(percentile(sorted, 0.99)),
      worstMs: sorted.length > 0 ? roundMs(sorted[sorted.length - 1]) : 0,
      draws: bucket.frames > 0 ? Math.round(bucket.drawsSum / bucket.frames) : 0,
      triangles: bucket.frames > 0 ? Math.round(bucket.trianglesSum / bucket.frames) : 0,
      maxDraws: bucket.maxDraws,
      maxTriangles: bucket.maxTriangles,
      ...(endReason !== undefined ? { endReason } : {}),
    };
  };

  const makeEmptyBucket = (startMs: number, ctx: PerfContext): ActiveBucket => ({
    segmentId,
    startMs,
    lastMs: startMs,
    frames: 0,
    intervals: [],
    drawsSum: 0,
    trianglesSum: 0,
    maxDraws: 0,
    maxTriangles: 0,
    ctx,
    mixedSettings: false,
  });

  const hydrateFromStorage = (): void => {
    if (!storage) return;
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<StoredTracePayload>;
      if (parsed.version !== PERF_TRACE_VERSION || !Array.isArray(parsed.seconds)) return;

      const meta = normalizeRetention(parsed.retention, limits);
      droppedSeconds = meta.droppedSeconds;
      droppedPartialSeconds = meta.droppedPartialSeconds;
      droppedHitches = meta.droppedHitches;
      droppedEvents = meta.droppedEvents;

      const loadedSeconds = parsed.seconds.filter(
        (entry): entry is FrameBucket =>
          isValidFrameBucket(entry) && entry.complete && entry.durationMs === 1000,
      );
      if (loadedSeconds.length > limits.maxSeconds) {
        const overflow = loadedSeconds.length - limits.maxSeconds;
        seconds = loadedSeconds.slice(overflow);
        droppedSeconds += overflow;
      } else {
        seconds = loadedSeconds;
      }

      const loadedPartials = Array.isArray(parsed.partialSeconds)
        ? parsed.partialSeconds.filter(
            (entry): entry is FrameBucket => isValidFrameBucket(entry) && !entry.complete,
          )
        : [];
      if (loadedPartials.length > limits.maxPartialSeconds) {
        const overflow = loadedPartials.length - limits.maxPartialSeconds;
        partialSeconds = loadedPartials.slice(overflow);
        droppedPartialSeconds += overflow;
      } else {
        partialSeconds = loadedPartials;
      }

      const loadedHitches = Array.isArray(parsed.hitches)
        ? parsed.hitches.filter(isValidHitch)
        : [];
      if (loadedHitches.length > limits.maxHitches) {
        const overflow = loadedHitches.length - limits.maxHitches;
        hitches = loadedHitches.slice(overflow);
        droppedHitches += overflow;
      } else {
        hitches = loadedHitches;
      }

      const loadedEvents = Array.isArray(parsed.events) ? parsed.events.filter(isValidEvent) : [];
      if (loadedEvents.length > limits.maxEvents) {
        const overflow = loadedEvents.length - limits.maxEvents;
        events = loadedEvents.slice(overflow);
        droppedEvents += overflow;
      } else {
        events = loadedEvents;
      }
    } catch {
      seconds = [];
      partialSeconds = [];
      hitches = [];
      events = [];
    }
  };

  const flush = (): void => {
    if (persistTimer !== undefined) {
      clearTimeout(persistTimer);
      persistTimer = undefined;
    }
    if (!storage) return;

    try {
      let payload: StoredTracePayload = {
        version: PERF_TRACE_VERSION,
        build,
        retention: currentRetention(),
        seconds: seconds.slice(-limits.maxSeconds),
        partialSeconds: partialSeconds.slice(-limits.maxPartialSeconds),
        hitches: hitches.slice(-limits.maxHitches),
        events: events.slice(-limits.maxEvents),
      };

      let json = JSON.stringify(payload);
      while (json.length > limits.maxJsonChars) {
        if (payload.seconds.length > 0) {
          const cut = Math.max(1, Math.ceil(payload.seconds.length / 4));
          payload.seconds = payload.seconds.slice(cut);
          droppedSeconds += cut;
        } else if (payload.partialSeconds.length > 0) {
          const cut = Math.max(1, Math.ceil(payload.partialSeconds.length / 2));
          payload.partialSeconds = payload.partialSeconds.slice(cut);
          droppedPartialSeconds += cut;
        } else if (payload.hitches.length > 0) {
          const cut = Math.max(1, Math.ceil(payload.hitches.length / 2));
          payload.hitches = payload.hitches.slice(cut);
          droppedHitches += cut;
        } else if (payload.events.length > 0) {
          const cut = Math.max(1, Math.ceil(payload.events.length / 2));
          payload.events = payload.events.slice(cut);
          droppedEvents += cut;
        } else {
          break;
        }
        payload = {
          ...payload,
          retention: currentRetention(),
        };
        json = JSON.stringify(payload);
      }

      seconds = payload.seconds;
      partialSeconds = payload.partialSeconds;
      hitches = payload.hitches;
      events = payload.events;

      storage.setItem(storageKey, json);
    } catch {
      // Storage may be denied or exceed browser quota; in-memory trace stays intact.
    }
  };

  const schedulePersist = (timeMs: number, immediate = false): void => {
    if (!storage || disposed) return;
    if (immediate) {
      flush();
      lastPersistMs = timeMs;
      return;
    }
    if (persistTimer !== undefined || timeMs - lastPersistMs < persistIntervalMs) return;
    lastPersistMs = timeMs;
    persistTimer = setTimeout(flush, 0);
  };

  const endSegment = (reason: string, timeMs?: number): FrameBucket | null => {
    const stamp =
      timeMs !== undefined && Number.isFinite(timeMs) ? timeMs : (previousMs ?? nowMonotonicMs());
    let partial: FrameBucket | null = null;
    if (activeBucket && activeBucket.frames > 0) {
      partial = summarizeActiveBucket(activeBucket, false, reason);
      pushPartialSecond(partial);
    }
    const hadOpenSegment = activeBucket !== null || previousMs !== null || !paused;
    activeBucket = null;
    previousMs = null;
    paused = true;
    if (hadOpenSegment) {
      pushEvent({
        build,
        sessionId,
        segmentId,
        kind: 'segment-end',
        label: `segment-end:${reason}`,
        detail: reason,
        timeMs: roundMs(stamp),
        wallMs: nowWallMs(),
      });
      segmentId += 1;
      schedulePersist(stamp, true);
    }
    return partial;
  };

  const snapshot = (): PerfTraceExport => {
    const current =
      activeBucket && activeBucket.frames > 0 ? summarizeActiveBucket(activeBucket, false) : null;
    const retainedSeconds = seconds.slice(-limits.maxSeconds);
    return {
      version: PERF_TRACE_VERSION,
      storageKey,
      build,
      sessionId,
      exportedAt: new Date(nowWallMs()).toISOString(),
      floorFps,
      retention: currentRetention(),
      stats: computePerfFloorStats(retainedSeconds, floorFps),
      seconds: retainedSeconds,
      partialSeconds: partialSeconds.slice(-limits.maxPartialSeconds),
      current,
      hitches: hitches.slice(-limits.maxHitches),
      events: events.slice(-limits.maxEvents),
    };
  };

  hydrateFromStorage();

  return {
    build,
    sessionId,
    storageKey,
    floorFps,
    recordFrame(timeMs, ctx, draws, triangles) {
      if (disposed || !Number.isFinite(timeMs)) return [];
      const cleanDraws = sanitizeCount(draws);
      const cleanTriangles = sanitizeCount(triangles);

      if (paused) {
        paused = false;
        activeBucket = null;
        previousMs = null;
      }

      if (previousMs === null || !Number.isFinite(previousMs) || timeMs <= previousMs) {
        previousMs = timeMs;
        activeBucket = {
          segmentId,
          startMs: timeMs,
          lastMs: timeMs,
          frames: 1,
          intervals: [],
          drawsSum: cleanDraws,
          trianglesSum: cleanTriangles,
          maxDraws: cleanDraws,
          maxTriangles: cleanTriangles,
          ctx,
          mixedSettings: false,
        };
        return [];
      }

      const dt = timeMs - previousMs;
      previousMs = timeMs;
      const completed: FrameBucket[] = [];

      let emittedBins = 0;
      while (
        activeBucket &&
        timeMs - activeBucket.startMs >= 1000 &&
        emittedBins < limits.maxSeconds
      ) {
        const nextStart = activeBucket.startMs + 1000;
        const closed = summarizeActiveBucket(activeBucket, true);
        pushCompleteSecond(closed);
        completed.push(closed);
        activeBucket = makeEmptyBucket(nextStart, ctx);
        emittedBins += 1;
      }

      if (activeBucket && timeMs - activeBucket.startMs >= 1000) {
        const excessSeconds = Math.floor((timeMs - activeBucket.startMs) / 1000);
        activeBucket.startMs += excessSeconds * 1000;
        activeBucket.lastMs = activeBucket.startMs;
        droppedSeconds += excessSeconds;
      }

      if (!activeBucket) {
        activeBucket = makeEmptyBucket(timeMs, ctx);
      }

      if (activeBucket.frames === 0) {
        activeBucket.ctx = ctx;
      } else {
        if (settingsDiffer(activeBucket.ctx, ctx)) {
          activeBucket.mixedSettings = true;
        }
        if (activeBucket.ctx.phase !== ctx.phase && activeBucket.ctx.phase !== 'mixed') {
          activeBucket.ctx = { ...activeBucket.ctx, phase: 'mixed' };
        }
      }

      activeBucket.frames += 1;
      activeBucket.drawsSum += cleanDraws;
      activeBucket.trianglesSum += cleanTriangles;
      if (cleanDraws > activeBucket.maxDraws) activeBucket.maxDraws = cleanDraws;
      if (cleanTriangles > activeBucket.maxTriangles) activeBucket.maxTriangles = cleanTriangles;
      activeBucket.lastMs = timeMs;
      activeBucket.intervals.push(dt);

      const budgetHz =
        ctx.reportedHz ?? (ctx.mode === 'desktop' ? DEFAULT_TARGET_HZ : ctx.requestedHz);
      const safeHz = Number.isFinite(budgetHz) && budgetHz > 0 ? budgetHz : DEFAULT_TARGET_HZ;
      const budgetMs = 1000 / safeHz;
      if (dt > HITCH_BUDGET_FACTOR * budgetMs) {
        pushHitch({
          build,
          sessionId,
          segmentId,
          mode: ctx.mode,
          phase: ctx.phase,
          ms: roundMs(dt),
          budgetMs: roundMs(budgetMs),
          timeMs: roundMs(timeMs),
          wallMs: Math.round(timeOrigin + timeMs),
          requestedHz: ctx.requestedHz,
          reportedHz: ctx.reportedHz,
        });
      }

      schedulePersist(timeMs, false);
      return completed;
    },
    endSegment,
    pause: endSegment,
    onVisibilityChange(visible, timeMs) {
      if (!visible) endSegment('visibility-hidden', timeMs);
    },
    onXrSessionStart(timeMs) {
      endSegment('xr-enter', timeMs);
    },
    onXrSessionEnd(timeMs) {
      endSegment('xr-exit', timeMs);
    },
    mark(kind, detail, timeMs, shouldFlush = false) {
      const stamp =
        timeMs !== undefined && Number.isFinite(timeMs) ? timeMs : (previousMs ?? nowMonotonicMs());
      const cleanKind = String(kind).slice(0, 48);
      const cleanDetail = detail !== undefined ? String(detail).slice(0, 100) : undefined;
      const event: PerfEvent = {
        build,
        sessionId,
        segmentId,
        kind: cleanKind,
        label: cleanDetail ? `${cleanKind}:${cleanDetail}` : cleanKind,
        ...(cleanDetail !== undefined ? { detail: cleanDetail } : {}),
        timeMs: roundMs(stamp),
        wallMs: nowWallMs(),
      };
      pushEvent(event);
      schedulePersist(stamp, shouldFlush);
      return event;
    },
    snapshot,
    getLatestCompleteSecond() {
      return seconds.length > 0 ? seconds[seconds.length - 1] : null;
    },
    getLatestBucket() {
      if (activeBucket && activeBucket.frames > 0) {
        return summarizeActiveBucket(activeBucket, false);
      }
      return seconds.length > 0 ? seconds[seconds.length - 1] : null;
    },
    exportJson(pretty = false) {
      return JSON.stringify(snapshot(), null, pretty ? 2 : undefined);
    },
    importJson(json) {
      const imported = importPerfTrace(json);
      seconds = [...imported.seconds].slice(-limits.maxSeconds);
      partialSeconds = [...imported.partialSeconds].slice(-limits.maxPartialSeconds);
      hitches = [...imported.hitches].slice(-limits.maxHitches);
      events = [...imported.events].slice(-limits.maxEvents);
      droppedSeconds = imported.retention.droppedSeconds;
      droppedPartialSeconds = imported.retention.droppedPartialSeconds;
      droppedHitches = imported.retention.droppedHitches;
      droppedEvents = imported.retention.droppedEvents;
      activeBucket = null;
      previousMs = null;
      paused = false;
      flush();
      return snapshot();
    },
    flush,
    clear() {
      if (persistTimer !== undefined) {
        clearTimeout(persistTimer);
        persistTimer = undefined;
      }
      seconds = [];
      partialSeconds = [];
      hitches = [];
      events = [];
      droppedSeconds = 0;
      droppedPartialSeconds = 0;
      droppedHitches = 0;
      droppedEvents = 0;
      activeBucket = null;
      previousMs = null;
      paused = false;
      try {
        storage?.removeItem(storageKey);
      } catch {
        // Ignore denied storage.
      }
    },
    dispose() {
      if (disposed) return;
      flush();
      disposed = true;
    },
  };
}
