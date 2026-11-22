/**
 * Layered mixed-reality occlusion controller for Rift Bastion (PRD D5, Risks).
 *
 * Supports runtime switching between the three Settings modes:
 * - `'auto-depth'`: prefers WebXR `depth-sensing` (`gpu-optimized` or `cpu-optimized` into a
 *   reusable `THREE.DataTexture` with zero per-frame allocations) and gracefully falls back to
 *   `'room-mesh'` whenever `XRFrame.getDepthInformation` / `XRWebGLBinding.getDepthInformation`
 *   is unavailable.
 * - `'room-mesh'`: depth-only (`colorWrite: false, depthWrite: true`) occluder meshes built from
 *   scanned planes and meshes, with exact geometric portal aperture cutouts (`cutPortalApertures`)
 *   punched through EVERY co-located host surface representation (both plane and offset mesh) and
 *   aligned to the exact portal plane so zero oblique passthrough seam occurs.
 * - `'off'`: disables both depth-sensing shader testing and room-mesh depth occluders.
 *
 * Recessed wall/ceiling dimensional rift portals bypass physical wall depth via BOTH an explicit
 * aperture stencil/mask pass AND analytic portal-cylinder bypass inside `applyDepthOcclusion`,
 * while foreground real hands and furniture in front of the wall remain able to occlude the rim
 * and interior.
 */
import * as THREE from 'three';
import type { RoomOcclusionOption } from '../settings/store.ts';

export type { RoomOcclusionOption };

export type EffectiveOcclusionMode = 'depth-sensing' | 'room-mesh' | 'off';
export type DepthSourceKind = 'none' | 'gpu' | 'cpu';
export type DepthDataFormat = 'luminance-alpha' | 'float32' | 'unsigned-short';

export type OcclusionSurfaceKind = 'floor' | 'table' | 'wall' | 'ceiling' | 'other';
export type OcclusionSurfaceSource = 'plane' | 'mesh' | 'virtual';

export interface LocalPolygonPoint {
  readonly x: number;
  readonly z: number;
}

/**
 * Minimal surface-input interface designed to compose directly with `RoomSurfaceModel`
 * entries from `src/mr/room-scan.ts` without tight coupling.
 */
export interface OcclusionSurface {
  readonly id: string;
  readonly kind: OcclusionSurfaceKind;
  readonly source?: OcclusionSurfaceSource;
  readonly revision: number;
  readonly visible?: boolean;
  /** Local-to-world transform (for planar surfaces: local XZ plane, +Y outward normal). */
  readonly worldMatrix: THREE.Matrix4;
  /** Optional world-space outward normal (derived from worldMatrix +Y when omitted for planes). */
  readonly normal?: THREE.Vector3;
  /** Planar boundary vertices in local XZ coordinates (matches `XRPlane.polygon`). */
  readonly polygon?: readonly LocalPolygonPoint[];
  /** Triangle mesh vertices in surface-local xyz triplets (matches `XRMesh.vertices`). */
  readonly vertices?: Float32Array | readonly number[];
  /** Raw mesh-local vertex transform when it differs from the fitted polygon basis. */
  readonly meshWorldMatrix?: THREE.Matrix4;
  /** Triangle indices into `vertices` (matches `XRMesh.indices`). */
  readonly indices?: Uint32Array | Uint16Array | readonly number[];
  /** Optional world-space bounding box. */
  readonly bounds?: THREE.Box3;
}

export interface PortalAperture {
  readonly id: string;
  /** World-space center of the portal aperture. */
  readonly center: THREE.Vector3;
  /** Unit outward world normal of the portal opening (pointing into the room). */
  readonly normal: THREE.Vector3;
  /** Nominal radius of a circular portal opening in meters (fallback for `radiusX`/`radiusY`). */
  readonly radius: number;
  /** Optional horizontal half-width in meters for elliptical apertures (defaults to `radius`). */
  readonly radiusX?: number;
  /** Optional vertical half-height in meters for elliptical apertures (defaults to `radius`). */
  readonly radiusY?: number;
  /** Optional full world transform (+Z outward normal, XY opening). */
  readonly worldMatrix?: THREE.Matrix4;
  /** Optional explicit host surface ID (co-located siblings within tolerance are also cut). */
  readonly hostSurfaceId?: string;
  /** Optional semantic kind of the host surface (prevents cutting unrelated nearby fixtures). */
  readonly hostKind?: OcclusionSurfaceKind;
}

export interface CutPortalAperturesOptions {
  /** Max perpendicular distance (m) from portal plane for co-located plane/mesh hosts. */
  hostOffsetTolerance?: number;
  /** Min `|dot(surfaceNormal, portalNormal)|` required to treat a surface/face as co-located. */
  normalAlignmentMin?: number;
  /** Number of edges on the circumscribed regular polygon used to punch the circular opening. */
  segments?: number;
  /** Align co-located host surface geometry to the exact portal plane to eliminate oblique seams. */
  alignToPortalPlane?: boolean;
}

export interface CutSurfaceResult {
  readonly geometry: THREE.BufferGeometry;
  readonly cutPortalIds: readonly string[];
  readonly triangleCount: number;
  readonly alignedToPortalPlane: boolean;
}

export type DepthOcclusionRole = 'world-object' | 'portal-rim' | 'portal-interior' | 'portal-mask';

export interface ApplyDepthOcclusionOptions {
  role?: DepthOcclusionRole;
  /** Depth tolerance (m) preventing z-fighting with scanned surfaces. */
  depthBias?: number;
  /** Distance (m) strictly in front of a portal plane where real objects still occlude the portal. */
  foregroundMargin?: number;
  /** Stencil reference value used for portal-mask and portal-interior passes. */
  stencilRef?: number;
}

export interface DepthOcclusionBinding {
  readonly role: DepthOcclusionRole;
  dispose(): void;
}

export interface DepthViewUniformState {
  readonly viewIndex: number;
  readonly source: DepthSourceKind;
  readonly format: DepthDataFormat | null;
  readonly texture: THREE.Texture | null;
  readonly dataTexture: THREE.DataTexture | null;
  readonly backingBuffer: ArrayBufferLike | null;
  readonly width: number;
  readonly height: number;
  readonly rawValueToMeters: number;
  readonly normDepthBufferFromNormView: THREE.Matrix4;
  readonly arrayLayer: number;
}

export interface DepthOcclusionUniforms {
  readonly uRbOccEnabled: { value: number };
  readonly uRbDepthTex: { value: THREE.Texture };
  readonly uRbDepthArrayTex: { value: THREE.Texture };
  readonly uRbDepthEncoding: { value: number };
  readonly uRbDepthArrayLayer: { value: number };
  readonly uRbNormDepthFromNormView: { value: THREE.Matrix4 };
  readonly uRbRawValueToMeters: { value: number };
  readonly uRbPortalCount: { value: number };
  readonly uRbPortalInvWorld: { value: THREE.Matrix4[] };
  readonly uRbPortalRadius: { value: number[] };
  readonly uRbPortalRadii: { value: THREE.Vector2[] };
}

export interface OcclusionState {
  readonly requestedMode: RoomOcclusionOption;
  readonly effectiveMode: EffectiveOcclusionMode;
  readonly depthAvailable: boolean;
  readonly depthSource: DepthSourceKind;
  readonly depthDataFormat: DepthDataFormat | null;
  readonly depthWidth: number;
  readonly depthHeight: number;
  readonly occluderMeshCount: number;
  readonly portalCount: number;
}

export type OcclusionListener = (state: Readonly<OcclusionState>) => void;

export interface OcclusionControllerOptions {
  initialMode?: RoomOcclusionOption;
  missingDepthFallback?: 'room-mesh' | 'off';
  cutOptions?: CutPortalAperturesOptions;
  /** Max views buffered (default 2 for stereo XR). */
  maxViews?: number;
}

export interface UpdateFromXrFrameOptions {
  glBinding?: XRWebGLBinding | null;
  viewerPose?: XRViewerPose | null;
}

export interface OcclusionController {
  readonly root: THREE.Group;
  readonly roomMeshRoot: THREE.Group;
  readonly state: Readonly<OcclusionState>;
  readonly requestedMode: RoomOcclusionOption;
  readonly effectiveMode: EffectiveOcclusionMode;
  readonly uniforms: DepthOcclusionUniforms;
  setMode(mode: RoomOcclusionOption): EffectiveOcclusionMode;
  setPortals(portals: readonly PortalAperture[]): void;
  getPortals(): readonly PortalAperture[];
  syncRoomSurfaces(surfaces: Iterable<OcclusionSurface>): void;
  getOccluderMesh(surfaceId: string): THREE.Mesh | undefined;
  updateFromXrFrame(
    frame: XRFrame | undefined,
    referenceSpace: XRReferenceSpace | null,
    options?: UpdateFromXrFrameOptions,
  ): EffectiveOcclusionMode;
  bindView(viewIndex: number): boolean;
  bindCamera(camera: THREE.Camera, xrCamera?: { cameras?: readonly THREE.Camera[] }): number;
  getViewDepthState(viewIndex?: number): Readonly<DepthViewUniformState> | null;
  resetDepth(): void;
  subscribe(listener: OcclusionListener): () => void;
  dispose(): void;
}

export const MAX_PORTAL_APERTURES = 4;
export const PORTAL_APERTURE_STENCIL_REF = 1;
export const ROOM_OCCLUDER_RENDER_ORDER = -100;
export const PORTAL_MASK_RENDER_ORDER = -10;
export const DEFAULT_HOST_OFFSET_TOLERANCE = 0.15;
export const DEFAULT_NORMAL_ALIGNMENT_MIN = 0.94;
export const DEFAULT_APERTURE_SEGMENTS = 32;
export const DEFAULT_DEPTH_BIAS = 0.02;
export const DEFAULT_PORTAL_RIM_DEPTH_BIAS = 0.04;
export const DEFAULT_FOREGROUND_MARGIN = 0.12;

const DEPTH_ENCODING_CPU_RG8_UINT16 = 0;
const DEPTH_ENCODING_GPU_LA8_UINT16 = 1;
const DEPTH_ENCODING_FLOAT32_R = 2;
const DEPTH_ENCODING_GPU_ARRAY_R = 3;

const CLIP_EPS = 1e-6;
const DEGENERATE_AREA_SQ = 1e-12;
const POINT_DUP_EPS_SQ = 1e-12;

interface Point3 {
  x: number;
  y: number;
  z: number;
}

interface Triangle3 {
  a: Point3;
  b: Point3;
  c: Point3;
}

interface HalfPlane2D {
  nx: number;
  ny: number;
}

interface CompiledPortal {
  readonly portal: PortalAperture;
  readonly worldMatrix: THREE.Matrix4;
  readonly invWorld: THREE.Matrix4;
  readonly normal: THREE.Vector3;
  readonly center: THREE.Vector3;
  readonly radius: number;
  readonly radiusX: number;
  readonly radiusY: number;
  readonly unitCircumradius: number;
  readonly halfPlanes: readonly HalfPlane2D[];
}

const _basisX = new THREE.Vector3();
const _basisY = new THREE.Vector3();
const _basisZ = new THREE.Vector3();
const _refAxis = new THREE.Vector3();
const _tmpVecA = new THREE.Vector3();
const _tmpVecB = new THREE.Vector3();
const _tmpVecC = new THREE.Vector3();
const _tmpEdge1 = new THREE.Vector3();
const _tmpEdge2 = new THREE.Vector3();
const _tmpNormal = new THREE.Vector3();
const _tmpInvMat = new THREE.Matrix4();

/**
 * Builds an orthonormal world matrix for a portal aperture (+Z outward normal, XY circular rim).
 */
export function buildPortalWorldMatrix(
  portal: PortalAperture,
  target = new THREE.Matrix4(),
): THREE.Matrix4 {
  if (portal.worldMatrix) {
    target.copy(portal.worldMatrix);
    return target;
  }
  _basisZ.copy(portal.normal);
  if (_basisZ.lengthSq() < 1e-12) {
    _basisZ.set(0, 0, 1);
  } else {
    _basisZ.normalize();
  }
  if (Math.abs(_basisZ.y) < 0.9) {
    _refAxis.set(0, 1, 0);
  } else {
    _refAxis.set(1, 0, 0);
  }
  _basisX.crossVectors(_refAxis, _basisZ).normalize();
  _basisY.crossVectors(_basisZ, _basisX).normalize();
  target.makeBasis(_basisX, _basisY, _basisZ);
  target.setPosition(portal.center);
  return target;
}

function buildApertureHalfPlanes(segments: number): HalfPlane2D[] {
  const count = Math.max(8, Math.round(segments));
  const planes: HalfPlane2D[] = [];
  for (let i = 0; i < count; i += 1) {
    const theta = (2 * Math.PI * i) / count;
    planes.push({ nx: Math.cos(theta), ny: Math.sin(theta) });
  }
  return planes;
}

function resolvePortalRadii(portal: PortalAperture): { rx: number; ry: number } {
  const fallback = Math.max(0, portal.radius);
  const rx = Math.max(0, portal.radiusX ?? fallback);
  const ry = Math.max(0, portal.radiusY ?? fallback);
  return { rx, ry };
}

function compilePortal(portal: PortalAperture, segments: number): CompiledPortal {
  const worldMatrix = buildPortalWorldMatrix(portal, new THREE.Matrix4());
  const invWorld = worldMatrix.clone().invert();
  const normal = new THREE.Vector3().setFromMatrixColumn(worldMatrix, 2).normalize();
  const center = new THREE.Vector3().setFromMatrixPosition(worldMatrix);
  const { rx, ry } = resolvePortalRadii(portal);
  const radius = Math.max(rx, ry);
  const halfPlanes = buildApertureHalfPlanes(segments);
  const unitCircumradius = 1 / Math.cos(Math.PI / halfPlanes.length);
  return {
    portal,
    worldMatrix,
    invWorld,
    normal,
    center,
    radius,
    radiusX: rx,
    radiusY: ry,
    unitCircumradius,
    halfPlanes,
  };
}

function isKindCompatibleWithPortal(surface: OcclusionSurface, portal: PortalAperture): boolean {
  if (portal.hostSurfaceId && portal.hostSurfaceId === surface.id) return true;
  if (!portal.hostKind || portal.hostKind === 'other') return true;
  if (surface.kind === 'other') return true;
  return surface.kind === portal.hostKind;
}

function pushUniquePoint(list: Point3[], pt: Point3): void {
  const prev = list[list.length - 1];
  if (prev) {
    const dx = pt.x - prev.x;
    const dy = pt.y - prev.y;
    const dz = pt.z - prev.z;
    if (dx * dx + dy * dy + dz * dz <= POINT_DUP_EPS_SQ) return;
  }
  list.push(pt);
}

function finalizePolygonLoop(list: Point3[]): Point3[] {
  if (list.length > 1) {
    const first = list[0] as Point3;
    const last = list[list.length - 1] as Point3;
    const dx = first.x - last.x;
    const dy = first.y - last.y;
    const dz = first.z - last.z;
    if (dx * dx + dy * dy + dz * dz <= POINT_DUP_EPS_SQ) {
      list.pop();
    }
  }
  return list;
}

function triangleAreaSq(a: Point3, b: Point3, c: Point3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const acz = c.z - a.z;
  const cx = aby * acz - abz * acy;
  const cy = abz * acx - abx * acz;
  const cz = abx * acy - aby * acx;
  return cx * cx + cy * cy + cz * cz;
}

function appendConvexFan(out: Triangle3[], poly: readonly Point3[]): void {
  if (poly.length < 3) return;
  const p0 = poly[0] as Point3;
  for (let i = 1; i + 1 < poly.length; i += 1) {
    const p1 = poly[i] as Point3;
    const p2 = poly[i + 1] as Point3;
    if (triangleAreaSq(p0, p1, p2) > DEGENERATE_AREA_SQ) {
      out.push({ a: p0, b: p1, c: p2 });
    }
  }
}

/**
 * Subtracts a circumscribed convex elliptical N-gon aperture (centered at local origin with
 * semi-axes `(radiusX, radiusY)`) from a single triangle in portal-local 3D coordinates. Preserves
 * exact winding and emits zero triangles inside the open ellipse `(x/rx)^2 + (y/ry)^2 < 1`.
 */
function subtractApertureFromLocalTriangle(
  tri: Triangle3,
  portal: CompiledPortal,
  out: Triangle3[],
): boolean {
  const rx = portal.radiusX;
  const ry = portal.radiusY;
  if (rx <= 1e-5 || ry <= 1e-5) {
    out.push(tri);
    return false;
  }
  const crX = rx * portal.unitCircumradius;
  const crY = ry * portal.unitCircumradius;
  const minX = Math.min(tri.a.x, tri.b.x, tri.c.x);
  const maxX = Math.max(tri.a.x, tri.b.x, tri.c.x);
  const minY = Math.min(tri.a.y, tri.b.y, tri.c.y);
  const maxY = Math.max(tri.a.y, tri.b.y, tri.c.y);
  if (maxX < -crX || minX > crX || maxY < -crY || minY > crY) {
    out.push(tri);
    return false;
  }

  const invRx = 1 / rx;
  const invRy = 1 / ry;
  let remaining: Point3[] = [
    { x: tri.a.x * invRx, y: tri.a.y * invRy, z: tri.a.z },
    { x: tri.b.x * invRx, y: tri.b.y * invRy, z: tri.b.z },
    { x: tri.c.x * invRx, y: tri.c.y * invRy, z: tri.c.z },
  ];
  const piecesOutside: Triangle3[] = [];
  let cutAny = false;

  for (const hp of portal.halfPlanes) {
    const { nx, ny } = hp;
    const outside: Point3[] = [];
    const inside: Point3[] = [];

    for (let i = 0; i < remaining.length; i += 1) {
      const curr = remaining[i] as Point3;
      const next = remaining[(i + 1) % remaining.length] as Point3;
      const dCurr = nx * curr.x + ny * curr.y - 1;
      const dNext = nx * next.x + ny * next.y - 1;

      if (dCurr >= -CLIP_EPS) pushUniquePoint(outside, curr);
      if (dCurr <= CLIP_EPS) pushUniquePoint(inside, curr);

      if ((dCurr > CLIP_EPS && dNext < -CLIP_EPS) || (dCurr < -CLIP_EPS && dNext > CLIP_EPS)) {
        const t = dCurr / (dCurr - dNext);
        const inter: Point3 = {
          x: curr.x + t * (next.x - curr.x),
          y: curr.y + t * (next.y - curr.y),
          z: curr.z + t * (next.z - curr.z),
        };
        pushUniquePoint(outside, inter);
        pushUniquePoint(inside, inter);
      }
    }

    finalizePolygonLoop(outside);
    finalizePolygonLoop(inside);

    if (inside.length < 3) {
      // Entire remaining polygon is outside this half-plane -> triangle doesn't touch the aperture!
      if (!cutAny) {
        out.push(tri);
        return false;
      }
      appendConvexFan(piecesOutside, remaining);
      remaining = [];
      break;
    }

    if (outside.length >= 3) {
      appendConvexFan(piecesOutside, outside);
      cutAny = true;
    }
    remaining = inside;
  }

  if (remaining.length >= 3) {
    // Some portion of the triangle fell strictly inside the aperture -> discard `remaining`.
    cutAny = true;
  }

  if (!cutAny) {
    out.push(tri);
    return false;
  }

  for (const piece of piecesOutside) {
    out.push({
      a: { x: piece.a.x * rx, y: piece.a.y * ry, z: piece.a.z },
      b: { x: piece.b.x * rx, y: piece.b.y * ry, z: piece.b.z },
      c: { x: piece.c.x * rx, y: piece.c.y * ry, z: piece.c.z },
    });
  }
  return true;
}

function extractSurfaceWorldTriangles(surface: OcclusionSurface): Triangle3[] {
  const triangles: Triangle3[] = [];

  if (surface.vertices && surface.indices && surface.indices.length >= 3) {
    const { vertices, indices } = surface;
    const worldMatrix = surface.meshWorldMatrix ?? surface.worldMatrix;
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const ia = (indices[i] as number) * 3;
      const ib = (indices[i + 1] as number) * 3;
      const ic = (indices[i + 2] as number) * 3;
      if (ia + 2 >= vertices.length || ib + 2 >= vertices.length || ic + 2 >= vertices.length) {
        continue;
      }
      _tmpVecA
        .set(vertices[ia] as number, vertices[ia + 1] as number, vertices[ia + 2] as number)
        .applyMatrix4(worldMatrix);
      _tmpVecB
        .set(vertices[ib] as number, vertices[ib + 1] as number, vertices[ib + 2] as number)
        .applyMatrix4(worldMatrix);
      _tmpVecC
        .set(vertices[ic] as number, vertices[ic + 1] as number, vertices[ic + 2] as number)
        .applyMatrix4(worldMatrix);
      const a: Point3 = { x: _tmpVecA.x, y: _tmpVecA.y, z: _tmpVecA.z };
      const b: Point3 = { x: _tmpVecB.x, y: _tmpVecB.y, z: _tmpVecB.z };
      const c: Point3 = { x: _tmpVecC.x, y: _tmpVecC.y, z: _tmpVecC.z };
      if (triangleAreaSq(a, b, c) > DEGENERATE_AREA_SQ) {
        triangles.push({ a, b, c });
      }
    }
    // If a planar open mesh has winding flipped opposite its room-facing normal, orient front faces outward.
    if (surface.normal && surface.normal.lengthSq() > 1e-12 && triangles.length > 0) {
      let sumX = 0;
      let sumY = 0;
      let sumZ = 0;
      let totalArea = 0;
      for (const tri of triangles) {
        _tmpEdge1.set(tri.b.x - tri.a.x, tri.b.y - tri.a.y, tri.b.z - tri.a.z);
        _tmpEdge2.set(tri.c.x - tri.a.x, tri.c.y - tri.a.y, tri.c.z - tri.a.z);
        _tmpNormal.crossVectors(_tmpEdge1, _tmpEdge2);
        const len = _tmpNormal.length();
        totalArea += len;
        sumX += _tmpNormal.x;
        sumY += _tmpNormal.y;
        sumZ += _tmpNormal.z;
      }
      const avgLen = Math.hypot(sumX, sumY, sumZ);
      if (totalArea > 1e-8 && avgLen > 0.7 * totalArea) {
        const dot =
          (sumX * surface.normal.x + sumY * surface.normal.y + sumZ * surface.normal.z) / avgLen;
        if (dot < -0.5) {
          for (const tri of triangles) {
            const tmp = tri.b;
            tri.b = tri.c;
            tri.c = tmp;
          }
        }
      }
    }
    return triangles;
  }

  if (surface.polygon && surface.polygon.length >= 3) {
    const contour: THREE.Vector2[] = [];
    for (const pt of surface.polygon) {
      const prev = contour[contour.length - 1];
      if (prev && Math.hypot(pt.x - prev.x, pt.z - prev.y) < 1e-6) continue;
      contour.push(new THREE.Vector2(pt.x, pt.z));
    }
    if (contour.length > 1) {
      const first = contour[0] as THREE.Vector2;
      const last = contour[contour.length - 1] as THREE.Vector2;
      if (first.distanceToSquared(last) < 1e-12) contour.pop();
    }
    if (contour.length < 3) return triangles;

    const faces = THREE.ShapeUtils.triangulateShape(contour, []);
    const { worldMatrix } = surface;
    for (const face of faces) {
      const i0 = face[0] as number;
      const i1 = face[1] as number;
      const i2 = face[2] as number;
      const p0 = contour[i0] as THREE.Vector2;
      const p1 = contour[i1] as THREE.Vector2;
      const p2 = contour[i2] as THREE.Vector2;

      // Ensure local winding faces +Y in local XZ plane before applying worldMatrix.
      const localCrossY = (p1.y - p0.y) * (p2.x - p0.x) - (p1.x - p0.x) * (p2.y - p0.y);
      const v1 = localCrossY >= 0 ? p1 : p2;
      const v2 = localCrossY >= 0 ? p2 : p1;

      _tmpVecA.set(p0.x, 0, p0.y).applyMatrix4(worldMatrix);
      _tmpVecB.set(v1.x, 0, v1.y).applyMatrix4(worldMatrix);
      _tmpVecC.set(v2.x, 0, v2.y).applyMatrix4(worldMatrix);
      const a: Point3 = { x: _tmpVecA.x, y: _tmpVecA.y, z: _tmpVecA.z };
      const b: Point3 = { x: _tmpVecB.x, y: _tmpVecB.y, z: _tmpVecB.z };
      const c: Point3 = { x: _tmpVecC.x, y: _tmpVecC.y, z: _tmpVecC.z };
      if (triangleAreaSq(a, b, c) > DEGENERATE_AREA_SQ) {
        triangles.push({ a, b, c });
      }
    }
  }

  return triangles;
}

function buildGeometryFromWorldTriangles(triangles: readonly Triangle3[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(triangles.length * 9);
  const normals = new Float32Array(triangles.length * 9);

  for (let i = 0; i < triangles.length; i += 1) {
    const tri = triangles[i] as Triangle3;
    const base = i * 9;
    positions[base] = tri.a.x;
    positions[base + 1] = tri.a.y;
    positions[base + 2] = tri.a.z;
    positions[base + 3] = tri.b.x;
    positions[base + 4] = tri.b.y;
    positions[base + 5] = tri.b.z;
    positions[base + 6] = tri.c.x;
    positions[base + 7] = tri.c.y;
    positions[base + 8] = tri.c.z;

    _tmpEdge1.set(tri.b.x - tri.a.x, tri.b.y - tri.a.y, tri.b.z - tri.a.z);
    _tmpEdge2.set(tri.c.x - tri.a.x, tri.c.y - tri.a.y, tri.c.z - tri.a.z);
    _tmpNormal.crossVectors(_tmpEdge1, _tmpEdge2);
    if (_tmpNormal.lengthSq() > 1e-18) _tmpNormal.normalize();
    else _tmpNormal.set(0, 1, 0);

    for (let v = 0; v < 3; v += 1) {
      normals[base + v * 3] = _tmpNormal.x;
      normals[base + v * 3 + 1] = _tmpNormal.y;
      normals[base + v * 3 + 2] = _tmpNormal.z;
    }
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function toPortalLocalPoint(point: Point3, invWorld: THREE.Matrix4): Point3 {
  _tmpVecA.set(point.x, point.y, point.z).applyMatrix4(invWorld);
  return { x: _tmpVecA.x, y: _tmpVecA.y, z: _tmpVecA.z };
}

function toWorldPoint(point: Point3, worldMatrix: THREE.Matrix4): Point3 {
  _tmpVecA.set(point.x, point.y, point.z).applyMatrix4(worldMatrix);
  return { x: _tmpVecA.x, y: _tmpVecA.y, z: _tmpVecA.z };
}

function isTriangleCoLocatedWithPortal(
  tri: Triangle3,
  portal: CompiledPortal,
  hostOffsetTolerance: number,
  normalAlignmentMin: number,
): boolean {
  _tmpEdge1.set(tri.b.x - tri.a.x, tri.b.y - tri.a.y, tri.b.z - tri.a.z);
  _tmpEdge2.set(tri.c.x - tri.a.x, tri.c.y - tri.a.y, tri.c.z - tri.a.z);
  _tmpNormal.crossVectors(_tmpEdge1, _tmpEdge2);
  const lenSq = _tmpNormal.lengthSq();
  if (lenSq <= 1e-18) return false;
  _tmpNormal.multiplyScalar(1 / Math.sqrt(lenSq));

  if (Math.abs(_tmpNormal.dot(portal.normal)) < normalAlignmentMin) {
    return false;
  }

  const da =
    (tri.a.x - portal.center.x) * portal.normal.x +
    (tri.a.y - portal.center.y) * portal.normal.y +
    (tri.a.z - portal.center.z) * portal.normal.z;
  const db =
    (tri.b.x - portal.center.x) * portal.normal.x +
    (tri.b.y - portal.center.y) * portal.normal.y +
    (tri.b.z - portal.center.z) * portal.normal.z;
  const dc =
    (tri.c.x - portal.center.x) * portal.normal.x +
    (tri.c.y - portal.center.y) * portal.normal.y +
    (tri.c.z - portal.center.z) * portal.normal.z;

  return (
    Math.abs(da) <= hostOffsetTolerance &&
    Math.abs(db) <= hostOffsetTolerance &&
    Math.abs(dc) <= hostOffsetTolerance
  );
}

/**
 * Builds world-space occluder geometry for a scanned plane or mesh and punches exact circular
 * portal openings through every co-located host surface representation (both planes AND offset
 * meshes within `hostOffsetTolerance`). Co-located host faces are aligned to the exact portal
 * plane so zero oblique passthrough seam occurs between host plane, offset mesh, and portal rim.
 */
export function cutPortalApertures(
  surface: OcclusionSurface,
  portals: readonly PortalAperture[],
  options: CutPortalAperturesOptions = {},
): CutSurfaceResult {
  const hostOffsetTolerance = options.hostOffsetTolerance ?? DEFAULT_HOST_OFFSET_TOLERANCE;
  const normalAlignmentMin = options.normalAlignmentMin ?? DEFAULT_NORMAL_ALIGNMENT_MIN;
  const segments = options.segments ?? DEFAULT_APERTURE_SEGMENTS;
  const alignToPortalPlane = options.alignToPortalPlane ?? true;

  let triangles = extractSurfaceWorldTriangles(surface);
  const cutPortalIds: string[] = [];
  let alignedToPortalPlane = false;

  if (triangles.length === 0 || portals.length === 0) {
    return {
      geometry: buildGeometryFromWorldTriangles(triangles),
      cutPortalIds,
      triangleCount: triangles.length,
      alignedToPortalPlane,
    };
  }

  for (const portal of portals) {
    if (portal.radius <= 1e-5) continue;
    if (!isKindCompatibleWithPortal(surface, portal)) continue;

    const compiled = compilePortal(portal, segments);
    const nextTriangles: Triangle3[] = [];
    let portalCutThisSurface = false;

    // Identify co-located triangles first so shared corner vertices on a global mesh can be
    // aligned cleanly without tearing adjacent perpendicular walls.
    const coLocatedFlags = new Uint8Array(triangles.length);
    let anyCoLocated = false;
    for (let i = 0; i < triangles.length; i += 1) {
      const tri = triangles[i] as Triangle3;
      if (isTriangleCoLocatedWithPortal(tri, compiled, hostOffsetTolerance, normalAlignmentMin)) {
        coLocatedFlags[i] = 1;
        anyCoLocated = true;
      }
    }

    if (!anyCoLocated) continue;

    for (let i = 0; i < triangles.length; i += 1) {
      const tri = triangles[i] as Triangle3;
      if (coLocatedFlags[i] === 0) {
        // If this non-co-located triangle shares a vertex right on the shifted host wall, snap
        // only vertices that lie within hostOffsetTolerance of the co-located portal plane if
        // the surface actually gets cut. Keep it untouched otherwise so nearby fixtures stay solid.
        nextTriangles.push(tri);
        continue;
      }

      const localA = toPortalLocalPoint(tri.a, compiled.invWorld);
      const localB = toPortalLocalPoint(tri.b, compiled.invWorld);
      const localC = toPortalLocalPoint(tri.c, compiled.invWorld);

      if (alignToPortalPlane) {
        localA.z = 0;
        localB.z = 0;
        localC.z = 0;
      }

      const localPieces: Triangle3[] = [];
      const didCut = subtractApertureFromLocalTriangle(
        { a: localA, b: localB, c: localC },
        compiled,
        localPieces,
      );
      if (didCut) {
        portalCutThisSurface = true;
        if (alignToPortalPlane) alignedToPortalPlane = true;
      }

      for (const piece of localPieces) {
        nextTriangles.push({
          a: toWorldPoint(piece.a, compiled.worldMatrix),
          b: toWorldPoint(piece.b, compiled.worldMatrix),
          c: toWorldPoint(piece.c, compiled.worldMatrix),
        });
      }
    }

    if (portalCutThisSurface) {
      cutPortalIds.push(portal.id);
      triangles = nextTriangles;
    }
  }

  return {
    geometry: buildGeometryFromWorldTriangles(triangles),
    cutPortalIds,
    triangleCount: triangles.length,
    alignedToPortalPlane,
  };
}

/**
 * Pure CPU mirror of the GLSL depth-occlusion + portal-aperture bypass decision used in
 * `applyDepthOcclusion`, useful for deterministic tests and visibility queries.
 */
export function evaluateDepthOcclusionSample(params: {
  viewDepthMeters: number;
  envDepthMeters: number;
  worldPosition: THREE.Vector3;
  cameraPosition: THREE.Vector3;
  portals: readonly PortalAperture[];
  role?: DepthOcclusionRole;
  depthBias?: number;
  foregroundMargin?: number;
}): { readonly occluded: boolean; readonly bypassedByPortal: boolean } {
  const {
    viewDepthMeters,
    envDepthMeters,
    worldPosition,
    cameraPosition,
    portals,
    role = 'world-object',
  } = params;

  if (!Number.isFinite(envDepthMeters) || envDepthMeters <= 0.001) {
    return { occluded: false, bypassedByPortal: false };
  }

  const foregroundMargin = params.foregroundMargin ?? DEFAULT_FOREGROUND_MARGIN;
  const depthBias =
    params.depthBias ??
    (role === 'portal-rim' ? DEFAULT_PORTAL_RIM_DEPTH_BIAS : DEFAULT_DEPTH_BIAS);

  if (role === 'portal-mask' || role === 'portal-rim') {
    // Discard the aperture stencil mask only if a real foreground object (hand/furniture) sits
    // strictly closer than the portal wall plane minus foregroundMargin.
    const occluded = envDepthMeters < viewDepthMeters - Math.max(foregroundMargin, depthBias);
    return { occluded, bypassedByPortal: !occluded };
  }

  if (role === 'portal-interior') {
    // Interior is recessed behind the wall; check if any portal aperture frames this fragment.
    for (const portal of portals) {
      const { rx, ry } = resolvePortalRadii(portal);
      if (rx <= 1e-5 || ry <= 1e-5) continue;
      buildPortalWorldMatrix(portal, _tmpInvMat).invert();
      _tmpVecA.copy(worldPosition).applyMatrix4(_tmpInvMat);
      _tmpVecB.copy(cameraPosition).applyMatrix4(_tmpInvMat);
      if (_tmpVecB.z > 0.001 && _tmpVecA.z <= depthBias) {
        const denom = _tmpVecB.z - _tmpVecA.z;
        if (denom > 1e-4) {
          const t = _tmpVecB.z / denom;
          const hitX = (_tmpVecB.x + t * (_tmpVecA.x - _tmpVecB.x)) / rx;
          const hitY = (_tmpVecB.y + t * (_tmpVecA.y - _tmpVecB.y)) / ry;
          if (hitX * hitX + hitY * hitY <= 1.0) {
            const portalHitViewZ = viewDepthMeters * t;
            const occluded = envDepthMeters < portalHitViewZ - foregroundMargin;
            return { occluded, bypassedByPortal: !occluded };
          }
        }
      }
    }
    const occluded = envDepthMeters < viewDepthMeters - foregroundMargin;
    return { occluded, bypassedByPortal: !occluded };
  }

  if (role === 'world-object') {
    for (const portal of portals) {
      const { rx, ry } = resolvePortalRadii(portal);
      if (rx <= 1e-5 || ry <= 1e-5) continue;
      buildPortalWorldMatrix(portal, _tmpInvMat).invert();
      _tmpVecA.copy(worldPosition).applyMatrix4(_tmpInvMat);
      _tmpVecB.copy(cameraPosition).applyMatrix4(_tmpInvMat);
      if (_tmpVecB.z > 0.001 && _tmpVecA.z <= depthBias) {
        const denom = _tmpVecB.z - _tmpVecA.z;
        if (denom > 1e-4) {
          const t = _tmpVecB.z / denom;
          const hitX = (_tmpVecB.x + t * (_tmpVecA.x - _tmpVecB.x)) / rx;
          const hitY = (_tmpVecB.y + t * (_tmpVecA.y - _tmpVecB.y)) / ry;
          if (hitX * hitX + hitY * hitY <= 1.0) {
            const portalHitViewZ = viewDepthMeters * t;
            if (envDepthMeters >= portalHitViewZ - foregroundMargin) {
              return { occluded: false, bypassedByPortal: true };
            }
            return { occluded: true, bypassedByPortal: false };
          }
        }
      }
    }
  }

  return {
    occluded: envDepthMeters + depthBias < viewDepthMeters,
    bypassedByPortal: false,
  };
}

interface PatchedMaterialRecord {
  readonly role: DepthOcclusionRole;
  readonly previousOnBeforeCompile: THREE.Material['onBeforeCompile'];
  readonly previousCacheKey: THREE.Material['customProgramCacheKey'];
  readonly previousRenderState?: {
    colorWrite: boolean;
    depthWrite: boolean;
    depthTest: boolean;
    stencilWrite: boolean;
    stencilRef: number;
    stencilFunc: THREE.StencilFunc;
    stencilFuncMask: number;
    stencilWriteMask: number;
    stencilFail: THREE.StencilOp;
    stencilZFail: THREE.StencilOp;
    stencilZPass: THREE.StencilOp;
  };
}

const patchedMaterials = new WeakMap<THREE.Material, PatchedMaterialRecord>();

const ROLE_TO_SHADER_MODE: Record<DepthOcclusionRole, number> = {
  'world-object': 0,
  'portal-rim': 1,
  'portal-interior': 2,
  'portal-mask': 3,
};

const VERTEX_DECL = /* glsl */ `
varying vec3 vRbOccWorldPos;
varying vec4 vRbOccClipPos;
varying float vRbOccViewZ;
`;

const VERTEX_PROJECT_REPLACEMENT = /* glsl */ `
vec4 rbOccLocalPos = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
  rbOccLocalPos = batchingMatrix * rbOccLocalPos;
#endif
#ifdef USE_INSTANCING
  rbOccLocalPos = instanceMatrix * rbOccLocalPos;
#endif
vRbOccWorldPos = ( modelMatrix * rbOccLocalPos ).xyz;
#include <project_vertex>
vRbOccClipPos = gl_Position;
vRbOccViewZ = -mvPosition.z;
`;

const FRAGMENT_DECL = /* glsl */ `
uniform float uRbOccEnabled;
uniform sampler2D uRbDepthTex;
#if __VERSION__ >= 300
uniform sampler2DArray uRbDepthArrayTex;
#endif
uniform float uRbDepthEncoding;
uniform float uRbDepthArrayLayer;
uniform mat4 uRbNormDepthFromNormView;
uniform float uRbRawValueToMeters;
uniform int uRbPortalCount;
uniform mat4 uRbPortalInvWorld[${MAX_PORTAL_APERTURES}];
uniform float uRbPortalRadius[${MAX_PORTAL_APERTURES}];
uniform vec2 uRbPortalRadii[${MAX_PORTAL_APERTURES}];
uniform float uRbOccRole;
uniform float uRbOccDepthBias;
uniform float uRbOccForegroundMargin;
varying vec3 vRbOccWorldPos;
varying vec4 vRbOccClipPos;
varying float vRbOccViewZ;

float rbSampleEnvDepthMeters( vec2 normViewUv ) {
  vec2 depthUv = ( uRbNormDepthFromNormView * vec4( normViewUv, 0.0, 1.0 ) ).xy;
  if ( depthUv.x < 0.0 || depthUv.x > 1.0 || depthUv.y < 0.0 || depthUv.y > 1.0 ) {
    return 0.0;
  }
  if ( uRbDepthEncoding < 0.5 ) {
    vec2 rg = texture2D( uRbDepthTex, depthUv ).rg;
    return dot( rg, vec2( 255.0, 65280.0 ) ) * uRbRawValueToMeters;
  }
  if ( uRbDepthEncoding < 1.5 ) {
    vec4 la = texture2D( uRbDepthTex, depthUv );
    return ( la.r * 255.0 + la.a * 65280.0 ) * uRbRawValueToMeters;
  }
  if ( uRbDepthEncoding < 2.5 ) {
    return texture2D( uRbDepthTex, depthUv ).r * uRbRawValueToMeters;
  }
  #if __VERSION__ >= 300
  return texture( uRbDepthArrayTex, vec3( depthUv, uRbDepthArrayLayer ) ).r * uRbRawValueToMeters;
  #else
  return texture2D( uRbDepthTex, depthUv ).r * uRbRawValueToMeters;
  #endif
}

bool rbShouldDiscardByDepth() {
  if ( uRbOccEnabled < 0.5 || vRbOccClipPos.w <= 0.0001 ) {
    return false;
  }
  vec2 normViewUv = ( vRbOccClipPos.xy / vRbOccClipPos.w ) * 0.5 + 0.5;
  // WebXR depth-view coordinates start at the top left, independently of clip space.
  normViewUv.y = 1.0 - normViewUv.y;
  float envDepth = rbSampleEnvDepthMeters( normViewUv );
  if ( envDepth <= 0.001 ) {
    return false;
  }
  // Role 3: portal-mask (only discard when real foreground hand/furniture is closer than portal plane)
  if ( uRbOccRole > 2.5 ) {
    return envDepth < ( vRbOccViewZ - max( uRbOccForegroundMargin, uRbOccDepthBias ) );
  }
  // Role 2: portal-interior (bypass wall depth; discard only if real foreground sits in front of aperture)
  if ( uRbOccRole > 1.5 ) {
    for ( int i = 0; i < ${MAX_PORTAL_APERTURES}; i++ ) {
      if ( i >= uRbPortalCount ) break;
      vec2 radii = uRbPortalRadii[i];
      if ( radii.x <= 0.0001 || radii.y <= 0.0001 ) continue;
      vec3 localFrag = ( uRbPortalInvWorld[i] * vec4( vRbOccWorldPos, 1.0 ) ).xyz;
      vec3 localEye = ( uRbPortalInvWorld[i] * vec4( cameraPosition, 1.0 ) ).xyz;
      if ( localEye.z > 0.001 && localFrag.z <= uRbOccDepthBias ) {
        float denom = localEye.z - localFrag.z;
        if ( denom > 0.0001 ) {
          float t = localEye.z / denom;
          vec2 hitXY = mix( localEye.xy, localFrag.xy, t ) / radii;
          if ( dot( hitXY, hitXY ) <= 1.0 ) {
            float portalHitViewZ = vRbOccViewZ * t;
            return envDepth < ( portalHitViewZ - uRbOccForegroundMargin );
          }
        }
      }
    }
    return envDepth < ( vRbOccViewZ - uRbOccForegroundMargin );
  }
  // Role 1: portal rim, using the same foreground separation as the aperture mask.
  if ( uRbOccRole > 0.5 ) {
    return envDepth < ( vRbOccViewZ - max( uRbOccForegroundMargin, uRbOccDepthBias ) );
  }
  // Role 0: world-object (emerging enemies/projectiles behind a portal aperture bypass the host wall)
  if ( uRbOccRole < 0.5 ) {
    for ( int i = 0; i < ${MAX_PORTAL_APERTURES}; i++ ) {
      if ( i >= uRbPortalCount ) break;
      vec2 radii = uRbPortalRadii[i];
      if ( radii.x <= 0.0001 || radii.y <= 0.0001 ) continue;
      vec3 localFrag = ( uRbPortalInvWorld[i] * vec4( vRbOccWorldPos, 1.0 ) ).xyz;
      vec3 localEye = ( uRbPortalInvWorld[i] * vec4( cameraPosition, 1.0 ) ).xyz;
      if ( localEye.z > 0.001 && localFrag.z <= uRbOccDepthBias ) {
        float denom = localEye.z - localFrag.z;
        if ( denom > 0.0001 ) {
          float t = localEye.z / denom;
          vec2 hitXY = mix( localEye.xy, localFrag.xy, t ) / radii;
          if ( dot( hitXY, hitXY ) <= 1.0 ) {
            float portalHitViewZ = vRbOccViewZ * t;
            if ( envDepth >= ( portalHitViewZ - uRbOccForegroundMargin ) ) {
              return false;
            }
            return true;
          }
        }
      }
    }
  }
  return ( envDepth + uRbOccDepthBias ) < vRbOccViewZ;
}
`;

/**
 * Patches any Three.js material via `onBeforeCompile` to consume live WebXR depth-sensing
 * uniforms from `controller` with portal-aperture bypass support and zero runtime shader
 * recompilation (all mode/format/portal state is uniform-driven).
 */
export function applyDepthOcclusion(
  material: THREE.Material,
  controller: OcclusionController,
  options: ApplyDepthOcclusionOptions = {},
): DepthOcclusionBinding {
  const role: DepthOcclusionRole = options.role ?? 'world-object';
  const depthBias =
    options.depthBias ??
    (role === 'portal-rim' ? DEFAULT_PORTAL_RIM_DEPTH_BIAS : DEFAULT_DEPTH_BIAS);
  const foregroundMargin = options.foregroundMargin ?? DEFAULT_FOREGROUND_MARGIN;
  const stencilRef = options.stencilRef ?? PORTAL_APERTURE_STENCIL_REF;

  const existing = patchedMaterials.get(material);
  if (existing && existing.role === role) {
    return {
      role,
      dispose() {
        restorePatchedMaterial(material);
      },
    };
  }
  if (existing) {
    restorePatchedMaterial(material);
  }

  let previousRenderState: PatchedMaterialRecord['previousRenderState'];
  if (role === 'portal-mask' || role === 'portal-interior') {
    previousRenderState = {
      colorWrite: material.colorWrite,
      depthWrite: material.depthWrite,
      depthTest: material.depthTest,
      stencilWrite: material.stencilWrite,
      stencilRef: material.stencilRef,
      stencilFunc: material.stencilFunc,
      stencilFuncMask: material.stencilFuncMask,
      stencilWriteMask: material.stencilWriteMask,
      stencilFail: material.stencilFail,
      stencilZFail: material.stencilZFail,
      stencilZPass: material.stencilZPass,
    };
  }

  if (role === 'portal-mask') {
    material.colorWrite = false;
    material.depthWrite = false;
    material.depthTest = true;
    material.stencilWrite = true;
    material.stencilRef = stencilRef;
    material.stencilFunc = THREE.AlwaysStencilFunc;
    material.stencilFuncMask = 0xff;
    material.stencilWriteMask = 0xff;
    material.stencilFail = THREE.KeepStencilOp;
    material.stencilZFail = THREE.KeepStencilOp;
    material.stencilZPass = THREE.ReplaceStencilOp;
  } else if (role === 'portal-interior') {
    material.stencilWrite = true;
    material.stencilRef = stencilRef;
    material.stencilFunc = THREE.EqualStencilFunc;
    material.stencilFuncMask = 0xff;
    material.stencilWriteMask = 0x00;
    material.stencilFail = THREE.KeepStencilOp;
    material.stencilZFail = THREE.KeepStencilOp;
    material.stencilZPass = THREE.KeepStencilOp;
  }

  const previousOnBeforeCompile = material.onBeforeCompile;
  const previousCacheKey = material.customProgramCacheKey;

  const roleUniform = { value: ROLE_TO_SHADER_MODE[role] };
  const biasUniform = { value: depthBias };
  const marginUniform = { value: foregroundMargin };

  material.onBeforeCompile = (shader, renderer) => {
    previousOnBeforeCompile?.call(material, shader, renderer);

    Object.assign(shader.uniforms, {
      uRbOccEnabled: controller.uniforms.uRbOccEnabled,
      uRbDepthTex: controller.uniforms.uRbDepthTex,
      uRbDepthArrayTex: controller.uniforms.uRbDepthArrayTex,
      uRbDepthEncoding: controller.uniforms.uRbDepthEncoding,
      uRbDepthArrayLayer: controller.uniforms.uRbDepthArrayLayer,
      uRbNormDepthFromNormView: controller.uniforms.uRbNormDepthFromNormView,
      uRbRawValueToMeters: controller.uniforms.uRbRawValueToMeters,
      uRbPortalCount: controller.uniforms.uRbPortalCount,
      uRbPortalInvWorld: controller.uniforms.uRbPortalInvWorld,
      uRbPortalRadius: controller.uniforms.uRbPortalRadius,
      uRbPortalRadii: controller.uniforms.uRbPortalRadii,
      uRbOccRole: roleUniform,
      uRbOccDepthBias: biasUniform,
      uRbOccForegroundMargin: marginUniform,
    });

    if (!shader.vertexShader.includes('vRbOccViewZ')) {
      shader.vertexShader = `${VERTEX_DECL}\n${shader.vertexShader}`.replace(
        '#include <project_vertex>',
        VERTEX_PROJECT_REPLACEMENT,
      );
    }

    if (!shader.fragmentShader.includes('rbShouldDiscardByDepth')) {
      shader.fragmentShader = `${FRAGMENT_DECL}\n${shader.fragmentShader}`.replace(
        'void main() {',
        'void main() {\n  if ( rbShouldDiscardByDepth() ) discard;\n',
      );
    }
  };

  material.customProgramCacheKey = () => {
    const base = previousCacheKey ? previousCacheKey.call(material) : '';
    return base ? `${base}|rb-depth-occ:${role}` : `rb-depth-occ:${role}`;
  };
  material.needsUpdate = true;

  patchedMaterials.set(material, {
    role,
    previousOnBeforeCompile,
    previousCacheKey,
    previousRenderState,
  });

  return {
    role,
    dispose() {
      restorePatchedMaterial(material);
    },
  };
}

function restorePatchedMaterial(material: THREE.Material): void {
  const record = patchedMaterials.get(material);
  if (!record) return;
  material.onBeforeCompile = record.previousOnBeforeCompile;
  material.customProgramCacheKey = record.previousCacheKey;
  if (record.previousRenderState) {
    Object.assign(material, record.previousRenderState);
  }
  material.needsUpdate = true;
  patchedMaterials.delete(material);
}

/**
 * Creates a depth-tested stencil-writer material for a portal aperture opening.
 * Writes `stencilRef` where the portal disk is NOT occluded by real foreground objects
 * (hands/furniture), while ignoring the physical host wall right behind the disk.
 */
export function createPortalApertureMaskMaterial(
  controller: OcclusionController,
  options: { stencilRef?: number; foregroundMargin?: number } = {},
): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    color: 0x000000,
    colorWrite: false,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });
  applyDepthOcclusion(material, controller, {
    role: 'portal-mask',
    stencilRef: options.stencilRef ?? PORTAL_APERTURE_STENCIL_REF,
    foregroundMargin: options.foregroundMargin ?? DEFAULT_FOREGROUND_MARGIN,
  });
  return material;
}

/**
 * Creates a portal aperture stencil-mask mesh aligned to the exact portal plane so recessed
 * portal interiors bypass host wall depth without oblique passthrough seams.
 */
export function createPortalApertureMaskMesh(
  portal: PortalAperture,
  controller: OcclusionController,
  options: { segments?: number; stencilRef?: number; foregroundMargin?: number } = {},
): THREE.Mesh {
  const { rx, ry } = resolvePortalRadii(portal);
  const geometry = new THREE.CircleGeometry(1, options.segments ?? DEFAULT_APERTURE_SEGMENTS);
  geometry.scale(Math.max(0.01, rx), Math.max(0.01, ry), 1);
  const material = createPortalApertureMaskMaterial(controller, options);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `portal-aperture-mask:${portal.id}`;
  mesh.renderOrder = PORTAL_MASK_RENDER_ORDER;
  mesh.frustumCulled = false;

  const worldMatrix = buildPortalWorldMatrix(portal, new THREE.Matrix4());
  worldMatrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
  mesh.updateMatrix();
  mesh.updateMatrixWorld(true);
  return mesh;
}

/** Configures a recessed portal interior material to pass inside the aperture stencil mask. */
export function configurePortalInteriorMaterial(
  material: THREE.Material,
  controller: OcclusionController,
  options: { stencilRef?: number; foregroundMargin?: number } = {},
): DepthOcclusionBinding {
  return applyDepthOcclusion(material, controller, {
    role: 'portal-interior',
    stencilRef: options.stencilRef ?? PORTAL_APERTURE_STENCIL_REF,
    foregroundMargin: options.foregroundMargin ?? DEFAULT_FOREGROUND_MARGIN,
  });
}

/** Configures a portal rim material so foreground hands/furniture occlude it without wall z-fighting. */
export function configurePortalRimMaterial(
  material: THREE.Material,
  controller: OcclusionController,
  options: { depthBias?: number; foregroundMargin?: number } = {},
): DepthOcclusionBinding {
  return applyDepthOcclusion(material, controller, {
    role: 'portal-rim',
    depthBias: options.depthBias ?? DEFAULT_PORTAL_RIM_DEPTH_BIAS,
    foregroundMargin: options.foregroundMargin ?? DEFAULT_FOREGROUND_MARGIN,
  });
}

interface MutableDepthViewSlot {
  viewIndex: number;
  source: DepthSourceKind;
  format: DepthDataFormat | null;
  width: number;
  height: number;
  rawValueToMeters: number;
  normDepthBufferFromNormView: THREE.Matrix4;
  arrayLayer: number;
  encoding: number;
  cpuBytes: Uint8Array | null;
  cpuFloats: Float32Array | null;
  dataTexture: THREE.DataTexture | null;
  gpuTexture: THREE.ExternalTexture | null;
  activeTexture: THREE.Texture | null;
}

interface OccluderEntry {
  surface: OcclusionSurface;
  mesh: THREE.Mesh;
  revision: number;
  portalVersion: number;
  cutPortalIds: readonly string[];
}

function createDummyDepth2D(): THREE.DataTexture {
  const tex = new THREE.DataTexture(
    new Uint8Array(2),
    1,
    1,
    THREE.RGFormat,
    THREE.UnsignedByteType,
  );
  tex.flipY = false;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createDummyDepthArray(): THREE.DataArrayTexture {
  const tex = new THREE.DataArrayTexture(new Float32Array(1), 1, 1, 1);
  tex.format = THREE.RedFormat;
  tex.type = THREE.FloatType;
  tex.flipY = false;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function detectCpuDepthFormat(
  depthInfo: XRCPUDepthInformation,
  sessionFormat?: string,
): DepthDataFormat {
  if (sessionFormat === 'float32') return 'float32';
  if (sessionFormat === 'unsigned-short') return 'unsigned-short';
  if (sessionFormat === 'luminance-alpha') return 'luminance-alpha';
  const pixelCount = Math.max(1, depthInfo.width * depthInfo.height);
  const bytesPerPixel = depthInfo.data.byteLength / pixelCount;
  if (bytesPerPixel >= 4) return 'float32';
  return 'luminance-alpha';
}

function detectGpuDepthFormat(sessionFormat?: string): DepthDataFormat {
  if (sessionFormat === 'float32') return 'float32';
  if (sessionFormat === 'unsigned-short') return 'unsigned-short';
  return 'luminance-alpha';
}

function createDepthViewSlot(viewIndex: number): MutableDepthViewSlot {
  return {
    viewIndex,
    source: 'none',
    format: null,
    width: 0,
    height: 0,
    rawValueToMeters: 1,
    normDepthBufferFromNormView: new THREE.Matrix4(),
    arrayLayer: 0,
    encoding: DEPTH_ENCODING_CPU_RG8_UINT16,
    cpuBytes: null,
    cpuFloats: null,
    dataTexture: null,
    gpuTexture: null,
    activeTexture: null,
  };
}

function clonePortalAperture(portal: PortalAperture): PortalAperture {
  return {
    id: portal.id,
    center: portal.center.clone(),
    normal: portal.normal.clone().normalize(),
    radius: portal.radius,
    ...(portal.radiusX !== undefined ? { radiusX: portal.radiusX } : {}),
    ...(portal.radiusY !== undefined ? { radiusY: portal.radiusY } : {}),
    ...(portal.worldMatrix ? { worldMatrix: portal.worldMatrix.clone() } : {}),
    ...(portal.hostSurfaceId !== undefined ? { hostSurfaceId: portal.hostSurfaceId } : {}),
    ...(portal.hostKind !== undefined ? { hostKind: portal.hostKind } : {}),
  };
}

export function createOcclusionController(
  options: OcclusionControllerOptions = {},
): OcclusionController {
  const maxViews = Math.max(1, options.maxViews ?? 2);
  const cutOptions: CutPortalAperturesOptions = { ...options.cutOptions };

  const root = new THREE.Group();
  root.name = 'mr-occlusion-root';

  const roomMeshRoot = new THREE.Group();
  roomMeshRoot.name = 'mr-occlusion-room-meshes';
  root.add(roomMeshRoot);

  // Shared opaque depth-only material for room-mesh fallback occluders.
  // FrontSide prevents back-facing walls (such as a near wall behind the desktop camera) from
  // erasing the entire room, and positive polygonOffset pushes occluder depth slightly behind
  // flush-mounted Core/turret bases, calibration rings, and shadow catchers to prevent z-fighting.
  const roomOccluderMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000,
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 2,
  });

  // Zero-triangle per-eye render hook that binds the active stereo eye's depth texture and
  // normDepthBufferFromNormView matrix right before each eye renders its opaque/transparent lists.
  const eyeBindGeo = new THREE.BufferGeometry();
  eyeBindGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  eyeBindGeo.setDrawRange(0, 0);
  const eyeBindMat = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: false,
    depthTest: false,
  });
  const eyeBindMesh = new THREE.Mesh(eyeBindGeo, eyeBindMat);
  eyeBindMesh.name = 'mr-occlusion-eye-bind-hook';
  eyeBindMesh.renderOrder = -1000;
  eyeBindMesh.frustumCulled = false;
  eyeBindMesh.raycast = () => undefined;
  root.add(eyeBindMesh);

  const dummyDepth2D = createDummyDepth2D();
  const dummyDepthArray = createDummyDepthArray();

  const portalInvWorldUniforms: THREE.Matrix4[] = Array.from(
    { length: MAX_PORTAL_APERTURES },
    () => new THREE.Matrix4(),
  );
  const portalRadiusUniforms: number[] = Array.from({ length: MAX_PORTAL_APERTURES }, () => 0);
  const portalRadiiUniforms: THREE.Vector2[] = Array.from(
    { length: MAX_PORTAL_APERTURES },
    () => new THREE.Vector2(0, 0),
  );

  const uniforms: DepthOcclusionUniforms = {
    uRbOccEnabled: { value: 0 },
    uRbDepthTex: { value: dummyDepth2D },
    uRbDepthArrayTex: { value: dummyDepthArray },
    uRbDepthEncoding: { value: DEPTH_ENCODING_CPU_RG8_UINT16 },
    uRbDepthArrayLayer: { value: 0 },
    uRbNormDepthFromNormView: { value: new THREE.Matrix4() },
    uRbRawValueToMeters: { value: 1 },
    uRbPortalCount: { value: 0 },
    uRbPortalInvWorld: { value: portalInvWorldUniforms },
    uRbPortalRadius: { value: portalRadiusUniforms },
    uRbPortalRadii: { value: portalRadiiUniforms },
  };

  const viewSlots: MutableDepthViewSlot[] = Array.from({ length: maxViews }, (_, i) =>
    createDepthViewSlot(i),
  );
  const occluders = new Map<string, OccluderEntry>();
  const listeners = new Set<OcclusionListener>();

  let requestedMode: RoomOcclusionOption = options.initialMode ?? 'auto-depth';
  let depthAvailable = false;
  let depthSource: DepthSourceKind = 'none';
  let depthDataFormat: DepthDataFormat | null = null;
  let depthWidth = 0;
  let depthHeight = 0;
  let activePortals: PortalAperture[] = [];
  let portalVersion = 0;
  let disposed = false;

  const scratchPortalMatrix = new THREE.Matrix4();

  function resolveEffectiveMode(): EffectiveOcclusionMode {
    if (requestedMode === 'off') return 'off';
    if (requestedMode === 'room-mesh') return 'room-mesh';
    return depthAvailable ? 'depth-sensing' : (options.missingDepthFallback ?? 'room-mesh');
  }

  function snapshotState(): Readonly<OcclusionState> {
    return Object.freeze({
      requestedMode,
      effectiveMode: resolveEffectiveMode(),
      depthAvailable,
      depthSource,
      depthDataFormat,
      depthWidth,
      depthHeight,
      occluderMeshCount: occluders.size,
      portalCount: activePortals.length,
    });
  }

  let lastState = snapshotState();

  function syncOutputsAndNotify(): void {
    const effective = resolveEffectiveMode();
    uniforms.uRbOccEnabled.value = effective === 'depth-sensing' ? 1 : 0;
    roomMeshRoot.visible = effective === 'room-mesh';

    const next = snapshotState();
    const changed =
      next.requestedMode !== lastState.requestedMode ||
      next.effectiveMode !== lastState.effectiveMode ||
      next.depthAvailable !== lastState.depthAvailable ||
      next.depthSource !== lastState.depthSource ||
      next.depthDataFormat !== lastState.depthDataFormat ||
      next.depthWidth !== lastState.depthWidth ||
      next.depthHeight !== lastState.depthHeight ||
      next.occluderMeshCount !== lastState.occluderMeshCount ||
      next.portalCount !== lastState.portalCount;

    lastState = next;
    if (changed) {
      for (const listener of [...listeners]) {
        listener(next);
      }
    }
  }

  function ensureCpuDataTexture(
    slot: MutableDepthViewSlot,
    width: number,
    height: number,
    format: DepthDataFormat,
  ): THREE.DataTexture {
    const isFloat = format === 'float32';
    const currentIsFloat = slot.format === 'float32';
    if (
      slot.dataTexture &&
      slot.width === width &&
      slot.height === height &&
      isFloat === currentIsFloat
    ) {
      return slot.dataTexture;
    }

    slot.dataTexture?.dispose();
    if (isFloat) {
      const floats = new Float32Array(width * height);
      const tex = new THREE.DataTexture(floats, width, height, THREE.RedFormat, THREE.FloatType);
      tex.flipY = false;
      tex.generateMipmaps = false;
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.colorSpace = THREE.NoColorSpace;
      slot.cpuFloats = floats;
      slot.cpuBytes = null;
      slot.dataTexture = tex;
    } else {
      const bytes = new Uint8Array(width * height * 2);
      const tex = new THREE.DataTexture(
        bytes,
        width,
        height,
        THREE.RGFormat,
        THREE.UnsignedByteType,
      );
      tex.flipY = false;
      tex.generateMipmaps = false;
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.colorSpace = THREE.NoColorSpace;
      slot.cpuBytes = bytes;
      slot.cpuFloats = null;
      slot.dataTexture = tex;
    }

    slot.width = width;
    slot.height = height;
    slot.format = format;
    return slot.dataTexture;
  }

  function updateSlotFromCpuDepth(
    slot: MutableDepthViewSlot,
    depthInfo: XRCPUDepthInformation,
    sessionFormat?: string,
  ): boolean {
    const { width, height, data } = depthInfo;
    if (!(width > 0 && height > 0) || !data || data.byteLength === 0) {
      return false;
    }
    const format = detectCpuDepthFormat(depthInfo, sessionFormat);
    const texture = ensureCpuDataTexture(slot, width, height, format);

    if (format === 'float32' && slot.cpuFloats) {
      const byteLen = Math.min(data.byteLength, slot.cpuFloats.byteLength);
      const elementCount = Math.floor(byteLen / 4);
      if (elementCount > 0) {
        slot.cpuFloats.set(new Float32Array(data, 0, elementCount));
      }
      slot.encoding = DEPTH_ENCODING_FLOAT32_R;
    } else if (slot.cpuBytes) {
      const byteLen = Math.min(data.byteLength, slot.cpuBytes.byteLength);
      if (byteLen > 0) {
        slot.cpuBytes.set(new Uint8Array(data, 0, byteLen));
      }
      slot.encoding = DEPTH_ENCODING_CPU_RG8_UINT16;
    } else {
      return false;
    }

    texture.needsUpdate = true;
    slot.source = 'cpu';
    slot.format = format;
    slot.rawValueToMeters = depthInfo.rawValueToMeters;
    slot.normDepthBufferFromNormView.fromArray(depthInfo.normDepthBufferFromNormView.matrix);
    slot.arrayLayer = 0;
    slot.activeTexture = texture;
    return true;
  }

  function updateSlotFromGpuDepth(
    slot: MutableDepthViewSlot,
    depthInfo: XRWebGLDepthInformation,
    viewIndex: number,
    sessionFormat?: string,
  ): boolean {
    if (!depthInfo.texture || !(depthInfo.width > 0 && depthInfo.height > 0)) {
      return false;
    }
    if (!slot.gpuTexture) {
      slot.gpuTexture = new THREE.ExternalTexture(depthInfo.texture);
    } else {
      slot.gpuTexture.sourceTexture = depthInfo.texture;
    }

    const format = detectGpuDepthFormat(sessionFormat);
    const isArray = depthInfo.textureType === 'texture-array';
    slot.source = 'gpu';
    slot.format = format;
    slot.width = depthInfo.width;
    slot.height = depthInfo.height;
    slot.rawValueToMeters = depthInfo.rawValueToMeters;
    slot.normDepthBufferFromNormView.fromArray(depthInfo.normDepthBufferFromNormView.matrix);
    slot.arrayLayer = isArray ? (depthInfo.imageIndex ?? viewIndex) : 0;
    slot.encoding = isArray
      ? DEPTH_ENCODING_GPU_ARRAY_R
      : format === 'float32'
        ? DEPTH_ENCODING_FLOAT32_R
        : DEPTH_ENCODING_GPU_LA8_UINT16;
    slot.activeTexture = slot.gpuTexture;
    return true;
  }

  function bindView(viewIndex: number): boolean {
    const slot = viewSlots[viewIndex];
    if (!slot || slot.source === 'none' || !slot.activeTexture) {
      uniforms.uRbOccEnabled.value = 0;
      return false;
    }

    uniforms.uRbOccEnabled.value = resolveEffectiveMode() === 'depth-sensing' ? 1 : 0;
    if (slot.encoding === DEPTH_ENCODING_GPU_ARRAY_R) {
      uniforms.uRbDepthArrayTex.value = slot.activeTexture;
      uniforms.uRbDepthTex.value = dummyDepth2D;
    } else {
      uniforms.uRbDepthTex.value = slot.activeTexture;
      uniforms.uRbDepthArrayTex.value = dummyDepthArray;
    }

    uniforms.uRbDepthEncoding.value = slot.encoding;
    uniforms.uRbDepthArrayLayer.value = slot.arrayLayer;
    uniforms.uRbNormDepthFromNormView.value.copy(slot.normDepthBufferFromNormView);
    uniforms.uRbRawValueToMeters.value = slot.rawValueToMeters;
    return true;
  }

  function rebuildOccluderEntry(entry: OccluderEntry): void {
    const cut = cutPortalApertures(entry.surface, activePortals, cutOptions);
    entry.mesh.geometry.dispose();
    entry.mesh.geometry = cut.geometry;
    entry.revision = entry.surface.revision;
    entry.portalVersion = portalVersion;
    entry.cutPortalIds = cut.cutPortalIds;
    entry.mesh.visible = entry.surface.visible ?? true;
  }

  function clearDepthAvailability(): void {
    depthAvailable = false;
    depthSource = 'none';
    depthDataFormat = null;
    depthWidth = 0;
    depthHeight = 0;
    for (const slot of viewSlots) {
      slot.source = 'none';
      slot.activeTexture = null;
    }
    uniforms.uRbDepthTex.value = dummyDepth2D;
    uniforms.uRbDepthArrayTex.value = dummyDepthArray;
    uniforms.uRbDepthArrayLayer.value = 0;
  }

  function syncPortalUniforms(): void {
    const count = Math.min(activePortals.length, MAX_PORTAL_APERTURES);
    uniforms.uRbPortalCount.value = count;
    for (let i = 0; i < MAX_PORTAL_APERTURES; i += 1) {
      const targetMat = portalInvWorldUniforms[i] as THREE.Matrix4;
      const targetRadii = portalRadiiUniforms[i] as THREE.Vector2;
      if (i < count) {
        const portal = activePortals[i] as PortalAperture;
        const { rx, ry } = resolvePortalRadii(portal);
        buildPortalWorldMatrix(portal, scratchPortalMatrix);
        targetMat.copy(scratchPortalMatrix).invert();
        portalRadiusUniforms[i] = Math.max(rx, ry);
        targetRadii.set(rx, ry);
      } else {
        targetMat.identity();
        portalRadiusUniforms[i] = 0;
        targetRadii.set(0, 0);
      }
    }
  }

  eyeBindMesh.onBeforeRender = (renderer, _scene, camera) => {
    if (resolveEffectiveMode() !== 'depth-sensing') return;
    const xrCamera = renderer.xr?.isPresenting
      ? (renderer.xr.getCamera() as unknown as { cameras?: readonly THREE.Camera[] })
      : undefined;
    let index = 0;
    const cameras = xrCamera?.cameras;
    if (cameras && cameras.length > 1) {
      const found = cameras.indexOf(camera);
      if (found >= 0) index = found;
    }
    bindView(index);
  };

  // Apply initial visibility/uniforms.
  syncOutputsAndNotify();

  return {
    root,
    roomMeshRoot,
    get state() {
      return lastState;
    },
    get requestedMode() {
      return requestedMode;
    },
    get effectiveMode() {
      return resolveEffectiveMode();
    },
    uniforms,

    setMode(mode) {
      if (disposed) return resolveEffectiveMode();
      requestedMode = mode;
      syncOutputsAndNotify();
      return resolveEffectiveMode();
    },

    setPortals(portals) {
      if (disposed) return;
      activePortals = portals.slice(0, MAX_PORTAL_APERTURES).map(clonePortalAperture);
      portalVersion += 1;
      syncPortalUniforms();

      // Rebuild existing room-mesh occluders so every co-located host representation reflects the
      // updated aperture cutouts immediately.
      for (const entry of occluders.values()) {
        rebuildOccluderEntry(entry);
      }
      syncOutputsAndNotify();
    },

    getPortals() {
      return activePortals;
    },

    syncRoomSurfaces(surfaces) {
      if (disposed) return;
      const seen = new Set<string>();

      for (const surface of surfaces) {
        seen.add(surface.id);
        const existing = occluders.get(surface.id);
        if (!existing) {
          const cut = cutPortalApertures(surface, activePortals, cutOptions);
          const mesh = new THREE.Mesh(cut.geometry, roomOccluderMaterial);
          mesh.name = `room-occluder:${surface.id}`;
          mesh.renderOrder = ROOM_OCCLUDER_RENDER_ORDER;
          mesh.castShadow = false;
          mesh.receiveShadow = false;
          mesh.visible = surface.visible ?? true;
          roomMeshRoot.add(mesh);
          occluders.set(surface.id, {
            surface,
            mesh,
            revision: surface.revision,
            portalVersion,
            cutPortalIds: cut.cutPortalIds,
          });
        } else {
          existing.surface = surface;
          if (existing.revision !== surface.revision || existing.portalVersion !== portalVersion) {
            rebuildOccluderEntry(existing);
          } else {
            existing.mesh.visible = surface.visible ?? true;
          }
        }
      }

      for (const [id, entry] of occluders) {
        if (!seen.has(id)) {
          roomMeshRoot.remove(entry.mesh);
          entry.mesh.geometry.dispose();
          occluders.delete(id);
        }
      }

      syncOutputsAndNotify();
    },

    getOccluderMesh(surfaceId) {
      return occluders.get(surfaceId)?.mesh;
    },

    updateFromXrFrame(frame, referenceSpace, frameOptions = {}) {
      if (disposed) return resolveEffectiveMode();
      if (!frame) {
        clearDepthAvailability();
        syncOutputsAndNotify();
        return resolveEffectiveMode();
      }

      const session = frame.session as
        | (XRSession & { depthUsage?: string; depthDataFormat?: string })
        | undefined;
      if (
        session?.enabledFeatures &&
        session.enabledFeatures.length > 0 &&
        !session.enabledFeatures.includes('depth-sensing')
      ) {
        clearDepthAvailability();
        syncOutputsAndNotify();
        return resolveEffectiveMode();
      }

      // Skip texture uploads when the player explicitly turned depth-sensing off or forced room-mesh.
      if (requestedMode !== 'auto-depth') {
        syncOutputsAndNotify();
        return resolveEffectiveMode();
      }

      const viewerPose =
        frameOptions.viewerPose ?? (referenceSpace ? frame.getViewerPose(referenceSpace) : null);
      if (!viewerPose || viewerPose.views.length === 0) {
        clearDepthAvailability();
        syncOutputsAndNotify();
        return resolveEffectiveMode();
      }

      const glBinding = frameOptions.glBinding ?? null;
      const canTryGpu = Boolean(
        glBinding &&
          typeof glBinding.getDepthInformation === 'function' &&
          session?.depthUsage !== 'cpu-optimized',
      );
      const canTryCpu = typeof frame.getDepthInformation === 'function';
      if (!canTryGpu && !canTryCpu) {
        clearDepthAvailability();
        syncOutputsAndNotify();
        return resolveEffectiveMode();
      }

      let acquiredAny = false;

      for (let i = 0; i < viewSlots.length; i += 1) {
        const view = viewerPose.views[i];
        const slot = viewSlots[i] as MutableDepthViewSlot;
        let updated = false;

        if (view && canTryGpu && glBinding) {
          try {
            const gpuInfo = glBinding.getDepthInformation(view);
            if (gpuInfo) {
              updated = updateSlotFromGpuDepth(slot, gpuInfo, i, session?.depthDataFormat);
            }
          } catch {
            // Runtime may reject GPU binding calls when session negotiated cpu-optimized depth.
          }
        }

        if (view && !updated && canTryCpu) {
          try {
            const cpuInfo = frame.getDepthInformation(view);
            if (cpuInfo) {
              updated = updateSlotFromCpuDepth(slot, cpuInfo, session?.depthDataFormat);
            }
          } catch {
            // Runtime may throw if depth is temporarily unavailable on this frame.
          }
        }

        if (updated) {
          acquiredAny = true;
        } else {
          slot.source = 'none';
          slot.activeTexture = null;
        }
      }

      if (acquiredAny) {
        const primary = viewSlots.find((s) => s.source !== 'none') ?? viewSlots[0];
        depthAvailable = true;
        depthSource = primary?.source ?? 'none';
        depthDataFormat = primary?.format ?? null;
        depthWidth = primary?.width ?? 0;
        depthHeight = primary?.height ?? 0;
        bindView(primary?.viewIndex ?? 0);
      } else {
        clearDepthAvailability();
      }

      syncOutputsAndNotify();
      return resolveEffectiveMode();
    },

    bindView,

    bindCamera(camera, xrCamera) {
      let index = 0;
      const cameras = xrCamera?.cameras;
      if (cameras && cameras.length > 1) {
        const found = cameras.indexOf(camera);
        if (found >= 0) index = found;
      }
      bindView(index);
      return index;
    },

    getViewDepthState(viewIndex = 0) {
      const slot = viewSlots[viewIndex];
      if (!slot) return null;
      const backingBuffer = slot.cpuBytes?.buffer ?? slot.cpuFloats?.buffer ?? null;
      return Object.freeze({
        viewIndex: slot.viewIndex,
        source: slot.source,
        format: slot.format,
        texture: slot.activeTexture,
        dataTexture: slot.dataTexture,
        backingBuffer,
        width: slot.width,
        height: slot.height,
        rawValueToMeters: slot.rawValueToMeters,
        normDepthBufferFromNormView: slot.normDepthBufferFromNormView,
        arrayLayer: slot.arrayLayer,
      });
    },

    resetDepth() {
      if (disposed) return;
      clearDepthAvailability();
      syncOutputsAndNotify();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of occluders.values()) {
        roomMeshRoot.remove(entry.mesh);
        entry.mesh.geometry.dispose();
      }
      occluders.clear();
      roomOccluderMaterial.dispose();
      eyeBindMesh.removeFromParent();
      eyeBindGeo.dispose();
      eyeBindMat.dispose();
      for (const slot of viewSlots) {
        slot.dataTexture?.dispose();
        slot.dataTexture = null;
        slot.gpuTexture?.dispose();
        slot.gpuTexture = null;
        slot.cpuBytes = null;
        slot.cpuFloats = null;
        slot.activeTexture = null;
      }
      dummyDepth2D.dispose();
      dummyDepthArray.dispose();
      root.removeFromParent();
      listeners.clear();
    },
  };
}
