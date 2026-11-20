/**
 * Deterministic seeded PRNG with named, independent sub-streams.
 *
 * One root seed drives every stream. Each named stream derives its own 32-bit seed from the root
 * seed and the stream name, so drawing from `fx` never perturbs `waves` or `targeting`. Pure
 * TypeScript with no DOM or Three.js dependencies, so the simulation can use it directly.
 */

export const STREAM_NAMES = ['waves', 'targeting', 'fx', 'nav'] as const;
export type StreamName = (typeof STREAM_NAMES)[number];

/** Seed used when no `?seed=` is supplied and no random seed is requested. */
export const DEFAULT_SEED = 0x5eed_b45e;

const UINT32 = 0x1_0000_0000;

/** 32-bit FNV-1a hash of a string, returned as an unsigned integer. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Murmur3 finalizer: spreads every input bit across the 32-bit output. */
function mix32(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Normalizes any finite number to an unsigned 32-bit seed. */
export function toSeed(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SEED;
  return Math.trunc(value) >>> 0;
}

/** Derives the seed of a named stream from the root seed. */
export function deriveStreamSeed(rootSeed: number, name: string): number {
  return mix32(toSeed(rootSeed) ^ mix32(hashString(name)));
}

/** Raw mulberry32 step function: returns a generator of uniform floats in `[0, 1)`. */
export function mulberry32(seed: number): () => number {
  let state = toSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  };
}

export interface Rng {
  /** The seed this generator started from. */
  readonly seed: number;
  /** Number of values drawn so far. */
  readonly draws: number;
  /** Uniform float in `[0, 1)`. */
  next(): number;
  /** Uniform float in `[min, max)`. */
  range(min: number, max: number): number;
  /** Uniform integer in `[min, max]` (both inclusive). */
  int(min: number, max: number): number;
  /** `true` with probability `p` (clamped to `[0, 1]`). */
  chance(p: number): boolean;
  /** Uniformly chosen element. Throws on an empty array. */
  pick<T>(items: readonly T[]): T;
  /** New shuffled copy (Fisher-Yates). The input is not modified. */
  shuffle<T>(items: readonly T[]): T[];
  /** Restarts the sequence from the original seed. */
  reset(): void;
}

/** Creates a deterministic generator for one seed. */
export function createRng(seed: number): Rng {
  const start = toSeed(seed);
  let step = mulberry32(start);
  let draws = 0;
  const next = (): number => {
    draws += 1;
    return step();
  };
  const rng: Rng = {
    seed: start,
    get draws() {
      return draws;
    },
    next,
    range(min, max) {
      return min + (max - min) * next();
    },
    int(min, max) {
      const low = Math.ceil(Math.min(min, max));
      const high = Math.floor(Math.max(min, max));
      if (high < low) throw new RangeError(`No integer in [${min}, ${max}]`);
      return low + Math.floor(next() * (high - low + 1));
    },
    chance(p) {
      const probability = Math.min(1, Math.max(0, p));
      return next() < probability;
    },
    pick(items) {
      if (items.length === 0) throw new RangeError('Cannot pick from an empty array');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    shuffle(items) {
      const copy = items.slice();
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(next() * (index + 1));
        const held = copy[index] as (typeof copy)[number];
        copy[index] = copy[swap] as (typeof copy)[number];
        copy[swap] = held;
      }
      return copy;
    },
    reset() {
      step = mulberry32(start);
      draws = 0;
    },
  };
  return rng;
}

export interface SeededStreams {
  readonly rootSeed: number;
  /** The generator for a named stream. The same instance is returned on every call. */
  stream(name: StreamName): Rng;
  /** Restarts every stream from its derived seed. */
  reset(): void;
}

/** Creates the named sub-streams (`waves`, `targeting`, `fx`, `nav`) for one root seed. */
export function createSeededStreams(rootSeed: number = DEFAULT_SEED): SeededStreams {
  const root = toSeed(rootSeed);
  const streams = new Map<StreamName, Rng>();
  for (const name of STREAM_NAMES) streams.set(name, createRng(deriveStreamSeed(root, name)));
  return {
    rootSeed: root,
    stream(name) {
      const rng = streams.get(name);
      if (!rng) throw new RangeError(`Unknown PRNG stream: ${String(name)}`);
      return rng;
    },
    reset() {
      for (const rng of streams.values()) rng.reset();
    },
  };
}

/**
 * Reads `?seed=` from a URL query string. Accepts decimal or `0x` hex integers (normalized to
 * unsigned 32-bit) and hashes any other non-empty text. Returns `null` when absent or blank.
 */
export function parseSeedParam(search: string | URLSearchParams): number | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const raw = params.get('seed');
  if (raw === null) return null;
  const text = raw.trim();
  if (text === '') return null;
  if (/^-?\d+$/.test(text)) return toSeed(Number(text));
  if (/^0x[0-9a-f]+$/i.test(text)) return toSeed(Number.parseInt(text.slice(2), 16));
  return hashString(text);
}

/** A fresh non-deterministic seed, using `crypto.getRandomValues` when available. */
export function randomSeed(): number {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    const buffer = new Uint32Array(1);
    cryptoApi.getRandomValues(buffer);
    return (buffer[0] ?? DEFAULT_SEED) >>> 0;
  }
  return toSeed(Math.random() * UINT32);
}

/** Resolves the session seed: the URL `?seed=` if present, otherwise a random seed. */
export function resolveSeed(search: string | URLSearchParams = ''): number {
  return parseSeedParam(search) ?? randomSeed();
}
