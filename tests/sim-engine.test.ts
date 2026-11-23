import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createActionBus } from '../src/core/action-bus.ts';
import {
  type CombatSimulation,
  computeEffectiveDamageMultiplier,
  computeEffectiveSlowFactor,
  createCombatSimulation,
  ENEMY_DEFS,
  getTurretBuildCost,
  getTurretSellRefund,
  getTurretTierStats,
  getTurretUpgradeCost,
  MAX_ACTIVE_ENEMIES,
  MISSION_WAVES,
  SIM_FIXED_DT,
  TURRET_DEFS,
  TURRET_REDEPLOY_COOLDOWN_SEC,
  TURRET_RELOCATE_COST,
  type TurretKind,
  type Vec3,
} from '../src/sim/engine.ts';
import { createSpatialHash3D, packCellKey3D, unpackCellKey3D } from '../src/sim/spatial-hash.ts';

/**
 * Valid tactical turret layout around the room perimeter and central lanes:
 * - Every position is >= 0.55 m from Core (0, 0, 1.5)
 * - Every position is >= 0.65 m from all 4 default portals
 * - Every pair of positions is >= 0.35 m apart
 */
const SCRIPTED_DEFENSE_SLOTS: ReadonlyArray<{
  readonly kind: TurretKind;
  readonly position: Vec3;
  readonly priority?: 'first' | 'strongest' | 'closest' | 'air-priority';
}> = [
  { kind: 'autocannon', position: { x: -0.65, y: 0, z: 0.75 }, priority: 'first' },
  { kind: 'autocannon', position: { x: 0.65, y: 0, z: 0.75 }, priority: 'first' },
  { kind: 'cryo-arc', position: { x: 0.0, y: 0, z: 0.2 }, priority: 'first' },
  { kind: 'rail-sniper', position: { x: -0.95, y: 0, z: 1.1 }, priority: 'strongest' },
  { kind: 'plasma-mortar', position: { x: 0.0, y: 0, z: 0.7 }, priority: 'first' },
  { kind: 'rail-sniper', position: { x: 0.95, y: 0, z: 1.1 }, priority: 'air-priority' },
  { kind: 'cryo-arc', position: { x: -0.65, y: 0, z: -0.4 }, priority: 'first' },
  { kind: 'plasma-mortar', position: { x: 0.65, y: 0, z: -0.4 }, priority: 'first' },
  { kind: 'autocannon', position: { x: -1.15, y: 0, z: 0.35 }, priority: 'closest' },
  { kind: 'rail-sniper', position: { x: 1.15, y: 0, z: 0.35 }, priority: 'strongest' },
  { kind: 'plasma-mortar', position: { x: -0.45, y: 0, z: 1.15 }, priority: 'first' },
  { kind: 'cryo-arc', position: { x: 0.45, y: 0, z: 1.15 }, priority: 'air-priority' },
  { kind: 'rail-sniper', position: { x: -1.35, y: 0, z: 1.35 }, priority: 'strongest' },
  { kind: 'autocannon', position: { x: 1.35, y: 0, z: 1.35 }, priority: 'first' },
];

/**
 * Executes a deterministic 12-wave scripted defense strategy on `sim`:
 * - Builds and upgrades turrets across waves using earned Requisition credits and early-launch bonuses.
 * - Verifies `enemies.length <= MAX_ACTIVE_ENEMIES` (`25`) on every single fixed tick.
 */
function runScripted12WaveDefense(seed: number): {
  readonly sim: CombatSimulation;
  readonly finalHash: string;
  readonly tickSnapshots: readonly string[];
  readonly maxConcurrentEnemiesObserved: number;
  readonly sawBossPhase2: boolean;
} {
  const sim = createCombatSimulation({ seed });
  const tickSnapshots: string[] = [];
  let maxConcurrentEnemiesObserved = 0;
  let sawBossPhase2 = false;

  const spendAvailableCredits = (waveTargetCount: number): void => {
    const state = sim.getState();
    const targetSlots = Math.min(SCRIPTED_DEFENSE_SLOTS.length, waveTargetCount);

    // 1. Place new T1 turrets up to `targetSlots`
    while (sim.getState().turrets.length < targetSlots) {
      const nextIndex = sim.getState().turrets.length;
      const spec = SCRIPTED_DEFENSE_SLOTS[nextIndex];
      if (!spec) break;
      const buildCost = getTurretBuildCost(spec.kind);
      if (sim.getState().credits < buildCost) break;

      const placed = sim.placeTurret({
        kind: spec.kind,
        position: spec.position,
        mountProfile: 'surface-clamp',
        surfaceKind: 'floor',
        priority: spec.priority ?? 'first',
      });
      expect(placed.ok).toBe(true);
    }

    // 2. Upgrade existing turrets T1 -> T2 first, then T2 -> T3
    let upgradedAny = true;
    while (upgradedAny) {
      upgradedAny = false;
      for (const fromTier of ['T1', 'T2'] as const) {
        for (const turret of sim.getState().turrets) {
          if (turret.tier !== fromTier) continue;
          const cost = getTurretUpgradeCost(turret.kind, turret.tier);
          if (cost !== null && sim.getState().credits >= cost) {
            const up = sim.upgradeTurret(turret.id);
            expect(up.ok).toBe(true);
            upgradedAny = true;
          }
        }
      }
    }
    expect(state.turrets.length).toBeLessThanOrEqual(14);
  };

  // Initial prep build + immediate Wave 1 launch
  spendAvailableCredits(3);
  const firstLaunch = sim.launchWave();
  expect(firstLaunch.ok).toBe(true);
  expect(firstLaunch.waveNumber).toBe(1);

  const maxTicks = 60 * 1200; // 20 minutes ceiling at 60 Hz
  for (let t = 0; t < maxTicks; t += 1) {
    const res = sim.tick();
    const activeCount = res.state.enemies.length;
    if (activeCount > maxConcurrentEnemiesObserved) {
      maxConcurrentEnemiesObserved = activeCount;
    }
    expect(activeCount).toBeLessThanOrEqual(MAX_ACTIVE_ENEMIES);

    for (const ev of res.events) {
      if (ev.type === 'boss-phase2') {
        sawBossPhase2 = true;
      }
    }

    if (res.state.phase === 'intermission') {
      spendAvailableCredits(3 + res.state.currentWave);
      const launched = sim.launchWave();
      expect(launched.ok).toBe(true);
    } else if (res.tick % 120 === 0 && res.state.phase === 'wave') {
      // Mid-wave live build & upgrade as bounties roll in
      spendAvailableCredits(3 + res.state.currentWave);
    }

    if (res.tick % 600 === 0) {
      tickSnapshots.push(sim.computeStateHash());
    }

    if (res.state.phase === 'victory' || res.state.phase === 'defeat') {
      break;
    }
  }

  return {
    sim,
    finalHash: sim.computeStateHash(),
    tickSnapshots,
    maxConcurrentEnemiesObserved,
    sawBossPhase2,
  };
}

describe('P2-T4 Deterministic 60 Hz Combat Simulation Engine & 3D Spatial Hash', () => {
  it('contains ZERO Three.js and ZERO WASM imports across all src/sim/* files', () => {
    const simDir = resolve(process.cwd(), 'src/sim');
    const files = readdirSync(simDir).filter((f) => f.endsWith('.ts'));
    expect(files).toEqual(
      expect.arrayContaining(['placement-rules.ts', 'spatial-hash.ts', 'engine.ts']),
    );

    for (const file of files) {
      const source = readFileSync(resolve(simDir, file), 'utf8');
      expect(source).not.toMatch(/from\s+['"]three['"]/);
      expect(source).not.toMatch(/import\s*\(\s*['"]three['"]\s*\)/);
      expect(source).not.toMatch(/THREE\./);
      expect(source).not.toMatch(/rapier/i);
      expect(source).not.toMatch(/\.wasm\b/i);
      expect(source).not.toMatch(/WebAssembly\b/);
    }
  });

  describe('SpatialHash3D (src/sim/spatial-hash.ts)', () => {
    it('packs/unpacks 3D signed cell keys and performs accurate radius, sorted, and nearest queries', () => {
      const coords = [
        { ix: 0, iy: 0, iz: 0 },
        { ix: -12, iy: 4, iz: 37 },
        { ix: -512, iy: 511, iz: -1 },
      ];
      for (const c of coords) {
        const key = packCellKey3D(c.ix, c.iy, c.iz);
        expect(unpackCellKey3D(key)).toEqual(c);
      }

      interface DummyNode {
        readonly id: string;
        readonly position: Vec3;
        readonly collisionRadiusM: number;
      }

      const grid = createSpatialHash3D<DummyNode>(0.75);
      const nodes: DummyNode[] = [
        { id: 'n1', position: { x: 0, y: 0, z: 0 }, collisionRadiusM: 0.2 },
        { id: 'n2', position: { x: 0.4, y: 0.1, z: -0.2 }, collisionRadiusM: 0.2 },
        { id: 'n3', position: { x: 1.1, y: 0, z: 0 }, collisionRadiusM: 0.35 },
        { id: 'n4', position: { x: -2.5, y: 1.4, z: 1.9 }, collisionRadiusM: 0.2 },
      ];

      grid.insertAll(nodes);
      expect(grid.size).toBe(4);
      expect(grid.activeCellCount).toBeGreaterThanOrEqual(3);

      // Query within 0.6 m of origin -> n1 and n2
      const reusableOut: DummyNode[] = [];
      const nearOrigin = grid.queryRadius({ x: 0, y: 0, z: 0 }, 0.6, reusableOut);
      expect(nearOrigin).toBe(reusableOut);
      expect(nearOrigin.map((n) => n.id).sort()).toEqual(['n1', 'n2']);
      expect(grid.countInRadius({ x: 0, y: 0, z: 0 }, 0.6)).toBe(2);

      // Query within 0.9 m with includeItemRadius: n3 is at x=1.1 with radius 0.35 (1.1 <= 0.9 + 0.35)
      const withRadius = grid.queryRadius({ x: 0, y: 0, z: 0 }, 0.9, { includeItemRadius: true });
      expect(withRadius.map((n) => n.id).sort()).toEqual(['n1', 'n2', 'n3']);

      // Sorted radius query orders by ascending distance from center
      const sorted = grid.queryRadiusSorted({ x: 0, y: 0, z: 0 }, 1.5);
      expect(sorted.map((n) => n.id)).toEqual(['n1', 'n2', 'n3']);

      // Nearest neighbor with filter
      const nearestExcludingN1 = grid.findNearest(
        { x: 0, y: 0, z: 0 },
        2.0,
        (item) => item.id !== 'n1',
      );
      expect(nearestExcludingN1?.id).toBe('n2');

      // Remove and rebuild recycle buckets cleanly
      const secondNode = nodes[1];
      if (!secondNode) throw new Error('Expected secondNode');
      expect(grid.remove(secondNode, secondNode.position)).toBe(true);
      expect(grid.size).toBe(3);
      grid.rebuild(nodes);
      expect(grid.size).toBe(4);
      grid.clear();
      expect(grid.size).toBe(0);
      expect(grid.activeCellCount).toBe(0);
    });
  });

  describe('Turret Commands (place, upgrade T1->T2->T3, priority, relocate cooldown, sell 75% refund)', () => {
    it('places, upgrades T1->T2->T3, switches priorities, relocates with 1.5s cooldown, and sells for 75% total invested refund', () => {
      const sim = createCombatSimulation({ seed: 0x1234_5678, startingCredits: 1000 });
      expect(TURRET_DEFS.autocannon.name).toBe('M44 Autocannon');
      expect(ENEMY_DEFS['carapace-brute'].armor.kineticReduction).toBe(0.5);
      expect(MISSION_WAVES).toHaveLength(12);

      // 1. Place T1 Autocannon (cost 100)
      const placed = sim.placeTurret({
        id: 'turret-alpha',
        kind: 'autocannon',
        position: { x: -0.8, y: 0, z: 0.4 },
        mountProfile: 'surface-clamp',
        surfaceKind: 'floor',
      });
      expect(placed.ok).toBe(true);
      expect(placed.turret?.tier).toBe('T1');
      expect(placed.turret?.level).toBe(1);
      expect(placed.turret?.investedCredits).toBe(100);
      expect(placed.remainingCredits).toBe(900);

      // 2. Reject placement violating minimum 0.35 m spacing (`TOO_CLOSE`)
      const tooClose = sim.placeTurret({
        kind: 'autocannon',
        position: { x: -0.65, y: 0, z: 0.4 },
        mountProfile: 'surface-clamp',
        surfaceKind: 'floor',
      });
      expect(tooClose.ok).toBe(false);
      expect(tooClose.reason).toBe('TOO_CLOSE');

      // 3. Upgrade T1 -> T2 (cost 130, cumulative 230) and T2 -> T3 (cost 190, cumulative 420)
      const upT2 = sim.upgradeTurret('turret-alpha');
      expect(upT2.ok).toBe(true);
      expect(upT2.previousTier).toBe('T1');
      expect(upT2.tier).toBe('T2');
      expect(upT2.cost).toBe(130);
      expect(upT2.turret?.investedCredits).toBe(230);
      expect(upT2.remainingCredits).toBe(770);

      const upT3 = sim.upgradeTurret('turret-alpha');
      expect(upT3.ok).toBe(true);
      expect(upT3.previousTier).toBe('T2');
      expect(upT3.tier).toBe('T3');
      expect(upT3.cost).toBe(190);
      expect(upT3.turret?.investedCredits).toBe(420);
      expect(upT3.remainingCredits).toBe(580);

      // Further upgrade at T3 is rejected with MAX_TIER
      const upMax = sim.upgradeTurret('turret-alpha');
      expect(upMax.ok).toBe(false);
      expect(upMax.reason).toBe('MAX_TIER');

      // 4. Switch target priorities ('first' | 'strongest' | 'closest' | 'air-priority')
      for (const mode of ['first', 'strongest', 'closest', 'air-priority', 'air'] as const) {
        const res = sim.setTurretPriority('turret-alpha', mode);
        expect(res.ok).toBe(true);
        expect(res.turret?.priority).toBe(mode);
      }

      // 5. Relocate turret: charges TURRET_RELOCATE_COST (25) and applies 1.5 s redeploy cooldown
      const relocated = sim.relocateTurret('turret-alpha', { x: 0.85, y: 0, z: 0.35 });
      expect(relocated.ok).toBe(true);
      expect(relocated.cost).toBe(TURRET_RELOCATE_COST);
      expect(relocated.redeployCooldownSec).toBe(TURRET_REDEPLOY_COOLDOWN_SEC);
      expect(relocated.remainingCredits).toBe(580 - TURRET_RELOCATE_COST);
      expect(relocated.turret?.position).toEqual({ x: 0.85, y: 0, z: 0.35 });
      expect(relocated.turret?.isRedeploying).toBe(true);

      // Spawn a crawler right next to the relocated turret and verify it cannot fire during the 1.5 s cooldown
      const testEnemy = sim.debugSpawnEnemy('skitter-crawler', {
        position: { x: 0.85, y: 0, z: 0.0 },
        hp: 500,
      });
      sim.runTicks(45); // 0.75 s (< 1.5 s cooldown)
      expect(sim.getTurret('turret-alpha')?.shotsFired).toBe(0);
      expect(sim.getTurret('turret-alpha')?.redeployCooldownSec).toBeGreaterThan(0.7);
      expect(testEnemy.hp).toBe(500);

      // Step another 50 ticks (total 95 ticks > 90 ticks = 1.5 s) -> redeploy finishes and turret fires!
      sim.runTicks(50);
      expect(sim.getTurret('turret-alpha')?.redeployCooldownSec).toBe(0);
      expect(sim.getTurret('turret-alpha')?.isRedeploying).toBe(false);
      expect(sim.getTurret('turret-alpha')?.shotsFired).toBeGreaterThan(0);
      expect(testEnemy.hp).toBeLessThan(500);

      // 6. Sell turret: refunds 75% of total invested credits (420 * 0.75 = 315)
      const creditsBeforeSell = sim.getState().credits;
      const expectedRefund = getTurretSellRefund('autocannon', 'T3');
      expect(expectedRefund).toBe(315);

      const sold = sim.sellTurret('turret-alpha');
      expect(sold.ok).toBe(true);
      expect(sold.refundCredits).toBe(315);
      expect(sold.remainingCredits).toBe(creditsBeforeSell + 315);
      expect(sim.getState().turrets).toHaveLength(0);
    });

    it('routes turret and wave commands through the shared ActionBus', () => {
      const bus = createActionBus();
      const sim = createCombatSimulation({ seed: 42, startingCredits: 600 });
      const detach = sim.attachActionBus(bus);

      bus.dispatch({
        type: 'turret/build',
        kind: 'rail-sniper',
        position: { x: -0.9, y: 1.4, z: 0.5 },
      });
      expect(sim.getState().turrets).toHaveLength(1);
      const firstTurret = sim.getState().turrets[0];
      if (!firstTurret) throw new Error('Expected firstTurret');
      const turretId = firstTurret.id;

      bus.dispatch({ type: 'turret/upgrade', turretId });
      expect(sim.getTurret(turretId)?.tier).toBe('T2');

      bus.dispatch({ type: 'turret/set-priority', turretId, priority: 'air' });
      expect(sim.getTurret(turretId)?.priority).toBe('air');

      bus.dispatch({ type: 'wave/launch' });
      expect(sim.getState().phase).toBe('wave');
      expect(sim.getState().currentWave).toBe(1);

      bus.dispatch({ type: 'turret/sell', turretId });
      expect(sim.getState().turrets).toHaveLength(0);

      detach();
    });
  });

  describe('4 Distinct Weapon Systems', () => {
    it('Autocannon deals rapid kinetic tracer hits that are reduced by 50% against Carapace Brute frontal armor', () => {
      const sim = createCombatSimulation({ seed: 101, startingCredits: 500 });
      const placed = sim.placeTurret({
        kind: 'autocannon',
        position: { x: 0, y: 0, z: 0.2 },
        mountProfile: 'surface-clamp',
        surfaceKind: 'floor',
      });
      expect(placed.ok).toBe(true);
      const t1Stats = getTurretTierStats('autocannon', 'T1');

      // 1. Against unarmored Skitter Crawler: full T1 damage (11)
      const crawler = sim.debugSpawnEnemy('skitter-crawler', {
        position: { x: 0, y: 0, z: -0.5 },
        hp: 200,
      });
      const res1 = sim.tick();
      expect(crawler.hp).toBeCloseTo(200 - t1Stats.damage, 5);
      expect(res1.events.some((e) => e.type === 'turret-fired' && e.damageType === 'kinetic')).toBe(
        true,
      );

      // Remove crawler and reset cooldown by waiting fireIntervalSec
      crawler.hp = 0;
      sim.runTicks(15);

      // 2. Against armored Carapace Brute: 50% kinetic armor reduction (11 * 0.5 = 5.5 damage)
      const brute = sim.debugSpawnEnemy('carapace-brute', {
        position: { x: 0, y: 0, z: -0.5 },
        hp: 440,
      });
      sim.tick();
      expect(brute.hp).toBeCloseTo(440 - t1Stats.damage * 0.5, 5);
    });

    it('Plasma Mortar launches parabolic projectiles dealing AoE splash damage and stacking/refreshing thermal burn DoT while bypassing kinetic armor', () => {
      const sim = createCombatSimulation({ seed: 202, startingCredits: 800 });
      const placed = sim.placeTurret({
        id: 'mortar-1',
        kind: 'plasma-mortar',
        position: { x: 0, y: 0, z: 0.5 },
        mountProfile: 'surface-clamp',
        surfaceKind: 'floor',
      });
      expect(placed.ok).toBe(true);
      const mortarStats = getTurretTierStats('plasma-mortar', 'T1');

      // Spawn a Carapace Brute (primary target) and an adjacent Skitter Crawler within 0.65 m AoE splash radius
      const brute = sim.debugSpawnEnemy('carapace-brute', {
        position: { x: 0, y: 0, z: -0.8 },
        hp: 1000,
      });
      const neighborCrawler = sim.debugSpawnEnemy('skitter-crawler', {
        position: { x: 0.35, y: 0, z: -0.8 },
        hp: 500,
      });

      // Step 1 tick: Plasma Mortar fires a parabolic projectile (not instant hitscan)
      const fireTick = sim.tick();
      expect(fireTick.state.projectiles).toHaveLength(1);
      const proj = fireTick.state.projectiles[0];
      if (!proj) throw new Error('Expected mortar projectile');
      expect(proj.turretKind).toBe('plasma-mortar');
      expect(proj.arcHeightM).toBeGreaterThan(0.3);

      // Advance until projectile impacts
      let impacted = false;
      let maxObservedProjectileY = proj.position.y;
      for (let i = 0; i < 40; i += 1) {
        const stepRes = sim.tick();
        if (stepRes.state.projectiles[0]) {
          maxObservedProjectileY = Math.max(
            maxObservedProjectileY,
            stepRes.state.projectiles[0].position.y,
          );
        }
        const impactEv = stepRes.events.find((e) => e.type === 'projectile-impact');
        if (impactEv && impactEv.type === 'projectile-impact') {
          impacted = true;
          expect(impactEv.hitEnemyIds).toContain(brute.id);
          expect(impactEv.hitEnemyIds).toContain(neighborCrawler.id);
          break;
        }
      }
      expect(impacted).toBe(true);
      // Verify projectile followed a parabolic arc elevated above ground level
      expect(maxObservedProjectileY).toBeGreaterThan(0.45);

      // Verify Carapace Brute took full plasma damage (bypasses 50% kinetic armor and applies +15% plasma vulnerability = 1.15x)
      const expectedBruteMult = computeEffectiveDamageMultiplier({
        enemyId: 'carapace-brute',
        damageType: 'plasma',
        armorPierceFactor: mortarStats.armorPierceFactor,
        antiAirMultiplier: mortarStats.antiAirMultiplier,
        bossBonusMultiplier: mortarStats.bossBonusMultiplier,
      });
      expect(expectedBruteMult).toBeCloseTo(1.15, 5);
      expect(brute.hp).toBeLessThanOrEqual(1000 - mortarStats.damage * expectedBruteMult + 1);
      expect(neighborCrawler.hp).toBeLessThan(500);

      // Both targets now carry 1 stack of thermal burn DoT
      expect(brute.burnStacks).toBe(1);
      expect(brute.burnDps).toBe(mortarStats.burnDps);
      expect(brute.burnRemainingSec).toBeGreaterThan(2.0);

      const hpAfterImpact = brute.hp;
      sim.runTicks(30); // 0.5 s of burn DoT ticks
      expect(brute.hp).toBeLessThan(hpAfterImpact);

      // Wait for second mortar shot to land while burn is still active -> verifies burn stack increment & duration refresh
      let secondImpact = false;
      for (let i = 0; i < 90; i += 1) {
        const stepRes = sim.tick();
        if (stepRes.events.some((e) => e.type === 'projectile-impact')) {
          secondImpact = true;
          break;
        }
      }
      expect(secondImpact).toBe(true);
      expect(brute.burnStacks).toBe(2);
      expect(brute.burnDps).toBeGreaterThan(mortarStats.burnDps);
      expect(brute.burnRemainingSec).toBeCloseTo(mortarStats.burnDurationSec, 1);
    });

    it('Cryo-Arc applies 35/45/55% movement slow and chains instantaneously across 2/3/4 ground & aerial targets', () => {
      const sim = createCombatSimulation({ seed: 303, startingCredits: 1500 });
      const placed = sim.placeTurret({
        id: 'cryo-1',
        kind: 'cryo-arc',
        position: { x: 0, y: 0, z: 0.4 },
        mountProfile: 'surface-clamp',
        surfaceKind: 'floor',
      });
      expect(placed.ok).toBe(true);

      // Spawn 4 enemies within chain jump radius (mixing ground Crawlers and aerial Wasp Skimmers)
      const e1 = sim.debugSpawnEnemy('skitter-crawler', {
        position: { x: 0, y: 0, z: -0.6 },
        hp: 600,
      });
      const e2 = sim.debugSpawnEnemy('wasp-skimmer', {
        position: { x: 0.3, y: 0.6, z: -0.8 },
        hp: 600,
      });
      const e3 = sim.debugSpawnEnemy('skitter-crawler', {
        position: { x: 0.6, y: 0, z: -1.0 },
        hp: 600,
      });
      const e4 = sim.debugSpawnEnemy('wasp-skimmer', {
        position: { x: 0.9, y: 0.6, z: -1.2 },
        hp: 600,
      });

      // T1 Cryo-Arc: chains across 2 targets with 35% slow
      const t1Tick = sim.tick();
      const t1Chain = t1Tick.events.find((e) => e.type === 'cryo-chain');
      expect(t1Chain).toBeDefined();
      if (t1Chain?.type === 'cryo-chain') {
        expect(t1Chain.jumpCount).toBe(2);
        expect(t1Chain.slowFactor).toBe(0.35);
      }
      expect(e1.slowFactor).toBeCloseTo(computeEffectiveSlowFactor('skitter-crawler', 0.35), 5);
      expect(e2.slowFactor).toBeCloseTo(computeEffectiveSlowFactor('wasp-skimmer', 0.35), 5);
      expect(e3.slowFactor).toBe(0);

      // Upgrade to T2: chains across 3 targets with 45% slow
      sim.upgradeTurret('cryo-1');
      const cryoTurretT2 = sim.getTurret('cryo-1');
      if (!cryoTurretT2) throw new Error('Expected cryo-1');
      cryoTurretT2.fireCooldownSec = 0;
      const t2Tick = sim.tick();
      const t2Chain = t2Tick.events.find((e) => e.type === 'cryo-chain');
      expect(t2Chain?.type === 'cryo-chain' && t2Chain.jumpCount).toBe(3);
      expect(e3.slowFactor).toBeCloseTo(0.45, 5);

      // Upgrade to T3: chains across all 4 targets with 55% slow
      sim.upgradeTurret('cryo-1');
      cryoTurretT2.fireCooldownSec = 0;
      const t3Tick = sim.tick();
      const t3Chain = t3Tick.events.find((e) => e.type === 'cryo-chain');
      expect(t3Chain?.type === 'cryo-chain' && t3Chain.jumpCount).toBe(4);
      expect(e4.slowFactor).toBeCloseTo(0.55, 5);
      expect(e1.effectiveSpeedMps).toBeCloseTo(e1.speedMps * (1 - 0.55), 4);
    });

    it('Rail Sniper fires an instant piercing line-of-sight beam with armor pierce, anti-air bonus, and boss bonus', () => {
      const sim = createCombatSimulation({ seed: 404, startingCredits: 1500 });
      const placed = sim.placeTurret({
        id: 'rail-1',
        kind: 'rail-sniper',
        position: { x: 0, y: 0, z: 0.8 },
        mountProfile: 'surface-clamp',
        surfaceKind: 'floor',
        priority: 'first',
      });
      expect(placed.ok).toBe(true);

      // Upgrade to T3 (damage 195, armorPierce 1.0, antiAir 1.8, bossBonus 1.7)
      sim.upgradeTurret('rail-1');
      sim.upgradeTurret('rail-1');
      const t3Stats = getTurretTierStats('rail-sniper', 'T3');
      expect(t3Stats.armorPierceFactor).toBe(1.0);
      expect(t3Stats.antiAirMultiplier).toBe(1.8);
      expect(t3Stats.bossBonusMultiplier).toBe(1.7);

      // Align two enemies along the exact line of sight (x = 0, y = 0, z = -0.2 and z = -1.2)
      const frontBrute = sim.debugSpawnEnemy('carapace-brute', {
        position: { x: 0, y: 0, z: -0.2 },
        distanceAlongPath: 2.5,
        hp: 2000,
      });
      const rearSkimmer = sim.debugSpawnEnemy('wasp-skimmer', {
        position: { x: 0, y: 0, z: -1.2 },
        distanceAlongPath: 1.5,
        hp: 2000,
      });

      const fireRes = sim.tick();
      const fireEv = fireRes.events.find(
        (e) => e.type === 'turret-fired' && e.turretKind === 'rail-sniper',
      );
      expect(fireEv?.type === 'turret-fired' && fireEv.piercedEnemyIds?.length).toBe(2);

      // Front Brute takes full T3 Rail damage with 100% armor pierce + 20% rail vulnerability (195 * 1.2 = 234)
      const bruteMult = computeEffectiveDamageMultiplier({
        enemyId: 'carapace-brute',
        damageType: 'rail',
        armorPierceFactor: t3Stats.armorPierceFactor,
        antiAirMultiplier: t3Stats.antiAirMultiplier,
        bossBonusMultiplier: t3Stats.bossBonusMultiplier,
      });
      expect(frontBrute.hp).toBeCloseTo(2000 - t3Stats.damage * bruteMult, 4);

      // Rear aerial Skimmer is pierced along the beam and takes anti-air bonus (1.8x) * pierce retention
      expect(rearSkimmer.hp).toBeLessThan(2000);
    });
  });

  describe('Rift Disruptor EMP Disable (4.0s) + Post-EMP Immunity (5.0s) & Broodlord Boss Phase 2', () => {
    it('Disruptor disables turrets within 1.2m for 4.0s and grants 5.0s post-recovery immunity preventing permastun', () => {
      const sim = createCombatSimulation({ seed: 505, startingCredits: 600 });
      const placed = sim.placeTurret({
        id: 'turret-emp-target',
        kind: 'autocannon',
        position: { x: 0, y: 1.2, z: 0.0 },
        mountProfile: 'hover-pod',
      });
      expect(placed.ok).toBe(true);
      const turret = placed.turret;
      if (!turret) throw new Error('Expected placed turret');

      // Spawn a Rift Disruptor within 1.2 m of the turret (at distance 0.5 m)
      const disruptor1 = sim.debugSpawnEnemy('rift-disruptor', {
        position: { x: 0, y: 1.4, z: -0.4 },
        hp: 5000,
      });
      expect(disruptor1.path.id).toContain('disruptor-detour');

      // Tick 1: Disruptor triggers its 4.0 s EMP disable
      const tick1 = sim.tick();
      const disruptedEv = tick1.events.find((e) => e.type === 'turret-disrupted');
      expect(disruptedEv).toBeDefined();
      expect(turret.isDisrupted).toBe(true);
      expect(turret.disabledRemainingSec).toBeCloseTo(4.0 - SIM_FIXED_DT, 4);

      // While disabled (e.g. 2.0 s = 120 ticks in), turret cannot fire and a second Disruptor cannot extend the stun
      sim.runTicks(119);
      expect(turret.isDisrupted).toBe(true);
      expect(turret.shotsFired).toBe(0);

      sim.debugSpawnEnemy('rift-disruptor', {
        position: { x: 0.1, y: 1.3, z: -0.2 },
        hp: 5000,
      });
      const midDisableTick = sim.tick();
      expect(midDisableTick.events.some((e) => e.type === 'turret-disrupted')).toBe(false);

      // Step the remaining 120 ticks to reach t = 4.0 s (total 240 ticks from pulse) -> Turret recovers with 5.0 s immunity!
      const recoveryRun = sim.runTicks(120);
      const recoveredEv = recoveryRun.events.find((e) => e.type === 'turret-recovered');
      expect(recoveredEv).toBeDefined();
      if (recoveredEv?.type === 'turret-recovered') {
        expect(recoveredEv.immunityDurationSec).toBe(5.0);
      }
      expect(turret.isDisrupted).toBe(false);
      expect(turret.disabledRemainingSec).toBe(0);
      expect(turret.isEmpImmune).toBe(true);
      expect(turret.empImmunityRemainingSec).toBeGreaterThan(4.8);

      // During the 5.0 s post-EMP immunity window, spawn another fresh Disruptor right on top of the turret:
      // immunity MUST block re-stunning while the turret fires freely!
      sim.debugSpawnEnemy('rift-disruptor', {
        position: { x: 0, y: 1.25, z: -0.1 },
        hp: 5000,
      });
      const immuneRun = sim.runTicks(180); // 3.0 s into the 5.0 s immunity window
      expect(immuneRun.events.some((e) => e.type === 'turret-disrupted')).toBe(false);
      expect(turret.isDisrupted).toBe(false);
      expect(turret.isEmpImmune).toBe(true);
      expect(turret.shotsFired).toBeGreaterThan(10);
    });

    it('Apex Broodlord transitions to Phase 2 at <=50% HP, spawns 0-bounty Skitter adds respecting the 25-enemy cap, and emits suppression roars', () => {
      const sim = createCombatSimulation({ seed: 606, startingCredits: 2500 });

      // Place a T3 Rail Sniper to damage the Boss and a close hover turret within the 1.5 m roar radius
      sim.placeTurret({
        id: 'boss-killer',
        kind: 'rail-sniper',
        position: { x: -0.9, y: 0, z: 0.9 },
        mountProfile: 'surface-clamp',
        surfaceKind: 'floor',
        priority: 'strongest',
      });
      sim.upgradeTurret('boss-killer');
      sim.upgradeTurret('boss-killer');

      const closeTurret = sim.placeTurret({
        id: 'frontline-turret',
        kind: 'autocannon',
        position: { x: -0.5, y: 0, z: -1.2 },
        mountProfile: 'surface-clamp',
        surfaceKind: 'floor',
      }).turret;
      if (!closeTurret) throw new Error('Expected closeTurret');

      // Spawn the Apex Broodlord just above the 50% HP threshold (50% of 5600 = 2800; start at 2900 HP)
      const boss = sim.debugSpawnBoss({
        position: { x: -0.5, y: 0, z: -1.6 },
        distanceAlongPath: 1.2,
        hp: 2900,
      });
      expect(boss.isBoss).toBe(true);
      expect(boss.bossPhase).toBe(1);
      expect(boss.isBossPhase2).toBe(false);

      // Force boss timers near 0 so both add-summon and suppression roar trigger promptly
      boss.bossSummonTimerSec = SIM_FIXED_DT;
      boss.bossSuppressionTimerSec = SIM_FIXED_DT;

      const stepRes = sim.runTicks(5);
      // 1. Rail Sniper hit drops Boss below 2800 HP (<= 50%), triggering Phase 2!
      const phase2Ev = stepRes.events.find((e) => e.type === 'boss-phase2');
      expect(phase2Ev).toBeDefined();
      expect(boss.bossPhase).toBe(2);
      expect(boss.isBossPhase2).toBe(true);
      expect(boss.emissiveIntensity).toBe(1.0);

      // 2. Boss suppression roar disables the nearby frontline turret for 3.0 s
      const roarDisrupt = stepRes.events.find(
        (e) => e.type === 'turret-disrupted' && e.sourceArchetypeId === 'apex-broodlord',
      );
      expect(roarDisrupt).toBeDefined();
      expect(closeTurret.isDisrupted).toBe(true);

      // 3. Boss summoned 0-bounty Skitter Crawler adds
      const summonedAdds = sim.getState().enemies.filter((e) => e.isSummonedAdd);
      expect(summonedAdds.length).toBeGreaterThanOrEqual(3);
      for (const add of summonedAdds) {
        expect(add.enemyId).toBe('skitter-crawler');
        expect(add.creditBounty).toBe(0);
        expect(add.summonedByBossId).toBe(boss.id);
      }

      // 4. Verify add spawns strictly respect the MAX_ACTIVE_ENEMIES = 25 cap
      while (sim.getState().enemies.length < MAX_ACTIVE_ENEMIES) {
        sim.debugSpawnEnemy('skitter-crawler', { hp: 5000 });
      }
      expect(sim.getState().enemies.length).toBe(MAX_ACTIVE_ENEMIES);
      boss.bossSummonTimerSec = SIM_FIXED_DT;
      sim.tick();
      expect(sim.getState().enemies.length).toBeLessThanOrEqual(MAX_ACTIVE_ENEMIES);
    });
  });

  describe('Full Deterministic 12-Wave Victory & Zero-Turret Defeat Runs', () => {
    // Two complete campaign simulations can exceed Vitest's default timeout on a shared CI runner.
    it('reaches Victory across all 12 waves with byte-identical computeStateHash() across two independent runs with the same seed', () => {
      const seed = 0x2026_b45e;
      const runA = runScripted12WaveDefense(seed);
      const runB = runScripted12WaveDefense(seed);

      const stateA = runA.sim.getState();
      const stateB = runB.sim.getState();

      expect(stateA.phase).toBe('victory');
      expect(stateA.victory).toBe(true);
      expect(stateA.defeat).toBe(false);
      expect(stateA.currentWave).toBe(12);
      expect(stateA.wavesCleared).toBe(12);
      expect(stateA.coreHp).toBeGreaterThan(0);
      expect(stateA.stars).toBeGreaterThanOrEqual(1);
      expect(stateA.score).toBeGreaterThan(5000);
      expect(runA.sawBossPhase2).toBe(true);
      expect(runA.maxConcurrentEnemiesObserved).toBeLessThanOrEqual(MAX_ACTIVE_ENEMIES);

      // Assert byte-identical deterministic state hash at every checkpoint and at mission end
      expect(runA.tickSnapshots).toEqual(runB.tickSnapshots);
      expect(runA.finalHash).toBe(runB.finalHash);
      expect(stateA.tick).toBe(stateB.tick);
      expect(stateA.credits).toBe(stateB.credits);
      expect(stateA.coreHp).toBe(stateB.coreHp);
      expect(stateA.score).toBe(stateB.score);
    }, 20_000);

    it('reaches Defeat in a zero-turret run with byte-identical computeStateHash() across two independent runs', () => {
      const runZeroTurretToDefeat = (seed: number) => {
        const sim = createCombatSimulation({ seed, autoStartWave1: true });
        const maxTicks = 60 * 600;
        for (let i = 0; i < maxTicks; i += 1) {
          const res = sim.tick();
          expect(res.state.enemies.length).toBeLessThanOrEqual(MAX_ACTIVE_ENEMIES);
          if (res.state.phase === 'intermission') {
            sim.launchWave();
          }
          if (res.state.phase === 'defeat' || res.state.phase === 'victory') {
            break;
          }
        }
        return {
          state: sim.getState(),
          hash: sim.computeStateHash(),
          history: sim.getEventHistory(),
        };
      };

      const defeatA = runZeroTurretToDefeat(0xdead_beef);
      const defeatB = runZeroTurretToDefeat(0xdead_beef);

      expect(defeatA.state.phase).toBe('defeat');
      expect(defeatA.state.defeat).toBe(true);
      expect(defeatA.state.victory).toBe(false);
      expect(defeatA.state.coreHp).toBe(0);
      expect(defeatA.state.stars).toBe(0);
      expect(
        defeatA.history.some(
          (e) => e.type === 'mission-ended' && e.outcome === 'defeat' && !e.victory,
        ),
      ).toBe(true);

      expect(defeatA.hash).toBe(defeatB.hash);
      expect(defeatA.state.tick).toBe(defeatB.state.tick);
    });

    it('supports debugJumpToWave and debugGrantCredits hooks cleanly for automated verification', () => {
      const sim = createCombatSimulation({ seed: 777 });
      const newBalance = sim.debugGrantCredits(5000);
      expect(newBalance).toBe(320 + 5000);

      const wave12 = sim.debugJumpToWave(12);
      expect(wave12.waveNumber).toBe(12);
      expect(wave12.isBossWave).toBe(true);
      expect(sim.getState().currentWave).toBe(12);
      expect(sim.getState().phase).toBe('wave');
      expect(sim.getState().activePortals).toHaveLength(4);
    });

    it('prevents wall-mounted turrets from targeting enemies behind their own wall or across a room wall', () => {
      const sim = createCombatSimulation({
        seed: 901,
        startingCredits: 1000,
        surfaces: [
          {
            id: 'floor-main',
            kind: 'floor',
            normal: { x: 0, y: 1, z: 0 },
            center: { x: 0, y: 0, z: 0 },
            polygon: [
              { x: -2.4, y: 0, z: -2.1 },
              { x: 2.4, y: 0, z: -2.1 },
              { x: 2.4, y: 0, z: 2.1 },
              { x: -2.4, y: 0, z: 2.1 },
            ],
          },
          {
            id: 'wall-west',
            kind: 'wall',
            normal: { x: 1, y: 0, z: 0 },
            center: { x: -2.0, y: 1.4, z: 0 },
            polygon: [
              { x: -2.0, y: 0, z: -2.1 },
              { x: -2.0, y: 0, z: 2.1 },
              { x: -2.0, y: 2.8, z: 2.1 },
              { x: -2.0, y: 2.8, z: -2.1 },
            ],
          },
          {
            id: 'wall-divider',
            kind: 'wall',
            normal: { x: 0, y: 0, z: 1 },
            center: { x: 0, y: 1.4, z: -0.5 },
            polygon: [
              { x: -2.4, y: 0, z: -0.5 },
              { x: 2.4, y: 0, z: -0.5 },
              { x: 2.4, y: 2.8, z: -0.5 },
              { x: -2.4, y: 2.8, z: -0.5 },
            ],
          },
        ],
      });

      // Wall turret mounted on west wall facing +X into the room
      const wallTurret = sim.placeTurret({
        kind: 'rail-sniper',
        position: { x: -2.0, y: 1.2, z: 0.4 },
        normal: { x: 1, y: 0, z: 0 },
        mountProfile: 'surface-clamp',
        surfaceId: 'wall-west',
        surfaceKind: 'wall',
      }).turret;
      if (!wallTurret) throw new Error('Expected wall turret placement');

      // Enemy 1: behind the west mounting wall (x = -2.8 < -2.0) — must NOT be targeted
      sim.debugSpawnEnemy('carapace-brute', {
        position: { x: -2.8, y: 1.2, z: 0.4 },
        hp: 500,
      });
      // Enemy 2: on the far side of wall-divider (z = -1.2 vs turret z = 0.4) — must NOT be targeted
      sim.debugSpawnEnemy('carapace-brute', {
        position: { x: -1.0, y: 1.2, z: -1.2 },
        hp: 500,
      });

      const blockedRes = sim.tick();
      expect(blockedRes.events.some((e) => e.type === 'turret-fired')).toBe(false);

      // Enemy 3: inside the room in front of both walls — SHOULD be targeted and hit
      const visibleEnemy = sim.debugSpawnEnemy('carapace-brute', {
        position: { x: -0.8, y: 1.2, z: 0.4 },
        hp: 500,
      });
      const clearRes = sim.tick();
      const shot = clearRes.events.find((e) => e.type === 'turret-fired');
      expect(shot).toBeDefined();
      expect(shot?.targetEnemyId).toBe(visibleEnemy.id);
    });
  });
});
