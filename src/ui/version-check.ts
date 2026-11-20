/** Strict build id format; must match BUILD_ID_PATTERN in scripts/build-version.ts. */
export const BUILD_ID_PATTERN = /^[0-9a-f]{6,64}$/;

export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const MIN_POLL_INTERVAL_MS = 1_000;
export const REQUEST_TIMEOUT_MS = 5_000;
export const EVENT_THROTTLE_MS = 15_000;
export const VERSION_POLL_PARAM = 'version-poll';
export const RELOAD_PARAM = 'v';

export function isValidBuildId(value: unknown): value is string {
  return typeof value === 'string' && BUILD_ID_PATTERN.test(value);
}

/** `?version-poll=<seconds>` shortens the interval; clamped to at least 1 s. Invalid values use the default. */
export function resolvePollIntervalMs(
  search: string,
  defaultMs: number = DEFAULT_POLL_INTERVAL_MS,
): number {
  const raw = new URLSearchParams(search).get(VERSION_POLL_PARAM);
  if (raw === null || raw.trim() === '') return defaultMs;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) return defaultMs;
  return Math.max(MIN_POLL_INTERVAL_MS, Math.round(seconds * 1000));
}

/** Adds/overwrites `?v=<newId>` while preserving every other query parameter and the hash fragment. */
export function buildReloadUrl(href: string, newId: string): string {
  const url = new URL(href, 'http://localhost');
  const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(href);
  url.searchParams.set(RELOAD_PARAM, newId);
  if (isAbsolute) return url.href;
  return `${url.pathname}${url.search}${url.hash}`;
}

export interface VersionWatcherOptions {
  /** Build id embedded in the running page (`window.__APP_BUILD`). 'dev' or missing disables polling. */
  currentBuildId: string | null | undefined;
  /** Called with a newer id (once per id) or `null` when the notice should clear (rollback). */
  onChange: (newId: string | null) => void;
  /** Manifest URL; a cache-busting `t=<now>` parameter is appended. Defaults to `version.json`. */
  url?: string;
  /** Query string used for `?version-poll=`. Defaults to `location.search`. */
  search?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  isOnline?: () => boolean;
  isVisible?: () => boolean;
  intervalMs?: number;
  timeoutMs?: number;
  throttleMs?: number;
  /** Receives `focus` and `online`. Defaults to `window`. */
  eventTarget?: EventTarget;
  /** Receives `visibilitychange`. Defaults to `document`. */
  documentTarget?: EventTarget;
}

export interface VersionWatcher {
  /** False when polling is disabled (dev build, missing id). */
  readonly enabled: boolean;
  /** Newer id currently reported, or null. */
  readonly noticeId: string | null;
  start(): void;
  /** Runs one check now; resolves when it finishes. Skipped while another is in flight or offline. */
  check(): Promise<void>;
  dispose(): void;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('version check aborted'));
    if (signal.aborted) {
      promise.catch(() => undefined);
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export function createVersionWatcher(options: VersionWatcherOptions): VersionWatcher {
  const current = options.currentBuildId;
  const enabled = isValidBuildId(current);
  const now = options.now ?? (() => Date.now());
  const isOnline = options.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine);
  const isVisible =
    options.isVisible ??
    (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const search = options.search ?? (typeof location === 'undefined' ? '' : location.search);
  const intervalMs = resolvePollIntervalMs(search, options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const throttleMs = options.throttleMs ?? EVENT_THROTTLE_MS;
  const baseUrl = options.url ?? 'version.json';

  let started = false;
  let disposed = false;
  let intervalHandle: ReturnType<typeof setInterval> | undefined;
  let active: AbortController | undefined;
  let inFlight: Promise<void> | null = null;
  let lastCheckAt = Number.NEGATIVE_INFINITY;
  let noticeId: string | null = null;
  let eventTarget: EventTarget | undefined;
  let documentTarget: EventTarget | undefined;

  const apply = (id: string): void => {
    const next = id === current ? null : id;
    if (next === noticeId) return;
    noticeId = next;
    try {
      options.onChange(next);
    } catch (error) {
      console.error('version watcher onChange failed', error);
    }
  };

  const run = async (): Promise<void> => {
    const controller = new AbortController();
    active = controller;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
      const separator = baseUrl.includes('?') ? '&' : '?';
      const response = await abortable(
        fetchImpl(`${baseUrl}${separator}t=${now()}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        }),
        controller.signal,
      );
      if (!response.ok) return;
      const body: unknown = await abortable(response.json(), controller.signal);
      if (disposed || typeof body !== 'object' || body === null) return;
      const id = (body as { id?: unknown }).id;
      if (!isValidBuildId(id)) return;
      apply(id);
    } catch {
      // Network, timeout, abort and malformed bodies are silent; any existing notice stays.
    } finally {
      clearTimeout(timer);
      if (active === controller) active = undefined;
    }
  };

  const check = (): Promise<void> => {
    if (!enabled || disposed) return Promise.resolve();
    if (inFlight) return inFlight;
    if (!isOnline()) return Promise.resolve();
    lastCheckAt = now();
    const operation = run().finally(() => {
      if (inFlight === operation) inFlight = null;
    });
    inFlight = operation;
    return operation;
  };

  const throttledCheck = (): void => {
    if (now() - lastCheckAt < throttleMs) return;
    void check();
  };
  const onFocus = (): void => throttledCheck();
  const onOnline = (): void => throttledCheck();
  const onVisibility = (): void => {
    if (isVisible()) throttledCheck();
  };

  return {
    get enabled() {
      return enabled;
    },
    get noticeId() {
      return noticeId;
    },
    start() {
      if (!enabled || disposed || started) return;
      started = true;
      eventTarget = options.eventTarget ?? (typeof window === 'undefined' ? undefined : window);
      documentTarget =
        options.documentTarget ?? (typeof document === 'undefined' ? undefined : document);
      eventTarget?.addEventListener('focus', onFocus);
      eventTarget?.addEventListener('online', onOnline);
      documentTarget?.addEventListener('visibilitychange', onVisibility);
      void check();
      intervalHandle = setInterval(() => void check(), intervalMs);
    },
    check,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (intervalHandle !== undefined) clearInterval(intervalHandle);
      intervalHandle = undefined;
      eventTarget?.removeEventListener('focus', onFocus);
      eventTarget?.removeEventListener('online', onOnline);
      documentTarget?.removeEventListener('visibilitychange', onVisibility);
      active?.abort();
      active = undefined;
    },
  };
}
