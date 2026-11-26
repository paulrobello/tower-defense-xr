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
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Text } from 'troika-three-text';
import { GAMEPLAY_OBJECT_SCALE } from '../content/waves.ts';
import type { ActionBus } from '../core/action-bus.ts';
import {
  VIRTUAL_CENTRAL_TABLE,
  VIRTUAL_CONSOLE_TABLE,
  VIRTUAL_ROOM_DIMENSIONS,
} from '../mr/virtual-room.ts';
import type { RuntimeAssetLibrary, SharedPbrMaterialId } from '../render/asset-loader.ts';
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

const ROOM = VIRTUAL_ROOM_DIMENSIONS;
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
  readonly launchReady: boolean;
  setLoadStatus?(text: string | null): void;
  setLaunchReady?(ready: boolean): void;
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
    justifyContent: 'flex-start',
    paddingLeft: 'clamp(20px, 6vw, 88px)',
    background:
      'linear-gradient(90deg, rgba(6, 10, 16, 0.90) 0%, rgba(6, 10, 16, 0.62) 48%, rgba(6, 10, 16, 0.18) 100%), url("/assets/ui/desktop-title.jpg") center / cover no-repeat',
    pointerEvents: 'none',
    zIndex: '10',
  });

  const panel = document.createElement('div');
  applyStyle(panel, {
    pointerEvents: 'auto',
    width: 'min(370px, calc(100vw - 32px))',
    padding: '28px 26px 24px',
    background: 'rgba(8, 14, 22, 0.88)',
    backdropFilter: 'blur(8px)',
    border: '1px solid rgba(45, 226, 255, 0.35)',
    borderRadius: '10px',
    boxShadow: '0 12px 48px rgba(0, 0, 0, 0.55), 0 0 36px rgba(45, 226, 255, 0.14)',
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

  const loadStatus = document.createElement('p');
  loadStatus.dataset.control = 'asset-load-status';
  applyStyle(loadStatus, {
    margin: '12px 0 0',
    font: '500 12px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace',
    color: PALETTE.trim,
    display: 'none',
  });

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
  panel.append(title, tagline, enterButton, desktopButton, settingsButton, loadStatus);

  const notice = document.createElement('div');
  notice.dataset.control = 'xr-notice';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  applyStyle(notice, {
    position: 'absolute',
    top: '66px',
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
  let launchReady = false;

  function render(state: Readonly<XrManagerState>): void {
    const requesting = state.status === 'requesting';
    enterButton.textContent = requesting ? ENTER_XR_PENDING_LABEL : ENTER_XR_LABEL;
    enterButton.disabled = !launchReady || requesting || state.supported === false;
    desktopButton.disabled = !launchReady;
    applyStyle(enterButton, { opacity: enterButton.disabled ? '0.5' : '1' });
    applyStyle(desktopButton, { opacity: desktopButton.disabled ? '0.5' : '1' });
    const message =
      state.error ??
      (visible && state.supported === false && !unsupportedDismissed
        ? XR_UNSUPPORTED_NOTICE
        : null);
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
    get launchReady() {
      return launchReady;
    },
    setLoadStatus(text) {
      if (!text) {
        loadStatus.textContent = '';
        applyStyle(loadStatus, { display: 'none' });
      } else {
        loadStatus.textContent = text;
        applyStyle(loadStatus, { display: 'block' });
      }
    },
    setLaunchReady(ready) {
      launchReady = ready;
      render(xr.state);
    },
    show() {
      visible = true;
      applyStyle(element, {
        background:
          'linear-gradient(90deg, rgba(6, 10, 16, 0.90) 0%, rgba(6, 10, 16, 0.62) 48%, rgba(6, 10, 16, 0.18) 100%), url("/assets/ui/desktop-title.jpg") center / cover no-repeat',
      });
      applyStyle(panel, { display: 'block' });
      render(xr.state);
    },
    hide() {
      visible = false;
      applyStyle(element, { background: 'none' });
      applyStyle(panel, { display: 'none' });
      render(xr.state);
    },
    dispose() {
      unsubscribe();
      element.remove();
    },
  };
}

function ensureUv2(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  if (geo.attributes.uv && !geo.attributes.uv2) {
    geo.setAttribute('uv2', geo.attributes.uv);
  }
  return geo;
}

function tagPbrSurface(
  mesh: THREE.Mesh,
  materialId: SharedPbrMaterialId,
  repeat: readonly [number, number],
  side?: THREE.Side,
): void {
  mesh.userData.pbrMaterial = materialId;
  mesh.userData.pbrRepeat = repeat;
  if (side !== undefined) mesh.userData.pbrSide = side;
}

/** Applies the 5 promoted shared PBR KTX2 materials to the Desktop Tactical Command Room. */
export function applyRoomPbrMaterials(room: THREE.Group, assets: RuntimeAssetLibrary): number {
  if (!assets.ready) return 0;
  let applied = 0;
  const cache = new Map<string, THREE.MeshStandardMaterial>();
  room.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const matId = node.userData.pbrMaterial as SharedPbrMaterialId | undefined;
    if (!matId) return;
    const repeat = (node.userData.pbrRepeat as readonly [number, number] | undefined) ?? [1, 1];
    const side = node.userData.pbrSide as THREE.Side | undefined;
    const key = `${matId}:${repeat[0]}x${repeat[1]}:${side ?? 'front'}`;
    let pbrMat = cache.get(key);
    if (!pbrMat) {
      pbrMat =
        assets.getSharedMaterial(matId, { repeat, ...(side !== undefined ? { side } : {}) }) ??
        undefined;
      if (!pbrMat) return;
      cache.set(key, pbrMat);
    }
    if (node.material !== pbrMat) {
      node.material = pbrMat;
      applied += 1;
    }
  });
  return applied;
}

/** Builds the stylized dark tactical command room (desktop stand-in for the real room). */
export function createTestRoom(): { room: THREE.Group; core: THREE.Mesh } {
  const room = new THREE.Group();
  room.name = 'test-room';

  const shell = new THREE.Mesh(
    ensureUv2(new THREE.BoxGeometry(ROOM.width, ROOM.height, ROOM.depth)),
    new THREE.MeshStandardMaterial({
      color: PALETTE.wall,
      roughness: 0.78,
      metalness: 0.18,
      side: THREE.BackSide,
    }),
  );
  shell.position.y = ROOM.height / 2;
  shell.receiveShadow = true;
  shell.name = 'room-shell';
  tagPbrSurface(shell, 'tactical-ceramic', [4, 2], THREE.BackSide);
  room.add(shell);

  const floor = new THREE.Mesh(
    ensureUv2(new THREE.PlaneGeometry(ROOM.width, ROOM.depth)),
    new THREE.MeshStandardMaterial({ color: PALETTE.floor, roughness: 0.55, metalness: 0.65 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.001;
  floor.receiveShadow = true;
  floor.name = 'room-floor';
  tagPbrSurface(floor, 'dark-gunmetal', [6, 6]);
  room.add(floor);

  const grid = new THREE.GridHelper(ROOM.depth, 20, PALETTE.trim, PALETTE.trim);
  const gridMaterial = grid.material as THREE.LineBasicMaterial;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.08;
  grid.position.y = 0.0005;
  room.add(grid);

  const trimMaterial = new THREE.MeshStandardMaterial({
    color: PALETTE.trim,
    emissive: PALETTE.trim,
    emissiveIntensity: 1.5,
  });
  const trimHeight = 0.032;
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
    for (const y of [0.1, ROOM.height - 0.1]) {
      const strip = new THREE.Mesh(geometry, trimMaterial);
      strip.position.set(x, y, z);
      strip.rotation.y = rotationY;
      room.add(strip);
    }
  }

  // Architectural brushed-titanium wall bulkhead ribs + rift-obsidian energy inlays
  const metal = new THREE.MeshStandardMaterial({
    color: '#2d3742',
    roughness: 0.36,
    metalness: 0.86,
  });
  const obsidianFallback = new THREE.MeshStandardMaterial({
    color: '#241a33',
    emissive: '#1e767e',
    emissiveIntensity: 0.55,
    roughness: 0.25,
    metalness: 0.15,
  });
  const chitinFallback = new THREE.MeshStandardMaterial({
    color: '#2a2230',
    roughness: 0.42,
    metalness: 0.1,
  });

  const ribGeo = ensureUv2(new THREE.BoxGeometry(0.14, ROOM.height - 0.22, 0.06));
  const ribPositions: Array<[number, number, number]> = [
    [-2.1, -ROOM.depth / 2 + 0.03, 0],
    [0, -ROOM.depth / 2 + 0.03, 0],
    [2.1, -ROOM.depth / 2 + 0.03, 0],
    [-ROOM.width / 2 + 0.03, -1.6, Math.PI / 2],
    [-ROOM.width / 2 + 0.03, 1.6, Math.PI / 2],
    [ROOM.width / 2 - 0.03, -1.6, Math.PI / 2],
    [ROOM.width / 2 - 0.03, 1.6, Math.PI / 2],
  ];
  for (const [rx, rz, rotY] of ribPositions) {
    const rib = new THREE.Mesh(ribGeo, metal);
    rib.position.set(rx, ROOM.height / 2, rz);
    rib.rotation.y = rotY;
    rib.receiveShadow = true;
    tagPbrSurface(rib, 'dark-gunmetal', [1, 4]);
    room.add(rib);
  }

  const bayFrameGeo = ensureUv2(new THREE.BoxGeometry(1.06, 0.62, 0.035));
  const bayInlayGeo = ensureUv2(new THREE.BoxGeometry(0.92, 0.48, 0.042));
  for (const x of [-1.25, 1.25]) {
    const frame = new THREE.Mesh(bayFrameGeo, metal);
    frame.position.set(x, 1.72, -ROOM.depth / 2 + 0.018);
    frame.name = `room-bulkhead-frame-${x < 0 ? 'left' : 'right'}`;
    tagPbrSurface(frame, 'dark-gunmetal', [2, 1]);
    room.add(frame);

    const inlay = new THREE.Mesh(bayInlayGeo, obsidianFallback);
    inlay.position.set(x, 1.72, -ROOM.depth / 2 + 0.02);
    inlay.name = `room-bulkhead-inlay-${x < 0 ? 'left' : 'right'}`;
    tagPbrSurface(inlay, 'rift-obsidian', [2, 1]);
    room.add(inlay);
  }

  // Subtle floor containment ring inlay beneath the central Core table using obsidian-chitin
  const daisRing = new THREE.Mesh(
    ensureUv2(new THREE.CylinderGeometry(1.18, 1.24, 0.014, 32)),
    chitinFallback,
  );
  daisRing.position.set(0, 0.007, 0);
  daisRing.receiveShadow = true;
  daisRing.name = 'room-central-dais';
  tagPbrSurface(daisRing, 'obsidian-chitin', [3, 3]);
  room.add(daisRing);

  const addTable = (
    name: string,
    spec: {
      readonly width: number;
      readonly depth: number;
      readonly y: number;
      readonly position: { readonly x: number; readonly y: number; readonly z: number };
    },
  ): void => {
    const table = new THREE.Group();
    table.name = name;
    table.position.set(spec.position.x, 0, spec.position.z);
    const thickness = 0.05;
    const top = new THREE.Mesh(
      ensureUv2(new THREE.BoxGeometry(spec.width, thickness, spec.depth)),
      metal,
    );
    top.position.y = spec.y - thickness / 2;
    top.receiveShadow = true;
    top.castShadow = true;
    tagPbrSurface(top, 'brushed-titanium', [2, 2]);
    table.add(top);
    const legHeight = Math.max(0.05, spec.y - thickness);
    const legGeometry = ensureUv2(new THREE.BoxGeometry(0.055, legHeight, 0.055));
    const lx = Math.max(0.05, spec.width / 2 - 0.055);
    const lz = Math.max(0.05, spec.depth / 2 - 0.055);
    for (const [x, z] of [
      [-lx, -lz],
      [lx, -lz],
      [-lx, lz],
      [lx, lz],
    ] as const) {
      const leg = new THREE.Mesh(legGeometry, metal);
      leg.position.set(x, legHeight / 2, z);
      leg.castShadow = true;
      leg.receiveShadow = true;
      tagPbrSurface(leg, 'dark-gunmetal', [1, 2]);
      table.add(leg);
    }
    room.add(table);
  };
  addTable('test-table', VIRTUAL_CENTRAL_TABLE);
  addTable('test-console-table', VIRTUAL_CONSOLE_TABLE);

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
  core.scale.setScalar(GAMEPLAY_OBJECT_SCALE);
  core.position.set(0, 0.95, 0);
  room.add(core);

  return { room, core };
}

/** Builds scene-level lighting kept active in both Desktop and XR passthrough sessions. */
export function createSceneLights(): THREE.Group {
  const lights = new THREE.Group();
  lights.name = 'scene-lights';

  lights.add(new THREE.HemisphereLight('#9ec4ff', '#16202e', 0.85));

  const key = new THREE.DirectionalLight('#eef4ff', 1.35);
  key.name = 'scene-key-light';
  key.position.set(2.2, 3.6, 1.8);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 12;
  key.shadow.camera.left = -4;
  key.shadow.camera.right = 4;
  key.shadow.camera.top = 4;
  key.shadow.camera.bottom = -4;
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  lights.add(key);

  const rim = new THREE.DirectionalLight('#60a5fa', 0.45);
  rim.name = 'scene-rim-light';
  rim.position.set(-2.4, 2.2, -2.0);
  lights.add(rim);

  const glow = new THREE.PointLight(PALETTE.core, 1.1, 3.5);
  glow.name = 'scene-core-glow';
  glow.position.set(0, 1.2, 0);
  lights.add(glow);

  return lights;
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
  readonly xrOverlayRoot: THREE.Group;
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

function configureSpatialOverlay(root: THREE.Group): () => void {
  const onAdded = ({ child }: { child: THREE.Object3D }): void => child.traverse(observe);
  const onRemoved = ({ child }: { child: THREE.Object3D }): void => child.traverse(unobserve);

  function observe(node: THREE.Object3D): void {
    node.addEventListener('childadded', onAdded);
    node.addEventListener('childremoved', onRemoved);
    if (!(node instanceof THREE.Mesh)) return;
    // Transparent panels must draw their backplates before labels even when their bounds sort differently.
    if (node instanceof Text) node.renderOrder = Math.max(node.renderOrder, 2);
    else if (node.userData.labelTextObject) node.renderOrder = Math.max(node.renderOrder, 1);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      material.depthTest = false;
      material.depthWrite = false;
      if (!material.transparent) {
        material.transparent = true;
        material.needsUpdate = true;
      }
    }
  }

  function unobserve(node: THREE.Object3D): void {
    node.removeEventListener('childadded', onAdded);
    node.removeEventListener('childremoved', onRemoved);
  }

  root.traverse(observe);
  return () => root.traverse(unobserve);
}

export function createDesktopShell(options: DesktopShellOptions): DesktopShell {
  const { container, bus } = options;
  configureFonts();

  const renderer =
    options.createRenderer?.() ??
    new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      stencil: true,
      powerPreference: 'high-performance',
    });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  if (renderer.shadowMap) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
  }
  renderer.domElement.dataset.control = 'game-canvas';
  applyStyle(renderer.domElement, { display: 'block', width: '100%', height: '100%' });
  const position = getComputedStyle(container).position;
  if (!position || position === 'static') {
    applyStyle(container, { position: 'relative' });
  }
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  const xrOverlayRoot = new THREE.Group();
  xrOverlayRoot.name = 'spatial-overlay';
  xrOverlayRoot.visible = false;
  const stopOverlay = configureSpatialOverlay(xrOverlayRoot);
  scene.add(xrOverlayRoot);
  const desktopBackground = new THREE.Color(PALETTE.background);
  scene.background = desktopBackground;
  const { room, core } = createTestRoom();
  scene.add(room);
  scene.add(createSceneLights());

  let envRenderTarget: THREE.WebGLRenderTarget | null = null;
  if (typeof renderer.getContext === 'function') {
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envScene = new RoomEnvironment();
      envRenderTarget = pmrem.fromScene(envScene, 0.04);
      scene.environment = envRenderTarget.texture;
      scene.environmentIntensity = 0.75;
      envScene.dispose();
      pmrem.dispose();
    } catch {
      // Headless / mock renderers without a WebGL2 context skip PMREM generation.
    }
  }

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
      xrOverlayRoot.visible = true;
      controls.enabled = false;
      overlay.hide();
      return;
    }
    scene.background = desktopBackground;
    room.visible = true;
    xrOverlayRoot.visible = false;
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
      if (!overlay.launchReady) return;
      void xr.enter();
    }),
    bus.on('xr/exit', () => {
      void xr.exit();
    }),
    bus.on('menu/play-desktop', () => {
      if (!overlay.launchReady) return;
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
    xrOverlayRoot,
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
      stopOverlay();
      if (envRenderTarget) {
        scene.environment = null;
        envRenderTarget.dispose();
        envRenderTarget = null;
      }
      disposeObject(scene);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
