/**
 * Barrel export for declarative content tables (`turrets`, `enemies`, `waves`) plus
 * referential-integrity, Quest 3 budget, and economy/pacing validation helpers.
 * Pure TypeScript — ZERO Three.js imports.
 */

export * from './enemies.ts';
export * from './turrets.ts';
export * from './waves.ts';

import { ENEMIES, ENEMY_IDS, ENEMY_LIST, type EnemyId } from './enemies.ts';
import {
  HARD_TURRET_CAP,
  TURRET_FOOTPRINT_RADIUS_M,
  TURRET_KINDS,
  TURRET_LIST,
  TURRET_MIN_SPACING_M,
  TURRET_SELL_REFUND_RATIO,
  TURRET_TIERS,
  TURRETS,
} from './turrets.ts';
import {
  COMBAT_MUSIC_CUE_IDS,
  computeMissionDurationSummary,
  computeMissionEconomySummary,
  estimatePeakConcurrentEnemies,
  INTERMISSION_DURATION_SEC,
  MAX_ACTIVE_ENEMIES,
  MAX_CONCURRENT_PORTALS,
  MISSION_TARGET_MAX_DURATION_SEC,
  MISSION_TARGET_MIN_DURATION_SEC,
  MUSIC_CUES,
  TOTAL_WAVES,
  WAVES,
} from './waves.ts';

export interface ContentValidationSummary {
  readonly turretCount: number;
  readonly tierCountPerTurret: number;
  readonly enemyCount: number;
  readonly waveCount: number;
  readonly maxPortalsObserved: number;
  readonly maxActiveEnemyCapObserved: number;
  readonly maxEstimatedConcurrentEnemies: number;
  readonly creditsEnteringBossWave: number;
  readonly totalMissionCreditsBase: number;
  readonly fastRunDurationSec: number;
  readonly nominalRunDurationSec: number;
  readonly fullCountdownDurationSec: number;
}

export interface ContentValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly summary: ContentValidationSummary;
}

/**
 * Validates referential integrity, monotonic turret tier progression, Quest 3 portal/enemy caps,
 * 10–14 turret T2/T3 economy affordability, and 10–15 minute mission duration across all tables.
 */
export function validateContentTables(): ContentValidationResult {
  const errors: string[] = [];

  // 1. Validate turret definitions & monotonic tier progression
  if (TURRET_LIST.length !== 4) {
    errors.push(`Expected 4 turret definitions, found ${TURRET_LIST.length}`);
  }
  if (HARD_TURRET_CAP !== 14) {
    errors.push(`Expected HARD_TURRET_CAP === 14, found ${HARD_TURRET_CAP}`);
  }
  if (TURRET_FOOTPRINT_RADIUS_M !== 0.16) {
    errors.push(`Expected TURRET_FOOTPRINT_RADIUS_M === 0.16, found ${TURRET_FOOTPRINT_RADIUS_M}`);
  }
  if (TURRET_MIN_SPACING_M !== 0.35) {
    errors.push(`Expected TURRET_MIN_SPACING_M === 0.35, found ${TURRET_MIN_SPACING_M}`);
  }
  if (TURRET_SELL_REFUND_RATIO !== 0.5) {
    errors.push(`Expected TURRET_SELL_REFUND_RATIO === 0.5, found ${TURRET_SELL_REFUND_RATIO}`);
  }

  for (const kind of TURRET_KINDS) {
    const turret = TURRETS[kind];
    if (!turret) {
      errors.push(`Missing turret definition for ${kind}`);
      continue;
    }

    if (turret.tierList.length !== 3) {
      errors.push(`Turret ${kind} must have 3 tiers, found ${turret.tierList.length}`);
    }

    let prevCost = 0;
    let prevCumulative = 0;
    let prevRange = 0;
    let prevRate = 0;
    let prevDamage = 0;
    let prevSingleDps = 0;
    let prevEffectiveDps = 0;

    for (let i = 0; i < TURRET_TIERS.length; i += 1) {
      const tierId = TURRET_TIERS[i];
      if (!tierId) continue;
      const tier = turret.tiers[tierId];
      if (!tier) {
        errors.push(`Turret ${kind} missing tier ${tierId}`);
        continue;
      }

      if (tier.cost <= prevCost) {
        errors.push(
          `Turret ${kind} ${tierId} cost (${tier.cost}) must exceed previous tier (${prevCost})`,
        );
      }
      const expectedCumulative = prevCumulative + tier.cost;
      if (tier.cumulativeCost !== expectedCumulative) {
        errors.push(
          `Turret ${kind} ${tierId} cumulativeCost (${tier.cumulativeCost}) !== ${expectedCumulative}`,
        );
      }
      const expectedRefund = Math.round(tier.cumulativeCost * TURRET_SELL_REFUND_RATIO);
      if (tier.sellRefundCredits !== expectedRefund) {
        errors.push(
          `Turret ${kind} ${tierId} sellRefundCredits (${tier.sellRefundCredits}) !== ${expectedRefund}`,
        );
      }
      if (tier.rangeM <= prevRange) {
        errors.push(
          `Turret ${kind} ${tierId} rangeM (${tier.rangeM}) must increase over ${prevRange}`,
        );
      }
      if (tier.fireRateHz <= prevRate) {
        errors.push(
          `Turret ${kind} ${tierId} fireRateHz (${tier.fireRateHz}) must increase over ${prevRate}`,
        );
      }
      if (tier.damage <= prevDamage) {
        errors.push(
          `Turret ${kind} ${tierId} damage (${tier.damage}) must increase over ${prevDamage}`,
        );
      }
      if (tier.nominalSingleTargetDps <= prevSingleDps) {
        errors.push(
          `Turret ${kind} ${tierId} nominalSingleTargetDps (${tier.nominalSingleTargetDps}) must increase over ${prevSingleDps}`,
        );
      }
      if (tier.nominalEffectiveDps <= prevEffectiveDps) {
        errors.push(
          `Turret ${kind} ${tierId} nominalEffectiveDps (${tier.nominalEffectiveDps}) must increase over ${prevEffectiveDps}`,
        );
      }

      prevCost = tier.cost;
      prevCumulative = tier.cumulativeCost;
      prevRange = tier.rangeM;
      prevRate = tier.fireRateHz;
      prevDamage = tier.damage;
      prevSingleDps = tier.nominalSingleTargetDps;
      prevEffectiveDps = tier.nominalEffectiveDps;
    }
  }

  // 2. Validate enemy archetypes
  if (ENEMY_LIST.length !== 6) {
    errors.push(`Expected 6 enemy archetypes, found ${ENEMY_LIST.length}`);
  }
  const validEnemySet = new Set<string>(ENEMY_IDS);
  for (const enemy of ENEMY_LIST) {
    if (enemy.maxHp <= 0) {
      errors.push(`Enemy ${enemy.id} maxHp must be > 0`);
    }
    if (enemy.speedMps <= 0) {
      errors.push(`Enemy ${enemy.id} speedMps must be > 0`);
    }
    if (enemy.creditBounty <= 0) {
      errors.push(`Enemy ${enemy.id} creditBounty must be > 0`);
    }
    if (enemy.coreDamage <= 0) {
      errors.push(`Enemy ${enemy.id} coreDamage must be > 0`);
    }
    if (enemy.collisionRadiusM <= 0) {
      errors.push(`Enemy ${enemy.id} collisionRadiusM must be > 0`);
    }
  }

  if (ENEMIES['carapace-brute'].armor.kineticReduction !== 0.5) {
    errors.push('carapace-brute must have 50% (0.5) kinetic armor reduction');
  }
  const disruptor = ENEMIES['rift-disruptor'].disruptorAbility;
  if (
    disruptor?.empRadiusM !== 1.2 ||
    disruptor.empDisableDurationSec !== 4.0 ||
    disruptor.turretImmunityCooldownSec <= 0
  ) {
    errors.push('rift-disruptor must define 1.2 m / 4.0 s EMP pulse with immunity cooldown');
  }
  const boss = ENEMIES['apex-broodlord'].bossAbility;
  if (
    boss?.phase2HpThresholdRatio !== 0.5 ||
    !validEnemySet.has(boss.summonEnemyId) ||
    boss.suppressionDisableDurationSec <= 0
  ) {
    errors.push('apex-broodlord must define 50% HP Phase-2 armor crack, add spawns, and pulse');
  }

  // 3. Validate 12 waves, referential integrity, portal & enemy caps, and music cues
  if (WAVES.length !== TOTAL_WAVES) {
    errors.push(`Expected ${TOTAL_WAVES} waves, found ${WAVES.length}`);
  }

  const validCombatCueSet = new Set<string>(COMBAT_MUSIC_CUE_IDS);
  let maxPortalsObserved = 0;
  let maxActiveEnemyCapObserved = 0;
  let maxEstimatedConcurrentEnemies = 0;
  let prevPortals = 1;

  for (let idx = 0; idx < WAVES.length; idx += 1) {
    const wave = WAVES[idx];
    if (!wave) continue;
    const expectedNum = idx + 1;
    if (wave.waveNumber !== expectedNum) {
      errors.push(
        `Wave at index ${idx} has waveNumber ${wave.waveNumber}, expected ${expectedNum}`,
      );
    }
    if (wave.concurrentPortals < 1 || wave.concurrentPortals > MAX_CONCURRENT_PORTALS) {
      errors.push(
        `Wave ${wave.waveNumber} concurrentPortals (${wave.concurrentPortals}) exceeds 1..${MAX_CONCURRENT_PORTALS}`,
      );
    }
    if (wave.concurrentPortals < prevPortals) {
      errors.push(
        `Wave ${wave.waveNumber} concurrentPortals (${wave.concurrentPortals}) decreased from ${prevPortals}`,
      );
    }
    prevPortals = wave.concurrentPortals;
    if (wave.concurrentPortals > maxPortalsObserved) {
      maxPortalsObserved = wave.concurrentPortals;
    }

    if (wave.maxActiveEnemies < 1 || wave.maxActiveEnemies > MAX_ACTIVE_ENEMIES) {
      errors.push(
        `Wave ${wave.waveNumber} maxActiveEnemies (${wave.maxActiveEnemies}) exceeds 1..${MAX_ACTIVE_ENEMIES}`,
      );
    }
    if (wave.maxActiveEnemies > maxActiveEnemyCapObserved) {
      maxActiveEnemyCapObserved = wave.maxActiveEnemies;
    }

    const peakEst = estimatePeakConcurrentEnemies(wave);
    if (peakEst.unthrottledPeak > MAX_ACTIVE_ENEMIES) {
      errors.push(
        `Wave ${wave.waveNumber} unthrottled peak concurrent enemies (${peakEst.unthrottledPeak}) exceeds ${MAX_ACTIVE_ENEMIES}`,
      );
    }
    if (peakEst.unthrottledPeak > maxEstimatedConcurrentEnemies) {
      maxEstimatedConcurrentEnemies = peakEst.unthrottledPeak;
    }

    if (!validCombatCueSet.has(wave.musicCue) || !MUSIC_CUES[wave.musicCue]) {
      errors.push(`Wave ${wave.waveNumber} references invalid musicCue: ${wave.musicCue}`);
    }

    const expectedIntermission = wave.waveNumber < TOTAL_WAVES ? INTERMISSION_DURATION_SEC : 0;
    if (wave.intermissionAfterSec !== expectedIntermission) {
      errors.push(
        `Wave ${wave.waveNumber} intermissionAfterSec (${wave.intermissionAfterSec}) !== ${expectedIntermission}`,
      );
    }

    if (wave.spawnGroups.length === 0) {
      errors.push(`Wave ${wave.waveNumber} has no spawnGroups`);
    }

    for (const group of wave.spawnGroups) {
      if (!validEnemySet.has(group.enemyId)) {
        errors.push(
          `Wave ${wave.waveNumber} group ${group.groupId} references unknown enemyId: ${String(group.enemyId)}`,
        );
      }
      if (group.count < 1) {
        errors.push(`Wave ${wave.waveNumber} group ${group.groupId} count must be >= 1`);
      }
      if (group.portalIndex < 0 || group.portalIndex >= wave.concurrentPortals) {
        errors.push(
          `Wave ${wave.waveNumber} group ${group.groupId} portalIndex (${group.portalIndex}) out of range 0..${wave.concurrentPortals - 1}`,
        );
      }
      if (group.startDelaySec < 0 || group.spawnIntervalSec <= 0) {
        errors.push(`Wave ${wave.waveNumber} group ${group.groupId} has invalid timing`);
      }
    }
  }

  // Verify enemy archetype introduction pacing across the 4 mission acts
  const hasWaveEnemy = (waveNumbers: readonly number[], enemyId: EnemyId): boolean =>
    waveNumbers.some((n) => WAVES[n - 1]?.spawnGroups.some((group) => group.enemyId === enemyId));

  if (!hasWaveEnemy([1, 2, 3, 4], 'skitter-crawler') || !hasWaveEnemy([3, 4], 'wasp-skimmer')) {
    errors.push('Waves 1–4 must introduce skitter-crawler and wasp-skimmer');
  }
  if (!hasWaveEnemy([5, 6, 7, 8], 'carapace-brute')) {
    errors.push('Waves 5–8 must include carapace-brute');
  }
  if (!hasWaveEnemy([9, 10, 11], 'rift-disruptor')) {
    errors.push('Waves 9–11 must include rift-disruptor');
  }
  if (!hasWaveEnemy([12], 'apex-broodlord')) {
    errors.push('Wave 12 must include apex-broodlord boss');
  }

  // 4. Validate economy curve (affords a viable 10–14 turret T2/T3 defense)
  const economy = computeMissionEconomySummary();
  const min10TurretT2Cost = 10 * TURRETS.autocannon.tiers.T2.cumulativeCost; // 2,300
  const max14TurretT3Cost = 14 * TURRETS['rail-sniper'].tiers.T3.cumulativeCost; // 8,680
  if (
    economy.creditsEnteringBossWave < min10TurretT2Cost ||
    economy.creditsEnteringBossWave > max14TurretT3Cost
  ) {
    errors.push(
      `Credits entering Wave 12 (${economy.creditsEnteringBossWave}) outside viable 10–14 turret T2/T3 envelope (${min10TurretT2Cost}..${max14TurretT3Cost})`,
    );
  }

  // 5. Validate mission pacing (10–15 minutes = 600–900 s)
  const duration = computeMissionDurationSummary();
  if (
    duration.fastRunDurationSec < MISSION_TARGET_MIN_DURATION_SEC ||
    duration.fullCountdownDurationSec > MISSION_TARGET_MAX_DURATION_SEC
  ) {
    errors.push(
      `Mission duration envelope (${duration.fastRunDurationSec}s..${duration.fullCountdownDurationSec}s) must fall inside ${MISSION_TARGET_MIN_DURATION_SEC}..${MISSION_TARGET_MAX_DURATION_SEC}s`,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    summary: {
      turretCount: TURRET_LIST.length,
      tierCountPerTurret: TURRET_TIERS.length,
      enemyCount: ENEMY_LIST.length,
      waveCount: WAVES.length,
      maxPortalsObserved,
      maxActiveEnemyCapObserved,
      maxEstimatedConcurrentEnemies,
      creditsEnteringBossWave: economy.creditsEnteringBossWave,
      totalMissionCreditsBase: economy.totalMissionCreditsBase,
      fastRunDurationSec: duration.fastRunDurationSec,
      nominalRunDurationSec: duration.nominalRunDurationSec,
      fullCountdownDurationSec: duration.fullCountdownDurationSec,
    },
  };
}

export function assertValidContentTables(): ContentValidationSummary {
  const result = validateContentTables();
  if (!result.valid) {
    throw new Error(`Invalid content tables:\n- ${result.errors.join('\n- ')}`);
  }
  return result.summary;
}
