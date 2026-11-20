/**
 * Deterministic Virtual Tactical Arena (`4.8 m × 4.2 m × 2.8 m` room with floor, central tactical
 * table at `y = 0.78 m`, side console table, 4 walls, and ceiling) producing a `RoomSurfaceModel`
 * with the exact same interface used on desktop, in IWER, and when Quest room scan is unavailable
 * or empty.
 */
import * as THREE from 'three';
import {
  buildRoomSurfaceFromLocalPolygon,
  createRoomSurfaceModel,
  type LocalPolygonPoint,
  makeSurfaceBasisMatrix,
  type RoomSurface,
  type RoomSurfaceModel,
  type RoomSurfaceModelOptions,
} from './room-scan.ts';

export const VIRTUAL_ROOM_DIMENSIONS = {
  width: 4.8,
  depth: 4.2,
  height: 2.8,
} as const;

export const VIRTUAL_CENTRAL_TABLE = {
  id: 'virtual-table-central',
  width: 1.4,
  depth: 0.9,
  y: 0.78,
  position: { x: 0, y: 0.78, z: 0 },
} as const;

export const VIRTUAL_CONSOLE_TABLE = {
  id: 'virtual-table-console',
  width: 0.65,
  depth: 1.2,
  y: 0.74,
  position: { x: 1.6, y: 0.74, z: 0 },
} as const;

function rectPolygon(width: number, depth: number): LocalPolygonPoint[] {
  const hw = width / 2;
  const hd = depth / 2;
  return [
    { x: -hw, z: -hd },
    { x: hw, z: -hd },
    { x: hw, z: hd },
    { x: -hw, z: hd },
  ];
}

function makeVirtualRectSurface(params: {
  id: string;
  semanticLabel: string;
  orientation: XRPlaneOrientation;
  center: THREE.Vector3;
  normal: THREE.Vector3;
  right: THREE.Vector3;
  width: number;
  depth: number;
}): RoomSurface {
  const worldMatrix = makeSurfaceBasisMatrix(params.center, params.normal, params.right);
  return buildRoomSurfaceFromLocalPolygon({
    id: params.id,
    source: 'virtual',
    semanticLabel: params.semanticLabel,
    orientation: params.orientation,
    revision: 1,
    lastChangedTime: 0,
    worldMatrix,
    localPolygon: rectPolygon(params.width, params.depth),
  });
}

/** Synthesizes the deterministic 8-surface Virtual Tactical Arena (`4.8 m × 4.2 m × 2.8 m`). */
export function createVirtualRoomSurfaces(): readonly RoomSurface[] {
  const { width, depth, height } = VIRTUAL_ROOM_DIMENSIONS;
  const hw = width / 2;
  const hd = depth / 2;
  const hh = height / 2;

  return [
    // Floor at y = 0, outward normal +Y
    makeVirtualRectSurface({
      id: 'virtual-floor',
      semanticLabel: 'floor',
      orientation: 'horizontal',
      center: new THREE.Vector3(0, 0, 0),
      normal: new THREE.Vector3(0, 1, 0),
      right: new THREE.Vector3(1, 0, 0),
      width,
      depth,
    }),
    // Ceiling at y = 2.8, outward normal -Y (pointing into the room)
    makeVirtualRectSurface({
      id: 'virtual-ceiling',
      semanticLabel: 'ceiling',
      orientation: 'horizontal',
      center: new THREE.Vector3(0, height, 0),
      normal: new THREE.Vector3(0, -1, 0),
      right: new THREE.Vector3(1, 0, 0),
      width,
      depth,
    }),
    // North (front) wall at z = -2.1, outward normal +Z
    makeVirtualRectSurface({
      id: 'virtual-wall-north',
      semanticLabel: 'wall',
      orientation: 'vertical',
      center: new THREE.Vector3(0, hh, -hd),
      normal: new THREE.Vector3(0, 0, 1),
      right: new THREE.Vector3(1, 0, 0),
      width,
      depth: height,
    }),
    // South (back) wall at z = +2.1, outward normal -Z
    makeVirtualRectSurface({
      id: 'virtual-wall-south',
      semanticLabel: 'wall',
      orientation: 'vertical',
      center: new THREE.Vector3(0, hh, hd),
      normal: new THREE.Vector3(0, 0, -1),
      right: new THREE.Vector3(-1, 0, 0),
      width,
      depth: height,
    }),
    // West (left) wall at x = -2.4, outward normal +X
    makeVirtualRectSurface({
      id: 'virtual-wall-west',
      semanticLabel: 'wall',
      orientation: 'vertical',
      center: new THREE.Vector3(-hw, hh, 0),
      normal: new THREE.Vector3(1, 0, 0),
      right: new THREE.Vector3(0, 0, -1),
      width: depth,
      depth: height,
    }),
    // East (right) wall at x = +2.4, outward normal -X
    makeVirtualRectSurface({
      id: 'virtual-wall-east',
      semanticLabel: 'wall',
      orientation: 'vertical',
      center: new THREE.Vector3(hw, hh, 0),
      normal: new THREE.Vector3(-1, 0, 0),
      right: new THREE.Vector3(0, 0, 1),
      width: depth,
      depth: height,
    }),
    // Central tactical table at y = 0.78 m
    makeVirtualRectSurface({
      id: VIRTUAL_CENTRAL_TABLE.id,
      semanticLabel: 'table',
      orientation: 'horizontal',
      center: new THREE.Vector3(
        VIRTUAL_CENTRAL_TABLE.position.x,
        VIRTUAL_CENTRAL_TABLE.position.y,
        VIRTUAL_CENTRAL_TABLE.position.z,
      ),
      normal: new THREE.Vector3(0, 1, 0),
      right: new THREE.Vector3(1, 0, 0),
      width: VIRTUAL_CENTRAL_TABLE.width,
      depth: VIRTUAL_CENTRAL_TABLE.depth,
    }),
    // Side console table
    makeVirtualRectSurface({
      id: VIRTUAL_CONSOLE_TABLE.id,
      semanticLabel: 'desk',
      orientation: 'horizontal',
      center: new THREE.Vector3(
        VIRTUAL_CONSOLE_TABLE.position.x,
        VIRTUAL_CONSOLE_TABLE.position.y,
        VIRTUAL_CONSOLE_TABLE.position.z,
      ),
      normal: new THREE.Vector3(0, 1, 0),
      right: new THREE.Vector3(1, 0, 0),
      width: VIRTUAL_CONSOLE_TABLE.width,
      depth: VIRTUAL_CONSOLE_TABLE.depth,
    }),
  ];
}

/**
 * Creates a `RoomSurfaceModel` preconfigured with the Virtual Tactical Arena fallback provider.
 * Defaults to `'virtual-fallback'` mode (for desktop/IWER) unless `initialMode` is overridden.
 */
export function createVirtualRoomModel(options: RoomSurfaceModelOptions = {}): RoomSurfaceModel {
  return createRoomSurfaceModel({
    initialMode: 'virtual-fallback',
    virtualSurfacesProvider: createVirtualRoomSurfaces,
    ...options,
  });
}
