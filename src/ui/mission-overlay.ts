/**
 * Mission Victory & Defeat Overlay (`src/ui/mission-overlay.ts`).
 *
 * Implements `PRD.md` §D12 (Device-Local IndexedDB Persistence) and
 * `plans/phase-2-combat-simulation-and-waves.md` (P2-T5):
 * - Dual-mode end-of-mission presentation:
 *   1. **Desktop DOM Overlay (`desktopElement`):** Styled strictly via CSSOM (`element.style`,
 *      production CSP safe) with Score, Waves Cleared, 1–3 Star Rating, `NEW BEST` badge,
 *      `Replay Mission`, `Settings`, and validated `Export Backup JSON` / `Import Backup JSON`
 *      controls.
 *   2. **Spatial XR Panel (`xrRoot`):** Built on `@par/xr-workspace` (`createMenuPanel`,
 *      `CachedTextBatch`, `keepAbove`, `OVERLAY_RENDER_ORDER`) with local bundled Troika SDF fonts.
 * - Wired directly to `PersistStore` (`src/persist/store.ts`): records every completed mission run
 *   into IndexedDB, compares against previous best score/stars/wave to highlight `NEW BEST`, and
 *   surfaces validation errors cleanly if corrupt backup JSON is imported.
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
import { CORE_MAX_HP, TOTAL_WAVES } from '../content/waves.ts';
import type { ActionBus, ActionSource } from '../core/action-bus.ts';
import {
  calculateStarRating,
  DEFAULT_MISSION_RECORDS,
  type MissionRecords,
  type PersistBackupPayload,
  type PersistStore,
  type StarRating,
} from '../persist/store.ts';
import type { SettingsStore } from '../settings/store.ts';
import type { CombatSimulationState } from '../sim/engine.ts';
import { configureFonts, resolveFontUrls } from './fonts.ts';

export type MissionOverlayMode = 'desktop' | 'xr';

export interface MissionResultInput {
  readonly victory: boolean;
  readonly score: number;
  readonly wavesCleared: number;
  readonly totalWaves?: number;
  readonly remainingCoreHp: number;
  readonly maxCoreHp?: number;
  readonly seed?: number;
  readonly durationMs?: number;
  /** Optional unique run key to deduplicate repeated frame calls for the same finished mission. */
  readonly runKey?: string;
}

export interface MissionOverlayState {
  readonly open: boolean;
  readonly victory: boolean;
  readonly score: number;
  readonly wavesCleared: number;
  readonly totalWaves: number;
  readonly remainingCoreHp: number;
  readonly maxCoreHp: number;
  readonly stars: StarRating;
  readonly isNewBest: boolean;
  readonly isNewBestScore: boolean;
  readonly isNewBestStars: boolean;
  readonly isNewBestWave: boolean;
  readonly records: MissionRecords;
  readonly backupStatusMessage: string | null;
  readonly backupError: boolean;
  readonly lastExportedJson: string | null;
}

export interface MissionOverlayOptions {
  readonly persistStore: PersistStore;
  readonly actionBus: ActionBus;
  readonly settingsStore?: SettingsStore;
  readonly container?: HTMLElement | null;
  readonly initialMode?: MissionOverlayMode;
  readonly width?: number;
  readonly renderOrder?: number;
  readonly onReplay?: (source: ActionSource) => void;
  readonly onBackupImported?: (payload: PersistBackupPayload) => void;
}

export interface MissionOverlay {
  readonly xrRoot: THREE.Group;
  readonly panel: MenuPanel;
  readonly textBatch: CachedTextBatch;
  readonly desktopElement: HTMLElement | null;
  readonly state: Readonly<MissionOverlayState>;
  readonly mode: MissionOverlayMode;
  readonly visible: boolean;
  presentResult(input: MissionResultInput): Promise<Readonly<MissionOverlayState>>;
  presentFromSim(simState: CombatSimulationState): Promise<Readonly<MissionOverlayState>>;
  refreshRecords(): Promise<Readonly<MissionRecords>>;
  exportBackup(): Promise<string>;
  importBackup(rawJson: string): Promise<PersistBackupPayload>;
  show(): void;
  hide(): void;
  setMode(mode: MissionOverlayMode): void;
  cellAt(object: THREE.Object3D): string | null;
  setHovered(id: string | null): void;
  activate(id: string): boolean;
  dispose(): void;
}

function applyStyle(element: HTMLElement, css: Partial<CSSStyleDeclaration>): void {
  Object.assign(element.style, css);
}

/** Formats a `0..3` star rating as visual filled/empty stars (`★ ★ ★`, `★ ★ ☆`, `☆ ☆ ☆`). */
export function formatStarsVisual(stars: StarRating): string {
  const filled = Math.max(0, Math.min(3, stars));
  const glyphs: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    glyphs.push(i < filled ? '★' : '☆');
  }
  return glyphs.join(' ');
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
 * Creates the Mission Victory & Defeat overlay wired to `PersistStore`.
 */
export function createMissionOverlay(options: MissionOverlayOptions): MissionOverlay {
  configureFonts();

  const { persistStore, actionBus, settingsStore } = options;
  const width = options.width ?? 0.64;
  const renderOrder = options.renderOrder ?? OVERLAY_RENDER_ORDER;

  let mode: MissionOverlayMode = options.initialMode ?? 'desktop';
  let lastRecordedRunKey: string | null = null;
  let disposed = false;

  let state: MissionOverlayState = {
    open: false,
    victory: false,
    score: 0,
    wavesCleared: 0,
    totalWaves: TOTAL_WAVES,
    remainingCoreHp: 0,
    maxCoreHp: CORE_MAX_HP,
    stars: 0,
    isNewBest: false,
    isNewBestScore: false,
    isNewBestStars: false,
    isNewBestWave: false,
    records: DEFAULT_MISSION_RECORDS,
    backupStatusMessage: null,
    backupError: false,
    lastExportedJson: null,
  };

  function handleReplay(source: ActionSource): void {
    hide();
    lastRecordedRunKey = null;
    options.onReplay?.(source);
    actionBus.dispatch({ type: 'calibrate/begin' }, source);
  }

  function handleOpenSettings(source: ActionSource): void {
    actionBus.dispatch({ type: 'menu/open-settings' }, source);
  }

  // --- Spatial XR Mission Overlay ---
  const xrRoot = new THREE.Group();
  xrRoot.name = 'mission-overlay-xr-root';
  xrRoot.position.set(0, 0.05, 0.08);
  xrRoot.visible = false;

  const headerHeight = 0.21;
  const buttonRowHeight = 0.068;
  const padX = 0.032;
  const padY = 0.026;

  const panelRows: MenuRow[] = [
    [
      {
        id: 'replay-mission',
        label: 'Replay Mission',
        weight: 2,
        selected: true,
        onSelect: () => handleReplay('xr'),
      },
      {
        id: 'open-settings',
        label: 'Settings',
        weight: 1.3,
        onSelect: () => handleOpenSettings('xr'),
      },
    ],
  ];

  const panel = createMenuPanel({
    name: 'mission-overlay',
    rows: panelRows,
    width,
    rowHeight: buttonRowHeight,
    rowGap: 0.012,
    cellGap: 0.02,
  });
  panel.root.position.set(0, -headerHeight - 0.014, 0.002);

  const fontUrl = resolveFontUrls().main;
  const textBatch = new CachedTextBatch();
  textBatch.name = 'mission-overlay-text-batch';
  textBatch.frustumCulled = false;
  textBatch.raycast = () => undefined;

  const titleText = createBatchedTextMember(
    'SECTOR SECURED — VICTORY',
    fontUrl,
    0.03,
    '#5ef2b6',
    0,
    -0.028,
    'center',
  );
  const starsText = createBatchedTextMember(
    '★ ★ ★',
    fontUrl,
    0.034,
    '#ffd166',
    0,
    -0.072,
    'center',
  );
  const newBestText = createBatchedTextMember('', fontUrl, 0.021, '#2de2ff', 0, -0.112, 'center');
  const statsLineText = createBatchedTextMember(
    'SCORE 0 · WAVES 0/12 · CORE 0/100',
    fontUrl,
    0.021,
    '#e6f4fb',
    0,
    -0.15,
    'center',
  );
  const bestLineText = createBatchedTextMember(
    'BEST SCORE 0 · BEST STARS 0★ · RUNS 0',
    fontUrl,
    0.018,
    '#8fb5c9',
    0,
    -0.184,
    'center',
  );

  const batchMembers = [titleText, starsText, newBestText, statsLineText, bestLineText];
  for (const member of batchMembers) {
    textBatch.addText(member);
  }
  textBatch.revision += 1;

  const totalHeight = headerHeight + 0.014 + panel.height;
  const backingGeo = new THREE.PlaneGeometry(width + padX * 2, totalHeight + padY * 2);
  const backingMat = new THREE.MeshBasicMaterial({
    color: 0x08131d,
    transparent: true,
    opacity: 0.94,
    depthWrite: false,
  });
  backingMat.forceSinglePass = true;
  const backing = new THREE.Mesh(backingGeo, backingMat);
  backing.name = 'mission-overlay-backing';
  backing.position.set(0, -totalHeight / 2, -0.004);

  xrRoot.add(backing, textBatch, panel.root);
  const stopKeepAbove = keepAbove(xrRoot, renderOrder);

  // --- Desktop DOM Mission Overlay (CSSOM styled) ---
  const container =
    options.container !== undefined
      ? options.container
      : typeof document !== 'undefined'
        ? document.body
        : null;

  let desktopElement: HTMLElement | null = null;
  let outcomeHeadingEl: HTMLHeadingElement | null = null;
  let newBestBadgeEl: HTMLSpanElement | null = null;
  let starsDisplayEl: HTMLDivElement | null = null;
  let scoreValueEl: HTMLSpanElement | null = null;
  let wavesValueEl: HTMLSpanElement | null = null;
  let coreHpValueEl: HTMLSpanElement | null = null;
  let bestScoreValueEl: HTMLSpanElement | null = null;
  let bestWaveValueEl: HTMLSpanElement | null = null;
  let bestStarsValueEl: HTMLSpanElement | null = null;
  let backupStatusEl: HTMLDivElement | null = null;
  let importFileInputEl: HTMLInputElement | null = null;

  async function handleExportClick(): Promise<string> {
    try {
      const json = await persistStore.exportBackupJson(true);
      state = {
        ...state,
        lastExportedJson: json,
        backupStatusMessage: 'Backup JSON exported successfully.',
        backupError: false,
      };
      syncUi();

      if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && container) {
        try {
          const blob = new Blob([json], { type: 'application/json' });
          if (typeof URL.createObjectURL === 'function') {
            const url = URL.createObjectURL(blob);
            const anchor = container.ownerDocument.createElement('a');
            anchor.href = url;
            anchor.download = 'rift-bastion-backup.json';
            anchor.click();
            URL.revokeObjectURL?.(url);
          }
        } catch {
          // Ignore download anchor errors in headless test environments.
        }
      }
      return json;
    } catch (error) {
      state = {
        ...state,
        backupStatusMessage: `Export failed: ${(error as Error).message}`,
        backupError: true,
      };
      syncUi();
      throw error;
    }
  }

  async function handleImportJsonString(rawJson: string): Promise<PersistBackupPayload> {
    try {
      const payload = await persistStore.importBackupJson(rawJson);
      if (settingsStore) {
        settingsStore.update(payload.settings);
      }
      state = {
        ...state,
        records: payload.missionRecords,
        backupStatusMessage: 'Backup JSON imported and verified.',
        backupError: false,
      };
      syncUi();
      options.onBackupImported?.(payload);
      return payload;
    } catch (error) {
      state = {
        ...state,
        backupStatusMessage: `Import rejected: ${(error as Error).message}`,
        backupError: true,
      };
      syncUi();
      throw error;
    }
  }

  if (container) {
    const doc = container.ownerDocument;
    const overlay = doc.createElement('section');
    overlay.dataset.missionOverlay = 'dom';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Mission Results');
    overlay.hidden = true;
    applyStyle(overlay, {
      position: 'fixed',
      inset: '0',
      zIndex: '8200',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
      background: 'rgba(5, 10, 16, 0.82)',
      backdropFilter: 'blur(8px)',
      color: '#e8f5fc',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    });

    const card = doc.createElement('div');
    card.dataset.mission = 'card';
    applyStyle(card, {
      width: 'min(480px, 100%)',
      padding: '26px 24px 22px',
      borderRadius: '14px',
      background: '#0b1622',
      border: '1px solid rgba(45, 226, 255, 0.45)',
      boxShadow: '0 24px 64px rgba(0, 0, 0, 0.65)',
      textAlign: 'center',
    });

    const headerRow = doc.createElement('div');
    applyStyle(headerRow, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '10px',
      flexWrap: 'wrap',
    });

    outcomeHeadingEl = doc.createElement('h2');
    outcomeHeadingEl.dataset.mission = 'outcome-title';
    applyStyle(outcomeHeadingEl, {
      margin: '0',
      fontSize: '22px',
      fontWeight: '700',
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
    });

    newBestBadgeEl = doc.createElement('span');
    newBestBadgeEl.dataset.mission = 'new-best';
    newBestBadgeEl.textContent = 'NEW BEST';
    newBestBadgeEl.hidden = true;
    applyStyle(newBestBadgeEl, {
      display: 'none',
      padding: '3px 9px',
      borderRadius: '999px',
      background: 'rgba(45, 226, 255, 0.18)',
      border: '1px solid #2de2ff',
      color: '#2de2ff',
      fontSize: '11px',
      fontWeight: '700',
      letterSpacing: '0.08em',
    });

    headerRow.append(outcomeHeadingEl, newBestBadgeEl);

    starsDisplayEl = doc.createElement('div');
    starsDisplayEl.dataset.mission = 'stars';
    applyStyle(starsDisplayEl, {
      margin: '12px 0 16px',
      fontSize: '28px',
      letterSpacing: '0.16em',
      color: '#ffd166',
    });

    const metricsGrid = doc.createElement('div');
    applyStyle(metricsGrid, {
      display: 'grid',
      gridTemplateColumns: 'repeat(3, 1fr)',
      gap: '10px',
      marginBottom: '14px',
    });

    const createMetricBox = (
      key: string,
      label: string,
    ): { box: HTMLDivElement; valueEl: HTMLSpanElement } => {
      const box = doc.createElement('div');
      applyStyle(box, {
        padding: '10px 8px',
        borderRadius: '8px',
        background: 'rgba(16, 30, 44, 0.9)',
        border: '1px solid rgba(72, 118, 146, 0.4)',
      });
      const caption = doc.createElement('div');
      caption.textContent = label;
      applyStyle(caption, {
        fontSize: '11px',
        color: '#8eb1c5',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        marginBottom: '4px',
      });
      const val = doc.createElement('span');
      val.dataset.mission = key;
      applyStyle(val, {
        fontSize: '18px',
        fontWeight: '700',
        fontVariantNumeric: 'tabular-nums',
      });
      box.append(caption, val);
      return { box, valueEl: val };
    };

    const scoreBox = createMetricBox('score', 'Score');
    const wavesBox = createMetricBox('waves-cleared', 'Waves Cleared');
    const coreBox = createMetricBox('core-hp', 'Core Integrity');
    scoreValueEl = scoreBox.valueEl;
    wavesValueEl = wavesBox.valueEl;
    coreHpValueEl = coreBox.valueEl;
    metricsGrid.append(scoreBox.box, wavesBox.box, coreBox.box);

    const bestSummaryRow = doc.createElement('div');
    bestSummaryRow.dataset.mission = 'best-records';
    applyStyle(bestSummaryRow, {
      display: 'flex',
      justifyContent: 'space-around',
      padding: '8px 12px',
      marginBottom: '16px',
      borderRadius: '8px',
      background: 'rgba(11, 20, 30, 0.85)',
      border: '1px solid rgba(53, 85, 108, 0.45)',
      fontSize: '12px',
      color: '#9fc0d4',
    });

    bestScoreValueEl = doc.createElement('span');
    bestScoreValueEl.dataset.mission = 'best-score';
    bestWaveValueEl = doc.createElement('span');
    bestWaveValueEl.dataset.mission = 'best-wave';
    bestStarsValueEl = doc.createElement('span');
    bestStarsValueEl.dataset.mission = 'best-stars';
    bestSummaryRow.append(bestScoreValueEl, bestWaveValueEl, bestStarsValueEl);

    const actionsRow = doc.createElement('div');
    applyStyle(actionsRow, {
      display: 'flex',
      gap: '10px',
      justifyContent: 'center',
      marginBottom: '14px',
    });

    const makeActionBtn = (
      actionKey: string,
      label: string,
      primary = false,
    ): HTMLButtonElement => {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.dataset.missionAction = actionKey;
      btn.textContent = label;
      applyStyle(btn, {
        flex: '1',
        padding: '10px 14px',
        borderRadius: '8px',
        border: primary ? '1px solid #2de2ff' : '1px solid #35556c',
        background: primary ? '#145870' : '#152736',
        color: '#f2f9fd',
        font: '600 13px/1.2 system-ui, -apple-system, sans-serif',
        letterSpacing: '0.04em',
        cursor: 'pointer',
      });
      return btn;
    };

    const replayBtn = makeActionBtn('replay', 'Replay Mission', true);
    replayBtn.addEventListener('click', () => handleReplay('desktop'));

    const settingsBtn = makeActionBtn('settings', 'Settings', false);
    settingsBtn.addEventListener('click', () => handleOpenSettings('desktop'));
    actionsRow.append(replayBtn, settingsBtn);

    const backupRow = doc.createElement('div');
    applyStyle(backupRow, {
      display: 'flex',
      gap: '10px',
      justifyContent: 'center',
      paddingTop: '12px',
      borderTop: '1px solid rgba(53, 85, 108, 0.35)',
    });

    const exportBtn = makeActionBtn('export-json', 'Export Backup JSON', false);
    exportBtn.addEventListener('click', () => {
      void handleExportClick().catch(() => undefined);
    });

    const importBtn = makeActionBtn('import-json', 'Import Backup JSON', false);
    importFileInputEl = doc.createElement('input');
    importFileInputEl.type = 'file';
    importFileInputEl.accept = 'application/json,.json';
    importFileInputEl.dataset.missionInput = 'import-file';
    importFileInputEl.hidden = true;
    applyStyle(importFileInputEl, { display: 'none' });

    importBtn.addEventListener('click', () => {
      importFileInputEl?.click();
    });
    importFileInputEl.addEventListener('change', () => {
      const file = importFileInputEl?.files?.[0];
      if (!file) return;
      void file
        .text()
        .then((raw) => handleImportJsonString(raw))
        .catch(() => undefined);
    });

    backupRow.append(exportBtn, importBtn, importFileInputEl);

    backupStatusEl = doc.createElement('div');
    backupStatusEl.dataset.mission = 'backup-status';
    backupStatusEl.hidden = true;
    applyStyle(backupStatusEl, {
      marginTop: '10px',
      fontSize: '12px',
      minHeight: '16px',
    });

    card.append(
      headerRow,
      starsDisplayEl,
      metricsGrid,
      bestSummaryRow,
      actionsRow,
      backupRow,
      backupStatusEl,
    );
    overlay.appendChild(card);
    container.appendChild(overlay);
    desktopElement = overlay;
  }

  function syncVisibility(): void {
    xrRoot.visible = state.open && mode === 'xr';
    if (desktopElement) {
      const showDom = state.open && mode === 'desktop';
      desktopElement.hidden = !showDom;
      desktopElement.setAttribute('aria-hidden', String(!showDom));
      applyStyle(desktopElement, { display: showDom ? 'flex' : 'none' });
    }
  }

  function syncUi(): void {
    if (disposed) return;

    const outcomeTitle = state.victory ? 'SECTOR SECURED — VICTORY' : 'BASTION LOST — DEFEAT';
    const outcomeColor = state.victory ? '#5ef2b6' : '#ff5c72';
    const starsVisual = formatStarsVisual(state.stars);
    const starsColor = state.stars > 0 ? '#ffd166' : '#6c8596';

    let batchDirty = false;
    const setMember = (member: Text, nextText: string, nextColor?: string): void => {
      if (member.text !== nextText) {
        member.text = nextText;
        batchDirty = true;
      }
      if (nextColor !== undefined && member.color !== nextColor) {
        member.color = nextColor;
        batchDirty = true;
      }
      if (batchDirty) {
        member.sync();
      }
    };

    setMember(titleText, outcomeTitle, outcomeColor);
    setMember(starsText, `${starsVisual} (${state.stars}/3)`, starsColor);
    setMember(newBestText, state.isNewBest ? '★ NEW BEST RECORD ★' : '');
    setMember(
      statsLineText,
      `SCORE ${state.score} · WAVES ${state.wavesCleared}/${state.totalWaves} · CORE ${Math.round(state.remainingCoreHp)}/${Math.round(state.maxCoreHp)}`,
    );
    setMember(
      bestLineText,
      `BEST ${state.records.bestScore} · WAVE ${state.records.highestWaveCleared}/${state.totalWaves} · ${state.records.bestStars}★`,
    );

    if (batchDirty) {
      textBatch.revision += 1;
    }

    if (outcomeHeadingEl) {
      outcomeHeadingEl.textContent = outcomeTitle;
      outcomeHeadingEl.style.color = outcomeColor;
    }
    if (newBestBadgeEl) {
      newBestBadgeEl.hidden = !state.isNewBest;
      applyStyle(newBestBadgeEl, { display: state.isNewBest ? 'inline-block' : 'none' });
    }
    if (starsDisplayEl) {
      starsDisplayEl.textContent = `${starsVisual} (${state.stars} / 3 Stars)`;
      starsDisplayEl.style.color = starsColor;
    }
    if (scoreValueEl) scoreValueEl.textContent = String(state.score);
    if (wavesValueEl) wavesValueEl.textContent = `${state.wavesCleared} / ${state.totalWaves}`;
    if (coreHpValueEl) {
      coreHpValueEl.textContent = `${Math.max(0, Math.round(state.remainingCoreHp))} / ${Math.max(1, Math.round(state.maxCoreHp))}`;
    }
    if (bestScoreValueEl) bestScoreValueEl.textContent = `Best Score: ${state.records.bestScore}`;
    if (bestWaveValueEl) {
      bestWaveValueEl.textContent = `Best Wave: ${state.records.highestWaveCleared}/${state.totalWaves}`;
    }
    if (bestStarsValueEl) {
      bestStarsValueEl.textContent = `Best Stars: ${state.records.bestStars}★`;
    }
    if (backupStatusEl) {
      const hasMsg = Boolean(state.backupStatusMessage);
      backupStatusEl.hidden = !hasMsg;
      backupStatusEl.textContent = state.backupStatusMessage ?? '';
      backupStatusEl.style.color = state.backupError ? '#ff6b6b' : '#5ef2b6';
    }

    syncVisibility();
  }

  function show(): void {
    if (disposed) return;
    state = { ...state, open: true };
    syncVisibility();
  }

  function hide(): void {
    if (disposed) return;
    state = { ...state, open: false };
    syncVisibility();
  }

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
      return state.open;
    },
    async presentResult(input) {
      if (disposed) return state;

      const totalWaves = input.totalWaves ?? TOTAL_WAVES;
      const maxCoreHp = input.maxCoreHp ?? CORE_MAX_HP;
      const score = Math.max(0, Math.round(input.score));
      const wavesCleared = Math.max(0, Math.min(totalWaves, Math.round(input.wavesCleared)));
      const remainingCoreHp = Math.max(0, Math.min(maxCoreHp, input.remainingCoreHp));

      const runKey =
        input.runKey ??
        `${input.victory ? 'V' : 'D'}:${score}:${wavesCleared}:${Math.round(remainingCoreHp)}:${input.seed ?? 0}`;

      if (lastRecordedRunKey === runKey && state.open) {
        return state;
      }
      lastRecordedRunKey = runKey;

      const prevRecords = await persistStore.loadMissionRecords();
      const stars = calculateStarRating({
        victory: input.victory,
        remainingCoreHp,
        maxCoreHp,
      });

      const isNewBestScore = score > prevRecords.bestScore && score > 0;
      const isNewBestStars = stars > prevRecords.bestStars;
      const isNewBestWave = wavesCleared > prevRecords.highestWaveCleared && wavesCleared > 0;
      const isNewBest = isNewBestScore || isNewBestStars || isNewBestWave;

      const updatedRecords = await persistStore.recordMissionRun({
        score,
        waveCleared: wavesCleared,
        victory: input.victory,
        remainingCoreHp,
        maxCoreHp,
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      });

      state = {
        ...state,
        open: true,
        victory: input.victory,
        score,
        wavesCleared,
        totalWaves,
        remainingCoreHp,
        maxCoreHp,
        stars,
        isNewBest,
        isNewBestScore,
        isNewBestStars,
        isNewBestWave,
        records: updatedRecords,
        backupStatusMessage: null,
        backupError: false,
      };

      syncUi();
      return state;
    },
    async presentFromSim(simState) {
      const victory = simState.victory || simState.phase === 'victory';
      return this.presentResult({
        victory,
        score: simState.score,
        wavesCleared: simState.wavesCleared,
        totalWaves: simState.totalWaves,
        remainingCoreHp: simState.coreHp,
        maxCoreHp: simState.maxCoreHp,
        seed: simState.seed,
        runKey: `sim:${simState.seed}:${simState.tick}:${victory ? 'V' : 'D'}`,
      });
    },
    async refreshRecords() {
      const records = await persistStore.loadMissionRecords();
      state = { ...state, records };
      syncUi();
      return records;
    },
    exportBackup: handleExportClick,
    importBackup: handleImportJsonString,
    show,
    hide,
    setMode(nextMode) {
      if (disposed || mode === nextMode) return;
      mode = nextMode;
      syncVisibility();
    },
    cellAt(object) {
      return disposed || !state.open ? null : panel.cellAt(object);
    },
    setHovered(id) {
      if (!disposed) panel.setHovered(id);
    },
    activate(id) {
      return disposed || !state.open ? false : panel.activate(id);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopKeepAbove();
      for (const member of batchMembers) {
        textBatch.removeText(member);
        member.dispose();
      }
      textBatch.dispose();
      panel.dispose();
      backingGeo.dispose();
      backingMat.dispose();
      xrRoot.clear();
      xrRoot.removeFromParent();
      desktopElement?.remove();
    },
  };
}
