/**
 * Pure, deterministic turret placement validation and pose calculation engine.
 *
 * Enforces all PRD (§D2, §D6) and `src/content/turrets.ts` spatial and economy rules:
 * - Hard cap of `14` active turrets (`CAP_REACHED` -> `"CAP 14/14"`)
 * - Minimum `0.35 m` center-to-center spacing (`TOO_CLOSE` -> `"TOO CLOSE"`)
 * - Full circular footprint containment (`footprintRadius = 0.16 m`, testing center + 8 perimeter
 *   sample points and polygon edge clearance so half a turret base can never hang off a table,
 *   shelf, floor, or wall — `OVERHANG` -> `"OVERHANG"`)
 * - Core Bastion keep-out radius `0.55 m` (`CORE_ZONE` -> `"CORE ZONE"`)
 * - Dimensional Rift Portal keep-out radius `0.65 m` (`PORTAL_ZONE` -> `"PORTAL ZONE"`)
 * - Surface-snap ray range `0.5–6.0 m` and mid-air hover-pod depth `0.8–5.0 m` (`OUT_OF_RANGE`)
 * - Requisition credit affordability (`INSUFFICIENT_CREDITS` -> `"NO CREDITS"`)
 * - Attachable surface classification (`floor`, `table`, `wall` for `surface-clamp`; `INVALID_SURFACE`)
 * - Exact surface-normal-aligned mount orientation (`surface-clamp`) vs upright repulsor ring
 *   orientation (`hover-pod`)
 *
 * STRICT INVARIANT: Pure TypeScript — ZERO Three.js imports.
 */

import {
  ATTACHABLE_SURFACE_KINDS,
  type AttachableSurfaceKind,
  CORE_KEEP_OUT_RADIUS_M,
  getTurretBuildCost,
  HARD_TURRET_CAP,
  HOVER_POD_MAX_DEPTH_M,
  HOVER_POD_MIN_DEPTH_M,
  MAX_ACTIVE_TURRETS,
  PORTAL_KEEP_OUT_RADIUS_M,
  SURFACE_SNAP_MAX_RANGE_M,
  SURFACE_SNAP_MIN_RANGE_M,
  TURRET_FOOTPRINT_RADIUS_M,
  TURRET_MIN_SPACING_M,
  TURRET_MOUNT_IDS,
  TURRET_PLACEMENT_CONSTRAINTS,
  TURRET_RELOCATE_COST,
  TURRET_SELL_REFUND_RATIO,
  type TurretKind,
  type TurretMountProfileId,
  type Vec3,
} from '../content/turrets.ts';

export {
  ATTACHABLE_SURFACE_KINDS,
  type AttachableSurfaceKind,
  CORE_KEEP_OUT_RADIUS_M,
  HARD_TURRET_CAP,
  HOVER_POD_MAX_DEPTH_M,
  HOVER_POD_MIN_DEPTH_M,
  MAX_ACTIVE_TURRETS,
  PORTAL_KEEP_OUT_RADIUS_M,
  SURFACE_SNAP_MAX_RANGE_M,
  SURFACE_SNAP_MIN_RANGE_M,
  TURRET_FOOTPRINT_RADIUS_M,
  TURRET_MIN_SPACING_M,
  TURRET_MOUNT_IDS,
  TURRET_PLACEMENT_CONSTRAINTS,
  TURRET_RELOCATE_COST,
  TURRET_SELL_REFUND_RATIO,
  type TurretKind,
  type TurretMountProfileId,
  type Vec3,
};

export const PLACEMENT_INVALID_REASONS = [
  'CAP_REACHED',
  'TOO_CLOSE',
  'OVERHANG',
  'CORE_ZONE',
  'PORTAL_ZONE',
  'BLOCKED_BY_SURFACE',
  'OUT_OF_RANGE',
  'INSUFFICIENT_CREDITS',
  'INVALID_SURFACE',
] as const;

export type PlacementInvalidReason = (typeof PLACEMENT_INVALID_REASONS)[number];

/** Crisp Troika SDF hologram ghost rejection labels for each invalid placement reason. */
export const PLACEMENT_REASON_LABELS: Readonly<Record<PlacementInvalidReason, string>> =
  Object.freeze({
    CAP_REACHED: `CAP ${HARD_TURRET_CAP}/${HARD_TURRET_CAP}`,
    TOO_CLOSE: 'TOO CLOSE',
    OVERHANG: 'OVERHANG',
    CORE_ZONE: 'CORE ZONE',
    PORTAL_ZONE: 'PORTAL ZONE',
    BLOCKED_BY_SURFACE: 'BLOCKED BY SURFACE',
    OUT_OF_RANGE: 'OUT OF RANGE',
    INSUFFICIENT_CREDITS: 'NO CREDITS',
    INVALID_SURFACE: 'INVALID SURFACE',
  });

/** Number of perimeter sample points tested around the circular turret footprint (`8`). */
export const DEFAULT_FOOTPRINT_PERIMETER_SAMPLES = 8;

/** Default thumbstick deadzone before detaching or stepping mid-air hover-pod depth (`0.2`). */
export const DEFAULT_HOVER_THUMBSTICK_DEADZONE = 0.2;

/** Default mid-air hover-pod depth push/pull speed in meters per second at full stick deflection (`2.0 m/s`). */
export const DEFAULT_HOVER_DEPTH_SPEED_MPS = 2.0;

/** Default initial hover-pod depth when detaching without a prior surface hit distance (`1.8 m`). */
export const DEFAULT_INITIAL_HOVER_DEPTH_M = 1.8;

const POLYGON_EPSILON_M = 1e-4;
const DISTANCE_EPSILON_M = 1e-5;

export interface Quat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export interface Point2D {
  readonly x: number;
  readonly z: number;
}

export interface TangentBasis {
  readonly origin: Vec3;
  /** Surface tangent X axis (`right`). */
  readonly u: Vec3;
  /** Outward unit surface normal (`up`). */
  readonly normal: Vec3;
  /** Surface tangent Z axis (`forward`, completing right-handed `(u, normal, v)` basis). */
  readonly v: Vec3;
}

export interface TurretMountPose {
  readonly mountProfile: TurretMountProfileId;
  readonly position: Vec3;
  /** Outward surface normal for `surface-clamp`, or world `+Y` `(0, 1, 0)` for `hover-pod`. */
  readonly normal: Vec3;
  /** Unit quaternion rotating local `(right=+X, up=+Y, forward=+Z)` into world space. */
  readonly quaternion: Quat;
  /** World-space local `+X` axis. */
  readonly right: Vec3;
  /** World-space local `+Y` axis (aligned with `normal`). */
  readonly up: Vec3;
  /** World-space local `+Z` axis. */
  readonly forward: Vec3;
}

export interface SurfaceMountPose extends TurretMountPose {
  readonly mountProfile: 'surface-clamp';
  readonly surfaceId: string | null;
  readonly surfaceKind: AttachableSurfaceKind | null;
}

export interface HoverPodPose extends TurretMountPose {
  readonly mountProfile: 'hover-pod';
  /** Clamped depth along the aiming ray in `[0.8, 5.0]` meters. */
  readonly depthM: number;
  /** Alias for `depthM` (`[0.8, 5.0]` meters). */
  readonly clampedDepthM: number;
  /** Unclamped requested depth before `[0.8, 5.0]` clamping. */
  readonly rawDepthM: number;
  /** Horizontal yaw angle in radians around world `+Y`. */
  readonly yaw: number;
}

/**
 * Plain structural interface compatible with `RoomSurface` from `src/mr/room-scan.ts`
 * without requiring any Three.js imports.
 */
export interface PlacementSurfaceLike {
  readonly id?: string;
  readonly kind?: string;
  readonly normal?: Readonly<Vec3>;
  readonly center?: Readonly<Vec3>;
  readonly polygon?: readonly Readonly<Vec3>[];
  readonly localPolygon?: readonly Point2D[];
  readonly worldMatrix?: { readonly elements: readonly number[] };
  readonly meshVertices?: Float32Array;
  readonly meshIndices?: Uint32Array;
}

export interface PlacedTurretLike {
  readonly id?: string;
  readonly position: Readonly<Vec3>;
  readonly kind?: TurretKind;
  readonly mountProfile?: TurretMountProfileId;
  readonly surfaceId?: string | null;
}

export interface CoreAnchorLike {
  readonly position: Readonly<Vec3>;
  readonly radius?: number;
  readonly yaw?: number;
  readonly surfaceId?: string | null;
}

export interface PortalAnchorLike {
  readonly id?: string;
  readonly position: Readonly<Vec3>;
  readonly normal?: Readonly<Vec3>;
}

export interface FootprintCheckOptions {
  /** Turret base footprint radius in meters (defaults to `TURRET_FOOTPRINT_RADIUS_M = 0.16`). */
  readonly footprintRadiusM?: number;
  /** Number of perimeter points sampled around the circular footprint (defaults to `8`). */
  readonly perimeterSamples?: number;
  /** Explicit surface normal when checking against a raw 3D polygon array. */
  readonly surfaceNormal?: Readonly<Vec3>;
  /** Boundary tolerance in meters (defaults to `1e-4`). */
  readonly epsilonM?: number;
}

export interface FootprintInspectionResult {
  readonly within: boolean;
  readonly valid: boolean;
  readonly centerInside: boolean;
  readonly minEdgeDistanceM: number;
  readonly footprintRadiusM: number;
  readonly testedSampleCount: number;
  readonly insideSampleCount: number;
  readonly samplePoints2D: readonly Point2D[];
  readonly overhangingSamplePoints2D: readonly Point2D[];
  readonly samplePoints3D: readonly Vec3[];
  readonly overhangingSamplePoints3D: readonly Vec3[];
}

export interface SurfaceMountPoseInput {
  readonly position: Readonly<Vec3>;
  readonly normal?: Readonly<Vec3>;
  readonly surfaceNormal?: Readonly<Vec3>;
  readonly forwardHint?: Readonly<Vec3>;
  readonly surfaceId?: string | null;
  readonly surfaceKind?: AttachableSurfaceKind | string | null;
}

export interface HoverPodPoseInput {
  readonly rayOrigin?: Readonly<Vec3>;
  readonly rayDirection?: Readonly<Vec3>;
  readonly position?: Readonly<Vec3>;
  readonly depthM?: number;
  readonly minDepthM?: number;
  readonly maxDepthM?: number;
  readonly yawHint?: number;
  readonly forwardHint?: Readonly<Vec3>;
}

export interface HoverDepthStepOptions {
  readonly deadzone?: number;
  readonly speedMps?: number;
  readonly minDepthM?: number;
  readonly maxDepthM?: number;
}

export interface PlacementValidationContext {
  /** Currently active placed turrets (or their 3D center positions). */
  readonly existingTurrets?: readonly (PlacedTurretLike | Readonly<Vec3>)[];
  /** Optional explicit active turret count override (defaults to `existingTurrets.length`). */
  readonly activeTurretCount?: number;
  /** Core Bastion anchor or 3D center position for the `0.55 m` keep-out check. */
  readonly coreAnchor?: CoreAnchorLike | Readonly<Vec3> | null;
  /** Alias for `coreAnchor` center position. */
  readonly corePosition?: Readonly<Vec3> | null;
  /** Active or candidate Rift Portal anchors for the `0.65 m` keep-out check. */
  readonly portalAnchors?: readonly (PortalAnchorLike | Readonly<Vec3>)[];
  /** Alias for `portalAnchors`. */
  readonly portals?: readonly (PortalAnchorLike | Readonly<Vec3>)[];
  /** Current available Requisition credits (when provided, enforces build/relocate cost). */
  readonly credits?: number;
  /** Optional explicit credit cost override. */
  readonly requiredCredits?: number;
  /** ID of an existing turret being relocated (excluded from cap and self-spacing checks). */
  readonly relocatingTurretId?: string | null;
  /** Optional constraint overrides (default to `TURRET_PLACEMENT_CONSTRAINTS`). */
  readonly footprintRadiusM?: number;
  readonly minSpacingM?: number;
  readonly hardTurretCap?: number;
  readonly coreKeepOutRadiusM?: number;
  readonly portalKeepOutRadiusM?: number;
  readonly surfaceSnapMinRangeM?: number;
  readonly surfaceSnapMaxRangeM?: number;
  readonly hoverPodMinDepthM?: number;
  readonly hoverPodMaxDepthM?: number;
}

export interface TurretPlacementCandidate extends PlacementValidationContext {
  /** Turret role being placed (defaults to `'autocannon'`). */
  readonly kind?: TurretKind;
  /** Placement mount mode (`'surface-clamp'` or `'hover-pod'`). */
  readonly mountProfile?: TurretMountProfileId;
  /** Optional alias for `mountProfile`. */
  readonly mode?: TurretMountProfileId;
  /** Candidate 3D world-space placement position. */
  readonly position: Readonly<Vec3>;
  /** Outward surface normal (used for `'surface-clamp'`). */
  readonly normal?: Readonly<Vec3>;
  /** Optional alias for `normal`. */
  readonly surfaceNormal?: Readonly<Vec3>;
  /** Supporting surface for `'surface-clamp'` footprint and surface-kind checks. */
  readonly surface?: PlacementSurfaceLike | null;
  /** Explicit supporting surface ID. */
  readonly surfaceId?: string | null;
  /** Explicit supporting surface kind (`'floor' | 'table' | 'wall' | 'ceiling' | 'other'`). */
  readonly surfaceKind?: string | null;
  /** Optional polygon vertices override (`Vec3[]` or 2D `Point2D[]`) for footprint validation. */
  readonly polygon?: readonly (Readonly<Vec3> | Point2D)[];
  /** Optional ray origin used to validate ray distance (`0.5–6.0 m` surface / `0.8–5.0 m` hover). */
  readonly rayOrigin?: Readonly<Vec3>;
  /** Optional explicit ray distance in meters. */
  readonly rayDistanceM?: number;
  /** Distance along the placement ray to the first solid room surface. */
  readonly blockingSurfaceDistanceM?: number;
  /** Optional explicit hover-pod depth in meters. */
  readonly depthM?: number;
  /** Optional forward orientation hint for computing the turret mount pose. */
  readonly forwardHint?: Readonly<Vec3>;
}

export interface PlacementValidationResult {
  readonly valid: boolean;
  /** Primary rejection reason when `!valid`, or `null` when `valid`. */
  readonly reason: PlacementInvalidReason | null;
  /** All violated placement reasons in priority order (`[]` when `valid`). */
  readonly reasons: readonly PlacementInvalidReason[];
  /** Human-readable Troika SDF label for the primary rejection reason, or `null` when `valid`. */
  readonly reasonLabel: string | null;
  readonly mountProfile: TurretMountProfileId;
  readonly pose: TurretMountPose;
  readonly surfaceId: string | null;
  readonly surfaceKind: AttachableSurfaceKind | null;
  /** Requisition credit cost required for this build or relocate action. */
  readonly cost: number;
  /** Active turret count evaluated against `hardTurretCap`. */
  readonly activeTurretCount: number;
  readonly hardTurretCap: number;
  /** Evaluated ray or hover depth distance in meters (`null` if no ray origin/distance supplied). */
  readonly distanceM: number | null;
  /** Nearest center-to-center distance to an existing turret in meters (`null` if none). */
  readonly nearestTurretDistanceM: number | null;
  /** 3D distance to the Core Bastion center in meters (`null` if no Core supplied). */
  readonly coreDistanceM: number | null;
  /** Nearest 3D distance to any Rift Portal anchor in meters (`null` if no portals supplied). */
  readonly nearestPortalDistanceM: number | null;
  /** Detailed footprint inspection result for `'surface-clamp'` when a surface polygon is present. */
  readonly footprint: FootprintInspectionResult | null;
}

/** Formats a `PlacementInvalidReason` into its crisp Troika SDF hologram ghost label. */
export function formatPlacementInvalidReason(
  reason: PlacementInvalidReason,
  hardCap: number = HARD_TURRET_CAP,
): string {
  if (reason === 'CAP_REACHED') {
    return `CAP ${hardCap}/${hardCap}`;
  }
  return PLACEMENT_REASON_LABELS[reason];
}

/** Returns true if `kind` is an attachable turret surface (`'floor' | 'table' | 'wall'`). */
export function isAttachableSurfaceKind(
  kind: string | null | undefined,
): kind is AttachableSurfaceKind {
  return kind === 'floor' || kind === 'table' || kind === 'wall';
}

function vec3Length(v: Readonly<Vec3>): number {
  return Math.hypot(v.x, v.y, v.z);
}

function normalizeVec3(v: Readonly<Vec3>, fallback: Readonly<Vec3> = { x: 0, y: 1, z: 0 }): Vec3 {
  const len = vec3Length(v);
  if (!Number.isFinite(len) || len < 1e-8) {
    return { x: fallback.x, y: fallback.y, z: fallback.z };
  }
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function dotVec3(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function crossVec3(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function distance3D(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function isVec3Point(p: Readonly<Vec3> | Point2D): p is Readonly<Vec3> {
  return 'y' in p && typeof (p as Readonly<Vec3>).y === 'number';
}

/**
 * Converts a right-handed orthonormal basis `(right=+X, up=+Y, forward=+Z)` into a unit quaternion.
 */
export function basisToQuaternion(
  right: Readonly<Vec3>,
  up: Readonly<Vec3>,
  forward: Readonly<Vec3>,
): Quat {
  // Column-major rotation matrix where col0 = right, col1 = up, col2 = forward
  const m00 = right.x;
  const m10 = right.y;
  const m20 = right.z;
  const m01 = up.x;
  const m11 = up.y;
  const m21 = up.z;
  const m02 = forward.x;
  const m12 = forward.y;
  const m22 = forward.z;

  const trace = m00 + m11 + m22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;

  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }

  const len = Math.hypot(x, y, z, w);
  if (len < 1e-8) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  return {
    x: x / len,
    y: y / len,
    z: z / len,
    w: w / len,
  };
}

/**
 * Rotates a 3D vector by a unit quaternion `q`.
 */
export function applyQuaternionToVec3(v: Readonly<Vec3>, q: Readonly<Quat>): Vec3 {
  const vx = v.x;
  const vy = v.y;
  const vz = v.z;
  const qx = q.x;
  const qy = q.y;
  const qz = q.z;
  const qw = q.w;

  const ix = qw * vx + qy * vz - qz * vy;
  const iy = qw * vy + qz * vx - qx * vz;
  const iz = qw * vz + qx * vy - qy * vx;
  const iw = -qx * vx - qy * vy - qz * vz;

  return {
    x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
    y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
    z: iz * qw + iw * -qz + ix * -qy - iy * -qx,
  };
}

/**
 * Builds a deterministic right-handed tangent basis `(u, normal, v)` on a surface with outward
 * unit normal `surfaceNormal` and origin `origin`.
 */
export function buildSurfaceTangentBasis(
  origin: Readonly<Vec3>,
  surfaceNormal: Readonly<Vec3>,
  forwardHint?: Readonly<Vec3>,
): TangentBasis {
  const normal = normalizeVec3(surfaceNormal, { x: 0, y: 1, z: 0 });

  // Choose a reference tangent forward vector (`v` = local +Z) or right vector (`u` = local +X).
  let candidateForward: Vec3;
  if (forwardHint && vec3Length(forwardHint) > 1e-6) {
    const proj = {
      x: forwardHint.x - normal.x * dotVec3(forwardHint, normal),
      y: forwardHint.y - normal.y * dotVec3(forwardHint, normal),
      z: forwardHint.z - normal.z * dotVec3(forwardHint, normal),
    };
    if (vec3Length(proj) > 1e-5) {
      candidateForward = normalizeVec3(proj);
      const u = normalizeVec3(crossVec3(normal, candidateForward));
      const v = normalizeVec3(crossVec3(u, normal));
      return {
        origin: { x: origin.x, y: origin.y, z: origin.z },
        u,
        normal,
        v,
      };
    }
  }

  // When no valid forwardHint is given:
  // - For horizontal surfaces (|normal.y| >= 0.95), align local +X near world +X (1, 0, 0)
  // - For walls / sloped surfaces (|normal.y| < 0.95), keep local +X horizontal by crossing worldUp (0, 1, 0) with normal
  let u: Vec3;
  if (Math.abs(normal.y) < 0.95) {
    const worldUp: Vec3 = { x: 0, y: 1, z: 0 };
    u = normalizeVec3(crossVec3(worldUp, normal), { x: 1, y: 0, z: 0 });
  } else {
    const rawRight: Vec3 = {
      x: 1 - normal.x * normal.x,
      y: -normal.y * normal.x,
      z: -normal.z * normal.x,
    };
    u = normalizeVec3(rawRight, { x: 1, y: 0, z: 0 });
  }
  const v = normalizeVec3(crossVec3(u, normal), { x: 0, y: 0, z: 1 });

  return {
    origin: { x: origin.x, y: origin.y, z: origin.z },
    u,
    normal,
    v,
  };
}

/** Projects a 3D world point onto the 2D tangent plane `(u, v)` of `basis`. */
export function projectPointToSurface2D(
  point: Readonly<Vec3>,
  basis: Readonly<TangentBasis>,
): Point2D {
  const dx = point.x - basis.origin.x;
  const dy = point.y - basis.origin.y;
  const dz = point.z - basis.origin.z;
  return {
    x: dx * basis.u.x + dy * basis.u.y + dz * basis.u.z,
    z: dx * basis.v.x + dy * basis.v.y + dz * basis.v.z,
  };
}

/** Unprojects a 2D tangent-plane coordinate `(x, z)` back to a 3D world point on `basis`. */
export function unprojectPointFromSurface2D(
  pt: Readonly<Point2D>,
  basis: Readonly<TangentBasis>,
): Vec3 {
  return {
    x: basis.origin.x + basis.u.x * pt.x + basis.v.x * pt.z,
    y: basis.origin.y + basis.u.y * pt.x + basis.v.y * pt.z,
    z: basis.origin.z + basis.u.z * pt.x + basis.v.z * pt.z,
  };
}

function pointToSegmentDistanceSq2D(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const abx = bx - ax;
  const abz = bz - az;
  const lenSq = abx * abx + abz * abz;
  if (lenSq < 1e-12) {
    const dx = px - ax;
    const dz = pz - az;
    return dx * dx + dz * dz;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / lenSq));
  const cx = ax + t * abx;
  const cz = az + t * abz;
  const dx = px - cx;
  const dz = pz - cz;
  return dx * dx + dz * dz;
}

/**
 * Minimum Euclidean distance in 2D from `point` to any edge segment of `polygon`.
 */
export function distanceToPolygonBoundary2D(
  point: Readonly<Point2D>,
  polygon: readonly Readonly<Point2D>[],
): number {
  if (polygon.length < 2) return 0;
  let minDistSq = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i] as Readonly<Point2D>;
    const b = polygon[(i + 1) % polygon.length] as Readonly<Point2D>;
    const dSq = pointToSegmentDistanceSq2D(point.x, point.z, a.x, a.z, b.x, b.z);
    if (dSq < minDistSq) minDistSq = dSq;
  }
  return Math.sqrt(minDistSq);
}

/**
 * Tests whether a 2D point `(x, z)` lies inside or within `epsilonM` of the boundary of `polygon`.
 */
export function isPointInPolygon2D(
  point: Readonly<Point2D>,
  polygon: readonly Readonly<Point2D>[],
  epsilonM = POLYGON_EPSILON_M,
): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  const epsSq = epsilonM * epsilonM;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i] as Readonly<Point2D>;
    const pj = polygon[j] as Readonly<Point2D>;
    if (pointToSegmentDistanceSq2D(point.x, point.z, pi.x, pi.z, pj.x, pj.z) <= epsSq) {
      return true;
    }
    const intersect =
      pi.z > point.z !== pj.z > point.z &&
      point.x < ((pj.x - pi.x) * (point.z - pi.z)) / (pj.z - pi.z) + pi.x;
    if (intersect) inside = !inside;
  }

  return inside;
}

function estimatePolygonNormal3D(points: readonly Readonly<Vec3>[]): Vec3 {
  if (points.length < 3) return { x: 0, y: 1, z: 0 };
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < points.length; i += 1) {
    const curr = points[i] as Readonly<Vec3>;
    const next = points[(i + 1) % points.length] as Readonly<Vec3>;
    nx += (curr.y - next.y) * (curr.z + next.z);
    ny += (curr.z - next.z) * (curr.x + next.x);
    nz += (curr.x - next.x) * (curr.y + next.y);
  }
  return normalizeVec3({ x: nx, y: ny, z: nz }, { x: 0, y: 1, z: 0 });
}

function isSurfaceObject(
  input: PlacementSurfaceLike | readonly (Readonly<Vec3> | Point2D)[] | null | undefined,
): input is PlacementSurfaceLike {
  return Boolean(input && !Array.isArray(input) && typeof input === 'object');
}

function resolveFootprintOptions(
  optionsOrRadius?: number | FootprintCheckOptions,
  surfaceNormalArg?: Readonly<Vec3>,
): Required<Omit<FootprintCheckOptions, 'surfaceNormal'>> & {
  readonly surfaceNormal?: Readonly<Vec3>;
} {
  if (typeof optionsOrRadius === 'number') {
    return {
      footprintRadiusM: optionsOrRadius,
      perimeterSamples: DEFAULT_FOOTPRINT_PERIMETER_SAMPLES,
      epsilonM: POLYGON_EPSILON_M,
      ...(surfaceNormalArg ? { surfaceNormal: surfaceNormalArg } : {}),
    };
  }
  return {
    footprintRadiusM: optionsOrRadius?.footprintRadiusM ?? TURRET_FOOTPRINT_RADIUS_M,
    perimeterSamples: Math.max(
      4,
      optionsOrRadius?.perimeterSamples ?? DEFAULT_FOOTPRINT_PERIMETER_SAMPLES,
    ),
    epsilonM: optionsOrRadius?.epsilonM ?? POLYGON_EPSILON_M,
    ...((optionsOrRadius?.surfaceNormal ?? surfaceNormalArg)
      ? { surfaceNormal: optionsOrRadius?.surfaceNormal ?? surfaceNormalArg }
      : {}),
  };
}

/**
 * Inspects whether a circular turret footprint (default `footprintRadiusM = 0.16 m`) centered at
 * `center` is completely contained inside a supporting surface polygon (testing the center point,
 * `8` perimeter sample points at `0°..315°`, and minimum edge distance >= `footprintRadiusM`).
 *
 * Works identically across horizontal floors/tables, vertical walls, tilted planes, and 2D local
 * polygons so half a turret base can NEVER hang off a table, shelf, or wall edge (`OVERHANG`).
 */
export function inspectFootprintWithinPolygon(
  center: Readonly<Vec3> | Point2D,
  polygonOrSurface: PlacementSurfaceLike | readonly (Readonly<Vec3> | Point2D)[],
  optionsOrRadius?: number | FootprintCheckOptions,
  surfaceNormalArg?: Readonly<Vec3>,
): FootprintInspectionResult {
  const opts = resolveFootprintOptions(optionsOrRadius, surfaceNormalArg);
  const radiusM = Math.max(0, opts.footprintRadiusM);
  const sampleCount = opts.perimeterSamples;
  const eps = opts.epsilonM;

  let rawPolygon: readonly (Readonly<Vec3> | Point2D)[] = [];
  let explicitNormal: Readonly<Vec3> | undefined = opts.surfaceNormal;
  let surfaceCenter: Readonly<Vec3> | undefined;

  if (isSurfaceObject(polygonOrSurface)) {
    if (polygonOrSurface.normal) explicitNormal = polygonOrSurface.normal;
    if (polygonOrSurface.center) surfaceCenter = polygonOrSurface.center;
    if (polygonOrSurface.polygon && polygonOrSurface.polygon.length >= 3) {
      rawPolygon = polygonOrSurface.polygon;
    } else if (polygonOrSurface.localPolygon && polygonOrSurface.localPolygon.length >= 3) {
      rawPolygon = polygonOrSurface.localPolygon;
    }
  } else if (Array.isArray(polygonOrSurface)) {
    rawPolygon = polygonOrSurface;
  }

  if (rawPolygon.length < 3) {
    return {
      within: false,
      valid: false,
      centerInside: false,
      minEdgeDistanceM: 0,
      footprintRadiusM: radiusM,
      testedSampleCount: 0,
      insideSampleCount: 0,
      samplePoints2D: [],
      overhangingSamplePoints2D: [],
      samplePoints3D: [],
      overhangingSamplePoints3D: [],
    };
  }

  const firstVertex = rawPolygon[0] as Readonly<Vec3> | Point2D;
  const is3DPolygon = isVec3Point(firstVertex);

  let basis: TangentBasis;
  let polygon2D: Point2D[];
  let center2D: Point2D;

  if (is3DPolygon) {
    const poly3D = rawPolygon as readonly Readonly<Vec3>[];
    const first3D = poly3D[0] as Readonly<Vec3>;
    const normal = explicitNormal ?? estimatePolygonNormal3D(poly3D);
    const origin3D: Vec3 = isVec3Point(center)
      ? { x: center.x, y: center.y, z: center.z }
      : surfaceCenter
        ? { x: surfaceCenter.x, y: surfaceCenter.y, z: surfaceCenter.z }
        : { x: first3D.x, y: first3D.y, z: first3D.z };
    basis = buildSurfaceTangentBasis(origin3D, normal);
    polygon2D = poly3D.map((v) => projectPointToSurface2D(v, basis));
    center2D = isVec3Point(center)
      ? projectPointToSurface2D(center, basis)
      : { x: center.x, z: center.z };
  } else {
    // 2D local polygon in (x, z)
    const poly2D = rawPolygon as readonly Point2D[];
    polygon2D = poly2D.map((p) => ({ x: p.x, z: p.z }));
    center2D = { x: center.x, z: center.z };
    const centerY = isVec3Point(center) ? center.y : 0;
    basis = {
      origin: { x: 0, y: centerY, z: 0 },
      u: { x: 1, y: 0, z: 0 },
      normal: explicitNormal ? normalizeVec3(explicitNormal) : { x: 0, y: 1, z: 0 },
      v: { x: 0, y: 0, z: 1 },
    };
  }

  const samplePoints2D: Point2D[] = [center2D];
  if (radiusM > 0) {
    for (let k = 0; k < sampleCount; k += 1) {
      const theta = (2 * Math.PI * k) / sampleCount;
      samplePoints2D.push({
        x: center2D.x + radiusM * Math.cos(theta),
        z: center2D.z + radiusM * Math.sin(theta),
      });
    }
  }

  const overhangingSamplePoints2D: Point2D[] = [];
  let centerInside = false;

  for (let i = 0; i < samplePoints2D.length; i += 1) {
    const sample = samplePoints2D[i] as Point2D;
    const inside = isPointInPolygon2D(sample, polygon2D, eps);
    if (i === 0) centerInside = inside;
    if (!inside) {
      overhangingSamplePoints2D.push(sample);
    }
  }

  const minEdgeDistanceM = centerInside ? distanceToPolygonBoundary2D(center2D, polygon2D) : 0;
  const edgeClearanceOk = radiusM <= 0 || minEdgeDistanceM >= radiusM - eps;
  const within = centerInside && overhangingSamplePoints2D.length === 0 && edgeClearanceOk;

  // If an edge sits closer than `radiusM` between two sample angles, include the closest boundary
  // overhang point in `overhangingSamplePoints2D` so diagnostics are always non-empty on overhang.
  if (centerInside && overhangingSamplePoints2D.length === 0 && !edgeClearanceOk) {
    overhangingSamplePoints2D.push({
      x: center2D.x + radiusM,
      z: center2D.z,
    });
  }

  const samplePoints3D = samplePoints2D.map((pt) => unprojectPointFromSurface2D(pt, basis));
  const overhangingSamplePoints3D = overhangingSamplePoints2D.map((pt) =>
    unprojectPointFromSurface2D(pt, basis),
  );
  const insideSampleCount = samplePoints2D.length - overhangingSamplePoints2D.length;

  return {
    within,
    valid: within,
    centerInside,
    minEdgeDistanceM,
    footprintRadiusM: radiusM,
    testedSampleCount: samplePoints2D.length,
    insideSampleCount,
    samplePoints2D,
    overhangingSamplePoints2D,
    samplePoints3D,
    overhangingSamplePoints3D,
  };
}

/**
 * Pure boolean check testing whether the entire circular turret footprint (`0.16 m` radius: center
 * + 8 perimeter sample points + polygon edge clearance) lies within the supporting surface polygon.
 *
 * Returns `false` (`OVERHANG`) if any edge of the turret base hangs off a table, shelf, floor, or wall.
 */
export function checkFootprintWithinPolygon(
  center: Readonly<Vec3> | Point2D,
  polygonOrSurface: PlacementSurfaceLike | readonly (Readonly<Vec3> | Point2D)[],
  optionsOrRadius?: number | FootprintCheckOptions,
  surfaceNormalArg?: Readonly<Vec3>,
): boolean {
  return inspectFootprintWithinPolygon(center, polygonOrSurface, optionsOrRadius, surfaceNormalArg)
    .within;
}

/**
 * Computes the exact surface-normal-aligned mount pose (`mountProfile: 'surface-clamp'`) for a
 * turret clamped flush onto a scanned floor, table, or wall.
 *
 * Local `+Y` (`up`) is strictly aligned with the outward unit surface normal.
 */
export function computeSurfaceMountPose(
  inputOrPosition: SurfaceMountPoseInput | Readonly<Vec3>,
  surfaceNormalArg?: Readonly<Vec3>,
  forwardHintArg?: Readonly<Vec3>,
): SurfaceMountPose {
  let position: Readonly<Vec3>;
  let rawNormal: Readonly<Vec3>;
  let forwardHint: Readonly<Vec3> | undefined;
  let surfaceId: string | null = null;
  let surfaceKind: AttachableSurfaceKind | null = null;

  if ('position' in inputOrPosition) {
    position = inputOrPosition.position;
    rawNormal = inputOrPosition.normal ?? inputOrPosition.surfaceNormal ?? { x: 0, y: 1, z: 0 };
    forwardHint = inputOrPosition.forwardHint;
    surfaceId = inputOrPosition.surfaceId ?? null;
    surfaceKind = isAttachableSurfaceKind(inputOrPosition.surfaceKind)
      ? inputOrPosition.surfaceKind
      : null;
  } else {
    position = inputOrPosition;
    rawNormal = surfaceNormalArg ?? { x: 0, y: 1, z: 0 };
    forwardHint = forwardHintArg;
  }

  const basis = buildSurfaceTangentBasis(position, rawNormal, forwardHint);
  const quaternion = basisToQuaternion(basis.u, basis.normal, basis.v);

  return {
    mountProfile: 'surface-clamp',
    position: { x: position.x, y: position.y, z: position.z },
    normal: basis.normal,
    quaternion,
    right: basis.u,
    up: basis.normal,
    forward: basis.v,
    surfaceId,
    surfaceKind,
  };
}

/**
 * Strictly clamps a mid-air hover-pod depth to `[HOVER_POD_MIN_DEPTH_M, HOVER_POD_MAX_DEPTH_M]`
 * (`0.8–5.0 m`).
 */
export function clampHoverPodDepth(
  depthM: number,
  minDepthM = HOVER_POD_MIN_DEPTH_M,
  maxDepthM = HOVER_POD_MAX_DEPTH_M,
): number {
  if (!Number.isFinite(depthM)) return minDepthM;
  return Math.max(minDepthM, Math.min(maxDepthM, depthM));
}

/**
 * Applies deadzone-filtered, elapsed-time-scaled thumbstick push/pull input to a mid-air
 * hover-pod depth and clamps the result strictly to `[0.8, 5.0]` meters.
 *
 * Sign convention:
 * - `pushPullInput > +deadzone` (pushing forward/away) increases depth toward `5.0 m`
 * - `pushPullInput < -deadzone` (pulling backward/closer) decreases depth toward `0.8 m`
 */
export function stepHoverPodDepth(
  currentDepthM: number,
  pushPullInput: number,
  dtSec: number,
  options?: HoverDepthStepOptions,
): number {
  const deadzone = options?.deadzone ?? DEFAULT_HOVER_THUMBSTICK_DEADZONE;
  const speedMps = options?.speedMps ?? DEFAULT_HOVER_DEPTH_SPEED_MPS;
  const minDepthM = options?.minDepthM ?? HOVER_POD_MIN_DEPTH_M;
  const maxDepthM = options?.maxDepthM ?? HOVER_POD_MAX_DEPTH_M;

  const clampedCurrent = clampHoverPodDepth(currentDepthM, minDepthM, maxDepthM);
  if (!Number.isFinite(pushPullInput) || !Number.isFinite(dtSec) || dtSec <= 0) {
    return clampedCurrent;
  }
  const absInput = Math.abs(pushPullInput);
  if (absInput <= deadzone) {
    return clampedCurrent;
  }

  const sign = pushPullInput > 0 ? 1 : -1;
  const normalizedMagnitude = Math.min(1, (absInput - deadzone) / Math.max(1e-5, 1 - deadzone));
  const nextDepth = clampedCurrent + sign * normalizedMagnitude * speedMps * dtSec;
  return clampHoverPodDepth(nextDepth, minDepthM, maxDepthM);
}

/**
 * Computes the upright repulsor hover-ring mount pose (`mountProfile: 'hover-pod'`) for a mid-air
 * turret deployed via thumbstick depth push/pull (`0.8–5.0 m`).
 *
 * Accepts either:
 * - `computeHoverPodPose({ rayOrigin, rayDirection, depthM, ... })`
 * - `computeHoverPodPose(rayOrigin, rayDirection, depthM, yawOrForwardHint?)`
 * - `computeHoverPodPose(position, yawHint?)`
 */
export function computeHoverPodPose(
  inputOrOriginOrPos: HoverPodPoseInput | Readonly<Vec3>,
  rayDirectionOrYawArg?: Readonly<Vec3> | number,
  depthMArg?: number,
  yawOrForwardHintArg?: number | Readonly<Vec3>,
): HoverPodPose {
  let position: Vec3;
  let rawDepthM: number;
  let clampedDepthM: number;
  let yaw = 0;

  const worldUp: Vec3 = { x: 0, y: 1, z: 0 };

  if (
    'rayOrigin' in inputOrOriginOrPos ||
    'position' in inputOrOriginOrPos ||
    'depthM' in inputOrOriginOrPos
  ) {
    const input = inputOrOriginOrPos as HoverPodPoseInput;
    const minDepth = input.minDepthM ?? HOVER_POD_MIN_DEPTH_M;
    const maxDepth = input.maxDepthM ?? HOVER_POD_MAX_DEPTH_M;
    rawDepthM = input.depthM ?? DEFAULT_INITIAL_HOVER_DEPTH_M;
    clampedDepthM = clampHoverPodDepth(rawDepthM, minDepth, maxDepth);

    if (input.rayOrigin && input.rayDirection) {
      const dir = normalizeVec3(input.rayDirection, { x: 0, y: 0, z: -1 });
      position = {
        x: input.rayOrigin.x + dir.x * clampedDepthM,
        y: input.rayOrigin.y + dir.y * clampedDepthM,
        z: input.rayOrigin.z + dir.z * clampedDepthM,
      };
    } else if (input.position) {
      position = { x: input.position.x, y: input.position.y, z: input.position.z };
    } else {
      position = { x: 0, y: 1.2, z: -clampedDepthM };
    }

    if (typeof input.yawHint === 'number' && Number.isFinite(input.yawHint)) {
      yaw = input.yawHint;
    } else if (input.forwardHint && Math.hypot(input.forwardHint.x, input.forwardHint.z) > 1e-6) {
      yaw = Math.atan2(input.forwardHint.x, input.forwardHint.z);
    }
  } else if (
    rayDirectionOrYawArg &&
    typeof rayDirectionOrYawArg === 'object' &&
    'x' in rayDirectionOrYawArg
  ) {
    const rayOrigin = inputOrOriginOrPos as Readonly<Vec3>;
    const rayDir = normalizeVec3(rayDirectionOrYawArg, { x: 0, y: 0, z: -1 });
    rawDepthM = depthMArg ?? DEFAULT_INITIAL_HOVER_DEPTH_M;
    clampedDepthM = clampHoverPodDepth(rawDepthM);
    position = {
      x: rayOrigin.x + rayDir.x * clampedDepthM,
      y: rayOrigin.y + rayDir.y * clampedDepthM,
      z: rayOrigin.z + rayDir.z * clampedDepthM,
    };

    if (typeof yawOrForwardHintArg === 'number' && Number.isFinite(yawOrForwardHintArg)) {
      yaw = yawOrForwardHintArg;
    } else if (
      yawOrForwardHintArg &&
      typeof yawOrForwardHintArg === 'object' &&
      Math.hypot(yawOrForwardHintArg.x, yawOrForwardHintArg.z) > 1e-6
    ) {
      yaw = Math.atan2(yawOrForwardHintArg.x, yawOrForwardHintArg.z);
    }
  } else {
    const pos = inputOrOriginOrPos as Readonly<Vec3>;
    position = { x: pos.x, y: pos.y, z: pos.z };
    rawDepthM =
      typeof depthMArg === 'number'
        ? depthMArg
        : clampHoverPodDepth(Math.hypot(pos.x, pos.y, pos.z));
    clampedDepthM = clampHoverPodDepth(rawDepthM);
    if (typeof rayDirectionOrYawArg === 'number' && Number.isFinite(rayDirectionOrYawArg)) {
      yaw = rayDirectionOrYawArg;
    }
  }

  const right: Vec3 = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
  const forward: Vec3 = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
  const halfYaw = yaw * 0.5;
  const quaternion: Quat = {
    x: 0,
    y: Math.sin(halfYaw),
    z: 0,
    w: Math.cos(halfYaw),
  };

  return {
    mountProfile: 'hover-pod',
    position,
    normal: worldUp,
    quaternion,
    right,
    up: worldUp,
    forward,
    depthM: clampedDepthM,
    clampedDepthM,
    rawDepthM,
    yaw,
  };
}

function extractVec3(item: Readonly<Vec3> | { readonly position: Readonly<Vec3> }): Readonly<Vec3> {
  if ('position' in item) return item.position;
  return item;
}

/**
 * Validates a candidate turret placement (either `'surface-clamp'` on floor/table/wall or
 * `'hover-pod'` in mid-air) against all spatial and economy constraints:
 * 1. `CAP_REACHED` (`14` active turret hard cap)
 * 2. `INVALID_SURFACE` (`surface-clamp` requires `'floor' | 'table' | 'wall'`)
 * 3. `OUT_OF_RANGE` (`0.5–6.0 m` for surface snap; `0.8–5.0 m` for hover-pod when ray distance/depth given)
 * 4. `CORE_ZONE` (`0.55 m` keep-out radius around the Core Bastion)
 * 5. `PORTAL_ZONE` (`0.65 m` keep-out radius around any Rift Portal anchor)
 * 6. `TOO_CLOSE` (`0.35 m` minimum center-to-center spacing from all existing turrets)
 * 7. `OVERHANG` (`0.16 m` full circular footprint containment inside supporting surface polygon)
 * 8. `INSUFFICIENT_CREDITS` (Requisition credits >= build/relocate cost when `credits` provided)
 */
export function validateTurretPlacement(
  candidate: TurretPlacementCandidate,
  context?: PlacementValidationContext,
): PlacementValidationResult {
  const kind: TurretKind = candidate.kind ?? 'autocannon';
  const relocatingTurretId = context?.relocatingTurretId ?? candidate.relocatingTurretId ?? null;

  const footprintRadiusM =
    context?.footprintRadiusM ?? candidate.footprintRadiusM ?? TURRET_FOOTPRINT_RADIUS_M;
  const minSpacingM = context?.minSpacingM ?? candidate.minSpacingM ?? TURRET_MIN_SPACING_M;
  const hardTurretCap = context?.hardTurretCap ?? candidate.hardTurretCap ?? HARD_TURRET_CAP;
  const coreKeepOutRadiusM =
    context?.coreKeepOutRadiusM ?? candidate.coreKeepOutRadiusM ?? CORE_KEEP_OUT_RADIUS_M;
  const portalKeepOutRadiusM =
    context?.portalKeepOutRadiusM ?? candidate.portalKeepOutRadiusM ?? PORTAL_KEEP_OUT_RADIUS_M;
  const surfaceSnapMinRangeM =
    context?.surfaceSnapMinRangeM ?? candidate.surfaceSnapMinRangeM ?? SURFACE_SNAP_MIN_RANGE_M;
  const surfaceSnapMaxRangeM =
    context?.surfaceSnapMaxRangeM ?? candidate.surfaceSnapMaxRangeM ?? SURFACE_SNAP_MAX_RANGE_M;
  const hoverPodMinDepthM =
    context?.hoverPodMinDepthM ?? candidate.hoverPodMinDepthM ?? HOVER_POD_MIN_DEPTH_M;
  const hoverPodMaxDepthM =
    context?.hoverPodMaxDepthM ?? candidate.hoverPodMaxDepthM ?? HOVER_POD_MAX_DEPTH_M;

  const surface = candidate.surface ?? null;
  const rawSurfaceKind = candidate.surfaceKind ?? surface?.kind ?? null;
  const surfaceId = candidate.surfaceId ?? surface?.id ?? null;

  const mountProfile: TurretMountProfileId =
    candidate.mountProfile ??
    candidate.mode ??
    (surface !== null || rawSurfaceKind !== null || candidate.polygon !== undefined
      ? 'surface-clamp'
      : 'hover-pod');

  const rawNormal =
    candidate.normal ??
    candidate.surfaceNormal ??
    surface?.normal ??
    ({ x: 0, y: 1, z: 0 } as const);
  const rayOrigin = candidate.rayOrigin;
  const flipNormal =
    rawSurfaceKind === 'wall' && rayOrigin
      ? dotVec3(rawNormal, {
          x: rayOrigin.x - candidate.position.x,
          y: rayOrigin.y - candidate.position.y,
          z: rayOrigin.z - candidate.position.z,
        }) < 0
      : (rawSurfaceKind === 'floor' || rawSurfaceKind === 'table') && rawNormal.y < 0;
  const mountNormal = flipNormal
    ? { x: -rawNormal.x, y: -rawNormal.y, z: -rawNormal.z }
    : rawNormal;

  const pose =
    mountProfile === 'surface-clamp'
      ? computeSurfaceMountPose({
          position: candidate.position,
          normal: mountNormal,
          forwardHint: candidate.forwardHint,
          surfaceId,
          surfaceKind: rawSurfaceKind,
        })
      : computeHoverPodPose({
          position: candidate.position,
          depthM: candidate.depthM ?? candidate.rayDistanceM,
          forwardHint: candidate.forwardHint,
        });

  const existingRaw = context?.existingTurrets ?? candidate.existingTurrets ?? [];
  const filteredExisting = existingRaw.filter((t) => {
    if (!relocatingTurretId) return true;
    if ('id' in t && typeof t.id === 'string') {
      return t.id !== relocatingTurretId;
    }
    return true;
  });

  const explicitCount = context?.activeTurretCount ?? candidate.activeTurretCount;
  const activeTurretCount =
    explicitCount !== undefined ? Math.max(0, explicitCount) : filteredExisting.length;

  const cost =
    context?.requiredCredits ??
    candidate.requiredCredits ??
    (relocatingTurretId ? TURRET_RELOCATE_COST : getTurretBuildCost(kind));

  const credits = context?.credits ?? candidate.credits;

  const coreSource =
    context?.coreAnchor ??
    context?.corePosition ??
    candidate.coreAnchor ??
    candidate.corePosition ??
    null;
  const corePos = coreSource ? extractVec3(coreSource) : null;
  const effectiveCoreRadiusM =
    coreSource &&
    'radius' in coreSource &&
    typeof coreSource.radius === 'number' &&
    coreSource.radius > 0
      ? Math.max(coreKeepOutRadiusM, coreSource.radius)
      : coreKeepOutRadiusM;

  const portalList =
    context?.portalAnchors ??
    context?.portals ??
    candidate.portalAnchors ??
    candidate.portals ??
    [];

  // Compute distance from rayOrigin / explicit rayDistanceM / depthM
  let distanceM: number | null = null;
  if (typeof candidate.rayDistanceM === 'number' && Number.isFinite(candidate.rayDistanceM)) {
    distanceM = candidate.rayDistanceM;
  } else if (
    pose.mountProfile === 'hover-pod' &&
    typeof candidate.depthM === 'number' &&
    Number.isFinite(candidate.depthM)
  ) {
    distanceM = candidate.depthM;
  } else if (candidate.rayOrigin) {
    distanceM = distance3D(candidate.rayOrigin, candidate.position);
  }

  const reasons: PlacementInvalidReason[] = [];

  // 1. Hard turret cap check (14 active turrets)
  if (activeTurretCount >= hardTurretCap) {
    reasons.push('CAP_REACHED');
  }

  // 2. Surface kind validity check for surface-clamp
  let validSurfaceKind: AttachableSurfaceKind | null = null;
  if (mountProfile === 'surface-clamp') {
    if (rawSurfaceKind !== null) {
      if (isAttachableSurfaceKind(rawSurfaceKind)) {
        validSurfaceKind = rawSurfaceKind;
      } else {
        reasons.push('INVALID_SURFACE');
      }
    } else if (
      candidate.surface === null &&
      candidate.polygon === undefined &&
      candidate.normal === undefined &&
      candidate.surfaceNormal === undefined
    ) {
      reasons.push('INVALID_SURFACE');
    } else {
      // Infer floor/table/wall from normal if kind wasn't explicitly labeled
      validSurfaceKind =
        Math.abs(pose.normal.y) >= 0.7 ? (pose.normal.y > 0 ? 'floor' : null) : 'wall';
      if (validSurfaceKind === null) {
        reasons.push('INVALID_SURFACE');
      }
    }
  }

  // 3. Range / depth check
  if (
    pose.mountProfile === 'hover-pod' &&
    candidate.blockingSurfaceDistanceM !== undefined &&
    pose.depthM + footprintRadiusM > candidate.blockingSurfaceDistanceM
  ) {
    reasons.push('BLOCKED_BY_SURFACE');
  }
  if (distanceM !== null) {
    if (mountProfile === 'surface-clamp') {
      if (
        distanceM < surfaceSnapMinRangeM - DISTANCE_EPSILON_M ||
        distanceM > surfaceSnapMaxRangeM + DISTANCE_EPSILON_M
      ) {
        reasons.push('OUT_OF_RANGE');
      }
    } else if (
      distanceM < hoverPodMinDepthM - DISTANCE_EPSILON_M ||
      distanceM > hoverPodMaxDepthM + DISTANCE_EPSILON_M
    ) {
      reasons.push('OUT_OF_RANGE');
    }
  }

  // 4. Core keep-out zone check (0.55 m)
  let coreDistanceM: number | null = null;
  if (corePos) {
    coreDistanceM = distance3D(candidate.position, corePos);
    if (coreDistanceM < effectiveCoreRadiusM - DISTANCE_EPSILON_M) {
      reasons.push('CORE_ZONE');
    }
  }

  // 5. Portal keep-out zone check (0.65 m)
  let nearestPortalDistanceM: number | null = null;
  for (const portal of portalList) {
    const portalPos = extractVec3(portal);
    const d = distance3D(candidate.position, portalPos);
    if (nearestPortalDistanceM === null || d < nearestPortalDistanceM) {
      nearestPortalDistanceM = d;
    }
  }
  if (
    nearestPortalDistanceM !== null &&
    nearestPortalDistanceM < portalKeepOutRadiusM - DISTANCE_EPSILON_M
  ) {
    reasons.push('PORTAL_ZONE');
  }

  // 6. Minimum turret-to-turret spacing check (0.35 m)
  let nearestTurretDistanceM: number | null = null;
  for (const existing of filteredExisting) {
    const existingPos = extractVec3(existing);
    const d = distance3D(candidate.position, existingPos);
    if (nearestTurretDistanceM === null || d < nearestTurretDistanceM) {
      nearestTurretDistanceM = d;
    }
  }
  if (
    nearestTurretDistanceM !== null &&
    nearestTurretDistanceM < minSpacingM - DISTANCE_EPSILON_M
  ) {
    reasons.push('TOO_CLOSE');
  }

  // 7. Full footprint containment check against supporting surface polygon (0.16 m radius, 8 perimeter samples + center)
  let footprint: FootprintInspectionResult | null = null;
  if (mountProfile === 'surface-clamp') {
    const polySource =
      candidate.polygon ??
      (surface &&
      ((surface.polygon && surface.polygon.length >= 3) ||
        (surface.localPolygon && surface.localPolygon.length >= 3))
        ? surface
        : null);

    if (polySource !== null) {
      footprint = inspectFootprintWithinPolygon(candidate.position, polySource, {
        footprintRadiusM,
        surfaceNormal: pose.normal,
      });
      if (!footprint.within) {
        reasons.push('OVERHANG');
      }
    }
  }

  // 8. Requisition credit check
  if (typeof credits === 'number' && Number.isFinite(credits) && credits < cost) {
    reasons.push('INSUFFICIENT_CREDITS');
  }

  const valid = reasons.length === 0;
  const primaryReason = reasons[0] ?? null;
  const reasonLabel = primaryReason
    ? formatPlacementInvalidReason(primaryReason, hardTurretCap)
    : null;

  return {
    valid,
    reason: primaryReason,
    reasons,
    reasonLabel,
    mountProfile,
    pose,
    surfaceId,
    surfaceKind: validSurfaceKind,
    cost,
    activeTurretCount,
    hardTurretCap,
    distanceM,
    nearestTurretDistanceM,
    coreDistanceM,
    nearestPortalDistanceM,
    footprint,
  };
}
