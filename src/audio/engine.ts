/**
 * Web Audio API 3D Spatial SFX Engine (`src/audio/engine.ts`, P4-T5).
 *
 * Integrates all 28 owner-approved ElevenLabs mastered SFX cues (`/assets/audio/sfx/*.ogg` with
 * `.mp3` fallback) into the runtime with:
 * - User-gesture unlock (`pointerdown`, `keydown`, `touchstart`) and visibility/focus pause-resume.
 * - Per-frame 3D `AudioListener` pose synchronization from the active Desktop or WebXR camera.
 * - 3D `PannerNode` spatialization for world-space combat, turret, enemy, and portal cues plus
 *   direct stereo routing for UI/Core feedback cues.
 * - Continuous looping spatial `rift-ambient` emitters anchored at each open Dimensional Rift Portal.
 * - Per-family voice caps and priority ducking so heavy Wave 12 volleys never clip Quest speakers.
 * - Live synchronization with `SettingsStore` (`masterVolume`, `sfxVolume`) and graceful degradation
 *   in headless test environments or checkouts without staged audio.
 */

import * as THREE from 'three';
import type { Vec3 } from '../content/index.ts';
import type { RuntimeSfxManifestEntry } from '../render/asset-loader.ts';
import type { CombatSimulationState, SimEvent, SimPortalState } from '../sim/engine.ts';

export type SfxCueId =
  | 'surface-clamp'
  | 'hover-pod'
  | 'invalid-placement'
  | 'relocate'
  | 'sell'
  | 'radial-tick'
  | 'autocannon-burst'
  | 'autocannon-impact'
  | 'plasma-launch'
  | 'plasma-detonation'
  | 'cryo-charge'
  | 'cryo-chain'
  | 'rail-charge'
  | 'rail-crack'
  | 'turret-servo'
  | 'tier-upgrade'
  | 'rift-tear'
  | 'rift-ambient'
  | 'skitter'
  | 'wasp'
  | 'brute'
  | 'disruptor'
  | 'broodlord'
  | 'boss-collapse'
  | 'wave-incoming'
  | 'core-shield-hit'
  | 'core-critical'
  | 'mission-confirm';

export type SfxFamily = 'placement-ui' | 'turrets' | 'rift-enemies' | 'core-waves';

export interface SfxCueConfig {
  readonly family: SfxFamily;
  readonly spatial: boolean;
  readonly gain: number;
  readonly cooldownMs: number;
  readonly pitchJitter: number;
  readonly priority: 'low' | 'normal' | 'high' | 'critical';
  readonly loop?: boolean;
}

export const SFX_CUE_CONFIGS: Readonly<Record<SfxCueId, SfxCueConfig>> = {
  'surface-clamp': {
    family: 'placement-ui',
    spatial: true,
    gain: 0.85,
    cooldownMs: 80,
    pitchJitter: 0.03,
    priority: 'normal',
  },
  'hover-pod': {
    family: 'placement-ui',
    spatial: true,
    gain: 0.85,
    cooldownMs: 80,
    pitchJitter: 0.03,
    priority: 'normal',
  },
  'invalid-placement': {
    family: 'placement-ui',
    spatial: false,
    gain: 0.72,
    cooldownMs: 180,
    pitchJitter: 0.0,
    priority: 'normal',
  },
  relocate: {
    family: 'placement-ui',
    spatial: true,
    gain: 0.85,
    cooldownMs: 120,
    pitchJitter: 0.02,
    priority: 'normal',
  },
  sell: {
    family: 'placement-ui',
    spatial: false,
    gain: 0.78,
    cooldownMs: 100,
    pitchJitter: 0.02,
    priority: 'normal',
  },
  'radial-tick': {
    family: 'placement-ui',
    spatial: false,
    gain: 0.52,
    cooldownMs: 45,
    pitchJitter: 0.04,
    priority: 'low',
  },

  'autocannon-burst': {
    family: 'turrets',
    spatial: true,
    gain: 0.62,
    cooldownMs: 65,
    pitchJitter: 0.07,
    priority: 'low',
  },
  'autocannon-impact': {
    family: 'turrets',
    spatial: true,
    gain: 0.45,
    cooldownMs: 90,
    pitchJitter: 0.09,
    priority: 'low',
  },
  'plasma-launch': {
    family: 'turrets',
    spatial: true,
    gain: 0.72,
    cooldownMs: 110,
    pitchJitter: 0.05,
    priority: 'normal',
  },
  'plasma-detonation': {
    family: 'turrets',
    spatial: true,
    gain: 0.92,
    cooldownMs: 95,
    pitchJitter: 0.06,
    priority: 'high',
  },
  'cryo-charge': {
    family: 'turrets',
    spatial: true,
    gain: 0.58,
    cooldownMs: 140,
    pitchJitter: 0.05,
    priority: 'low',
  },
  'cryo-chain': {
    family: 'turrets',
    spatial: true,
    gain: 0.68,
    cooldownMs: 120,
    pitchJitter: 0.06,
    priority: 'normal',
  },
  'rail-charge': {
    family: 'turrets',
    spatial: true,
    gain: 0.56,
    cooldownMs: 320,
    pitchJitter: 0.03,
    priority: 'normal',
  },
  'rail-crack': {
    family: 'turrets',
    spatial: true,
    gain: 0.96,
    cooldownMs: 120,
    pitchJitter: 0.04,
    priority: 'high',
  },
  'turret-servo': {
    family: 'turrets',
    spatial: true,
    gain: 0.28,
    cooldownMs: 420,
    pitchJitter: 0.08,
    priority: 'low',
  },
  'tier-upgrade': {
    family: 'turrets',
    spatial: true,
    gain: 0.88,
    cooldownMs: 120,
    pitchJitter: 0.02,
    priority: 'high',
  },

  'rift-tear': {
    family: 'rift-enemies',
    spatial: true,
    gain: 0.95,
    cooldownMs: 250,
    pitchJitter: 0.03,
    priority: 'high',
  },
  'rift-ambient': {
    family: 'rift-enemies',
    spatial: true,
    gain: 0.34,
    cooldownMs: 0,
    pitchJitter: 0.0,
    priority: 'low',
    loop: true,
  },
  skitter: {
    family: 'rift-enemies',
    spatial: true,
    gain: 0.58,
    cooldownMs: 90,
    pitchJitter: 0.1,
    priority: 'low',
  },
  wasp: {
    family: 'rift-enemies',
    spatial: true,
    gain: 0.62,
    cooldownMs: 100,
    pitchJitter: 0.08,
    priority: 'low',
  },
  brute: {
    family: 'rift-enemies',
    spatial: true,
    gain: 0.82,
    cooldownMs: 180,
    pitchJitter: 0.05,
    priority: 'normal',
  },
  disruptor: {
    family: 'rift-enemies',
    spatial: true,
    gain: 0.88,
    cooldownMs: 220,
    pitchJitter: 0.04,
    priority: 'high',
  },
  broodlord: {
    family: 'rift-enemies',
    spatial: true,
    gain: 1.0,
    cooldownMs: 1200,
    pitchJitter: 0.02,
    priority: 'critical',
  },
  'boss-collapse': {
    family: 'rift-enemies',
    spatial: true,
    gain: 1.0,
    cooldownMs: 600,
    pitchJitter: 0.0,
    priority: 'critical',
  },

  'wave-incoming': {
    family: 'core-waves',
    spatial: false,
    gain: 0.86,
    cooldownMs: 600,
    pitchJitter: 0.0,
    priority: 'critical',
  },
  'core-shield-hit': {
    family: 'core-waves',
    spatial: true,
    gain: 0.85,
    cooldownMs: 140,
    pitchJitter: 0.04,
    priority: 'high',
  },
  'core-critical': {
    family: 'core-waves',
    spatial: false,
    gain: 0.94,
    cooldownMs: 2400,
    pitchJitter: 0.0,
    priority: 'critical',
  },
  'mission-confirm': {
    family: 'core-waves',
    spatial: false,
    gain: 0.78,
    cooldownMs: 300,
    pitchJitter: 0.0,
    priority: 'normal',
  },
};

const FAMILY_VOICE_CAPS: Readonly<Record<SfxFamily, number>> = {
  'placement-ui': 4,
  turrets: 8,
  'rift-enemies': 6,
  'core-waves': 4,
};

const MAX_TOTAL_ACTIVE_VOICES = 16;

export interface AudioVolumes {
  readonly masterVolume: number;
  readonly sfxVolume: number;
  readonly musicVolume: number;
}

export interface SpatialAudioEngineOptions {
  readonly initialVolumes?: Partial<AudioVolumes>;
  readonly audioContextFactory?: () => AudioContext;
  readonly nowMs?: () => number;
}

export interface PlaySfxOptions {
  readonly position?: Readonly<Vec3> | null;
  readonly gainScale?: number;
}

export interface SpatialAudioEngine {
  readonly unlocked: boolean;
  readonly loadedCueCount: number;
  readonly activeVoiceCount: number;
  readonly volumes: Readonly<AudioVolumes>;
  registerManifestCues(cues: readonly RuntimeSfxManifestEntry[]): void;
  unlock(): Promise<boolean>;
  setVolumes(patch: Partial<AudioVolumes>): void;
  setVisibility(visible: boolean): void;
  updateListener(camera: THREE.Camera): void;
  play(cueId: SfxCueId, options?: PlaySfxOptions): boolean;
  syncOpenPortals(portals: readonly SimPortalState[]): void;
  processSimEvents(events: readonly SimEvent[], simState: CombatSimulationState): void;
  dispose(): void;
}

interface ActiveVoice {
  readonly family: SfxFamily;
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
  readonly panner: PannerNode | null;
}

interface PortalAmbientVoice {
  readonly portalId: string;
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
  readonly panner: PannerNode;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function supportsOggOpus(): boolean {
  if (typeof document === 'undefined') return true;
  try {
    const audio = document.createElement('audio');
    return audio.canPlayType('audio/ogg; codecs="opus"') !== '';
  } catch {
    return true;
  }
}

export function createSpatialAudioEngine(
  options: SpatialAudioEngineOptions = {},
): SpatialAudioEngine {
  const nowMs =
    options.nowMs ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const preferOgg = supportsOggOpus();

  let volumes: AudioVolumes = {
    masterVolume: clamp01(options.initialVolumes?.masterVolume ?? 0.8),
    sfxVolume: clamp01(options.initialVolumes?.sfxVolume ?? 0.85),
    musicVolume: clamp01(options.initialVolumes?.musicVolume ?? 0.7),
  };

  let ctx: AudioContext | null = null;
  let masterGain: GainNode | null = null;
  let sfxBusGain: GainNode | null = null;
  let duckingGain: GainNode | null = null;
  let criticalBusGain: GainNode | null = null;
  let unlocked = false;
  let disposed = false;

  const cueUrls = new Map<SfxCueId, { readonly ogg: string; readonly mp3: string }>();
  const decodedBuffers = new Map<SfxCueId, AudioBuffer>();
  const inflightLoads = new Map<SfxCueId, Promise<AudioBuffer | null>>();
  const lastPlayedAtMs = new Map<SfxCueId, number>();
  const activeVoices = new Set<ActiveVoice>();
  const portalAmbients = new Map<string, PortalAmbientVoice>();
  const lastOpenPortals = new Map<string, Vec3>();

  // Track per-turret previous target & rail charge state to drive subtle servo and rail-charge cues
  const prevTurretTarget = new Map<string, string | null>();
  const railChargedTurrets = new Set<string>();
  let duckResetTimer: ReturnType<typeof setTimeout> | null = null;

  const listenerPos = new THREE.Vector3();
  const listenerQuat = new THREE.Quaternion();
  const listenerFwd = new THREE.Vector3();
  const listenerUp = new THREE.Vector3();

  function effectiveSfxGain(): number {
    return clamp01(volumes.masterVolume * volumes.sfxVolume);
  }

  function applyBusVolumes(): void {
    if (!ctx || !masterGain || !sfxBusGain || !criticalBusGain) return;
    const t = ctx.currentTime;
    masterGain.gain.setTargetAtTime(volumes.masterVolume, t, 0.02);
    sfxBusGain.gain.setTargetAtTime(volumes.sfxVolume, t, 0.02);
    criticalBusGain.gain.setTargetAtTime(volumes.sfxVolume, t, 0.02);
  }

  function ensureContext(): AudioContext | null {
    if (disposed) return null;
    if (ctx) return ctx;
    try {
      const AudioCtxCtor =
        options.audioContextFactory ??
        (typeof globalThis !== 'undefined'
          ? ((
              globalThis as unknown as {
                AudioContext?: typeof AudioContext;
                webkitAudioContext?: typeof AudioContext;
              }
            ).AudioContext ??
            (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext)
          : undefined);
      if (!AudioCtxCtor) return null;
      ctx =
        typeof options.audioContextFactory === 'function'
          ? options.audioContextFactory()
          : new (AudioCtxCtor as typeof AudioContext)();

      masterGain = ctx.createGain();
      duckingGain = ctx.createGain();
      sfxBusGain = ctx.createGain();
      criticalBusGain = ctx.createGain();

      // Normal/high cues route through sfxBusGain -> duckingGain -> masterGain -> destination
      // Critical cues bypass ducking so alarms & boss roars stay crisp
      sfxBusGain.connect(duckingGain);
      duckingGain.connect(masterGain);
      criticalBusGain.connect(masterGain);
      masterGain.connect(ctx.destination);
      applyBusVolumes();
      return ctx;
    } catch {
      ctx = null;
      return null;
    }
  }

  async function loadCueBuffer(cueId: SfxCueId): Promise<AudioBuffer | null> {
    const cached = decodedBuffers.get(cueId);
    if (cached) return cached;
    const existing = inflightLoads.get(cueId);
    if (existing) return existing;

    const entry = cueUrls.get(cueId);
    const context = ensureContext();
    if (!entry || !context || typeof fetch !== 'function') return null;

    const urls = preferOgg ? [entry.ogg, entry.mp3] : [entry.mp3, entry.ogg];
    const promise = (async (): Promise<AudioBuffer | null> => {
      for (const url of urls) {
        if (disposed) return null;
        try {
          const resp = await fetch(url);
          if (!resp.ok) continue;
          const bytes = await resp.arrayBuffer();
          if (disposed || !ctx) return null;
          const decoded = await ctx.decodeAudioData(bytes.slice(0));
          if (disposed) return null;
          decodedBuffers.set(cueId, decoded);
          return decoded;
        } catch {
          // Try next codec fallback cleanly
        }
      }
      return null;
    })().finally(() => {
      inflightLoads.delete(cueId);
    });

    inflightLoads.set(cueId, promise);
    return promise;
  }

  function preloadCoreCues(): void {
    if (disposed || !ctx) return;
    // Warm all registered cues in the background once unlocked so combat cues fire with 0 ms latency
    for (const cueId of cueUrls.keys()) {
      void loadCueBuffer(cueId);
    }
  }

  function triggerDucking(durationMs: number): void {
    if (!ctx || !duckingGain) return;
    const t = ctx.currentTime;
    duckingGain.gain.cancelScheduledValues(t);
    duckingGain.gain.setTargetAtTime(0.55, t, 0.03);
    if (duckResetTimer !== null) {
      clearTimeout(duckResetTimer);
    }
    duckResetTimer = setTimeout(() => {
      duckResetTimer = null;
      if (ctx && duckingGain && !disposed) {
        duckingGain.gain.setTargetAtTime(1.0, ctx.currentTime, 0.14);
      }
    }, durationMs);
  }

  function configurePanner(panner: PannerNode, position: Readonly<Vec3>): void {
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 0.85;
    panner.maxDistance = 16;
    panner.rolloffFactor = 1.35;
    if (panner.positionX) {
      panner.positionX.value = position.x;
      panner.positionY.value = position.y;
      panner.positionZ.value = position.z;
    } else if (typeof panner.setPosition === 'function') {
      panner.setPosition(position.x, position.y, position.z);
    }
  }

  function countVoicesInFamily(family: SfxFamily): number {
    let count = 0;
    for (const v of activeVoices) {
      if (v.family === family) count += 1;
    }
    return count;
  }

  function stopVoice(voice: ActiveVoice): void {
    if (!activeVoices.has(voice)) return;
    activeVoices.delete(voice);
    try {
      voice.source.onended = null;
      voice.source.stop();
    } catch {
      // Already ended
    }
    try {
      voice.source.disconnect();
      voice.gain.disconnect();
      voice.panner?.disconnect();
    } catch {
      // Ignore disconnect errors
    }
  }

  function startPortalAmbient(portalId: string, position: Readonly<Vec3>): void {
    if (disposed || !ctx || !unlocked || !sfxBusGain) return;
    const existing = portalAmbients.get(portalId);
    if (existing) {
      configurePanner(existing.panner, position);
      return;
    }
    const buffer = decodedBuffers.get('rift-ambient');
    if (!buffer) {
      void loadCueBuffer('rift-ambient').then((loaded) => {
        const currentPos = lastOpenPortals.get(portalId);
        if (loaded && !disposed && currentPos) {
          startPortalAmbient(portalId, currentPos);
        }
      });
      return;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const gain = ctx.createGain();
    const targetGain = SFX_CUE_CONFIGS['rift-ambient'].gain;
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(targetGain, ctx.currentTime + 0.65);

    const panner = ctx.createPanner();
    configurePanner(panner, position);
    panner.refDistance = 0.65;
    panner.rolloffFactor = 1.6;

    source.connect(gain);
    gain.connect(panner);
    panner.connect(sfxBusGain);
    source.start();

    portalAmbients.set(portalId, { portalId, source, gain, panner });
  }

  function stopPortalAmbient(portalId: string): void {
    const voice = portalAmbients.get(portalId);
    if (!voice) return;
    portalAmbients.delete(portalId);
    try {
      if (ctx) {
        const t = ctx.currentTime;
        voice.gain.gain.cancelScheduledValues(t);
        voice.gain.gain.setTargetAtTime(0.0001, t, 0.08);
        voice.source.stop(t + 0.35);
      } else {
        voice.source.stop();
      }
    } catch {
      // Ignore stop errors
    }
  }

  function play(cueId: SfxCueId, playOptions: PlaySfxOptions = {}): boolean {
    if (disposed) return false;
    if (effectiveSfxGain() <= 0.001) return false;
    const cfg = SFX_CUE_CONFIGS[cueId];
    if (!cfg) return false;

    const now = nowMs();
    const last = lastPlayedAtMs.get(cueId) ?? -Infinity;
    if (now - last < cfg.cooldownMs) return false;

    const context = ensureContext();
    if (!context || !sfxBusGain || !criticalBusGain) return false;
    if (context.state === 'suspended' && !unlocked) return false;

    const buffer = decodedBuffers.get(cueId);
    if (!buffer) {
      // Kick off lazy decode so subsequent triggers play immediately
      void loadCueBuffer(cueId);
      return false;
    }

    // Enforce total and per-family voice caps
    const familyCap = FAMILY_VOICE_CAPS[cfg.family];
    if (
      activeVoices.size >= MAX_TOTAL_ACTIVE_VOICES ||
      countVoicesInFamily(cfg.family) >= familyCap
    ) {
      if (cfg.priority === 'low') return false;
      // Evict oldest voice in same family (or globally) for high/critical cues
      let victim: ActiveVoice | null = null;
      for (const v of activeVoices) {
        if (v.family === cfg.family) {
          victim = v;
          break;
        }
      }
      if (!victim && cfg.priority === 'critical') {
        victim = activeVoices.values().next().value ?? null;
      }
      if (!victim) return false;
      stopVoice(victim);
    }

    lastPlayedAtMs.set(cueId, now);

    const source = context.createBufferSource();
    source.buffer = buffer;
    if (cfg.pitchJitter > 0) {
      source.playbackRate.value = 1 + (Math.random() * 2 - 1) * cfg.pitchJitter;
    }

    const gain = context.createGain();
    gain.gain.value = clamp01(cfg.gain * (playOptions.gainScale ?? 1));

    const targetBus = cfg.priority === 'critical' ? criticalBusGain : sfxBusGain;
    let panner: PannerNode | null = null;

    if (cfg.spatial && playOptions.position && typeof context.createPanner === 'function') {
      panner = context.createPanner();
      configurePanner(panner, playOptions.position);
      source.connect(gain);
      gain.connect(panner);
      panner.connect(targetBus);
    } else {
      source.connect(gain);
      gain.connect(targetBus);
    }

    const voice: ActiveVoice = {
      family: cfg.family,
      source,
      gain,
      panner,
    };
    activeVoices.add(voice);
    source.onended = () => {
      stopVoice(voice);
    };
    source.start();

    if (cfg.priority === 'critical') {
      triggerDucking(900);
    }
    return true;
  }

  async function unlock(): Promise<boolean> {
    if (disposed) return false;
    const context = ensureContext();
    if (!context) return false;
    try {
      if (context.state === 'suspended') {
        await context.resume();
      }
      unlocked = context.state === 'running';
      if (unlocked) {
        preloadCoreCues();
        // Start any already-open portal ambients now that audio is unlocked
        for (const [portalId, pos] of lastOpenPortals.entries()) {
          startPortalAmbient(portalId, pos);
        }
      }
      return unlocked;
    } catch {
      return false;
    }
  }

  // Automatic user-gesture unlock hook in browser environments
  const onGesture = (): void => {
    if (!unlocked && !disposed) {
      void unlock();
    }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', onGesture, { passive: true });
    window.addEventListener('keydown', onGesture, { passive: true });
    window.addEventListener('touchstart', onGesture, { passive: true });
  }

  return {
    get unlocked() {
      return unlocked;
    },
    get loadedCueCount() {
      return decodedBuffers.size;
    },
    get activeVoiceCount() {
      return activeVoices.size + portalAmbients.size;
    },
    get volumes() {
      return volumes;
    },
    registerManifestCues(cues) {
      for (const cue of cues) {
        if (cue.id in SFX_CUE_CONFIGS) {
          cueUrls.set(cue.id as SfxCueId, { ogg: cue.ogg, mp3: cue.mp3 });
        }
      }
      if (unlocked) {
        preloadCoreCues();
      }
    },
    unlock,
    setVolumes(patch) {
      volumes = {
        masterVolume:
          patch.masterVolume !== undefined ? clamp01(patch.masterVolume) : volumes.masterVolume,
        sfxVolume: patch.sfxVolume !== undefined ? clamp01(patch.sfxVolume) : volumes.sfxVolume,
        musicVolume:
          patch.musicVolume !== undefined ? clamp01(patch.musicVolume) : volumes.musicVolume,
      };
      applyBusVolumes();
    },
    setVisibility(visible) {
      if (!ctx || disposed) return;
      if (!visible) {
        if (ctx.state === 'running') void ctx.suspend().catch(() => undefined);
      } else if (unlocked && ctx.state === 'suspended') {
        void ctx.resume().catch(() => undefined);
      }
    },
    updateListener(camera) {
      if (!ctx || !unlocked || disposed) return;
      const listener = ctx.listener;
      if (!listener) return;
      camera.getWorldPosition(listenerPos);
      camera.getWorldQuaternion(listenerQuat);
      listenerFwd.set(0, 0, -1).applyQuaternion(listenerQuat).normalize();
      listenerUp.set(0, 1, 0).applyQuaternion(listenerQuat).normalize();

      if (listener.positionX) {
        listener.positionX.value = listenerPos.x;
        listener.positionY.value = listenerPos.y;
        listener.positionZ.value = listenerPos.z;
        listener.forwardX.value = listenerFwd.x;
        listener.forwardY.value = listenerFwd.y;
        listener.forwardZ.value = listenerFwd.z;
        listener.upX.value = listenerUp.x;
        listener.upY.value = listenerUp.y;
        listener.upZ.value = listenerUp.z;
      } else if (typeof listener.setPosition === 'function') {
        listener.setPosition(listenerPos.x, listenerPos.y, listenerPos.z);
        listener.setOrientation(
          listenerFwd.x,
          listenerFwd.y,
          listenerFwd.z,
          listenerUp.x,
          listenerUp.y,
          listenerUp.z,
        );
      }
    },
    play,
    syncOpenPortals(portals) {
      const activeIds = new Set<string>();
      for (const portal of portals) {
        if (!portal.isOpen) continue;
        activeIds.add(portal.id);
        lastOpenPortals.set(portal.id, portal.position);
        startPortalAmbient(portal.id, portal.position);
      }
      for (const id of [...lastOpenPortals.keys()]) {
        if (!activeIds.has(id)) {
          lastOpenPortals.delete(id);
          stopPortalAmbient(id);
        }
      }
    },
    processSimEvents(events, simState) {
      if (disposed) return;
      // 1. Track turret target acquisition (servo slew) and Rail Sniper pre-fire charge
      const liveTurretIds = new Set<string>();
      for (const t of simState.turrets) {
        liveTurretIds.add(t.id);
        const prevTarget = prevTurretTarget.get(t.id) ?? null;
        if (t.targetEnemyId && t.targetEnemyId !== prevTarget && t.disabledRemainingSec <= 0) {
          play('turret-servo', { position: t.position, gainScale: 0.8 });
        }
        prevTurretTarget.set(t.id, t.targetEnemyId);

        if (t.kind === 'rail-sniper' && t.targetEnemyId && t.disabledRemainingSec <= 0) {
          if (
            t.fireCooldownSec > 0.1 &&
            t.fireCooldownSec <= 0.65 &&
            !railChargedTurrets.has(t.id)
          ) {
            railChargedTurrets.add(t.id);
            play('rail-charge', { position: t.position });
          } else if (t.fireCooldownSec > 0.8) {
            railChargedTurrets.delete(t.id);
          }
        } else {
          railChargedTurrets.delete(t.id);
        }
      }
      for (const id of [...prevTurretTarget.keys()]) {
        if (!liveTurretIds.has(id)) {
          prevTurretTarget.delete(id);
          railChargedTurrets.delete(id);
        }
      }

      // 2. Keep open portal ambient spatial emitters synced
      this.syncOpenPortals(simState.portals);

      // 3. Dispatch discrete SimEvents to their exact approved SFX cues
      for (const ev of events) {
        switch (ev.type) {
          case 'turret-placed':
            play(ev.mountProfile === 'hover-pod' ? 'hover-pod' : 'surface-clamp', {
              position: ev.position,
            });
            break;
          case 'turret-upgraded': {
            const turret = simState.turrets.find((t) => t.id === ev.turretId);
            play('tier-upgrade', { position: turret?.position ?? null });
            break;
          }
          case 'turret-relocated':
            play('relocate', { position: ev.toPosition });
            break;
          case 'turret-sold':
            play('sell', { position: ev.position });
            break;
          case 'turret-fired':
            if (ev.turretKind === 'autocannon') {
              play('autocannon-burst', { position: ev.fromPosition });
            } else if (ev.turretKind === 'plasma-mortar') {
              play('plasma-launch', { position: ev.fromPosition });
            } else if (ev.turretKind === 'cryo-arc') {
              play('cryo-charge', { position: ev.fromPosition });
            } else if (ev.turretKind === 'rail-sniper') {
              railChargedTurrets.delete(ev.turretId);
              play('rail-crack', { position: ev.fromPosition });
            }
            break;
          case 'projectile-impact':
            if (ev.turretKind === 'plasma-mortar') {
              play('plasma-detonation', { position: ev.position });
            }
            break;
          case 'cryo-chain':
            play('cryo-chain', { position: ev.chainPositions[0] ?? null });
            break;
          case 'enemy-hit':
            if (!ev.isDot && ev.damageType === 'kinetic') {
              if (ev.archetypeId === 'carapace-brute') {
                play('brute', { position: ev.position, gainScale: 0.55 });
              } else {
                play('autocannon-impact', { position: ev.position });
              }
            }
            break;
          case 'enemy-spawned':
            if (ev.isBoss) {
              play('broodlord', { position: ev.position });
            }
            break;
          case 'enemy-killed':
            if (ev.isBoss || ev.archetypeId === 'apex-broodlord') {
              play('boss-collapse', { position: ev.position });
            } else if (ev.archetypeId === 'skitter-crawler') {
              play('skitter', { position: ev.position });
            } else if (ev.archetypeId === 'wasp-skimmer') {
              play('wasp', { position: ev.position });
            } else if (ev.archetypeId === 'carapace-brute') {
              play('brute', { position: ev.position });
            } else if (ev.archetypeId === 'rift-disruptor') {
              play('disruptor', { position: ev.position, gainScale: 0.72 });
            }
            break;
          case 'turret-disrupted':
            if (ev.sourceArchetypeId === 'apex-broodlord') {
              play('broodlord', { position: ev.position, gainScale: 0.88 });
            } else {
              play('disruptor', { position: ev.position });
            }
            break;
          case 'boss-phase2':
            play('broodlord', { position: ev.position, gainScale: 1.0 });
            break;
          case 'portal-opened':
            play('rift-tear', { position: ev.position });
            break;
          case 'core-hit':
            play('core-shield-hit', { position: ev.position });
            if (ev.maxCoreHp > 0 && ev.remainingCoreHp / ev.maxCoreHp <= 0.3) {
              play('core-critical');
            }
            break;
          case 'wave-started':
            play('wave-incoming');
            break;
          default:
            break;
        }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (typeof window !== 'undefined') {
        window.removeEventListener('pointerdown', onGesture);
        window.removeEventListener('keydown', onGesture);
        window.removeEventListener('touchstart', onGesture);
      }
      if (duckResetTimer !== null) {
        clearTimeout(duckResetTimer);
        duckResetTimer = null;
      }
      for (const voice of [...activeVoices]) {
        stopVoice(voice);
      }
      for (const id of [...portalAmbients.keys()]) {
        stopPortalAmbient(id);
      }
      lastOpenPortals.clear();
      prevTurretTarget.clear();
      railChargedTurrets.clear();
      decodedBuffers.clear();
      inflightLoads.clear();
      if (ctx) {
        void ctx.close().catch(() => undefined);
        ctx = null;
      }
      masterGain = null;
      sfxBusGain = null;
      duckingGain = null;
      criticalBusGain = null;
    },
  };
}
