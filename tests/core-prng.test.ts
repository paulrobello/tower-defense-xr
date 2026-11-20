import { describe, expect, it } from 'vitest';
import {
  createRng,
  createSeededStreams,
  DEFAULT_SEED,
  deriveStreamSeed,
  hashString,
  mulberry32,
  parseSeedParam,
  randomSeed,
  resolveSeed,
  STREAM_NAMES,
  toSeed,
} from '../src/core/prng.ts';

const draw = (next: () => number, count: number): number[] =>
  Array.from({ length: count }, () => next());

describe('mulberry32', () => {
  it('is deterministic for a seed and yields floats in [0, 1)', () => {
    const a = draw(mulberry32(42), 1000);
    const b = draw(mulberry32(42), 1000);
    expect(a).toEqual(b);
    for (const value of a) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('produces different sequences for different seeds', () => {
    expect(draw(mulberry32(1), 8)).not.toEqual(draw(mulberry32(2), 8));
  });

  it('matches the reference mulberry32 output (golden values)', () => {
    // Golden values pin the algorithm: any change breaks recorded seeds and replays.
    const values = draw(mulberry32(1), 3).map((value) => Math.round(value * 1e9));
    expect(values).toEqual([627073941, 2735721, 527447040]);
  });

  it('is roughly uniform', () => {
    const buckets = new Array<number>(10).fill(0);
    const next = mulberry32(DEFAULT_SEED);
    for (let index = 0; index < 20000; index += 1) {
      const bucket = Math.floor(next() * 10);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    for (const count of buckets) expect(Math.abs(count - 2000)).toBeLessThan(200);
  });
});

describe('createRng', () => {
  it('replays after reset and counts draws', () => {
    const rng = createRng(7);
    const first = draw(rng.next, 5);
    expect(rng.draws).toBe(5);
    rng.reset();
    expect(rng.draws).toBe(0);
    expect(draw(rng.next, 5)).toEqual(first);
  });

  it('int stays inside inclusive bounds and covers them', () => {
    const rng = createRng(99);
    const seen = new Set<number>();
    for (let index = 0; index < 2000; index += 1) {
      const value = rng.int(3, 6);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(6);
      seen.add(value);
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
    expect(() => rng.int(0.2, 0.8)).toThrow(RangeError);
  });

  it('range, chance, pick and shuffle are deterministic and well-formed', () => {
    const a = createRng(5);
    const b = createRng(5);
    const items = ['a', 'b', 'c', 'd', 'e'] as const;
    expect(a.range(2, 4)).toBe(b.range(2, 4));
    expect(a.chance(0.5)).toBe(b.chance(0.5));
    expect(a.pick(items)).toBe(b.pick(items));
    const shuffled = a.shuffle(items);
    expect(shuffled).toEqual(b.shuffle(items));
    expect([...shuffled].sort()).toEqual([...items]);
    expect(items).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(createRng(1).chance(0)).toBe(false);
    expect(createRng(1).chance(1)).toBe(true);
    expect(() => a.pick([])).toThrow(RangeError);
  });
});

describe('createSeededStreams', () => {
  it('exposes every named stream with distinct derived seeds', () => {
    const streams = createSeededStreams(1234);
    const seeds = STREAM_NAMES.map((name) => streams.stream(name).seed);
    expect(new Set(seeds).size).toBe(STREAM_NAMES.length);
    expect(streams.stream('waves').seed).toBe(deriveStreamSeed(1234, 'waves'));
    expect(streams.stream('waves')).toBe(streams.stream('waves'));
  });

  it('reproduces identical streams for the same root seed', () => {
    const a = createSeededStreams(2024);
    const b = createSeededStreams(2024);
    for (const name of STREAM_NAMES) {
      expect(draw(a.stream(name).next, 20)).toEqual(draw(b.stream(name).next, 20));
    }
  });

  it('keeps streams independent: drawing fx does not perturb waves', () => {
    const quiet = createSeededStreams(77);
    const noisy = createSeededStreams(77);
    draw(noisy.stream('fx').next, 500);
    draw(noisy.stream('targeting').next, 37);
    expect(draw(noisy.stream('waves').next, 10)).toEqual(draw(quiet.stream('waves').next, 10));
  });

  it('differs across root seeds and resets every stream', () => {
    const a = createSeededStreams(1);
    const b = createSeededStreams(2);
    expect(draw(a.stream('nav').next, 4)).not.toEqual(draw(b.stream('nav').next, 4));
    const beforeWaves = draw(a.stream('waves').next, 5);
    const beforeFx = draw(a.stream('fx').next, 5);
    a.reset();
    expect(draw(a.stream('waves').next, 5)).toEqual(beforeWaves);
    expect(draw(a.stream('fx').next, 5)).toEqual(beforeFx);
    a.reset();
    const replay = createSeededStreams(1);
    expect(draw(a.stream('waves').next, 5)).toEqual(draw(replay.stream('waves').next, 5));
  });

  it('defaults to DEFAULT_SEED and rejects unknown streams', () => {
    expect(createSeededStreams().rootSeed).toBe(DEFAULT_SEED);
    expect(() => createSeededStreams(1).stream('bogus' as never)).toThrow(RangeError);
  });
});

describe('seed parsing', () => {
  it('parses decimal, hex, negative and text seeds', () => {
    expect(parseSeedParam('?seed=12345')).toBe(12345);
    expect(parseSeedParam('?seed=0xFF')).toBe(255);
    expect(parseSeedParam('?seed=-1')).toBe(0xffffffff);
    expect(parseSeedParam('?seed=4294967297')).toBe(1);
    expect(parseSeedParam('?seed=rift')).toBe(hashString('rift'));
    expect(parseSeedParam(new URLSearchParams({ seed: ' 9 ' }))).toBe(9);
  });

  it('returns null when absent or blank', () => {
    expect(parseSeedParam('')).toBeNull();
    expect(parseSeedParam('?perf')).toBeNull();
    expect(parseSeedParam('?seed=')).toBeNull();
    expect(parseSeedParam('?seed=%20')).toBeNull();
  });

  it('resolveSeed prefers the URL and otherwise falls back to a random uint32', () => {
    expect(resolveSeed('?seed=31')).toBe(31);
    const random = resolveSeed('');
    expect(Number.isInteger(random)).toBe(true);
    expect(random).toBeGreaterThanOrEqual(0);
    expect(random).toBeLessThanOrEqual(0xffffffff);
    const generated = randomSeed();
    expect(Number.isInteger(generated)).toBe(true);
    expect(generated >>> 0).toBe(generated);
  });

  it('normalizes seeds and hashes stably', () => {
    expect(toSeed(Number.NaN)).toBe(DEFAULT_SEED);
    expect(toSeed(3.9)).toBe(3);
    expect(hashString('waves')).toBe(hashString('waves'));
    expect(hashString('waves')).not.toBe(hashString('fx'));
  });
});
