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
 *    - Pooled kinetic tracers, mortar plasma shells and spherical blasts, cryo-arc jagged
 *      chain-lightning beams, rail sniper piercing beams, and EMP pulses driven by
 *      `SimEvent[]`.
 */

import * as THREE from 'three';
import {
  CORE_BASTION_SPEC,
  ENEMIES,
  type EnemyId,
  GAMEPLAY_OBJECT_SCALE,
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
import { enemyModelId, type RuntimeAssetLibrary, turretModelId } from './asset-loader.ts';
import type { LightingController } from './lighting.ts';
import { createRiftPortalShaderMaterial, type RiftPortalShaderUniforms } from './portal-shader.ts';
import { type CombatVfxPool, createCombatVfxPool } from './vfx-pool.ts';

export const MAX_INSTANCED_TRACERS = 64;
export const MAX_INSTANCED_MORTAR_SHELLS = 32;
export const MAX_INSTANCED_CRYO_SEGMENTS = 64;
export const MAX_INSTANCED_RAIL_BEAMS = 24;
export const MAX_INSTANCED_HP_BARS = MAX_ACTIVE_ENEMIES + 8;

const CRYO_SUBSEGMENTS_PER_LINK = 3;
/** Helios Plasma Mortar GLBs are authored with their crucible tilted +35° upward at rest. */
const HELIOS_MORTAR_REST_ASCENT_RAD = (35 * Math.PI) / 180;

/**
 * Approximate distance covered by one authored locomotion cycle. These values use the
 * approved neutral envelopes as the stride reference, keeping clip playback in the
 * same scale as the simulation instead of adding an arbitrary speed multiplier.
 */
const ENEMY_LOCOMOTION_STRIDE_M: Readonly<Record<EnemyId, number>> = {
  'skitter-crawler': 0.34,
  'wasp-skimmer': 0.42,
  'carapace-brute': 0.52,
  'rift-disruptor': 0.32,
  'rift-spitter': 0.4,
  'apex-broodlord': 0.92,
};

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
  readonly upgradeBarGroup: THREE.Group;
  readonly upgradeBarFill: THREE.Mesh;
  readonly healthBarGroup: THREE.Group;
  readonly healthBarFill: THREE.Mesh;
  recoilOffsetM: number;
  rotarySpinAngle: number;
  isDisrupted: boolean;
  yaw: number;
  pitch: number;
  upgradeAnimationRemainingSec: number;
  upgradeAnimationDurationSec: number;
  upgradeReemergeRemainingSec: number;
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
  isCryoSlowed: boolean;
  isBossPhase2: boolean;
  slowFactor: number;
  emissiveIntensity: number;
  hitFlashSec: number;
  locomotionPhase: number;
  readonly lastTangent: THREE.Vector3;
}

export interface WeaponFxCounts {
  readonly activeTracers: number;
  readonly activeMortarShells: number;
  readonly activeBlastSpheres: number;
  readonly activeCryoSegments: number;
  readonly activeRailBeams: number;
  readonly activeHpBars: number;
}

export interface BlockoutRendererOptions {
  /** Whether to patch blockout materials with WebXR depth-sensing occlusion when `occlusion` is provided (default `true`). */
  readonly enableDepthOcclusion?: boolean;
  /** Promoted Phase 4 GLB/KTX2 runtime asset library (falls back seamlessly to blockouts when omitted or loading). */
  readonly assets?: RuntimeAssetLibrary | null;
  /** Optional AAA lighting controller for transient dynamic combat explosion/impact lights. */
  readonly lighting?: LightingController | null;
}

export interface BlockoutRenderer {
  readonly root: THREE.Group;
  readonly coreBastion: CoreBastionBlockout;
  readonly portalsGroup: THREE.Group;
  readonly turretsGroup: THREE.Group;
  readonly enemiesGroup: THREE.Group;
  readonly fxGroup: THREE.Group;
  readonly healthBarsGroup: THREE.Group;
  readonly vfx: CombatVfxPool;
  readonly portals: ReadonlyMap<string, RiftPortalBlockout>;
  readonly turrets: ReadonlyMap<string, TurretBlockout>;
  readonly enemies: ReadonlyMap<string, EnemyBlockout>;
  readonly fxCounts: Readonly<WeaponFxCounts>;
  readonly tracerInstancedMesh: THREE.InstancedMesh;
  readonly mortarShellInstancedMesh: THREE.InstancedMesh;
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
const _hpViewPosition = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _color = new THREE.Color();

const CRYO_FROST_COLOR = new THREE.Color(0x22d3ee);
const BOSS_PHASE1_EMISSIVE = new THREE.Color(0xec4899);
const BOSS_PHASE2_MOLTEN_EMISSIVE = new THREE.Color(0xff4d00);
/** Small room-side bias after the scaled rim's back face meets the host plane. */
const PORTAL_HOST_CONTACT_BIAS_M = 0.002;

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
  const assets = options.assets ?? null;
  const lighting = options.lighting ?? null;

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
  const vfx = createCombatVfxPool(fxGroup, useDepthOcclusion ? occlusion : null);

  // ==========================================================================
  // AAA Runtime Asset View State (upgraded live as soon as `assets.ready` is true)
  // ==========================================================================
  const TURRET_LOD1_DIST_SQ = 4.0 * 4.0;
  const ENEMY_LOD1_DIST_SQ = 4.5 * 4.5;
  const ENEMY_ANIM_THROTTLE_DIST_SQ = 6.0 * 6.0;
  const _camWorldPos = new THREE.Vector3();

  interface CoreAssetView {
    readonly root: THREE.Group;
    readonly mixer: THREE.AnimationMixer;
    readonly clips: readonly THREE.AnimationClip[];
    readonly bindings: DepthOcclusionBinding[];
    currentClip: string;
    oneShotRemainingSec: number;
  }

  interface PortalAssetView {
    readonly root: THREE.Group;
    readonly mixer: THREE.AnimationMixer;
    readonly clips: readonly THREE.AnimationClip[];
    readonly interiorNode: THREE.Object3D | null;
    readonly shaderMat: THREE.ShaderMaterial | null;
    readonly vortexMap: THREE.Texture | null;
    readonly bindings: DepthOcclusionBinding[];
    wasOpen: boolean;
    shaderTime: number;
    surgeRemainingSec: number;
    currentClip: string;
  }

  interface TurretAssetView {
    readonly container: THREE.Group;
    readonly headRoot: THREE.Group;
    readonly mountRoot: THREE.Group;
    readonly mountMixer: THREE.AnimationMixer | null;
    readonly mountClips: readonly THREE.AnimationClip[];
    readonly headYawRing: THREE.Object3D | null;
    readonly headPitchCradle: THREE.Object3D | null;
    readonly headRecoilGroup: THREE.Object3D | null;
    readonly headRotaryCluster: THREE.Object3D | null;
    readonly headMuzzleSocket: THREE.Object3D | null;
    readonly materials: THREE.MeshStandardMaterial[];
    readonly bindings: DepthOcclusionBinding[];
    tier: TurretTierId;
    mountProfile: TurretMountProfileId;
    lod: 0 | 1;
    mountClip: string;
    mountDeployRemainingSec: number;
    upgradeSpinRemainingSec: number;
  }

  interface EnemyAssetView {
    readonly root: THREE.Group;
    readonly mixer: THREE.AnimationMixer;
    readonly clips: readonly THREE.AnimationClip[];
    readonly materials: THREE.MeshStandardMaterial[];
    readonly baseEmissiveMaps: (THREE.Texture | null)[];
    readonly baseEmissiveColors: THREE.Color[];
    readonly bindings: DepthOcclusionBinding[];
    lod: 0 | 1;
    currentClip: string;
    oneShotRemainingSec: number;
    phase2Applied: boolean;
    throttleFlip: boolean;
  }

  let coreAssetView: CoreAssetView | null = null;
  const portalAssetViews = new Map<string, PortalAssetView>();
  const turretAssetViews = new Map<string, TurretAssetView>();
  const enemyAssetViews = new Map<string, EnemyAssetView>();

  function bindGlbMaterials(
    obj: THREE.Object3D,
    role: 'world-object' | 'portal-rim' | 'portal-interior',
    outBindings: DepthOcclusionBinding[],
    outStdMats?: THREE.MeshStandardMaterial[],
  ): void {
    obj.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (const mat of mats) {
        if (!mat) continue;
        if (outStdMats && mat instanceof THREE.MeshStandardMaterial) {
          outStdMats.push(mat);
        }
        if (useDepthOcclusion && occlusion) {
          const binding =
            role === 'portal-rim'
              ? configurePortalRimMaterial(mat, occlusion)
              : role === 'portal-interior'
                ? configurePortalInteriorMaterial(mat, occlusion)
                : applyDepthOcclusion(mat, occlusion, { role: 'world-object' });
          outBindings.push(binding);
        }
      }
    });
  }

  function disposeClonedGlb(
    obj: THREE.Object3D,
    bindings: DepthOcclusionBinding[],
    extraTextures?: readonly (THREE.Texture | null)[],
  ): void {
    for (const b of bindings) b.dispose();
    bindings.length = 0;
    obj.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (const mat of mats) mat?.dispose();
    });
    if (extraTextures) {
      for (const tex of extraTextures) tex?.dispose();
    }
    obj.removeFromParent();
  }

  function playMixerClip(
    mixer: THREE.AnimationMixer,
    clips: readonly THREE.AnimationClip[],
    name: string,
    loop = true,
  ): THREE.AnimationClip | null {
    const clip = clips.find((c) => c.name === name) ?? clips[0];
    if (!clip) return null;
    mixer.stopAllAction();
    const action = mixer.clipAction(clip);
    action.reset();
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Number.POSITIVE_INFINITY : 1);
    action.clampWhenFinished = !loop;
    action.play();
    return clip;
  }

  function ensureCoreAsset(): void {
    if (coreAssetView || !assets?.ready || !assets.hasModel('core-bastion', 0)) return;
    const inst = assets.instantiate('core-bastion', 0);
    if (!inst) return;
    const bindings: DepthOcclusionBinding[] = [];
    bindGlbMaterials(inst.root, 'world-object', bindings);
    inst.root.name = 'aaa-core-bastion-glb';
    coreBastion.group.add(inst.root);
    // Hide blockout primitives while keeping contact shadow & shield dome reactive FX
    coreBastion.pedestalMesh.visible = false;
    coreBastion.energyCoreMesh.visible = false;
    const collar = coreBastion.group.getObjectByName('core-bastion-collar');
    if (collar) collar.visible = false;

    const mixer = new THREE.AnimationMixer(inst.root);
    playMixerClip(mixer, inst.animations, 'idle_pulse', true);
    coreAssetView = {
      root: inst.root,
      mixer,
      clips: inst.animations,
      bindings,
      currentClip: 'idle_pulse',
      oneShotRemainingSec: 0,
    };
  }

  function ensurePortalAsset(portal: RiftPortalBlockout): PortalAssetView | null {
    const existing = portalAssetViews.get(portal.id);
    if (existing) return existing;
    if (!assets?.ready || !assets.hasModel('rift-portal', 0)) return null;
    const inst = assets.instantiate('rift-portal', 0);
    if (!inst) return null;

    const bindings: DepthOcclusionBinding[] = [];
    let interiorNode: THREE.Object3D | null = null;
    let shaderMat: THREE.ShaderMaterial | null = null;
    let vortexMap: THREE.Texture | null = null;

    inst.root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      if (node.name === 'portalInterior') {
        interiorNode = node;
        const oldMat = Array.isArray(node.material) ? node.material[0] : node.material;
        vortexMap =
          oldMat instanceof THREE.MeshStandardMaterial
            ? (oldMat.emissiveMap ?? oldMat.map ?? null)
            : oldMat instanceof THREE.MeshBasicMaterial
              ? (oldMat.map ?? null)
              : null;
        shaderMat = createRiftPortalShaderMaterial({
          vortexMap,
          initialOpen: portal.isOpen ? 1 : 0,
        });
        node.material = shaderMat;
        node.castShadow = false;
        node.receiveShadow = false;
        if (oldMat) oldMat.dispose();
        if (useDepthOcclusion && occlusion) {
          bindings.push(configurePortalInteriorMaterial(shaderMat, occlusion));
        }
      } else {
        const mats = Array.isArray(node.material) ? node.material : [node.material];
        for (const mat of mats) {
          if (mat && useDepthOcclusion && occlusion) {
            bindings.push(configurePortalRimMaterial(mat, occlusion));
          }
        }
      }
    });

    inst.root.name = `aaa-rift-portal-${portal.id}`;
    portal.group.add(inst.root);
    portal.frameMesh.visible = false;
    portal.interiorMesh.visible = false;
    portal.vortexRingMesh.visible = false;

    const mixer = new THREE.AnimationMixer(inst.root);
    const startClip = portal.isOpen ? 'idle_rift' : 'close_seal';
    playMixerClip(mixer, inst.animations, startClip, portal.isOpen);
    if (!portal.isOpen) {
      mixer.update(5);
    }

    const view: PortalAssetView = {
      root: inst.root,
      mixer,
      clips: inst.animations,
      interiorNode,
      shaderMat,
      vortexMap,
      bindings,
      wasOpen: portal.isOpen,
      shaderTime: portal.portalIndex * 1.3,
      surgeRemainingSec: 0,
      currentClip: startClip,
    };
    portalAssetViews.set(portal.id, view);
    return view;
  }

  function disposePortalAsset(id: string): void {
    const view = portalAssetViews.get(id);
    if (!view) return;
    view.mixer.stopAllAction();
    disposeClonedGlb(view.root, view.bindings);
    portalAssetViews.delete(id);
  }

  function disposeTurretAsset(id: string): void {
    const view = turretAssetViews.get(id);
    if (!view) return;
    view.mountMixer?.stopAllAction();
    disposeClonedGlb(view.container, view.bindings);
    turretAssetViews.delete(id);
  }

  function ensureTurretAsset(
    turret: TurretBlockout,
    simTurret: SimTurret,
    desiredLod: 0 | 1,
  ): TurretAssetView | null {
    if (!assets?.ready) return null;
    const existing = turretAssetViews.get(turret.id);
    const upgraded = Boolean(existing && existing.tier !== simTurret.tier);
    if (
      existing &&
      existing.tier === simTurret.tier &&
      existing.mountProfile === simTurret.mountProfile &&
      existing.lod === desiredLod
    ) {
      return existing;
    }

    const headId = turretModelId(simTurret.kind, simTurret.tier);
    const mountId = simTurret.mountProfile === 'hover-pod' ? 'hover-pod' : 'surface-clamp';
    if (!assets.hasModel(headId, desiredLod) || !assets.hasModel(mountId, desiredLod)) {
      return existing ?? null;
    }

    const prevDeploy = existing?.mountDeployRemainingSec ?? 0;
    const isBrandNew = !existing;
    if (existing) disposeTurretAsset(turret.id);

    const headInst = assets.instantiate(headId, desiredLod);
    const mountInst = assets.instantiate(mountId, desiredLod);
    if (!headInst || !mountInst) return null;

    const container = new THREE.Group();
    container.name = `aaa-turret-${turret.id}`;
    container.add(mountInst.root, headInst.root);

    const bindings: DepthOcclusionBinding[] = [];
    const materials: THREE.MeshStandardMaterial[] = [];
    bindGlbMaterials(container, 'world-object', bindings, materials);

    turret.group.add(container);
    turret.clampMountGroup.visible = false;
    turret.hoverPodGroup.visible = false;
    turret.yawRing.visible = false;

    const mountMixer =
      mountInst.animations.length > 0 ? new THREE.AnimationMixer(mountInst.root) : null;
    let mountClip = '';
    let mountDeployRemainingSec = prevDeploy;
    if (mountMixer) {
      const deployName = mountId === 'hover-pod' ? 'deploy_ignite' : 'deploy_lock';
      const idleName = mountId === 'hover-pod' ? 'hover_idle' : 'idle_locked';
      if (isBrandNew) {
        const clip = playMixerClip(mountMixer, mountInst.animations, deployName, false);
        mountClip = clip?.name ?? deployName;
        mountDeployRemainingSec = clip?.duration ?? 1.0;
      } else {
        const clip = playMixerClip(mountMixer, mountInst.animations, idleName, true);
        mountClip = clip?.name ?? idleName;
      }
    }

    const view: TurretAssetView = {
      container,
      headRoot: headInst.root,
      mountRoot: mountInst.root,
      mountMixer,
      mountClips: mountInst.animations,
      headYawRing: headInst.root.getObjectByName('yawRing') ?? null,
      headPitchCradle: headInst.root.getObjectByName('pitchCradle') ?? null,
      headRecoilGroup: headInst.root.getObjectByName('recoilGroup') ?? null,
      headRotaryCluster: headInst.root.getObjectByName('rotaryCluster') ?? null,
      headMuzzleSocket: headInst.root.getObjectByName('muzzleSocket') ?? null,
      materials,
      bindings,
      tier: simTurret.tier,
      mountProfile: simTurret.mountProfile,
      lod: desiredLod,
      mountClip,
      mountDeployRemainingSec,
      upgradeSpinRemainingSec: upgraded ? 0.65 : 0,
    };
    turretAssetViews.set(turret.id, view);
    return view;
  }

  function disposeEnemyAsset(id: string): void {
    const view = enemyAssetViews.get(id);
    if (!view) return;
    view.mixer.stopAllAction();
    disposeClonedGlb(view.root, view.bindings);
    enemyAssetViews.delete(id);
  }

  function defaultEnemyLocomotionClip(simEnemy: SimEnemy): string {
    switch (simEnemy.archetypeId) {
      case 'skitter-crawler':
      case 'rift-spitter':
        return simEnemy.locomotionMode === 'climb' ? 'climb_wall' : 'crawl_floor';
      case 'wasp-skimmer':
        return 'hover_fly';
      case 'carapace-brute':
        return 'stomp_walk';
      case 'rift-disruptor':
        return 'hover_glide';
      case 'apex-broodlord':
        return 'boss_march';
    }
  }

  function enemyLocomotionSpeed(simEnemy: SimEnemy, clip: THREE.AnimationClip | undefined): number {
    const strideM = ENEMY_LOCOMOTION_STRIDE_M[simEnemy.archetypeId];
    if (!clip || !Number.isFinite(strideM) || strideM <= 0 || clip.duration <= 0) return 1;
    return (
      (Math.max(0, simEnemy.effectiveSpeedMps) * clip.duration) / (strideM * GAMEPLAY_OBJECT_SCALE)
    );
  }

  function ensureEnemyAsset(
    enemy: EnemyBlockout,
    simEnemy: SimEnemy,
    desiredLod: 0 | 1,
  ): EnemyAssetView | null {
    if (!assets?.ready) return null;
    const existing = enemyAssetViews.get(enemy.id);
    if (existing && existing.lod === desiredLod) return existing;

    const modelId = enemyModelId(simEnemy.archetypeId);
    if (!assets.hasModel(modelId, desiredLod)) return existing ?? null;
    if (existing) disposeEnemyAsset(enemy.id);

    const inst = assets.instantiate(modelId, desiredLod);
    if (!inst) return null;

    const bindings: DepthOcclusionBinding[] = [];
    const materials: THREE.MeshStandardMaterial[] = [];
    bindGlbMaterials(inst.root, 'world-object', bindings, materials);

    const baseEmissiveMaps = materials.map((m) => m.emissiveMap);
    const baseEmissiveColors = materials.map((m) => m.emissive.clone());

    inst.root.name = `aaa-enemy-${enemy.id}`;
    enemy.group.add(inst.root);
    enemy.bodyGroup.visible = false;

    const mixer = new THREE.AnimationMixer(inst.root);
    const locoClip = defaultEnemyLocomotionClip(simEnemy);
    playMixerClip(mixer, inst.animations, locoClip, true);

    const view: EnemyAssetView = {
      root: inst.root,
      mixer,
      clips: inst.animations,
      materials,
      baseEmissiveMaps,
      baseEmissiveColors,
      bindings,
      lod: desiredLod,
      currentClip: locoClip,
      oneShotRemainingSec: 0,
      phase2Applied: false,
      throttleFlip: false,
    };
    enemyAssetViews.set(enemy.id, view);
    return view;
  }

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
  const contactShadowSize = 128;
  const contactShadowPixels = new Uint8Array(contactShadowSize * contactShadowSize * 4);
  for (let y = 0; y < contactShadowSize; y += 1) {
    for (let x = 0; x < contactShadowSize; x += 1) {
      const radius =
        Math.hypot(x + 0.5 - contactShadowSize / 2, y + 0.5 - contactShadowSize / 2) /
        (contactShadowSize / 2);
      const fade = 1 - THREE.MathUtils.smoothstep(radius, 0.25, 0.96);
      contactShadowPixels[(y * contactShadowSize + x) * 4 + 3] = Math.round(255 * fade);
    }
  }
  const coreContactShadowMap = new THREE.DataTexture(
    contactShadowPixels,
    contactShadowSize,
    contactShadowSize,
  );
  coreContactShadowMap.magFilter = THREE.LinearFilter;
  coreContactShadowMap.minFilter = THREE.LinearFilter;
  coreContactShadowMap.needsUpdate = true;

  function createCoreBastion(): CoreBastionBlockout {
    const group = new THREE.Group();
    group.name = 'blockout-core-bastion';
    group.scale.setScalar(GAMEPLAY_OBJECT_SCALE);
    const shadowDiameter = CORE_BASTION_SPEC.shieldDomeRadiusM * 2.15;
    // Skip low-res WebXR depth-row discard on the grounded contact shadow so Quest depth rows
    // never slice horizontal banding lines across the Core floor shadow.
    const contact = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(shadowDiameter, shadowDiameter)),
      trackMat(
        new THREE.MeshBasicMaterial({
          map: coreContactShadowMap,
          opacity: 0.31,
          transparent: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        }),
        'none',
      ),
    );
    contact.name = 'core-bastion-contact-shadow';
    contact.rotation.x = -Math.PI / 2;
    contact.position.y = 0.007;
    group.add(contact);

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
    group.scale.setScalar(GAMEPLAY_OBJECT_SCALE);
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
      apertureMaskMesh = createPortalApertureMaskMesh(
        {
          ...portalAperture,
          radius: apertureRadius * GAMEPLAY_OBJECT_SCALE,
          radiusX: radiusX * GAMEPLAY_OBJECT_SCALE,
          radiusY: radiusY * GAMEPLAY_OBJECT_SCALE,
        },
        occlusion,
      );
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
    group.scale.setScalar(GAMEPLAY_OBJECT_SCALE);
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

    // The bar is attached to the turret so it follows wall/ceiling mounts without
    // allocating per-frame geometry. Its fill scale is updated from sim progress.
    const upgradeBarGroup = new THREE.Group();
    upgradeBarGroup.name = 'turret-upgrade-progress';
    upgradeBarGroup.position.y = b.totalHeightM + 0.14;
    const upgradeBarBg = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(0.28, 0.026)),
      trackMat(
        new THREE.MeshBasicMaterial({
          color: 0x111827,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
        }),
        'world-object',
        entityMats,
        entityBindings,
      ),
    );
    upgradeBarBg.name = 'turret-upgrade-progress-bg';
    const upgradeBarFill = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(0.26, 0.016)),
      trackMat(
        new THREE.MeshBasicMaterial({
          color: 0x22d3ee,
          transparent: true,
          opacity: 0.98,
          depthWrite: false,
        }),
        'world-object',
        entityMats,
        entityBindings,
      ),
    );
    upgradeBarFill.name = 'turret-upgrade-progress-fill';
    upgradeBarFill.position.z = 0.002;
    upgradeBarGroup.add(upgradeBarBg, upgradeBarFill);
    upgradeBarGroup.visible = false;
    group.add(upgradeBarGroup);

    const healthBarGroup = new THREE.Group();
    healthBarGroup.name = 'turret-health';
    healthBarGroup.position.y = b.totalHeightM + 0.14;
    const healthBarBg = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(0.28, 0.026)),
      trackMat(
        new THREE.MeshBasicMaterial({
          color: 0x111827,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
        }),
        'world-object',
        entityMats,
        entityBindings,
      ),
    );
    healthBarBg.name = 'turret-health-bg';
    const healthBarFill = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(0.26, 0.016)),
      trackMat(
        new THREE.MeshBasicMaterial({
          color: 0xef4444,
          transparent: true,
          opacity: 0.98,
          depthWrite: false,
        }),
        'world-object',
        entityMats,
        entityBindings,
      ),
    );
    healthBarFill.name = 'turret-health-fill';
    healthBarFill.position.z = 0.002;
    healthBarGroup.add(healthBarBg, healthBarFill);
    healthBarGroup.visible = false;
    group.add(healthBarGroup);

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
      upgradeBarGroup,
      upgradeBarFill,
      healthBarGroup,
      healthBarFill,
      recoilOffsetM: 0,
      rotarySpinAngle: 0,
      isDisrupted: simTurret.isDisrupted,
      yaw: simTurret.yaw,
      pitch: simTurret.pitch,
      upgradeAnimationRemainingSec: 0,
      upgradeAnimationDurationSec: 0.65,
      upgradeReemergeRemainingSec: 0,
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
    group.scale.setScalar(GAMEPLAY_OBJECT_SCALE);
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
    } else if (simEnemy.archetypeId === 'rift-spitter') {
      // Ranged Rift Spitter: olive armored shell with a lime luminous firing chamber.
      const shell = new THREE.Mesh(sharedOctaGeo, primaryMaterial);
      shell.name = 'spitter-shell';
      shell.scale.set(b.widthM * 0.46, b.heightM * 0.52, b.lengthM * 0.5);
      shell.position.set(0, b.heightM * 0.5, 0);
      shell.castShadow = true;
      bodyGroup.add(shell);

      const chamber = new THREE.Mesh(sharedOctaGeo, accentMaterial);
      chamber.name = 'spitter-luminous-chamber';
      chamber.scale.set(b.widthM * 0.22, b.heightM * 0.24, b.lengthM * 0.2);
      chamber.position.set(0, b.heightM * 0.52, b.lengthM * 0.42);
      bodyGroup.add(chamber);

      const vent = new THREE.Mesh(sharedTorusGeo, accentMaterial);
      vent.name = 'spitter-chamber-ring';
      vent.scale.setScalar(b.widthM * 0.3);
      vent.rotation.x = Math.PI / 2;
      vent.position.copy(chamber.position);
      bodyGroup.add(vent);
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

    registerEntityCleanup(`enemy:${simEnemy.id}`, [], entityMats, entityBindings);
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
      isCryoSlowed: simEnemy.slowFactor > 0,
      isBossPhase2: simEnemy.isBossPhase2,
      slowFactor: simEnemy.slowFactor,
      emissiveIntensity: simEnemy.emissiveIntensity,
      hitFlashSec: 0,
      locomotionPhase: 0,
      lastTangent: new THREE.Vector3(),
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
      opacity: 0.55,
      depthWrite: false,
    }),
  );
  const hpBarFillMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.98,
      depthWrite: false,
    }),
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
    cryoArcInstancedMesh,
    railBeamInstancedMesh,
  );

  const activeTracers: ActiveTracerFx[] = [];
  const activeCryoSegments: ActiveBeamSegmentFx[] = [];
  const activeRailBeams: ActiveBeamSegmentFx[] = [];
  const mortarVisualOffsets = new Map<string, Vec3>();

  function resolveTurretMuzzleWorldPosition(turretId: string, fallback: Readonly<Vec3>): Vec3 {
    const view = turretAssetViews.get(turretId);
    if (view?.headMuzzleSocket) {
      view.container.updateWorldMatrix(true, true);
      view.headMuzzleSocket.getWorldPosition(_vecA);
      return { x: _vecA.x, y: _vecA.y, z: _vecA.z };
    }
    return { x: fallback.x, y: fallback.y, z: fallback.z };
  }

  let fxCounts: WeaponFxCounts = {
    activeTracers: 0,
    activeMortarShells: 0,
    activeBlastSpheres: 0,
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
      if ((ev as SimEvent & { type: string }).type === 'enemy-ranged-fired') {
        const rangedEvent = ev as SimEvent & {
          fromPosition: Vec3;
          toPosition: Vec3;
        };
        if (activeTracers.length >= MAX_INSTANCED_TRACERS) activeTracers.shift();
        activeTracers.push({
          from: { ...rangedEvent.fromPosition },
          to: { ...rangedEvent.toPosition },
          elapsedSec: 0,
          durationSec: 0.2,
          colorHex: 0xa3e635,
        });
        continue;
      }
      switch (ev.type) {
        case 'core-hit': {
          coreBastion.hitFlashRemainingSec = 0.35;
          if (coreAssetView) {
            const clip = playMixerClip(
              coreAssetView.mixer,
              coreAssetView.clips,
              'hit_flinch',
              false,
            );
            coreAssetView.currentClip = 'hit_flinch';
            coreAssetView.oneShotRemainingSec = clip?.duration ?? 0.8;
          }
          vfx.spawnShockRing(
            {
              x: coreBastion.group.position.x,
              y: coreBastion.group.position.y + 0.35 * GAMEPLAY_OBJECT_SCALE,
              z: coreBastion.group.position.z,
            },
            { x: 0, y: 1, z: 0 },
            CORE_BASTION_SPEC.shieldDomeRadiusM * 1.35 * GAMEPLAY_OBJECT_SCALE,
            0xff3b5c,
            0.38,
          );
          lighting?.flashPoint(
            {
              x: coreBastion.group.position.x,
              y: coreBastion.group.position.y + 0.5 * GAMEPLAY_OBJECT_SCALE,
              z: coreBastion.group.position.z,
            },
            0xff3b5c,
            3.5,
            3.0,
            0.3,
          );
          break;
        }
        case 'portal-opened':
        case 'enemy-spawned': {
          const portal = portalsMap.get(ev.portalId);
          if (portal) {
            portal.spawnFlashSec = 0.4;
          }
          const portalView = portalAssetViews.get(ev.portalId);
          if (portalView && ev.type === 'enemy-spawned') {
            const clip = playMixerClip(portalView.mixer, portalView.clips, 'spawn_surge', false);
            portalView.currentClip = 'spawn_surge';
            portalView.surgeRemainingSec = clip?.duration ?? 0.9;
          }
          break;
        }
        case 'turret-fired': {
          const shotOrigin = resolveTurretMuzzleWorldPosition(ev.turretId, ev.fromPosition);
          const turretBlockout = turretsMap.get(ev.turretId);
          if (turretBlockout) {
            turretBlockout.recoilOffsetM =
              ev.turretKind === 'rail-sniper'
                ? 0.055
                : ev.turretKind === 'plasma-mortar'
                  ? 0.045
                  : 0.025;
            turretBlockout.recoilGroup.position.z = -turretBlockout.recoilOffsetM;
            const turretView = turretAssetViews.get(ev.turretId);
            if (turretView?.headRecoilGroup) {
              turretView.headRecoilGroup.position.z = -turretBlockout.recoilOffsetM;
            }
          }

          if (ev.turretKind === 'autocannon') {
            if (activeTracers.length >= MAX_INSTANCED_TRACERS) activeTracers.shift();
            activeTracers.push({
              from: shotOrigin,
              to: { ...ev.toPosition },
              elapsedSec: 0,
              durationSec: 0.14,
              colorHex: 0xf59e0b,
            });
            vfx.spawnMuzzleFlash(shotOrigin, 0xfbbf24, ev.tier === 'T3' ? 0.11 : 0.08);
            const dx = ev.toPosition.x - shotOrigin.x;
            const dy = ev.toPosition.y - shotOrigin.y;
            const dz = ev.toPosition.z - shotOrigin.z;
            const len = Math.max(0.01, Math.hypot(dx, dy, dz));
            vfx.spawnShellCasing(shotOrigin, { x: dx / len, y: dy / len, z: dz / len });
            vfx.spawnImpactBurst(ev.toPosition, 0xf59e0b, 5, 1.6, 0.013);
          } else if (ev.turretKind === 'rail-sniper') {
            if (activeRailBeams.length >= MAX_INSTANCED_RAIL_BEAMS) activeRailBeams.shift();
            activeRailBeams.push({
              from: shotOrigin,
              to: { ...ev.toPosition },
              elapsedSec: 0,
              durationSec: 0.26,
              thicknessM: ev.tier === 'T3' ? 0.028 : ev.tier === 'T2' ? 0.022 : 0.017,
              colorHex: 0x7dd3fc,
            });
            vfx.spawnMuzzleFlash(shotOrigin, 0x7dd3fc, 0.13);
            vfx.spawnRailRings(shotOrigin, ev.toPosition, 0x7dd3fc);
            lighting?.flashPoint(ev.toPosition, 0x38bdf8, 3.2, 2.8, 0.22);
          } else if (ev.turretKind === 'cryo-arc') {
            spawnCryoJaggedLink(shotOrigin, ev.toPosition);
            vfx.spawnMuzzleFlash(shotOrigin, 0x22d3ee, 0.09);
            vfx.spawnImpactBurst(ev.toPosition, 0x67e8f9, 7, 1.4, 0.016);
          } else if (ev.turretKind === 'plasma-mortar') {
            vfx.spawnMuzzleFlash(shotOrigin, 0xff7b29, 0.12);
            if (ev.projectileId) {
              mortarVisualOffsets.set(ev.projectileId, {
                x: shotOrigin.x - ev.fromPosition.x,
                y: shotOrigin.y - ev.fromPosition.y,
                z: shotOrigin.z - ev.fromPosition.z,
              });
            }
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
              vfx.spawnImpactBurst(p1, 0x22d3ee, 4, 1.1, 0.014);
            }
          }
          break;
        }
        case 'projectile-impact': {
          vfx.spawnPlasmaExplosion(ev.position, Math.max(0.3, ev.aoeRadiusM));
          lighting?.flashPoint(ev.position, 0xff5722, 4.8, 3.6, 0.36);
          break;
        }
        case 'turret-disrupted': {
          vfx.spawnBlastSphere(ev.position, 1.25, 0x38bdf8, 0.45);
          lighting?.flashPoint(ev.position, 0x38bdf8, 3.6, 3.2, 0.35);
          const sourceView = enemyAssetViews.get(ev.sourceEnemyId);
          if (sourceView) {
            const clip = playMixerClip(sourceView.mixer, sourceView.clips, 'emp_pulse', false);
            sourceView.currentClip = 'emp_pulse';
            sourceView.oneShotRemainingSec = clip?.duration ?? 1.0;
          }
          break;
        }
        case 'boss-phase2': {
          vfx.spawnDeathBurst(ev.position, 0xff4d00, true);
          lighting?.flashPoint(ev.position, 0xff4d00, 6.0, 4.5, 0.65);
          const bossView = enemyAssetViews.get(ev.bossEnemyId);
          if (bossView) {
            const clip = playMixerClip(bossView.mixer, bossView.clips, 'phase2_shift', false);
            bossView.currentClip = 'phase2_shift';
            bossView.oneShotRemainingSec = clip?.duration ?? 1.5;
          }
          break;
        }
        case 'enemy-hit': {
          const enemyBlockout = enemiesMap.get(ev.enemyId);
          if (enemyBlockout) {
            enemyBlockout.hitFlashSec = 0.1;
          }
          const hitView = enemyAssetViews.get(ev.enemyId);
          if (hitView && hitView.oneShotRemainingSec <= 0 && !enemyBlockout?.isBoss) {
            const clip = playMixerClip(hitView.mixer, hitView.clips, 'hit', false);
            if (clip) {
              hitView.currentClip = 'hit';
              hitView.oneShotRemainingSec = Math.min(clip.duration, 0.35);
            }
          }
          break;
        }
        case 'enemy-killed': {
          const enemyDef = ENEMIES[ev.archetypeId];
          const burstColor = ev.archetypeId === 'apex-broodlord' ? 0xff4d00 : 0xa855f7;
          vfx.spawnDeathBurst(ev.position, burstColor, enemyDef.isBoss);
          if (enemyDef.isBoss) {
            lighting?.flashPoint(ev.position, 0xff4d00, 6.5, 5.0, 0.75);
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
    vfx,
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
    cryoArcInstancedMesh,
    railBeamInstancedMesh,
    hpBgInstancedMesh,
    hpFillInstancedMesh,

    syncFromSim(snapshot, events = [], dt = 0, camera = null) {
      if (disposed) return;

      const stepDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
      elapsedTotalSec += stepDt;

      // 1. Sync Core Bastion position, rotation, HP color, and `core-hit` shield flare
      ensureCoreAsset();
      if (camera) {
        camera.getWorldPosition(_camWorldPos);
      } else {
        _camWorldPos.set(0, 1.65, 3.2);
      }
      coreBastion.group.position.set(
        snapshot.corePosition.x,
        snapshot.corePosition.y,
        snapshot.corePosition.z,
      );
      lighting?.setCorePosition(snapshot.corePosition);
      coreBastion.lastHp = snapshot.coreHp;
      coreBastion.maxHp = snapshot.maxCoreHp;
      coreBastion.energyCoreMesh.rotation.y = elapsedTotalSec * 0.9;
      coreBastion.energyCoreMesh.position.y =
        CORE_BASTION_SPEC.heightM - 0.15 + Math.sin(elapsedTotalSec * 2.4) * 0.018;

      // Process core-hit before applying Core flash tint; defer weapon/entity events until
      // portals, turrets, and enemies have this tick's exact transforms and muzzle sockets.
      for (const ev of events) {
        if (ev.type === 'core-hit') {
          coreBastion.hitFlashRemainingSec = 0.35;
        }
      }

      if (coreBastion.hitFlashRemainingSec > 0) {
        coreBastion.hitFlashRemainingSec = Math.max(0, coreBastion.hitFlashRemainingSec - stepDt);
      }
      const coreHitFactor = coreBastion.hitFlashRemainingSec > 0 ? 1 : 0;
      const coreHpRatio =
        snapshot.maxCoreHp > 0 ? Math.max(0, snapshot.coreHp / snapshot.maxCoreHp) : 0;
      lighting?.setCoreState(coreHpRatio, coreHitFactor > 0);

      if (coreAssetView) {
        if (coreAssetView.oneShotRemainingSec > 0) {
          coreAssetView.oneShotRemainingSec = Math.max(
            0,
            coreAssetView.oneShotRemainingSec - stepDt,
          );
        }
        if (coreAssetView.oneShotRemainingSec <= 0) {
          const desiredClip =
            snapshot.phase === 'victory'
              ? 'victory_surge'
              : coreHpRatio < 0.35
                ? 'critical_overload'
                : 'idle_pulse';
          if (coreAssetView.currentClip !== desiredClip) {
            playMixerClip(coreAssetView.mixer, coreAssetView.clips, desiredClip, true);
            coreAssetView.currentClip = desiredClip;
          }
        }
        coreAssetView.mixer.update(stepDt);
      }

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
        const portalView = ensurePortalAsset(portalBlockout);
        _dir.set(simPortal.normal.x, simPortal.normal.y, simPortal.normal.z).normalize();
        if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, 1);
        _vecA.set(simPortal.position.x, simPortal.position.y, simPortal.position.z);
        if (!portalView && simPortal.hostKind !== 'virtual-rift') {
          // The procedural torus straddles its origin; the GLB flange is authored at Z=0.
          _vecA.addScaledVector(
            _dir,
            RIFT_PORTAL_SPEC.rimThicknessM * GAMEPLAY_OBJECT_SCALE * 0.5 +
              PORTAL_HOST_CONTACT_BIAS_M,
          );
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
          // The mask belongs on the scanned host plane. Only the visual rim is recessed
          // room-side, otherwise the occlusion cutout inherits the visual contact offset.
          portalBlockout.apertureMaskMesh.position.set(
            simPortal.position.x,
            simPortal.position.y,
            simPortal.position.z,
          );
          portalBlockout.apertureMaskMesh.quaternion.copy(portalBlockout.group.quaternion);
          portalBlockout.apertureMaskMesh.visible = simPortal.isOpen;
        }

        portalBlockout.pulsePhase += stepDt * (simPortal.isOpen ? 3.2 : 1.0);
        if (portalBlockout.spawnFlashSec > 0) {
          portalBlockout.spawnFlashSec = Math.max(0, portalBlockout.spawnFlashSec - stepDt);
        }

        if (portalView) {
          if (simPortal.isOpen && !portalView.wasOpen) {
            playMixerClip(portalView.mixer, portalView.clips, 'open_tear', false);
            portalView.currentClip = 'open_tear';
          } else if (!simPortal.isOpen && portalView.wasOpen) {
            playMixerClip(portalView.mixer, portalView.clips, 'close_seal', false);
            portalView.currentClip = 'close_seal';
          }
          portalView.wasOpen = simPortal.isOpen;

          if (portalView.surgeRemainingSec > 0) {
            portalView.surgeRemainingSec = Math.max(0, portalView.surgeRemainingSec - stepDt);
            if (portalView.surgeRemainingSec <= 0 && simPortal.isOpen) {
              playMixerClip(portalView.mixer, portalView.clips, 'idle_rift', true);
              portalView.currentClip = 'idle_rift';
            }
          }
          portalView.mixer.update(stepDt);

          if (portalView.shaderMat) {
            const uniforms = portalView.shaderMat.uniforms as RiftPortalShaderUniforms;
            portalView.shaderTime += stepDt;
            uniforms.uTime.value = portalView.shaderTime;
            const scaleOpen = portalView.interiorNode
              ? THREE.MathUtils.clamp(portalView.interiorNode.scale.x, 0, 1)
              : simPortal.isOpen
                ? 1
                : 0;
            uniforms.uOpen.value = simPortal.isOpen ? Math.max(0.02, scaleOpen) : scaleOpen;
            uniforms.uSurge.value = Math.min(
              1,
              portalView.surgeRemainingSec > 0
                ? Math.sin(Math.PI * Math.min(1, portalView.surgeRemainingSec / 0.9))
                : portalBlockout.spawnFlashSec * 2.0,
            );
          }
          if (portalView.interiorNode) {
            portalView.interiorNode.visible =
              simPortal.isOpen || portalView.interiorNode.scale.x > 0.01;
          }
        } else {
          portalBlockout.interiorMesh.visible = simPortal.isOpen;
          portalBlockout.vortexRingMesh.visible = simPortal.isOpen;
        }
        portalBlockout.frameMaterial.emissiveIntensity = simPortal.isOpen
          ? 1.15 + 0.35 * Math.sin(portalBlockout.pulsePhase) + portalBlockout.spawnFlashSec
          : 0.35;
        portalBlockout.interiorMaterial.opacity = simPortal.isOpen
          ? 0.78 + 0.14 * Math.sin(portalBlockout.pulsePhase * 1.3)
          : 0;
      }

      for (const [id, record] of portalsMap.entries()) {
        if (!seenPortals.has(id)) {
          disposePortalAsset(id);
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
      for (const ev of events) {
        const upgradeEvent = ev as SimEvent & {
          type: string;
          turretId?: string;
          durationSec?: number;
        };
        if (upgradeEvent.type !== 'turret-upgrade-started' || !upgradeEvent.turretId) continue;
        const record = turretsMap.get(upgradeEvent.turretId);
        if (record) {
          record.upgradeAnimationDurationSec = Math.max(0.1, upgradeEvent.durationSec ?? 0.65);
          record.upgradeAnimationRemainingSec = record.upgradeAnimationDurationSec;
          record.upgradeReemergeRemainingSec = 0;
        }
      }
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
          // The simulation changes tier on completion. Keep the completed silhouette
          // low for one short reveal so it rises smoothly instead of popping in.
          turretBlockout.upgradeAnimationRemainingSec = 0;
          turretBlockout.upgradeReemergeRemainingSec = 0.35;
        }

        const upgradeState = simTurret as SimTurret & {
          upgradeRemainingSec?: number;
          upgradeDurationSec?: number;
          upgradeTargetTier?: TurretTierId | null;
        };
        const simUpgradeDuration = upgradeState.upgradeDurationSec ?? 0;
        const simUpgradeRemaining = upgradeState.upgradeRemainingSec ?? 0;
        if (simUpgradeDuration > 0 && simUpgradeRemaining > 0) {
          turretBlockout.upgradeAnimationDurationSec = simUpgradeDuration;
          turretBlockout.upgradeAnimationRemainingSec = simUpgradeRemaining;
        } else if (turretBlockout.upgradeAnimationRemainingSec > 0) {
          turretBlockout.upgradeAnimationRemainingSec = Math.max(
            0,
            turretBlockout.upgradeAnimationRemainingSec - stepDt,
          );
        }
        turretBlockout.upgradeReemergeRemainingSec = Math.max(
          0,
          turretBlockout.upgradeReemergeRemainingSec - stepDt,
        );
        const upgrading =
          simUpgradeRemaining > 0 || turretBlockout.upgradeAnimationRemainingSec > 0;
        const upgradeProgress =
          simUpgradeDuration > 0
            ? THREE.MathUtils.clamp(1 - simUpgradeRemaining / simUpgradeDuration, 0, 1)
            : 1;
        const reemergeProgress =
          turretBlockout.upgradeReemergeRemainingSec > 0
            ? THREE.MathUtils.clamp(1 - turretBlockout.upgradeReemergeRemainingSec / 0.35, 0, 1)
            : 1;
        const sinkProgress = upgrading
          ? THREE.MathUtils.smoothstep(upgradeProgress, 0, 0.25)
          : 1 - THREE.MathUtils.smoothstep(reemergeProgress, 0, 1);
        const animatedBaseHeight = getTurretTierStats(simTurret.kind, simTurret.tier).blockout
          .baseHeightM;
        turretBlockout.yawRing.position.y = animatedBaseHeight * (1 - sinkProgress * 0.92);
        turretBlockout.upgradeBarGroup.visible = upgrading;
        turretBlockout.upgradeBarFill.scale.x = Math.max(0.001, upgradeProgress);
        turretBlockout.upgradeBarFill.position.x = -0.13 * (1 - upgradeProgress);
        const turretHp = (simTurret as SimTurret & { hp?: number; maxHp?: number }).hp;
        const turretMaxHp = (simTurret as SimTurret & { hp?: number; maxHp?: number }).maxHp;
        const turretHpRatio =
          turretMaxHp && turretMaxHp > 0 && turretHp !== undefined
            ? THREE.MathUtils.clamp(turretHp / turretMaxHp, 0, 1)
            : 1;
        const turretDamaged = turretHpRatio < 1 && turretHpRatio > 0;
        turretBlockout.healthBarGroup.visible = turretDamaged && !upgrading;
        turretBlockout.healthBarFill.scale.x = Math.max(0.001, turretHpRatio);
        turretBlockout.healthBarFill.position.x = -0.13 * (1 - turretHpRatio);

        // Mount base visibility (`surface-clamp` legs vs `hover-pod` repulsor ring)
        turretBlockout.mountProfile = simTurret.mountProfile;
        turretBlockout.group.userData.mountProfile = simTurret.mountProfile;
        const isHover = simTurret.mountProfile === 'hover-pod';

        const turretDistSq =
          (simTurret.position.x - _camWorldPos.x) ** 2 +
          (simTurret.position.y - _camWorldPos.y) ** 2 +
          (simTurret.position.z - _camWorldPos.z) ** 2;
        const desiredTurretLod: 0 | 1 = turretDistSq > TURRET_LOD1_DIST_SQ ? 1 : 0;
        const turretView = ensureTurretAsset(turretBlockout, simTurret, desiredTurretLod);
        if (turretView) {
          turretView.headRoot.position.y = -animatedBaseHeight * sinkProgress * 0.92;
        }
        if (!turretView) {
          turretBlockout.clampMountGroup.visible = !isHover;
          turretBlockout.hoverPodGroup.visible = isHover;
          turretBlockout.yawRing.visible = true;
        }

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
          if (simTurret.targetEnemyId && !simTurret.isDisrupted) {
            turretBlockout.rotarySpinAngle += stepDt * 18;
          }
          if (rotary) {
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

        // Drive AAA GLB Turret + Mount articulation & animations
        if (turretView) {
          if (turretView.upgradeSpinRemainingSec > 0) {
            turretView.upgradeSpinRemainingSec = Math.max(
              0,
              turretView.upgradeSpinRemainingSec - stepDt,
            );
          }
          const upgradeSpin =
            turretView.upgradeSpinRemainingSec > 0
              ? (1 - turretView.upgradeSpinRemainingSec / 0.65) * Math.PI * 2
              : 0;
          if (turretView.headYawRing) {
            const empTwitch = simTurret.isDisrupted ? Math.sin(elapsedTotalSec * 19) * 0.08 : 0;
            turretView.headYawRing.rotation.y = simTurret.yaw + upgradeSpin + empTwitch;
          }
          if (turretView.headPitchCradle) {
            if (simTurret.isDisrupted) {
              turretView.headPitchCradle.rotation.x = 0.34 + Math.sin(elapsedTotalSec * 14) * 0.04;
            } else if (simTurret.kind === 'plasma-mortar') {
              // Helios mortar GLBs are built with their crucible already inclined +35° upward.
              const glbPitch = THREE.MathUtils.clamp(
                simTurret.pitch - HELIOS_MORTAR_REST_ASCENT_RAD,
                -0.55,
                0.85,
              );
              turretView.headPitchCradle.rotation.x = -glbPitch;
            } else {
              turretView.headPitchCradle.rotation.x = -simTurret.pitch;
            }
          }
          if (turretView.headRecoilGroup) {
            turretView.headRecoilGroup.position.z = -turretBlockout.recoilOffsetM;
          }
          if (turretView.headRotaryCluster) {
            turretView.headRotaryCluster.rotation.z = turretBlockout.rotarySpinAngle;
          }
          for (const mat of turretView.materials) {
            mat.emissiveIntensity = simTurret.isDisrupted
              ? 0.22 + 0.12 * Math.sin(elapsedTotalSec * 22)
              : 1.25;
          }
          if (turretView.mountMixer) {
            if (turretView.mountDeployRemainingSec > 0) {
              turretView.mountDeployRemainingSec = Math.max(
                0,
                turretView.mountDeployRemainingSec - stepDt,
              );
            }
            if (turretView.mountDeployRemainingSec <= 0) {
              const targetMountClip =
                simTurret.mountProfile === 'hover-pod'
                  ? simTurret.isDisrupted
                    ? 'emp_stall'
                    : 'hover_idle'
                  : 'idle_locked';
              if (turretView.mountClip !== targetMountClip) {
                playMixerClip(turretView.mountMixer, turretView.mountClips, targetMountClip, true);
                turretView.mountClip = targetMountClip;
              }
            }
            turretView.mountMixer.update(stepDt);
          }
        }
      }

      for (const [id, record] of turretsMap.entries()) {
        if (!seenTurrets.has(id)) {
          disposeTurretAsset(id);
          turretsGroup.remove(record.group);
          disposeEntityCleanup(`turret:${id}`);
          turretsMap.delete(id);
        }
      }

      // 4. Sync 5 Invaders + Instanced World Health Bars
      const seenEnemies = new Set<string>();
      let hpBarIndex = 0;

      // Compute camera billboard orientation once for all enemy health bars
      const hasBillboardCam = Boolean(camera);
      if (camera) {
        camera.getWorldPosition(_hpViewPosition);
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

        // Surface crawlers follow the host normal. Aerial units stay upright and only
        // turn toward travel, so a portal's ceiling normal cannot invert their model.
        if (simEnemy.movementLayer === 'air') {
          _upAxis.set(0, 1, 0);
        } else {
          _upAxis.set(simEnemy.normal.x, simEnemy.normal.y, simEnemy.normal.z).normalize();
        }
        if (_upAxis.lengthSq() < 1e-6) _upAxis.set(0, 1, 0);
        _vecA.set(simEnemy.tangent.x, simEnemy.tangent.y, simEnemy.tangent.z);
        _vecA.addScaledVector(_upAxis, -_vecA.dot(_upAxis));
        if (_vecA.lengthSq() < 1e-6 && enemyBlockout.lastTangent.lengthSq() < 1e-6) {
          // A vertical entry tangent has no heading in the mount plane. Use the next
          // route tangent that does, so the loaded model faces the exit path on frame one.
          for (const waypoint of simEnemy.path.waypoints) {
            if (waypoint.cumulativeDistance < simEnemy.distanceAlongPath) continue;
            const { x, y, z } = waypoint.tangent;
            _vecA.set(x, y, z).addScaledVector(_upAxis, -_vecA.dot(_upAxis));
            if (_vecA.lengthSq() >= 1e-6) break;
          }
        }
        if (_vecA.lengthSq() < 1e-6) {
          _vecA.copy(enemyBlockout.lastTangent);
          _vecA.addScaledVector(_upAxis, -_vecA.dot(_upAxis));
        }
        if (_vecA.lengthSq() < 1e-6) {
          _vecA.set(0, 0, 1);
          _vecA.addScaledVector(_upAxis, -_vecA.dot(_upAxis));
        }
        if (_vecA.lengthSq() < 1e-6) _vecA.set(1, 0, 0);
        _vecA.normalize();
        _vecB.crossVectors(_upAxis, _vecA);
        if (_vecB.lengthSq() < 1e-6) {
          _vecB.set(1, 0, 0);
        } else {
          _vecB.normalize();
        }
        _vecA.crossVectors(_vecB, _upAxis).normalize();
        enemyBlockout.lastTangent.copy(_vecA);
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

        // Drive AAA Skinned & Animated Blender Invader GLB (with LOD & distance animation throttling)
        const enemyDistSq =
          (simEnemy.position.x - _camWorldPos.x) ** 2 +
          (simEnemy.position.y - _camWorldPos.y) ** 2 +
          (simEnemy.position.z - _camWorldPos.z) ** 2;
        const desiredEnemyLod: 0 | 1 = enemyDistSq > ENEMY_LOD1_DIST_SQ ? 1 : 0;
        const enemyView = ensureEnemyAsset(enemyBlockout, simEnemy, desiredEnemyLod);
        if (enemyView) {
          if (enemyView.oneShotRemainingSec > 0) {
            enemyView.oneShotRemainingSec = Math.max(0, enemyView.oneShotRemainingSec - stepDt);
          }
          const locomotionClip = defaultEnemyLocomotionClip(simEnemy);
          if (enemyView.oneShotRemainingSec <= 0) {
            const hasAttackClip =
              simEnemy.attackingCore && enemyView.clips.some((clip) => clip.name === 'attack');
            const targetClip = hasAttackClip ? 'attack' : locomotionClip;
            if (targetClip && enemyView.currentClip !== targetClip) {
              playMixerClip(enemyView.mixer, enemyView.clips, targetClip, true);
              enemyView.currentClip = targetClip;
            }
          }
          // Throttle distant animation ticks (>6 m) to every other frame for Quest 3 CPU headroom
          const farThrottle = enemyDistSq > ENEMY_ANIM_THROTTLE_DIST_SQ;
          enemyView.throttleFlip = !enemyView.throttleFlip;
          if (!farThrottle || enemyView.throttleFlip) {
            const activeClip = enemyView.clips.find((clip) => clip.name === enemyView.currentClip);
            const isSurfaceLocomotion =
              simEnemy.movementLayer === 'surface' &&
              enemyView.oneShotRemainingSec <= 0 &&
              enemyView.currentClip === locomotionClip;
            const animSpeed = isSurfaceLocomotion ? enemyLocomotionSpeed(simEnemy, activeClip) : 1;
            enemyView.mixer.update((farThrottle ? stepDt * 2 : stepDt) * animSpeed);
          }

          // Uniform-driven material states: Hit flash, Cryo frost tint, Boss Phase-2 molten cracks
          const wantPhase2 = simEnemy.isBoss && simEnemy.isBossPhase2;
          for (let m = 0; m < enemyView.materials.length; m += 1) {
            const mat = enemyView.materials[m];
            if (!mat) continue;
            if (wantPhase2 && !enemyView.phase2Applied && assets?.broodlordPhase2Emissive) {
              mat.emissiveMap = assets.broodlordPhase2Emissive;
              mat.needsUpdate = true;
            } else if (!wantPhase2 && enemyView.phase2Applied) {
              mat.emissiveMap = enemyView.baseEmissiveMaps[m] ?? null;
              mat.needsUpdate = true;
            }
            if (enemyBlockout.hitFlashSec > 0) {
              mat.emissive.setHex(0xffffff);
              mat.emissiveIntensity = 1.6 + (enemyBlockout.hitFlashSec / 0.1) * 0.9;
            } else if (isSlowed) {
              mat.emissive.copy(CRYO_FROST_COLOR);
              mat.emissiveIntensity = 0.85;
            } else if (wantPhase2) {
              mat.emissive.setHex(0xffffff);
              mat.emissiveIntensity = Math.max(1.65, simEnemy.emissiveIntensity * 1.8);
            } else {
              mat.emissive.copy(enemyView.baseEmissiveColors[m] ?? BOSS_PHASE1_EMISSIVE);
              mat.emissiveIntensity = 1.05;
            }
          }
          enemyView.phase2Applied = wantPhase2;
        }

        // Instanced World HP Bar above enemy (billboarded toward active camera)
        const barY =
          simEnemy.position.y + def.blockout.healthBarOffsetHeightM * GAMEPLAY_OBJECT_SCALE;
        // Prevent the enemy world overlay from filling the headset view near the eye.
        if (
          hpBarIndex < MAX_INSTANCED_HP_BARS &&
          simEnemy.hp > 0 &&
          (!camera ||
            _hpViewPosition.distanceToSquared(
              _vecA.set(simEnemy.position.x, barY, simEnemy.position.z),
            ) >= 0.25)
        ) {
          const hpRatio = THREE.MathUtils.clamp(
            simEnemy.maxHp > 0 ? simEnemy.hp / simEnemy.maxHp : 0,
            0.02,
            1,
          );
          const barScaleWidth = (simEnemy.isBoss ? 1.85 : 1.0) * GAMEPLAY_OBJECT_SCALE;
          const barScaleHeight = (simEnemy.isBoss ? 1.35 : 1.0) * GAMEPLAY_OBJECT_SCALE;

          _dummyObj.position.set(simEnemy.position.x, barY, simEnemy.position.z);
          if (hasBillboardCam) _dummyObj.quaternion.copy(_quat);
          else _dummyObj.quaternion.identity();
          _dummyObj.scale.set(barScaleWidth, barScaleHeight, 1);
          _dummyObj.updateMatrix();
          hpBgInstancedMesh.setMatrixAt(hpBarIndex, _dummyObj.matrix);

          // Left-aligned fill bar slightly in front of the backing bar along viewer axis
          const fillOffset = -0.15 * barScaleWidth * (1 - hpRatio);
          _dummyObj.position.set(
            simEnemy.position.x + _vecMid.x * fillOffset + _dir.x * 0.003,
            barY + _vecMid.y * fillOffset + _dir.y * 0.003,
            simEnemy.position.z + _vecMid.z * fillOffset + _dir.z * 0.003,
          );
          _dummyObj.scale.set(barScaleWidth * hpRatio, barScaleHeight, 1);
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
          disposeEnemyAsset(id);
          enemiesGroup.remove(record.group);
          disposeEntityCleanup(`enemy:${id}`);
          enemiesMap.delete(id);
        }
      }

      // Process combat events after entity transforms & GLB muzzle sockets match this tick.
      processEvents(events);

      // Apply enemy-hit flashes immediately on this frame for both blockout & GLB views
      if (events.length > 0) {
        for (const ev of events) {
          if (ev.type === 'enemy-hit') {
            const eb = enemiesMap.get(ev.enemyId);
            if (eb && eb.hitFlashSec > 0) {
              eb.primaryMaterial.emissive.setHex(0xffffff);
              eb.primaryMaterial.emissiveIntensity = (eb.hitFlashSec / 0.1) * 0.8;
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
        orientSegmentMatrix(segStart, segEnd, 0.014 * GAMEPLAY_OBJECT_SCALE, _mat4);
        tracerInstancedMesh.setMatrixAt(tracerWrite, _mat4);
        activeTracers[tracerWrite] = tr;
        tracerWrite += 1;
      }
      activeTracers.length = tracerWrite;
      tracerInstancedMesh.count = tracerWrite;
      tracerInstancedMesh.instanceMatrix.needsUpdate = true;

      // 5b. Live Mortar Plasma Shells (synced from snapshot.projectiles, blended from GLB muzzle)
      let shellCount = 0;
      const liveProjectileIds = new Set<string>();
      for (const proj of snapshot.projectiles) {
        liveProjectileIds.add(proj.id);
        if (shellCount >= MAX_INSTANCED_MORTAR_SHELLS) break;
        const offset = mortarVisualOffsets.get(proj.id);
        const blend = offset ? Math.max(0, 1 - proj.progress * 3.0) : 0;
        _dummyObj.position.set(
          proj.position.x + (offset ? offset.x * blend : 0),
          proj.position.y + (offset ? offset.y * blend : 0),
          proj.position.z + (offset ? offset.z * blend : 0),
        );
        _dummyObj.quaternion.identity();
        const radius = proj.tier === 'T3' ? 0.068 : proj.tier === 'T2' ? 0.056 : 0.046;
        _dummyObj.scale.setScalar(radius * GAMEPLAY_OBJECT_SCALE);
        _dummyObj.updateMatrix();
        mortarShellInstancedMesh.setMatrixAt(shellCount, _dummyObj.matrix);
        shellCount += 1;
      }
      for (const id of mortarVisualOffsets.keys()) {
        if (!liveProjectileIds.has(id)) {
          mortarVisualOffsets.delete(id);
        }
      }
      mortarShellInstancedMesh.count = shellCount;
      mortarShellInstancedMesh.instanceMatrix.needsUpdate = true;

      // 5c. Cryo-Arc Jagged Chain-Lightning Beams
      let cryoWrite = 0;
      for (let i = 0; i < activeCryoSegments.length; i += 1) {
        const seg = activeCryoSegments[i];
        if (!seg) continue;
        seg.elapsedSec += stepDt;
        if (seg.elapsedSec >= seg.durationSec) continue;
        const fade = 1 - seg.elapsedSec / seg.durationSec;
        orientSegmentMatrix(
          seg.from,
          seg.to,
          seg.thicknessM * (0.5 + 0.5 * fade) * GAMEPLAY_OBJECT_SCALE,
          _mat4,
        );
        cryoArcInstancedMesh.setMatrixAt(cryoWrite, _mat4);
        activeCryoSegments[cryoWrite] = seg;
        cryoWrite += 1;
      }
      activeCryoSegments.length = cryoWrite;
      cryoArcInstancedMesh.count = cryoWrite;
      cryoArcInstancedMesh.instanceMatrix.needsUpdate = true;

      // 5d. Rail Sniper Piercing Beams
      let railWrite = 0;
      for (let i = 0; i < activeRailBeams.length; i += 1) {
        const beam = activeRailBeams[i];
        if (!beam) continue;
        beam.elapsedSec += stepDt;
        if (beam.elapsedSec >= beam.durationSec) continue;
        const fade = 1 - beam.elapsedSec / beam.durationSec;
        orientSegmentMatrix(
          beam.from,
          beam.to,
          beam.thicknessM * (0.45 + 0.55 * fade) * GAMEPLAY_OBJECT_SCALE,
          _mat4,
        );
        railBeamInstancedMesh.setMatrixAt(railWrite, _mat4);
        activeRailBeams[railWrite] = beam;
        railWrite += 1;
      }
      activeRailBeams.length = railWrite;
      railBeamInstancedMesh.count = railWrite;
      railBeamInstancedMesh.instanceMatrix.needsUpdate = true;

      vfx.tick(stepDt);

      fxCounts = {
        activeTracers: tracerWrite,
        activeMortarShells: shellCount,
        activeBlastSpheres: vfx.stats.activeBlasts,
        activeCryoSegments: cryoWrite,
        activeRailBeams: railWrite,
        activeHpBars: hpBarIndex,
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;

      if (coreAssetView) {
        coreAssetView.mixer.stopAllAction();
        disposeClonedGlb(coreAssetView.root, coreAssetView.bindings);
        coreAssetView = null;
      }
      for (const id of [...portalAssetViews.keys()]) disposePortalAsset(id);
      for (const id of [...turretAssetViews.keys()]) disposeTurretAsset(id);
      for (const id of [...enemyAssetViews.keys()]) disposeEnemyAsset(id);
      vfx.dispose();

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
      cryoArcInstancedMesh.dispose();
      railBeamInstancedMesh.dispose();
      hpBgInstancedMesh.dispose();
      hpFillInstancedMesh.dispose();
      coreContactShadowMap.dispose();

      portalsMap.clear();
      turretsMap.clear();
      enemiesMap.clear();
      activeTracers.length = 0;
      activeCryoSegments.length = 0;
      activeRailBeams.length = 0;
      mortarVisualOffsets.clear();

      root.clear();
      root.removeFromParent();
    },
  };
}
