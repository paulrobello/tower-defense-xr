/**
 * Quest 3 `immersive-ar` session manager over `@par/xr-workspace`'s `createXrSession`.
 *
 * Owns the Quest 3 performance discipline from `webxr.md`:
 * - framebuffer scale is applied once, before the projection layer is created (Quest Browser
 *   ignores mid-session changes), so a new value takes effect on the next XR entry;
 * - fixed foveation is re-asserted every XR frame (and again after the awaited frame-rate request,
 *   which can overwrite a late session-start write);
 * - 72 Hz is requested via `session.updateTargetFrameRate` and the rate the session actually
 *   reports is read back before anyone judges frames against a budget;
 * - one shared, deduplicated entry request with a clearable error state.
 */
import { createXrSession, type XrSession } from '@par/xr-workspace';
import type * as THREE from 'three';

export const XR_MODE: XRSessionMode = 'immersive-ar';
export const AR_OPTIONAL_FEATURES = [
  'plane-detection',
  'mesh-detection',
  'depth-sensing',
  'anchors',
  'local-floor',
] as const;
export const AR_REFERENCE_SPACES: readonly XRReferenceSpaceType[] = ['local-floor', 'local'];

export const DEFAULT_FRAMEBUFFER_SCALE = 1.15;
export const FRAMEBUFFER_SCALE_OPTIONS = [1, 1.1, 1.15, 1.2] as const;
export const MIN_FRAMEBUFFER_SCALE = 0.5;
export const MAX_FRAMEBUFFER_SCALE = 2;
export const DEFAULT_FOVEATION = 0.5;
export const FOVEATION_OPTIONS = [0, 0.5, 1] as const;
export const TARGET_FRAME_RATE = 72;

/** Depth-sensing preferences. Without this dictionary the UA must not grant `depth-sensing`. */
export const DEFAULT_DEPTH_SENSING: XRDepthStateInit = {
  // GPU negotiation also enables Three's whole-frame depth pass, outside app occlusion control.
  usagePreference: ['cpu-optimized'],
  dataFormatPreference: ['luminance-alpha', 'float32'],
};

export const XR_UNAVAILABLE_MESSAGE =
  'WebXR is unavailable here. Open this page in Meta Quest Browser over HTTPS.';

export type XrEntryStatus = 'idle' | 'requesting' | 'presenting' | 'error';

export interface XrManagerState {
  /** `null` until `checkSupport()` resolves. */
  supported: boolean | null;
  status: XrEntryStatus;
  /** Last entry error, kept until a successful entry or `clearError()`. */
  error: string | null;
  presenting: boolean;
  /** Scale the next session's projection layer will be created with. */
  framebufferScale: number;
  /** Scale the current session's layer was created with; `null` when not presenting. */
  appliedFramebufferScale: number | null;
  foveation: number;
  targetFrameRate: number;
  /** Rate the session reports after negotiation; `null` when unknown or not presenting. */
  negotiatedFrameRate: number | null;
  supportedFrameRates: readonly number[];
  /** Non-fatal frame-rate request failure, if any. */
  frameRateError: string | null;
  enabledFeatures: readonly string[];
}

export type XrStateListener = (state: Readonly<XrManagerState>) => void;

export interface XrSessionManagerOptions {
  renderer: THREE.WebGLRenderer;
  framebufferScale?: number;
  foveation?: number;
  targetFrameRate?: number;
  /** Override for the requested optional features. */
  optionalFeatures?: readonly string[];
  /** Depth-sensing init merged into the session request; `null` omits it. */
  depthSensing?: XRDepthStateInit | null;
  onStart?(session: XRSession): void;
  onEnd?(): void;
  onReset?(): void;
  /** For tests. Defaults to `navigator.xr`, resolved at call time. */
  xr?: XRSystem | (() => XRSystem | undefined);
}

export interface XrSessionManager {
  readonly state: Readonly<XrManagerState>;
  readonly session: XRSession | null;
  readonly reference: XRReferenceSpace | null;
  readonly presenting: boolean;
  /** Resolves with the negotiated rate of the current session once its request settles. */
  readonly frameRateNegotiation: Promise<number | null>;
  checkSupport(): Promise<boolean>;
  /**
   * Single shared entry request: concurrent callers share one promise and no duplicate session
   * request is made. Resolves `true` when presenting; never rejects (errors land in `state.error`).
   */
  enter(): Promise<boolean>;
  exit(): Promise<void>;
  clearError(): void;
  /** Stores the scale for the next XR entry. Returns `true` when it applies only on re-entry. */
  setFramebufferScale(scale: number): boolean;
  setFoveation(level: number): void;
  /** Call once per XR frame: re-asserts foveation and returns the viewer pose. */
  update(frame?: XRFrame): XRViewerPose | null;
  subscribe(listener: XrStateListener): () => void;
  dispose(): void;
}

export function clampFramebufferScale(scale: number): number {
  if (!Number.isFinite(scale)) return DEFAULT_FRAMEBUFFER_SCALE;
  return Math.min(MAX_FRAMEBUFFER_SCALE, Math.max(MIN_FRAMEBUFFER_SCALE, scale));
}

export function clampFoveation(level: number): number {
  if (!Number.isFinite(level)) return DEFAULT_FOVEATION;
  return Math.min(1, Math.max(0, level));
}

export interface XrUrlOptions {
  framebufferScale?: number;
  foveation?: number;
}

/** Reads `?fbscale=` (alias `?framebuffer-scale=`) and `?foveation=` from a query string. */
export function parseXrUrlOptions(search: string | URLSearchParams): XrUrlOptions {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const result: XrUrlOptions = {};
  const number = (key: string): number | null => {
    const raw = params.get(key);
    if (raw === null || raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const scale = number('fbscale') ?? number('framebuffer-scale');
  if (scale !== null) result.framebufferScale = clampFramebufferScale(scale);
  const foveation = number('foveation');
  if (foveation !== null) result.foveation = clampFoveation(foveation);
  return result;
}

/** Picks the supported rate to request: the target if offered, otherwise the nearest offered. */
export function chooseFrameRate(target: number, supported: readonly number[]): number {
  if (supported.length === 0) return target;
  let best = supported[0] as number;
  for (const rate of supported) {
    if (Math.abs(rate - target) < Math.abs(best - target)) best = rate;
  }
  return best;
}

/** A short, player-facing explanation of a failed XR entry. */
export function describeXrError(error: unknown): string {
  const name =
    typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
  const message =
    typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : '';
  switch (name) {
    case 'NotSupportedError':
      return 'Mixed reality is not supported by this browser or device.';
    case 'SecurityError':
      return 'Mixed reality needs a secure (HTTPS) page and a button press to start.';
    case 'NotAllowedError':
      return 'Mixed reality permission was denied.';
    case 'InvalidStateError':
      return 'Another XR session is already active.';
    default:
      if (message) return message;
      return typeof error === 'string' && error ? error : 'Could not start mixed reality.';
  }
}

export function createXrSessionManager(options: XrSessionManagerOptions): XrSessionManager {
  const { renderer } = options;
  const depthSensing =
    options.depthSensing === undefined ? DEFAULT_DEPTH_SENSING : options.depthSensing;
  const listeners = new Set<XrStateListener>();
  let disposed = false;
  let pending: Promise<boolean> | null = null;
  let negotiation: Promise<number | null> = Promise.resolve(null);
  let detachFrameRate: (() => void) | null = null;

  let state: XrManagerState = {
    supported: null,
    status: 'idle',
    error: null,
    presenting: false,
    framebufferScale: clampFramebufferScale(options.framebufferScale ?? DEFAULT_FRAMEBUFFER_SCALE),
    appliedFramebufferScale: null,
    foveation: clampFoveation(options.foveation ?? DEFAULT_FOVEATION),
    targetFrameRate: options.targetFrameRate ?? TARGET_FRAME_RATE,
    negotiatedFrameRate: null,
    supportedFrameRates: [],
    frameRateError: null,
    enabledFeatures: [],
  };

  function setState(patch: Partial<XrManagerState>): void {
    state = { ...state, ...patch };
    const snapshot = state;
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error('[xr-session]', error);
      }
    }
  }

  function baseSystem(): XRSystem | undefined {
    if (typeof options.xr === 'function') return options.xr();
    if (options.xr) return options.xr;
    return typeof navigator === 'undefined' ? undefined : navigator.xr;
  }

  // Wraps the system so the session request carries the depth-sensing dictionary, which the
  // workspace session API has no field for. Everything else passes through untouched.
  const system = {
    isSessionSupported(mode: XRSessionMode): Promise<boolean> {
      const base = baseSystem();
      return base ? base.isSessionSupported(mode) : Promise.resolve(false);
    },
    requestSession(mode: XRSessionMode, init?: XRSessionInit): Promise<XRSession> {
      const base = baseSystem();
      if (!base) return Promise.reject(new Error(XR_UNAVAILABLE_MESSAGE));
      const optionalFeatures = init?.optionalFeatures
        ? Array.from(new Set(init.optionalFeatures)).filter(
            (feature) => feature !== 'depth-sensing' || depthSensing !== null,
          )
        : undefined;
      const merged: XRSessionInit = {
        ...init,
        ...(optionalFeatures ? { optionalFeatures } : {}),
        ...(depthSensing ? { depthSensing } : {}),
      };
      return base.requestSession(mode, merged);
    },
  } as unknown as XRSystem;

  async function negotiateFrameRate(session: XRSession): Promise<number | null> {
    const supported = session.supportedFrameRates ? Array.from(session.supportedFrameRates) : [];
    setState({
      supportedFrameRates: supported,
      negotiatedFrameRate: session.frameRate ?? null,
      frameRateError: null,
    });
    if (typeof session.updateTargetFrameRate !== 'function') return session.frameRate ?? null;
    let frameRateError: string | null = null;
    try {
      await session.updateTargetFrameRate(chooseFrameRate(state.targetFrameRate, supported));
    } catch (error) {
      frameRateError = describeXrError(error);
    }
    if (disposed || core.session !== session) return null;
    // The awaited request can land after a session-start foveation write; assert it again now.
    core.setFoveation(state.foveation);
    const negotiated = session.frameRate ?? null;
    setState({ negotiatedFrameRate: negotiated, frameRateError });
    return negotiated;
  }

  const core: XrSession = createXrSession(renderer, {
    mode: XR_MODE,
    referenceSpaces: AR_REFERENCE_SPACES,
    optionalFeatures: options.optionalFeatures ?? AR_OPTIONAL_FEATURES,
    foveation: state.foveation,
    xr: system,
    onStart(session) {
      const onFrameRateChange = (): void => {
        if (core.session === session) setState({ negotiatedFrameRate: session.frameRate ?? null });
      };
      session.addEventListener('frameratechange', onFrameRateChange);
      detachFrameRate = () => session.removeEventListener('frameratechange', onFrameRateChange);
      setState({
        status: 'presenting',
        presenting: true,
        error: null,
        appliedFramebufferScale: state.framebufferScale,
        enabledFeatures: session.enabledFeatures ? [...session.enabledFeatures] : [],
      });
      negotiation = negotiateFrameRate(session);
      options.onStart?.(session);
    },
    onEnd() {
      detachFrameRate?.();
      detachFrameRate = null;
      setState({
        status: state.status === 'error' ? 'error' : 'idle',
        presenting: false,
        appliedFramebufferScale: null,
        negotiatedFrameRate: null,
        supportedFrameRates: [],
        enabledFeatures: [],
      });
      options.onEnd?.();
    },
    onReset() {
      options.onReset?.();
    },
  });

  async function run(): Promise<boolean> {
    if (!baseSystem()) {
      setState({ status: 'error', error: XR_UNAVAILABLE_MESSAGE });
      return false;
    }
    setState({ status: 'requesting' });
    // Framebuffer scale only applies at projection-layer creation, i.e. before setSession.
    if (!renderer.xr.isPresenting) renderer.xr.setFramebufferScaleFactor(state.framebufferScale);
    try {
      await core.enter();
    } catch (error) {
      setState({ status: 'error', error: describeXrError(error) });
      return false;
    }
    if (!core.presenting) {
      if (state.status === 'requesting') setState({ status: 'idle' });
      return false;
    }
    return true;
  }

  return {
    get state() {
      return state;
    },
    get session() {
      return core.session;
    },
    get reference() {
      return core.reference;
    },
    get presenting() {
      return core.presenting;
    },
    get frameRateNegotiation() {
      return negotiation;
    },
    async checkSupport() {
      const supported = baseSystem() ? await core.supported() : false;
      if (!disposed) setState({ supported });
      return supported;
    },
    enter() {
      if (disposed) return Promise.resolve(false);
      if (core.presenting) return Promise.resolve(true);
      if (pending) return pending;
      pending = run().finally(() => {
        pending = null;
      });
      return pending;
    },
    exit() {
      return core.exit();
    },
    clearError() {
      if (state.error === null && state.status !== 'error') return;
      setState({ error: null, status: state.status === 'error' ? 'idle' : state.status });
    },
    setFramebufferScale(scale) {
      setState({ framebufferScale: clampFramebufferScale(scale) });
      return core.presenting;
    },
    setFoveation(level) {
      const foveation = clampFoveation(level);
      core.setFoveation(foveation);
      setState({ foveation });
    },
    update(frame) {
      if (!disposed && core.presenting && frame && !core.reference) {
        renderer.xr.setFoveation(state.foveation);
      }
      return core.update(frame);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      detachFrameRate?.();
      detachFrameRate = null;
      core.dispose();
      listeners.clear();
    },
  };
}
