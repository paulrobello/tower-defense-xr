import type { SfxCueId } from './engine.ts';

const SAMPLE_RATE = 24000;
const TAU = Math.PI * 2;

type CueShape = readonly [
  durationSec: number,
  fromHz: number,
  toHz: number,
  noiseMix: number,
  pulses?: number,
];

// Voice envelopes and sweeps for the built-in effects used by clean public builds.
const CUE_SHAPES: Readonly<Record<Exclude<SfxCueId, 'rift-ambient'>, CueShape>> = {
  'surface-clamp': [0.16, 410, 160, 0.58, 2],
  'hover-pod': [0.28, 190, 570, 0.12],
  'invalid-placement': [0.22, 275, 150, 0.08, 2],
  relocate: [0.25, 400, 240, 0.23],
  sell: [0.34, 340, 720, 0.04, 3],
  'radial-tick': [0.055, 940, 620, 0.16],
  'autocannon-burst': [0.21, 164, 58, 0.82, 3],
  'autocannon-impact': [0.12, 213, 81, 0.74],
  'plasma-launch': [0.32, 260, 570, 0.32],
  'plasma-detonation': [0.64, 110, 38, 0.71],
  'cryo-charge': [0.44, 220, 1010, 0.09],
  'cryo-chain': [0.26, 1350, 425, 0.62, 4],
  'rail-charge': [0.54, 115, 670, 0.18],
  'rail-crack': [0.21, 290, 70, 0.82],
  'turret-servo': [0.18, 150, 320, 0.48],
  'tier-upgrade': [0.49, 280, 830, 0.08, 3],
  'rift-tear': [0.67, 110, 420, 0.62],
  skitter: [0.16, 560, 245, 0.45, 3],
  wasp: [0.26, 440, 560, 0.37, 4],
  brute: [0.39, 130, 56, 0.57],
  disruptor: [0.37, 1120, 295, 0.51, 3],
  broodlord: [0.75, 162, 53, 0.49],
  'boss-collapse': [1.05, 90, 34, 0.76],
  'wave-incoming': [0.69, 420, 242, 0.08, 3],
  'core-shield-hit': [0.3, 560, 104, 0.42],
  'core-critical': [0.96, 550, 265, 0.1, 4],
  'mission-confirm': [0.66, 390, 780, 0.03, 3],
};

/** Synthesizes original mono PCM once per cue and reuses the engine's spatial and volume routing. */
export function createBuiltinSfxBuffer(context: AudioContext, cueId: SfxCueId): AudioBuffer {
  if (cueId === 'rift-ambient') {
    const buffer = context.createBuffer(1, SAMPLE_RATE * 4, SAMPLE_RATE);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) {
      const t = (TAU * i) / SAMPLE_RATE;
      // Each layer completes whole cycles across the four-second loop.
      samples[i] =
        (0.07 + 0.035 * Math.sin(t / 4)) * Math.sin(t * 82) +
        0.038 * Math.sin(t * 123 + Math.sin(t / 2) * 0.6) +
        0.033 * Math.sin(t * 166);
    }
    return buffer;
  }

  const [duration, fromHz, toHz, noiseMix, pulses = 1] = CUE_SHAPES[cueId];
  const buffer = context.createBuffer(1, Math.round(SAMPLE_RATE * duration), SAMPLE_RATE);
  const samples = buffer.getChannelData(0);
  let random = 0x37a0d2fc;
  let noise = 0;
  let phase = 0;
  const pulseDuration = duration / pulses;
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / SAMPLE_RATE;
    const progress = t / duration;
    const withinPulse = (t % pulseDuration) / pulseDuration;
    const attack = Math.min(1, (withinPulse * pulseDuration) / 0.006);
    const envelope = attack * Math.exp(-4.2 * withinPulse) * Math.min(1, (1 - withinPulse) * 6);
    phase += (TAU * (fromHz + (toHz - fromHz) * progress)) / SAMPLE_RATE;
    random = (Math.imul(1664525, random) + 1013904223) >>> 0;
    const white = random / 0x80000000 - 1;
    noise = 0.78 * noise + 0.22 * white;
    const tone = Math.sin(phase) * 0.8 + Math.sin(phase * 2.02) * 0.2;
    samples[i] =
      0.5 * envelope * (tone * (1 - noiseMix) + (noise * 0.75 + white * 0.25) * noiseMix);
  }
  return buffer;
}
