/**
 * Desktop entry shell: Three.js WebGL2 renderer, a stylized dark tactical test room, an orbit/aim
 * desktop camera, and the DOM launch overlay (Enter Mixed Reality, Play Desktop, Settings, and a
 * dismissible XR notice). Every control dispatches through the shared action bus; the shell handles
 * only the session/view actions it owns (`xr/enter`, `xr/exit`, `menu/play-desktop`,
 * `view/recenter`) and leaves game and settings actions to their own handlers.
 *
 * Styling is applied through the CSSOM (`element.style`) so a strict production CSP without
 * `'unsafe-inline'` styles stays satisfied.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ActionBus } from '../core/action-bus.ts';
import { configureFonts } from '../ui/fonts.ts';
import {
  createXrSessionManager,
  parseXrUrlOptions,
  type XrManagerState,
  type XrSessionManager,
  type XrSessionManagerOptions,
} from '../xr/session.ts';

export const ENTER_XR_LABEL = 'Enter Mixed Reality (Quest 3)';
export const ENTER_XR_PENDING_LABEL = 'Starting Mixed Reality…';
export const PLAY_DESKTOP_LABEL = 'Play Desktop';
export const SETTINGS_LABEL = 'Settings';
export const XR_UNSUPPORTED_NOTICE =
  'Mixed reality needs Meta Quest Browser over HTTPS. Desktop play is fully available here.';

const PALETTE = {
  background: '#06080c',
  floor: '#0b1016',
  wall: '#10161e',
  trim: '#2de2ff',
  amber: '#ffb347',
  core: '#9b6bff',
  text: '#e6f3ff',
  muted: '#8aa4b8',
  panel: 'rgba(8, 14, 22, 0.86)',
  danger: '#ff6b6b',
} as const;

const ROOM = { width: 6, height: 3, depth: 5 } as const;
const DESKTOP_CAMERA_POSITION = new THREE.Vector3(0, 1.65, 3.2);
const DESKTOP_CAMERA_TARGET = new THREE.Vector3(0, 0.9, 0);

function applyStyle(element: HTMLElement, css: Partial<CSSStyleDeclaration>): void {
  Object.assign(element.style, css);
}

/** The slice of the XR session manager the overlay reads. */
export type XrEntryView = Pick<XrSessionManager, 'state' | 'subscribe' | 'clearError'>;

export interface LaunchOverlay {
  readonly element: HTMLElement;
  readonly visible: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}

function makeButton(
  document: Document,
  label: string,
  control: string,
  primary: boolean,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.control = control;
  applyStyle(button, {
    display: 'block',
    width: '100%',
    margin: '10px 0 0',
    padding: '14px 18px',
    font: '600 16px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif',
    letterSpacing: '0.04em',
    color: primary ? '#03141a' : PALETTE.text,
    background: primary ? PALETTE.trim : 'rgba(45, 226, 255, 0.08)',
    border: `1px solid ${primary ? PALETTE.trim : 'rgba(45, 226, 255, 0.45)'}`,
    borderRadius: '6px',
    cursor: 'pointer',
  });
  return button;
}

/**
 * Builds the DOM launch overlay. Buttons dispatch `xr/enter`, `menu/play-desktop`, and
 * `menu/open-settings`; the notice banner shows the XR entry error (dismiss clears it on the
 * manager) or an unsupported-device hint (dismiss hides it).
 */
export function createLaunchOverlay(
  root: HTMLElement,
  bus: ActionBus,
  xr: XrEntryView,
): LaunchOverlay {
  const document = root.ownerDocument;
  const element = document.createElement('div');
  element.dataset.control = 'launch-overlay';
  applyStyle(element, {
    position: 'absolute',
    inset: '0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
    zIndex: '10',
  });

  const panel = document.createElement('div');
  applyStyle(panel, {
    pointerEvents: 'auto',
    width: 'min(360px, calc(100vw - 32px))',
    padding: '28px 26px 24px',
    background: PALETTE.panel,
    border: '1px solid rgba(45, 226, 255, 0.35)',
    borderRadius: '10px',
    boxShadow: '0 0 40px rgba(45, 226, 255, 0.12)',
    color: PALETTE.text,
    font: '15px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif',
  });

  const title = document.createElement('h1');
  title.textContent = 'Rift Bastion';
  applyStyle(title, {
    margin: '0',
    font: '700 28px/1.1 system-ui, -apple-system, "Segoe UI", sans-serif',
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
  });
  const tagline = document.createElement('p');
  tagline.textContent = 'Mixed-reality tactical tower defense';
  applyStyle(tagline, { margin: '6px 0 14px', color: PALETTE.muted });

  const enterButton = makeButton(document, ENTER_XR_LABEL, 'enter-xr', true);
  const desktopButton = makeButton(document, PLAY_DESKTOP_LABEL, 'play-desktop', false);
  const settingsButton = makeButton(document, SETTINGS_LABEL, 'settings', false);
  enterButton.addEventListener('click', () => bus.dispatch({ type: 'xr/enter' }, 'desktop'));
  desktopButton.addEventListener('click', () =>
    bus.dispatch({ type: 'menu/play-desktop' }, 'desktop'),
  );
  settingsButton.addEventListener('click', () =>
    bus.dispatch({ type: 'menu/open-settings' }, 'desktop'),
  );
  panel.append(title, tagline, enterButton, desktopButton, settingsButton);

  const notice = document.createElement('div');
  notice.dataset.control = 'xr-notice';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  applyStyle(notice, {
    position: 'absolute',
    top: '16px',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'none',
    alignItems: 'center',
    gap: '12px',
    maxWidth: 'calc(100vw - 32px)',
    padding: '10px 12px 10px 16px',
    pointerEvents: 'auto',
    color: PALETTE.text,
    background: 'rgba(40, 12, 16, 0.92)',
    border: `1px solid ${PALETTE.danger}`,
    borderRadius: '6px',
    font: '14px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif',
  });
  const noticeText = document.createElement('span');
  noticeText.dataset.control = 'xr-notice-text';
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = 'Dismiss';
  dismiss.dataset.control = 'xr-notice-dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss notice');
  applyStyle(dismiss, {
    padding: '4px 10px',
    color: PALETTE.text,
    background: 'transparent',
    border: '1px solid rgba(255, 255, 255, 0.4)',
    borderRadius: '4px',
    cursor: 'pointer',
    font: 'inherit',
  });
  notice.append(noticeText, dismiss);

  element.append(panel, notice);
  root.append(element);

  let unsupportedDismissed = false;
  let visible = true;

  function render(state: Readonly<XrManagerState>): void {
    const requesting = state.status === 'requesting';
    enterButton.textContent = requesting ? ENTER_XR_PENDING_LABEL : ENTER_XR_LABEL;
    enterButton.disabled = requesting || state.supported === false;
    applyStyle(enterButton, { opacity: enterButton.disabled ? '0.5' : '1' });
    const message =
      state.error ??
      (state.supported === false && !unsupportedDismissed ? XR_UNSUPPORTED_NOTICE : null);
    noticeText.textContent = message ?? '';
    applyStyle(notice, { display: message ? 'flex' : 'none' });
  }

  dismiss.addEventListener('click', () => {
    if (xr.state.error !== null) xr.clearError();
    else unsupportedDismissed = true;
    render(xr.state);
  });

  const unsubscribe = xr.subscribe(render);
  render(xr.state);

  return {
    element,
    get visible() {
      return visible;
    },
    show() {
      visible = true;
      applyStyle(panel, { display: 'block' });
    },
    hide() {
      visible = false;
      applyStyle(panel, { display: 'none' });
    },
    dispose() {
      unsubscribe();
      element.remove();
    },
  };
}

/** Builds the stylized dark tactical test room (desktop stand-in for the real room). */
export function createTestRoom(): { room: THREE.Group; core: THREE.Mesh } {
  const room = new THREE.Group();
  room.name = 'test-room';

  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(ROOM.width, ROOM.height, ROOM.depth),
    new THREE.MeshStandardMaterial({
      color: PALETTE.wall,
      roughness: 0.85,
      metalness: 0.25,
      side: THREE.BackSide,
    }),
  );
  shell.position.y = ROOM.height / 2;
  shell.name = 'room-shell';
  room.add(shell);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM.width, ROOM.depth),
    new THREE.MeshStandardMaterial({ color: PALETTE.floor, roughness: 0.7, metalness: 0.35 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.001;
  floor.name = 'room-floor';
  room.add(floor);

  const grid = new THREE.GridHelper(ROOM.depth, 20, PALETTE.trim, PALETTE.trim);
  const gridMaterial = grid.material as THREE.LineBasicMaterial;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.12;
  grid.position.y = 0.002;
  room.add(grid);

  const trimMaterial = new THREE.MeshStandardMaterial({
    color: PALETTE.trim,
    emissive: PALETTE.trim,
    emissiveIntensity: 1.6,
  });
  const trimHeight = 0.04;
  const trims: Array<[number, number, number, number, number]> = [
    // width, depth, x, z, rotationY
    [ROOM.width, 0.02, 0, -ROOM.depth / 2 + 0.01, 0],
    [ROOM.width, 0.02, 0, ROOM.depth / 2 - 0.01, 0],
    [ROOM.depth, 0.02, -ROOM.width / 2 + 0.01, 0, Math.PI / 2],
    [ROOM.depth, 0.02, ROOM.width / 2 - 0.01, 0, Math.PI / 2],
  ];
  const trimGeometries = new Map<number, THREE.BoxGeometry>();
  for (const [width, depth, x, z, rotationY] of trims) {
    let geometry = trimGeometries.get(width);
    if (!geometry) {
      geometry = new THREE.BoxGeometry(width, trimHeight, depth);
      trimGeometries.set(width, geometry);
    }
    for (const y of [0.12, ROOM.height - 0.12]) {
      const strip = new THREE.Mesh(geometry, trimMaterial);
      strip.position.set(x, y, z);
      strip.rotation.y = rotationY;
      room.add(strip);
    }
  }

  const panelMaterial = new THREE.MeshStandardMaterial({
    color: '#1a1206',
    emissive: PALETTE.amber,
    emissiveIntensity: 0.55,
  });
  const panelGeometry = new THREE.PlaneGeometry(0.9, 0.5);
  for (const x of [-1.6, 1.6]) {
    const panel = new THREE.Mesh(panelGeometry, panelMaterial);
    panel.position.set(x, 1.7, -ROOM.depth / 2 + 0.02);
    room.add(panel);
  }

  const metal = new THREE.MeshStandardMaterial({
    color: '#2a333d',
    roughness: 0.4,
    metalness: 0.8,
  });
  const table = new THREE.Group();
  table.name = 'test-table';
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.05, 0.8), metal);
  top.position.y = 0.75;
  table.add(top);
  const legGeometry = new THREE.BoxGeometry(0.05, 0.725, 0.05);
  for (const [x, z] of [
    [-0.65, -0.35],
    [0.65, -0.35],
    [-0.65, 0.35],
    [0.65, 0.35],
  ] as const) {
    const leg = new THREE.Mesh(legGeometry, metal);
    leg.position.set(x, 0.3625, z);
    table.add(leg);
  }
  room.add(table);

  const core = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.12, 0),
    new THREE.MeshStandardMaterial({
      color: PALETTE.core,
      emissive: PALETTE.core,
      emissiveIntensity: 1.4,
      roughness: 0.3,
      metalness: 0.2,
    }),
  );
  core.name = 'core-placeholder';
  core.position.set(0, 0.95, 0);
  room.add(core);

  room.add(new THREE.HemisphereLight('#8fb8ff', '#0a0c10', 0.7));
  const key = new THREE.DirectionalLight('#dfe9ff', 1.1);
  key.position.set(2, 2.8, 1.5);
  room.add(key);
  const glow = new THREE.PointLight(PALETTE.core, 1.2, 3);
  glow.position.set(0, 1.2, 0);
  room.add(glow);

  return { room, core };
}

export type FrameCallback = (deltaSeconds: number, timeMs: number, frame?: XRFrame) => void;
export type ShellMode = 'launch' | 'desktop' | 'xr';

export interface DesktopShellOptions {
  /** Element the canvas and overlay are mounted in. */
  container: HTMLElement;
  bus: ActionBus;
  /** Extra XR manager options; URL `?fbscale=` / `?foveation=` fill in unset values. */
  xr?: Omit<XrSessionManagerOptions, 'renderer'>;
  /** Defaults to `location.search`. */
  search?: string;
  /** For tests or alternative renderers. */
  createRenderer?(): THREE.WebGLRenderer;
}

export interface DesktopShell {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly room: THREE.Group;
  readonly xr: XrSessionManager;
  readonly overlay: LaunchOverlay;
  readonly mode: ShellMode;
  /** Registers a per-frame callback (desktop and XR). Returns the unregister function. */
  onFrame(callback: FrameCallback): () => void;
  dispose(): void;
}

function disposeObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    const mesh = object as Partial<THREE.Mesh>;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const material = mesh.material;
    if (Array.isArray(material)) for (const entry of material) materials.add(entry);
    else if (material) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}

export function createDesktopShell(options: DesktopShellOptions): DesktopShell {
  const { container, bus } = options;
  configureFonts();

  const renderer =
    options.createRenderer?.() ??
    new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.dataset.control = 'game-canvas';
  applyStyle(renderer.domElement, { display: 'block', width: '100%', height: '100%' });
  const position = getComputedStyle(container).position;
  if (!position || position === 'static') {
    applyStyle(container, { position: 'relative' });
  }
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  const desktopBackground = new THREE.Color(PALETTE.background);
  scene.background = desktopBackground;
  const { room, core } = createTestRoom();
  scene.add(room);

  const camera = new THREE.PerspectiveCamera(65, 1, 0.05, 50);
  camera.position.copy(DESKTOP_CAMERA_POSITION);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(DESKTOP_CAMERA_TARGET);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.8;
  controls.maxDistance = 4.5;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.enabled = false;
  controls.update();

  const search = options.search ?? (typeof location === 'undefined' ? '' : location.search);
  const xr = createXrSessionManager({
    ...parseXrUrlOptions(search),
    ...options.xr,
    renderer,
  });

  const overlay = createLaunchOverlay(container, bus, xr);
  let mode: ShellMode = 'launch';
  let desktopPlaying = false;

  function resetCamera(): void {
    camera.position.copy(DESKTOP_CAMERA_POSITION);
    controls.target.copy(DESKTOP_CAMERA_TARGET);
    controls.update();
  }

  function resize(): void {
    if (renderer.xr.isPresenting) return;
    const width = Math.max(1, container.clientWidth || globalThis.innerWidth || 1);
    const height = Math.max(1, container.clientHeight || globalThis.innerHeight || 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function applyPresentation(presenting: boolean): void {
    if (presenting) {
      mode = 'xr';
      // Passthrough: no background and no virtual room; the real room replaces the test room.
      scene.background = null;
      room.visible = false;
      controls.enabled = false;
      overlay.hide();
      return;
    }
    scene.background = desktopBackground;
    room.visible = true;
    mode = desktopPlaying ? 'desktop' : 'launch';
    controls.enabled = desktopPlaying;
    if (desktopPlaying) overlay.hide();
    else overlay.show();
    resize();
  }

  let lastPresenting = xr.state.presenting;
  const unsubscribeXr = xr.subscribe((state) => {
    if (state.presenting === lastPresenting) return;
    lastPresenting = state.presenting;
    applyPresentation(state.presenting);
  });

  const unsubscribers = [
    bus.on('xr/enter', () => {
      void xr.enter();
    }),
    bus.on('xr/exit', () => {
      void xr.exit();
    }),
    bus.on('menu/play-desktop', () => {
      desktopPlaying = true;
      if (!xr.presenting) applyPresentation(false);
    }),
    bus.on('view/recenter', () => {
      if (!xr.presenting) resetCamera();
    }),
  ];

  const frameCallbacks = new Set<FrameCallback>();
  let lastTime: number | null = null;
  renderer.setAnimationLoop((time, frame) => {
    const delta = lastTime === null ? 0 : Math.min(0.1, Math.max(0, (time - lastTime) / 1000));
    lastTime = time;
    if (frame) xr.update(frame);
    else if (controls.enabled) controls.update();
    core.rotation.y += delta * 0.6;
    for (const callback of [...frameCallbacks]) callback(delta, time, frame);
    renderer.render(scene, camera);
  });

  const onResize = (): void => resize();
  globalThis.addEventListener?.('resize', onResize);
  resize();
  void xr.checkSupport();

  let disposed = false;
  return {
    renderer,
    scene,
    camera,
    controls,
    room,
    xr,
    overlay,
    get mode() {
      return mode;
    },
    onFrame(callback) {
      frameCallbacks.add(callback);
      return () => {
        frameCallbacks.delete(callback);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      renderer.setAnimationLoop(null);
      globalThis.removeEventListener?.('resize', onResize);
      for (const unsubscribe of unsubscribers) unsubscribe();
      unsubscribeXr();
      frameCallbacks.clear();
      void xr.exit();
      xr.dispose();
      overlay.dispose();
      controls.dispose();
      disposeObject(scene);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
