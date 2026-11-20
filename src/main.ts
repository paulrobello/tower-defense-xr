import * as THREE from 'three';
import { createActionBus } from './core/action-bus.ts';
import { createSeededStreams, resolveSeed } from './core/prng.ts';
import { createGameStateMachine } from './core/state.ts';
import { createDesktopShell, type DesktopShell } from './desktop/bootstrap.ts';
import { createPerfHud, type PerfHud } from './perf/hud.ts';
import { createPerfRecorder, type PerfRecorder } from './perf/recorder.ts';
import {
  createDomSettingsPanel,
  createXrSettingsPanel,
  type DomSettingsPanel,
  type XrSettingsPanel,
} from './settings/panel.ts';
import { createSettingsStore, type SettingsStore } from './settings/store.ts';
import { createVersionWatcher, type VersionWatcher } from './ui/version-check.ts';
import { createVersionNotice, type VersionNotice } from './ui/version-notice.ts';

export const APP_NAME = 'Rift Bastion';

export interface AppRuntime {
  readonly shell: DesktopShell;
  readonly settings: SettingsStore;
  readonly domSettings: DomSettingsPanel;
  readonly xrSettings: XrSettingsPanel;
  readonly perfRecorder: PerfRecorder;
  readonly perfHud: PerfHud;
  readonly versionNotice: VersionNotice;
  readonly versionWatcher: VersionWatcher;
  readonly seed: number;
  dispose(): void;
}

declare global {
  interface Window {
    __riftBastionApp?: AppRuntime;
  }
}

export function mountApp(container: HTMLElement): AppRuntime {
  const search = typeof location === 'undefined' ? '' : location.search;
  const seed = resolveSeed(search);
  createSeededStreams(seed);

  const bus = createActionBus();
  const state = createGameStateMachine();
  const settings = createSettingsStore({ search });
  const initial = settings.get();

  const xrHudRoot = new THREE.Group();
  xrHudRoot.name = 'rift-bastion-xr-hud';
  xrHudRoot.position.set(0, 1.35, -1.25);

  const shell = createDesktopShell({
    container,
    bus,
    search,
    xr: {
      framebufferScale: initial.framebufferScale,
      foveation: initial.fixedFoveation,
    },
  });
  shell.scene.add(xrHudRoot);

  const buildId =
    typeof window !== 'undefined' && typeof window.__APP_BUILD === 'string'
      ? window.__APP_BUILD
      : typeof __APP_BUILD === 'string'
        ? __APP_BUILD
        : 'dev';

  const perfRecorder = createPerfRecorder({ build: buildId });
  const perfHud = createPerfHud(perfRecorder, settings, {
    container,
    initialMode: 'desktop',
  });
  perfHud.xrRoot.position.set(0.55, 0.25, 0);
  xrHudRoot.add(perfHud.xrRoot);

  const domSettings = createDomSettingsPanel(settings, { container });
  const xrSettings = createXrSettingsPanel(settings);
  xrSettings.root.position.set(0, 0, 0);
  xrHudRoot.add(xrSettings.root);

  const versionNotice = createVersionNotice({
    getSession: () => shell.xr.session,
    hasUnsavedState: () => state.phase === 'wave',
    xrHud: {
      attach: (root) => {
        root.position.set(0, 0.36, 0);
        xrHudRoot.add(root);
      },
      detach: (root) => {
        xrHudRoot.remove(root);
      },
    },
  });
  const versionWatcher = createVersionWatcher({
    currentBuildId: buildId,
    search,
    onChange: (id) => versionNotice.update(id),
  });
  versionWatcher.start();

  const syncXrStatus = (): void => {
    const xrState = shell.xr.state;
    const status = {
      inSession: xrState.presenting,
      appliedFramebufferScale: xrState.appliedFramebufferScale,
      reportedFoveation: xrState.presenting ? xrState.foveation : null,
    };
    domSettings.setXrStatus(status);
    xrSettings.setXrStatus(status);
  };

  let wasPresenting = shell.xr.state.presenting;
  const unsubXr = shell.xr.subscribe((xrState) => {
    syncXrStatus();
    if (xrState.presenting !== wasPresenting) {
      wasPresenting = xrState.presenting;
      if (xrState.presenting) {
        perfRecorder.onXrSessionStart();
        perfHud.setMode('xr');
        domSettings.hide();
      } else {
        perfRecorder.onXrSessionEnd();
        perfHud.setMode('desktop');
        xrSettings.hide();
      }
      versionNotice.refresh();
    }
  });

  const unsubSettings = settings.subscribe((next) => {
    shell.xr.setFoveation(next.fixedFoveation);
    shell.xr.setFramebufferScale(next.framebufferScale);
    syncXrStatus();
  });

  const unsubState = state.subscribe(() => {
    versionNotice.refresh();
  });

  const unsubBus = [
    bus.on('menu/open-settings', () => {
      if (shell.xr.presenting) xrSettings.toggle();
      else domSettings.toggle();
    }),
    bus.on('menu/close-settings', () => {
      domSettings.hide();
      xrSettings.hide();
    }),
    bus.on('menu/play-desktop', () => {
      if (state.phase === 'title') state.transition('calibrate');
    }),
  ];

  const onVisibility = (): void => {
    perfRecorder.onVisibilityChange(!document.hidden);
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  const unsubFrame = shell.onFrame((_dt, timeMs) => {
    const cur = settings.get();
    const xrState = shell.xr.state;
    const mode = xrState.presenting ? 'xr' : 'desktop';
    const info = shell.renderer.info.render;
    perfRecorder.recordFrame(
      timeMs,
      {
        mode,
        phase: state.phase,
        requestedHz: mode === 'xr' ? xrState.targetFrameRate : 60,
        reportedHz: mode === 'xr' ? xrState.negotiatedFrameRate : null,
        qualityTier: cur.qualityTier,
        framebufferScale: xrState.appliedFramebufferScale ?? cur.framebufferScale,
        fixedFoveation: mode === 'xr' ? xrState.foveation : null,
      },
      info.calls,
      info.triangles,
    );
    perfHud.update(timeMs);
  });

  syncXrStatus();

  let disposed = false;
  const runtime: AppRuntime = {
    shell,
    settings,
    domSettings,
    xrSettings,
    perfRecorder,
    perfHud,
    versionNotice,
    versionWatcher,
    seed,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubFrame();
      unsubXr();
      unsubSettings();
      unsubState();
      for (const fn of unsubBus) fn();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      versionWatcher.dispose();
      versionNotice.dispose();
      domSettings.dispose();
      xrSettings.dispose();
      perfHud.dispose();
      perfRecorder.dispose();
      shell.dispose();
    },
  };

  if (typeof window !== 'undefined') {
    window.__riftBastionApp = runtime;
  }
  return runtime;
}

if (typeof document !== 'undefined') {
  const root = document.getElementById('app');
  if (root) {
    mountApp(root);
  }
}
