/**
 * High-Readability Dimension-Locked Tactical Sci-Fi Blockout Renderer (`src/render/blockouts.ts`).
 *
 * Implements `PRD.md` §D1, §D2, §D5, §D7, §D8, §Quest 3 Budgets and
 * `plans/phase-2-combat-simulation-and-waves.md` (P2-T5):
 *
 * 1. **Core Bastion (`CORE_BASTION_SPEC`):**
 *    - Armored hexagonal/octagonal pedestal (`radiusM = 0.38`, `heightM = 0.72`), pulsing
 *      violet-cyan energy core, rotating containment rings, and translucent shield dome/ring
 *      (`shieldDomeRadiusM = 0.52`) flaring on `core-hit` events.
 * 2. **Rift Portals (`RIFT_PORTAL_SPEC`):**
 *    - Beveled titanium frame (`apertureWidthM = 0.95`, `apertureHeightM = 1.35`,
 *      `rimThicknessM = 0.12`) + glowing violet/teal interior plane using
 *      `configurePortalRimMaterial`, `configurePortalInteriorMaterial`, and
 *      `createPortalApertureMaskMesh` from `src/mr/occlusion.ts`.
 * 3. **4 Turrets × 3 Tiers (`autocannon`, `plasma-mortar`, `cryo-arc`, `rail-sniper`):**
 *    - Exact meter footprints (`footprintRadiusM = 0.16`) and tier head/barrel dimensions from
 *      `src/content/turrets.ts` so P3 Blender GLBs swap in 1:1.
 *    - Articulated `surface-clamp` 4-leg base vs glowing `hover-pod` repulsor ring.
 *    - Articulated `yawRing` + `pitchCradle` tracking the active simulation target, spring-damped
 *      barrel muzzle recoil on `turret-fired`, and crackling EMP-disrupted spark halo when
 *      `turret.isDisrupted` (`disabledRemainingSec > 0`).
 * 4. **5 Invaders (`skitter-crawler`, `wasp-skimmer`, `carapace-brute`, `rift-disruptor`, `apex-broodlord`):**
 *    - Exact bounding silhouettes from `src/content/enemies.ts`, surface-normal climbing orientation,
 *      cryo-slow cyan frost tint (`slowFactor > 0`), Carapace Brute frontal armor plate, Rift Disruptor
 *      rotating EMP field ring, and Apex Broodlord Boss Phase-2 molten armor-crack emissive shift.
 *    - Pre-allocated GPU-instanced world health bars (`hpBgInstancedMesh` + `hpFillInstancedMesh`).
 * 5. **GPU-Instanced Weapon FX Pools (zero per-frame geometry allocation, <= 6 instanced draw calls):**
 *    - Pooled kinetic tracers, mortar plasma shells + expanding AoE blast rings, cryo-arc jagged
 *      chain-lightning beams, rail sniper piercing beams, and EMP/roar shockwave rings driven by
 *      `SimEvent[]`.
 */

import * as THREE from 'three';
import {
  CORE_BASTION_SPEC,
  ENEMIES,
  type EnemyId,
  getEnemyDefinition,
  getTurretDefinition,
  getTurretTierStats,
  MAX_ACTIVE_ENEMIES,
  RIFT_PORTAL_SPEC,
  TURRET_BARREL_START_FRACTION,
  TURRET_MOUNT_PROFILES,
  type TurretKind,
  type TurretMountProfileId,
  type TurretTierId,
  type Vec3,
} from '../content/index.ts';
import {
  applyDepthOcclusion,
  buildPortalWorldMatrix,
  configurePortalInteriorMaterial,
  configurePortalRimMaterial,
  createPortalApertureMaskMesh,
  type DepthOcclusionBinding,
  type OcclusionController,
  type PortalAperture,
} from '../mr/occlusion.ts';
import type {
  CombatSimulationState,
  SimEnemy,
  SimEvent,
  SimPortalState,
  SimTurret,
} from '../sim/engine.ts';

export const MAX_INSTANCED_TRACERS = 64;
export const MAX_INSTANCED_MORTAR_SHELLS = 32;
export const MAX_INSTANCED_BLAST_RINGS = 24;
export const MAX_INSTANCED_CRYO_SEGMENTS = 64;
export const MAX_INSTANCED_RAIL_BEAMS = 24;
export const MAX_INSTANCED_HP_BARS = MAX_ACTIVE_ENEMIES + 8;

const CRYO_SUBSEGMENTS_PER_LINK = 3;

export interface CoreBastionBlockout {
  readonly group: THREE.Group;
  readonly pedestalMesh: THREE.Mesh;
  readonly energyCoreMesh: THREE.Mesh;
  readonly shieldRingMesh: THREE.Mesh;
  readonly shieldDomeMesh: THREE.Mesh;
  readonly coreMaterial: THREE.MeshStandardMaterial;
  readonly shieldMaterial: THREE.MeshBasicMaterial;
  hitFlashRemainingSec: number;
  lastHp: number;
  maxHp: number;
}

export interface RiftPortalBlockout {
  readonly id: string;
  readonly portalIndex: number;
  readonly group: THREE.Group;
  readonly frameMesh: THREE.Mesh;
  readonly interiorMesh: THREE.Mesh;
  readonly vortexRingMesh: THREE.Mesh;
  readonly apertureMaskMesh: THREE.Mesh | null;
  readonly frameMaterial: THREE.MeshStandardMaterial;
  readonly interiorMaterial: THREE.MeshBasicMaterial;
  isOpen: boolean;
  pulsePhase: number;
  spawnFlashSec: number;
}

export interface TurretBlockout {
  readonly id: string;
  readonly kind: TurretKind;
  tier: TurretTierId;
  mountProfile: TurretMountProfileId;
  readonly group: THREE.Group;
  readonly clampMountGroup: THREE.Group;
  readonly hoverPodGroup: THREE.Group;
  readonly yawRing: THREE.Group;
  readonly pitchCradle: THREE.Group;
  readonly recoilGroup: THREE.Group;
  readonly barrelGroup: THREE.Group;
  readonly headMesh: THREE.Mesh;
  readonly empHaloGroup: THREE.Group;
  readonly bodyMaterial: THREE.MeshStandardMaterial;
  readonly accentMaterial: THREE.MeshStandardMaterial;
  readonly empMaterial: THREE.MeshBasicMaterial;
  recoilOffsetM: number;
  rotarySpinAngle: number;
  isDisrupted: boolean;
  yaw: number;
  pitch: number;
}

export interface EnemyBlockout {
  readonly id: string;
  readonly archetypeId: EnemyId;
  readonly isBoss: boolean;
  readonly group: THREE.Group;
  readonly bodyGroup: THREE.Group;
  readonly primaryMaterial: THREE.MeshStandardMaterial;
  readonly accentMaterial: THREE.MeshStandardMaterial;
  readonly crackMaterial: THREE.MeshBasicMaterial | null;
  readonly frostRingMesh: THREE.Mesh;
  isCryoSlowed: boolean;
  isBossPhase2: boolean;
  slowFactor: number;
  emissiveIntensity: number;
  hitFlashSec: number;
  locomotionPhase: number;
}

export interface WeaponFxCounts {
  readonly activeTracers: number;
  readonly activeMortarShells: number;
  readonly activeBlastRings: number;
  readonly activeCryoSegments: number;
  readonly activeRailBeams: number;
  readonly activeHpBars: number;
}

export interface BlockoutRendererOptions {
  /** Whether to patch blockout materials with WebXR depth-sensing occlusion when `occlusion` is provided (default `true`). */
  readonly enableDepthOcclusion?: boolean;
}

export interface BlockoutRenderer {
  readonly root: THREE.Group;
  readonly coreBastion: CoreBastionBlockout;
  readonly portalsGroup: THREE.Group;
  readonly turretsGroup: THREE.Group;
  readonly enemiesGroup: THREE.Group;
  readonly fxGroup: THREE.Group;
  readonly healthBarsGroup: THREE.Group;
  readonly portals: ReadonlyMap<string, RiftPortalBlockout>;
  readonly turrets: ReadonlyMap<string, TurretBlockout>;
  readonly enemies: ReadonlyMap<string, EnemyBlockout>;
  readonly fxCounts: Readonly<WeaponFxCounts>;
  readonly tracerInstancedMesh: THREE.InstancedMesh;
  readonly mortarShellInstancedMesh: THREE.InstancedMesh;
  readonly blastRingInstancedMesh: THREE.InstancedMesh;
  readonly cryoArcInstancedMesh: THREE.InstancedMesh;
  readonly railBeamInstancedMesh: THREE.InstancedMesh;
  readonly hpBgInstancedMesh: THREE.InstancedMesh;
  readonly hpFillInstancedMesh: THREE.InstancedMesh;
  syncFromSim(
    snapshot: CombatSimulationState,
    events?: readonly SimEvent[],
    dt?: number,
    camera?: THREE.Camera | null,
  ): void;
  dispose(): void;
}

interface ActiveTracerFx {
  from: Vec3;
  to: Vec3;
  elapsedSec: number;
  durationSec: number;
  colorHex: number;
}

interface ActiveBlastRingFx {
  position: Vec3;
  maxRadiusM: number;
  elapsedSec: number;
  durationSec: number;
  colorHex: number;
}

interface ActiveBeamSegmentFx {
  from: Vec3;
  to: Vec3;
  elapsedSec: number;
  durationSec: number;
  thicknessM: number;
  colorHex: number;
}

const _dummyObj = new THREE.Object3D();
const _vecA = new THREE.Vector3();
const _vecB = new THREE.Vector3();
const _vecMid = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _upAxis = new THREE.Vector3(0, 1, 0);
const _zAxis = new THREE.Vector3(0, 0, 1);
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _color = new THREE.Color();

const CRYO_FROST_COLOR = new THREE.Color(0x22d3ee);
const BOSS_PHASE1_EMISSIVE = new THREE.Color(0xec4899);
const BOSS_PHASE2_MOLTEN_EMISSIVE = new THREE.Color(0xff4d00);

function orientSegmentMatrix(
  from: Readonly<Vec3>,
  to: Readonly<Vec3>,
  radiusM: number,
  targetMatrix: THREE.Matrix4,
): number {
  _vecA.set(from.x, from.y, from.z);
  _vecB.set(to.x, to.y, to.z);
  _dir.subVectors(_vecB, _vecA);
  const len = _dir.length();
  if (len < 1e-5) {
    targetMatrix.makeScale(0, 0, 0);
    return 0;
  }
  _dir.divideScalar(len);
  _vecMid.addVectors(_vecA, _vecB).multiplyScalar(0.5);
  _quat.setFromUnitVectors(_upAxis, _dir);
  _scale.set(radiusM, len, radiusM);
  targetMatrix.compose(_vecMid, _quat, _scale);
  return len;
}

/**
 * Creates the dimension-locked tactical sci-fi blockout renderer.
 */
export function createBlockoutRenderer(
  scene: THREE.Scene,
  occlusion?: OcclusionController | null,
  options: BlockoutRendererOptions = {},
): BlockoutRenderer {
  const useDepthOcclusion = (options.enableDepthOcclusion ?? true) && Boolean(occlusion);

  const root = new THREE.Group();
  root.name = 'rift-bastion-blockouts-root';
  scene.add(root);

  const portalsGroup = new THREE.Group();
  portalsGroup.name = 'blockouts-portals';
  const turretsGroup = new THREE.Group();
  turretsGroup.name = 'blockouts-turrets';
  const enemiesGroup = new THREE.Group();
  enemiesGroup.name = 'blockouts-enemies';
  const fxGroup = new THREE.Group();
  fxGroup.name = 'blockouts-weapon-fx';
  const healthBarsGroup = new THREE.Group();
  healthBarsGroup.name = 'blockouts-health-bars';

  const ownedGeometries = new Set<THREE.BufferGeometry>();
  const ownedMaterials = new Set<THREE.Material>();
  const depthBindings = new Set<DepthOcclusionBinding>();
  const entityDisposers = new Map<string, () => void>();

  function trackGeo<T extends THREE.BufferGeometry>(geo: T, bucket?: THREE.BufferGeometry[]): T {
    ownedGeometries.add(geo);
    bucket?.push(geo);
    return geo;
  }

  function trackMat<T extends THREE.Material>(
    mat: T,
    role: 'world-object' | 'portal-rim' | 'portal-interior' | 'none' = 'world-object',
    matBucket?: THREE.Material[],
    bindingBucket?: DepthOcclusionBinding[],
  ): T {
    ownedMaterials.add(mat);
    matBucket?.push(mat);
    if (useDepthOcclusion && occlusion && role !== 'none') {
      const binding =
        role === 'portal-rim'
          ? configurePortalRimMaterial(mat, occlusion)
          : role === 'portal-interior'
            ? configurePortalInteriorMaterial(mat, occlusion)
            : applyDepthOcclusion(mat, occlusion, { role: 'world-object' });
      depthBindings.add(binding);
      bindingBucket?.push(binding);
    }
    return mat;
  }

  function registerEntityCleanup(
    key: string,
    geos: THREE.BufferGeometry[],
    mats: THREE.Material[],
    bindings: DepthOcclusionBinding[],
  ): void {
    entityDisposers.set(key, () => {
      for (const binding of bindings) {
        binding.dispose();
        depthBindings.delete(binding);
      }
      for (const geo of geos) {
        geo.dispose();
        ownedGeometries.delete(geo);
      }
      for (const mat of mats) {
        mat.dispose();
        ownedMaterials.delete(mat);
      }
    });
  }

  function disposeEntityCleanup(key: string): void {
    const fn = entityDisposers.get(key);
    if (fn) {
      fn();
      entityDisposers.delete(key);
    }
  }

  // Shared reusable unit primitives to minimize BufferGeometry allocations
  const sharedBoxGeo = trackGeo(new THREE.BoxGeometry(1, 1, 1));
  const sharedCylGeo = trackGeo(new THREE.CylinderGeometry(1, 1, 1, 16));
  const sharedBarrelGeo = trackGeo(new THREE.CylinderGeometry(1, 1, 1, 12));
  sharedBarrelGeo.rotateX(Math.PI / 2);
  const sharedOctaGeo = trackGeo(new THREE.OctahedronGeometry(1, 0));
  const sharedTorusGeo = trackGeo(new THREE.TorusGeometry(1, 0.14, 10, 28));
  const sharedRingGeo = trackGeo(new THREE.RingGeometry(0.76, 1.0, 28));

  // ==========================================================================
  // 1. Core Bastion Blockout (CORE_BASTION_SPEC)
  // ==========================================================================
  function createCoreBastion(): CoreBastionBlockout {
    const group = new THREE.Group();
    group.name = 'blockout-core-bastion';

    const pedestalHeight = CORE_BASTION_SPEC.heightM * 0.56;
    const pedestalGeo = trackGeo(
      new THREE.CylinderGeometry(
        CORE_BASTION_SPEC.radiusM * 0.82,
        CORE_BASTION_SPEC.radiusM,
        pedestalHeight,
        8,
      ),
    );
    const pedestalMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x1e293b,
        metalness: 0.82,
        roughness: 0.28,
      }),
    );
    const pedestalMesh = new THREE.Mesh(pedestalGeo, pedestalMat);
    pedestalMesh.name = 'core-bastion-pedestal';
    pedestalMesh.position.y = pedestalHeight * 0.5;
    pedestalMesh.castShadow = true;
    pedestalMesh.receiveShadow = true;
    group.add(pedestalMesh);

    // Upper armored collar ring
    const collarGeo = trackGeo(
      new THREE.TorusGeometry(CORE_BASTION_SPEC.radiusM * 0.78, 0.032, 10, 24),
    );
    const collarMesh = new THREE.Mesh(collarGeo, pedestalMat);
    collarMesh.name = 'core-bastion-collar';
    collarMesh.rotation.x = Math.PI / 2;
    collarMesh.position.y = pedestalHeight;
    group.add(collarMesh);

    // Pulsing violet-cyan energy core crystal
    const coreRadius = 0.15;
    const coreGeo = trackGeo(new THREE.OctahedronGeometry(coreRadius, 1));
    const coreMaterial = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x2de2ff,
        emissive: 0x8b5cf6,
        emissiveIntensity: 1.5,
        metalness: 0.35,
        roughness: 0.18,
      }),
    );
    const energyCoreMesh = new THREE.Mesh(coreGeo, coreMaterial);
    energyCoreMesh.name = 'core-bastion-energy-core';
    energyCoreMesh.position.y = CORE_BASTION_SPEC.heightM - coreRadius;
    energyCoreMesh.castShadow = true;
    group.add(energyCoreMesh);

    // Shield ring at base + translucent shield dome reacting to `core-hit`
    const shieldMaterial = trackMat(
      new THREE.MeshBasicMaterial({
        color: 0x2de2ff,
        transparent: true,
        opacity: 0.28,
        side: THREE.FrontSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );

    const shieldRingGeo = trackGeo(
      new THREE.RingGeometry(
        CORE_BASTION_SPEC.shieldDomeRadiusM - 0.035,
        CORE_BASTION_SPEC.shieldDomeRadiusM,
        40,
      ),
    );
    const shieldRingMesh = new THREE.Mesh(shieldRingGeo, shieldMaterial);
    shieldRingMesh.name = 'core-bastion-shield-ring';
    shieldRingMesh.rotation.x = -Math.PI / 2;
    shieldRingMesh.position.y = 0.014;
    shieldRingMesh.renderOrder = 1;
    group.add(shieldRingMesh);

    const domeGeo = trackGeo(
      new THREE.SphereGeometry(
        CORE_BASTION_SPEC.shieldDomeRadiusM,
        24,
        16,
        0,
        Math.PI * 2,
        0,
        Math.PI * 0.5,
      ),
    );
    const shieldDomeMesh = new THREE.Mesh(domeGeo, shieldMaterial);
    shieldDomeMesh.name = 'core-bastion-shield-dome';
    shieldDomeMesh.position.y = 0.005;
    shieldDomeMesh.renderOrder = 2;
    group.add(shieldDomeMesh);

    return {
      group,
      pedestalMesh,
      energyCoreMesh,
      shieldRingMesh,
      shieldDomeMesh,
      coreMaterial,
      shieldMaterial,
      hitFlashRemainingSec: 0,
      lastHp: 100,
      maxHp: 100,
    };
  }

  const coreBastion = createCoreBastion();
  root.add(coreBastion.group, portalsGroup, turretsGroup, enemiesGroup, fxGroup, healthBarsGroup);

  // ==========================================================================
  // 2. Dimensional Rift Portal Blockout (RIFT_PORTAL_SPEC + Occlusion Cutout)
  // ==========================================================================
  const portalsMap = new Map<string, RiftPortalBlockout>();

  function createRiftPortalBlockout(portal: SimPortalState): RiftPortalBlockout {
    const entityGeos: THREE.BufferGeometry[] = [];
    const entityMats: THREE.Material[] = [];
    const entityBindings: DepthOcclusionBinding[] = [];

    const group = new THREE.Group();
    group.name = `blockout-portal-${portal.id}`;
    group.userData.portalId = portal.id;
    group.userData.portalIndex = portal.portalIndex;

    const radiusX = RIFT_PORTAL_SPEC.apertureWidthM * 0.5;
    const radiusY = RIFT_PORTAL_SPEC.apertureHeightM * 0.5;
    const apertureRadius = Math.max(radiusX, radiusY);
    const scaleX = radiusX / apertureRadius;
    const scaleY = radiusY / apertureRadius;

    const frameMaterial = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x334155,
        emissive: 0x6d28d9,
        emissiveIntensity: 0.9,
        metalness: 0.85,
        roughness: 0.25,
      }),
      'portal-rim',
      entityMats,
      entityBindings,
    );

    const frameGeo = trackGeo(
      new THREE.TorusGeometry(apertureRadius, RIFT_PORTAL_SPEC.rimThicknessM * 0.5, 10, 32),
      entityGeos,
    );
    const frameMesh = new THREE.Mesh(frameGeo, frameMaterial);
    frameMesh.name = `portal-frame-${portal.id}`;
    frameMesh.scale.set(scaleX, scaleY, 1);
    group.add(frameMesh);

    // Glowing violet/teal interior plane recessed slightly inside the rim
    const interiorMaterial = trackMat(
      new THREE.MeshBasicMaterial({
        color: 0x7c3aed,
        transparent: true,
        opacity: 0.86,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
      'portal-interior',
      entityMats,
      entityBindings,
    );
    const interiorGeo = trackGeo(new THREE.CircleGeometry(apertureRadius * 0.96, 32), entityGeos);
    const interiorMesh = new THREE.Mesh(interiorGeo, interiorMaterial);
    interiorMesh.name = `portal-interior-${portal.id}`;
    interiorMesh.scale.set(scaleX, scaleY, 1);
    interiorMesh.position.z = -0.025;
    group.add(interiorMesh);

    // Inner teal vortex ring
    const vortexRingMesh = new THREE.Mesh(sharedRingGeo, interiorMaterial);
    vortexRingMesh.name = `portal-vortex-ring-${portal.id}`;
    vortexRingMesh.scale.set(
      RIFT_PORTAL_SPEC.apertureWidthM * 0.34,
      RIFT_PORTAL_SPEC.apertureHeightM * 0.34,
      1,
    );
    vortexRingMesh.position.z = -0.015;
    group.add(vortexRingMesh);

    _dir.set(portal.normal.x, portal.normal.y, portal.normal.z).normalize();
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, 1);
    const portalAperture: PortalAperture = {
      id: portal.id,
      center: new THREE.Vector3(portal.position.x, portal.position.y, portal.position.z),
      normal: _dir.clone(),
      radius: apertureRadius,
      radiusX,
      radiusY,
      hostKind: portal.hostKind === 'virtual-rift' ? 'other' : portal.hostKind,
    };
    buildPortalWorldMatrix(portalAperture, _mat4);
    _mat4.decompose(group.position, group.quaternion, _scale);
    group.updateMatrixWorld(true);

    // Create explicit portal aperture stencil mask mesh matching the exact elliptical opening
    let apertureMaskMesh: THREE.Mesh | null = null;
    if (occlusion) {
      apertureMaskMesh = createPortalApertureMaskMesh(portalAperture, occlusion);
      ownedGeometries.add(apertureMaskMesh.geometry);
      entityGeos.push(apertureMaskMesh.geometry);
      const maskMat = apertureMaskMesh.material as THREE.Material;
      ownedMaterials.add(maskMat);
      entityMats.push(maskMat);
      portalsGroup.add(apertureMaskMesh);
    }

    registerEntityCleanup(`portal:${portal.id}`, entityGeos, entityMats, entityBindings);
    portalsGroup.add(group);

    return {
      id: portal.id,
      portalIndex: portal.portalIndex,
      group,
      frameMesh,
      interiorMesh,
      vortexRingMesh,
      apertureMaskMesh,
      frameMaterial,
      interiorMaterial,
      isOpen: portal.isOpen,
      pulsePhase: portal.portalIndex * 1.1,
      spawnFlashSec: 0,
    };
  }

  // ==========================================================================
  // 3. 4 Turrets × 3 Tiers Blockouts (Dimension-Locked + Yaw/Pitch/Recoil/EMP)
  // ==========================================================================
  const turretsMap = new Map<string, TurretBlockout>();

  function populateTierBarrelAssembly(
    barrelGroup: THREE.Group,
    headMesh: THREE.Mesh,
    kind: TurretKind,
    tier: TurretTierId,
    bodyMat: THREE.MeshStandardMaterial,
    accentMat: THREE.MeshStandardMaterial,
  ): void {
    barrelGroup.clear();
    const stats = getTurretTierStats(kind, tier);
    const b = stats.blockout;

    headMesh.scale.set(b.headWidthM, b.headHeightM, b.headLengthM);
    const barrelStartZ = b.headLengthM * TURRET_BARREL_START_FRACTION;

    if (kind === 'autocannon') {
      if (tier === 'T1') {
        // Single centered kinetic barrel
        const barrel = new THREE.Mesh(sharedBarrelGeo, bodyMat);
        barrel.name = 'barrel-autocannon-t1';
        barrel.scale.set(b.barrelRadiusM, b.barrelRadiusM, b.barrelLengthM);
        barrel.position.set(0, 0, barrelStartZ + b.barrelLengthM * 0.5);
        barrelGroup.add(barrel);

        const tip = new THREE.Mesh(sharedBarrelGeo, accentMat);
        tip.scale.set(b.barrelRadiusM * 1.18, b.barrelRadiusM * 1.18, 0.035);
        tip.position.set(0, 0, barrelStartZ + b.barrelLengthM);
        barrelGroup.add(tip);
      } else if (tier === 'T2') {
        // Twin linked titanium barrels
        const spreadX = b.headWidthM * 0.24;
        for (const sign of [-1, 1] as const) {
          const barrel = new THREE.Mesh(sharedBarrelGeo, bodyMat);
          barrel.name = `barrel-autocannon-t2-${sign > 0 ? 'r' : 'l'}`;
          barrel.scale.set(b.barrelRadiusM, b.barrelRadiusM, b.barrelLengthM);
          barrel.position.set(sign * spreadX, 0, barrelStartZ + b.barrelLengthM * 0.5);
          barrelGroup.add(barrel);

          const tip = new THREE.Mesh(sharedBarrelGeo, accentMat);
          tip.scale.set(b.barrelRadiusM * 1.15, b.barrelRadiusM * 1.15, 0.032);
          tip.position.set(sign * spreadX, 0, barrelStartZ + b.barrelLengthM);
          barrelGroup.add(tip);
        }
      } else {
        // T3: 6-barrel rotary gatling cluster + glowing thermal shroud ring
        const rotaryCluster = new THREE.Group();
        rotaryCluster.name = 'barrel-autocannon-t3-rotary';
        rotaryCluster.position.set(0, 0, barrelStartZ + b.barrelLengthM * 0.5);
        const subRadius = b.barrelRadiusM * 0.34;
        const ringR = b.barrelRadiusM * 0.68;
        for (let i = 0; i < 6; i += 1) {
          const theta = (i * Math.PI * 2) / 6;
          const subBarrel = new THREE.Mesh(sharedBarrelGeo, bodyMat);
          subBarrel.scale.set(subRadius, subRadius, b.barrelLengthM);
          subBarrel.position.set(Math.cos(theta) * ringR, Math.sin(theta) * ringR, 0);
          rotaryCluster.add(subBarrel);
        }
        const shroud = new THREE.Mesh(sharedTorusGeo, accentMat);
        shroud.name = 'autocannon-t3-thermal-shroud';
        shroud.scale.setScalar(b.barrelRadiusM * 1.05);
        shroud.position.z = b.barrelLengthM * 0.32;
        rotaryCluster.add(shroud);
        barrelGroup.add(rotaryCluster);
      }
    } else if (kind === 'plasma-mortar') {
      if (tier === 'T1') {
        // Single heavy mortar tube
        const tube = new THREE.Mesh(sharedBarrelGeo, bodyMat);
        tube.name = 'barrel-mortar-t1';
        tube.scale.set(b.barrelRadiusM, b.barrelRadiusM, b.barrelLengthM);
        tube.position.set(0, 0.015, barrelStartZ + b.barrelLengthM * 0.45);
        barrelGroup.add(tube);

        const muzzleRing = new THREE.Mesh(sharedTorusGeo, accentMat);
        muzzleRing.scale.setScalar(b.barrelRadiusM);
        muzzleRing.position.set(0, 0.015, barrelStartZ + b.barrelLengthM * 0.9);
        barrelGroup.add(muzzleRing);
      } else if (tier === 'T2') {
        // Dual-chamber plasma tubes
        const spreadX = b.headWidthM * 0.25;
        for (const sign of [-1, 1] as const) {
          const tube = new THREE.Mesh(sharedBarrelGeo, bodyMat);
          tube.name = `barrel-mortar-t2-${sign > 0 ? 'r' : 'l'}`;
          tube.scale.set(b.barrelRadiusM, b.barrelRadiusM, b.barrelLengthM);
          tube.position.set(sign * spreadX, 0.015, barrelStartZ + b.barrelLengthM * 0.45);
          barrelGroup.add(tube);

          const muzzleRing = new THREE.Mesh(sharedTorusGeo, accentMat);
          muzzleRing.scale.setScalar(b.barrelRadiusM * 0.95);
          muzzleRing.position.set(sign * spreadX, 0.015, barrelStartZ + b.barrelLengthM * 0.9);
          barrelGroup.add(muzzleRing);
        }
      } else {
        // T3: Heavy siege mortar + dual thermal plasma chambers + shockwave collar
        const spreadX = b.headWidthM * 0.24;
        for (const sign of [-1, 1] as const) {
          const tube = new THREE.Mesh(sharedBarrelGeo, bodyMat);
          tube.name = `barrel-mortar-t3-${sign > 0 ? 'r' : 'l'}`;
          tube.scale.set(b.barrelRadiusM, b.barrelRadiusM, b.barrelLengthM);
          tube.position.set(sign * spreadX, 0.02, barrelStartZ + b.barrelLengthM * 0.48);
          barrelGroup.add(tube);
        }
        const siegeCollar = new THREE.Mesh(sharedTorusGeo, accentMat);
        siegeCollar.name = 'mortar-t3-shockwave-collar';
        siegeCollar.scale.set(b.headWidthM * 0.56, b.headHeightM * 0.48, 1);
        siegeCollar.position.set(0, 0.02, barrelStartZ + b.barrelLengthM * 0.88);
        barrelGroup.add(siegeCollar);
      }
    } else if (kind === 'cryo-arc') {
      if (tier === 'T1') {
        // Single cryo coil emitter
        const emitter = new THREE.Mesh(sharedBarrelGeo, accentMat);
        emitter.name = 'barrel-cryo-t1';
        emitter.scale.set(b.barrelRadiusM, b.barrelRadiusM, b.barrelLengthM);
        emitter.position.set(0, 0.01, barrelStartZ + b.barrelLengthM * 0.5);
        barrelGroup.add(emitter);

        const coilRing = new THREE.Mesh(sharedTorusGeo, accentMat);
        coilRing.scale.setScalar(b.barrelRadiusM * 1.45);
        coilRing.position.set(0, 0.01, barrelStartZ + b.barrelLengthM * 0.75);
        barrelGroup.add(coilRing);
      } else if (tier === 'T2') {
        // Dual arcing cryo prongs
        const spreadX = b.headWidthM * 0.26;
        for (const sign of [-1, 1] as const) {
          const prong = new THREE.Mesh(sharedBarrelGeo, accentMat);
          prong.name = `barrel-cryo-t2-${sign > 0 ? 'r' : 'l'}`;
          prong.scale.set(b.barrelRadiusM, b.barrelRadiusM, b.barrelLengthM);
          prong.position.set(sign * spreadX, 0.01, barrelStartZ + b.barrelLengthM * 0.5);
          barrelGroup.add(prong);
        }
      } else {
        // T3: Tri-pylon cryo conduit around a central cryo crystal
        const triR = b.headWidthM * 0.3;
        for (let i = 0; i < 3; i += 1) {
          const angle = (i * Math.PI * 2) / 3 + Math.PI / 6;
          const pylon = new THREE.Mesh(sharedBarrelGeo, accentMat);
          pylon.name = `barrel-cryo-t3-pylon-${i}`;
          pylon.scale.set(b.barrelRadiusM, b.barrelRadiusM, b.barrelLengthM);
          pylon.position.set(
            Math.cos(angle) * triR,
            Math.sin(angle) * triR,
            barrelStartZ + b.barrelLengthM * 0.5,
          );
          barrelGroup.add(pylon);
        }
        const crystal = new THREE.Mesh(sharedOctaGeo, accentMat);
        crystal.name = 'cryo-t3-conduit-crystal';
        crystal.scale.setScalar(0.036);
        crystal.position.set(0, 0, barrelStartZ + b.barrelLengthM * 0.92);
        barrelGroup.add(crystal);
      }
    } else {
      // rail-sniper
      if (tier === 'T1') {
        // Compact single capacitor rail
        const rail = new THREE.Mesh(sharedBarrelGeo, bodyMat);
        rail.name = 'barrel-rail-t1';
        rail.scale.set(b.barrelRadiusM, b.barrelRadiusM, b.barrelLengthM);
        rail.position.set(0, 0, barrelStartZ + b.barrelLengthM * 0.5);
        barrelGroup.add(rail);

        const coreStrip = new THREE.Mesh(sharedBoxGeo, accentMat);
        coreStrip.scale.set(b.barrelRadiusM * 0.7, b.barrelRadiusM * 1.6, b.barrelLengthM * 0.92);
        coreStrip.position.set(0, 0, barrelStartZ + b.barrelLengthM * 0.5);
        barrelGroup.add(coreStrip);
      } else if (tier === 'T2') {
        // Extended capacitor rails (top/bottom parallel fins)
        const rail = new THREE.Mesh(sharedBarrelGeo, bodyMat);
        rail.name = 'barrel-rail-t2';
        rail.scale.set(b.barrelRadiusM, b.barrelRadiusM, b.barrelLengthM);
        rail.position.set(0, 0, barrelStartZ + b.barrelLengthM * 0.5);
        barrelGroup.add(rail);

        for (const sign of [-1, 1] as const) {
          const fin = new THREE.Mesh(sharedBoxGeo, accentMat);
          fin.name = `rail-t2-capacitor-fin-${sign > 0 ? 'top' : 'bot'}`;
          fin.scale.set(b.barrelRadiusM * 1.3, 0.012, b.barrelLengthM * 0.95);
          fin.position.set(
            0,
            sign * (b.barrelRadiusM * 1.15),
            barrelStartZ + b.barrelLengthM * 0.5,
          );
          barrelGroup.add(fin);
        }
      } else {
        // T3: Twin-rail magnetic accelerator
        const spreadX = b.headWidthM * 0.22;
        for (const sign of [-1, 1] as const) {
          const rail = new THREE.Mesh(sharedBoxGeo, bodyMat);
          rail.name = `barrel-rail-t3-${sign > 0 ? 'r' : 'l'}`;
          rail.scale.set(b.barrelRadiusM * 1.4, b.barrelRadiusM * 1.9, b.barrelLengthM);
          rail.position.set(sign * spreadX, 0, barrelStartZ + b.barrelLengthM * 0.5);
          barrelGroup.add(rail);

          const strip = new THREE.Mesh(sharedBoxGeo, accentMat);
          strip.scale.set(0.01, b.barrelRadiusM * 2.1, b.barrelLengthM * 0.96);
          strip.position.set(sign * spreadX * 0.72, 0, barrelStartZ + b.barrelLengthM * 0.5);
          barrelGroup.add(strip);
        }
      }
    }

    barrelGroup.userData.tier = tier;
    barrelGroup.userData.barrelCount = b.barrelCount;
  }

  function createTurretBlockout(simTurret: SimTurret): TurretBlockout {
    const entityMats: THREE.Material[] = [];
    const entityBindings: DepthOcclusionBinding[] = [];
    const def = getTurretDefinition(simTurret.kind);
    const stats = getTurretTierStats(simTurret.kind, simTurret.tier);
    const b = stats.blockout;

    const group = new THREE.Group();
    group.name = `blockout-turret-${simTurret.id}`;
    group.userData.turretId = simTurret.id;
    group.userData.turretKind = simTurret.kind;
    group.userData.turretTier = simTurret.tier;
    group.userData.mountProfile = simTurret.mountProfile;

    const bodyMaterial = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x263238,
        metalness: 0.78,
        roughness: 0.3,
      }),
      'world-object',
      entityMats,
      entityBindings,
    );
    const accentColor = new THREE.Color(def.accentColorHex);
    const accentMaterial = trackMat(
      new THREE.MeshStandardMaterial({
        color: accentColor,
        emissive: accentColor,
        emissiveIntensity: 1.25,
        metalness: 0.4,
        roughness: 0.22,
      }),
      'world-object',
      entityMats,
      entityBindings,
    );
    const empMaterial = trackMat(
      new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.9,
        wireframe: true,
      }),
      'world-object',
      entityMats,
      entityBindings,
    );
    registerEntityCleanup(`turret:${simTurret.id}`, [], entityMats, entityBindings);

    // 1. Surface-clamp 4-leg articulated mount
    const clampMountGroup = new THREE.Group();
    clampMountGroup.name = 'turret-mount-surface-clamp';
    const clampSpec = TURRET_MOUNT_PROFILES['surface-clamp'].blockout;

    const clampHub = new THREE.Mesh(sharedCylGeo, bodyMaterial);
    clampHub.name = 'turret-clamp-hub';
    clampHub.scale.set(
      clampSpec.emissiveRingRadiusM * 0.85,
      clampSpec.heightM,
      clampSpec.emissiveRingRadiusM * 0.85,
    );
    clampHub.position.y = clampSpec.heightM * 0.5;
    clampHub.castShadow = true;
    clampMountGroup.add(clampHub);

    for (let i = 0; i < clampSpec.legCount; i += 1) {
      const angle = (i * Math.PI * 2) / clampSpec.legCount + Math.PI / 4;
      const leg = new THREE.Mesh(sharedBoxGeo, accentMaterial);
      leg.name = `turret-clamp-leg-${i}`;
      leg.scale.set(0.032, 0.026, clampSpec.radiusM * 0.84);
      const r = clampSpec.radiusM * 0.56;
      leg.position.set(Math.sin(angle) * r, 0.015, Math.cos(angle) * r);
      leg.rotation.y = angle;
      clampMountGroup.add(leg);
    }
    group.add(clampMountGroup);

    // 2. Hover-pod repulsor ring mount
    const hoverPodGroup = new THREE.Group();
    hoverPodGroup.name = 'turret-mount-hover-pod';
    const hoverSpec = TURRET_MOUNT_PROFILES['hover-pod'].blockout;

    const repulsorRing = new THREE.Mesh(sharedTorusGeo, accentMaterial);
    repulsorRing.name = 'turret-hover-repulsor-ring';
    repulsorRing.scale.setScalar(hoverSpec.emissiveRingRadiusM);
    repulsorRing.rotation.x = Math.PI / 2;
    repulsorRing.position.y = hoverSpec.heightM * 0.45;
    hoverPodGroup.add(repulsorRing);

    const repulsorCore = new THREE.Mesh(sharedCylGeo, bodyMaterial);
    repulsorCore.name = 'turret-hover-repulsor-core';
    repulsorCore.scale.set(
      hoverSpec.emissiveRingRadiusM * 0.56,
      hoverSpec.heightM,
      hoverSpec.emissiveRingRadiusM * 0.56,
    );
    repulsorCore.position.y = hoverSpec.heightM * 0.5;
    hoverPodGroup.add(repulsorCore);
    group.add(hoverPodGroup);

    // 3. Articulated Yaw Ring + Pitch Cradle + Recoil Barrel Assembly
    const yawRing = new THREE.Group();
    yawRing.name = 'turret-yaw-ring';
    yawRing.position.y = b.baseHeightM;

    const pitchCradle = new THREE.Group();
    pitchCradle.name = 'turret-pitch-cradle';
    pitchCradle.position.y = b.headHeightM * 0.5;

    const headMesh = new THREE.Mesh(sharedBoxGeo, bodyMaterial);
    headMesh.name = 'turret-head';
    headMesh.castShadow = true;
    headMesh.receiveShadow = true;
    pitchCradle.add(headMesh);

    const recoilGroup = new THREE.Group();
    recoilGroup.name = 'turret-recoil-cradle';
    const barrelGroup = new THREE.Group();
    barrelGroup.name = 'turret-barrel-assembly';
    recoilGroup.add(barrelGroup);
    pitchCradle.add(recoilGroup);
    yawRing.add(pitchCradle);
    group.add(yawRing);

    populateTierBarrelAssembly(
      barrelGroup,
      headMesh,
      simTurret.kind,
      simTurret.tier,
      bodyMaterial,
      accentMaterial,
    );

    // 4. EMP-Disrupted Spark Halo
    const empHaloGroup = new THREE.Group();
    empHaloGroup.name = 'turret-emp-spark-halo';
    empHaloGroup.position.y = b.totalHeightM + 0.08;
    empHaloGroup.visible = false;

    const empSparkOcta = new THREE.Mesh(sharedOctaGeo, empMaterial);
    empSparkOcta.scale.setScalar(0.065);
    const empSparkRing = new THREE.Mesh(sharedTorusGeo, empMaterial);
    empSparkRing.scale.setScalar(0.12);
    empSparkRing.rotation.x = Math.PI / 2;
    empHaloGroup.add(empSparkOcta, empSparkRing);
    group.add(empHaloGroup);

    turretsGroup.add(group);

    return {
      id: simTurret.id,
      kind: simTurret.kind,
      tier: simTurret.tier,
      mountProfile: simTurret.mountProfile,
      group,
      clampMountGroup,
      hoverPodGroup,
      yawRing,
      pitchCradle,
      recoilGroup,
      barrelGroup,
      headMesh,
      empHaloGroup,
      bodyMaterial,
      accentMaterial,
      empMaterial,
      recoilOffsetM: 0,
      rotarySpinAngle: 0,
      isDisrupted: simTurret.isDisrupted,
      yaw: simTurret.yaw,
      pitch: simTurret.pitch,
    };
  }

  // ==========================================================================
  // 4. 5 Invader Archetype Blockouts (Dimension-Locked + Frost + Boss Phase 2)
  // ==========================================================================
  const enemiesMap = new Map<string, EnemyBlockout>();

  function createEnemyBlockout(simEnemy: SimEnemy): EnemyBlockout {
    const entityMats: THREE.Material[] = [];
    const entityBindings: DepthOcclusionBinding[] = [];
    const def = getEnemyDefinition(simEnemy.archetypeId);
    const b = def.blockout;

    const group = new THREE.Group();
    group.name = `blockout-enemy-${simEnemy.id}`;
    group.userData.enemyId = simEnemy.id;
    group.userData.archetypeId = simEnemy.archetypeId;
    group.userData.isBoss = simEnemy.isBoss;

    const bodyGroup = new THREE.Group();
    bodyGroup.name = 'enemy-body-silhouette';
    group.add(bodyGroup);

    const primaryMaterial = trackMat(
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(def.primaryColorHex),
        metalness: 0.55,
        roughness: 0.42,
      }),
      'world-object',
      entityMats,
      entityBindings,
    );
    const accentColor = new THREE.Color(def.emissiveColorHex);
    const accentMaterial = trackMat(
      new THREE.MeshStandardMaterial({
        color: accentColor,
        emissive: accentColor,
        emissiveIntensity: 1.2,
        metalness: 0.35,
        roughness: 0.25,
      }),
      'world-object',
      entityMats,
      entityBindings,
    );

    let crackMaterial: THREE.MeshBasicMaterial | null = null;

    if (simEnemy.archetypeId === 'skitter-crawler') {
      // Fast Swarm Crawler: segmented chitin carapace + 6 angled legs
      const thorax = new THREE.Mesh(sharedBoxGeo, primaryMaterial);
      thorax.name = 'crawler-thorax';
      thorax.scale.set(b.widthM * 0.65, b.heightM * 0.65, b.lengthM * 0.85);
      thorax.position.set(0, b.heightM * 0.55, 0);
      thorax.castShadow = true;
      bodyGroup.add(thorax);

      const spine = new THREE.Mesh(sharedBoxGeo, accentMaterial);
      spine.name = 'crawler-emissive-spine';
      spine.scale.set(b.widthM * 0.25, b.heightM * 0.22, b.lengthM * 0.72);
      spine.position.set(0, b.heightM * 0.9, 0);
      bodyGroup.add(spine);

      for (const zOff of [-b.lengthM * 0.28, 0, b.lengthM * 0.28]) {
        for (const side of [-1, 1] as const) {
          const leg = new THREE.Mesh(sharedBoxGeo, primaryMaterial);
          leg.scale.set(b.widthM * 0.38, 0.022, 0.026);
          leg.position.set(side * b.widthM * 0.38, b.heightM * 0.32, zOff);
          leg.rotation.z = side * -0.45;
          bodyGroup.add(leg);
        }
      }
    } else if (simEnemy.archetypeId === 'wasp-skimmer') {
      // Aerial Striker: darting fuselage + 4 swept teal wings
      const fuselage = new THREE.Mesh(sharedBoxGeo, primaryMaterial);
      fuselage.name = 'skimmer-fuselage';
      fuselage.scale.set(b.widthM * 0.28, b.heightM * 0.58, b.lengthM);
      fuselage.position.set(0, b.heightM * 0.5, 0);
      fuselage.castShadow = true;
      bodyGroup.add(fuselage);

      for (const side of [-1, 1] as const) {
        const wing = new THREE.Mesh(sharedBoxGeo, accentMaterial);
        wing.name = `skimmer-wing-${side > 0 ? 'r' : 'l'}`;
        wing.scale.set(b.widthM * 0.48, 0.015, b.lengthM * 0.42);
        wing.position.set(side * b.widthM * 0.28, b.heightM * 0.65, -0.02);
        wing.rotation.z = side * 0.18;
        bodyGroup.add(wing);
      }
    } else if (simEnemy.archetypeId === 'carapace-brute') {
      // Armored Heavy: hulking torso + dense sloped frontal armor carapace plate
      const torso = new THREE.Mesh(sharedBoxGeo, primaryMaterial);
      torso.name = 'brute-torso';
      torso.scale.set(b.widthM * 0.86, b.heightM * 0.85, b.lengthM * 0.82);
      torso.position.set(0, b.heightM * 0.5, -b.lengthM * 0.05);
      torso.castShadow = true;
      bodyGroup.add(torso);

      const frontalPlate = new THREE.Mesh(sharedBoxGeo, primaryMaterial);
      frontalPlate.name = 'brute-frontal-armor-plate';
      frontalPlate.scale.set(b.widthM, b.heightM * 0.78, 0.075);
      frontalPlate.position.set(0, b.heightM * 0.46, b.lengthM * 0.44);
      frontalPlate.rotation.x = -0.22;
      frontalPlate.castShadow = true;
      bodyGroup.add(frontalPlate);

      const coreVent = new THREE.Mesh(sharedBoxGeo, accentMaterial);
      coreVent.name = 'brute-plasma-vent';
      coreVent.scale.set(b.widthM * 0.52, b.heightM * 0.22, b.lengthM * 0.55);
      coreVent.position.set(0, b.heightM * 0.88, -0.02);
      bodyGroup.add(coreVent);
    } else if (simEnemy.archetypeId === 'rift-disruptor') {
      // Aerial Tactical Support: octahedron core + rotating EMP emitter ring
      const hull = new THREE.Mesh(sharedOctaGeo, primaryMaterial);
      hull.name = 'disruptor-hull';
      hull.scale.set(b.widthM * 0.38, b.heightM * 0.48, b.lengthM * 0.45);
      hull.position.set(0, b.heightM * 0.5, 0);
      hull.castShadow = true;
      bodyGroup.add(hull);

      const empRing = new THREE.Mesh(sharedTorusGeo, accentMaterial);
      empRing.name = 'disruptor-emp-ring';
      empRing.scale.setScalar(b.widthM * 0.48);
      empRing.rotation.x = Math.PI / 2;
      empRing.position.set(0, b.heightM * 0.5, 0);
      bodyGroup.add(empRing);
    } else {
      // Wave 12 Boss: Apex Broodlord Matriarch (0.92 m × 0.78 m × 0.84 m) + Phase-2 molten armor cracks
      const carapace = new THREE.Mesh(sharedBoxGeo, primaryMaterial);
      carapace.name = 'broodlord-carapace';
      carapace.scale.set(b.widthM * 0.88, b.heightM * 0.78, b.lengthM * 0.88);
      carapace.position.set(0, b.heightM * 0.5, 0);
      carapace.castShadow = true;
      bodyGroup.add(carapace);

      const crest = new THREE.Mesh(sharedOctaGeo, accentMaterial);
      crest.name = 'broodlord-matriarch-crest';
      crest.scale.set(b.widthM * 0.34, b.heightM * 0.28, b.lengthM * 0.36);
      crest.position.set(0, b.heightM * 0.92, b.lengthM * 0.14);
      bodyGroup.add(crest);

      crackMaterial = trackMat(
        new THREE.MeshBasicMaterial({
          color: BOSS_PHASE1_EMISSIVE,
          transparent: true,
          opacity: 0.45,
        }),
        'world-object',
        entityMats,
        entityBindings,
      );
      const crackSeams = new THREE.Group();
      crackSeams.name = 'broodlord-armor-crack-seams';
      for (const xOff of [-b.widthM * 0.26, 0, b.widthM * 0.26]) {
        const seam = new THREE.Mesh(sharedBoxGeo, crackMaterial);
        seam.scale.set(0.042, b.heightM * 0.82, b.lengthM * 0.92);
        seam.position.set(xOff, b.heightM * 0.5, 0);
        crackSeams.add(seam);
      }
      bodyGroup.add(crackSeams);
    }

    // Cryo-slow frost ring indicator at enemy base
    const frostMat = trackMat(
      new THREE.MeshBasicMaterial({
        color: CRYO_FROST_COLOR,
        transparent: true,
        opacity: 0.8,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
      'world-object',
      entityMats,
      entityBindings,
    );
    registerEntityCleanup(`enemy:${simEnemy.id}`, [], entityMats, entityBindings);
    const frostRingMesh = new THREE.Mesh(sharedRingGeo, frostMat);
    frostRingMesh.name = 'enemy-cryo-frost-ring';
    frostRingMesh.rotation.x = -Math.PI / 2;
    frostRingMesh.scale.setScalar(Math.max(b.widthM, b.lengthM) * 0.55);
    frostRingMesh.position.y = 0.015;
    frostRingMesh.visible = false;
    group.add(frostRingMesh);

    enemiesGroup.add(group);

    return {
      id: simEnemy.id,
      archetypeId: simEnemy.archetypeId,
      isBoss: simEnemy.isBoss,
      group,
      bodyGroup,
      primaryMaterial,
      accentMaterial,
      crackMaterial,
      frostRingMesh,
      isCryoSlowed: simEnemy.slowFactor > 0,
      isBossPhase2: simEnemy.isBossPhase2,
      slowFactor: simEnemy.slowFactor,
      emissiveIntensity: simEnemy.emissiveIntensity,
      hitFlashSec: 0,
      locomotionPhase: 0,
    };
  }

  // ==========================================================================
  // 5. Pre-Allocated GPU-Instanced World Health Bars & Weapon FX Pools
  // ==========================================================================
  const hpBarBgGeo = trackGeo(new THREE.BoxGeometry(0.32, 0.036, 0.012));
  const hpBarFillGeo = trackGeo(new THREE.BoxGeometry(0.3, 0.026, 0.016));
  const hpBarBgMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0x09131d,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
    }),
    'none',
  );
  const hpBarFillMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.98,
      depthWrite: false,
    }),
    'none',
  );

  const hpBgInstancedMesh = new THREE.InstancedMesh(hpBarBgGeo, hpBarBgMat, MAX_INSTANCED_HP_BARS);
  hpBgInstancedMesh.name = 'instanced-enemy-hp-bg';
  hpBgInstancedMesh.count = 0;
  hpBgInstancedMesh.frustumCulled = false;
  hpBgInstancedMesh.renderOrder = 10;

  const hpFillInstancedMesh = new THREE.InstancedMesh(
    hpBarFillGeo,
    hpBarFillMat,
    MAX_INSTANCED_HP_BARS,
  );
  hpFillInstancedMesh.name = 'instanced-enemy-hp-fill';
  hpFillInstancedMesh.count = 0;
  hpFillInstancedMesh.frustumCulled = false;
  hpFillInstancedMesh.renderOrder = 11;
  healthBarsGroup.add(hpBgInstancedMesh, hpFillInstancedMesh);

  // Weapon FX InstancedMeshes (all pre-allocated once at startup)
  const unitSegmentCylGeo = trackGeo(new THREE.CylinderGeometry(1, 1, 1, 8));
  const unitSphereGeo = trackGeo(new THREE.SphereGeometry(1, 12, 10));
  const unitBlastRingGeo = trackGeo(new THREE.RingGeometry(0.82, 1.0, 28));
  unitBlastRingGeo.rotateX(-Math.PI / 2);

  const tracerMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    }),
  );
  const mortarShellMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0xff5722,
    }),
  );
  const blastRingMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.82,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  const cryoBeamMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    }),
  );
  const railBeamMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0x7dd3fc,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
    }),
  );

  const tracerInstancedMesh = new THREE.InstancedMesh(
    unitSegmentCylGeo,
    tracerMat,
    MAX_INSTANCED_TRACERS,
  );
  tracerInstancedMesh.name = 'instanced-fx-kinetic-tracers';
  tracerInstancedMesh.count = 0;
  tracerInstancedMesh.frustumCulled = false;

  const mortarShellInstancedMesh = new THREE.InstancedMesh(
    unitSphereGeo,
    mortarShellMat,
    MAX_INSTANCED_MORTAR_SHELLS,
  );
  mortarShellInstancedMesh.name = 'instanced-fx-mortar-shells';
  mortarShellInstancedMesh.count = 0;
  mortarShellInstancedMesh.frustumCulled = false;

  const blastRingInstancedMesh = new THREE.InstancedMesh(
    unitBlastRingGeo,
    blastRingMat,
    MAX_INSTANCED_BLAST_RINGS,
  );
  blastRingInstancedMesh.name = 'instanced-fx-blast-rings';
  blastRingInstancedMesh.count = 0;
  blastRingInstancedMesh.frustumCulled = false;

  const cryoArcInstancedMesh = new THREE.InstancedMesh(
    unitSegmentCylGeo,
    cryoBeamMat,
    MAX_INSTANCED_CRYO_SEGMENTS,
  );
  cryoArcInstancedMesh.name = 'instanced-fx-cryo-chains';
  cryoArcInstancedMesh.count = 0;
  cryoArcInstancedMesh.frustumCulled = false;

  const railBeamInstancedMesh = new THREE.InstancedMesh(
    unitSegmentCylGeo,
    railBeamMat,
    MAX_INSTANCED_RAIL_BEAMS,
  );
  railBeamInstancedMesh.name = 'instanced-fx-rail-beams';
  railBeamInstancedMesh.count = 0;
  railBeamInstancedMesh.frustumCulled = false;

  fxGroup.add(
    tracerInstancedMesh,
    mortarShellInstancedMesh,
    blastRingInstancedMesh,
    cryoArcInstancedMesh,
    railBeamInstancedMesh,
  );

  const activeTracers: ActiveTracerFx[] = [];
  const activeBlastRings: ActiveBlastRingFx[] = [];
  const activeCryoSegments: ActiveBeamSegmentFx[] = [];
  const activeRailBeams: ActiveBeamSegmentFx[] = [];

  let fxCounts: WeaponFxCounts = {
    activeTracers: 0,
    activeMortarShells: 0,
    activeBlastRings: 0,
    activeCryoSegments: 0,
    activeRailBeams: 0,
    activeHpBars: 0,
  };

  function spawnCryoJaggedLink(from: Readonly<Vec3>, to: Readonly<Vec3>): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    let prev: Vec3 = { x: from.x, y: from.y, z: from.z };

    for (let s = 1; s <= CRYO_SUBSEGMENTS_PER_LINK; s += 1) {
      const t = s / CRYO_SUBSEGMENTS_PER_LINK;
      const jitter = s < CRYO_SUBSEGMENTS_PER_LINK ? (s % 2 === 1 ? 0.055 : -0.055) : 0;
      const next: Vec3 = {
        x: from.x + dx * t - dz * jitter,
        y: from.y + dy * t + Math.abs(jitter) * 0.45,
        z: from.z + dz * t + dx * jitter,
      };
      if (activeCryoSegments.length >= MAX_INSTANCED_CRYO_SEGMENTS) {
        activeCryoSegments.shift();
      }
      activeCryoSegments.push({
        from: prev,
        to: next,
        elapsedSec: 0,
        durationSec: 0.22,
        thicknessM: 0.016,
        colorHex: 0x22d3ee,
      });
      prev = next;
    }
  }

  function processEvents(events: readonly SimEvent[]): void {
    for (const ev of events) {
      switch (ev.type) {
        case 'core-hit': {
          coreBastion.hitFlashRemainingSec = 0.35;
          break;
        }
        case 'portal-opened':
        case 'enemy-spawned': {
          const portal = portalsMap.get(ev.portalId);
          if (portal) {
            portal.spawnFlashSec = 0.4;
          }
          break;
        }
        case 'turret-fired': {
          const turretBlockout = turretsMap.get(ev.turretId);
          if (turretBlockout) {
            turretBlockout.recoilOffsetM =
              ev.turretKind === 'rail-sniper'
                ? 0.055
                : ev.turretKind === 'plasma-mortar'
                  ? 0.045
                  : 0.025;
          }

          if (ev.turretKind === 'autocannon') {
            if (activeTracers.length >= MAX_INSTANCED_TRACERS) activeTracers.shift();
            activeTracers.push({
              from: { ...ev.fromPosition },
              to: { ...ev.toPosition },
              elapsedSec: 0,
              durationSec: 0.14,
              colorHex: 0xf59e0b,
            });
          } else if (ev.turretKind === 'rail-sniper') {
            if (activeRailBeams.length >= MAX_INSTANCED_RAIL_BEAMS) activeRailBeams.shift();
            activeRailBeams.push({
              from: { ...ev.fromPosition },
              to: { ...ev.toPosition },
              elapsedSec: 0,
              durationSec: 0.26,
              thicknessM: ev.tier === 'T3' ? 0.028 : ev.tier === 'T2' ? 0.022 : 0.017,
              colorHex: 0x7dd3fc,
            });
          } else if (ev.turretKind === 'cryo-arc') {
            spawnCryoJaggedLink(ev.fromPosition, ev.toPosition);
          }
          break;
        }
        case 'cryo-chain': {
          const pts = ev.chainPositions;
          for (let i = 0; i + 1 < pts.length; i += 1) {
            const p0 = pts[i];
            const p1 = pts[i + 1];
            if (p0 && p1) {
              spawnCryoJaggedLink(p0, p1);
            }
          }
          break;
        }
        case 'projectile-impact': {
          if (activeBlastRings.length >= MAX_INSTANCED_BLAST_RINGS) activeBlastRings.shift();
          activeBlastRings.push({
            position: { ...ev.position },
            maxRadiusM: Math.max(0.25, ev.aoeRadiusM),
            elapsedSec: 0,
            durationSec: 0.38,
            colorHex: 0xff5722,
          });
          break;
        }
        case 'turret-disrupted': {
          if (activeBlastRings.length >= MAX_INSTANCED_BLAST_RINGS) activeBlastRings.shift();
          activeBlastRings.push({
            position: { ...ev.position },
            maxRadiusM: 1.2,
            elapsedSec: 0,
            durationSec: 0.45,
            colorHex: 0x38bdf8,
          });
          break;
        }
        case 'boss-phase2': {
          if (activeBlastRings.length >= MAX_INSTANCED_BLAST_RINGS) activeBlastRings.shift();
          activeBlastRings.push({
            position: { ...ev.position },
            maxRadiusM: 1.6,
            elapsedSec: 0,
            durationSec: 0.6,
            colorHex: 0xff4d00,
          });
          break;
        }
        case 'enemy-hit': {
          const enemyBlockout = enemiesMap.get(ev.enemyId);
          if (enemyBlockout) {
            enemyBlockout.hitFlashSec = 0.1;
          }
          break;
        }
        default:
          break;
      }
    }
  }

  let elapsedTotalSec = 0;
  let disposed = false;

  return {
    root,
    coreBastion,
    portalsGroup,
    turretsGroup,
    enemiesGroup,
    fxGroup,
    healthBarsGroup,
    get portals() {
      return portalsMap;
    },
    get turrets() {
      return turretsMap;
    },
    get enemies() {
      return enemiesMap;
    },
    get fxCounts() {
      return fxCounts;
    },
    tracerInstancedMesh,
    mortarShellInstancedMesh,
    blastRingInstancedMesh,
    cryoArcInstancedMesh,
    railBeamInstancedMesh,
    hpBgInstancedMesh,
    hpFillInstancedMesh,

    syncFromSim(snapshot, events = [], dt = 0, camera = null) {
      if (disposed) return;

      const stepDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
      elapsedTotalSec += stepDt;

      // 1. Sync Core Bastion position, rotation, HP color, and `core-hit` shield flare
      coreBastion.group.position.set(
        snapshot.corePosition.x,
        snapshot.corePosition.y,
        snapshot.corePosition.z,
      );
      coreBastion.lastHp = snapshot.coreHp;
      coreBastion.maxHp = snapshot.maxCoreHp;
      coreBastion.energyCoreMesh.rotation.y = elapsedTotalSec * 0.9;
      coreBastion.energyCoreMesh.position.y =
        CORE_BASTION_SPEC.heightM - 0.15 + Math.sin(elapsedTotalSec * 2.4) * 0.018;

      // Process events after ensuring entities exist or during update
      processEvents(events);

      if (coreBastion.hitFlashRemainingSec > 0) {
        coreBastion.hitFlashRemainingSec = Math.max(0, coreBastion.hitFlashRemainingSec - stepDt);
      }
      const coreHitFactor = coreBastion.hitFlashRemainingSec > 0 ? 1 : 0;
      const coreHpRatio =
        snapshot.maxCoreHp > 0 ? Math.max(0, snapshot.coreHp / snapshot.maxCoreHp) : 0;

      if (coreHitFactor > 0) {
        coreBastion.shieldMaterial.color.setHex(0xff3b5c);
        coreBastion.shieldMaterial.opacity = 0.56;
        coreBastion.coreMaterial.emissive.setHex(0xff3b5c);
        coreBastion.coreMaterial.emissiveIntensity = 2.4;
      } else {
        coreBastion.shieldMaterial.color.setHex(coreHpRatio < 0.35 ? 0xff7b54 : 0x2de2ff);
        coreBastion.shieldMaterial.opacity = 0.2 + 0.08 * Math.sin(elapsedTotalSec * 2.0);
        coreBastion.coreMaterial.emissive.setHex(0x8b5cf6);
        coreBastion.coreMaterial.emissiveIntensity = 1.4 + 0.25 * Math.sin(elapsedTotalSec * 3.0);
      }

      // 2. Sync Dimensional Rift Portals
      const seenPortals = new Set<string>();
      for (const simPortal of snapshot.portals) {
        seenPortals.add(simPortal.id);
        let portalBlockout = portalsMap.get(simPortal.id);
        if (!portalBlockout) {
          portalBlockout = createRiftPortalBlockout(simPortal);
          portalsMap.set(simPortal.id, portalBlockout);
        }

        portalBlockout.isOpen = simPortal.isOpen;
        _dir.set(simPortal.normal.x, simPortal.normal.y, simPortal.normal.z).normalize();
        if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, 1);
        _vecA.set(simPortal.position.x, simPortal.position.y, simPortal.position.z);
        if (simPortal.hostKind !== 'virtual-rift') {
          // Keep the entire rim on the room side even at grazing angles.
          _vecA.addScaledVector(_dir, RIFT_PORTAL_SPEC.rimThicknessM / 2 + 0.01);
        }
        buildPortalWorldMatrix(
          {
            id: simPortal.id,
            center: _vecA,
            normal: _dir,
            radius:
              Math.max(RIFT_PORTAL_SPEC.apertureWidthM, RIFT_PORTAL_SPEC.apertureHeightM) * 0.5,
          },
          _mat4,
        );
        _mat4.decompose(portalBlockout.group.position, portalBlockout.group.quaternion, _scale);

        if (portalBlockout.apertureMaskMesh) {
          portalBlockout.apertureMaskMesh.position.copy(portalBlockout.group.position);
          portalBlockout.apertureMaskMesh.quaternion.copy(portalBlockout.group.quaternion);
          portalBlockout.apertureMaskMesh.visible = simPortal.isOpen;
        }

        portalBlockout.pulsePhase += stepDt * (simPortal.isOpen ? 3.2 : 1.0);
        if (portalBlockout.spawnFlashSec > 0) {
          portalBlockout.spawnFlashSec = Math.max(0, portalBlockout.spawnFlashSec - stepDt);
        }

        portalBlockout.interiorMesh.visible = simPortal.isOpen;
        portalBlockout.vortexRingMesh.visible = simPortal.isOpen;
        portalBlockout.frameMaterial.emissiveIntensity = simPortal.isOpen
          ? 1.15 + 0.35 * Math.sin(portalBlockout.pulsePhase) + portalBlockout.spawnFlashSec
          : 0.35;
        portalBlockout.interiorMaterial.opacity = simPortal.isOpen
          ? 0.78 + 0.14 * Math.sin(portalBlockout.pulsePhase * 1.3)
          : 0;
      }

      for (const [id, record] of portalsMap.entries()) {
        if (!seenPortals.has(id)) {
          portalsGroup.remove(record.group);
          if (record.apertureMaskMesh) {
            portalsGroup.remove(record.apertureMaskMesh);
          }
          disposeEntityCleanup(`portal:${id}`);
          portalsMap.delete(id);
        }
      }

      // 3. Sync 4 Turrets × 3 Tiers (Tier Upgrade Silhouette, Yaw/Pitch, Recoil, EMP Halo)
      const seenTurrets = new Set<string>();
      for (const simTurret of snapshot.turrets) {
        seenTurrets.add(simTurret.id);
        let turretBlockout = turretsMap.get(simTurret.id);
        if (!turretBlockout) {
          turretBlockout = createTurretBlockout(simTurret);
          turretsMap.set(simTurret.id, turretBlockout);
        }

        // Rebuild barrel & head silhouette if upgraded to a new tier (T1 -> T2 -> T3)
        if (turretBlockout.tier !== simTurret.tier) {
          turretBlockout.tier = simTurret.tier;
          turretBlockout.group.userData.turretTier = simTurret.tier;
          const nextB = getTurretTierStats(simTurret.kind, simTurret.tier).blockout;
          turretBlockout.yawRing.position.y = nextB.baseHeightM;
          turretBlockout.pitchCradle.position.y = nextB.headHeightM * 0.5;
          turretBlockout.empHaloGroup.position.y = nextB.totalHeightM + 0.08;
          populateTierBarrelAssembly(
            turretBlockout.barrelGroup,
            turretBlockout.headMesh,
            simTurret.kind,
            simTurret.tier,
            turretBlockout.bodyMaterial,
            turretBlockout.accentMaterial,
          );
        }

        // Mount base visibility (`surface-clamp` legs vs `hover-pod` repulsor ring)
        turretBlockout.mountProfile = simTurret.mountProfile;
        turretBlockout.group.userData.mountProfile = simTurret.mountProfile;
        const isHover = simTurret.mountProfile === 'hover-pod';
        turretBlockout.clampMountGroup.visible = !isHover;
        turretBlockout.hoverPodGroup.visible = isHover;

        turretBlockout.group.position.set(
          simTurret.position.x,
          simTurret.position.y,
          simTurret.position.z,
        );
        turretBlockout.group.quaternion.set(
          simTurret.pose.quaternion.x,
          simTurret.pose.quaternion.y,
          simTurret.pose.quaternion.z,
          simTurret.pose.quaternion.w,
        );

        // Articulated yaw-ring + pitch-cradle tracking the active sim target
        turretBlockout.yaw = simTurret.yaw;
        turretBlockout.pitch = simTurret.pitch;
        turretBlockout.yawRing.rotation.y = simTurret.yaw;
        turretBlockout.pitchCradle.rotation.x = -simTurret.pitch;

        // Spring-damped muzzle recoil recovery
        if (turretBlockout.recoilOffsetM > 0) {
          turretBlockout.recoilOffsetM = Math.max(0, turretBlockout.recoilOffsetM - stepDt * 0.22);
        }
        turretBlockout.recoilGroup.position.z = -turretBlockout.recoilOffsetM;

        // T3 Autocannon rotary barrel spin while targeting
        if (simTurret.kind === 'autocannon' && simTurret.tier === 'T3') {
          const rotary = turretBlockout.barrelGroup.getObjectByName('barrel-autocannon-t3-rotary');
          if (rotary && simTurret.targetEnemyId && !simTurret.isDisrupted) {
            turretBlockout.rotarySpinAngle += stepDt * 18;
            rotary.rotation.z = turretBlockout.rotarySpinAngle;
          }
        }

        // EMP-Disrupted spark halo & weapon power-down tint
        turretBlockout.isDisrupted = simTurret.isDisrupted;
        turretBlockout.empHaloGroup.visible = simTurret.isDisrupted;
        if (simTurret.isDisrupted) {
          turretBlockout.empHaloGroup.rotation.y += stepDt * 5.5;
          turretBlockout.empHaloGroup.rotation.x = Math.sin(elapsedTotalSec * 8) * 0.35;
          turretBlockout.accentMaterial.emissiveIntensity = 0.2;
        } else {
          turretBlockout.accentMaterial.emissiveIntensity = 1.25;
        }
      }

      for (const [id, record] of turretsMap.entries()) {
        if (!seenTurrets.has(id)) {
          turretsGroup.remove(record.group);
          disposeEntityCleanup(`turret:${id}`);
          turretsMap.delete(id);
        }
      }

      // Re-run event recoil/flash bindings for turrets or enemies created in this very frame
      if (events.length > 0) {
        for (const ev of events) {
          if (ev.type === 'turret-fired') {
            const tb = turretsMap.get(ev.turretId);
            if (tb && tb.recoilOffsetM === 0) {
              tb.recoilOffsetM = 0.03;
              tb.recoilGroup.position.z = -tb.recoilOffsetM;
            }
          }
        }
      }

      // 4. Sync 5 Invaders + Instanced World Health Bars
      const seenEnemies = new Set<string>();
      let hpBarIndex = 0;

      // Compute camera billboard orientation once for all enemy health bars
      const hasBillboardCam = Boolean(camera);
      if (camera) {
        camera.updateMatrixWorld(false);
        _quat.setFromRotationMatrix(camera.matrixWorld);
      } else {
        _quat.identity();
      }
      _vecMid.set(1, 0, 0).applyQuaternion(_quat); // billboard right axis
      _dir.set(0, 0, 1).applyQuaternion(_quat); // billboard toward-camera axis

      for (const simEnemy of snapshot.enemies) {
        seenEnemies.add(simEnemy.id);
        let enemyBlockout = enemiesMap.get(simEnemy.id);
        if (!enemyBlockout) {
          enemyBlockout = createEnemyBlockout(simEnemy);
          enemiesMap.set(simEnemy.id, enemyBlockout);
        }

        const def = ENEMIES[simEnemy.archetypeId];
        enemyBlockout.group.position.set(
          simEnemy.position.x,
          simEnemy.position.y,
          simEnemy.position.z,
        );

        // Orient invader along its locomotion tangent & surface normal
        _upAxis.set(simEnemy.normal.x, simEnemy.normal.y, simEnemy.normal.z).normalize();
        if (_upAxis.lengthSq() < 1e-6) _upAxis.set(0, 1, 0);
        _vecA.set(simEnemy.tangent.x, simEnemy.tangent.y, simEnemy.tangent.z).normalize();
        if (_vecA.lengthSq() < 1e-6) _vecA.set(0, 0, 1);
        _vecB.crossVectors(_upAxis, _vecA);
        if (_vecB.lengthSq() < 1e-6) {
          _vecB.set(1, 0, 0);
        } else {
          _vecB.normalize();
        }
        _vecA.crossVectors(_vecB, _upAxis).normalize();
        _mat4.makeBasis(_vecB, _upAxis, _vecA);
        enemyBlockout.group.quaternion.setFromRotationMatrix(_mat4);
        _upAxis.set(0, 1, 0);

        // Subtle locomotion bob + Disruptor EMP ring rotation
        enemyBlockout.locomotionPhase += stepDt * (0.8 + simEnemy.effectiveSpeedMps * 4.5);
        enemyBlockout.bodyGroup.position.y =
          Math.sin(enemyBlockout.locomotionPhase) *
          (simEnemy.movementLayer === 'air' ? 0.025 : 0.01);
        if (simEnemy.archetypeId === 'rift-disruptor') {
          const empRing = enemyBlockout.bodyGroup.getObjectByName('disruptor-emp-ring');
          if (empRing) {
            empRing.rotation.z += stepDt * 3.2;
          }
        }

        // Hit flash decay + emissive response
        if (enemyBlockout.hitFlashSec > 0) {
          enemyBlockout.hitFlashSec = Math.max(0, enemyBlockout.hitFlashSec - stepDt);
          enemyBlockout.primaryMaterial.emissive.setHex(0xffffff);
          enemyBlockout.primaryMaterial.emissiveIntensity = (enemyBlockout.hitFlashSec / 0.1) * 0.8;
        } else {
          enemyBlockout.primaryMaterial.emissive.setHex(0x000000);
          enemyBlockout.primaryMaterial.emissiveIntensity = 0;
        }

        // Cryo-Slow Cyan Frost Tint
        const isSlowed = simEnemy.slowFactor > 0 && simEnemy.slowRemainingSec > 0;
        enemyBlockout.isCryoSlowed = isSlowed;
        enemyBlockout.slowFactor = simEnemy.slowFactor;
        enemyBlockout.frostRingMesh.visible = isSlowed;
        if (isSlowed) {
          enemyBlockout.primaryMaterial.color
            .set(def.primaryColorHex)
            .lerp(CRYO_FROST_COLOR, Math.min(0.75, 0.35 + simEnemy.slowFactor));
        } else {
          enemyBlockout.primaryMaterial.color.set(def.primaryColorHex);
        }

        // Apex Broodlord Boss Phase-2 Molten Armor-Crack Emissive Shift
        enemyBlockout.isBossPhase2 = simEnemy.isBossPhase2;
        enemyBlockout.emissiveIntensity = simEnemy.emissiveIntensity;
        if (simEnemy.isBoss) {
          if (simEnemy.isBossPhase2) {
            enemyBlockout.accentMaterial.emissive.copy(BOSS_PHASE2_MOLTEN_EMISSIVE);
            enemyBlockout.accentMaterial.emissiveIntensity = Math.max(
              1.9,
              simEnemy.emissiveIntensity * 2.0,
            );
            if (enemyBlockout.crackMaterial) {
              enemyBlockout.crackMaterial.color.copy(BOSS_PHASE2_MOLTEN_EMISSIVE);
              enemyBlockout.crackMaterial.opacity = 0.96;
            }
          } else {
            enemyBlockout.accentMaterial.emissive.copy(BOSS_PHASE1_EMISSIVE);
            enemyBlockout.accentMaterial.emissiveIntensity = 1.1;
            if (enemyBlockout.crackMaterial) {
              enemyBlockout.crackMaterial.color.copy(BOSS_PHASE1_EMISSIVE);
              enemyBlockout.crackMaterial.opacity = 0.42;
            }
          }
        }

        // Instanced World HP Bar above enemy (billboarded toward active camera)
        if (hpBarIndex < MAX_INSTANCED_HP_BARS && simEnemy.hp > 0) {
          const hpRatio = THREE.MathUtils.clamp(
            simEnemy.maxHp > 0 ? simEnemy.hp / simEnemy.maxHp : 0,
            0.02,
            1,
          );
          const barY = simEnemy.position.y + def.blockout.healthBarOffsetHeightM;
          const barScaleWidth = simEnemy.isBoss ? 1.85 : 1.0;

          _dummyObj.position.set(simEnemy.position.x, barY, simEnemy.position.z);
          if (hasBillboardCam) _dummyObj.quaternion.copy(_quat);
          else _dummyObj.quaternion.identity();
          _dummyObj.scale.set(barScaleWidth, simEnemy.isBoss ? 1.35 : 1, 1);
          _dummyObj.updateMatrix();
          hpBgInstancedMesh.setMatrixAt(hpBarIndex, _dummyObj.matrix);

          // Left-aligned fill bar slightly in front of the backing bar along viewer axis
          const fillOffset = -0.15 * barScaleWidth * (1 - hpRatio);
          _dummyObj.position.set(
            simEnemy.position.x + _vecMid.x * fillOffset + _dir.x * 0.003,
            barY + _vecMid.y * fillOffset + _dir.y * 0.003,
            simEnemy.position.z + _vecMid.z * fillOffset + _dir.z * 0.003,
          );
          _dummyObj.scale.set(barScaleWidth * hpRatio, simEnemy.isBoss ? 1.35 : 1, 1);
          _dummyObj.updateMatrix();
          hpFillInstancedMesh.setMatrixAt(hpBarIndex, _dummyObj.matrix);

          if (simEnemy.isBoss) {
            _color.setHex(simEnemy.isBossPhase2 ? 0xff4d00 : 0xec4899);
          } else if (hpRatio > 0.6) {
            _color.setHex(0x22c55e);
          } else if (hpRatio > 0.3) {
            _color.setHex(0xf59e0b);
          } else {
            _color.setHex(0xef4444);
          }
          hpFillInstancedMesh.setColorAt(hpBarIndex, _color);
          hpBarIndex += 1;
        }
      }

      for (const [id, record] of enemiesMap.entries()) {
        if (!seenEnemies.has(id)) {
          enemiesGroup.remove(record.group);
          disposeEntityCleanup(`enemy:${id}`);
          enemiesMap.delete(id);
        }
      }

      // Apply enemy-hit flashes for enemies created during this very frame
      if (events.length > 0) {
        for (const ev of events) {
          if (ev.type === 'enemy-hit') {
            const eb = enemiesMap.get(ev.enemyId);
            if (eb && eb.hitFlashSec === 0) {
              eb.hitFlashSec = 0.1;
              eb.primaryMaterial.emissive.setHex(0xffffff);
              eb.primaryMaterial.emissiveIntensity = 0.8;
            }
          }
        }
      }

      hpBgInstancedMesh.count = hpBarIndex;
      hpFillInstancedMesh.count = hpBarIndex;
      hpBgInstancedMesh.instanceMatrix.needsUpdate = true;
      hpFillInstancedMesh.instanceMatrix.needsUpdate = true;
      if (hpFillInstancedMesh.instanceColor) {
        hpFillInstancedMesh.instanceColor.needsUpdate = true;
      }

      // 5. Update Pooled Instanced Weapon FX
      // 5a. Kinetic Autocannon Tracers
      let tracerWrite = 0;
      for (let i = 0; i < activeTracers.length; i += 1) {
        const tr = activeTracers[i];
        if (!tr) continue;
        tr.elapsedSec += stepDt;
        if (tr.elapsedSec >= tr.durationSec) continue;

        const t0 = Math.max(0, tr.elapsedSec / tr.durationSec - 0.35);
        const t1 = Math.min(1, tr.elapsedSec / tr.durationSec + 0.35);
        const segStart: Vec3 = {
          x: tr.from.x + (tr.to.x - tr.from.x) * t0,
          y: tr.from.y + (tr.to.y - tr.from.y) * t0,
          z: tr.from.z + (tr.to.z - tr.from.z) * t0,
        };
        const segEnd: Vec3 = {
          x: tr.from.x + (tr.to.x - tr.from.x) * t1,
          y: tr.from.y + (tr.to.y - tr.from.y) * t1,
          z: tr.from.z + (tr.to.z - tr.from.z) * t1,
        };
        orientSegmentMatrix(segStart, segEnd, 0.014, _mat4);
        tracerInstancedMesh.setMatrixAt(tracerWrite, _mat4);
        activeTracers[tracerWrite] = tr;
        tracerWrite += 1;
      }
      activeTracers.length = tracerWrite;
      tracerInstancedMesh.count = tracerWrite;
      tracerInstancedMesh.instanceMatrix.needsUpdate = true;

      // 5b. Live Mortar Plasma Shells (synced from snapshot.projectiles)
      let shellCount = 0;
      for (const proj of snapshot.projectiles) {
        if (shellCount >= MAX_INSTANCED_MORTAR_SHELLS) break;
        _dummyObj.position.set(proj.position.x, proj.position.y, proj.position.z);
        _dummyObj.quaternion.identity();
        const radius = proj.tier === 'T3' ? 0.068 : proj.tier === 'T2' ? 0.056 : 0.046;
        _dummyObj.scale.setScalar(radius);
        _dummyObj.updateMatrix();
        mortarShellInstancedMesh.setMatrixAt(shellCount, _dummyObj.matrix);
        shellCount += 1;
      }
      mortarShellInstancedMesh.count = shellCount;
      mortarShellInstancedMesh.instanceMatrix.needsUpdate = true;

      // 5c. Mortar AoE Blast & EMP Shockwave Rings
      let ringWrite = 0;
      for (let i = 0; i < activeBlastRings.length; i += 1) {
        const ring = activeBlastRings[i];
        if (!ring) continue;
        ring.elapsedSec += stepDt;
        if (ring.elapsedSec >= ring.durationSec) continue;

        const progress = THREE.MathUtils.clamp(ring.elapsedSec / ring.durationSec, 0.08, 1);
        const radius = ring.maxRadiusM * progress;
        _dummyObj.position.set(ring.position.x, ring.position.y + 0.02, ring.position.z);
        _dummyObj.quaternion.identity();
        _dummyObj.scale.setScalar(radius);
        _dummyObj.updateMatrix();
        blastRingInstancedMesh.setMatrixAt(ringWrite, _dummyObj.matrix);
        _color.setHex(ring.colorHex);
        blastRingInstancedMesh.setColorAt(ringWrite, _color);
        activeBlastRings[ringWrite] = ring;
        ringWrite += 1;
      }
      activeBlastRings.length = ringWrite;
      blastRingInstancedMesh.count = ringWrite;
      blastRingInstancedMesh.instanceMatrix.needsUpdate = true;
      if (blastRingInstancedMesh.instanceColor) {
        blastRingInstancedMesh.instanceColor.needsUpdate = true;
      }

      // 5d. Cryo-Arc Jagged Chain-Lightning Beams
      let cryoWrite = 0;
      for (let i = 0; i < activeCryoSegments.length; i += 1) {
        const seg = activeCryoSegments[i];
        if (!seg) continue;
        seg.elapsedSec += stepDt;
        if (seg.elapsedSec >= seg.durationSec) continue;
        const fade = 1 - seg.elapsedSec / seg.durationSec;
        orientSegmentMatrix(seg.from, seg.to, seg.thicknessM * (0.5 + 0.5 * fade), _mat4);
        cryoArcInstancedMesh.setMatrixAt(cryoWrite, _mat4);
        activeCryoSegments[cryoWrite] = seg;
        cryoWrite += 1;
      }
      activeCryoSegments.length = cryoWrite;
      cryoArcInstancedMesh.count = cryoWrite;
      cryoArcInstancedMesh.instanceMatrix.needsUpdate = true;

      // 5e. Rail Sniper Piercing Beams
      let railWrite = 0;
      for (let i = 0; i < activeRailBeams.length; i += 1) {
        const beam = activeRailBeams[i];
        if (!beam) continue;
        beam.elapsedSec += stepDt;
        if (beam.elapsedSec >= beam.durationSec) continue;
        const fade = 1 - beam.elapsedSec / beam.durationSec;
        orientSegmentMatrix(beam.from, beam.to, beam.thicknessM * (0.45 + 0.55 * fade), _mat4);
        railBeamInstancedMesh.setMatrixAt(railWrite, _mat4);
        activeRailBeams[railWrite] = beam;
        railWrite += 1;
      }
      activeRailBeams.length = railWrite;
      railBeamInstancedMesh.count = railWrite;
      railBeamInstancedMesh.instanceMatrix.needsUpdate = true;

      fxCounts = {
        activeTracers: tracerWrite,
        activeMortarShells: shellCount,
        activeBlastRings: ringWrite,
        activeCryoSegments: cryoWrite,
        activeRailBeams: railWrite,
        activeHpBars: hpBarIndex,
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;

      entityDisposers.clear();
      for (const binding of depthBindings) {
        binding.dispose();
      }
      depthBindings.clear();
      for (const geo of ownedGeometries) {
        geo.dispose();
      }
      ownedGeometries.clear();
      for (const mat of ownedMaterials) {
        mat.dispose();
      }
      ownedMaterials.clear();

      tracerInstancedMesh.dispose();
      mortarShellInstancedMesh.dispose();
      blastRingInstancedMesh.dispose();
      cryoArcInstancedMesh.dispose();
      railBeamInstancedMesh.dispose();
      hpBgInstancedMesh.dispose();
      hpFillInstancedMesh.dispose();

      portalsMap.clear();
      turretsMap.clear();
      enemiesMap.clear();
      activeTracers.length = 0;
      activeBlastRings.length = 0;
      activeCryoSegments.length = 0;
      activeRailBeams.length = 0;

      root.clear();
      root.removeFromParent();
    },
  };
}
