import {
  createMenuPanel,
  keepAbove,
  type MenuPanel,
  OVERLAY_RENDER_ORDER,
} from '@par/xr-workspace';
import * as THREE from 'three';
import { TURRET_SELL_REFUND_RATIO } from '../content/turrets.ts';
import type { SimTurret } from '../sim/engine.ts';

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
  });
  const rangeBoundary = new THREE.Group();
  rangeBoundary.name = 'turret-inspector-range-boundary';
  for (let axis = 0; axis < 3; axis += 1) {
    const line = new THREE.LineLoop(rangeGeometry, rangeMaterial);
    line.raycast = () => undefined;
    if (axis === 1) line.rotation.x = Math.PI / 2;
    if (axis === 2) line.rotation.y = Math.PI / 2;
    rangeBoundary.add(line);
  }
  rangeRoot.add(rangeBoundary);

  let mode: 'desktop' | 'xr' = 'desktop';
  let selected: Readonly<SimTurret> | null = null;
  let disposed = false;
  const activateSell = (): void => {
    if (selected) options.onSell(selected);
  };
  const width = 0.56;
  const panel = createMenuPanel({
    name: 'turret-inspector',
    width,
    rowHeight: 0.057,
    rowGap: 0.008,
    hoverColor: RANGE_COLOR,
    rows: [
      { id: 'turret-name', label: '', backplate: false },
      { id: 'range', label: '', backplate: false },
      { id: 'damage-rate', label: '', backplate: false },
      [
        { id: 'sell', label: 'Sell', onSelect: activateSell },
        { id: 'close', label: 'Close', onSelect: options.onClose },
      ],
    ],
  });
  const backing = new THREE.Mesh(
    new THREE.PlaneGeometry(width + 0.05, panel.height + 0.05),
    new THREE.MeshBasicMaterial({
      color: 0x071823,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
    }),
  );
  backing.position.set(0, -panel.height / 2, -0.004);
  const trim = new THREE.Mesh(
    new THREE.PlaneGeometry(width + 0.05, 0.004),
    new THREE.MeshBasicMaterial({ color: RANGE_COLOR, transparent: true, depthWrite: false }),
  );
  trim.position.set(0, 0.024, -0.002);
  trim.raycast = () => undefined;
  xrRoot.add(backing, trim, panel.root);
  const stopKeepAbove = keepAbove(xrRoot, options.renderOrder ?? OVERLAY_RENDER_ORDER);

  const doc = options.container.ownerDocument;
  const desktopElement = doc.createElement('section');
  desktopElement.dataset.turretInspector = 'true';
  desktopElement.setAttribute('aria-label', 'Selected turret');
  desktopElement.style.cssText =
    'position:absolute;right:16px;top:72px;z-index:7001;padding:12px 16px;' +
    'background:#0b2531;border-top:2px solid #35d6e8;color:#e6fbff;' +
    'font:600 13px/1.5 "SF Mono",Consolas,monospace;min-width:220px;';
  const title = doc.createElement('strong');
  title.style.color = '#72e5ec';
  const stats = doc.createElement('div');
  stats.style.margin = '5px 0 12px';
  const sell = doc.createElement('button');
  sell.type = 'button';
  sell.dataset.turretAction = 'sell';
  sell.style.cssText =
    'background:#542e1a;color:#ffe0a1;border:1px solid #bd8e47;padding:5px 9px;cursor:pointer;';
  sell.addEventListener('click', activateSell);
  const close = doc.createElement('button');
  close.type = 'button';
  close.dataset.turretAction = 'close';
  close.textContent = 'Close';
  close.style.cssText =
    'margin-left:8px;background:#103641;color:#e6fbff;border:1px solid #438592;' +
    'padding:5px 9px;cursor:pointer;';
  close.addEventListener('click', options.onClose);
  desktopElement.append(title, stats, sell, close);
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
    const titleText = `${turret.name} · ${turret.tier}`;
    const rangeText = `Range ${tier.rangeM} m`;
    const damageText = `${tier.damage} damage · ${tier.fireRateHz}/s`;
    const sellText = `Sell +${Math.round(turret.investedCredits * TURRET_SELL_REFUND_RATIO)} CR`;
    const nextReadout = `${titleText} ${rangeText} ${damageText} ${sellText}`;
    if (readout === nextReadout) return;
    readout = nextReadout;
    panel.setLabel('turret-name', titleText);
    panel.setLabel('range', rangeText);
    panel.setLabel('damage-rate', damageText);
    panel.setLabel('sell', sellText);
    title.textContent = titleText;
    stats.textContent = `${rangeText} · ${damageText}`;
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
      rangeMaterial.dispose();
      backing.geometry.dispose();
      backing.material.dispose();
      trim.geometry.dispose();
      trim.material.dispose();
      desktopElement.remove();
      xrRoot.removeFromParent();
      rangeRoot.removeFromParent();
    },
  };
}
