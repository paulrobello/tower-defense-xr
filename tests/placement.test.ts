import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  CORE_KEEP_OUT_RADIUS_M,
  HARD_TURRET_CAP,
  HOVER_POD_MAX_DEPTH_M,
  HOVER_POD_MIN_DEPTH_M,
  PORTAL_KEEP_OUT_RADIUS_M,
  SURFACE_SNAP_MAX_RANGE_M,
  SURFACE_SNAP_MIN_RANGE_M,
  TURRET_FOOTPRINT_RADIUS_M,
  TURRET_MIN_SPACING_M,
  type Vec3,
} from '../src/content/turrets.ts';
import { createActionBus, type GameAction } from '../src/core/action-bus.ts';
import {
  buildRoomSurfaceFromLocalPolygon,
  createRoomSurfaceModel,
  makeSurfaceBasisMatrix,
  type RoomSurface,
} from '../src/mr/room-scan.ts';
import { createVirtualRoomModel } from '../src/mr/virtual-room.ts';
import {
  applyQuaternionToVec3,
  checkFootprintWithinPolygon,
  clampHoverPodDepth,
  computeHoverPodPose,
  computeSurfaceMountPose,
  inspectFootprintWithinPolygon,
  stepHoverPodDepth,
  validateTurretPlacement,
} from '../src/sim/placement-rules.ts';
import type { CoreAnchor, PortalAnchor } from '../src/xr/calibration.ts';
import {
  createTurretGhostPreview,
  createTurretPlacementController,
  GHOST_COLOR_INVALID,
  GHOST_COLOR_SURFACE_VALID,
} from '../src/xr/placement.ts';

function makeRectSurface(params: {
  id: string;
  semanticLabel: string;
  orientation?: XRPlaneOrientation;
  center: THREE.Vector3;
  normal: THREE.Vector3;
  right?: THREE.Vector3;
  width: number;
  depth: number;
}): RoomSurface {
  const hw = params.width / 2;
  const hd = params.depth / 2;
  const worldMatrix = makeSurfaceBasisMatrix(params.center, params.normal, params.right);
  return buildRoomSurfaceFromLocalPolygon({
    id: params.id,
    source: 'plane',
    semanticLabel: params.semanticLabel,
    orientation: params.orientation,
    revision: 1,
    lastChangedTime: 100,
    worldMatrix,
    localPolygon: [
      { x: -hw, z: -hd },
      { x: hw, z: -hd },
      { x: hw, z: hd },
      { x: -hw, z: hd },
    ],
  });
}

function makeXrPose(
  position: THREE.Vector3,
  quaternion: THREE.Quaternion = new THREE.Quaternion(),
): XRPose {
  const matrix = new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1));
  return {
    transform: {
      position: { x: position.x, y: position.y, z: position.z, w: 1 } as DOMPointReadOnly,
      orientation: {
        x: quaternion.x,
        y: quaternion.y,
        z: quaternion.z,
        w: quaternion.w,
      } as DOMPointReadOnly,
      matrix: new Float32Array(matrix.elements),
      inverse: {} as XRRigidTransform,
    },
    emulatedPosition: false,
  };
}

describe('Controller rays and scanned room geometry', () => {
  it('uses transformed raw triangles before the fitted plane and blocks turret selection behind them', () => {
    const wall = makeRectSurface({
      id: 'back-wall',
      semanticLabel: 'wall',
      orientation: 'vertical',
      center: new THREE.Vector3(0, 1.4, -3),
      normal: new THREE.Vector3(0, 0, 1),
      right: new THREE.Vector3(1, 0, 0),
      width: 4.8,
      depth: 2.8,
    });
    const scan: RoomSurface = {
      ...wall,
      id: 'unlabeled-mesh',
      kind: 'other',
      source: 'mesh',
      semanticLabel: null,
      meshWorldMatrix: new THREE.Matrix4().makeTranslation(0.08, 0, -1.4),
      meshVertices: new Float32Array([-0.3, 0.6, 0, 0.3, 0.6, 0, 0.3, 1.8, 0, -0.3, 1.8, 0]),
      meshIndices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      bounds: new THREE.Box3(
        new THREE.Vector3(-0.22, 0.6, -1.4),
        new THREE.Vector3(0.38, 1.8, -1.4),
      ),
    };
    const roomModel = createRoomSurfaceModel({
      initialMode: 'virtual-fallback',
      virtualSurfacesProvider: () => [wall, scan],
    });
    const controller = createTurretPlacementController({
      roomModel,
      initialCredits: 1000,
      initialActive: false,
    });
    const direction = { x: 0, y: 0, z: -1 };
    const origin = { x: 0, y: 1.1, z: 0 };
    expect(controller.raycastRoomDistance(origin, direction)).toBeCloseTo(1.4);
    expect(controller.raycastRoomDistance({ ...origin, x: 0.9 }, direction)).toBeCloseTo(3);
    const obscured = controller.placeTurret({
      kind: 'autocannon',
      surfaceId: wall.id,
      position: { ...origin, z: -3 },
      normal: { x: 0, y: 0, z: 1 },
    });
    const visible = controller.placeTurret({
      kind: 'autocannon',
      surfaceId: wall.id,
      position: { x: 0.9, y: 1.1, z: -3 },
      normal: { x: 0, y: 0, z: 1 },
    });
    expect(obscured).not.toBeNull();
    expect(visible).not.toBeNull();
    expect(controller.pickPlacedTurret(origin, direction)).toBeNull();
    expect(controller.pickPlacedTurret({ ...origin, x: 0.9 }, direction)?.id).toBe(visible?.id);
    controller.dispose();
  });
});

describe('src/sim/placement-rules.ts pure TypeScript boundary', () => {
  it('contains zero Three.js imports or THREE namespace references', () => {
    const filePath = resolve(__dirname, '../src/sim/placement-rules.ts');
    const source = readFileSync(filePath, 'utf8');
    // Strip comments before checking for imports/usages
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(codeOnly).not.toMatch(/from\s+['"]three['"]/);
    expect(codeOnly).not.toMatch(/import\s*\(\s*['"]three['"]\s*\)/);
    expect(codeOnly).not.toMatch(/\bTHREE\b/);
  });
});

describe('Surface-normal mount alignment (floor, table, walls, and tilted planes)', () => {
  it('previews and commits mounts on the room-facing sides of reversed floor and wall scans', () => {
    const floor = makeRectSurface({
      id: 'downward-floor',
      semanticLabel: 'floor',
      center: new THREE.Vector3(),
      normal: new THREE.Vector3(0, -1, 0),
      width: 5,
      depth: 5,
    });
    const wall = makeRectSurface({
      id: 'outward-wall',
      semanticLabel: 'wall',
      center: new THREE.Vector3(0, 1.4, -2),
      normal: new THREE.Vector3(0, 0, -1),
      width: 4,
      depth: 2.8,
    });
    const roomModel = createRoomSurfaceModel({
      initialMode: 'virtual-fallback',
      virtualSurfacesProvider: () => [floor, wall],
    });
    const placement = createTurretPlacementController({ roomModel, initialCredits: 1000 });
    const origin = { x: 0, y: 1.4, z: 0 };

    for (const [aim, surface, roomNormal] of [
      [{ x: 0, y: -1, z: 0 }, floor, new THREE.Vector3(0, 1, 0)],
      [{ x: 0, y: 0, z: -1 }, wall, new THREE.Vector3(0, 0, 1)],
    ] as const) {
      placement.beginBuild('autocannon');
      const preview = placement.updateFromRay(origin, aim);
      expect(preview.valid).toBe(true);
      expect(preview.surfaceId).toBe(surface.id);
      expect(roomNormal.dot(new THREE.Vector3().copy(preview.pose.normal))).toBeCloseTo(1);
      const placed = placement.confirmPlacement('xr');
      if (!placed) throw new Error('Expected a committed surface mount');
      expect(
        roomNormal.dot(new THREE.Vector3(0, 1, 0).applyQuaternion(placed.visual.quaternion)),
      ).toBeCloseTo(1);
      expect(placed.surfaceAnchor?.tracked).toBe(true);
    }
    placement.dispose();
  });

  it('aligns surface-clamp local +Y axis exactly to floor, table, and wall outward normals', () => {
    const cases: Array<{ label: string; normal: Vec3; position: Vec3 }> = [
      { label: 'floor (+Y)', normal: { x: 0, y: 1, z: 0 }, position: { x: 0.4, y: 0, z: -1.1 } },
      {
        label: 'table (+Y at 0.78m)',
        normal: { x: 0, y: 1, z: 0 },
        position: { x: 0.1, y: 0.78, z: -0.2 },
      },
      {
        label: 'north wall (+Z)',
        normal: { x: 0, y: 0, z: 1 },
        position: { x: -0.5, y: 1.4, z: -2.1 },
      },
      {
        label: 'south wall (-Z)',
        normal: { x: 0, y: 0, z: -1 },
        position: { x: 0.3, y: 1.5, z: 2.1 },
      },
      {
        label: 'west wall (+X)',
        normal: { x: 1, y: 0, z: 0 },
        position: { x: -2.4, y: 1.3, z: -0.4 },
      },
      {
        label: 'east wall (-X)',
        normal: { x: -1, y: 0, z: 0 },
        position: { x: 2.4, y: 1.3, z: 0.2 },
      },
      {
        label: 'angled wall',
        normal: { x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 },
        position: { x: -1.5, y: 1.2, z: -1.5 },
      },
    ];

    for (const c of cases) {
      const pose = computeSurfaceMountPose({
        position: c.position,
        normal: c.normal,
      });

      expect(pose.mountProfile).toBe('surface-clamp');
      expect(pose.up.x).toBeCloseTo(c.normal.x, 5);
      expect(pose.up.y).toBeCloseTo(c.normal.y, 5);
      expect(pose.up.z).toBeCloseTo(c.normal.z, 5);

      // Verify rotating local +Y (0, 1, 0) by pose.quaternion yields the exact surface normal
      const rotatedUp = applyQuaternionToVec3({ x: 0, y: 1, z: 0 }, pose.quaternion);
      expect(rotatedUp.x).toBeCloseTo(c.normal.x, 5);
      expect(rotatedUp.y).toBeCloseTo(c.normal.y, 5);
      expect(rotatedUp.z).toBeCloseTo(c.normal.z, 5);

      // Verify right-handed orthonormal basis
      const rightDotUp =
        pose.right.x * pose.up.x + pose.right.y * pose.up.y + pose.right.z * pose.up.z;
      const forwardDotUp =
        pose.forward.x * pose.up.x + pose.forward.y * pose.up.y + pose.forward.z * pose.up.z;
      expect(rightDotUp).toBeCloseTo(0, 5);
      expect(forwardDotUp).toBeCloseTo(0, 5);
    }
  });

  it('keeps mid-air hover-pod orientation strictly upright along world +Y', () => {
    const hoverPose = computeHoverPodPose(
      { x: 0, y: 1.2, z: 1.45 },
      { x: -0.3, y: -0.4, z: -0.866 },
      2.2,
    );
    expect(hoverPose.mountProfile).toBe('hover-pod');
    expect(hoverPose.depthM).toBeCloseTo(2.2, 5);
    expect(hoverPose.up).toEqual({ x: 0, y: 1, z: 0 });
    expect(hoverPose.normal).toEqual({ x: 0, y: 1, z: 0 });

    const rotatedUp = applyQuaternionToVec3({ x: 0, y: 1, z: 0 }, hoverPose.quaternion);
    expect(rotatedUp.x).toBeCloseTo(0, 5);
    expect(rotatedUp.y).toBeCloseTo(1, 5);
    expect(rotatedUp.z).toBeCloseTo(0, 5);
  });
});

describe('Full-footprint overhang check (0.16 m radius, 8 perimeter samples + center)', () => {
  const shelfSurface = makeRectSurface({
    id: 'shelf-table',
    semanticLabel: 'table',
    center: new THREE.Vector3(0, 0.78, 0),
    normal: new THREE.Vector3(0, 1, 0),
    width: 1.0, // spans x in [-0.5, +0.5]
    depth: 0.6, // spans z in [-0.3, +0.3]
  });

  const wallSurface = makeRectSurface({
    id: 'north-wall',
    semanticLabel: 'wall',
    orientation: 'vertical',
    center: new THREE.Vector3(0, 1.4, -2.1),
    normal: new THREE.Vector3(0, 0, 1),
    right: new THREE.Vector3(1, 0, 0),
    width: 2.0, // spans x in [-1.0, +1.0]
    depth: 2.0, // spans y in [0.4, 2.4]
  });

  it('accepts a turret whose full 0.16 m circular footprint sits inside the table/shelf boundary', () => {
    expect(TURRET_FOOTPRINT_RADIUS_M).toBe(0.16);

    // Center at (0.30, 0.78, 0.10): 0.20 m from nearest X edge (0.50) and 0.20 m from nearest Z edge (0.30)
    const centerOnShelf = { x: 0.3, y: 0.78, z: 0.1 };
    const inspection = inspectFootprintWithinPolygon(centerOnShelf, shelfSurface);
    expect(inspection.within).toBe(true);
    expect(inspection.centerInside).toBe(true);
    expect(inspection.testedSampleCount).toBe(9); // center + 8 perimeter points
    expect(inspection.insideSampleCount).toBe(9);
    expect(inspection.overhangingSamplePoints2D).toHaveLength(0);
    expect(checkFootprintWithinPolygon(centerOnShelf, shelfSurface)).toBe(true);

    const validation = validateTurretPlacement({
      kind: 'autocannon',
      mountProfile: 'surface-clamp',
      position: centerOnShelf,
      surface: shelfSurface,
    });
    expect(validation.valid).toBe(true);
    expect(validation.reason).toBeNull();
  });

  it('rejects with OVERHANG when the center is on the shelf/table but the 0.16 m base edge hangs off', () => {
    // Center at x = 0.42 m (inside [-0.5, +0.5], 0.08 m from the +0.50 m shelf edge < 0.16 m footprint radius)
    const overhangingEdgePoint = { x: 0.42, y: 0.78, z: 0 };
    const inspection = inspectFootprintWithinPolygon(overhangingEdgePoint, shelfSurface);

    expect(inspection.centerInside).toBe(true);
    expect(inspection.within).toBe(false);
    expect(inspection.overhangingSamplePoints2D.length).toBeGreaterThan(0);
    expect(checkFootprintWithinPolygon(overhangingEdgePoint, shelfSurface)).toBe(false);

    const result = validateTurretPlacement({
      kind: 'autocannon',
      mountProfile: 'surface-clamp',
      position: overhangingEdgePoint,
      surface: shelfSurface,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('OVERHANG');
    expect(result.reasonLabel).toBe('OVERHANG');
  });

  it('enforces full 0.16 m footprint containment on vertical walls as well as horizontal surfaces', () => {
    // Valid wall center well inside [-1.0, 1.0] x [0.4, 2.4]
    const validWallPoint = { x: 0.0, y: 1.4, z: -2.1 };
    expect(checkFootprintWithinPolygon(validWallPoint, wallSurface)).toBe(true);

    // Wall point 0.07 m from right edge (x = 0.93 on [-1.0, 1.0] wall -> overhangs right edge)
    const overhangingWallPoint = { x: 0.93, y: 1.4, z: -2.1 };
    expect(checkFootprintWithinPolygon(overhangingWallPoint, wallSurface)).toBe(false);

    const wallValidation = validateTurretPlacement({
      kind: 'rail-sniper',
      mountProfile: 'surface-clamp',
      position: overhangingWallPoint,
      surface: wallSurface,
    });
    expect(wallValidation.valid).toBe(false);
    expect(wallValidation.reason).toBe('OVERHANG');
  });
});

describe('Thumbstick push/pull hover-pod depth clamping (0.8–5.0 m) & surface re-snap', () => {
  it('clamps hover-pod depth strictly within [0.8, 5.0] m under extreme thumbstick push and pull', () => {
    expect(HOVER_POD_MIN_DEPTH_M).toBe(0.8);
    expect(HOVER_POD_MAX_DEPTH_M).toBe(5.0);

    expect(clampHoverPodDepth(0.1)).toBe(0.8);
    expect(clampHoverPodDepth(0.8)).toBe(0.8);
    expect(clampHoverPodDepth(2.5)).toBe(2.5);
    expect(clampHoverPodDepth(5.0)).toBe(5.0);
    expect(clampHoverPodDepth(9.4)).toBe(5.0);

    // Deadzone filtering: stick within [-0.2, 0.2] leaves depth unchanged
    expect(stepHoverPodDepth(2.0, 0.15, 0.5)).toBeCloseTo(2.0, 5);
    expect(stepHoverPodDepth(2.0, -0.19, 0.5)).toBeCloseTo(2.0, 5);

    // Pushing forward (+1.0) over 5 seconds clamps strictly at 5.0 m
    let depth = 1.8;
    for (let i = 0; i < 30; i += 1) {
      depth = stepHoverPodDepth(depth, 1.0, 0.1);
      expect(depth).toBeGreaterThanOrEqual(HOVER_POD_MIN_DEPTH_M);
      expect(depth).toBeLessThanOrEqual(HOVER_POD_MAX_DEPTH_M);
    }
    expect(depth).toBeCloseTo(HOVER_POD_MAX_DEPTH_M, 5);

    // Pulling backward (-1.0) over 5 seconds clamps strictly at 0.8 m
    for (let i = 0; i < 35; i += 1) {
      depth = stepHoverPodDepth(depth, -1.0, 0.1);
      expect(depth).toBeGreaterThanOrEqual(HOVER_POD_MIN_DEPTH_M);
      expect(depth).toBeLessThanOrEqual(HOVER_POD_MAX_DEPTH_M);
    }
    expect(depth).toBeCloseTo(HOVER_POD_MIN_DEPTH_M, 5);
  });

  it('detaches from surface-clamp into hover-pod on stick push/pull and re-snaps cleanly on toggle or surface change', () => {
    const roomModel = createVirtualRoomModel();
    const scene = new THREE.Scene();
    const controller = createTurretPlacementController({
      roomModel,
      scene,
      initialCredits: 1000,
    });

    const rayOrigin: Vec3 = { x: 0, y: 1.35, z: 1.45 };
    // Aim down at the central tactical table (0, 0.78, 0)
    const toTable: Vec3 = { x: 0, y: 0.78 - 1.35, z: -1.45 };

    // 1. Neutral stick snaps flush to the table surface
    const snapResult = controller.updateFromRay(rayOrigin, toTable, { stickY: 0 });
    expect(snapResult.valid).toBe(true);
    expect(snapResult.mountProfile).toBe('surface-clamp');
    expect(snapResult.surfaceKind).toBe('table');
    expect(controller.ghost.state.colorHex).toBe(GHOST_COLOR_SURFACE_VALID);
    expect(controller.ghost.clampMountGroup.visible).toBe(true);
    expect(controller.ghost.hoverPodGroup.visible).toBe(false);

    // 2. Push thumbstick forward (+0.9) -> detaches into mid-air hover-pod mode
    const hoverResult = controller.updateFromRay(rayOrigin, toTable, {
      stickY: 0.9,
      dtSec: 0.25,
    });
    expect(hoverResult.reason).toBe('BLOCKED_BY_SURFACE');
    expect(controller.confirmPlacement()).toBeNull();
    expect(hoverResult.mountProfile).toBe('hover-pod');
    expect(controller.mountMode).toBe('hover-pod');
    expect(controller.hoverDepthM).toBeGreaterThanOrEqual(HOVER_POD_MIN_DEPTH_M);
    expect(controller.hoverDepthM).toBeLessThanOrEqual(HOVER_POD_MAX_DEPTH_M);
    expect(controller.ghost.state.colorHex).toBe(GHOST_COLOR_INVALID);
    expect(controller.ghost.clampMountGroup.visible).toBe(false);
    expect(controller.ghost.hoverPodGroup.visible).toBe(true);

    // 3. Push beyond max depth and pull below min depth -> remains clamped in [0.8, 5.0] m
    controller.updateFromRay(rayOrigin, toTable, { stickY: 1.0, dtSec: 10.0 });
    expect(controller.hoverDepthM).toBeCloseTo(HOVER_POD_MAX_DEPTH_M, 5);
    controller.updateFromRay(rayOrigin, toTable, { stickY: -1.0, dtSec: 10.0 });
    expect(controller.hoverDepthM).toBeCloseTo(HOVER_POD_MIN_DEPTH_M, 5);

    // 4. Aim onto the north wall with neutral stick -> auto re-snaps to surface-clamp on wall
    const toNorthWall: Vec3 = { x: 0.4, y: 0.1, z: -3.55 };
    const wallSnapResult = controller.updateFromRay(rayOrigin, toNorthWall, { stickY: 0 });
    expect(wallSnapResult.mountProfile).toBe('surface-clamp');
    expect(wallSnapResult.surfaceKind).toBe('wall');
    expect(wallSnapResult.pose.normal.z).toBeCloseTo(1, 5);
    expect(controller.ghost.state.colorHex).toBe(GHOST_COLOR_SURFACE_VALID);
    expect(controller.ghost.clampMountGroup.visible).toBe(true);
    expect(controller.ghost.hoverPodGroup.visible).toBe(false);

    // 5. Detach again and use explicit resnapToSurface() / B-Y toggle
    controller.updateFromRay(rayOrigin, toNorthWall, { stickY: -0.85, dtSec: 0.2 });
    expect(controller.mountMode).toBe('hover-pod');
    controller.resnapToSurface();
    expect(controller.mountMode).toBe('surface-clamp');
    expect(controller.ghost.clampMountGroup.visible).toBe(true);

    controller.dispose();
  });
});

describe('Placement constraints: 0.35 m spacing, 14-turret hard cap, Core & Portal keep-out, and economy', () => {
  const floorSurface = makeRectSurface({
    id: 'floor-main',
    semanticLabel: 'floor',
    center: new THREE.Vector3(0, 0, 0),
    normal: new THREE.Vector3(0, 1, 0),
    width: 6.0,
    depth: 6.0,
  });

  const coreAnchor: CoreAnchor = {
    position: { x: 0, y: 0, z: 0 },
    yaw: 0,
    surfaceId: 'floor-main',
    surfaceKind: 'floor',
    radius: CORE_KEEP_OUT_RADIUS_M,
  };

  const portalAnchors: readonly PortalAnchor[] = [
    {
      id: 'portal-north',
      position: { x: 0, y: 0.2, z: -2.2 },
      normal: { x: 0, y: 0, z: 1 },
      width: 1.1,
      height: 1.5,
      surfaceId: 'wall-north',
      hostKind: 'wall',
      distanceFromCore: 2.2,
    },
  ];

  it('rejects placements within the 0.55 m Core keep-out zone (CORE_ZONE -> "CORE ZONE")', () => {
    expect(CORE_KEEP_OUT_RADIUS_M).toBe(0.55);

    const insideCore = validateTurretPlacement(
      {
        kind: 'autocannon',
        mountProfile: 'surface-clamp',
        position: { x: 0.4, y: 0, z: 0 }, // 0.40 m < 0.55 m
        surface: floorSurface,
      },
      { coreAnchor, portalAnchors },
    );
    expect(insideCore.valid).toBe(false);
    expect(insideCore.reason).toBe('CORE_ZONE');
    expect(insideCore.reasonLabel).toBe('CORE ZONE');

    const outsideCore = validateTurretPlacement(
      {
        kind: 'autocannon',
        mountProfile: 'surface-clamp',
        position: { x: 0.65, y: 0, z: 0 }, // 0.65 m >= 0.55 m
        surface: floorSurface,
      },
      { coreAnchor, portalAnchors },
    );
    expect(outsideCore.valid).toBe(true);
  });

  it('rejects placements within the 0.65 m Portal keep-out zone (PORTAL_ZONE -> "PORTAL ZONE")', () => {
    expect(PORTAL_KEEP_OUT_RADIUS_M).toBe(0.65);

    const insidePortal = validateTurretPlacement(
      {
        kind: 'cryo-arc',
        mountProfile: 'surface-clamp',
        position: { x: 0.2, y: 0, z: -2.0 }, // distance to (0, 0.2, -2.2) is ~0.346 m < 0.65 m
        surface: floorSurface,
      },
      { coreAnchor, portalAnchors },
    );
    expect(insidePortal.valid).toBe(false);
    expect(insidePortal.reason).toBe('PORTAL_ZONE');
    expect(insidePortal.reasonLabel).toBe('PORTAL ZONE');
  });

  it('enforces the 0.35 m minimum center-to-center spacing (TOO_CLOSE -> "TOO CLOSE")', () => {
    expect(TURRET_MIN_SPACING_M).toBe(0.35);

    const existing = [{ id: 'turret-1', position: { x: 1.0, y: 0, z: -1.0 } }];

    const tooClose = validateTurretPlacement(
      {
        kind: 'autocannon',
        mountProfile: 'surface-clamp',
        position: { x: 1.25, y: 0, z: -1.0 }, // 0.25 m < 0.35 m
        surface: floorSurface,
      },
      { existingTurrets: existing, coreAnchor },
    );
    expect(tooClose.valid).toBe(false);
    expect(tooClose.reason).toBe('TOO_CLOSE');
    expect(tooClose.reasonLabel).toBe('TOO CLOSE');

    const wellSpaced = validateTurretPlacement(
      {
        kind: 'autocannon',
        mountProfile: 'surface-clamp',
        position: { x: 1.38, y: 0, z: -1.0 }, // 0.38 m >= 0.35 m
        surface: floorSurface,
      },
      { existingTurrets: existing, coreAnchor },
    );
    expect(wellSpaced.valid).toBe(true);
  });

  it('enforces the 14-turret hard cap (CAP_REACHED -> "CAP 14/14") and updates ghost SDF label', () => {
    expect(HARD_TURRET_CAP).toBe(14);

    const roomModel = createVirtualRoomModel();
    const actionBus = createActionBus();
    const dispatchedActions: GameAction[] = [];
    actionBus.onAny((action) => dispatchedActions.push(action));

    const controller = createTurretPlacementController({
      roomModel,
      actionBus,
      initialCredits: 5000,
    });

    const floor = roomModel.getSurface('virtual-floor');
    expect(floor).toBeDefined();
    if (!floor) throw new Error('Missing virtual-floor');

    // Place 14 turrets on a well-spaced grid across the 4.8 m x 4.2 m floor
    const gridCoords: Array<[number, number]> = [
      [-1.8, -1.5],
      [-1.2, -1.5],
      [-0.6, -1.5],
      [0.0, -1.5],
      [0.6, -1.5],
      [1.2, -1.5],
      [1.8, -1.5],
      [-1.8, 1.5],
      [-1.2, 1.5],
      [-0.6, 1.5],
      [0.0, 1.5],
      [0.6, 1.5],
      [1.2, 1.5],
      [1.8, 1.5],
    ];

    for (let i = 0; i < HARD_TURRET_CAP; i += 1) {
      const [x, z] = gridCoords[i] as [number, number];
      const placed = controller.placeTurret({
        kind: 'autocannon',
        mountProfile: 'surface-clamp',
        position: { x, y: 0, z },
        surface: floor,
      });
      expect(placed).not.toBeNull();
    }

    expect(controller.turretCount).toBe(14);
    expect(dispatchedActions.filter((a) => a.type === 'turret/build')).toHaveLength(14);

    // Attempt to place a 15th turret at a valid open location
    const fifteenthAttempt = controller.placeTurret({
      kind: 'autocannon',
      mountProfile: 'surface-clamp',
      position: { x: -1.8, y: 0, z: 0 },
      surface: floor,
    });
    expect(fifteenthAttempt).toBeNull();
    expect(controller.turretCount).toBe(14);
    expect(controller.lastValidation?.valid).toBe(false);
    expect(controller.lastValidation?.reason).toBe('CAP_REACHED');
    expect(controller.lastValidation?.reasonLabel).toBe('CAP 14/14');
    expect(controller.ghost.state.colorHex).toBe(GHOST_COLOR_INVALID);
    expect(controller.ghost.state.reasonLabelText).toBe('CAP 14/14');
    expect(controller.ghost.reasonLabel.visible).toBe(true);

    // Selling 1 turret frees a slot and refunds 50% credits
    const firstTurret = controller.placedTurrets[0];
    if (!firstTurret) throw new Error('Expected first turret');
    const creditsBeforeSell = controller.credits ?? 0;
    const refund = controller.sellTurret(firstTurret.id);
    expect(refund).toBe(100);
    expect(controller.credits).toBe(creditsBeforeSell + 100);
    expect(controller.turretCount).toBe(13);

    // Now the 14th slot can be filled again
    const replacement = controller.placeTurret({
      kind: 'plasma-mortar',
      mountProfile: 'surface-clamp',
      position: { x: -1.8, y: 0, z: 0 },
      surface: floor,
    });
    expect(replacement).not.toBeNull();
    expect(controller.turretCount).toBe(14);

    controller.dispose();
  });

  it('accepts ceiling mounts, including reversed tracked normals, while rejecting credit and range failures', () => {
    const ceilingSurface = makeRectSurface({
      id: 'ceiling-main',
      semanticLabel: 'ceiling',
      center: new THREE.Vector3(0, 2.8, 0),
      normal: new THREE.Vector3(0, -1, 0),
      width: 4.8,
      depth: 4.2,
    });

    const ceilingCheck = validateTurretPlacement({
      kind: 'autocannon',
      mountProfile: 'surface-clamp',
      position: { x: 0, y: 2.8, z: -1.0 },
      surface: ceilingSurface,
    });
    expect(ceilingCheck.valid).toBe(true);
    expect(ceilingCheck.surfaceKind).toBe('ceiling');
    expect(ceilingCheck.pose.normal.y).toBeCloseTo(-1);

    const reversedCeilingCheck = validateTurretPlacement({
      kind: 'autocannon',
      mountProfile: 'surface-clamp',
      position: { x: 0, y: 2.8, z: -1.0 },
      surface: { ...ceilingSurface, normal: new THREE.Vector3(0, 1, 0) },
      surfaceKind: 'ceiling',
    });
    expect(reversedCeilingCheck.valid).toBe(true);
    expect(reversedCeilingCheck.surfaceKind).toBe('ceiling');
    expect(reversedCeilingCheck.pose.normal.y).toBeCloseTo(-1);

    const tooFarCheck = validateTurretPlacement({
      kind: 'autocannon',
      mountProfile: 'surface-clamp',
      position: { x: 0, y: 0, z: -2.0 },
      surface: floorSurface,
      rayDistanceM: SURFACE_SNAP_MAX_RANGE_M + 0.5,
    });
    expect(tooFarCheck.valid).toBe(false);
    expect(tooFarCheck.reason).toBe('OUT_OF_RANGE');

    const tooCloseRayCheck = validateTurretPlacement({
      kind: 'autocannon',
      mountProfile: 'surface-clamp',
      position: { x: 0, y: 0, z: -1.0 },
      surface: floorSurface,
      rayDistanceM: SURFACE_SNAP_MIN_RANGE_M - 0.1,
    });
    expect(tooCloseRayCheck.valid).toBe(false);
    expect(tooCloseRayCheck.reason).toBe('OUT_OF_RANGE');

    const noCreditsCheck = validateTurretPlacement(
      {
        kind: 'rail-sniper', // costs 300
        mountProfile: 'surface-clamp',
        position: { x: 1.5, y: 0, z: -1.5 },
        surface: floorSurface,
      },
      { credits: 90 },
    );
    expect(noCreditsCheck.valid).toBe(false);
    expect(noCreditsCheck.reason).toBe('INSUFFICIENT_CREDITS');
    expect(noCreditsCheck.reasonLabel).toBe('NO CREDITS');
  });
});

describe('Surface-relative & Core-relative anchor tracking sync and XR controller integration', () => {
  it('moves placed surface turret visual and collider together on RoomSurfaceModel refinement and hides/restores on tracking loss', () => {
    const roomModel = createRoomSurfaceModel({ emptyGraceMs: 5000 });
    const referenceSpace = {} as XRReferenceSpace;

    const tablePlane: XRPlane = {
      orientation: 'horizontal',
      planeSpace: {} as XRSpace,
      semanticLabel: 'table',
      polygon: [
        { x: -0.6, y: 0, z: -0.4, w: 1 } as DOMPointReadOnly,
        { x: 0.6, y: 0, z: -0.4, w: 1 } as DOMPointReadOnly,
        { x: 0.6, y: 0, z: 0.4, w: 1 } as DOMPointReadOnly,
        { x: -0.6, y: 0, z: 0.4, w: 1 } as DOMPointReadOnly,
      ],
      lastChangedTime: 100,
    };

    let currentTablePose: XRPose | null = makeXrPose(new THREE.Vector3(0, 0.75, -1.4));
    let detectedPlanes = new Set<XRPlane>([tablePlane]);

    const fakeFrame = {
      session: {
        enabledFeatures: ['plane-detection', 'mesh-detection'],
      },
      get detectedPlanes() {
        return detectedPlanes;
      },
      detectedMeshes: new Set<XRMesh>(),
      getPose(space: XRSpace) {
        if (space === tablePlane.planeSpace) return currentTablePose;
        return null;
      },
    } as unknown as XRFrame;

    roomModel.updateFromFrame(fakeFrame, referenceSpace, { nowMs: 100 });
    const tableSurface = roomModel.surfaces[0];
    if (!tableSurface) throw new Error('Expected tableSurface');
    expect(tableSurface.kind).toBe('table');

    const controller = createTurretPlacementController({
      roomModel,
      initialCredits: 1000,
    });

    // Place a turret at (+0.2, 0.75, -1.3) on the table (offset (+0.2, 0, +0.1) in table local space)
    const turret = controller.placeTurret({
      kind: 'autocannon',
      mountProfile: 'surface-clamp',
      position: { x: 0.2, y: 0.75, z: -1.3 },
      surface: tableSurface,
    });
    expect(turret).not.toBeNull();
    if (!turret) throw new Error('Expected placed turret');
    expect(turret.surfaceAnchor).not.toBeNull();
    expect(turret.tracked).toBe(true);
    expect(turret.visible).toBe(true);
    expect(turret.visual.position.x).toBeCloseTo(0.2, 5);
    expect(turret.visual.position.y).toBeCloseTo(0.75, 5);
    expect(turret.visual.position.z).toBeCloseTo(-1.3, 5);
    expect(turret.collider.position.x).toBeCloseTo(0.2, 5);
    expect(turret.collider.position.y).toBeCloseTo(0.75, 5);
    expect(turret.collider.position.z).toBeCloseTo(-1.3, 5);

    // 1. Simulate Quest tracking refinement shifting the table by (+0.05, +0.02, -0.04)
    tablePlane.lastChangedTime = 200;
    currentTablePose = makeXrPose(new THREE.Vector3(0.05, 0.77, -1.44));
    roomModel.updateFromFrame(fakeFrame, referenceSpace, { nowMs: 200 });

    expect(turret.position.x).toBeCloseTo(0.25, 5);
    expect(turret.position.y).toBeCloseTo(0.77, 5);
    expect(turret.position.z).toBeCloseTo(-1.34, 5);
    expect(turret.visual.position.x).toBeCloseTo(0.25, 5);
    expect(turret.visual.position.y).toBeCloseTo(0.77, 5);
    expect(turret.visual.position.z).toBeCloseTo(-1.34, 5);
    expect(turret.collider.position.x).toBeCloseTo(0.25, 5);
    expect(turret.collider.position.y).toBeCloseTo(0.77, 5);
    expect(turret.collider.position.z).toBeCloseTo(-1.34, 5);

    // 2. Simulate temporary tracking loss (plane disappears from frame) -> visual & collider hide together
    detectedPlanes = new Set<XRPlane>();
    roomModel.updateFromFrame(fakeFrame, referenceSpace, { nowMs: 300 });
    expect(turret.tracked).toBe(false);
    expect(turret.visible).toBe(false);
    expect(turret.visual.visible).toBe(false);
    expect(turret.collider.visible).toBe(false);

    // 3. Simulate tracking restoration -> visual & collider restore from the exact same local offset
    detectedPlanes = new Set<XRPlane>([tablePlane]);
    roomModel.updateFromFrame(fakeFrame, referenceSpace, { nowMs: 400 });
    expect(turret.tracked).toBe(true);
    expect(turret.visible).toBe(true);
    expect(turret.visual.visible).toBe(true);
    expect(turret.collider.visible).toBe(true);
    expect(turret.visual.position.x).toBeCloseTo(0.25, 5);
    expect(turret.collider.position.x).toBeCloseTo(0.25, 5);

    controller.dispose();
  });

  it('anchors mid-air hover-pod turrets relative to the CoreAnchor frame and updates visual + collider together', () => {
    const roomModel = createVirtualRoomModel();
    const initialCore: CoreAnchor = {
      position: { x: 0, y: 0.78, z: 0 },
      yaw: 0,
      surfaceId: 'virtual-table-central',
      surfaceKind: 'table',
      radius: CORE_KEEP_OUT_RADIUS_M,
    };

    const controller = createTurretPlacementController({
      roomModel,
      coreAnchor: initialCore,
      initialCredits: 1000,
    });

    const hoverTurret = controller.placeTurret({
      kind: 'rail-sniper',
      mountProfile: 'hover-pod',
      position: { x: 0.8, y: 1.5, z: -0.9 },
      depthM: 1.8,
    });
    expect(hoverTurret).not.toBeNull();
    if (!hoverTurret) throw new Error('Expected hoverTurret');
    expect(hoverTurret.mountProfile).toBe('hover-pod');
    expect(hoverTurret.coreLocalOffset).toEqual({
      x: 0.8,
      y: 1.5 - 0.78,
      z: -0.9,
    });

    // Shift Core anchor by (+0.2, 0, -0.1) -> hover-pod visual and collider move together
    controller.setCoreAnchor({
      ...initialCore,
      position: { x: 0.2, y: 0.78, z: -0.1 },
    });

    expect(hoverTurret.position.x).toBeCloseTo(1.0, 5);
    expect(hoverTurret.position.y).toBeCloseTo(1.5, 5);
    expect(hoverTurret.position.z).toBeCloseTo(-1.0, 5);
    expect(hoverTurret.visual.position.x).toBeCloseTo(1.0, 5);
    expect(hoverTurret.collider.position.x).toBeCloseTo(1.0, 5);

    controller.dispose();
  });

  it('drives XR controller laser placement via updateFromXrFrame and suppresses trigger while grip is held', () => {
    const roomModel = createVirtualRoomModel();
    const scene = new THREE.Scene();
    const controller = createTurretPlacementController({
      roomModel,
      scene,
      initialCredits: 1000,
    });

    const targetRaySpace = {} as XRSpace;
    const referenceSpace = {} as XRReferenceSpace;

    let triggerPressed = false;
    let gripPressed = false;
    let stickY = 0;

    const rightSource = {
      handedness: 'right',
      targetRayMode: 'tracked-pointer',
      targetRaySpace,
      get gamepad() {
        return {
          axes: [0, 0, 0, stickY],
          buttons: [
            { pressed: triggerPressed, touched: triggerPressed, value: triggerPressed ? 1 : 0 },
            { pressed: gripPressed, touched: gripPressed, value: gripPressed ? 1 : 0 },
            { pressed: false, touched: false, value: 0 },
            { pressed: false, touched: false, value: 0 },
            { pressed: false, touched: false, value: 0 },
            { pressed: false, touched: false, value: 0 },
          ],
        } as unknown as Gamepad;
      },
    } as unknown as XRInputSource;

    // Controller at (0, 1.35, 1.45) pitched down 25 deg aiming at the central table
    const controllerQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.42, 0, 0, 'YXZ'));
    const controllerPose = makeXrPose(new THREE.Vector3(0, 1.35, 1.45), controllerQuat);

    const xrFrame = {
      session: {
        inputSources: [rightSource],
      },
      getPose(space: XRSpace) {
        if (space === targetRaySpace) return controllerPose;
        return null;
      },
    } as unknown as XRFrame;

    // Frame 1: Idle hover on table
    const v1 = controller.updateFromXrFrame(xrFrame, referenceSpace, 1 / 72);
    expect(v1?.valid).toBe(true);
    expect(v1?.mountProfile).toBe('surface-clamp');
    expect(controller.turretCount).toBe(0);

    // A panel/menu hit owns the aiming ray for that frame. Hide the stale
    // placement preview and rejection label, then restore placement on exit.
    const suppressed = controller.updateFromXrFrame(
      xrFrame,
      referenceSpace,
      1 / 72,
      (source) => source === rightSource,
    );
    expect(suppressed).toBeNull();
    expect(controller.ghost.group.visible).toBe(false);
    expect(controller.ghost.reasonLabel.visible).toBe(false);
    expect(controller.lastValidation).toBeNull();

    const restored = controller.updateFromXrFrame(xrFrame, referenceSpace, 1 / 72, () => false);
    expect(restored?.valid).toBe(true);
    expect(controller.ghost.group.visible).toBe(true);

    // Frame 2: Hold Grip + press Trigger -> must be suppressed per webxr.md Controller Contract
    gripPressed = true;
    triggerPressed = true;
    controller.updateFromXrFrame(xrFrame, referenceSpace, 1 / 72);
    controller.confirmXrPlacement(xrFrame, referenceSpace, rightSource);
    expect(controller.turretCount).toBe(0);

    // Frame 3: Release Grip & Trigger
    gripPressed = false;
    triggerPressed = false;
    controller.updateFromXrFrame(xrFrame, referenceSpace, 1 / 72);

    // Frame 4: Clean Trigger press without Grip -> places turret on table
    triggerPressed = true;
    controller.updateFromXrFrame(xrFrame, referenceSpace, 1 / 72);
    expect(controller.turretCount).toBe(0);
    controller.confirmXrPlacement(xrFrame, referenceSpace, rightSource);
    expect(controller.turretCount).toBe(1);
    expect(controller.placedTurrets[0]?.surfaceKind).toBe('table');

    // Frame 5: Push thumbstick forward in XR frame (gamepad axes[3] = -0.9) -> detaches to hover-pod
    triggerPressed = false;
    stickY = -0.9;
    const v5 = controller.updateFromXrFrame(xrFrame, referenceSpace, 0.25);
    expect(v5?.mountProfile).toBe('hover-pod');
    expect(controller.mountMode).toBe('hover-pod');

    const ghostPreview = createTurretGhostPreview();
    ghostPreview.dispose();
    controller.dispose();
  });

  it('keeps rejection reason labels upright and facing the viewer across floor, wall, and ceiling mounts', () => {
    const ghost = createTurretGhostPreview();
    const viewerPosition: Vec3 = { x: 0, y: 1.5, z: 1.8 };

    const mounts: Array<{
      readonly label: string;
      readonly pos: Vec3;
      readonly normal: Vec3;
      readonly quat: THREE.Quaternion;
    }> = [
      {
        label: 'floor facing away',
        pos: { x: 0, y: 0, z: -0.6 },
        normal: { x: 0, y: 1, z: 0 },
        quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI),
      },
      {
        label: 'wall mount',
        pos: { x: -1.8, y: 1.2, z: -0.4 },
        normal: { x: 1, y: 0, z: 0 },
        quat: new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(1, 0, 0),
        ),
      },
      {
        label: 'ceiling mount',
        pos: { x: 0, y: 2.6, z: -0.5 },
        normal: { x: 0, y: -1, z: 0 },
        quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI),
      },
    ];

    const worldQuat = new THREE.Quaternion();
    const labelPos = new THREE.Vector3();
    for (const mount of mounts) {
      ghost.update({
        kind: 'autocannon',
        tier: 'T1',
        visible: true,
        viewerPosition,
        validation: {
          valid: false,
          reason: 'TOO_CLOSE',
          reasons: ['TOO_CLOSE'],
          reasonLabel: 'TOO CLOSE',
          mountProfile: 'surface-clamp',
          surfaceId: 'surf',
          surfaceKind: 'wall',
          cost: 200,
          activeTurretCount: 1,
          hardTurretCap: 14,
          distanceM: 1.5,
          nearestTurretDistanceM: 0.2,
          coreDistanceM: 1.2,
          nearestPortalDistanceM: 2.0,
          footprint: null,
          pose: {
            mountProfile: 'surface-clamp',
            position: mount.pos,
            normal: mount.normal,
            right: { x: 1, y: 0, z: 0 },
            up: mount.normal,
            forward: { x: 0, y: 0, z: 1 },
            quaternion: {
              x: mount.quat.x,
              y: mount.quat.y,
              z: mount.quat.z,
              w: mount.quat.w,
            },
          },
        },
      });

      expect(ghost.reasonLabel.visible).toBe(true);
      ghost.reasonLabel.getWorldQuaternion(worldQuat);
      ghost.reasonLabel.getWorldPosition(labelPos);
      const labelUp = new THREE.Vector3(0, 1, 0).applyQuaternion(worldQuat);
      const labelFront = new THREE.Vector3(0, 0, 1).applyQuaternion(worldQuat);
      const toViewer = new THREE.Vector3(
        viewerPosition.x - labelPos.x,
        viewerPosition.y - labelPos.y,
        viewerPosition.z - labelPos.z,
      ).normalize();

      // Label is always upright (+Y dot world +Y > 0.7) and front-facing toward viewer (dot > 0.95)
      expect(labelUp.y, mount.label).toBeGreaterThan(0.7);
      expect(labelFront.dot(toViewer), mount.label).toBeGreaterThan(0.95);
    }

    ghost.dispose();
  });
});
