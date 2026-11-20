/**
 * WebXR room-scale plane & mesh ingestion, semantic surface classification, session-feature
 * diagnostics (unsupported / denied vs empty scan), and surface-relative anchor registry.
 *
 * Consumed identically by `nav/`, `mr/`, and `xr/` via `RoomSurfaceModel`.
 */
import * as THREE from 'three';
import { createVirtualRoomSurfaces } from './virtual-room.ts';

export const SURFACE_KINDS = ['floor', 'table', 'wall', 'ceiling', 'other'] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

export type SurfaceSource = 'plane' | 'mesh' | 'virtual';

export const ROOM_SCAN_STATUSES = [
  'scanning',
  'ready',
  'empty',
  'denied',
  'unsupported',
  'virtual-fallback',
] as const;
export type RoomScanStatus = (typeof ROOM_SCAN_STATUSES)[number];

export interface LocalPolygonPoint {
  readonly x: number;
  readonly z: number;
}

export interface RoomSurface {
  readonly id: string;
  readonly source: SurfaceSource;
  readonly kind: SurfaceKind;
  readonly semanticLabel: string | null;
  readonly orientation: XRPlaneOrientation;
  readonly revision: number;
  readonly lastChangedTime: number;
  /** Local-to-world rigid transform; local `+Y` aligns with outward world `normal`. */
  readonly worldMatrix: THREE.Matrix4;
  /** Outward world-space unit normal. */
  readonly normal: THREE.Vector3;
  /** World-space center of the surface polygon. */
  readonly center: THREE.Vector3;
  /** 2D polygon vertices in the surface's local `y = 0` plane. */
  readonly localPolygon: readonly LocalPolygonPoint[];
  /** World-space polygon vertices (`localPolygon` transformed by `worldMatrix`). */
  readonly polygon: readonly THREE.Vector3[];
  /** World-space axis-aligned bounding box. */
  readonly bounds: THREE.Box3;
  /** Raw mesh-local vertex positions when `source === 'mesh'`. */
  readonly meshVertices?: Float32Array;
  /** Raw triangle indices when `source === 'mesh'`. */
  readonly meshIndices?: Uint32Array;
}

export interface PoseComponents {
  readonly position: THREE.Vector3 | { readonly x: number; readonly y: number; readonly z: number };
  readonly quaternion?:
    | THREE.Quaternion
    | { readonly x: number; readonly y: number; readonly z: number; readonly w: number };
  readonly scale?: THREE.Vector3 | { readonly x: number; readonly y: number; readonly z: number };
}

export type SurfacePoseInput = THREE.Matrix4 | PoseComponents;

export interface AnchorColliderTarget {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale?: THREE.Vector3;
  matrix?: THREE.Matrix4;
  visible: boolean;
  updateMatrixWorld?(force?: boolean): void;
}

export interface SurfaceAnchorTarget {
  visual?: THREE.Object3D;
  collider?: AnchorColliderTarget;
  onUpdate?: (anchor: SurfaceAnchor) => void;
}

export interface SurfaceAnchor {
  readonly id: string;
  readonly surfaceId: string;
  readonly localMatrix: THREE.Matrix4;
  readonly worldMatrix: THREE.Matrix4;
  readonly worldPosition: THREE.Vector3;
  readonly worldQuaternion: THREE.Quaternion;
  readonly visible: boolean;
  readonly tracked: boolean;
  readonly visual?: THREE.Object3D;
  readonly collider?: AnchorColliderTarget;
}

export interface GrantedScanFeatures {
  readonly planeDetection: boolean;
  readonly meshDetection: boolean;
}

export interface RoomScanNotice {
  readonly status: RoomScanStatus;
  readonly title: string;
  readonly message: string;
  readonly canFallback: boolean;
  readonly dismissed: boolean;
}

export interface RoomSurfaceSnapshot {
  readonly status: RoomScanStatus;
  readonly revision: number;
  readonly surfaces: readonly RoomSurface[];
  readonly grantedFeatures: GrantedScanFeatures;
  readonly statusMessage: string;
  readonly notice: RoomScanNotice;
  readonly usingVirtualFallback: boolean;
}

export type RoomSurfaceListener = (snapshot: RoomSurfaceSnapshot) => void;

export interface FrameUpdateOptions {
  /** Monotonic timestamp in milliseconds used for the empty-scan grace window. */
  nowMs?: number;
  /** Explicit permission-denial hint when `plane-detection`/`mesh-detection` were withheld. */
  permissionDenied?: boolean;
  /** Hint indicating the device/browser supports room scanning (withheld features => denied). */
  spatialSupported?: boolean;
}

export interface SessionScanOptions {
  permissionDenied?: boolean;
  spatialSupported?: boolean;
}

export interface RoomSurfaceModelOptions {
  /** Time (ms) before a granted scan with zero surfaces transitions from `scanning` to `empty`. */
  emptyGraceMs?: number;
  /** Start directly in `virtual-fallback` using the provided virtual surfaces. */
  initialMode?: 'scanning' | 'virtual-fallback';
  /** Automatically activate virtual fallback if the room scan is unsupported, denied, or empty. */
  autoFallbackOnUnavailable?: boolean;
  /** Provider for Virtual Tactical Arena surfaces used by `activateVirtualFallback()`. */
  virtualSurfacesProvider?: () => readonly RoomSurface[];
  /** Optional clock override for deterministic tests. */
  now?: () => number;
}

export interface RoomSurfaceModel {
  readonly status: RoomScanStatus;
  readonly revision: number;
  readonly surfaces: readonly RoomSurface[];
  readonly grantedFeatures: GrantedScanFeatures;
  readonly statusMessage: string;
  readonly notice: RoomScanNotice;
  readonly usingVirtualFallback: boolean;
  getSurface(id: string): RoomSurface | undefined;
  getSurfacesByKind(kind: SurfaceKind): readonly RoomSurface[];
  updateFromFrame(
    frame: XRFrame,
    referenceSpace: XRReferenceSpace,
    options?: FrameUpdateOptions,
  ): RoomSurfaceSnapshot;
  setSession(session: XRSession | null, options?: SessionScanOptions): void;
  reportSessionError(error: unknown): void;
  activateVirtualFallback(): RoomSurfaceSnapshot;
  deactivateVirtualFallback(): RoomSurfaceSnapshot;
  dismissNotice(): void;
  attachAnchor(
    surfaceId: string,
    localPose: SurfacePoseInput,
    target?: SurfaceAnchorTarget,
  ): SurfaceAnchor;
  detachAnchor(anchorId: string): boolean;
  getAnchor(anchorId: string): SurfaceAnchor | undefined;
  getAnchors(): readonly SurfaceAnchor[];
  subscribe(listener: RoomSurfaceListener): () => void;
  snapshot(): RoomSurfaceSnapshot;
  reset(): void;
}

const DEFAULT_EMPTY_GRACE_MS = 1500;
const MATRIX_EPSILON = 1e-6;
const MESH_PLANE_BAND_M = 0.025;
const HULL_EPSILON = 1e-5;

const _scratchPos = new THREE.Vector3();
const _scratchQuat = new THREE.Quaternion();
const _scratchScale = new THREE.Vector3(1, 1, 1);
const _scratchInvRotation = new THREE.Matrix4();
const _scratchWorldUp = new THREE.Vector3();

/** Maps a WebXR `semanticLabel` to the normalized `SurfaceKind`. */
export function classifySemanticLabel(label: string | null | undefined): SurfaceKind {
  const normalized = label?.trim().toLowerCase() ?? '';
  switch (normalized) {
    case 'floor':
      return 'floor';
    case 'table':
    case 'desk':
    case 'couch':
    case 'bed':
      return 'table';
    case 'wall':
    case 'wall_face':
      return 'wall';
    case 'ceiling':
      return 'ceiling';
    default:
      return 'other';
  }
}

/** Computes an area-weighted centroid of a 3D planar polygon, falling back to vertex mean. */
export function computePolygonCentroid(points: readonly THREE.Vector3[]): THREE.Vector3 {
  if (points.length === 0) return new THREE.Vector3();
  const mean = new THREE.Vector3();
  for (const point of points) mean.add(point);
  mean.divideScalar(points.length);
  if (points.length < 3) return mean;

  // Use Newell-style triangle fan around points[0] weighted by signed triangle area.
  const origin = points[0] as THREE.Vector3;
  const edgeA = new THREE.Vector3();
  const edgeB = new THREE.Vector3();
  const cross = new THREE.Vector3();
  const weighted = new THREE.Vector3();
  let refNormal: THREE.Vector3 | null = null;
  let totalArea = 0;

  for (let i = 1; i + 1 < points.length; i += 1) {
    const p1 = points[i] as THREE.Vector3;
    const p2 = points[i + 1] as THREE.Vector3;
    edgeA.subVectors(p1, origin);
    edgeB.subVectors(p2, origin);
    cross.crossVectors(edgeA, edgeB);
    const len = cross.length();
    if (len < 1e-9) continue;
    if (!refNormal) refNormal = cross.clone().divideScalar(len);
    const signedArea = cross.dot(refNormal);
    totalArea += signedArea;
    weighted.addScaledVector(
      new THREE.Vector3().addVectors(origin, p1).add(p2).divideScalar(3),
      signedArea,
    );
  }

  if (Math.abs(totalArea) < 1e-7) return mean;
  return weighted.divideScalar(totalArea);
}

/**
 * Builds a right-handed rigid `Matrix4` at `origin` whose local `+Y` axis aligns with `normal`.
 */
export function makeSurfaceBasisMatrix(
  origin: THREE.Vector3,
  normal: THREE.Vector3,
  hintRight?: THREE.Vector3,
): THREE.Matrix4 {
  const yAxis = normal.clone().normalize();
  if (yAxis.lengthSq() < 1e-8) yAxis.set(0, 1, 0);

  const right = hintRight ? hintRight.clone() : new THREE.Vector3(1, 0, 0);
  // Orthogonalize against yAxis; fall back to another axis if collinear.
  right.addScaledVector(yAxis, -right.dot(yAxis));
  if (right.lengthSq() < 1e-6) {
    right.set(Math.abs(yAxis.x) < 0.9 ? 1 : 0, 0, Math.abs(yAxis.x) < 0.9 ? 0 : 1);
    right.addScaledVector(yAxis, -right.dot(yAxis));
  }
  right.normalize();
  const zAxis = new THREE.Vector3().crossVectors(right, yAxis).normalize();
  return new THREE.Matrix4().makeBasis(right, yAxis, zAxis).setPosition(origin);
}

export interface BuildRoomSurfaceParams {
  readonly id: string;
  readonly source: SurfaceSource;
  readonly semanticLabel: string | null;
  readonly orientation?: XRPlaneOrientation;
  readonly revision: number;
  readonly lastChangedTime: number;
  readonly worldMatrix: THREE.Matrix4;
  readonly localPolygon: readonly LocalPolygonPoint[];
  readonly extraBoundsPoints?: readonly THREE.Vector3[];
  readonly meshVertices?: Float32Array;
  readonly meshIndices?: Uint32Array;
}

/** Constructs a `RoomSurface` from a 2D local polygon and local-to-world `Matrix4`. */
export function buildRoomSurfaceFromLocalPolygon(params: BuildRoomSurfaceParams): RoomSurface {
  const worldMatrix = params.worldMatrix.clone();
  const normal = new THREE.Vector3(0, 1, 0).transformDirection(worldMatrix).normalize();
  const localPolygon = params.localPolygon.map((p) => ({ x: p.x, z: p.z }));
  const polygon = localPolygon.map((p) => new THREE.Vector3(p.x, 0, p.z).applyMatrix4(worldMatrix));
  const bounds = new THREE.Box3();
  if (params.extraBoundsPoints && params.extraBoundsPoints.length > 0) {
    for (const vertex of params.extraBoundsPoints) bounds.expandByPoint(vertex);
    for (const vertex of polygon) bounds.expandByPoint(vertex);
  } else {
    bounds.setFromPoints(polygon);
  }
  const center = computePolygonCentroid(polygon);
  const orientation: XRPlaneOrientation =
    params.orientation ?? (Math.abs(normal.y) >= 0.7 ? 'horizontal' : 'vertical');

  return {
    id: params.id,
    source: params.source,
    kind: classifySemanticLabel(params.semanticLabel),
    semanticLabel: params.semanticLabel,
    orientation,
    revision: params.revision,
    lastChangedTime: params.lastChangedTime,
    worldMatrix,
    normal,
    center,
    localPolygon,
    polygon,
    bounds,
    ...(params.meshVertices ? { meshVertices: params.meshVertices } : {}),
    ...(params.meshIndices ? { meshIndices: params.meshIndices } : {}),
  };
}

function cross2D(o: LocalPolygonPoint, a: LocalPolygonPoint, b: LocalPolygonPoint): number {
  return (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
}

/** Computes a 2D convex hull in `(x, z)` using Andrew's monotone chain. */
function computeConvexHull2D(points: readonly LocalPolygonPoint[]): LocalPolygonPoint[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => (a.x !== b.x ? a.x - b.x : a.z - b.z));
  const unique: LocalPolygonPoint[] = [];
  for (const p of sorted) {
    const prev = unique[unique.length - 1];
    if (!prev || Math.abs(p.x - prev.x) > HULL_EPSILON || Math.abs(p.z - prev.z) > HULL_EPSILON) {
      unique.push({ x: p.x, z: p.z });
    }
  }
  if (unique.length < 3) return [];

  const lower: LocalPolygonPoint[] = [];
  for (const p of unique) {
    while (lower.length >= 2) {
      const a = lower[lower.length - 2] as LocalPolygonPoint;
      const b = lower[lower.length - 1] as LocalPolygonPoint;
      if (cross2D(a, b, p) <= HULL_EPSILON) lower.pop();
      else break;
    }
    lower.push(p);
  }

  const upper: LocalPolygonPoint[] = [];
  for (let i = unique.length - 1; i >= 0; i -= 1) {
    const p = unique[i] as LocalPolygonPoint;
    while (upper.length >= 2) {
      const a = upper[upper.length - 2] as LocalPolygonPoint;
      const b = upper[upper.length - 1] as LocalPolygonPoint;
      if (cross2D(a, b, p) <= HULL_EPSILON) upper.pop();
      else break;
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

interface ExtractedMeshLocal {
  readonly localToMeshMatrix: THREE.Matrix4;
  readonly localPolygon: readonly LocalPolygonPoint[];
  readonly localVertices: readonly THREE.Vector3[];
}

function extractMeshLocalGeometry(
  mesh: XRMesh,
  meshPoseMatrix: THREE.Matrix4,
): ExtractedMeshLocal | null {
  const { vertices, indices } = mesh;
  const vertexCount = Math.floor(vertices.length / 3);
  if (vertexCount < 3) return null;

  const localVertices: THREE.Vector3[] = [];
  for (let i = 0; i < vertexCount; i += 1) {
    localVertices.push(
      new THREE.Vector3(vertices[i * 3] ?? 0, vertices[i * 3 + 1] ?? 0, vertices[i * 3 + 2] ?? 0),
    );
  }

  const areaNormal = new THREE.Vector3();
  const edgeA = new THREE.Vector3();
  const edgeB = new THREE.Vector3();
  const triCross = new THREE.Vector3();
  let totalArea = 0;

  for (let i = 0; i + 2 < indices.length; i += 3) {
    const ia = indices[i] ?? 0;
    const ib = indices[i + 1] ?? 0;
    const ic = indices[i + 2] ?? 0;
    const va = localVertices[ia];
    const vb = localVertices[ib];
    const vc = localVertices[ic];
    if (!va || !vb || !vc) continue;
    edgeA.subVectors(vb, va);
    edgeB.subVectors(vc, va);
    triCross.crossVectors(edgeA, edgeB);
    const len = triCross.length();
    if (!Number.isFinite(len) || len < 1e-9) continue;
    totalArea += len;
    areaNormal.add(triCross);
  }

  _scratchInvRotation.extractRotation(meshPoseMatrix).invert();
  _scratchWorldUp.set(0, 1, 0).applyMatrix4(_scratchInvRotation).normalize();

  const kind = classifySemanticLabel(mesh.semanticLabel);
  const localNormal = new THREE.Vector3();
  const isPlanarOpen = totalArea > 1e-8 && areaNormal.length() > 1e-3 * totalArea;

  if (isPlanarOpen) {
    localNormal.copy(areaNormal).normalize();
    if ((kind === 'floor' || kind === 'table') && localNormal.dot(_scratchWorldUp) < -0.5) {
      localNormal.negate();
    } else if (kind === 'ceiling' && localNormal.dot(_scratchWorldUp) > 0.5) {
      localNormal.negate();
    }
  } else if (kind === 'ceiling') {
    localNormal.copy(_scratchWorldUp).negate();
  } else if (kind === 'floor' || kind === 'table') {
    localNormal.copy(_scratchWorldUp);
  } else {
    // Closed non-horizontal mesh: pick thinnest AABB axis pointing toward origin.
    const box = new THREE.Box3().setFromPoints(localVertices);
    const size = box.getSize(new THREE.Vector3());
    if (size.x <= size.y && size.x <= size.z) localNormal.set(1, 0, 0);
    else if (size.z <= size.x && size.z <= size.y) localNormal.set(0, 0, 1);
    else localNormal.set(0, 1, 0);
    const worldCenter = box.getCenter(new THREE.Vector3()).applyMatrix4(meshPoseMatrix);
    const worldN = localNormal.clone().transformDirection(meshPoseMatrix);
    if (worldN.dot(worldCenter) > 0) localNormal.negate();
  }

  let minProj = Number.POSITIVE_INFINITY;
  let maxProj = Number.NEGATIVE_INFINITY;
  for (const v of localVertices) {
    const proj = v.dot(localNormal);
    if (proj < minProj) minProj = proj;
    if (proj > maxProj) maxProj = proj;
  }

  const spread = maxProj - minProj;
  const threshold = spread > MESH_PLANE_BAND_M ? maxProj - MESH_PLANE_BAND_M : minProj - 1;
  const faceVertices = localVertices.filter((v) => v.dot(localNormal) >= threshold);
  const supportVertices = faceVertices.length >= 3 ? faceVertices : localVertices;

  const faceCenter = new THREE.Vector3();
  for (const v of supportVertices) faceCenter.add(v);
  faceCenter.divideScalar(supportVertices.length);

  // Project origin onto the supporting plane at maxProj.
  const originDelta = maxProj - faceCenter.dot(localNormal);
  const planeOrigin = faceCenter.clone().addScaledVector(localNormal, originDelta);
  const localToMeshMatrix = makeSurfaceBasisMatrix(planeOrigin, localNormal);
  const invLocalToMesh = localToMeshMatrix.clone().invert();

  const projected: LocalPolygonPoint[] = [];
  const tmp = new THREE.Vector3();
  for (const v of supportVertices) {
    tmp.copy(v).applyMatrix4(invLocalToMesh);
    projected.push({ x: tmp.x, z: tmp.z });
  }

  let localPolygon = computeConvexHull2D(projected);
  if (localPolygon.length < 3) {
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const p of projected) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    if (maxX - minX < 1e-4 || maxZ - minZ < 1e-4) return null;
    localPolygon = [
      { x: minX, z: minZ },
      { x: maxX, z: minZ },
      { x: maxX, z: maxZ },
      { x: minX, z: maxZ },
    ];
  }

  return { localToMeshMatrix, localPolygon, localVertices };
}

function toMatrix4(input: SurfacePoseInput): THREE.Matrix4 {
  if (input instanceof THREE.Matrix4) return input.clone();
  const pos = new THREE.Vector3(input.position.x, input.position.y, input.position.z);
  const quat = input.quaternion
    ? new THREE.Quaternion(
        input.quaternion.x,
        input.quaternion.y,
        input.quaternion.z,
        input.quaternion.w,
      )
    : new THREE.Quaternion();
  const scale = input.scale
    ? new THREE.Vector3(input.scale.x, input.scale.y, input.scale.z)
    : new THREE.Vector3(1, 1, 1);
  return new THREE.Matrix4().compose(pos, quat, scale);
}

function matricesDiffer(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < 16; i += 1) {
    if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > MATRIX_EPSILON) return true;
  }
  return false;
}

function buildStatusDetails(
  status: RoomScanStatus,
  surfaceCount: number,
): { title: string; message: string; canFallback: boolean } {
  switch (status) {
    case 'scanning':
      return {
        title: 'Scanning Room',
        message:
          'Scanning room surfaces… Look around your space or switch to the Virtual Tactical Arena.',
        canFallback: true,
      };
    case 'ready':
      return {
        title: 'Room Scan Ready',
        message: `Room scan ready (${surfaceCount} surface${surfaceCount === 1 ? '' : 's'} detected).`,
        canFallback: true,
      };
    case 'empty':
      return {
        title: 'No Surfaces Detected',
        message:
          'Room scan permission is granted, but no surfaces were detected. Run Room Setup on Quest or switch to the Virtual Tactical Arena.',
        canFallback: true,
      };
    case 'denied':
      return {
        title: 'Room Scan Permission Denied',
        message:
          'Spatial room-scan permission was denied. Allow Spatial Data access in Quest Browser or switch to the Virtual Tactical Arena.',
        canFallback: true,
      };
    case 'unsupported':
      return {
        title: 'Room Scan Unavailable',
        message:
          'WebXR plane/mesh detection is unsupported in this session. Switch to the Virtual Tactical Arena to play.',
        canFallback: true,
      };
    case 'virtual-fallback':
      return {
        title: 'Virtual Tactical Arena',
        message: 'Using the Virtual Tactical Arena (4.8 m × 4.2 m × 2.8 m).',
        canFallback: false,
      };
  }
}

function readGrantedFeatures(frame: XRFrame): GrantedScanFeatures {
  const session = frame.session as (XRSession & { enabledFeatures?: Iterable<string> }) | undefined;
  if (session?.enabledFeatures) {
    const set = new Set<string>(session.enabledFeatures);
    return {
      planeDetection: set.has('plane-detection'),
      meshDetection: set.has('mesh-detection'),
    };
  }
  return {
    planeDetection: frame.detectedPlanes !== undefined,
    meshDetection: frame.detectedMeshes !== undefined,
  };
}

function isPermissionDeniedError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = String(error.name);
    if (name === 'NotAllowedError' || name === 'SecurityError') return true;
  }
  const msg =
    typeof error === 'object' && error !== null && 'message' in error
      ? String(error.message).toLowerCase()
      : typeof error === 'string'
        ? error.toLowerCase()
        : '';
  return msg.includes('denied') || msg.includes('permission');
}

interface TrackedSourceEntry {
  readonly id: string;
  revision: number;
  lastChangedTime: number;
  lastMatrixElements: number[];
}

interface InternalAnchorRecord {
  readonly id: string;
  readonly surfaceId: string;
  readonly localMatrix: THREE.Matrix4;
  readonly worldMatrix: THREE.Matrix4;
  readonly worldPosition: THREE.Vector3;
  readonly worldQuaternion: THREE.Quaternion;
  visible: boolean;
  tracked: boolean;
  readonly visual?: THREE.Object3D;
  readonly collider?: AnchorColliderTarget;
  readonly onUpdate?: (anchor: SurfaceAnchor) => void;
}

/** Creates the unified `RoomSurfaceModel` consumed by `nav/`, `mr/`, and `xr/`. */
export function createRoomSurfaceModel(options: RoomSurfaceModelOptions = {}): RoomSurfaceModel {
  const emptyGraceMs = options.emptyGraceMs ?? DEFAULT_EMPTY_GRACE_MS;
  const autoFallbackOnUnavailable = options.autoFallbackOnUnavailable ?? false;
  const nowFn = options.now ?? (() => performance.now());
  const virtualSurfacesProvider = options.virtualSurfacesProvider ?? createVirtualRoomSurfaces;

  let status: RoomScanStatus = options.initialMode ?? 'scanning';
  let modelRevision = 0;
  let surfaces: readonly RoomSurface[] = [];
  let surfaceMap = new Map<string, RoomSurface>();
  let grantedFeatures: GrantedScanFeatures = { planeDetection: false, meshDetection: false };
  let usingVirtualFallback = status === 'virtual-fallback';
  let noticeDismissed = false;
  let permissionDenied = false;
  let spatialSupported: boolean | undefined;
  let scanStartedAtMs: number | null = null;
  let nextPlaneIndex = 1;
  let nextMeshIndex = 1;
  let nextAnchorIndex = 1;

  const trackedSources = new Map<XRPlane | XRMesh, TrackedSourceEntry>();
  const meshLocalCache = new WeakMap<
    XRMesh,
    { lastChangedTime: number; extracted: ExtractedMeshLocal | null }
  >();
  const anchors = new Map<string, InternalAnchorRecord>();
  const listeners = new Set<RoomSurfaceListener>();

  function toPublicAnchor(record: InternalAnchorRecord): SurfaceAnchor {
    return {
      id: record.id,
      surfaceId: record.surfaceId,
      localMatrix: record.localMatrix,
      worldMatrix: record.worldMatrix,
      worldPosition: record.worldPosition,
      worldQuaternion: record.worldQuaternion,
      visible: record.visible,
      tracked: record.tracked,
      ...(record.visual ? { visual: record.visual } : {}),
      ...(record.collider ? { collider: record.collider } : {}),
    };
  }

  function applyAnchor(record: InternalAnchorRecord, surface: RoomSurface | undefined): void {
    if (surface) {
      record.tracked = true;
      record.visible = true;
      record.worldMatrix.copy(surface.worldMatrix).multiply(record.localMatrix);
      record.worldMatrix.decompose(record.worldPosition, record.worldQuaternion, _scratchScale);

      if (record.visual) {
        record.visual.visible = true;
        record.visual.position.copy(record.worldPosition);
        record.visual.quaternion.copy(record.worldQuaternion);
        record.visual.scale.copy(_scratchScale);
        record.visual.updateMatrix();
        record.visual.updateMatrixWorld(true);
      }

      if (record.collider) {
        record.collider.visible = true;
        record.collider.position.copy(record.worldPosition);
        record.collider.quaternion.copy(record.worldQuaternion);
        if (record.collider.scale) record.collider.scale.copy(_scratchScale);
        if (record.collider.matrix) record.collider.matrix.copy(record.worldMatrix);
        record.collider.updateMatrixWorld?.(true);
      }
    } else {
      record.tracked = false;
      record.visible = false;
      if (record.visual) record.visual.visible = false;
      if (record.collider) record.collider.visible = false;
    }

    record.onUpdate?.(toPublicAnchor(record));
  }

  function syncAllAnchors(): void {
    for (const record of anchors.values()) {
      applyAnchor(record, surfaceMap.get(record.surfaceId));
    }
  }

  function buildSnapshot(): RoomSurfaceSnapshot {
    const details = buildStatusDetails(status, surfaces.length);
    return {
      status,
      revision: modelRevision,
      surfaces,
      grantedFeatures,
      statusMessage: details.message,
      notice: {
        status,
        title: details.title,
        message: details.message,
        canFallback: details.canFallback,
        dismissed: noticeDismissed,
      },
      usingVirtualFallback,
    };
  }

  function notify(): void {
    if (listeners.size === 0) return;
    const snap = buildSnapshot();
    for (const listener of [...listeners]) {
      try {
        listener(snap);
      } catch (error) {
        console.error('[room-scan]', error);
      }
    }
  }

  function setSurfaces(nextSurfaces: readonly RoomSurface[], forceBump = false): boolean {
    let changed = forceBump || nextSurfaces.length !== surfaces.length;
    if (!changed) {
      for (let i = 0; i < nextSurfaces.length; i += 1) {
        const prev = surfaces[i];
        const next = nextSurfaces[i];
        if (!prev || !next || prev.id !== next.id || prev.revision !== next.revision) {
          changed = true;
          break;
        }
      }
    }
    surfaces = nextSurfaces;
    const nextMap = new Map<string, RoomSurface>();
    for (const surface of nextSurfaces) nextMap.set(surface.id, surface);
    surfaceMap = nextMap;
    if (changed) modelRevision += 1;
    syncAllAnchors();
    return changed;
  }

  function enterVirtualFallback(): RoomSurfaceSnapshot {
    const virtualSurfaces = virtualSurfacesProvider();
    const prevStatus = status;
    const prevFallback = usingVirtualFallback;
    status = 'virtual-fallback';
    usingVirtualFallback = true;
    noticeDismissed = false;
    const surfacesChanged = setSurfaces(
      virtualSurfaces,
      prevStatus !== status || prevFallback !== usingVirtualFallback,
    );
    if (surfacesChanged || prevStatus !== status || prevFallback !== usingVirtualFallback) {
      notify();
    }
    return buildSnapshot();
  }

  if (usingVirtualFallback) {
    const initialSurfaces = virtualSurfacesProvider();
    setSurfaces(initialSurfaces, initialSurfaces.length > 0);
  }

  function getOrUpdateTrackedEntry(
    sourceObj: XRPlane | XRMesh,
    kind: 'plane' | 'mesh',
    lastChangedTime: number,
    worldMatrix: THREE.Matrix4,
  ): TrackedSourceEntry {
    const existing = trackedSources.get(sourceObj);
    if (!existing) {
      const id = kind === 'plane' ? `plane-${nextPlaneIndex++}` : `mesh-${nextMeshIndex++}`;
      const entry: TrackedSourceEntry = {
        id,
        revision: 1,
        lastChangedTime,
        lastMatrixElements: [...worldMatrix.elements],
      };
      trackedSources.set(sourceObj, entry);
      return entry;
    }

    if (
      existing.lastChangedTime !== lastChangedTime ||
      matricesDiffer(existing.lastMatrixElements, worldMatrix.elements)
    ) {
      existing.revision += 1;
      existing.lastChangedTime = lastChangedTime;
      existing.lastMatrixElements = [...worldMatrix.elements];
    }
    return existing;
  }

  return {
    get status() {
      return status;
    },
    get revision() {
      return modelRevision;
    },
    get surfaces() {
      return surfaces;
    },
    get grantedFeatures() {
      return grantedFeatures;
    },
    get statusMessage() {
      return buildStatusDetails(status, surfaces.length).message;
    },
    get notice() {
      const details = buildStatusDetails(status, surfaces.length);
      return {
        status,
        title: details.title,
        message: details.message,
        canFallback: details.canFallback,
        dismissed: noticeDismissed,
      };
    },
    get usingVirtualFallback() {
      return usingVirtualFallback;
    },
    getSurface(id) {
      return surfaceMap.get(id);
    },
    getSurfacesByKind(kind) {
      return surfaces.filter((s) => s.kind === kind);
    },
    setSession(session, sessionOptions) {
      if (sessionOptions?.permissionDenied !== undefined) {
        permissionDenied = sessionOptions.permissionDenied;
      }
      if (sessionOptions?.spatialSupported !== undefined) {
        spatialSupported = sessionOptions.spatialSupported;
      }
      if (!session) {
        scanStartedAtMs = null;
        return;
      }
      const features = new Set<string>(
        (session as XRSession & { enabledFeatures?: Iterable<string> }).enabledFeatures ?? [],
      );
      grantedFeatures = {
        planeDetection: features.has('plane-detection'),
        meshDetection: features.has('mesh-detection'),
      };
      scanStartedAtMs = nowFn();
      if (!grantedFeatures.planeDetection && !grantedFeatures.meshDetection) {
        const nextStatus: RoomScanStatus =
          permissionDenied || spatialSupported === true ? 'denied' : 'unsupported';
        if (autoFallbackOnUnavailable) {
          enterVirtualFallback();
          return;
        }
        if (status !== nextStatus) {
          status = nextStatus;
          modelRevision += 1;
          notify();
        }
      }
    },
    reportSessionError(error) {
      permissionDenied = isPermissionDeniedError(error);
      const nextStatus: RoomScanStatus = permissionDenied ? 'denied' : 'unsupported';
      if (autoFallbackOnUnavailable) {
        enterVirtualFallback();
        return;
      }
      const prevStatus = status;
      status = nextStatus;
      noticeDismissed = false;
      const changed = setSurfaces([], prevStatus !== status);
      if (changed || prevStatus !== status) notify();
    },
    activateVirtualFallback() {
      return enterVirtualFallback();
    },
    deactivateVirtualFallback() {
      if (!usingVirtualFallback) return buildSnapshot();
      usingVirtualFallback = false;
      status = 'scanning';
      scanStartedAtMs = null;
      noticeDismissed = false;
      setSurfaces([], true);
      notify();
      return buildSnapshot();
    },
    dismissNotice() {
      if (noticeDismissed) return;
      noticeDismissed = true;
      notify();
    },
    updateFromFrame(frame, referenceSpace, frameOptions) {
      if (usingVirtualFallback) {
        return buildSnapshot();
      }

      if (frameOptions?.permissionDenied !== undefined) {
        permissionDenied = frameOptions.permissionDenied;
      }
      if (frameOptions?.spatialSupported !== undefined) {
        spatialSupported = frameOptions.spatialSupported;
      }

      const prevStatus = status;
      const features = readGrantedFeatures(frame);
      const featuresChanged =
        features.planeDetection !== grantedFeatures.planeDetection ||
        features.meshDetection !== grantedFeatures.meshDetection;
      grantedFeatures = features;

      if (!features.planeDetection && !features.meshDetection) {
        const nextStatus: RoomScanStatus =
          permissionDenied || spatialSupported === true ? 'denied' : 'unsupported';
        if (autoFallbackOnUnavailable) {
          return enterVirtualFallback();
        }
        status = nextStatus;
        if (prevStatus !== status) noticeDismissed = false;
        const changed = setSurfaces([], prevStatus !== status || featuresChanged);
        if (changed) notify();
        return buildSnapshot();
      }

      const nowMs = frameOptions?.nowMs ?? nowFn();
      if (scanStartedAtMs === null) scanStartedAtMs = nowMs;

      const nextSurfaces: RoomSurface[] = [];

      if (features.planeDetection) {
        let planes: Iterable<XRPlane> | undefined;
        try {
          planes = frame.detectedPlanes;
        } catch {
          planes = undefined;
        }
        for (const plane of planes ?? []) {
          if (plane.polygon.length < 3) continue;
          const pose = frame.getPose(plane.planeSpace, referenceSpace);
          if (!pose) continue;
          const worldMatrix = new THREE.Matrix4().fromArray(pose.transform.matrix);
          const tracked = getOrUpdateTrackedEntry(
            plane,
            'plane',
            plane.lastChangedTime,
            worldMatrix,
          );
          const localPolygon = plane.polygon.map((p) => ({ x: p.x, z: p.z }));
          nextSurfaces.push(
            buildRoomSurfaceFromLocalPolygon({
              id: tracked.id,
              source: 'plane',
              semanticLabel: plane.semanticLabel ?? null,
              orientation: plane.orientation,
              revision: tracked.revision,
              lastChangedTime: plane.lastChangedTime,
              worldMatrix,
              localPolygon,
            }),
          );
        }
      }

      if (features.meshDetection) {
        let meshes: Iterable<XRMesh> | undefined;
        try {
          meshes = frame.detectedMeshes;
        } catch {
          meshes = undefined;
        }
        for (const mesh of meshes ?? []) {
          const pose = frame.getPose(mesh.meshSpace, referenceSpace);
          if (!pose) continue;
          const meshPoseMatrix = new THREE.Matrix4().fromArray(pose.transform.matrix);

          let cached = meshLocalCache.get(mesh);
          if (!cached || cached.lastChangedTime !== mesh.lastChangedTime) {
            cached = {
              lastChangedTime: mesh.lastChangedTime,
              extracted: extractMeshLocalGeometry(mesh, meshPoseMatrix),
            };
            meshLocalCache.set(mesh, cached);
          }
          const extracted = cached.extracted;
          if (!extracted) continue;

          const worldMatrix = meshPoseMatrix.clone().multiply(extracted.localToMeshMatrix);
          const tracked = getOrUpdateTrackedEntry(mesh, 'mesh', mesh.lastChangedTime, worldMatrix);
          const extraBoundsPoints = extracted.localVertices.map((v) =>
            v.clone().applyMatrix4(meshPoseMatrix),
          );
          nextSurfaces.push(
            buildRoomSurfaceFromLocalPolygon({
              id: tracked.id,
              source: 'mesh',
              semanticLabel: mesh.semanticLabel ?? null,
              revision: tracked.revision,
              lastChangedTime: mesh.lastChangedTime,
              worldMatrix,
              localPolygon: extracted.localPolygon,
              extraBoundsPoints,
              meshVertices: mesh.vertices,
              meshIndices: mesh.indices,
            }),
          );
        }
      }

      let nextStatus: RoomScanStatus;
      if (nextSurfaces.length > 0) {
        nextStatus = 'ready';
      } else if (nowMs - scanStartedAtMs < emptyGraceMs) {
        nextStatus = 'scanning';
      } else {
        nextStatus = 'empty';
      }

      if (nextStatus === 'empty' && autoFallbackOnUnavailable) {
        return enterVirtualFallback();
      }

      status = nextStatus;
      if (prevStatus !== status) noticeDismissed = false;
      const changed = setSurfaces(nextSurfaces, prevStatus !== status || featuresChanged);
      if (changed) notify();
      return buildSnapshot();
    },
    attachAnchor(surfaceId, localPose, target) {
      const id = `anchor-${nextAnchorIndex++}`;
      const record: InternalAnchorRecord = {
        id,
        surfaceId,
        localMatrix: toMatrix4(localPose),
        worldMatrix: new THREE.Matrix4(),
        worldPosition: new THREE.Vector3(),
        worldQuaternion: new THREE.Quaternion(),
        visible: false,
        tracked: false,
        visual: target?.visual,
        collider: target?.collider,
        onUpdate: target?.onUpdate,
      };
      anchors.set(id, record);
      applyAnchor(record, surfaceMap.get(surfaceId));
      return toPublicAnchor(record);
    },
    detachAnchor(anchorId) {
      return anchors.delete(anchorId);
    },
    getAnchor(anchorId) {
      const record = anchors.get(anchorId);
      return record ? toPublicAnchor(record) : undefined;
    },
    getAnchors() {
      return [...anchors.values()].map(toPublicAnchor);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot() {
      return buildSnapshot();
    },
    reset() {
      trackedSources.clear();
      anchors.clear();
      surfaces = [];
      surfaceMap.clear();
      grantedFeatures = { planeDetection: false, meshDetection: false };
      permissionDenied = false;
      spatialSupported = undefined;
      scanStartedAtMs = null;
      noticeDismissed = false;
      usingVirtualFallback = options.initialMode === 'virtual-fallback';
      status = usingVirtualFallback ? 'virtual-fallback' : 'scanning';
      modelRevision += 1;
      if (usingVirtualFallback) {
        const initialSurfaces = virtualSurfacesProvider();
        setSurfaces(initialSurfaces, true);
      }
      notify();
    },
  };
}
