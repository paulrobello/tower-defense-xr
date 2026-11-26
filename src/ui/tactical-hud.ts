/**
 * Compact Movable Spatial XR Tactical HUD & Matching Desktop HUD Strip.
 *
 * - **Spatial XR HUD (`xrRoot`):** Built on `@par/xr-workspace` public exports (`createMenuPanel`,
 *   `CachedTextBatch`, `keepAbove`, `OVERLAY_RENDER_ORDER`) with local bundled Troika SDF fonts
 *   (`configureFonts()`). Displays Core HP, Requisition Credits, wave progress, remaining enemies,
 *   active turrets, Play Arc (`180°` / `360°`), contextual primary button (`Lock Core` in `calibrate`,
 *   `Launch Wave` in `prep`/`intermission`, `Wave Active` in `wave`, `Recalibrate` on end screens),
 *   and `Settings` button. Marked `rootUIgrabbable` so Universal Manipulation can move/rotate/scale
 *   it cleanly as one unit.
 * - **Recentering (`view/recenter`):** Repositions the spatial HUD in front of the current headset
 *   pose (`1.15 m` ahead, slightly below eye level, facing the player horizontally, scale reset to
 *   `1.0`) and stays spatially stable afterward (never head-locked).
 * - **Desktop HUD Strip (`desktopElement`):** Matching minimal tactical top strip styled purely via
 *   CSSOM (`element.style`, strict production CSP safe) dispatching the exact same `ActionBus`
 *   actions with `source: 'desktop'`.
 */

import {
  CachedTextBatch,
  createMenuPanel,
  keepAbove,
  type MenuPanel,
  type MenuRow,
  OVERLAY_RENDER_ORDER,
} from '@par/xr-workspace';
import * as THREE from 'three';
import { Text } from 'troika-three-text';
import { HARD_TURRET_CAP, type TurretKind, type TurretMountProfileId } from '../content/turrets.ts';
import { CORE_MAX_HP, STARTING_CREDITS, TOTAL_WAVES } from '../content/waves.ts';
import type { ActionBus, ActionSource, PlayArc } from '../core/action-bus.ts';
import type { GamePhase } from '../core/state.ts';
import { forwardFromYaw, type HeadsetPose } from '../xr/calibration.ts';
import { configureFonts, resolveFontUrls } from './fonts.ts';
import type { TacticalAtlasResource, TacticalIconAtlas } from './tactical-atlas.ts';

export type TacticalHudMode = 'desktop' | 'xr';

export const DEFAULT_HUD_RECENTER_DISTANCE_M = 1.15;
export const DEFAULT_HUD_RECENTER_Y_OFFSET_M = -0.18;
export const DEFAULT_HUD_MIN_Y_M = 0.72;

export interface TacticalHudState {
  readonly phase: GamePhase;
  readonly coreHp: number;
  readonly coreMaxHp: number;
  readonly credits: number;
  readonly wave: number;
  readonly totalWaves: number;
  readonly enemiesRemaining: number;
  readonly activeTurrets: number;
  readonly maxTurrets: number;
  readonly playArc: PlayArc;
  readonly canLockCore: boolean;
  readonly canLaunchWave: boolean;
  readonly selectedTurretKind: TurretKind | null;
  readonly mountMode: TurretMountProfileId;
  readonly disruptedTurretCount?: number;
}

export interface TacticalHudOptions {
  readonly actionBus: ActionBus;
  readonly atlas?: TacticalAtlasResource;
  readonly container?: HTMLElement | null;
  readonly initialMode?: TacticalHudMode;
  readonly initialVisible?: boolean;
  readonly initialState?: Partial<TacticalHudState>;
  readonly getHeadsetPose?: () => HeadsetPose | null;
  readonly recenterDistanceM?: number;
  readonly recenterYOffsetM?: number;
  readonly width?: number;
  readonly renderOrder?: number;
}

export interface TacticalHud {
  readonly xrRoot: THREE.Group;
  readonly panel: MenuPanel;
  readonly textBatch: CachedTextBatch;
  readonly desktopElement: HTMLElement | null;
  readonly state: Readonly<TacticalHudState>;
  readonly mode: TacticalHudMode;
  readonly visible: boolean;
  readonly recenterCount: number;
  updateState(patch: Partial<TacticalHudState>): Readonly<TacticalHudState>;
  setMode(mode: TacticalHudMode): void;
  setVisible(visible: boolean): void;
  /** Repositions `xrRoot` in front of `headsetPose` and resets uniform scale; stays spatially stable afterward. */
  recenterToHeadset(headsetPose: HeadsetPose): void;
  /** XR pointer hit testing for HUD buttons. */
  cellAt(object: THREE.Object3D): string | null;
  setHovered(id: string | null): void;
  activate(id: string): boolean;
  dispose(): void;
}

const DEFAULT_HEADSET_POSE: HeadsetPose = {
  position: { x: 0, y: 1.55, z: 0 },
  yaw: 0,
};

const Y_AXIS = new THREE.Vector3(0, 1, 0);

function applyStyle(element: HTMLElement, css: Partial<CSSStyleDeclaration>): void {
  Object.assign(element.style, css);
}

function formatPrimaryButtonLabel(state: Readonly<TacticalHudState>): string {
  switch (state.phase) {
    case 'calibrate':
      return state.canLockCore ? 'Lock Core' : 'Move Core';
    case 'prep':
    case 'intermission':
      return 'Launch Wave';
    case 'wave':
      return `Wave ${state.wave}/${state.totalWaves}`;
    case 'victory':
    case 'defeat':
      return 'Recalibrate';
    default:
      return 'Lock Core';
  }
}

function formatPlayArcXrBadge(arc: PlayArc): string {
  return arc === 'front-180' ? 'Arc: 180°' : 'Arc: 360°';
}

function formatPlayArcDesktopBadge(arc: PlayArc): string {
  return arc === 'front-180' ? 'ARC 180° SEATED' : 'ARC 360° ROOM';
}

function formatCoreHpText(state: Readonly<TacticalHudState>): string {
  return `CORE ${Math.max(0, Math.round(state.coreHp))}/${Math.max(1, Math.round(state.coreMaxHp))}`;
}

function formatCreditsText(state: Readonly<TacticalHudState>): string {
  return `${Math.max(0, Math.floor(state.credits))} CR`;
}

function formatWaveText(state: Readonly<TacticalHudState>): string {
  return `WAVE ${Math.max(0, Math.floor(state.wave))}/${Math.max(1, Math.floor(state.totalWaves))}`;
}

function formatTurretsText(state: Readonly<TacticalHudState>): string {
  return `TURRETS ${Math.max(0, Math.floor(state.activeTurrets))}/${Math.max(1, Math.floor(state.maxTurrets))}`;
}

function formatRemainingEnemies(state: Readonly<TacticalHudState>): string {
  if (state.phase === 'intermission') return '0';
  if (state.phase !== 'wave') return '—';
  return String(state.enemiesRemaining);
}

function createChamferPlate(width: number, height: number, bevel: number): THREE.ShapeGeometry {
  const x = width / 2;
  const y = height / 2;
  const outline = new THREE.Shape();
  outline.moveTo(-x + bevel, y);
  outline.lineTo(x - bevel, y);
  outline.lineTo(x, y - bevel);
  outline.lineTo(x, -y + bevel);
  outline.lineTo(x - bevel, -y);
  outline.lineTo(-x + bevel, -y);
  outline.lineTo(-x, -y + bevel);
  outline.lineTo(-x, y - bevel);
  outline.closePath();
  return new THREE.ShapeGeometry(outline);
}

function createBatchedTextMember(
  text: string,
  fontUrl: string,
  fontSize: number,
  color: string,
  x: number,
  y: number,
  anchorX: 'left' | 'center' | 'right',
): Text {
  const member = new Text();
  member.text = text;
  member.font = fontUrl;
  member.fontSize = fontSize;
  member.color = color;
  member.anchorX = anchorX;
  member.anchorY = 'middle';
  member.position.set(x, y, 0.004);
  member.updateMatrix();
  member.sync();
  return member;
}

/**
 * Creates the movable spatial XR tactical HUD (`createMenuPanel` + `CachedTextBatch` + `keepAbove`)
 * and matching minimal desktop HUD strip.
 */
export function createTacticalHud(options: TacticalHudOptions): TacticalHud {
  configureFonts();

  const { actionBus } = options;
  const width = options.width ?? 0.68;
  const renderOrder = options.renderOrder ?? OVERLAY_RENDER_ORDER;
  const recenterDistanceM = options.recenterDistanceM ?? DEFAULT_HUD_RECENTER_DISTANCE_M;
  const recenterYOffsetM = options.recenterYOffsetM ?? DEFAULT_HUD_RECENTER_Y_OFFSET_M;

  let mode: TacticalHudMode = options.initialMode ?? 'desktop';
  let visible = options.initialVisible ?? true;
  let recenterCount = 0;
  let lastHeadsetPose: HeadsetPose = options.getHeadsetPose?.() ?? DEFAULT_HEADSET_POSE;
  let loadedAtlas: TacticalIconAtlas | null = null;
  let disposed = false;

  if (options.atlas) {
    void options.atlas.get().then((resolved) => {
      if (!disposed && resolved) {
        loadedAtlas = resolved;
        syncReadouts();
      }
    });
  }

  let state: TacticalHudState = {
    phase: options.initialState?.phase ?? 'calibrate',
    coreHp: options.initialState?.coreHp ?? CORE_MAX_HP,
    coreMaxHp: options.initialState?.coreMaxHp ?? CORE_MAX_HP,
    credits: options.initialState?.credits ?? STARTING_CREDITS,
    wave: options.initialState?.wave ?? 0,
    totalWaves: options.initialState?.totalWaves ?? TOTAL_WAVES,
    enemiesRemaining: options.initialState?.enemiesRemaining ?? 0,
    activeTurrets: options.initialState?.activeTurrets ?? 0,
    maxTurrets: options.initialState?.maxTurrets ?? HARD_TURRET_CAP,
    playArc: options.initialState?.playArc ?? 'front-180',
    canLockCore: options.initialState?.canLockCore ?? true,
    canLaunchWave: options.initialState?.canLaunchWave ?? true,
    selectedTurretKind: options.initialState?.selectedTurretKind ?? null,
    mountMode: options.initialState?.mountMode ?? 'surface-clamp',
  };

  function dispatchPrimaryAction(source: ActionSource): void {
    if (state.phase === 'calibrate') {
      if (state.canLockCore) {
        actionBus.dispatch({ type: 'calibrate/confirm' }, source);
      }
      return;
    }
    if (state.phase === 'prep' || state.phase === 'intermission') {
      if (state.canLaunchWave) {
        actionBus.dispatch({ type: 'wave/launch' }, source);
      }
      return;
    }
    if (state.phase === 'victory' || state.phase === 'defeat') {
      actionBus.dispatch({ type: 'calibrate/begin' }, source);
    }
  }

  function dispatchTogglePlayArc(source: ActionSource): void {
    const nextArc: PlayArc = state.playArc === 'front-180' ? 'full-360' : 'front-180';
    actionBus.dispatch({ type: 'calibrate/set-play-arc', arc: nextArc }, source);
  }

  function dispatchOpenSettings(source: ActionSource): void {
    actionBus.dispatch({ type: 'menu/open-settings' }, source);
  }

  // --- Spatial XR HUD Root ---
  const xrRoot = new THREE.Group();
  xrRoot.name = 'tactical-hud-xr-root';
  xrRoot.userData.rootUIgrabbable = true;
  xrRoot.userData.inputAction = 'grabWidget';
  xrRoot.userData.scaleLimits = [0.5, 1.8];

  const telemetryHeight = 0.082;
  const buttonRowHeight = 0.068;
  const padX = 0.026;
  const padY = 0.02;

  const panelRows: MenuRow[] = [
    [
      {
        id: 'primary-action',
        label: formatPrimaryButtonLabel(state),
        weight: 2.2,
        selected: true,
        onSelect: () => dispatchPrimaryAction('xr'),
      },
      {
        id: 'play-arc',
        label: formatPlayArcXrBadge(state.playArc),
        weight: 1.4,
        onSelect: () => dispatchTogglePlayArc('xr'),
      },
      {
        id: 'settings',
        label: 'Settings',
        weight: 1.2,
        onSelect: () => dispatchOpenSettings('xr'),
      },
    ],
  ];

  const panel = createMenuPanel({
    name: 'tactical-hud',
    rows: panelRows,
    width,
    rowHeight: buttonRowHeight,
    rowGap: 0.01,
    cellGap: 0.014,
    hoverColor: 0x86f9ff,
  });
  panel.root.position.set(0, -telemetryHeight - 0.012, 0.002);

  // Batched SDF telemetry strip via `@par/xr-workspace` `CachedTextBatch`
  const fontUrl = resolveFontUrls().main;
  const textBatch = new CachedTextBatch();
  textBatch.name = 'tactical-hud-telemetry-batch';
  textBatch.frustumCulled = false;
  textBatch.raycast = () => undefined;

  const topLineY = -0.02;
  const bottomLineY = -0.063;
  const leftX = -width / 2 + 0.012;
  const rightX = width / 2 - 0.012;

  const coreHpText = createBatchedTextMember(
    formatCoreHpText(state),
    fontUrl,
    0.024,
    '#5ef2b6',
    leftX,
    topLineY,
    'left',
  );
  const creditsText = createBatchedTextMember(
    formatCreditsText(state),
    fontUrl,
    0.024,
    '#ffd166',
    rightX,
    topLineY,
    'right',
  );
  const waveText = createBatchedTextMember(
    formatWaveText(state),
    fontUrl,
    0.021,
    '#8fd8ff',
    leftX,
    bottomLineY,
    'left',
  );
  const turretsText = createBatchedTextMember(
    formatTurretsText(state),
    fontUrl,
    0.021,
    '#e4f2fb',
    rightX,
    bottomLineY,
    'right',
  );
  const enemyCaption = createBatchedTextMember(
    'ENEMIES LEFT',
    fontUrl,
    0.017,
    '#b6dce6',
    0,
    -0.023,
    'center',
  );
  const enemyCountText = createBatchedTextMember(
    formatRemainingEnemies(state),
    fontUrl,
    0.033,
    '#fff4b9',
    0,
    -0.054,
    'center',
  );
  enemyCountText.name = 'tactical-hud-enemies-left';

  const batchMembers = [
    coreHpText,
    creditsText,
    waveText,
    turretsText,
    enemyCaption,
    enemyCountText,
  ];
  for (const member of batchMembers) {
    textBatch.addText(member);
  }
  textBatch.revision += 1;

  const totalHeight = telemetryHeight + 0.012 + panel.height;
  const panelWidth = width + padX * 2;
  const panelHeight = totalHeight + padY * 2;
  const frameGeo = createChamferPlate(panelWidth, panelHeight, 0.018);
  const backingGeo = createChamferPlate(panelWidth - 0.006, panelHeight - 0.006, 0.016);
  const insetGeo = createChamferPlate(width * 0.32, 0.074, 0.009);
  const trimGeo = new THREE.PlaneGeometry(width * 0.36, 0.004);
  const barWidth = width * 0.24;
  const healthGeo = new THREE.PlaneGeometry(barWidth, 0.006);

  const createPlateMaterial = (color: number, opacity = 1): THREE.MeshBasicMaterial =>
    new THREE.MeshBasicMaterial({ color, opacity, transparent: true, depthWrite: false });

  const frameMat = createPlateMaterial(0x438592, 0.98);
  const backingMat = createPlateMaterial(0x071823, 0.96);
  const insetMat = createPlateMaterial(0x153644);
  const trimMat = createPlateMaterial(0x53e4f2);
  const healthTrackMat = createPlateMaterial(0x254750);
  const healthMat = createPlateMaterial(0x5ef2b6);

  const frame = new THREE.Mesh(frameGeo, frameMat);
  frame.position.set(0, -totalHeight / 2, -0.007);
  frame.raycast = () => undefined;

  const backing = new THREE.Mesh(backingGeo, backingMat);
  backing.name = 'tactical-hud-backing';
  backing.position.set(0, -totalHeight / 2, -0.004);
  backing.userData.inputAction = 'grabWidget';

  const enemyInset = new THREE.Mesh(insetGeo, insetMat);
  enemyInset.position.set(0, -0.039, -0.002);
  enemyInset.raycast = () => undefined;

  const trim = new THREE.Mesh(trimGeo, trimMat);
  trim.name = 'tactical-hud-top-trim';
  trim.position.set(-width * 0.28, padY - 0.004, -0.002);
  trim.raycast = () => undefined;

  const healthTrack = new THREE.Mesh(healthGeo, healthTrackMat);
  healthTrack.position.set(leftX + barWidth / 2, -0.039, -0.001);
  healthTrack.raycast = () => undefined;
  const healthFill = new THREE.Mesh(healthGeo, healthMat);
  healthFill.name = 'tactical-hud-core-fill';
  healthFill.position.copy(healthTrack.position);
  healthFill.position.z = 0.001;
  healthFill.raycast = () => undefined;

  xrRoot.add(frame, backing, trim, enemyInset, healthTrack, healthFill, textBatch, panel.root);
  const stopKeepAbove = keepAbove(xrRoot, renderOrder);

  // --- Desktop HUD Strip (strict CSSOM styling, no inline <style> injection) ---
  const container =
    options.container !== undefined
      ? options.container
      : typeof document !== 'undefined'
        ? document.body
        : null;

  let desktopElement: HTMLElement | null = null;
  let coreHpEl: HTMLSpanElement | null = null;
  let creditsEl: HTMLSpanElement | null = null;
  let waveWarningIconEl: HTMLSpanElement | null = null;
  let waveEl: HTMLSpanElement | null = null;
  let enemiesEl: HTMLSpanElement | null = null;
  let empWarningIconEl: HTMLSpanElement | null = null;
  let turretsEl: HTMLSpanElement | null = null;
  let playArcBtn: HTMLButtonElement | null = null;
  let primaryBtn: HTMLButtonElement | null = null;
  let settingsBtn: HTMLButtonElement | null = null;

  if (container) {
    const doc = container.ownerDocument;
    const bar = doc.createElement('div');
    bar.dataset.hud = 'tactical-strip';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Tactical HUD');
    applyStyle(bar, {
      position: 'fixed',
      top: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '7000',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexWrap: 'wrap',
      maxWidth: 'calc(100% - 24px)',
      gap: '7px',
      padding: '10px 16px',
      clipPath:
        'polygon(12px 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%, 0 12px)',
      background: 'linear-gradient(115deg, #102e3b, #081822 58%, #12323b)',
      borderTop: '2px solid #53e4f2',
      borderBottom: '1px solid #438592',
      color: '#e9f8ff',
      fontFamily: '"SF Mono", Consolas, monospace',
      fontSize: '12px',
      fontWeight: '600',
      letterSpacing: '0.05em',
      pointerEvents: 'auto',
      whiteSpace: 'nowrap',
    });

    const makeStat = (key: string, accent: string): HTMLSpanElement => {
      const span = doc.createElement('span');
      span.dataset.hud = key;
      applyStyle(span, {
        padding: '4px 8px',
        backgroundColor: '#143342',
        borderLeft: '2px solid #346979',
        color: accent,
        fontVariantNumeric: 'tabular-nums',
      });
      return span;
    };

    const makeBtn = (key: string, primary = false): HTMLButtonElement => {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.dataset.hud = key;
      applyStyle(btn, {
        padding: '5px 11px',
        borderRadius: '1px 7px 1px 7px',
        border: primary ? '1px solid #53e4f2' : '1px solid #346979',
        background: primary ? '#0a5362' : '#102934',
        color: '#eef8fc',
        font: '600 12px/1.2 system-ui, -apple-system, sans-serif',
        letterSpacing: '0.04em',
        cursor: 'pointer',
      });
      return btn;
    };

    const makeIconBadge = (key: string, title: string): HTMLSpanElement => {
      const icon = doc.createElement('span');
      icon.dataset.hud = key;
      icon.title = title;
      applyStyle(icon, {
        display: 'none',
        width: '20px',
        height: '20px',
        flexShrink: '0',
        backgroundRepeat: 'no-repeat',
      });
      return icon;
    };

    coreHpEl = makeStat('core-hp', '#5ef2b6');
    creditsEl = makeStat('credits', '#ffd166');
    waveWarningIconEl = makeIconBadge('wave-warning-icon', 'Wave Active');
    waveEl = makeStat('wave', '#8fd8ff');
    enemiesEl = makeStat('enemies-left', '#fff4b9');
    empWarningIconEl = makeIconBadge('emp-disrupted-icon', 'Turret EMP Disrupted');
    turretsEl = makeStat('turrets', '#e7f4fb');

    playArcBtn = makeBtn('play-arc', false);
    playArcBtn.addEventListener('click', () => dispatchTogglePlayArc('desktop'));

    primaryBtn = makeBtn('primary-action', true);
    primaryBtn.addEventListener('click', () => dispatchPrimaryAction('desktop'));

    settingsBtn = makeBtn('settings', false);
    settingsBtn.textContent = 'Settings';
    settingsBtn.addEventListener('click', () => dispatchOpenSettings('desktop'));

    bar.append(
      coreHpEl,
      creditsEl,
      waveWarningIconEl,
      waveEl,
      enemiesEl,
      empWarningIconEl,
      turretsEl,
      playArcBtn,
      primaryBtn,
      settingsBtn,
    );
    container.appendChild(bar);
    desktopElement = bar;
  }

  function syncVisibility(): void {
    xrRoot.visible = visible && mode === 'xr';
    if (desktopElement) {
      const showDom = visible && mode === 'desktop';
      desktopElement.hidden = !showDom;
      applyStyle(desktopElement, { display: showDom ? 'flex' : 'none' });
    }
  }

  function syncReadouts(): void {
    if (disposed) return;

    const nextCoreText = formatCoreHpText(state);
    const nextCreditsText = formatCreditsText(state);
    const nextWaveText = formatWaveText(state);
    const nextTurretsText = formatTurretsText(state);
    const remainingEnemies = formatRemainingEnemies(state);
    const nextPrimaryLabel = formatPrimaryButtonLabel(state);
    const nextArcPanelLabel = formatPlayArcXrBadge(state.playArc);
    const hpRatio =
      state.coreMaxHp > 0 ? THREE.MathUtils.clamp(state.coreHp / state.coreMaxHp, 0, 1) : 0;
    const hpColor = hpRatio <= 0.3 ? '#ff5c72' : hpRatio <= 0.6 ? '#ffd166' : '#5ef2b6';

    let batchDirty = false;
    const updateBatchMember = (member: Text, nextText: string, nextColor?: string): void => {
      if (member.text === nextText && (nextColor === undefined || member.color === nextColor))
        return;
      member.text = nextText;
      if (nextColor !== undefined) member.color = nextColor;
      member.sync();
      batchDirty = true;
    };

    updateBatchMember(coreHpText, nextCoreText, hpColor);
    updateBatchMember(creditsText, nextCreditsText);
    updateBatchMember(waveText, nextWaveText);
    updateBatchMember(turretsText, nextTurretsText);
    updateBatchMember(
      enemyCountText,
      remainingEnemies,
      state.phase === 'wave' ? '#fff4b9' : '#a8c8d0',
    );
    healthFill.visible = hpRatio > 0;
    healthFill.scale.x = hpRatio;
    healthFill.position.x = leftX + (barWidth * hpRatio) / 2;
    healthMat.color.set(hpColor);

    if (batchDirty) {
      textBatch.revision += 1;
    }

    panel.setLabel('primary-action', nextPrimaryLabel);
    panel.setLabel('play-arc', nextArcPanelLabel);

    if (coreHpEl) {
      coreHpEl.textContent = nextCoreText;
      coreHpEl.style.color = hpColor;
      const percentage = hpRatio * 100;
      coreHpEl.style.backgroundImage = `linear-gradient(to right, ${hpColor} ${percentage}%, #254750 ${percentage}%)`;
      coreHpEl.style.backgroundSize = '100% 2px';
      coreHpEl.style.backgroundRepeat = 'no-repeat';
      coreHpEl.style.backgroundPosition = 'bottom';
    }
    if (creditsEl) creditsEl.textContent = nextCreditsText;
    if (waveEl) waveEl.textContent = nextWaveText;
    if (enemiesEl) enemiesEl.textContent = `ENEMIES LEFT ${remainingEnemies}`;
    if (turretsEl) turretsEl.textContent = nextTurretsText;
    const syncAtlasBadge = (el: HTMLSpanElement | null, iconId: string, active: boolean): void => {
      if (!el) return;
      const rect = loadedAtlas?.icons[iconId]?.rect;
      if (!active || !loadedAtlas || !rect) {
        applyStyle(el, { display: 'none' });
        return;
      }
      const size = 20;
      const scale = size / 128;
      applyStyle(el, {
        display: 'inline-block',
        backgroundImage: `url("${loadedAtlas.url}")`,
        backgroundSize: `${loadedAtlas.width * scale}px ${loadedAtlas.height * scale}px`,
        backgroundPosition: `${-rect[0] * scale}px ${-rect[1] * scale}px`,
      });
    };
    syncAtlasBadge(waveWarningIconEl, 'wave-warning', state.phase === 'wave');
    syncAtlasBadge(empWarningIconEl, 'emp-disrupted', (state.disruptedTurretCount ?? 0) > 0);
    if (playArcBtn) playArcBtn.textContent = formatPlayArcDesktopBadge(state.playArc);
    if (primaryBtn) {
      primaryBtn.textContent = nextPrimaryLabel;
      const disabled =
        state.phase === 'wave' ||
        (state.phase === 'calibrate' && !state.canLockCore) ||
        ((state.phase === 'prep' || state.phase === 'intermission') && !state.canLaunchWave);
      primaryBtn.disabled = disabled;
      primaryBtn.style.opacity = disabled ? '0.55' : '1';
    }
  }

  function recenterToHeadset(headsetPose: HeadsetPose): void {
    if (disposed) return;
    lastHeadsetPose = {
      position: { ...headsetPose.position },
      yaw: headsetPose.yaw,
    };
    const fwd = forwardFromYaw(headsetPose.yaw);
    const targetY = Math.max(DEFAULT_HUD_MIN_Y_M, headsetPose.position.y + recenterYOffsetM);
    xrRoot.position.set(
      headsetPose.position.x + fwd.x * recenterDistanceM,
      targetY,
      headsetPose.position.z + fwd.z * recenterDistanceM,
    );
    xrRoot.quaternion.setFromAxisAngle(Y_AXIS, headsetPose.yaw);
    xrRoot.scale.setScalar(1);
    xrRoot.updateMatrixWorld(true);
    recenterCount += 1;
  }

  // Position once at spawn relative to initial headset pose, then remain spatially stable.
  recenterToHeadset(lastHeadsetPose);
  recenterCount = 0;

  const unsubscribers: Array<() => void> = [
    actionBus.on('view/recenter', () => {
      const pose = options.getHeadsetPose?.() ?? lastHeadsetPose;
      recenterToHeadset(pose);
    }),
    actionBus.on('calibrate/set-play-arc', (action) => {
      if (state.playArc !== action.arc) {
        state = { ...state, playArc: action.arc };
        syncReadouts();
      }
    }),
  ];

  syncReadouts();
  syncVisibility();

  return {
    xrRoot,
    panel,
    textBatch,
    desktopElement,
    get state() {
      return state;
    },
    get mode() {
      return mode;
    },
    get visible() {
      return visible;
    },
    get recenterCount() {
      return recenterCount;
    },
    updateState(patch) {
      if (disposed) return state;
      state = { ...state, ...patch };
      syncReadouts();
      return state;
    },
    setMode(nextMode) {
      if (disposed || mode === nextMode) return;
      mode = nextMode;
      syncVisibility();
    },
    setVisible(nextVisible) {
      if (disposed || visible === nextVisible) return;
      visible = nextVisible;
      syncVisibility();
    },
    recenterToHeadset,
    cellAt(object) {
      return disposed ? null : panel.cellAt(object);
    },
    setHovered(id) {
      if (!disposed) panel.setHovered(id);
    },
    activate(id) {
      return disposed ? false : panel.activate(id);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsub of unsubscribers.splice(0)) unsub();
      stopKeepAbove();
      for (const member of batchMembers) {
        textBatch.removeText(member);
        member.dispose();
      }
      textBatch.dispose();
      panel.dispose();
      for (const geometry of [frameGeo, backingGeo, insetGeo, trimGeo, healthGeo]) {
        geometry.dispose();
      }
      for (const material of [frameMat, backingMat, insetMat, trimMat, healthTrackMat, healthMat]) {
        material.dispose();
      }
      xrRoot.clear();
      xrRoot.removeFromParent();
      desktopElement?.remove();
    },
  };
}
