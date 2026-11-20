import { createMenuPanel, keepAbove, type MenuPanel } from '@par/xr-workspace';
import type * as THREE from 'three';
import { buildReloadUrl, RELOAD_PARAM } from './version-check.ts';

export const XR_EXIT_TIMEOUT_MS = 10_000;
export const NOTICE_Z_INDEX = 2147483647;

export interface SessionLike {
  end(): Promise<void>;
}

export interface LocationLike {
  href: string;
  replace(url: string): void;
}

/** Mounts the XR reload control on the movable XR HUD (the coordinator wires this up). */
export interface XRHudMount {
  attach(root: THREE.Group): void;
  detach(root: THREE.Group): void;
}

/** Ends the XR session (bounded by `timeoutMs`) and only then navigates. Rejects, without navigating, on failure. */
export async function reloadAfterXRExit(
  session: SessionLike,
  newId: string,
  location: LocationLike,
  timeoutMs: number = XR_EXIT_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs} ms ending the XR session`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([session.end(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  location.replace(buildReloadUrl(location.href, newId));
}

export interface VersionNoticeOptions {
  /** Returns the live immersive session, or null/undefined on desktop. */
  getSession?: () => SessionLike | null | undefined;
  /** True while there is unsaved work or a wave in progress; desktop never auto-reloads then. */
  hasUnsavedState?: () => boolean;
  xrHud?: XRHudMount;
  location?: LocationLike;
  doc?: Document;
  xrExitTimeoutMs?: number;
  onError?: (error: Error) => void;
}

export interface VersionNotice {
  /** Feed from the watcher's `onChange`: newer id, or null to clear. */
  update(newId: string | null): void;
  /** Re-evaluate after the XR session starts/ends or the unsaved/in-wave state changes. */
  refresh(): void;
  /** Reload for the pending id: desktop navigates; XR ends the session first. */
  reload(): Promise<void>;
  /** Null unless the XR control is mounted. Hook picking via cellAt/setHovered/activate. */
  readonly xrPanel: MenuPanel | null;
  readonly pendingId: string | null;
  readonly lastError: Error | null;
  dispose(): void;
}

const NOTICE_ATTR = 'data-version-notice';
const swallow = (event: Event): void => event.stopPropagation();

export function createVersionNotice(options: VersionNoticeOptions = {}): VersionNotice {
  const doc = options.doc ?? document;
  const loc: LocationLike = options.location ?? window.location;
  const timeoutMs = options.xrExitTimeoutMs ?? XR_EXIT_TIMEOUT_MS;

  let pendingId: string | null = null;
  let dismissedId: string | null = null;
  let lastError: Error | null = null;
  let reloading = false;
  let disposed = false;
  let element: HTMLDivElement | null = null;
  let message: HTMLSpanElement | null = null;
  let reloadButton: HTMLButtonElement | null = null;
  let panel: MenuPanel | null = null;
  let stopKeepAbove: (() => void) | null = null;

  const session = (): SessionLike | null => options.getSession?.() ?? null;
  const unsaved = (): boolean => options.hasUnsavedState?.() ?? false;

  const fail = (error: unknown): void => {
    lastError = error instanceof Error ? error : new Error(String(error));
    panel?.setLabel('reload', 'Update: Retry');
    if (message) message.textContent = `Update failed: ${lastError.message}`;
    options.onError?.(lastError);
  };

  const navigate = (id: string): void => loc.replace(buildReloadUrl(loc.href, id));

  const reload = async (): Promise<void> => {
    const id = pendingId;
    if (id === null || reloading || disposed) return;
    reloading = true;
    lastError = null;
    try {
      const active = session();
      if (active) await reloadAfterXRExit(active, id, loc, timeoutMs);
      else navigate(id);
    } catch (error) {
      fail(error);
    } finally {
      reloading = false;
    }
  };

  const removeDom = (): void => {
    element?.remove();
    element = null;
    message = null;
    reloadButton = null;
  };

  const removeXr = (): void => {
    if (!panel) return;
    options.xrHud?.detach(panel.root);
    stopKeepAbove?.();
    stopKeepAbove = null;
    panel.dispose();
    panel = null;
  };

  const reloadLabel = (): string => (unsaved() ? 'Reload anyway' : 'Reload');
  const messageText = (): string =>
    unsaved()
      ? 'A new version is available. Reloading will lose unsaved progress.'
      : 'A new version is available.';

  const button = (label: string, onClick: () => void): HTMLButtonElement => {
    const el = doc.createElement('button');
    el.type = 'button';
    el.textContent = label;
    el.style.cssText =
      'font:inherit;padding:2px 8px;border:1px solid #6f8;border-radius:4px;background:#123;color:#fff;cursor:pointer';
    el.addEventListener('click', onClick);
    return el;
  };

  const showDom = (): void => {
    if (element) {
      if (message && !lastError) message.textContent = messageText();
      if (reloadButton) reloadButton.textContent = reloadLabel();
      return;
    }
    const root = doc.createElement('div');
    root.setAttribute(NOTICE_ATTR, '');
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    root.style.cssText = `position:fixed;right:12px;bottom:12px;z-index:${NOTICE_Z_INDEX};display:flex;gap:8px;align-items:center;max-width:min(420px,calc(100vw - 24px));padding:8px 12px;border-radius:6px;background:rgba(10,20,30,.94);color:#fff;font:13px/1.3 system-ui,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.5);pointer-events:auto`;
    for (const type of ['keydown', 'keyup', 'keypress']) root.addEventListener(type, swallow);
    message = doc.createElement('span');
    message.textContent = messageText();
    reloadButton = button(reloadLabel(), () => void reload());
    const later = button('Later', () => {
      dismissedId = pendingId;
      removeDom();
    });
    root.append(message, reloadButton, later);
    (doc.body ?? doc.documentElement).append(root);
    element = root;
  };

  const showXr = (): void => {
    if (panel) return;
    panel = createMenuPanel({
      name: 'version-update',
      width: 0.3,
      rowHeight: 0.07,
      rows: [
        {
          id: 'reload',
          label: lastError ? 'Update: Retry' : 'Update: Reload',
          onSelect: () => void reload(),
        },
      ],
    });
    stopKeepAbove = keepAbove(panel.root);
    options.xrHud?.attach(panel.root);
  };

  const evaluate = (autoReloadAllowed: boolean): void => {
    if (disposed) return;
    if (pendingId === null) {
      removeDom();
      removeXr();
      return;
    }
    if (session()) {
      removeDom();
      showXr();
      return;
    }
    removeXr();
    if (dismissedId === pendingId) return;
    const alreadyTried =
      new URL(loc.href, 'http://localhost').searchParams.get(RELOAD_PARAM) === pendingId;
    if (autoReloadAllowed && !unsaved() && !alreadyTried && !reloading) {
      void reload();
      return;
    }
    showDom();
  };

  return {
    update(newId) {
      if (newId === null) {
        pendingId = null;
        dismissedId = null;
        lastError = null;
      } else if (newId !== pendingId) {
        pendingId = newId;
        lastError = null;
      }
      evaluate(true);
    },
    refresh() {
      // A visible notice only relabels; it never turns into a surprise reload.
      evaluate(element === null);
    },
    reload,
    get xrPanel() {
      return panel;
    },
    get pendingId() {
      return pendingId;
    },
    get lastError() {
      return lastError;
    },
    dispose() {
      if (disposed) return;
      removeDom();
      removeXr();
      disposed = true;
    },
  };
}
