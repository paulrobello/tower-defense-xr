/**
 * Zero-allocation-friendly 3D spatial hash grid (`SpatialHash3D<T>`) for fast radius and
 * neighbor queries:
 * - Turret target acquisition within `rangeM`
 * - Plasma Mortar AoE splash damage radius (`aoeRadiusM`)
 * - Cryo-Arc chain-lightning target jumps (`chainJumpRadiusM`)
 * - Rift Disruptor EMP field radius (`1.2 m`) & Apex Broodlord suppression pulse radius (`1.5 m`)
 *
 * Design notes:
 * - Each item is inserted into the single 3D cell containing its center point, while the grid
 *   tracks `maxItemRadiusM`. Radius queries expand the searched cell AABB by `radiusM + maxItemRadiusM`,
 *   guaranteeing every candidate is visited at most once without needing per-query `Set` allocations.
 * - Cell keys pack signed 10-bit `(ix, iy, iz)` coordinates (`[-512, 511]`) into a 30-bit SMI integer
 *   so `Map<number, T[]>` lookups allocate zero strings.
 * - Cell bucket arrays are recycled through an internal pool (`bucketPool`) on `clear()`, so
 *   per-tick rebuilds allocate zero arrays after warm-up.
 *
 * STRICT INVARIANT: Pure TypeScript — ZERO Three.js and ZERO WASM imports.
 */

import type { Vec3 } from '../content/turrets.ts';

export type { Vec3 };

/** Default spatial hash cell size in meters (`1.0 m` balances room-scale turret & AoE radii). */
export const DEFAULT_SPATIAL_HASH_CELL_SIZE_M = 1.0;

const COORD_BIAS = 512;
const COORD_MASK = 0x3ff;
const COORD_MIN = -512;
const COORD_MAX = 511;
const DIST_EPSILON = 1e-7;

export type PositionExtractor<T> = (item: T) => Readonly<Vec3>;
export type RadiusExtractor<T> = (item: T) => number;
export type SpatialQueryFilter<T> = (item: T, distanceSq: number) => boolean;

export interface SpatialHash3DOptions<T> {
  /** Edge length of each cubic grid cell in meters (default `1.0`). */
  readonly cellSizeM?: number;
  /** Extracts the 3D position of an item (defaults to `item.position` or `item` as `Vec3`). */
  readonly getPosition?: PositionExtractor<T>;
  /** Extracts the optional bounding radius of an item in meters (defaults to `item.collisionRadiusM ?? item.radiusM ?? 0`). */
  readonly getRadius?: RadiusExtractor<T>;
}

export interface SpatialQueryOptions<T> {
  /** Optional filter predicate evaluated on each candidate inside the radius. */
  readonly filter?: SpatialQueryFilter<T>;
  /**
   * When `true`, expands each item's effective hit distance by its extracted radius
   * (`distance(center, itemPos) <= radiusM + itemRadiusM`). Defaults to `false` (exact center distance).
   */
  readonly includeItemRadius?: boolean;
  /** Optional caller-supplied output array cleared and populated in place for zero-allocation queries. */
  readonly out?: T[];
}

interface EntryRecord<T> {
  item: T;
  x: number;
  y: number;
  z: number;
  radiusM: number;
}

function defaultGetPosition<T>(item: T): Readonly<Vec3> {
  const candidate = item as unknown as { readonly position?: Readonly<Vec3> } & Readonly<Vec3>;
  if (candidate && typeof candidate === 'object' && 'position' in candidate && candidate.position) {
    return candidate.position;
  }
  return candidate;
}

function defaultGetRadius<T>(item: T): number {
  const candidate = item as unknown as {
    readonly collisionRadiusM?: number;
    readonly radiusM?: number;
    readonly radius?: number;
  };
  if (!candidate || typeof candidate !== 'object') return 0;
  if (
    typeof candidate.collisionRadiusM === 'number' &&
    Number.isFinite(candidate.collisionRadiusM)
  ) {
    return Math.max(0, candidate.collisionRadiusM);
  }
  if (typeof candidate.radiusM === 'number' && Number.isFinite(candidate.radiusM)) {
    return Math.max(0, candidate.radiusM);
  }
  if (typeof candidate.radius === 'number' && Number.isFinite(candidate.radius)) {
    return Math.max(0, candidate.radius);
  }
  return 0;
}

function clampCellCoord(coord: number): number {
  if (coord < COORD_MIN) return COORD_MIN;
  if (coord > COORD_MAX) return COORD_MAX;
  return coord | 0;
}

/**
 * Packs 3 signed integer cell coordinates `(ix, iy, iz)` into a 30-bit unsigned integer key.
 */
export function packCellKey3D(ix: number, iy: number, iz: number): number {
  const cx = (clampCellCoord(ix) + COORD_BIAS) & COORD_MASK;
  const cy = (clampCellCoord(iy) + COORD_BIAS) & COORD_MASK;
  const cz = (clampCellCoord(iz) + COORD_BIAS) & COORD_MASK;
  return cx | (cy << 10) | (cz << 20);
}

/**
 * Unpacks a 30-bit cell key back into `{ ix, iy, iz }` cell coordinates.
 */
export function unpackCellKey3D(key: number): {
  readonly ix: number;
  readonly iy: number;
  readonly iz: number;
} {
  const ix = (key & COORD_MASK) - COORD_BIAS;
  const iy = ((key >> 10) & COORD_MASK) - COORD_BIAS;
  const iz = ((key >> 20) & COORD_MASK) - COORD_BIAS;
  return { ix, iy, iz };
}

export class SpatialHash3D<T> {
  readonly cellSizeM: number;
  private readonly invCellSizeM: number;
  private readonly getPosition: PositionExtractor<T>;
  private readonly getRadius: RadiusExtractor<T>;

  /** Map from packed 30-bit integer cell key to pooled bucket array of entry indices. */
  private readonly cells = new Map<number, number[]>();
  /** Recycled bucket arrays to avoid per-tick array allocations. */
  private readonly bucketPool: number[][] = [];
  /** Contiguous pooled entry records for cache-friendly coordinate access. */
  private readonly entries: EntryRecord<T>[] = [];
  private entryCount = 0;
  private maxItemRadiusM = 0;

  constructor(
    optionsOrCellSize: SpatialHash3DOptions<T> | number = DEFAULT_SPATIAL_HASH_CELL_SIZE_M,
    getPositionArg?: PositionExtractor<T>,
    getRadiusArg?: RadiusExtractor<T>,
  ) {
    if (typeof optionsOrCellSize === 'number') {
      const validCellSize =
        Number.isFinite(optionsOrCellSize) && optionsOrCellSize > 0
          ? optionsOrCellSize
          : DEFAULT_SPATIAL_HASH_CELL_SIZE_M;
      this.cellSizeM = validCellSize;
      this.invCellSizeM = 1 / validCellSize;
      this.getPosition = getPositionArg ?? defaultGetPosition;
      this.getRadius = getRadiusArg ?? defaultGetRadius;
    } else {
      const rawSize = optionsOrCellSize.cellSizeM ?? DEFAULT_SPATIAL_HASH_CELL_SIZE_M;
      const validCellSize =
        Number.isFinite(rawSize) && rawSize > 0 ? rawSize : DEFAULT_SPATIAL_HASH_CELL_SIZE_M;
      this.cellSizeM = validCellSize;
      this.invCellSizeM = 1 / validCellSize;
      this.getPosition = optionsOrCellSize.getPosition ?? getPositionArg ?? defaultGetPosition;
      this.getRadius = optionsOrCellSize.getRadius ?? getRadiusArg ?? defaultGetRadius;
    }
  }

  /** Total number of items currently stored in the spatial hash. */
  get size(): number {
    return this.entryCount;
  }

  /** Number of non-empty 3D grid cells currently active. */
  get activeCellCount(): number {
    return this.cells.size;
  }

  /** Maximum item radius observed since the last `clear()`. */
  get maxObservedRadiusM(): number {
    return this.maxItemRadiusM;
  }

  /** Converts a world-space coordinate component to its integer grid cell coordinate. */
  worldToCellCoord(value: number): number {
    return clampCellCoord(Math.floor(value * this.invCellSizeM));
  }

  /** Computes the packed 30-bit cell key for a 3D world position. */
  cellKeyForPosition(pos: Readonly<Vec3>): number {
    return packCellKey3D(
      this.worldToCellCoord(pos.x),
      this.worldToCellCoord(pos.y),
      this.worldToCellCoord(pos.z),
    );
  }

  /**
   * Clears all items and recycles every active cell bucket back into `bucketPool`
   * without allocating or freeing arrays.
   */
  clear(): void {
    for (const bucket of this.cells.values()) {
      bucket.length = 0;
      this.bucketPool.push(bucket);
    }
    this.cells.clear();
    this.entryCount = 0;
    this.maxItemRadiusM = 0;
  }

  /**
   * Inserts one item into the spatial hash grid in O(1) time.
   */
  insert(item: T, explicitPosition?: Readonly<Vec3>, explicitRadiusM?: number): void {
    const pos = explicitPosition ?? this.getPosition(item);
    const radiusM =
      explicitRadiusM !== undefined
        ? Math.max(0, explicitRadiusM)
        : Math.max(0, this.getRadius(item));

    if (radiusM > this.maxItemRadiusM) {
      this.maxItemRadiusM = radiusM;
    }

    const index = this.entryCount;
    this.entryCount += 1;

    const existingRecord = this.entries[index];
    if (existingRecord) {
      existingRecord.item = item;
      existingRecord.x = pos.x;
      existingRecord.y = pos.y;
      existingRecord.z = pos.z;
      existingRecord.radiusM = radiusM;
    } else {
      this.entries.push({
        item,
        x: pos.x,
        y: pos.y,
        z: pos.z,
        radiusM,
      });
    }

    const key = this.cellKeyForPosition(pos);
    let bucket = this.cells.get(key);
    if (!bucket) {
      bucket = this.bucketPool.pop() ?? [];
      this.cells.set(key, bucket);
    }
    bucket.push(index);
  }

  /**
   * Inserts a batch of items into the spatial hash grid.
   */
  insertAll(items: readonly T[]): void {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item !== undefined) {
        this.insert(item);
      }
    }
  }

  /**
   * Clears the grid and inserts all items from `items`.
   */
  rebuild(items: readonly T[]): void {
    this.clear();
    this.insertAll(items);
  }

  /**
   * Removes an item from the spatial hash grid. Returns `true` if found and removed.
   */
  remove(item: T, hintPosition?: Readonly<Vec3>): boolean {
    if (this.entryCount === 0) return false;

    if (hintPosition) {
      const key = this.cellKeyForPosition(hintPosition);
      const bucket = this.cells.get(key);
      if (bucket && this.removeFromBucket(bucket, key, item)) {
        return true;
      }
    }

    for (const [key, bucket] of this.cells.entries()) {
      if (this.removeFromBucket(bucket, key, item)) {
        return true;
      }
    }
    return false;
  }

  private removeFromBucket(bucket: number[], key: number, targetItem: T): boolean {
    for (let i = 0; i < bucket.length; i += 1) {
      const entryIdx = bucket[i] as number;
      const entry = this.entries[entryIdx];
      if (entry && entry.item === targetItem) {
        bucket.splice(i, 1);
        if (bucket.length === 0) {
          this.cells.delete(key);
          this.bucketPool.push(bucket);
        }
        this.entryCount = Math.max(0, this.entryCount - 1);
        return true;
      }
    }
    return false;
  }

  /**
   * Zero-allocation iteration over all items within `radiusM` of `center`.
   */
  forEachInRadius(
    center: Readonly<Vec3>,
    radiusM: number,
    callback: (item: T, distanceSq: number) => void,
    includeItemRadius = false,
  ): void {
    if (this.entryCount === 0 || !Number.isFinite(radiusM) || radiusM < 0) {
      return;
    }

    const searchPad = includeItemRadius ? radiusM + this.maxItemRadiusM : radiusM;
    const minIx = this.worldToCellCoord(center.x - searchPad);
    const maxIx = this.worldToCellCoord(center.x + searchPad);
    const minIy = this.worldToCellCoord(center.y - searchPad);
    const maxIy = this.worldToCellCoord(center.y + searchPad);
    const minIz = this.worldToCellCoord(center.z - searchPad);
    const maxIz = this.worldToCellCoord(center.z + searchPad);

    const baseLimitSq = (radiusM + DIST_EPSILON) * (radiusM + DIST_EPSILON);

    for (let iz = minIz; iz <= maxIz; iz += 1) {
      const czPart = ((iz + COORD_BIAS) & COORD_MASK) << 20;
      for (let iy = minIy; iy <= maxIy; iy += 1) {
        const cyzPart = czPart | (((iy + COORD_BIAS) & COORD_MASK) << 10);
        for (let ix = minIx; ix <= maxIx; ix += 1) {
          const key = cyzPart | ((ix + COORD_BIAS) & COORD_MASK);
          const bucket = this.cells.get(key);
          if (!bucket) continue;

          for (let b = 0; b < bucket.length; b += 1) {
            const entryIdx = bucket[b] as number;
            const entry = this.entries[entryIdx];
            if (!entry) continue;

            const dx = entry.x - center.x;
            const dy = entry.y - center.y;
            const dz = entry.z - center.z;
            const distSq = dx * dx + dy * dy + dz * dz;

            if (includeItemRadius && entry.radiusM > 0) {
              const effR = radiusM + entry.radiusM + DIST_EPSILON;
              if (distSq <= effR * effR) {
                callback(entry.item, distSq);
              }
            } else if (distSq <= baseLimitSq) {
              callback(entry.item, distSq);
            }
          }
        }
      }
    }
  }

  /**
   * Queries all items within `radiusM` of `center`.
   *
   * Supports flexible call forms:
   * - `queryRadius(center, radiusM)`
   * - `queryRadius(center, radiusM, filterFn)`
   * - `queryRadius(center, radiusM, outArray, filterFn?)`
   * - `queryRadius(center, radiusM, { filter?, includeItemRadius?, out? })`
   */
  queryRadius(
    center: Readonly<Vec3>,
    radiusM: number,
    optionsOrOutOrFilter?: T[] | SpatialQueryFilter<T> | SpatialQueryOptions<T>,
    filterArg?: SpatialQueryFilter<T>,
  ): T[] {
    let out: T[];
    let filter: SpatialQueryFilter<T> | undefined = filterArg;
    let includeItemRadius = false;

    if (Array.isArray(optionsOrOutOrFilter)) {
      out = optionsOrOutOrFilter;
      out.length = 0;
    } else if (typeof optionsOrOutOrFilter === 'function') {
      out = [];
      filter = optionsOrOutOrFilter;
    } else if (optionsOrOutOrFilter && typeof optionsOrOutOrFilter === 'object') {
      out = optionsOrOutOrFilter.out ?? [];
      out.length = 0;
      filter = optionsOrOutOrFilter.filter ?? filterArg;
      includeItemRadius = optionsOrOutOrFilter.includeItemRadius ?? false;
    } else {
      out = [];
    }

    this.forEachInRadius(
      center,
      radiusM,
      (item, distSq) => {
        if (!filter || filter(item, distSq)) {
          out.push(item);
        }
      },
      includeItemRadius,
    );

    return out;
  }

  /**
   * Queries all items within `radiusM` of `center`, sorted by ascending distance from `center`
   * with an optional deterministic tie-breaker.
   */
  queryRadiusSorted(
    center: Readonly<Vec3>,
    radiusM: number,
    filter?: SpatialQueryFilter<T>,
    tieBreak?: (a: T, b: T) => number,
    includeItemRadius = false,
  ): T[] {
    const scored: Array<{ item: T; distSq: number }> = [];
    this.forEachInRadius(
      center,
      radiusM,
      (item, distSq) => {
        if (!filter || filter(item, distSq)) {
          scored.push({ item, distSq });
        }
      },
      includeItemRadius,
    );

    scored.sort((a, b) => {
      const diff = a.distSq - b.distSq;
      if (Math.abs(diff) > 1e-9) return diff;
      return tieBreak ? tieBreak(a.item, b.item) : 0;
    });

    return scored.map((entry) => entry.item);
  }

  /**
   * Finds the nearest item within `maxRadiusM` of `center` matching `filter`.
   */
  findNearest(
    center: Readonly<Vec3>,
    maxRadiusM: number,
    filter?: SpatialQueryFilter<T>,
    tieBreak?: (a: T, b: T) => number,
    includeItemRadius = false,
  ): T | null {
    let bestItem: T | null = null;
    let bestDistSq = Number.POSITIVE_INFINITY;

    this.forEachInRadius(
      center,
      maxRadiusM,
      (item, distSq) => {
        if (filter && !filter(item, distSq)) return;
        if (distSq + 1e-9 < bestDistSq) {
          bestDistSq = distSq;
          bestItem = item;
        } else if (
          bestItem !== null &&
          Math.abs(distSq - bestDistSq) <= 1e-9 &&
          tieBreak &&
          tieBreak(item, bestItem) < 0
        ) {
          bestDistSq = distSq;
          bestItem = item;
        }
      },
      includeItemRadius,
    );

    return bestItem;
  }

  /**
   * Counts items within `radiusM` of `center` without allocating an output array.
   */
  countInRadius(
    center: Readonly<Vec3>,
    radiusM: number,
    filter?: SpatialQueryFilter<T>,
    includeItemRadius = false,
  ): number {
    let count = 0;
    this.forEachInRadius(
      center,
      radiusM,
      (item, distSq) => {
        if (!filter || filter(item, distSq)) {
          count += 1;
        }
      },
      includeItemRadius,
    );
    return count;
  }
}

export function createSpatialHash3D<T>(
  optionsOrCellSize: SpatialHash3DOptions<T> | number = DEFAULT_SPATIAL_HASH_CELL_SIZE_M,
  getPosition?: PositionExtractor<T>,
  getRadius?: RadiusExtractor<T>,
): SpatialHash3D<T> {
  return new SpatialHash3D<T>(optionsOrCellSize, getPosition, getRadius);
}
