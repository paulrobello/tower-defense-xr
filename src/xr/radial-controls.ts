/**
 * Spatial XR Thumbstick Radial Build/Command Menu & Both-Stick Recenter Recovery Gesture.
 *
 * Follows `~/.claude/guides/webxr.md` (Controller Contract & Thumbstick Radial Menus) using
 * `@par/xr-workspace` public exports (`createRadialMenu`, `createStickRadialNavigation`,
 * `PlacementRays`, `createPointer`, `keepAbove`, `OVERLAY_RENDER_ORDER`):
 *
 * - **Opening & Dismissal:** Click either thumbstick (while no grip is held and not busy) to open
 *   the radial wheel in front of the current viewer pose. A second click of the opening thumbstick
 *   dismisses the wheel.
 * - **Dynamic Contexts:**
 *   - **Build Wheel** (aiming at open space/surface): `M44 Autocannon`, `Helios Plasma`,
 *     `Glacier Cryo-Arc`, `Valkyrie Rail` (with live Requisition credit affordability badges and
 *     disabled gating when credits are insufficient or the `14/14` hard turret cap is reached),
 *     `Launch Wave`, and center `Cancel`.
 *   - **Turret Command Wheel** (aiming at an existing placed turret): `Upgrade (T1->T2 / T2->T3)`
 *     (disabled at `T3` or insufficient credits), `Priority (First/Strongest/Closest/Air)`,
 *     `Relocate`, `Sell (50%)`, and center `Close`.
 * - **Selection Precedence (`webxr.md`):** Both controller lasers remain active while open. Either
 *   trigger can select the wedge its laser points at; deliberate thumbstick tilt on the opening
 *   controller takes priority over the opening controller's laser; neutral stick + no ray target on
 *   the opener confirms `Cancel`/`Close`. Targets are captured per input source on `selectstart`
 *   and dispatched once on `select` for the active opening generation, consuming stale releases.
 * - **Strict Grip Suppression (`webxr.md`):** Grip (`buttons[1]`) is manipulation and strictly
 *   suppresses radial opening, trigger selection, world placement, and recenter holds, cancelling
 *   any in-flight trigger presses immediately so releasing grip never fires a pending action.
 * - **Both-Stick 1.0 s Recovery Gesture (`webxr.md`):** Holding both thumbstick clicks for `1.0 s`
 *   with neither grip held dispatches `{ type: 'view/recenter' }` on the shared `ActionBus`.
 */

import {
  createPointer,
  createRadialMenu,
  createStickRadialNavigation,
  keepAbove,
  OVERLAY_RENDER_ORDER,
  PlacementRays,
  type PlacementRayTarget,
  type Pointer,
  type RadialMenu,
  type RadialMenuItem,
  type RadialMenuTheme,
  type StickRadialNavigation,
} from '@par/xr-workspace';
import * as THREE from 'three';
import {
  getNextTurretTier,
  getTurretBuildCost,
  getTurretDefinition,
  getTurretSellRefund,
  getTurretUpgradeCost,
  HARD_TURRET_CAP,
  TARGET_PRIORITIES,
  type TargetPriority,
  TURRET_KINDS,
  TURRET_RELOCATE_COST,
  type TurretKind,
  type TurretTierId,
  type Vec3,
} from '../content/turrets.ts';
import type { ActionBus } from '../core/action-bus.ts';
import type { GamePhase } from '../core/state.ts';
import { configureFonts } from '../ui/fonts.ts';
import { createTacticalAtlas, type TacticalAtlasResource } from '../ui/tactical-atlas.ts';
import type { PlacedTurretRecord, TurretPlacementController } from './placement.ts';
import { BASTION_RADIAL_THEME, skinRadialMenu } from './radial-skin.ts';

/** Required continuous hold time for the both-thumbstick-click recovery gesture (seconds). */
export const BOTH_STICK_RECENTER_HOLD_SEC = 1.0;

/** Default scale and viewer-relative spawn offset matching `@par/xr-workspace`'s `createXrRadialMenu`. */
export const RADIAL_MENU_SCALE = 0.63;
export const RADIAL_MENU_OFFSET_Y = -0.035;
export const RADIAL_MENU_OFFSET_Z = -0.56;
export const DEFAULT_RADIAL_STICK_DEADZONE = 0.35;

export type RadialContextMode = 'build' | 'turret';

export type BuildRadialActionId =
  | 'build:autocannon'
  | 'build:plasma-mortar'
  | 'build:cryo-arc'
  | 'build:rail-sniper'
  | 'wave:launch';

export type TurretRadialActionId =
  | 'turret:upgrade'
  | 'turret:priority'
  | 'turret:relocate'
  | 'turret:sell';

export type RadialActionId = BuildRadialActionId | TurretRadialActionId;
export type RadialChoiceId = RadialActionId | 'cancel';

export interface RadialItemDescriptor<Action extends RadialActionId = RadialActionId>
  extends RadialMenuItem<Action> {
  readonly icon: string;
  readonly disabled: boolean;
  readonly disabledReason?: string;
}

export interface RadialTurretTarget {
  readonly id: string;
  readonly kind: TurretKind;
  readonly tier: TurretTierId;
  readonly priority: TargetPriority;
}

export interface RadialBuildStateSnapshot {
  readonly credits: number;
  readonly activeTurretCount: number;
  readonly hardTurretCap?: number;
  readonly canLaunchWave?: boolean;
  readonly phase?: GamePhase;
}

interface XrPanelTarget {
  readonly root: THREE.Object3D;
  cellAt(object: THREE.Object3D): string | null;
  setHovered?(id: string | null): void;
  activate(id: string): boolean;
}

interface PanelHit {
  readonly panel: XrPanelTarget;
  readonly cell: string;
}

export interface XrRadialControlsOptions {
  readonly scene: THREE.Scene;
  readonly overlayRoot?: THREE.Group;
  readonly actionBus: ActionBus;
  readonly placement?: TurretPlacementController;
  readonly getBuildState?: () => RadialBuildStateSnapshot;
  readonly getAimedTurret?: (
    rayOrigin: Readonly<Vec3>,
    rayDirection: Readonly<Vec3>,
  ) => RadialTurretTarget | null;
  readonly isBusy?: () => boolean;
  readonly getPanels?: () => readonly XrPanelTarget[];
  readonly getMovableWidgets?: () => readonly THREE.Object3D[];
  readonly recenterHoldSec?: number;
  readonly stickDeadZone?: number;
  readonly renderOrder?: number;
  readonly theme?: Partial<RadialMenuTheme>;
  readonly atlas?: TacticalAtlasResource;
  readonly onSelectBuildKind?: (kind: TurretKind) => void;
  readonly onBeginRelocate?: (turretId: string) => void;
  readonly onActionDispatched?: (action: RadialActionId, targetTurretId: string | null) => void;
  readonly onRecenter?: () => void;
}

export interface XrRadialControls {
  readonly root: THREE.Group;
  readonly isModal: boolean;
  readonly isOpen: boolean;
  readonly interactive: boolean;
  readonly context: RadialContextMode | null;
  readonly targetTurretId: string | null;
  readonly items: readonly RadialItemDescriptor[];
  readonly hoveredAction: RadialChoiceId | null;
  readonly isGripHeld: boolean;
  readonly recenterProgress: number;
  readonly owner: XRInputSource | null;
  /** Returns `true` if world/placement trigger activation must be suppressed right now. */
  shouldSuppressWorldTrigger(source?: XRInputSource): boolean;
  update(frame: XRFrame, referenceSpace: XRReferenceSpace, timeMs: number, busy?: boolean): void;
  /** Returns `true` if the radial system or grip suppression consumed the event. */
  handleSelectStart(source: XRInputSource): boolean;
  /** Returns `true` if the radial system or grip suppression consumed the event. */
  handleSelect(source: XRInputSource): boolean;
  /** Cancels any pending trigger press for `source` without dispatching. */
  handleSelectEnd(source: XRInputSource): boolean;
  /** Attaches `selectstart`/`select`/`selectend` listeners directly to an `XRSession`. */
  attachSession(
    session: XRSession,
    captureWorldSelect?: (
      event: XRInputSourceEvent,
    ) => ((selection: XRInputSourceEvent) => void) | null,
  ): () => void;
  close(): void;
  reset(): void;
  dispose(): void;
}

const DISABLED_WEDGE_COLOR = 0x161d24;
const DISABLED_WEDGE_OPACITY = 0.42;

const RADIAL_TURRET_LABELS: Readonly<Record<TurretKind, string>> = {
  autocannon: 'M44 Autocannon',
  'plasma-mortar': 'Helios Plasma',
  'cryo-arc': 'Glacier Cryo-Arc',
  'rail-sniper': 'Valkyrie Rail',
};

const RADIAL_TURRET_ICONS: Readonly<Record<TurretKind, string>> = {
  autocannon: 'build-autocannon',
  'plasma-mortar': 'build-plasma-mortar',
  'cryo-arc': 'build-cryo-arc',
  'rail-sniper': 'build-rail-sniper',
};

const TARGET_PRIORITY_LABELS: Readonly<Record<TargetPriority, string>> = {
  first: 'First',
  strongest: 'Strongest',
  closest: 'Closest',
  air: 'Air',
};

/** Returns the next `TargetPriority` in the standard cycle (`First -> Strongest -> Closest -> Air`). */
export function nextTargetPriority(current: TargetPriority): TargetPriority {
  const idx = TARGET_PRIORITIES.indexOf(current);
  const nextIdx = idx < 0 ? 0 : (idx + 1) % TARGET_PRIORITIES.length;
  return TARGET_PRIORITIES[nextIdx] as TargetPriority;
}

/** Formats a `TargetPriority` enum into a concise tactical UI label. */
export function formatTargetPriorityLabel(priority: TargetPriority): string {
  return TARGET_PRIORITY_LABELS[priority];
}

/** Extracts the `TurretKind` from a Build Wheel action id, or `null` for non-build actions. */
export function turretKindFromRadialAction(action: RadialActionId): TurretKind | null {
  switch (action) {
    case 'build:autocannon':
      return 'autocannon';
    case 'build:plasma-mortar':
      return 'plasma-mortar';
    case 'build:cryo-arc':
      return 'cryo-arc';
    case 'build:rail-sniper':
      return 'rail-sniper';
    default:
      return null;
  }
}

/**
 * Builds the live Build Wheel wedge descriptors (`M44 Autocannon`, `Helios Plasma`,
 * `Glacier Cryo-Arc`, `Valkyrie Rail`, `Launch Wave`), reflecting live credit affordability
 * and the `14/14` hard turret cap. Center disc is always `Cancel`.
 */
export function buildBuildWheelItems(
  snapshot: RadialBuildStateSnapshot,
): RadialItemDescriptor<BuildRadialActionId>[] {
  const cap = snapshot.hardTurretCap ?? HARD_TURRET_CAP;
  const capReached = snapshot.activeTurretCount >= cap;
  const credits = Math.max(0, Math.floor(snapshot.credits));

  const turretItems: RadialItemDescriptor<BuildRadialActionId>[] = TURRET_KINDS.map((kind) => {
    const cost = getTurretBuildCost(kind);
    const affordable = credits >= cost;
    const disabled = capReached || !affordable;
    const disabledReason = capReached
      ? `CAP ${cap}/${cap}`
      : !affordable
        ? 'NO CREDITS'
        : undefined;
    const badge = capReached ? `CAP ${cap}/${cap}` : affordable ? `${cost} CR` : `${cost} CR (LOW)`;
    const actionId = `build:${kind}` as BuildRadialActionId;

    return {
      id: actionId,
      icon: RADIAL_TURRET_ICONS[kind],
      label: `${RADIAL_TURRET_LABELS[kind]}\n${badge}`,
      disabled,
      ...(disabledReason ? { disabledReason } : {}),
    };
  });

  const canLaunch =
    snapshot.canLaunchWave ??
    (snapshot.phase === undefined ||
      snapshot.phase === 'prep' ||
      snapshot.phase === 'intermission');

  turretItems.push({
    id: 'wave:launch',
    icon: 'wave-launch',
    label: canLaunch ? 'Launch Wave' : 'Wave Active',
    disabled: !canLaunch,
    ...(canLaunch ? {} : { disabledReason: 'WAVE ACTIVE' }),
  });

  return turretItems;
}

/**
 * Builds the live Turret Command Wheel wedge descriptors (`Upgrade`, `Priority`, `Relocate`,
 * `Sell (50%)`) for an existing placed turret. Center disc is `Close`.
 */
export function buildTurretCommandWheelItems(
  target: RadialTurretTarget,
  credits: number,
): RadialItemDescriptor<TurretRadialActionId>[] {
  const available = Math.max(0, Math.floor(credits));
  const nextTier = getNextTurretTier(target.tier);
  const upgradeCost = getTurretUpgradeCost(target.kind, target.tier);
  const upgradeDisabled = nextTier === null || upgradeCost === null || available < upgradeCost;
  const upgradeDisabledReason =
    nextTier === null || upgradeCost === null
      ? 'MAX TIER'
      : available < upgradeCost
        ? 'NO CREDITS'
        : undefined;
  const upgradeLabel =
    nextTier === null || upgradeCost === null
      ? 'Upgrade\nMAX (T3)'
      : available >= upgradeCost
        ? `Upgrade ${target.tier}->${nextTier}\n${upgradeCost} CR`
        : `Upgrade ${target.tier}->${nextTier}\n${upgradeCost} CR (LOW)`;

  const nextPrio = nextTargetPriority(target.priority);
  const relocateAffordable = available >= TURRET_RELOCATE_COST;
  const sellRefund = getTurretSellRefund(target.kind, target.tier);
  const upgradeIcon = nextTier === 'T2' ? 'tier-2' : 'tier-3';

  return [
    {
      id: 'turret:upgrade',
      icon: upgradeIcon,
      label: upgradeLabel,
      disabled: upgradeDisabled,
      ...(upgradeDisabledReason ? { disabledReason: upgradeDisabledReason } : {}),
    },
    {
      id: 'turret:priority',
      icon: `target-${target.priority}`,
      label: `Priority: ${formatTargetPriorityLabel(target.priority)}\nNext: ${formatTargetPriorityLabel(nextPrio)}`,
      disabled: false,
    },
    {
      id: 'turret:relocate',
      icon: 'relocate',
      label: relocateAffordable
        ? `Relocate\n${TURRET_RELOCATE_COST} CR`
        : `Relocate\n${TURRET_RELOCATE_COST} CR (LOW)`,
      disabled: !relocateAffordable,
      ...(relocateAffordable ? {} : { disabledReason: 'NO CREDITS' }),
    },
    {
      id: 'turret:sell',
      icon: 'sell',
      label: `Sell (50%)\n+${sellRefund} CR`,
      disabled: false,
    },
  ];
}

function readStickAxes(pad: Gamepad): { x: number; y: number } {
  const offset = pad.axes.length >= 4 ? 2 : 0;
  return {
    x: pad.axes[offset] ?? 0,
    y: pad.axes[offset + 1] ?? 0,
  };
}

function isControllerGripPressed(source: XRInputSource): boolean {
  return Boolean(source.gamepad?.buttons[1]?.pressed);
}

function isControllerStickClicked(source: XRInputSource): boolean {
  return Boolean(source.gamepad?.buttons[3]?.pressed);
}

function toTurretTarget(record: PlacedTurretRecord | null | undefined): RadialTurretTarget | null {
  if (!record) return null;
  return {
    id: record.id,
    kind: record.kind,
    tier: record.tier,
    priority: record.priority,
  };
}

function applyDisabledWedgeStyling(
  menuRoot: THREE.Group,
  items: readonly RadialItemDescriptor[],
): void {
  const disabledSet = new Set<string>(items.filter((item) => item.disabled).map((item) => item.id));
  if (disabledSet.size === 0) return;

  menuRoot.traverse((node) => {
    const action = node.userData.radialAction as string | undefined;
    if (!action || !disabledSet.has(action)) return;
    if ((node as THREE.Mesh).isMesh) {
      const mat = (node as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
      if (mat && 'color' in mat && typeof mat.opacity === 'number') {
        mat.color.setHex(DISABLED_WEDGE_COLOR);
        mat.opacity = DISABLED_WEDGE_OPACITY;
      }
    }
    const textObj = node.userData.labelTextObject as
      | { color: string | number; sync?: () => void }
      | undefined;
    if (textObj) {
      textObj.color = '#6f8291';
      textObj.sync?.();
    }
  });
}

/**
 * Creates the XR radial build/command menu controller and both-stick 1.0 s recenter recovery driver.
 */
export function createXrRadialControls(options: XrRadialControlsOptions): XrRadialControls {
  configureFonts();

  const { scene, actionBus, placement } = options;
  const recenterHoldSec = options.recenterHoldSec ?? BOTH_STICK_RECENTER_HOLD_SEC;
  const stickDeadZone = options.stickDeadZone ?? DEFAULT_RADIAL_STICK_DEADZONE;
  const renderOrder = options.renderOrder ?? OVERLAY_RENDER_ORDER;
  const theme: Partial<RadialMenuTheme> = { ...BASTION_RADIAL_THEME, ...options.theme };
  const atlas = options.atlas ?? createTacticalAtlas();
  let skin: ReturnType<typeof skinRadialMenu> | undefined;

  const root = new THREE.Group();
  root.name = 'rift-bastion-xr-radial-host';
  root.scale.setScalar(RADIAL_MENU_SCALE);
  (options.overlayRoot ?? scene).add(root);
  const stopKeepAbove = keepAbove(root, renderOrder);

  const controllerRays = new PlacementRays(scene);
  options.overlayRoot?.add(controllerRays.group);
  controllerRays.group.name = 'rift-bastion-radial-rays';
  const stopKeepRaysAbove = keepAbove(controllerRays.group, renderOrder + 1);
  const pointer: Pointer = createPointer({ far: 8 });
  const aimObject = new THREE.Object3D();

  let menu: RadialMenu<RadialActionId> | null = null;
  let nav: StickRadialNavigation<RadialActionId, XRInputSource> | null = null;
  let owner: XRInputSource | null = null;
  let context: RadialContextMode | null = null;
  let targetTurret: RadialTurretTarget | null = null;
  let activeItems: RadialItemDescriptor[] = [];
  let disabledActions = new Set<RadialActionId>();
  let hoveredAction: RadialChoiceId | null = null;
  let selectingSource: XRInputSource | null = null;
  let generation = 0;
  let previousTimeMs: number | undefined;
  let anyGripHeld = false;
  let bothStickHoldSec = 0;
  let recenterFiredForHold = false;
  let disposed = false;

  const stickPressedBySource = new Map<XRInputSource, boolean>();
  const gripPressedSources = new Set<XRInputSource>();
  let widgetGrab: { source: XRInputSource; root: THREE.Object3D } | null = null;
  const widgetFromGrip = new THREE.Matrix4();
  const gripMatrix = new THREE.Matrix4();
  const widgetMatrix = new THREE.Matrix4();
  const inverseParentMatrix = new THREE.Matrix4();
  const rayActions = new Map<XRInputSource, RadialChoiceId>();
  const rayCells = new Map<XRInputSource, PanelHit>();
  const panelRayHits = new Set<XRInputSource>();
  const panelPresses = new Map<XRInputSource, PanelHit>();
  const worldPresses = new Map<XRInputSource, (selection: XRInputSourceEvent) => void>();
  let pointedPanels: readonly XrPanelTarget[] = [];
  let panelModal = false;
  const triggerStart = new Map<
    XRInputSource,
    { generation: number; action: RadialChoiceId | null }
  >();
  // Tracks sources whose trigger was held or pressed while grip was down so release stays suppressed.
  const gripSuppressedTriggers = new Set<XRInputSource>();

  function updateWidgetGrab(
    started: XRInputSource | null,
    frame: XRFrame,
    referenceSpace: XRReferenceSpace,
  ): void {
    if (menu?.root.visible) return;
    if (widgetGrab && (!gripPressedSources.has(widgetGrab.source) || !widgetGrab.root.visible))
      widgetGrab = null;

    const source = widgetGrab?.source ?? started;
    if (!source) return;
    const grip = frame.getPose(source.gripSpace ?? source.targetRaySpace, referenceSpace);
    if (!grip) {
      widgetGrab = null;
      return;
    }
    gripMatrix.fromArray(grip.transform.matrix);

    if (!widgetGrab) {
      const aim = frame.getPose(source.targetRaySpace, referenceSpace);
      if (!aim) return;
      const widgets = options.getMovableWidgets?.().filter((widget) => widget.visible) ?? [];
      for (const widget of widgets) widget.updateWorldMatrix(true, true);
      const { position, orientation } = aim.transform;
      aimObject.position.set(position.x, position.y, position.z);
      aimObject.quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w);
      const hit = pointer.castFrom(aimObject, widgets);
      if (!hit) return;
      widgetGrab = { source, root: hit.root };
      widgetFromGrip.copy(gripMatrix).invert().multiply(hit.root.matrixWorld);
    }

    const widget = widgetGrab.root;
    widgetMatrix.multiplyMatrices(gripMatrix, widgetFromGrip);
    if (widget.parent) {
      widget.parent.updateWorldMatrix(true, false);
      widgetMatrix.premultiply(inverseParentMatrix.copy(widget.parent.matrixWorld).invert());
    }
    widgetMatrix.decompose(widget.position, widget.quaternion, widget.scale);
    widget.updateWorldMatrix(false, true);
  }

  function updatePanelRays(
    sources: readonly XRInputSource[],
    frame: XRFrame,
    referenceSpace: XRReferenceSpace,
  ): void {
    const panels = menu?.root.visible ? [] : (options.getPanels?.() ?? []);
    const targets = panels.filter((panel) => panel.root.visible);
    for (const panel of pointedPanels) {
      if (!targets.includes(panel)) panel.setHovered?.(null);
    }
    pointedPanels = targets;
    const roots = targets.map(({ root }) => {
      root.updateWorldMatrix(true, true);
      return root;
    });
    const beams: PlacementRayTarget[] = [];
    for (const source of sources) {
      if (source.hand || !source.gamepad) continue;
      const pose = frame.getPose(source.targetRaySpace, referenceSpace);
      if (!pose) continue;

      const { position, orientation } = pose.transform;
      aimObject.position.set(position.x, position.y, position.z);
      aimObject.quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w);
      const hit = roots.length ? pointer.castFrom(aimObject, roots) : null;
      if (hit) panelRayHits.add(source);
      const panel = hit && targets.find((target) => target.root === hit.root);
      const cell = hit && panel?.cellAt(hit.object);
      if (panel && cell) rayCells.set(source, { panel, cell });
      if (
        hit ||
        !placement?.active ||
        panelModal ||
        anyGripHeld ||
        options.isBusy?.() ||
        menu?.root.visible
      ) {
        beams.push({
          source,
          origin: aimObject.position.clone(),
          direction: new THREE.Vector3(0, 0, -1).applyQuaternion(aimObject.quaternion),
          distance: hit?.distance ?? 0.85,
          contact: Boolean(hit),
          valid: true,
        });
      }
    }
    for (const panel of targets) {
      let hoveredCell: string | null = null;
      for (const hit of rayCells.values()) {
        if (hit.panel !== panel) continue;
        hoveredCell = hit.cell;
        break;
      }
      panel.setHovered?.(hoveredCell);
    }
    controllerRays.update(beams);
  }

  function resolveBuildState(): RadialBuildStateSnapshot {
    if (options.getBuildState) {
      return options.getBuildState();
    }
    return {
      credits: placement?.credits ?? 0,
      activeTurretCount: placement?.turretCount ?? 0,
      hardTurretCap: HARD_TURRET_CAP,
      canLaunchWave: true,
    };
  }

  function resolveAimedTurret(
    source: XRInputSource,
    frame: XRFrame,
    referenceSpace: XRReferenceSpace,
  ): RadialTurretTarget | null {
    const pose = source.targetRaySpace
      ? frame.getPose(source.targetRaySpace, referenceSpace)
      : null;
    if (!pose) return null;

    const origin: Vec3 = {
      x: pose.transform.position.x,
      y: pose.transform.position.y,
      z: pose.transform.position.z,
    };
    const quat = new THREE.Quaternion(
      pose.transform.orientation.x,
      pose.transform.orientation.y,
      pose.transform.orientation.z,
      pose.transform.orientation.w,
    );
    const dirVec = new THREE.Vector3(0, 0, -1).applyQuaternion(quat).normalize();
    const direction: Vec3 = { x: dirVec.x, y: dirVec.y, z: dirVec.z };

    if (options.getAimedTurret) {
      return options.getAimedTurret(origin, direction);
    }
    return toTurretTarget(placement?.pickPlacedTurret(origin, direction));
  }

  function invalidatePendingTriggers(): void {
    for (const [src, press] of triggerStart.entries()) {
      press.generation = -1;
      press.action = null;
      gripSuppressedTriggers.add(src);
    }
    selectingSource = null;
  }

  function closeMenu(): void {
    menu?.close();
    nav?.reset();
    owner = null;
    hoveredAction = null;
    selectingSource = null;
    rayActions.clear();
    controllerRays.clear();
  }

  function discardMenu(): void {
    closeMenu();
    if (menu) {
      skin?.dispose();
      skin = undefined;
      menu.root.removeFromParent();
      menu.dispose();
      menu = null;
    }
    nav = null;
    context = null;
    targetTurret = null;
    activeItems = [];
    disabledActions.clear();
  }

  function openMenuForSource(
    source: XRInputSource,
    nextContext: RadialContextMode,
    items: RadialItemDescriptor[],
    turret: RadialTurretTarget | null,
    viewerTransform: XRRigidTransform,
  ): void {
    discardMenu();
    context = nextContext;
    targetTurret = turret;
    activeItems = items;
    disabledActions = new Set(items.filter((item) => item.disabled).map((item) => item.id));

    menu = createRadialMenu<RadialActionId>({
      items: items.map((item) => ({ id: item.id, label: item.label.split('\n')[0] ?? item.label })),
      theme,
      centerLabel: nextContext === 'turret' ? 'Close' : 'Cancel',
    });
    skin = skinRadialMenu(menu.root, items, atlas);
    root.add(menu.root);

    nav = createStickRadialNavigation<RadialActionId, XRInputSource>({
      menu,
      items: items.map((item) => item.id),
      deadZone: stickDeadZone,
      isBusy: () => anyGripHeld || Boolean(options.isBusy?.()),
      onOpen: (openingSource) => {
        owner = openingSource;
        generation += 1;
        for (const press of triggerStart.values()) {
          press.generation = -1;
        }
        menu?.open();
        if (menu) {
          applyDisabledWedgeStyling(menu.root, activeItems);
          skin?.applyDisabled();
        }
      },
      onClose: () => {
        closeMenu();
      },
    });

    root.quaternion.set(
      viewerTransform.orientation.x,
      viewerTransform.orientation.y,
      viewerTransform.orientation.z,
      viewerTransform.orientation.w,
    );
    root.position
      .set(0, RADIAL_MENU_OFFSET_Y, RADIAL_MENU_OFFSET_Z)
      .applyQuaternion(root.quaternion)
      .add(
        new THREE.Vector3(
          viewerTransform.position.x,
          viewerTransform.position.y,
          viewerTransform.position.z,
        ),
      );
    root.updateMatrixWorld(true);

    // Prime the rising-edge latch inside StickRadialNavigation so the opening click opens cleanly
    // and the stick must be released before a second click dismisses.
    nav.update(source, { pressed: false, x: 0, y: 0 });
    nav.update(source, { pressed: true, x: 0, y: 0 });
  }

  function executeAction(action: RadialActionId): void {
    if (disabledActions.has(action)) return;

    const turretKind = turretKindFromRadialAction(action);
    if (turretKind) {
      placement?.beginBuild(turretKind);
      options.onSelectBuildKind?.(turretKind);
      options.onActionDispatched?.(action, null);
      return;
    }

    if (action === 'wave:launch') {
      actionBus.dispatch({ type: 'wave/launch' }, 'xr');
      options.onActionDispatched?.(action, null);
      return;
    }

    const target = targetTurret;
    if (!target) return;

    switch (action) {
      case 'turret:upgrade':
        actionBus.dispatch({ type: 'turret/upgrade', turretId: target.id }, 'xr');
        options.onActionDispatched?.(action, target.id);
        return;
      case 'turret:priority': {
        const nextPrio = nextTargetPriority(target.priority);
        actionBus.dispatch(
          { type: 'turret/set-priority', turretId: target.id, priority: nextPrio },
          'xr',
        );
        options.onActionDispatched?.(action, target.id);
        return;
      }
      case 'turret:relocate':
        placement?.beginRelocate(target.id);
        options.onBeginRelocate?.(target.id);
        options.onActionDispatched?.(action, target.id);
        return;
      case 'turret:sell':
        actionBus.dispatch({ type: 'turret/sell', turretId: target.id }, 'xr');
        options.onActionDispatched?.(action, target.id);
        return;
    }
  }

  function clearPanelHover(): void {
    for (const panel of pointedPanels) panel.setHovered?.(null);
    pointedPanels = [];
  }

  function reset(): void {
    discardMenu();
    stickPressedBySource.clear();
    gripPressedSources.clear();
    widgetGrab = null;
    triggerStart.clear();
    gripSuppressedTriggers.clear();
    panelPresses.clear();
    worldPresses.clear();
    rayCells.clear();
    panelRayHits.clear();
    clearPanelHover();
    panelModal = false;
    anyGripHeld = false;
    bothStickHoldSec = 0;
    recenterFiredForHold = false;
    previousTimeMs = undefined;
  }

  const controls: XrRadialControls = {
    root,
    get isModal() {
      return menu?.root.visible === true;
    },
    get isOpen() {
      return menu?.isOpen === true;
    },
    get interactive() {
      return menu?.interactive === true;
    },
    get context() {
      return menu?.root.visible ? context : null;
    },
    get targetTurretId() {
      return menu?.root.visible ? (targetTurret?.id ?? null) : null;
    },
    get items() {
      return activeItems;
    },
    get hoveredAction() {
      return hoveredAction;
    },
    get isGripHeld() {
      return anyGripHeld;
    },
    get recenterProgress() {
      return recenterHoldSec > 0 ? Math.min(1, bothStickHoldSec / recenterHoldSec) : 0;
    },
    get owner() {
      return owner;
    },
    shouldSuppressWorldTrigger(source) {
      if (anyGripHeld || panelModal) return true;
      if (source && isControllerGripPressed(source)) return true;
      if (
        source &&
        (gripSuppressedTriggers.has(source) || panelRayHits.has(source) || panelPresses.has(source))
      )
        return true;
      if (menu?.root.visible) return true;
      return false;
    },
    update(frame, referenceSpace, timeMs, busy = false) {
      if (disposed) return;

      const dtSec =
        previousTimeMs === undefined
          ? 0
          : THREE.MathUtils.clamp((timeMs - previousTimeMs) / 1000, 0, 0.1);
      previousTimeMs = timeMs;

      menu?.update(dtSec);
      panelModal = busy;
      rayCells.clear();
      panelRayHits.clear();

      const inputSources = [...(frame.session?.inputSources ?? [])];
      const activeSet = new Set<XRInputSource>(inputSources);

      let gripHeld = false;
      let gripStarted: XRInputSource | null = null;
      let sticksDown = 0;
      let openingCandidate: XRInputSource | null = null;

      for (const source of inputSources) {
        if (source.hand || !source.gamepad) continue;
        const sourceGrip = isControllerGripPressed(source);
        if (sourceGrip) {
          gripHeld = true;
          if (!gripPressedSources.has(source)) gripStarted ??= source;
          gripPressedSources.add(source);
          if (source.gamepad.buttons[0]?.pressed) {
            gripSuppressedTriggers.add(source);
          }
        } else {
          gripPressedSources.delete(source);
          if (!source.gamepad.buttons[0]?.pressed) gripSuppressedTriggers.delete(source);
        }

        const stickDown = isControllerStickClicked(source);
        if (stickDown) sticksDown += 1;
        const prevStickDown = stickPressedBySource.get(source) ?? false;
        if (!prevStickDown && stickDown && !openingCandidate) {
          openingCandidate = source;
        }
        stickPressedBySource.set(source, stickDown);
      }

      // Clean up disconnected input sources
      for (const known of [...stickPressedBySource.keys()]) {
        if (!activeSet.has(known)) {
          stickPressedBySource.delete(known);
          gripPressedSources.delete(known);
          triggerStart.delete(known);
          panelPresses.delete(known);
          worldPresses.delete(known);
          gripSuppressedTriggers.delete(known);
          rayActions.delete(known);
          if (selectingSource === known) selectingSource = null;
        }
      }

      anyGripHeld = gripHeld;
      const externalBusy = busy || Boolean(options.isBusy?.());

      // Strict Grip Suppression: pressing grip cancels any pending trigger presses immediately.
      if (gripHeld) {
        invalidatePendingTriggers();
        panelPresses.clear();
        worldPresses.clear();
      }
      updateWidgetGrab(gripStarted, frame, referenceSpace);

      // Both-thumbstick-click 1.0 s recovery gesture (only when neither grip is held).
      if (sticksDown >= 2 && !gripHeld) {
        bothStickHoldSec += dtSec;
        if (!recenterFiredForHold && bothStickHoldSec + 1e-6 >= recenterHoldSec) {
          recenterFiredForHold = true;
          if (menu?.isOpen) {
            closeMenu();
          }
          actionBus.dispatch({ type: 'view/recenter' }, 'xr');
          options.onRecenter?.();
        }
      } else {
        bothStickHoldSec = 0;
        if (sticksDown < 2) {
          recenterFiredForHold = false;
        }
      }

      // Clear ownership on owner disconnect or tracking loss
      if (owner) {
        const ownerStillPresent = activeSet.has(owner);
        const trackingSpace = owner.gripSpace ?? owner.targetRaySpace;
        const hasPose =
          ownerStillPresent && trackingSpace
            ? Boolean(frame.getPose(trackingSpace, referenceSpace))
            : false;
        if (!ownerStillPresent || !hasPose) {
          closeMenu();
        }
      }

      let drewWheelRays = false;
      // Single-stick open when wheel is closed and neither grip nor busy state is active
      if (
        !menu?.root.visible &&
        sticksDown === 1 &&
        openingCandidate &&
        !gripHeld &&
        !externalBusy
      ) {
        const viewerPose = frame.getViewerPose(referenceSpace);
        const ownerSpace = openingCandidate.gripSpace ?? openingCandidate.targetRaySpace;
        const ownerPose = ownerSpace ? frame.getPose(ownerSpace, referenceSpace) : null;
        if (viewerPose && ownerPose) {
          const buildState = resolveBuildState();
          const aimedTurret = resolveAimedTurret(openingCandidate, frame, referenceSpace);
          if (aimedTurret) {
            const items = buildTurretCommandWheelItems(aimedTurret, buildState.credits);
            openMenuForSource(openingCandidate, 'turret', items, aimedTurret, viewerPose.transform);
          } else {
            const items = buildBuildWheelItems(buildState);
            openMenuForSource(openingCandidate, 'build', items, null, viewerPose.transform);
          }
        }
      } else if (owner?.gamepad && menu?.isOpen && nav) {
        // Drive open wheel with opening thumbstick + both controller lasers
        const stick = readStickAxes(owner.gamepad);
        const stickDown = isControllerStickClicked(owner);
        // Do not let a both-stick hold or grip-held press toggle unexpectedly; second single click dismisses.
        if (!gripHeld && sticksDown <= 1) {
          nav.update(owner, { pressed: stickDown, x: stick.x, y: stick.y });
        }

        if (menu.isOpen && menu.interactive) {
          skin?.settle();
          root.updateWorldMatrix(true, true);
          const beams: PlacementRayTarget[] = [];
          rayActions.clear();

          for (const source of inputSources) {
            if (source.hand || !source.gamepad || !source.targetRaySpace) continue;
            const pose = frame.getPose(source.targetRaySpace, referenceSpace);
            if (!pose) continue;

            aimObject.position.set(
              pose.transform.position.x,
              pose.transform.position.y,
              pose.transform.position.z,
            );
            aimObject.quaternion.set(
              pose.transform.orientation.x,
              pose.transform.orientation.y,
              pose.transform.orientation.z,
              pose.transform.orientation.w,
            );
            aimObject.updateMatrixWorld(true);

            const hit = pointer.castFrom(aimObject, [menu.root]);
            const hitAction = hit ? menu.actionAt(hit.object) : null;
            if (hitAction) {
              rayActions.set(source, hitAction);
            }

            const isDisabledHit =
              hitAction !== null && hitAction !== 'cancel' && disabledActions.has(hitAction);

            beams.push({
              source,
              origin: aimObject.position.clone(),
              direction: new THREE.Vector3(0, 0, -1).applyQuaternion(aimObject.quaternion),
              distance: hit?.distance ?? 0.85,
              contact: hitAction !== null,
              valid: !isDisabledHit,
            });
          }

          controllerRays.update(beams);
          drewWheelRays = true;

          // Hover precedence: active selecting press > deliberate owner stick tilt > opener laser > other laser > cancel
          const stickChoice = nav.choice();
          const ownerRay = owner ? (rayActions.get(owner) ?? null) : null;
          const anyRay = rayActions.values().next().value ?? null;
          const nextHover: RadialChoiceId = stickChoice ?? ownerRay ?? anyRay ?? 'cancel';
          hoveredAction = selectingSource
            ? (triggerStart.get(selectingSource)?.action ?? null)
            : nextHover;
          menu.setHovered(hoveredAction);
          applyDisabledWedgeStyling(menu.root, activeItems);
          skin?.applyDisabled();
        }
      }
      if (!drewWheelRays) {
        if (!menu?.root.visible) hoveredAction = null;
        updatePanelRays(inputSources, frame, referenceSpace);
      } else {
        clearPanelHover();
      }
    },
    handleSelectStart(source) {
      if (disposed) return false;
      if (anyGripHeld || isControllerGripPressed(source)) {
        gripSuppressedTriggers.add(source);
        triggerStart.set(source, { generation: -1, action: null });
        selectingSource = null;
        return true;
      }
      if (!menu?.root.visible) {
        const hit = rayCells.get(source);
        if (!hit) return panelModal || panelRayHits.has(source);
        panelPresses.set(source, hit);
        return true;
      }
      const aimed = rayActions.get(source) ?? null;
      const eligible = Boolean(menu.interactive && (source === owner || aimed !== null));
      const resolved = nav ? nav.selectionFor(source, aimed) : aimed;
      // Neutral stick + no ray target on opener confirms Cancel.
      const capturedAction: RadialChoiceId | null = eligible ? (resolved ?? 'cancel') : null;
      triggerStart.set(source, {
        generation: eligible ? generation : -1,
        action: capturedAction,
      });
      if (eligible) {
        selectingSource = source;
      }
      return true;
    },
    handleSelect(source) {
      if (disposed) return false;
      const press = triggerStart.get(source);
      const panelPress = panelPresses.get(source);
      triggerStart.delete(source);
      panelPresses.delete(source);
      if (selectingSource === source) selectingSource = null;

      const wasGripSuppressed =
        anyGripHeld || isControllerGripPressed(source) || gripSuppressedTriggers.has(source);
      gripSuppressedTriggers.delete(source);
      if (wasGripSuppressed) {
        return true;
      }

      if (panelPress) {
        const hit = rayCells.get(source);
        if (
          !menu?.root.visible &&
          options.getPanels?.().includes(panelPress.panel) &&
          panelPress.panel.root.visible &&
          hit?.panel === panelPress.panel &&
          hit.cell === panelPress.cell
        )
          panelPress.panel.activate(panelPress.cell);
        return true;
      }
      if (panelModal || panelRayHits.has(source)) return true;

      if (!menu?.root.visible && (!press || press.generation === 0)) {
        return false;
      }

      if (menu?.interactive && press && press.generation === generation) {
        const chosen = press.action;
        if (!chosen || chosen === 'cancel') {
          closeMenu();
        } else if (!disabledActions.has(chosen)) {
          closeMenu();
          executeAction(chosen);
        }
      }
      return true;
    },
    handleSelectEnd(source) {
      if (disposed) return false;
      const hadPress = triggerStart.delete(source);
      const hadPanelPress = panelPresses.delete(source);
      if (selectingSource === source) selectingSource = null;
      const wasSuppressed = gripSuppressedTriggers.delete(source);
      return hadPress || hadPanelPress || wasSuppressed || Boolean(menu?.root.visible);
    },
    attachSession(session, captureWorldSelect) {
      const onSelectStart = (event: XRInputSourceEvent) => {
        const source = event.inputSource;
        worldPresses.delete(source);
        if (!controls.handleSelectStart(source)) {
          const action = captureWorldSelect?.(event);
          if (action) worldPresses.set(source, action);
        }
      };
      const onSelect = (event: XRInputSourceEvent) => {
        const source = event.inputSource;
        const worldAction = worldPresses.get(source);
        worldPresses.delete(source);
        if (!controls.handleSelect(source)) worldAction?.(event);
      };
      const onSelectEnd = (event: XRInputSourceEvent) => {
        worldPresses.delete(event.inputSource);
        controls.handleSelectEnd(event.inputSource);
      };
      session.addEventListener('selectstart', onSelectStart);
      session.addEventListener('select', onSelect);
      session.addEventListener('selectend', onSelectEnd);
      return () => {
        worldPresses.clear();
        session.removeEventListener('selectstart', onSelectStart);
        session.removeEventListener('select', onSelect);
        session.removeEventListener('selectend', onSelectEnd);
      };
    },
    close() {
      closeMenu();
    },
    reset,
    dispose() {
      if (disposed) return;
      disposed = true;
      reset();
      stopKeepAbove();
      stopKeepRaysAbove();
      root.removeFromParent();
      controllerRays.dispose();
      if (!options.atlas) atlas.dispose();
    },
  };

  return controls;
}

export { getTurretDefinition };
