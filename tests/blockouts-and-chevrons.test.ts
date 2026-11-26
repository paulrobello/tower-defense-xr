import 'fake-indexeddb/auto';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  CORE_BASTION_SPEC,
  ENEMIES,
  ENEMY_IDS,
  GAMEPLAY_OBJECT_SCALE,
  getTurretTierStats,
  RIFT_PORTAL_SPEC,
  TURRET_BARREL_START_FRACTION,
  TURRET_KINDS,
  type TurretKind,
} from '../src/content/index.ts';
import { createActionBus } from '../src/core/action-bus.ts';
import { createOcclusionController } from '../src/mr/occlusion.ts';
import { createPersistStore } from '../src/persist/store.ts';
import { createBlockoutRenderer } from '../src/render/blockouts.ts';
import { createSettingsStore } from '../src/settings/store.ts';
import { createCombatSimulation, SIM_FIXED_DT } from '../src/sim/engine.ts';
import { createMissionOverlay } from '../src/ui/mission-overlay.ts';
import {
  createThreatChevrons,
  evaluateThreatIndicators,
  NEAR_CORE_THREAT_RADIUS_M,
  PORTAL_THREAT_ALERT_DURATION_SEC,
  projectThreatDirection,
} from '../src/ui/threat-chevrons.ts';

describe('P2-T5: BlockoutRenderer (Core, Portals, 4 Turrets × 3 Tiers, 5 Invaders, Instanced FX)', () => {
  it('aligns the shot origin and launch direction with the displayed barrel on floor and wall mounts', () => {
    for (const kind of TURRET_KINDS) {
      for (const kindOfSurface of ['floor', 'wall'] as const) {
        const scene = new THREE.Scene();
        const renderer = createBlockoutRenderer(scene);
        const sim = createCombatSimulation({ seed: 42 });
        const wall = kindOfSurface === 'wall';
        const turret = sim.placeTurret({
          kind,
          position: { x: 0, y: wall ? 1.1 : 0, z: -1 },
          normal: wall ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 },
          mountProfile: 'surface-clamp',
          surfaceKind: kindOfSurface,
        }).turret;
        if (!turret) throw new Error('Expected turret placement');
        sim.debugSpawnEnemy('carapace-brute', {
          position: { x: 0.65, y: 0.4, z: 0.25 },
          hp: 2000,
        });
        const { state, events } = sim.tick();
        const shot = events.find((event) => event.type === 'turret-fired');
        if (!shot) throw new Error(`Expected a shot from ${kind}`);
        renderer.syncFromSim(state, events, 1 / 60);
        const displayed = renderer.turrets.get(turret.id);
        if (!displayed) throw new Error('Expected the displayed turret');
        const b = turret.stats.blockout;
        const reach = b.headLengthM * TURRET_BARREL_START_FRACTION + b.barrelLengthM;
        const muzzle = displayed.pitchCradle.localToWorld(new THREE.Vector3(0, 0, reach));
        expect(muzzle.distanceTo(new THREE.Vector3().copy(shot.fromPosition))).toBeLessThan(1e-6);
        const forward = displayed.pitchCradle.getWorldDirection(new THREE.Vector3());
        const launch = new THREE.Vector3().copy(shot.toPosition).sub(muzzle);
        if (kind === 'plasma-mortar') {
          const shell = state.projectiles.find((projectile) => projectile.id === shot.projectileId);
          if (!shell) throw new Error('Expected a mortar projectile');
          launch.y += 4 * shell.arcHeightM;
        }
        expect(forward.dot(launch.normalize())).toBeCloseTo(1, 5);
        renderer.dispose();
      }
    }
  });

  it('creates Core Bastion and Rift Portals with aperture masks and reacts to core-hit events', () => {
    const scene = new THREE.Scene();
    const occlusion = createOcclusionController({ initialMode: 'auto-depth' });
    const renderer = createBlockoutRenderer(scene, occlusion);
    const sim = createCombatSimulation({ seed: 20261120 });

    renderer.syncFromSim(sim.getState(), sim.drainEvents(), 1 / 60);

    // Core Bastion positioned at sim corePosition
    expect(renderer.coreBastion.group.position.z).toBeCloseTo(sim.getState().corePosition.z, 3);
    expect(renderer.coreBastion.pedestalMesh.name).toBe('core-bastion-pedestal');
    expect(renderer.coreBastion.shieldRingMesh.name).toBe('core-bastion-shield-ring');
    expect(renderer.coreBastion.energyCoreMesh.position.y).toBeLessThanOrEqual(
      CORE_BASTION_SPEC.heightM,
    );
    const shadow = renderer.coreBastion.group.getObjectByName(
      'core-bastion-contact-shadow',
    ) as THREE.Mesh;
    expect(shadow).toBeDefined();
    expect(shadow.position.y).toBeGreaterThan(0);
    expect((shadow.material as THREE.MeshBasicMaterial).depthWrite).toBe(false);
    expect(renderer.coreBastion.pedestalMesh.castShadow).toBe(false);
    expect(renderer.coreBastion.energyCoreMesh.castShadow).toBe(false);

    // 4 Rift Portals created with aperture mask meshes
    expect(renderer.portals.size).toBe(4);
    for (const portal of renderer.portals.values()) {
      expect(portal.apertureMaskMesh).not.toBeNull();
      expect(portal.frameMesh.name).toContain('portal-frame-');
      expect(portal.interiorMesh.name).toContain('portal-interior-');
    }

    // Trigger core-hit event and verify shield flare reaction
    renderer.syncFromSim(
      sim.getState(),
      [
        {
          type: 'core-hit',
          tick: 10,
          timeSec: 0.2,
          enemyId: 'enemy-1',
          archetypeId: 'skitter-crawler',
          damage: 4,
          remainingCoreHp: 96,
          maxCoreHp: 100,
          position: sim.getState().corePosition,
        },
      ],
      0.016,
    );
    expect(renderer.coreBastion.hitFlashRemainingSec).toBeGreaterThan(0);
    expect(renderer.coreBastion.shieldMaterial.color.getHex()).toBe(0xff3b5c);

    renderer.dispose();
    occlusion.dispose();
  });

  it('puts scaled wall and ceiling portal rims against their host plane while keeping masks on the anchor', () => {
    const scene = new THREE.Scene();
    const occlusion = createOcclusionController({ initialMode: 'auto-depth' });
    const renderer = createBlockoutRenderer(scene, occlusion);
    const sim = createCombatSimulation({ seed: 20261120 });
    const baseState = sim.getState();
    const portals = baseState.portals.map((portal, index) =>
      index < 2
        ? {
            ...portal,
            position: { x: index === 0 ? -0.9 : 0.9, y: index === 1 ? 2.5 : 1.4, z: -2.1 },
            normal: index === 1 ? { x: 0, y: -1, z: 0 } : { x: 0, y: 0, z: 1 },
            hostKind: index === 1 ? ('ceiling' as const) : ('wall' as const),
          }
        : portal,
    );

    renderer.syncFromSim({ ...baseState, portals }, [], 1 / 60);
    scene.updateMatrixWorld(true);

    for (const anchor of portals.slice(0, 2)) {
      const blockout = renderer.portals.get(anchor.id);
      expect(blockout).toBeDefined();
      if (!blockout) continue;
      const normal = new THREE.Vector3(anchor.normal.x, anchor.normal.y, anchor.normal.z);
      const backOfRim = blockout.group.localToWorld(
        new THREE.Vector3(0, 0, -RIFT_PORTAL_SPEC.rimThicknessM * 0.5),
      );
      const anchorPoint = new THREE.Vector3(
        anchor.position.x,
        anchor.position.y,
        anchor.position.z,
      );
      expect(backOfRim.clone().sub(anchorPoint).dot(normal)).toBeCloseTo(0.002, 4);
      expect(blockout.apertureMaskMesh).not.toBeNull();
      if (blockout.apertureMaskMesh) {
        expect(
          blockout.apertureMaskMesh.getWorldPosition(new THREE.Vector3()).distanceTo(anchorPoint),
        ).toBeLessThan(1e-6);
      }
    }

    expect(GAMEPLAY_OBJECT_SCALE).toBe(0.45);
    renderer.dispose();
    occlusion.dispose();
  });

  it('builds all 4 turret roles across T1 -> T2 -> T3 upgrades, surface-clamp vs hover-pod mounts, recoil, and EMP disruption halo', () => {
    const scene = new THREE.Scene();
    const renderer = createBlockoutRenderer(scene);
    const sim = createCombatSimulation({
      seed: 42,
      startingCredits: 9000,
    });

    const placements: Array<{
      kind: TurretKind;
      position: { x: number; y: number; z: number };
      mountProfile: 'surface-clamp' | 'hover-pod';
      surfaceId?: string;
    }> = [
      {
        kind: 'autocannon',
        position: { x: -1.1, y: 0, z: 0.4 },
        mountProfile: 'surface-clamp',
        surfaceId: 'sim-floor-main',
      },
      {
        kind: 'plasma-mortar',
        position: { x: -0.4, y: 0, z: 0.4 },
        mountProfile: 'surface-clamp',
        surfaceId: 'sim-floor-main',
      },
      {
        kind: 'cryo-arc',
        position: { x: 0.4, y: 1.25, z: 0.4 },
        mountProfile: 'hover-pod',
      },
      {
        kind: 'rail-sniper',
        position: { x: 1.1, y: 1.35, z: 0.4 },
        mountProfile: 'hover-pod',
      },
    ];

    const placedIds: string[] = [];
    for (const p of placements) {
      const res = sim.placeTurret({
        kind: p.kind,
        position: p.position,
        mountProfile: p.mountProfile,
        surfaceId: p.surfaceId,
      });
      expect(res.ok).toBe(true);
      if (res.turret) placedIds.push(res.turret.id);
    }

    renderer.syncFromSim(sim.getState(), sim.drainEvents(), 1 / 60);
    expect(renderer.turrets.size).toBe(4);

    // Check T1 dimensions, mount profile visibility, and barrel counts
    for (let i = 0; i < TURRET_KINDS.length; i += 1) {
      const kind = TURRET_KINDS[i] as TurretKind;
      const id = placedIds[i] as string;
      const blockout = renderer.turrets.get(id);
      expect(blockout).toBeDefined();
      if (!blockout) continue;

      const t1Stats = getTurretTierStats(kind, 'T1');
      expect(blockout.tier).toBe('T1');
      expect(blockout.barrelGroup.userData.tier).toBe('T1');
      expect(blockout.barrelGroup.userData.barrelCount).toBe(t1Stats.blockout.barrelCount);
      expect(blockout.headMesh.scale.x).toBeCloseTo(t1Stats.blockout.headWidthM, 4);
      expect(blockout.headMesh.scale.y).toBeCloseTo(t1Stats.blockout.headHeightM, 4);
      expect(blockout.headMesh.scale.z).toBeCloseTo(t1Stats.blockout.headLengthM, 4);

      const expectedHover = placements[i]?.mountProfile === 'hover-pod';
      expect(blockout.hoverPodGroup.visible).toBe(expectedHover);
      expect(blockout.clampMountGroup.visible).toBe(!expectedHover);
      expect(blockout.empHaloGroup.visible).toBe(false);
    }

    // Upgrade all 4 turrets to T2 and verify silhouettes update
    for (const id of placedIds) {
      const up = sim.upgradeTurret(id);
      expect(up.ok).toBe(true);
      expect(up.tier).toBe('T2');
    }
    renderer.syncFromSim(sim.getState(), sim.drainEvents(), 1 / 60);

    for (let i = 0; i < TURRET_KINDS.length; i += 1) {
      const kind = TURRET_KINDS[i] as TurretKind;
      const id = placedIds[i] as string;
      const blockout = renderer.turrets.get(id);
      expect(blockout).toBeDefined();
      if (!blockout) continue;
      const t2Stats = getTurretTierStats(kind, 'T2');
      expect(blockout.tier).toBe('T2');
      expect(blockout.barrelGroup.userData.tier).toBe('T2');
      expect(blockout.barrelGroup.userData.barrelCount).toBe(t2Stats.blockout.barrelCount);
      expect(blockout.headMesh.scale.x).toBeCloseTo(t2Stats.blockout.headWidthM, 4);
    }

    // Upgrade all 4 turrets to T3 and verify T3 rotary/siege/tri-pylon/twin-rail silhouettes
    for (const id of placedIds) {
      const up = sim.upgradeTurret(id);
      expect(up.ok).toBe(true);
      expect(up.tier).toBe('T3');
    }
    renderer.syncFromSim(sim.getState(), sim.drainEvents(), 1 / 60);

    for (let i = 0; i < TURRET_KINDS.length; i += 1) {
      const kind = TURRET_KINDS[i] as TurretKind;
      const id = placedIds[i] as string;
      const blockout = renderer.turrets.get(id);
      expect(blockout).toBeDefined();
      if (!blockout) continue;
      const t3Stats = getTurretTierStats(kind, 'T3');
      expect(blockout.tier).toBe('T3');
      expect(blockout.barrelGroup.userData.tier).toBe('T3');
      expect(blockout.barrelGroup.userData.barrelCount).toBe(t3Stats.blockout.barrelCount);
    }

    // Spawn a Rift Disruptor right next to turret-1 so it pulses EMP disruption
    const firstId = placedIds[0] ?? 'turret-1';
    const firstTurret = sim.getTurret(firstId);
    expect(firstTurret).toBeDefined();
    if (!firstTurret) return;
    sim.debugSpawnEnemy('rift-disruptor', {
      position: {
        x: firstTurret.position.x,
        y: firstTurret.position.y + 0.3,
        z: firstTurret.position.z,
      },
      initialEmpCooldownSec: 0,
    });

    const tickRes = sim.tick();
    renderer.syncFromSim(tickRes.state, sim.drainEvents(), 1 / 60);

    const disruptedTurretBlockout = renderer.turrets.get(firstId);
    expect(disruptedTurretBlockout).toBeDefined();
    if (!disruptedTurretBlockout) return;
    expect(disruptedTurretBlockout.isDisrupted).toBe(true);
    expect(disruptedTurretBlockout.empHaloGroup.visible).toBe(true);
    expect(disruptedTurretBlockout.accentMaterial.emissiveIntensity).toBeCloseTo(0.2, 3);

    renderer.dispose();
  });

  it('renders all 5 invader archetypes, cryo-slow cyan frost tint, Apex Broodlord Boss Phase-2 armor cracks, instanced HP bars, and pooled weapon FX', () => {
    const scene = new THREE.Scene();
    const renderer = createBlockoutRenderer(scene);
    const sim = createCombatSimulation({
      seed: 99,
      startingCredits: 5000,
    });

    // Place a Cryo-Arc, Autocannon, Plasma Mortar, and Rail Sniper
    sim.placeTurret({
      kind: 'cryo-arc',
      position: { x: -0.7, y: 0, z: -0.4 },
      mountProfile: 'surface-clamp',
      surfaceId: 'sim-floor-main',
    });
    sim.placeTurret({
      kind: 'autocannon',
      position: { x: 0.7, y: 0, z: -0.4 },
      mountProfile: 'surface-clamp',
      surfaceId: 'sim-floor-main',
    });
    sim.placeTurret({
      kind: 'plasma-mortar',
      position: { x: -0.7, y: 0, z: 0.3 },
      mountProfile: 'surface-clamp',
      surfaceId: 'sim-floor-main',
    });
    const railRes = sim.placeTurret({
      kind: 'rail-sniper',
      position: { x: 0.7, y: 0, z: 0.3 },
      mountProfile: 'surface-clamp',
      surfaceId: 'sim-floor-main',
      priority: 'strongest',
    });
    expect(railRes.ok).toBe(true);

    // Spawn all 5 enemy archetypes (keep Disruptor EMP on cooldown and Boss near portal > 1.5 m from turrets)
    const spawnedIds: Record<string, string> = {};
    for (let i = 0; i < ENEMY_IDS.length; i += 1) {
      const archetypeId = ENEMY_IDS[i] ?? 'skitter-crawler';
      const enemy = sim.debugSpawnEnemy(archetypeId, {
        portalIndex: i % 4,
        distanceAlongPath: archetypeId === 'apex-broodlord' ? 0.15 : 1.3 + i * 0.15,
        initialEmpCooldownSec: 10,
      });
      spawnedIds[archetypeId] = enemy.id;
    }

    // Run ticks so turrets fire (cryo slow + chain, kinetic tracer, mortar shell, rail beam)
    const stepRes = sim.runTicks(4);
    renderer.syncFromSim(stepRes.state, stepRes.events, 0.03);

    expect(renderer.enemies.size).toBe(5);
    expect(renderer.hpBgInstancedMesh.count).toBe(5);
    expect(renderer.hpFillInstancedMesh.count).toBe(5);

    // Weapon FX pools must be active after turrets fire
    const totalActiveFx =
      renderer.fxCounts.activeTracers +
      renderer.fxCounts.activeMortarShells +
      renderer.fxCounts.activeCryoSegments +
      renderer.fxCounts.activeRailBeams;
    expect(totalActiveFx).toBeGreaterThan(0);

    // Verify cryo-slowed enemy exhibits cyan frost ring and frost tint
    const slowedSimEnemy = stepRes.state.enemies.find(
      (e) => e.slowFactor > 0 && e.slowRemainingSec > 0,
    );
    expect(slowedSimEnemy).toBeDefined();
    if (slowedSimEnemy) {
      const slowedBlockout = renderer.enemies.get(slowedSimEnemy.id);
      expect(slowedBlockout?.isCryoSlowed).toBe(true);
      expect(slowedBlockout?.frostRingMesh.visible).toBe(true);
    }

    // Drive Apex Broodlord Boss below 50% HP via a live Rail Sniper hit to trigger Phase-2 molten armor-crack transition
    const bossId = spawnedIds['apex-broodlord'] ?? '';
    const bossEntity = sim.getEnemy(bossId);
    expect(bossEntity).toBeDefined();
    if (!bossEntity) return;
    expect(bossEntity.isBoss).toBe(true);
    expect(bossEntity.isBossPhase2).toBe(false);

    // Put boss just above the 50% threshold and step until Rail Sniper ('strongest' priority) strikes it
    bossEntity.hp = ENEMIES['apex-broodlord'].maxHp * 0.5 + 5;
    const railInterval = getTurretTierStats('rail-sniper', 'T1').fireIntervalSec;
    const bossTick = sim.runTicks(Math.ceil(railInterval / SIM_FIXED_DT) + 1);
    renderer.syncFromSim(bossTick.state, bossTick.events, 1 / 60);

    const bossBlockout = renderer.enemies.get(bossId);
    expect(bossBlockout).toBeDefined();
    if (!bossBlockout) return;
    expect(bossBlockout.isBossPhase2).toBe(true);
    expect(bossBlockout.crackMaterial?.opacity).toBeGreaterThan(0.9);
    expect(bossBlockout.accentMaterial.emissiveIntensity).toBeGreaterThanOrEqual(1.9);

    // Dispose cleanly and verify scene cleanup
    renderer.dispose();
    expect(renderer.turrets.size).toBe(0);
    expect(renderer.enemies.size).toBe(0);
    expect(renderer.portals.size).toBe(0);
    expect(scene.getObjectByName('rift-bastion-blockouts-root')).toBeUndefined();
  });

  it('orients a ceiling crawler along its exit heading and keeps flyers upright on frame one', () => {
    const sim = createCombatSimulation({
      seed: 42,
      portalAnchors: [
        {
          id: 'ceiling-rift',
          position: { x: -1.2, y: 2.8, z: -0.7 },
          normal: { x: 0, y: -1, z: 0 },
          hostKind: 'ceiling',
        },
      ],
    });
    const ceiling = sim.debugSpawnEnemy('carapace-brute');
    const flyer = sim.debugSpawnEnemy('wasp-skimmer');
    const portalNormal = { x: 0, y: -1, z: 0 };
    ceiling.normal = portalNormal;
    ceiling.tangent = portalNormal;
    flyer.normal = portalNormal;
    flyer.tangent = portalNormal;
    const exit = ceiling.path.waypoints.find(
      ({ tangent }) => Math.hypot(tangent.x, tangent.z) > 0.001,
    );
    expect(exit).toBeDefined();

    const scene = new THREE.Scene();
    const renderer = createBlockoutRenderer(scene);
    renderer.syncFromSim(sim.getState(), [], 0);
    const ceilingRotation = renderer.enemies.get(ceiling.id)?.group.quaternion;
    const flyerRotation = renderer.enemies.get(flyer.id)?.group.quaternion;
    expect(ceilingRotation).toBeDefined();
    expect(flyerRotation).toBeDefined();
    if (!ceilingRotation || !flyerRotation || !exit) return;

    const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(ceilingRotation);
    const exitHeading = new THREE.Vector3(exit.tangent.x, 0, exit.tangent.z).normalize();
    expect(facing.dot(exitHeading)).toBeGreaterThan(0.99);
    expect(new THREE.Vector3(0, 1, 0).applyQuaternion(ceilingRotation).y).toBeLessThan(-0.99);
    expect(new THREE.Vector3(0, 1, 0).applyQuaternion(flyerRotation).y).toBeGreaterThan(0.99);
    renderer.dispose();
  });

  it('expands and fades a spherical Plasma Mortar blast centered on an airborne impact', () => {
    const scene = new THREE.Scene();
    const renderer = createBlockoutRenderer(scene);
    const snapshot = createCombatSimulation({ seed: 7 }).getState();
    const position = new THREE.Vector3(0.2, 1.4, -0.7);

    renderer.syncFromSim(
      snapshot,
      [
        {
          type: 'projectile-impact',
          tick: 1,
          timeSec: 0.016,
          projectileId: 'plasma-shell',
          turretId: 'mortar',
          turretKind: 'plasma-mortar',
          damageType: 'plasma',
          position,
          aoeRadiusM: 0.65,
          hitEnemyIds: [],
        },
      ],
      0.05,
    );
    const blastMesh = renderer.vfx.group.getObjectByName(
      'vfx-instanced-blast-spheres',
    ) as THREE.InstancedMesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
    expect(blastMesh.geometry).toBeInstanceOf(THREE.SphereGeometry);
    expect(blastMesh.material.color.getHex()).toBe(0xffffff);
    expect(blastMesh.material.depthWrite).toBe(false);
    expect(renderer.fxCounts.activeBlastSpheres).toBe(1);
    expect(renderer.vfx.stats.activeRings).toBe(0);

    const matrix = new THREE.Matrix4();
    blastMesh.getMatrixAt(0, matrix);
    const scale = new THREE.Vector3().setFromMatrixScale(matrix);
    expect(scale.x).toBeCloseTo(scale.y);
    expect(scale.x).toBeCloseTo(scale.z);
    expect(new THREE.Vector3().setFromMatrixPosition(matrix).distanceTo(position)).toBeLessThan(
      1e-6,
    );

    const opacity = blastMesh.geometry.getAttribute('aBlastOpacity');
    const startOpacity = opacity.getX(0);
    renderer.syncFromSim(snapshot, [], 0.1);
    blastMesh.getMatrixAt(0, matrix);

    expect(new THREE.Vector3().setFromMatrixScale(matrix).x).toBeGreaterThan(scale.x);
    expect(opacity.getX(0)).toBeLessThan(startOpacity);
    for (let frame = 0; frame < 4; frame += 1) renderer.syncFromSim(snapshot, [], 0.1);
    expect(blastMesh.count).toBe(0);
    renderer.dispose();
  });

  it('keeps HP bar fill above background, billboards HP bars toward camera and hides closed portal vortex rings', () => {
    const scene = new THREE.Scene();
    const renderer = createBlockoutRenderer(scene);
    const sim = createCombatSimulation({ seed: 7 });
    const enemy = sim.debugSpawnEnemy('rift-disruptor', {
      position: { x: 0.5, y: 1.0, z: -0.5 },
      hp: 100,
    });

    const cam = new THREE.PerspectiveCamera();
    cam.position.set(2, 1.5, 0);
    cam.lookAt(0, 1.0, 0);
    cam.updateMatrixWorld(true);

    renderer.syncFromSim(
      sim.getState(),
      [
        {
          type: 'enemy-hit',
          tick: 1,
          timeSec: 0.016,
          enemyId: enemy.id,
          archetypeId: 'rift-disruptor',
          turretId: null,
          damageType: 'kinetic',
          damage: 10,
          remainingHp: 90,
          maxHp: 100,
          position: enemy.position,
          isDot: false,
          isSplash: false,
          isChain: false,
          isPiercing: false,
        },
      ],
      0.016,
      cam,
    );

    // HP fill renders in transparent pass strictly after HP bg
    expect((renderer.hpFillInstancedMesh.material as THREE.MeshBasicMaterial).transparent).toBe(
      true,
    );
    expect(renderer.hpFillInstancedMesh.renderOrder).toBeGreaterThan(
      renderer.hpBgInstancedMesh.renderOrder,
    );

    // HP bar matrix adopts camera orientation (not identity) when camera is rotated
    const hpMat = new THREE.Matrix4();
    const hpPos = new THREE.Vector3();
    const hpQuat = new THREE.Quaternion();
    const hpScale = new THREE.Vector3();
    renderer.hpBgInstancedMesh.getMatrixAt(0, hpMat);
    hpMat.decompose(hpPos, hpQuat, hpScale);
    const camQuat = new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld);
    expect(Math.abs(hpQuat.dot(camQuat))).toBeCloseTo(1, 4);
    cam.position.copy(hpPos).add(new THREE.Vector3(0, 0, 0.2));
    renderer.syncFromSim(sim.getState(), [], 0, cam);
    expect(renderer.hpBgInstancedMesh.count).toBe(0);
    expect(renderer.hpFillInstancedMesh.count).toBe(0);

    // Enemy hit flash applies emissive response
    const enemyBlockout = renderer.enemies.get(enemy.id);
    expect(enemyBlockout?.primaryMaterial.emissiveIntensity).toBeGreaterThan(0);

    // Closed portals hide both interiorMesh and vortexRingMesh
    for (const portal of renderer.portals.values()) {
      expect(portal.vortexRingMesh.visible).toBe(portal.isOpen);
    }

    renderer.dispose();
  });
});

describe('P2-T5: ThreatChevrons (Off-FOV Angular Projection & Portal/Core Threat Filtering)', () => {
  const viewer = {
    position: { x: 0, y: 1.2, z: 1.5 },
    yaw: 0, // Facing -Z (0, 0, -1)
  };
  const corePosition = { x: 0, y: 0.78, z: 0 };

  it('projects in-FOV vs off-FOV left/right/behind/above threats with exact edge angles', () => {
    // 1. Dead ahead in FOV (-Z)
    const ahead = projectThreatDirection(viewer, { x: 0, y: 1.2, z: -1.5 });
    expect(ahead.offFov).toBe(false);
    expect(ahead.azimuthRad).toBeCloseTo(0, 4);

    // 2. Off-FOV 90 deg to the right (+X)
    const right = projectThreatDirection(viewer, { x: 2.5, y: 1.2, z: 1.5 });
    expect(right.offFov).toBe(true);
    expect(right.azimuthRad).toBeCloseTo(Math.PI / 2, 3);
    expect(right.edgeAngleRad).toBeCloseTo(0, 3);
    expect(right.edgeNdcX).toBeCloseTo(1, 3);

    // 3. Off-FOV 90 deg to the left (-X)
    const left = projectThreatDirection(viewer, { x: -2.5, y: 1.2, z: 1.5 });
    expect(left.offFov).toBe(true);
    expect(left.azimuthRad).toBeCloseTo(-Math.PI / 2, 3);
    expect(Math.abs(left.edgeAngleRad)).toBeCloseTo(Math.PI, 3);
    expect(left.edgeNdcX).toBeCloseTo(-1, 3);

    // 4. Directly above (+Y ceiling portal)
    const above = projectThreatDirection(viewer, { x: 0, y: 3.5, z: 1.5 });
    expect(above.offFov).toBe(true);
    expect(above.edgeAngleRad).toBeCloseTo(Math.PI / 2, 3);
    expect(above.edgeNdcY).toBeCloseTo(1, 3);
  });

  it('filters enemies strictly by <= 1.8 m Core distance and off-FOV cone, plus 4.0 s portal-opened alerts', () => {
    const indicators = evaluateThreatIndicators({
      viewer,
      corePosition,
      enemies: [
        // Inside 1.8 m of Core AND off-FOV (to the right at x = 1.4, z = 1.0 -> dist to Core ~1.73 m <= 1.8 m)
        {
          id: 'enemy-near-offfov',
          archetypeId: 'skitter-crawler',
          position: { x: 1.4, y: 0.78, z: 1.0 },
          hp: 80,
          isBoss: false,
        },
        // Inside 1.8 m of Core BUT directly in front of viewer (in FOV) -> should NOT show chevron
        {
          id: 'enemy-near-infov',
          archetypeId: 'skitter-crawler',
          position: { x: 0, y: 1.0, z: 0 },
          hp: 80,
          isBoss: false,
        },
        // Off-FOV BUT > 1.8 m from Core (x = 2.4 -> dist 2.4 m > 1.8 m) -> should NOT show chevron
        {
          id: 'enemy-far-offfov',
          archetypeId: 'carapace-brute',
          position: { x: 2.4, y: 0.78, z: 0 },
          hp: 440,
          isBoss: false,
        },
      ],
      portalAlerts: [
        {
          portalId: 'portal-west',
          position: { x: -2.4, y: 1.4, z: 1.2 },
          waveNumber: 3,
          remainingSec: 3.2,
        },
      ],
    });

    expect(NEAR_CORE_THREAT_RADIUS_M).toBe(1.8);
    expect(indicators.map((d) => d.sourceId)).toEqual(['enemy-near-offfov', 'portal-west']);
    expect(indicators[0]?.kind).toBe('near-core');
    expect(indicators[0]?.distanceToCoreM).toBeLessThanOrEqual(1.8);
    expect(indicators[1]?.kind).toBe('portal-opened');

    // Verify stateful ThreatChevrons DOM & XR ring update and 4.0 s portal alert expiry
    const container = document.createElement('div');
    const chevrons = createThreatChevrons({ container, initialMode: 'desktop' });

    const camera = new THREE.PerspectiveCamera(65, 16 / 9, 0.05, 50);
    camera.position.set(0, 1.2, 1.5);
    camera.lookAt(0, 1.2, -1);
    camera.updateMatrixWorld(true);

    chevrons.update({
      snapshot: {
        corePosition,
        enemies: [],
      },
      events: [
        {
          type: 'portal-opened',
          tick: 1,
          timeSec: 0.016,
          portalId: 'portal-east',
          portalIndex: 3,
          position: { x: 2.4, y: 1.4, z: 1.2 },
          normal: { x: -1, y: 0, z: 0 },
          waveNumber: 2,
        },
      ],
      dt: 0.1,
      camera,
    });

    expect(chevrons.activeThreats.length).toBe(1);
    expect(chevrons.activeThreats[0]?.sourceId).toBe('portal-east');
    const activeDomBadge = container.querySelector('[data-source-id="portal-east"]') as HTMLElement;
    expect(activeDomBadge).not.toBeNull();
    expect(activeDomBadge.hidden).toBe(false);

    // Advance past the 4.0 s portal alert window and verify automatic expiry
    chevrons.update({
      snapshot: { corePosition, enemies: [] },
      dt: PORTAL_THREAT_ALERT_DURATION_SEC + 0.2,
      camera,
    });
    expect(chevrons.activeThreats.length).toBe(0);

    chevrons.dispose();
  });
});

describe('P2-T5: MissionOverlay (IndexedDB Recording, Stars, New Best Badge & JSON Backup)', () => {
  it('records completed mission runs to IndexedDB, computes 1–3 stars, shows NEW BEST badge, and exports/imports backup JSON', async () => {
    const container = document.createElement('div');
    const persistStore = createPersistStore({
      dbName: `test-mission-overlay-${Date.now()}-${Math.random()}`,
    });
    await persistStore.init();

    const bus = createActionBus();
    const settingsStore = createSettingsStore();
    const overlay = createMissionOverlay({
      persistStore,
      actionBus: bus,
      settingsStore,
      container,
      initialMode: 'desktop',
    });

    // 1. Present a 2-star Victory run (75% Core HP -> 2 stars)
    const firstState = await overlay.presentResult({
      victory: true,
      score: 4200,
      wavesCleared: 12,
      totalWaves: 12,
      remainingCoreHp: 75,
      maxCoreHp: 100,
      seed: 1234,
      runKey: 'run-1',
    });

    expect(firstState.open).toBe(true);
    expect(firstState.victory).toBe(true);
    expect(firstState.stars).toBe(2);
    expect(firstState.isNewBest).toBe(true);
    expect(firstState.records.bestScore).toBe(4200);
    expect(firstState.records.bestStars).toBe(2);
    expect(firstState.records.totalRuns).toBe(1);

    const newBestEl = container.querySelector('[data-mission="new-best"]') as HTMLElement;
    const starsEl = container.querySelector('[data-mission="stars"]') as HTMLElement;
    const scoreEl = container.querySelector('[data-mission="score"]') as HTMLElement;
    expect(newBestEl.hidden).toBe(false);
    expect(starsEl.textContent).toContain('★ ★ ☆');
    expect(scoreEl.textContent).toBe('4200');

    // 2. Present a lower-score Defeat run (0 stars, not a new best)
    const secondState = await overlay.presentResult({
      victory: false,
      score: 1800,
      wavesCleared: 6,
      totalWaves: 12,
      remainingCoreHp: 0,
      maxCoreHp: 100,
      seed: 1235,
      runKey: 'run-2',
    });

    expect(secondState.victory).toBe(false);
    expect(secondState.stars).toBe(0);
    expect(secondState.isNewBest).toBe(false);
    expect(secondState.records.bestScore).toBe(4200);
    expect(secondState.records.bestStars).toBe(2);
    expect(secondState.records.totalRuns).toBe(2);
    expect(newBestEl.hidden).toBe(true);

    // 3. Present a 3-star Victory run (95% Core HP -> 3 stars, NEW BEST!)
    const thirdState = await overlay.presentResult({
      victory: true,
      score: 6850,
      wavesCleared: 12,
      totalWaves: 12,
      remainingCoreHp: 95,
      maxCoreHp: 100,
      seed: 1236,
      runKey: 'run-3',
    });

    expect(thirdState.stars).toBe(3);
    expect(thirdState.isNewBest).toBe(true);
    expect(thirdState.isNewBestStars).toBe(true);
    expect(thirdState.isNewBestScore).toBe(true);
    expect(thirdState.records.bestScore).toBe(6850);
    expect(thirdState.records.bestStars).toBe(3);
    expect(starsEl.textContent).toContain('★ ★ ★');
    expect(newBestEl.hidden).toBe(false);

    // 4. Export backup JSON, clear records, and re-import backup JSON
    const exportedJson = await overlay.exportBackup();
    expect(exportedJson).toContain('"bestScore": 6850');

    await persistStore.clearMissionRecords();
    const cleared = await persistStore.loadMissionRecords();
    expect(cleared.bestScore).toBe(0);

    // Reject corrupt JSON without clobbering state
    await expect(overlay.importBackup('{corrupt')).rejects.toThrow();
    expect(overlay.state.backupError).toBe(true);

    // Import valid backup JSON
    const imported = await overlay.importBackup(exportedJson);
    expect(imported.missionRecords.bestScore).toBe(6850);
    expect(imported.missionRecords.bestStars).toBe(3);
    expect(overlay.state.backupError).toBe(false);

    overlay.dispose();
    persistStore.close();
  });
});
