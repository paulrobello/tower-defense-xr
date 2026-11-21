import type * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  AR_OPTIONAL_FEATURES,
  chooseFrameRate,
  createXrSessionManager,
  DEFAULT_DEPTH_SENSING,
  DEFAULT_FOVEATION,
  DEFAULT_FRAMEBUFFER_SCALE,
  describeXrError,
  parseXrUrlOptions,
  XR_UNAVAILABLE_MESSAGE,
  type XrManagerState,
  type XrSessionManagerOptions,
} from '../src/xr/session.ts';

class FakeReferenceSpace extends EventTarget {}

class FakeSession extends EventTarget {
  ended = false;
  frameRate: number | undefined = 90;
  supportedFrameRates: Float32Array | undefined = new Float32Array([72, 80, 90, 120]);
  enabledFeatures = ['local-floor', 'plane-detection', 'anchors'];
  rejectFrameRate: Error | null = null;
  updateTargetFrameRate = vi.fn(async (rate: number) => {
    if (this.rejectFrameRate) throw this.rejectFrameRate;
    this.frameRate = rate;
  });
  requestReferenceSpace = vi.fn(async (_type: XRReferenceSpaceType) => new FakeReferenceSpace());
  end = vi.fn(async () => {
    if (this.ended) return;
    this.ended = true;
    this.dispatchEvent(new Event('end'));
  });
}

interface Harness {
  renderer: THREE.WebGLRenderer;
  rendererXr: {
    enabled: boolean;
    isPresenting: boolean;
    setReferenceSpaceType: ReturnType<typeof vi.fn>;
    setSession: ReturnType<typeof vi.fn>;
    getReferenceSpace: () => FakeReferenceSpace | null;
    setFoveation: ReturnType<typeof vi.fn>;
    setFramebufferScaleFactor: ReturnType<typeof vi.fn>;
  };
  xr: {
    isSessionSupported: ReturnType<typeof vi.fn>;
    requestSession: ReturnType<typeof vi.fn>;
  };
  sessions: FakeSession[];
  failNext: { error: unknown | null };
  configure: (session: FakeSession) => void;
}

function createHarness(configure: (session: FakeSession) => void = () => {}): Harness {
  let reference: FakeReferenceSpace | null = null;
  const rendererXr: Harness['rendererXr'] = {
    enabled: false,
    isPresenting: false,
    setReferenceSpaceType: vi.fn(),
    setSession: vi.fn(async (session: FakeSession) => {
      rendererXr.isPresenting = true;
      reference = new FakeReferenceSpace();
      session.addEventListener('end', () => {
        rendererXr.isPresenting = false;
        reference = null;
      });
    }),
    getReferenceSpace: () => reference,
    setFoveation: vi.fn(),
    setFramebufferScaleFactor: vi.fn(),
  };
  const sessions: FakeSession[] = [];
  const failNext: Harness['failNext'] = { error: null };
  const harness: Harness = {
    renderer: { xr: rendererXr } as unknown as THREE.WebGLRenderer,
    rendererXr,
    sessions,
    failNext,
    configure,
    xr: {
      isSessionSupported: vi.fn(async (mode: XRSessionMode) => mode === 'immersive-ar'),
      requestSession: vi.fn(async (_mode: XRSessionMode, _init?: XRSessionInit) => {
        if (failNext.error) {
          const error = failNext.error;
          failNext.error = null;
          throw error;
        }
        const session = new FakeSession();
        harness.configure(session);
        sessions.push(session);
        return session;
      }),
    },
  };
  return harness;
}

function manager(harness: Harness, options: Partial<XrSessionManagerOptions> = {}) {
  return createXrSessionManager({
    renderer: harness.renderer,
    xr: harness.xr as unknown as XRSystem,
    ...options,
  });
}

const fakeFrame = (pose: object = { transform: {} }) =>
  ({ getViewerPose: vi.fn(() => pose) }) as unknown as XRFrame;

describe('XR session manager entry', () => {
  it('requests immersive-ar with the AR features, local reference spaces and depth-sensing init', async () => {
    const harness = createHarness();
    const xr = manager(harness);
    expect(await xr.enter()).toBe(true);
    expect(harness.xr.requestSession).toHaveBeenCalledTimes(1);
    const [mode, init] = harness.xr.requestSession.mock.calls[0] as [XRSessionMode, XRSessionInit];
    expect(mode).toBe('immersive-ar');
    expect(init.optionalFeatures).toEqual(
      expect.arrayContaining([...AR_OPTIONAL_FEATURES, 'local-floor', 'local']),
    );
    expect(new Set(init.optionalFeatures).size).toBe(init.optionalFeatures?.length);
    expect(init.optionalFeatures).not.toContain('hand-tracking');
    expect(init.depthSensing).toEqual(DEFAULT_DEPTH_SENSING);
    expect(init.depthSensing?.usagePreference).toEqual(['cpu-optimized']);
    expect(harness.rendererXr.setReferenceSpaceType).toHaveBeenCalledWith('local-floor');
    expect(xr.presenting).toBe(true);
    expect(xr.state).toMatchObject({
      status: 'presenting',
      presenting: true,
      error: null,
      appliedFramebufferScale: DEFAULT_FRAMEBUFFER_SCALE,
      enabledFeatures: ['local-floor', 'plane-detection', 'anchors'],
    });
  });

  it('omits the depth-sensing feature and init when disabled', async () => {
    const harness = createHarness();
    await manager(harness, { depthSensing: null }).enter();
    const init = harness.xr.requestSession.mock.calls[0]?.[1] as XRSessionInit;
    expect(init.depthSensing).toBeUndefined();
    expect(init.optionalFeatures).not.toContain('depth-sensing');
  });

  it('applies the framebuffer scale before the projection layer is created', async () => {
    const harness = createHarness();
    const xr = manager(harness);
    await xr.enter();
    expect(harness.rendererXr.setFramebufferScaleFactor).toHaveBeenCalledWith(1.15);
    const scaleOrder = harness.rendererXr.setFramebufferScaleFactor.mock.invocationCallOrder[0];
    const sessionOrder = harness.rendererXr.setSession.mock.invocationCallOrder[0];
    expect(scaleOrder).toBeLessThan(sessionOrder as number);
  });

  it('defers framebuffer scale changes made while presenting to the next entry', async () => {
    const harness = createHarness();
    const xr = manager(harness, { framebufferScale: 1.1 });
    await xr.enter();
    expect(harness.rendererXr.setFramebufferScaleFactor).toHaveBeenLastCalledWith(1.1);
    expect(xr.setFramebufferScale(1.2)).toBe(true);
    expect(harness.rendererXr.setFramebufferScaleFactor).toHaveBeenCalledTimes(1);
    expect(xr.state.appliedFramebufferScale).toBe(1.1);
    expect(xr.state.framebufferScale).toBe(1.2);
    await xr.exit();
    expect(xr.setFramebufferScale(1.2)).toBe(false);
    await xr.enter();
    expect(harness.rendererXr.setFramebufferScaleFactor).toHaveBeenLastCalledWith(1.2);
    expect(xr.state.appliedFramebufferScale).toBe(1.2);
  });

  it('deduplicates concurrent entry requests into one shared session request', async () => {
    const harness = createHarness();
    const xr = manager(harness);
    const first = xr.enter();
    const second = xr.enter();
    const third = xr.enter();
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(xr.state.status).toBe('requesting');
    expect(await Promise.all([first, second, third])).toEqual([true, true, true]);
    expect(harness.xr.requestSession).toHaveBeenCalledTimes(1);
    expect(await xr.enter()).toBe(true);
    expect(harness.xr.requestSession).toHaveBeenCalledTimes(1);
  });

  it('records a clearable error on refusal and clears it on successful retry', async () => {
    const harness = createHarness();
    const xr = manager(harness);
    const states: XrManagerState[] = [];
    xr.subscribe((state) => states.push(state));
    harness.failNext.error = new DOMException('denied', 'NotAllowedError');
    expect(await xr.enter()).toBe(false);
    expect(xr.state.status).toBe('error');
    expect(xr.state.error).toBe('Mixed reality permission was denied.');
    expect(xr.presenting).toBe(false);
    xr.clearError();
    expect(xr.state.error).toBeNull();
    expect(xr.state.status).toBe('idle');
    expect(states.at(-1)?.error).toBeNull();

    harness.failNext.error = new DOMException('nope', 'NotSupportedError');
    await xr.enter();
    expect(xr.state.error).toMatch(/not supported/);
    expect(await xr.enter()).toBe(true);
    expect(xr.state.error).toBeNull();
    expect(xr.state.status).toBe('presenting');
  });

  it('reports unavailable WebXR without throwing', async () => {
    const harness = createHarness();
    const xr = manager(harness, { xr: () => undefined });
    expect(await xr.checkSupport()).toBe(false);
    expect(xr.state.supported).toBe(false);
    expect(await xr.enter()).toBe(false);
    expect(xr.state.error).toBe(XR_UNAVAILABLE_MESSAGE);
    expect(harness.xr.requestSession).not.toHaveBeenCalled();
  });

  it('checks immersive-ar support through the system', async () => {
    const harness = createHarness();
    const xr = manager(harness);
    expect(xr.state.supported).toBeNull();
    expect(await xr.checkSupport()).toBe(true);
    expect(harness.xr.isSessionSupported).toHaveBeenCalledWith('immersive-ar');
    expect(xr.state.supported).toBe(true);
  });

  it('returns to idle when the session ends', async () => {
    const harness = createHarness();
    const onEnd = vi.fn();
    const xr = manager(harness, { onEnd });
    await xr.enter();
    await xr.frameRateNegotiation;
    await harness.sessions[0]?.end();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(xr.presenting).toBe(false);
    expect(xr.state).toMatchObject({
      status: 'idle',
      presenting: false,
      appliedFramebufferScale: null,
      negotiatedFrameRate: null,
    });
  });

  it('never enters after dispose', async () => {
    const harness = createHarness();
    const xr = manager(harness);
    xr.dispose();
    expect(await xr.enter()).toBe(false);
    expect(harness.xr.requestSession).not.toHaveBeenCalled();
  });
});

describe('XR session manager foveation', () => {
  it('re-asserts fixed foveation 0.5 on every XR frame', async () => {
    const harness = createHarness();
    const xr = manager(harness);
    await xr.enter();
    await xr.frameRateNegotiation;
    harness.rendererXr.setFoveation.mockClear();
    const pose = { transform: { position: { x: 0, y: 1.6, z: 0 } } };
    const frame = fakeFrame(pose);
    for (let index = 0; index < 5; index += 1) expect(xr.update(frame)).toBe(pose);
    expect(harness.rendererXr.setFoveation).toHaveBeenCalledTimes(5);
    for (const call of harness.rendererXr.setFoveation.mock.calls) {
      expect(call[0]).toBe(DEFAULT_FOVEATION);
    }
  });

  it('uses an updated foveation level on subsequent frames and skips frames when idle', async () => {
    const harness = createHarness();
    const xr = manager(harness, { foveation: 0 });
    expect(xr.update(fakeFrame())).toBeNull();
    expect(harness.rendererXr.setFoveation).not.toHaveBeenCalled();
    await xr.enter();
    xr.setFoveation(1);
    harness.rendererXr.setFoveation.mockClear();
    xr.update(fakeFrame());
    expect(harness.rendererXr.setFoveation).toHaveBeenCalledWith(1);
    expect(xr.state.foveation).toBe(1);
    xr.setFoveation(7);
    expect(xr.state.foveation).toBe(1);
  });

  it('re-asserts foveation after the awaited frame-rate request lands', async () => {
    let finishRate = (): void => {};
    const harness = createHarness((session) => {
      session.updateTargetFrameRate = vi.fn(
        (rate: number) =>
          new Promise<void>((resolve) => {
            finishRate = () => {
              session.frameRate = rate;
              resolve();
            };
          }),
      );
    });
    const xr = manager(harness);
    await xr.enter();
    harness.rendererXr.setFoveation.mockClear();
    finishRate();
    await xr.frameRateNegotiation;
    expect(harness.rendererXr.setFoveation).toHaveBeenCalledWith(DEFAULT_FOVEATION);
  });
});

describe('XR session manager frame rate', () => {
  it('requests 72 Hz and reads back the negotiated rate', async () => {
    const harness = createHarness();
    const xr = manager(harness);
    await xr.enter();
    expect(await xr.frameRateNegotiation).toBe(72);
    expect(harness.sessions[0]?.updateTargetFrameRate).toHaveBeenCalledWith(72);
    expect(xr.state.negotiatedFrameRate).toBe(72);
    expect(xr.state.supportedFrameRates).toEqual([72, 80, 90, 120]);
    expect(xr.state.frameRateError).toBeNull();
  });

  it('reports the rate the session actually runs at when the request is refused', async () => {
    const harness = createHarness((session) => {
      session.rejectFrameRate = new Error('rate refused');
    });
    const xr = manager(harness);
    await xr.enter();
    expect(await xr.frameRateNegotiation).toBe(90);
    expect(xr.state.negotiatedFrameRate).toBe(90);
    expect(xr.state.frameRateError).toBe('rate refused');
    expect(xr.state.status).toBe('presenting');
  });

  it('reads back a rate the runtime lands on instead of the requested one', async () => {
    const harness = createHarness((session) => {
      session.updateTargetFrameRate = vi.fn(async () => {
        session.frameRate = 80;
      });
    });
    const xr = manager(harness);
    await xr.enter();
    expect(await xr.frameRateNegotiation).toBe(80);
  });

  it('requests the nearest supported rate when 72 Hz is not offered', async () => {
    const harness = createHarness((session) => {
      session.supportedFrameRates = new Float32Array([60, 90]);
    });
    const xr = manager(harness);
    await xr.enter();
    await xr.frameRateNegotiation;
    expect(harness.sessions[0]?.updateTargetFrameRate).toHaveBeenCalledWith(60);
  });

  it('tracks frameratechange events', async () => {
    const harness = createHarness();
    const xr = manager(harness);
    await xr.enter();
    await xr.frameRateNegotiation;
    const session = harness.sessions[0] as FakeSession;
    session.frameRate = 120;
    session.dispatchEvent(new Event('frameratechange'));
    expect(xr.state.negotiatedFrameRate).toBe(120);
  });

  it('handles runtimes without updateTargetFrameRate', async () => {
    const harness = createHarness((session) => {
      (session as unknown as { updateTargetFrameRate: undefined }).updateTargetFrameRate =
        undefined;
      session.supportedFrameRates = undefined;
      session.frameRate = undefined;
    });
    const xr = manager(harness);
    await xr.enter();
    expect(await xr.frameRateNegotiation).toBeNull();
    expect(xr.state.negotiatedFrameRate).toBeNull();
  });
});

describe('XR helpers', () => {
  it('parses URL framebuffer scale and foveation with clamping', () => {
    expect(parseXrUrlOptions('?fbscale=1.2&foveation=1')).toEqual({
      framebufferScale: 1.2,
      foveation: 1,
    });
    expect(parseXrUrlOptions('?framebuffer-scale=1.1')).toEqual({ framebufferScale: 1.1 });
    expect(parseXrUrlOptions('?fbscale=9&foveation=-1')).toEqual({
      framebufferScale: 2,
      foveation: 0,
    });
    expect(parseXrUrlOptions('?fbscale=abc&foveation=')).toEqual({});
    expect(parseXrUrlOptions('')).toEqual({});
  });

  it('chooses the requested or nearest supported frame rate', () => {
    expect(chooseFrameRate(72, [])).toBe(72);
    expect(chooseFrameRate(72, [72, 90])).toBe(72);
    expect(chooseFrameRate(72, [90, 120])).toBe(90);
  });

  it('describes XR errors for players', () => {
    expect(describeXrError(new DOMException('x', 'SecurityError'))).toMatch(/HTTPS/);
    expect(describeXrError(new DOMException('x', 'InvalidStateError'))).toMatch(/already/);
    expect(describeXrError(new Error('custom'))).toBe('custom');
    expect(describeXrError('text')).toBe('text');
    expect(describeXrError(null)).toBe('Could not start mixed reality.');
  });
});
