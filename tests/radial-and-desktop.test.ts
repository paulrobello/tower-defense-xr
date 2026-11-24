import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('troika-three-text', async (importOriginal) => {
  const actual = await importOriginal<typeof import('troika-three-text')>();
  const ThreeMod = await import('three');
  class MockText extends ThreeMod.Mesh {
    text = '';
    font: string | null = null;
    fontSize = 0;
    maxWidth = 0;
    anchorX: number | string = 0;
    anchorY: number | string = 0;
    textAlign = '';
    whiteSpace = '';
    lineHeight: number | string = 'normal';
    overflowWrap = '';
    color: number | string = 0;
    depthOffset = 0;
    readonly textRenderInfo = null;
    constructor() {
      super(new ThreeMod.BufferGeometry(), new ThreeMod.MeshBasicMaterial());
    }
    sync(callback?: () => void): void {
      queueMicrotask(() => callback?.());
    }
    dispose(): void {
      this.geometry.dispose();
    }
  }
  class MockBatchedText extends MockText {
    readonly members = new Set<MockText>();
    addText(text: MockText): void {
      this.members.add(text);
    }
    removeText(text: MockText): void {
      this.members.delete(text);
    }
    updateBounds(): void {}
  }
  return {
    ...actual,
    configureTextBuilder: vi.fn(),
    Text: MockText,
    BatchedText: MockBatchedText,
  };
});

import { OVERLAY_RENDER_ORDER } from '@par/xr-workspace';
import {
  HARD_TURRET_CAP,
  HOVER_POD_MAX_DEPTH_M,
  HOVER_POD_MIN_DEPTH_M,
} from '../src/content/turrets.ts';
import { type ActionEnvelope, createActionBus, type GameAction } from '../src/core/action-bus.ts';
import { createGameStateMachine } from '../src/core/state.ts';
import { createDesktopControls } from '../src/desktop/controls.ts';
import { createVirtualRoomModel } from '../src/mr/virtual-room.ts';
import { createTacticalHud } from '../src/ui/tactical-hud.ts';
import { createCalibrationController, type HeadsetPose } from '../src/xr/calibration.ts';
import { createTurretPlacementController } from '../src/xr/placement.ts';
import {
  BOTH_STICK_RECENTER_HOLD_SEC,
  buildBuildWheelItems,
  buildTurretCommandWheelItems,
  createXrRadialControls,
  nextTargetPriority,
  type RadialTurretTarget,
} from '../src/xr/radial-controls.ts';

interface FakeControllerSpec {
  handedness: XRHandedness;
  position: THREE.Vector3;
  quaternion?: THREE.Quaternion;
  trigger?: boolean;
  grip?: boolean;
  stickClick?: boolean;
  stickX?: number;
  stickY?: number;
}

function makeTransform(
  position: THREE.Vector3,
  quaternion: THREE.Quaternion = new THREE.Quaternion(),
): XRRigidTransform {
  const matrix = new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1));
  return {
    position: { x: position.x, y: position.y, z: position.z, w: 1 } as DOMPointReadOnly,
    orientation: {
      x: quaternion.x,
      y: quaternion.y,
      z: quaternion.z,
      w: quaternion.w,
    } as DOMPointReadOnly,
    matrix: new Float32Array(matrix.elements),
    inverse: {} as XRRigidTransform,
  };
}

function makePose(
  position: THREE.Vector3,
  quaternion: THREE.Quaternion = new THREE.Quaternion(),
): XRPose {
  return {
    transform: makeTransform(position, quaternion),
    emulatedPosition: false,
  };
}

function createFakeController(spec: FakeControllerSpec): {
  source: XRInputSource;
  setState: (patch: Partial<Omit<FakeControllerSpec, 'handedness'>>) => void;
  getPose: () => XRPose;
} {
  let pos = spec.position.clone();
  let quat = (spec.quaternion ?? new THREE.Quaternion()).clone();
  const buttons = [
    { pressed: Boolean(spec.trigger), touched: false, value: spec.trigger ? 1 : 0 }, // 0 trigger
    { pressed: Boolean(spec.grip), touched: false, value: spec.grip ? 1 : 0 }, // 1 grip
    { pressed: false, touched: false, value: 0 }, // 2 touchpad
    { pressed: Boolean(spec.stickClick), touched: false, value: spec.stickClick ? 1 : 0 }, // 3 thumbstick
    { pressed: false, touched: false, value: 0 }, // 4 A/X
    { pressed: false, touched: false, value: 0 }, // 5 B/Y
  ];
  const axes = [0, 0, spec.stickX ?? 0, spec.stickY ?? 0];

  const targetRaySpace = { id: `${spec.handedness}-ray` } as unknown as XRSpace;
  const gripSpace = { id: `${spec.handedness}-grip` } as unknown as XRSpace;

  const source = {
    handedness: spec.handedness,
    targetRayMode: 'tracked-pointer',
    targetRaySpace,
    gripSpace,
    profiles: ['oculus-touch-v3'],
    gamepad: {
      buttons,
      axes,
      connected: true,
      id: 'oculus-touch',
      index: spec.handedness === 'right' ? 1 : 0,
      mapping: 'xr-standard',
      timestamp: 0,
      hapticActuators: [],
    } as unknown as Gamepad,
  } as unknown as XRInputSource;

  return {
    source,
    setState(patch) {
      if (patch.position) pos = patch.position.clone();
      if (patch.quaternion) quat = patch.quaternion.clone();
      if (patch.trigger !== undefined) {
        buttons[0].pressed = patch.trigger;
        buttons[0].value = patch.trigger ? 1 : 0;
      }
      if (patch.grip !== undefined) {
        buttons[1].pressed = patch.grip;
        buttons[1].value = patch.grip ? 1 : 0;
      }
      if (patch.stickClick !== undefined) {
        buttons[3].pressed = patch.stickClick;
        buttons[3].value = patch.stickClick ? 1 : 0;
      }
      if (patch.stickX !== undefined) axes[2] = patch.stickX;
      if (patch.stickY !== undefined) axes[3] = patch.stickY;
    },
    getPose() {
      return makePose(pos, quat);
    },
  };
}

function createFakeXrFrame(
  controllers: Array<ReturnType<typeof createFakeController>>,
  viewerPos: THREE.Vector3 = new THREE.Vector3(0, 1.5, 0),
  viewerQuat: THREE.Quaternion = new THREE.Quaternion(),
): { frame: XRFrame; referenceSpace: XRReferenceSpace } {
  const spaceMap = new Map<XRSpace, XRPose>();
  for (const ctrl of controllers) {
    spaceMap.set(ctrl.source.targetRaySpace, ctrl.getPose());
    if (ctrl.source.gripSpace) {
      spaceMap.set(ctrl.source.gripSpace, ctrl.getPose());
    }
  }
  const referenceSpace = { id: 'local-floor' } as unknown as XRReferenceSpace;
  const viewerPose = {
    transform: makeTransform(viewerPos, viewerQuat),
    views: [],
    emulatedPosition: false,
  } as unknown as XRViewerPose;

  const frame = {
    session: {
      inputSources: controllers.map((c) => c.source),
    },
    getPose(space: XRSpace) {
      return spaceMap.get(space) ?? null;
    },
    getViewerPose() {
      return viewerPose;
    },
  } as unknown as XRFrame;

  return { frame, referenceSpace };
}

/** Steps radial animation past `OPEN_SECONDS` (0.64 s) so the wheel settles and becomes interactive. */
function settleRadialAnimation(
  radial: ReturnType<typeof createXrRadialControls>,
  controllers: Array<ReturnType<typeof createFakeController>>,
  startTimeMs: number,
  steps = 8,
  stepMs = 100,
): number {
  let time = startTimeMs;
  for (let i = 0; i < steps; i += 1) {
    time += stepMs;
    const { frame, referenceSpace } = createFakeXrFrame(controllers);
    radial.update(frame, referenceSpace, time);
  }
  return time;
}

describe('Radial Wheel Context Builders (Build & Turret Command)', () => {
  it('computes live affordability badges and disables unaffordable or capped turrets', () => {
    const affordable = buildBuildWheelItems({
      credits: 130,
      activeTurretCount: 2,
      hardTurretCap: HARD_TURRET_CAP,
      canLaunchWave: true,
    });
    expect(affordable.map((i) => i.id)).toEqual([
      'build:autocannon',
      'build:plasma-mortar',
      'build:cryo-arc',
      'build:rail-sniper',
      'wave:launch',
    ]);
    // 130 CR: Autocannon (100) & Cryo-Arc (125) affordable; Plasma (135) & Rail (150) disabled
    expect(affordable[0].disabled).toBe(false);
    expect(affordable[0].label).toContain('M44 Autocannon');
    expect(affordable[0].label).toContain('100 CR');
    expect(affordable[1].disabled).toBe(true);
    expect(affordable[1].disabledReason).toBe('NO CREDITS');
    expect(affordable[2].disabled).toBe(false);
    expect(affordable[3].disabled).toBe(true);
    expect(affordable[4].disabled).toBe(false);

    // At 14/14 cap, all 4 build wedges are disabled with CAP 14/14 badge
    const capped = buildBuildWheelItems({
      credits: 999,
      activeTurretCount: 14,
      hardTurretCap: 14,
      canLaunchWave: false,
    });
    for (let i = 0; i < 4; i += 1) {
      expect(capped[i].disabled).toBe(true);
      expect(capped[i].disabledReason).toBe('CAP 14/14');
      expect(capped[i].label).toContain('CAP 14/14');
    }
    expect(capped[4].disabled).toBe(true);
  });

  it('builds Turret Command items with T1->T2/T2->T3 upgrades, T3 max disable, priority cycle, relocate, and 75% sell', () => {
    const t1: RadialTurretTarget = {
      id: 'turret-1',
      kind: 'autocannon',
      tier: 'T1',
      priority: 'first',
    };
    const itemsT1 = buildTurretCommandWheelItems(t1, 150);
    expect(itemsT1.map((i) => i.id)).toEqual([
      'turret:upgrade',
      'turret:priority',
      'turret:relocate',
      'turret:sell',
    ]);
    expect(itemsT1[0].disabled).toBe(false);
    expect(itemsT1[0].label).toContain('T1->T2');
    expect(itemsT1[0].label).toContain('130 CR');
    expect(itemsT1[1].label).toContain('First');
    expect(itemsT1[1].label).toContain('Strongest');
    expect(itemsT1[2].disabled).toBe(false);
    expect(itemsT1[3].label).toContain('75%');
    expect(itemsT1[3].label).toContain('+75 CR');

    // Insufficient credits disables upgrade & relocate while leaving priority and sell enabled
    const lowCredits = buildTurretCommandWheelItems(t1, 10);
    expect(lowCredits[0].disabled).toBe(true);
    expect(lowCredits[1].disabled).toBe(false);
    expect(lowCredits[2].disabled).toBe(true);
    expect(lowCredits[3].disabled).toBe(false);

    // T3 disables upgrade with MAX TIER
    const t3: RadialTurretTarget = {
      id: 'turret-2',
      kind: 'rail-sniper',
      tier: 'T3',
      priority: 'air',
    };
    const itemsT3 = buildTurretCommandWheelItems(t3, 500);
    expect(itemsT3[0].disabled).toBe(true);
    expect(itemsT3[0].disabledReason).toBe('MAX TIER');
    expect(itemsT3[0].label).toContain('MAX (T3)');
    expect(nextTargetPriority('air')).toBe('first');
  });
});

describe('XR Radial Controls (Build Wheel, Turret Command Wheel, Grip Suppression & Recenter)', () => {
  it('opens Build Wheel on thumbstick click, prioritizes stick tilt over ray, selects wedge on trigger, and cancels on neutral stick', () => {
    const scene = new THREE.Scene();
    const bus = createActionBus();
    const dispatched: ActionEnvelope[] = [];
    bus.onAny((_a, env) => dispatched.push(env));

    const selectedKinds: string[] = [];
    const radial = createXrRadialControls({
      scene,
      actionBus: bus,
      getBuildState: () => ({ credits: 320, activeTurretCount: 1, canLaunchWave: true }),
      getAimedTurret: () => null,
      onSelectBuildKind: (kind) => selectedKinds.push(kind),
    });

    const right = createFakeController({
      handedness: 'right',
      position: new THREE.Vector3(0.25, 1.2, -0.2),
    });
    const left = createFakeController({
      handedness: 'left',
      position: new THREE.Vector3(-0.25, 1.2, -0.2),
    });
    const controllers = [left, right];

    // Frame 0: neutral
    let t = 1000;
    let xr = createFakeXrFrame(controllers);
    radial.update(xr.frame, xr.referenceSpace, t);
    expect(radial.isModal).toBe(false);

    // Frame 1: right stick click opens Build Wheel
    right.setState({ stickClick: true });
    t += 16;
    xr = createFakeXrFrame(controllers);
    radial.update(xr.frame, xr.referenceSpace, t);
    expect(radial.isModal).toBe(true);
    expect(radial.context).toBe('build');

    // Release stick click and settle opening animation
    right.setState({ stickClick: false });
    t = settleRadialAnimation(radial, controllers, t);
    expect(radial.interactive).toBe(true);

    // Deliberate stick tilt UP (y = -1) selects top wedge (index 0: M44 Autocannon)
    right.setState({ stickX: 0, stickY: -1 });
    t += 16;
    xr = createFakeXrFrame(controllers);
    radial.update(xr.frame, xr.referenceSpace, t);
    expect(radial.hoveredAction).toBe('build:autocannon');

    // Trigger selectstart + select dispatches build selection and closes wheel
    expect(radial.handleSelectStart(right.source)).toBe(true);
    expect(radial.handleSelect(right.source)).toBe(true);
    expect(selectedKinds).toEqual(['autocannon']);
    expect(radial.isOpen).toBe(false);

    // Finish closing animation
    t = settleRadialAnimation(radial, controllers, t, 3, 100);
    expect(radial.isModal).toBe(false);

    // Re-open with left thumbstick, leave stick neutral (no ray hit) -> trigger confirms Cancel
    left.setState({ stickClick: true });
    t += 16;
    xr = createFakeXrFrame(controllers);
    radial.update(xr.frame, xr.referenceSpace, t);
    expect(radial.isModal).toBe(true);
    left.setState({ stickClick: false });
    t = settleRadialAnimation(radial, controllers, t);
    expect(radial.hoveredAction).toBe('cancel');

    expect(radial.handleSelectStart(left.source)).toBe(true);
    expect(radial.handleSelect(left.source)).toBe(true);
    expect(radial.isOpen).toBe(false);
    expect(dispatched).toHaveLength(0);

    // Re-open and dismiss with a second thumbstick click
    t = settleRadialAnimation(radial, controllers, t, 3, 100);
    right.setState({ stickClick: true, stickX: 0, stickY: 0 });
    t += 16;
    xr = createFakeXrFrame(controllers);
    radial.update(xr.frame, xr.referenceSpace, t);
    expect(radial.isOpen).toBe(true);
    right.setState({ stickClick: false });
    t = settleRadialAnimation(radial, controllers, t);
    right.setState({ stickClick: true });
    t += 16;
    xr = createFakeXrFrame(controllers);
    radial.update(xr.frame, xr.referenceSpace, t);
    expect(radial.isOpen).toBe(false);

    radial.dispose();
  });

  it('opens Turret Command Wheel when aiming at an existing turret and dispatches Upgrade, Priority, Relocate, and Sell', () => {
    const scene = new THREE.Scene();
    const bus = createActionBus();
    const actions: GameAction[] = [];
    bus.onAny((action, env) => {
      expect(env.source).toBe('xr');
      actions.push(action);
    });

    const relocatedIds: string[] = [];
    const targetTurret: RadialTurretTarget = {
      id: 'turret-7',
      kind: 'cryo-arc',
      tier: 'T1',
      priority: 'first',
    };

    const radial = createXrRadialControls({
      scene,
      actionBus: bus,
      getBuildState: () => ({ credits: 300, activeTurretCount: 3 }),
      getAimedTurret: () => targetTurret,
      onBeginRelocate: (id) => relocatedIds.push(id),
    });

    const right = createFakeController({
      handedness: 'right',
      position: new THREE.Vector3(0, 1.2, 0),
    });
    const controllers = [right];
    let t = 1000;

    // Helper: open turret wheel, tilt stick to (sx, sy), trigger select
    const selectTurretWedge = (sx: number, sy: number) => {
      right.setState({ stickClick: false, stickX: 0, stickY: 0 });
      t = settleRadialAnimation(radial, controllers, t, 3, 100);

      right.setState({ stickClick: true });
      t += 16;
      let xr = createFakeXrFrame(controllers);
      radial.update(xr.frame, xr.referenceSpace, t);
      expect(radial.context).toBe('turret');
      expect(radial.targetTurretId).toBe('turret-7');

      right.setState({ stickClick: false });
      t = settleRadialAnimation(radial, controllers, t);

      right.setState({ stickX: sx, stickY: sy });
      t += 16;
      xr = createFakeXrFrame(controllers);
      radial.update(xr.frame, xr.referenceSpace, t);

      radial.handleSelectStart(right.source);
      radial.handleSelect(right.source);
    };

    // 4 wedges clockwise from top: 0=Upgrade (0,-1), 1=Priority (1,0), 2=Relocate (0,1), 3=Sell (-1,0)
    selectTurretWedge(0, -1); // Upgrade
    selectTurretWedge(1, 0); // Priority
    selectTurretWedge(0, 1); // Relocate
    selectTurretWedge(-1, 0); // Sell

    expect(actions).toEqual([
      { type: 'turret/upgrade', turretId: 'turret-7' },
      { type: 'turret/set-priority', turretId: 'turret-7', priority: 'strongest' },
      { type: 'turret/sell', turretId: 'turret-7' },
    ]);
    expect(relocatedIds).toEqual(['turret-7']);

    radial.dispose();
  });

  it('enforces strict grip suppression: gripping never opens radial, cancels pending triggers, and blocks placement', () => {
    const scene = new THREE.Scene();
    const bus = createActionBus();
    const roomModel = createVirtualRoomModel();
    const placement = createTurretPlacementController({
      roomModel,
      scene,
      actionBus: bus,
      initialCredits: 400,
      initialActive: true,
    });
    const actions: GameAction[] = [];
    bus.onAny((a) => actions.push(a));

    const radial = createXrRadialControls({
      scene,
      actionBus: bus,
      placement,
      getBuildState: () => ({ credits: 400, activeTurretCount: placement.turretCount }),
    });

    const right = createFakeController({
      handedness: 'right',
      position: new THREE.Vector3(0, 1.4, 0.8),
      // Pitch down toward floor
      quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.6, 0, 0)),
    });
    const controllers = [right];
    let t = 1000;

    // Neutral frame
    let xr = createFakeXrFrame(controllers);
    radial.update(xr.frame, xr.referenceSpace, t);

    // 1. Holding grip while clicking thumbstick must NOT open radial
    right.setState({ grip: true, stickClick: true });
    t += 16;
    xr = createFakeXrFrame(controllers);
    radial.update(xr.frame, xr.referenceSpace, t);
    expect(radial.isGripHeld).toBe(true);
    expect(radial.isModal).toBe(false);
    expect(radial.shouldSuppressWorldTrigger(right.source)).toBe(true);

    // 2. Holding grip while pressing trigger must NEVER place a turret in placement controller
    right.setState({ grip: true, trigger: true, stickClick: false });
    t += 16;
    xr = createFakeXrFrame(controllers);
    radial.update(xr.frame, xr.referenceSpace, t);
    placement.updateFromXrFrame(xr.frame, xr.referenceSpace, 0.016);
    expect(placement.turretCount).toBe(0);
    expect(actions).toHaveLength(0);

    // 3. Open radial cleanly, start trigger press on Launch Wave, then press grip before release:
    // grip MUST cancel the pending trigger press so releasing trigger does not dispatch!
    right.setState({ grip: false, trigger: false, stickClick: false });
    t += 16;
    xr = createFakeXrFrame(controllers);
    radial.update(xr.frame, xr.referenceSpace, t);

    right.setState({ stickClick: true });
    t += 16;
    xr = createFakeXrFrame(controllers);
    radial.update(xr.frame, xr.referenceSpace, t);
    expect(radial.isOpen).toBe(true);

    right.setState({ stickClick: false });
    t = settleRadialAnimation(radial, controllers, t);

    // Tilt toward Launch Wave (wedge index 4 of 5: top-left around (-0.95, -0.31))
    right.setState({ stickX: -0.95, stickY: -0.31 });
    t += 16;
    xr = createFakeXrFrame(controllers);
    radial.update(xr.frame, xr.referenceSpace, t);
    expect(radial.hoveredAction).toBe('wave:launch');

    // Begin trigger press
    radial.handleSelectStart(right.source);

    // Grip pressed before trigger completes -> cancels pending press
    right.setState({ grip: true });
    t += 16;
    xr = createFakeXrFrame(controllers);
    radial.update(xr.frame, xr.referenceSpace, t);

    // Release grip and complete select -> stale/cancelled press is consumed, zero actions dispatched
    right.setState({ grip: false });
    t += 16;
    xr = createFakeXrFrame(controllers);
    radial.update(xr.frame, xr.referenceSpace, t);

    expect(radial.handleSelect(right.source)).toBe(true);
    expect(actions).toHaveLength(0);

    radial.dispose();
    placement.dispose();
  });

  it('triggers view/recenter after 1.0 s both-stick hold and strictly suppresses it while gripping', () => {
    const scene = new THREE.Scene();
    const bus = createActionBus();
    const recenters: ActionEnvelope[] = [];
    bus.on('view/recenter', (_a, env) => recenters.push(env));

    const radial = createXrRadialControls({
      scene,
      actionBus: bus,
      recenterHoldSec: BOTH_STICK_RECENTER_HOLD_SEC,
    });

    const left = createFakeController({
      handedness: 'left',
      position: new THREE.Vector3(-0.2, 1.2, -0.2),
    });
    const right = createFakeController({
      handedness: 'right',
      position: new THREE.Vector3(0.2, 1.2, -0.2),
    });
    const controllers = [left, right];

    let t = 0;
    let xr = createFakeXrFrame(controllers);
    radial.update(xr.frame, xr.referenceSpace, t);

    // Hold both sticks WHILE left grip is held for 1.5 s -> must NOT trigger recenter
    left.setState({ stickClick: true, grip: true });
    right.setState({ stickClick: true, grip: false });
    for (let i = 0; i < 15; i += 1) {
      t += 100;
      xr = createFakeXrFrame(controllers);
      radial.update(xr.frame, xr.referenceSpace, t);
    }
    expect(recenters).toHaveLength(0);
    expect(radial.recenterProgress).toBe(0);

    // Release grip while holding both sticks -> accumulates 1.0 s and fires once
    left.setState({ grip: false, stickClick: true });
    right.setState({ grip: false, stickClick: true });
    for (let i = 0; i < 9; i += 1) {
      t += 100;
      xr = createFakeXrFrame(controllers);
      radial.update(xr.frame, xr.referenceSpace, t);
    }
    expect(recenters).toHaveLength(0);
    expect(radial.recenterProgress).toBeCloseTo(0.9, 5);

    // Crosses 1.0 s threshold -> fires view/recenter once
    t += 100;
    xr = createFakeXrFrame(controllers);
    radial.update(xr.frame, xr.referenceSpace, t);
    expect(recenters).toHaveLength(1);
    expect(recenters[0].source).toBe('xr');
    expect(radial.isModal).toBe(false);

    // Continuing to hold does not fire again until sticks are released
    t += 100;
    xr = createFakeXrFrame(controllers);
    radial.update(xr.frame, xr.referenceSpace, t);
    expect(recenters).toHaveLength(1);

    radial.dispose();
  });

  it('refuses to dispatch disabled wedges (insufficient credits / cap 14/14 / T3 max) and lets either controller laser select wedges', () => {
    const scene = new THREE.Scene();
    const bus = createActionBus();
    const actions: GameAction[] = [];
    bus.onAny((a) => actions.push(a));
    const selectedKinds: string[] = [];

    const radial = createXrRadialControls({
      scene,
      actionBus: bus,
      getBuildState: () => ({ credits: 50, activeTurretCount: 14, canLaunchWave: true }),
      getAimedTurret: () => null,
      onSelectBuildKind: (kind) => selectedKinds.push(kind),
    });

    const right = createFakeController({
      handedness: 'right',
      position: new THREE.Vector3(0.25, 1.2, -0.2),
    });
    const left = createFakeController({
      handedness: 'left',
      position: new THREE.Vector3(-0.25, 1.2, -0.2),
    });
    const controllers = [left, right];

    let t = 500;
    let xr = createFakeXrFrame(controllers);
    radial.update(xr.frame, xr.referenceSpace, t);

    // Open Build Wheel with right stick
    right.setState({ stickClick: true });
    t += 16;
    xr = createFakeXrFrame(controllers);
    radial.update(xr.frame, xr.referenceSpace, t);
    right.setState({ stickClick: false });
    t = settleRadialAnimation(radial, controllers, t);

    // Tilt stick UP to index 0 (Autocannon) which is disabled due to CAP 14/14 & low credits
    right.setState({ stickX: 0, stickY: -1 });
    t += 16;
    xr = createFakeXrFrame(controllers);
    radial.update(xr.frame, xr.referenceSpace, t);
    expect(radial.hoveredAction).toBe('build:autocannon');

    // Triggering a disabled wedge consumes the trigger and dispatches nothing
    expect(radial.handleSelectStart(right.source)).toBe(true);
    expect(radial.handleSelect(right.source)).toBe(true);
    expect(selectedKinds).toHaveLength(0);
    expect(actions).toHaveLength(0);
    expect(radial.isOpen).toBe(true);

    // Return opener stick to neutral and aim the OTHER (left) controller laser directly at Launch Wave wedge
    right.setState({ stickX: 0, stickY: 0 });
    let launchWedgeWorld: THREE.Vector3 | null = null;
    radial.root.updateWorldMatrix(true, true);
    radial.root.traverse((node) => {
      if (node.userData.radialAction === 'wave:launch' && (node as THREE.Mesh).isMesh) {
        launchWedgeWorld = new THREE.Vector3();
        node.getWorldPosition(launchWedgeWorld);
      }
    });
    expect(launchWedgeWorld).not.toBeNull();
    if (launchWedgeWorld) {
      const origin = new THREE.Vector3(0, 1.5, 0);
      const dir = (launchWedgeWorld as THREE.Vector3).clone().sub(origin).normalize();
      const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
      left.setState({ position: origin, quaternion: quat });
      t += 16;
      xr = createFakeXrFrame(controllers);
      radial.update(xr.frame, xr.referenceSpace, t);
      expect(radial.hoveredAction).toBe('wave:launch');

      // Other controller's trigger selects the aimed Launch Wave wedge
      expect(radial.handleSelectStart(left.source)).toBe(true);
      expect(radial.handleSelect(left.source)).toBe(true);
      expect(actions).toEqual([{ type: 'wave/launch' }]);
    }

    radial.dispose();
  });
});

describe('Tactical HUD (Spatial XR + Desktop Strip + Recentering)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('updates telemetry readouts, contextual Lock Core / Launch Wave button, Play Arc badge, and dispatches ActionBus events', () => {
    const bus = createActionBus();
    const received: Array<{ action: GameAction; source: string }> = [];
    bus.onAny((action, env) => received.push({ action, source: env.source }));

    const container = document.createElement('div');
    document.body.appendChild(container);

    const hud = createTacticalHud({
      actionBus: bus,
      container,
      initialMode: 'desktop',
      initialState: {
        phase: 'calibrate',
        coreHp: 100,
        coreMaxHp: 100,
        wave: 0,
        totalWaves: 12,
        activeTurrets: 0,
        maxTurrets: 14,
        playArc: 'front-180',
      },
    });

    const query = (key: string) => container.querySelector(`[data-hud="${key}"]`) as HTMLElement;
    expect(query('core-hp').textContent).toBe('CORE 100/100');
    expect(query('credits').textContent).toBe('200 CR');
    expect(query('wave').textContent).toBe('WAVE 0/12');
    expect(query('turrets').textContent).toBe('TURRETS 0/14');
    expect(query('primary-action').textContent).toBe('Lock Core');
    expect(query('play-arc').textContent).toContain('180°');

    // Desktop button clicks route through ActionBus
    query('primary-action').click();
    query('play-arc').click();
    query('settings').click();

    expect(received).toEqual([
      { action: { type: 'calibrate/confirm' }, source: 'desktop' },
      { action: { type: 'calibrate/set-play-arc', arc: 'full-360' }, source: 'desktop' },
      { action: { type: 'menu/open-settings' }, source: 'desktop' },
    ]);

    // Play Arc automatically synced via ActionBus listener
    expect(hud.state.playArc).toBe('full-360');
    expect(query('play-arc').textContent).toContain('360°');

    // Transition to prep phase + mid-game telemetry updates
    hud.updateState({
      phase: 'prep',
      coreHp: 84,
      credits: 475,
      wave: 3,
      activeTurrets: 6,
    });
    expect(query('core-hp').textContent).toBe('CORE 84/100');
    expect(query('credits').textContent).toBe('475 CR');
    expect(query('wave').textContent).toBe('WAVE 3/12');
    expect(query('turrets').textContent).toBe('TURRETS 6/14');
    expect(query('primary-action').textContent).toBe('Launch Wave');

    // XR mode hides desktop strip, shows XR root, and XR panel activation dispatches with source 'xr'
    hud.setMode('xr');
    expect(hud.xrRoot.visible).toBe(true);
    expect(hud.desktopElement?.hidden).toBe(true);
    expect(hud.xrRoot.userData.rootUIgrabbable).toBe(true);
    expect(hud.xrRoot.renderOrder).toBe(OVERLAY_RENDER_ORDER);

    received.length = 0;
    expect(hud.activate('primary-action')).toBe(true);
    expect(hud.activate('settings')).toBe(true);
    expect(received).toEqual([
      { action: { type: 'wave/launch' }, source: 'xr' },
      { action: { type: 'menu/open-settings' }, source: 'xr' },
    ]);

    hud.dispose();
  });

  it('recenters spatial XR HUD in front of the current headset pose on view/recenter and stays stable afterward', () => {
    const bus = createActionBus();
    let currentPose: HeadsetPose = {
      position: { x: 1.0, y: 1.6, z: 0.5 },
      yaw: Math.PI / 2, // facing -X
    };

    const hud = createTacticalHud({
      actionBus: bus,
      container: null,
      initialMode: 'xr',
      getHeadsetPose: () => currentPose,
      recenterDistanceM: 1.2,
      recenterYOffsetM: -0.2,
    });

    // Simulate user scaling/moving HUD away before recentering
    hud.xrRoot.scale.setScalar(1.4);
    hud.xrRoot.position.set(5, 3, 5);

    bus.dispatch({ type: 'view/recenter' }, 'xr');

    expect(hud.recenterCount).toBe(1);
    // Facing -X from (1.0, 1.6, 0.5) at distance 1.2 => x = -0.2, y = 1.4, z = 0.5
    expect(hud.xrRoot.position.x).toBeCloseTo(-0.2, 4);
    expect(hud.xrRoot.position.y).toBeCloseTo(1.4, 4);
    expect(hud.xrRoot.position.z).toBeCloseTo(0.5, 4);
    expect(hud.xrRoot.scale.x).toBeCloseTo(1, 5);

    // Local +Z of the HUD faces back toward the headset (+X)
    const hudForward = new THREE.Vector3(0, 0, 1).applyQuaternion(hud.xrRoot.quaternion);
    expect(hudForward.x).toBeCloseTo(1, 4);
    expect(hudForward.z).toBeCloseTo(0, 4);

    // Moving the headset afterward does NOT move the HUD (spatially stable)
    const savedPos = hud.xrRoot.position.clone();
    currentPose = { position: { x: -2, y: 1.7, z: -2 }, yaw: 0 };
    hud.updateState({ credits: 400 });
    expect(hud.xrRoot.position.distanceTo(savedPos)).toBe(0);

    hud.dispose();
  });
});

describe('Desktop Controls (1:1 ActionBus Parity for Calibration, Placement, Wheel & Hotkeys)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('maps calibration click/Space/PlayArc, 1-4 build + scroll depth + H/right-click hover toggle, and U/T/R/X/Tab/Escape onto ActionBus', () => {
    const bus = createActionBus();
    const state = createGameStateMachine({ initial: 'calibrate' });
    const roomModel = createVirtualRoomModel();
    const scene = new THREE.Scene();

    const calibration = createCalibrationController({
      roomModel,
      actionBus: bus,
      gameState: state,
      initialHeadsetPose: { position: { x: 0, y: 1.65, z: 1.45 }, yaw: 0 },
    });
    const placement = createTurretPlacementController({
      roomModel,
      scene,
      actionBus: bus,
      coreAnchor: () => calibration.coreAnchor,
      portalAnchors: () => calibration.portalAnchors,
      initialCredits: 1000,
      initialActive: false,
    });

    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    document.body.appendChild(canvas);

    const camera = new THREE.PerspectiveCamera(60, 800 / 600, 0.1, 30);
    camera.position.set(0, 1.8, 2.2);
    camera.lookAt(0, 0.0, -0.5);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    const events: Array<{ action: GameAction; source: string }> = [];
    bus.onAny((action, env) => events.push({ action, source: env.source }));

    const desktop = createDesktopControls({
      actionBus: bus,
      camera,
      domElement: canvas,
      eventTarget: window,
      gameState: state,
      calibration,
      placement,
      roomModel,
      wheelDepthStepM: 0.5,
    });

    const pressKey = (key: string, code?: string) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, code: code ?? key, bubbles: true }));
    };

    // 1. Calibration phase: left-click moves Core via ActionBus, P toggles Play Arc, Space locks Core
    canvas.dispatchEvent(
      new MouseEvent('pointerdown', { clientX: 400, clientY: 340, button: 0, bubbles: true }),
    );
    expect(
      events.some((e) => e.action.type === 'calibrate/move-core' && e.source === 'desktop'),
    ).toBe(true);

    pressKey('p');
    expect(events.some((e) => e.action.type === 'calibrate/set-play-arc')).toBe(true);

    pressKey(' ', 'Space');
    expect(events.some((e) => e.action.type === 'calibrate/confirm')).toBe(true);
    expect(state.phase).toBe('prep');

    // 2. Quick-build hotkeys 1-4 select turret kinds and enter placement mode
    pressKey('1');
    expect(placement.state.active).toBe(true);
    expect(placement.selectedKind).toBe('autocannon');
    pressKey('2');
    expect(placement.selectedKind).toBe('plasma-mortar');
    pressKey('3');
    expect(placement.selectedKind).toBe('cryo-arc');
    pressKey('4');
    expect(placement.selectedKind).toBe('rail-sniper');

    // 3. Mouse ray + Scroll wheel adjusts hover-pod depth within 0.8-5.0 m
    canvas.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 400, clientY: 320, bubbles: true }),
    );
    expect(placement.mountMode).toBe('surface-clamp');

    canvas.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }),
    );
    expect(placement.mountMode).toBe('hover-pod');
    const depthAfterPush = placement.hoverDepthM;
    expect(depthAfterPush).toBeGreaterThanOrEqual(HOVER_POD_MIN_DEPTH_M);
    expect(depthAfterPush).toBeLessThanOrEqual(HOVER_POD_MAX_DEPTH_M);

    // Push far beyond 5.0 m -> clamped to 5.0 m
    for (let i = 0; i < 15; i += 1) {
      canvas.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }),
      );
    }
    expect(placement.hoverDepthM).toBe(HOVER_POD_MAX_DEPTH_M);

    // Pull close below 0.8 m -> clamped to 0.8 m
    for (let i = 0; i < 15; i += 1) {
      canvas.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }),
      );
    }
    expect(placement.hoverDepthM).toBe(HOVER_POD_MIN_DEPTH_M);

    // 4. Right-click and H toggle hover-pod <-> surface-clamp
    canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(placement.mountMode).toBe('surface-clamp');
    pressKey('h');
    expect(placement.mountMode).toBe('hover-pod');
    pressKey('h');
    expect(placement.mountMode).toBe('surface-clamp');

    // 5. Left-click confirms placement via ActionBus (turret/build)
    // Aim at a valid open floor spot away from Core
    const placed = placement.placeTurret(
      {
        kind: 'autocannon',
        position: { x: 1.2, y: 0, z: -0.8 },
        mountProfile: 'surface-clamp',
        surfaceId: roomModel.surfaces.find((s) => s.kind === 'floor')?.id ?? null,
      },
      'desktop',
    );
    expect(placed).not.toBeNull();
    if (!placed) throw new Error('Expected turret to be placed');
    const turretId = placed.id;

    // Escape cancels placement mode
    pressKey('Escape');
    expect(placement.state.active).toBe(false);

    // 6. Select placed turret and exercise U (upgrade), T (cycle priority), R (relocate), X (sell)
    desktop.setSelectedTurret(turretId);
    events.length = 0;

    pressKey('u');
    pressKey('t');
    pressKey('t');
    pressKey('r');
    expect(placement.state.active).toBe(true);
    expect(placement.relocatingTurretId).toBe(turretId);

    // Cancel relocate with Escape, then sell with X
    pressKey('Escape');
    expect(placement.state.active).toBe(false);
    desktop.setSelectedTurret(turretId);
    pressKey('x');

    // 7. Space launches wave in prep phase; Tab toggles Settings open & closed
    pressKey(' ', 'Space');
    pressKey('Tab');
    pressKey('Tab');

    expect(events).toEqual([
      { action: { type: 'turret/upgrade', turretId }, source: 'desktop' },
      {
        action: { type: 'turret/set-priority', turretId, priority: 'strongest' },
        source: 'desktop',
      },
      { action: { type: 'turret/set-priority', turretId, priority: 'closest' }, source: 'desktop' },
      { action: { type: 'turret/sell', turretId }, source: 'desktop' },
      { action: { type: 'wave/launch' }, source: 'desktop' },
      { action: { type: 'menu/open-settings' }, source: 'desktop' },
      { action: { type: 'menu/close-settings' }, source: 'desktop' },
    ]);

    desktop.dispose();
    placement.dispose();
    calibration.dispose();
  });

  it('places a turret via mouse left-click on floor and confirms turret/build once on ActionBus', () => {
    const bus = createActionBus();
    const roomModel = createVirtualRoomModel();
    const scene = new THREE.Scene();

    const placement = createTurretPlacementController({
      roomModel,
      scene,
      actionBus: bus,
      coreAnchor: {
        position: { x: 0, y: 0.78, z: -0.2 },
        yaw: 0,
        surfaceId: null,
        surfaceKind: 'table',
        radius: 0.55,
      },
      portalAnchors: [],
      initialCredits: 500,
      initialActive: false,
    });

    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    document.body.appendChild(canvas);

    // Position camera looking straight down at an unobstructed floor region (1.2, 0, -1.0)
    const camera = new THREE.PerspectiveCamera(60, 800 / 600, 0.1, 30);
    camera.position.set(1.2, 1.8, -1.0);
    camera.lookAt(1.2, 0, -1.0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    const builds: GameAction[] = [];
    bus.on('turret/build', (action) => builds.push(action));

    const desktop = createDesktopControls({
      actionBus: bus,
      camera,
      domElement: canvas,
      eventTarget: window,
      getPhase: () => 'prep',
      placement,
      roomModel,
    });

    // Press 1 (Autocannon) then click center of canvas -> ray hits floor at (1.2, 0, -1.0)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
    canvas.dispatchEvent(
      new MouseEvent('pointerdown', { clientX: 400, clientY: 300, button: 0, bubbles: true }),
    );

    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatchObject({ type: 'turret/build', kind: 'autocannon' });
    expect(placement.turretCount).toBe(1);

    desktop.dispose();
    placement.dispose();
  });
});
