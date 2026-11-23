/**
 * Deterministic 60 Hz Fixed-Timestep Combat Simulation Engine (`src/sim/engine.ts`).
 *
 * Pure TypeScript with ZERO Three.js and ZERO WASM imports.
 *
 * Integrates:
 * - Seeded PRNG streams (`createSeededStreams` from `src/core/prng.ts`)
 * - Hybrid 3D Room Navigation Graph (`RoomNavigationGraph`, `buildNavigationGraph`,
 *   `samplePathAtDistance`, `computeDisruptorDetourPath`, `recoverStuckCrawler` from `src/nav/graph.ts`)
 * - Turret Placement Rules (`validateTurretPlacement` from `src/sim/placement-rules.ts`)
 * - 3D Spatial Hash Grid (`SpatialHash3D` from `src/sim/spatial-hash.ts`)
 * - Declarative Content Tables (`TURRETS`, `ENEMIES`, `WAVES` from `src/content/index.ts`)
 *
 * Features:
 * - Live & intermission turret commands: `placeTurret`, `upgradeTurret` (`T1->T2->T3`),
 *   `setTurretPriority` (`first | strongest | closest | air | air-priority`),
 *   `relocateTurret` (`25` credit fee + `1.5 s` redeploy cooldown), `sellTurret` (`75%` total invested refund).
 * - 4 distinct weapon roles:
 *   1. `autocannon`: rapid kinetic tracer hits (reduced by `Carapace Brute` 50% kinetic armor).
 *   2. `plasma-mortar`: parabolic projectile flight -> AoE splash damage + thermal burn DoT stacks/refresh.
 *   3. `cryo-arc`: applies `35/45/55%` movement slow (`computeEffectiveSlowFactor`) and chains
 *      instantaneously across `2/3/4` targets within chain radius (ground & air).
 *   4. `rail-sniper`: instant piercing line-of-sight beam with armor pierce (`0.85/0.95/1.0`),
 *      anti-air bonus (`1.4/1.6/1.8`), and boss bonus (`1.35/1.5/1.7`).
 * - 5 enemy archetypes & wave spawner (`MAX_ACTIVE_ENEMIES = 25` cap):
 *   - `skitter-crawler`, `wasp-skimmer`, `carapace-brute`, `rift-disruptor` (`4.0 s` EMP disable
 *     within `1.2 m` + `5.0 s` post-EMP immunity preventing permastun), and `apex-broodlord`
 *     (Wave 12 Boss: Phase 2 armor-crack transition at `<=50%` HP, `0`-bounty `skitter-crawler`
 *     add spawns respecting enemy cap, and turret-suppressing roar pulses).
 * - Economy, scoring, star rating preview, Victory/Defeat transitions, deterministic
 *   `computeStateHash()`, 18 typed `SimEvent` variants, and `?debug` helper hooks
 *   (`debugJumpToWave`, `debugGrantCredits`, `debugSpawnEnemy`, `debugSpawnBoss`).
 */

import {
  type AttachableSurfaceKind,
  CORE_KEEP_OUT_RADIUS_M,
  CORE_MAX_HP,
  type CombatMusicCueId,
  computeEarlyLaunchBonus,
  computeEffectiveDamageMultiplier,
  computeEffectiveSlowFactor,
  type DamageType,
  EARLY_LAUNCH_CREDITS_PER_SEC,
  EARLY_LAUNCH_MAX_BONUS_CREDITS,
  ENEMIES,
  ENEMY_IDS,
  type EnemyDefinition,
  type EnemyId,
  getEnemyDefinition,
  getNextTurretTier,
  getTurretBuildCost,
  getTurretDefinition,
  getTurretSellRefund,
  getTurretTierStats,
  getTurretUpgradeCost,
  getWaveDefinition,
  HARD_TURRET_CAP,
  INITIAL_PREP_DURATION_SEC,
  INTERMISSION_DURATION_SEC,
  MAX_ACTIVE_ENEMIES,
  MAX_ACTIVE_TURRETS,
  MAX_CONCURRENT_PORTALS,
  MISSION_CONFIG,
  type MovementLayer,
  type MusicCueId,
  PORTAL_KEEP_OUT_RADIUS_M,
  STAR_RATING_THRESHOLDS,
  STARTING_CREDITS,
  TARGET_PRIORITIES,
  type TargetPriority,
  TOTAL_WAVES,
  TURRET_BARREL_START_FRACTION,
  TURRET_FOOTPRINT_RADIUS_M,
  TURRET_KINDS,
  TURRET_MIN_SPACING_M,
  TURRET_MOUNT_IDS,
  TURRET_REDEPLOY_COOLDOWN_SEC,
  TURRET_RELOCATE_COST,
  TURRET_SELL_REFUND_RATIO,
  TURRET_TIERS,
  TURRETS,
  type TurretDefinition,
  type TurretKind,
  type TurretMountProfileId,
  type TurretTierId,
  type TurretTierNumber,
  type TurretTierStats,
  type Vec3,
  WAVES,
  type WaveDefinition,
} from '../content/index.ts';
import type { ActionBus, GameAction } from '../core/action-bus.ts';
import {
  createSeededStreams,
  DEFAULT_SEED,
  hashString,
  type Rng,
  type SeededStreams,
  toSeed,
} from '../core/prng.ts';
import type { GamePhase } from '../core/state.ts';
import {
  buildNavigationGraph,
  computeDisruptorDetourPath,
  distanceVec3,
  type LocomotionMode,
  type NavCoreAnchorInput,
  type NavigationPath,
  type NavPortalAnchorInput,
  type NavSurfaceInput,
  type RoomNavigationGraph,
  recoverStuckCrawler,
  samplePathAtDistance,
} from '../nav/graph.ts';
import {
  type PlacementInvalidReason,
  type PlacementSurfaceLike,
  type PlacementValidationResult,
  type Point2D,
  type TurretMountPose,
  validateTurretPlacement,
} from './placement-rules.ts';
import { SpatialHash3D } from './spatial-hash.ts';

/** Fixed 60 Hz simulation timestep in seconds (`1 / 60`). */
export const SIM_FIXED_DT = 1 / 60;
export const SIM_TICK_RATE_HZ = 60;

/** Canonical content table aliases for simulation consumers. */
export const TURRET_DEFS = TURRETS;
export const ENEMY_DEFS = ENEMIES;
export const MISSION_WAVES = WAVES;

/** Maximum thermal burn DoT stacks from repeated Plasma Mortar hits. */
export const MAX_BURN_STACKS = 3;

/** Beam radius tolerance for Rail Sniper line-of-sight piercing hits (meters). */
export const RAIL_PIERCE_BEAM_RADIUS_M = 0.14;

/** Secondary damage retention factor for enemies pierced behind the primary Rail Sniper target. */
export const RAIL_SECONDARY_PIERCE_RETENTION = 0.65;

export {
  type AttachableSurfaceKind,
  CORE_KEEP_OUT_RADIUS_M,
  CORE_MAX_HP,
  type CombatMusicCueId,
  computeEarlyLaunchBonus,
  computeEffectiveDamageMultiplier,
  computeEffectiveSlowFactor,
  type DamageType,
  EARLY_LAUNCH_CREDITS_PER_SEC,
  EARLY_LAUNCH_MAX_BONUS_CREDITS,
  ENEMIES,
  ENEMY_IDS,
  type EnemyDefinition,
  type EnemyId,
  getEnemyDefinition,
  getNextTurretTier,
  getTurretBuildCost,
  getTurretDefinition,
  getTurretSellRefund,
  getTurretTierStats,
  getTurretUpgradeCost,
  getWaveDefinition,
  HARD_TURRET_CAP,
  INITIAL_PREP_DURATION_SEC,
  INTERMISSION_DURATION_SEC,
  type LocomotionMode,
  MAX_ACTIVE_ENEMIES,
  MAX_ACTIVE_TURRETS,
  MAX_CONCURRENT_PORTALS,
  MISSION_CONFIG,
  type MovementLayer,
  type MusicCueId,
  type NavCoreAnchorInput,
  type NavigationPath,
  type NavPortalAnchorInput,
  type NavSurfaceInput,
  type PlacementInvalidReason,
  type PlacementSurfaceLike,
  type PlacementValidationResult,
  PORTAL_KEEP_OUT_RADIUS_M,
  type RoomNavigationGraph,
  STAR_RATING_THRESHOLDS,
  STARTING_CREDITS,
  TARGET_PRIORITIES,
  type TargetPriority,
  TOTAL_WAVES,
  TURRET_FOOTPRINT_RADIUS_M,
  TURRET_KINDS,
  TURRET_MIN_SPACING_M,
  TURRET_MOUNT_IDS,
  TURRET_REDEPLOY_COOLDOWN_SEC,
  TURRET_RELOCATE_COST,
  TURRET_SELL_REFUND_RATIO,
  TURRET_TIERS,
  TURRETS,
  type TurretDefinition,
  type TurretKind,
  type TurretMountPose,
  type TurretMountProfileId,
  type TurretTierId,
  type TurretTierNumber,
  type TurretTierStats,
  type Vec3,
  WAVES,
  type WaveDefinition,
};

/**
 * Target priority mode accepted by `setTurretPriority` and `placeTurret`.
 * Supports both `'air'` (from `src/core/action-bus.ts`) and `'air-priority'` (from P2-T4 spec).
 */
export const SIM_TARGET_PRIORITIES = [
  'first',
  'strongest',
  'closest',
  'air',
  'air-priority',
] as const;
export type SimTargetPriority = (typeof SIM_TARGET_PRIORITIES)[number];

export type SimCombatPhase = Extract<
  GamePhase,
  'prep' | 'wave' | 'intermission' | 'victory' | 'defeat'
>;

export type SimStarRating = 0 | 1 | 2 | 3;

// ============================================================================
// Simulation Entities
// ============================================================================

export interface SimTurret {
  readonly id: string;
  readonly kind: TurretKind;
  readonly name: string;
  readonly damageType: DamageType;
  tier: TurretTierId;
  level: TurretTierNumber;
  position: Vec3;
  normal: Vec3;
  mountProfile: TurretMountProfileId;
  pose: TurretMountPose;
  surfaceId: string | null;
  surfaceKind: AttachableSurfaceKind | null;
  priority: SimTargetPriority;
  stats: TurretTierStats;
  /** Cumulative build + upgrade credits invested in this turret. */
  investedCredits: number;
  /** Current 75% sell refund in Requisition credits. */
  sellRefundCredits: number;
  /** Seconds remaining before the next weapon discharge (`0` = ready). */
  fireCooldownSec: number;
  /** Seconds remaining in the `1.5 s` relocate redeploy warm-up (`0` = ready). */
  redeployCooldownSec: number;
  /** Seconds remaining while disabled by a Disruptor EMP (`4.0 s`) or Boss roar (`3.0 s`). */
  disabledRemainingSec: number;
  /** Seconds remaining in the `5.0 s` post-EMP recovery immunity window. */
  empImmunityRemainingSec: number;
  /** Post-disable immunity duration queued to activate when `disabledRemainingSec` reaches `0`. */
  pendingImmunityDurationSec: number;
  /** Convenience flag: `disabledRemainingSec > 0`. */
  isDisrupted: boolean;
  /** Convenience flag: `empImmunityRemainingSec > 0`. */
  isEmpImmune: boolean;
  /** Convenience flag: `redeployCooldownSec > 0`. */
  isRedeploying: boolean;
  /** Currently acquired enemy ID, or `null` if idle. */
  targetEnemyId: string | null;
  /** Horizontal aiming yaw in radians (`atan2(dx, dz)`). */
  yaw: number;
  /** Vertical aiming pitch in radians. */
  pitch: number;
  shotsFired: number;
  totalDamageDealt: number;
  kills: number;
}

export interface SimEnemy {
  readonly id: string;
  readonly enemyId: EnemyId;
  readonly archetypeId: EnemyId;
  readonly name: string;
  hp: number;
  readonly maxHp: number;
  readonly speedMps: number;
  effectiveSpeedMps: number;
  readonly movementLayer: MovementLayer;
  position: Vec3;
  tangent: Vec3;
  normal: Vec3;
  locomotionMode: LocomotionMode;
  readonly portalId: string;
  readonly portalIndex: number;
  readonly laneIndex: number;
  path: NavigationPath;
  distanceAlongPath: number;
  distanceToCore: number;
  progress: number;
  readonly collisionRadiusM: number;
  readonly coreDamage: number;
  readonly creditBounty: number;
  readonly scoreValue: number;
  readonly isBoss: boolean;
  bossPhase: 1 | 2;
  isBossPhase2: boolean;
  emissiveIntensity: number;
  readonly isSummonedAdd: boolean;
  readonly summonedByBossId: string | null;
  /** Current active Cryo-Arc movement slow ratio (`0..0.8`). */
  slowFactor: number;
  /** Seconds remaining on active Cryo-Arc slow. */
  slowRemainingSec: number;
  /** Current thermal burn stack count (`0..MAX_BURN_STACKS`). */
  burnStacks: number;
  /** Current effective thermal burn damage per second before elemental armor multiplier. */
  burnDps: number;
  /** Seconds remaining on active thermal burn DoT. */
  burnRemainingSec: number;
  /** Seconds remaining before a Rift Disruptor can emit its next EMP pulse. */
  empCooldownSec: number;
  /** Seconds remaining before the Apex Broodlord summons its next Skitter Crawler add wave. */
  bossSummonTimerSec: number;
  /** Seconds remaining before the Apex Broodlord emits its next turret-suppressing roar pulse. */
  bossSuppressionTimerSec: number;
  readonly spawnTick: number;
}

export interface SimProjectile {
  readonly id: string;
  readonly turretId: string;
  readonly turretKind: TurretKind;
  readonly tier: TurretTierId;
  readonly damageType: DamageType;
  targetEnemyId: string | null;
  readonly startPosition: Vec3;
  targetPosition: Vec3;
  position: Vec3;
  velocity: Vec3;
  readonly arcHeightM: number;
  readonly speedMps: number;
  elapsedSec: number;
  readonly flightDurationSec: number;
  progress: number;
  readonly damage: number;
  readonly aoeRadiusM: number;
  readonly splashEdgeFalloff: number;
  readonly burnDps: number;
  readonly burnDurationSec: number;
  readonly armorPierceFactor: number;
  readonly antiAirMultiplier: number;
  readonly bossBonusMultiplier: number;
}

export interface SimPortalState {
  readonly id: string;
  readonly portalIndex: number;
  readonly position: Vec3;
  readonly normal: Vec3;
  readonly hostKind: 'wall' | 'ceiling' | 'virtual-rift';
  isOpen: boolean;
  openedAtTick: number | null;
}

// ============================================================================
// Typed Per-Tick Simulation Events (18 Discriminated Union Variants)
// ============================================================================

export interface SimEventBase {
  readonly tick: number;
  readonly timeSec: number;
}

export interface TurretPlacedEvent extends SimEventBase {
  readonly type: 'turret-placed';
  readonly turretId: string;
  readonly kind: TurretKind;
  readonly tier: TurretTierId;
  readonly position: Vec3;
  readonly normal: Vec3;
  readonly mountProfile: TurretMountProfileId;
  readonly cost: number;
  readonly remainingCredits: number;
}

export interface TurretUpgradedEvent extends SimEventBase {
  readonly type: 'turret-upgraded';
  readonly turretId: string;
  readonly kind: TurretKind;
  readonly previousTier: TurretTierId;
  readonly tier: TurretTierId;
  readonly cost: number;
  readonly investedCredits: number;
  readonly remainingCredits: number;
}

export interface TurretRelocatedEvent extends SimEventBase {
  readonly type: 'turret-relocated';
  readonly turretId: string;
  readonly kind: TurretKind;
  readonly fromPosition: Vec3;
  readonly toPosition: Vec3;
  readonly mountProfile: TurretMountProfileId;
  readonly cost: number;
  readonly redeployCooldownSec: number;
  readonly remainingCredits: number;
}

export interface TurretSoldEvent extends SimEventBase {
  readonly type: 'turret-sold';
  readonly turretId: string;
  readonly kind: TurretKind;
  readonly tier: TurretTierId;
  readonly position: Vec3;
  readonly refundCredits: number;
  readonly remainingCredits: number;
}

export interface TurretFiredEvent extends SimEventBase {
  readonly type: 'turret-fired';
  readonly turretId: string;
  readonly turretKind: TurretKind;
  readonly tier: TurretTierId;
  readonly damageType: DamageType;
  readonly targetEnemyId: string;
  readonly fromPosition: Vec3;
  readonly toPosition: Vec3;
  readonly projectileId: string | null;
  readonly piercedEnemyIds?: readonly string[];
}

export interface ProjectileImpactEvent extends SimEventBase {
  readonly type: 'projectile-impact';
  readonly projectileId: string;
  readonly turretId: string;
  readonly turretKind: TurretKind;
  readonly damageType: DamageType;
  readonly position: Vec3;
  readonly aoeRadiusM: number;
  readonly hitEnemyIds: readonly string[];
}

export interface CryoChainEvent extends SimEventBase {
  readonly type: 'cryo-chain';
  readonly turretId: string;
  readonly tier: TurretTierId;
  readonly targetEnemyIds: readonly string[];
  readonly chainPositions: readonly Vec3[];
  readonly jumpCount: number;
  readonly slowFactor: number;
}

export interface EnemySpawnedEvent extends SimEventBase {
  readonly type: 'enemy-spawned';
  readonly enemyId: string;
  readonly archetypeId: EnemyId;
  readonly portalId: string;
  readonly portalIndex: number;
  readonly position: Vec3;
  readonly movementLayer: MovementLayer;
  readonly maxHp: number;
  readonly creditBounty: number;
  readonly isBoss: boolean;
  readonly isSummonedAdd: boolean;
  readonly summonedByBossId: string | null;
}

export interface EnemyHitEvent extends SimEventBase {
  readonly type: 'enemy-hit';
  readonly enemyId: string;
  readonly archetypeId: EnemyId;
  readonly turretId: string | null;
  readonly damageType: DamageType;
  readonly damage: number;
  readonly remainingHp: number;
  readonly maxHp: number;
  readonly position: Vec3;
  readonly isDot: boolean;
  readonly isSplash: boolean;
  readonly isChain: boolean;
  readonly isPiercing: boolean;
}

export interface EnemyKilledEvent extends SimEventBase {
  readonly type: 'enemy-killed';
  readonly enemyId: string;
  readonly archetypeId: EnemyId;
  readonly turretId: string | null;
  readonly damageType: DamageType;
  readonly position: Vec3;
  readonly creditBounty: number;
  readonly scoreAwarded: number;
  readonly totalCredits: number;
  readonly totalScore: number;
  readonly isBoss: boolean;
}

export interface TurretDisruptedEvent extends SimEventBase {
  readonly type: 'turret-disrupted';
  readonly turretId: string;
  readonly turretKind: TurretKind;
  readonly sourceEnemyId: string;
  readonly sourceArchetypeId: EnemyId;
  readonly position: Vec3;
  readonly durationSec: number;
  readonly immunityCooldownSec: number;
}

export interface TurretRecoveredEvent extends SimEventBase {
  readonly type: 'turret-recovered';
  readonly turretId: string;
  readonly turretKind: TurretKind;
  readonly position: Vec3;
  readonly immunityDurationSec: number;
}

export interface PortalOpenedEvent extends SimEventBase {
  readonly type: 'portal-opened';
  readonly portalId: string;
  readonly portalIndex: number;
  readonly position: Vec3;
  readonly normal: Vec3;
  readonly waveNumber: number;
}

export interface CoreHitEvent extends SimEventBase {
  readonly type: 'core-hit';
  readonly enemyId: string;
  readonly archetypeId: EnemyId;
  readonly damage: number;
  readonly remainingCoreHp: number;
  readonly maxCoreHp: number;
  readonly position: Vec3;
}

export interface WaveStartedEvent extends SimEventBase {
  readonly type: 'wave-started';
  readonly waveNumber: number;
  readonly waveId: string;
  readonly title: string;
  readonly musicCue: CombatMusicCueId;
  readonly concurrentPortals: number;
  readonly earlyLaunchBonusCredits: number;
  readonly totalCredits: number;
}

export interface WaveClearedEvent extends SimEventBase {
  readonly type: 'wave-cleared';
  readonly waveNumber: number;
  readonly clearBonusCredits: number;
  readonly totalCredits: number;
  readonly remainingCoreHp: number;
  readonly totalScore: number;
}

export interface BossPhase2Event extends SimEventBase {
  readonly type: 'boss-phase2';
  readonly bossEnemyId: string;
  readonly archetypeId: 'apex-broodlord';
  readonly hp: number;
  readonly maxHp: number;
  readonly position: Vec3;
  readonly speedMultiplier: number;
  readonly kineticReduction: number;
}

export interface MissionEndedEvent extends SimEventBase {
  readonly type: 'mission-ended';
  readonly outcome: 'victory' | 'defeat';
  readonly victory: boolean;
  readonly waveNumber: number;
  readonly wavesCleared: number;
  readonly remainingCoreHp: number;
  readonly maxCoreHp: number;
  readonly credits: number;
  readonly score: number;
  readonly stars: SimStarRating;
}

export type SimEvent =
  | TurretPlacedEvent
  | TurretUpgradedEvent
  | TurretRelocatedEvent
  | TurretSoldEvent
  | TurretFiredEvent
  | ProjectileImpactEvent
  | CryoChainEvent
  | EnemySpawnedEvent
  | EnemyHitEvent
  | EnemyKilledEvent
  | TurretDisruptedEvent
  | TurretRecoveredEvent
  | PortalOpenedEvent
  | CoreHitEvent
  | WaveStartedEvent
  | WaveClearedEvent
  | BossPhase2Event
  | MissionEndedEvent;

export type SimEventType = SimEvent['type'];

// ============================================================================
// Command Input & Result Contracts
// ============================================================================

export interface PlaceTurretInput {
  readonly id?: string;
  readonly kind: TurretKind;
  readonly position: Readonly<Vec3>;
  readonly mountProfile?: TurretMountProfileId;
  readonly mode?: TurretMountProfileId;
  readonly normal?: Readonly<Vec3>;
  readonly surfaceNormal?: Readonly<Vec3>;
  readonly surface?: PlacementSurfaceLike | null;
  readonly surfaceId?: string | null;
  readonly surfaceKind?: AttachableSurfaceKind | string | null;
  readonly polygon?: readonly (Readonly<Vec3> | Point2D)[];
  readonly priority?: SimTargetPriority;
  readonly rayOrigin?: Readonly<Vec3>;
  readonly rayDistanceM?: number;
  readonly depthM?: number;
  readonly forwardHint?: Readonly<Vec3>;
}

export interface PlaceTurretResult {
  readonly ok: boolean;
  readonly valid: boolean;
  readonly turret: SimTurret | null;
  readonly reason: PlacementInvalidReason | null;
  readonly reasonLabel: string | null;
  readonly cost: number;
  readonly remainingCredits: number;
  readonly validation: PlacementValidationResult;
}

export type UpgradeFailureReason = 'TURRET_NOT_FOUND' | 'MAX_TIER' | 'INSUFFICIENT_CREDITS';

export interface UpgradeTurretResult {
  readonly ok: boolean;
  readonly turret: SimTurret | null;
  readonly reason: UpgradeFailureReason | null;
  readonly previousTier: TurretTierId | null;
  readonly tier: TurretTierId | null;
  readonly cost: number;
  readonly remainingCredits: number;
}

export interface SetTurretPriorityResult {
  readonly ok: boolean;
  readonly turret: SimTurret | null;
  readonly priority: SimTargetPriority | null;
  readonly reason: 'TURRET_NOT_FOUND' | 'INVALID_PRIORITY' | null;
}

export interface RelocateTurretInput {
  readonly turretId: string;
  readonly position: Readonly<Vec3>;
  readonly mountProfile?: TurretMountProfileId;
  readonly normal?: Readonly<Vec3>;
  readonly surface?: PlacementSurfaceLike | null;
  readonly surfaceId?: string | null;
  readonly surfaceKind?: AttachableSurfaceKind | string | null;
  readonly polygon?: readonly (Readonly<Vec3> | Point2D)[];
  readonly rayOrigin?: Readonly<Vec3>;
  readonly rayDistanceM?: number;
  readonly depthM?: number;
  readonly forwardHint?: Readonly<Vec3>;
}

export interface RelocateTurretResult {
  readonly ok: boolean;
  readonly valid: boolean;
  readonly turret: SimTurret | null;
  readonly reason: PlacementInvalidReason | 'TURRET_NOT_FOUND' | null;
  readonly reasonLabel: string | null;
  readonly cost: number;
  readonly redeployCooldownSec: number;
  readonly remainingCredits: number;
  readonly validation: PlacementValidationResult | null;
}

export interface SellTurretResult {
  readonly ok: boolean;
  readonly turret: SimTurret | null;
  readonly reason: 'TURRET_NOT_FOUND' | null;
  readonly refundCredits: number;
  readonly remainingCredits: number;
}

export interface LaunchWaveResult {
  readonly ok: boolean;
  readonly waveNumber: number;
  readonly bonusCredits: number;
  readonly remainingCredits: number;
}

export interface DebugSpawnEnemyOptions {
  readonly id?: string;
  readonly portalIndex?: number;
  readonly portalId?: string;
  readonly position?: Readonly<Vec3>;
  readonly distanceAlongPath?: number;
  readonly hp?: number;
  readonly maxHp?: number;
  readonly creditBounty?: number;
  readonly laneIndex?: number;
  readonly isSummonedAdd?: boolean;
  readonly summonedByBossId?: string | null;
  readonly initialEmpCooldownSec?: number;
}

export interface DebugJumpToWaveOptions {
  readonly clearExistingEnemies?: boolean;
  readonly clearProjectiles?: boolean;
  readonly startImmediately?: boolean;
}

export interface CombatSimulationConfig {
  /** Root PRNG seed (defaults to `DEFAULT_SEED`). */
  readonly seed?: number;
  /** Optional pre-created seeded PRNG streams (overrides `seed` when provided). */
  readonly streams?: SeededStreams;
  /** Optional pre-built room navigation graph. */
  readonly navGraph?: RoomNavigationGraph;
  /** Room surfaces used when building a default `RoomNavigationGraph` and validating surface placements. */
  readonly surfaces?: readonly NavSurfaceInput[];
  /** Core Bastion anchor or 3D position (defaults to `{ x: 0, y: 0, z: 1.5 }`). */
  readonly coreAnchor?: NavCoreAnchorInput | Readonly<Vec3>;
  /** Portal anchors (defaults to 4 standard wall/ceiling rift anchors `>= 2.0 m` from the Core). */
  readonly portalAnchors?: readonly NavPortalAnchorInput[];
  /** Starting Requisition credits override (defaults to `STARTING_CREDITS = 320`). */
  readonly startingCredits?: number;
  /** Maximum Core HP override (defaults to `CORE_MAX_HP = 100`). */
  readonly coreMaxHp?: number;
  /** Initial phase (`'prep'` by default, or `'wave'` if `autoStartWave1` is `true`). */
  readonly initialPhase?: SimCombatPhase;
  /** When `true`, starts Wave 1 immediately upon creation instead of waiting in `'prep'`. */
  readonly autoStartWave1?: boolean;
  /** Allow the initial countdown to launch Wave 1 automatically. */
  readonly autoLaunchInitialWave?: boolean;
  /** Initial prep countdown duration in seconds (defaults to `INITIAL_PREP_DURATION_SEC = 20`). */
  readonly initialPrepDurationSec?: number;
  /** Custom wave table override (defaults to `WAVES`). */
  readonly waves?: readonly WaveDefinition[];
  /** Optional spatial hash cell size in meters (defaults to `1.0`). */
  readonly spatialHashCellSizeM?: number;
}

export interface CombatSimulationState {
  readonly seed: number;
  readonly tick: number;
  readonly timeSec: number;
  readonly accumulatorSec: number;
  readonly phase: SimCombatPhase;
  /** Current wave number (`0` during initial prep, `1..12` once Wave 1 starts). */
  readonly currentWave: number;
  /** Highest wave cleared so far (`0..12`). */
  readonly wavesCleared: number;
  readonly totalWaves: number;
  readonly credits: number;
  readonly coreHp: number;
  readonly maxCoreHp: number;
  readonly score: number;
  /** Current 0–3 star rating preview based on remaining Core HP ratio. */
  readonly starRatingPreview: SimStarRating;
  /** Final mission star rating (`0` on defeat, `1..3` on victory, or current preview while active). */
  readonly stars: SimStarRating;
  readonly victory: boolean;
  readonly defeat: boolean;
  readonly prepRemainingSec: number;
  readonly intermissionRemainingSec: number;
  readonly waveElapsedSec: number;
  readonly pendingWaveSpawns: number;
  readonly totalEnemiesKilled: number;
  readonly totalCreditsEarned: number;
  readonly musicCue: MusicCueId;
  readonly corePosition: Vec3;
  readonly coreRadius: number;
  readonly portals: readonly SimPortalState[];
  readonly activePortals: readonly SimPortalState[];
  readonly turrets: readonly SimTurret[];
  readonly enemies: readonly SimEnemy[];
  readonly projectiles: readonly SimProjectile[];
}

export interface SimTickResult {
  readonly tick: number;
  readonly timeSec: number;
  readonly ticksExecuted: number;
  readonly phase: SimCombatPhase;
  readonly events: readonly SimEvent[];
  readonly state: CombatSimulationState;
}

export interface CombatSimulation {
  readonly seed: number;
  readonly streams: SeededStreams;
  readonly navGraph: RoomNavigationGraph;
  readonly enemySpatialHash: SpatialHash3D<SimEnemy>;
  readonly turretSpatialHash: SpatialHash3D<SimTurret>;

  /** Advances the simulation by exactly one fixed `SIM_FIXED_DT = 1/60 s` tick. */
  tick(): SimTickResult;
  /**
   * Advances the simulation using the fixed-timestep accumulator (`SIM_FIXED_DT = 1/60 s`).
   * Calling `step()` with no arguments advances by 1 fixed tick.
   */
  step(dtSec?: number, maxSubSteps?: number): SimTickResult;
  /** Runs `count` fixed `1/60 s` ticks and returns all events emitted across those ticks. */
  runTicks(count: number): SimTickResult;

  /** Live & intermission turret commands. */
  placeTurret(input: PlaceTurretInput): PlaceTurretResult;
  upgradeTurret(turretId: string): UpgradeTurretResult;
  setTurretPriority(turretId: string, priority: SimTargetPriority): SetTurretPriorityResult;
  relocateTurret(
    turretIdOrInput: string | RelocateTurretInput,
    position?: Readonly<Vec3>,
    options?: Partial<Omit<RelocateTurretInput, 'turretId' | 'position'>>,
  ): RelocateTurretResult;
  sellTurret(turretId: string): SellTurretResult;
  validatePlacement(
    candidate: PlaceTurretInput,
    relocatingTurretId?: string | null,
  ): PlacementValidationResult;

  /** Wave launch & navigation graph updates. */
  launchWave(): LaunchWaveResult;
  startNextWave(): LaunchWaveResult;
  setNavigationGraph(graph: RoomNavigationGraph): void;

  /** State & event inspection. */
  getState(): CombatSimulationState;
  getTurret(turretId: string): SimTurret | undefined;
  getEnemy(enemyId: string): SimEnemy | undefined;
  getEvents(): readonly SimEvent[];
  drainEvents(): SimEvent[];
  getEventHistory(): readonly SimEvent[];
  computeStateHash(): string;

  /** ActionBus integration. */
  handleAction(action: GameAction): void;
  attachActionBus(bus: ActionBus): () => void;

  /** `?debug`-compatible helper hooks for P2-T6 automated verification and unit tests. */
  debugJumpToWave(waveNumber: number, options?: DebugJumpToWaveOptions): WaveDefinition;
  debugGrantCredits(amount: number): number;
  debugSpawnEnemy(enemyId: EnemyId, options?: DebugSpawnEnemyOptions): SimEnemy;
  debugSpawnBoss(options?: DebugSpawnEnemyOptions): SimEnemy;
}

// ============================================================================
// Default Room & Navigation Graph Helpers
// ============================================================================

const DEFAULT_CORE_POSITION: Vec3 = Object.freeze({ x: 0, y: 0, z: 1.5 });

const DEFAULT_PORTAL_ANCHORS: readonly NavPortalAnchorInput[] = Object.freeze([
  {
    id: 'portal-0',
    position: { x: -0.9, y: 1.4, z: -2.1 },
    normal: { x: 0, y: 0, z: 1 },
    hostKind: 'wall',
    surfaceId: 'sim-wall-north',
  },
  {
    id: 'portal-1',
    position: { x: 0.9, y: 1.4, z: -2.1 },
    normal: { x: 0, y: 0, z: 1 },
    hostKind: 'wall',
    surfaceId: 'sim-wall-north',
  },
  {
    id: 'portal-2',
    position: { x: -2.2, y: 1.4, z: -0.4 },
    normal: { x: 1, y: 0, z: 0 },
    hostKind: 'wall',
    surfaceId: 'sim-wall-west',
  },
  {
    id: 'portal-3',
    position: { x: 2.2, y: 1.4, z: -0.4 },
    normal: { x: -1, y: 0, z: 0 },
    hostKind: 'wall',
    surfaceId: 'sim-wall-east',
  },
]);

const DEFAULT_ROOM_SURFACES: readonly NavSurfaceInput[] = Object.freeze([
  {
    id: 'sim-floor-main',
    kind: 'floor',
    center: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    polygon: [
      { x: -3.2, y: 0, z: -3.2 },
      { x: 3.2, y: 0, z: -3.2 },
      { x: 3.2, y: 0, z: 3.2 },
      { x: -3.2, y: 0, z: 3.2 },
    ],
  },
  {
    id: 'sim-ceiling-main',
    kind: 'ceiling',
    center: { x: 0, y: 2.8, z: 0 },
    normal: { x: 0, y: -1, z: 0 },
    polygon: [
      { x: -3.2, y: 2.8, z: -3.2 },
      { x: 3.2, y: 2.8, z: -3.2 },
      { x: 3.2, y: 2.8, z: 3.2 },
      { x: -3.2, y: 2.8, z: 3.2 },
    ],
  },
  {
    id: 'sim-wall-north',
    kind: 'wall',
    center: { x: 0, y: 1.4, z: -2.1 },
    normal: { x: 0, y: 0, z: 1 },
    polygon: [
      { x: -3.2, y: 0, z: -2.1 },
      { x: 3.2, y: 0, z: -2.1 },
      { x: 3.2, y: 2.8, z: -2.1 },
      { x: -3.2, y: 2.8, z: -2.1 },
    ],
  },
  {
    id: 'sim-wall-west',
    kind: 'wall',
    center: { x: -2.2, y: 1.4, z: 0 },
    normal: { x: 1, y: 0, z: 0 },
    polygon: [
      { x: -2.2, y: 0, z: -3.2 },
      { x: -2.2, y: 0, z: 3.2 },
      { x: -2.2, y: 2.8, z: 3.2 },
      { x: -2.2, y: 2.8, z: -3.2 },
    ],
  },
  {
    id: 'sim-wall-east',
    kind: 'wall',
    center: { x: 2.2, y: 1.4, z: 0 },
    normal: { x: -1, y: 0, z: 0 },
    polygon: [
      { x: 2.2, y: 0, z: -3.2 },
      { x: 2.2, y: 0, z: 3.2 },
      { x: 2.2, y: 2.8, z: 3.2 },
      { x: 2.2, y: 2.8, z: -3.2 },
    ],
  },
]);

function cloneVec3(v: Readonly<Vec3>): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function quantize(value: number, scale = 10000): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * scale);
}

export function computeStarRatingFromCoreHp(
  remainingCoreHp: number,
  maxCoreHp: number = CORE_MAX_HP,
  defeat = false,
): SimStarRating {
  if (defeat || !Number.isFinite(remainingCoreHp) || remainingCoreHp <= 0 || maxCoreHp <= 0) {
    return 0;
  }
  const ratio = remainingCoreHp / maxCoreHp;
  if (ratio + 1e-6 >= STAR_RATING_THRESHOLDS.threeStarMinHpRatio) return 3;
  if (ratio + 1e-6 >= STAR_RATING_THRESHOLDS.twoStarMinHpRatio) return 2;
  if (ratio > 0) return 1;
  return 0;
}

export function isSimTargetPriority(value: unknown): value is SimTargetPriority {
  return typeof value === 'string' && (SIM_TARGET_PRIORITIES as readonly string[]).includes(value);
}

/**
 * Computes minimum 3D distance from `point` to line segment `segStart -> segEnd`,
 * plus the normalized projection parameter `t` in `[0, 1]`.
 */
function pointToSegmentDistance3D(
  point: Readonly<Vec3>,
  segStart: Readonly<Vec3>,
  segEnd: Readonly<Vec3>,
): { readonly distanceM: number; readonly t: number } {
  const abx = segEnd.x - segStart.x;
  const aby = segEnd.y - segStart.y;
  const abz = segEnd.z - segStart.z;
  const lenSq = abx * abx + aby * aby + abz * abz;
  if (lenSq < 1e-12) {
    return { distanceM: distanceVec3(point, segStart), t: 0 };
  }
  const apx = point.x - segStart.x;
  const apy = point.y - segStart.y;
  const apz = point.z - segStart.z;
  const rawT = (apx * abx + apy * aby + apz * abz) / lenSq;
  const t = Math.max(0, Math.min(1, rawT));
  const cx = segStart.x + abx * t;
  const cy = segStart.y + aby * t;
  const cz = segStart.z + abz * t;
  return {
    distanceM: Math.hypot(point.x - cx, point.y - cy, point.z - cz),
    t,
  };
}

interface ScheduledWaveSpawn {
  readonly groupId: string;
  readonly enemyId: EnemyId;
  readonly portalIndex: number;
  readonly scheduledTimeSec: number;
  readonly sequenceIndex: number;
  spawned: boolean;
}

// ============================================================================
// Combat Simulation Factory
// ============================================================================

export function createCombatSimulation(config: CombatSimulationConfig = {}): CombatSimulation {
  const streams = config.streams ?? createSeededStreams(config.seed ?? DEFAULT_SEED);
  const seed = toSeed(streams.rootSeed);
  const wavesRng: Rng = streams.stream('waves');
  const targetingRng: Rng = streams.stream('targeting');

  const surfaces: readonly NavSurfaceInput[] = config.surfaces ?? DEFAULT_ROOM_SURFACES;
  let currentNavGraph: RoomNavigationGraph =
    config.navGraph ??
    buildNavigationGraph({
      surfaces,
      coreAnchor: config.coreAnchor ?? DEFAULT_CORE_POSITION,
      portalAnchors:
        config.portalAnchors && config.portalAnchors.length > 0
          ? config.portalAnchors
          : DEFAULT_PORTAL_ANCHORS,
    });

  const waveTable: readonly WaveDefinition[] =
    config.waves && config.waves.length > 0 ? config.waves : WAVES;
  const totalWaves = waveTable.length;

  const maxCoreHp =
    typeof config.coreMaxHp === 'number' && config.coreMaxHp > 0 ? config.coreMaxHp : CORE_MAX_HP;
  let coreHp = maxCoreHp;
  let credits =
    typeof config.startingCredits === 'number' && Number.isFinite(config.startingCredits)
      ? Math.max(0, Math.round(config.startingCredits))
      : STARTING_CREDITS;
  let totalCreditsEarned = credits;
  let score = 0;
  let totalEnemiesKilled = 0;

  let tickCount = 0;
  let timeSec = 0;
  let accumulatorSec = 0;

  let phase: SimCombatPhase = config.initialPhase ?? 'prep';
  let currentWave = 0;
  let wavesCleared = 0;
  const autoLaunchInitialWave = config.autoLaunchInitialWave ?? true;
  let prepRemainingSec = autoLaunchInitialWave
    ? typeof config.initialPrepDurationSec === 'number' && config.initialPrepDurationSec >= 0
      ? config.initialPrepDurationSec
      : INITIAL_PREP_DURATION_SEC
    : 0;
  let intermissionRemainingSec = 0;
  let waveElapsedSec = 0;

  let nextTurretSeq = 1;
  let nextEnemySeq = 1;
  let nextProjectileSeq = 1;
  let aerialLaneCounter = 0;

  const turrets: SimTurret[] = [];
  const enemies: SimEnemy[] = [];
  const projectiles: SimProjectile[] = [];
  let scheduledSpawns: ScheduledWaveSpawn[] = [];

  const portals: SimPortalState[] = currentNavGraph.portals.map((p, idx) => ({
    id: p.id,
    portalIndex: idx,
    position: cloneVec3(p.position),
    normal: cloneVec3(p.normal),
    hostKind: p.hostKind ?? (p.normal.y < -0.5 ? 'ceiling' : 'wall'),
    isOpen: false,
    openedAtTick: null,
  }));

  const cellSizeM = config.spatialHashCellSizeM ?? 1.0;
  const enemySpatialHash = new SpatialHash3D<SimEnemy>({
    cellSizeM,
    getPosition: (e) => e.position,
    getRadius: (e) => e.collisionRadiusM,
  });
  const turretSpatialHash = new SpatialHash3D<SimTurret>({
    cellSizeM,
    getPosition: (t) => t.position,
    getRadius: () => TURRET_FOOTPRINT_RADIUS_M,
  });

  // Event buffers:
  // - `pendingCommandEvents`: events emitted by commands between ticks; folded into the next tick
  //   AND immediately visible via `getEvents()`.
  // - `lastTickEvents`: events emitted during the most recent `tick()` or `step()`.
  // - `eventHistory`: complete chronological event log across the session.
  const pendingCommandEvents: SimEvent[] = [];
  let lastTickEvents: SimEvent[] = [];
  const eventHistory: SimEvent[] = [];
  let activeTickCollector: SimEvent[] | null = null;

  function emitEvent(event: SimEvent): void {
    eventHistory.push(event);
    if (activeTickCollector) {
      activeTickCollector.push(event);
    } else {
      pendingCommandEvents.push(event);
    }
  }

  function rebuildSpatialHashes(): void {
    enemySpatialHash.rebuild(enemies);
    turretSpatialHash.rebuild(turrets);
  }

  function refreshDisruptorPaths(): void {
    for (const enemy of enemies) {
      if (enemy.enemyId !== 'rift-disruptor' || enemy.hp <= 0) continue;
      if (turrets.length > 0) {
        const detour = computeDisruptorDetourPath(
          enemy.position,
          turrets,
          currentNavGraph.corePosition,
          currentNavGraph,
          {
            portalId: enemy.portalId,
            laneIndex: enemy.laneIndex,
            empRadiusM: ENEMIES['rift-disruptor'].disruptorAbility?.empRadiusM ?? 1.2,
          },
        );
        enemy.path = detour;
        enemy.distanceAlongPath = 0;
        const sample = samplePathAtDistance(detour, 0);
        enemy.distanceToCore = sample.distanceToCore;
        enemy.progress = sample.progress;
      }
    }
  }

  function getActiveMusicCue(): MusicCueId {
    if (phase === 'victory') return MISSION_CONFIG.victoryMusicCue;
    if (phase === 'defeat') return MISSION_CONFIG.defeatMusicCue;
    if (phase === 'prep' || phase === 'intermission') return MISSION_CONFIG.prepMusicCue;
    const waveDef = waveTable[Math.max(0, Math.min(waveTable.length - 1, currentWave - 1))];
    return waveDef ? waveDef.musicCue : 'first-contact';
  }

  function openPortalsForWave(waveDef: WaveDefinition): void {
    const count = Math.min(portals.length, Math.max(1, waveDef.concurrentPortals));
    for (let i = 0; i < count; i += 1) {
      const portal = portals[i];
      if (!portal) continue;
      if (!portal.isOpen) {
        portal.isOpen = true;
        portal.openedAtTick = tickCount;
        emitEvent({
          type: 'portal-opened',
          tick: tickCount,
          timeSec,
          portalId: portal.id,
          portalIndex: portal.portalIndex,
          position: cloneVec3(portal.position),
          normal: cloneVec3(portal.normal),
          waveNumber: waveDef.waveNumber,
        });
      }
    }
  }

  function scheduleWaveSpawns(waveDef: WaveDefinition): void {
    const queue: ScheduledWaveSpawn[] = [];
    let seq = 0;
    for (const group of waveDef.spawnGroups) {
      for (let i = 0; i < group.count; i += 1) {
        queue.push({
          groupId: group.groupId,
          enemyId: group.enemyId,
          portalIndex: group.portalIndex,
          scheduledTimeSec: group.startDelaySec + i * group.spawnIntervalSec,
          sequenceIndex: seq,
          spawned: false,
        });
        seq += 1;
      }
    }
    queue.sort((a, b) =>
      a.scheduledTimeSec !== b.scheduledTimeSec
        ? a.scheduledTimeSec - b.scheduledTimeSec
        : a.sequenceIndex - b.sequenceIndex,
    );
    scheduledSpawns = queue;
  }

  function beginWave(waveNumber: number, earlyLaunchBonusCredits = 0): WaveDefinition {
    const clampedWave = Math.max(1, Math.min(totalWaves, waveNumber));
    const waveDef = waveTable[clampedWave - 1] ?? getWaveDefinition(clampedWave);

    currentWave = clampedWave;
    phase = 'wave';
    prepRemainingSec = 0;
    intermissionRemainingSec = 0;
    waveElapsedSec = 0;

    if (earlyLaunchBonusCredits > 0) {
      credits += earlyLaunchBonusCredits;
      totalCreditsEarned += earlyLaunchBonusCredits;
    }

    openPortalsForWave(waveDef);
    scheduleWaveSpawns(waveDef);

    // Draw once from `waves` PRNG stream on wave start so wave stream state advances deterministically
    wavesRng.next();

    emitEvent({
      type: 'wave-started',
      tick: tickCount,
      timeSec,
      waveNumber: waveDef.waveNumber,
      waveId: waveDef.id,
      title: waveDef.title,
      musicCue: waveDef.musicCue,
      concurrentPortals: waveDef.concurrentPortals,
      earlyLaunchBonusCredits,
      totalCredits: credits,
    });

    return waveDef;
  }

  function spawnEnemyInstance(enemyId: EnemyId, options: DebugSpawnEnemyOptions = {}): SimEnemy {
    const def = getEnemyDefinition(enemyId);
    const portalCount = Math.max(1, currentNavGraph.portals.length);
    const portalIndex =
      options.portalIndex !== undefined
        ? Math.max(0, Math.min(portalCount - 1, options.portalIndex))
        : 0;
    const fallbackPortal: NavPortalAnchorInput = {
      id: 'portal-0',
      position: { x: -0.9, y: 1.4, z: -2.1 },
      normal: { x: 0, y: 0, z: 1 },
      hostKind: 'wall',
      surfaceId: 'sim-wall-north',
    };
    const portalAnchor =
      (options.portalId
        ? currentNavGraph.portals.find((p) => p.id === options.portalId)
        : undefined) ??
      currentNavGraph.portals[portalIndex] ??
      DEFAULT_PORTAL_ANCHORS[0] ??
      fallbackPortal;

    const laneOptions = [-2, -1, 0, 1, 2] as const;
    const laneIndex =
      options.laneIndex !== undefined
        ? options.laneIndex
        : def.movementLayer === 'air'
          ? (laneOptions[aerialLaneCounter++ % laneOptions.length] ?? 0)
          : 0;

    const fallbackPath =
      currentNavGraph.getSurfacePath(portalAnchor.id) ??
      currentNavGraph.recoverCrawler(portalAnchor.position).path;

    let path: NavigationPath;
    if (options.position) {
      if (def.movementLayer === 'air') {
        path = computeDisruptorDetourPath(
          options.position,
          enemyId === 'rift-disruptor' ? turrets : [],
          currentNavGraph.corePosition,
          currentNavGraph,
          {
            portalId: portalAnchor.id,
            laneIndex,
            empRadiusM: def.disruptorAbility?.empRadiusM ?? 1.2,
            flightAltitudeM: options.position.y,
          },
        );
      } else {
        path = recoverStuckCrawler(options.position, currentNavGraph).path;
      }
    } else if (def.movementLayer === 'air') {
      if (enemyId === 'rift-disruptor' && turrets.length > 0) {
        path = computeDisruptorDetourPath(
          portalAnchor.position,
          turrets,
          currentNavGraph.corePosition,
          currentNavGraph,
          {
            portalId: portalAnchor.id,
            laneIndex,
            empRadiusM: def.disruptorAbility?.empRadiusM ?? 1.2,
          },
        );
      } else {
        path = currentNavGraph.getAirPath(portalAnchor.id, laneIndex) ?? fallbackPath;
      }
    } else {
      path = fallbackPath;
    }

    const initialDistanceAlongPath = options.position
      ? 0
      : Math.max(0, Math.min(path.totalLength, options.distanceAlongPath ?? 0));
    const initialSample = samplePathAtDistance(path, initialDistanceAlongPath);
    const startPosition = options.position
      ? cloneVec3(options.position)
      : cloneVec3(initialSample.position);
    const initialDistanceToCore = initialSample.distanceToCore;

    const id = options.id ?? `enemy-${nextEnemySeq++}`;
    const maxHp =
      options.maxHp !== undefined && options.maxHp > 0
        ? options.maxHp
        : options.hp !== undefined && options.hp > def.maxHp
          ? options.hp
          : def.maxHp;
    const initialHp =
      options.hp !== undefined && options.hp > 0 ? Math.min(maxHp, options.hp) : maxHp;
    const creditBounty =
      options.creditBounty !== undefined ? Math.max(0, options.creditBounty) : def.creditBounty;
    const isSummonedAdd = options.isSummonedAdd ?? false;

    const enemy: SimEnemy = {
      id,
      enemyId: def.id,
      archetypeId: def.id,
      name: def.name,
      hp: initialHp,
      maxHp,
      speedMps: def.speedMps,
      effectiveSpeedMps: def.speedMps,
      movementLayer: def.movementLayer,
      position: startPosition,
      tangent: cloneVec3(initialSample.tangent),
      normal: cloneVec3(initialSample.normal),
      locomotionMode: initialSample.locomotionMode,
      portalId: portalAnchor.id,
      portalIndex,
      laneIndex,
      path,
      distanceAlongPath: initialDistanceAlongPath,
      distanceToCore: initialDistanceToCore,
      progress: initialSample.progress,
      collisionRadiusM: def.collisionRadiusM,
      coreDamage: def.coreDamage,
      creditBounty,
      scoreValue: isSummonedAdd ? 0 : def.scoreValue,
      isBoss: def.isBoss,
      bossPhase: 1,
      isBossPhase2: false,
      emissiveIntensity: 0,
      isSummonedAdd,
      summonedByBossId: options.summonedByBossId ?? null,
      slowFactor: 0,
      slowRemainingSec: 0,
      burnStacks: 0,
      burnDps: 0,
      burnRemainingSec: 0,
      empCooldownSec: options.initialEmpCooldownSec ?? 0,
      bossSummonTimerSec: def.bossAbility?.summonIntervalSec ?? 8.5,
      bossSuppressionTimerSec: def.bossAbility?.suppressionPulseIntervalSec ?? 10.5,
      spawnTick: tickCount,
    };

    enemies.push(enemy);
    enemySpatialHash.insert(enemy);

    emitEvent({
      type: 'enemy-spawned',
      tick: tickCount,
      timeSec,
      enemyId: enemy.id,
      archetypeId: enemy.enemyId,
      portalId: enemy.portalId,
      portalIndex: enemy.portalIndex,
      position: cloneVec3(enemy.position),
      movementLayer: enemy.movementLayer,
      maxHp: enemy.maxHp,
      creditBounty: enemy.creditBounty,
      isBoss: enemy.isBoss,
      isSummonedAdd: enemy.isSummonedAdd,
      summonedByBossId: enemy.summonedByBossId,
    });

    return enemy;
  }

  // ==========================================================================
  // Damage, Status Effects & Kill Resolution
  // ==========================================================================

  function applyDamageToEnemy(params: {
    readonly enemy: SimEnemy;
    readonly rawDamage: number;
    readonly damageType: DamageType;
    readonly turret: SimTurret | null;
    readonly isDot?: boolean;
    readonly isSplash?: boolean;
    readonly isChain?: boolean;
    readonly isPiercing?: boolean;
  }): boolean {
    const { enemy, rawDamage, damageType, turret } = params;
    if (enemy.hp <= 0 || rawDamage <= 0) return false;

    const actualDamage = Math.min(enemy.hp, rawDamage);
    enemy.hp = Math.max(0, enemy.hp - rawDamage);

    if (turret) {
      turret.totalDamageDealt += actualDamage;
    }

    emitEvent({
      type: 'enemy-hit',
      tick: tickCount,
      timeSec,
      enemyId: enemy.id,
      archetypeId: enemy.enemyId,
      turretId: turret ? turret.id : null,
      damageType,
      damage: rawDamage,
      remainingHp: enemy.hp,
      maxHp: enemy.maxHp,
      position: cloneVec3(enemy.position),
      isDot: params.isDot ?? false,
      isSplash: params.isSplash ?? false,
      isChain: params.isChain ?? false,
      isPiercing: params.isPiercing ?? false,
    });

    // Check Apex Broodlord Phase-2 transition at <= 50% HP
    if (enemy.isBoss && enemy.hp > 0 && enemy.bossPhase === 1) {
      const bossDef = getEnemyDefinition(enemy.enemyId);
      const bossAbility = bossDef.bossAbility;
      if (bossAbility && enemy.hp <= enemy.maxHp * bossAbility.phase2HpThresholdRatio + 1e-6) {
        enemy.bossPhase = 2;
        enemy.isBossPhase2 = true;
        enemy.emissiveIntensity = bossAbility.phase2EmissiveIntensity;
        // Accelerate next summon upon entering Phase 2 frenzy
        enemy.bossSummonTimerSec = Math.min(enemy.bossSummonTimerSec, 0.5);

        emitEvent({
          type: 'boss-phase2',
          tick: tickCount,
          timeSec,
          bossEnemyId: enemy.id,
          archetypeId: 'apex-broodlord',
          hp: enemy.hp,
          maxHp: enemy.maxHp,
          position: cloneVec3(enemy.position),
          speedMultiplier: bossAbility.phase2SpeedMultiplier,
          kineticReduction: bossAbility.phase2KineticReduction,
        });
      }
    }

    if (enemy.hp <= 0) {
      if (turret) {
        turret.kills += 1;
      }
      totalEnemiesKilled += 1;
      if (enemy.creditBounty > 0) {
        credits += enemy.creditBounty;
        totalCreditsEarned += enemy.creditBounty;
      }
      if (enemy.scoreValue > 0) {
        score += enemy.scoreValue;
      }

      emitEvent({
        type: 'enemy-killed',
        tick: tickCount,
        timeSec,
        enemyId: enemy.id,
        archetypeId: enemy.enemyId,
        turretId: turret ? turret.id : null,
        damageType,
        position: cloneVec3(enemy.position),
        creditBounty: enemy.creditBounty,
        scoreAwarded: enemy.scoreValue,
        totalCredits: credits,
        totalScore: score,
        isBoss: enemy.isBoss,
      });

      const idx = enemies.indexOf(enemy);
      if (idx !== -1) {
        enemies.splice(idx, 1);
      }
      enemySpatialHash.remove(enemy, enemy.position);
      return true;
    }

    return false;
  }

  function applyThermalBurnToEnemy(
    enemy: SimEnemy,
    burnDps: number,
    burnDurationSec: number,
  ): void {
    if (enemy.hp <= 0 || burnDps <= 0 || burnDurationSec <= 0) return;

    if (enemy.burnRemainingSec > 0 && enemy.burnStacks > 0) {
      // Refresh burn duration and increment burn stack (up to MAX_BURN_STACKS)
      enemy.burnStacks = Math.min(MAX_BURN_STACKS, enemy.burnStacks + 1);
      enemy.burnRemainingSec = Math.max(enemy.burnRemainingSec, burnDurationSec);
      const baseDps = Math.max(burnDps, enemy.burnDps / Math.max(1, enemy.burnStacks - 1));
      enemy.burnDps = baseDps * (1 + 0.5 * (enemy.burnStacks - 1));
    } else {
      enemy.burnStacks = 1;
      enemy.burnDps = burnDps;
      enemy.burnRemainingSec = burnDurationSec;
    }
  }

  function applyCryoSlowToEnemy(
    enemy: SimEnemy,
    rawSlowFactor: number,
    slowDurationSec: number,
  ): number {
    if (enemy.hp <= 0 || rawSlowFactor <= 0 || slowDurationSec <= 0) return 0;
    const effectiveSlow = computeEffectiveSlowFactor(enemy.enemyId, rawSlowFactor);
    enemy.slowFactor = Math.max(enemy.slowFactor, effectiveSlow);
    enemy.slowRemainingSec = Math.max(enemy.slowRemainingSec, slowDurationSec);
    const def = getEnemyDefinition(enemy.enemyId);
    const phase2Mult =
      enemy.isBoss && enemy.isBossPhase2 && def.bossAbility
        ? def.bossAbility.phase2SpeedMultiplier
        : 1.0;
    enemy.effectiveSpeedMps = enemy.speedMps * phase2Mult * (1 - enemy.slowFactor);
    return effectiveSlow;
  }

  function disruptTurret(
    turret: SimTurret,
    sourceEnemy: SimEnemy,
    disableDurationSec: number,
    immunityCooldownSec: number,
  ): boolean {
    // Cannot stun a turret that is already disabled or inside its post-EMP immunity window
    if (turret.disabledRemainingSec > 0 || turret.empImmunityRemainingSec > 0) {
      return false;
    }

    turret.disabledRemainingSec = disableDurationSec;
    turret.pendingImmunityDurationSec = immunityCooldownSec;
    turret.isDisrupted = true;
    turret.targetEnemyId = null;

    emitEvent({
      type: 'turret-disrupted',
      tick: tickCount,
      timeSec,
      turretId: turret.id,
      turretKind: turret.kind,
      sourceEnemyId: sourceEnemy.id,
      sourceArchetypeId: sourceEnemy.enemyId,
      position: cloneVec3(turret.position),
      durationSec: disableDurationSec,
      immunityCooldownSec,
    });

    return true;
  }

  // ==========================================================================
  // Target Acquisition & Weapon Systems
  // ==========================================================================

  function compareEnemiesByPriority(
    turret: SimTurret,
    a: SimEnemy,
    b: SimEnemy,
    priority: SimTargetPriority,
  ): number {
    if (priority === 'air' || priority === 'air-priority') {
      const aIsAir = a.movementLayer === 'air' ? 1 : 0;
      const bIsAir = b.movementLayer === 'air' ? 1 : 0;
      if (aIsAir !== bIsAir) return bIsAir - aIsAir;
      // Within the same movement layer, prioritize Rift Disruptors first, then closest to Core
      const aIsDisruptor = a.enemyId === 'rift-disruptor' ? 1 : 0;
      const bIsDisruptor = b.enemyId === 'rift-disruptor' ? 1 : 0;
      if (aIsDisruptor !== bIsDisruptor) return bIsDisruptor - aIsDisruptor;
      const distDiff = a.distanceToCore - b.distanceToCore;
      if (Math.abs(distDiff) > 1e-4) return distDiff;
    } else if (priority === 'strongest') {
      const hpDiff = b.hp - a.hp;
      if (Math.abs(hpDiff) > 1e-4) return hpDiff;
      const maxHpDiff = b.maxHp - a.maxHp;
      if (Math.abs(maxHpDiff) > 1e-4) return maxHpDiff;
      const coreDiff = a.distanceToCore - b.distanceToCore;
      if (Math.abs(coreDiff) > 1e-4) return coreDiff;
    } else if (priority === 'closest') {
      const dA = distanceVec3(turret.position, a.position);
      const dB = distanceVec3(turret.position, b.position);
      const diff = dA - dB;
      if (Math.abs(diff) > 1e-4) return diff;
      const coreDiff = a.distanceToCore - b.distanceToCore;
      if (Math.abs(coreDiff) > 1e-4) return coreDiff;
    } else {
      // 'first': minimum distanceToCore
      const coreDiff = a.distanceToCore - b.distanceToCore;
      if (Math.abs(coreDiff) > 1e-4) return coreDiff;
    }

    // Seeded PRNG tie-breaker when two enemies are tied on primary & secondary metrics
    return targetingRng.next() < 0.5 ? -1 : 1;
  }

  function isPointInPlanarPolygon3D(
    point: Readonly<Vec3>,
    polygon: readonly Vec3[],
    normal: Readonly<Vec3>,
  ): boolean {
    if (polygon.length < 3) return false;
    // Build orthonormal basis (u, v) on the surface plane
    const refX = Math.abs(normal.y) < 0.9 ? 0 : 1;
    const refY = Math.abs(normal.y) < 0.9 ? 1 : 0;
    const refZ = 0;
    let ux = refY * normal.z - refZ * normal.y;
    let uy = refZ * normal.x - refX * normal.z;
    let uz = refX * normal.y - refY * normal.x;
    const uLen = Math.hypot(ux, uy, uz);
    if (uLen < 1e-8) return false;
    ux /= uLen;
    uy /= uLen;
    uz /= uLen;
    const vx = normal.y * uz - normal.z * uy;
    const vy = normal.z * ux - normal.x * uz;
    const vz = normal.x * uy - normal.y * ux;

    const pu = point.x * ux + point.y * uy + point.z * uz;
    const pv = point.x * vx + point.y * vy + point.z * vz;

    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const pi = polygon[i] as Vec3;
      const pj = polygon[j] as Vec3;
      const xi = pi.x * ux + pi.y * uy + pi.z * uz;
      const yi = pi.x * vx + pi.y * vy + pi.z * vz;
      const xj = pj.x * ux + pj.y * uy + pj.z * uz;
      const yj = pj.x * vx + pj.y * vy + pj.z * vz;

      const intersects =
        yi > pv !== yj > pv && pu < ((xj - xi) * (pv - yi)) / (yj - yi + 1e-12) + xi;
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function hasTurretLineOfSight(turret: SimTurret, targetPos: Readonly<Vec3>): boolean {
    const { up } = turret.pose;
    // 1. A surface-mounted turret cannot aim or shoot backwards through its own mounting surface.
    if (turret.mountProfile === 'surface-clamp') {
      const relX = targetPos.x - turret.position.x;
      const relY = targetPos.y - turret.position.y;
      const relZ = targetPos.z - turret.position.z;
      const frontDot = relX * up.x + relY * up.y + relZ * up.z;
      if (frontDot < -0.05) {
        return false;
      }
    }

    // 2. Reject targets blocked by any scanned room wall/ceiling/floor surface along the sightline.
    const blockout = turret.stats.blockout;
    const pivotHeight = blockout.baseHeightM + blockout.headHeightM / 2;
    const ax = turret.position.x + up.x * pivotHeight;
    const ay = turret.position.y + up.y * pivotHeight;
    const az = turret.position.z + up.z * pivotHeight;
    const dx = targetPos.x - ax;
    const dy = targetPos.y - ay;
    const dz = targetPos.z - az;

    for (const surface of surfaces) {
      if (surface.kind !== 'wall' && surface.kind !== 'ceiling' && surface.kind !== 'floor') {
        continue;
      }
      if (surface.id === turret.surfaceId) continue;
      if (surface.polygon.length < 3) continue;

      const nLen = Math.hypot(surface.normal.x, surface.normal.y, surface.normal.z);
      if (nLen < 1e-6) continue;
      const nx = surface.normal.x / nLen;
      const ny = surface.normal.y / nLen;
      const nz = surface.normal.z / nLen;

      const dA =
        (ax - surface.center.x) * nx + (ay - surface.center.y) * ny + (az - surface.center.z) * nz;
      const dB =
        (targetPos.x - surface.center.x) * nx +
        (targetPos.y - surface.center.y) * ny +
        (targetPos.z - surface.center.z) * nz;
      if (dA * dB >= 0) continue;

      const denom = dA - dB;
      if (Math.abs(denom) < 1e-6) continue;
      const t = dA / denom;
      if (t <= 0.04 || t >= 0.96) continue;

      const hit: Vec3 = {
        x: ax + dx * t,
        y: ay + dy * t,
        z: az + dz * t,
      };
      if (!isPointInPlanarPolygon3D(hit, surface.polygon, { x: nx, y: ny, z: nz })) {
        continue;
      }

      // Allow shots passing through an open portal aperture mounted on this wall/ceiling.
      const passesThroughPortal = portals.some((portal) => {
        if (!portal.isOpen) return false;
        const pDist = distanceVec3(hit, portal.position);
        return pDist <= 0.72;
      });
      if (!passesThroughPortal) {
        return false;
      }
    }

    return true;
  }

  function acquireTurretTarget(turret: SimTurret): SimEnemy | null {
    const def = TURRETS[turret.kind];
    const allowedLayers = def.targetLayers;
    const candidates = enemySpatialHash.queryRadius(
      turret.position,
      turret.stats.rangeM,
      (enemy) =>
        enemy.hp > 0 &&
        allowedLayers.includes(enemy.movementLayer) &&
        hasTurretLineOfSight(turret, enemy.position),
    );
    if (candidates.length === 0) return null;
    const firstCandidate = candidates[0];
    if (!firstCandidate) return null;
    if (candidates.length === 1) return firstCandidate;

    let best = firstCandidate;
    for (let i = 1; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      if (!candidate) continue;
      if (compareEnemiesByPriority(turret, candidate, best, turret.priority) < 0) {
        best = candidate;
      }
    }
    return best;
  }

  function aimTurret(
    turret: SimTurret,
    targetPos: Readonly<Vec3>,
  ): {
    muzzle: Vec3;
    arcHeightM: number;
  } {
    const blockout = turret.stats.blockout;
    const { right, up, forward } = turret.pose;
    const pivotHeight = blockout.baseHeightM + blockout.headHeightM / 2;
    const pivot = {
      x: turret.position.x + up.x * pivotHeight,
      y: turret.position.y + up.y * pivotHeight,
      z: turret.position.z + up.z * pivotHeight,
    };
    const arcHeightM =
      turret.kind === 'plasma-mortar'
        ? Math.min(1.35, Math.max(0.35, distanceVec3(pivot, targetPos) * 0.35))
        : 0;
    const dx = targetPos.x - pivot.x;
    // The derivative of the mortar's parabolic lift at launch is four times its arc height.
    const dy = targetPos.y - pivot.y + 4 * arcHeightM;
    const dz = targetPos.z - pivot.z;
    const localX = dx * right.x + dy * right.y + dz * right.z;
    const localY = dx * up.x + dy * up.y + dz * up.z;
    const localZ = dx * forward.x + dy * forward.y + dz * forward.z;
    turret.yaw = Math.atan2(localX, localZ);
    turret.pitch = Math.atan2(localY, Math.hypot(localX, localZ));
    const barrelReach =
      blockout.headLengthM * TURRET_BARREL_START_FRACTION + blockout.barrelLengthM;
    const muzzleScale = barrelReach / (Math.hypot(dx, dy, dz) || 1);
    return {
      muzzle: {
        x: pivot.x + dx * muzzleScale,
        y: pivot.y + dy * muzzleScale,
        z: pivot.z + dz * muzzleScale,
      },
      arcHeightM,
    };
  }

  function fireAutocannon(turret: SimTurret, target: SimEnemy, muzzle: Vec3): void {
    const stats = turret.stats;
    const mult = computeEffectiveDamageMultiplier({
      enemyId: target.enemyId,
      damageType: 'kinetic',
      armorPierceFactor: stats.armorPierceFactor,
      antiAirMultiplier: stats.antiAirMultiplier,
      bossBonusMultiplier: stats.bossBonusMultiplier,
      isBossPhase2: target.isBossPhase2,
    });
    const effectiveDamage = stats.damage * mult;

    emitEvent({
      type: 'turret-fired',
      tick: tickCount,
      timeSec,
      turretId: turret.id,
      turretKind: turret.kind,
      tier: turret.tier,
      damageType: 'kinetic',
      targetEnemyId: target.id,
      fromPosition: muzzle,
      toPosition: cloneVec3(target.position),
      projectileId: null,
    });

    applyDamageToEnemy({
      enemy: target,
      rawDamage: effectiveDamage,
      damageType: 'kinetic',
      turret,
    });
  }

  function firePlasmaMortar(
    turret: SimTurret,
    target: SimEnemy,
    startPos: Vec3,
    arcHeightM: number,
  ): void {
    const stats = turret.stats;
    const targetPos = cloneVec3(target.position);
    const dist = Math.max(0.25, distanceVec3(startPos, targetPos));
    const speedMps = Math.max(1.0, stats.projectileSpeedMps);
    const flightDurationSec = Math.max(SIM_FIXED_DT, dist / speedMps);

    const projectileId = `proj-${nextProjectileSeq++}`;
    const projectile: SimProjectile = {
      id: projectileId,
      turretId: turret.id,
      turretKind: turret.kind,
      tier: turret.tier,
      damageType: 'plasma',
      targetEnemyId: target.id,
      startPosition: startPos,
      targetPosition: targetPos,
      position: cloneVec3(startPos),
      velocity: {
        x: (targetPos.x - startPos.x) / flightDurationSec,
        y: (targetPos.y - startPos.y) / flightDurationSec,
        z: (targetPos.z - startPos.z) / flightDurationSec,
      },
      arcHeightM,
      speedMps,
      elapsedSec: 0,
      flightDurationSec,
      progress: 0,
      damage: stats.damage,
      aoeRadiusM: stats.aoeRadiusM,
      splashEdgeFalloff: stats.splashEdgeFalloff,
      burnDps: stats.burnDps,
      burnDurationSec: stats.burnDurationSec,
      armorPierceFactor: stats.armorPierceFactor,
      antiAirMultiplier: stats.antiAirMultiplier,
      bossBonusMultiplier: stats.bossBonusMultiplier,
    };

    projectiles.push(projectile);

    emitEvent({
      type: 'turret-fired',
      tick: tickCount,
      timeSec,
      turretId: turret.id,
      turretKind: turret.kind,
      tier: turret.tier,
      damageType: 'plasma',
      targetEnemyId: target.id,
      fromPosition: cloneVec3(startPos),
      toPosition: cloneVec3(targetPos),
      projectileId,
    });
  }

  function fireCryoArc(turret: SimTurret, primaryTarget: SimEnemy, muzzle: Vec3): void {
    const stats = turret.stats;
    const chainedTargets: SimEnemy[] = [primaryTarget];
    const visitedIds = new Set<string>([primaryTarget.id]);

    // Instantaneously chain across up to `stats.chainCount` (2 / 3 / 4) targets within `chainJumpRadiusM`
    let currentAnchor = primaryTarget;
    while (chainedTargets.length < stats.chainCount && stats.chainJumpRadiusM > 0) {
      const nextTarget = enemySpatialHash.findNearest(
        currentAnchor.position,
        stats.chainJumpRadiusM,
        (candidate) => candidate.hp > 0 && !visitedIds.has(candidate.id),
        (a, b) => {
          const coreDiff = a.distanceToCore - b.distanceToCore;
          if (Math.abs(coreDiff) > 1e-4) return coreDiff;
          return targetingRng.next() < 0.5 ? -1 : 1;
        },
      );
      if (!nextTarget) break;
      visitedIds.add(nextTarget.id);
      chainedTargets.push(nextTarget);
      currentAnchor = nextTarget;
    }

    const targetIds = chainedTargets.map((e) => e.id);
    const chainPositions = chainedTargets.map((e) => cloneVec3(e.position));

    emitEvent({
      type: 'turret-fired',
      tick: tickCount,
      timeSec,
      turretId: turret.id,
      turretKind: turret.kind,
      tier: turret.tier,
      damageType: 'cryo',
      targetEnemyId: primaryTarget.id,
      fromPosition: muzzle,
      toPosition: cloneVec3(primaryTarget.position),
      projectileId: null,
    });

    emitEvent({
      type: 'cryo-chain',
      tick: tickCount,
      timeSec,
      turretId: turret.id,
      tier: turret.tier,
      targetEnemyIds: targetIds,
      chainPositions,
      jumpCount: chainedTargets.length,
      slowFactor: stats.slowFactor,
    });

    for (let jumpIdx = 0; jumpIdx < chainedTargets.length; jumpIdx += 1) {
      const enemy = chainedTargets[jumpIdx];
      if (!enemy) continue;
      applyCryoSlowToEnemy(enemy, stats.slowFactor, stats.slowDurationSec);

      const retention = stats.chainDamageRetention ** jumpIdx;
      const mult = computeEffectiveDamageMultiplier({
        enemyId: enemy.enemyId,
        damageType: 'cryo',
        armorPierceFactor: stats.armorPierceFactor,
        antiAirMultiplier: stats.antiAirMultiplier,
        bossBonusMultiplier: stats.bossBonusMultiplier,
        isBossPhase2: enemy.isBossPhase2,
      });
      const jumpDamage = stats.damage * retention * mult;

      applyDamageToEnemy({
        enemy,
        rawDamage: jumpDamage,
        damageType: 'cryo',
        turret,
        isChain: jumpIdx > 0,
      });
    }
  }

  function fireRailSniper(turret: SimTurret, primaryTarget: SimEnemy, startPos: Vec3): void {
    const stats = turret.stats;
    const toTarget = {
      x: primaryTarget.position.x - startPos.x,
      y: primaryTarget.position.y - startPos.y,
      z: primaryTarget.position.z - startPos.z,
    };
    const len = Math.hypot(toTarget.x, toTarget.y, toTarget.z) || 1;
    const beamEnd: Vec3 = {
      x: startPos.x + (toTarget.x / len) * stats.rangeM,
      y: startPos.y + (toTarget.y / len) * stats.rangeM,
      z: startPos.z + (toTarget.z / len) * stats.rangeM,
    };

    // Find any additional enemies pierced along the 3D line-of-sight beam up to `rangeM`
    const candidatesInRange = enemySpatialHash.queryRadius(
      turret.position,
      stats.rangeM,
      (e) => e.hp > 0 && e.id !== primaryTarget.id && hasTurretLineOfSight(turret, e.position),
    );

    const piercedSecondary: Array<{ enemy: SimEnemy; t: number }> = [];
    for (const candidate of candidatesInRange) {
      const segCheck = pointToSegmentDistance3D(candidate.position, startPos, beamEnd);
      if (
        segCheck.t > 0.02 &&
        segCheck.distanceM <= candidate.collisionRadiusM + RAIL_PIERCE_BEAM_RADIUS_M
      ) {
        piercedSecondary.push({ enemy: candidate, t: segCheck.t });
      }
    }
    piercedSecondary.sort((a, b) => a.t - b.t);

    const piercedEnemyIds = [primaryTarget.id, ...piercedSecondary.map((p) => p.enemy.id)];

    emitEvent({
      type: 'turret-fired',
      tick: tickCount,
      timeSec,
      turretId: turret.id,
      turretKind: turret.kind,
      tier: turret.tier,
      damageType: 'rail',
      targetEnemyId: primaryTarget.id,
      fromPosition: cloneVec3(startPos),
      toPosition: cloneVec3(primaryTarget.position),
      projectileId: null,
      piercedEnemyIds,
    });

    // Primary target takes full armor-piercing + anti-air + boss-bonus damage
    const primaryMult = computeEffectiveDamageMultiplier({
      enemyId: primaryTarget.enemyId,
      damageType: 'rail',
      armorPierceFactor: stats.armorPierceFactor,
      antiAirMultiplier: stats.antiAirMultiplier,
      bossBonusMultiplier: stats.bossBonusMultiplier,
      isBossPhase2: primaryTarget.isBossPhase2,
    });
    applyDamageToEnemy({
      enemy: primaryTarget,
      rawDamage: stats.damage * primaryMult,
      damageType: 'rail',
      turret,
      isPiercing: true,
    });

    // Secondary enemies along the piercing beam line-of-sight take pierced rail damage
    for (const entry of piercedSecondary) {
      if (entry.enemy.hp <= 0) continue;
      const secMult = computeEffectiveDamageMultiplier({
        enemyId: entry.enemy.enemyId,
        damageType: 'rail',
        armorPierceFactor: stats.armorPierceFactor,
        antiAirMultiplier: stats.antiAirMultiplier,
        bossBonusMultiplier: stats.bossBonusMultiplier,
        isBossPhase2: entry.enemy.isBossPhase2,
      });
      applyDamageToEnemy({
        enemy: entry.enemy,
        rawDamage: stats.damage * RAIL_SECONDARY_PIERCE_RETENTION * secMult,
        damageType: 'rail',
        turret,
        isPiercing: true,
      });
    }
  }

  function stepProjectiles(dt: number): void {
    for (let i = projectiles.length - 1; i >= 0; i -= 1) {
      const proj = projectiles[i];
      if (!proj) continue;

      // Track live target position while target remains alive so parabolic mortar shells lead cleanly
      if (proj.targetEnemyId) {
        const liveTarget = enemies.find((e) => e.id === proj.targetEnemyId && e.hp > 0);
        if (liveTarget) {
          proj.targetPosition = cloneVec3(liveTarget.position);
        }
      }

      proj.elapsedSec += dt;
      const t = Math.min(1, proj.elapsedSec / Math.max(1e-5, proj.flightDurationSec));
      proj.progress = t;

      const parabola = 4 * t * (1 - t);
      const nextX = proj.startPosition.x + (proj.targetPosition.x - proj.startPosition.x) * t;
      const nextZ = proj.startPosition.z + (proj.targetPosition.z - proj.startPosition.z) * t;
      const baseLinearY = proj.startPosition.y + (proj.targetPosition.y - proj.startPosition.y) * t;
      const nextY = baseLinearY + proj.arcHeightM * parabola;

      proj.velocity = {
        x: (nextX - proj.position.x) / dt,
        y: (nextY - proj.position.y) / dt,
        z: (nextZ - proj.position.z) / dt,
      };
      proj.position = { x: nextX, y: nextY, z: nextZ };

      if (t >= 1 - 1e-6) {
        // Resolve parabolic Plasma Mortar AoE splash + thermal burn DoT
        const impactPos = cloneVec3(proj.targetPosition);
        const sourceTurret = turrets.find((tur) => tur.id === proj.turretId) ?? null;

        const splashedEnemies = enemySpatialHash.queryRadius(
          impactPos,
          proj.aoeRadiusM,
          (e) => e.hp > 0,
        );

        const hitEnemyIds = splashedEnemies.map((e) => e.id);
        emitEvent({
          type: 'projectile-impact',
          tick: tickCount,
          timeSec,
          projectileId: proj.id,
          turretId: proj.turretId,
          turretKind: proj.turretKind,
          damageType: proj.damageType,
          position: impactPos,
          aoeRadiusM: proj.aoeRadiusM,
          hitEnemyIds,
        });

        for (const enemy of splashedEnemies) {
          if (enemy.hp <= 0) continue;
          const dist = distanceVec3(impactPos, enemy.position);
          const isDirectTarget = enemy.id === proj.targetEnemyId || dist <= 0.08;
          const falloffRatio = isDirectTarget
            ? 1.0
            : Math.max(
                proj.splashEdgeFalloff,
                1.0 -
                  (1.0 - proj.splashEdgeFalloff) *
                    Math.min(1, dist / Math.max(1e-4, proj.aoeRadiusM)),
              );

          const mult = computeEffectiveDamageMultiplier({
            enemyId: enemy.enemyId,
            damageType: proj.damageType,
            armorPierceFactor: proj.armorPierceFactor,
            antiAirMultiplier: proj.antiAirMultiplier,
            bossBonusMultiplier: proj.bossBonusMultiplier,
            isBossPhase2: enemy.isBossPhase2,
          });

          const splashDamage = proj.damage * falloffRatio * mult;
          applyThermalBurnToEnemy(enemy, proj.burnDps, proj.burnDurationSec);
          applyDamageToEnemy({
            enemy,
            rawDamage: splashDamage,
            damageType: proj.damageType,
            turret: sourceTurret,
            isSplash: true,
          });
        }

        projectiles.splice(i, 1);
      }
    }
  }

  function stepTurrets(dt: number): void {
    for (const turret of turrets) {
      // 1. Update EMP / Boss suppression disable & post-recovery immunity timers
      if (turret.disabledRemainingSec > 0) {
        turret.disabledRemainingSec = Math.max(0, turret.disabledRemainingSec - dt);
        turret.isDisrupted = turret.disabledRemainingSec > 0;
        if (turret.disabledRemainingSec === 0) {
          const immunityDuration =
            turret.pendingImmunityDurationSec > 0 ? turret.pendingImmunityDurationSec : 5.0;
          turret.empImmunityRemainingSec = immunityDuration;
          turret.pendingImmunityDurationSec = 0;
          turret.isEmpImmune = immunityDuration > 0;
          emitEvent({
            type: 'turret-recovered',
            tick: tickCount,
            timeSec,
            turretId: turret.id,
            turretKind: turret.kind,
            position: cloneVec3(turret.position),
            immunityDurationSec: immunityDuration,
          });
        }
      } else if (turret.empImmunityRemainingSec > 0) {
        turret.empImmunityRemainingSec = Math.max(0, turret.empImmunityRemainingSec - dt);
        turret.isEmpImmune = turret.empImmunityRemainingSec > 0;
      }

      // 2. Update relocate redeploy warm-up cooldown
      if (turret.redeployCooldownSec > 0) {
        turret.redeployCooldownSec = Math.max(0, turret.redeployCooldownSec - dt);
        turret.isRedeploying = turret.redeployCooldownSec > 0;
      }

      // 3. Update weapon firing cooldown
      if (turret.fireCooldownSec > 0) {
        turret.fireCooldownSec = Math.max(0, turret.fireCooldownSec - dt);
      }

      // Disrupted or redeploying turrets cannot acquire targets or fire
      if (turret.disabledRemainingSec > 0 || turret.redeployCooldownSec > 0) {
        turret.targetEnemyId = null;
        continue;
      }

      const target = acquireTurretTarget(turret);
      if (!target) {
        turret.targetEnemyId = null;
        continue;
      }

      turret.targetEnemyId = target.id;
      const { muzzle, arcHeightM } = aimTurret(turret, target.position);

      if (turret.fireCooldownSec <= 1e-7) {
        turret.fireCooldownSec = turret.stats.fireIntervalSec;
        turret.shotsFired += 1;

        switch (turret.kind) {
          case 'autocannon':
            fireAutocannon(turret, target, muzzle);
            break;
          case 'plasma-mortar':
            firePlasmaMortar(turret, target, muzzle, arcHeightM);
            break;
          case 'cryo-arc':
            fireCryoArc(turret, target, muzzle);
            break;
          case 'rail-sniper':
            fireRailSniper(turret, target, muzzle);
            break;
        }
      }
    }
  }

  function stepEnemiesAndAbilities(dt: number): void {
    // Snapshot current enemies list so add-spawns during iteration are stable
    const currentEnemies = [...enemies];

    for (const enemy of currentEnemies) {
      if (enemy.hp <= 0) continue;

      // 1. Tick thermal burn DoT
      if (enemy.burnRemainingSec > 0 && enemy.burnDps > 0) {
        const burnMult = computeEffectiveDamageMultiplier({
          enemyId: enemy.enemyId,
          damageType: 'plasma',
          armorPierceFactor: 0.75,
          antiAirMultiplier: 1.0,
          bossBonusMultiplier: 1.1,
          isBossPhase2: enemy.isBossPhase2,
        });
        const burnTickDamage = enemy.burnDps * burnMult * dt;
        enemy.burnRemainingSec = Math.max(0, enemy.burnRemainingSec - dt);
        if (enemy.burnRemainingSec === 0) {
          enemy.burnStacks = 0;
          enemy.burnDps = 0;
        }
        const killedByBurn = applyDamageToEnemy({
          enemy,
          rawDamage: burnTickDamage,
          damageType: 'plasma',
          turret: null,
          isDot: true,
        });
        if (killedByBurn) continue;
      }

      // 2. Tick Cryo-Arc slow timer
      if (enemy.slowRemainingSec > 0) {
        enemy.slowRemainingSec = Math.max(0, enemy.slowRemainingSec - dt);
        if (enemy.slowRemainingSec === 0) {
          enemy.slowFactor = 0;
        }
      }

      // 3. Advance enemy along its navigation path
      const def = getEnemyDefinition(enemy.enemyId);
      const phase2Mult =
        enemy.isBoss && enemy.isBossPhase2 && def.bossAbility
          ? def.bossAbility.phase2SpeedMultiplier
          : 1.0;
      const effectiveSpeed = enemy.speedMps * phase2Mult * (1 - enemy.slowFactor);
      enemy.effectiveSpeedMps = effectiveSpeed;
      enemy.distanceAlongPath += effectiveSpeed * dt;

      const sample = samplePathAtDistance(enemy.path, enemy.distanceAlongPath);
      enemy.position = cloneVec3(sample.position);
      enemy.tangent = cloneVec3(sample.tangent);
      enemy.normal = cloneVec3(sample.normal);
      enemy.locomotionMode = sample.locomotionMode;
      enemy.distanceToCore = sample.distanceToCore;
      enemy.progress = sample.progress;

      // 4. Rift Disruptor EMP pulse check (1.2 m radius, 4.0 s disable, 5.0 s post-recovery immunity)
      if (def.disruptorAbility) {
        const emp = def.disruptorAbility;
        enemy.empCooldownSec = Math.max(0, enemy.empCooldownSec - dt);
        if (enemy.empCooldownSec <= 1e-7) {
          const nearbyTurrets = turretSpatialHash.queryRadius(enemy.position, emp.empRadiusM);
          if (nearbyTurrets.length > 0) {
            enemy.empCooldownSec = emp.empPulseIntervalSec;
            for (const turret of nearbyTurrets) {
              disruptTurret(
                turret,
                enemy,
                emp.empDisableDurationSec,
                emp.turretImmunityCooldownSec,
              );
            }
          }
        }
      }

      // 5. Apex Broodlord Boss abilities (0-bounty Skitter adds + turret-suppressing roar pulse)
      if (def.bossAbility) {
        const bossAb = def.bossAbility;
        enemy.bossSummonTimerSec = Math.max(0, enemy.bossSummonTimerSec - dt);
        if (enemy.bossSummonTimerSec <= 1e-7) {
          enemy.bossSummonTimerSec = bossAb.summonIntervalSec;
          const activeCap = getActiveEnemyCap();
          const desiredCount =
            enemy.bossPhase === 2 ? bossAb.summonCountPhase2 : bossAb.summonCountPhase1;
          const availableSlots = Math.max(0, activeCap - enemies.length);
          const toSpawn = Math.min(desiredCount, availableSlots);

          for (let s = 0; s < toSpawn; s += 1) {
            const offsetDist = Math.min(
              enemy.path.totalLength * 0.95,
              Math.max(0, enemy.distanceAlongPath + (s - (toSpawn - 1) * 0.5) * 0.25),
            );
            spawnEnemyInstance(bossAb.summonEnemyId, {
              portalId: enemy.portalId,
              portalIndex: enemy.portalIndex,
              distanceAlongPath: offsetDist,
              creditBounty: bossAb.summonedAddBounty,
              isSummonedAdd: true,
              summonedByBossId: enemy.id,
            });
          }
        }

        enemy.bossSuppressionTimerSec = Math.max(0, enemy.bossSuppressionTimerSec - dt);
        if (enemy.bossSuppressionTimerSec <= 1e-7) {
          const nearbyTurrets = turretSpatialHash.queryRadius(
            enemy.position,
            bossAb.suppressionPulseRadiusM,
          );
          if (nearbyTurrets.length > 0) {
            enemy.bossSuppressionTimerSec = bossAb.suppressionPulseIntervalSec;
            for (const turret of nearbyTurrets) {
              disruptTurret(
                turret,
                enemy,
                bossAb.suppressionDisableDurationSec,
                bossAb.suppressionImmunityCooldownSec,
              );
            }
          }
        }
      }

      // 6. Core arrival check
      if (sample.reachedCore) {
        coreHp = Math.max(0, coreHp - enemy.coreDamage);
        emitEvent({
          type: 'core-hit',
          tick: tickCount,
          timeSec,
          enemyId: enemy.id,
          archetypeId: enemy.enemyId,
          damage: enemy.coreDamage,
          remainingCoreHp: coreHp,
          maxCoreHp,
          position: cloneVec3(currentNavGraph.corePosition),
        });

        const idx = enemies.indexOf(enemy);
        if (idx !== -1) {
          enemies.splice(idx, 1);
        }
        enemySpatialHash.remove(enemy, enemy.position);

        if (coreHp <= 0 && phase !== 'defeat') {
          phase = 'defeat';
          emitEvent({
            type: 'mission-ended',
            tick: tickCount,
            timeSec,
            outcome: 'defeat',
            victory: false,
            waveNumber: currentWave,
            wavesCleared,
            remainingCoreHp: 0,
            maxCoreHp,
            credits,
            score,
            stars: 0,
          });
          return;
        }
      }
    }
  }

  function getActiveEnemyCap(): number {
    const waveDef = waveTable[Math.max(0, Math.min(waveTable.length - 1, currentWave - 1))];
    const waveCap = waveDef ? waveDef.maxActiveEnemies : MAX_ACTIVE_ENEMIES;
    return Math.min(MAX_ACTIVE_ENEMIES, waveCap);
  }

  function stepWaveSpawner(dt: number): void {
    if (phase !== 'wave') return;

    const activeCap = getActiveEnemyCap();
    for (const entry of scheduledSpawns) {
      if (entry.spawned) continue;
      if (waveElapsedSec + 1e-7 < entry.scheduledTimeSec) continue;
      if (enemies.length >= activeCap) {
        // Respect <= 25 concurrent enemy cap: hold remaining spawns until active enemies drop below cap
        break;
      }
      entry.spawned = true;
      spawnEnemyInstance(entry.enemyId, {
        portalIndex: entry.portalIndex,
      });
    }

    waveElapsedSec += dt;
  }

  function checkWaveClearOrProgression(dt: number): void {
    if (phase === 'victory' || phase === 'defeat') return;

    if (phase === 'prep') {
      if (!autoLaunchInitialWave) return;
      prepRemainingSec = Math.max(0, prepRemainingSec - dt);
      if (prepRemainingSec <= 1e-7) {
        beginWave(1, 0);
      }
      return;
    }

    if (phase === 'intermission') {
      intermissionRemainingSec = Math.max(0, intermissionRemainingSec - dt);
      if (intermissionRemainingSec <= 1e-7) {
        beginWave(currentWave + 1, 0);
      }
      return;
    }

    if (phase === 'wave') {
      const hasPendingSpawns = scheduledSpawns.some((s) => !s.spawned);
      if (!hasPendingSpawns && enemies.length === 0 && coreHp > 0) {
        const waveDef = waveTable[currentWave - 1];
        const clearBonus = waveDef ? waveDef.clearBonusCredits : 0;
        credits += clearBonus;
        totalCreditsEarned += clearBonus;
        score += clearBonus * 2;
        wavesCleared = Math.max(wavesCleared, currentWave);

        emitEvent({
          type: 'wave-cleared',
          tick: tickCount,
          timeSec,
          waveNumber: currentWave,
          clearBonusCredits: clearBonus,
          totalCredits: credits,
          remainingCoreHp: coreHp,
          totalScore: score,
        });

        if (currentWave >= totalWaves) {
          phase = 'victory';
          const stars = computeStarRatingFromCoreHp(coreHp, maxCoreHp, false);
          emitEvent({
            type: 'mission-ended',
            tick: tickCount,
            timeSec,
            outcome: 'victory',
            victory: true,
            waveNumber: currentWave,
            wavesCleared,
            remainingCoreHp: coreHp,
            maxCoreHp,
            credits,
            score,
            stars,
          });
        } else {
          phase = 'intermission';
          intermissionRemainingSec = waveDef
            ? waveDef.intermissionAfterSec
            : INTERMISSION_DURATION_SEC;
        }
      }
    }
  }

  function executeSingleFixedTick(): SimEvent[] {
    const tickEvents: SimEvent[] = [];
    if (pendingCommandEvents.length > 0) {
      tickEvents.push(...pendingCommandEvents);
      pendingCommandEvents.length = 0;
    }

    activeTickCollector = tickEvents;
    try {
      tickCount += 1;
      timeSec = tickCount * SIM_FIXED_DT;

      if (phase !== 'victory' && phase !== 'defeat') {
        // 1. Spawn any due wave enemies (respecting MAX_ACTIVE_ENEMIES = 25)
        stepWaveSpawner(SIM_FIXED_DT);

        // 2. Rebuild spatial hashes for fast O(1) cell queries before combat & movement
        rebuildSpatialHashes();

        // 3. Advance active enemies, burn DoTs, Cryo slows, Disruptor EMPs, Broodlord summons/roars, and Core hits
        stepEnemiesAndAbilities(SIM_FIXED_DT);

        if ((phase as SimCombatPhase) !== 'defeat') {
          // 4. Rebuild spatial hashes with updated enemy positions before turret target acquisition & projectile impacts
          rebuildSpatialHashes();

          // 5. Advance in-flight parabolic projectiles (Plasma Mortar AoE splash + burn DoT)
          stepProjectiles(SIM_FIXED_DT);

          // 6. Update turret cooldowns/recovery and fire weapons
          stepTurrets(SIM_FIXED_DT);

          // 7. Check wave completion or prep/intermission countdown expiration
          checkWaveClearOrProgression(SIM_FIXED_DT);
        }
      }
    } finally {
      activeTickCollector = null;
    }

    lastTickEvents = tickEvents;
    return tickEvents;
  }

  // ==========================================================================
  // Public Turret & Wave Commands
  // ==========================================================================

  function resolvePlacementCandidate(
    input: PlaceTurretInput,
    relocatingTurretId: string | null = null,
  ): PlacementValidationResult {
    const mountProfile: TurretMountProfileId =
      input.mountProfile ??
      input.mode ??
      (input.surface !== undefined ||
      input.surfaceKind !== undefined ||
      input.polygon !== undefined ||
      input.normal !== undefined ||
      input.surfaceNormal !== undefined
        ? 'surface-clamp'
        : 'hover-pod');

    const surface =
      input.surface !== undefined
        ? input.surface
        : input.surfaceId
          ? (surfaces.find((s) => s.id === input.surfaceId) ?? null)
          : null;

    const portalObstacles = portals.filter((p) => p.isOpen);

    return validateTurretPlacement(
      {
        kind: input.kind,
        mountProfile,
        position: input.position,
        normal: input.normal ?? input.surfaceNormal ?? surface?.normal,
        surface,
        surfaceId: input.surfaceId ?? surface?.id ?? null,
        surfaceKind:
          input.surfaceKind ?? surface?.kind ?? (mountProfile === 'surface-clamp' ? 'floor' : null),
        polygon: input.polygon,
        rayOrigin: input.rayOrigin,
        rayDistanceM: input.rayDistanceM,
        depthM: input.depthM,
        forwardHint: input.forwardHint,
      },
      {
        existingTurrets: turrets,
        corePosition: currentNavGraph.corePosition,
        portalAnchors: portalObstacles.length > 0 ? portalObstacles : currentNavGraph.portals,
        credits,
        relocatingTurretId,
      },
    );
  }

  function placeTurret(input: PlaceTurretInput): PlaceTurretResult {
    const validation = resolvePlacementCandidate(input, null);
    if (!validation.valid) {
      return {
        ok: false,
        valid: false,
        turret: null,
        reason: validation.reason,
        reasonLabel: validation.reasonLabel,
        cost: validation.cost,
        remainingCredits: credits,
        validation,
      };
    }

    const def = getTurretDefinition(input.kind);
    const tierStats = getTurretTierStats(input.kind, 'T1');
    const buildCost = validation.cost;
    credits -= buildCost;

    const priority: SimTargetPriority =
      input.priority && isSimTargetPriority(input.priority) ? input.priority : def.defaultPriority;

    const turretId = input.id ?? `turret-${nextTurretSeq++}`;
    const turret: SimTurret = {
      id: turretId,
      kind: def.kind,
      name: def.name,
      damageType: def.damageType,
      tier: 'T1',
      level: 1,
      position: cloneVec3(validation.pose.position),
      normal: cloneVec3(validation.pose.normal),
      mountProfile: validation.mountProfile,
      pose: validation.pose,
      surfaceId: validation.surfaceId,
      surfaceKind: validation.surfaceKind,
      priority,
      stats: tierStats,
      investedCredits: buildCost,
      sellRefundCredits: getTurretSellRefund(def.kind, 'T1'),
      fireCooldownSec: 0,
      redeployCooldownSec: 0,
      disabledRemainingSec: 0,
      empImmunityRemainingSec: 0,
      pendingImmunityDurationSec: 0,
      isDisrupted: false,
      isEmpImmune: false,
      isRedeploying: false,
      targetEnemyId: null,
      yaw: 0,
      pitch: 0,
      shotsFired: 0,
      totalDamageDealt: 0,
      kills: 0,
    };

    turrets.push(turret);
    turretSpatialHash.insert(turret);
    refreshDisruptorPaths();

    emitEvent({
      type: 'turret-placed',
      tick: tickCount,
      timeSec,
      turretId: turret.id,
      kind: turret.kind,
      tier: turret.tier,
      position: cloneVec3(turret.position),
      normal: cloneVec3(turret.normal),
      mountProfile: turret.mountProfile,
      cost: buildCost,
      remainingCredits: credits,
    });

    return {
      ok: true,
      valid: true,
      turret,
      reason: null,
      reasonLabel: null,
      cost: buildCost,
      remainingCredits: credits,
      validation,
    };
  }

  function upgradeTurret(turretId: string): UpgradeTurretResult {
    const turret = turrets.find((t) => t.id === turretId);
    if (!turret) {
      return {
        ok: false,
        turret: null,
        reason: 'TURRET_NOT_FOUND',
        previousTier: null,
        tier: null,
        cost: 0,
        remainingCredits: credits,
      };
    }

    const nextTier = getNextTurretTier(turret.tier);
    const upgradeCost = getTurretUpgradeCost(turret.kind, turret.tier);
    if (!nextTier || upgradeCost === null) {
      return {
        ok: false,
        turret,
        reason: 'MAX_TIER',
        previousTier: turret.tier,
        tier: turret.tier,
        cost: 0,
        remainingCredits: credits,
      };
    }

    if (credits < upgradeCost) {
      return {
        ok: false,
        turret,
        reason: 'INSUFFICIENT_CREDITS',
        previousTier: turret.tier,
        tier: turret.tier,
        cost: upgradeCost,
        remainingCredits: credits,
      };
    }

    const previousTier = turret.tier;
    const nextStats = getTurretTierStats(turret.kind, nextTier);
    credits -= upgradeCost;
    turret.tier = nextTier;
    turret.level = nextStats.level;
    turret.stats = nextStats;
    turret.investedCredits += upgradeCost;
    turret.sellRefundCredits = Math.round(turret.investedCredits * TURRET_SELL_REFUND_RATIO);

    emitEvent({
      type: 'turret-upgraded',
      tick: tickCount,
      timeSec,
      turretId: turret.id,
      kind: turret.kind,
      previousTier,
      tier: turret.tier,
      cost: upgradeCost,
      investedCredits: turret.investedCredits,
      remainingCredits: credits,
    });

    return {
      ok: true,
      turret,
      reason: null,
      previousTier,
      tier: turret.tier,
      cost: upgradeCost,
      remainingCredits: credits,
    };
  }

  function setTurretPriority(
    turretId: string,
    priority: SimTargetPriority,
  ): SetTurretPriorityResult {
    const turret = turrets.find((t) => t.id === turretId);
    if (!turret) {
      return {
        ok: false,
        turret: null,
        priority: null,
        reason: 'TURRET_NOT_FOUND',
      };
    }
    if (!isSimTargetPriority(priority)) {
      return {
        ok: false,
        turret,
        priority: turret.priority,
        reason: 'INVALID_PRIORITY',
      };
    }

    turret.priority = priority;
    return {
      ok: true,
      turret,
      priority: turret.priority,
      reason: null,
    };
  }

  function relocateTurret(
    turretIdOrInput: string | RelocateTurretInput,
    positionArg?: Readonly<Vec3>,
    optionsArg?: Partial<Omit<RelocateTurretInput, 'turretId' | 'position'>>,
  ): RelocateTurretResult {
    const input: RelocateTurretInput =
      typeof turretIdOrInput === 'string'
        ? {
            turretId: turretIdOrInput,
            position: positionArg ?? { x: 0, y: 0, z: 0 },
            ...optionsArg,
          }
        : turretIdOrInput;

    const turret = turrets.find((t) => t.id === input.turretId);
    if (!turret) {
      return {
        ok: false,
        valid: false,
        turret: null,
        reason: 'TURRET_NOT_FOUND',
        reasonLabel: 'TURRET NOT FOUND',
        cost: TURRET_RELOCATE_COST,
        redeployCooldownSec: 0,
        remainingCredits: credits,
        validation: null,
      };
    }

    const validation = resolvePlacementCandidate(
      {
        kind: turret.kind,
        position: input.position,
        mountProfile: input.mountProfile ?? turret.mountProfile,
        normal: input.normal,
        surface: input.surface,
        surfaceId: input.surfaceId,
        surfaceKind: input.surfaceKind,
        polygon: input.polygon,
        rayOrigin: input.rayOrigin,
        rayDistanceM: input.rayDistanceM,
        depthM: input.depthM,
        forwardHint: input.forwardHint,
      },
      turret.id,
    );

    if (!validation.valid) {
      return {
        ok: false,
        valid: false,
        turret,
        reason: validation.reason,
        reasonLabel: validation.reasonLabel,
        cost: validation.cost,
        redeployCooldownSec: turret.redeployCooldownSec,
        remainingCredits: credits,
        validation,
      };
    }

    const fromPosition = cloneVec3(turret.position);
    credits -= validation.cost;
    turret.position = cloneVec3(validation.pose.position);
    turret.normal = cloneVec3(validation.pose.normal);
    turret.mountProfile = validation.mountProfile;
    turret.pose = validation.pose;
    turret.surfaceId = validation.surfaceId;
    turret.surfaceKind = validation.surfaceKind;
    turret.redeployCooldownSec = TURRET_REDEPLOY_COOLDOWN_SEC;
    turret.isRedeploying = true;
    turret.targetEnemyId = null;

    rebuildSpatialHashes();
    refreshDisruptorPaths();

    emitEvent({
      type: 'turret-relocated',
      tick: tickCount,
      timeSec,
      turretId: turret.id,
      kind: turret.kind,
      fromPosition,
      toPosition: cloneVec3(turret.position),
      mountProfile: turret.mountProfile,
      cost: validation.cost,
      redeployCooldownSec: TURRET_REDEPLOY_COOLDOWN_SEC,
      remainingCredits: credits,
    });

    return {
      ok: true,
      valid: true,
      turret,
      reason: null,
      reasonLabel: null,
      cost: validation.cost,
      redeployCooldownSec: TURRET_REDEPLOY_COOLDOWN_SEC,
      remainingCredits: credits,
      validation,
    };
  }

  function sellTurret(turretId: string): SellTurretResult {
    const idx = turrets.findIndex((t) => t.id === turretId);
    if (idx === -1) {
      return {
        ok: false,
        turret: null,
        reason: 'TURRET_NOT_FOUND',
        refundCredits: 0,
        remainingCredits: credits,
      };
    }

    const turret = turrets[idx];
    if (!turret) {
      return {
        ok: false,
        turret: null,
        reason: 'TURRET_NOT_FOUND',
        refundCredits: 0,
        remainingCredits: credits,
      };
    }
    turrets.splice(idx, 1);
    turretSpatialHash.remove(turret, turret.position);

    const refundCredits = Math.round(turret.investedCredits * TURRET_SELL_REFUND_RATIO);
    credits += refundCredits;
    refreshDisruptorPaths();

    emitEvent({
      type: 'turret-sold',
      tick: tickCount,
      timeSec,
      turretId: turret.id,
      kind: turret.kind,
      tier: turret.tier,
      position: cloneVec3(turret.position),
      refundCredits,
      remainingCredits: credits,
    });

    return {
      ok: true,
      turret,
      reason: null,
      refundCredits,
      remainingCredits: credits,
    };
  }

  function launchWave(): LaunchWaveResult {
    if (phase === 'prep') {
      const waveDef = beginWave(1, 0);
      return {
        ok: true,
        waveNumber: waveDef.waveNumber,
        bonusCredits: 0,
        remainingCredits: credits,
      };
    }

    if (phase === 'intermission') {
      const bonus = computeEarlyLaunchBonus(intermissionRemainingSec);
      const nextWaveNumber = Math.min(totalWaves, currentWave + 1);
      const waveDef = beginWave(nextWaveNumber, bonus);
      return {
        ok: true,
        waveNumber: waveDef.waveNumber,
        bonusCredits: bonus,
        remainingCredits: credits,
      };
    }

    return {
      ok: false,
      waveNumber: currentWave,
      bonusCredits: 0,
      remainingCredits: credits,
    };
  }

  function setNavigationGraph(graph: RoomNavigationGraph): void {
    currentNavGraph = graph;
    for (const enemy of enemies) {
      if (enemy.hp <= 0) continue;
      if (enemy.movementLayer === 'surface') {
        const recovered = recoverStuckCrawler(enemy.position, currentNavGraph);
        enemy.path = recovered.path;
        enemy.distanceAlongPath = 0;
        const sample = samplePathAtDistance(enemy.path, 0);
        enemy.distanceToCore = sample.distanceToCore;
        enemy.progress = sample.progress;
      } else if (enemy.enemyId === 'rift-disruptor' && turrets.length > 0) {
        enemy.path = computeDisruptorDetourPath(
          enemy.position,
          turrets,
          currentNavGraph.corePosition,
          currentNavGraph,
          { portalId: enemy.portalId, laneIndex: enemy.laneIndex },
        );
        enemy.distanceAlongPath = 0;
      }
    }
  }

  function getState(): CombatSimulationState {
    const defeat = phase === 'defeat' || coreHp <= 0;
    const victory = phase === 'victory';
    const starPreview = computeStarRatingFromCoreHp(coreHp, maxCoreHp, defeat);
    const pendingWaveSpawns = scheduledSpawns.reduce((acc, s) => acc + (s.spawned ? 0 : 1), 0);

    return {
      seed,
      tick: tickCount,
      timeSec,
      accumulatorSec,
      phase,
      currentWave,
      wavesCleared,
      totalWaves,
      credits,
      coreHp,
      maxCoreHp,
      score,
      starRatingPreview: starPreview,
      stars: victory || defeat ? starPreview : starPreview,
      victory,
      defeat,
      prepRemainingSec,
      intermissionRemainingSec,
      waveElapsedSec,
      pendingWaveSpawns,
      totalEnemiesKilled,
      totalCreditsEarned,
      musicCue: getActiveMusicCue(),
      corePosition: cloneVec3(currentNavGraph.corePosition),
      coreRadius: currentNavGraph.coreRadius,
      portals,
      activePortals: portals.filter((p) => p.isOpen),
      turrets,
      enemies,
      projectiles,
    };
  }

  function computeStateHash(): string {
    const state = getState();
    const parts: string[] = [
      `seed:${state.seed}`,
      `tick:${state.tick}`,
      `phase:${state.phase}`,
      `wave:${state.currentWave}/${state.wavesCleared}`,
      `credits:${state.credits}`,
      `core:${quantize(state.coreHp)}/${quantize(state.maxCoreHp)}`,
      `score:${state.score}`,
      `stars:${state.stars}`,
      `timers:${quantize(state.prepRemainingSec)},${quantize(state.intermissionRemainingSec)},${quantize(state.waveElapsedSec)}`,
      `pending:${state.pendingWaveSpawns}`,
      `killed:${state.totalEnemiesKilled}`,
      `rng:${wavesRng.draws},${targetingRng.draws}`,
    ];

    for (const portal of state.portals) {
      parts.push(`P:${portal.id}:${portal.isOpen ? 1 : 0}:${portal.openedAtTick ?? -1}`);
    }

    for (const t of state.turrets) {
      parts.push(
        `T:${t.id}:${t.kind}:${t.tier}:${t.mountProfile}:${t.priority}:${quantize(t.position.x)},${quantize(t.position.y)},${quantize(t.position.z)}:${t.investedCredits}:${quantize(t.fireCooldownSec)}:${quantize(t.redeployCooldownSec)}:${quantize(t.disabledRemainingSec)}:${quantize(t.empImmunityRemainingSec)}:${t.shotsFired}:${t.kills}`,
      );
    }

    for (const e of state.enemies) {
      parts.push(
        `E:${e.id}:${e.enemyId}:${quantize(e.hp)}:${quantize(e.distanceAlongPath)}:${quantize(e.position.x)},${quantize(e.position.y)},${quantize(e.position.z)}:${quantize(e.slowFactor)}:${quantize(e.slowRemainingSec)}:${e.burnStacks}:${quantize(e.burnDps)}:${quantize(e.burnRemainingSec)}:${e.bossPhase}`,
      );
    }

    for (const pr of state.projectiles) {
      parts.push(
        `J:${pr.id}:${pr.turretId}:${pr.targetEnemyId ?? '-'}:${quantize(pr.progress)}:${quantize(pr.position.x)},${quantize(pr.position.y)},${quantize(pr.position.z)}`,
      );
    }

    const canonical = parts.join('|');
    const h1 = hashString(canonical);
    const h2 = hashString(`${canonical}#${state.tick}`);
    return `0x${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
  }

  // ==========================================================================
  // `?debug` Verification Helpers & ActionBus Handler
  // ==========================================================================

  function debugJumpToWave(
    waveNumber: number,
    options: DebugJumpToWaveOptions = {},
  ): WaveDefinition {
    const clearEnemies = options.clearExistingEnemies ?? true;
    const clearProjs = options.clearProjectiles ?? true;
    const startImmediately = options.startImmediately ?? true;

    if (clearEnemies) {
      enemies.length = 0;
      enemySpatialHash.clear();
    }
    if (clearProjs) {
      projectiles.length = 0;
    }

    const clamped = Math.max(1, Math.min(totalWaves, Math.trunc(waveNumber)));
    wavesCleared = Math.max(wavesCleared, clamped - 1);

    if (startImmediately) {
      return beginWave(clamped, 0);
    }

    currentWave = clamped - 1;
    phase = 'intermission';
    intermissionRemainingSec = INTERMISSION_DURATION_SEC;
    return waveTable[clamped - 1] ?? getWaveDefinition(clamped);
  }

  function debugGrantCredits(amount: number): number {
    if (Number.isFinite(amount) && amount > 0) {
      const add = Math.round(amount);
      credits += add;
      totalCreditsEarned += add;
    }
    return credits;
  }

  function debugSpawnEnemy(enemyId: EnemyId, options: DebugSpawnEnemyOptions = {}): SimEnemy {
    return spawnEnemyInstance(enemyId, options);
  }

  function debugSpawnBoss(options: DebugSpawnEnemyOptions = {}): SimEnemy {
    return spawnEnemyInstance('apex-broodlord', options);
  }

  function handleAction(action: GameAction): void {
    switch (action.type) {
      case 'turret/build':
        placeTurret({
          kind: action.kind,
          position: action.position,
          surfaceId: action.surfaceId,
        });
        break;
      case 'turret/upgrade':
        upgradeTurret(action.turretId);
        break;
      case 'turret/relocate':
        relocateTurret({
          turretId: action.turretId,
          position: action.position,
          surfaceId: action.surfaceId,
        });
        break;
      case 'turret/sell':
        sellTurret(action.turretId);
        break;
      case 'turret/set-priority':
        setTurretPriority(action.turretId, action.priority);
        break;
      case 'wave/launch':
        launchWave();
        break;
      default:
        break;
    }
  }

  function attachActionBus(bus: ActionBus): () => void {
    return bus.onAny((action) => {
      handleAction(action);
    });
  }

  if (config.autoStartWave1) {
    beginWave(1, 0);
  }

  return {
    seed,
    streams,
    get navGraph() {
      return currentNavGraph;
    },
    enemySpatialHash,
    turretSpatialHash,

    tick(): SimTickResult {
      const events = executeSingleFixedTick();
      return {
        tick: tickCount,
        timeSec,
        ticksExecuted: 1,
        phase,
        events,
        state: getState(),
      };
    },

    step(dtSec?: number, maxSubSteps = 3600): SimTickResult {
      if (dtSec === undefined) {
        const events = executeSingleFixedTick();
        return {
          tick: tickCount,
          timeSec,
          ticksExecuted: 1,
          phase,
          events,
          state: getState(),
        };
      }

      if (!Number.isFinite(dtSec) || dtSec <= 0) {
        return {
          tick: tickCount,
          timeSec,
          ticksExecuted: 0,
          phase,
          events: [],
          state: getState(),
        };
      }

      accumulatorSec += dtSec;
      const aggregatedEvents: SimEvent[] = [];
      let ticksExecuted = 0;

      while (accumulatorSec + 1e-9 >= SIM_FIXED_DT && ticksExecuted < maxSubSteps) {
        accumulatorSec = Math.max(0, accumulatorSec - SIM_FIXED_DT);
        const tickEvents = executeSingleFixedTick();
        if (tickEvents.length > 0) {
          aggregatedEvents.push(...tickEvents);
        }
        ticksExecuted += 1;
      }

      if (aggregatedEvents.length > 0) {
        lastTickEvents = aggregatedEvents;
      }

      return {
        tick: tickCount,
        timeSec,
        ticksExecuted,
        phase,
        events: aggregatedEvents,
        state: getState(),
      };
    },

    runTicks(count: number): SimTickResult {
      const steps = Math.max(0, Math.trunc(count));
      const aggregatedEvents: SimEvent[] = [];
      for (let i = 0; i < steps; i += 1) {
        const tickEvents = executeSingleFixedTick();
        if (tickEvents.length > 0) {
          aggregatedEvents.push(...tickEvents);
        }
      }
      if (aggregatedEvents.length > 0) {
        lastTickEvents = aggregatedEvents;
      }
      return {
        tick: tickCount,
        timeSec,
        ticksExecuted: steps,
        phase,
        events: aggregatedEvents,
        state: getState(),
      };
    },

    placeTurret,
    upgradeTurret,
    setTurretPriority,
    relocateTurret,
    sellTurret,
    validatePlacement: resolvePlacementCandidate,
    launchWave,
    startNextWave: launchWave,
    setNavigationGraph,

    getState,
    getTurret(turretId: string): SimTurret | undefined {
      return turrets.find((t) => t.id === turretId);
    },
    getEnemy(enemyId: string): SimEnemy | undefined {
      return enemies.find((e) => e.id === enemyId);
    },
    getEvents(): readonly SimEvent[] {
      if (pendingCommandEvents.length > 0) {
        return [...lastTickEvents, ...pendingCommandEvents];
      }
      return lastTickEvents;
    },
    drainEvents(): SimEvent[] {
      const out = [...lastTickEvents, ...pendingCommandEvents];
      lastTickEvents = [];
      pendingCommandEvents.length = 0;
      return out;
    },
    getEventHistory(): readonly SimEvent[] {
      return eventHistory;
    },
    computeStateHash,

    handleAction,
    attachActionBus,

    debugJumpToWave,
    debugGrantCredits,
    debugSpawnEnemy,
    debugSpawnBoss,
  };
}
