/**
 * Complete 12-Wave + Apex Broodlord Boss mission timeline, economy rules, Quest 3 active caps,
 * and Suno soundtrack cue mapping.
 * Pure TypeScript data & calculation helpers — ZERO Three.js imports.
 *
 * References:
 * - PRD.md §D8 (12-Wave Mission), §Quest 3 Budgets (<=4 portals, <=25 active enemies)
 * - suno-music-prompt.md (Cue Map: Tactical Command Deck, Perimeter Scan, First Contact,
 *   Breach Protocol, Perimeter Overload, Broodlord Siege, Sector Secured, Bastion Lost)
 * - plans/phase-2-combat-simulation-and-waves.md (P2-T2)
 */

import { ENEMIES, type EnemyId } from './enemies.ts';

export const MUSIC_CUE_IDS = [
  'tactical-command-deck',
  'perimeter-scan',
  'first-contact',
  'breach-protocol',
  'perimeter-overload',
  'broodlord-siege',
  'sector-secured',
  'bastion-lost',
] as const;

export type MusicCueId = (typeof MUSIC_CUE_IDS)[number];

export const COMBAT_MUSIC_CUE_IDS = [
  'first-contact',
  'breach-protocol',
  'perimeter-overload',
  'broodlord-siege',
] as const;

export type CombatMusicCueId = (typeof COMBAT_MUSIC_CUE_IDS)[number];

export interface MusicCueDefinition {
  readonly id: MusicCueId;
  readonly trackNumber: number;
  readonly title: string;
  readonly bpm: number;
  readonly keySignature: string;
  readonly loop: boolean;
  readonly nominalDurationSec: number;
  readonly usageContext: string;
}

export const MUSIC_CUES: Readonly<Record<MusicCueId, MusicCueDefinition>> = {
  'tactical-command-deck': {
    id: 'tactical-command-deck',
    trackNumber: 1,
    title: 'Tactical Command Deck',
    bpm: 96,
    keySignature: 'D minor',
    loop: true,
    nominalDurationSec: 120,
    usageContext: 'Launch screen, mission briefing, and Settings',
  },
  'perimeter-scan': {
    id: 'perimeter-scan',
    trackNumber: 2,
    title: 'Perimeter Scan',
    bpm: 100,
    keySignature: 'D minor',
    loop: true,
    nominalDurationSec: 120,
    usageContext: 'Pre-mission Core calibration and wave intermissions',
  },
  'first-contact': {
    id: 'first-contact',
    trackNumber: 3,
    title: 'First Contact',
    bpm: 118,
    keySignature: 'D minor',
    loop: true,
    nominalDurationSec: 120,
    usageContext: 'Waves 1–4 (early skirmishes, Skitter Crawlers & Wasp Skimmers)',
  },
  'breach-protocol': {
    id: 'breach-protocol',
    trackNumber: 4,
    title: 'Breach Protocol',
    bpm: 126,
    keySignature: 'D minor',
    loop: true,
    nominalDurationSec: 120,
    usageContext: 'Waves 5–8 (armored Carapace Brutes & multi-portal pressure)',
  },
  'perimeter-overload': {
    id: 'perimeter-overload',
    trackNumber: 5,
    title: 'Perimeter Overload',
    bpm: 132,
    keySignature: 'D minor',
    loop: true,
    nominalDurationSec: 120,
    usageContext: 'Waves 9–11 (Rift Disruptors, air + ground saturation)',
  },
  'broodlord-siege': {
    id: 'broodlord-siege',
    trackNumber: 6,
    title: 'Broodlord Siege',
    bpm: 138,
    keySignature: 'D minor',
    loop: true,
    nominalDurationSec: 120,
    usageContext: 'Wave 12 Boss encounter (Apex Broodlord)',
  },
  'sector-secured': {
    id: 'sector-secured',
    trackNumber: 7,
    title: 'Sector Secured',
    bpm: 110,
    keySignature: 'D major',
    loop: false,
    nominalDurationSec: 9,
    usageContext: 'Mission Victory overlay stinger',
  },
  'bastion-lost': {
    id: 'bastion-lost',
    trackNumber: 8,
    title: 'Bastion Lost',
    bpm: 82,
    keySignature: 'D minor',
    loop: false,
    nominalDurationSec: 7,
    usageContext: 'Core Destroyed / Defeat overlay stinger',
  },
};

/** Player's initial Requisition credits at Wave 1 prep phase. */
export const STARTING_CREDITS = 400;

/** Core Bastion maximum hit points (`100` makes percentage star ratings exact). */
export const CORE_MAX_HP = 100;

/** Initial preparation phase duration before Wave 1 auto-launches (seconds). */
export const INITIAL_PREP_DURATION_SEC = 20;

/** Standard intermission build countdown between waves (seconds, skippable for bonus credits). */
export const INTERMISSION_DURATION_SEC = 15;

/** Bonus Requisition credits awarded per full second skipped via "Launch Wave Early". */
export const EARLY_LAUNCH_CREDITS_PER_SEC = 2;

/** Maximum Requisition credit bonus earned by launching immediately (`15 s * 2 = 30`). */
export const EARLY_LAUNCH_MAX_BONUS_CREDITS =
  INTERMISSION_DURATION_SEC * EARLY_LAUNCH_CREDITS_PER_SEC;

/** Hard Quest 3 budget ceiling on simultaneously active dimensional rift portals (`1..4`). */
export const MAX_CONCURRENT_PORTALS = 4;

/** Hard Quest 3 budget ceiling on simultaneously active enemies in the room (`<= 25`). */
export const MAX_ACTIVE_ENEMIES = 25;

/** Minimum Euclidean clearance between the Core Bastion and any wall/ceiling portal anchor (meters). */
export const MIN_PORTAL_DISTANCE_FROM_CORE_M = 2.0;

/** Total number of waves in the vertical-slice mission. */
export const TOTAL_WAVES = 12;

/** Target mission pacing bounds (10–15 minutes = 600–900 seconds). */
export const MISSION_TARGET_MIN_DURATION_SEC = 600;
export const MISSION_TARGET_MAX_DURATION_SEC = 900;

/** Scale physical gameplay objects around their room-anchored origins. */
export const GAMEPLAY_OBJECT_SCALE = 0.45;

/** Blockout & Quest 3 budget specs for Core Bastion and Dimensional Rift Portal Frame. */
export const CORE_BASTION_SPEC = {
  radiusM: 0.38,
  heightM: 0.72,
  shieldDomeRadiusM: 0.52,
  keepOutRadiusM: 0.55,
  maxTris: 14000,
  textureSizePx: 2048,
} as const;

/** Radius of the visible Core shield in the room. */
export const CORE_SHIELD_RADIUS_M = CORE_BASTION_SPEC.shieldDomeRadiusM * GAMEPLAY_OBJECT_SCALE;

export const RIFT_PORTAL_SPEC = {
  apertureWidthM: 0.95,
  apertureHeightM: 1.35,
  rimThicknessM: 0.12,
  recessDepthM: 0.45,
  keepOutRadiusM: 0.65,
  minDistanceFromCoreM: MIN_PORTAL_DISTANCE_FROM_CORE_M,
  maxTris: 4500,
  textureSizePx: 1024,
} as const;

export interface StarRatingThresholds {
  readonly oneStarMinHpRatio: number;
  readonly twoStarMinHpRatio: number;
  readonly threeStarMinHpRatio: number;
}

export const STAR_RATING_THRESHOLDS: StarRatingThresholds = {
  oneStarMinHpRatio: 0.01,
  twoStarMinHpRatio: 0.6,
  threeStarMinHpRatio: 0.9,
};

export interface MissionConfig {
  readonly id: string;
  readonly title: string;
  readonly totalWaves: number;
  readonly startingCredits: number;
  readonly coreMaxHp: number;
  readonly initialPrepDurationSec: number;
  readonly intermissionDurationSec: number;
  readonly earlyLaunchCreditsPerSec: number;
  readonly earlyLaunchMaxBonusCredits: number;
  readonly maxConcurrentPortals: number;
  readonly maxActiveEnemies: number;
  readonly minPortalDistanceFromCoreM: number;
  readonly targetDurationMinSec: number;
  readonly targetDurationMaxSec: number;
  readonly prepMusicCue: MusicCueId;
  readonly victoryMusicCue: MusicCueId;
  readonly defeatMusicCue: MusicCueId;
  readonly starThresholds: StarRatingThresholds;
}

export const MISSION_CONFIG: MissionConfig = {
  id: 'rift-bastion-vertical-slice',
  title: 'Operation Rift Bastion',
  totalWaves: TOTAL_WAVES,
  startingCredits: STARTING_CREDITS,
  coreMaxHp: CORE_MAX_HP,
  initialPrepDurationSec: INITIAL_PREP_DURATION_SEC,
  intermissionDurationSec: INTERMISSION_DURATION_SEC,
  earlyLaunchCreditsPerSec: EARLY_LAUNCH_CREDITS_PER_SEC,
  earlyLaunchMaxBonusCredits: EARLY_LAUNCH_MAX_BONUS_CREDITS,
  maxConcurrentPortals: MAX_CONCURRENT_PORTALS,
  maxActiveEnemies: MAX_ACTIVE_ENEMIES,
  minPortalDistanceFromCoreM: MIN_PORTAL_DISTANCE_FROM_CORE_M,
  targetDurationMinSec: MISSION_TARGET_MIN_DURATION_SEC,
  targetDurationMaxSec: MISSION_TARGET_MAX_DURATION_SEC,
  prepMusicCue: 'perimeter-scan',
  victoryMusicCue: 'sector-secured',
  defeatMusicCue: 'bastion-lost',
  starThresholds: STAR_RATING_THRESHOLDS,
};

export interface WaveSpawnGroup {
  readonly groupId: string;
  readonly enemyId: EnemyId;
  /** Number of units spawned by this group (`>= 1`). */
  readonly count: number;
  /** Zero-based portal slot index (`0 .. concurrentPortals - 1`). */
  readonly portalIndex: number;
  /** Seconds after wave start when the first unit in this group spawns. */
  readonly startDelaySec: number;
  /** Seconds between consecutive unit spawns in this group. */
  readonly spawnIntervalSec: number;
}

export type WavePhaseAct = 'act-1-contact' | 'act-2-breach' | 'act-3-overload' | 'act-4-boss';

export interface WaveDefinition {
  /** 1-indexed wave number (`1..12`). */
  readonly waveNumber: number;
  readonly id: string;
  readonly title: string;
  readonly tacticalBrief: string;
  readonly act: WavePhaseAct;
  readonly isBossWave: boolean;
  /** Number of active wall/ceiling rift portals during this wave (`1..4`). */
  readonly concurrentPortals: number;
  /** Per-wave simultaneous active enemy cap (`<= 25`). */
  readonly maxActiveEnemies: number;
  /** Soundtrack cue from `suno-music-prompt.md` active during this wave. */
  readonly musicCue: CombatMusicCueId;
  /** Bonus Requisition credits awarded immediately upon clearing the wave. */
  readonly clearBonusCredits: number;
  /** Intermission countdown following this wave (`15 s` for Waves 1–11; `0 s` after Wave 12). */
  readonly intermissionAfterSec: number;
  /** Expected seconds after the final spawn for all surviving units to traverse or be cleared. */
  readonly expectedClearTailSec: number;
  readonly spawnGroups: readonly WaveSpawnGroup[];
}

export const WAVES: readonly WaveDefinition[] = [
  // =========================================================================
  // ACT I — FIRST CONTACT (Waves 1–4: introductory crawlers & skimmers)
  // Music Cue: 'first-contact' (118 BPM · D minor)
  // =========================================================================
  {
    waveNumber: 1,
    id: 'wave-01',
    title: 'First Contact',
    tacticalBrief:
      'A single wall rift opens ahead. Skitter Crawlers descend onto the floor toward the Core.',
    act: 'act-1-contact',
    isBossWave: false,
    concurrentPortals: 1,
    maxActiveEnemies: 10,
    musicCue: 'first-contact',
    clearBonusCredits: 60,
    intermissionAfterSec: INTERMISSION_DURATION_SEC,
    expectedClearTailSec: 11,
    spawnGroups: [
      {
        groupId: 'w1-crawlers-alpha',
        enemyId: 'skitter-crawler',
        count: 6,
        portalIndex: 0,
        startDelaySec: 0,
        spawnIntervalSec: 2.5,
      },
      {
        groupId: 'w1-crawlers-beta',
        enemyId: 'skitter-crawler',
        count: 6,
        portalIndex: 0,
        startDelaySec: 18,
        spawnIntervalSec: 2.2,
      },
    ],
  },
  {
    waveNumber: 2,
    id: 'wave-02',
    title: 'Ceiling Descent',
    tacticalBrief:
      'Denser Skitter Crawler packs surge through the primary rift in overlapping two-pronged bursts.',
    act: 'act-1-contact',
    isBossWave: false,
    concurrentPortals: 1,
    maxActiveEnemies: 12,
    musicCue: 'first-contact',
    clearBonusCredits: 70,
    intermissionAfterSec: INTERMISSION_DURATION_SEC,
    expectedClearTailSec: 11,
    spawnGroups: [
      {
        groupId: 'w2-crawlers-vanguard',
        enemyId: 'skitter-crawler',
        count: 8,
        portalIndex: 0,
        startDelaySec: 0,
        spawnIntervalSec: 2.1,
      },
      {
        groupId: 'w2-crawlers-rush',
        enemyId: 'skitter-crawler',
        count: 9,
        portalIndex: 0,
        startDelaySec: 18,
        spawnIntervalSec: 1.9,
      },
    ],
  },
  {
    waveNumber: 3,
    id: 'wave-03',
    title: 'Aerial Recon',
    tacticalBrief:
      'A second rift tears open. Wasp Skimmers fly directly through 3D room air while Crawlers push the floor.',
    act: 'act-1-contact',
    isBossWave: false,
    concurrentPortals: 2,
    maxActiveEnemies: 14,
    musicCue: 'first-contact',
    clearBonusCredits: 80,
    intermissionAfterSec: INTERMISSION_DURATION_SEC,
    expectedClearTailSec: 12,
    spawnGroups: [
      {
        groupId: 'w3-crawlers-p0',
        enemyId: 'skitter-crawler',
        count: 8,
        portalIndex: 0,
        startDelaySec: 0,
        spawnIntervalSec: 2.2,
      },
      {
        groupId: 'w3-skimmers-p1',
        enemyId: 'wasp-skimmer',
        count: 5,
        portalIndex: 1,
        startDelaySec: 6,
        spawnIntervalSec: 3.0,
      },
      {
        groupId: 'w3-crawlers-p1',
        enemyId: 'skitter-crawler',
        count: 7,
        portalIndex: 1,
        startDelaySec: 22,
        spawnIntervalSec: 2.1,
      },
    ],
  },
  {
    waveNumber: 4,
    id: 'wave-04',
    title: 'Crossfire Swarm',
    tacticalBrief:
      'Coordinated dual-portal assault mixing fast floor packs with elevated Wasp Skimmer squadrons.',
    act: 'act-1-contact',
    isBossWave: false,
    concurrentPortals: 2,
    maxActiveEnemies: 16,
    musicCue: 'first-contact',
    clearBonusCredits: 90,
    intermissionAfterSec: INTERMISSION_DURATION_SEC,
    expectedClearTailSec: 12,
    spawnGroups: [
      {
        groupId: 'w4-crawlers-p0',
        enemyId: 'skitter-crawler',
        count: 10,
        portalIndex: 0,
        startDelaySec: 0,
        spawnIntervalSec: 2.0,
      },
      {
        groupId: 'w4-skimmers-p1',
        enemyId: 'wasp-skimmer',
        count: 7,
        portalIndex: 1,
        startDelaySec: 4,
        spawnIntervalSec: 2.5,
      },
      {
        groupId: 'w4-crawlers-p1',
        enemyId: 'skitter-crawler',
        count: 8,
        portalIndex: 1,
        startDelaySec: 20,
        spawnIntervalSec: 2.0,
      },
      {
        groupId: 'w4-skimmers-p0',
        enemyId: 'wasp-skimmer',
        count: 5,
        portalIndex: 0,
        startDelaySec: 26,
        spawnIntervalSec: 2.4,
      },
    ],
  },

  // =========================================================================
  // ACT II — BREACH PROTOCOL (Waves 5–8: armored brutes + multi-portal pressure)
  // Music Cue: 'breach-protocol' (126 BPM · D minor)
  // =========================================================================
  {
    waveNumber: 5,
    id: 'wave-05',
    title: 'Breach Protocol',
    tacticalBrief:
      'Three portals active. Heavily plated Carapace Brutes (50% kinetic armor) lead the surface advance.',
    act: 'act-2-breach',
    isBossWave: false,
    concurrentPortals: 3,
    maxActiveEnemies: 18,
    musicCue: 'breach-protocol',
    clearBonusCredits: 105,
    intermissionAfterSec: INTERMISSION_DURATION_SEC,
    expectedClearTailSec: 14,
    spawnGroups: [
      {
        groupId: 'w5-brutes-p0',
        enemyId: 'carapace-brute',
        count: 3,
        portalIndex: 0,
        startDelaySec: 0,
        spawnIntervalSec: 7.0,
      },
      {
        groupId: 'w5-crawlers-p1',
        enemyId: 'skitter-crawler',
        count: 10,
        portalIndex: 1,
        startDelaySec: 3,
        spawnIntervalSec: 2.2,
      },
      {
        groupId: 'w5-skimmers-p2',
        enemyId: 'wasp-skimmer',
        count: 7,
        portalIndex: 2,
        startDelaySec: 10,
        spawnIntervalSec: 2.8,
      },
      {
        groupId: 'w5-crawlers-p2',
        enemyId: 'skitter-crawler',
        count: 7,
        portalIndex: 2,
        startDelaySec: 26,
        spawnIntervalSec: 2.0,
      },
    ],
  },
  {
    waveNumber: 6,
    id: 'wave-06',
    title: 'Iron Phalanx',
    tacticalBrief:
      'Dual Carapace Brute columns march under Wasp Skimmer air cover across three rift vectors.',
    act: 'act-2-breach',
    isBossWave: false,
    concurrentPortals: 3,
    maxActiveEnemies: 19,
    musicCue: 'breach-protocol',
    clearBonusCredits: 115,
    intermissionAfterSec: INTERMISSION_DURATION_SEC,
    expectedClearTailSec: 14,
    spawnGroups: [
      {
        groupId: 'w6-brutes-p0',
        enemyId: 'carapace-brute',
        count: 3,
        portalIndex: 0,
        startDelaySec: 0,
        spawnIntervalSec: 6.5,
      },
      {
        groupId: 'w6-crawlers-p1',
        enemyId: 'skitter-crawler',
        count: 10,
        portalIndex: 1,
        startDelaySec: 2,
        spawnIntervalSec: 2.1,
      },
      {
        groupId: 'w6-brutes-p2',
        enemyId: 'carapace-brute',
        count: 3,
        portalIndex: 2,
        startDelaySec: 14,
        spawnIntervalSec: 6.5,
      },
      {
        groupId: 'w6-skimmers-p0',
        enemyId: 'wasp-skimmer',
        count: 9,
        portalIndex: 0,
        startDelaySec: 18,
        spawnIntervalSec: 2.5,
      },
      {
        groupId: 'w6-crawlers-p2',
        enemyId: 'skitter-crawler',
        count: 8,
        portalIndex: 2,
        startDelaySec: 28,
        spawnIntervalSec: 1.9,
      },
    ],
  },
  {
    waveNumber: 7,
    id: 'wave-07',
    title: 'Tri-Vector Pressure',
    tacticalBrief:
      'Sustained armored siege and dense crawler packs test Cryo-Arc choke points and Plasma splash.',
    act: 'act-2-breach',
    isBossWave: false,
    concurrentPortals: 3,
    maxActiveEnemies: 20,
    musicCue: 'breach-protocol',
    clearBonusCredits: 125,
    intermissionAfterSec: INTERMISSION_DURATION_SEC,
    expectedClearTailSec: 15,
    spawnGroups: [
      {
        groupId: 'w7-crawlers-p0',
        enemyId: 'skitter-crawler',
        count: 11,
        portalIndex: 0,
        startDelaySec: 0,
        spawnIntervalSec: 1.9,
      },
      {
        groupId: 'w7-brutes-p1',
        enemyId: 'carapace-brute',
        count: 4,
        portalIndex: 1,
        startDelaySec: 4,
        spawnIntervalSec: 6.0,
      },
      {
        groupId: 'w7-skimmers-p2',
        enemyId: 'wasp-skimmer',
        count: 10,
        portalIndex: 2,
        startDelaySec: 8,
        spawnIntervalSec: 2.4,
      },
      {
        groupId: 'w7-brutes-p0',
        enemyId: 'carapace-brute',
        count: 3,
        portalIndex: 0,
        startDelaySec: 22,
        spawnIntervalSec: 6.0,
      },
      {
        groupId: 'w7-crawlers-p2',
        enemyId: 'skitter-crawler',
        count: 9,
        portalIndex: 2,
        startDelaySec: 28,
        spawnIntervalSec: 1.9,
      },
    ],
  },
  {
    waveNumber: 8,
    id: 'wave-08',
    title: 'Quad-Rift Convergence',
    tacticalBrief:
      'All four dimensional rifts open simultaneously, converging armored Brutes and Skimmers on the Core.',
    act: 'act-2-breach',
    isBossWave: false,
    concurrentPortals: 4,
    maxActiveEnemies: 22,
    musicCue: 'breach-protocol',
    clearBonusCredits: 140,
    intermissionAfterSec: INTERMISSION_DURATION_SEC,
    expectedClearTailSec: 15,
    spawnGroups: [
      {
        groupId: 'w8-brutes-p0',
        enemyId: 'carapace-brute',
        count: 4,
        portalIndex: 0,
        startDelaySec: 0,
        spawnIntervalSec: 6.0,
      },
      {
        groupId: 'w8-crawlers-p1',
        enemyId: 'skitter-crawler',
        count: 11,
        portalIndex: 1,
        startDelaySec: 2,
        spawnIntervalSec: 1.9,
      },
      {
        groupId: 'w8-skimmers-p2',
        enemyId: 'wasp-skimmer',
        count: 10,
        portalIndex: 2,
        startDelaySec: 6,
        spawnIntervalSec: 2.3,
      },
      {
        groupId: 'w8-brutes-p3',
        enemyId: 'carapace-brute',
        count: 4,
        portalIndex: 3,
        startDelaySec: 16,
        spawnIntervalSec: 5.8,
      },
      {
        groupId: 'w8-crawlers-p3',
        enemyId: 'skitter-crawler',
        count: 10,
        portalIndex: 3,
        startDelaySec: 28,
        spawnIntervalSec: 1.8,
      },
    ],
  },

  // =========================================================================
  // ACT III — PERIMETER OVERLOAD (Waves 9–11: disruptors + saturated air/ground)
  // Music Cue: 'perimeter-overload' (132 BPM · D minor)
  // =========================================================================
  {
    waveNumber: 9,
    id: 'wave-09',
    title: 'Signal Blackout',
    tacticalBrief:
      'Rift Disruptors enter the airspace, pulsing 4 s EMP fields within 1.2 m. Prioritize them with Rail Snipers!',
    act: 'act-3-overload',
    isBossWave: false,
    concurrentPortals: 4,
    maxActiveEnemies: 22,
    musicCue: 'perimeter-overload',
    clearBonusCredits: 155,
    intermissionAfterSec: INTERMISSION_DURATION_SEC,
    expectedClearTailSec: 15,
    spawnGroups: [
      {
        groupId: 'w9-disruptors-p0',
        enemyId: 'rift-disruptor',
        count: 3,
        portalIndex: 0,
        startDelaySec: 0,
        spawnIntervalSec: 9.0,
      },
      {
        groupId: 'w9-crawlers-p1',
        enemyId: 'skitter-crawler',
        count: 11,
        portalIndex: 1,
        startDelaySec: 2,
        spawnIntervalSec: 1.9,
      },
      {
        groupId: 'w9-brutes-p2',
        enemyId: 'carapace-brute',
        count: 4,
        portalIndex: 2,
        startDelaySec: 6,
        spawnIntervalSec: 6.0,
      },
      {
        groupId: 'w9-skimmers-p3',
        enemyId: 'wasp-skimmer',
        count: 10,
        portalIndex: 3,
        startDelaySec: 12,
        spawnIntervalSec: 2.3,
      },
      {
        groupId: 'w9-disruptors-p2',
        enemyId: 'rift-disruptor',
        count: 2,
        portalIndex: 2,
        startDelaySec: 24,
        spawnIntervalSec: 8.0,
      },
      {
        groupId: 'w9-crawlers-p0',
        enemyId: 'skitter-crawler',
        count: 8,
        portalIndex: 0,
        startDelaySec: 30,
        spawnIntervalSec: 1.8,
      },
    ],
  },
  {
    waveNumber: 10,
    id: 'wave-10',
    title: 'EMP Storm',
    tacticalBrief:
      'Multiple Rift Disruptor wings escort heavy Carapace Brute columns across all four rifts.',
    act: 'act-3-overload',
    isBossWave: false,
    concurrentPortals: 4,
    maxActiveEnemies: 24,
    musicCue: 'perimeter-overload',
    clearBonusCredits: 170,
    intermissionAfterSec: INTERMISSION_DURATION_SEC,
    expectedClearTailSec: 16,
    spawnGroups: [
      {
        groupId: 'w10-brutes-p0',
        enemyId: 'carapace-brute',
        count: 4,
        portalIndex: 0,
        startDelaySec: 0,
        spawnIntervalSec: 5.5,
      },
      {
        groupId: 'w10-disruptors-p1',
        enemyId: 'rift-disruptor',
        count: 3,
        portalIndex: 1,
        startDelaySec: 3,
        spawnIntervalSec: 8.0,
      },
      {
        groupId: 'w10-crawlers-p2',
        enemyId: 'skitter-crawler',
        count: 12,
        portalIndex: 2,
        startDelaySec: 4,
        spawnIntervalSec: 1.8,
      },
      {
        groupId: 'w10-skimmers-p3',
        enemyId: 'wasp-skimmer',
        count: 11,
        portalIndex: 3,
        startDelaySec: 10,
        spawnIntervalSec: 2.2,
      },
      {
        groupId: 'w10-disruptors-p3',
        enemyId: 'rift-disruptor',
        count: 3,
        portalIndex: 3,
        startDelaySec: 22,
        spawnIntervalSec: 7.5,
      },
      {
        groupId: 'w10-brutes-p1',
        enemyId: 'carapace-brute',
        count: 4,
        portalIndex: 1,
        startDelaySec: 24,
        spawnIntervalSec: 5.5,
      },
      {
        groupId: 'w10-crawlers-p0',
        enemyId: 'skitter-crawler',
        count: 10,
        portalIndex: 0,
        startDelaySec: 32,
        spawnIntervalSec: 1.7,
      },
    ],
  },
  {
    waveNumber: 11,
    id: 'wave-11',
    title: 'Perimeter Overload',
    tacticalBrief:
      'Full-scale multi-vector saturation! Hold the 4-portal crossfire before the Broodlord super-rift breaches.',
    act: 'act-3-overload',
    isBossWave: false,
    concurrentPortals: 4,
    maxActiveEnemies: 25,
    musicCue: 'perimeter-overload',
    clearBonusCredits: 190,
    intermissionAfterSec: INTERMISSION_DURATION_SEC,
    expectedClearTailSec: 16,
    spawnGroups: [
      {
        groupId: 'w11-crawlers-p0',
        enemyId: 'skitter-crawler',
        count: 12,
        portalIndex: 0,
        startDelaySec: 0,
        spawnIntervalSec: 1.7,
      },
      {
        groupId: 'w11-brutes-p1',
        enemyId: 'carapace-brute',
        count: 5,
        portalIndex: 1,
        startDelaySec: 2,
        spawnIntervalSec: 5.2,
      },
      {
        groupId: 'w11-disruptors-p2',
        enemyId: 'rift-disruptor',
        count: 4,
        portalIndex: 2,
        startDelaySec: 4,
        spawnIntervalSec: 7.0,
      },
      {
        groupId: 'w11-skimmers-p3',
        enemyId: 'wasp-skimmer',
        count: 12,
        portalIndex: 3,
        startDelaySec: 8,
        spawnIntervalSec: 2.1,
      },
      {
        groupId: 'w11-brutes-p2',
        enemyId: 'carapace-brute',
        count: 4,
        portalIndex: 2,
        startDelaySec: 22,
        spawnIntervalSec: 5.5,
      },
      {
        groupId: 'w11-disruptors-p0',
        enemyId: 'rift-disruptor',
        count: 3,
        portalIndex: 0,
        startDelaySec: 26,
        spawnIntervalSec: 7.0,
      },
      {
        groupId: 'w11-crawlers-p3',
        enemyId: 'skitter-crawler',
        count: 12,
        portalIndex: 3,
        startDelaySec: 32,
        spawnIntervalSec: 1.7,
      },
    ],
  },

  // =========================================================================
  // ACT IV — BROODLORD SIEGE (Wave 12: Apex Broodlord Boss + Escorts)
  // Music Cue: 'broodlord-siege' (138 BPM · D minor)
  // =========================================================================
  {
    waveNumber: 12,
    id: 'wave-12',
    title: 'Broodlord Siege',
    tacticalBrief:
      'The Apex Broodlord emerges from the primary super-rift flanked by Disruptors, Brutes, and swarm escorts!',
    act: 'act-4-boss',
    isBossWave: true,
    concurrentPortals: 4,
    maxActiveEnemies: 25,
    musicCue: 'broodlord-siege',
    clearBonusCredits: 300,
    intermissionAfterSec: 0,
    expectedClearTailSec: 28,
    spawnGroups: [
      {
        groupId: 'w12-apex-broodlord',
        enemyId: 'apex-broodlord',
        count: 1,
        portalIndex: 0,
        startDelaySec: 2,
        spawnIntervalSec: 1.0,
      },
      {
        groupId: 'w12-crawlers-escort-p1',
        enemyId: 'skitter-crawler',
        count: 10,
        portalIndex: 1,
        startDelaySec: 0,
        spawnIntervalSec: 2.0,
      },
      {
        groupId: 'w12-disruptors-p2',
        enemyId: 'rift-disruptor',
        count: 3,
        portalIndex: 2,
        startDelaySec: 6,
        spawnIntervalSec: 9.0,
      },
      {
        groupId: 'w12-skimmers-p3',
        enemyId: 'wasp-skimmer',
        count: 10,
        portalIndex: 3,
        startDelaySec: 8,
        spawnIntervalSec: 2.4,
      },
      {
        groupId: 'w12-brutes-p1',
        enemyId: 'carapace-brute',
        count: 4,
        portalIndex: 1,
        startDelaySec: 18,
        spawnIntervalSec: 6.0,
      },
      {
        groupId: 'w12-disruptors-p3',
        enemyId: 'rift-disruptor',
        count: 2,
        portalIndex: 3,
        startDelaySec: 28,
        spawnIntervalSec: 8.0,
      },
      {
        groupId: 'w12-crawlers-finale-p2',
        enemyId: 'skitter-crawler',
        count: 10,
        portalIndex: 2,
        startDelaySec: 30,
        spawnIntervalSec: 1.8,
      },
    ],
  },
];

export function getWaveDefinition(waveNumber: number): WaveDefinition {
  const wave = WAVES[waveNumber - 1];
  if (!wave || wave.waveNumber !== waveNumber) {
    throw new Error(`Invalid wave number: ${String(waveNumber)} (expected 1..${TOTAL_WAVES})`);
  }
  return wave;
}

export function getMusicCueForWave(waveNumber: number): CombatMusicCueId {
  return getWaveDefinition(waveNumber).musicCue;
}

/**
 * Computes the Requisition credit bonus earned when the player triggers "Launch Wave Early"
 * with `remainingIntermissionSec` left on the intermission timer.
 */
export function computeEarlyLaunchBonus(remainingIntermissionSec: number): number {
  const clampedSec = Math.min(INTERMISSION_DURATION_SEC, Math.max(0, remainingIntermissionSec));
  return Math.min(
    EARLY_LAUNCH_MAX_BONUS_CREDITS,
    Math.round(clampedSec * EARLY_LAUNCH_CREDITS_PER_SEC),
  );
}

/**
 * Computes the last scheduled enemy spawn timestamp (seconds from wave start) for a wave.
 */
export function computeWaveSpawnSpanSec(wave: WaveDefinition): number {
  let maxSpawnTimeSec = 0;
  for (const group of wave.spawnGroups) {
    const groupEndSec = group.startDelaySec + Math.max(0, group.count - 1) * group.spawnIntervalSec;
    if (groupEndSec > maxSpawnTimeSec) {
      maxSpawnTimeSec = groupEndSec;
    }
  }
  return maxSpawnTimeSec;
}

/**
 * Computes the expected active combat duration of a wave (spawn window + clear tail).
 */
export function computeWaveCombatDurationSec(wave: WaveDefinition): number {
  return computeWaveSpawnSpanSec(wave) + wave.expectedClearTailSec;
}

/**
 * Computes total enemy kill bounties for a wave (excluding wave clear bonus).
 */
export function computeWaveKillBountyCredits(wave: WaveDefinition): number {
  let total = 0;
  for (const group of wave.spawnGroups) {
    const enemy = ENEMIES[group.enemyId];
    total += group.count * (enemy ? enemy.creditBounty : 0);
  }
  return total;
}

/**
 * Computes total credits earned from a wave (kill bounties + clear bonus, excluding early launch).
 */
export function computeWaveTotalCredits(wave: WaveDefinition): number {
  return computeWaveKillBountyCredits(wave) + wave.clearBonusCredits;
}

/**
 * Computes total enemies spawned across all groups in a wave.
 */
export function computeWaveEnemyCount(wave: WaveDefinition): number {
  let count = 0;
  for (const group of wave.spawnGroups) {
    count += group.count;
  }
  return count;
}

/**
 * Estimates the unthrottled peak concurrent enemies alive during a wave given a conservative
 * average unit lifetime on the battlefield (`nominalLifetimeSec`, default `10.5 s`), clamped
 * by the wave's `maxActiveEnemies` spawner gate.
 */
export function estimatePeakConcurrentEnemies(
  wave: WaveDefinition,
  nominalLifetimeSec = 10.5,
): { readonly unthrottledPeak: number; readonly cappedPeak: number } {
  const spawnTimes: number[] = [];
  for (const group of wave.spawnGroups) {
    for (let i = 0; i < group.count; i += 1) {
      spawnTimes.push(group.startDelaySec + i * group.spawnIntervalSec);
    }
  }
  spawnTimes.sort((a, b) => a - b);

  let unthrottledPeak = 0;
  for (const t of spawnTimes) {
    let alive = 0;
    for (const s of spawnTimes) {
      if (s <= t && s + nominalLifetimeSec >= t) {
        alive += 1;
      }
    }
    if (alive > unthrottledPeak) {
      unthrottledPeak = alive;
    }
  }

  // Account for Broodlord Phase-1/2 add spawns (up to 4 extra alive at once during Wave 12).
  if (wave.isBossWave) {
    unthrottledPeak += 4;
  }

  return {
    unthrottledPeak,
    cappedPeak: Math.min(wave.maxActiveEnemies, unthrottledPeak),
  };
}

export interface WaveEconomySnapshot {
  readonly waveNumber: number;
  readonly enemyCount: number;
  readonly killBountyCredits: number;
  readonly clearBonusCredits: number;
  readonly waveTotalCredits: number;
  /** Cumulative credits available at the start of this wave (before its spawns). */
  readonly creditsEnteringWave: number;
  /** Cumulative credits available immediately after clearing this wave. */
  readonly creditsAfterWave: number;
}

export interface MissionEconomySummary {
  readonly startingCredits: number;
  readonly totalKillBountyCredits: number;
  readonly totalClearBonusCredits: number;
  readonly maxEarlyLaunchBonusCredits: number;
  /** Cumulative credits available entering Wave 12 Boss (before Wave 12 bounties). */
  readonly creditsEnteringBossWave: number;
  /** Total Requisition credits earned across the entire 12-wave mission (without early-launch bonus). */
  readonly totalMissionCreditsBase: number;
  /** Total Requisition credits earned across the mission if every wave is launched early. */
  readonly totalMissionCreditsWithMaxEarlyBonus: number;
  readonly waves: readonly WaveEconomySnapshot[];
}

export function computeMissionEconomySummary(): MissionEconomySummary {
  let runningCredits = STARTING_CREDITS;
  let totalKillBountyCredits = 0;
  let totalClearBonusCredits = 0;
  const snapshots: WaveEconomySnapshot[] = [];

  for (const wave of WAVES) {
    const creditsEnteringWave = runningCredits;
    const killBountyCredits = computeWaveKillBountyCredits(wave);
    const clearBonusCredits = wave.clearBonusCredits;
    const waveTotalCredits = killBountyCredits + clearBonusCredits;
    runningCredits += waveTotalCredits;
    totalKillBountyCredits += killBountyCredits;
    totalClearBonusCredits += clearBonusCredits;

    snapshots.push({
      waveNumber: wave.waveNumber,
      enemyCount: computeWaveEnemyCount(wave),
      killBountyCredits,
      clearBonusCredits,
      waveTotalCredits,
      creditsEnteringWave,
      creditsAfterWave: runningCredits,
    });
  }

  const maxEarlyLaunchBonusCredits = (TOTAL_WAVES - 1) * EARLY_LAUNCH_MAX_BONUS_CREDITS;
  const bossSnapshot = snapshots[snapshots.length - 1];

  return {
    startingCredits: STARTING_CREDITS,
    totalKillBountyCredits,
    totalClearBonusCredits,
    maxEarlyLaunchBonusCredits,
    creditsEnteringBossWave: bossSnapshot ? bossSnapshot.creditsEnteringWave : runningCredits,
    totalMissionCreditsBase: runningCredits,
    totalMissionCreditsWithMaxEarlyBonus: runningCredits + maxEarlyLaunchBonusCredits,
    waves: snapshots,
  };
}

export interface MissionDurationSummary {
  readonly totalCombatDurationSec: number;
  readonly totalIntermissionDurationSec: number;
  readonly initialPrepDurationSec: number;
  /** Fast-paced run where every intermission is skipped early (`totalCombatDurationSec`). */
  readonly fastRunDurationSec: number;
  /** Typical run where player spends ~50% of prep and intermission time (`~7.5 s` per break). */
  readonly nominalRunDurationSec: number;
  /** Full-countdown run where every prep and 15 s intermission expires completely. */
  readonly fullCountdownDurationSec: number;
}

export function computeMissionDurationSummary(): MissionDurationSummary {
  let totalCombatDurationSec = 0;
  let totalIntermissionDurationSec = 0;

  for (const wave of WAVES) {
    totalCombatDurationSec += computeWaveCombatDurationSec(wave);
    totalIntermissionDurationSec += wave.intermissionAfterSec;
  }

  const fastRunDurationSec = totalCombatDurationSec;
  const nominalRunDurationSec =
    totalCombatDurationSec +
    Math.round(INITIAL_PREP_DURATION_SEC * 0.5 + totalIntermissionDurationSec * 0.5);
  const fullCountdownDurationSec =
    totalCombatDurationSec + INITIAL_PREP_DURATION_SEC + totalIntermissionDurationSec;

  return {
    totalCombatDurationSec,
    totalIntermissionDurationSec,
    initialPrepDurationSec: INITIAL_PREP_DURATION_SEC,
    fastRunDurationSec,
    nominalRunDurationSec,
    fullCountdownDurationSec,
  };
}
