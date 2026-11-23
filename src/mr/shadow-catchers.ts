/**
 * Real-world horizontal shadow-catcher planes for Rift Bastion (PRD D5, P1-T2).
 *
 * Binds lightweight `THREE.ShadowMaterial` planes to scanned horizontal floors and tables
 * (and virtual fallback surfaces) so turrets, Core, and invaders cast grounding directional
 * shadows onto real-world furniture with:
 * - zero darkening of unshadowed passthrough pixels (`ShadowMaterial` outputs alpha 0 when lit),
 * - configurable shadow opacity,
 * - `polygonOffset` + tiny elevation offset to eliminate z-fighting against floor occluders and
 *   virtual fallback geometry,
 * - incremental surface sync and complete geometry/material disposal.
 */
import * as THREE from 'three';

export type ShadowSurfaceKind = 'floor' | 'table' | 'wall' | 'ceiling' | 'other';

export interface ShadowCatcherPolygonPoint {
  readonly x: number;
  readonly z: number;
}

/**
 * Minimal surface-input interface designed to compose directly with `RoomSurfaceModel`
 * entries from `src/mr/room-scan.ts` without tight coupling.
 */
export interface ShadowCatcherSurface {
  readonly id: string;
  readonly kind: ShadowSurfaceKind;
  readonly source?: 'plane' | 'mesh' | 'virtual';
  readonly revision: number;
  readonly visible?: boolean;
  /** Local-to-world transform (for planes: local XZ plane, +Y normal). */
  readonly worldMatrix: THREE.Matrix4;
  /** Optional world-space outward normal (derived from worldMatrix +Y when omitted). */
  readonly normal?: THREE.Vector3;
  /** Planar boundary vertices in local XZ coordinates. */
  readonly polygon?: readonly ShadowCatcherPolygonPoint[];
  /** Optional triangle mesh vertices in local xyz triplets. */
  readonly vertices?: Float32Array | readonly number[];
  /** Raw mesh-local vertex transform when it differs from the fitted polygon basis. */
  readonly meshWorldMatrix?: THREE.Matrix4;
  /** Optional triangle indices into `vertices`. */
  readonly indices?: Uint32Array | Uint16Array | readonly number[];
}

export interface ShadowCatcherOptions {
  /** Shadow darkness opacity in `[0, 1]` (default `0.42`). */
  opacity?: number;
  /** Shadow tint color (default black `0x000000`). */
  color?: THREE.ColorRepresentation;
  /** `polygonOffsetFactor` to prevent z-fighting with room occluders/virtual floor (default `-2`). */
  polygonOffsetFactor?: number;
  /** `polygonOffsetUnits` to prevent z-fighting with room occluders/virtual floor (default `-2`). */
  polygonOffsetUnits?: number;
  /** Small upward world-Y offset in meters (default `0.001` = 1 mm) to avoid coplanar artifacts. */
  elevationOffset?: number;
  /** Minimum `|normal.y|` to consider a surface horizontal (default `0.85`). */
  minHorizontalNormalY?: number;
  /** Surface kinds eligible to receive shadow catchers (default `['floor', 'table']`). */
  acceptedKinds?: readonly ShadowSurfaceKind[];
  /** Render order for shadow-catcher meshes (default `-5`). */
  renderOrder?: number;
  /** Initial visibility (default `true`). */
  enabled?: boolean;
}

export interface ShadowCatcherSyncStats {
  readonly created: number;
  readonly updated: number;
  readonly removed: number;
  readonly activeCount: number;
}

export interface ShadowCatcherManager {
  readonly root: THREE.Group;
  readonly material: THREE.ShadowMaterial;
  readonly count: number;
  readonly enabled: boolean;
  readonly opacity: number;
  sync(surfaces: Iterable<ShadowCatcherSurface>): ShadowCatcherSyncStats;
  getMesh(surfaceId: string): THREE.Mesh | undefined;
  getSurfaceIds(): string[];
  setOpacity(opacity: number): void;
  setEnabled(enabled: boolean): void;
  setPolygonOffset(factor: number, units: number): void;
  clear(): void;
  dispose(): void;
}

export const DEFAULT_SHADOW_OPACITY = 0.42;
export const DEFAULT_SHADOW_POLYGON_OFFSET_FACTOR = -2;
export const DEFAULT_SHADOW_POLYGON_OFFSET_UNITS = -2;
export const DEFAULT_SHADOW_ELEVATION_OFFSET = 0.001;
export const DEFAULT_MIN_HORIZONTAL_NORMAL_Y = 0.85;
export const SHADOW_CATCHER_RENDER_ORDER = -5;
export const DEFAULT_ACCEPTED_SHADOW_KINDS: readonly ShadowSurfaceKind[] = Object.freeze([
  'floor',
  'table',
]);

const DEGENERATE_AREA_SQ = 1e-12;

const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _edge1 = new THREE.Vector3();
const _edge2 = new THREE.Vector3();
const _triNormal = new THREE.Vector3();
const _surfaceNormal = new THREE.Vector3();

function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SHADOW_OPACITY;
  return Math.min(1, Math.max(0, value));
}

function resolveSurfaceNormalY(surface: ShadowCatcherSurface): number {
  if (surface.normal && surface.normal.lengthSq() > 1e-12) {
    _surfaceNormal.copy(surface.normal).normalize();
    return Math.abs(_surfaceNormal.y);
  }
  _surfaceNormal.setFromMatrixColumn(surface.worldMatrix, 1);
  if (_surfaceNormal.lengthSq() <= 1e-12) return 0;
  _surfaceNormal.normalize();
  return Math.abs(_surfaceNormal.y);
}

/**
 * Checks whether a scanned or virtual room surface should receive a horizontal shadow catcher.
 */
export function isEligibleShadowSurface(
  surface: ShadowCatcherSurface,
  options: {
    acceptedKinds?: readonly ShadowSurfaceKind[];
    minHorizontalNormalY?: number;
  } = {},
): boolean {
  const acceptedKinds = options.acceptedKinds ?? DEFAULT_ACCEPTED_SHADOW_KINDS;
  const minHorizontalNormalY = options.minHorizontalNormalY ?? DEFAULT_MIN_HORIZONTAL_NORMAL_Y;
  if (!acceptedKinds.includes(surface.kind)) return false;

  // Mesh surfaces may contain mixed horizontal and vertical faces; check upward faces during build.
  if (surface.vertices && surface.indices && surface.indices.length >= 3) {
    return true;
  }

  if (!surface.polygon || surface.polygon.length < 3) return false;
  return resolveSurfaceNormalY(surface) >= minHorizontalNormalY;
}

/**
 * Builds an upward-facing world-space `BufferGeometry` for a horizontal floor/table shadow catcher.
 * Returns `null` if the surface contains no valid horizontal triangles.
 */
export function buildShadowCatcherGeometry(
  surface: ShadowCatcherSurface,
  options: {
    minHorizontalNormalY?: number;
    elevationOffset?: number;
  } = {},
): THREE.BufferGeometry | null {
  const minHorizontalNormalY = options.minHorizontalNormalY ?? DEFAULT_MIN_HORIZONTAL_NORMAL_Y;
  const elevationOffset = options.elevationOffset ?? DEFAULT_SHADOW_ELEVATION_OFFSET;

  const positions: number[] = [];
  const normals: number[] = [];

  const pushHorizontalTriangle = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    allowDownwardWindingFlip: boolean,
  ): void => {
    _edge1.subVectors(b, a);
    _edge2.subVectors(c, a);
    _triNormal.crossVectors(_edge1, _edge2);
    const lenSq = _triNormal.lengthSq();
    if (lenSq <= DEGENERATE_AREA_SQ) return;
    _triNormal.multiplyScalar(1 / Math.sqrt(lenSq));

    if (allowDownwardWindingFlip) {
      if (Math.abs(_triNormal.y) < minHorizontalNormalY) return;
    } else if (_triNormal.y < minHorizontalNormalY) {
      return;
    }

    // Orient winding so FrontSide always faces upward (+Y) toward overhead directional lights.
    const flip = _triNormal.y < 0;
    const p1 = flip ? c : b;
    const p2 = flip ? b : c;
    if (flip) _triNormal.negate();

    positions.push(
      a.x,
      a.y + elevationOffset,
      a.z,
      p1.x,
      p1.y + elevationOffset,
      p1.z,
      p2.x,
      p2.y + elevationOffset,
      p2.z,
    );
    normals.push(
      _triNormal.x,
      _triNormal.y,
      _triNormal.z,
      _triNormal.x,
      _triNormal.y,
      _triNormal.z,
      _triNormal.x,
      _triNormal.y,
      _triNormal.z,
    );
  };

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
    if (contour.length >= 3) {
      const faces = THREE.ShapeUtils.triangulateShape(contour, []);
      for (const face of faces) {
        const p0 = contour[face[0] as number] as THREE.Vector2;
        const p1 = contour[face[1] as number] as THREE.Vector2;
        const p2 = contour[face[2] as number] as THREE.Vector2;
        _vA.set(p0.x, 0, p0.y).applyMatrix4(surface.worldMatrix);
        _vB.set(p1.x, 0, p1.y).applyMatrix4(surface.worldMatrix);
        _vC.set(p2.x, 0, p2.y).applyMatrix4(surface.worldMatrix);
        pushHorizontalTriangle(_vA, _vB, _vC, true);
      }
    }
  } else if (surface.vertices && surface.indices && surface.indices.length >= 3) {
    const { vertices, indices } = surface;
    const worldMatrix = surface.meshWorldMatrix ?? surface.worldMatrix;
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const ia = (indices[i] as number) * 3;
      const ib = (indices[i + 1] as number) * 3;
      const ic = (indices[i + 2] as number) * 3;
      if (ia + 2 >= vertices.length || ib + 2 >= vertices.length || ic + 2 >= vertices.length) {
        continue;
      }
      _vA
        .set(vertices[ia] as number, vertices[ia + 1] as number, vertices[ia + 2] as number)
        .applyMatrix4(worldMatrix);
      _vB
        .set(vertices[ib] as number, vertices[ib + 1] as number, vertices[ib + 2] as number)
        .applyMatrix4(worldMatrix);
      _vC
        .set(vertices[ic] as number, vertices[ic + 1] as number, vertices[ic + 2] as number)
        .applyMatrix4(worldMatrix);
      pushHorizontalTriangle(_vA, _vB, _vC, false);
    }
  }

  if (positions.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

interface CatcherEntry {
  readonly mesh: THREE.Mesh;
  revision: number;
}

interface HorizontalSurfaceBounds {
  readonly kind: ShadowSurfaceKind;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly avgY: number;
}

const COPLANAR_SHADOW_Y_TOLERANCE_M = 0.08;

function estimateHorizontalBounds(surface: ShadowCatcherSurface): HorizontalSurfaceBounds | null {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let sumY = 0;
  let count = 0;

  if (surface.polygon && surface.polygon.length >= 3) {
    for (const pt of surface.polygon) {
      _vA.set(pt.x, 0, pt.z).applyMatrix4(surface.worldMatrix);
      if (_vA.x < minX) minX = _vA.x;
      if (_vA.x > maxX) maxX = _vA.x;
      if (_vA.z < minZ) minZ = _vA.z;
      if (_vA.z > maxZ) maxZ = _vA.z;
      sumY += _vA.y;
      count += 1;
    }
  } else if (surface.vertices && surface.vertices.length >= 9) {
    const worldMatrix = surface.meshWorldMatrix ?? surface.worldMatrix;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let i = 0; i + 2 < surface.vertices.length; i += 3) {
      _vA
        .set(
          surface.vertices[i] as number,
          surface.vertices[i + 1] as number,
          surface.vertices[i + 2] as number,
        )
        .applyMatrix4(worldMatrix);
      if (_vA.x < minX) minX = _vA.x;
      if (_vA.x > maxX) maxX = _vA.x;
      if (_vA.z < minZ) minZ = _vA.z;
      if (_vA.z > maxZ) maxZ = _vA.z;
      if (_vA.y > maxY) maxY = _vA.y;
      count += 1;
    }
    if (count > 0 && Number.isFinite(maxY)) {
      return { kind: surface.kind, minX, maxX, minZ, maxZ, avgY: maxY };
    }
  }

  if (count === 0) return null;
  return { kind: surface.kind, minX, maxX, minZ, maxZ, avgY: sumY / count };
}

function overlapsCoplanarPlane(
  candidate: HorizontalSurfaceBounds,
  planes: readonly HorizontalSurfaceBounds[],
): boolean {
  for (const plane of planes) {
    if (plane.kind !== candidate.kind) continue;
    if (Math.abs(plane.avgY - candidate.avgY) > COPLANAR_SHADOW_Y_TOLERANCE_M) continue;
    const overlapX =
      Math.min(plane.maxX, candidate.maxX) - Math.max(plane.minX, candidate.minX) > 0.05;
    const overlapZ =
      Math.min(plane.maxZ, candidate.maxZ) - Math.max(plane.minZ, candidate.minZ) > 0.05;
    if (overlapX && overlapZ) return true;
  }
  return false;
}

export function createShadowCatcherManager(
  options: ShadowCatcherOptions = {},
): ShadowCatcherManager {
  const acceptedKinds = options.acceptedKinds ?? DEFAULT_ACCEPTED_SHADOW_KINDS;
  const minHorizontalNormalY = options.minHorizontalNormalY ?? DEFAULT_MIN_HORIZONTAL_NORMAL_Y;
  const elevationOffset = options.elevationOffset ?? DEFAULT_SHADOW_ELEVATION_OFFSET;
  const renderOrder = options.renderOrder ?? SHADOW_CATCHER_RENDER_ORDER;

  const root = new THREE.Group();
  root.name = 'mr-shadow-catchers';
  root.visible = options.enabled ?? true;

  // ShadowMaterial renders transparent (alpha = 0) wherever pixels are unshadowed, guaranteeing
  // zero darkening of passthrough pixels while projecting crisp directional shadows on floors/tables.
  const material = new THREE.ShadowMaterial({
    color: options.color ?? 0x000000,
    opacity: clampOpacity(options.opacity ?? DEFAULT_SHADOW_OPACITY),
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: options.polygonOffsetFactor ?? DEFAULT_SHADOW_POLYGON_OFFSET_FACTOR,
    polygonOffsetUnits: options.polygonOffsetUnits ?? DEFAULT_SHADOW_POLYGON_OFFSET_UNITS,
  });

  const entries = new Map<string, CatcherEntry>();
  let disposed = false;

  function removeEntry(id: string): void {
    const entry = entries.get(id);
    if (!entry) return;
    root.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    entries.delete(id);
  }

  return {
    root,
    material,
    get count() {
      return entries.size;
    },
    get enabled() {
      return root.visible;
    },
    get opacity() {
      return material.opacity;
    },

    sync(surfaces) {
      if (disposed) {
        return { created: 0, updated: 0, removed: 0, activeCount: 0 };
      }

      const eligible: ShadowCatcherSurface[] = [];
      const planeBounds: HorizontalSurfaceBounds[] = [];
      for (const surface of surfaces) {
        if (!isEligibleShadowSurface(surface, { acceptedKinds, minHorizontalNormalY })) {
          continue;
        }
        eligible.push(surface);
        if (surface.source === 'plane' && surface.visible !== false) {
          const b = estimateHorizontalBounds(surface);
          if (b) planeBounds.push(b);
        }
      }

      const seen = new Set<string>();
      let created = 0;
      let updated = 0;
      let removed = 0;

      for (const surface of eligible) {
        // Quest reports both XRPlane and XRMesh for the same floor/table; skip the overlapping
        // mesh shadow catcher when a coplanar plane already owns that elevation.
        if (surface.source === 'mesh' && planeBounds.length > 0) {
          const mb = estimateHorizontalBounds(surface);
          if (mb && overlapsCoplanarPlane(mb, planeBounds)) {
            continue;
          }
        }
        seen.add(surface.id);

        const existing = entries.get(surface.id);
        if (!existing) {
          const geometry = buildShadowCatcherGeometry(surface, {
            minHorizontalNormalY,
            elevationOffset,
          });
          if (!geometry) {
            seen.delete(surface.id);
            continue;
          }
          const mesh = new THREE.Mesh(geometry, material);
          mesh.name = `shadow-catcher:${surface.id}`;
          mesh.receiveShadow = true;
          mesh.castShadow = false;
          mesh.renderOrder = renderOrder;
          mesh.visible = surface.visible ?? true;
          root.add(mesh);
          entries.set(surface.id, { mesh, revision: surface.revision });
          created += 1;
        } else if (existing.revision !== surface.revision) {
          const geometry = buildShadowCatcherGeometry(surface, {
            minHorizontalNormalY,
            elevationOffset,
          });
          if (!geometry) {
            seen.delete(surface.id);
            removeEntry(surface.id);
            removed += 1;
            continue;
          }
          existing.mesh.geometry.dispose();
          existing.mesh.geometry = geometry;
          existing.mesh.visible = surface.visible ?? true;
          existing.revision = surface.revision;
          updated += 1;
        } else {
          existing.mesh.visible = surface.visible ?? true;
        }
      }

      for (const id of [...entries.keys()]) {
        if (!seen.has(id)) {
          removeEntry(id);
          removed += 1;
        }
      }

      return {
        created,
        updated,
        removed,
        activeCount: entries.size,
      };
    },

    getMesh(surfaceId) {
      return entries.get(surfaceId)?.mesh;
    },

    getSurfaceIds() {
      return [...entries.keys()];
    },

    setOpacity(opacity) {
      if (disposed) return;
      material.opacity = clampOpacity(opacity);
    },

    setEnabled(enabled) {
      if (disposed) return;
      root.visible = enabled;
    },

    setPolygonOffset(factor, units) {
      if (disposed) return;
      material.polygonOffset = true;
      material.polygonOffsetFactor = factor;
      material.polygonOffsetUnits = units;
    },

    clear() {
      for (const id of [...entries.keys()]) {
        removeEntry(id);
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of [...entries.keys()]) {
        removeEntry(id);
      }
      material.dispose();
      root.removeFromParent();
    },
  };
}
