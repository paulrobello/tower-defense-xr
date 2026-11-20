/**
 * Declarative tactical turret definitions (4 roles × 3 upgrade tiers) and placement/economy rules.
 * Pure TypeScript data & calculation helpers — ZERO Three.js imports.
 *
 * References:
 * - PRD.md §D6 (Placement & 14-turret cap), §D7 (4-Role Tactical Turret Kit × 3 Tiers), §Quest 3 Budgets
 * - plans/phase-2-combat-simulation-and-waves.md (P2-T2)
 */

import {
  TARGET_PRIORITIES,
  type TargetPriority,
  TURRET_KINDS,
  type TurretKind,
  type Vec3,
} from '../core/action-bus.ts';

export { TARGET_PRIORITIES, type TargetPriority, TURRET_KINDS, type TurretKind, type Vec3 };

export const TURRET_TIERS = ['T1', 'T2', 'T3'] as const;
export type TurretTierId = (typeof TURRET_TIERS)[number];
export type TurretTierNumber = 1 | 2 | 3;

export const TURRET_MOUNT_IDS = ['surface-clamp', 'hover-pod'] as const;
export type TurretMountProfileId = (typeof TURRET_MOUNT_IDS)[number];

export const DAMAGE_TYPES = ['kinetic', 'plasma', 'cryo', 'rail'] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];

export const MOVEMENT_LAYERS = ['surface', 'air'] as const;
export type MovementLayer = (typeof MOVEMENT_LAYERS)[number];

export const ATTACHABLE_SURFACE_KINDS = ['floor', 'table', 'wall'] as const;
export type AttachableSurfaceKind = (typeof ATTACHABLE_SURFACE_KINDS)[number];

/** Footprint radius of every turret base (meters). */
export const TURRET_FOOTPRINT_RADIUS_M = 0.16;

/** Minimum center-to-center spacing between any two placed turrets (meters). */
export const TURRET_MIN_SPACING_M = 0.35;

/** Hard cap on simultaneously active player turrets (protects balance & Quest 3 frame budget). */
export const HARD_TURRET_CAP = 14;
export const MAX_ACTIVE_TURRETS = HARD_TURRET_CAP;

/** Credit refund ratio when selling a turret (applied to cumulative invested credits). */
export const TURRET_SELL_REFUND_RATIO = 0.75;

/** Flat Requisition credit fee to relocate an existing turret live or between waves. */
export const TURRET_RELOCATE_COST = 25;

/** Brief redeploy warm-up cooldown after relocating a turret before firing resumes (seconds). */
export const TURRET_REDEPLOY_COOLDOWN_SEC = 1.5;

/** Keep-out radius around the Core Bastion center where turrets cannot be placed (meters). */
export const CORE_KEEP_OUT_RADIUS_M = 0.55;

/** Keep-out radius around any dimensional rift portal anchor (meters). */
export const PORTAL_KEEP_OUT_RADIUS_M = 0.65;

/** Valid controller ray distance window for surface-clamp auto-snap (meters). */
export const SURFACE_SNAP_MIN_RANGE_M = 0.5;
export const SURFACE_SNAP_MAX_RANGE_M = 6.0;

/** Valid thumbstick push/pull depth window for mid-air hover-pod placement (meters). */
export const HOVER_POD_MIN_DEPTH_M = 0.8;
export const HOVER_POD_MAX_DEPTH_M = 5.0;

export interface TurretPlacementConstraints {
  readonly footprintRadiusM: number;
  readonly minSpacingM: number;
  readonly hardTurretCap: number;
  readonly sellRefundRatio: number;
  readonly relocateCost: number;
  readonly redeployCooldownSec: number;
  readonly coreKeepOutRadiusM: number;
  readonly portalKeepOutRadiusM: number;
  readonly surfaceSnapMinRangeM: number;
  readonly surfaceSnapMaxRangeM: number;
  readonly hoverPodMinDepthM: number;
  readonly hoverPodMaxDepthM: number;
}

export const TURRET_PLACEMENT_CONSTRAINTS: TurretPlacementConstraints = {
  footprintRadiusM: TURRET_FOOTPRINT_RADIUS_M,
  minSpacingM: TURRET_MIN_SPACING_M,
  hardTurretCap: HARD_TURRET_CAP,
  sellRefundRatio: TURRET_SELL_REFUND_RATIO,
  relocateCost: TURRET_RELOCATE_COST,
  redeployCooldownSec: TURRET_REDEPLOY_COOLDOWN_SEC,
  coreKeepOutRadiusM: CORE_KEEP_OUT_RADIUS_M,
  portalKeepOutRadiusM: PORTAL_KEEP_OUT_RADIUS_M,
  surfaceSnapMinRangeM: SURFACE_SNAP_MIN_RANGE_M,
  surfaceSnapMaxRangeM: SURFACE_SNAP_MAX_RANGE_M,
  hoverPodMinDepthM: HOVER_POD_MIN_DEPTH_M,
  hoverPodMaxDepthM: HOVER_POD_MAX_DEPTH_M,
};

export interface TurretMountProfile {
  readonly id: TurretMountProfileId;
  readonly label: string;
  readonly description: string;
  readonly alignsToSurfaceNormal: boolean;
  readonly allowedSurfaces: readonly AttachableSurfaceKind[];
  readonly minDistanceM: number;
  readonly maxDistanceM: number;
  readonly blockout: {
    readonly radiusM: number;
    readonly heightM: number;
    readonly legCount: number;
    readonly emissiveRingRadiusM: number;
  };
}

export const TURRET_MOUNT_PROFILES: Record<TurretMountProfileId, TurretMountProfile> = {
  'surface-clamp': {
    id: 'surface-clamp',
    label: 'Articulated Surface Clamp',
    description:
      'Flush mechanical clamp base that locks onto scanned floors, tables, or walls aligned to the surface normal.',
    alignsToSurfaceNormal: true,
    allowedSurfaces: ['floor', 'table', 'wall'],
    minDistanceM: SURFACE_SNAP_MIN_RANGE_M,
    maxDistanceM: SURFACE_SNAP_MAX_RANGE_M,
    blockout: {
      radiusM: TURRET_FOOTPRINT_RADIUS_M,
      heightM: 0.055,
      legCount: 4,
      emissiveRingRadiusM: 0.11,
    },
  },
  'hover-pod': {
    id: 'hover-pod',
    label: 'Repulsor Hover-Ring Pod',
    description:
      'Mid-air gravitic repulsor ring deployed via thumbstick depth push/pull at 0.8–5.0 m.',
    alignsToSurfaceNormal: false,
    allowedSurfaces: [],
    minDistanceM: HOVER_POD_MIN_DEPTH_M,
    maxDistanceM: HOVER_POD_MAX_DEPTH_M,
    blockout: {
      radiusM: TURRET_FOOTPRINT_RADIUS_M,
      heightM: 0.07,
      legCount: 0,
      emissiveRingRadiusM: 0.145,
    },
  },
};

export interface TurretBlockoutDimensions {
  readonly footprintRadiusM: number;
  readonly baseHeightM: number;
  readonly headWidthM: number;
  readonly headHeightM: number;
  readonly headLengthM: number;
  readonly totalHeightM: number;
  readonly barrelLengthM: number;
  readonly barrelRadiusM: number;
  readonly barrelCount: number;
  readonly muzzleOffsetM: Readonly<Vec3>;
}

export interface TurretMeshBudget {
  readonly maxLod0Tris: number;
  readonly maxLod1Tris: number;
  readonly lodSwapDistanceM: number;
  readonly maxMaterials: number;
  readonly textureSizePx: number;
}

export const DEFAULT_TURRET_MESH_BUDGET: TurretMeshBudget = {
  maxLod0Tris: 6500,
  maxLod1Tris: 2500,
  lodSwapDistanceM: 4.0,
  maxMaterials: 2,
  textureSizePx: 1024,
};

export interface TurretTierStats {
  readonly tier: TurretTierId;
  readonly level: TurretTierNumber;
  readonly label: string;
  readonly summary: string;
  /** Build cost for T1; incremental upgrade cost for T2 and T3. */
  readonly cost: number;
  /** Total Requisition credits invested to reach this tier from scratch. */
  readonly cumulativeCost: number;
  /** Exact 75% sell refund in Requisition credits at this tier. */
  readonly sellRefundCredits: number;
  /** Effective engagement range (meters). */
  readonly rangeM: number;
  /** Attacks per second (Hz). */
  readonly fireRateHz: number;
  /** Seconds between shots (`1 / fireRateHz`). */
  readonly fireIntervalSec: number;
  /** Direct hit damage before armor / anti-air / boss multipliers. */
  readonly damage: number;
  /** Projectile speed in m/s (`0` for instant beam/arc weapons). */
  readonly projectileSpeedMps: number;
  /** Splash damage radius in meters (`0` for single-target weapons). */
  readonly aoeRadiusM: number;
  /** Minimum splash damage ratio at the outer edge of `aoeRadiusM` (`0..1`). */
  readonly splashEdgeFalloff: number;
  /** Thermal burn damage over time per second (`0` if none). */
  readonly burnDps: number;
  /** Thermal burn duration in seconds (`0` if none). */
  readonly burnDurationSec: number;
  /** Movement speed reduction ratio (`0.35` = 35% slow; `0` if none). */
  readonly slowFactor: number;
  /** Cryo slow duration in seconds (`0` if none). */
  readonly slowDurationSec: number;
  /** Total targets hit by a chain-lightning pulse (`2..4` for Cryo-Arc; `1` otherwise). */
  readonly chainCount: number;
  /** Maximum jump distance in meters between chained targets (`0` if no chain). */
  readonly chainJumpRadiusM: number;
  /** Damage retention factor per chain jump (`0..1`). */
  readonly chainDamageRetention: number;
  /** Fraction of target armor reduction ignored (`0..1`). */
  readonly armorPierceFactor: number;
  /** Damage multiplier against aerial (`air` movement layer) invaders (`>= 1`). */
  readonly antiAirMultiplier: number;
  /** Damage multiplier against boss (`isBoss === true`) invaders (`>= 1`). */
  readonly bossBonusMultiplier: number;
  /** Precomputed unarmored single-target sustained DPS (`damage * fireRateHz + burnDps`). */
  readonly nominalSingleTargetDps: number;
  /** Precomputed effective multi-target / specialization DPS for balance monotonicity checks. */
  readonly nominalEffectiveDps: number;
  readonly blockout: TurretBlockoutDimensions;
  readonly meshBudget: TurretMeshBudget;
}

export interface TurretDefinition {
  readonly id: TurretKind;
  readonly kind: TurretKind;
  readonly name: string;
  readonly shortName: string;
  readonly modelCode: string;
  readonly roleSummary: string;
  readonly damageType: DamageType;
  readonly accentColorHex: string;
  readonly defaultPriority: TargetPriority;
  readonly allowedPriorities: readonly TargetPriority[];
  readonly targetLayers: readonly MovementLayer[];
  readonly mountProfiles: readonly TurretMountProfileId[];
  readonly footprintRadiusM: number;
  readonly minSpacingM: number;
  readonly hardCap: number;
  readonly sellRefundRatio: number;
  readonly relocateCost: number;
  readonly redeployCooldownSec: number;
  readonly tiers: Readonly<Record<TurretTierId, TurretTierStats>>;
  readonly tierList: readonly [TurretTierStats, TurretTierStats, TurretTierStats];
}

const AUTOCANNON_TIERS: Record<TurretTierId, TurretTierStats> = {
  T1: {
    tier: 'T1',
    level: 1,
    label: 'T1 Single Barrel',
    summary: 'Rapid single-barrel kinetic autocannon firing amber tracer bursts.',
    cost: 100,
    cumulativeCost: 100,
    sellRefundCredits: 75,
    rangeM: 2.4,
    fireRateHz: 6.0,
    fireIntervalSec: 1 / 6.0,
    damage: 11,
    projectileSpeedMps: 18.0,
    aoeRadiusM: 0,
    splashEdgeFalloff: 0,
    burnDps: 0,
    burnDurationSec: 0,
    slowFactor: 0,
    slowDurationSec: 0,
    chainCount: 1,
    chainJumpRadiusM: 0,
    chainDamageRetention: 1,
    armorPierceFactor: 0.0,
    antiAirMultiplier: 1.0,
    bossBonusMultiplier: 1.0,
    nominalSingleTargetDps: 66.0,
    nominalEffectiveDps: 66.0,
    blockout: {
      footprintRadiusM: TURRET_FOOTPRINT_RADIUS_M,
      baseHeightM: 0.08,
      headWidthM: 0.16,
      headHeightM: 0.12,
      headLengthM: 0.22,
      totalHeightM: 0.24,
      barrelLengthM: 0.18,
      barrelRadiusM: 0.022,
      barrelCount: 1,
      muzzleOffsetM: { x: 0, y: 0.18, z: 0.26 },
    },
    meshBudget: DEFAULT_TURRET_MESH_BUDGET,
  },
  T2: {
    tier: 'T2',
    level: 2,
    label: 'T2 Twin Linked Barrels',
    summary: 'Alternating twin-linked titanium barrels with higher cyclic rate and velocity.',
    cost: 130,
    cumulativeCost: 230,
    sellRefundCredits: 173,
    rangeM: 2.7,
    fireRateHz: 8.0,
    fireIntervalSec: 1 / 8.0,
    damage: 14.5,
    projectileSpeedMps: 21.0,
    aoeRadiusM: 0,
    splashEdgeFalloff: 0,
    burnDps: 0,
    burnDurationSec: 0,
    slowFactor: 0,
    slowDurationSec: 0,
    chainCount: 1,
    chainJumpRadiusM: 0,
    chainDamageRetention: 1,
    armorPierceFactor: 0.1,
    antiAirMultiplier: 1.05,
    bossBonusMultiplier: 1.0,
    nominalSingleTargetDps: 116.0,
    nominalEffectiveDps: 116.0,
    blockout: {
      footprintRadiusM: TURRET_FOOTPRINT_RADIUS_M,
      baseHeightM: 0.085,
      headWidthM: 0.19,
      headHeightM: 0.13,
      headLengthM: 0.24,
      totalHeightM: 0.26,
      barrelLengthM: 0.21,
      barrelRadiusM: 0.02,
      barrelCount: 2,
      muzzleOffsetM: { x: 0, y: 0.19, z: 0.29 },
    },
    meshBudget: DEFAULT_TURRET_MESH_BUDGET,
  },
  T3: {
    tier: 'T3',
    level: 3,
    label: 'T3 Rotary Gatling',
    summary:
      'Six-barrel rotary gatling assembly with glowing thermal shroud and tungsten core rounds.',
    cost: 190,
    cumulativeCost: 420,
    sellRefundCredits: 315,
    rangeM: 3.0,
    fireRateHz: 11.0,
    fireIntervalSec: 1 / 11.0,
    damage: 17.5,
    projectileSpeedMps: 24.0,
    aoeRadiusM: 0,
    splashEdgeFalloff: 0,
    burnDps: 0,
    burnDurationSec: 0,
    slowFactor: 0,
    slowDurationSec: 0,
    chainCount: 1,
    chainJumpRadiusM: 0,
    chainDamageRetention: 1,
    armorPierceFactor: 0.2,
    antiAirMultiplier: 1.1,
    bossBonusMultiplier: 1.05,
    nominalSingleTargetDps: 192.5,
    nominalEffectiveDps: 192.5,
    blockout: {
      footprintRadiusM: TURRET_FOOTPRINT_RADIUS_M,
      baseHeightM: 0.09,
      headWidthM: 0.21,
      headHeightM: 0.145,
      headLengthM: 0.26,
      totalHeightM: 0.28,
      barrelLengthM: 0.24,
      barrelRadiusM: 0.036,
      barrelCount: 6,
      muzzleOffsetM: { x: 0, y: 0.2, z: 0.32 },
    },
    meshBudget: DEFAULT_TURRET_MESH_BUDGET,
  },
};

const PLASMA_MORTAR_TIERS: Record<TurretTierId, TurretTierStats> = {
  T1: {
    tier: 'T1',
    level: 1,
    label: 'T1 Single Tube Mortar',
    summary: 'High-arcing plasma mortar launching explosive molten shells with lingering burn.',
    cost: 135,
    cumulativeCost: 135,
    sellRefundCredits: 101,
    rangeM: 2.6,
    fireRateHz: 0.85,
    fireIntervalSec: 1 / 0.85,
    damage: 58,
    projectileSpeedMps: 6.5,
    aoeRadiusM: 0.65,
    splashEdgeFalloff: 0.5,
    burnDps: 14,
    burnDurationSec: 2.5,
    slowFactor: 0,
    slowDurationSec: 0,
    chainCount: 1,
    chainJumpRadiusM: 0,
    chainDamageRetention: 1,
    armorPierceFactor: 0.6,
    antiAirMultiplier: 1.0,
    bossBonusMultiplier: 1.1,
    nominalSingleTargetDps: 63.3,
    nominalEffectiveDps: 158.25,
    blockout: {
      footprintRadiusM: TURRET_FOOTPRINT_RADIUS_M,
      baseHeightM: 0.09,
      headWidthM: 0.18,
      headHeightM: 0.16,
      headLengthM: 0.2,
      totalHeightM: 0.27,
      barrelLengthM: 0.16,
      barrelRadiusM: 0.042,
      barrelCount: 1,
      muzzleOffsetM: { x: 0, y: 0.25, z: 0.16 },
    },
    meshBudget: DEFAULT_TURRET_MESH_BUDGET,
  },
  T2: {
    tier: 'T2',
    level: 2,
    label: 'T2 Dual-Chamber Mortar',
    summary:
      'Twin pressurized magnetic plasma tubes with expanded blast radius and hotter napalm slag.',
    cost: 175,
    cumulativeCost: 310,
    sellRefundCredits: 233,
    rangeM: 2.9,
    fireRateHz: 1.05,
    fireIntervalSec: 1 / 1.05,
    damage: 82,
    projectileSpeedMps: 7.2,
    aoeRadiusM: 0.8,
    splashEdgeFalloff: 0.55,
    burnDps: 22,
    burnDurationSec: 3.0,
    slowFactor: 0,
    slowDurationSec: 0,
    chainCount: 1,
    chainJumpRadiusM: 0,
    chainDamageRetention: 1,
    armorPierceFactor: 0.75,
    antiAirMultiplier: 1.0,
    bossBonusMultiplier: 1.15,
    nominalSingleTargetDps: 108.1,
    nominalEffectiveDps: 291.87,
    blockout: {
      footprintRadiusM: TURRET_FOOTPRINT_RADIUS_M,
      baseHeightM: 0.095,
      headWidthM: 0.21,
      headHeightM: 0.175,
      headLengthM: 0.22,
      totalHeightM: 0.29,
      barrelLengthM: 0.18,
      barrelRadiusM: 0.038,
      barrelCount: 2,
      muzzleOffsetM: { x: 0, y: 0.27, z: 0.18 },
    },
    meshBudget: DEFAULT_TURRET_MESH_BUDGET,
  },
  T3: {
    tier: 'T3',
    level: 3,
    label: 'T3 Heavy Siege Mortar',
    summary:
      'Heavy thermonuclear siege emitter detaching shockwave rings that melt armored columns.',
    cost: 250,
    cumulativeCost: 560,
    sellRefundCredits: 420,
    rangeM: 3.2,
    fireRateHz: 1.25,
    fireIntervalSec: 1 / 1.25,
    damage: 116,
    projectileSpeedMps: 8.0,
    aoeRadiusM: 0.95,
    splashEdgeFalloff: 0.6,
    burnDps: 32,
    burnDurationSec: 3.5,
    slowFactor: 0,
    slowDurationSec: 0,
    chainCount: 1,
    chainJumpRadiusM: 0,
    chainDamageRetention: 1,
    armorPierceFactor: 0.9,
    antiAirMultiplier: 1.0,
    bossBonusMultiplier: 1.25,
    nominalSingleTargetDps: 177.0,
    nominalEffectiveDps: 513.3,
    blockout: {
      footprintRadiusM: TURRET_FOOTPRINT_RADIUS_M,
      baseHeightM: 0.1,
      headWidthM: 0.23,
      headHeightM: 0.19,
      headLengthM: 0.25,
      totalHeightM: 0.31,
      barrelLengthM: 0.21,
      barrelRadiusM: 0.052,
      barrelCount: 2,
      muzzleOffsetM: { x: 0, y: 0.29, z: 0.2 },
    },
    meshBudget: DEFAULT_TURRET_MESH_BUDGET,
  },
};

const CRYO_ARC_TIERS: Record<TurretTierId, TurretTierStats> = {
  T1: {
    tier: 'T1',
    level: 1,
    label: 'T1 Single Cryo Coil',
    summary: 'Emits sub-zero electrical arcs that chill movement by 35% and jump across 2 targets.',
    cost: 125,
    cumulativeCost: 125,
    sellRefundCredits: 94,
    rangeM: 2.1,
    fireRateHz: 2.0,
    fireIntervalSec: 0.5,
    damage: 18,
    projectileSpeedMps: 0,
    aoeRadiusM: 0,
    splashEdgeFalloff: 0,
    burnDps: 0,
    burnDurationSec: 0,
    slowFactor: 0.35,
    slowDurationSec: 2.2,
    chainCount: 2,
    chainJumpRadiusM: 1.1,
    chainDamageRetention: 0.8,
    armorPierceFactor: 0.4,
    antiAirMultiplier: 1.1,
    bossBonusMultiplier: 1.0,
    nominalSingleTargetDps: 36.0,
    nominalEffectiveDps: 64.8,
    blockout: {
      footprintRadiusM: TURRET_FOOTPRINT_RADIUS_M,
      baseHeightM: 0.085,
      headWidthM: 0.16,
      headHeightM: 0.18,
      headLengthM: 0.16,
      totalHeightM: 0.28,
      barrelLengthM: 0.14,
      barrelRadiusM: 0.028,
      barrelCount: 1,
      muzzleOffsetM: { x: 0, y: 0.24, z: 0.14 },
    },
    meshBudget: DEFAULT_TURRET_MESH_BUDGET,
  },
  T2: {
    tier: 'T2',
    level: 2,
    label: 'T2 Dual Arcing Prongs',
    summary:
      'Twin superconducting cryo-prongs imposing a 45% slow across 3 ground or aerial targets.',
    cost: 160,
    cumulativeCost: 285,
    sellRefundCredits: 214,
    rangeM: 2.35,
    fireRateHz: 2.4,
    fireIntervalSec: 1 / 2.4,
    damage: 26,
    projectileSpeedMps: 0,
    aoeRadiusM: 0,
    splashEdgeFalloff: 0,
    burnDps: 0,
    burnDurationSec: 0,
    slowFactor: 0.45,
    slowDurationSec: 2.6,
    chainCount: 3,
    chainJumpRadiusM: 1.3,
    chainDamageRetention: 0.85,
    armorPierceFactor: 0.55,
    antiAirMultiplier: 1.15,
    bossBonusMultiplier: 1.05,
    nominalSingleTargetDps: 62.4,
    nominalEffectiveDps: 160.52,
    blockout: {
      footprintRadiusM: TURRET_FOOTPRINT_RADIUS_M,
      baseHeightM: 0.09,
      headWidthM: 0.18,
      headHeightM: 0.2,
      headLengthM: 0.18,
      totalHeightM: 0.3,
      barrelLengthM: 0.16,
      barrelRadiusM: 0.026,
      barrelCount: 2,
      muzzleOffsetM: { x: 0, y: 0.26, z: 0.16 },
    },
    meshBudget: DEFAULT_TURRET_MESH_BUDGET,
  },
  T3: {
    tier: 'T3',
    level: 3,
    label: 'T3 Tri-Pylon Cryo Conduit',
    summary: 'Tri-pylon flash-freeze conduit locking down 4 chained targets at 55% movement slow.',
    cost: 225,
    cumulativeCost: 510,
    sellRefundCredits: 383,
    rangeM: 2.6,
    fireRateHz: 2.8,
    fireIntervalSec: 1 / 2.8,
    damage: 36,
    projectileSpeedMps: 0,
    aoeRadiusM: 0,
    splashEdgeFalloff: 0,
    burnDps: 0,
    burnDurationSec: 0,
    slowFactor: 0.55,
    slowDurationSec: 3.2,
    chainCount: 4,
    chainJumpRadiusM: 1.5,
    chainDamageRetention: 0.9,
    armorPierceFactor: 0.7,
    antiAirMultiplier: 1.2,
    bossBonusMultiplier: 1.1,
    nominalSingleTargetDps: 100.8,
    nominalEffectiveDps: 346.65,
    blockout: {
      footprintRadiusM: TURRET_FOOTPRINT_RADIUS_M,
      baseHeightM: 0.095,
      headWidthM: 0.2,
      headHeightM: 0.22,
      headLengthM: 0.2,
      totalHeightM: 0.32,
      barrelLengthM: 0.18,
      barrelRadiusM: 0.025,
      barrelCount: 3,
      muzzleOffsetM: { x: 0, y: 0.28, z: 0.18 },
    },
    meshBudget: DEFAULT_TURRET_MESH_BUDGET,
  },
};

const RAIL_SNIPER_TIERS: Record<TurretTierId, TurretTierStats> = {
  T1: {
    tier: 'T1',
    level: 1,
    label: 'T1 Compact Capacitor Rail',
    summary:
      'Long-range hypervelocity rail slug that punches through armor and deals bonus anti-air and boss damage.',
    cost: 150,
    cumulativeCost: 150,
    sellRefundCredits: 113,
    rangeM: 3.5,
    fireRateHz: 0.75,
    fireIntervalSec: 1 / 0.75,
    damage: 96,
    projectileSpeedMps: 0,
    aoeRadiusM: 0,
    splashEdgeFalloff: 0,
    burnDps: 0,
    burnDurationSec: 0,
    slowFactor: 0,
    slowDurationSec: 0,
    chainCount: 1,
    chainJumpRadiusM: 0,
    chainDamageRetention: 1,
    armorPierceFactor: 0.85,
    antiAirMultiplier: 1.4,
    bossBonusMultiplier: 1.35,
    nominalSingleTargetDps: 72.0,
    nominalEffectiveDps: 100.8,
    blockout: {
      footprintRadiusM: TURRET_FOOTPRINT_RADIUS_M,
      baseHeightM: 0.085,
      headWidthM: 0.15,
      headHeightM: 0.12,
      headLengthM: 0.28,
      totalHeightM: 0.25,
      barrelLengthM: 0.28,
      barrelRadiusM: 0.02,
      barrelCount: 1,
      muzzleOffsetM: { x: 0, y: 0.19, z: 0.34 },
    },
    meshBudget: DEFAULT_TURRET_MESH_BUDGET,
  },
  T2: {
    tier: 'T2',
    level: 2,
    label: 'T2 Extended Capacitor Rails',
    summary: 'Overcharged dual-stage capacitor rails delivering near-total armor penetration.',
    cost: 195,
    cumulativeCost: 345,
    sellRefundCredits: 259,
    rangeM: 4.0,
    fireRateHz: 0.9,
    fireIntervalSec: 1 / 0.9,
    damage: 140,
    projectileSpeedMps: 0,
    aoeRadiusM: 0,
    splashEdgeFalloff: 0,
    burnDps: 0,
    burnDurationSec: 0,
    slowFactor: 0,
    slowDurationSec: 0,
    chainCount: 1,
    chainJumpRadiusM: 0,
    chainDamageRetention: 1,
    armorPierceFactor: 0.95,
    antiAirMultiplier: 1.6,
    bossBonusMultiplier: 1.5,
    nominalSingleTargetDps: 126.0,
    nominalEffectiveDps: 201.6,
    blockout: {
      footprintRadiusM: TURRET_FOOTPRINT_RADIUS_M,
      baseHeightM: 0.09,
      headWidthM: 0.17,
      headHeightM: 0.13,
      headLengthM: 0.31,
      totalHeightM: 0.27,
      barrelLengthM: 0.32,
      barrelRadiusM: 0.022,
      barrelCount: 1,
      muzzleOffsetM: { x: 0, y: 0.2, z: 0.38 },
    },
    meshBudget: DEFAULT_TURRET_MESH_BUDGET,
  },
  T3: {
    tier: 'T3',
    level: 3,
    label: 'T3 Twin-Rail Accelerator',
    summary:
      'Twin magnetic accelerator rails with 100% armor bypass, 1.8x anti-air lethality, and 1.7x boss damage.',
    cost: 275,
    cumulativeCost: 620,
    sellRefundCredits: 465,
    rangeM: 4.5,
    fireRateHz: 1.1,
    fireIntervalSec: 1 / 1.1,
    damage: 195,
    projectileSpeedMps: 0,
    aoeRadiusM: 0,
    splashEdgeFalloff: 0,
    burnDps: 0,
    burnDurationSec: 0,
    slowFactor: 0,
    slowDurationSec: 0,
    chainCount: 1,
    chainJumpRadiusM: 0,
    chainDamageRetention: 1,
    armorPierceFactor: 1.0,
    antiAirMultiplier: 1.8,
    bossBonusMultiplier: 1.7,
    nominalSingleTargetDps: 214.5,
    nominalEffectiveDps: 386.1,
    blockout: {
      footprintRadiusM: TURRET_FOOTPRINT_RADIUS_M,
      baseHeightM: 0.095,
      headWidthM: 0.19,
      headHeightM: 0.14,
      headLengthM: 0.34,
      totalHeightM: 0.29,
      barrelLengthM: 0.36,
      barrelRadiusM: 0.024,
      barrelCount: 2,
      muzzleOffsetM: { x: 0, y: 0.21, z: 0.42 },
    },
    meshBudget: DEFAULT_TURRET_MESH_BUDGET,
  },
};

export const TURRETS: Readonly<Record<TurretKind, TurretDefinition>> = {
  autocannon: {
    id: 'autocannon',
    kind: 'autocannon',
    name: 'M44 Autocannon',
    shortName: 'Autocannon',
    modelCode: 'M44',
    roleSummary: 'Kinetic sustained rapid tracer DPS; shreds unarmored crawlers and flyers.',
    damageType: 'kinetic',
    accentColorHex: '#f59e0b',
    defaultPriority: 'first',
    allowedPriorities: TARGET_PRIORITIES,
    targetLayers: ['surface', 'air'],
    mountProfiles: TURRET_MOUNT_IDS,
    footprintRadiusM: TURRET_FOOTPRINT_RADIUS_M,
    minSpacingM: TURRET_MIN_SPACING_M,
    hardCap: HARD_TURRET_CAP,
    sellRefundRatio: TURRET_SELL_REFUND_RATIO,
    relocateCost: TURRET_RELOCATE_COST,
    redeployCooldownSec: TURRET_REDEPLOY_COOLDOWN_SEC,
    tiers: AUTOCANNON_TIERS,
    tierList: [AUTOCANNON_TIERS.T1, AUTOCANNON_TIERS.T2, AUTOCANNON_TIERS.T3],
  },
  'plasma-mortar': {
    id: 'plasma-mortar',
    kind: 'plasma-mortar',
    name: 'Helios Plasma Mortar',
    shortName: 'Plasma Mortar',
    modelCode: 'Helios',
    roleSummary:
      'Parabolic AoE plasma splash + thermal burn DoT; counters clustered surface packs and armor.',
    damageType: 'plasma',
    accentColorHex: '#ff5722',
    defaultPriority: 'first',
    allowedPriorities: TARGET_PRIORITIES,
    targetLayers: ['surface', 'air'],
    mountProfiles: TURRET_MOUNT_IDS,
    footprintRadiusM: TURRET_FOOTPRINT_RADIUS_M,
    minSpacingM: TURRET_MIN_SPACING_M,
    hardCap: HARD_TURRET_CAP,
    sellRefundRatio: TURRET_SELL_REFUND_RATIO,
    relocateCost: TURRET_RELOCATE_COST,
    redeployCooldownSec: TURRET_REDEPLOY_COOLDOWN_SEC,
    tiers: PLASMA_MORTAR_TIERS,
    tierList: [PLASMA_MORTAR_TIERS.T1, PLASMA_MORTAR_TIERS.T2, PLASMA_MORTAR_TIERS.T3],
  },
  'cryo-arc': {
    id: 'cryo-arc',
    kind: 'cryo-arc',
    name: 'Glacier Cryo-Arc',
    shortName: 'Cryo-Arc',
    modelCode: 'Glacier',
    roleSummary:
      '35–55% movement slow + 2–4 target chain lightning across ground and aerial lanes.',
    damageType: 'cryo',
    accentColorHex: '#06b6d4',
    defaultPriority: 'first',
    allowedPriorities: TARGET_PRIORITIES,
    targetLayers: ['surface', 'air'],
    mountProfiles: TURRET_MOUNT_IDS,
    footprintRadiusM: TURRET_FOOTPRINT_RADIUS_M,
    minSpacingM: TURRET_MIN_SPACING_M,
    hardCap: HARD_TURRET_CAP,
    sellRefundRatio: TURRET_SELL_REFUND_RATIO,
    relocateCost: TURRET_RELOCATE_COST,
    redeployCooldownSec: TURRET_REDEPLOY_COOLDOWN_SEC,
    tiers: CRYO_ARC_TIERS,
    tierList: [CRYO_ARC_TIERS.T1, CRYO_ARC_TIERS.T2, CRYO_ARC_TIERS.T3],
  },
  'rail-sniper': {
    id: 'rail-sniper',
    kind: 'rail-sniper',
    name: 'Valkyrie Rail Sniper',
    shortName: 'Rail Sniper',
    modelCode: 'Valkyrie',
    roleSummary:
      'Long-range armor-piercing hypervelocity rail slug with anti-air, Disruptor, and Boss damage bonus.',
    damageType: 'rail',
    accentColorHex: '#3b82f6',
    defaultPriority: 'strongest',
    allowedPriorities: TARGET_PRIORITIES,
    targetLayers: ['surface', 'air'],
    mountProfiles: TURRET_MOUNT_IDS,
    footprintRadiusM: TURRET_FOOTPRINT_RADIUS_M,
    minSpacingM: TURRET_MIN_SPACING_M,
    hardCap: HARD_TURRET_CAP,
    sellRefundRatio: TURRET_SELL_REFUND_RATIO,
    relocateCost: TURRET_RELOCATE_COST,
    redeployCooldownSec: TURRET_REDEPLOY_COOLDOWN_SEC,
    tiers: RAIL_SNIPER_TIERS,
    tierList: [RAIL_SNIPER_TIERS.T1, RAIL_SNIPER_TIERS.T2, RAIL_SNIPER_TIERS.T3],
  },
};

export const TURRET_LIST: readonly TurretDefinition[] = TURRET_KINDS.map((kind) => TURRETS[kind]);

export function normalizeTurretTier(tier: TurretTierId | TurretTierNumber): TurretTierId {
  if (tier === 1 || tier === 'T1') return 'T1';
  if (tier === 2 || tier === 'T2') return 'T2';
  if (tier === 3 || tier === 'T3') return 'T3';
  throw new Error(`Invalid turret tier: ${String(tier)}`);
}

export function getTurretDefinition(kind: TurretKind): TurretDefinition {
  const def = TURRETS[kind];
  if (!def) {
    throw new Error(`Unknown turret kind: ${String(kind)}`);
  }
  return def;
}

export function getTurretTierStats(
  kind: TurretKind,
  tier: TurretTierId | TurretTierNumber = 'T1',
): TurretTierStats {
  const def = getTurretDefinition(kind);
  return def.tiers[normalizeTurretTier(tier)];
}

export function getNextTurretTier(
  currentTier: TurretTierId | TurretTierNumber,
): TurretTierId | null {
  const normalized = normalizeTurretTier(currentTier);
  if (normalized === 'T1') return 'T2';
  if (normalized === 'T2') return 'T3';
  return null;
}

export function getTurretBuildCost(kind: TurretKind): number {
  return getTurretTierStats(kind, 'T1').cost;
}

export function getTurretUpgradeCost(
  kind: TurretKind,
  currentTier: TurretTierId | TurretTierNumber,
): number | null {
  const next = getNextTurretTier(currentTier);
  if (!next) return null;
  return getTurretTierStats(kind, next).cost;
}

export function getTurretCumulativeCost(
  kind: TurretKind,
  tier: TurretTierId | TurretTierNumber,
): number {
  return getTurretTierStats(kind, tier).cumulativeCost;
}

export function getTurretSellRefund(
  kind: TurretKind,
  tier: TurretTierId | TurretTierNumber,
): number {
  const stats = getTurretTierStats(kind, tier);
  return Math.round(stats.cumulativeCost * TURRET_SELL_REFUND_RATIO);
}
