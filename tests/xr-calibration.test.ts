import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createActionBus } from '../src/core/action-bus.ts';
import { createGameStateMachine } from '../src/core/state.ts';
import {
  buildRoomSurfaceFromLocalPolygon,
  createRoomSurfaceModel,
  makeSurfaceBasisMatrix,
  type RoomSurface,
} from '../src/mr/room-scan.ts';
import { createVirtualRoomModel } from '../src/mr/virtual-room.ts';
import { createMemoryStorageAdapter, createSettingsStore } from '../src/settings/store.ts';
import {
  CORE_KEEP_OUT_RADIUS,
  CORE_SUGGEST_IDEAL_DIST_M,
  CORE_SUGGEST_MAX_DIST_M,
  CORE_SUGGEST_MIN_DIST_M,
  computeRelativeAzimuth,
  createCalibrationController,
  createCalibrationPreview,
  detectPlayArcFromHeight,
  detectPostureFromHeight,
  distance3D,
  distanceXZ,
  extractHeadsetPoseFromObject,
  isWithinPlayArc,
  MIN_PORTAL_CLEARANCE_M,
  MIN_REQUIRED_PORTALS,
  raycastCorePlacement,
  SEATED_HEIGHT_THRESHOLD_M,
  selectPortalAnchors,
  suggestCoreAnchor,
  VIRTUAL_PEDESTAL_Y_SEATED,
  VIRTUAL_PEDESTAL_Y_STANDING,
  VIRTUAL_RIFT_MAX_DIST_M,
  VIRTUAL_RIFT_MIN_DIST_M,
  validateCalibration,
} from '../src/xr/calibration.ts';

function makeRectSurface(params: {
  id: string;
  semanticLabel: string;
  orientation: XRPlaneOrientation;
  center: THREE.Vector3;
  normal: THREE.Vector3;
  right: THREE.Vector3;
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

describe('Play Arc auto-detection & explicit override preservation', () => {
  it('auto-detects seated (< 1.35 m -> front-180) vs standing (>= 1.35 m -> full-360) posture', () => {
    expect(SEATED_HEIGHT_THRESHOLD_M).toBe(1.35);

    // Seated 1.2 m
    expect(detectPostureFromHeight(1.2)).toBe('seated');
    expect(detectPlayArcFromHeight(1.2)).toBe('front-180');
    expect(detectPlayArcFromHeight(1.34)).toBe('front-180');

    // Standing 1.65 m & threshold 1.35 m
    expect(detectPostureFromHeight(1.35)).toBe('standing');
    expect(detectPlayArcFromHeight(1.35)).toBe('full-360');
    expect(detectPostureFromHeight(1.65)).toBe('standing');
    expect(detectPlayArcFromHeight(1.65)).toBe('full-360');
  });

  it('preserves explicit Play Arc overrides in pure helper, CalibrationController, and SettingsStore', () => {
    expect(detectPlayArcFromHeight(1.2, 'full-360')).toBe('full-360');
    expect(detectPlayArcFromHeight(1.65, 'front-180')).toBe('front-180');

    const roomModel = createVirtualRoomModel();
    const settingsStore = createSettingsStore({
      adapter: createMemoryStorageAdapter(),
      storage: null,
      search: '',
    });

    const controller = createCalibrationController({
      roomModel,
      settingsStore,
      initialHeadsetPose: { position: { x: 0, y: 1.2, z: 1.45 }, yaw: 0 },
    });

    // Initial seated auto-detection (1.2 m -> front-180)
    expect(controller.state.posture).toBe('seated');
    expect(controller.playArc).toBe('front-180');
    expect(controller.state.playArcOverridden).toBe(false);

    // Standing auto-detection when no override has been set (1.65 m -> full-360)
    controller.beginCalibration({ position: { x: 0, y: 1.65, z: 1.45 }, yaw: 0 });
    expect(controller.state.posture).toBe('standing');
    expect(controller.playArc).toBe('full-360');
    expect(settingsStore.get().playArc).toBe('full-360');
    expect(controller.state.playArcOverridden).toBe(false);

    // Explicit user override via SettingsStore to front-180 while standing
    settingsStore.set('playArc', 'front-180');
    expect(controller.playArc).toBe('front-180');
    expect(controller.state.playArcOverridden).toBe(true);

    // Re-running beginCalibration at standing height (1.65 m) preserves the explicit front-180 override
    controller.beginCalibration({ position: { x: 0, y: 1.65, z: 1.45 }, yaw: 0 });
    expect(controller.state.posture).toBe('standing');
    expect(controller.playArc).toBe('front-180');
    expect(controller.state.playArcOverridden).toBe(true);

    // Explicit user override via Calibration UI / controller to full-360, then re-calibrating at seated 1.2 m
    controller.setPlayArc('full-360');
    controller.beginCalibration({ position: { x: 0, y: 1.2, z: 1.45 }, yaw: 0 });
    expect(controller.state.posture).toBe('seated');
    expect(controller.playArc).toBe('full-360');
    expect(settingsStore.get().playArc).toBe('full-360');

    controller.dispose();
  });
});

describe('Core Bastion auto-suggestion (table -> floor -> virtual pedestal within 1.2–1.8 m)', () => {
  const floorSurface = makeRectSurface({
    id: 'floor-main',
    semanticLabel: 'floor',
    orientation: 'horizontal',
    center: new THREE.Vector3(0, 0, 0),
    normal: new THREE.Vector3(0, 1, 0),
    right: new THREE.Vector3(1, 0, 0),
    width: 5.0,
    depth: 5.0,
  });

  const tableSurface = makeRectSurface({
    id: 'table-ahead',
    semanticLabel: 'table',
    orientation: 'horizontal',
    center: new THREE.Vector3(0, 0.76, -1.5),
    normal: new THREE.Vector3(0, 1, 0),
    right: new THREE.Vector3(1, 0, 0),
    width: 1.3,
    depth: 0.85,
  });

  it('prefers a tracked floor and retains a comfortable table as the next suggestion', () => {
    for (const headHeight of [1.2, 1.65]) {
      const headsetPose = { position: { x: 0, y: headHeight, z: 0 }, yaw: 0 };
      const core = suggestCoreAnchor(headsetPose, [floorSurface, tableSurface]);

      expect(core.surfaceId).toBe('floor-main');
      expect(core.surfaceKind).toBe('floor');
      expect(core.radius).toBe(CORE_KEEP_OUT_RADIUS);
      expect(core.position.y).toBeCloseTo(0, 5);
      expect(suggestCoreAnchor(headsetPose, [tableSurface]).surfaceId).toBe('table-ahead');

      const horizDist = distanceXZ(core.position, headsetPose.position);
      expect(horizDist).toBeGreaterThanOrEqual(CORE_SUGGEST_MIN_DIST_M);
      expect(horizDist).toBeLessThanOrEqual(CORE_SUGGEST_MAX_DIST_M);
    }
  });

  it('uses the tracked ray contact height on a back-facing floor and keeps the anchor on a miss', () => {
    const floor = makeRectSurface({
      id: 'tracked-floor',
      semanticLabel: 'floor',
      orientation: 'horizontal',
      center: new THREE.Vector3(0, 0, -1),
      normal: new THREE.Vector3(0.2, -1, 0).normalize(),
      right: new THREE.Vector3(1, 0, 0),
      width: 4,
      depth: 3,
    });
    const headset = { yaw: 0, position: { x: 0, y: 1.6, z: 0 } };
    const aboveFloor = { x: 1, y: 1.2, z: -1 };
    const placed = raycastCorePlacement(aboveFloor, { x: 0, y: -1, z: 0 }, [floor], headset);
    expect(placed.surfaceId).toBe(floor.id);
    expect(placed.position.y).toBeCloseTo(0.2, 5);
    expect(raycastCorePlacement(aboveFloor, { x: 0, y: 1, z: 0 }, [floor], headset, placed)).toBe(
      placed,
    );
  });

  it('falls back to scanned floor 1.2–1.8 m ahead when no table is within range', () => {
    const farTable = makeRectSurface({
      id: 'table-too-far',
      semanticLabel: 'table',
      orientation: 'horizontal',
      center: new THREE.Vector3(0, 0.76, -2.8),
      normal: new THREE.Vector3(0, 1, 0),
      right: new THREE.Vector3(1, 0, 0),
      width: 0.8,
      depth: 0.6,
    });

    for (const headHeight of [1.2, 1.65]) {
      const headsetPose = { position: { x: 0, y: headHeight, z: 0 }, yaw: 0 };
      const core = suggestCoreAnchor(headsetPose, [floorSurface, farTable]);

      expect(core.surfaceId).toBe('floor-main');
      expect(core.surfaceKind).toBe('floor');
      expect(core.position.y).toBeCloseTo(0, 5);

      const horizDist = distanceXZ(core.position, headsetPose.position);
      expect(horizDist).toBeGreaterThanOrEqual(CORE_SUGGEST_MIN_DIST_M);
      expect(horizDist).toBeLessThanOrEqual(CORE_SUGGEST_MAX_DIST_M);
      expect(horizDist).toBeCloseTo(CORE_SUGGEST_IDEAL_DIST_M, 4);
    }
  });

  it('falls back to a virtual tactical pedestal at 1.45 m ahead (y=0.78 m seated / 0.92 m standing) when no scan exists', () => {
    const seatedPose = { position: { x: 0.5, y: 1.2, z: 1.0 }, yaw: Math.PI / 2 }; // facing -X
    const seatedCore = suggestCoreAnchor(seatedPose, []);
    expect(seatedCore.surfaceId).toBeNull();
    expect(seatedCore.surfaceKind).toBe('virtual-pedestal');
    expect(seatedCore.position.y).toBeCloseTo(VIRTUAL_PEDESTAL_Y_SEATED, 5);
    expect(seatedCore.position.x).toBeCloseTo(0.5 - CORE_SUGGEST_IDEAL_DIST_M, 5);
    expect(seatedCore.position.z).toBeCloseTo(1.0, 5);
    expect(distanceXZ(seatedCore.position, seatedPose.position)).toBeCloseTo(
      CORE_SUGGEST_IDEAL_DIST_M,
      5,
    );

    const standingPose = { position: { x: 0, y: 1.65, z: 0 }, yaw: 0 }; // facing -Z
    const standingCore = suggestCoreAnchor(standingPose, []);
    expect(standingCore.surfaceId).toBeNull();
    expect(standingCore.surfaceKind).toBe('virtual-pedestal');
    expect(standingCore.position.y).toBeCloseTo(VIRTUAL_PEDESTAL_Y_STANDING, 5);
    expect(standingCore.position.z).toBeCloseTo(-CORE_SUGGEST_IDEAL_DIST_M, 5);
    expect(distanceXZ(standingCore.position, standingPose.position)).toBeCloseTo(
      CORE_SUGGEST_IDEAL_DIST_M,
      5,
    );
  });
});

describe('Portal candidate selection (>= 2.0 m clearance, 180° vs 360° arc, small-room fallback)', () => {
  const coreAtOrigin = {
    position: { x: 0, y: 0.78, z: 0 },
    yaw: 0,
    surfaceId: 'virtual-table-central',
    surfaceKind: 'table' as const,
    radius: CORE_KEEP_OUT_RADIUS,
  };

  it('strictly enforces >= 2.0 m Euclidean distance from Core and rejects closer walls', () => {
    const closeNorthWall = makeRectSurface({
      id: 'wall-close-1.4m',
      semanticLabel: 'wall',
      orientation: 'vertical',
      center: new THREE.Vector3(0, 1.4, -1.4),
      normal: new THREE.Vector3(0, 0, 1),
      right: new THREE.Vector3(1, 0, 0),
      width: 1.8,
      depth: 2.4,
    });
    const validWestWall = makeRectSurface({
      id: 'wall-west-2.5m',
      semanticLabel: 'wall',
      orientation: 'vertical',
      center: new THREE.Vector3(-2.5, 1.4, -0.4),
      normal: new THREE.Vector3(1, 0, 0),
      right: new THREE.Vector3(0, 0, -1),
      width: 2.0,
      depth: 2.4,
    });
    const validEastWall = makeRectSurface({
      id: 'wall-east-2.5m',
      semanticLabel: 'wall',
      orientation: 'vertical',
      center: new THREE.Vector3(2.5, 1.4, -0.4),
      normal: new THREE.Vector3(-1, 0, 0),
      right: new THREE.Vector3(0, 0, 1),
      width: 2.0,
      depth: 2.4,
    });

    const portals = selectPortalAnchors({
      surfaces: [closeNorthWall, validWestWall, validEastWall],
      coreAnchor: coreAtOrigin,
      playerYaw: 0,
      playArc: 'front-180',
    });

    expect(portals.length).toBeGreaterThanOrEqual(MIN_REQUIRED_PORTALS);
    expect(portals.some((p) => p.surfaceId === 'wall-close-1.4m')).toBe(false);
    for (const portal of portals) {
      const dist = distance3D(portal.position, coreAtOrigin.position);
      expect(dist).toBeGreaterThanOrEqual(MIN_PORTAL_CLEARANCE_M);
      expect(portal.distanceFromCore).toBeCloseTo(dist, 5);
    }
  });

  it('filters portals to [-90°, +90°] in front-180 mode and distributes around the room in full-360 mode', () => {
    const virtualModel = createVirtualRoomModel();
    // Test with a non-zero rotated player yaw (+30 deg) to prove yaw-relative azimuth filtering
    const playerYaw = Math.PI / 6;

    const frontPortals = selectPortalAnchors({
      surfaces: virtualModel.surfaces,
      coreAnchor: coreAtOrigin,
      playerYaw,
      playArc: 'front-180',
    });

    expect(frontPortals.length).toBeGreaterThanOrEqual(2);
    expect(frontPortals.length).toBeLessThanOrEqual(4);
    for (const portal of frontPortals) {
      expect(portal.distanceFromCore).toBeGreaterThanOrEqual(MIN_PORTAL_CLEARANCE_M);
      const azimuth = computeRelativeAzimuth(coreAtOrigin.position, portal.position, playerYaw);
      expect(Math.abs(azimuth)).toBeLessThanOrEqual(Math.PI / 2 + 1e-5);
      expect(isWithinPlayArc(coreAtOrigin.position, portal.position, playerYaw, 'front-180')).toBe(
        true,
      );
    }

    const fullPortals = selectPortalAnchors({
      surfaces: virtualModel.surfaces,
      coreAnchor: coreAtOrigin,
      playerYaw: 0,
      playArc: 'full-360',
    });

    expect(fullPortals).toHaveLength(4);
    const hasFrontHemisphere = fullPortals.some(
      (p) => Math.abs(computeRelativeAzimuth(coreAtOrigin.position, p.position, 0)) <= Math.PI / 2,
    );
    const hasRearHemisphere = fullPortals.some(
      (p) => Math.abs(computeRelativeAzimuth(coreAtOrigin.position, p.position, 0)) > Math.PI / 2,
    );
    expect(hasFrontHemisphere).toBe(true);
    expect(hasRearHemisphere).toBe(true);
  });

  it('automatically synthesizes virtual rift gates at 2.6–3.6 m in a small room (1.5 m walls) yielding >= 2 valid portals', () => {
    // Small 3.0 m x 3.0 m room where all 4 walls sit at 1.5 m from the Core (< 2.0 m clearance)
    const smallRoomWalls: RoomSurface[] = [
      makeRectSurface({
        id: 'small-wall-north',
        semanticLabel: 'wall',
        orientation: 'vertical',
        center: new THREE.Vector3(0, 1.3, -1.5),
        normal: new THREE.Vector3(0, 0, 1),
        right: new THREE.Vector3(1, 0, 0),
        width: 1.6,
        depth: 2.2,
      }),
      makeRectSurface({
        id: 'small-wall-south',
        semanticLabel: 'wall',
        orientation: 'vertical',
        center: new THREE.Vector3(0, 1.3, 1.5),
        normal: new THREE.Vector3(0, 0, -1),
        right: new THREE.Vector3(-1, 0, 0),
        width: 1.6,
        depth: 2.2,
      }),
      makeRectSurface({
        id: 'small-wall-west',
        semanticLabel: 'wall',
        orientation: 'vertical',
        center: new THREE.Vector3(-1.5, 1.3, 0),
        normal: new THREE.Vector3(1, 0, 0),
        right: new THREE.Vector3(0, 0, -1),
        width: 1.6,
        depth: 2.2,
      }),
      makeRectSurface({
        id: 'small-wall-east',
        semanticLabel: 'wall',
        orientation: 'vertical',
        center: new THREE.Vector3(1.5, 1.3, 0),
        normal: new THREE.Vector3(-1, 0, 0),
        right: new THREE.Vector3(0, 0, 1),
        width: 1.6,
        depth: 2.2,
      }),
    ];

    for (const playArc of ['front-180', 'full-360'] as const) {
      const portals = selectPortalAnchors({
        surfaces: smallRoomWalls,
        coreAnchor: coreAtOrigin,
        playerYaw: 0,
        playArc,
      });

      expect(portals.length).toBeGreaterThanOrEqual(MIN_REQUIRED_PORTALS);
      expect(portals.length).toBeLessThanOrEqual(4);
      expect(portals.every((p) => p.hostKind === 'virtual-rift')).toBe(true);
      expect(portals.every((p) => p.surfaceId === null)).toBe(true);

      for (const portal of portals) {
        const dist = distance3D(portal.position, coreAtOrigin.position);
        expect(dist).toBeGreaterThanOrEqual(VIRTUAL_RIFT_MIN_DIST_M);
        expect(dist).toBeLessThanOrEqual(VIRTUAL_RIFT_MAX_DIST_M);
        expect(dist).toBeGreaterThanOrEqual(MIN_PORTAL_CLEARANCE_M);
        expect(isWithinPlayArc(coreAtOrigin.position, portal.position, 0, playArc)).toBe(true);
      }

      const check = validateCalibration(coreAtOrigin, portals, playArc, 0);
      expect(check.valid).toBe(true);
    }
  });

  it('chooses a flat scanned wall patch away from an unlabeled recess and a protruding fixture', () => {
    const wall = makeRectSurface({
      id: 'wall-with-recess',
      semanticLabel: 'wall',
      orientation: 'vertical',
      center: new THREE.Vector3(0, 1.4, -2.9),
      normal: new THREE.Vector3(0, 0, 1),
      right: new THREE.Vector3(1, 0, 0),
      width: 6,
      depth: 2.8,
    });
    const mesh: RoomSurface = {
      ...wall,
      id: 'unlabeled-room-mesh',
      kind: 'other',
      source: 'mesh',
      semanticLabel: null,
      bounds: new THREE.Box3(new THREE.Vector3(-3, 0, -3.08), new THREE.Vector3(3, 2.8, -2.75)),
      meshWorldMatrix: new THREE.Matrix4().makeTranslation(0, 0, -2.9),
      meshVertices: new Float32Array([
        -3, 0, 0.025, -0.58, 0, 0.025, -0.58, 2.8, 0.025, -3, 2.8, 0.025, 0.58, 0, 0.025, 3, 0,
        0.025, 3, 2.8, 0.025, 0.58, 2.8, 0.025, -0.58, 0, -0.18, 0.58, 0, -0.18, 0.58, 2.8, -0.18,
        -0.58, 2.8, -0.18, 1, 0.93, 0.15, 1.9, 0.93, 0.15, 1.9, 1.97, 0.15, 1, 1.97, 0.15,
      ]),
      meshIndices: new Uint32Array([
        0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11, 12, 13, 14, 12, 14, 15,
      ]),
    };
    const portals = selectPortalAnchors({
      surfaces: [wall, mesh],
      coreAnchor: coreAtOrigin,
      playerYaw: 0,
      playArc: 'front-180',
      maxPortals: 3,
    });
    expect(portals).toHaveLength(3);
    for (const portal of portals) {
      expect(portal.surfaceId).toBe(wall.id);
      expect(portal.position.z).toBeCloseTo(-2.875, 5);
      expect(Math.abs(portal.position.x)).toBeGreaterThan(0.78);
      if (portal.position.y > 0.7 && portal.position.y < 2.2) {
        expect(portal.position.x < 0.8 || portal.position.x > 2.1).toBe(true);
      }
    }
  });

  it('keeps portals in the seated arc when the mesh face stands forward of its fitted plane', () => {
    const wall = makeRectSurface({
      id: 'arc-edge-wall',
      semanticLabel: 'wall',
      orientation: 'vertical',
      center: new THREE.Vector3(3, 1.4, -0.02),
      normal: new THREE.Vector3(0, 0, 1),
      right: new THREE.Vector3(1, 0, 0),
      width: 1.9,
      depth: 2.8,
    });
    const mesh: RoomSurface = {
      ...wall,
      id: 'arc-edge-mesh',
      source: 'mesh',
      kind: 'other',
      semanticLabel: null,
      bounds: new THREE.Box3(new THREE.Vector3(2.05, 0, 0.02), new THREE.Vector3(3.95, 2.8, 0.02)),
      meshWorldMatrix: new THREE.Matrix4().makeTranslation(0, 0, 0.02),
      meshVertices: new Float32Array([2.05, 0, 0, 3.95, 0, 0, 3.95, 2.8, 0, 2.05, 2.8, 0]),
      meshIndices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    };
    const portals = selectPortalAnchors({
      surfaces: [wall, mesh],
      coreAnchor: coreAtOrigin,
      playerYaw: 0,
      playArc: 'front-180',
    });
    expect(portals.some((portal) => portal.surfaceId === wall.id)).toBe(false);
    expect(validateCalibration(coreAtOrigin, portals, 'front-180', 0).valid).toBe(true);
  });

  it('keeps wall portals clear of doorways, keeps ceiling portals inside ceiling corners, and rejects portals behind walls', () => {
    const northWallWithDoor = makeRectSurface({
      id: 'wall-north-door',
      semanticLabel: 'wall',
      orientation: 'vertical',
      center: new THREE.Vector3(0, 1.4, -2.5),
      normal: new THREE.Vector3(0, 0, 1),
      right: new THREE.Vector3(1, 0, 0),
      width: 4.8,
      depth: 2.8,
    });
    const doorwayInCenter = makeRectSurface({
      id: 'door-north-center',
      semanticLabel: 'door_frame',
      orientation: 'vertical',
      center: new THREE.Vector3(0, 1.1, -2.5),
      normal: new THREE.Vector3(0, 0, 1),
      right: new THREE.Vector3(1, 0, 0),
      width: 1.0,
      depth: 2.2,
    });
    const westWall = makeRectSurface({
      id: 'wall-west',
      semanticLabel: 'wall',
      orientation: 'vertical',
      center: new THREE.Vector3(-2.4, 1.4, 0),
      normal: new THREE.Vector3(1, 0, 0),
      right: new THREE.Vector3(0, 0, -1),
      width: 5.0,
      depth: 2.8,
    });
    // Adjacent-room wall behind the west wall (x = -3.4) — must NOT receive a portal!
    const behindWestWall = makeRectSurface({
      id: 'wall-outside-room',
      semanticLabel: 'wall',
      orientation: 'vertical',
      center: new THREE.Vector3(-3.4, 1.4, -0.5),
      normal: new THREE.Vector3(1, 0, 0),
      right: new THREE.Vector3(0, 0, -1),
      width: 3.0,
      depth: 2.8,
    });
    // Small ceiling right against the north/west corner — center is too close to walls for rim clearance
    const smallCornerCeiling = makeRectSurface({
      id: 'ceiling-narrow-strip',
      semanticLabel: 'ceiling',
      orientation: 'horizontal',
      center: new THREE.Vector3(-1.9, 2.8, -2.0),
      normal: new THREE.Vector3(0, -1, 0),
      right: new THREE.Vector3(1, 0, 0),
      width: 0.42,
      depth: 0.42,
    });

    const portals = selectPortalAnchors({
      surfaces: [northWallWithDoor, doorwayInCenter, westWall, behindWestWall, smallCornerCeiling],
      coreAnchor: coreAtOrigin,
      playerYaw: 0,
      playArc: 'front-180',
    });

    expect(portals.length).toBeGreaterThanOrEqual(MIN_REQUIRED_PORTALS);
    // Never pick the wall behind wall-west (out of bounds for the room)
    expect(portals.some((p) => p.surfaceId === 'wall-outside-room')).toBe(false);
    // Never pick the undersized corner ceiling strip where the portal rim would clip through walls
    expect(portals.some((p) => p.surfaceId === 'ceiling-narrow-strip')).toBe(false);
    // A rim that reaches the doorway height must clear its horizontal opening.
    for (const p of portals) {
      if (p.surfaceId === 'wall-north-door' && p.position.y < 2.5) {
        expect(Math.abs(p.position.x)).toBeGreaterThan(0.73);
      }
      // Virtual fallback rifts must also stay on the room side of wall-west (x >= -2.4)
      expect(p.position.x).toBeGreaterThanOrEqual(-2.41);
    }
  });
});

describe('Core relocation, ActionBus integration, and Three.js hologram preview lifecycle', () => {
  it('supports laser ray relocation, grip-drag clamping, preview rendering, and Lock Core state transition', () => {
    const roomModel = createVirtualRoomModel();
    const actionBus = createActionBus();
    const gameState = createGameStateMachine({ initial: 'calibrate' });
    const preview = createCalibrationPreview();

    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 1.2, 1.45);
    camera.lookAt(0, 1.2, 0);
    const initialPose = extractHeadsetPoseFromObject(camera);
    expect(initialPose.yaw).toBeCloseTo(0, 5);

    const controller = createCalibrationController({
      roomModel,
      actionBus,
      gameState,
      initialHeadsetPose: initialPose,
      preview,
    });

    // Starts active in calibrate phase on central table (1.45 m ahead at z=0, y=0.78)
    expect(controller.state.active).toBe(true);
    expect(controller.locked).toBe(false);
    expect(controller.isValid).toBe(true);
    expect(controller.coreAnchor.surfaceKind).toBe('table');
    expect(controller.coreAnchor.position.y).toBeCloseTo(0.78, 5);
    expect(preview.group.visible).toBe(true);
    expect(preview.clearanceRing.position.x).toBeCloseTo(controller.coreAnchor.position.x, 4);
    expect(preview.clearanceRing.position.z).toBeCloseTo(controller.coreAnchor.position.z, 4);

    // Relocate Core via laser ray hitting the floor at (0.8, 0, -0.5)
    const rayOrigin = { x: 0, y: 1.2, z: 1.45 };
    const rayTarget = { x: 1.1, y: 0, z: -0.6 };
    const rayDir = {
      x: rayTarget.x - rayOrigin.x,
      y: rayTarget.y - rayOrigin.y,
      z: rayTarget.z - rayOrigin.z,
    };
    const afterRay = controller.moveCoreByRay(rayOrigin, rayDir);
    expect(afterRay.surfaceKind).toBe('floor');
    expect(afterRay.position.y).toBeCloseTo(0, 4);
    expect(afterRay.position.x).toBeCloseTo(1.1, 3);
    expect(afterRay.position.z).toBeCloseTo(-0.6, 3);

    // Relocate Core via grip-drag back onto the central table
    controller.beginGripDrag();
    const afterGrip = controller.updateGripDrag({ x: 0.1, y: 0.78, z: -0.1 });
    controller.endGripDrag();
    expect(afterGrip.surfaceKind).toBe('table');
    expect(afterGrip.position.y).toBeCloseTo(0.78, 4);
    expect(afterGrip.position.x).toBeCloseTo(0.1, 4);

    // Relocate Core via ActionBus dispatch
    actionBus.dispatch({
      type: 'calibrate/move-core',
      position: { x: -0.2, y: 0.78, z: 0.05 },
    });
    expect(controller.coreAnchor.position.x).toBeCloseTo(-0.2, 4);
    expect(controller.coreAnchor.position.z).toBeCloseTo(0.05, 4);

    // Confirm Lock Core & Begin via ActionBus -> hides preview and transitions calibrate -> prep
    actionBus.dispatch({ type: 'calibrate/confirm' });
    expect(controller.locked).toBe(true);
    expect(controller.state.active).toBe(false);
    expect(preview.group.visible).toBe(false);
    expect(gameState.phase).toBe('prep');

    // Empty room model relocates onto virtual-pedestal when no surfaces exist
    const emptyModel = createRoomSurfaceModel();
    const emptyController = createCalibrationController({
      roomModel: emptyModel,
      initialHeadsetPose: { position: { x: 0, y: 1.2, z: 0 }, yaw: 0 },
    });
    const movedPedestal = emptyController.moveCoreToPoint({ x: 0.3, y: 0.8, z: -1.3 });
    expect(movedPedestal.surfaceKind).toBe('virtual-pedestal');
    expect(movedPedestal.surfaceId).toBeNull();
    expect(emptyController.portalAnchors.length).toBeGreaterThanOrEqual(MIN_REQUIRED_PORTALS);

    emptyController.dispose();
    controller.dispose();
    preview.dispose();
  });
});
