import {
  createMenuPanel,
  keepAbove,
  type MenuPanel,
  type MenuRow,
  OVERLAY_RENDER_ORDER,
} from '@par/xr-workspace';
import * as THREE from 'three';
import type { OcclusionState } from '../mr/occlusion.ts';
import {
  FIXED_FOVEATION_OPTIONS,
  type FixedFoveationOption,
  FRAMEBUFFER_SCALE_OPTIONS,
  type FramebufferScaleOption,
  PLAY_ARC_OPTIONS,
  type PlayArcOption,
  QUALITY_TIER_OPTIONS,
  type QualityTierOption,
  ROOM_OCCLUSION_OPTIONS,
  type RoomOcclusionOption,
  SETTINGS_METADATA,
  type Settings,
  type SettingsStore,
} from './store';

export interface SettingsXrStatus {
  readonly inSession?: boolean;
  readonly appliedFramebufferScale?: number | null;
  readonly reportedFoveation?: number | null;
  readonly roomOcclusion?: Readonly<OcclusionState>;
}

export interface DomSettingsPanelOptions {
  container?: HTMLElement;
  onClose?: () => void;
  initialOpen?: boolean;
}

export interface DomSettingsPanel {
  readonly element: HTMLElement;
  readonly open: boolean;
  show(): void;
  hide(): void;
  toggle(): void;
  setXrStatus(status: SettingsXrStatus): void;
  dispose(): void;
}

export interface XrSettingsPanelOptions {
  name?: string;
  width?: number;
  rowHeight?: number;
  renderOrder?: number;
  onClose?: () => void;
  initialVisible?: boolean;
}

export interface XrSettingsPanel {
  readonly root: THREE.Group;
  readonly panel: MenuPanel;
  readonly visible: boolean;
  show(): void;
  hide(): void;
  toggle(): void;
  setVisible(visible: boolean): void;
  cellAt(object: THREE.Object3D): string | null;
  activate(id: string): boolean;
  setHovered(id: string | null): void;
  setPage(page: number): void;
  setXrStatus(status: SettingsXrStatus): void;
  dispose(): void;
}

const STYLE_ELEMENT_ID = 'rift-bastion-settings-panel-styles';
const VOLUME_STEP = 0.1;

function formatFoveationOption(value: FixedFoveationOption): string {
  if (value === 0) return 'Off (0)';
  if (value === 0.5) return '0.5';
  return '1.0';
}

function formatFoveationCompact(value: FixedFoveationOption): string {
  if (value === 0) return 'Off';
  if (value === 0.5) return '0.5';
  return '1.0';
}

function formatFramebufferScale(value: FramebufferScaleOption): string {
  return `${value.toFixed(value === 1.15 ? 2 : 1)}x`;
}

function formatPlayArcDom(value: PlayArcOption): string {
  return value === 'front-180' ? 'Front 180° (Seated)' : 'Full 360° (Standing)';
}

function formatPlayArcXr(value: PlayArcOption): string {
  return value === 'front-180' ? 'Front 180' : 'Full 360';
}

function formatRoomOcclusion(value: RoomOcclusionOption): string {
  switch (value) {
    case 'auto-depth':
      return 'Auto Depth';
    case 'room-mesh':
      return 'Room Mesh';
    case 'off':
      return 'Off';
  }
}

function formatQualityTier(value: QualityTierOption): string {
  switch (value) {
    case 'max-beauty':
      return 'Max Beauty';
    case 'balanced':
      return 'Balanced';
    case 'high-fps':
      return 'High FPS';
  }
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function cycleOption<T>(options: readonly T[], current: T): T {
  const index = options.indexOf(current);
  return options[(index + 1 + options.length) % options.length];
}

function formatScaleReentryNote(
  settings: Readonly<Settings>,
  xrStatus: SettingsXrStatus,
  compact = false,
): string {
  const applied = xrStatus.appliedFramebufferScale;
  const pending =
    Boolean(xrStatus.inSession) &&
    typeof applied === 'number' &&
    Number.isFinite(applied) &&
    Math.abs(applied - settings.framebufferScale) > 1e-6;
  if (pending && typeof applied === 'number') {
    const activeLabel = `${applied.toFixed(applied === 1.15 ? 2 : 1)}x`;
    return compact
      ? `Scale pending XR re-entry (active ${activeLabel})`
      : `Takes effect on XR re-entry (active XR scale: ${activeLabel}).`;
  }
  return compact
    ? 'FB Scale takes effect on XR re-entry'
    : (SETTINGS_METADATA.framebufferScale.note ?? 'Takes effect on XR re-entry.');
}

function formatFoveationNote(xrStatus: SettingsXrStatus): string {
  const reported = xrStatus.reportedFoveation;
  if (typeof reported === 'number' && Number.isFinite(reported)) {
    return `Active XR reported foveation: ${reported.toFixed(2)}`;
  }
  return 'Applies live in XR and persists across quality preset changes.';
}

function ensureDomStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ELEMENT_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = `
.rb-settings-overlay[hidden] {
  display: none !important;
}
.rb-settings-overlay {
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(6, 11, 17, 0.76);
  backdrop-filter: blur(8px);
  color: #e6f0f7;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.rb-settings-card {
  width: min(520px, 100%);
  max-height: 90vh;
  overflow-y: auto;
  background: #0e1822;
  border: 1px solid #2b4558;
  border-radius: 12px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
  padding: 20px 22px;
}
.rb-settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid #1e3342;
}
.rb-settings-title {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #f3f9fc;
}
.rb-settings-grid {
  display: grid;
  gap: 14px;
}
.rb-settings-row {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 8px 14px;
}
.rb-settings-row-label {
  font-size: 14px;
  font-weight: 500;
  color: #d7e7f2;
}
.rb-settings-note {
  grid-column: 1 / -1;
  font-size: 12px;
  line-height: 1.35;
  color: #8fb1c4;
  margin-top: -4px;
}
.rb-settings-note[data-pending="true"] {
  color: #f0b859;
  font-weight: 500;
}
.rb-settings-select {
  min-width: 196px;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid #35556c;
  background: #142432;
  color: #f0f7fb;
  font-size: 13px;
}
.rb-settings-range-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 196px;
}
.rb-settings-range-wrap input[type="range"] {
  flex: 1;
  accent-color: #54c6eb;
}
.rb-settings-range-value {
  min-width: 38px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  color: #b7d3e3;
}
.rb-settings-checkbox {
  width: 18px;
  height: 18px;
  accent-color: #54c6eb;
}
.rb-settings-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 20px;
  padding-top: 14px;
  border-top: 1px solid #1e3342;
}
.rb-settings-btn {
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid #35556c;
  background: #172b3b;
  color: #eef6fb;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.rb-settings-btn:hover {
  background: #203c52;
}
.rb-settings-btn-primary {
  border-color: #4ea5c7;
  background: #1f546c;
}
.rb-settings-btn-primary:hover {
  background: #296b88;
}
`;
  doc.head.appendChild(style);
}

/**
 * Clean DOM Settings overlay for the launch screen and desktop play.
 * Reads and writes the shared live `SettingsStore`.
 */
export function createDomSettingsPanel(
  store: SettingsStore,
  options: DomSettingsPanelOptions = {},
): DomSettingsPanel {
  const container = options.container ?? document.body;
  const doc = container.ownerDocument;
  ensureDomStyles(doc);

  let isOpen = Boolean(options.initialOpen);
  let xrStatus: SettingsXrStatus = {};
  let disposed = false;

  const overlay = doc.createElement('section');
  overlay.className = 'rb-settings-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Settings');
  overlay.dataset.settingsPanel = 'dom';
  overlay.hidden = !isOpen;
  overlay.setAttribute('aria-hidden', String(!isOpen));

  const card = doc.createElement('div');
  card.className = 'rb-settings-card';
  overlay.appendChild(card);

  const header = doc.createElement('div');
  header.className = 'rb-settings-header';
  const title = doc.createElement('h2');
  title.className = 'rb-settings-title';
  title.textContent = 'Settings';
  const closeTopBtn = doc.createElement('button');
  closeTopBtn.type = 'button';
  closeTopBtn.className = 'rb-settings-btn';
  closeTopBtn.textContent = 'Close';
  closeTopBtn.dataset.settingsAction = 'close';
  header.append(title, closeTopBtn);
  card.appendChild(header);

  const grid = doc.createElement('div');
  grid.className = 'rb-settings-grid';
  card.appendChild(grid);

  const createRow = (
    labelText: string,
    control: HTMLElement,
    noteEl?: HTMLElement,
  ): HTMLElement => {
    const row = doc.createElement('label');
    row.className = 'rb-settings-row';
    const span = doc.createElement('span');
    span.className = 'rb-settings-row-label';
    span.textContent = labelText;
    row.append(span, control);
    if (noteEl) row.appendChild(noteEl);
    grid.appendChild(row);
    return row;
  };

  // Show FPS
  const showFpsInput = doc.createElement('input');
  showFpsInput.type = 'checkbox';
  showFpsInput.className = 'rb-settings-checkbox';
  showFpsInput.dataset.settingKey = 'showFps';
  showFpsInput.setAttribute('aria-label', 'Show FPS');
  showFpsInput.addEventListener('change', () => {
    store.set('showFps', showFpsInput.checked);
  });
  createRow('Show FPS', showFpsInput);

  // Fixed Foveation
  const foveationSelect = doc.createElement('select');
  foveationSelect.className = 'rb-settings-select';
  foveationSelect.dataset.settingKey = 'fixedFoveation';
  foveationSelect.setAttribute('aria-label', 'Fixed Foveation');
  for (const level of FIXED_FOVEATION_OPTIONS) {
    const opt = doc.createElement('option');
    opt.value = String(level);
    opt.textContent = formatFoveationOption(level);
    foveationSelect.appendChild(opt);
  }
  foveationSelect.addEventListener('change', () => {
    store.set('fixedFoveation', Number(foveationSelect.value) as FixedFoveationOption);
  });
  const foveationNote = doc.createElement('span');
  foveationNote.className = 'rb-settings-note';
  foveationNote.dataset.settingsNote = 'fixedFoveation';
  createRow('Fixed Foveation', foveationSelect, foveationNote);

  // Framebuffer Scale
  const scaleSelect = doc.createElement('select');
  scaleSelect.className = 'rb-settings-select';
  scaleSelect.dataset.settingKey = 'framebufferScale';
  scaleSelect.setAttribute('aria-label', 'Framebuffer Scale');
  for (const scale of FRAMEBUFFER_SCALE_OPTIONS) {
    const opt = doc.createElement('option');
    opt.value = String(scale);
    opt.textContent = formatFramebufferScale(scale);
    scaleSelect.appendChild(opt);
  }
  scaleSelect.addEventListener('change', () => {
    store.set('framebufferScale', Number(scaleSelect.value) as FramebufferScaleOption);
  });
  const scaleNote = doc.createElement('span');
  scaleNote.className = 'rb-settings-note';
  scaleNote.dataset.settingsNote = 'framebufferScale';
  createRow('Framebuffer Scale', scaleSelect, scaleNote);

  // Play Arc
  const playArcSelect = doc.createElement('select');
  playArcSelect.className = 'rb-settings-select';
  playArcSelect.dataset.settingKey = 'playArc';
  playArcSelect.setAttribute('aria-label', 'Play Arc');
  for (const arc of PLAY_ARC_OPTIONS) {
    const opt = doc.createElement('option');
    opt.value = arc;
    opt.textContent = formatPlayArcDom(arc);
    playArcSelect.appendChild(opt);
  }
  playArcSelect.addEventListener('change', () => {
    store.set('playArc', playArcSelect.value as PlayArcOption);
  });
  createRow('Play Arc', playArcSelect);

  // Room Occlusion
  const occlusionSelect = doc.createElement('select');
  occlusionSelect.className = 'rb-settings-select';
  occlusionSelect.dataset.settingKey = 'roomOcclusion';
  occlusionSelect.setAttribute('aria-label', 'Room Occlusion');
  for (const mode of ROOM_OCCLUSION_OPTIONS) {
    const opt = doc.createElement('option');
    opt.value = mode;
    opt.textContent = formatRoomOcclusion(mode);
    occlusionSelect.appendChild(opt);
  }
  occlusionSelect.addEventListener('change', () => {
    store.set('roomOcclusion', occlusionSelect.value as RoomOcclusionOption);
  });
  createRow('Room Occlusion', occlusionSelect);

  // Quality Tier
  const qualitySelect = doc.createElement('select');
  qualitySelect.className = 'rb-settings-select';
  qualitySelect.dataset.settingKey = 'qualityTier';
  qualitySelect.setAttribute('aria-label', 'Quality Tier');
  for (const tier of QUALITY_TIER_OPTIONS) {
    const opt = doc.createElement('option');
    opt.value = tier;
    opt.textContent = formatQualityTier(tier);
    qualitySelect.appendChild(opt);
  }
  qualitySelect.addEventListener('change', () => {
    store.set('qualityTier', qualitySelect.value as QualityTierOption);
  });
  createRow('Quality Tier', qualitySelect);

  // Volumes
  const createVolumeControl = (
    key: 'masterVolume' | 'musicVolume' | 'sfxVolume',
    labelText: string,
  ): { input: HTMLInputElement; readout: HTMLSpanElement } => {
    const wrap = doc.createElement('div');
    wrap.className = 'rb-settings-range-wrap';
    const input = doc.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '1';
    input.step = '0.05';
    input.dataset.settingKey = key;
    input.setAttribute('aria-label', labelText);
    const readout = doc.createElement('span');
    readout.className = 'rb-settings-range-value';
    readout.dataset.settingReadout = key;
    input.addEventListener('input', () => {
      store.set(key, Number(input.value));
    });
    wrap.append(input, readout);
    createRow(labelText, wrap);
    return { input, readout };
  };

  const masterControl = createVolumeControl('masterVolume', 'Master Volume');
  const musicControl = createVolumeControl('musicVolume', 'Music Volume');
  const sfxControl = createVolumeControl('sfxVolume', 'SFX Volume');

  // Footer
  const footer = doc.createElement('div');
  footer.className = 'rb-settings-footer';
  const resetBtn = doc.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'rb-settings-btn';
  resetBtn.textContent = 'Reset to Defaults';
  resetBtn.dataset.settingsAction = 'reset';
  resetBtn.addEventListener('click', () => {
    store.reset();
  });

  const doneBtn = doc.createElement('button');
  doneBtn.type = 'button';
  doneBtn.className = 'rb-settings-btn rb-settings-btn-primary';
  doneBtn.textContent = 'Done';
  doneBtn.dataset.settingsAction = 'done';

  footer.append(resetBtn, doneBtn);
  card.appendChild(footer);

  const syncFromStore = (settings: Readonly<Settings>): void => {
    showFpsInput.checked = settings.showFps;
    foveationSelect.value = String(settings.fixedFoveation);
    scaleSelect.value = String(settings.framebufferScale);
    playArcSelect.value = settings.playArc;
    occlusionSelect.value = settings.roomOcclusion;
    qualitySelect.value = settings.qualityTier;

    masterControl.input.value = String(settings.masterVolume);
    masterControl.readout.textContent = formatPercent(settings.masterVolume);
    musicControl.input.value = String(settings.musicVolume);
    musicControl.readout.textContent = formatPercent(settings.musicVolume);
    sfxControl.input.value = String(settings.sfxVolume);
    sfxControl.readout.textContent = formatPercent(settings.sfxVolume);

    foveationNote.textContent = formatFoveationNote(xrStatus);
    scaleNote.textContent = formatScaleReentryNote(settings, xrStatus, false);
    const pending =
      Boolean(xrStatus.inSession) && store.isPendingXrReentry(xrStatus.appliedFramebufferScale);
    scaleNote.dataset.pending = String(pending);
  };

  const setOpen = (next: boolean): void => {
    if (disposed || isOpen === next) return;
    isOpen = next;
    overlay.hidden = !isOpen;
    overlay.setAttribute('aria-hidden', String(!isOpen));
    if (!isOpen) options.onClose?.();
  };

  closeTopBtn.addEventListener('click', () => setOpen(false));
  doneBtn.addEventListener('click', () => setOpen(false));
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) setOpen(false);
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!isOpen || disposed) return;
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  };
  doc.addEventListener('keydown', onKeyDown, true);

  const unsubscribe = store.subscribe((next) => {
    syncFromStore(next);
  });

  syncFromStore(store.get());
  container.appendChild(overlay);

  return {
    element: overlay,
    get open() {
      return isOpen;
    },
    show() {
      setOpen(true);
    },
    hide() {
      setOpen(false);
    },
    toggle() {
      setOpen(!isOpen);
    },
    setXrStatus(status) {
      if (disposed) return;
      xrStatus = { ...status };
      syncFromStore(store.get());
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      doc.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
    },
  };
}

/**
 * Spatial in-XR Settings panel built on `@par/xr-workspace`'s `createMenuPanel` + `keepAbove`.
 * Reads and writes the exact same live `SettingsStore` as the DOM Settings overlay.
 */
export function createXrSettingsPanel(
  store: SettingsStore,
  options: XrSettingsPanelOptions = {},
): XrSettingsPanel {
  const name = options.name ?? 'settings';
  const width = options.width ?? 0.62;
  const rowHeight = options.rowHeight ?? 0.068;
  const renderOrder = options.renderOrder ?? OVERLAY_RENDER_ORDER;

  let xrStatus: SettingsXrStatus = {};
  let disposed = false;

  const root = new THREE.Group();
  root.name = `${name}-panel-root`;
  root.visible = options.initialVisible ?? false;

  const adjustVolume = (key: 'masterVolume' | 'musicVolume' | 'sfxVolume', delta: number): void => {
    const current = store.get()[key];
    const next = Math.round(Math.min(1, Math.max(0, current + delta)) * 100) / 100;
    store.set(key, next);
  };

  const formatShowFpsLabel = (s: Readonly<Settings>): string =>
    `Show FPS: ${s.showFps ? 'On' : 'Off'}`;
  const formatFoveationLabel = (s: Readonly<Settings>): string => {
    const reported = xrStatus.reportedFoveation;
    const suffix =
      typeof reported === 'number' && Number.isFinite(reported)
        ? ` (rep ${reported.toFixed(1)})`
        : '';
    return `Foveation: ${formatFoveationCompact(s.fixedFoveation)}${suffix}`;
  };
  const formatScaleLabel = (s: Readonly<Settings>): string =>
    `FB Scale: ${formatFramebufferScale(s.framebufferScale)}`;
  const formatQualityLabel = (s: Readonly<Settings>): string =>
    `Quality: ${formatQualityTier(s.qualityTier)}`;
  const formatPlayArcLabel = (s: Readonly<Settings>): string =>
    `Play Arc: ${formatPlayArcXr(s.playArc)}`;
  const formatOcclusionLabel = (settings: Readonly<Settings>): string => {
    const requested = formatRoomOcclusion(settings.roomOcclusion);
    const occlusion = xrStatus.roomOcclusion;
    if (!xrStatus.inSession || occlusion?.requestedMode !== settings.roomOcclusion) {
      return `Occlusion: ${requested}`;
    }

    if (occlusion.effectiveMode === 'depth-sensing') return 'Auto Depth · Sensor active';
    const hasRoomMesh = occlusion.occluderMeshCount > 0;
    if (settings.roomOcclusion === 'auto-depth') {
      return hasRoomMesh ? 'Auto Depth · Room Mesh' : 'Auto Depth · Unavailable';
    }
    if (settings.roomOcclusion === 'room-mesh' && !hasRoomMesh) {
      return 'Room Mesh · Unavailable';
    }
    return `Occlusion: ${requested}`;
  };

  const initial = store.get();

  const rows: MenuRow[] = [
    [
      { id: 'header', label: 'Settings', weight: 3, backplate: false },
      {
        id: 'close',
        label: 'Close',
        weight: 1,
        onSelect: () => {
          root.visible = false;
          options.onClose?.();
        },
      },
    ],
    // Page 1: Display & MR
    {
      id: 'show-fps',
      label: formatShowFpsLabel(initial),
      onSelect: () => store.set('showFps', !store.get().showFps),
    },
    {
      id: 'fixed-foveation',
      label: formatFoveationLabel(initial),
      onSelect: () =>
        store.set(
          'fixedFoveation',
          cycleOption(FIXED_FOVEATION_OPTIONS, store.get().fixedFoveation),
        ),
    },
    {
      id: 'framebuffer-scale',
      label: formatScaleLabel(initial),
      onSelect: () =>
        store.set(
          'framebufferScale',
          cycleOption(FRAMEBUFFER_SCALE_OPTIONS, store.get().framebufferScale),
        ),
    },
    {
      id: 'framebuffer-scale-note',
      label: formatScaleReentryNote(initial, xrStatus, true),
      backplate: false,
    },
    {
      id: 'quality-tier',
      label: formatQualityLabel(initial),
      onSelect: () =>
        store.set('qualityTier', cycleOption(QUALITY_TIER_OPTIONS, store.get().qualityTier)),
    },
    {
      id: 'play-arc',
      label: formatPlayArcLabel(initial),
      onSelect: () => store.set('playArc', cycleOption(PLAY_ARC_OPTIONS, store.get().playArc)),
    },
    // Page 2: Occlusion & Audio
    {
      id: 'room-occlusion',
      label: formatOcclusionLabel(initial),
      onSelect: () =>
        store.set('roomOcclusion', cycleOption(ROOM_OCCLUSION_OPTIONS, store.get().roomOcclusion)),
    },
    [
      {
        id: 'master-label',
        label: `Master: ${formatPercent(initial.masterVolume)}`,
        weight: 3,
        backplate: false,
      },
      {
        id: 'master-down',
        label: '-',
        weight: 1,
        onSelect: () => adjustVolume('masterVolume', -VOLUME_STEP),
      },
      {
        id: 'master-up',
        label: '+',
        weight: 1,
        onSelect: () => adjustVolume('masterVolume', VOLUME_STEP),
      },
    ],
    [
      {
        id: 'music-label',
        label: `Music: ${formatPercent(initial.musicVolume)}`,
        weight: 3,
        backplate: false,
      },
      {
        id: 'music-down',
        label: '-',
        weight: 1,
        onSelect: () => adjustVolume('musicVolume', -VOLUME_STEP),
      },
      {
        id: 'music-up',
        label: '+',
        weight: 1,
        onSelect: () => adjustVolume('musicVolume', VOLUME_STEP),
      },
    ],
    [
      {
        id: 'sfx-label',
        label: `SFX: ${formatPercent(initial.sfxVolume)}`,
        weight: 3,
        backplate: false,
      },
      {
        id: 'sfx-down',
        label: '-',
        weight: 1,
        onSelect: () => adjustVolume('sfxVolume', -VOLUME_STEP),
      },
      {
        id: 'sfx-up',
        label: '+',
        weight: 1,
        onSelect: () => adjustVolume('sfxVolume', VOLUME_STEP),
      },
    ],
    {
      id: 'reset',
      label: 'Reset to Defaults',
      onSelect: () => {
        store.reset();
      },
    },
  ];

  const panel = createMenuPanel({
    name,
    rows,
    width,
    rowHeight,
    rowGap: 0.012,
    cellGap: 0.02,
    pinnedRows: 1,
    pageSize: 6,
  });

  const pad = 0.03;
  const backingHeight = Math.max(0.2, panel.height + pad * 2);
  const backingGeometry = new THREE.PlaneGeometry(width + pad * 2, backingHeight);
  const backingMaterial = new THREE.MeshBasicMaterial({
    color: 0x0b151e,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  const backing = new THREE.Mesh(backingGeometry, backingMaterial);
  backing.name = `${name}-panel-backing`;
  backing.position.set(0, -panel.height / 2, -0.004);
  backing.userData.inputAction = 'grabWidget';

  root.add(backing, panel.root);
  root.userData.scaleLimits = [0.4, 1.8];
  const stopKeepAbove = keepAbove(root, renderOrder);

  const syncLabels = (settings: Readonly<Settings>): void => {
    if (disposed) return;
    panel.setLabel('show-fps', formatShowFpsLabel(settings));
    panel.setLabel('fixed-foveation', formatFoveationLabel(settings));
    panel.setLabel('framebuffer-scale', formatScaleLabel(settings));
    panel.setLabel('framebuffer-scale-note', formatScaleReentryNote(settings, xrStatus, true));
    panel.setLabel('quality-tier', formatQualityLabel(settings));
    panel.setLabel('play-arc', formatPlayArcLabel(settings));
    panel.setLabel('room-occlusion', formatOcclusionLabel(settings));
    panel.setLabel('master-label', `Master: ${formatPercent(settings.masterVolume)}`);
    panel.setLabel('music-label', `Music: ${formatPercent(settings.musicVolume)}`);
    panel.setLabel('sfx-label', `SFX: ${formatPercent(settings.sfxVolume)}`);
  };

  const unsubscribe = store.subscribe((next) => {
    syncLabels(next);
  });

  return {
    root,
    panel,
    get visible() {
      return root.visible;
    },
    show() {
      if (!disposed) root.visible = true;
    },
    hide() {
      if (!disposed) root.visible = false;
    },
    toggle() {
      if (!disposed) root.visible = !root.visible;
    },
    setVisible(visible) {
      if (!disposed) root.visible = visible;
    },
    cellAt(object) {
      return disposed ? null : panel.cellAt(object);
    },
    activate(id) {
      return disposed ? false : panel.activate(id);
    },
    setHovered(id) {
      if (!disposed) panel.setHovered(id);
    },
    setPage(page) {
      if (!disposed) panel.setPage(page);
    },
    setXrStatus(status) {
      if (disposed) return;
      xrStatus = { ...status };
      syncLabels(store.get());
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      stopKeepAbove();
      panel.dispose();
      backingGeometry.dispose();
      backingMaterial.dispose();
      root.clear();
      root.removeFromParent();
    },
  };
}
