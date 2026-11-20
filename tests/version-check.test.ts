import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeContentHash,
  currentBuildId,
  normalizeBuildId,
  sourceFingerprint,
} from '../scripts/build-version.ts';
import {
  buildReloadUrl,
  createVersionWatcher,
  isValidBuildId,
  resolvePollIntervalMs,
  type VersionWatcher,
  type VersionWatcherOptions,
} from '../src/ui/version-check.ts';
import {
  createVersionNotice,
  reloadAfterXRExit,
  type SessionLike,
} from '../src/ui/version-notice.ts';

// Real menu panels build troika SDF labels (fonts/WebGL), which happy-dom cannot provide. Replace only
// createMenuPanel with a faithful stand-in for the surface the notice uses; keepAbove stays real.
vi.mock('@par/xr-workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@par/xr-workspace')>();
  const THREE = await import('three');
  return {
    ...actual,
    createMenuPanel: (options: {
      rows: ReadonlyArray<{ id: string; label: string; onSelect?: () => void }>;
    }) => {
      const handlers = new Map(options.rows.map((row) => [row.id, row.onSelect]));
      const labels = new Map(options.rows.map((row) => [row.id, row.label]));
      return {
        root: new THREE.Group(),
        labels,
        activate: (id: string) => {
          const handler = handlers.get(id);
          handler?.();
          return handler !== undefined;
        },
        setLabel: (id: string, label: string) => labels.set(id, label),
        dispose: () => undefined,
      };
    },
  };
});

const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';
const C = 'cccccccccccc';

type FakeFetch = ReturnType<typeof vi.fn<typeof fetch>>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('version watcher', () => {
  let target: EventTarget;
  let doc: EventTarget;
  let online: boolean;
  let changes: Array<string | null>;
  let watcher: VersionWatcher | undefined;
  let fetchFn: FakeFetch;

  const make = (extra: Partial<VersionWatcherOptions> = {}): VersionWatcher => {
    watcher = createVersionWatcher({
      currentBuildId: A,
      onChange: (id) => changes.push(id),
      fetch: fetchFn,
      isOnline: () => online,
      isVisible: () => true,
      eventTarget: target,
      documentTarget: doc,
      search: '',
      ...extra,
    });
    return watcher;
  };
  const respond = (id: unknown): void => {
    fetchFn.mockImplementation(async () => jsonResponse({ id }));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    target = new EventTarget();
    doc = new EventTarget();
    online = true;
    changes = [];
    fetchFn = vi.fn<typeof fetch>();
    respond(A);
  });
  afterEach(() => {
    watcher?.dispose();
    watcher = undefined;
    vi.useRealTimers();
  });

  it('stays silent when the manifest id matches the running build', async () => {
    make().start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([]);
  });

  it('reports a newer id on the first poll without adopting it as the baseline, once', async () => {
    respond(B);
    const w = make();
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toEqual([B]);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(changes).toEqual([B]);
    expect(w.noticeId).toBe(B);
    respond(C);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(changes).toEqual([B, C]);
  });

  it('sends a cache-bypassing request', async () => {
    make().start();
    await vi.advanceTimersByTimeAsync(0);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('version.json?t=1000000');
    expect(init?.cache).toBe('no-store');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps the prior notice through network errors, 500s and malformed JSON', async () => {
    respond(B);
    make().start();
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toEqual([B]);

    fetchFn.mockRejectedValue(new TypeError('network down'));
    await vi.advanceTimersByTimeAsync(30_000);
    fetchFn.mockImplementation(async () => jsonResponse({ id: A }, 500));
    await vi.advanceTimersByTimeAsync(30_000);
    fetchFn.mockImplementation(async () => new Response('<html>oops', { status: 200 }));
    await vi.advanceTimersByTimeAsync(30_000);
    for (const bad of [null, 42, 'zzzzzz', 'DEADBEEF', 'abc', '', `${'a'.repeat(65)}`, { x: 1 }]) {
      fetchFn.mockImplementation(async () => jsonResponse(bad));
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(fetchFn).toHaveBeenCalledTimes(12);
    expect(changes).toEqual([B]);
    expect(watcher?.noticeId).toBe(B);
  });

  it('is silent on first-poll failures', async () => {
    fetchFn.mockRejectedValue(new Error('boom'));
    make().start();
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toEqual([]);
  });

  it('skips requests while offline and resumes when back online', async () => {
    online = false;
    make().start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchFn).not.toHaveBeenCalled();
    online = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('clears the notice on rollback to the running build and re-reports a later newer id', async () => {
    respond(B);
    make().start();
    await vi.advanceTimersByTimeAsync(0);
    respond(A);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(changes).toEqual([B, null]);
    expect(watcher?.noticeId).toBeNull();
    respond(B);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(changes).toEqual([B, null, B]);
  });

  it('does not overlap requests while one is in flight', async () => {
    let release: (() => void) | undefined;
    fetchFn.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(jsonResponse({ id: B }));
        }),
    );
    const w = make({ intervalMs: 1_000 });
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    void w.check();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toEqual([B]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('aborts a hung request after 5 s, including a hung body, and retries on the next tick', async () => {
    let signal: AbortSignal | null | undefined;
    fetchFn.mockImplementation(async (_url, init) => {
      signal = init?.signal;
      return {
        ok: true,
        json: () => new Promise(() => undefined),
      } as unknown as Response;
    });
    make().start();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    respond(B);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(changes).toEqual([B]);
  });

  it('throttles focus, visibility and online checks to 15 s', async () => {
    make().start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    target.dispatchEvent(new Event('focus'));
    doc.dispatchEvent(new Event('visibilitychange'));
    target.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(14_999);
    target.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    target.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    target.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000); // interval tick at t=30 s
    expect(fetchFn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(15_000);
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('ignores visibilitychange while hidden', async () => {
    let visible = false;
    make({ isVisible: () => visible }).start();
    await vi.advanceTimersByTimeAsync(20_000);
    const before = fetchFn.mock.calls.length;
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(before);
    visible = true;
    await vi.advanceTimersByTimeAsync(15_000);
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn.mock.calls.length).toBe(before + 1);
  });

  it('honours ?version-poll= and clamps it to at least 1 s', async () => {
    expect(resolvePollIntervalMs('')).toBe(30_000);
    expect(resolvePollIntervalMs('?version-poll=5')).toBe(5_000);
    expect(resolvePollIntervalMs('?version-poll=0')).toBe(1_000);
    expect(resolvePollIntervalMs('?version-poll=-3')).toBe(1_000);
    expect(resolvePollIntervalMs('?version-poll=0.2')).toBe(1_000);
    expect(resolvePollIntervalMs('?version-poll=abc')).toBe(30_000);
    expect(resolvePollIntervalMs('?version-poll=')).toBe(30_000);
    expect(resolvePollIntervalMs('?a=1&version-poll=2.5')).toBe(2_500);

    make({ search: '?version-poll=0' }).start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('uses a 30 s interval by default', async () => {
    make().start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([['dev'], [undefined], [null], [''], ['not-hex']])(
    'never polls for build id %s',
    async (id) => {
      const w = make({ currentBuildId: id });
      w.start();
      target.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(60_000);
      await w.check();
      expect(w.enabled).toBe(false);
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it('dispose aborts the active request and stops timers and listeners', async () => {
    let signal: AbortSignal | null | undefined;
    fetchFn.mockImplementation((_url, init) => {
      signal = init?.signal;
      return new Promise<Response>(() => undefined);
    });
    const w = make();
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    w.dispose();
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    target.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('validates ids strictly', () => {
    expect(isValidBuildId('deadbeef0123')).toBe(true);
    for (const bad of [
      'DEADBEEF',
      'abc12',
      'g'.repeat(12),
      'a'.repeat(65),
      12345678,
      null,
      'dev',
    ]) {
      expect(isValidBuildId(bad)).toBe(false);
    }
  });
});

describe('cache-busting reload URL', () => {
  it('preserves existing query parameters and the fragment', () => {
    const url = new URL(
      buildReloadUrl('https://rift-bastion.pardev.net/play/?a=1&b=two#wave-3', B),
    );
    expect(url.origin).toBe('https://rift-bastion.pardev.net');
    expect(url.pathname).toBe('/play/');
    expect(url.searchParams.get('a')).toBe('1');
    expect(url.searchParams.get('b')).toBe('two');
    expect(url.searchParams.get('v')).toBe(B);
    expect(url.hash).toBe('#wave-3');
  });

  it('replaces a previous v parameter and works without a query', () => {
    expect(buildReloadUrl('https://x.test/?v=old&q=1', B)).toBe(`https://x.test/?v=${B}&q=1`);
    expect(buildReloadUrl('https://x.test/#frag', B)).toBe(`https://x.test/?v=${B}#frag`);
  });
});

describe('version notice', () => {
  const location = (href = 'https://x.test/?mode=a#h') => ({ href, replace: vi.fn() });
  const noticeEl = (): HTMLElement | null => document.querySelector('[data-version-notice]');

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('auto-reloads on desktop when idle', () => {
    const loc = location();
    const notice = createVersionNotice({ location: loc });
    notice.update(B);
    expect(loc.replace).toHaveBeenCalledWith(`https://x.test/?mode=a&v=${B}#h`);
    expect(noticeEl()).toBeNull();
    notice.dispose();
  });

  it('shows a compact topmost notice instead of reloading when state is unsaved', () => {
    const loc = location();
    const notice = createVersionNotice({ location: loc, hasUnsavedState: () => true });
    notice.update(B);
    expect(loc.replace).not.toHaveBeenCalled();
    const el = noticeEl();
    expect(el?.style.zIndex).toBe('2147483647');
    const buttons = [...(el?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
    expect(buttons).toEqual(['Reload anyway', 'Later']);

    const leaked = vi.fn();
    document.addEventListener('keydown', leaked);
    el?.querySelector('button')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'w', bubbles: true }),
    );
    expect(leaked).not.toHaveBeenCalled();
    document.removeEventListener('keydown', leaked);

    el?.querySelectorAll('button')[0]?.click();
    expect(loc.replace).toHaveBeenCalledWith(`https://x.test/?mode=a&v=${B}#h`);
    notice.dispose();
  });

  it('Later hides until the next newer id and rollback clears the notice', () => {
    const notice = createVersionNotice({ location: location(), hasUnsavedState: () => true });
    notice.update(B);
    expect(noticeEl()).not.toBeNull();
    noticeEl()?.querySelectorAll('button')[1]?.click();
    expect(noticeEl()).toBeNull();
    notice.update(B);
    expect(noticeEl()).toBeNull();
    notice.update(C);
    expect(noticeEl()).not.toBeNull();
    notice.update(null);
    expect(noticeEl()).toBeNull();
    expect(notice.pendingId).toBeNull();
    notice.dispose();
  });

  it('labels the button Reload when only a manual notice is needed', () => {
    let unsaved = true;
    const loc = location();
    const notice = createVersionNotice({ location: loc, hasUnsavedState: () => unsaved });
    notice.update(B);
    expect(noticeEl()?.querySelector('button')?.textContent).toBe('Reload anyway');
    unsaved = false;
    notice.refresh();
    expect(noticeEl()?.querySelector('button')?.textContent).toBe('Reload');
    expect(loc.replace).not.toHaveBeenCalled();
    notice.dispose();
  });

  it('does not auto-reload again when the reload URL already carries the new id', () => {
    const loc = location(`https://x.test/?v=${B}`);
    const notice = createVersionNotice({ location: loc });
    notice.update(B);
    expect(loc.replace).not.toHaveBeenCalled();
    expect(noticeEl()).not.toBeNull();
    notice.dispose();
  });

  describe('immersive XR', () => {
    const makeSession = (
      end: () => Promise<void>,
    ): SessionLike & { end: ReturnType<typeof vi.fn> } => ({
      end: vi.fn(end),
    });

    it('never auto-reloads; shows the XR control and awaits session.end() before navigating', async () => {
      const loc = location();
      let finishEnd: (() => void) | undefined;
      const session = makeSession(() => new Promise<void>((resolve) => (finishEnd = resolve)));
      const attach = vi.fn();
      const detach = vi.fn();
      const notice = createVersionNotice({
        location: loc,
        getSession: () => session,
        xrHud: { attach, detach },
      });
      notice.update(B);
      expect(loc.replace).not.toHaveBeenCalled();
      expect(noticeEl()).toBeNull();
      expect(attach).toHaveBeenCalledTimes(1);
      expect(notice.xrPanel?.activate('reload')).toBe(true);
      await Promise.resolve();
      expect(session.end).toHaveBeenCalledTimes(1);
      expect(loc.replace).not.toHaveBeenCalled();
      finishEnd?.();
      await vi.waitFor(() =>
        expect(loc.replace).toHaveBeenCalledWith(`https://x.test/?mode=a&v=${B}#h`),
      );
      notice.update(null);
      expect(detach).toHaveBeenCalledTimes(1);
      expect(notice.xrPanel).toBeNull();
      notice.dispose();
    });

    it('keeps the page and exposes the error when session.end() fails', async () => {
      const loc = location();
      const failure = new Error('exit refused');
      const onError = vi.fn();
      const notice = createVersionNotice({
        location: loc,
        getSession: () => makeSession(() => Promise.reject(failure)),
        onError,
      });
      notice.update(B);
      await notice.reload();
      expect(loc.replace).not.toHaveBeenCalled();
      expect(notice.lastError).toBe(failure);
      expect(onError).toHaveBeenCalledWith(failure);
      notice.dispose();
    });
  });
});

describe('reloadAfterXRExit', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('navigates only after session.end() resolves', async () => {
    const loc = { href: 'https://x.test/?q=1#f', replace: vi.fn() };
    let finish: (() => void) | undefined;
    const done = reloadAfterXRExit(
      { end: () => new Promise<void>((resolve) => (finish = resolve)) },
      B,
      loc,
    );
    await vi.advanceTimersByTimeAsync(9_000);
    expect(loc.replace).not.toHaveBeenCalled();
    finish?.();
    await done;
    expect(loc.replace).toHaveBeenCalledWith(`https://x.test/?q=1&v=${B}#f`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with a timeout error after 10 s and does not navigate', async () => {
    const loc = { href: 'https://x.test/', replace: vi.fn() };
    const done = reloadAfterXRExit({ end: () => new Promise<void>(() => undefined) }, B, loc);
    const assertion = expect(done).rejects.toThrow(/Timed out after 10000 ms/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(loc.replace).not.toHaveBeenCalled();
  });

  it('preserves the original error when exit fails', async () => {
    const loc = { href: 'https://x.test/', replace: vi.fn() };
    const failure = new Error('InvalidStateError');
    await expect(reloadAfterXRExit({ end: () => Promise.reject(failure) }, B, loc)).rejects.toBe(
      failure,
    );
    expect(loc.replace).not.toHaveBeenCalled();
  });
});

describe('build-version script', () => {
  let root: string;
  const write = (path: string, content: string): void => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rift-version-'));
    write('package.json', JSON.stringify({ version: '1.0.0' }));
    write('index.html', '<html></html>');
    write('src/main.ts', 'export {}');
    write('public/asset.bin', 'one');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('changes the id for an asset-only change and a package version change', () => {
    const base = sourceFingerprint(root);
    expect(sourceFingerprint(root)).toBe(base);
    write('public/asset.bin', 'two');
    const assetChanged = sourceFingerprint(root);
    expect(assetChanged).not.toBe(base);
    write('package.json', JSON.stringify({ version: '1.0.1' }));
    expect(sourceFingerprint(root)).not.toBe(assetChanged);
    expect(isValidBuildId(currentBuildId(root))).toBe(true);
  });

  it('content hash covers bundles, version and public files', () => {
    const bundle = { 'a.js': { type: 'chunk', code: 'x' } };
    const base = computeContentHash(bundle, '1.0.0', join(root, 'public'));
    expect(computeContentHash(bundle, '1.0.0', join(root, 'public'))).toBe(base);
    expect(
      computeContentHash({ 'a.js': { type: 'chunk', code: 'y' } }, '1.0.0', join(root, 'public')),
    ).not.toBe(base);
    expect(computeContentHash(bundle, '1.0.1', join(root, 'public'))).not.toBe(base);
    write('public/asset.bin', 'changed');
    expect(computeContentHash(bundle, '1.0.0', join(root, 'public'))).not.toBe(base);
  });

  it('honours RIFT_BASTION_BUILD_ID and rejects non-hex overrides', () => {
    vi.stubEnv('RIFT_BASTION_BUILD_ID', 'ABCDEF123456');
    expect(currentBuildId(root)).toBe('abcdef123456');
    vi.stubEnv('RIFT_BASTION_BUILD_ID', 'not-hex!');
    expect(() => currentBuildId(root)).toThrow(/hex/);
    expect(normalizeBuildId(' 0123abcd ')).toBe('0123abcd');
  });
});
