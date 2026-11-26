/**
 * Deterministic Hybrid 3D Room Navigation Graph (`src/nav/graph.ts`).
 *
 * Pure TypeScript with ZERO Three.js imports. Accepts minimal plain numeric `Vec3` / surface
 * polygon structures structurally compatible with `RoomSurfaceModel`, `RoomSurface`, `CoreAnchor`,
 * and `PortalAnchor`.
 *
 * Layers:
 * 1. Crawler Surface Layer (`'surface'`):
 *    - Smooth wall/ceiling descent splines (`'climb' | 'drop' | 'floor'`) with per-segment
 *      surface normals from every portal aperture down onto the nearest walkable floor node.
 *    - Deterministic 2D grid A* + continuous visibility-graph / string-pulling pathfinding on
 *      the floor plane around furniture obstacle footprints (`table` / `other` projections with
 *      collision clearance margin) to the Core Bastion.
 *    - Stuck-unit recovery (`recoverStuckCrawler(pos, graph)`) computing a 3D leap/re-path bridge
 *      to the nearest Core-connected floor waypoint whenever a dynamic scan update or room-splitting
 *      obstacle blocks a corridor.
 * 2. Aerial Corridor Layer (`'air'`):
 *    - Smooth 3D obstacle-clearing flight splines (`'fly'`) from every portal through open room
 *      air to the Core, supporting lateral lane spread (`laneIndex` offset) so `Wasp Skimmer`
 *      flocks never stack on a single line.
 *    - Rift Disruptor turret-detour steering (`computeDisruptorDetourPath`) routing near active
 *      turrets (`<= 1.2 m` EMP radius) before continuing toward the Core.
 * 3. Exact O(1) `distanceToCore` & Path Sampling (`samplePathAtDistance(path, s)`):
 *    - Precomputes cumulative arc lengths and uniform arc-length lookup tables guaranteeing
 *      strictly monotonic `distanceToCore` for exact turret `"First"` targeting across both
 *      ground and air layers.
 */

import type { MovementLayer, Vec3 } from '../content/turrets.ts';
import { CORE_SHIELD_RADIUS_M } from '../content/waves.ts';

export type { MovementLayer, Vec3 };

export interface Point2D {
  readonly x: number;
  readonly z: number;
}

export type CrawlerLocomotionMode = 'climb' | 'drop' | 'floor';
export type LocomotionMode = CrawlerLocomotionMode | 'fly';

export type NavSurfaceKind = 'floor' | 'table' | 'wall' | 'ceiling' | 'other';
export type NavCoreSurfaceKind = NavSurfaceKind | 'virtual-pedestal';
export type NavPortalHostKind = 'wall' | 'ceiling' | 'virtual-rift';

export interface NavSurfaceBounds {
  readonly min: Readonly<Vec3>;
  readonly max: Readonly<Vec3>;
}

/**
 * Plain structural interface compatible with `RoomSurface` from `src/mr/room-scan.ts`
 * without importing Three.js.
 */
export interface NavSurfaceInput {
  readonly id: string;
  readonly kind: NavSurfaceKind;
  readonly normal: Readonly<Vec3>;
  readonly center: Readonly<Vec3>;
  readonly polygon: readonly Readonly<Vec3>[];
  readonly bounds?: NavSurfaceBounds;
}

/**
 * Plain structural interface compatible with `CoreAnchor` from `src/xr/calibration.ts`.
 */
export interface NavCoreAnchorInput {
  readonly position: Readonly<Vec3>;
  readonly yaw?: number;
  readonly surfaceId?: string | null;
  readonly surfaceKind?: NavCoreSurfaceKind;
  readonly radius?: number;
}

/**
 * Plain structural interface compatible with `PortalAnchor` from `src/xr/calibration.ts`.
 */
export interface NavPortalAnchorInput {
  readonly id: string;
  readonly position: Readonly<Vec3>;
  readonly normal: Readonly<Vec3>;
  readonly width?: number;
  readonly height?: number;
  readonly surfaceId?: string | null;
  readonly hostKind?: NavPortalHostKind;
  readonly distanceFromCore?: number;
}

export interface NavObstacle {
  readonly id: string;
  readonly surfaceId: string;
  readonly kind: NavSurfaceKind;
  /** Raw 2D footprint polygon in world XZ (CCW convex hull / surface polygon). */
  readonly polygonXZ: readonly Point2D[];
  readonly boundsXZ: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Clearance-inflated 2D polygon in world XZ used for pathfinding margin. */
  readonly expandedPolygonXZ: readonly Point2D[];
  readonly minY: number;
  readonly maxY: number;
  readonly center: Vec3;
  readonly clearanceM: number;
}

export interface FloorNavigationGrid {
  readonly cellSizeM: number;
  readonly cols: number;
  readonly rows: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly floorY: number;
  /** Flat row-major walkability mask (`1` = walkable, `0` = blocked by obstacle + clearance). */
  readonly walkable: Uint8Array;
  /** Flat row-major Core-connected component mask (`1` = reachable to Core on 2D floor, `0` = cut off). */
  readonly coreConnected: Uint8Array;
}

export interface NavigationWaypoint {
  readonly position: Vec3;
  readonly normal: Vec3;
  readonly tangent: Vec3;
  readonly locomotionMode: LocomotionMode;
  /** Cumulative arc length from path start (`0` at index 0, `totalLength` at final waypoint). */
  readonly cumulativeDistance: number;
  /** Exact remaining arc length along this path to the Core (`totalLength - cumulativeDistance`). */
  readonly distanceToCore: number;
}

export interface NavigationSegment {
  readonly index: number;
  readonly start: Vec3;
  readonly end: Vec3;
  readonly tangent: Vec3;
  readonly normal: Vec3;
  readonly startNormal: Vec3;
  readonly endNormal: Vec3;
  readonly locomotionMode: LocomotionMode;
  readonly length: number;
  readonly startDistance: number;
  readonly endDistance: number;
  readonly startDistanceToCore: number;
  readonly endDistanceToCore: number;
}

export interface NavigationPath {
  readonly id: string;
  readonly portalId: string;
  readonly layer: MovementLayer;
  readonly laneIndex: number;
  readonly waypoints: readonly NavigationWaypoint[];
  readonly segments: readonly NavigationSegment[];
  /** Cumulative arc-length table matching `waypoints` (`[0, ..., totalLength]`). */
  readonly cumulativeLengths: readonly number[];
  /** Remaining distance-to-core table matching `waypoints` (`[totalLength, ..., 0]`). */
  readonly distancesToCore: readonly number[];
  readonly totalLength: number;
  /** Walkable floor/surface landing position where the wall/ceiling descent spline touches down. */
  readonly landingPosition: Vec3;
  /** Waypoint index corresponding to `landingPosition`. */
  readonly landingWaypointIndex: number;
  /** Precomputed O(1) uniform arc-length bucket table mapping `s` -> starting segment index. */
  readonly arcSegmentLookup: readonly number[];
}

export interface PathSample {
  readonly position: Vec3;
  readonly tangent: Vec3;
  readonly normal: Vec3;
  readonly locomotionMode: LocomotionMode;
  readonly distanceToCore: number;
  readonly distanceAlongPath: number;
  readonly progress: number;
  readonly segmentIndex: number;
  readonly reachedCore: boolean;
}

export interface StuckRecoveryResult extends NavigationPath {
  /** `true` when a 3D leap bridge was required to escape an obstacle, out-of-bounds point, or split floor. */
  readonly usedLeap: boolean;
  /** The Core-connected floor waypoint where the recovery bridge lands before continuing to the Core. */
  readonly targetWaypoint: Vec3;
  /** Waypoints forming the initial recovery bridge from `pos` to `targetWaypoint`. */
  readonly bridgeWaypoints: readonly NavigationWaypoint[];
  /** Self-reference to the complete recovered `NavigationPath` for callers expecting `{ path }`. */
  readonly path: NavigationPath;
}

export interface DisruptorDetourOptions {
  /** EMP trigger radius of the Rift Disruptor in meters (default `1.2`). */
  readonly empRadiusM?: number;
  /** Desired closest approach distance to each visited turret in meters (default `0.35`). */
  readonly targetApproachDistanceM?: number;
  /** Maximum number of turret detours along a single flight path (default `3`). */
  readonly maxDetourTurrets?: number;
  /** Nominal flight altitude in meters above the floor (default `1.45`). */
  readonly flightAltitudeM?: number;
  /** Optional portal identifier tag for the returned path (default `'disruptor-detour'`). */
  readonly portalId?: string;
  /** Optional lane index tag for the returned path (default `0`). */
  readonly laneIndex?: number;
}

export interface BuildNavigationGraphInput {
  /** Room surfaces (floor, table/obstacle footprints, walls, ceiling). Omit if `roomModel` is provided. */
  readonly surfaces?: readonly NavSurfaceInput[];
  /** Optional `RoomSurfaceModel`-compatible container. */
  readonly roomModel?: {
    readonly surfaces: readonly NavSurfaceInput[];
    readonly revision?: number;
  };
  /** Core Bastion anchor or world position. */
  readonly coreAnchor: NavCoreAnchorInput | Readonly<Vec3>;
  /** Active or candidate wall/ceiling/virtual portal anchors. */
  readonly portalAnchors: readonly NavPortalAnchorInput[];
  /** Optional revision number override. */
  readonly revision?: number;
  /** 2D floor grid cell resolution in meters (default `0.12`). */
  readonly gridCellSizeM?: number;
  /** Collision clearance margin around furniture obstacle footprints in meters (default `0.2`). */
  readonly obstacleClearanceM?: number;
  /** Default nominal flight altitude above floor for aerial corridors in meters (default `1.35`). */
  readonly nominalFlightAltitudeM?: number;
  /** Vertical clearance above obstacles for aerial corridors in meters (default `0.35`). */
  readonly aerialClearanceM?: number;
  /** Lateral spacing between adjacent aerial flock lanes in meters (default `0.38`). */
  readonly aerialLaneSpacingM?: number;
  /** Precomputed aerial lane indices per portal (default `[-2, -1, 0, 1, 2]`). */
  readonly aerialLaneIndices?: readonly number[];
}

export interface RoomNavigationGraph {
  readonly revision: number;
  readonly floorY: number;
  readonly ceilingY: number;
  readonly roomBounds: {
    readonly min: Vec3;
    readonly max: Vec3;
  };
  readonly corePosition: Vec3;
  readonly coreRadius: number;
  readonly coreSurfaceId: string | null;
  readonly nominalFlightAltitudeM: number;
  readonly aerialClearanceM: number;
  readonly aerialLaneSpacingM: number;
  readonly obstacleClearanceM: number;
  readonly portals: readonly NavPortalAnchorInput[];
  readonly obstacles: readonly NavObstacle[];
  readonly grid: FloorNavigationGrid;
  /** Crawler surface path per portal ID. */
  readonly surfacePaths: Readonly<Record<string, NavigationPath>>;
  /** Default (lane 0) aerial flight path per portal ID. */
  readonly airPaths: Readonly<Record<string, NavigationPath>>;
  /** Precomputed lateral aerial lane paths per portal ID (`portalId -> Record<laneIndex, NavigationPath>`). */
  readonly airLanePaths: Readonly<Record<string, Readonly<Record<number, NavigationPath>>>>;
  getSurfacePath(portalId: string): NavigationPath | undefined;
  getAirPath(portalId: string, laneIndex?: number): NavigationPath | undefined;
  getPath(portalId: string, layer: MovementLayer, laneIndex?: number): NavigationPath | undefined;
  computeDisruptorPath(
    fromPos: Readonly<Vec3>,
    turretPositions: readonly (Readonly<Vec3> | { readonly position: Readonly<Vec3> })[],
    options?: DisruptorDetourOptions,
  ): NavigationPath;
  recoverCrawler(pos: Readonly<Vec3>): StuckRecoveryResult;
}

export const DEFAULT_GRID_CELL_SIZE_M = 0.12;
export const DEFAULT_OBSTACLE_CLEARANCE_M = 0.2;
export const DEFAULT_NOMINAL_FLIGHT_ALTITUDE_M = 1.35;
export const DEFAULT_DISRUPTOR_FLIGHT_ALTITUDE_M = 1.45;
export const DEFAULT_AERIAL_CLEARANCE_M = 0.35;
export const DEFAULT_AERIAL_LANE_SPACING_M = 0.38;
export const DEFAULT_AERIAL_LANE_INDICES: readonly number[] = [-2, -1, 0, 1, 2];
export const DEFAULT_DISRUPTOR_EMP_RADIUS_M = 1.2;

const ARC_LOOKUP_BUCKETS = 64;
const EPSILON = 1e-6;
const UP_NORMAL: Vec3 = Object.freeze({ x: 0, y: 1, z: 0 });
const DOWN_NORMAL: Vec3 = Object.freeze({ x: 0, y: -1, z: 0 });

// ============================================================================
// Pure Vector & 2D Polygon Geometry Helpers
// ============================================================================

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function cloneVec3(v: Readonly<Vec3>): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function coreShieldApproachPoint(
  from: Readonly<Vec3>,
  core: Readonly<Vec3>,
  airborne = false,
): Vec3 {
  const dx = from.x - core.x;
  const dy = airborne ? Math.max(0, from.y - core.y) : 0;
  const dz = from.z - core.z;
  const length = Math.hypot(dx, dy, dz);
  if (length <= EPSILON) return { x: core.x + CORE_SHIELD_RADIUS_M, y: core.y, z: core.z };
  const scale = CORE_SHIELD_RADIUS_M / length;
  return { x: core.x + dx * scale, y: core.y + dy * scale, z: core.z + dz * scale };
}

function finishCrawlerAtShield(
  specs: RawWaypointSpec[],
  core: Readonly<Vec3>,
  firstFloorIndex: number,
): void {
  // Route the terminal approach in from the Core's support elevation. The floor path
  // can approach under an elevated Core; trim any points already inside its footprint.
  let from = specs[firstFloorIndex]?.position ?? core;
  for (let index = specs.length - 2; index > firstFloorIndex; index -= 1) {
    const position = specs[index]?.position;
    if (!position || Math.hypot(position.x - core.x, position.z - core.z) <= CORE_SHIELD_RADIUS_M) {
      continue;
    }
    from = position;
    specs.length = index + 2;
    break;
  }
  specs[specs.length - 1] = {
    position: coreShieldApproachPoint(from, core),
    normal: UP_NORMAL,
    locomotionMode: 'floor',
  };
}

export function addVec3(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function subVec3(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scaleVec3(v: Readonly<Vec3>, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function lerpVec3(a: Readonly<Vec3>, b: Readonly<Vec3>, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

export function dotVec3(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function lengthVec3(v: Readonly<Vec3>): number {
  return Math.hypot(v.x, v.y, v.z);
}

export function distanceVec3(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function distanceXZ2D(a: Readonly<Point2D>, b: Readonly<Point2D>): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function normalizeVec3(v: Readonly<Vec3>, fallback: Readonly<Vec3> = UP_NORMAL): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < 1e-8) return cloneVec3(fallback);
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function extractCoreInfo(core: NavCoreAnchorInput | Readonly<Vec3>): {
  readonly position: Vec3;
  readonly radius: number;
  readonly surfaceId: string | null;
} {
  if ('position' in core) {
    return {
      position: cloneVec3(core.position),
      radius: core.radius ?? 0.38,
      surfaceId: core.surfaceId ?? null,
    };
  }
  return {
    position: cloneVec3(core),
    radius: 0.38,
    surfaceId: null,
  };
}

function cross2D(o: Readonly<Point2D>, a: Readonly<Point2D>, b: Readonly<Point2D>): number {
  return (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
}

/**
 * Computes the 2D convex hull of a point cloud in the XZ plane in counter-clockwise order.
 */
export function computeConvexHullXZ(points: readonly Readonly<Point2D>[]): Point2D[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => (a.x !== b.x ? a.x - b.x : a.z - b.z));
  const unique: Point2D[] = [];
  for (const p of sorted) {
    const prev = unique[unique.length - 1];
    if (!prev || Math.abs(p.x - prev.x) > 1e-5 || Math.abs(p.z - prev.z) > 1e-5) {
      unique.push({ x: p.x, z: p.z });
    }
  }
  if (unique.length < 3) return unique;

  const lower: Point2D[] = [];
  for (const p of unique) {
    while (lower.length >= 2) {
      const a = lower[lower.length - 2] as Point2D;
      const b = lower[lower.length - 1] as Point2D;
      if (cross2D(a, b, p) <= 1e-6) lower.pop();
      else break;
    }
    lower.push(p);
  }

  const upper: Point2D[] = [];
  for (let i = unique.length - 1; i >= 0; i -= 1) {
    const p = unique[i] as Point2D;
    while (upper.length >= 2) {
      const a = upper[upper.length - 2] as Point2D;
      const b = upper[upper.length - 1] as Point2D;
      if (cross2D(a, b, p) <= 1e-6) upper.pop();
      else break;
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/**
 * Expands a 2D convex polygon outward from its centroid/edge normals by `margin` meters.
 */
export function expandPolygonXZ(polygon: readonly Readonly<Point2D>[], margin: number): Point2D[] {
  if (polygon.length < 3 || margin <= 0) {
    return polygon.map((p) => ({ x: p.x, z: p.z }));
  }
  const hull = computeConvexHullXZ(polygon);
  if (hull.length < 3) return polygon.map((p) => ({ x: p.x, z: p.z }));

  let cx = 0;
  let cz = 0;
  for (const p of hull) {
    cx += p.x;
    cz += p.z;
  }
  cx /= hull.length;
  cz /= hull.length;

  const expandedSamples: Point2D[] = [];
  for (let i = 0; i < hull.length; i += 1) {
    const prev = hull[(i - 1 + hull.length) % hull.length] as Point2D;
    const curr = hull[i] as Point2D;
    const next = hull[(i + 1) % hull.length] as Point2D;

    const e1x = curr.x - prev.x;
    const e1z = curr.z - prev.z;
    const e1Len = Math.hypot(e1x, e1z) || 1;
    let n1x = e1z / e1Len;
    let n1z = -e1x / e1Len;
    if (n1x * (curr.x - cx) + n1z * (curr.z - cz) < 0) {
      n1x = -n1x;
      n1z = -n1z;
    }

    const e2x = next.x - curr.x;
    const e2z = next.z - curr.z;
    const e2Len = Math.hypot(e2x, e2z) || 1;
    let n2x = e2z / e2Len;
    let n2z = -e2x / e2Len;
    if (n2x * (curr.x - cx) + n2z * (curr.z - cz) < 0) {
      n2x = -n2x;
      n2z = -n2z;
    }

    expandedSamples.push({ x: curr.x + n1x * margin, z: curr.z + n1z * margin });
    expandedSamples.push({ x: curr.x + n2x * margin, z: curr.z + n2z * margin });

    const bx = n1x + n2x;
    const bz = n1z + n2z;
    const bLen = Math.hypot(bx, bz);
    if (bLen > 1e-5) {
      expandedSamples.push({
        x: curr.x + (bx / bLen) * margin * 1.15,
        z: curr.z + (bz / bLen) * margin * 1.15,
      });
    }
  }

  return computeConvexHullXZ(expandedSamples);
}

export function pointToSegmentDistanceSq2D(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): { readonly x: number; readonly z: number; readonly distSq: number } {
  const abx = bx - ax;
  const abz = bz - az;
  const lenSq = abx * abx + abz * abz;
  if (lenSq < 1e-12) {
    const dx = px - ax;
    const dz = pz - az;
    return { x: ax, z: az, distSq: dx * dx + dz * dz };
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / lenSq));
  const cx = ax + t * abx;
  const cz = az + t * abz;
  const dx = px - cx;
  const dz = pz - cz;
  return { x: cx, z: cz, distSq: dx * dx + dz * dz };
}

/**
 * Tests whether `(px, pz)` lies strictly inside or within `boundaryEps` of a 2D polygon in XZ.
 * Pass negative `boundaryEps` (e.g. `-1e-5`) to test strict interior only (excluding boundary).
 */
export function isPointInPolygon2D(
  px: number,
  pz: number,
  polygon: readonly Readonly<Point2D>[],
  boundaryEps = 1e-5,
): boolean {
  if (polygon.length < 3) return false;

  let minEdgeDistSq = Number.POSITIVE_INFINITY;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i] as Point2D;
    const pj = polygon[j] as Point2D;
    const seg = pointToSegmentDistanceSq2D(px, pz, pi.x, pi.z, pj.x, pj.z);
    if (seg.distSq < minEdgeDistSq) minEdgeDistSq = seg.distSq;

    const intersect =
      pi.z > pz !== pj.z > pz && px < ((pj.x - pi.x) * (pz - pi.z)) / (pj.z - pi.z) + pi.x;
    if (intersect) inside = !inside;
  }

  if (boundaryEps >= 0) {
    if (minEdgeDistSq <= boundaryEps * boundaryEps) return true;
    return inside;
  }

  const strictMarginSq = boundaryEps * boundaryEps;
  if (minEdgeDistSq <= strictMarginSq) return false;
  return inside;
}

/**
 * Computes signed distance from `(px, pz)` to a 2D polygon (`< 0` inside, `0` on edge, `> 0` outside).
 */
export function pointToPolygonSignedDistance2D(
  px: number,
  pz: number,
  polygon: readonly Readonly<Point2D>[],
): number {
  if (polygon.length === 0) return Number.POSITIVE_INFINITY;
  let minDistSq = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i] as Point2D;
    const b = polygon[(i + 1) % polygon.length] as Point2D;
    const d = pointToSegmentDistanceSq2D(px, pz, a.x, a.z, b.x, b.z).distSq;
    if (d < minDistSq) minDistSq = d;
  }
  const dist = Math.sqrt(minDistSq);
  return isPointInPolygon2D(px, pz, polygon, -1e-6) ? -dist : dist;
}

function orient2D(a: Readonly<Point2D>, b: Readonly<Point2D>, c: Readonly<Point2D>): number {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function onSegment2D(
  a: Readonly<Point2D>,
  b: Readonly<Point2D>,
  p: Readonly<Point2D>,
  eps = 1e-6,
): boolean {
  return (
    p.x >= Math.min(a.x, b.x) - eps &&
    p.x <= Math.max(a.x, b.x) + eps &&
    p.z >= Math.min(a.z, b.z) - eps &&
    p.z <= Math.max(a.z, b.z) + eps &&
    Math.abs(orient2D(a, b, p)) <= eps
  );
}

export function segmentsIntersect2D(
  a1: Readonly<Point2D>,
  a2: Readonly<Point2D>,
  b1: Readonly<Point2D>,
  b2: Readonly<Point2D>,
  properOnly = false,
): boolean {
  const o1 = orient2D(a1, a2, b1);
  const o2 = orient2D(a1, a2, b2);
  const o3 = orient2D(b1, b2, a1);
  const o4 = orient2D(b1, b2, a2);

  const eps = 1e-7;
  if (properOnly) {
    return (
      ((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) &&
      ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps))
    );
  }

  if (
    ((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) &&
    ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps))
  ) {
    return true;
  }

  if (onSegment2D(a1, a2, b1)) return true;
  if (onSegment2D(a1, a2, b2)) return true;
  if (onSegment2D(b1, b2, a1)) return true;
  if (onSegment2D(b1, b2, a2)) return true;
  return false;
}

export function segmentToSegmentDistance2D(
  a1: Readonly<Point2D>,
  a2: Readonly<Point2D>,
  b1: Readonly<Point2D>,
  b2: Readonly<Point2D>,
): number {
  if (segmentsIntersect2D(a1, a2, b1, b2, false)) return 0;
  const d1 = pointToSegmentDistanceSq2D(a1.x, a1.z, b1.x, b1.z, b2.x, b2.z).distSq;
  const d2 = pointToSegmentDistanceSq2D(a2.x, a2.z, b1.x, b1.z, b2.x, b2.z).distSq;
  const d3 = pointToSegmentDistanceSq2D(b1.x, b1.z, a1.x, a1.z, a2.x, a2.z).distSq;
  const d4 = pointToSegmentDistanceSq2D(b2.x, b2.z, a1.x, a1.z, a2.x, a2.z).distSq;
  return Math.sqrt(Math.min(d1, d2, d3, d4));
}

/**
 * Returns `true` if segment `p1 -> p2` enters the strict interior of `polygon`
 * (or passes within `clearanceM` of `polygon` when `clearanceM > 0`).
 */
export function segmentIntersectsPolygonInterior2D(
  p1: Readonly<Point2D>,
  p2: Readonly<Point2D>,
  polygon: readonly Readonly<Point2D>[],
  clearanceM = 0,
): boolean {
  if (polygon.length < 3) return false;

  // Test endpoints and interior sample points along segment p1 -> p2
  const samples = 8;
  for (let s = 0; s <= samples; s += 1) {
    const t = s / samples;
    const x = p1.x + (p2.x - p1.x) * t;
    const z = p1.z + (p2.z - p1.z) * t;
    if (clearanceM > 0) {
      if (pointToPolygonSignedDistance2D(x, z, polygon) < clearanceM - 1e-5) {
        return true;
      }
    } else if (isPointInPolygon2D(x, z, polygon, -1e-4)) {
      return true;
    }
  }

  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i] as Point2D;
    const b = polygon[(i + 1) % polygon.length] as Point2D;
    if (clearanceM > 0) {
      if (segmentToSegmentDistance2D(p1, p2, a, b) < clearanceM - 1e-5) {
        return true;
      }
    } else if (segmentsIntersect2D(p1, p2, a, b, true)) {
      return true;
    }
  }

  return false;
}

/**
 * Computes the minimum Euclidean distance in XZ between segment `p1 -> p2` and `polygon`
 * (`0` if the segment intersects or lies inside `polygon`).
 */
export function segmentToPolygonDistance2D(
  p1: Readonly<Point2D>,
  p2: Readonly<Point2D>,
  polygon: readonly Readonly<Point2D>[],
): number {
  if (polygon.length < 3) return Number.POSITIVE_INFINITY;
  if (segmentIntersectsPolygonInterior2D(p1, p2, polygon, 0)) return 0;

  let minDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i] as Point2D;
    const b = polygon[(i + 1) % polygon.length] as Point2D;
    const d = segmentToSegmentDistance2D(p1, p2, a, b);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

// ============================================================================
// Path Construction, Precomputed Arc-Length Tables & O(1) Sampling
// ============================================================================

interface RawWaypointSpec {
  readonly position: Vec3;
  readonly normal: Vec3;
  readonly locomotionMode: LocomotionMode;
}

function buildNavigationPathFromSpecs(params: {
  readonly id: string;
  readonly portalId: string;
  readonly layer: MovementLayer;
  readonly laneIndex: number;
  readonly specs: readonly RawWaypointSpec[];
  readonly landingSpecIndex: number;
}): NavigationPath {
  const { id, portalId, layer, laneIndex, specs, landingSpecIndex } = params;

  // Filter out degenerate duplicate points (< 1e-5 apart) so every segment has strictly positive length.
  const filtered: RawWaypointSpec[] = [];
  let mappedLandingIndex = 0;

  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i] as RawWaypointSpec;
    const prev = filtered[filtered.length - 1];
    if (!prev || distanceVec3(prev.position, spec.position) > 1e-5) {
      if (i <= landingSpecIndex) {
        mappedLandingIndex = filtered.length;
      }
      filtered.push({
        position: cloneVec3(spec.position),
        normal: normalizeVec3(spec.normal),
        locomotionMode: spec.locomotionMode,
      });
    } else if (i === landingSpecIndex) {
      mappedLandingIndex = filtered.length - 1;
    }
  }

  // Guarantee at least 2 distinct waypoints even for degenerate zero-length inputs.
  if (filtered.length === 0) {
    filtered.push(
      { position: { x: 0, y: 0, z: 0 }, normal: UP_NORMAL, locomotionMode: 'floor' },
      { position: { x: 0, y: 0, z: -0.01 }, normal: UP_NORMAL, locomotionMode: 'floor' },
    );
  } else if (filtered.length === 1) {
    const only = filtered[0] as RawWaypointSpec;
    filtered.push({
      position: { x: only.position.x, y: only.position.y, z: only.position.z - 0.01 },
      normal: only.normal,
      locomotionMode: only.locomotionMode,
    });
  }

  const cumulativeLengths: number[] = [0];
  let runningLength = 0;
  for (let i = 0; i + 1 < filtered.length; i += 1) {
    const a = filtered[i] as RawWaypointSpec;
    const b = filtered[i + 1] as RawWaypointSpec;
    const segLen = Math.max(1e-5, distanceVec3(a.position, b.position));
    runningLength += segLen;
    cumulativeLengths.push(runningLength);
  }

  const totalLength = runningLength;
  const distancesToCore = cumulativeLengths.map((d) => Math.max(0, totalLength - d));

  const segments: NavigationSegment[] = [];
  for (let i = 0; i + 1 < filtered.length; i += 1) {
    const a = filtered[i] as RawWaypointSpec;
    const b = filtered[i + 1] as RawWaypointSpec;
    const startDist = cumulativeLengths[i] ?? 0;
    const endDist = cumulativeLengths[i + 1] ?? totalLength;
    const segLen = Math.max(1e-5, endDist - startDist);
    const tangent = normalizeVec3(subVec3(b.position, a.position), { x: 0, y: 0, z: -1 });
    const startNormal = normalizeVec3(a.normal);
    const endNormal = normalizeVec3(b.normal);
    const midNormal = normalizeVec3(lerpVec3(startNormal, endNormal, 0.5), startNormal);

    segments.push({
      index: i,
      start: cloneVec3(a.position),
      end: cloneVec3(b.position),
      tangent,
      normal:
        startNormal.x === endNormal.x &&
        startNormal.y === endNormal.y &&
        startNormal.z === endNormal.z
          ? startNormal
          : midNormal,
      startNormal,
      endNormal,
      locomotionMode: a.locomotionMode,
      length: segLen,
      startDistance: startDist,
      endDistance: endDist,
      startDistanceToCore: Math.max(0, totalLength - startDist),
      endDistanceToCore: Math.max(0, totalLength - endDist),
    });
  }

  const waypoints: NavigationWaypoint[] = filtered.map((spec, idx) => {
    const seg =
      segments[Math.min(idx, segments.length - 1)] ??
      ({
        tangent: { x: 0, y: 0, z: -1 },
      } as NavigationSegment);
    return {
      position: cloneVec3(spec.position),
      normal: cloneVec3(spec.normal),
      tangent: cloneVec3(seg.tangent),
      locomotionMode: spec.locomotionMode,
      cumulativeDistance: cumulativeLengths[idx] ?? 0,
      distanceToCore: distancesToCore[idx] ?? 0,
    };
  });

  // Precompute O(1) uniform arc-length lookup table mapping bucket -> starting segment index.
  const arcSegmentLookup: number[] = new Array<number>(ARC_LOOKUP_BUCKETS + 1).fill(0);
  let segCursor = 0;
  for (let b = 0; b <= ARC_LOOKUP_BUCKETS; b += 1) {
    const targetS = (b / ARC_LOOKUP_BUCKETS) * totalLength;
    while (
      segCursor + 1 < segments.length &&
      (segments[segCursor]?.endDistance ?? 0) < targetS - 1e-7
    ) {
      segCursor += 1;
    }
    arcSegmentLookup[b] = segCursor;
  }

  const clampedLandingIndex = Math.max(0, Math.min(waypoints.length - 1, mappedLandingIndex));
  const landingPosition = cloneVec3(
    (waypoints[clampedLandingIndex] as NavigationWaypoint).position,
  );

  return {
    id,
    portalId,
    layer,
    laneIndex,
    waypoints,
    segments,
    cumulativeLengths,
    distancesToCore,
    totalLength,
    landingPosition,
    landingWaypointIndex: clampedLandingIndex,
    arcSegmentLookup,
  };
}

/**
 * Exact O(1) remaining path distance to the Core Bastion for turret `"First"` target priority.
 */
export function getDistanceToCore(path: NavigationPath, distanceAlongPath: number): number {
  const s = Number.isFinite(distanceAlongPath) ? distanceAlongPath : 0;
  const clampedS = Math.max(0, Math.min(path.totalLength, s));
  return Math.max(0, path.totalLength - clampedS);
}

/**
 * Samples a `NavigationPath` at traveled arc length `s` (`0 .. path.totalLength`) in O(1) time
 * via the precomputed arc-length lookup table, guaranteeing strictly monotonic `distanceToCore`.
 */
export function samplePathAtDistance(path: NavigationPath, s: number): PathSample {
  const safeS = Number.isFinite(s) ? s : 0;
  const total = path.totalLength;
  if (total <= EPSILON || path.segments.length === 0) {
    const first = path.waypoints[0];
    return {
      position: first ? cloneVec3(first.position) : { x: 0, y: 0, z: 0 },
      tangent: first ? cloneVec3(first.tangent) : { x: 0, y: 0, z: -1 },
      normal: first ? cloneVec3(first.normal) : cloneVec3(UP_NORMAL),
      locomotionMode: first ? first.locomotionMode : 'floor',
      distanceToCore: 0,
      distanceAlongPath: 0,
      progress: 1,
      segmentIndex: 0,
      reachedCore: true,
    };
  }

  const clampedS = Math.max(0, Math.min(total, safeS));
  const reachedCore = safeS >= total - EPSILON;
  const distanceToCore = reachedCore ? 0 : Math.max(0, total - clampedS);
  const progress = clampedS / total;

  // O(1) bucket lookup + local forward scan (typically 0 or 1 step).
  const bucket = Math.min(
    ARC_LOOKUP_BUCKETS,
    Math.max(0, Math.floor(progress * ARC_LOOKUP_BUCKETS)),
  );
  let segIndex = path.arcSegmentLookup[bucket] ?? 0;
  while (
    segIndex + 1 < path.segments.length &&
    (path.segments[segIndex]?.endDistance ?? 0) < clampedS - 1e-7
  ) {
    segIndex += 1;
  }
  while (segIndex > 0 && (path.segments[segIndex]?.startDistance ?? 0) > clampedS + 1e-7) {
    segIndex -= 1;
  }

  const seg = path.segments[segIndex] as NavigationSegment;
  const localT =
    seg.length > EPSILON
      ? Math.max(0, Math.min(1, (clampedS - seg.startDistance) / seg.length))
      : 0;

  const position = lerpVec3(seg.start, seg.end, localT);
  const normal = normalizeVec3(lerpVec3(seg.startNormal, seg.endNormal, localT), seg.normal);

  return {
    position,
    tangent: cloneVec3(seg.tangent),
    normal,
    locomotionMode: seg.locomotionMode,
    distanceToCore,
    distanceAlongPath: clampedS,
    progress,
    segmentIndex: segIndex,
    reachedCore,
  };
}

// ============================================================================
// Room Bounds, Obstacle Extraction & 2D Floor Navigation Grid
// ============================================================================

function computeRoomFloorAndBounds(
  surfaces: readonly NavSurfaceInput[],
  corePos: Readonly<Vec3>,
  portals: readonly NavPortalAnchorInput[],
): {
  readonly floorY: number;
  readonly ceilingY: number;
  readonly min: Vec3;
  readonly max: Vec3;
  readonly floorPolygonsXZ: readonly (readonly Point2D[])[];
} {
  const floors = surfaces.filter((s) => s.kind === 'floor');
  const ceilings = surfaces.filter((s) => s.kind === 'ceiling');

  let floorY = 0;
  if (floors.length > 0) {
    // Pick the lowest/primary floor plane elevation
    floorY = Math.min(...floors.map((f) => f.center.y));
  }

  let ceilingY = floorY + 2.8;
  if (ceilings.length > 0) {
    ceilingY = Math.max(...ceilings.map((c) => c.center.y));
  }

  const floorPolygonsXZ: Point2D[][] = [];
  for (const f of floors) {
    const hull = computeConvexHullXZ(f.polygon.map((p) => ({ x: p.x, z: p.z })));
    if (hull.length >= 3) {
      floorPolygonsXZ.push(hull);
    }
  }

  let minX = corePos.x - 1.5;
  let maxX = corePos.x + 1.5;
  let minY = Math.min(floorY, corePos.y);
  let maxY = Math.max(ceilingY, corePos.y + 2.2);
  let minZ = corePos.z - 1.5;
  let maxZ = corePos.z + 1.5;

  if (floorPolygonsXZ.length > 0) {
    minX = Number.POSITIVE_INFINITY;
    maxX = Number.NEGATIVE_INFINITY;
    minZ = Number.POSITIVE_INFINITY;
    maxZ = Number.NEGATIVE_INFINITY;
    for (const poly of floorPolygonsXZ) {
      for (const pt of poly) {
        if (pt.x < minX) minX = pt.x;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.z < minZ) minZ = pt.z;
        if (pt.z > maxZ) maxZ = pt.z;
      }
    }
    for (const surface of surfaces) {
      for (const pt of surface.polygon) {
        if (pt.y < minY) minY = pt.y;
        if (pt.y > maxY) maxY = pt.y;
      }
    }
  } else {
    for (const surface of surfaces) {
      for (const pt of surface.polygon) {
        if (pt.x < minX) minX = pt.x;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.y > maxY) maxY = pt.y;
        if (pt.z < minZ) minZ = pt.z;
        if (pt.z > maxZ) maxZ = pt.z;
      }
    }
    for (const portal of portals) {
      const p = portal.position;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
  }

  const padXZ = floorPolygonsXZ.length > 0 ? 0.02 : 0.5;

  return {
    floorY,
    ceilingY: Math.max(ceilingY, maxY),
    min: { x: minX - padXZ, y: minY, z: minZ - padXZ },
    max: { x: maxX + padXZ, y: Math.max(ceilingY, maxY), z: maxZ + padXZ },
    floorPolygonsXZ,
  };
}

function extractFloorObstacles(
  surfaces: readonly NavSurfaceInput[],
  floorY: number,
  corePos: Readonly<Vec3>,
  coreSurfaceId: string | null,
  clearanceM: number,
): NavObstacle[] {
  const obstacles: NavObstacle[] = [];

  for (const surface of surfaces) {
    if (surface.kind !== 'table' && surface.kind !== 'other') continue;
    if (surface.polygon.length < 3) continue;

    const rawPoints: Point2D[] = surface.polygon.map((p) => ({ x: p.x, z: p.z }));
    const polygonXZ = computeConvexHullXZ(rawPoints);
    if (polygonXZ.length < 3) continue;

    // If the Core Bastion itself is anchored on (or positioned inside) this table surface,
    // treat this surface as the Core's elevated platform rather than an impassable obstacle
    // blocking the goal point.
    if (surface.id === coreSurfaceId || isPointInPolygon2D(corePos.x, corePos.z, polygonXZ, 0.04)) {
      continue;
    }

    const minY = floorY;
    let maxY = surface.center.y;
    for (const pt of surface.polygon) {
      if (pt.y > maxY) maxY = pt.y;
    }
    if (surface.bounds) {
      maxY = Math.max(maxY, surface.bounds.max.y);
    }

    const expandedPolygonXZ = expandPolygonXZ(polygonXZ, clearanceM);
    const boundsXZ = {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minZ: Number.POSITIVE_INFINITY,
      maxZ: Number.NEGATIVE_INFINITY,
    };
    for (const { x, z } of polygonXZ) {
      boundsXZ.minX = Math.min(boundsXZ.minX, x);
      boundsXZ.maxX = Math.max(boundsXZ.maxX, x);
      boundsXZ.minZ = Math.min(boundsXZ.minZ, z);
      boundsXZ.maxZ = Math.max(boundsXZ.maxZ, z);
    }

    obstacles.push({
      id: `obstacle-${surface.id}`,
      surfaceId: surface.id,
      kind: surface.kind,
      polygonXZ,
      boundsXZ,
      expandedPolygonXZ,
      minY,
      maxY: Math.max(floorY + 0.35, maxY),
      center: cloneVec3(surface.center),
      clearanceM,
    });
  }

  return obstacles;
}

function isPointClearOfObstacles(
  x: number,
  z: number,
  obstacles: readonly NavObstacle[],
  marginM: number,
): boolean {
  const pad = Math.max(marginM, 1e-4);
  for (const obs of obstacles) {
    const { minX, maxX, minZ, maxZ } = obs.boundsXZ;
    if (x < minX - pad || x > maxX + pad || z < minZ - pad || z > maxZ + pad) continue;
    if (marginM <= 0) {
      if (isPointInPolygon2D(x, z, obs.polygonXZ, 1e-4)) return false;
    } else if (pointToPolygonSignedDistance2D(x, z, obs.polygonXZ) < marginM - 1e-5) {
      return false;
    }
  }
  return true;
}

function isSegmentClearOfObstacles(
  a: Readonly<Point2D>,
  b: Readonly<Point2D>,
  obstacles: readonly NavObstacle[],
  marginM: number,
): boolean {
  const segMinX = Math.min(a.x, b.x) - marginM;
  const segMaxX = Math.max(a.x, b.x) + marginM;
  const segMinZ = Math.min(a.z, b.z) - marginM;
  const segMaxZ = Math.max(a.z, b.z) + marginM;
  for (const obs of obstacles) {
    const { minX, maxX, minZ, maxZ } = obs.boundsXZ;
    if (segMaxX < minX || segMinX > maxX || segMaxZ < minZ || segMinZ > maxZ) continue;
    if (segmentIntersectsPolygonInterior2D(a, b, obs.polygonXZ, marginM)) {
      return false;
    }
  }
  return true;
}

function cellToWorldXZ(
  grid: Pick<FloorNavigationGrid, 'minX' | 'minZ' | 'cellSizeM'>,
  col: number,
  row: number,
): Point2D {
  return {
    x: grid.minX + (col + 0.5) * grid.cellSizeM,
    z: grid.minZ + (row + 0.5) * grid.cellSizeM,
  };
}

function worldToCell(
  grid: Pick<FloorNavigationGrid, 'minX' | 'minZ' | 'cellSizeM' | 'cols' | 'rows'>,
  x: number,
  z: number,
): { readonly col: number; readonly row: number } {
  const col = Math.max(0, Math.min(grid.cols - 1, Math.floor((x - grid.minX) / grid.cellSizeM)));
  const row = Math.max(0, Math.min(grid.rows - 1, Math.floor((z - grid.minZ) / grid.cellSizeM)));
  return { col, row };
}

function buildFloorNavigationGrid(params: {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly floorY: number;
  readonly cellSizeM: number;
  readonly obstacles: readonly NavObstacle[];
  readonly clearanceM: number;
  readonly corePos: Readonly<Vec3>;
}): FloorNavigationGrid {
  const { minX, maxX, minZ, maxZ, floorY, cellSizeM, obstacles, clearanceM, corePos } = params;
  const cols = Math.max(8, Math.ceil((maxX - minX) / cellSizeM));
  const rows = Math.max(8, Math.ceil((maxZ - minZ) / cellSizeM));
  const totalCells = cols * rows;

  const walkable = new Uint8Array(totalCells);
  const rawWalkable = new Uint8Array(totalCells);

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const idx = row * cols + col;
      const wx = minX + (col + 0.5) * cellSizeM;
      const wz = minZ + (row + 0.5) * cellSizeM;

      const rawClear = isPointClearOfObstacles(wx, wz, obstacles, 0.02);
      rawWalkable[idx] = rawClear ? 1 : 0;

      const clearanceClear = rawClear && isPointClearOfObstacles(wx, wz, obstacles, clearanceM);
      walkable[idx] = clearanceClear ? 1 : 0;
    }
  }

  // Flood-fill from the nearest walkable cell to `corePos` using rawWalkable (8-connected without
  // crossing obstacle polygon edges) so we know exactly which floor cells belong to the Core's
  // connected component when an obstacle splits the floor.
  const coreConnected = new Uint8Array(totalCells);
  const startCell = findNearestWalkableCell(
    { minX, minZ, cellSizeM, cols, rows },
    rawWalkable,
    corePos.x,
    corePos.z,
  );

  if (startCell) {
    const queue: number[] = [startCell.row * cols + startCell.col];
    coreConnected[startCell.row * cols + startCell.col] = 1;
    const dirs: ReadonlyArray<readonly [number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ];

    let head = 0;
    while (head < queue.length) {
      const curr = queue[head++] as number;
      const cRow = Math.floor(curr / cols);
      const cCol = curr - cRow * cols;
      const currPt = cellToWorldXZ({ minX, minZ, cellSizeM }, cCol, cRow);

      for (const [dc, dr] of dirs) {
        const nCol = cCol + dc;
        const nRow = cRow + dr;
        if (nCol < 0 || nCol >= cols || nRow < 0 || nRow >= rows) continue;
        const nIdx = nRow * cols + nCol;
        if (coreConnected[nIdx] === 1 || rawWalkable[nIdx] === 0) continue;

        const nextPt = cellToWorldXZ({ minX, minZ, cellSizeM }, nCol, nRow);
        if (!isSegmentClearOfObstacles(currPt, nextPt, obstacles, 0.01)) continue;

        coreConnected[nIdx] = 1;
        queue.push(nIdx);
      }
    }
  }

  return {
    cellSizeM,
    cols,
    rows,
    minX,
    maxX,
    minZ,
    maxZ,
    floorY,
    walkable,
    coreConnected,
  };
}

function findNearestWalkableCell(
  grid: Pick<FloorNavigationGrid, 'minX' | 'minZ' | 'cellSizeM' | 'cols' | 'rows'>,
  mask: Uint8Array,
  targetX: number,
  targetZ: number,
): { readonly col: number; readonly row: number } | null {
  const origin = worldToCell(grid, targetX, targetZ);
  if (mask[origin.row * grid.cols + origin.col] === 1) {
    return origin;
  }

  let bestCol = -1;
  let bestRow = -1;
  let bestDistSq = Number.POSITIVE_INFINITY;

  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.cols; col += 1) {
      if (mask[row * grid.cols + col] !== 1) continue;
      const pt = cellToWorldXZ(grid, col, row);
      const dx = pt.x - targetX;
      const dz = pt.z - targetZ;
      const dSq = dx * dx + dz * dz;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestCol = col;
        bestRow = row;
      }
    }
  }

  if (bestCol < 0) return null;
  return { col: bestCol, row: bestRow };
}

// ============================================================================
// Deterministic 2D Floor Pathfinding (Grid A* + String-Pulling + Visibility Graph)
// ============================================================================

function runGridAStar2D(
  grid: FloorNavigationGrid,
  startXZ: Readonly<Point2D>,
  goalXZ: Readonly<Point2D>,
  obstacles: readonly NavObstacle[],
  marginM: number,
): Point2D[] | null {
  const { cols, rows, minX, minZ, cellSizeM } = grid;
  const total = cols * rows;
  const mask = new Uint8Array(total);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const wx = minX + (c + 0.5) * cellSizeM;
      const wz = minZ + (r + 0.5) * cellSizeM;
      mask[r * cols + c] = isPointClearOfObstacles(wx, wz, obstacles, marginM) ? 1 : 0;
    }
  }

  const startCell = findNearestWalkableCell(grid, mask, startXZ.x, startXZ.z);
  const goalCell = findNearestWalkableCell(grid, mask, goalXZ.x, goalXZ.z);
  if (!startCell || !goalCell) return null;

  const startIdx = startCell.row * cols + startCell.col;
  const goalIdx = goalCell.row * cols + goalCell.col;

  // Verify the snapped start cell is reachable from startXZ without crossing an obstacle
  const startCellPt = cellToWorldXZ(grid, startCell.col, startCell.row);
  if (!isSegmentClearOfObstacles(startXZ, startCellPt, obstacles, 0)) {
    return null;
  }
  const goalCellPt = cellToWorldXZ(grid, goalCell.col, goalCell.row);
  if (!isSegmentClearOfObstacles(goalCellPt, goalXZ, obstacles, 0)) {
    return null;
  }

  const gScore = new Float64Array(total).fill(Number.POSITIVE_INFINITY);
  const fScore = new Float64Array(total).fill(Number.POSITIVE_INFINITY);
  const cameFrom = new Int32Array(total).fill(-1);
  const closed = new Uint8Array(total);
  const inOpen = new Uint8Array(total);

  const heuristic = (col: number, row: number): number => {
    const dx = Math.abs(col - goalCell.col);
    const dr = Math.abs(row - goalCell.row);
    const diag = Math.min(dx, dr);
    const straight = Math.max(dx, dr) - diag;
    return (diag * Math.SQRT2 + straight) * cellSizeM;
  };

  gScore[startIdx] = 0;
  fScore[startIdx] = heuristic(startCell.col, startCell.row);
  const openList: number[] = [startIdx];
  inOpen[startIdx] = 1;

  const neighbors: ReadonlyArray<readonly [number, number, number]> = [
    [1, 0, cellSizeM],
    [-1, 0, cellSizeM],
    [0, 1, cellSizeM],
    [0, -1, cellSizeM],
    [1, 1, cellSizeM * Math.SQRT2],
    [1, -1, cellSizeM * Math.SQRT2],
    [-1, 1, cellSizeM * Math.SQRT2],
    [-1, -1, cellSizeM * Math.SQRT2],
  ];

  while (openList.length > 0) {
    // Deterministic min selection (tie-breaking on fScore, then gScore, then cell index)
    let bestPos = 0;
    let bestNode = openList[0] as number;
    for (let i = 1; i < openList.length; i += 1) {
      const candidate = openList[i] as number;
      const fCand = fScore[candidate] ?? Number.POSITIVE_INFINITY;
      const fBest = fScore[bestNode] ?? Number.POSITIVE_INFINITY;
      if (fCand < fBest - 1e-9 || (Math.abs(fCand - fBest) <= 1e-9 && candidate < bestNode)) {
        bestPos = i;
        bestNode = candidate;
      }
    }

    openList.splice(bestPos, 1);
    inOpen[bestNode] = 0;

    if (bestNode === goalIdx) {
      const cellIndices: number[] = [];
      let curr = goalIdx;
      while (curr !== -1) {
        cellIndices.push(curr);
        if (curr === startIdx) break;
        curr = cameFrom[curr] ?? -1;
      }
      cellIndices.reverse();

      const rawPath: Point2D[] = [{ x: startXZ.x, z: startXZ.z }];
      for (const idx of cellIndices) {
        const r = Math.floor(idx / cols);
        const c = idx - r * cols;
        rawPath.push(cellToWorldXZ(grid, c, r));
      }
      rawPath.push({ x: goalXZ.x, z: goalXZ.z });
      return rawPath;
    }

    closed[bestNode] = 1;
    const cRow = Math.floor(bestNode / cols);
    const cCol = bestNode - cRow * cols;
    const currPt = cellToWorldXZ(grid, cCol, cRow);

    for (const [dc, dr, stepCost] of neighbors) {
      const nCol = cCol + dc;
      const nRow = cRow + dr;
      if (nCol < 0 || nCol >= cols || nRow < 0 || nRow >= rows) continue;
      const nIdx = nRow * cols + nCol;
      if (closed[nIdx] === 1 || mask[nIdx] === 0) continue;

      // Prevent diagonal corner cutting across blocked orthogonal neighbors or obstacle edges
      if (dc !== 0 && dr !== 0) {
        if (mask[cRow * cols + nCol] === 0 || mask[nRow * cols + cCol] === 0) {
          continue;
        }
      }

      const nextPt = cellToWorldXZ(grid, nCol, nRow);
      if (!isSegmentClearOfObstacles(currPt, nextPt, obstacles, marginM * 0.85)) {
        continue;
      }

      const tentativeG = (gScore[bestNode] ?? 0) + stepCost;
      if (tentativeG + 1e-9 < (gScore[nIdx] ?? Number.POSITIVE_INFINITY)) {
        cameFrom[nIdx] = bestNode;
        gScore[nIdx] = tentativeG;
        fScore[nIdx] = tentativeG + heuristic(nCol, nRow);
        if (inOpen[nIdx] === 0) {
          openList.push(nIdx);
          inOpen[nIdx] = 1;
        }
      }
    }
  }

  return null;
}

/**
 * Continuous 2D Visibility Graph shortest path around inflated obstacle vertices.
 * Guarantees an exact obstacle-free path even through narrow diagonal gaps between furniture.
 */
function runVisibilityGraph2D(
  startXZ: Readonly<Point2D>,
  goalXZ: Readonly<Point2D>,
  obstacles: readonly NavObstacle[],
  marginM: number,
  bounds: Pick<FloorNavigationGrid, 'minX' | 'maxX' | 'minZ' | 'maxZ'>,
): Point2D[] | null {
  if (isSegmentClearOfObstacles(startXZ, goalXZ, obstacles, marginM)) {
    return [
      { x: startXZ.x, z: startXZ.z },
      { x: goalXZ.x, z: goalXZ.z },
    ];
  }

  const nodes: Point2D[] = [
    { x: startXZ.x, z: startXZ.z },
    { x: goalXZ.x, z: goalXZ.z },
  ];

  const vertexExpansion = Math.max(0.05, marginM + 0.04);
  for (const obs of obstacles) {
    const ring = expandPolygonXZ(obs.polygonXZ, vertexExpansion);
    for (const v of ring) {
      if (
        v.x >= bounds.minX + 0.04 &&
        v.x <= bounds.maxX - 0.04 &&
        v.z >= bounds.minZ + 0.04 &&
        v.z <= bounds.maxZ - 0.04 &&
        isPointClearOfObstacles(v.x, v.z, obstacles, marginM * 0.9)
      ) {
        nodes.push(v);
      }
    }
  }

  const n = nodes.length;
  const dist = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  const prev = new Int32Array(n).fill(-1);
  const visited = new Uint8Array(n);
  dist[0] = 0;

  for (let step = 0; step < n; step += 1) {
    let u = -1;
    let bestD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i += 1) {
      if (visited[i] === 0 && (dist[i] ?? Number.POSITIVE_INFINITY) < bestD) {
        bestD = dist[i] ?? Number.POSITIVE_INFINITY;
        u = i;
      }
    }
    if (u === -1 || u === 1) break;
    visited[u] = 1;

    const uPt = nodes[u] as Point2D;
    for (let v = 0; v < n; v += 1) {
      if (visited[v] === 1 || v === u) continue;
      const vPt = nodes[v] as Point2D;
      if (!isSegmentClearOfObstacles(uPt, vPt, obstacles, marginM * 0.85)) continue;
      const alt = bestD + distanceXZ2D(uPt, vPt);
      if (alt + 1e-9 < (dist[v] ?? Number.POSITIVE_INFINITY)) {
        dist[v] = alt;
        prev[v] = u;
      }
    }
  }

  if (!Number.isFinite(dist[1] ?? Number.POSITIVE_INFINITY)) {
    return null;
  }

  const result: Point2D[] = [];
  let curr = 1;
  while (curr !== -1) {
    result.push(nodes[curr] as Point2D);
    if (curr === 0) break;
    curr = prev[curr] ?? -1;
  }
  result.reverse();
  return result;
}

/**
 * String-pulls a 2D floor path and applies clearance-verified corner rounding so crawlers
 * turn smoothly around table footprints with zero obstacle interior intersections.
 */
function smoothFloorPath2D(
  rawPoints: readonly Readonly<Point2D>[],
  obstacles: readonly NavObstacle[],
  marginM: number,
): Point2D[] {
  if (rawPoints.length <= 2) {
    return rawPoints.map((p) => ({ x: p.x, z: p.z }));
  }

  // 1. Greedy line-of-sight string pulling
  const pulled: Point2D[] = [{ x: (rawPoints[0] as Point2D).x, z: (rawPoints[0] as Point2D).z }];
  let i = 0;
  while (i < rawPoints.length - 1) {
    let furthest = i + 1;
    const anchor = rawPoints[i] as Point2D;
    for (let j = rawPoints.length - 1; j > i + 1; j -= 1) {
      const candidate = rawPoints[j] as Point2D;
      if (isSegmentClearOfObstacles(anchor, candidate, obstacles, marginM)) {
        furthest = j;
        break;
      }
    }
    const chosen = rawPoints[furthest] as Point2D;
    pulled.push({ x: chosen.x, z: chosen.z });
    i = furthest;
  }

  if (pulled.length <= 2) return pulled;

  // 2. Corner beveling (Chaikin-style corner rounding) where each bevel chord stays clear of obstacles
  const rounded: Point2D[] = [pulled[0] as Point2D];
  for (let k = 1; k < pulled.length - 1; k += 1) {
    const prev = rounded[rounded.length - 1] as Point2D;
    const curr = pulled[k] as Point2D;
    const next = pulled[k + 1] as Point2D;

    const d1 = distanceXZ2D(prev, curr);
    const d2 = distanceXZ2D(curr, next);
    const cut = Math.min(0.18, d1 * 0.3, d2 * 0.3);

    if (cut > 0.04) {
      const pA: Point2D = {
        x: curr.x + ((prev.x - curr.x) / d1) * cut,
        z: curr.z + ((prev.z - curr.z) / d1) * cut,
      };
      const pB: Point2D = {
        x: curr.x + ((next.x - curr.x) / d2) * cut,
        z: curr.z + ((next.z - curr.z) / d2) * cut,
      };
      if (
        isSegmentClearOfObstacles(prev, pA, obstacles, marginM * 0.9) &&
        isSegmentClearOfObstacles(pA, pB, obstacles, marginM * 0.9) &&
        isSegmentClearOfObstacles(pB, next, obstacles, marginM * 0.9)
      ) {
        rounded.push(pA, pB);
        continue;
      }
    }
    rounded.push(curr);
  }
  rounded.push(pulled[pulled.length - 1] as Point2D);

  return rounded;
}

/**
 * Finds a deterministic obstacle-avoiding 2D path on the floor plane from `startXZ` to `goalXZ`.
 * Returns `null` only if the floor is completely split by an obstacle from wall to wall.
 */
function findCollisionFreeFloorPath2D(
  grid: FloorNavigationGrid,
  startXZ: Readonly<Point2D>,
  goalXZ: Readonly<Point2D>,
  obstacles: readonly NavObstacle[],
  preferredClearanceM: number,
): Point2D[] | null {
  if (
    startXZ.x < grid.minX ||
    startXZ.x > grid.maxX ||
    startXZ.z < grid.minZ ||
    startXZ.z > grid.maxZ
  ) {
    return null;
  }
  if (isSegmentClearOfObstacles(startXZ, goalXZ, obstacles, preferredClearanceM)) {
    return [
      { x: startXZ.x, z: startXZ.z },
      { x: goalXZ.x, z: goalXZ.z },
    ];
  }

  const clearanceTiers = [preferredClearanceM, preferredClearanceM * 0.6, 0.06, 0.02, 0.005];

  for (const margin of clearanceTiers) {
    const astarPath = runGridAStar2D(grid, startXZ, goalXZ, obstacles, margin);
    if (astarPath) {
      const smoothed = smoothFloorPath2D(astarPath, obstacles, margin * 0.9);
      if (verifyPathClearOfObstacleInteriors2D(smoothed, obstacles)) {
        return smoothed;
      }
    }

    const visPath = runVisibilityGraph2D(startXZ, goalXZ, obstacles, margin, grid);
    if (visPath) {
      const smoothed = smoothFloorPath2D(visPath, obstacles, margin * 0.9);
      if (verifyPathClearOfObstacleInteriors2D(smoothed, obstacles)) {
        return smoothed;
      }
    }
  }

  return null;
}

function verifyPathClearOfObstacleInteriors2D(
  points: readonly Readonly<Point2D>[],
  obstacles: readonly NavObstacle[],
): boolean {
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i] as Point2D;
    const b = points[i + 1] as Point2D;
    if (!isSegmentClearOfObstacles(a, b, obstacles, 0)) {
      return false;
    }
  }
  return true;
}

// ============================================================================
// Portal Landing Node Selection & Wall/Ceiling Descent Splines
// ============================================================================

function selectPortalLandingXZ(
  portal: NavPortalAnchorInput,
  corePos: Readonly<Vec3>,
  grid: FloorNavigationGrid,
  obstacles: readonly NavObstacle[],
  clearanceM: number,
): Point2D {
  const p = portal.position;
  const hostKind = portal.hostKind ?? (portal.normal.y < -0.5 ? 'ceiling' : 'wall');

  // Horizontal direction inward from portal toward Core
  const toCoreX = corePos.x - p.x;
  const toCoreZ = corePos.z - p.z;
  const toCoreLen = Math.hypot(toCoreX, toCoreZ) || 1;
  const dirToCoreX = toCoreX / toCoreLen;
  const dirToCoreZ = toCoreZ / toCoreLen;

  const horizNormalLen = Math.hypot(portal.normal.x, portal.normal.z);
  const inwardX = horizNormalLen > 0.2 ? portal.normal.x / horizNormalLen : dirToCoreX;
  const inwardZ = horizNormalLen > 0.2 ? portal.normal.z / horizNormalLen : dirToCoreZ;
  const rightX = -inwardZ;
  const rightZ = inwardX;

  const portalXZ: Point2D = { x: p.x, z: p.z };
  const portalOverObstacle = !isPointClearOfObstacles(p.x, p.z, obstacles, 0.02);

  const forwardDistances =
    hostKind === 'ceiling'
      ? [0.25, 0.4, 0.55, 0.75, 0.95, 1.2]
      : [0.28, 0.42, 0.58, 0.75, 0.95, 1.15];
  const lateralOffsets = [0, -0.3, 0.3, -0.6, 0.6, -0.95, 0.95, -1.3, 1.3];

  let bestCandidate: Point2D | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const fwd of forwardDistances) {
    for (const lat of lateralOffsets) {
      const cx = Math.max(
        grid.minX + 0.12,
        Math.min(grid.maxX - 0.12, p.x + inwardX * fwd + rightX * lat),
      );
      const cz = Math.max(
        grid.minZ + 0.12,
        Math.min(grid.maxZ - 0.12, p.z + inwardZ * fwd + rightZ * lat),
      );

      if (!isPointClearOfObstacles(cx, cz, obstacles, clearanceM)) continue;

      const candidate: Point2D = { x: cx, z: cz };
      if (!portalOverObstacle && !isSegmentClearOfObstacles(portalXZ, candidate, obstacles, 0.02)) {
        continue;
      }

      const cell = worldToCell(grid, cx, cz);
      const connectedBonus = grid.coreConnected[cell.row * grid.cols + cell.col] === 1 ? 0 : 25;
      const distToCore = Math.hypot(cx - corePos.x, cz - corePos.z);
      const score = connectedBonus + Math.abs(lat) * 1.4 + fwd * 0.8 + distToCore * 0.25;
      if (score < bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }
  }

  if (bestCandidate) return bestCandidate;

  // Fallback: nearest Core-connected walkable cell in the grid
  const fallbackCell =
    findNearestWalkableCell(grid, grid.coreConnected, p.x + inwardX * 0.35, p.z + inwardZ * 0.35) ??
    findNearestWalkableCell(grid, grid.walkable, p.x + inwardX * 0.35, p.z + inwardZ * 0.35);

  if (fallbackCell) {
    return cellToWorldXZ(grid, fallbackCell.col, fallbackCell.row);
  }

  return {
    x: p.x + inwardX * 0.35,
    z: p.z + inwardZ * 0.35,
  };
}

/**
 * Generates the smooth wall/ceiling-to-floor descent spline waypoints (`'climb'` -> `'drop'` -> `'floor'`).
 */
function buildPortalDescentSpecs(
  portal: NavPortalAnchorInput,
  landingXZ: Readonly<Point2D>,
  floorY: number,
  ceilingY: number,
  obstacles: readonly NavObstacle[],
): RawWaypointSpec[] {
  const p0 = cloneVec3(portal.position);
  const hostKind = portal.hostKind ?? (portal.normal.y < -0.5 ? 'ceiling' : 'wall');
  const specs: RawWaypointSpec[] = [];

  if (hostKind === 'ceiling' || portal.normal.y < -0.5) {
    // Ceiling portal descent:
    // 1. Emerge on ceiling and skitter along ceiling plane (`'climb'`, normal `(0, -1, 0)`)
    //    to clear any obstacle directly beneath the aperture before dropping.
    const ceilingNormal = DOWN_NORMAL;
    const dx = landingXZ.x - p0.x;
    const dz = landingXZ.z - p0.z;
    const horizDist = Math.hypot(dx, dz);

    const crawlRatio = horizDist > 0.05 ? Math.min(0.55, 0.35 / horizDist) : 0.4;
    const detachPoint: Vec3 = {
      x: p0.x + dx * crawlRatio,
      y: Math.max(p0.y - 0.04, ceilingY - 0.06),
      z: p0.z + dz * crawlRatio,
    };

    specs.push({
      position: p0,
      normal: ceilingNormal,
      locomotionMode: 'climb',
    });

    specs.push({
      position: detachPoint,
      normal: ceilingNormal,
      locomotionMode: 'climb',
    });

    // 2. Smooth 3D cubic drop spline (`'drop'`) down onto `landingXZ` at `floorY`
    const dropDirectionNormal = normalizeVec3({ x: dx, y: 0.35, z: dz }, UP_NORMAL);
    const dropSteps = 4;
    for (let step = 1; step < dropSteps; step += 1) {
      const t = step / dropSteps;
      // Smooth S-curve in horizontal and vertical descent
      const hBlend = t * t * (3 - 2 * t);
      const vBlend = t * t;
      const pos: Vec3 = {
        x: detachPoint.x + (landingXZ.x - detachPoint.x) * hBlend,
        y: detachPoint.y + (floorY - detachPoint.y) * vBlend,
        z: detachPoint.z + (landingXZ.z - detachPoint.z) * hBlend,
      };
      const blendedNormal = normalizeVec3(lerpVec3(dropDirectionNormal, UP_NORMAL, t), UP_NORMAL);
      specs.push({
        position: pos,
        normal: blendedNormal,
        locomotionMode: 'drop',
      });
    }

    // 3. Touchdown on walkable floor (`'floor'`, normal `(0, 1, 0)`)
    specs.push({
      position: { x: landingXZ.x, y: floorY, z: landingXZ.z },
      normal: UP_NORMAL,
      locomotionMode: 'floor',
    });

    return specs;
  }

  // Wall or Virtual-Rift portal descent:
  const wallNormal = normalizeVec3(
    { x: portal.normal.x, y: 0, z: portal.normal.z },
    { x: 0, y: 0, z: 1 },
  );
  const verticalSpan = Math.max(0.2, p0.y - floorY);
  const dismountHeight = Math.min(0.32, verticalSpan * 0.3);
  const dismountY = floorY + dismountHeight;

  // Check if straight line in XZ from p0 to landingXZ is obstacle-free; if so we keep climb points
  // tightly against the wall before curving out to landingXZ.
  const directClear = isSegmentClearOfObstacles({ x: p0.x, z: p0.z }, landingXZ, obstacles, 0);
  const wallBaseX = directClear ? p0.x + (landingXZ.x - p0.x) * 0.2 : landingXZ.x;
  const wallBaseZ = directClear ? p0.z + (landingXZ.z - p0.z) * 0.2 : landingXZ.z;

  // 1. Climb down the wall face (`'climb'`, normal = wallNormal)
  specs.push({
    position: p0,
    normal: wallNormal,
    locomotionMode: 'climb',
  });

  const midWallY = floorY + (p0.y - floorY) * 0.55;
  specs.push({
    position: {
      x: p0.x + (wallBaseX - p0.x) * 0.5,
      y: midWallY,
      z: p0.z + (wallBaseZ - p0.z) * 0.5,
    },
    normal: wallNormal,
    locomotionMode: 'climb',
  });

  specs.push({
    position: {
      x: wallBaseX,
      y: dismountY,
      z: wallBaseZ,
    },
    normal: normalizeVec3(lerpVec3(wallNormal, UP_NORMAL, 0.25), wallNormal),
    locomotionMode: 'climb',
  });

  // 2. Smooth baseboard dismount / drop arc onto the floor (`'drop'`)
  specs.push({
    position: {
      x: wallBaseX + (landingXZ.x - wallBaseX) * 0.55,
      y: floorY + dismountHeight * 0.35,
      z: wallBaseZ + (landingXZ.z - wallBaseZ) * 0.55,
    },
    normal: normalizeVec3(lerpVec3(wallNormal, UP_NORMAL, 0.65), UP_NORMAL),
    locomotionMode: 'drop',
  });

  // 3. Touchdown on walkable floor (`'floor'`, normal `(0, 1, 0)`)
  specs.push({
    position: { x: landingXZ.x, y: floorY, z: landingXZ.z },
    normal: UP_NORMAL,
    locomotionMode: 'floor',
  });

  return specs;
}

function buildLeapBridgeSpecs(
  fromPos: Readonly<Vec3>,
  toFloorPos: Readonly<Vec3>,
  obstacles: readonly NavObstacle[],
): RawWaypointSpec[] {
  let maxObstacleY = Math.max(fromPos.y, toFloorPos.y);
  for (const obs of obstacles) {
    if (
      segmentIntersectsPolygonInterior2D(
        { x: fromPos.x, z: fromPos.z },
        { x: toFloorPos.x, z: toFloorPos.z },
        obs.expandedPolygonXZ,
        0,
      )
    ) {
      maxObstacleY = Math.max(maxObstacleY, obs.maxY);
    }
  }

  const apexY = maxObstacleY + 0.32;
  const specs: RawWaypointSpec[] = [];
  const steps = 4;
  for (let i = 0; i < steps; i += 1) {
    const t = i / steps;
    const parabola = 4 * t * (1 - t);
    const baseLinearY = fromPos.y + (toFloorPos.y - fromPos.y) * t;
    const y = baseLinearY + Math.max(0.25, apexY - baseLinearY) * parabola;
    specs.push({
      position: {
        x: fromPos.x + (toFloorPos.x - fromPos.x) * t,
        y,
        z: fromPos.z + (toFloorPos.z - fromPos.z) * t,
      },
      normal: UP_NORMAL,
      locomotionMode: 'drop',
    });
  }

  specs.push({
    position: cloneVec3(toFloorPos),
    normal: UP_NORMAL,
    locomotionMode: 'floor',
  });

  return specs;
}

function findBestCoreConnectedFloorTarget(
  fromXZ: Readonly<Point2D>,
  corePos: Readonly<Vec3>,
  grid: FloorNavigationGrid,
  obstacles: readonly NavObstacle[],
  clearanceM: number,
): Point2D {
  let bestPt: Point2D | null = null;
  let bestMetric = Number.POSITIVE_INFINITY;

  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.cols; col += 1) {
      const idx = row * grid.cols + col;
      if (grid.coreConnected[idx] !== 1) continue;
      const pt = cellToWorldXZ(grid, col, row);
      if (!isPointClearOfObstacles(pt.x, pt.z, obstacles, clearanceM * 0.75)) continue;

      const dFrom = Math.hypot(pt.x - fromXZ.x, pt.z - fromXZ.z);
      const dCore = Math.hypot(pt.x - corePos.x, pt.z - corePos.z);
      const metric = dFrom * 1.15 + dCore * 0.45;
      if (metric < bestMetric) {
        bestMetric = metric;
        bestPt = pt;
      }
    }
  }

  if (bestPt) return bestPt;
  return { x: corePos.x, z: corePos.z };
}

function buildCrawlerSurfacePath(params: {
  readonly portal: NavPortalAnchorInput;
  readonly corePos: Readonly<Vec3>;
  readonly grid: FloorNavigationGrid;
  readonly obstacles: readonly NavObstacle[];
  readonly ceilingY: number;
  readonly clearanceM: number;
}): NavigationPath {
  const { portal, corePos, grid, obstacles, ceilingY, clearanceM } = params;
  const floorY = grid.floorY;
  const coreXZ: Point2D = { x: corePos.x, z: corePos.z };

  const landingXZ = selectPortalLandingXZ(portal, corePos, grid, obstacles, clearanceM);
  const descentSpecs = buildPortalDescentSpecs(portal, landingXZ, floorY, ceilingY, obstacles);
  const landingSpecIndex = descentSpecs.length - 1;

  const floorWaypointsXZ = findCollisionFreeFloorPath2D(
    grid,
    landingXZ,
    coreXZ,
    obstacles,
    clearanceM,
  );

  const allSpecs: RawWaypointSpec[] = [...descentSpecs];

  if (floorWaypointsXZ && floorWaypointsXZ.length >= 2) {
    for (let i = 1; i < floorWaypointsXZ.length; i += 1) {
      const wp = floorWaypointsXZ[i] as Point2D;
      allSpecs.push({
        position: { x: wp.x, y: floorY, z: wp.z },
        normal: UP_NORMAL,
        locomotionMode: 'floor',
      });
    }
  } else {
    // Floor is completely split by a wall-to-wall furniture obstacle: bridge across the obstacle
    // to the nearest Core-connected floor node and continue along the floor to the Core.
    const bridgeTargetXZ = findBestCoreConnectedFloorTarget(
      landingXZ,
      corePos,
      grid,
      obstacles,
      clearanceM,
    );
    const bridgeSpecs = buildLeapBridgeSpecs(
      { x: landingXZ.x, y: floorY, z: landingXZ.z },
      { x: bridgeTargetXZ.x, y: floorY, z: bridgeTargetXZ.z },
      obstacles,
    );
    for (let i = 1; i < bridgeSpecs.length; i += 1) {
      allSpecs.push(bridgeSpecs[i] as RawWaypointSpec);
    }
    const tailFloorXZ = findCollisionFreeFloorPath2D(
      grid,
      bridgeTargetXZ,
      coreXZ,
      obstacles,
      clearanceM * 0.5,
    ) ?? [bridgeTargetXZ, coreXZ];
    for (let i = 1; i < tailFloorXZ.length; i += 1) {
      const wp = tailFloorXZ[i] as Point2D;
      allSpecs.push({
        position: { x: wp.x, y: floorY, z: wp.z },
        normal: UP_NORMAL,
        locomotionMode: 'floor',
      });
    }
  }

  finishCrawlerAtShield(allSpecs, corePos, landingSpecIndex);

  return buildNavigationPathFromSpecs({
    id: `surface-${portal.id}`,
    portalId: portal.id,
    layer: 'surface',
    laneIndex: 0,
    specs: allSpecs,
    landingSpecIndex,
  });
}

// ============================================================================
// Aerial Corridor Layer (`air`) & Lateral Flock Lane Separation
// ============================================================================

function computeSafeAerialAltitudeAtXZ(
  x: number,
  z: number,
  baseCruiseY: number,
  ceilingY: number,
  obstacles: readonly NavObstacle[],
  aerialClearanceM: number,
): number {
  let y = baseCruiseY;
  for (const obs of obstacles) {
    if (isPointInPolygon2D(x, z, obs.expandedPolygonXZ, 0.15)) {
      y = Math.max(y, obs.maxY + aerialClearanceM);
    }
  }
  return Math.min(ceilingY - 0.18, y);
}

function buildAerialCorridorPath(params: {
  readonly portal: NavPortalAnchorInput;
  readonly corePos: Readonly<Vec3>;
  readonly laneIndex: number;
  readonly laneSpacingM: number;
  readonly floorY: number;
  readonly ceilingY: number;
  readonly roomBounds: { readonly min: Vec3; readonly max: Vec3 };
  readonly obstacles: readonly NavObstacle[];
  readonly nominalFlightAltitudeM: number;
  readonly aerialClearanceM: number;
}): NavigationPath {
  const {
    portal,
    corePos,
    laneIndex,
    laneSpacingM,
    floorY,
    ceilingY,
    roomBounds,
    obstacles,
    nominalFlightAltitudeM,
    aerialClearanceM,
  } = params;

  const startPos = cloneVec3(portal.position);
  const endPos = coreShieldApproachPoint(startPos, corePos, true);

  const dx = endPos.x - startPos.x;
  const dz = endPos.z - startPos.z;
  const horizLen = Math.hypot(dx, dz) || 1;
  const dirX = dx / horizLen;
  const dirZ = dz / horizLen;
  // Perpendicular horizontal right vector for lateral lane separation
  const rightX = dirZ;
  const rightZ = -dirX;

  const lateralOffsetM = laneIndex * laneSpacingM;
  const baseCruiseY = Math.min(
    ceilingY - 0.22,
    Math.max(floorY + nominalFlightAltitudeM, corePos.y + 0.45),
  );

  // Also ensure the corridor clears the tallest obstacle intersected along its centerline
  let corridorCruiseY = baseCruiseY;
  for (const obs of obstacles) {
    if (
      segmentIntersectsPolygonInterior2D(
        { x: startPos.x, z: startPos.z },
        { x: endPos.x, z: endPos.z },
        obs.expandedPolygonXZ,
        Math.abs(lateralOffsetM) + 0.25,
      )
    ) {
      corridorCruiseY = Math.min(
        ceilingY - 0.18,
        Math.max(corridorCruiseY, obs.maxY + aerialClearanceM),
      );
    }
  }

  const numSteps = 8;
  const specs: RawWaypointSpec[] = [];
  const wallPad = 0.18;

  for (let i = 0; i <= numSteps; i += 1) {
    const t = i / numSteps;
    // Lateral envelope peaks across the middle of the room so distinct lanes stay clearly separated,
    // while starting at the portal aperture and converging smoothly onto the Core.
    const lateralEnvelope = i === 0 || i === numSteps ? 0 : Math.sin(Math.PI * t);
    const rawX = startPos.x + dx * t + rightX * lateralOffsetM * lateralEnvelope;
    const rawZ = startPos.z + dz * t + rightZ * lateralOffsetM * lateralEnvelope;

    const x =
      i === 0 || i === numSteps
        ? rawX
        : Math.max(roomBounds.min.x + wallPad, Math.min(roomBounds.max.x - wallPad, rawX));
    const z =
      i === 0 || i === numSteps
        ? rawZ
        : Math.max(roomBounds.min.z + wallPad, Math.min(roomBounds.max.z - wallPad, rawZ));

    let y: number;
    if (i === 0) {
      y = startPos.y;
    } else if (i === numSteps) {
      y = endPos.y;
    } else {
      const localSafeCruise = computeSafeAerialAltitudeAtXZ(
        x,
        z,
        corridorCruiseY,
        ceilingY,
        obstacles,
        aerialClearanceM,
      );
      const linearY = startPos.y + (endPos.y - startPos.y) * t;
      const cruiseBlend = Math.sin(Math.PI * t);
      y = linearY * (1 - cruiseBlend) + localSafeCruise * cruiseBlend;
      // Add subtle vertical staggering by laneIndex so lanes separate in 3D as well as XZ
      const laneAltOffset = Math.max(-0.18, Math.min(0.18, laneIndex * 0.04)) * cruiseBlend;
      y = Math.min(ceilingY - 0.16, Math.max(localSafeCruise - 0.05, y + laneAltOffset));
    }

    specs.push({
      position: { x, y, z },
      normal: UP_NORMAL,
      locomotionMode: 'fly',
    });
  }

  return buildNavigationPathFromSpecs({
    id: `air-${portal.id}-lane-${laneIndex}`,
    portalId: portal.id,
    layer: 'air',
    laneIndex,
    specs,
    landingSpecIndex: 0,
  });
}

// ============================================================================
// Disruptor Turret-Detour Steering & Stuck-Unit Recovery
// ============================================================================

function extractPlainVec3(item: Readonly<Vec3> | { readonly position: Readonly<Vec3> }): Vec3 {
  if ('position' in item) {
    return cloneVec3(item.position);
  }
  return cloneVec3(item);
}

/**
 * Computes a smooth 3D aerial flight path for a `Rift Disruptor` from `fromPos` that detours
 * within EMP range (`<= 1.2 m`) of active turrets before continuing toward `corePos`.
 */
export function computeDisruptorDetourPath(
  fromPos: Readonly<Vec3>,
  turretPositions: readonly (Readonly<Vec3> | { readonly position: Readonly<Vec3> })[],
  corePos: Readonly<Vec3> | NavCoreAnchorInput,
  graph?: RoomNavigationGraph,
  options: DisruptorDetourOptions = {},
): NavigationPath {
  const targetCore = extractCoreInfo(corePos).position;
  const empRadiusM = options.empRadiusM ?? DEFAULT_DISRUPTOR_EMP_RADIUS_M;
  const approachDistM = Math.min(empRadiusM * 0.45, options.targetApproachDistanceM ?? 0.35);
  const maxDetours = Math.max(1, options.maxDetourTurrets ?? 3);
  const floorY = graph?.floorY ?? 0;
  const ceilingY = graph?.ceilingY ?? floorY + 2.8;
  const obstacles = graph?.obstacles ?? [];
  const aerialClearanceM = graph?.aerialClearanceM ?? DEFAULT_AERIAL_CLEARANCE_M;
  const baseFlightY = Math.min(
    ceilingY - 0.22,
    floorY + (options.flightAltitudeM ?? DEFAULT_DISRUPTOR_FLIGHT_ALTITUDE_M),
  );

  const endPos = coreShieldApproachPoint(fromPos, targetCore, true);

  const turrets = turretPositions.map(extractPlainVec3);

  // Filter and order candidate turrets along the progress axis from `fromPos` toward `targetCore`
  const toCoreX = endPos.x - fromPos.x;
  const toCoreZ = endPos.z - fromPos.z;
  const totalHoriz = Math.hypot(toCoreX, toCoreZ) || 1;
  const fwdX = toCoreX / totalHoriz;
  const fwdZ = toCoreZ / totalHoriz;

  const scoredTurrets = turrets
    .map((t, index) => {
      const relX = t.x - fromPos.x;
      const relZ = t.z - fromPos.z;
      const along = relX * fwdX + relZ * fwdZ;
      const perp = Math.abs(-relX * fwdZ + relZ * fwdX);
      const distFromStart = distanceVec3(fromPos, t);
      return {
        turret: t,
        index,
        along,
        perp,
        distFromStart,
        score: perp * 1.1 + Math.max(0, -along) * 2.5 + distFromStart * 0.35,
      };
    })
    .sort((a, b) => (a.score !== b.score ? a.score - b.score : a.index - b.index))
    .slice(0, maxDetours)
    .sort((a, b) => a.along - b.along);

  const controlAnchors: Vec3[] = [cloneVec3(fromPos)];

  for (const entry of scoredTurrets) {
    const tPos = entry.turret;
    // Position the hover waypoint within `approachDistM` of the turret (well inside `empRadiusM`),
    // biased slightly toward the corridor centerline and above obstacles.
    const toCenterX = (fromPos.x + endPos.x) * 0.5 - tPos.x;
    const toCenterZ = (fromPos.z + endPos.z) * 0.5 - tPos.z;
    const toCenterLen = Math.hypot(toCenterX, toCenterZ) || 1;

    const hoverX = tPos.x + (toCenterX / toCenterLen) * Math.min(approachDistM * 0.5, 0.22);
    const hoverZ = tPos.z + (toCenterZ / toCenterLen) * Math.min(approachDistM * 0.5, 0.22);
    const safeY = computeSafeAerialAltitudeAtXZ(
      hoverX,
      hoverZ,
      Math.max(tPos.y + 0.2, Math.min(baseFlightY, tPos.y + approachDistM * 0.75)),
      ceilingY,
      obstacles,
      aerialClearanceM,
    );
    // Clamp vertical distance to turret so 3D distance to `tPos` is guaranteed <= empRadiusM * 0.65
    const maxVertDelta = Math.sqrt(Math.max(0.05, (empRadiusM * 0.6) ** 2 - 0.22 ** 2));
    const hoverY = Math.min(
      ceilingY - 0.16,
      Math.max(floorY + 0.35, Math.min(safeY, tPos.y + maxVertDelta)),
    );

    controlAnchors.push({ x: hoverX, y: hoverY, z: hoverZ });
  }

  controlAnchors.push(endPos);

  // Subdivide each control span smoothly while clearing obstacle heights
  const specs: RawWaypointSpec[] = [];
  for (let i = 0; i + 1 < controlAnchors.length; i += 1) {
    const a = controlAnchors[i] as Vec3;
    const b = controlAnchors[i + 1] as Vec3;
    const spanDist = distanceVec3(a, b);
    const subSteps = Math.max(2, Math.min(6, Math.ceil(spanDist / 0.55)));

    for (let s = 0; s < subSteps; s += 1) {
      if (i > 0 && s === 0) continue;
      const t = s / subSteps;
      const smoothT = t * t * (3 - 2 * t);
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      let y = a.y + (b.y - a.y) * smoothT;
      if (s > 0) {
        y = Math.max(
          y,
          computeSafeAerialAltitudeAtXZ(x, z, y, ceilingY, obstacles, aerialClearanceM * 0.7),
        );
      }
      specs.push({
        position: { x, y, z },
        normal: UP_NORMAL,
        locomotionMode: 'fly',
      });
    }
  }

  specs.push({
    position: endPos,
    normal: UP_NORMAL,
    locomotionMode: 'fly',
  });

  return buildNavigationPathFromSpecs({
    id: `disruptor-detour-${options.portalId ?? 'active'}`,
    portalId: options.portalId ?? 'disruptor-detour',
    layer: 'air',
    laneIndex: options.laneIndex ?? 0,
    specs,
    landingSpecIndex: 0,
  });
}

/**
 * Stuck-unit recovery for surface crawlers:
 * If a dynamic room-scan update places an obstacle over a unit, knocks a unit out of bounds,
 * or splits the floor corridor in half, computes a clean leap/re-path bridge to the nearest
 * Core-connected floor waypoint and continues around obstacles to the Core Bastion.
 */
export function recoverStuckCrawler(
  pos: Readonly<Vec3>,
  graph: RoomNavigationGraph,
): StuckRecoveryResult {
  const { grid, obstacles, corePosition, obstacleClearanceM, floorY } = graph;
  const startPos = cloneVec3(pos);
  const startXZ: Point2D = { x: startPos.x, z: startPos.z };
  const coreXZ: Point2D = { x: corePosition.x, z: corePosition.z };

  const inBounds =
    startPos.x >= grid.minX &&
    startPos.x <= grid.maxX &&
    startPos.z >= grid.minZ &&
    startPos.z <= grid.maxZ;
  const clearAtStart = isPointClearOfObstacles(startPos.x, startPos.z, obstacles, 0.02);
  const onFloor = Math.abs(startPos.y - floorY) <= 0.15;

  // Attempt a direct obstacle-free 2D floor re-path if the crawler is already on open connected floor
  if (inBounds && clearAtStart && onFloor) {
    const directFloorXZ = findCollisionFreeFloorPath2D(
      grid,
      startXZ,
      coreXZ,
      obstacles,
      obstacleClearanceM,
    );
    if (directFloorXZ && directFloorXZ.length >= 2) {
      const specs: RawWaypointSpec[] = directFloorXZ.map((pt) => ({
        position: { x: pt.x, y: floorY, z: pt.z },
        normal: UP_NORMAL,
        locomotionMode: 'floor',
      }));
      finishCrawlerAtShield(specs, corePosition, 0);
      const basePath = buildNavigationPathFromSpecs({
        id: 'recovered-crawler-path',
        portalId: 'recovery',
        layer: 'surface',
        laneIndex: 0,
        specs,
        landingSpecIndex: 0,
      });
      const nextWp = basePath.waypoints[1] ?? basePath.waypoints[0];
      const targetWaypoint = nextWp ? cloneVec3(nextWp.position) : cloneVec3(corePosition);
      const result: StuckRecoveryResult = {
        ...basePath,
        usedLeap: false,
        targetWaypoint,
        bridgeWaypoints: basePath.waypoints.slice(0, 2),
        path: basePath,
      };
      return result;
    }
  }

  // Otherwise, compute a 3D leap bridge (`locomotionMode: 'drop'`) to the best Core-connected
  // walkable floor waypoint (either from existing surface paths on the Core side or from the
  // Core-connected floor grid mask), then follow the connected floor path to the Core.
  const targetXZ = findBestCoreConnectedFloorTarget(
    startXZ,
    corePosition,
    grid,
    obstacles,
    obstacleClearanceM,
  );
  const targetWaypoint: Vec3 = { x: targetXZ.x, y: floorY, z: targetXZ.z };

  const bridgeSpecs = buildLeapBridgeSpecs(startPos, targetWaypoint, obstacles);
  const landingSpecIndex = bridgeSpecs.length - 1;

  const tailFloorXZ = findCollisionFreeFloorPath2D(
    grid,
    targetXZ,
    coreXZ,
    obstacles,
    obstacleClearanceM * 0.75,
  ) ?? [targetXZ, coreXZ];

  const allSpecs: RawWaypointSpec[] = [...bridgeSpecs];
  for (let i = 1; i < tailFloorXZ.length; i += 1) {
    const pt = tailFloorXZ[i] as Point2D;
    allSpecs.push({
      position: { x: pt.x, y: floorY, z: pt.z },
      normal: UP_NORMAL,
      locomotionMode: 'floor',
    });
  }

  finishCrawlerAtShield(allSpecs, corePosition, landingSpecIndex);
  const basePath = buildNavigationPathFromSpecs({
    id: 'recovered-crawler-leap-path',
    portalId: 'recovery',
    layer: 'surface',
    laneIndex: 0,
    specs: allSpecs,
    landingSpecIndex,
  });

  const bridgeWaypoints = basePath.waypoints.slice(0, basePath.landingWaypointIndex + 1);
  return {
    ...basePath,
    usedLeap: true,
    targetWaypoint: cloneVec3(basePath.landingPosition),
    bridgeWaypoints,
    path: basePath,
  };
}

// ============================================================================
// Top-Level Navigation Graph Builder
// ============================================================================

/**
 * Builds the deterministic `RoomNavigationGraph` (synchronized `'surface'` and `'air'` layers)
 * from room surfaces, Core Bastion anchor, and Portal Anchors.
 */
export function buildNavigationGraph(input: BuildNavigationGraphInput): RoomNavigationGraph {
  const surfaces = input.surfaces ?? input.roomModel?.surfaces ?? [];
  const revision = input.revision ?? input.roomModel?.revision ?? 1;
  const coreInfo = extractCoreInfo(input.coreAnchor);
  const corePos = coreInfo.position;
  const portals = input.portalAnchors;

  const gridCellSizeM = input.gridCellSizeM ?? DEFAULT_GRID_CELL_SIZE_M;
  const obstacleClearanceM = input.obstacleClearanceM ?? DEFAULT_OBSTACLE_CLEARANCE_M;
  const nominalFlightAltitudeM = input.nominalFlightAltitudeM ?? DEFAULT_NOMINAL_FLIGHT_ALTITUDE_M;
  const aerialClearanceM = input.aerialClearanceM ?? DEFAULT_AERIAL_CLEARANCE_M;
  const aerialLaneSpacingM = input.aerialLaneSpacingM ?? DEFAULT_AERIAL_LANE_SPACING_M;
  const aerialLaneIndices = input.aerialLaneIndices ?? DEFAULT_AERIAL_LANE_INDICES;

  const boundsInfo = computeRoomFloorAndBounds(surfaces, corePos, portals);
  const { floorY, ceilingY } = boundsInfo;
  const roomBounds = { min: boundsInfo.min, max: boundsInfo.max };

  const obstacles = extractFloorObstacles(
    surfaces,
    floorY,
    corePos,
    coreInfo.surfaceId,
    obstacleClearanceM,
  );

  const grid = buildFloorNavigationGrid({
    minX: roomBounds.min.x,
    maxX: roomBounds.max.x,
    minZ: roomBounds.min.z,
    maxZ: roomBounds.max.z,
    floorY,
    cellSizeM: gridCellSizeM,
    obstacles,
    clearanceM: obstacleClearanceM,
    corePos,
  });

  const surfacePaths: Record<string, NavigationPath> = {};
  const airPaths: Record<string, NavigationPath> = {};
  const airLanePaths: Record<string, Record<number, NavigationPath>> = {};

  const laneSet = new Set<number>(aerialLaneIndices);
  laneSet.add(0);
  const sortedLanes = [...laneSet].sort((a, b) => a - b);

  for (const portal of portals) {
    surfacePaths[portal.id] = buildCrawlerSurfacePath({
      portal,
      corePos,
      grid,
      obstacles,
      ceilingY,
      clearanceM: obstacleClearanceM,
    });

    const portalLanes: Record<number, NavigationPath> = {};
    for (const laneIndex of sortedLanes) {
      portalLanes[laneIndex] = buildAerialCorridorPath({
        portal,
        corePos,
        laneIndex,
        laneSpacingM: aerialLaneSpacingM,
        floorY,
        ceilingY,
        roomBounds,
        obstacles,
        nominalFlightAltitudeM,
        aerialClearanceM,
      });
    }
    airLanePaths[portal.id] = portalLanes;
    airPaths[portal.id] = portalLanes[0] as NavigationPath;
  }

  const graph: RoomNavigationGraph = {
    revision,
    floorY,
    ceilingY,
    roomBounds,
    corePosition: corePos,
    coreRadius: coreInfo.radius,
    coreSurfaceId: coreInfo.surfaceId,
    nominalFlightAltitudeM,
    aerialClearanceM,
    aerialLaneSpacingM,
    obstacleClearanceM,
    portals,
    obstacles,
    grid,
    surfacePaths,
    airPaths,
    airLanePaths,
    getSurfacePath(portalId: string): NavigationPath | undefined {
      return surfacePaths[portalId];
    },
    getAirPath(portalId: string, laneIndex = 0): NavigationPath | undefined {
      const lanes = airLanePaths[portalId];
      if (lanes?.[laneIndex]) {
        return lanes[laneIndex];
      }
      const portal = portals.find((p) => p.id === portalId);
      if (!portal) return undefined;
      return buildAerialCorridorPath({
        portal,
        corePos,
        laneIndex,
        laneSpacingM: aerialLaneSpacingM,
        floorY,
        ceilingY,
        roomBounds,
        obstacles,
        nominalFlightAltitudeM,
        aerialClearanceM,
      });
    },
    getPath(portalId: string, layer: MovementLayer, laneIndex = 0): NavigationPath | undefined {
      return layer === 'surface'
        ? graph.getSurfacePath(portalId)
        : graph.getAirPath(portalId, laneIndex);
    },
    computeDisruptorPath(
      fromPos: Readonly<Vec3>,
      turretPositions: readonly (Readonly<Vec3> | { readonly position: Readonly<Vec3> })[],
      options?: DisruptorDetourOptions,
    ): NavigationPath {
      return computeDisruptorDetourPath(fromPos, turretPositions, corePos, graph, options);
    },
    recoverCrawler(pos: Readonly<Vec3>): StuckRecoveryResult {
      return recoverStuckCrawler(pos, graph);
    },
  };

  return graph;
}
