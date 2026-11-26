import {
  CachedTextBatch,
  createMenuPanel,
  keepAbove,
  type MenuPanel,
  OVERLAY_RENDER_ORDER,
} from '@par/xr-workspace';
import * as THREE from 'three';
import { TURRET_SELL_REFUND_RATIO } from '../content/turrets.ts';
import type { SimTurret } from '../sim/engine.ts';
import { configureFonts } from './fonts.ts';
import { createBatchedTextMember, createChamferPlate, TACTICAL_PLATE } from './tactical-style.ts';

interface TurretInspectorOptions {
  readonly container: HTMLElement;
  readonly renderOrder?: number;
  readonly onSell: (turret: Readonly<SimTurret>) => void;
  readonly onClose: () => void;
}

export interface TurretInspector {
  readonly xrRoot: THREE.Group;
  readonly rangeRoot: THREE.Group;
  readonly panel: MenuPanel;
  readonly desktopElement: HTMLElement;
  readonly turret: Readonly<SimTurret> | null;
  setMode(mode: 'desktop' | 'xr'): void;
  setTurret(turret: Readonly<SimTurret> | null): void;
  dispose(): void;
}

const RANGE_COLOR = 0x35d6e8;

export function createTurretInspector(options: TurretInspectorOptions): TurretInspector {
  const xrRoot = new THREE.Group();
  xrRoot.name = 'turret-inspector';
  xrRoot.userData.rootUIgrabbable = true;
  xrRoot.userData.inputAction = 'grabWidget';
  xrRoot.userData.scaleLimits = [0.5, 1.8];

  const rangeRoot = new THREE.Group();
  rangeRoot.name = 'turret-inspector-range';
  const points = Array.from({ length: 72 }, (_, index) => {
    const angle = (2 * Math.PI * index) / 72;
    return new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0);
  });
  const rangeGeometry = new THREE.BufferGeometry().setFromPoints(points);
  const rangeMaterial = new THREE.LineBasicMaterial({
    color: RANGE_COLOR,
    transparent: true,
    opacity: 0.46,
    depthWrite: false,
    depthTest: false,
  });
  rangeMaterial.toneMapped = false;
  const rangeBoundary = new THREE.Group();
  rangeBoundary.name = 'turret-inspector-range-boundary';
  for (let axis = 0; axis < 3; axis += 1) {
    const line = new THREE.LineLoop(rangeGeometry, rangeMaterial);
    line.raycast = () => undefined;
    if (axis === 1) line.rotation.x = Math.PI / 2;
    if (axis === 2) line.rotation.y = Math.PI / 2;
    rangeBoundary.add(line);
  }
  // Spokes leave a readable in-room cue even when the true boundary is beyond a wall.
  // Their endpoints still use the actual range, so the guide never implies a shorter reach.
  const spokePositions: number[] = [];
  for (let axis = 0; axis < 3; axis += 1) {
    for (let index = 0; index < 8; index += 1) {
      const angle = (2 * Math.PI * index) / 8;
      const x = Math.cos(angle);
      const y = Math.sin(angle);
      const start = 0.06;
      const end = 1;
      if (axis === 0) spokePositions.push(start * x, start * y, 0, end * x, end * y, 0);
      if (axis === 1) spokePositions.push(start * x, 0, start * y, end * x, 0, end * y);
      if (axis === 2) spokePositions.push(0, start * x, start * y, 0, end * x, end * y);
    }
  }
  const spokeGeometry = new THREE.BufferGeometry();
  spokeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(spokePositions, 3));
  const spokes = new THREE.LineSegments(spokeGeometry, rangeMaterial);
  spokes.name = 'turret-inspector-range-spokes';
  spokes.raycast = () => undefined;

  const markerMaterial = rangeMaterial.clone();
  markerMaterial.opacity = 0.88;
  const selectionMarker = new THREE.Group();
  selectionMarker.name = 'turret-inspector-selected-marker';
  selectionMarker.scale.setScalar(0.115);
  for (const ring of rangeBoundary.children) {
    const marker = new THREE.LineLoop(rangeGeometry, markerMaterial);
    marker.quaternion.copy(ring.quaternion);
    marker.raycast = () => undefined;
    selectionMarker.add(marker);
  }
  rangeRoot.add(rangeBoundary, spokes, selectionMarker);

  let mode: 'desktop' | 'xr' = 'desktop';
  let selected: Readonly<SimTurret> | null = null;
  let disposed = false;
  const activateSell = (): void => {
    if (selected) options.onSell(selected);
  };
  const width = 0.56;
  const telemetryHeight = 0.143;
  const panel = createMenuPanel({
    name: 'turret-inspector',
    width,
    rowHeight: 0.057,
    cellGap: 0.014,
    hoverColor: 0x86f9ff,
    rows: [
      [
        { id: 'sell', label: 'Sell', onSelect: activateSell },
        { id: 'close', label: 'Close', onSelect: options.onClose },
      ],
    ],
  });
  panel.root.position.set(0, -telemetryHeight, 0.002);

  const plateWidth = width + 0.05;
  const bodyHeight = telemetryHeight + panel.height;
  const frameHeight = bodyHeight + 0.034;
  const plates: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] = [];
  function plate(
    geometry: THREE.BufferGeometry,
    color: number,
    x: number,
    y: number,
    z: number,
    opacity = 1,
  ): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
    );
    mesh.position.set(x, y, z);
    mesh.raycast = () => undefined;
    plates.push(mesh);
    return mesh;
  }

  const centerY = -bodyHeight / 2;
  plate(
    createChamferPlate(plateWidth, frameHeight, 0.018),
    TACTICAL_PLATE.frame,
    0,
    centerY,
    -0.007,
    0.98,
  );
  const backing = plate(
    createChamferPlate(plateWidth - 0.006, frameHeight - 0.006, 0.016),
    TACTICAL_PLATE.backing,
    0,
    centerY,
    -0.004,
    0.96,
  );
  backing.name = 'turret-inspector-backing';
  backing.raycast = THREE.Mesh.prototype.raycast;
  backing.userData.inputAction = 'grabWidget';
  plate(
    new THREE.PlaneGeometry(width * 0.36, 0.004),
    TACTICAL_PLATE.trim,
    -width * 0.28,
    0.013,
    -0.002,
  );
  plate(createChamferPlate(width, 0.078, 0.01), TACTICAL_PLATE.inset, 0, -0.094, -0.002);
  plate(
    createChamferPlate(0.085, 0.035, 0.006),
    TACTICAL_PLATE.inset,
    width / 2 - 0.043,
    -0.023,
    -0.002,
  );
  for (const x of [-width / 6, width / 6]) {
    plate(new THREE.PlaneGeometry(0.0014, 0.054), TACTICAL_PLATE.frame, x, -0.094, -0.001);
  }

  const statLabels = ['Range', 'Damage', 'Fire rate'];
  const fontUrl = configureFonts().main;
  const textBatch = new CachedTextBatch();
  textBatch.name = 'turret-inspector-telemetry';
  textBatch.frustumCulled = false;
  textBatch.raycast = () => undefined;
  const nameText = createBatchedTextMember(
    '',
    fontUrl,
    0.039,
    '#e9f8ff',
    -width / 2,
    -0.023,
    'left',
  );
  const tierText = createBatchedTextMember(
    '',
    fontUrl,
    0.021,
    '#8fd8ff',
    width / 2 - 0.043,
    -0.023,
    'center',
  );
  const stats = statLabels.map((label, index) => {
    const x = ((index - 1) * width) / 3;
    const caption = createBatchedTextMember(
      label.toUpperCase(),
      fontUrl,
      0.018,
      '#b6dce6',
      x,
      -0.076,
      'center',
    );
    const value = createBatchedTextMember('', fontUrl, 0.035, '#e9f8ff', x, -0.107, 'center');
    return { caption, value };
  });
  const members = [nameText, tierText, ...stats.flatMap(({ caption, value }) => [caption, value])];
  for (const member of members) textBatch.addText(member);
  textBatch.revision += 1;
  xrRoot.add(...plates, textBatch, panel.root);
  const stopKeepAbove = keepAbove(xrRoot, options.renderOrder ?? OVERLAY_RENDER_ORDER);

  const doc = options.container.ownerDocument;
  const desktopElement = doc.createElement('section');
  desktopElement.dataset.turretInspector = 'true';
  desktopElement.setAttribute('aria-label', 'Selected turret');
  desktopElement.style.cssText =
    'position:absolute;right:16px;top:72px;z-index:7001;padding:14px 15px;' +
    'box-sizing:border-box;width:min(294px,calc(100% - 32px));' +
    'clip-path:polygon(12px 0,100% 0,100% calc(100% - 12px),calc(100% - 12px) 100%,0 100%,0 12px);' +
    'background:linear-gradient(115deg,#102e3b,#081822 58%,#12323b);' +
    'border-top:2px solid #53e4f2;border-bottom:1px solid #438592;color:#e9f8ff;' +
    'font:600 12px/1.4 "SF Mono",Consolas,monospace;font-variant-numeric:tabular-nums;';
  const heading = doc.createElement('header');
  heading.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;';
  const title = doc.createElement('strong');
  title.style.cssText = 'font-size:16px;line-height:1.15;';
  const tierBadge = doc.createElement('span');
  tierBadge.style.cssText = 'padding:3px 7px;background:#153644;color:#8fd8ff;';
  heading.append(title, tierBadge);
  const metricStrip = doc.createElement('dl');
  metricStrip.style.cssText =
    'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:12px 0;' +
    'border:1px solid #346979;background:#143342;';
  const desktopValues = statLabels.map((label, index) => {
    const metric = doc.createElement('div');
    metric.style.cssText = 'text-align:center;padding:7px 2px;';
    if (index > 0) metric.style.borderLeft = '1px solid #346979';
    const caption = doc.createElement('dt');
    caption.textContent = label.toUpperCase();
    caption.style.cssText = 'font-size:9px;letter-spacing:.05em;color:#b6dce6;';
    const value = doc.createElement('dd');
    value.style.cssText = 'font-size:15px;line-height:1.3;margin:0;';
    metric.append(caption, value);
    metricStrip.append(metric);
    return value;
  });
  const actions = doc.createElement('div');
  actions.style.cssText = 'display:flex;gap:7px;';
  const sell = doc.createElement('button');
  sell.type = 'button';
  sell.dataset.turretAction = 'sell';
  const actionStyle =
    'flex:1;min-height:30px;border-radius:1px 7px 1px 7px;padding:5px 9px;cursor:pointer;' +
    'font:600 12px/1.2 system-ui,-apple-system,sans-serif;letter-spacing:.04em;';
  sell.style.cssText = `${actionStyle}background:#463525;color:#ffd166;border:1px solid #bd8e47;`;
  sell.addEventListener('click', activateSell);
  const close = doc.createElement('button');
  close.type = 'button';
  close.dataset.turretAction = 'close';
  close.textContent = 'Close';
  close.style.cssText = `${actionStyle}background:#102934;color:#eef8fc;border:1px solid #346979;`;
  close.addEventListener('click', options.onClose);
  actions.append(sell, close);
  desktopElement.append(heading, metricStrip, actions);
  options.container.append(desktopElement);

  const syncVisibility = (): void => {
    xrRoot.visible = selected !== null && mode === 'xr';
    desktopElement.hidden = selected === null || mode !== 'desktop';
    rangeRoot.visible = selected !== null;
  };

  let readout = '';
  function setTurret(turret: Readonly<SimTurret> | null): void {
    if (disposed) return;
    const changedSelection = turret?.id !== selected?.id;
    selected = turret;
    if (changedSelection) syncVisibility();
    if (!turret) return;

    const { position, stats: tier } = turret;
    rangeRoot.position.set(position.x, position.y, position.z);
    rangeBoundary.scale.setScalar(tier.rangeM);
    spokes.scale.setScalar(tier.rangeM);
    const values = [`${tier.rangeM} m`, String(tier.damage), `${tier.fireRateHz}/s`];
    const sellText = `Sell +${Math.round(turret.investedCredits * TURRET_SELL_REFUND_RATIO)} CR`;
    const nextReadout = `${turret.name} ${turret.tier} ${values.join(' ')} ${sellText}`;
    if (readout === nextReadout) return;
    readout = nextReadout;
    nameText.text = turret.name;
    nameText.sync();
    tierText.text = turret.tier;
    tierText.sync();
    for (const [index, { value }] of stats.entries()) {
      value.text = values[index] ?? '';
      value.sync();
      const desktopValue = desktopValues[index];
      if (desktopValue) desktopValue.textContent = value.text;
    }
    textBatch.revision += 1;
    panel.setLabel('sell', sellText);
    title.textContent = turret.name;
    tierBadge.textContent = turret.tier;
    sell.textContent = sellText;
  }

  syncVisibility();
  return {
    xrRoot,
    rangeRoot,
    panel,
    desktopElement,
    get turret() {
      return selected;
    },
    setMode(nextMode) {
      if (disposed) return;
      mode = nextMode;
      syncVisibility();
    },
    setTurret,
    dispose() {
      if (disposed) return;
      disposed = true;
      stopKeepAbove();
      panel.dispose();
      rangeGeometry.dispose();
      spokeGeometry.dispose();
      rangeMaterial.dispose();
      markerMaterial.dispose();
      for (const member of members) {
        textBatch.removeText(member);
        member.dispose();
      }
      textBatch.dispose();
      for (const mesh of plates) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      desktopElement.remove();
      xrRoot.removeFromParent();
      rangeRoot.removeFromParent();
    },
  };
}
