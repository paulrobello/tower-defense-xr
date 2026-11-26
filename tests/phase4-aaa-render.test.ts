import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { applyRoomPbrMaterials, createTestRoom } from '../src/desktop/bootstrap.ts';
import { buildRoomSurfaceFromLocalPolygon, makeSurfaceBasisMatrix } from '../src/mr/room-scan.ts';
import type {
  RuntimeAssetLibrary,
  RuntimeAssetManifest,
  SharedPbrMaterialId,
} from '../src/render/asset-loader.ts';
import { createBlockoutRenderer } from '../src/render/blockouts.ts';
import { createLightingController, MAX_TRANSIENT_POINT_LIGHTS } from '../src/render/lighting.ts';
import {
  createRiftPortalShaderMaterial,
  type RiftPortalShaderUniforms,
} from '../src/render/portal-shader.ts';
import { createCombatVfxPool, MAX_TOTAL_VFX_CAP, MAX_VFX_SPARKS } from '../src/render/vfx-pool.ts';
import { createCombatSimulation } from '../src/sim/engine.ts';
import {
  createTurretGhostPreview,
  GHOST_COLOR_HOVER_VALID,
  GHOST_COLOR_INVALID,
} from '../src/xr/placement.ts';

const ROOT = resolve(import.meta.dirname, '..');

describe('Phase 4 AAA Runtime Pipeline (P4-T1, P4-T2, P4-T3)', () => {
  it('promotes all 40 animated GLBs and UI assets into public/assets with verified SHA-256 hashes', () => {
    const manifestPath = resolve(ROOT, 'public/assets/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RuntimeAssetManifest;
    expect(manifest.version).toBe(1);
    expect(manifest.models.length).toBe(40);

    for (const entry of manifest.models) {
      expect(entry.animations.length).toBeGreaterThanOrEqual(3);
      const diskPath = resolve(ROOT, 'public', entry.path.replace(/^\//, ''));
      const buf = readFileSync(diskPath);
      expect(buf.byteLength).toBe(entry.bytes);
      const actualSha = createHash('sha256').update(buf).digest('hex');
      expect(actualSha).toBe(entry.sha256);
    }

    for (const extra of Object.values(manifest.extras)) {
      const diskPath = resolve(ROOT, 'public', extra.path.replace(/^\//, ''));
      const buf = readFileSync(diskPath);
      expect(buf.byteLength).toBe(extra.bytes);
      const actualSha = createHash('sha256').update(buf).digest('hex');
      expect(actualSha).toBe(extra.sha256);
    }

    // All 5 shared PBR KTX2 materials promoted
    expect(manifest.materials?.length).toBe(5);
    const matIds = new Set(manifest.materials?.map((m) => m.id));
    expect(matIds).toEqual(
      new Set([
        'brushed-titanium',
        'tactical-ceramic',
        'dark-gunmetal',
        'obsidian-chitin',
        'rift-obsidian',
      ]),
    );
    for (const mat of manifest.materials ?? []) {
      for (const path of [mat.basecolor, mat.normal, mat.orm, mat.emissive].filter(Boolean)) {
        const diskPath = resolve(ROOT, 'public', (path as string).replace(/^\//, ''));
        expect(readFileSync(diskPath).byteLength).toBeGreaterThan(0);
      }
    }
  });

  it('creates uniform-driven Dimensional Rift Portal GLSL shader without runtime defines', () => {
    const mat = createRiftPortalShaderMaterial({ initialOpen: 0.5 });
    const uniforms = mat.uniforms as RiftPortalShaderUniforms;
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
    expect(uniforms.uOpen.value).toBe(0.5);
    expect(uniforms.uSurge.value).toBe(0);
    expect(uniforms.uTime.value).toBe(0);
    expect(uniforms.uHasVortexMap.value).toBe(0);
    expect(mat.vertexShader).toContain('#include <project_vertex>');
    expect(mat.fragmentShader).toContain('// RB_PORTAL_ALPHA_HOOK');
    mat.dispose();
  });

  it('enforces <= 2,500 active VFX cap and <= 12 extra draw calls with zero leaks on dispose', () => {
    const scene = new THREE.Scene();
    const vfx = createCombatVfxPool(scene);
    expect(MAX_TOTAL_VFX_CAP).toBeLessThanOrEqual(2500);
    expect(vfx.drawCallCount).toBeLessThanOrEqual(12);

    // Over-spawn beyond ring buffer size to verify strict cap enforcement
    for (let i = 0; i < 400; i += 1) {
      vfx.spawnPlasmaExplosion({ x: i * 0.01, y: 0, z: 0 }, 0.8);
      vfx.spawnRailRings({ x: 0, y: 1, z: 0 }, { x: 2, y: 1, z: 0 });
      vfx.spawnShellCasing({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 });
    }
    vfx.tick(0.016);
    expect(vfx.stats.activeSparks).toBeLessThanOrEqual(MAX_VFX_SPARKS);
    expect(vfx.stats.totalActive).toBeGreaterThan(0);
    expect(vfx.stats.totalActive).toBeLessThanOrEqual(2500);

    // Advance past all lifetimes so pools drain cleanly to 0
    for (let i = 0; i < 60; i += 1) {
      vfx.tick(0.1);
    }
    expect(vfx.stats.totalActive).toBe(0);
    vfx.dispose();
  });

  it('bounds transient combat point lights to <= 2 and decays intensity cleanly', () => {
    const scene = new THREE.Scene();
    const lighting = createLightingController(scene, null);
    expect(MAX_TRANSIENT_POINT_LIGHTS).toBe(2);

    lighting.flashPoint({ x: 1, y: 0.5, z: -1 }, 0xff5722, 5.0, 3.5, 0.3);
    lighting.flashPoint({ x: -1, y: 0.5, z: 1 }, 0x38bdf8, 4.0, 3.0, 0.3);
    lighting.flashPoint({ x: 0, y: 0.5, z: 0 }, 0xff4d00, 6.0, 4.0, 0.3);

    const transientLights = lighting.group.children.filter(
      (c): c is THREE.PointLight =>
        c instanceof THREE.PointLight && c.name.startsWith('aaa-transient-point-light-'),
    );
    expect(transientLights.length).toBe(2);
    expect(transientLights.some((l) => l.intensity > 0)).toBe(true);

    lighting.update(0.5);
    expect(transientLights.every((l) => l.intensity === 0)).toBe(true);
    lighting.dispose();
  });

  it('lights the tracked wall polygon near a flash and fades quickly', () => {
    const scene = new THREE.Scene();
    const lighting = createLightingController(scene);
    const wall = buildRoomSurfaceFromLocalPolygon({
      id: 'scan-wall',
      source: 'plane',
      semanticLabel: 'wall',
      revision: 1,
      lastChangedTime: 1,
      worldMatrix: makeSurfaceBasisMatrix(
        new THREE.Vector3(0, 1.1, -2),
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(1, 0, 0),
      ),
      localPolygon: [
        { x: -1, z: -1 },
        { x: 1, z: -1 },
        { x: 1, z: 0 },
        { x: 0, z: 0 },
        { x: 0, z: 1 },
        { x: -1, z: 1 },
      ],
    });
    lighting.syncRoomSurfaces([wall]);
    const flashes = lighting.group.children.filter(
      (node): node is THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> =>
        node instanceof THREE.Mesh && node.name.startsWith('aaa-mr-wall-flash-'),
    );
    lighting.flashPoint({ x: 0, y: 1, z: 2 }, 0xff5722, 4.8, 3.6, 0.35);
    expect(flashes.every((flash) => !flash.visible)).toBe(true);

    lighting.flashPoint({ x: -0.4, y: 1, z: -1.6 }, 0xff5722, 4.8, 3.6, 0.35);
    const active = flashes.find((flash) => flash.visible);
    if (!active) throw new Error('Expected the nearby wall to receive a flash');
    expect(active.geometry.getAttribute('position').count).toBe(wall.localPolygon.length);
    expect(active.geometry.index?.count).toBe(12);
    expect(active.material.depthTest).toBe(true);
    expect(active.material.depthWrite).toBe(false);
    expect(active.material.blending).toBe(THREE.AdditiveBlending);
    const peak = Number(active.material.uniforms.uOpacity.value);
    lighting.update(0.15);
    expect(Number(active.material.uniforms.uOpacity.value)).toBeLessThan(peak);
    expect(active.visible).toBe(true);
    lighting.syncRoomSurfaces([]);
    expect(active.visible).toBe(false);
    lighting.dispose();
  });

  it('applies all 5 shared PBR materials to the Desktop Command Room and upgrades placement ghost to GLB holograms', () => {
    const sharedMats = new Map<SharedPbrMaterialId, THREE.MeshStandardMaterial>([
      ['brushed-titanium', new THREE.MeshStandardMaterial({ name: 'pbr-brushed-titanium' })],
      ['tactical-ceramic', new THREE.MeshStandardMaterial({ name: 'pbr-tactical-ceramic' })],
      ['dark-gunmetal', new THREE.MeshStandardMaterial({ name: 'pbr-dark-gunmetal' })],
      ['obsidian-chitin', new THREE.MeshStandardMaterial({ name: 'pbr-obsidian-chitin' })],
      ['rift-obsidian', new THREE.MeshStandardMaterial({ name: 'pbr-rift-obsidian' })],
    ]);

    const fakeAssets: RuntimeAssetLibrary = {
      manifest: null,
      progress: { loaded: 40, total: 40, ready: true, precompiled: true },
      ready: true,
      broodlordPhase2Emissive: null,
      loadAll: async () => true,
      hasModel: () => true,
      hasSharedMaterial: (id) => sharedMats.has(id),
      getSharedMaterial: (id) => sharedMats.get(id) ?? null,
      instantiate: (id) => {
        const root = new THREE.Group();
        root.name = `mock-${id}`;
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.1, 0.1, 0.1),
          new THREE.MeshStandardMaterial(),
        );
        root.add(mesh);
        return { root, animations: [], isSkinned: false };
      },
      precompile: async () => undefined,
      subscribe: () => () => undefined,
      dispose: () => undefined,
    };

    const { room } = createTestRoom();
    const applied = applyRoomPbrMaterials(room, fakeAssets);
    expect(applied).toBeGreaterThanOrEqual(15);

    const ghost = createTurretGhostPreview({ assets: fakeAssets });
    ghost.update({
      kind: 'rail-sniper',
      tier: 'T1',
      visible: true,
      validation: {
        valid: true,
        reason: null,
        reasons: [],
        reasonLabel: null,
        mountProfile: 'hover-pod',
        surfaceId: null,
        surfaceKind: null,
        cost: 160,
        activeTurretCount: 0,
        hardTurretCap: 14,
        distanceM: 1.5,
        nearestTurretDistanceM: null,
        coreDistanceM: 1.2,
        nearestPortalDistanceM: 2.0,
        footprint: null,
        pose: {
          mountProfile: 'hover-pod',
          position: { x: 0, y: 1.2, z: -1 },
          normal: { x: 0, y: 1, z: 0 },
          right: { x: 1, y: 0, z: 0 },
          up: { x: 0, y: 1, z: 0 },
          forward: { x: 0, y: 0, z: 1 },
          quaternion: { x: 0, y: 0, z: 0, w: 1 },
        },
      },
    });
    expect(ghost.clampMountGroup.getObjectByName('turret-ghost-glb-clamp')).toBeDefined();
    expect(ghost.hoverPodGroup.getObjectByName('turret-ghost-glb-hover')).toBeDefined();
    expect(
      ghost.turretBodyGroup.getObjectByName('turret-ghost-glb-valkyrie-rail-sniper-t1'),
    ).toBeDefined();
    expect(ghost.state.colorHex).toBe(GHOST_COLOR_HOVER_VALID);

    ghost.update({
      kind: 'rail-sniper',
      tier: 'T1',
      validation: {
        valid: false,
        reason: 'TOO_CLOSE',
        reasons: ['TOO_CLOSE'],
        reasonLabel: 'TOO CLOSE',
        mountProfile: 'surface-clamp',
        surfaceId: null,
        surfaceKind: null,
        cost: 160,
        activeTurretCount: 1,
        hardTurretCap: 14,
        distanceM: 1.5,
        nearestTurretDistanceM: 0.2,
        coreDistanceM: 1.2,
        nearestPortalDistanceM: 2.0,
        footprint: null,
        pose: {
          mountProfile: 'surface-clamp',
          position: { x: 0, y: 0.8, z: -1 },
          normal: { x: 0, y: 1, z: 0 },
          right: { x: 1, y: 0, z: 0 },
          up: { x: 0, y: 1, z: 0 },
          forward: { x: 0, y: 0, z: 1 },
          quaternion: { x: 0, y: 0, z: 0, w: 1 },
        },
      },
    });
    expect(ghost.state.colorHex).toBe(GHOST_COLOR_INVALID);

    ghost.dispose();
    for (const m of sharedMats.values()) m.dispose();
  });

  it('compensates Helios mortar 35-deg rest ascent and anchors Cryo-Arc beams to the GLB muzzleSocket', () => {
    const buildMockTurretGlb = (muzzleLocal: [number, number, number]): THREE.Group => {
      const root = new THREE.Group();
      const yawRing = new THREE.Group();
      yawRing.name = 'yawRing';
      yawRing.position.set(0, 0.085, 0);
      const pitchCradle = new THREE.Group();
      pitchCradle.name = 'pitchCradle';
      pitchCradle.position.set(0, 0.09, 0);
      const recoilGroup = new THREE.Group();
      recoilGroup.name = 'recoilGroup';
      const muzzleSocket = new THREE.Object3D();
      muzzleSocket.name = 'muzzleSocket';
      muzzleSocket.position.set(muzzleLocal[0], muzzleLocal[1], muzzleLocal[2]);
      recoilGroup.add(muzzleSocket);
      pitchCradle.add(recoilGroup);
      yawRing.add(pitchCradle);
      root.add(yawRing);
      return root;
    };

    const fakeAssets: RuntimeAssetLibrary = {
      manifest: null,
      progress: { loaded: 40, total: 40, ready: true, precompiled: true },
      ready: true,
      broodlordPhase2Emissive: null,
      loadAll: async () => true,
      hasModel: () => true,
      hasSharedMaterial: () => false,
      getSharedMaterial: () => null,
      instantiate: (id) => {
        if (id.startsWith('glacier-cryo-arc')) {
          return { root: buildMockTurretGlb([0, 0.065, 0.14]), animations: [], isSkinned: false };
        }
        if (id.startsWith('helios-plasma-mortar')) {
          return { root: buildMockTurretGlb([0, 0.08, 0.16]), animations: [], isSkinned: false };
        }
        return { root: new THREE.Group(), animations: [], isSkinned: false };
      },
      precompile: async () => undefined,
      subscribe: () => () => undefined,
      dispose: () => undefined,
    };

    const scene = new THREE.Scene();
    const renderer = createBlockoutRenderer(scene, null, { assets: fakeAssets });
    const sim = createCombatSimulation({ seed: 77, startingCredits: 1000 });

    const mortar = sim.placeTurret({
      kind: 'plasma-mortar',
      position: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
      mountProfile: 'surface-clamp',
      surfaceKind: 'floor',
    }).turret;
    const cryo = sim.placeTurret({
      kind: 'cryo-arc',
      position: { x: 0.8, y: 0, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
      mountProfile: 'surface-clamp',
      surfaceKind: 'floor',
    }).turret;
    if (!mortar || !cryo) throw new Error('Expected mortar and cryo turrets');

    sim.debugSpawnEnemy('carapace-brute', {
      position: { x: 0.8, y: 0.24, z: -1.4 },
      hp: 2000,
    });
    const { state, events } = sim.tick();
    renderer.syncFromSim(state, events, 1 / 60);

    // 1. Helios mortar GLB pitchCradle subtracts the baked 35-deg rest ascent
    const mortarBlockout = renderer.turrets.get(mortar.id);
    const mortarCradle = mortarBlockout?.group.getObjectByName('pitchCradle');
    expect(mortarCradle).toBeDefined();
    const expectedGlbPitch = THREE.MathUtils.clamp(
      mortar.pitch - (35 * Math.PI) / 180,
      -0.55,
      0.85,
    );
    expect(mortarCradle?.rotation.x).toBeCloseTo(-expectedGlbPitch, 4);

    // 2. Cryo-Arc beam first segment starts from the GLB muzzleSocket world position (not old blockout reach)
    const cryoBlockout = renderer.turrets.get(cryo.id);
    const cryoSocket = cryoBlockout?.group.getObjectByName('muzzleSocket');
    expect(cryoSocket).toBeDefined();
    // Reset recoil offset to inspect unfired nozzle tip where the beam was spawned
    const cryoRecoil = cryoBlockout?.group.getObjectByName('recoilGroup');
    if (cryoRecoil) cryoRecoil.position.z = 0;
    cryoBlockout?.group.updateWorldMatrix(true, true);
    const expectedMuzzle = new THREE.Vector3();
    cryoSocket?.getWorldPosition(expectedMuzzle);

    expect(renderer.cryoArcInstancedMesh.count).toBeGreaterThanOrEqual(3);
    const segMat = new THREE.Matrix4();
    renderer.cryoArcInstancedMesh.getMatrixAt(0, segMat);
    const segCenter = new THREE.Vector3();
    const segQuat = new THREE.Quaternion();
    const segScale = new THREE.Vector3();
    segMat.decompose(segCenter, segQuat, segScale);
    const segAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(segQuat);
    const segStart = segCenter.clone().addScaledVector(segAxis, -segScale.y * 0.5);
    expect(segStart.distanceTo(expectedMuzzle)).toBeLessThan(0.01);

    renderer.dispose();
  });
});
