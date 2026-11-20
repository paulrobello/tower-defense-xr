// Runs in the page before any app script, right after IWER's UMD bundle (`window.IWER`).
// Installs an emulated Meta Quest 3 runtime (`forceInstall: true` so desktop Chromium's native
// `navigator.xr` does not silently win), hooks Three.js via `__THREE_DEVTOOLS__`, records
// `requestSession` arguments, subclasses `XRWebGLLayer` to observe `framebufferScaleFactor` and
// `fixedFoveation` writes, and exposes frame-synchronized helpers on `window.__xrEmu`.
(() => {
  const probe = {
    renderers: [],
    scenes: [],
    requests: [],
    layerInits: [],
    foveationWrites: [],
    passes: [],
    session: null,
    device: null,
    sessionEndedCount: 0,
  };
  window.__xrEmu = probe;

  const devtools = new EventTarget();
  devtools.addEventListener('observe', (event) => {
    const target = event.detail;
    if (target?.isWebGLRenderer) probe.renderers.push(target);
    else if (target?.isScene) probe.scenes.push(target);
  });
  window.__THREE_DEVTOOLS__ = devtools;

  const { XRDevice, metaQuest3 } = window.IWER;
  const device = new XRDevice(metaQuest3, { stereoEnabled: true });
  device.installRuntime({ forceInstall: true });
  device.primaryInputMode = 'controller';
  probe.device = device;

  const recordFoveation = (value) => {
    const last = probe.foveationWrites.at(-1);
    if (!last || last.value !== value) probe.foveationWrites.push({ value, count: 1 });
    else last.count += 1;
  };

  const xr = navigator.xr;
  const requestSession = xr.requestSession.bind(xr);
  xr.requestSession = async (mode, init) => {
    probe.requests.push({
      mode,
      optionalFeatures: Array.isArray(init?.optionalFeatures) ? [...init.optionalFeatures] : [],
      requiredFeatures: Array.isArray(init?.requiredFeatures) ? [...init.requiredFeatures] : [],
      hasDepthSensing: Boolean(init?.depthSensing),
    });
    const session = await requestSession(mode, init);
    const entry = { mode, session, ended: false };
    probe.session = entry;
    session.addEventListener('end', () => {
      entry.ended = true;
      probe.sessionEndedCount += 1;
    });
    return session;
  };

  const BaseLayer = window.XRWebGLLayer;
  class RecordingLayer extends BaseLayer {
    constructor(session, context, init = {}) {
      super(session, context, init);
      probe.layerInits.push({
        projection: false,
        framebufferScaleFactor: init?.framebufferScaleFactor ?? 1,
        ...init,
      });
    }
    // Three.js writes `fixedFoveation` only when the getter is defined; IWER's emulation layer
    // leaves it undefined, so define a getter/setter here to observe every write from the app.
    get fixedFoveation() {
      return this.__foveation ?? 0;
    }
    set fixedFoveation(value) {
      this.__foveation = value;
      recordFoveation(value);
    }
  }
  window.XRWebGLLayer = RecordingLayer;

  const Binding = window.XRWebGLBinding;
  if (Binding?.prototype && 'createProjectionLayer' in Binding.prototype) {
    const create = Binding.prototype.createProjectionLayer;
    Binding.prototype.createProjectionLayer = function (init = {}) {
      probe.layerInits.push({
        projection: true,
        framebufferScaleFactor: init?.scaleFactor ?? 1,
        ...init,
      });
      const layer = create.call(this, init);
      if (layer && layer.fixedFoveation === undefined) {
        let current = 0;
        Object.defineProperty(layer, 'fixedFoveation', {
          configurable: true,
          get() {
            return current;
          },
          set(value) {
            current = value;
            recordFoveation(value);
          },
        });
      }
      return layer;
    };
  }

  probe.wrapRender = (renderer) => {
    if (!renderer || renderer.__xrEmuWrapped) return;
    renderer.__xrEmuWrapped = true;
    const render = renderer.render.bind(renderer);
    renderer.render = (scene, camera) => {
      if (renderer.xr.isPresenting) {
        probe.passes.push({
          t: performance.now(),
          scene: scene.uuid,
          children: scene.children.length,
          autoClear: renderer.autoClear,
        });
        if (probe.passes.length > 400) probe.passes.splice(0, 200);
      }
      return render(scene, camera);
    };
  };

  probe.ctx = () => {
    const renderer = probe.renderers[0] ?? null;
    if (renderer) probe.wrapRender(renderer);
    const scene = probe.scenes[0] ?? null;
    const hudRoot =
      probe.scenes.map((s) => s.getObjectByName('rift-bastion-xr-hud')).find(Boolean) ?? null;
    return {
      renderer,
      scene,
      hudRoot,
      app: window.__riftBastionApp ?? null,
    };
  };

  /**
   * Seated or standing head pose in tracking (`local-floor`) space, looking down -Z with optional
   * pitch and yaw in radians (yaw counter-clockwise about +Y, applied before pitch).
   */
  probe.setHead = (y, pitch = 0, yaw = 0) => {
    device.position.set(0, y, 0);
    const sp = Math.sin(pitch / 2);
    const cp = Math.cos(pitch / 2);
    const sy = Math.sin(yaw / 2);
    const cy = Math.cos(yaw / 2);
    device.quaternion.set(cy * sp, sy * cp, -sy * sp, cy * cp);
  };

  /** World position of a named Object3D across observed Three.js scenes. */
  probe.worldOf = (name) => {
    const node = probe.scenes.map((s) => s.getObjectByName(name)).find(Boolean) ?? null;
    if (!node) return null;
    node.updateWorldMatrix(true, false);
    const e = node.matrixWorld.elements;
    return { x: e[12], y: e[13], z: e[14] };
  };

  /**
   * Resolves after `n` XR frames (`session.requestAnimationFrame`). Pose writes via `setHead` or
   * controller pose updates reach Three.js only on the next XR frame, so await this before reading
   * derived camera or ray state.
   */
  probe.frames = (n = 2) =>
    new Promise((done) => {
      const session = probe.session?.session;
      if (!session || probe.session.ended) {
        done(0);
        return;
      }
      let left = Math.max(1, Math.floor(n));
      const step = () => {
        left -= 1;
        if (left <= 0) done(n);
        else session.requestAnimationFrame(step);
      };
      session.requestAnimationFrame(step);
    });
})();
