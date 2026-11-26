import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSpatialAudioEngine, SFX_CUE_CONFIGS, type SfxCueId } from '../src/audio/engine.ts';
import type { CombatSimulationState } from '../src/sim/engine.ts';

interface MockSourceNode {
  buffer: AudioBuffer | null;
  loop: boolean;
  playbackRate: { value: number };
  onended: (() => void) | null;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function createMockAudioContext() {
  const sources: MockSourceNode[] = [];
  const panners: Array<{
    panningModel: string;
    distanceModel: string;
    refDistance: number;
    maxDistance: number;
    rolloffFactor: number;
    positionX: { value: number };
    positionY: { value: number };
    positionZ: { value: number };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];

  const createGain = () => ({
    gain: {
      value: 1,
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
      setTargetAtTime: vi.fn(),
      cancelScheduledValues: vi.fn(),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  });

  const ctx = {
    state: 'suspended' as AudioContextState,
    currentTime: 0,
    destination: {},
    listener: {
      positionX: { value: 0 },
      positionY: { value: 0 },
      positionZ: { value: 0 },
      forwardX: { value: 0 },
      forwardY: { value: 0 },
      forwardZ: { value: -1 },
      upX: { value: 0 },
      upY: { value: 1 },
      upZ: { value: 0 },
    },
    resume: vi.fn(async () => {
      ctx.state = 'running';
    }),
    suspend: vi.fn(async () => {
      ctx.state = 'suspended';
    }),
    close: vi.fn(async () => {
      ctx.state = 'closed';
    }),
    createGain: vi.fn(createGain),
    createBufferSource: vi.fn(() => {
      const node: MockSourceNode = {
        buffer: null,
        loop: false,
        playbackRate: { value: 1 },
        onended: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      sources.push(node);
      return node;
    }),
    createPanner: vi.fn(() => {
      const node = {
        panningModel: 'equalpower',
        distanceModel: 'inverse',
        refDistance: 1,
        maxDistance: 10000,
        rolloffFactor: 1,
        positionX: { value: 0 },
        positionY: { value: 0 },
        positionZ: { value: 0 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      panners.push(node);
      return node;
    }),
    createBuffer: vi.fn((_channels: number, length: number, sampleRate: number) => {
      const samples = new Float32Array(length);
      return {
        duration: length / sampleRate,
        length,
        sampleRate,
        getChannelData: () => samples,
      } as unknown as AudioBuffer;
    }),
    decodeAudioData: vi.fn(
      async () => ({ duration: 0.5, length: 24000, sampleRate: 48000 }) as unknown as AudioBuffer,
    ),
  };

  return {
    ctx: ctx as unknown as AudioContext,
    raw: ctx,
    sources,
    panners,
  };
}

describe('Spatial Audio Engine (P4-T5)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('defines configurations for all 28 owner-approved SFX cues', () => {
    const keys = Object.keys(SFX_CUE_CONFIGS) as SfxCueId[];
    expect(keys.length).toBe(28);
    expect(SFX_CUE_CONFIGS['rift-ambient'].loop).toBe(true);
    expect(SFX_CUE_CONFIGS['core-critical'].priority).toBe('critical');
  });

  it('unlocks, decodes cues, spatializes 3D playback, enforces cooldown & voice caps, and cleans up', async () => {
    let fakeTime = 1000;
    const mock = createMockAudioContext();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(16),
    })) as unknown as typeof fetch;

    const engine = createSpatialAudioEngine({
      initialVolumes: { masterVolume: 0.9, sfxVolume: 0.8, musicVolume: 0.5 },
      audioContextFactory: () => mock.ctx,
      nowMs: () => fakeTime,
    });

    engine.registerManifestCues([
      {
        id: 'autocannon-burst',
        family: 'turrets',
        loop: false,
        ogg: '/assets/audio/sfx/autocannon-burst.ogg',
        mp3: '/assets/audio/sfx/autocannon-burst.mp3',
        durationSec: 0.3,
      },
      {
        id: 'rift-ambient',
        family: 'rift-enemies',
        loop: true,
        ogg: '/assets/audio/sfx/rift-ambient.ogg',
        mp3: '/assets/audio/sfx/rift-ambient.mp3',
        durationSec: 8.0,
      },
      {
        id: 'core-critical',
        family: 'core-waves',
        loop: false,
        ogg: '/assets/audio/sfx/core-critical.ogg',
        mp3: '/assets/audio/sfx/core-critical.mp3',
        durationSec: 1.7,
      },
    ]);

    expect(engine.unlocked).toBe(false);
    const didUnlock = await engine.unlock();
    expect(didUnlock).toBe(true);
    expect(engine.unlocked).toBe(true);

    // Wait for background preloads to settle
    await vi.waitFor(() => expect(engine.loadedCueCount).toBe(3));

    // Sync listener from camera pose
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(1.2, 1.6, 2.4);
    camera.updateMatrixWorld(true);
    engine.updateListener(camera);
    expect(mock.raw.listener.positionX.value).toBeCloseTo(1.2);
    expect(mock.raw.listener.positionY.value).toBeCloseTo(1.6);

    // Spatial turret shot creates a PannerNode positioned in world space
    expect(engine.play('autocannon-burst', { position: { x: 2, y: 1, z: -1 } })).toBe(true);
    expect(mock.panners.length).toBe(1);
    expect(mock.panners[0]?.positionX.value).toBe(2);
    expect(engine.activeVoiceCount).toBe(1);

    // Immediate duplicate within cooldown is rejected
    expect(engine.play('autocannon-burst', { position: { x: 2, y: 1, z: -1 } })).toBe(false);

    // After cooldown, playback succeeds up to family cap (8 turrets)
    for (let i = 0; i < 10; i += 1) {
      fakeTime += 200;
      engine.play('autocannon-burst', { position: { x: i, y: 1, z: 0 } });
    }
    expect(engine.activeVoiceCount).toBeLessThanOrEqual(8);

    // Critical alarm bypasses cap / evicts and plays
    fakeTime += 3000;
    expect(engine.play('core-critical')).toBe(true);

    // Open portal starts looping spatial rift-ambient; closing it removes it
    engine.syncOpenPortals([
      {
        id: 'portal-0',
        portalIndex: 0,
        position: { x: 0, y: 1.5, z: -2.5 },
        normal: { x: 0, y: 0, z: 1 },
        hostKind: 'wall',
        isOpen: true,
        openedAtTick: 1,
      },
    ]);
    const loopSource = mock.sources.find((s) => s.loop);
    expect(loopSource).toBeDefined();

    engine.syncOpenPortals([]);
    expect(loopSource?.stop).toHaveBeenCalled();

    // Volume muting prevents new playback
    engine.setVolumes({ masterVolume: 0 });
    fakeTime += 500;
    expect(engine.play('autocannon-burst', { position: { x: 0, y: 1, z: 0 } })).toBe(false);

    // Visibility hide/show suspends & resumes context
    engine.setVisibility(false);
    expect(mock.raw.suspend).toHaveBeenCalled();
    engine.setVisibility(true);
    expect(mock.raw.resume).toHaveBeenCalledTimes(2);

    engine.dispose();
    expect(mock.raw.close).toHaveBeenCalledTimes(1);
    expect(engine.activeVoiceCount).toBe(0);
  });

  it('plays a built-in wave cue when the registered recordings return 404', async () => {
    const mock = createMockAudioContext();
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof fetch;

    const engine = createSpatialAudioEngine({ audioContextFactory: () => mock.ctx });
    engine.registerManifestCues([
      {
        id: 'wave-incoming',
        family: 'core-waves',
        loop: false,
        ogg: '/assets/audio/sfx/wave-incoming.ogg',
        mp3: '/assets/audio/sfx/wave-incoming.mp3',
        durationSec: 1.8,
      },
    ]);
    await engine.unlock();

    const emptySim = {
      turrets: [],
      portals: [],
    } as unknown as CombatSimulationState;

    expect(() =>
      engine.processSimEvents(
        [
          {
            type: 'wave-started',
            tick: 1,
            timeSec: 0,
            waveNumber: 1,
            waveId: 'wave-1',
            title: 'First Contact',
            musicCue: 'first-contact',
            concurrentPortals: 1,
            earlyLaunchBonusCredits: 0,
            totalCredits: 250,
          },
        ],
        emptySim,
      ),
    ).not.toThrow();
    expect(mock.sources[0]?.start).toHaveBeenCalledTimes(1);
    expect(mock.raw.createBuffer).toHaveBeenCalledTimes(1);

    engine.dispose();
  });

  it('plays the game recording after codec fallback and coalesces requests while it decodes', async () => {
    const mock = createMockAudioContext();
    const request = vi.fn();
    globalThis.fetch = request as unknown as typeof fetch;
    const publishedBuffer = { duration: 0.42 } as AudioBuffer;
    let releaseDecode: (buffer: AudioBuffer) => void = () => {};
    const delayed = new Promise<AudioBuffer>((resolve) => {
      releaseDecode = resolve;
    });
    const attemptedFormats: string[] = [];
    mock.raw.decodeAudioData.mockImplementation(async (buffer?: ArrayBuffer) => {
      const code = buffer ? new Uint8Array(buffer)[0] : 0;
      if (code === 1) throw new Error('Codec not supported');
      return code === 2 ? delayed : publishedBuffer;
    });
    const engine = createSpatialAudioEngine({
      audioContextFactory: () => mock.ctx,
      recordedCueBytes: (cue, format) => {
        if (cue !== 'surface-clamp') return Uint8Array.of(3).buffer;
        attemptedFormats.push(format);
        return Uint8Array.of(attemptedFormats.length).buffer;
      },
    });

    await engine.unlock();
    expect(engine.play('surface-clamp', { position: { x: 1, y: 0, z: 0 } })).toBe(true);
    expect(engine.play('surface-clamp')).toBe(false);
    expect(mock.sources).toHaveLength(0);
    await vi.waitFor(() => expect(attemptedFormats).toHaveLength(2));
    expect(new Set(attemptedFormats)).toEqual(new Set(['ogg', 'mp3']));
    releaseDecode(publishedBuffer);
    await vi.waitFor(() => expect(mock.sources[0]?.start).toHaveBeenCalledTimes(1));
    expect(mock.sources[0]?.buffer).toBe(publishedBuffer);
    expect(mock.panners[0]?.positionX.value).toBe(1);
    expect(engine.loadedCueCount).toBe(28);
    expect(mock.raw.createBuffer).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    engine.dispose();
  });

  it('plays and reuses built-in effects when the public manifest has no recordings', async () => {
    const mock = createMockAudioContext();
    const request = vi.fn();
    globalThis.fetch = request as unknown as typeof fetch;
    let now = 0;
    const engine = createSpatialAudioEngine({
      audioContextFactory: () => mock.ctx,
      nowMs: () => now,
    });
    engine.registerManifestCues([]);
    await engine.unlock();

    const position = { x: 1, y: 1, z: -2 };
    expect(engine.play('autocannon-burst', { position })).toBe(true);
    now += 1000;
    expect(engine.play('autocannon-burst', { position })).toBe(true);
    expect(mock.sources[0]?.buffer).toBe(mock.sources[1]?.buffer);
    expect(mock.panners[0]?.positionX.value).toBe(position.x);
    expect(
      mock.sources[0]?.buffer?.getChannelData(0).some((sample) => Math.abs(sample) > 0.05),
    ).toBe(true);
    engine.syncOpenPortals([
      {
        id: 'portal-1',
        portalIndex: 0,
        position,
        normal: { x: 0, y: 0, z: 1 },
        hostKind: 'wall',
        isOpen: true,
        openedAtTick: 1,
      },
    ]);
    const loop = mock.sources.find((source) => source.loop)?.buffer?.getChannelData(0);
    if (!loop) throw new Error('Expected the portal ambience to play');
    expect(Math.abs((loop[loop.length - 1] ?? 0) - (loop[0] ?? 0))).toBeLessThan(0.01);
    expect(request).not.toHaveBeenCalled();

    engine.setVolumes({ sfxVolume: 0 });
    expect(engine.play('mission-confirm')).toBe(false);
    engine.dispose();
  });

  it('plays the confirmation cue on wave clear', async () => {
    const mock = createMockAudioContext();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(32),
    })) as unknown as typeof fetch;
    const engine = createSpatialAudioEngine({ audioContextFactory: () => mock.ctx });
    engine.registerManifestCues([
      {
        id: 'mission-confirm',
        family: 'core-waves',
        loop: false,
        ogg: '/assets/audio/sfx/mission-confirm.ogg',
        mp3: '/assets/audio/sfx/mission-confirm.mp3',
        durationSec: 1,
      },
    ]);
    await engine.unlock();
    await vi.waitFor(() => expect(engine.loadedCueCount).toBe(1));

    engine.processSimEvents(
      [
        {
          type: 'wave-cleared',
          tick: 200,
          timeSec: 200 / 60,
          waveNumber: 1,
          clearBonusCredits: 70,
          totalCredits: 230,
          remainingCoreHp: 100,
          totalScore: 140,
        },
      ],
      { turrets: [], portals: [], victory: false } as unknown as CombatSimulationState,
    );
    expect(mock.sources).toHaveLength(1);
    expect(mock.sources[0]?.start).toHaveBeenCalledTimes(1);
    engine.dispose();
  });

  it('starts one opt-in preview music loop after unlock and respects music mute', async () => {
    const mock = createMockAudioContext();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(32),
    })) as unknown as typeof fetch;

    const engine = createSpatialAudioEngine({
      previewMusic: true,
      audioContextFactory: () => mock.ctx,
      initialVolumes: { musicVolume: 0.4 },
    });
    await engine.unlock();
    await vi.waitFor(() => expect(mock.sources.filter((source) => source.loop)).toHaveLength(1));
    await engine.unlock();
    expect(mock.sources.filter((source) => source.loop)).toHaveLength(1);

    const source = mock.sources.find((node) => node.loop);
    const musicGain = source?.connect.mock.calls[0]?.[0];
    expect(musicGain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.4, 0, 0.02);
    engine.setVolumes({ musicVolume: 0 });
    expect(musicGain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, 0.02);
    engine.setVolumes({ musicVolume: 0.6 });
    expect(musicGain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.6, 0, 0.02);
    expect(mock.sources.filter((node) => node.loop)).toHaveLength(1);
    engine.dispose();
    expect(source?.stop).toHaveBeenCalledTimes(1);
  });

  it('silently skips the preview loop when its asset is unavailable', async () => {
    const mock = createMockAudioContext();
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof fetch;

    const engine = createSpatialAudioEngine({
      previewMusic: true,
      audioContextFactory: () => mock.ctx,
    });
    await expect(engine.unlock()).resolves.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mock.sources.filter((source) => source.loop)).toHaveLength(0);
    engine.dispose();
  });
});
