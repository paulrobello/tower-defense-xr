/**
 * Desktop 1:1 Parity Input Controller (`ActionBus` bridge).
 *
 * Maps 100% of Calibration, Hybrid Surface/Hover Placement, and Radial/Quick-Build turret commands
 * onto the exact same shared `ActionBus` consumed by WebXR controllers (`PRD.md` D11):
 *
 * - **Mouse Ray:** Moves the live placement ghost or Core Anchor target; left-click moves the Core
 *   (`calibrate/move-core`) in `calibrate` phase, confirms turret placement/relocation (`turret/build`
 *   or `turret/relocate`) when placing, or selects an existing placed turret when idle.
 * - **Scroll Wheel:** Smoothly adjusts mid-air hover-pod depth within `0.8–5.0 m` (detaching into
 *   `hover-pod` mode automatically).
 * - **Right-Click / `H`:** Toggles between `surface-clamp` (auto-snap) and `hover-pod` (mid-air).
 * - **Hotkeys:**
 *   - `1–4`: Select turret (`1` Autocannon, `2` Plasma Mortar, `3` Cryo-Arc, `4` Rail Sniper)
 *   - `U`: Upgrade selected/hovered turret (`turret/upgrade`)
 *   - `T`: Cycle target priority (`First -> Strongest -> Closest -> Air`) (`turret/set-priority`)
 *   - `R`: Enter relocate mode for selected/hovered turret
 *   - `X`: Sell selected/hovered turret (`turret/sell`)
 *   - `P`: Toggle Play Arc (`front-180` / `full-360`) (`calibrate/set-play-arc`)
 *   - `Space`: Contextual primary action — Lock Core (`calibrate/confirm`) in `calibrate` phase, or
 *     Launch Wave (`wave/launch`) in `prep` / `intermission`
 *   - `Tab`: Toggle Settings (`menu/open-settings` / `menu/close-settings`)
 *   - `Escape`: Cancel active placement / close Settings / clear turret selection / `menu/back`
 */

import * as THREE from 'three';
import {
  getNextTurretTier,
  HOVER_POD_MAX_DEPTH_M,
  HOVER_POD_MIN_DEPTH_M,
  type TargetPriority,
  TURRET_KINDS,
  type TurretKind,
  type Vec3,
} from '../content/turrets.ts';
import type { ActionBus, PlayArc } from '../core/action-bus.ts';
import type { GamePhase, GameStateMachine } from '../core/state.ts';
import type { RoomSurfaceModel } from '../mr/room-scan.ts';
import { type CalibrationController, raycastCorePlacement } from '../xr/calibration.ts';
import type { TurretPlacementController } from '../xr/placement.ts';
import { nextTargetPriority, type TurretRadialActionId } from '../xr/radial-controls.ts';

/** Default hover-pod depth step per mouse wheel notch (meters). */
export const DEFAULT_WHEEL_DEPTH_STEP_M = 0.25;

/** Canonical desktop hotkey mapping from keys `1–4` to `TurretKind`. */
export const DESKTOP_TURRET_HOTKEYS: Readonly<Record<string, TurretKind>> = {
  '1': TURRET_KINDS[0],
  '2': TURRET_KINDS[1],
  '3': TURRET_KINDS[2],
  '4': TURRET_KINDS[3],
};

const DESKTOP_TURRET_COMMANDS: Readonly<Record<string, TurretRadialActionId>> = {
  u: 'turret:upgrade',
  t: 'turret:priority',
  r: 'turret:relocate',
  x: 'turret:sell',
};

export interface DesktopRay {
  readonly origin: Vec3;
  readonly direction: Vec3;
}

export interface DesktopControlsState {
  readonly enabled: boolean;
  readonly selectedTurretId: string | null;
  readonly hoveredTurretId: string | null;
  readonly settingsOpen: boolean;
  readonly lastRay: DesktopRay | null;
}

export interface DesktopControlsOptions {
  readonly actionBus: ActionBus;
  readonly camera: THREE.Camera;
  readonly domElement: HTMLElement;
  readonly eventTarget?: EventTarget;
  readonly gameState?: GameStateMachine;
  readonly getPhase?: () => GamePhase;
  readonly calibration?: CalibrationController;
  readonly placement?: TurretPlacementController;
  readonly roomModel?: RoomSurfaceModel;
  readonly isSettingsOpen?: () => boolean;
  readonly getPlayArc?: () => PlayArc;
  readonly wheelDepthStepM?: number;
  readonly enabled?: boolean;
  readonly onTurretSelected?: (turretId: string | null) => void;
  readonly onBuildKindSelected?: (kind: TurretKind) => void;
}

export interface DesktopControls {
  readonly state: Readonly<DesktopControlsState>;
  setEnabled(enabled: boolean): void;
  setSelectedTurret(turretId: string | null): void;
  setSettingsOpen(open: boolean): void;
  selectTurretKind(kind: TurretKind): void;
  issueTurretCommand(action: TurretRadialActionId): boolean;
  adjustHoverDepth(deltaM: number): number | null;
  toggleHoverSnap(): void;
  cancel(): void;
  dispose(): void;
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as Partial<HTMLElement>;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

function computeMouseRay(
  clientX: number,
  clientY: number,
  domElement: HTMLElement,
  camera: THREE.Camera,
  raycaster: THREE.Raycaster,
  ndc: THREE.Vector2,
): DesktopRay {
  const rect = domElement.getBoundingClientRect();
  const width = rect.width > 0 ? rect.width : 1;
  const height = rect.height > 0 ? rect.height : 1;
  ndc.x = ((clientX - rect.left) / width) * 2 - 1;
  ndc.y = -((clientY - rect.top) / height) * 2 + 1;
  camera.updateMatrixWorld(true);
  raycaster.setFromCamera(ndc, camera);
  const { origin, direction } = raycaster.ray;
  return {
    origin: { x: origin.x, y: origin.y, z: origin.z },
    direction: { x: direction.x, y: direction.y, z: direction.z },
  };
}

function intersectHorizontalPlane(ray: DesktopRay, planeY: number): Vec3 {
  if (Math.abs(ray.direction.y) > 1e-5) {
    const t = Math.max(0.6, Math.min(6.0, (planeY - ray.origin.y) / ray.direction.y));
    return {
      x: ray.origin.x + ray.direction.x * t,
      y: planeY,
      z: ray.origin.z + ray.direction.z * t,
    };
  }
  return {
    x: ray.origin.x + ray.direction.x * 1.45,
    y: planeY,
    z: ray.origin.z + ray.direction.z * 1.45,
  };
}

/**
 * Attaches mouse, wheel, and keyboard controls that route 100% of Calibration, Placement,
 * Turret Command, Wave, and Settings actions through the shared `ActionBus`.
 */
export function createDesktopControls(options: DesktopControlsOptions): DesktopControls {
  const { actionBus, camera, domElement, calibration, placement, roomModel } = options;
  const keyboardTarget: EventTarget =
    options.eventTarget ?? domElement.ownerDocument?.defaultView ?? globalThis;
  const wheelDepthStepM = options.wheelDepthStepM ?? DEFAULT_WHEEL_DEPTH_STEP_M;

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  let enabled = options.enabled ?? true;
  let selectedTurretId: string | null = null;
  let hoveredTurretId: string | null = null;
  let internalSettingsOpen = false;
  let lastRay: DesktopRay | null = null;
  let disposed = false;

  // Fallback priority memory when no external simulation updates placement records on ActionBus.
  const priorityOverrides = new Map<string, TargetPriority>();

  function resolvePhase(): GamePhase {
    if (options.getPhase) return options.getPhase();
    if (options.gameState) return options.gameState.phase;
    return 'prep';
  }

  function resolveSettingsOpen(): boolean {
    return options.isSettingsOpen ? options.isSettingsOpen() : internalSettingsOpen;
  }

  function resolveTargetTurretId(): string | null {
    if (selectedTurretId && (!placement || placement.getTurret(selectedTurretId))) {
      return selectedTurretId;
    }
    if (hoveredTurretId && (!placement || placement.getTurret(hoveredTurretId))) {
      return hoveredTurretId;
    }
    return selectedTurretId ?? hoveredTurretId;
  }

  function setSelectedTurretInternal(nextId: string | null): void {
    if (selectedTurretId === nextId) return;
    selectedTurretId = nextId;
    options.onTurretSelected?.(nextId);
  }

  function updateFromRay(ray: DesktopRay): void {
    lastRay = ray;
    const phase = resolvePhase();
    if (phase === 'prep' || phase === 'wave' || phase === 'intermission') {
      if (placement?.state.active) {
        placement.updateFromRay(ray.origin, ray.direction);
        hoveredTurretId = null;
      } else if (placement) {
        const hit = placement.pickPlacedTurret(ray.origin, ray.direction);
        hoveredTurretId = hit?.id ?? null;
      }
    }
  }

  function resolveCalibrationPoint(ray: DesktopRay): Vec3 {
    const surfaces = roomModel?.surfaces ?? [];
    if (calibration && surfaces.length > 0) {
      const candidate = raycastCorePlacement(
        ray.origin,
        ray.direction,
        surfaces,
        calibration.state.headsetPose,
        calibration.coreAnchor,
      );
      return candidate.position;
    }
    const surfaceHit = placement?.raycastSurface(ray.origin, ray.direction);
    if (
      surfaceHit &&
      (surfaceHit.surface.kind === 'floor' || surfaceHit.surface.kind === 'table')
    ) {
      return surfaceHit.point;
    }
    const fallbackY = calibration?.coreAnchor.position.y ?? 0.78;
    return intersectHorizontalPlane(ray, fallbackY);
  }

  function confirmPlacementViaBus(): void {
    if (!placement) return;
    const wasRelocatingId = placement.relocatingTurretId;
    let emitted = false;
    const unsubBuild = actionBus.on('turret/build', () => {
      emitted = true;
    });
    const unsubRelocate = actionBus.on('turret/relocate', () => {
      emitted = true;
    });
    try {
      const placed = placement.confirmPlacement('desktop');
      if (placed && !emitted) {
        if (wasRelocatingId) {
          actionBus.dispatch(
            {
              type: 'turret/relocate',
              turretId: wasRelocatingId,
              position: { ...placed.position },
              ...(placed.surfaceId ? { surfaceId: placed.surfaceId } : {}),
            },
            'desktop',
          );
        } else {
          actionBus.dispatch(
            {
              type: 'turret/build',
              kind: placed.kind,
              position: { ...placed.position },
              ...(placed.surfaceId ? { surfaceId: placed.surfaceId } : {}),
            },
            'desktop',
          );
        }
      }
    } finally {
      unsubBuild();
      unsubRelocate();
    }
  }

  function onPointerMove(event: Event): void {
    if (!enabled || disposed) return;
    const ptr = event as MouseEvent;
    const ray = computeMouseRay(ptr.clientX, ptr.clientY, domElement, camera, raycaster, ndc);
    updateFromRay(ray);
  }

  function onPointerDown(event: Event): void {
    if (!enabled || disposed) return;
    const ptr = event as MouseEvent;
    // Left button only (button 0); right-click is handled via contextmenu for hover/snap toggle.
    if (ptr.button !== 0) return;

    const ray = computeMouseRay(ptr.clientX, ptr.clientY, domElement, camera, raycaster, ndc);
    lastRay = ray;
    const phase = resolvePhase();

    if (phase === 'calibrate') {
      const position = resolveCalibrationPoint(ray);
      actionBus.dispatch({ type: 'calibrate/move-core', position }, 'desktop');
      return;
    }

    if (phase === 'prep' || phase === 'wave' || phase === 'intermission') {
      if (placement?.state.active) {
        placement.updateFromRay(ray.origin, ray.direction);
        confirmPlacementViaBus();
        return;
      }
      if (placement) {
        const hit = placement.pickPlacedTurret(ray.origin, ray.direction);
        hoveredTurretId = hit?.id ?? null;
        setSelectedTurretInternal(hit?.id ?? null);
      }
    }
  }

  function onContextMenu(event: Event): void {
    if (!enabled || disposed) return;
    const phase = resolvePhase();
    if (
      (phase === 'prep' || phase === 'wave' || phase === 'intermission') &&
      placement?.state.active
    ) {
      event.preventDefault();
      placement.toggleHoverMode();
    }
  }

  function onWheel(event: Event): void {
    if (!enabled || disposed) return;
    const wheel = event as WheelEvent;
    if (!placement?.state.active) return;

    wheel.preventDefault();
    const direction = wheel.deltaY < 0 ? 1 : wheel.deltaY > 0 ? -1 : 0;
    if (direction === 0) return;
    placement.adjustHoverDepth(direction * wheelDepthStepM);
  }

  function selectTurretKind(kind: TurretKind): void {
    setSelectedTurretInternal(null);
    placement?.beginBuild(kind);
    if (lastRay && placement) {
      placement.updateFromRay(lastRay.origin, lastRay.direction);
    }
    options.onBuildKindSelected?.(kind);
  }

  function cancel(): void {
    if (resolveSettingsOpen()) {
      internalSettingsOpen = false;
      actionBus.dispatch({ type: 'menu/close-settings' }, 'desktop');
      return;
    }
    if (placement?.state.active) {
      placement.cancelPlacement();
      setSelectedTurretInternal(null);
      return;
    }
    if (selectedTurretId !== null) {
      setSelectedTurretInternal(null);
      return;
    }
    actionBus.dispatch({ type: 'menu/back' }, 'desktop');
  }

  function onKeyDown(event: Event): void {
    if (!enabled || disposed) return;
    const keyEvent = event as KeyboardEvent;
    if (isEditableElement(keyEvent.target)) return;

    const key = keyEvent.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;

    // Tab toggles Settings
    if (key === 'Tab') {
      keyEvent.preventDefault();
      const currentlyOpen = resolveSettingsOpen();
      internalSettingsOpen = !currentlyOpen;
      actionBus.dispatch(
        { type: currentlyOpen ? 'menu/close-settings' : 'menu/open-settings' },
        'desktop',
      );
      return;
    }

    // Escape cancels placement / settings / selection / back
    if (key === 'Escape') {
      keyEvent.preventDefault();
      cancel();
      return;
    }

    // Space: Lock Core in calibrate phase, Launch Wave in prep / intermission
    if (key === ' ' || keyEvent.code === 'Space') {
      if (keyEvent.target instanceof Element && keyEvent.target.closest('button')) return;
      const phase = resolvePhase();
      if (phase === 'calibrate') {
        keyEvent.preventDefault();
        actionBus.dispatch({ type: 'calibrate/confirm' }, 'desktop');
      } else if (phase === 'prep' || phase === 'intermission') {
        keyEvent.preventDefault();
        actionBus.dispatch({ type: 'wave/launch' }, 'desktop');
      }
      return;
    }

    // 1-4: Quick-build turret selection
    const buildKind = DESKTOP_TURRET_HOTKEYS[key];
    if (buildKind) {
      keyEvent.preventDefault();
      selectTurretKind(buildKind);
      return;
    }

    // H: Toggle hover-pod / surface-clamp mode
    if (lower === 'h') {
      if (placement?.state.active) {
        keyEvent.preventDefault();
        placement.toggleHoverMode();
      }
      return;
    }

    // P: Toggle Play Arc (`front-180` / `full-360`) for full calibration parity
    if (lower === 'p') {
      keyEvent.preventDefault();
      const currentArc: PlayArc = options.getPlayArc?.() ?? calibration?.playArc ?? 'front-180';
      const nextArc: PlayArc = currentArc === 'front-180' ? 'full-360' : 'front-180';
      actionBus.dispatch({ type: 'calibrate/set-play-arc', arc: nextArc }, 'desktop');
      return;
    }

    const command = DESKTOP_TURRET_COMMANDS[lower];
    if (command && issueTurretCommand(command)) keyEvent.preventDefault();
  }

  function issueTurretCommand(action: TurretRadialActionId): boolean {
    if (!enabled || disposed || resolveSettingsOpen()) return false;
    const turretId = resolveTargetTurretId();
    if (!turretId) return false;
    const record = placement?.getTurret(turretId);
    switch (action) {
      case 'turret:upgrade':
        if (record && getNextTurretTier(record.tier) === null) return false;
        actionBus.dispatch({ type: 'turret/upgrade', turretId }, 'desktop');
        return true;
      case 'turret:priority': {
        const currentPrio: TargetPriority =
          priorityOverrides.get(turretId) ?? record?.priority ?? 'first';
        const nextPrio = nextTargetPriority(currentPrio);
        priorityOverrides.set(turretId, nextPrio);
        if (record) {
          record.priority = nextPrio;
        }
        actionBus.dispatch(
          { type: 'turret/set-priority', turretId, priority: nextPrio },
          'desktop',
        );
        return true;
      }
      case 'turret:relocate': {
        const began = placement ? placement.beginRelocate(turretId) : true;
        if (began && lastRay && placement) {
          placement.updateFromRay(lastRay.origin, lastRay.direction);
        }
        return began;
      }
      case 'turret:sell':
        priorityOverrides.delete(turretId);
        setSelectedTurretInternal(null);
        actionBus.dispatch({ type: 'turret/sell', turretId }, 'desktop');
        return true;
    }
  }

  // Keep internal settings state synced when settings actions arrive from elsewhere (HUD, XR, etc.)
  const unsubscribers: Array<() => void> = [
    actionBus.on('menu/open-settings', () => {
      internalSettingsOpen = true;
    }),
    actionBus.on('menu/close-settings', () => {
      internalSettingsOpen = false;
    }),
    actionBus.on('turret/sell', (action) => {
      priorityOverrides.delete(action.turretId);
      if (selectedTurretId === action.turretId) {
        setSelectedTurretInternal(null);
      }
    }),
  ];

  domElement.addEventListener('pointermove', onPointerMove);
  domElement.addEventListener('pointerdown', onPointerDown);
  domElement.addEventListener('contextmenu', onContextMenu);
  domElement.addEventListener('wheel', onWheel, { passive: false });
  keyboardTarget.addEventListener('keydown', onKeyDown);

  return {
    get state() {
      return {
        enabled,
        selectedTurretId,
        hoveredTurretId,
        settingsOpen: resolveSettingsOpen(),
        lastRay,
      };
    },
    setEnabled(nextEnabled) {
      enabled = nextEnabled;
    },
    setSelectedTurret(turretId) {
      setSelectedTurretInternal(turretId);
    },
    setSettingsOpen(open) {
      internalSettingsOpen = open;
    },
    selectTurretKind,
    issueTurretCommand,
    adjustHoverDepth(deltaM) {
      if (!placement) return null;
      return placement.adjustHoverDepth(deltaM);
    },
    toggleHoverSnap() {
      placement?.toggleHoverMode();
    },
    cancel,
    dispose() {
      if (disposed) return;
      disposed = true;
      domElement.removeEventListener('pointermove', onPointerMove);
      domElement.removeEventListener('pointerdown', onPointerDown);
      domElement.removeEventListener('contextmenu', onContextMenu);
      domElement.removeEventListener('wheel', onWheel);
      keyboardTarget.removeEventListener('keydown', onKeyDown);
      for (const unsub of unsubscribers.splice(0)) unsub();
      priorityOverrides.clear();
    },
  };
}

export { HOVER_POD_MAX_DEPTH_M, HOVER_POD_MIN_DEPTH_M };
