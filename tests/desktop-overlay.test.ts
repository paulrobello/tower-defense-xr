import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createActionBus, type GameAction } from '../src/core/action-bus.ts';
import {
  createDesktopShell,
  createLaunchOverlay,
  ENTER_XR_LABEL,
  ENTER_XR_PENDING_LABEL,
  XR_UNSUPPORTED_NOTICE,
  type XrEntryView,
} from '../src/desktop/bootstrap.ts';
import type { XrManagerState, XrStateListener } from '../src/xr/session.ts';

function fakeXr(initial: Partial<XrManagerState> = {}) {
  const listeners = new Set<XrStateListener>();
  let state = {
    supported: null,
    status: 'idle',
    error: null,
    presenting: false,
    framebufferScale: 1.15,
    appliedFramebufferScale: null,
    foveation: 0.5,
    targetFrameRate: 72,
    negotiatedFrameRate: null,
    supportedFrameRates: [],
    frameRateError: null,
    enabledFeatures: [],
    ...initial,
  } as XrManagerState;
  const set = (patch: Partial<XrManagerState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  };
  const view: XrEntryView = {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clearError: vi.fn(() => set({ error: null, status: 'idle' })),
  };
  return { view, set, listeners };
}

const control = (root: HTMLElement, name: string) =>
  root.querySelector(`[data-control="${name}"]`) as HTMLElement;

describe('desktop launch overlay', () => {
  it('renders the three launch controls and dispatches bus actions', () => {
    const root = document.createElement('div');
    const bus = createActionBus();
    const received: GameAction[] = [];
    bus.onAny((action, envelope) => {
      expect(envelope.source).toBe('desktop');
      received.push(action);
    });
    const overlay = createLaunchOverlay(root, bus, fakeXr().view);
    overlay.setLaunchReady?.(true);
    expect(control(root, 'enter-xr').textContent).toBe(ENTER_XR_LABEL);
    expect(control(root, 'play-desktop').textContent).toBe('Play Desktop');
    expect(control(root, 'settings').textContent).toBe('Settings');
    control(root, 'enter-xr').click();
    control(root, 'play-desktop').click();
    control(root, 'settings').click();
    expect(received).toEqual([
      { type: 'xr/enter' },
      { type: 'menu/play-desktop' },
      { type: 'menu/open-settings' },
    ]);
  });

  it('disables the enter button while a request is pending or XR is unsupported', () => {
    const root = document.createElement('div');
    const xr = fakeXr();
    const overlay = createLaunchOverlay(root, createActionBus(), xr.view);
    const enter = control(root, 'enter-xr') as HTMLButtonElement;
    expect(enter.disabled).toBe(true);
    overlay.setLaunchReady?.(true);
    expect(enter.disabled).toBe(false);
    xr.set({ status: 'requesting' });
    expect(enter.disabled).toBe(true);
    expect(enter.textContent).toBe(ENTER_XR_PENDING_LABEL);
    xr.set({ status: 'idle', supported: false });
    expect(enter.disabled).toBe(true);
    expect(enter.textContent).toBe(ENTER_XR_LABEL);
  });

  it('shows entry errors in a dismissible notice that clears the manager error', () => {
    const root = document.createElement('div');
    const xr = fakeXr();
    createLaunchOverlay(root, createActionBus(), xr.view);
    const notice = control(root, 'xr-notice');
    expect(notice.style.display).toBe('none');
    xr.set({ status: 'error', error: 'Mixed reality permission was denied.' });
    expect(notice.style.display).toBe('flex');
    expect(control(root, 'xr-notice-text').textContent).toBe(
      'Mixed reality permission was denied.',
    );
    control(root, 'xr-notice-dismiss').click();
    expect(xr.view.clearError).toHaveBeenCalledTimes(1);
    expect(notice.style.display).toBe('none');
  });

  it('shows a dismissible unsupported hint without touching the manager error', () => {
    const root = document.createElement('div');
    const xr = fakeXr({ supported: false });
    createLaunchOverlay(root, createActionBus(), xr.view);
    expect(control(root, 'xr-notice-text').textContent).toBe(XR_UNSUPPORTED_NOTICE);
    control(root, 'xr-notice-dismiss').click();
    expect(xr.view.clearError).not.toHaveBeenCalled();
    expect(control(root, 'xr-notice').style.display).toBe('none');
  });

  it('hides, shows, and disposes cleanly', () => {
    const root = document.createElement('div');
    const xr = fakeXr();
    const overlay = createLaunchOverlay(root, createActionBus(), xr.view);
    overlay.hide();
    expect(overlay.visible).toBe(false);
    overlay.show();
    expect(overlay.visible).toBe(true);
    overlay.dispose();
    expect(root.childElementCount).toBe(0);
    expect(xr.listeners.size).toBe(0);
  });
});

class MockReferenceSpace extends EventTarget {}

class MockSession extends EventTarget {
  frameRate = 90;
  supportedFrameRates = new Float32Array([72, 90]);
  enabledFeatures = ['local-floor'];
  updateTargetFrameRate = vi.fn(async (rate: number) => {
    this.frameRate = rate;
  });
  requestReferenceSpace = vi.fn(async () => new MockReferenceSpace());
  end = vi.fn(async () => {
    this.dispatchEvent(new Event('end'));
  });
}

function createMockRenderer() {
  const domElement = document.createElement('canvas');
  let reference: MockReferenceSpace | null = null;
  let loop: ((time: number, frame?: XRFrame) => void) | null = null;
  const xr = {
    enabled: false,
    isPresenting: false,
    setReferenceSpaceType: vi.fn(),
    setSession: vi.fn(async (session: MockSession) => {
      xr.isPresenting = true;
      reference = new MockReferenceSpace();
      session.addEventListener('end', () => {
        xr.isPresenting = false;
        reference = null;
      });
    }),
    getReferenceSpace: () => reference,
    setFoveation: vi.fn(),
    setFramebufferScaleFactor: vi.fn(),
  };
  const renderer = {
    domElement,
    xr,
    toneMapping: 0,
    outputColorSpace: '',
    setPixelRatio: vi.fn(),
    setClearColor: vi.fn(),
    setSize: vi.fn(),
    render: vi.fn(),
    setAnimationLoop: vi.fn((fn: ((time: number, frame?: XRFrame) => void) | null) => {
      loop = fn;
    }),
    dispose: vi.fn(),
  } as unknown as THREE.WebGLRenderer;
  return { renderer, xr, tick: (time: number, frame?: XRFrame) => loop?.(time, frame) };
}

describe('desktop bootstrap shell', () => {
  it('wires test room, URL XR options, play-desktop, recenter, and XR entry/exit via the bus', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const bus = createActionBus();
    const mock = createMockRenderer();
    const session = new MockSession();
    const xrSystem = {
      isSessionSupported: vi.fn(async () => true),
      requestSession: vi.fn(async () => session),
    } as unknown as XRSystem;

    const shell = createDesktopShell({
      container,
      bus,
      search: '?fbscale=1.2&foveation=1',
      xr: { xr: xrSystem },
      createRenderer: () => mock.renderer,
    });

    expect(shell.mode).toBe('launch');
    expect(shell.room.visible).toBe(true);
    expect(shell.scene.background).not.toBeNull();
    expect(shell.xr.state.framebufferScale).toBe(1.2);
    expect(shell.xr.state.foveation).toBe(1);

    shell.overlay.setLaunchReady?.(true);

    // Play Desktop hides launch overlay and unlocks orbit controls.
    bus.dispatch({ type: 'menu/play-desktop' }, 'desktop');
    expect(shell.mode).toBe('desktop');
    expect(shell.overlay.visible).toBe(false);
    expect(shell.controls.enabled).toBe(true);

    // Recenter restores desktop camera position.
    shell.camera.position.set(2, 2, 2);
    bus.dispatch({ type: 'view/recenter' }, 'desktop');
    expect(shell.camera.position.x).toBeCloseTo(0);

    // Entering XR via action bus hides virtual room + background for passthrough, while keeping scene lights active.
    bus.dispatch({ type: 'xr/enter' }, 'desktop');
    await vi.waitFor(() => expect(shell.xr.presenting).toBe(true));
    expect(shell.mode).toBe('xr');
    expect(shell.room.visible).toBe(false);
    expect(shell.scene.getObjectByName('scene-lights')?.visible).toBe(true);
    expect(shell.scene.background).toBeNull();
    expect(mock.xr.setFramebufferScaleFactor).toHaveBeenCalledWith(1.2);

    // XR animation frame re-asserts foveation and notifies frame callbacks.
    const onFrame = vi.fn();
    const offFrame = shell.onFrame(onFrame);
    mock.xr.setFoveation.mockClear();
    const frame = { getViewerPose: vi.fn(() => ({})) } as unknown as XRFrame;
    mock.tick(16, frame);
    expect(mock.xr.setFoveation).toHaveBeenCalledWith(1);
    expect(onFrame).toHaveBeenCalledWith(0, 16, frame);
    expect(mock.renderer.render).toHaveBeenCalledExactlyOnceWith(shell.scene, shell.camera);
    expect(shell.xrOverlayRoot.visible).toBe(true);
    const panel = new THREE.Group();
    shell.xrOverlayRoot.add(panel);
    const control = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
    panel.add(control);
    expect(control.material).toMatchObject({
      depthWrite: false,
      depthTest: false,
      transparent: true,
    });
    offFrame();

    // Exiting XR restores virtual room and desktop mode.
    bus.dispatch({ type: 'xr/exit' }, 'xr');
    await vi.waitFor(() => expect(shell.xr.presenting).toBe(false));
    expect(shell.mode).toBe('desktop');
    expect(shell.room.visible).toBe(true);
    expect(shell.xrOverlayRoot.visible).toBe(false);
    expect(shell.scene.background).not.toBeNull();

    shell.dispose();
    container.remove();
  });
});
