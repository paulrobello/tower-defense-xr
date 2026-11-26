/**
 * Declarative bio-mechanical / insectoid invader definitions (5 archetypes) and combat damage helpers.
 * Pure TypeScript data & calculation helpers — ZERO Three.js imports.
 *
 * References:
 * - PRD.md §D8 (5 Rigged Invader Archetypes & 12-Wave Mission), §Quest 3 Budgets
 * - plans/phase-2-combat-simulation-and-waves.md (P2-T2)
 */

import type { DamageType, MovementLayer } from './turrets.ts';

export const ENEMY_IDS = [
  'skitter-crawler',
  'wasp-skimmer',
  'carapace-brute',
  'rift-disruptor',
  'rift-spitter',
  'apex-broodlord',
] as const;

export type EnemyId = (typeof ENEMY_IDS)[number];

/**
 * Damage reduction profile per weapon damage type (`0.5` = 50% damage reduction;
 * negative values indicate a vulnerability bonus such as `-0.15` = +15% damage taken).
 */
export interface EnemyArmorProfile {
  /** Base kinetic damage reduction (`0.5` for Carapace Brute frontal armor plate). */
  readonly kineticReduction: number;
  /** Base plasma damage reduction (negative values grant bonus plasma vulnerability). */
  readonly plasmaReduction: number;
  /** Base cryo-arc damage reduction. */
  readonly cryoReduction: number;
  /** Base rail sniper damage reduction (negative values grant bonus rail vulnerability). */
  readonly railReduction: number;
  /** Whether the unit features a heavy frontal armor carapace plate. */
  readonly frontalPlate: boolean;
  /** Resistance against Cryo-Arc slow (`0` = full slow effect, `0.45` = 45% slow reduction for Boss). */
  readonly slowResistance: number;
}

/**
 * Rift Disruptor EMP ability parameters:
 * Pulses a 1.2 m electromagnetic disruption field that disables nearby turrets for 4.0 s,
 * with a mandatory post-recovery turret immunity window so turrets cannot be permastunned.
 */
export interface DisruptorEmpAbility {
  /** Radius around the Disruptor within which active turrets are disabled (meters). */
  readonly empRadiusM: number;
  /** Duration a hit turret remains disabled by an EMP pulse (seconds). */
  readonly empDisableDurationSec: number;
  /** Cadence between successive EMP pulses emitted by a Disruptor (seconds). */
  readonly empPulseIntervalSec: number;
  /** Delay after spawn before the Disruptor emits its first EMP pulse (seconds). */
  readonly initialPulseDelaySec: number;
  /** Immunity window after a turret recovers during which it cannot be re-stunned (seconds). */
  readonly turretImmunityCooldownSec: number;
}

/**
 * Wave 12 Apex Broodlord Boss mechanics:
 * - Phase-2 transition at 50% HP (`phase2HpThresholdRatio = 0.5`) cracking frontal armor open,
 *   boosting movement speed and uniform-driven armor-crack emissive glow.
 * - Periodic Skitter Crawler add spawns (with 0 credit bounty to prevent infinite credit farming).
 * - Periodic turret-suppression pulse with post-recovery immunity cooldown.
 */
export interface BroodlordBossAbility {
  /** HP ratio (`0.5` = 50% max HP) that triggers the Phase-2 armor-crack transition. */
  readonly phase2HpThresholdRatio: number;
  /** Movement speed multiplier applied in Phase 2 (`>= 1`). */
  readonly phase2SpeedMultiplier: number;
  /** Reduced kinetic armor reduction in Phase 2 after the frontal carapace cracks. */
  readonly phase2KineticReduction: number;
  /** Uniform value (`1.0`) driving the Phase-2 armor-crack emissive shader mask. */
  readonly phase2EmissiveIntensity: number;
  /** Invader archetype spawned as adds during the boss march. */
  readonly summonEnemyId: EnemyId;
  /** Number of Skitter Crawlers spawned per summon cycle in Phase 1. */
  readonly summonCountPhase1: number;
  /** Number of Skitter Crawlers spawned per summon cycle in Phase 2. */
  readonly summonCountPhase2: number;
  /** Seconds between boss add-summon cycles. */
  readonly summonIntervalSec: number;
  /** Credit bounty granted by boss-summoned adds (`0` to keep mission economy deterministic). */
  readonly summonedAddBounty: number;
  /** Radius of the Broodlord's turret-suppressing roar pulse (meters). */
  readonly suppressionPulseRadiusM: number;
  /** Seconds between Broodlord turret-suppression roar pulses. */
  readonly suppressionPulseIntervalSec: number;
  /** Seconds turrets within `suppressionPulseRadiusM` are disabled by a suppression roar. */
  readonly suppressionDisableDurationSec: number;
  /** Turret post-recovery immunity window against subsequent EMP/suppression pulses (seconds). */
  readonly suppressionImmunityCooldownSec: number;
}

export interface EnemyBlockoutDimensions {
  readonly lengthM: number;
  readonly widthM: number;
  readonly heightM: number;
  readonly healthBarOffsetHeightM: number;
}

export interface EnemyMeshBudget {
  readonly maxTris: number;
  readonly maxBones: number;
  readonly maxMaterials: number;
  readonly textureSizePx: number;
  readonly lodSwapDistanceM: number;
}

export interface EnemyDefinition {
  readonly id: EnemyId;
  readonly name: string;
  readonly shortName: string;
  readonly archetypeLabel: string;
  readonly summary: string;
  readonly maxHp: number;
  /** Base locomotion speed along surface waypoints or 3D air corridors (meters/second). */
  readonly speedMps: number;
  readonly movementLayer: MovementLayer;
  /** Whether the unit can climb down wall/ceiling portal descent splines onto floor/table planes. */
  readonly canDescendWallToFloor: boolean;
  /** Preferred flight altitude above the floor for `'air'` units (`0` for `'surface'` units). */
  readonly nominalFlightAltitudeM: number;
  readonly armor: EnemyArmorProfile;
  /** Damage inflicted on the Core Bastion if this unit reaches the Core perimeter. */
  readonly coreDamage: number;
  readonly rangedAttackRangeM?: number;
  /** Requisition credits awarded when destroyed. */
  readonly creditBounty: number;
  /** Mission score points awarded when destroyed. */
  readonly scoreValue: number;
  /** Analytic sphere/capsule radius used by spatial-hash projectile & AoE hit queries (meters). */
  readonly collisionRadiusM: number;
  readonly isBoss: boolean;
  readonly primaryColorHex: string;
  readonly emissiveColorHex: string;
  readonly disruptorAbility: DisruptorEmpAbility | null;
  readonly bossAbility: BroodlordBossAbility | null;
  readonly blockout: EnemyBlockoutDimensions;
  readonly meshBudget: EnemyMeshBudget;
}

export const ENEMIES: Readonly<Record<EnemyId, EnemyDefinition>> = {
  'skitter-crawler': {
    id: 'skitter-crawler',
    name: 'Skitter Crawler',
    shortName: 'Crawler',
    archetypeLabel: 'Fast Swarm',
    summary:
      'Agile chitinous swarm unit that climbs down wall and ceiling rift splines onto floors and furniture, sprinting in packs toward the Core.',
    maxHp: 160,
    speedMps: 0.65,
    movementLayer: 'surface',
    canDescendWallToFloor: true,
    nominalFlightAltitudeM: 0,
    armor: {
      kineticReduction: 0.0,
      plasmaReduction: 0.0,
      cryoReduction: 0.0,
      railReduction: 0.0,
      frontalPlate: false,
      slowResistance: 0.0,
    },
    coreDamage: 4,
    creditBounty: 10,
    scoreValue: 25,
    collisionRadiusM: 0.14,
    isBoss: false,
    primaryColorHex: '#3f3f46',
    emissiveColorHex: '#a855f7',
    disruptorAbility: null,
    bossAbility: null,
    blockout: {
      lengthM: 0.34,
      widthM: 0.26,
      heightM: 0.18,
      healthBarOffsetHeightM: 0.28,
    },
    meshBudget: {
      maxTris: 4500,
      maxBones: 24,
      maxMaterials: 2,
      textureSizePx: 1024,
      lodSwapDistanceM: 6.0,
    },
  },
  'wasp-skimmer': {
    id: 'wasp-skimmer',
    name: 'Wasp Skimmer',
    shortName: 'Skimmer',
    archetypeLabel: 'Aerial Striker',
    summary:
      'High-speed bio-mechanical flyer that darts directly from wall and ceiling portals through 3D open-air room corridors, bypassing floor furniture.',
    maxHp: 210,
    speedMps: 0.72,
    movementLayer: 'air',
    canDescendWallToFloor: false,
    nominalFlightAltitudeM: 1.35,
    armor: {
      kineticReduction: 0.05,
      plasmaReduction: 0.1,
      cryoReduction: 0.0,
      railReduction: 0.0,
      frontalPlate: false,
      slowResistance: 0.0,
    },
    coreDamage: 5,
    creditBounty: 14,
    scoreValue: 35,
    collisionRadiusM: 0.16,
    isBoss: false,
    primaryColorHex: '#312e81',
    emissiveColorHex: '#2dd4bf',
    disruptorAbility: null,
    bossAbility: null,
    blockout: {
      lengthM: 0.38,
      widthM: 0.42,
      heightM: 0.22,
      healthBarOffsetHeightM: 0.32,
    },
    meshBudget: {
      maxTris: 6500,
      maxBones: 24,
      maxMaterials: 2,
      textureSizePx: 1024,
      lodSwapDistanceM: 6.0,
    },
  },
  'carapace-brute': {
    id: 'carapace-brute',
    name: 'Carapace Brute',
    shortName: 'Brute',
    archetypeLabel: 'Armored Heavy',
    summary:
      'Heavy floor-stomping siege organism plated in dense frontal chitin that reduces kinetic damage by 50%, requiring Rail Sniper or Plasma Mortar fire.',
    maxHp: 880,
    speedMps: 0.34,
    movementLayer: 'surface',
    canDescendWallToFloor: true,
    nominalFlightAltitudeM: 0,
    armor: {
      kineticReduction: 0.5,
      plasmaReduction: -0.15,
      cryoReduction: 0.0,
      railReduction: -0.2,
      frontalPlate: true,
      slowResistance: 0.15,
    },
    coreDamage: 12,
    creditBounty: 32,
    scoreValue: 90,
    collisionRadiusM: 0.24,
    isBoss: false,
    primaryColorHex: '#1e293b',
    emissiveColorHex: '#f97316',
    disruptorAbility: null,
    bossAbility: null,
    blockout: {
      lengthM: 0.52,
      widthM: 0.46,
      heightM: 0.48,
      healthBarOffsetHeightM: 0.6,
    },
    meshBudget: {
      maxTris: 9000,
      maxBones: 28,
      maxMaterials: 2,
      textureSizePx: 1024,
      lodSwapDistanceM: 6.0,
    },
  },
  'rift-disruptor': {
    id: 'rift-disruptor',
    name: 'Rift Disruptor',
    shortName: 'Disruptor',
    archetypeLabel: 'Aerial Tactical Support',
    summary:
      'Hovering dimensional support unit that glides toward turret clusters and emits a 1.2 m EMP field disabling turrets for 4 s (with recovery immunity cooldown).',
    maxHp: 500,
    speedMps: 0.45,
    movementLayer: 'air',
    canDescendWallToFloor: false,
    nominalFlightAltitudeM: 1.45,
    armor: {
      kineticReduction: 0.15,
      plasmaReduction: 0.05,
      cryoReduction: 0.0,
      railReduction: -0.15,
      frontalPlate: false,
      slowResistance: 0.1,
    },
    coreDamage: 8,
    creditBounty: 28,
    scoreValue: 85,
    collisionRadiusM: 0.2,
    isBoss: false,
    primaryColorHex: '#4c1d95',
    emissiveColorHex: '#38bdf8',
    disruptorAbility: {
      empRadiusM: 1.2,
      empDisableDurationSec: 4.0,
      empPulseIntervalSec: 6.5,
      initialPulseDelaySec: 2.5,
      turretImmunityCooldownSec: 5.0,
    },
    bossAbility: null,
    blockout: {
      lengthM: 0.42,
      widthM: 0.44,
      heightM: 0.32,
      healthBarOffsetHeightM: 0.44,
    },
    meshBudget: {
      maxTris: 6500,
      maxBones: 24,
      maxMaterials: 2,
      textureSizePx: 1024,
      lodSwapDistanceM: 6.0,
    },
  },
  'rift-spitter': {
    id: 'rift-spitter',
    name: 'Rift Spitter',
    shortName: 'Spitter',
    archetypeLabel: 'Ranged Artillery',
    summary:
      'A ground invader that stops at firing distance and spits charged bolts at exposed defenses.',
    maxHp: 160,
    speedMps: 0.52,
    movementLayer: 'surface',
    canDescendWallToFloor: true,
    nominalFlightAltitudeM: 0,
    armor: {
      kineticReduction: 0,
      plasmaReduction: 0,
      cryoReduction: 0,
      railReduction: 0,
      frontalPlate: false,
      slowResistance: 0,
    },
    coreDamage: 4,
    rangedAttackRangeM: 1.65,
    creditBounty: 10,
    scoreValue: 30,
    collisionRadiusM: 0.17,
    isBoss: false,
    primaryColorHex: '#52604a',
    emissiveColorHex: '#b9f472',
    disruptorAbility: null,
    bossAbility: null,
    blockout: { lengthM: 0.4, widthM: 0.3, heightM: 0.24, healthBarOffsetHeightM: 0.34 },
    meshBudget: {
      maxTris: 4500,
      maxBones: 24,
      maxMaterials: 2,
      textureSizePx: 1024,
      lodSwapDistanceM: 6,
    },
  },
  'apex-broodlord': {
    id: 'apex-broodlord',
    name: 'Apex Broodlord',
    shortName: 'Broodlord',
    archetypeLabel: 'Wave 12 Boss Matriarch',
    summary:
      'Massive bio-mechanical matriarch emerging from the Wave 12 super-rift; spawns Skitter adds, pulses turret-suppressing roars, and enters an armor-cracked Phase 2 frenzy at 50% HP.',
    maxHp: 11200,
    speedMps: 0.12,
    movementLayer: 'surface',
    canDescendWallToFloor: true,
    nominalFlightAltitudeM: 0,
    armor: {
      kineticReduction: 0.4,
      plasmaReduction: 0.05,
      cryoReduction: 0.15,
      railReduction: -0.1,
      frontalPlate: true,
      slowResistance: 0.45,
    },
    coreDamage: 100,
    creditBounty: 250,
    scoreValue: 1200,
    collisionRadiusM: 0.42,
    isBoss: true,
    primaryColorHex: '#18181b',
    emissiveColorHex: '#ec4899',
    disruptorAbility: null,
    bossAbility: {
      phase2HpThresholdRatio: 0.5,
      phase2SpeedMultiplier: 1.3,
      phase2KineticReduction: 0.15,
      phase2EmissiveIntensity: 1.0,
      summonEnemyId: 'skitter-crawler',
      summonCountPhase1: 3,
      summonCountPhase2: 4,
      summonIntervalSec: 8.5,
      summonedAddBounty: 0,
      suppressionPulseRadiusM: 1.5,
      suppressionPulseIntervalSec: 10.5,
      suppressionDisableDurationSec: 3.0,
      suppressionImmunityCooldownSec: 5.0,
    },
    blockout: {
      lengthM: 0.92,
      widthM: 0.78,
      heightM: 0.84,
      healthBarOffsetHeightM: 1.02,
    },
    meshBudget: {
      maxTris: 28000,
      maxBones: 48,
      maxMaterials: 3,
      textureSizePx: 2048,
      lodSwapDistanceM: 8.0,
    },
  },
};

export const ENEMY_LIST: readonly EnemyDefinition[] = ENEMY_IDS.map((id) => ENEMIES[id]);

export function getEnemyDefinition(id: EnemyId): EnemyDefinition {
  const def = ENEMIES[id];
  if (!def) {
    throw new Error(`Unknown enemy id: ${String(id)}`);
  }
  return def;
}

export interface DamageCalculationParams {
  readonly enemyId: EnemyId;
  readonly damageType: DamageType;
  readonly armorPierceFactor: number;
  readonly antiAirMultiplier: number;
  readonly bossBonusMultiplier: number;
  readonly isBossPhase2?: boolean;
}

/**
 * Computes the net damage multiplier for a weapon hit against an invader archetype,
 * accounting for kinetic/elemental armor reduction, armor piercing, anti-air bonus,
 * boss bonus, and the Broodlord Phase-2 armor crack.
 */
export function computeEffectiveDamageMultiplier(params: DamageCalculationParams): number {
  const enemy = getEnemyDefinition(params.enemyId);
  const pierce = Math.min(1, Math.max(0, params.armorPierceFactor));

  let rawReduction = 0;
  switch (params.damageType) {
    case 'kinetic':
      rawReduction =
        enemy.isBoss && params.isBossPhase2 && enemy.bossAbility
          ? enemy.bossAbility.phase2KineticReduction
          : enemy.armor.kineticReduction;
      break;
    case 'plasma':
      rawReduction = enemy.armor.plasmaReduction;
      break;
    case 'cryo':
      rawReduction = enemy.armor.cryoReduction;
      break;
    case 'rail':
      rawReduction = enemy.armor.railReduction;
      break;
  }

  // Armor piercing reduces positive damage reduction; negative reduction (vulnerability) is preserved.
  const effectiveReduction = rawReduction > 0 ? rawReduction * (1 - pierce) : rawReduction;
  const armorMultiplier = Math.max(0.1, 1 - effectiveReduction);
  const layerMultiplier = enemy.movementLayer === 'air' ? params.antiAirMultiplier : 1.0;
  const bossMultiplier = enemy.isBoss ? params.bossBonusMultiplier : 1.0;

  return armorMultiplier * layerMultiplier * bossMultiplier;
}

/**
 * Computes the effective movement speed slow ratio (`0..0.8`) applied by a Cryo-Arc hit
 * after accounting for the target's `slowResistance`.
 */
export function computeEffectiveSlowFactor(enemyId: EnemyId, rawSlowFactor: number): number {
  const enemy = getEnemyDefinition(enemyId);
  const clampedSlow = Math.min(0.8, Math.max(0, rawSlowFactor));
  return clampedSlow * (1 - enemy.armor.slowResistance);
}
