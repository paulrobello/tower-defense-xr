import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  classifySemanticLabel,
  createRoomSurfaceModel,
  type RoomSurfaceSnapshot,
} from '../src/mr/room-scan.ts';
import {
  createVirtualRoomModel,
  createVirtualRoomSurfaces,
  VIRTUAL_CENTRAL_TABLE,
  VIRTUAL_CONSOLE_TABLE,
  VIRTUAL_ROOM_DIMENSIONS,
} from '../src/mr/virtual-room.ts';

function makePose(
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

function makePlane(params: {
  orientation?: XRPlaneOrientation;
  semanticLabel?: string;
  polygon: Array<{ x: number; z: number }>;
  lastChangedTime?: number;
}): XRPlane {
  return {
    orientation: params.orientation ?? 'horizontal',
    planeSpace: {} as XRSpace,
    polygon: params.polygon.map((p) => ({ x: p.x, y: 0, z: p.z, w: 1 }) as DOMPointReadOnly),
    lastChangedTime: params.lastChangedTime ?? 100,
    ...(params.semanticLabel !== undefined ? { semanticLabel: params.semanticLabel } : {}),
  };
}

function makeBoxMesh(params: {
  width: number;
  height: number;
  depth: number;
  semanticLabel?: string;
  lastChangedTime?: number;
}): XRMesh {
  const hw = params.width / 2;
  const hd = params.depth / 2;
  const h = params.height;
  // Closed box spanning y in [0, h]
  const vertices = new Float32Array([
    -hw,
    0,
    -hd,
    hw,
    0,
    -hd,
    hw,
    0,
    hd,
    -hw,
    0,
    hd,
    -hw,
    h,
    -hd,
    hw,
    h,
    -hd,
    hw,
    h,
    hd,
    -hw,
    h,
    hd,
  ]);
  const indices = new Uint32Array([
    // bottom (normal -Y)
    0, 1, 2, 0, 2, 3,
    // top (normal +Y)
    4, 6, 5, 4, 7, 6,
    // front (-Z)
    0, 5, 1, 0, 4, 5,
    // back (+Z)
    2, 7, 3, 2, 6, 7,
    // left (-X)
    0, 3, 7, 0, 7, 4,
    // right (+X)
    1, 5, 6, 1, 6, 2,
  ]);
  return {
    meshSpace: {} as XRSpace,
    vertices,
    indices,
    lastChangedTime: params.lastChangedTime ?? 200,
    ...(params.semanticLabel !== undefined ? { semanticLabel: params.semanticLabel } : {}),
  };
}

function makePlanarWallMesh(width: number, height: number, semanticLabel = 'wall_face'): XRMesh {
  const hw = width / 2;
  const hh = height / 2;
  // Planar quad in XY facing +Z
  const vertices = new Float32Array([-hw, -hh, 0, hw, -hh, 0, hw, hh, 0, -hw, hh, 0]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  return {
    meshSpace: {} as XRSpace,
    vertices,
    indices,
    lastChangedTime: 300,
    semanticLabel,
  };
}

function makeFrame(params: {
  enabledFeatures?: string[];
  planes?: Array<{ plane: XRPlane; pose: XRPose | null }>;
  meshes?: Array<{ mesh: XRMesh; pose: XRPose | null }>;
  omitFeatureList?: boolean;
}): { frame: XRFrame; referenceSpace: XRReferenceSpace } {
  const referenceSpace = {} as XRReferenceSpace;
  const poseMap = new Map<XRSpace, XRPose | null>();
  const planeSet = new Set<XRPlane>();
  const meshSet = new Set<XRMesh>();

  for (const entry of params.planes ?? []) {
    planeSet.add(entry.plane);
    poseMap.set(entry.plane.planeSpace, entry.pose);
  }
  for (const entry of params.meshes ?? []) {
    meshSet.add(entry.mesh);
    poseMap.set(entry.mesh.meshSpace, entry.pose);
  }

  const session = params.omitFeatureList
    ? ({} as XRSession)
    : ({ enabledFeatures: params.enabledFeatures ?? [] } as unknown as XRSession);

  const frame = {
    session,
    detectedPlanes: params.planes !== undefined ? planeSet : undefined,
    detectedMeshes: params.meshes !== undefined ? meshSet : undefined,
    getPose(space: XRSpace) {
      return poseMap.get(space) ?? null;
    },
  } as unknown as XRFrame;

  return { frame, referenceSpace };
}

describe('semantic classification', () => {
  it('maps WebXR semantic labels into normalized SurfaceKind values', () => {
    expect(classifySemanticLabel('floor')).toBe('floor');
    expect(classifySemanticLabel('  FLOOR  ')).toBe('floor');
    expect(classifySemanticLabel('table')).toBe('table');
    expect(classifySemanticLabel('desk')).toBe('table');
    expect(classifySemanticLabel('couch')).toBe('table');
    expect(classifySemanticLabel('bed')).toBe('table');
    expect(classifySemanticLabel('wall')).toBe('wall');
    expect(classifySemanticLabel('wall_face')).toBe('wall');
    expect(classifySemanticLabel('ceiling')).toBe('ceiling');
    expect(classifySemanticLabel('lamp')).toBe('other');
    expect(classifySemanticLabel('')).toBe('other');
    expect(classifySemanticLabel(null)).toBe('other');
    expect(classifySemanticLabel(undefined)).toBe('other');
  });
});

describe('WebXR plane and mesh ingestion', () => {
  it('extracts world polygons, outward normals, AABBs, and stable revisions from detectedPlanes', () => {
    const model = createRoomSurfaceModel({ emptyGraceMs: 0 });
    const floorPlane = makePlane({
      orientation: 'horizontal',
      semanticLabel: 'floor',
      polygon: [
        { x: -2, z: -1.5 },
        { x: 2, z: -1.5 },
        { x: 2, z: 1.5 },
        { x: -2, z: 1.5 },
      ],
      lastChangedTime: 10,
    });
    const wallPlane = makePlane({
      orientation: 'vertical',
      semanticLabel: 'wall_face',
      polygon: [
        { x: -2, z: -1.4 },
        { x: 2, z: -1.4 },
        { x: 2, z: 1.4 },
        { x: -2, z: 1.4 },
      ],
      lastChangedTime: 11,
    });
    // Rotate +90 deg around X so plane local +Y points along world +Z
    const wallQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      Math.PI / 2,
    );

    const { frame: f1, referenceSpace } = makeFrame({
      enabledFeatures: ['local-floor', 'plane-detection'],
      planes: [
        { plane: floorPlane, pose: makePose(new THREE.Vector3(0, 0, 0)) },
        { plane: wallPlane, pose: makePose(new THREE.Vector3(0, 1.4, -2), wallQuat) },
      ],
    });

    const snap1 = model.updateFromFrame(f1, referenceSpace, { nowMs: 100 });
    expect(snap1.status).toBe('ready');
    expect(snap1.grantedFeatures).toEqual({ planeDetection: true, meshDetection: false });
    expect(snap1.surfaces).toHaveLength(2);

    const floor = model.getSurfacesByKind('floor')[0];
    expect(floor).toBeDefined();
    expect(floor?.source).toBe('plane');
    expect(floor?.revision).toBe(1);
    expect(floor?.normal.x).toBeCloseTo(0, 5);
    expect(floor?.normal.y).toBeCloseTo(1, 5);
    expect(floor?.normal.z).toBeCloseTo(0, 5);
    expect(floor?.bounds.min.x).toBeCloseTo(-2, 5);
    expect(floor?.bounds.max.x).toBeCloseTo(2, 5);
    expect(floor?.bounds.min.z).toBeCloseTo(-1.5, 5);
    expect(floor?.bounds.max.z).toBeCloseTo(1.5, 5);
    expect(floor?.localPolygon).toHaveLength(4);
    expect(floor?.polygon).toHaveLength(4);

    const wall = model.getSurfacesByKind('wall')[0];
    expect(wall).toBeDefined();
    expect(wall?.normal.x).toBeCloseTo(0, 5);
    expect(wall?.normal.y).toBeCloseTo(0, 5);
    expect(wall?.normal.z).toBeCloseTo(1, 5);
    expect(wall?.center.z).toBeCloseTo(-2, 5);
    expect(wall?.bounds.min.y).toBeCloseTo(0, 4);
    expect(wall?.bounds.max.y).toBeCloseTo(2.8, 4);

    // Unchanged frame keeps surface and model revisions constant
    const snap2 = model.updateFromFrame(f1, referenceSpace, { nowMs: 116 });
    expect(snap2.revision).toBe(snap1.revision);
    expect(model.getSurfacesByKind('floor')[0]?.revision).toBe(1);

    // Pose refinement increments revision for changed surface only
    const { frame: f3 } = makeFrame({
      enabledFeatures: ['local-floor', 'plane-detection'],
      planes: [
        { plane: floorPlane, pose: makePose(new THREE.Vector3(0, 0.02, 0)) },
        { plane: wallPlane, pose: makePose(new THREE.Vector3(0, 1.4, -2), wallQuat) },
      ],
    });
    const snap3 = model.updateFromFrame(f3, referenceSpace, { nowMs: 132 });
    expect(snap3.revision).toBeGreaterThan(snap1.revision);
    expect(model.getSurfacesByKind('floor')[0]?.revision).toBe(2);
    expect(model.getSurfacesByKind('wall')[0]?.revision).toBe(1);
  });

  it('ingests detectedMeshes and extracts tabletop polygon/normal/AABB for 3D furniture meshes', () => {
    const model = createRoomSurfaceModel({ emptyGraceMs: 0 });
    const deskMesh = makeBoxMesh({
      width: 1.2,
      height: 0.78,
      depth: 0.8,
      semanticLabel: 'desk',
    });
    const wallMesh = makePlanarWallMesh(4, 2.6, 'wall_face');

    const { frame, referenceSpace } = makeFrame({
      enabledFeatures: ['mesh-detection'],
      meshes: [
        { mesh: deskMesh, pose: makePose(new THREE.Vector3(0.5, 0, -0.4)) },
        { mesh: wallMesh, pose: makePose(new THREE.Vector3(0, 1.3, -2.0)) },
      ],
    });

    const snap = model.updateFromFrame(frame, referenceSpace, { nowMs: 50 });
    expect(snap.status).toBe('ready');
    expect(snap.grantedFeatures).toEqual({ planeDetection: false, meshDetection: true });

    const desk = model.getSurfacesByKind('table')[0];
    expect(desk).toBeDefined();
    expect(desk?.source).toBe('mesh');
    expect(desk?.normal.y).toBeCloseTo(1, 5);
    expect(desk?.center.x).toBeCloseTo(0.5, 4);
    expect(desk?.center.y).toBeCloseTo(0.78, 4);
    expect(desk?.center.z).toBeCloseTo(-0.4, 4);
    // World AABB spans full 3D mesh height [0, 0.78]
    expect(desk?.bounds.min.y).toBeCloseTo(0, 4);
    expect(desk?.bounds.max.y).toBeCloseTo(0.78, 4);
    expect(desk?.bounds.min.x).toBeCloseTo(-0.1, 4);
    expect(desk?.bounds.max.x).toBeCloseTo(1.1, 4);
    // Tabletop polygon lies at y = 0.78
    for (const v of desk?.polygon ?? []) {
      expect(v.y).toBeCloseTo(0.78, 4);
    }

    const wall = model.getSurfacesByKind('wall')[0];
    expect(wall).toBeDefined();
    expect(wall?.normal.z).toBeCloseTo(1, 5);
    expect(wall?.bounds.min.x).toBeCloseTo(-2, 4);
    expect(wall?.bounds.max.x).toBeCloseTo(2, 4);

    const next = model.updateFromFrame(frame, referenceSpace, { nowMs: 64 });
    expect(next.surfaces).toBe(snap.surfaces);
    expect(next.revision).toBe(snap.revision);

    const interruptedFrame = Object.create(frame, {
      detectedMeshes: {
        get() {
          throw new DOMException('Room data is temporarily unavailable', 'InvalidStateError');
        },
      },
    }) as XRFrame;
    const interrupted = model.updateFromFrame(interruptedFrame, referenceSpace, { nowMs: 78 });
    expect(interrupted.status).toBe('ready');
    expect(interrupted.surfaces).toBe(snap.surfaces);
  });
});

describe('session feature diagnostics & virtual fallback switching', () => {
  it('distinguishes unsupported, permission-denied, and empty granted scans with one-click fallback', () => {
    const events: RoomSurfaceSnapshot[] = [];

    // 1. Unsupported session (features omitted, no denial)
    const unsupportedModel = createRoomSurfaceModel();
    unsupportedModel.subscribe((s) => events.push(s));
    const { frame: fUnsupported, referenceSpace: ref1 } = makeFrame({
      enabledFeatures: ['local-floor'],
      planes: [],
    });
    const sUnsupported = unsupportedModel.updateFromFrame(fUnsupported, ref1, { nowMs: 0 });
    expect(sUnsupported.status).toBe('unsupported');
    expect(sUnsupported.statusMessage.toLowerCase()).toContain('unsupported');
    expect(sUnsupported.notice.canFallback).toBe(true);

    // 2. Permission denied (withheld features with permissionDenied signal or NotAllowedError)
    const deniedModel = createRoomSurfaceModel();
    const { frame: fDenied, referenceSpace: ref2 } = makeFrame({
      enabledFeatures: ['local-floor'],
      planes: [],
    });
    const sDenied = deniedModel.updateFromFrame(fDenied, ref2, {
      nowMs: 0,
      permissionDenied: true,
    });
    expect(sDenied.status).toBe('denied');
    expect(sDenied.statusMessage.toLowerCase()).toContain('denied');
    expect(sDenied.notice.canFallback).toBe(true);

    const errModel = createRoomSurfaceModel();
    errModel.reportSessionError(new DOMException('User denied spatial data', 'NotAllowedError'));
    expect(errModel.status).toBe('denied');

    // 3. Empty scan (features granted, grace window elapses with 0 surfaces)
    const emptyModel = createRoomSurfaceModel({ emptyGraceMs: 1000 });
    const { frame: fEmpty, referenceSpace: ref3 } = makeFrame({
      enabledFeatures: ['plane-detection', 'mesh-detection'],
      planes: [],
      meshes: [],
    });
    const sScanning = emptyModel.updateFromFrame(fEmpty, ref3, { nowMs: 100 });
    expect(sScanning.status).toBe('scanning');
    expect(sScanning.grantedFeatures).toEqual({ planeDetection: true, meshDetection: true });

    const sEmpty = emptyModel.updateFromFrame(fEmpty, ref3, { nowMs: 1200 });
    expect(sEmpty.status).toBe('empty');
    expect(sEmpty.statusMessage.toLowerCase()).toContain('granted');
    expect(sEmpty.statusMessage.toLowerCase()).toContain('no surfaces');
    expect(sEmpty.notice.canFallback).toBe(true);

    // One-click switch to virtual fallback
    emptyModel.dismissNotice();
    expect(emptyModel.notice.dismissed).toBe(true);
    const sFallback = emptyModel.activateVirtualFallback();
    expect(sFallback.status).toBe('virtual-fallback');
    expect(sFallback.usingVirtualFallback).toBe(true);
    expect(sFallback.notice.canFallback).toBe(false);
    expect(sFallback.surfaces.length).toBe(8);
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('surface-relative anchor registry', () => {
  it('refines visual + collider poses together, hides on tracking loss, and restores from exact local offset', () => {
    const model = createRoomSurfaceModel({ emptyGraceMs: 0 });
    const tablePlane = makePlane({
      orientation: 'horizontal',
      semanticLabel: 'table',
      polygon: [
        { x: -0.7, z: -0.45 },
        { x: 0.7, z: -0.45 },
        { x: 0.7, z: 0.45 },
        { x: -0.7, z: 0.45 },
      ],
    });

    const initialPose = makePose(new THREE.Vector3(0, 0.78, 0));
    const { frame: f1, referenceSpace } = makeFrame({
      enabledFeatures: ['plane-detection'],
      planes: [{ plane: tablePlane, pose: initialPose }],
    });
    model.updateFromFrame(f1, referenceSpace, { nowMs: 10 });
    const tableId = model.getSurfacesByKind('table')[0]?.id ?? '';
    expect(tableId).not.toBe('');

    const visual = new THREE.Object3D();
    const collider = {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      matrix: new THREE.Matrix4(),
      visible: false,
    };
    const onUpdate = vi.fn();

    const localOffsetPos = new THREE.Vector3(0.25, 0.1, -0.15);
    const localOffsetQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 4,
    );

    const anchor = model.attachAnchor(
      tableId,
      { position: localOffsetPos, quaternion: localOffsetQuat },
      { visual, collider, onUpdate },
    );

    expect(anchor.tracked).toBe(true);
    expect(anchor.visible).toBe(true);
    expect(visual.visible).toBe(true);
    expect(collider.visible).toBe(true);
    expect(visual.position.x).toBeCloseTo(0.25, 5);
    expect(visual.position.y).toBeCloseTo(0.88, 5);
    expect(visual.position.z).toBeCloseTo(-0.15, 5);
    expect(collider.position.distanceTo(visual.position)).toBeCloseTo(0, 6);
    expect(collider.quaternion.angleTo(visual.quaternion)).toBeCloseTo(0, 6);

    // Tracking refinement: surface translates and yaws by 90 deg
    const yaw90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    const refinedOrigin = new THREE.Vector3(0.12, 0.8, -0.05);
    const { frame: f2 } = makeFrame({
      enabledFeatures: ['plane-detection'],
      planes: [{ plane: tablePlane, pose: makePose(refinedOrigin, yaw90) }],
    });
    model.updateFromFrame(f2, referenceSpace, { nowMs: 26 });

    const expectedWorld1 = new THREE.Matrix4()
      .compose(refinedOrigin, yaw90, new THREE.Vector3(1, 1, 1))
      .multiply(
        new THREE.Matrix4().compose(localOffsetPos, localOffsetQuat, new THREE.Vector3(1, 1, 1)),
      );
    const expectedPos1 = new THREE.Vector3();
    const expectedQuat1 = new THREE.Quaternion();
    expectedWorld1.decompose(expectedPos1, expectedQuat1, new THREE.Vector3());

    expect(visual.visible).toBe(true);
    expect(collider.visible).toBe(true);
    expect(visual.position.distanceTo(expectedPos1)).toBeCloseTo(0, 5);
    expect(collider.position.distanceTo(expectedPos1)).toBeCloseTo(0, 5);
    expect(visual.quaternion.angleTo(expectedQuat1)).toBeCloseTo(0, 5);
    expect(collider.quaternion.angleTo(expectedQuat1)).toBeCloseTo(0, 5);

    // Tracking loss: plane missing from frame -> both visual and collider hidden cleanly
    const { frame: fLost } = makeFrame({
      enabledFeatures: ['plane-detection'],
      planes: [],
    });
    model.updateFromFrame(fLost, referenceSpace, { nowMs: 42 });

    const lostAnchor = model.getAnchor(anchor.id);
    expect(lostAnchor?.tracked).toBe(false);
    expect(lostAnchor?.visible).toBe(false);
    expect(visual.visible).toBe(false);
    expect(collider.visible).toBe(false);

    // Tracking returns with new refined pose -> restores from exact original local offset
    const yawNeg30 = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      -Math.PI / 6,
    );
    const restoredOrigin = new THREE.Vector3(-0.3, 0.76, 0.4);
    const { frame: fRestored } = makeFrame({
      enabledFeatures: ['plane-detection'],
      planes: [{ plane: tablePlane, pose: makePose(restoredOrigin, yawNeg30) }],
    });
    model.updateFromFrame(fRestored, referenceSpace, { nowMs: 58 });

    const expectedWorld2 = new THREE.Matrix4()
      .compose(restoredOrigin, yawNeg30, new THREE.Vector3(1, 1, 1))
      .multiply(
        new THREE.Matrix4().compose(localOffsetPos, localOffsetQuat, new THREE.Vector3(1, 1, 1)),
      );
    const expectedPos2 = new THREE.Vector3();
    const expectedQuat2 = new THREE.Quaternion();
    expectedWorld2.decompose(expectedPos2, expectedQuat2, new THREE.Vector3());

    const restoredAnchor = model.getAnchor(anchor.id);
    expect(restoredAnchor?.tracked).toBe(true);
    expect(restoredAnchor?.visible).toBe(true);
    expect(visual.visible).toBe(true);
    expect(collider.visible).toBe(true);
    expect(visual.position.distanceTo(expectedPos2)).toBeCloseTo(0, 5);
    expect(collider.position.distanceTo(expectedPos2)).toBeCloseTo(0, 5);
    expect(visual.quaternion.angleTo(expectedQuat2)).toBeCloseTo(0, 5);
    expect(collider.quaternion.angleTo(expectedQuat2)).toBeCloseTo(0, 5);

    expect(onUpdate).toHaveBeenCalled();
    expect(model.detachAnchor(anchor.id)).toBe(true);
    expect(model.getAnchors()).toHaveLength(0);
  });
});

describe('Virtual Tactical Arena', () => {
  it('synthesizes a complete 4.8m x 4.2m x 2.8m room with floor, ceiling, 4 walls, central table (y=0.78m), and side console', () => {
    const model = createVirtualRoomModel();
    expect(model.status).toBe('virtual-fallback');
    expect(model.usingVirtualFallback).toBe(true);
    expect(model.surfaces).toHaveLength(8);

    const floor = model.getSurfacesByKind('floor');
    const ceiling = model.getSurfacesByKind('ceiling');
    const walls = model.getSurfacesByKind('wall');
    const tables = model.getSurfacesByKind('table');

    expect(floor).toHaveLength(1);
    expect(ceiling).toHaveLength(1);
    expect(walls).toHaveLength(4);
    expect(tables).toHaveLength(2);

    // Room envelope: 4.8m x 4.2m x 2.8m
    expect(floor[0]?.bounds.min.x).toBeCloseTo(-VIRTUAL_ROOM_DIMENSIONS.width / 2, 5);
    expect(floor[0]?.bounds.max.x).toBeCloseTo(VIRTUAL_ROOM_DIMENSIONS.width / 2, 5);
    expect(floor[0]?.bounds.min.z).toBeCloseTo(-VIRTUAL_ROOM_DIMENSIONS.depth / 2, 5);
    expect(floor[0]?.bounds.max.z).toBeCloseTo(VIRTUAL_ROOM_DIMENSIONS.depth / 2, 5);
    expect(floor[0]?.center.y).toBeCloseTo(0, 5);
    expect(floor[0]?.normal.y).toBeCloseTo(1, 5);

    expect(ceiling[0]?.center.y).toBeCloseTo(VIRTUAL_ROOM_DIMENSIONS.height, 5);
    expect(ceiling[0]?.normal.y).toBeCloseTo(-1, 5);

    // Central tactical table at y=0.78m & side console table
    const central = model.getSurface(VIRTUAL_CENTRAL_TABLE.id);
    const consoleTable = model.getSurface(VIRTUAL_CONSOLE_TABLE.id);
    expect(central?.center.y).toBeCloseTo(0.78, 5);
    expect(central?.normal.y).toBeCloseTo(1, 5);
    expect(consoleTable).toBeDefined();
    expect(consoleTable?.normal.y).toBeCloseTo(1, 5);
    expect(central?.bounds.intersectsBox(consoleTable?.bounds as THREE.Box3)).toBe(false);

    // Every wall/ceiling surface is >= 2.0m from the central table center (portal clearance)
    const coreDefault = central?.center ?? new THREE.Vector3(0, 0.78, 0);
    for (const portalHost of [...walls, ...ceiling]) {
      expect(portalHost.center.distanceTo(coreDefault)).toBeGreaterThanOrEqual(2.0);
    }

    // All virtual surfaces satisfy rigid worldMatrix <-> localPolygon <-> polygon & +Y === normal
    for (const surface of createVirtualRoomSurfaces()) {
      const transformedY = new THREE.Vector3(0, 1, 0).transformDirection(surface.worldMatrix);
      expect(transformedY.distanceTo(surface.normal)).toBeCloseTo(0, 5);
      expect(surface.polygon).toHaveLength(surface.localPolygon.length);
      for (let i = 0; i < surface.localPolygon.length; i += 1) {
        const lp = surface.localPolygon[i];
        const wp = surface.polygon[i];
        const expected = new THREE.Vector3(lp?.x ?? 0, 0, lp?.z ?? 0).applyMatrix4(
          surface.worldMatrix,
        );
        expect(wp?.distanceTo(expected)).toBeCloseTo(0, 5);
      }
    }

    // Surface-relative anchoring works identically on virtual room surfaces
    const turret = new THREE.Object3D();
    const anchor = model.attachAnchor(
      VIRTUAL_CENTRAL_TABLE.id,
      { position: new THREE.Vector3(0.2, 0, -0.1) },
      { visual: turret },
    );
    expect(anchor.tracked).toBe(true);
    expect(turret.visible).toBe(true);
    expect(turret.position.x).toBeCloseTo(0.2, 5);
    expect(turret.position.y).toBeCloseTo(0.78, 5);
    expect(turret.position.z).toBeCloseTo(-0.1, 5);
  });
});
