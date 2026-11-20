import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertValidContentTables,
  COMBAT_MUSIC_CUE_IDS,
  CORE_MAX_HP,
  computeEarlyLaunchBonus,
  computeEffectiveDamageMultiplier,
  computeEffectiveSlowFactor,
  computeMissionDurationSummary,
  computeMissionEconomySummary,
  computeWaveCombatDurationSec,
  computeWaveEnemyCount,
  computeWaveTotalCredits,
  ENEMIES,
  ENEMY_IDS,
  ENEMY_LIST,
  estimatePeakConcurrentEnemies,
  getEnemyDefinition,
  getMusicCueForWave,
  getNextTurretTier,
  getTurretBuildCost,
  getTurretCumulativeCost,
  getTurretDefinition,
  getTurretSellRefund,
  getTurretTierStats,
  getTurretUpgradeCost,
  getWaveDefinition,
  HARD_TURRET_CAP,
  HOVER_POD_MAX_DEPTH_M,
  HOVER_POD_MIN_DEPTH_M,
  INTERMISSION_DURATION_SEC,
  MAX_ACTIVE_ENEMIES,
  MAX_CONCURRENT_PORTALS,
  MISSION_CONFIG,
  MISSION_TARGET_MAX_DURATION_SEC,
  MISSION_TARGET_MIN_DURATION_SEC,
  MUSIC_CUES,
  normalizeTurretTier,
  STARTING_CREDITS,
  TOTAL_WAVES,
  TURRET_FOOTPRINT_RADIUS_M,
  TURRET_KINDS,
  TURRET_MIN_SPACING_M,
  TURRET_MOUNT_PROFILES,
  TURRET_REDEPLOY_COOLDOWN_SEC,
  TURRET_RELOCATE_COST,
  TURRET_SELL_REFUND_RATIO,
  TURRET_TIERS,
  TURRETS,
  type TurretKind,
  type TurretTierId,
  validateContentTables,
  WAVES,
} from '../src/content/index.ts';

describe('P2-T2 Content Data Tables & 12-Wave Mission Script', () => {
  it('contains zero Three.js imports across all src/content/ modules', () => {
    const files = ['turrets.ts', 'enemies.ts', 'waves.ts', 'index.ts'];
    for (const file of files) {
      const source = readFileSync(resolve(process.cwd(), 'src/content', file), 'utf8');
      expect(source).not.toMatch(/from\s+['"]three['"]/);
      expect(source).not.toMatch(/import\s*\(\s*['"]three['"]\s*\)/);
    }
  });

  it('passes full content table referential integrity and constraint validation', () => {
    const validation = validateContentTables();
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);

    const summary = assertValidContentTables();
    expect(summary.turretCount).toBe(4);
    expect(summary.tierCountPerTurret).toBe(3);
    expect(summary.enemyCount).toBe(5);
    expect(summary.waveCount).toBe(12);
    expect(summary.maxPortalsObserved).toBe(4);
    expect(summary.maxActiveEnemyCapObserved).toBeLessThanOrEqual(25);
    expect(summary.maxEstimatedConcurrentEnemies).toBeLessThanOrEqual(25);
  });

  describe('Turrets (4 roles × 3 upgrade tiers)', () => {
    it('defines all 4 turret kinds with exact placement, refund, and mount rules', () => {
      expect(TURRET_KINDS).toEqual(['autocannon', 'plasma-mortar', 'cryo-arc', 'rail-sniper']);
      expect(HARD_TURRET_CAP).toBe(14);
      expect(TURRET_FOOTPRINT_RADIUS_M).toBe(0.16);
      expect(TURRET_MIN_SPACING_M).toBe(0.35);
      expect(TURRET_SELL_REFUND_RATIO).toBe(0.75);
      expect(TURRET_RELOCATE_COST).toBeGreaterThan(0);
      expect(TURRET_REDEPLOY_COOLDOWN_SEC).toBeGreaterThan(0);

      expect(TURRET_MOUNT_PROFILES['surface-clamp'].alignsToSurfaceNormal).toBe(true);
      expect(TURRET_MOUNT_PROFILES['surface-clamp'].allowedSurfaces).toEqual([
        'floor',
        'table',
        'wall',
      ]);
      expect(TURRET_MOUNT_PROFILES['hover-pod'].minDistanceM).toBe(HOVER_POD_MIN_DEPTH_M);
      expect(TURRET_MOUNT_PROFILES['hover-pod'].maxDistanceM).toBe(HOVER_POD_MAX_DEPTH_M);
      expect(HOVER_POD_MIN_DEPTH_M).toBe(0.8);
      expect(HOVER_POD_MAX_DEPTH_M).toBe(5.0);
    });

    it('enforces strict monotonic progression across T1 -> T2 -> T3 for every turret', () => {
      for (const kind of TURRET_KINDS) {
        const def = getTurretDefinition(kind);
        expect(def.footprintRadiusM).toBe(0.16);
        expect(def.minSpacingM).toBe(0.35);
        expect(def.hardCap).toBe(14);
        expect(def.sellRefundRatio).toBe(0.75);
        expect(def.mountProfiles).toEqual(['surface-clamp', 'hover-pod']);

        const t1 = getTurretTierStats(kind, 'T1');
        const t2 = getTurretTierStats(kind, 'T2');
        const t3 = getTurretTierStats(kind, 'T3');

        expect(getTurretTierStats(kind, 1)).toEqual(t1);
        expect(getTurretTierStats(kind, 2)).toEqual(t2);
        expect(getTurretTierStats(kind, 3)).toEqual(t3);

        expect(t1.cost).toBeLessThan(t2.cost);
        expect(t2.cost).toBeLessThan(t3.cost);

        expect(t1.cumulativeCost).toBe(t1.cost);
        expect(t2.cumulativeCost).toBe(t1.cost + t2.cost);
        expect(t3.cumulativeCost).toBe(t1.cost + t2.cost + t3.cost);

        expect(getTurretBuildCost(kind)).toBe(t1.cost);
        expect(getTurretUpgradeCost(kind, 'T1')).toBe(t2.cost);
        expect(getTurretUpgradeCost(kind, 'T2')).toBe(t3.cost);
        expect(getTurretUpgradeCost(kind, 'T3')).toBeNull();
        expect(getNextTurretTier('T1')).toBe('T2');
        expect(getNextTurretTier('T2')).toBe('T3');
        expect(getNextTurretTier('T3')).toBeNull();

        for (const tierId of TURRET_TIERS) {
          const stats = def.tiers[tierId];
          expect(getTurretCumulativeCost(kind, tierId)).toBe(stats.cumulativeCost);
          expect(getTurretSellRefund(kind, tierId)).toBe(
            Math.round(stats.cumulativeCost * TURRET_SELL_REFUND_RATIO),
          );
          expect(stats.sellRefundCredits).toBe(getTurretSellRefund(kind, tierId));
          expect(stats.blockout.footprintRadiusM).toBe(0.16);
          expect(stats.blockout.totalHeightM).toBeGreaterThan(stats.blockout.baseHeightM);
          expect(stats.meshBudget.maxLod0Tris).toBeLessThanOrEqual(6500);
          expect(stats.meshBudget.maxLod1Tris).toBeLessThanOrEqual(2500);
        }

        expect(t1.rangeM).toBeLessThan(t2.rangeM);
        expect(t2.rangeM).toBeLessThan(t3.rangeM);
        expect(t1.fireRateHz).toBeLessThan(t2.fireRateHz);
        expect(t2.fireRateHz).toBeLessThan(t3.fireRateHz);
        expect(t1.damage).toBeLessThan(t2.damage);
        expect(t2.damage).toBeLessThan(t3.damage);
        expect(t1.nominalSingleTargetDps).toBeLessThan(t2.nominalSingleTargetDps);
        expect(t2.nominalSingleTargetDps).toBeLessThan(t3.nominalSingleTargetDps);
        expect(t1.nominalEffectiveDps).toBeLessThan(t2.nominalEffectiveDps);
        expect(t2.nominalEffectiveDps).toBeLessThan(t3.nominalEffectiveDps);
      }
    });

    it('matches role-specific weapon mechanics for Autocannon, Plasma Mortar, Cryo-Arc, and Rail Sniper', () => {
      // M44 Autocannon: high fire-rate kinetic tracer DPS
      const auto = TURRETS.autocannon;
      expect(auto.name).toBe('M44 Autocannon');
      expect(auto.damageType).toBe('kinetic');
      expect(auto.tiers.T1.fireRateHz).toBeGreaterThanOrEqual(5);
      expect(auto.tiers.T3.fireRateHz).toBeGreaterThanOrEqual(10);

      // Helios Plasma Mortar: parabolic AoE splash + burn DoT
      const mortar = TURRETS['plasma-mortar'];
      expect(mortar.name).toBe('Helios Plasma Mortar');
      expect(mortar.damageType).toBe('plasma');
      for (const tier of mortar.tierList) {
        expect(tier.aoeRadiusM).toBeGreaterThan(0.5);
        expect(tier.burnDps).toBeGreaterThan(0);
        expect(tier.burnDurationSec).toBeGreaterThan(0);
      }
      expect(mortar.tiers.T1.aoeRadiusM).toBeLessThan(mortar.tiers.T2.aoeRadiusM);
      expect(mortar.tiers.T2.aoeRadiusM).toBeLessThan(mortar.tiers.T3.aoeRadiusM);

      // Glacier Cryo-Arc: 35–55% slow + 2–4 target chain lightning, ground & air
      const cryo = TURRETS['cryo-arc'];
      expect(cryo.name).toBe('Glacier Cryo-Arc');
      expect(cryo.damageType).toBe('cryo');
      expect(cryo.targetLayers).toEqual(['surface', 'air']);
      expect(cryo.tiers.T1.slowFactor).toBe(0.35);
      expect(cryo.tiers.T2.slowFactor).toBe(0.45);
      expect(cryo.tiers.T3.slowFactor).toBe(0.55);
      expect(cryo.tiers.T1.chainCount).toBe(2);
      expect(cryo.tiers.T2.chainCount).toBe(3);
      expect(cryo.tiers.T3.chainCount).toBe(4);
      expect(cryo.tiers.T1.chainJumpRadiusM).toBeGreaterThan(0);

      // Valkyrie Rail Sniper: long-range armor-piercing with anti-air & boss bonus
      const rail = TURRETS['rail-sniper'];
      expect(rail.name).toBe('Valkyrie Rail Sniper');
      expect(rail.damageType).toBe('rail');
      expect(rail.tiers.T1.rangeM).toBeGreaterThan(auto.tiers.T3.rangeM);
      expect(rail.tiers.T3.armorPierceFactor).toBe(1.0);
      expect(rail.tiers.T1.antiAirMultiplier).toBeGreaterThan(1.0);
      expect(rail.tiers.T3.antiAirMultiplier).toBeGreaterThan(rail.tiers.T1.antiAirMultiplier);
      expect(rail.tiers.T1.bossBonusMultiplier).toBeGreaterThan(1.0);
      expect(rail.tiers.T3.bossBonusMultiplier).toBeGreaterThan(rail.tiers.T1.bossBonusMultiplier);
    });
  });

  describe('Enemies (5 bio-mechanical / insectoid invader archetypes)', () => {
    it('defines all 5 archetypes with movement layers, budgets, and special abilities', () => {
      expect(ENEMY_IDS).toEqual([
        'skitter-crawler',
        'wasp-skimmer',
        'carapace-brute',
        'rift-disruptor',
        'apex-broodlord',
      ]);
      expect(ENEMY_LIST).toHaveLength(5);

      const crawler = getEnemyDefinition('skitter-crawler');
      expect(crawler.movementLayer).toBe('surface');
      expect(crawler.canDescendWallToFloor).toBe(true);
      expect(crawler.meshBudget.maxTris).toBeLessThanOrEqual(4500);

      const skimmer = getEnemyDefinition('wasp-skimmer');
      expect(skimmer.movementLayer).toBe('air');
      expect(skimmer.nominalFlightAltitudeM).toBeGreaterThan(1.0);
      expect(skimmer.meshBudget.maxTris).toBeLessThanOrEqual(6500);

      const brute = getEnemyDefinition('carapace-brute');
      expect(brute.movementLayer).toBe('surface');
      expect(brute.armor.kineticReduction).toBe(0.5);
      expect(brute.armor.frontalPlate).toBe(true);
      expect(brute.meshBudget.maxTris).toBeLessThanOrEqual(9000);

      const disruptor = getEnemyDefinition('rift-disruptor');
      expect(disruptor.movementLayer).toBe('air');
      expect(disruptor.disruptorAbility).not.toBeNull();
      expect(disruptor.disruptorAbility?.empRadiusM).toBe(1.2);
      expect(disruptor.disruptorAbility?.empDisableDurationSec).toBe(4.0);
      expect(disruptor.disruptorAbility?.turretImmunityCooldownSec).toBeGreaterThanOrEqual(4.0);
      expect(disruptor.meshBudget.maxTris).toBeLessThanOrEqual(6500);

      const boss = getEnemyDefinition('apex-broodlord');
      expect(boss.isBoss).toBe(true);
      expect(boss.movementLayer).toBe('surface');
      expect(boss.bossAbility).not.toBeNull();
      expect(boss.bossAbility?.phase2HpThresholdRatio).toBe(0.5);
      expect(boss.bossAbility?.summonEnemyId).toBe('skitter-crawler');
      expect(boss.bossAbility?.summonedAddBounty).toBe(0);
      expect(boss.bossAbility?.suppressionDisableDurationSec).toBeGreaterThan(0);
      expect(boss.bossAbility?.suppressionImmunityCooldownSec).toBeGreaterThan(0);
      expect(boss.meshBudget.maxTris).toBeLessThanOrEqual(28000);
      expect(boss.meshBudget.maxBones).toBeLessThanOrEqual(48);
    });

    it('computes armor reduction, armor pierce, anti-air, boss bonus, and cryo slow resistance accurately', () => {
      // Carapace Brute takes 50% kinetic damage when armorPierceFactor === 0
      const kineticVsBrute = computeEffectiveDamageMultiplier({
        enemyId: 'carapace-brute',
        damageType: 'kinetic',
        armorPierceFactor: 0,
        antiAirMultiplier: 1,
        bossBonusMultiplier: 1,
      });
      expect(kineticVsBrute).toBeCloseTo(0.5, 5);

      // Rail Sniper & Plasma Mortar deal bonus effective damage against Carapace Brute
      const railT2 = TURRETS['rail-sniper'].tiers.T2;
      const railVsBrute = computeEffectiveDamageMultiplier({
        enemyId: 'carapace-brute',
        damageType: 'rail',
        armorPierceFactor: railT2.armorPierceFactor,
        antiAirMultiplier: railT2.antiAirMultiplier,
        bossBonusMultiplier: railT2.bossBonusMultiplier,
      });
      expect(railVsBrute).toBeGreaterThan(1.1);

      const plasmaT2 = TURRETS['plasma-mortar'].tiers.T2;
      const plasmaVsBrute = computeEffectiveDamageMultiplier({
        enemyId: 'carapace-brute',
        damageType: 'plasma',
        armorPierceFactor: plasmaT2.armorPierceFactor,
        antiAirMultiplier: plasmaT2.antiAirMultiplier,
        bossBonusMultiplier: plasmaT2.bossBonusMultiplier,
      });
      expect(plasmaVsBrute).toBeGreaterThan(1.1);

      // Rail Sniper anti-air multiplier applies to aerial Rift Disruptor & Wasp Skimmer
      const railVsDisruptor = computeEffectiveDamageMultiplier({
        enemyId: 'rift-disruptor',
        damageType: 'rail',
        armorPierceFactor: railT2.armorPierceFactor,
        antiAirMultiplier: railT2.antiAirMultiplier,
        bossBonusMultiplier: railT2.bossBonusMultiplier,
      });
      expect(railVsDisruptor).toBeGreaterThanOrEqual(railT2.antiAirMultiplier);

      // Apex Broodlord Phase-2 armor crack increases kinetic damage taken
      const kineticBossPhase1 = computeEffectiveDamageMultiplier({
        enemyId: 'apex-broodlord',
        damageType: 'kinetic',
        armorPierceFactor: 0,
        antiAirMultiplier: 1,
        bossBonusMultiplier: 1,
        isBossPhase2: false,
      });
      const kineticBossPhase2 = computeEffectiveDamageMultiplier({
        enemyId: 'apex-broodlord',
        damageType: 'kinetic',
        armorPierceFactor: 0,
        antiAirMultiplier: 1,
        bossBonusMultiplier: 1,
        isBossPhase2: true,
      });
      expect(kineticBossPhase2).toBeGreaterThan(kineticBossPhase1);

      // Cryo slow factor respects boss slow resistance while applying full slow to crawlers
      expect(computeEffectiveSlowFactor('skitter-crawler', 0.55)).toBeCloseTo(0.55, 5);
      expect(computeEffectiveSlowFactor('apex-broodlord', 0.55)).toBeLessThan(0.55);
      expect(computeEffectiveSlowFactor('apex-broodlord', 0.55)).toBeGreaterThan(0.25);
    });
  });

  describe('Waves, Quest 3 Caps, Suno Music Mapping, Pacing & Economy Balance', () => {
    it('enforces <=4 concurrent portals, <=25 concurrent enemies, 15s intermissions, and exact Suno music cues', () => {
      expect(WAVES).toHaveLength(12);
      expect(TOTAL_WAVES).toBe(12);
      expect(MAX_CONCURRENT_PORTALS).toBe(4);
      expect(MAX_ACTIVE_ENEMIES).toBe(25);
      expect(INTERMISSION_DURATION_SEC).toBe(15);
      expect(STARTING_CREDITS).toBeGreaterThanOrEqual(300);
      expect(CORE_MAX_HP).toBe(100);
      expect(MISSION_CONFIG.totalWaves).toBe(12);

      for (const cueId of COMBAT_MUSIC_CUE_IDS) {
        expect(MUSIC_CUES[cueId]).toBeDefined();
      }
      expect(getMusicCueForWave(1)).toBe('first-contact');
      expect(getMusicCueForWave(4)).toBe('first-contact');
      expect(getMusicCueForWave(5)).toBe('breach-protocol');
      expect(getMusicCueForWave(8)).toBe('breach-protocol');
      expect(getMusicCueForWave(9)).toBe('perimeter-overload');
      expect(getMusicCueForWave(11)).toBe('perimeter-overload');
      expect(getMusicCueForWave(12)).toBe('broodlord-siege');

      for (const wave of WAVES) {
        expect(getWaveDefinition(wave.waveNumber)).toBe(wave);
        expect(wave.concurrentPortals).toBeGreaterThanOrEqual(1);
        expect(wave.concurrentPortals).toBeLessThanOrEqual(4);
        expect(wave.maxActiveEnemies).toBeLessThanOrEqual(25);
        expect(computeWaveEnemyCount(wave)).toBeGreaterThan(0);
        expect(computeWaveTotalCredits(wave)).toBeGreaterThan(wave.clearBonusCredits);
        expect(computeWaveCombatDurationSec(wave)).toBeGreaterThan(30);

        const peak = estimatePeakConcurrentEnemies(wave);
        expect(peak.unthrottledPeak).toBeLessThanOrEqual(25);
        expect(peak.cappedPeak).toBeLessThanOrEqual(25);
      }

      expect(computeEarlyLaunchBonus(15)).toBe(30);
      expect(computeEarlyLaunchBonus(7.5)).toBe(15);
      expect(computeEarlyLaunchBonus(0)).toBe(0);
    });

    it('paces total 12-wave mission duration strictly inside 10–15 minutes (600–900 seconds)', () => {
      const duration = computeMissionDurationSummary();
      expect(duration.fastRunDurationSec).toBeGreaterThanOrEqual(MISSION_TARGET_MIN_DURATION_SEC);
      expect(duration.nominalRunDurationSec).toBeGreaterThanOrEqual(
        MISSION_TARGET_MIN_DURATION_SEC,
      );
      expect(duration.nominalRunDurationSec).toBeLessThanOrEqual(MISSION_TARGET_MAX_DURATION_SEC);
      expect(duration.fullCountdownDurationSec).toBeLessThanOrEqual(
        MISSION_TARGET_MAX_DURATION_SEC,
      );
    });

    it('affords a viable 10–14 turret T2/T3 defense and defeats all 12 waves in a deterministic balance simulation', () => {
      const economy = computeMissionEconomySummary();

      // Verify a 12-turret mixed T2/T3 defense (3 of each turret role: 7×T3 + 5×T2) is cleanly affordable before Wave 12
      const referenceSquad: ReadonlyArray<{ kind: TurretKind; tier: TurretTierId }> = [
        { kind: 'autocannon', tier: 'T3' },
        { kind: 'autocannon', tier: 'T3' },
        { kind: 'autocannon', tier: 'T2' },
        { kind: 'plasma-mortar', tier: 'T3' },
        { kind: 'plasma-mortar', tier: 'T3' },
        { kind: 'plasma-mortar', tier: 'T2' },
        { kind: 'cryo-arc', tier: 'T3' },
        { kind: 'cryo-arc', tier: 'T2' },
        { kind: 'cryo-arc', tier: 'T2' },
        { kind: 'rail-sniper', tier: 'T3' },
        { kind: 'rail-sniper', tier: 'T3' },
        { kind: 'rail-sniper', tier: 'T2' },
      ];
      expect(referenceSquad.length).toBeGreaterThanOrEqual(10);
      expect(referenceSquad.length).toBeLessThanOrEqual(HARD_TURRET_CAP);

      const referenceSquadCost = referenceSquad.reduce(
        (sum, slot) => sum + getTurretCumulativeCost(slot.kind, slot.tier),
        0,
      );
      expect(economy.creditsEnteringBossWave).toBeGreaterThanOrEqual(referenceSquadCost);

      // Progressive wave-by-wave build + combat simulation across Waves 1..12:
      // At each wave start, spend available credits to build up to 12 balanced turrets and upgrade T1->T2->T3.
      const buildOrder: readonly TurretKind[] = [
        'autocannon',
        'autocannon',
        'cryo-arc',
        'rail-sniper',
        'plasma-mortar',
        'rail-sniper',
        'cryo-arc',
        'plasma-mortar',
        'autocannon',
        'rail-sniper',
        'plasma-mortar',
        'cryo-arc',
      ];
      const activeTurrets: Array<{ kind: TurretKind; tier: TurretTierId }> = [];
      let bankCredits = STARTING_CREDITS;

      for (const wave of WAVES) {
        // 1. Build new T1 turrets up to wave-appropriate cap (max 12 in this build order, <= 14 hard cap)
        const targetTurretCount = Math.min(buildOrder.length, 2 + wave.waveNumber);
        while (activeTurrets.length < targetTurretCount) {
          const nextKind = buildOrder[activeTurrets.length];
          if (!nextKind) break;
          const buildCost = getTurretBuildCost(nextKind);
          if (bankCredits < buildCost) break;
          bankCredits -= buildCost;
          activeTurrets.push({ kind: nextKind, tier: 'T1' });
        }

        // 2. Upgrade lowest-tier turrets (T1 -> T2 first, then T2 -> T3) with remaining credits
        let upgraded = true;
        while (upgraded) {
          upgraded = false;
          for (const targetFromTier of ['T1', 'T2'] as const) {
            for (const slot of activeTurrets) {
              if (slot.tier !== targetFromTier) continue;
              const upCost = getTurretUpgradeCost(slot.kind, slot.tier);
              const nextTier = getNextTurretTier(slot.tier);
              if (upCost !== null && nextTier !== null && bankCredits >= upCost) {
                bankCredits -= upCost;
                slot.tier = nextTier;
                upgraded = true;
              }
            }
          }
        }

        // 3. Evaluate wave combat damage capacity vs total wave enemy HP (accounting for armor, slow, AoE, EMP)
        let bestSlowFactor = 0;
        for (const slot of activeTurrets) {
          const stats = getTurretTierStats(slot.kind, slot.tier);
          if (stats.slowFactor > bestSlowFactor) {
            bestSlowFactor = stats.slowFactor;
          }
        }

        // Disruptor EMP uptime factor (with 4 s disable and 5 s immunity cooldown, worst-case uptime is >= 78%)
        const hasDisruptors = wave.spawnGroups.some((g) => g.enemyId === 'rift-disruptor');
        const empUptimeFactor = hasDisruptors ? 0.82 : 1.0;

        let totalWaveKillTimeRequiredSec = 0;
        for (const group of wave.spawnGroups) {
          const enemy = ENEMIES[group.enemyId];
          const groupTotalHp = group.count * enemy.maxHp;

          let squadDpsAgainstGroup = 0;
          for (const slot of activeTurrets) {
            const turretDef = TURRETS[slot.kind];
            const stats = getTurretTierStats(slot.kind, slot.tier);
            const dmgMult = computeEffectiveDamageMultiplier({
              enemyId: enemy.id,
              damageType: turretDef.damageType,
              armorPierceFactor: stats.armorPierceFactor,
              antiAirMultiplier: stats.antiAirMultiplier,
              bossBonusMultiplier: stats.bossBonusMultiplier,
              isBossPhase2: enemy.isBoss,
            });

            // AoE splash and chain lightning hit multiple swarm/escort units simultaneously
            const multiTargetFactor = enemy.isBoss
              ? 1.0
              : slot.kind === 'plasma-mortar'
                ? 2.2
                : slot.kind === 'cryo-arc'
                  ? Math.min(group.count, stats.chainCount) * 0.8
                  : 1.0;

            const rangeEngagementRatio = Math.min(1.0, stats.rangeM / 3.0);
            squadDpsAgainstGroup +=
              stats.nominalSingleTargetDps *
              dmgMult *
              multiTargetFactor *
              rangeEngagementRatio *
              empUptimeFactor;
          }

          expect(squadDpsAgainstGroup).toBeGreaterThan(0);
          totalWaveKillTimeRequiredSec += groupTotalHp / squadDpsAgainstGroup;
        }

        // Cryo-Arc slow extends effective engagement window inside the room
        const avgSlow = computeEffectiveSlowFactor(
          wave.isBossWave ? 'apex-broodlord' : 'skitter-crawler',
          bestSlowFactor,
        );
        const effectiveEngagementWindowSec =
          computeWaveCombatDurationSec(wave) * (1 + avgSlow * 0.65);

        expect(totalWaveKillTimeRequiredSec).toBeLessThan(effectiveEngagementWindowSec);

        // 4. Collect wave kill bounties + clear bonus for next intermission
        bankCredits += computeWaveTotalCredits(wave);
      }

      // Confirm that by Wave 12 we fielded 12 T2/T3 turrets with a majority at T3
      expect(activeTurrets.length).toBe(12);
      const t2OrT3Count = activeTurrets.filter((t) => t.tier === 'T2' || t.tier === 'T3').length;
      const t3Count = activeTurrets.filter((t) => t.tier === 'T3').length;
      expect(t2OrT3Count).toBe(12);
      expect(t3Count).toBeGreaterThanOrEqual(8);
    });

    it('rejects invalid turret, enemy, tier, and wave lookups cleanly', () => {
      expect(() => normalizeTurretTier('T4' as TurretTierId)).toThrow(/Invalid turret tier/);
      expect(() => getTurretDefinition('laser-tower' as TurretKind)).toThrow(/Unknown turret kind/);
      expect(() => getEnemyDefinition('void-worm' as never)).toThrow(/Unknown enemy id/);
      expect(() => getWaveDefinition(0)).toThrow(/Invalid wave number/);
      expect(() => getWaveDefinition(13)).toThrow(/Invalid wave number/);
    });
  });
});
