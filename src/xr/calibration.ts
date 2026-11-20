/**
 * Pre-Mission Core Anchor Calibration, Play Arc (`front-180` Seated / `full-360` Standing)
 * auto-detection & override, portal candidate selection (`>= 2.0 m` Euclidean clearance with
 * virtual rift gate fallback at `2.6–3.6 m`), and Three.js hologram calibration preview.
 *
 * Consumed by:
 * - `P1-T2` (`src/mr/occlusion.ts` portal aperture cutouts via `PortalAnchor`)
 * - `P1-T4` (`src/xr/placement.ts` Core keep-out & portal keep-out validation via `CoreAnchor` / `PortalAnchor`)
 * - `P2-T1` (`src/nav/graph.ts` 3D wall/ceiling-to-floor & aerial navigation graph)
 *
 * References:
 * - PRD.md §D2 (Hybrid Room-Scale MR), §D3 (Pre-Mission Core Anchor & Safety Envelope),
 *   §D4 (Seated & Standing Play Arc)
 * - plans/phase-1-room-mr-and-placement.md (P1-T3)
 */
import * as THREE from 'three';
import { CORE_BASTION_SPEC, RIFT_PORTAL_SPEC } from '../content/waves.ts';
import type { ActionBus, PlayArc, Vec3 } from '../core/action-bus.ts';
import type { GameStateMachine } from '../core/state.ts';
import type { RoomSurface, RoomSurfaceModel, SurfaceAnchor, SurfaceKind } from '../mr/room-scan.ts';
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, type SettingsStore } from '../settings/store.ts';

/** Minimum keep-out radius around the Core Bastion for turret placement (`0.55 m`). */
export const CORE_KEEP_OUT_RADIUS = CORE_BASTION_SPEC.keepOutRadiusM;

/** Minimum Euclidean distance between the Core Bastion and any wall/ceiling portal anchor (`2.0 m`). */
export const MIN_PORTAL_CLEARANCE_M = RIFT_PORTAL_SPEC.minDistanceFromCoreM;

/** Minimum number of valid (`>= 2.0 m`) portal anchors required before Wave 1 can be unlocked. */
export const MIN_REQUIRED_PORTALS = 2;

/** Maximum number of portal anchors selected for the 12-wave mission (`4`). */
export const MAX_PORTAL_ANCHORS = 4;

/** Headset height threshold below which seated posture (`front-180`) is auto-detected (`1.35 m`). */
export const SEATED_HEIGHT_THRESHOLD_M = 1.35;

/** Minimum horizontal distance ahead of the player for Core auto-suggestion (`1.2 m`). */
export const CORE_SUGGEST_MIN_DIST_M = 1.2;

/** Maximum horizontal distance ahead of the player for Core auto-suggestion (`1.8 m`). */
export const CORE_SUGGEST_MAX_DIST_M = 1.8;

/** Ideal horizontal distance ahead of the player for Core auto-suggestion (`1.45 m`). */
export const CORE_SUGGEST_IDEAL_DIST_M = 1.45;

/** Virtual tactical pedestal height when seated (`< 1.35 m` headset height). */
export const VIRTUAL_PEDESTAL_Y_SEATED = 0.78;

/** Virtual tactical pedestal height when standing (`>= 1.35 m` headset height). */
export const VIRTUAL_PEDESTAL_Y_STANDING = 0.92;

/** Comfortable tabletop height bounds for Core auto-suggestion (`0.45–1.15 m`). */
export const COMFORTABLE_TABLE_MIN_Y = 0.45;
export const COMFORTABLE_TABLE_MAX_Y = 1.15;

/** Euclidean distance range (`2.6–3.6 m`) for synthesized fallback virtual rift gates. */
export const VIRTUAL_RIFT_MIN_DIST_M = 2.6;
export const VIRTUAL_RIFT_MAX_DIST_M = 3.6;

/** Default portal aperture dimensions from `RIFT_PORTAL_SPEC`. */
export const DEFAULT_PORTAL_WIDTH = RIFT_PORTAL_SPEC.apertureWidthM;
export const DEFAULT_PORTAL_HEIGHT = RIFT_PORTAL_SPEC.apertureHeightM;

/** Minimum 3D center-to-center spacing between selected portal anchors (`1.05 m`). */
const MIN_PORTAL_SEPARATION_M = 1.05;

export type CoreSurfaceKind = SurfaceKind | 'virtual-pedestal';
export type PortalHostKind = 'wall' | 'ceiling' | 'virtual-rift';
export type PlayerPosture = 'seated' | 'standing';

export interface CoreAnchor {
  readonly position: Vec3;
  readonly yaw: number;
  readonly surfaceId: string | null;
  readonly surfaceKind: CoreSurfaceKind;
  readonly radius: number;
}

export interface PortalAnchor {
  readonly id: string;
  readonly position: Vec3;
  readonly normal: Vec3;
  readonly width: number;
  readonly height: number;
  readonly surfaceId: string | null;
  readonly hostKind: PortalHostKind;
  readonly distanceFromCore: number;
}

export interface HeadsetPose {
  readonly position: Vec3;
  /** Horizontal forward yaw in radians (`0` = facing `-Z`, `+PI/2` = facing `-X`). */
  readonly yaw: number;
}

export interface CalibrationState {
  readonly active: boolean;
  readonly locked: boolean;
  readonly posture: PlayerPosture;
  readonly headsetPose: HeadsetPose;
  readonly playArc: PlayArc;
  readonly playArcOverridden: boolean;
  readonly coreAnchor: CoreAnchor;
  readonly portalAnchors: readonly PortalAnchor[];
  readonly isValid: boolean;
  readonly validationMessage: string;
}

export type CalibrationListener = (state: Readonly<CalibrationState>) => void;

export interface SelectPortalAnchorsInput {
  readonly surfaces: readonly RoomSurface[];
  readonly coreAnchor: Pick<CoreAnchor, 'position'> | Vec3;
  readonly playerYaw: number;
  readonly playerPosition?: Vec3;
  readonly playArc: PlayArc;
  readonly maxPortals?: number;
  readonly minPortals?: number;
  readonly minDistanceFromCoreM?: number;
}

export interface BeginCalibrationOptions {
  readonly playArcOverride?: PlayArc;
  readonly resetPlayArcOverride?: boolean;
}

export interface MoveCoreOptions {
  readonly surfaceId?: string | null;
}

export interface CalibrationPreview {
  readonly group: THREE.Group;
  readonly coreRing: THREE.Mesh;
  readonly keepOutRing: THREE.Mesh;
  readonly clearanceRing: THREE.Mesh;
  readonly portalFramesGroup: THREE.Group;
  update(
    state: Pick<CalibrationState, 'coreAnchor' | 'portalAnchors' | 'isValid' | 'locked' | 'active'>,
  ): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

export interface CalibrationControllerOptions {
  readonly roomModel: RoomSurfaceModel;
  readonly settingsStore?: SettingsStore;
  readonly actionBus?: ActionBus;
  readonly gameState?: GameStateMachine;
  readonly initialHeadsetPose?: HeadsetPose;
  readonly playArcOverride?: PlayArc;
  readonly preview?: CalibrationPreview;
}

export interface CalibrationController {
  readonly state: Readonly<CalibrationState>;
  readonly coreAnchor: CoreAnchor;
  readonly portalAnchors: readonly PortalAnchor[];
  readonly playArc: PlayArc;
  readonly isValid: boolean;
  readonly locked: boolean;
  readonly surfaceAnchor: SurfaceAnchor | null;
  readonly preview: CalibrationPreview | null;
  beginCalibration(
    headsetPose?: HeadsetPose,
    options?: BeginCalibrationOptions,
  ): Readonly<CalibrationState>;
  autoSuggestCore(headsetPose?: HeadsetPose): CoreAnchor;
  moveCoreToPoint(position: Vec3, options?: MoveCoreOptions): CoreAnchor;
  moveCoreByRay(rayOrigin: Vec3, rayDirection: Vec3): CoreAnchor;
  beginGripDrag(): void;
  updateGripDrag(handPosition: Vec3): CoreAnchor;
  endGripDrag(): void;
  setPlayArc(arc: PlayArc): Readonly<CalibrationState>;
  refreshPortals(): readonly PortalAnchor[];
  confirmLockCore(): boolean;
  subscribe(listener: CalibrationListener): () => void;
  dispose(): void;
}

const DEFAULT_HEADSET_POSE: HeadsetPose = Object.freeze({
  position: Object.freeze({ x: 0, y: 1.65, z: 1.45 }),
  yaw: 0,
});

function cloneVec3(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function extractPosition(core: Pick<CoreAnchor, 'position'> | Vec3): Vec3 {
  if ('position' in core) {
    return core.position;
  }
  return core;
}

export function distance3D(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function distanceXZ(a: Vec3, b: { readonly x: number; readonly z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Returns the horizontal unit forward vector for a right-handed Y-up yaw angle (`0` -> `(0, 0, -1)`).
 */
export function forwardFromYaw(yaw: number): Vec3 {
  return {
    x: -Math.sin(yaw),
    y: 0,
    z: -Math.cos(yaw),
  };
}

/**
 * Computes the horizontal yaw angle in `[-PI, PI]` from a 3D forward direction vector.
 */
export function yawFromForward(forward: Vec3): number {
  const len = Math.hypot(forward.x, forward.z);
  if (len < 1e-8) return 0;
  return Math.atan2(-forward.x / len, -forward.z / len);
}

/**
 * Extracts a `HeadsetPose` (world position + horizontal forward yaw) from a Three.js camera or head object.
 */
export function extractHeadsetPoseFromObject(cameraOrHead: THREE.Object3D): HeadsetPose {
  cameraOrHead.updateMatrixWorld(true);
  const pos = new THREE.Vector3().setFromMatrixPosition(cameraOrHead.matrixWorld);
  const forward = new THREE.Vector3(0, 0, -1).transformDirection(cameraOrHead.matrixWorld);
  return {
    position: { x: pos.x, y: pos.y, z: pos.z },
    yaw: yawFromForward({ x: forward.x, y: forward.y, z: forward.z }),
  };
}

/**
 * Detects seated (`< 1.35 m`) vs standing (`>= 1.35 m`) posture from initial headset height.
 */
export function detectPostureFromHeight(headHeightM: number): PlayerPosture {
  return headHeightM < SEATED_HEIGHT_THRESHOLD_M ? 'seated' : 'standing';
}

/**
 * Auto-detects Play Arc (`'front-180'` when seated `< 1.35 m`, `'full-360'` when standing `>= 1.35 m`),
 * while preserving an explicit user override when provided.
 */
export function detectPlayArcFromHeight(
  headHeightM: number,
  explicitOverride?: PlayArc | null,
): PlayArc {
  if (explicitOverride === 'front-180' || explicitOverride === 'full-360') {
    return explicitOverride;
  }
  return detectPostureFromHeight(headHeightM) === 'seated' ? 'front-180' : 'full-360';
}

/**
 * Computes signed horizontal azimuth angle in radians (`[-PI, PI]`) of `to` relative to `from`
 * and `forwardYaw` (`0` = dead ahead, `+PI/2` = `+90°` right, `-PI/2` = `-90°` left).
 */
export function computeRelativeAzimuth(from: Vec3, to: Vec3, forwardYaw: number): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.hypot(dx, dz) < 1e-7) return 0;
  const fx = -Math.sin(forwardYaw);
  const fz = -Math.cos(forwardYaw);
  const rx = Math.cos(forwardYaw);
  const rz = -Math.sin(forwardYaw);
  const fwd = dx * fx + dz * fz;
  const right = dx * rx + dz * rz;
  return Math.atan2(right, fwd);
}

/**
 * Checks whether `to` lies within the active `PlayArc` relative to `from` and `forwardYaw`.
 * - `'front-180'`: restricts azimuth to `[-90°, +90°]` (`[-PI/2, +PI/2]`)
 * - `'full-360'`: accepts all azimuths (`[-180°, +180°]`)
 */
export function isWithinPlayArc(
  from: Vec3,
  to: Vec3,
  forwardYaw: number,
  playArc: PlayArc,
): boolean {
  if (playArc === 'full-360') return true;
  const azimuth = computeRelativeAzimuth(from, to, forwardYaw);
  return Math.abs(azimuth) <= Math.PI / 2 + 1e-5;
}

function pointToSegmentDistanceSq2D(
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
 * Tests whether `(x, z)` lies inside or on the boundary of a world-space horizontal polygon.
 */
export function isPointInPolygonXZ(
  x: number,
  z: number,
  polygon: readonly THREE.Vector3[],
  eps = 1e-4,
): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i] as THREE.Vector3;
    const pj = polygon[j] as THREE.Vector3;
    const seg = pointToSegmentDistanceSq2D(x, z, pi.x, pi.z, pj.x, pj.z);
    if (seg.distSq <= eps * eps) return true;

    const intersect =
      pi.z > z !== pj.z > z && x < ((pj.x - pi.x) * (z - pi.z)) / (pj.z - pi.z) + pi.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Finds the closest point `(x, z)` inside or on the perimeter of a horizontal polygon.
 */
export function closestPointOnPolygonXZ(
  x: number,
  z: number,
  polygon: readonly THREE.Vector3[],
): { readonly x: number; readonly z: number; readonly distSq: number } {
  if (polygon.length === 0) return { x, z, distSq: 0 };
  if (isPointInPolygonXZ(x, z, polygon)) {
    return { x, z, distSq: 0 };
  }
  let bestX = (polygon[0] as THREE.Vector3).x;
  let bestZ = (polygon[0] as THREE.Vector3).z;
  let bestDistSq = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i] as THREE.Vector3;
    const b = polygon[(i + 1) % polygon.length] as THREE.Vector3;
    const candidate = pointToSegmentDistanceSq2D(x, z, a.x, a.z, b.x, b.z);
    if (candidate.distSq < bestDistSq) {
      bestDistSq = candidate.distSq;
      bestX = candidate.x;
      bestZ = candidate.z;
    }
  }
  return { x: bestX, z: bestZ, distSq: bestDistSq };
}

function isHorizontalSupportSurface(surface: RoomSurface, kind: 'table' | 'floor'): boolean {
  if (surface.kind !== kind) return false;
  if (surface.normal.y < 0.7) return false;
  if (kind === 'table') {
    const y = surface.center.y;
    if (y < COMFORTABLE_TABLE_MIN_Y || y > COMFORTABLE_TABLE_MAX_Y) return false;
  }
  return surface.polygon.length >= 3;
}

interface HorizontalCandidateMatch {
  readonly surface: RoomSurface;
  readonly position: Vec3;
  readonly horizontalDistance: number;
  readonly lateralOffset: number;
  readonly score: number;
}

function evaluateHorizontalSurfaceForSuggestion(
  surface: RoomSurface,
  headsetPose: HeadsetPose,
): HorizontalCandidateMatch | null {
  const hx = headsetPose.position.x;
  const hz = headsetPose.position.z;
  const fwd = forwardFromYaw(headsetPose.yaw);
  const rx = Math.cos(headsetPose.yaw);
  const rz = -Math.sin(headsetPose.yaw);
  const surfaceY = surface.center.y;

  const samplePoints: Array<{ readonly x: number; readonly z: number }> = [];

  // 1. Sample along the player's forward ray inside [1.2, 1.8] m around the ideal 1.45 m target.
  const rayDistances = [1.45, 1.4, 1.5, 1.35, 1.55, 1.3, 1.6, 1.25, 1.65, 1.2, 1.7, 1.75, 1.8];
  for (const d of rayDistances) {
    const px = hx + fwd.x * d;
    const pz = hz + fwd.z * d;
    if (isPointInPolygonXZ(px, pz, surface.polygon)) {
      samplePoints.push({ x: px, z: pz });
    }
  }

  // 2. Include surface center if it lies on the polygon.
  if (isPointInPolygonXZ(surface.center.x, surface.center.z, surface.polygon)) {
    samplePoints.push({ x: surface.center.x, z: surface.center.z });
  }

  // 3. Project the ideal 1.45 m point onto the polygon and nudge slightly toward centroid.
  const idealX = hx + fwd.x * CORE_SUGGEST_IDEAL_DIST_M;
  const idealZ = hz + fwd.z * CORE_SUGGEST_IDEAL_DIST_M;
  const clamped = closestPointOnPolygonXZ(idealX, idealZ, surface.polygon);
  samplePoints.push({ x: clamped.x, z: clamped.z });
  const toCenterX = surface.center.x - clamped.x;
  const toCenterZ = surface.center.z - clamped.z;
  const toCenterLen = Math.hypot(toCenterX, toCenterZ);
  if (toCenterLen > 1e-4) {
    const nudge = Math.min(0.15, toCenterLen * 0.5);
    const nx = clamped.x + (toCenterX / toCenterLen) * nudge;
    const nz = clamped.z + (toCenterZ / toCenterLen) * nudge;
    if (isPointInPolygonXZ(nx, nz, surface.polygon)) {
      samplePoints.push({ x: nx, z: nz });
    }
  }

  let best: HorizontalCandidateMatch | null = null;
  for (const pt of samplePoints) {
    const dx = pt.x - hx;
    const dz = pt.z - hz;
    const dist = Math.hypot(dx, dz);
    if (dist < CORE_SUGGEST_MIN_DIST_M - 1e-5 || dist > CORE_SUGGEST_MAX_DIST_M + 1e-5) {
      continue;
    }
    const forwardProj = dx * fwd.x + dz * fwd.z;
    // Candidate must be in front of the player (within ±55 deg of calibrated forward yaw).
    if (forwardProj < dist * Math.cos((55 * Math.PI) / 180)) {
      continue;
    }
    const lateral = Math.abs(dx * rx + dz * rz);
    // Prefer points closest to the player within [1.2, 1.8] and aligned with the forward ray.
    const distFromIdeal = Math.abs(dist - CORE_SUGGEST_IDEAL_DIST_M);
    const score = lateral * 1.5 + distFromIdeal * 0.6 + (dist - CORE_SUGGEST_MIN_DIST_M) * 0.25;
    if (!best || score < best.score) {
      best = {
        surface,
        position: { x: pt.x, y: surfaceY, z: pt.z },
        horizontalDistance: dist,
        lateralOffset: lateral,
        score,
      };
    }
  }

  return best;
}

/**
 * Auto-suggests the Core Bastion anchor `1.2–1.8 m` horizontally ahead of the player:
 * 1. Nearest scanned `table` at comfortable height (`0.45–1.15 m`) within `1.2–1.8 m` ahead
 * 2. Else nearest scanned `floor` within `1.2–1.8 m` ahead
 * 3. Else virtual tactical pedestal at `1.45 m` ahead (`y = 0.78 m` seated / `0.92 m` standing)
 */
export function suggestCoreAnchor(
  headsetPose: HeadsetPose,
  surfaces: readonly RoomSurface[],
): CoreAnchor {
  // 1. Prefer tables at comfortable height within 1.2–1.8 m ahead
  let bestTable: HorizontalCandidateMatch | null = null;
  for (const surface of surfaces) {
    if (!isHorizontalSupportSurface(surface, 'table')) continue;
    const candidate = evaluateHorizontalSurfaceForSuggestion(surface, headsetPose);
    if (!candidate) continue;
    if (
      !bestTable ||
      candidate.horizontalDistance < bestTable.horizontalDistance - 0.05 ||
      (Math.abs(candidate.horizontalDistance - bestTable.horizontalDistance) <= 0.05 &&
        candidate.score < bestTable.score)
    ) {
      bestTable = candidate;
    }
  }
  if (bestTable) {
    return {
      position: bestTable.position,
      yaw: headsetPose.yaw,
      surfaceId: bestTable.surface.id,
      surfaceKind: 'table',
      radius: CORE_KEEP_OUT_RADIUS,
    };
  }

  // 2. Fall back to floor within 1.2–1.8 m ahead
  let bestFloor: HorizontalCandidateMatch | null = null;
  for (const surface of surfaces) {
    if (!isHorizontalSupportSurface(surface, 'floor')) continue;
    const candidate = evaluateHorizontalSurfaceForSuggestion(surface, headsetPose);
    if (!candidate) continue;
    if (!bestFloor || candidate.score < bestFloor.score) {
      bestFloor = candidate;
    }
  }
  if (bestFloor) {
    return {
      position: bestFloor.position,
      yaw: headsetPose.yaw,
      surfaceId: bestFloor.surface.id,
      surfaceKind: 'floor',
      radius: CORE_KEEP_OUT_RADIUS,
    };
  }

  // 3. Fall back to virtual tactical pedestal at 1.45 m ahead
  const posture = detectPostureFromHeight(headsetPose.position.y);
  const pedestalY = posture === 'seated' ? VIRTUAL_PEDESTAL_Y_SEATED : VIRTUAL_PEDESTAL_Y_STANDING;
  const fwd = forwardFromYaw(headsetPose.yaw);
  return {
    position: {
      x: headsetPose.position.x + fwd.x * CORE_SUGGEST_IDEAL_DIST_M,
      y: pedestalY,
      z: headsetPose.position.z + fwd.z * CORE_SUGGEST_IDEAL_DIST_M,
    },
    yaw: headsetPose.yaw,
    surfaceId: null,
    surfaceKind: 'virtual-pedestal',
    radius: CORE_KEEP_OUT_RADIUS,
  };
}

/**
 * Clamps a requested Core relocation position onto a valid horizontal surface (`table` or `floor`)
 * or onto the virtual tactical pedestal if no horizontal surfaces are available.
 */
export function clampCoreToSurfaces(
  targetPosition: Vec3,
  surfaces: readonly RoomSurface[],
  headsetPose: HeadsetPose,
  options?: MoveCoreOptions,
): CoreAnchor {
  const horizontalSurfaces = surfaces.filter(
    (s) => isHorizontalSupportSurface(s, 'table') || isHorizontalSupportSurface(s, 'floor'),
  );

  // 1. Explicit target surfaceId if valid
  if (options?.surfaceId) {
    const explicit = horizontalSurfaces.find((s) => s.id === options.surfaceId);
    if (explicit) {
      const clamped = closestPointOnPolygonXZ(targetPosition.x, targetPosition.z, explicit.polygon);
      return {
        position: { x: clamped.x, y: explicit.center.y, z: clamped.z },
        yaw: headsetPose.yaw,
        surfaceId: explicit.id,
        surfaceKind: explicit.kind,
        radius: CORE_KEEP_OUT_RADIUS,
      };
    }
  }

  // 2. Prefer a table containing (or very near) the target when target.y is elevated
  const tables = horizontalSurfaces.filter((s) => s.kind === 'table');
  const floors = horizontalSurfaces.filter((s) => s.kind === 'floor');

  let bestTable: { surface: RoomSurface; x: number; z: number; metric: number } | null = null;
  for (const table of tables) {
    const clamped = closestPointOnPolygonXZ(targetPosition.x, targetPosition.z, table.polygon);
    const horizDist = Math.sqrt(clamped.distSq);
    const vertDist = Math.abs(targetPosition.y - table.center.y);
    if (horizDist <= 0.25 && (targetPosition.y >= 0.35 || floors.length === 0)) {
      const metric = horizDist * 2 + vertDist;
      if (!bestTable || metric < bestTable.metric) {
        bestTable = { surface: table, x: clamped.x, z: clamped.z, metric };
      }
    }
  }
  if (bestTable) {
    return {
      position: { x: bestTable.x, y: bestTable.surface.center.y, z: bestTable.z },
      yaw: headsetPose.yaw,
      surfaceId: bestTable.surface.id,
      surfaceKind: 'table',
      radius: CORE_KEEP_OUT_RADIUS,
    };
  }

  // 3. Check floors or nearest horizontal surface in 3D
  if (horizontalSurfaces.length > 0) {
    let bestSurface: { surface: RoomSurface; x: number; z: number; dist3D: number } | null = null;
    for (const surface of horizontalSurfaces) {
      const clamped = closestPointOnPolygonXZ(targetPosition.x, targetPosition.z, surface.polygon);
      const d3 = Math.hypot(
        targetPosition.x - clamped.x,
        targetPosition.y - surface.center.y,
        targetPosition.z - clamped.z,
      );
      if (!bestSurface || d3 < bestSurface.dist3D) {
        bestSurface = { surface, x: clamped.x, z: clamped.z, dist3D: d3 };
      }
    }
    if (bestSurface) {
      return {
        position: { x: bestSurface.x, y: bestSurface.surface.center.y, z: bestSurface.z },
        yaw: headsetPose.yaw,
        surfaceId: bestSurface.surface.id,
        surfaceKind: bestSurface.surface.kind,
        radius: CORE_KEEP_OUT_RADIUS,
      };
    }
  }

  // 4. Virtual pedestal fallback (clamped to comfortable reach around headset pose)
  const posture = detectPostureFromHeight(headsetPose.position.y);
  const defaultY = posture === 'seated' ? VIRTUAL_PEDESTAL_Y_SEATED : VIRTUAL_PEDESTAL_Y_STANDING;
  const dx = targetPosition.x - headsetPose.position.x;
  const dz = targetPosition.z - headsetPose.position.z;
  const dist = Math.hypot(dx, dz);
  let px = targetPosition.x;
  let pz = targetPosition.z;
  if (dist < 0.6 || dist > 3.5) {
    const clampedDist = Math.max(0.6, Math.min(3.5, dist || CORE_SUGGEST_IDEAL_DIST_M));
    if (dist > 1e-5) {
      px = headsetPose.position.x + (dx / dist) * clampedDist;
      pz = headsetPose.position.z + (dz / dist) * clampedDist;
    } else {
      const fwd = forwardFromYaw(headsetPose.yaw);
      px = headsetPose.position.x + fwd.x * clampedDist;
      pz = headsetPose.position.z + fwd.z * clampedDist;
    }
  }
  const py =
    Number.isFinite(targetPosition.y) && targetPosition.y >= 0.45 && targetPosition.y <= 1.25
      ? targetPosition.y
      : defaultY;

  return {
    position: { x: px, y: py, z: pz },
    yaw: headsetPose.yaw,
    surfaceId: null,
    surfaceKind: 'virtual-pedestal',
    radius: CORE_KEEP_OUT_RADIUS,
  };
}

/**
 * Raycasts a controller/mouse ray against horizontal surfaces (`table`, `floor`) or fallback
 * pedestal plane to relocate the Core Bastion.
 */
export function raycastCorePlacement(
  rayOrigin: Vec3,
  rayDirection: Vec3,
  surfaces: readonly RoomSurface[],
  headsetPose: HeadsetPose,
  currentCore?: CoreAnchor,
): CoreAnchor {
  const dirLen = Math.hypot(rayDirection.x, rayDirection.y, rayDirection.z);
  if (dirLen < 1e-8) {
    return currentCore ?? suggestCoreAnchor(headsetPose, surfaces);
  }
  const dx = rayDirection.x / dirLen;
  const dy = rayDirection.y / dirLen;
  const dz = rayDirection.z / dirLen;

  const horizontalSurfaces = surfaces.filter(
    (s) => isHorizontalSupportSurface(s, 'table') || isHorizontalSupportSurface(s, 'floor'),
  );

  let closestHit: { surface: RoomSurface; point: Vec3; t: number } | null = null;
  for (const surface of horizontalSurfaces) {
    const denom = dx * surface.normal.x + dy * surface.normal.y + dz * surface.normal.z;
    if (Math.abs(denom) < 1e-6) continue;
    const t =
      ((surface.center.x - rayOrigin.x) * surface.normal.x +
        (surface.center.y - rayOrigin.y) * surface.normal.y +
        (surface.center.z - rayOrigin.z) * surface.normal.z) /
      denom;
    if (t <= 0.05 || t > 12) continue;
    const hx = rayOrigin.x + dx * t;
    const hy = rayOrigin.y + dy * t;
    const hz = rayOrigin.z + dz * t;
    if (isPointInPolygonXZ(hx, hz, surface.polygon)) {
      if (!closestHit || t < closestHit.t) {
        closestHit = {
          surface,
          point: { x: hx, y: hy, z: hz },
          t,
        };
      }
    }
  }

  if (closestHit) {
    return {
      position: {
        x: closestHit.point.x,
        y: closestHit.surface.center.y,
        z: closestHit.point.z,
      },
      yaw: headsetPose.yaw,
      surfaceId: closestHit.surface.id,
      surfaceKind: closestHit.surface.kind,
      radius: CORE_KEEP_OUT_RADIUS,
    };
  }

  // Intersect fallback horizontal plane at current Core height (or default pedestal/floor height)
  const fallbackY =
    currentCore?.position.y ??
    (detectPostureFromHeight(headsetPose.position.y) === 'seated'
      ? VIRTUAL_PEDESTAL_Y_SEATED
      : VIRTUAL_PEDESTAL_Y_STANDING);
  let targetPoint: Vec3;
  if (Math.abs(dy) > 1e-5) {
    const t = Math.max(0.6, Math.min(5.0, (fallbackY - rayOrigin.y) / dy));
    targetPoint = {
      x: rayOrigin.x + dx * t,
      y: fallbackY,
      z: rayOrigin.z + dz * t,
    };
  } else {
    targetPoint = {
      x: rayOrigin.x + dx * CORE_SUGGEST_IDEAL_DIST_M,
      y: fallbackY,
      z: rayOrigin.z + dz * CORE_SUGGEST_IDEAL_DIST_M,
    };
  }

  return clampCoreToSurfaces(targetPoint, surfaces, headsetPose);
}

interface RawPortalCandidate {
  readonly surfaceId: string;
  readonly hostKind: 'wall' | 'ceiling';
  readonly position: Vec3;
  readonly normal: Vec3;
  readonly distanceFromCore: number;
  readonly azimuthFromCore: number;
  readonly isSurfaceCenter: boolean;
}

function computeInwardPortalNormal(
  surfaceNormal: THREE.Vector3,
  candidatePos: Vec3,
  corePos: Vec3,
): Vec3 {
  let nx = surfaceNormal.x;
  let ny = surfaceNormal.y;
  let nz = surfaceNormal.z;
  const len = Math.hypot(nx, ny, nz);
  if (len > 1e-8) {
    nx /= len;
    ny /= len;
    nz /= len;
  } else {
    nx = 0;
    ny = 0;
    nz = 1;
  }
  const toCoreX = corePos.x - candidatePos.x;
  const toCoreY = corePos.y - candidatePos.y;
  const toCoreZ = corePos.z - candidatePos.z;
  if (nx * toCoreX + ny * toCoreY + nz * toCoreZ < 0) {
    return { x: -nx, y: -ny, z: -nz };
  }
  return { x: nx, y: ny, z: nz };
}

function generateSurfacePortalSamples(surface: RoomSurface): Array<{
  readonly position: Vec3;
  readonly isCenter: boolean;
}> {
  const samples: Array<{ readonly position: Vec3; readonly isCenter: boolean }> = [
    {
      position: { x: surface.center.x, y: surface.center.y, z: surface.center.z },
      isCenter: true,
    },
  ];

  if (surface.localPolygon.length < 3) return samples;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const pt of surface.localPolygon) {
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.z < minZ) minZ = pt.z;
    if (pt.z > maxZ) maxZ = pt.z;
  }

  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  const marginX = Math.min(0.45, spanX * 0.2);
  const marginZ = Math.min(0.45, spanZ * 0.2);
  const safeMinX = minX + marginX;
  const safeMaxX = maxX - marginX;
  const safeMinZ = minZ + marginZ;
  const safeMaxZ = maxZ - marginZ;

  const fractions = [-0.65, -0.35, 0, 0.35, 0.65];
  const midX = (safeMinX + safeMaxX) * 0.5;
  const halfX = Math.max(0, (safeMaxX - safeMinX) * 0.5);
  const midZ = (safeMinZ + safeMaxZ) * 0.5;
  const halfZ = Math.max(0, (safeMaxZ - safeMinZ) * 0.5);

  const tmp = new THREE.Vector3();
  if (surface.kind === 'wall') {
    for (const fx of fractions) {
      if (fx === 0) continue;
      const lx = midX + fx * halfX;
      const lz = midZ;
      tmp.set(lx, 0, lz).applyMatrix4(surface.worldMatrix);
      samples.push({
        position: { x: tmp.x, y: tmp.y, z: tmp.z },
        isCenter: false,
      });
    }
  } else if (surface.kind === 'ceiling') {
    const ceilingFractions = [-0.55, 0, 0.55];
    for (const fx of ceilingFractions) {
      for (const fz of ceilingFractions) {
        if (fx === 0 && fz === 0) continue;
        const lx = midX + fx * halfX;
        const lz = midZ + fz * halfZ;
        tmp.set(lx, 0, lz).applyMatrix4(surface.worldMatrix);
        samples.push({
          position: { x: tmp.x, y: tmp.y, z: tmp.z },
          isCenter: false,
        });
      }
    }
  }

  return samples;
}

function angularDifference(a: number, b: number): number {
  let diff = (a - b) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return Math.abs(diff);
}

/**
 * Selects up to `4` wall/ceiling portal anchors (at least `2` required before unlocking Wave 1):
 * - Strictly enforces `>= 2.0 m` Euclidean distance from the Core Bastion
 * - Filters azimuth by `playArc` (`'front-180'` restricts to `[-90°, +90°]` of `playerYaw`;
 *   `'full-360'` distributes around the room)
 * - Automatically synthesizes virtual rift gates at `2.6–3.6 m` when scanned walls/ceilings are
 *   missing, closer than `2.0 m`, or yield fewer than `2` valid anchors
 */
export function selectPortalAnchors(input: SelectPortalAnchorsInput): readonly PortalAnchor[] {
  const corePos = extractPosition(input.coreAnchor);
  const maxPortals = Math.max(1, input.maxPortals ?? MAX_PORTAL_ANCHORS);
  const minPortals = Math.max(1, Math.min(maxPortals, input.minPortals ?? MIN_REQUIRED_PORTALS));
  const minDistance = input.minDistanceFromCoreM ?? MIN_PORTAL_CLEARANCE_M;
  const { playerYaw, playArc, playerPosition } = input;

  // Check if playerPosition is consistent with corePos (Core ahead of player)
  const checkPlayerArc =
    playerPosition !== undefined &&
    isWithinPlayArc(playerPosition, corePos, playerYaw, 'front-180');

  const candidates: RawPortalCandidate[] = [];
  for (const surface of input.surfaces) {
    if (surface.kind !== 'wall' && surface.kind !== 'ceiling') continue;
    const samples = generateSurfacePortalSamples(surface);
    for (const sample of samples) {
      const dist = distance3D(sample.position, corePos);
      if (dist < minDistance) continue;
      if (!isWithinPlayArc(corePos, sample.position, playerYaw, playArc)) continue;
      if (
        checkPlayerArc &&
        playerPosition &&
        !isWithinPlayArc(playerPosition, sample.position, playerYaw, playArc)
      ) {
        continue;
      }

      const normal = computeInwardPortalNormal(surface.normal, sample.position, corePos);
      const azimuthFromCore = computeRelativeAzimuth(corePos, sample.position, playerYaw);
      candidates.push({
        surfaceId: surface.id,
        hostKind: surface.kind,
        position: sample.position,
        normal,
        distanceFromCore: dist,
        azimuthFromCore,
        isSurfaceCenter: sample.isCenter,
      });
    }
  }

  // Target azimuth slots for balanced angular spread across the play arc
  const targetAzimuths =
    playArc === 'front-180'
      ? [0, -Math.PI * 0.3, Math.PI * 0.3, -Math.PI * 0.45]
      : [0, Math.PI, -Math.PI * 0.5, Math.PI * 0.5];

  const selected: PortalAnchor[] = [];
  const usedSurfaceIds = new Set<string>();

  while (selected.length < maxPortals && candidates.length > 0) {
    const slotAzimuth = targetAzimuths[selected.length % targetAzimuths.length] ?? 0;
    let bestIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let i = 0; i < candidates.length; i += 1) {
      const c = candidates[i] as RawPortalCandidate;
      let tooClose = false;
      let minAngularSep = Math.PI;
      for (const existing of selected) {
        if (distance3D(c.position, existing.position) < MIN_PORTAL_SEPARATION_M) {
          tooClose = true;
          break;
        }
        const existingAz = computeRelativeAzimuth(corePos, existing.position, playerYaw);
        const sep = angularDifference(c.azimuthFromCore, existingAz);
        if (sep < minAngularSep) minAngularSep = sep;
      }
      if (tooClose) continue;

      const surfacePenalty = usedSurfaceIds.has(c.surfaceId) ? 1.8 : 0;
      const ceilingPenalty = c.hostKind === 'ceiling' ? 0.35 : 0;
      const centerBonus = c.isSurfaceCenter ? -0.25 : 0;
      const slotDiff = angularDifference(c.azimuthFromCore, slotAzimuth);
      const diversityBonus = selected.length > 0 ? -minAngularSep * 0.6 : 0;
      const distPenalty = Math.abs(c.distanceFromCore - 2.6) * 0.15;

      const score =
        surfacePenalty + ceilingPenalty + centerBonus + slotDiff + diversityBonus + distPenalty;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex < 0) break;
    const chosen = candidates.splice(bestIndex, 1)[0] as RawPortalCandidate;
    usedSurfaceIds.add(chosen.surfaceId);
    selected.push({
      id: `portal-${selected.length + 1}`,
      position: cloneVec3(chosen.position),
      normal: cloneVec3(chosen.normal),
      width: DEFAULT_PORTAL_WIDTH,
      height: DEFAULT_PORTAL_HEIGHT,
      surfaceId: chosen.surfaceId,
      hostKind: chosen.hostKind,
      distanceFromCore: chosen.distanceFromCore,
    });
  }

  // Synthesize virtual rift gates at 2.6–3.6 m if scanned surfaces yield fewer than minPortals (2)
  if (selected.length < minPortals) {
    const virtualOffsetsRad =
      playArc === 'front-180'
        ? [(-32 * Math.PI) / 180, (32 * Math.PI) / 180, (-68 * Math.PI) / 180, (68 * Math.PI) / 180]
        : [
            (-45 * Math.PI) / 180,
            (45 * Math.PI) / 180,
            (-135 * Math.PI) / 180,
            (135 * Math.PI) / 180,
          ];
    const virtualDistances = [2.8, 3.05, 3.25, 3.45];
    const targetCount = Math.min(maxPortals, Math.max(minPortals, MAX_PORTAL_ANCHORS));
    let virtualSlot = 0;

    while (selected.length < targetCount && virtualSlot < 8) {
      const offsetRad = virtualOffsetsRad[virtualSlot % virtualOffsetsRad.length] ?? 0;
      const targetDist =
        virtualDistances[virtualSlot % virtualDistances.length] ?? VIRTUAL_RIFT_MIN_DIST_M;
      virtualSlot += 1;

      const worldAngle = playerYaw + offsetRad;
      const dirX = -Math.sin(worldAngle);
      const dirZ = -Math.cos(worldAngle);

      const portalY = Math.max(1.2, corePos.y + 0.6);
      const dy = portalY - corePos.y;
      const horizRadius = Math.sqrt(Math.max(1.0, targetDist * targetDist - dy * dy));

      const position: Vec3 = {
        x: corePos.x + dirX * horizRadius,
        y: portalY,
        z: corePos.z + dirZ * horizRadius,
      };

      const tooClose = selected.some(
        (existing) => distance3D(position, existing.position) < MIN_PORTAL_SEPARATION_M * 0.85,
      );
      if (tooClose) continue;

      const normalLen = Math.hypot(-dirX, -dirZ) || 1;
      const normal: Vec3 = {
        x: -dirX / normalLen,
        y: 0,
        z: -dirZ / normalLen,
      };
      const exactDistance = distance3D(position, corePos);

      selected.push({
        id: `virtual-rift-${selected.length + 1}`,
        position,
        normal,
        width: DEFAULT_PORTAL_WIDTH,
        height: DEFAULT_PORTAL_HEIGHT,
        surfaceId: null,
        hostKind: 'virtual-rift',
        distanceFromCore: exactDistance,
      });
    }
  }

  return selected;
}

/**
 * Validates that the Core Anchor and Portal Anchors meet all safety & gameplay constraints
 * before unlocking Wave 1 (`>= 2` portals, every portal `>= 2.0 m` from Core, and all portals
 * inside the active `playArc`).
 */
export function validateCalibration(
  coreAnchor: CoreAnchor,
  portalAnchors: readonly PortalAnchor[],
  playArc?: PlayArc,
  playerYaw?: number,
): { readonly valid: boolean; readonly reason: string } {
  if (coreAnchor.radius < CORE_KEEP_OUT_RADIUS - 1e-5) {
    return {
      valid: false,
      reason: `Core keep-out radius (${coreAnchor.radius.toFixed(2)} m) is below ${CORE_KEEP_OUT_RADIUS} m.`,
    };
  }
  if (portalAnchors.length < MIN_REQUIRED_PORTALS) {
    return {
      valid: false,
      reason: `At least ${MIN_REQUIRED_PORTALS} valid rift portals are required (found ${portalAnchors.length}).`,
    };
  }
  for (const portal of portalAnchors) {
    const dist = distance3D(portal.position, coreAnchor.position);
    if (
      dist < MIN_PORTAL_CLEARANCE_M - 1e-4 ||
      portal.distanceFromCore < MIN_PORTAL_CLEARANCE_M - 1e-4
    ) {
      return {
        valid: false,
        reason: `Portal ${portal.id} (${dist.toFixed(2)} m) violates the ${MIN_PORTAL_CLEARANCE_M.toFixed(1)} m Core safety clearance.`,
      };
    }
    if (
      playArc === 'front-180' &&
      playerYaw !== undefined &&
      !isWithinPlayArc(coreAnchor.position, portal.position, playerYaw, 'front-180')
    ) {
      return {
        valid: false,
        reason: `Portal ${portal.id} lies outside the Front 180° Seated Play Arc.`,
      };
    }
  }
  return {
    valid: true,
    reason: `Core Bastion ready (${portalAnchors.length} rift portals locked >= ${MIN_PORTAL_CLEARANCE_M.toFixed(1)} m).`,
  };
}

/**
 * Builds the Three.js calibration hologram preview group:
 * - Core Anchor ring + beacon (`calibration-core-anchor`)
 * - Core keep-out ring (`0.55 m`, `calibration-core-keepout-ring`)
 * - `2.0 m` minimum portal clearance ring (`calibration-clearance-ring`)
 * - Candidate Rift Portal hologram frames (`calibration-portal-frames`)
 */
export function createCalibrationPreview(): CalibrationPreview {
  const group = new THREE.Group();
  group.name = 'calibration-preview';

  const cyanColor = new THREE.Color('#2de2ff');
  const violetColor = new THREE.Color('#9b6bff');
  const crimsonColor = new THREE.Color('#ff6b6b');

  const coreRingMat = new THREE.MeshBasicMaterial({
    color: cyanColor,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const coreRing = new THREE.Mesh(
    new THREE.RingGeometry(CORE_BASTION_SPEC.radiusM * 0.72, CORE_BASTION_SPEC.radiusM, 36),
    coreRingMat,
  );
  coreRing.name = 'calibration-core-anchor';
  coreRing.rotation.x = -Math.PI / 2;

  const coreBeacon = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.11, 0),
    new THREE.MeshBasicMaterial({
      color: violetColor,
      transparent: true,
      opacity: 0.9,
      wireframe: true,
    }),
  );
  coreBeacon.name = 'calibration-core-beacon';
  coreBeacon.position.set(0, 0, 0.32);
  coreRing.add(coreBeacon);
  group.add(coreRing);

  const keepOutMat = new THREE.MeshBasicMaterial({
    color: violetColor,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const keepOutRing = new THREE.Mesh(
    new THREE.RingGeometry(CORE_KEEP_OUT_RADIUS - 0.025, CORE_KEEP_OUT_RADIUS, 40),
    keepOutMat,
  );
  keepOutRing.name = 'calibration-core-keepout-ring';
  keepOutRing.rotation.x = -Math.PI / 2;
  group.add(keepOutRing);

  const clearanceMat = new THREE.MeshBasicMaterial({
    color: cyanColor,
    transparent: true,
    opacity: 0.45,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const clearanceRing = new THREE.Mesh(
    new THREE.RingGeometry(MIN_PORTAL_CLEARANCE_M - 0.035, MIN_PORTAL_CLEARANCE_M, 64),
    clearanceMat,
  );
  clearanceRing.name = 'calibration-clearance-ring';
  clearanceRing.rotation.x = -Math.PI / 2;
  group.add(clearanceRing);

  const portalFramesGroup = new THREE.Group();
  portalFramesGroup.name = 'calibration-portal-frames';
  group.add(portalFramesGroup);

  const portalFrameGeo = new THREE.RingGeometry(
    Math.min(DEFAULT_PORTAL_WIDTH, DEFAULT_PORTAL_HEIGHT) * 0.42,
    Math.min(DEFAULT_PORTAL_WIDTH, DEFAULT_PORTAL_HEIGHT) * 0.5,
    4,
  );
  portalFrameGeo.rotateZ(Math.PI / 4);
  const portalScaleX = DEFAULT_PORTAL_WIDTH / Math.min(DEFAULT_PORTAL_WIDTH, DEFAULT_PORTAL_HEIGHT);
  const portalScaleY =
    DEFAULT_PORTAL_HEIGHT / Math.min(DEFAULT_PORTAL_WIDTH, DEFAULT_PORTAL_HEIGHT);

  const portalWallMat = new THREE.MeshBasicMaterial({
    color: cyanColor,
    transparent: true,
    opacity: 0.8,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const portalVirtualMat = new THREE.MeshBasicMaterial({
    color: violetColor,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const portalSlots: THREE.Mesh[] = [];
  for (let i = 0; i < MAX_PORTAL_ANCHORS; i += 1) {
    const slot = new THREE.Mesh(portalFrameGeo, portalWallMat);
    slot.name = `calibration-portal-frame-${i}`;
    slot.scale.set(portalScaleX, portalScaleY, 1);
    slot.visible = false;
    portalFramesGroup.add(slot);
    portalSlots.push(slot);
  }

  const zAxis = new THREE.Vector3(0, 0, 1);
  const targetNormal = new THREE.Vector3();

  return {
    group,
    coreRing,
    keepOutRing,
    clearanceRing,
    portalFramesGroup,
    update(state) {
      const visible = state.active && !state.locked;
      group.visible = visible;

      const { x, y, z } = state.coreAnchor.position;
      coreRing.position.set(x, y + 0.004, z);
      keepOutRing.position.set(x, y + 0.003, z);
      clearanceRing.position.set(x, y + 0.002, z);

      const statusColor = state.isValid ? cyanColor : crimsonColor;
      coreRingMat.color.copy(statusColor);
      clearanceMat.color.copy(statusColor);

      for (let i = 0; i < portalSlots.length; i += 1) {
        const slot = portalSlots[i] as THREE.Mesh;
        const portal = state.portalAnchors[i];
        if (!portal) {
          slot.visible = false;
          continue;
        }
        slot.visible = true;
        slot.position.set(portal.position.x, portal.position.y, portal.position.z);
        targetNormal.set(portal.normal.x, portal.normal.y, portal.normal.z).normalize();
        if (targetNormal.lengthSq() < 1e-6) targetNormal.set(0, 0, 1);
        slot.quaternion.setFromUnitVectors(zAxis, targetNormal);
        slot.material = portal.hostKind === 'virtual-rift' ? portalVirtualMat : portalWallMat;
        slot.userData.portalId = portal.id;
        slot.userData.hostKind = portal.hostKind;
        slot.userData.distanceFromCore = portal.distanceFromCore;
      }
    },
    setVisible(visible) {
      group.visible = visible;
    },
    dispose() {
      coreRing.geometry.dispose();
      coreBeacon.geometry.dispose();
      keepOutRing.geometry.dispose();
      clearanceRing.geometry.dispose();
      portalFrameGeo.dispose();
      coreRingMat.dispose();
      (coreBeacon.material as THREE.Material).dispose();
      keepOutMat.dispose();
      clearanceMat.dispose();
      portalWallMat.dispose();
      portalVirtualMat.dispose();
    },
  };
}

function hasInitialSettingsPlayArcOverride(settingsStore: SettingsStore | undefined): boolean {
  if (!settingsStore) return false;
  if ('playArc' in settingsStore.getOverrides()) return true;
  if (settingsStore.get().playArc !== DEFAULT_SETTINGS.playArc) return true;
  try {
    if (
      typeof globalThis.localStorage !== 'undefined' &&
      globalThis.localStorage !== null &&
      globalThis.localStorage.getItem(SETTINGS_STORAGE_KEY) !== null
    ) {
      return true;
    }
  } catch {
    // Ignore storage access errors in headless tests.
  }
  return false;
}

/**
 * Stateful calibration controller orchestrating Core Bastion auto-suggestion, laser/grip relocation,
 * Play Arc (`front-180` / `full-360`) auto-detection & override, portal candidate selection,
 * `RoomSurfaceModel` surface anchoring, `ActionBus` / `SettingsStore` / `GameStateMachine` sync,
 * and the Three.js calibration hologram preview.
 */
export function createCalibrationController(
  options: CalibrationControllerOptions,
): CalibrationController {
  const { roomModel, settingsStore, actionBus, gameState } = options;
  const preview = options.preview ?? null;

  let headsetPose: HeadsetPose = options.initialHeadsetPose
    ? {
        position: cloneVec3(options.initialHeadsetPose.position),
        yaw: options.initialHeadsetPose.yaw,
      }
    : DEFAULT_HEADSET_POSE;

  let playArcOverridden =
    options.playArcOverride !== undefined || hasInitialSettingsPlayArcOverride(settingsStore);
  let explicitPlayArc: PlayArc | null =
    options.playArcOverride ??
    (playArcOverridden && settingsStore ? settingsStore.get().playArc : null);

  let posture: PlayerPosture = detectPostureFromHeight(headsetPose.position.y);
  let playArc: PlayArc = detectPlayArcFromHeight(headsetPose.position.y, explicitPlayArc);
  let active = gameState ? gameState.phase === 'calibrate' : true;
  let locked = false;
  let manuallyRelocated = false;
  let gripDragging = false;
  let isSyncingSettings = false;
  let surfaceAnchor: SurfaceAnchor | null = null;

  let coreAnchor: CoreAnchor = suggestCoreAnchor(headsetPose, roomModel.surfaces);
  let portalAnchors: readonly PortalAnchor[] = selectPortalAnchors({
    surfaces: roomModel.surfaces,
    coreAnchor,
    playerYaw: headsetPose.yaw,
    playerPosition: headsetPose.position,
    playArc,
  });

  const listeners = new Set<CalibrationListener>();
  const unsubscribers: Array<() => void> = [];

  function syncSettingsPlayArc(nextArc: PlayArc): void {
    if (!settingsStore) return;
    if (settingsStore.get().playArc === nextArc) return;
    isSyncingSettings = true;
    try {
      settingsStore.set('playArc', nextArc);
    } finally {
      isSyncingSettings = false;
    }
  }

  function syncSurfaceAnchor(): void {
    if (surfaceAnchor) {
      roomModel.detachAnchor(surfaceAnchor.id);
      surfaceAnchor = null;
    }
    if (!coreAnchor.surfaceId) return;
    const surface = roomModel.getSurface(coreAnchor.surfaceId);
    if (!surface) return;

    const invSurface = surface.worldMatrix.clone().invert();
    const localPos = new THREE.Vector3(
      coreAnchor.position.x,
      coreAnchor.position.y,
      coreAnchor.position.z,
    ).applyMatrix4(invSurface);

    surfaceAnchor = roomModel.attachAnchor(
      surface.id,
      { position: localPos },
      {
        onUpdate(updated) {
          if (!updated.tracked) return;
          const nextPos: Vec3 = {
            x: updated.worldPosition.x,
            y: updated.worldPosition.y,
            z: updated.worldPosition.z,
          };
          if (distance3D(nextPos, coreAnchor.position) > 1e-4) {
            coreAnchor = {
              ...coreAnchor,
              position: nextPos,
            };
            portalAnchors = selectPortalAnchors({
              surfaces: roomModel.surfaces,
              coreAnchor,
              playerYaw: headsetPose.yaw,
              playerPosition: headsetPose.position,
              playArc,
            });
            updatePreviewAndNotify();
          }
        },
      },
    );
  }

  function buildState(): Readonly<CalibrationState> {
    const check = validateCalibration(coreAnchor, portalAnchors, playArc, headsetPose.yaw);
    return Object.freeze({
      active,
      locked,
      posture,
      headsetPose: Object.freeze({
        position: Object.freeze(cloneVec3(headsetPose.position)),
        yaw: headsetPose.yaw,
      }),
      playArc,
      playArcOverridden,
      coreAnchor: Object.freeze({
        ...coreAnchor,
        position: Object.freeze(cloneVec3(coreAnchor.position)),
      }),
      portalAnchors,
      isValid: check.valid,
      validationMessage: check.reason,
    });
  }

  function updatePreviewAndNotify(): Readonly<CalibrationState> {
    const current = buildState();
    preview?.update(current);
    for (const listener of [...listeners]) {
      try {
        listener(current);
      } catch (error) {
        console.error('[calibration]', error);
      }
    }
    return current;
  }

  function recomputePortals(): readonly PortalAnchor[] {
    portalAnchors = selectPortalAnchors({
      surfaces: roomModel.surfaces,
      coreAnchor,
      playerYaw: headsetPose.yaw,
      playerPosition: headsetPose.position,
      playArc,
    });
    return portalAnchors;
  }

  syncSettingsPlayArc(playArc);
  syncSurfaceAnchor();
  preview?.update(buildState());

  // Subscribe to RoomSurfaceModel updates during active calibration
  unsubscribers.push(
    roomModel.subscribe(() => {
      if (!active || locked) return;
      if (!manuallyRelocated) {
        coreAnchor = suggestCoreAnchor(headsetPose, roomModel.surfaces);
        syncSurfaceAnchor();
      }
      recomputePortals();
      updatePreviewAndNotify();
    }),
  );

  // Subscribe to SettingsStore Play Arc updates
  if (settingsStore) {
    unsubscribers.push(
      settingsStore.subscribe((next, _prev, changedKeys) => {
        if (!changedKeys.includes('playArc') || isSyncingSettings) return;
        playArcOverridden = true;
        explicitPlayArc = next.playArc;
        if (playArc !== next.playArc) {
          playArc = next.playArc;
          recomputePortals();
          updatePreviewAndNotify();
        }
      }),
    );
  }

  // Subscribe to GameStateMachine transitions
  if (gameState) {
    unsubscribers.push(
      gameState.subscribe((change) => {
        if (change.to === 'calibrate') {
          active = true;
          locked = false;
          updatePreviewAndNotify();
        } else if (change.from === 'calibrate') {
          active = false;
          preview?.setVisible(false);
        }
      }),
    );
  }

  // Subscribe to shared ActionBus commands
  if (actionBus) {
    unsubscribers.push(
      actionBus.on('calibrate/begin', () => {
        if (gameState && gameState.phase !== 'calibrate' && gameState.can('calibrate')) {
          gameState.transition('calibrate', 'calibrate/begin');
        }
        controller.beginCalibration();
      }),
      actionBus.on('calibrate/move-core', (action) => {
        controller.moveCoreToPoint(action.position);
      }),
      actionBus.on('calibrate/set-play-arc', (action) => {
        controller.setPlayArc(action.arc);
      }),
      actionBus.on('calibrate/confirm', () => {
        controller.confirmLockCore();
      }),
      actionBus.on('settings/change', (action) => {
        if (
          action.key === 'playArc' &&
          (action.value === 'front-180' || action.value === 'full-360')
        ) {
          controller.setPlayArc(action.value);
        }
      }),
    );
  }

  const controller: CalibrationController = {
    get state() {
      return buildState();
    },
    get coreAnchor() {
      return coreAnchor;
    },
    get portalAnchors() {
      return portalAnchors;
    },
    get playArc() {
      return playArc;
    },
    get isValid() {
      return validateCalibration(coreAnchor, portalAnchors, playArc, headsetPose.yaw).valid;
    },
    get locked() {
      return locked;
    },
    get surfaceAnchor() {
      return surfaceAnchor;
    },
    get preview() {
      return preview;
    },
    beginCalibration(nextHeadsetPose, beginOptions) {
      if (nextHeadsetPose) {
        headsetPose = {
          position: cloneVec3(nextHeadsetPose.position),
          yaw: nextHeadsetPose.yaw,
        };
      }
      if (beginOptions?.resetPlayArcOverride) {
        playArcOverridden = false;
        explicitPlayArc = null;
      }
      if (beginOptions?.playArcOverride) {
        playArcOverridden = true;
        explicitPlayArc = beginOptions.playArcOverride;
      }

      posture = detectPostureFromHeight(headsetPose.position.y);
      playArc = detectPlayArcFromHeight(
        headsetPose.position.y,
        playArcOverridden ? explicitPlayArc : null,
      );
      syncSettingsPlayArc(playArc);

      active = true;
      locked = false;
      manuallyRelocated = false;
      gripDragging = false;
      coreAnchor = suggestCoreAnchor(headsetPose, roomModel.surfaces);
      syncSurfaceAnchor();
      recomputePortals();
      return updatePreviewAndNotify();
    },
    autoSuggestCore(nextHeadsetPose) {
      if (nextHeadsetPose) {
        headsetPose = {
          position: cloneVec3(nextHeadsetPose.position),
          yaw: nextHeadsetPose.yaw,
        };
      }
      manuallyRelocated = false;
      coreAnchor = suggestCoreAnchor(headsetPose, roomModel.surfaces);
      syncSurfaceAnchor();
      recomputePortals();
      updatePreviewAndNotify();
      return coreAnchor;
    },
    moveCoreToPoint(position, moveOptions) {
      if (locked) return coreAnchor;
      manuallyRelocated = true;
      coreAnchor = clampCoreToSurfaces(position, roomModel.surfaces, headsetPose, moveOptions);
      syncSurfaceAnchor();
      recomputePortals();
      updatePreviewAndNotify();
      return coreAnchor;
    },
    moveCoreByRay(rayOrigin, rayDirection) {
      if (locked) return coreAnchor;
      manuallyRelocated = true;
      coreAnchor = raycastCorePlacement(
        rayOrigin,
        rayDirection,
        roomModel.surfaces,
        headsetPose,
        coreAnchor,
      );
      syncSurfaceAnchor();
      recomputePortals();
      updatePreviewAndNotify();
      return coreAnchor;
    },
    beginGripDrag() {
      if (locked) return;
      gripDragging = true;
    },
    updateGripDrag(handPosition) {
      if (locked || !gripDragging) return coreAnchor;
      return controller.moveCoreToPoint(handPosition);
    },
    endGripDrag() {
      gripDragging = false;
    },
    setPlayArc(arc) {
      playArcOverridden = true;
      explicitPlayArc = arc;
      playArc = arc;
      syncSettingsPlayArc(arc);
      recomputePortals();
      return updatePreviewAndNotify();
    },
    refreshPortals() {
      recomputePortals();
      updatePreviewAndNotify();
      return portalAnchors;
    },
    confirmLockCore() {
      const check = validateCalibration(coreAnchor, portalAnchors, playArc, headsetPose.yaw);
      if (!check.valid) {
        updatePreviewAndNotify();
        return false;
      }
      locked = true;
      active = false;
      gripDragging = false;
      updatePreviewAndNotify();
      preview?.setVisible(false);
      if (gameState && gameState.phase === 'calibrate' && gameState.can('prep')) {
        gameState.transition('prep', 'core-locked');
      }
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      for (const unsub of unsubscribers.splice(0)) unsub();
      if (surfaceAnchor) {
        roomModel.detachAnchor(surfaceAnchor.id);
        surfaceAnchor = null;
      }
      listeners.clear();
    },
  };

  return controller;
}
