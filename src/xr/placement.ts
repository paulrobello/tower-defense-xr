/**
 * Hybrid XR & Desktop Turret Placement Driver.
 *
 * Integrates `@par/xr-workspace` (`PlacementRays`, `createPointer`, `createButtonEdges`,
 * `createScalableLabel`, `updateScalableLabel`, `disposeScalableLabel`, `keepAbove`,
 * `OVERLAY_RENDER_ORDER`) with `RoomSurfaceModel`, `CoreAnchor`, `PortalAnchor[]`, and
 * the pure validation engine in `src/sim/placement-rules.ts`:
 *
 * - **Auto Surface-Snap (`surface-clamp`):** Raycasts against scanned floors, tables, and walls
 *   within `0.5–6.0 m`, snaps the hologram ghost flush to the outward surface normal, checks the
 *   entire `0.16 m` circular footprint against the surface polygon (`OVERHANG` rejection), and
 *   displays the 4-leg articulated clamp base + translucent range sphere.
 * - **Thumbstick Push/Pull Hover-Pod Mode (`hover-pod`):** Pushing/pulling the aiming thumbstick
 *   forward/backward (above deadzone, elapsed-time scaled) detaches smoothly into mid-air
 *   repulsor hover-pod mode at adjustable depth (`0.8–5.0 m`), switching the ghost mount preview
 *   to the glowing repulsor ring. Pressing B/Y (explicit re-snap toggle) or aiming back onto a
 *   valid surface with a neutral stick returns cleanly to surface-snap.
 * - **Visual Hologram Ghost:** Color-coded cyan (`0x2de2ff`, valid `surface-clamp`), violet-cyan
 *   (`0x7c8cff`, valid `hover-pod`), or crimson (`0xff3b5c`) with a crisp Troika SDF reason label
 *   (`CAP 14/14`, `TOO CLOSE`, `OVERHANG`, `CORE ZONE`, `PORTAL ZONE`, `NO CREDITS`,
 *   `OUT OF RANGE`, `INVALID SURFACE`) when invalid.
 * - **Surface-Relative & Core-Relative Anchoring:** Registers placed surface turrets via
 *   `RoomSurfaceModel.attachAnchor` and hover-pod turrets relative to the `CoreAnchor` frame so
 *   visual and collider transforms track spatial refinements together and hide/restore on tracking loss.
 */

import {
  type ButtonEdges,
  createButtonEdges,
  createPointer,
  createScalableLabel,
  disposeScalableLabel,
  keepAbove,
  OVERLAY_RENDER_ORDER,
  PlacementRays,
  type PlacementRayTarget,
  type Pointer,
  updateScalableLabel,
} from '@par/xr-workspace';
import * as THREE from 'three';
import {
  getNextTurretTier,
  getTurretBuildCost,
  getTurretDefinition,
  getTurretSellRefund,
  getTurretTierStats,
  getTurretUpgradeCost,
  HARD_TURRET_CAP,
  HOVER_POD_MAX_DEPTH_M,
  HOVER_POD_MIN_DEPTH_M,
  SURFACE_SNAP_MAX_RANGE_M,
  SURFACE_SNAP_MIN_RANGE_M,
  type TargetPriority,
  TURRET_FOOTPRINT_RADIUS_M,
  TURRET_MOUNT_PROFILES,
  TURRET_RELOCATE_COST,
  type TurretKind,
  type TurretMountProfileId,
  type TurretTierId,
  type Vec3,
} from '../content/turrets.ts';
import type { ActionBus, ActionSource } from '../core/action-bus.ts';
import type {
  AnchorColliderTarget,
  RoomSurface,
  RoomSurfaceModel,
  SurfaceAnchor,
} from '../mr/room-scan.ts';
import {
  type AttachableSurfaceKind,
  checkFootprintWithinPolygon,
  clampHoverPodDepth,
  computeHoverPodPose,
  computeSurfaceMountPose,
  DEFAULT_HOVER_DEPTH_SPEED_MPS,
  DEFAULT_HOVER_THUMBSTICK_DEADZONE,
  DEFAULT_INITIAL_HOVER_DEPTH_M,
  formatPlacementInvalidReason,
  inspectFootprintWithinPolygon,
  isAttachableSurfaceKind,
  isPointInPolygon2D,
  PLACEMENT_INVALID_REASONS,
  PLACEMENT_REASON_LABELS,
  type PlacementInvalidReason,
  type PlacementValidationResult,
  type Quat,
  stepHoverPodDepth,
  type TurretMountPose,
  type TurretPlacementCandidate,
  validateTurretPlacement,
} from '../sim/placement-rules.ts';
import { configureFonts } from '../ui/fonts.ts';
import type { CoreAnchor, PortalAnchor } from './calibration.ts';

export {
  type AttachableSurfaceKind,
  checkFootprintWithinPolygon,
  clampHoverPodDepth,
  computeHoverPodPose,
  computeSurfaceMountPose,
  DEFAULT_HOVER_DEPTH_SPEED_MPS,
  DEFAULT_HOVER_THUMBSTICK_DEADZONE,
  DEFAULT_INITIAL_HOVER_DEPTH_M,
  formatPlacementInvalidReason,
  HOVER_POD_MAX_DEPTH_M,
  HOVER_POD_MIN_DEPTH_M,
  inspectFootprintWithinPolygon,
  isAttachableSurfaceKind,
  PLACEMENT_INVALID_REASONS,
  PLACEMENT_REASON_LABELS,
  type PlacementInvalidReason,
  type PlacementValidationResult,
  type Quat,
  stepHoverPodDepth,
  type TurretMountPose,
  type TurretPlacementCandidate,
  validateTurretPlacement,
};

/** Cyan hologram tint for valid `surface-clamp` placements (`#2de2ff`). */
export const GHOST_COLOR_SURFACE_VALID = 0x2de2ff;

/** Violet-cyan hologram tint for valid mid-air `hover-pod` placements (`#7c8cff`). */
export const GHOST_COLOR_HOVER_VALID = 0x7c8cff;

/** Crimson hologram tint for invalid placements (`#ff3b5c`). */
export const GHOST_COLOR_INVALID = 0xff3b5c;

export interface TurretGhostState {
  readonly visible: boolean;
  readonly valid: boolean;
  readonly kind: TurretKind;
  readonly tier: TurretTierId;
  readonly mountProfile: TurretMountProfileId;
  readonly colorHex: number;
  readonly reason: PlacementInvalidReason | null;
  readonly reasonLabelText: string | null;
  readonly rangeM: number;
  readonly position: Vec3;
  readonly normal: Vec3;
  readonly quaternion: Quat;
}

export interface TurretGhostUpdateInput {
  readonly validation: PlacementValidationResult;
  readonly kind?: TurretKind;
  readonly tier?: TurretTierId;
  readonly visible?: boolean;
}

export interface TurretGhostPreview {
  readonly group: THREE.Group;
  readonly clampMountGroup: THREE.Group;
  readonly hoverPodGroup: THREE.Group;
  readonly turretBodyGroup: THREE.Group;
  readonly footprintRing: THREE.Mesh;
  readonly rangeSphere: THREE.Mesh;
  readonly reasonLabel: THREE.Mesh;
  readonly state: Readonly<TurretGhostState>;
  update(input: TurretGhostUpdateInput): Readonly<TurretGhostState>;
  setVisible(visible: boolean): void;
  dispose(): void;
}

export interface SurfaceRayHit {
  readonly surface: RoomSurface;
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly distance: number;
}

export interface PlacementRayUpdateOptions {
  /**
   * Thumbstick push/pull input in `[-1, 1]`:
   * - `> +deadzone`: push away along ray (increases hover-pod depth toward `5.0 m`)
   * - `< -deadzone`: pull closer along ray (decreases hover-pod depth toward `0.8 m`)
   * - within `[-deadzone, +deadzone]`: neutral stick
   */
  readonly stickY?: number;
  /** Elapsed frame delta in seconds for time-scaled thumbstick depth movement. */
  readonly dtSec?: number;
  /** Explicit B/Y button toggle or re-snap request returning from `hover-pod` to `surface-clamp`. */
  readonly resnap?: boolean;
  /**
   * When true, a neutral stick (`|stickY| <= deadzone`) over any valid attachable surface
   * immediately re-snaps to `surface-clamp` even if aiming at the same surface.
   */
  readonly autoResnapOnNeutral?: boolean;
  /** Optional explicit mount profile override (`'surface-clamp'` or `'hover-pod'`). */
  readonly mountProfile?: TurretMountProfileId;
  /** Optional forward orientation hint for surface-clamp mount pose. */
  readonly forwardHint?: Readonly<Vec3>;
}

export interface PlacedTurretCollider extends AnchorColliderTarget {
  readonly radiusM: number;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
  matrix: THREE.Matrix4;
  visible: boolean;
}

export interface PlacedTurretRecord {
  readonly id: string;
  readonly kind: TurretKind;
  tier: TurretTierId;
  priority: TargetPriority;
  mountProfile: TurretMountProfileId;
  position: Vec3;
  normal: Vec3;
  quaternion: Quat;
  surfaceId: string | null;
  surfaceKind: AttachableSurfaceKind | null;
  surfaceAnchor: SurfaceAnchor | null;
  coreLocalMatrix: THREE.Matrix4 | null;
  coreLocalOffset: Vec3 | null;
  readonly visual: THREE.Group;
  readonly collider: PlacedTurretCollider;
  tracked: boolean;
  visible: boolean;
  investedCredits: number;
}

export interface DirectPlaceTurretInput {
  readonly kind?: TurretKind;
  readonly tier?: TurretTierId;
  readonly priority?: TargetPriority;
  readonly mountProfile?: TurretMountProfileId;
  readonly position: Readonly<Vec3>;
  readonly normal?: Readonly<Vec3>;
  readonly surface?: RoomSurface | null;
  readonly surfaceId?: string | null;
  readonly surfaceKind?: string | null;
  readonly rayOrigin?: Readonly<Vec3>;
  readonly rayDistanceM?: number;
  readonly depthM?: number;
  readonly forwardHint?: Readonly<Vec3>;
}

export interface PlacementControllerState {
  readonly active: boolean;
  readonly selectedKind: TurretKind;
  readonly selectedTier: TurretTierId;
  readonly mountProfile: TurretMountProfileId;
  readonly hoverDepthM: number;
  readonly relocatingTurretId: string | null;
  readonly turretCount: number;
  readonly hardTurretCap: number;
  readonly credits: number | undefined;
  readonly lastRayOrigin: Vec3 | null;
  readonly lastRayDirection: Vec3 | null;
  readonly lastSurfaceHit: SurfaceRayHit | null;
  readonly lastValidation: PlacementValidationResult | null;
}

export type PlacementControllerListener = (state: Readonly<PlacementControllerState>) => void;

export interface TurretPlacementControllerOptions {
  readonly roomModel: RoomSurfaceModel;
  readonly scene?: THREE.Scene;
  readonly coreAnchor?: CoreAnchor | (() => CoreAnchor | null) | null;
  readonly portalAnchors?: readonly PortalAnchor[] | (() => readonly PortalAnchor[]);
  readonly actionBus?: ActionBus;
  /** Optional starting Requisition credits (omit to skip credit gating unless `getCredits` is set). */
  readonly initialCredits?: number;
  /** Optional external credits getter (supersedes internal credit balance when provided). */
  readonly getCredits?: () => number | undefined;
  readonly initialKind?: TurretKind;
  readonly initialActive?: boolean;
  readonly thumbstickDeadzone?: number;
  readonly hoverDepthSpeedMps?: number;
  readonly initialHoverDepthM?: number;
  /** Handedness preference for XR placement aiming (defaults to `'right'`, falling back to any controller). */
  readonly preferredHandedness?: XRHandedness;
  readonly ghost?: TurretGhostPreview;
  readonly placementRays?: PlacementRays;
  readonly pointer?: Pointer;
}

export interface TurretPlacementController {
  readonly state: Readonly<PlacementControllerState>;
  readonly ghost: TurretGhostPreview;
  readonly placementRays: PlacementRays | null;
  readonly pointer: Pointer;
  readonly placedTurretsGroup: THREE.Group;
  readonly surfacePickGroup: THREE.Group;
  readonly placedTurrets: readonly PlacedTurretRecord[];
  readonly turretCount: number;
  readonly credits: number | undefined;
  readonly selectedKind: TurretKind;
  readonly mountMode: TurretMountProfileId;
  readonly hoverDepthM: number;
  readonly relocatingTurretId: string | null;
  readonly lastValidation: PlacementValidationResult | null;
  setSelectedKind(kind: TurretKind): void;
  setCredits(credits: number | undefined): void;
  setCoreAnchor(coreAnchor: CoreAnchor | null): void;
  setPortalAnchors(portalAnchors: readonly PortalAnchor[]): void;
  setPlacementActive(active: boolean): void;
  beginBuild(kind?: TurretKind): void;
  beginRelocate(turretId: string): boolean;
  cancelPlacement(): void;
  pushPullThumbstick(pushPullInput: number, dtSec: number): number;
  adjustHoverDepth(deltaDepthM: number): number;
  setHoverDepth(depthM: number): number;
  resnapToSurface(): void;
  toggleHoverMode(): TurretMountProfileId;
  raycastSurface(
    rayOrigin: Readonly<Vec3>,
    rayDirection: Readonly<Vec3>,
    acceptsSurface?: (surface: RoomSurface) => boolean,
  ): SurfaceRayHit | null;
  updateFromRay(
    rayOrigin: Readonly<Vec3>,
    rayDirection: Readonly<Vec3>,
    options?: PlacementRayUpdateOptions,
  ): PlacementValidationResult;
  updateFromXrFrame(
    frame: XRFrame,
    referenceSpace: XRReferenceSpace,
    dtSec: number,
    suppressTrigger?: (source: XRInputSource) => boolean,
  ): PlacementValidationResult | null;
  confirmPlacement(source?: ActionSource): PlacedTurretRecord | null;
  placeTurret(input: DirectPlaceTurretInput, source?: ActionSource): PlacedTurretRecord | null;
  relocateTurret(
    turretId: string,
    input: DirectPlaceTurretInput,
    source?: ActionSource,
  ): PlacedTurretRecord | null;
  upgradeTurret(turretId: string, source?: ActionSource): PlacedTurretRecord | null;
  sellTurret(turretId: string, source?: ActionSource): number;
  setTurretPriority(
    turretId: string,
    priority: TargetPriority,
    source?: ActionSource,
  ): PlacedTurretRecord | null;
  removeTurret(turretId: string): boolean;
  getTurret(turretId: string): PlacedTurretRecord | undefined;
  pickPlacedTurret(
    rayOrigin: Readonly<Vec3>,
    rayDirection: Readonly<Vec3>,
  ): PlacedTurretRecord | null;
  subscribe(listener: PlacementControllerListener): () => void;
  dispose(): void;
}

function cloneVec3(v: Readonly<Vec3>): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function cloneQuat(q: Readonly<Quat>): Quat {
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

/**
 * Builds the 3D hologram ghost preview group with:
 * - Articulated 4-leg `surface-clamp` base
 * - Glowing gravitic `hover-pod` repulsor ring
 * - Role-scaled turret body + barrel preview
 * - `0.16 m` circular footprint boundary ring
 * - Translucent engagement range sphere
 * - Crisp Troika SDF rejection reason label (`@par/xr-workspace` `createScalableLabel` + `keepAbove`)
 */
export function createTurretGhostPreview(): TurretGhostPreview {
  configureFonts();

  const group = new THREE.Group();
  group.name = 'turret-placement-ghost';

  const bodyMat = new THREE.MeshBasicMaterial({
    color: GHOST_COLOR_SURFACE_VALID,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
  });
  bodyMat.forceSinglePass = true;

  const accentMat = new THREE.MeshBasicMaterial({
    color: GHOST_COLOR_SURFACE_VALID,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  accentMat.forceSinglePass = true;

  const rangeMat = new THREE.MeshBasicMaterial({
    color: GHOST_COLOR_SURFACE_VALID,
    transparent: true,
    opacity: 0.14,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  rangeMat.forceSinglePass = true;

  const ownedGeometries: THREE.BufferGeometry[] = [];

  // 1. Footprint perimeter ring (0.16 m radius in local y = 0 plane)
  const footprintGeo = new THREE.RingGeometry(
    TURRET_FOOTPRINT_RADIUS_M - 0.015,
    TURRET_FOOTPRINT_RADIUS_M,
    36,
  );
  ownedGeometries.push(footprintGeo);
  const footprintRing = new THREE.Mesh(footprintGeo, accentMat);
  footprintRing.name = 'turret-ghost-footprint-ring';
  footprintRing.rotation.x = -Math.PI / 2;
  footprintRing.position.y = 0.002;
  group.add(footprintRing);

  // 2. Surface-clamp mount group (base hub + 4 articulated clamp legs)
  const clampMountGroup = new THREE.Group();
  clampMountGroup.name = 'turret-ghost-surface-clamp';
  const clampProfile = TURRET_MOUNT_PROFILES['surface-clamp'].blockout;

  const clampHubGeo = new THREE.CylinderGeometry(
    clampProfile.emissiveRingRadiusM * 0.75,
    clampProfile.emissiveRingRadiusM,
    clampProfile.heightM,
    20,
  );
  ownedGeometries.push(clampHubGeo);
  const clampHub = new THREE.Mesh(clampHubGeo, bodyMat);
  clampHub.name = 'turret-ghost-clamp-hub';
  clampHub.position.y = clampProfile.heightM * 0.5;
  clampMountGroup.add(clampHub);

  const legGeo = new THREE.BoxGeometry(0.032, 0.028, clampProfile.radiusM * 0.85);
  ownedGeometries.push(legGeo);
  for (let i = 0; i < clampProfile.legCount; i += 1) {
    const angle = (i * Math.PI * 2) / clampProfile.legCount + Math.PI / 4;
    const leg = new THREE.Mesh(legGeo, accentMat);
    leg.name = `turret-ghost-clamp-leg-${i}`;
    const r = clampProfile.radiusM * 0.56;
    leg.position.set(Math.sin(angle) * r, 0.016, Math.cos(angle) * r);
    leg.rotation.y = angle;
    clampMountGroup.add(leg);
  }
  group.add(clampMountGroup);

  // 3. Hover-pod repulsor ring mount group
  const hoverPodGroup = new THREE.Group();
  hoverPodGroup.name = 'turret-ghost-hover-pod';
  hoverPodGroup.visible = false;
  const hoverProfile = TURRET_MOUNT_PROFILES['hover-pod'].blockout;

  const repulsorTorusGeo = new THREE.TorusGeometry(hoverProfile.emissiveRingRadiusM, 0.018, 12, 32);
  ownedGeometries.push(repulsorTorusGeo);
  const repulsorRing = new THREE.Mesh(repulsorTorusGeo, accentMat);
  repulsorRing.name = 'turret-ghost-repulsor-ring';
  repulsorRing.rotation.x = Math.PI / 2;
  repulsorRing.position.y = hoverProfile.heightM * 0.45;
  hoverPodGroup.add(repulsorRing);

  const repulsorCoreGeo = new THREE.CylinderGeometry(
    hoverProfile.emissiveRingRadiusM * 0.62,
    hoverProfile.emissiveRingRadiusM * 0.42,
    hoverProfile.heightM,
    20,
  );
  ownedGeometries.push(repulsorCoreGeo);
  const repulsorCore = new THREE.Mesh(repulsorCoreGeo, bodyMat);
  repulsorCore.name = 'turret-ghost-repulsor-core';
  repulsorCore.position.y = hoverProfile.heightM * 0.5;
  hoverPodGroup.add(repulsorCore);
  group.add(hoverPodGroup);

  // 4. Turret body + head + barrel preview
  const turretBodyGroup = new THREE.Group();
  turretBodyGroup.name = 'turret-ghost-body';

  const headGeo = new THREE.BoxGeometry(1, 1, 1);
  ownedGeometries.push(headGeo);
  const headMesh = new THREE.Mesh(headGeo, bodyMat);
  headMesh.name = 'turret-ghost-head';
  turretBodyGroup.add(headMesh);

  const barrelGeo = new THREE.CylinderGeometry(1, 1, 1, 12);
  barrelGeo.rotateX(Math.PI / 2);
  ownedGeometries.push(barrelGeo);
  const barrelMesh = new THREE.Mesh(barrelGeo, accentMat);
  barrelMesh.name = 'turret-ghost-barrel';
  turretBodyGroup.add(barrelMesh);
  group.add(turretBodyGroup);

  // 5. Translucent engagement range sphere (unit radius scaled by tierStats.rangeM)
  const rangeSphereGeo = new THREE.SphereGeometry(1, 24, 16);
  ownedGeometries.push(rangeSphereGeo);
  const rangeSphere = new THREE.Mesh(rangeSphereGeo, rangeMat);
  rangeSphere.name = 'turret-ghost-range-sphere';
  const defaultRangeM = getTurretTierStats('autocannon', 'T1').rangeM;
  rangeSphere.scale.setScalar(defaultRangeM);
  group.add(rangeSphere);

  // 6. Crisp Troika SDF rejection reason label above the ghost
  const reasonLabel = createScalableLabel('INVALID', 0.36, 0.085, {
    background: '#2a0910',
    border: '#ff3b5c',
    name: 'turret-ghost-reason-label',
  });
  reasonLabel.name = 'turret-ghost-reason-label';
  reasonLabel.position.set(0, 0.42, 0);
  reasonLabel.visible = false;
  const stopKeepAbove = keepAbove(reasonLabel, OVERLAY_RENDER_ORDER);
  group.add(reasonLabel);

  function syncTurretDimensions(kind: TurretKind, tier: TurretTierId): number {
    const stats = getTurretTierStats(kind, tier);
    const b = stats.blockout;
    headMesh.scale.set(b.headWidthM, b.headHeightM, b.headLengthM);
    headMesh.position.set(0, b.baseHeightM + b.headHeightM * 0.5, 0);

    barrelMesh.scale.set(b.barrelRadiusM * 2, b.barrelRadiusM * 2, b.barrelLengthM);
    barrelMesh.position.set(
      0,
      b.baseHeightM + b.headHeightM * 0.55,
      b.headLengthM * 0.5 + b.barrelLengthM * 0.45,
    );

    rangeSphere.scale.setScalar(stats.rangeM);
    reasonLabel.position.set(0, b.totalHeightM + 0.14, 0);
    return stats.rangeM;
  }

  let currentKind: TurretKind = 'autocannon';
  let currentTier: TurretTierId = 'T1';
  let currentRangeM = syncTurretDimensions(currentKind, currentTier);

  let currentState: TurretGhostState = {
    visible: true,
    valid: true,
    kind: currentKind,
    tier: currentTier,
    mountProfile: 'surface-clamp',
    colorHex: GHOST_COLOR_SURFACE_VALID,
    reason: null,
    reasonLabelText: null,
    rangeM: currentRangeM,
    position: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
  };

  return {
    group,
    clampMountGroup,
    hoverPodGroup,
    turretBodyGroup,
    footprintRing,
    rangeSphere,
    reasonLabel,
    get state() {
      return currentState;
    },
    update(input) {
      const kind = input.kind ?? currentKind;
      const tier = input.tier ?? currentTier;
      if (kind !== currentKind || tier !== currentTier) {
        currentKind = kind;
        currentTier = tier;
        currentRangeM = syncTurretDimensions(kind, tier);
      }

      const { validation } = input;
      const visible = input.visible ?? group.visible;
      group.visible = visible;

      const { pose, mountProfile, valid, reason, reasonLabel: labelText } = validation;
      group.position.set(pose.position.x, pose.position.y, pose.position.z);
      group.quaternion.set(
        pose.quaternion.x,
        pose.quaternion.y,
        pose.quaternion.z,
        pose.quaternion.w,
      );
      group.updateMatrixWorld(true);

      const isHover = mountProfile === 'hover-pod';
      clampMountGroup.visible = !isHover;
      hoverPodGroup.visible = isHover;

      const colorHex = !valid
        ? GHOST_COLOR_INVALID
        : isHover
          ? GHOST_COLOR_HOVER_VALID
          : GHOST_COLOR_SURFACE_VALID;

      bodyMat.color.setHex(colorHex);
      accentMat.color.setHex(colorHex);
      rangeMat.color.setHex(colorHex);

      if (!valid && labelText) {
        reasonLabel.visible = true;
        updateScalableLabel(reasonLabel, labelText);
      } else {
        reasonLabel.visible = false;
      }

      currentState = Object.freeze({
        visible,
        valid,
        kind: currentKind,
        tier: currentTier,
        mountProfile,
        colorHex,
        reason,
        reasonLabelText: !valid ? labelText : null,
        rangeM: currentRangeM,
        position: cloneVec3(pose.position),
        normal: cloneVec3(pose.normal),
        quaternion: cloneQuat(pose.quaternion),
      });
      return currentState;
    },
    setVisible(visible) {
      group.visible = visible;
      currentState = Object.freeze({
        ...currentState,
        visible,
      });
    },
    dispose() {
      stopKeepAbove();
      disposeScalableLabel(reasonLabel);
      for (const geo of ownedGeometries) {
        geo.dispose();
      }
      bodyMat.dispose();
      accentMat.dispose();
      rangeMat.dispose();
    },
  };
}

function buildPlacedTurretVisual(
  id: string,
  kind: TurretKind,
  tier: TurretTierId,
  mountProfile: TurretMountProfileId,
): THREE.Group {
  const def = getTurretDefinition(kind);
  const stats = getTurretTierStats(kind, tier);
  const b = stats.blockout;

  const root = new THREE.Group();
  root.name = `placed-turret-${id}`;
  root.userData.turretId = id;
  root.userData.turretKind = kind;
  root.userData.turretTier = tier;
  root.userData.mountProfile = mountProfile;

  const baseMat = new THREE.MeshStandardMaterial({
    color: 0x263238,
    metalness: 0.75,
    roughness: 0.32,
  });
  const accentMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(def.accentColorHex),
  });

  if (mountProfile === 'surface-clamp') {
    const clampProfile = TURRET_MOUNT_PROFILES['surface-clamp'].blockout;
    const clampGroup = new THREE.Group();
    clampGroup.name = 'turret-mount-surface-clamp';

    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(
        clampProfile.emissiveRingRadiusM * 0.78,
        clampProfile.emissiveRingRadiusM,
        clampProfile.heightM,
        18,
      ),
      baseMat,
    );
    hub.position.y = clampProfile.heightM * 0.5;
    clampGroup.add(hub);

    const legGeo = new THREE.BoxGeometry(0.032, 0.028, clampProfile.radiusM * 0.85);
    for (let i = 0; i < clampProfile.legCount; i += 1) {
      const angle = (i * Math.PI * 2) / clampProfile.legCount + Math.PI / 4;
      const leg = new THREE.Mesh(legGeo, accentMat);
      const r = clampProfile.radiusM * 0.56;
      leg.position.set(Math.sin(angle) * r, 0.016, Math.cos(angle) * r);
      leg.rotation.y = angle;
      clampGroup.add(leg);
    }
    root.add(clampGroup);
  } else {
    const hoverProfile = TURRET_MOUNT_PROFILES['hover-pod'].blockout;
    const hoverGroup = new THREE.Group();
    hoverGroup.name = 'turret-mount-hover-pod';

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(hoverProfile.emissiveRingRadiusM, 0.018, 12, 28),
      accentMat,
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = hoverProfile.heightM * 0.45;
    hoverGroup.add(ring);

    const core = new THREE.Mesh(
      new THREE.CylinderGeometry(
        hoverProfile.emissiveRingRadiusM * 0.62,
        hoverProfile.emissiveRingRadiusM * 0.42,
        hoverProfile.heightM,
        18,
      ),
      baseMat,
    );
    core.position.y = hoverProfile.heightM * 0.5;
    hoverGroup.add(core);
    root.add(hoverGroup);
  }

  const head = new THREE.Mesh(
    new THREE.BoxGeometry(b.headWidthM, b.headHeightM, b.headLengthM),
    baseMat,
  );
  head.name = 'turret-head';
  head.position.set(0, b.baseHeightM + b.headHeightM * 0.5, 0);
  root.add(head);

  const barrelGeo = new THREE.CylinderGeometry(
    b.barrelRadiusM,
    b.barrelRadiusM,
    b.barrelLengthM,
    12,
  );
  barrelGeo.rotateX(Math.PI / 2);
  const barrel = new THREE.Mesh(barrelGeo, accentMat);
  barrel.name = 'turret-barrel';
  barrel.position.set(
    0,
    b.baseHeightM + b.headHeightM * 0.55,
    b.headLengthM * 0.5 + b.barrelLengthM * 0.45,
  );
  root.add(barrel);

  root.userData.disposeVisual = () => {
    root.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) {
        (node as THREE.Mesh).geometry?.dispose();
      }
    });
    baseMat.dispose();
    accentMat.dispose();
  };

  return root;
}

function buildSurfacePickGeometry(surface: RoomSurface): THREE.BufferGeometry | null {
  const pts = surface.localPolygon;
  if (pts.length < 3) return null;

  const positions: number[] = [];
  for (const pt of pts) {
    positions.push(pt.x, 0, pt.z);
  }

  const contour = pts.map((pt) => new THREE.Vector2(pt.x, pt.z));
  const triangles = THREE.ShapeUtils.triangulateShape(contour, []);
  const indices: number[] = [];
  if (triangles.length > 0) {
    for (const tri of triangles) {
      indices.push(tri[0] ?? 0, tri[1] ?? 1, tri[2] ?? 2);
    }
  } else {
    for (let i = 1; i + 1 < pts.length; i += 1) {
      indices.push(0, i, i + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function makeCoreWorldMatrix(core: CoreAnchor): THREE.Matrix4 {
  return new THREE.Matrix4()
    .makeRotationY(core.yaw)
    .setPosition(core.position.x, core.position.y, core.position.z);
}

/**
 * Creates the controller laser & desktop parity turret placement driver.
 */
export function createTurretPlacementController(
  options: TurretPlacementControllerOptions,
): TurretPlacementController {
  const { roomModel, scene, actionBus } = options;
  const deadzone = options.thumbstickDeadzone ?? DEFAULT_HOVER_THUMBSTICK_DEADZONE;
  const hoverSpeedMps = options.hoverDepthSpeedMps ?? DEFAULT_HOVER_DEPTH_SPEED_MPS;
  const preferredHandedness = options.preferredHandedness ?? 'right';

  const ghost = options.ghost ?? createTurretGhostPreview();
  const ownsGhost = options.ghost === undefined;

  const pointer = options.pointer ?? createPointer({ far: 12 });
  const placementRays = options.placementRays ?? (scene ? new PlacementRays(scene) : null);
  const ownsPlacementRays = options.placementRays === undefined && placementRays !== null;

  const placedTurretsGroup = new THREE.Group();
  placedTurretsGroup.name = 'placed-turrets-layer';

  const surfacePickGroup = new THREE.Group();
  surfacePickGroup.name = 'placement-surface-pick-layer';

  if (scene) {
    scene.add(ghost.group);
    scene.add(placedTurretsGroup);
    scene.add(surfacePickGroup);
  }

  const pickMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  // `material.visible = false` skips drawing while keeping the mesh pickable by `createPointer`.
  pickMaterial.visible = false;

  let syncedRoomRevision = -1;
  let syncedSurfaceSignature = '';

  let active = options.initialActive ?? true;
  let selectedKind: TurretKind = options.initialKind ?? 'autocannon';
  let selectedTier: TurretTierId = 'T1';
  let mountProfile: TurretMountProfileId = 'surface-clamp';
  let hoverDepthM = clampHoverPodDepth(options.initialHoverDepthM ?? DEFAULT_INITIAL_HOVER_DEPTH_M);
  let relocatingTurretId: string | null = null;
  let internalCredits: number | undefined = options.initialCredits;

  let explicitCoreAnchor: CoreAnchor | null =
    typeof options.coreAnchor === 'function' ? null : (options.coreAnchor ?? null);
  let explicitPortalAnchors: readonly PortalAnchor[] =
    typeof options.portalAnchors === 'function' ? [] : (options.portalAnchors ?? []);

  let lastRayOrigin: Vec3 | null = null;
  let lastRayDirection: Vec3 | null = null;
  let lastSurfaceHit: SurfaceRayHit | null = null;
  let lastValidation: PlacementValidationResult | null = null;

  // Tracks which surface (if any) was active when the user detached into hover-pod mode
  let detachedFromSurfaceId: string | null = null;
  let hoverStickWasActive = false;

  let nextTurretSeq = 1;
  const placedTurretsMap = new Map<string, PlacedTurretRecord>();
  const buttonEdgesBySource = new Map<XRInputSource, ButtonEdges>();
  const listeners = new Set<PlacementControllerListener>();
  const unsubscribers: Array<() => void> = [];

  ghost.setVisible(active);

  function resolveCredits(): number | undefined {
    if (options.getCredits) {
      return options.getCredits();
    }
    return internalCredits;
  }

  function resolveCoreAnchor(): CoreAnchor | null {
    if (typeof options.coreAnchor === 'function') {
      return options.coreAnchor();
    }
    return explicitCoreAnchor;
  }

  function resolvePortalAnchors(): readonly PortalAnchor[] {
    if (typeof options.portalAnchors === 'function') {
      return options.portalAnchors();
    }
    return explicitPortalAnchors;
  }

  function clearPickMeshes(): void {
    for (const child of [...surfacePickGroup.children]) {
      if ((child as THREE.Mesh).isMesh) {
        (child as THREE.Mesh).geometry?.dispose();
      }
      surfacePickGroup.remove(child);
    }
  }

  function syncSurfacePickMeshes(): void {
    const surfaces = roomModel.surfaces;
    const signature = surfaces.map((s) => `${s.id}:${s.revision}`).join('|');
    if (roomModel.revision === syncedRoomRevision && signature === syncedSurfaceSignature) {
      return;
    }
    syncedRoomRevision = roomModel.revision;
    syncedSurfaceSignature = signature;

    clearPickMeshes();
    for (const surface of surfaces) {
      const geo = buildSurfacePickGeometry(surface);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, pickMaterial);
      mesh.name = `surface-pick-${surface.id}`;
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(surface.worldMatrix);
      mesh.updateMatrixWorld(true);
      mesh.userData.surfaceId = surface.id;
      surfacePickGroup.add(mesh);
    }
    surfacePickGroup.updateMatrixWorld(true);
  }

  function syncHoverPodAnchors(): void {
    const core = resolveCoreAnchor();
    if (!core) return;

    // If the Core is attached to a surface in roomModel, derive the live Core frame from that surface
    const coreWorldMatrix = makeCoreWorldMatrix(core);
    let coreSurfaceTracked = true;

    if (core.surfaceId) {
      const coreSurface = roomModel.getSurface(core.surfaceId);
      if (!coreSurface) {
        coreSurfaceTracked = false;
      }
    }

    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);

    for (const record of placedTurretsMap.values()) {
      if (record.mountProfile !== 'hover-pod' || !record.coreLocalMatrix) continue;

      if (!coreSurfaceTracked) {
        record.tracked = false;
        record.visible = false;
        record.visual.visible = false;
        record.collider.visible = false;
        continue;
      }

      record.tracked = true;
      record.visible = true;
      const worldMat = coreWorldMatrix.clone().multiply(record.coreLocalMatrix);
      worldMat.decompose(pos, quat, scale);

      record.position = { x: pos.x, y: pos.y, z: pos.z };
      record.quaternion = { x: quat.x, y: quat.y, z: quat.z, w: quat.w };

      record.visual.visible = true;
      record.visual.position.copy(pos);
      record.visual.quaternion.copy(quat);
      record.visual.scale.copy(scale);
      record.visual.updateMatrixWorld(true);

      record.collider.visible = true;
      record.collider.position.copy(pos);
      record.collider.quaternion.copy(quat);
      record.collider.scale.copy(scale);
      record.collider.matrix.copy(worldMat);
    }
  }

  function buildState(): Readonly<PlacementControllerState> {
    return Object.freeze({
      active,
      selectedKind,
      selectedTier,
      mountProfile,
      hoverDepthM,
      relocatingTurretId,
      turretCount: placedTurretsMap.size,
      hardTurretCap: HARD_TURRET_CAP,
      credits: resolveCredits(),
      lastRayOrigin: lastRayOrigin ? cloneVec3(lastRayOrigin) : null,
      lastRayDirection: lastRayDirection ? cloneVec3(lastRayDirection) : null,
      lastSurfaceHit,
      lastValidation,
    });
  }

  function notify(): Readonly<PlacementControllerState> {
    const snap = buildState();
    for (const listener of [...listeners]) {
      try {
        listener(snap);
      } catch (error) {
        console.error('[placement]', error);
      }
    }
    return snap;
  }

  function raycastSurfaceInternal(
    rayOrigin: Readonly<Vec3>,
    rayDirection: Readonly<Vec3>,
    attachableOnly: boolean,
    acceptsSurface?: (surface: RoomSurface) => boolean,
  ): SurfaceRayHit | null {
    const dirLen = Math.hypot(rayDirection.x, rayDirection.y, rayDirection.z);
    if (dirLen < 1e-8) return null;
    const dx = rayDirection.x / dirLen;
    const dy = rayDirection.y / dirLen;
    const dz = rayDirection.z / dirLen;

    syncSurfacePickMeshes();

    // 1. Primary path: use `@par/xr-workspace` `createPointer` against surface pick meshes
    const originVec = new THREE.Vector3(rayOrigin.x, rayOrigin.y, rayOrigin.z);
    const dirVec = new THREE.Vector3(dx, dy, dz);
    const candidateMeshes = surfacePickGroup.children.filter((child) => {
      const sid = child.userData.surfaceId as string | undefined;
      if (!sid) return false;
      const surface = roomModel.getSurface(sid);
      if (!surface) return false;
      if (acceptsSurface && !acceptsSurface(surface)) return false;
      return attachableOnly ? isAttachableSurfaceKind(surface.kind) : true;
    });

    if (candidateMeshes.length > 0) {
      const hit = pointer.cast(originVec, dirVec, candidateMeshes);
      if (hit) {
        const sid = hit.object.userData.surfaceId as string | undefined;
        const surface = sid ? roomModel.getSurface(sid) : undefined;
        if (surface) {
          return {
            surface,
            point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
            normal: {
              x: surface.normal.x,
              y: surface.normal.y,
              z: surface.normal.z,
            },
            distance: hit.distance,
          };
        }
      }
    }

    // 2. Analytic planar polygon intersection fallback
    const invMatrix = new THREE.Matrix4();
    const localHit = new THREE.Vector3();
    let bestHit: SurfaceRayHit | null = null;

    for (const surface of roomModel.surfaces) {
      if (attachableOnly && !isAttachableSurfaceKind(surface.kind)) continue;
      if (acceptsSurface && !acceptsSurface(surface)) continue;
      if (surface.localPolygon.length < 3) continue;

      const nx = surface.normal.x;
      const ny = surface.normal.y;
      const nz = surface.normal.z;
      const denom = dx * nx + dy * ny + dz * nz;
      if (Math.abs(denom) < 1e-6) continue;

      const t =
        ((surface.center.x - rayOrigin.x) * nx +
          (surface.center.y - rayOrigin.y) * ny +
          (surface.center.z - rayOrigin.z) * nz) /
        denom;
      if (t <= 0.02 || t > 12) continue;

      const hx = rayOrigin.x + dx * t;
      const hy = rayOrigin.y + dy * t;
      const hz = rayOrigin.z + dz * t;

      invMatrix.copy(surface.worldMatrix).invert();
      localHit.set(hx, hy, hz).applyMatrix4(invMatrix);
      if (!isPointInPolygon2D({ x: localHit.x, z: localHit.z }, surface.localPolygon)) {
        continue;
      }

      if (!bestHit || t < bestHit.distance) {
        bestHit = {
          surface,
          point: { x: hx, y: hy, z: hz },
          normal: { x: nx, y: ny, z: nz },
          distance: t,
        };
      }
    }

    return bestHit;
  }

  function attachTurretAnchoring(
    record: PlacedTurretRecord,
    pose: TurretMountPose,
    surfaceId: string | null,
  ): void {
    // Clean up any existing surface anchor before re-attaching
    if (record.surfaceAnchor) {
      roomModel.detachAnchor(record.surfaceAnchor.id);
      record.surfaceAnchor = null;
    }
    record.coreLocalMatrix = null;
    record.coreLocalOffset = null;

    const worldPos = new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z);
    const worldQuat = new THREE.Quaternion(
      pose.quaternion.x,
      pose.quaternion.y,
      pose.quaternion.z,
      pose.quaternion.w,
    );
    const worldScale = new THREE.Vector3(1, 1, 1);
    const turretWorldMatrix = new THREE.Matrix4().compose(worldPos, worldQuat, worldScale);

    record.visual.position.copy(worldPos);
    record.visual.quaternion.copy(worldQuat);
    record.visual.updateMatrixWorld(true);

    record.collider.position.copy(worldPos);
    record.collider.quaternion.copy(worldQuat);
    record.collider.matrix.copy(turretWorldMatrix);

    if (record.mountProfile === 'surface-clamp' && surfaceId) {
      const surface = roomModel.getSurface(surfaceId);
      if (surface) {
        const localMatrix = surface.worldMatrix.clone().invert().multiply(turretWorldMatrix);
        const normalScratch = new THREE.Vector3();

        record.surfaceAnchor = roomModel.attachAnchor(surface.id, localMatrix, {
          visual: record.visual,
          collider: record.collider,
          onUpdate(updated) {
            record.tracked = updated.tracked;
            record.visible = updated.visible;
            if (updated.tracked) {
              record.position = {
                x: updated.worldPosition.x,
                y: updated.worldPosition.y,
                z: updated.worldPosition.z,
              };
              record.quaternion = {
                x: updated.worldQuaternion.x,
                y: updated.worldQuaternion.y,
                z: updated.worldQuaternion.z,
                w: updated.worldQuaternion.w,
              };
              normalScratch.set(0, 1, 0).applyQuaternion(updated.worldQuaternion).normalize();
              record.normal = {
                x: normalScratch.x,
                y: normalScratch.y,
                z: normalScratch.z,
              };
            }
          },
        });
        return;
      }
    }

    // Hover-pod (or surface without a registered RoomSurface): anchor relative to Core frame
    const core = resolveCoreAnchor();
    if (core) {
      const coreWorldMatrix = makeCoreWorldMatrix(core);
      const invCore = coreWorldMatrix.clone().invert();
      record.coreLocalMatrix = invCore.multiply(turretWorldMatrix);
      const localOffset = new THREE.Vector3().setFromMatrixPosition(record.coreLocalMatrix);
      record.coreLocalOffset = { x: localOffset.x, y: localOffset.y, z: localOffset.z };
    }
  }

  // Subscribe to RoomSurfaceModel updates so surface pick meshes and Core-relative hover-pods stay synced
  unsubscribers.push(
    roomModel.subscribe(() => {
      syncSurfacePickMeshes();
      syncHoverPodAnchors();
      notify();
    }),
  );

  const controller: TurretPlacementController = {
    get state() {
      return buildState();
    },
    get ghost() {
      return ghost;
    },
    get placementRays() {
      return placementRays;
    },
    get pointer() {
      return pointer;
    },
    get placedTurretsGroup() {
      return placedTurretsGroup;
    },
    get surfacePickGroup() {
      return surfacePickGroup;
    },
    get placedTurrets() {
      return [...placedTurretsMap.values()];
    },
    get turretCount() {
      return placedTurretsMap.size;
    },
    get credits() {
      return resolveCredits();
    },
    get selectedKind() {
      return selectedKind;
    },
    get mountMode() {
      return mountProfile;
    },
    get hoverDepthM() {
      return hoverDepthM;
    },
    get relocatingTurretId() {
      return relocatingTurretId;
    },
    get lastValidation() {
      return lastValidation;
    },
    setSelectedKind(kind) {
      selectedKind = kind;
      selectedTier = 'T1';
      relocatingTurretId = null;
      if (lastRayOrigin && lastRayDirection) {
        controller.updateFromRay(lastRayOrigin, lastRayDirection);
      } else {
        notify();
      }
    },
    setCredits(nextCredits) {
      internalCredits = nextCredits;
      if (lastRayOrigin && lastRayDirection) {
        controller.updateFromRay(lastRayOrigin, lastRayDirection);
      } else {
        notify();
      }
    },
    setCoreAnchor(nextCore) {
      explicitCoreAnchor = nextCore;
      syncHoverPodAnchors();
      if (lastRayOrigin && lastRayDirection) {
        controller.updateFromRay(lastRayOrigin, lastRayDirection);
      } else {
        notify();
      }
    },
    setPortalAnchors(nextPortals) {
      explicitPortalAnchors = [...nextPortals];
      if (lastRayOrigin && lastRayDirection) {
        controller.updateFromRay(lastRayOrigin, lastRayDirection);
      } else {
        notify();
      }
    },
    setPlacementActive(nextActive) {
      active = nextActive;
      ghost.setVisible(nextActive);
      if (!nextActive) {
        placementRays?.clear();
      }
      notify();
    },
    beginBuild(kind) {
      if (kind) {
        selectedKind = kind;
      }
      selectedTier = 'T1';
      relocatingTurretId = null;
      active = true;
      ghost.setVisible(true);
      notify();
    },
    beginRelocate(turretId) {
      const existing = placedTurretsMap.get(turretId);
      if (!existing) return false;
      relocatingTurretId = turretId;
      selectedKind = existing.kind;
      selectedTier = existing.tier;
      mountProfile = existing.mountProfile;
      active = true;
      ghost.setVisible(true);
      notify();
      return true;
    },
    cancelPlacement() {
      relocatingTurretId = null;
      active = false;
      ghost.setVisible(false);
      placementRays?.clear();
      notify();
    },
    pushPullThumbstick(pushPullInput, dtSec) {
      if (Math.abs(pushPullInput) > deadzone) {
        if (mountProfile !== 'hover-pod') {
          mountProfile = 'hover-pod';
          if (lastSurfaceHit) {
            hoverDepthM = clampHoverPodDepth(lastSurfaceHit.distance);
            detachedFromSurfaceId = lastSurfaceHit.surface.id;
          }
        }
        hoverDepthM = stepHoverPodDepth(hoverDepthM, pushPullInput, dtSec, {
          deadzone,
          speedMps: hoverSpeedMps,
        });
        hoverStickWasActive = true;
      } else {
        hoverStickWasActive = false;
      }
      return hoverDepthM;
    },
    adjustHoverDepth(deltaDepthM) {
      if (mountProfile !== 'hover-pod') {
        mountProfile = 'hover-pod';
        if (lastSurfaceHit) {
          hoverDepthM = clampHoverPodDepth(lastSurfaceHit.distance);
          detachedFromSurfaceId = lastSurfaceHit.surface.id;
        }
      }
      hoverDepthM = clampHoverPodDepth(hoverDepthM + deltaDepthM);
      if (lastRayOrigin && lastRayDirection) {
        controller.updateFromRay(lastRayOrigin, lastRayDirection);
      } else {
        notify();
      }
      return hoverDepthM;
    },
    setHoverDepth(depthM) {
      mountProfile = 'hover-pod';
      hoverDepthM = clampHoverPodDepth(depthM);
      if (lastRayOrigin && lastRayDirection) {
        controller.updateFromRay(lastRayOrigin, lastRayDirection);
      } else {
        notify();
      }
      return hoverDepthM;
    },
    resnapToSurface() {
      mountProfile = 'surface-clamp';
      detachedFromSurfaceId = null;
      hoverStickWasActive = false;
      if (lastRayOrigin && lastRayDirection) {
        controller.updateFromRay(lastRayOrigin, lastRayDirection);
      } else {
        notify();
      }
    },
    toggleHoverMode() {
      if (mountProfile === 'hover-pod') {
        controller.resnapToSurface();
      } else {
        mountProfile = 'hover-pod';
        if (lastSurfaceHit) {
          hoverDepthM = clampHoverPodDepth(lastSurfaceHit.distance);
          detachedFromSurfaceId = lastSurfaceHit.surface.id;
        }
        if (lastRayOrigin && lastRayDirection) {
          controller.updateFromRay(lastRayOrigin, lastRayDirection);
        } else {
          notify();
        }
      }
      return mountProfile;
    },
    raycastSurface(rayOrigin, rayDirection, acceptsSurface) {
      return raycastSurfaceInternal(rayOrigin, rayDirection, true, acceptsSurface);
    },
    updateFromRay(rayOrigin, rayDirection, rayOptions) {
      lastRayOrigin = cloneVec3(rayOrigin);
      lastRayDirection = cloneVec3(rayDirection);

      const attachableHit = raycastSurfaceInternal(rayOrigin, rayDirection, true);
      const anyHit = attachableHit ?? raycastSurfaceInternal(rayOrigin, rayDirection, false);
      lastSurfaceHit = attachableHit;

      if (rayOptions?.mountProfile) {
        mountProfile = rayOptions.mountProfile;
        if (mountProfile === 'surface-clamp') {
          detachedFromSurfaceId = null;
        }
      }

      if (rayOptions?.resnap) {
        mountProfile = 'surface-clamp';
        detachedFromSurfaceId = null;
        hoverStickWasActive = false;
      }

      const stickY = rayOptions?.stickY ?? 0;
      const dtSec = rayOptions?.dtSec ?? 1 / 60;
      const stickDeflected = Math.abs(stickY) > deadzone;

      if (stickDeflected) {
        if (mountProfile !== 'hover-pod') {
          mountProfile = 'hover-pod';
          if (attachableHit) {
            hoverDepthM = clampHoverPodDepth(attachableHit.distance);
            detachedFromSurfaceId = attachableHit.surface.id;
          }
        }
        hoverDepthM = stepHoverPodDepth(hoverDepthM, stickY, dtSec, {
          deadzone,
          speedMps: hoverSpeedMps,
        });
        hoverStickWasActive = true;
      } else {
        // Neutral thumbstick: check if we should re-snap to a valid surface
        const validRangeSurfaceHit =
          attachableHit !== null &&
          attachableHit.distance >= SURFACE_SNAP_MIN_RANGE_M &&
          attachableHit.distance <= SURFACE_SNAP_MAX_RANGE_M;

        if (mountProfile === 'hover-pod' && validRangeSurfaceHit && attachableHit) {
          const changedSurface =
            detachedFromSurfaceId !== null && attachableHit.surface.id !== detachedFromSurfaceId;
          const enteredFromAir = detachedFromSurfaceId === null && !hoverStickWasActive;
          if (rayOptions?.autoResnapOnNeutral || changedSurface || enteredFromAir) {
            mountProfile = 'surface-clamp';
            detachedFromSurfaceId = null;
          }
        }
        if (!validRangeSurfaceHit && mountProfile === 'hover-pod') {
          // Aimed away from the original detached surface into open space; next valid surface hit will re-snap
          detachedFromSurfaceId = null;
        }
        hoverStickWasActive = false;
      }

      let candidate: TurretPlacementCandidate;
      const forwardHint = rayOptions?.forwardHint ?? {
        x: rayDirection.x,
        y: 0,
        z: rayDirection.z,
      };

      if (mountProfile === 'hover-pod') {
        const hoverPose = computeHoverPodPose({
          rayOrigin,
          rayDirection,
          depthM: hoverDepthM,
          forwardHint,
        });
        hoverDepthM = hoverPose.depthM;
        candidate = {
          kind: selectedKind,
          mountProfile: 'hover-pod',
          position: hoverPose.position,
          normal: hoverPose.normal,
          rayOrigin,
          rayDistanceM: hoverDepthM,
          depthM: hoverDepthM,
          forwardHint,
        };
      } else if (anyHit) {
        candidate = {
          kind: selectedKind,
          mountProfile: 'surface-clamp',
          position: anyHit.point,
          normal: anyHit.normal,
          surface: anyHit.surface,
          surfaceId: anyHit.surface.id,
          surfaceKind: anyHit.surface.kind,
          rayOrigin,
          rayDistanceM: anyHit.distance,
          forwardHint,
        };
      } else {
        // Ray missed all room surfaces in surface-clamp mode
        const fallbackDirLen = Math.hypot(rayDirection.x, rayDirection.y, rayDirection.z) || 1;
        const fallbackPos: Vec3 = {
          x: rayOrigin.x + (rayDirection.x / fallbackDirLen) * hoverDepthM,
          y: rayOrigin.y + (rayDirection.y / fallbackDirLen) * hoverDepthM,
          z: rayOrigin.z + (rayDirection.z / fallbackDirLen) * hoverDepthM,
        };
        candidate = {
          kind: selectedKind,
          mountProfile: 'surface-clamp',
          position: fallbackPos,
          surface: null,
          surfaceId: null,
          surfaceKind: null,
          rayOrigin,
          rayDistanceM: SURFACE_SNAP_MAX_RANGE_M + 1,
          forwardHint,
        };
      }

      const validation = validateTurretPlacement(candidate, {
        existingTurrets: [...placedTurretsMap.values()],
        coreAnchor: resolveCoreAnchor(),
        portalAnchors: resolvePortalAnchors(),
        credits: resolveCredits(),
        relocatingTurretId,
      });

      lastValidation = validation;
      ghost.update({
        validation,
        kind: selectedKind,
        tier: selectedTier,
        visible: active,
      });
      notify();
      return validation;
    },
    updateFromXrFrame(frame, referenceSpace, dtSec, suppressTrigger) {
      if (!active) {
        placementRays?.clear();
        return null;
      }

      const inputSources = [...(frame.session?.inputSources ?? [])].filter(
        (s) => !s.hand && s.targetRaySpace,
      );
      if (inputSources.length === 0) {
        placementRays?.clear();
        return null;
      }

      // Prefer the configured aiming hand (e.g. 'right'), falling back to the first controller
      const aimingSource =
        inputSources.find((s) => s.handedness === preferredHandedness) ??
        (inputSources[0] as XRInputSource);

      const rayTargets: PlacementRayTarget[] = [];
      let activeValidation: PlacementValidationResult | null = null;

      for (const source of inputSources) {
        const pose = frame.getPose(source.targetRaySpace, referenceSpace);
        if (!pose) continue;

        let edges = buttonEdgesBySource.get(source);
        if (!edges) {
          edges = createButtonEdges();
          buttonEdgesBySource.set(source, edges);
        }
        edges.update(source.gamepad);
        if (suppressTrigger?.(source)) continue;

        const origin = new THREE.Vector3(
          pose.transform.position.x,
          pose.transform.position.y,
          pose.transform.position.z,
        );
        const quat = new THREE.Quaternion(
          pose.transform.orientation.x,
          pose.transform.orientation.y,
          pose.transform.orientation.z,
          pose.transform.orientation.w,
        );
        const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(quat).normalize();

        if (source === aimingSource) {
          const pad = source.gamepad;
          const axisOffset = (pad?.axes.length ?? 0) >= 4 ? 2 : 0;
          // WebXR standard gamepad thumbstick Y is negative when pushed forward/up
          const rawGamepadY = pad?.axes[axisOffset + 1] ?? 0;
          const pushPullStick = -rawGamepadY;

          // Brief B/Y button press (buttons[5] or buttons[4]) forces re-snap to surface mode
          const resnapPressed = edges.pressed(5) || edges.pressed(4);
          // Controller Contract (webxr.md): Grip (buttons[1]) is manipulation and must suppress trigger activation
          const gripHeld = edges.held(1);
          const triggerPressed = edges.pressed(0);

          activeValidation = controller.updateFromRay(
            { x: origin.x, y: origin.y, z: origin.z },
            { x: direction.x, y: direction.y, z: direction.z },
            {
              stickY: pushPullStick,
              dtSec,
              resnap: resnapPressed,
            },
          );

          const rayDistance =
            activeValidation.mountProfile === 'hover-pod'
              ? hoverDepthM
              : (lastSurfaceHit?.distance ?? hoverDepthM);

          rayTargets.push({
            source,
            origin,
            direction,
            distance: Math.max(0.2, Math.min(SURFACE_SNAP_MAX_RANGE_M, rayDistance)),
            contact: activeValidation.mountProfile === 'hover-pod' || lastSurfaceHit !== null,
            valid: activeValidation.valid,
          });

          if (triggerPressed && !gripHeld && activeValidation.valid) {
            controller.confirmPlacement('xr');
          }
        } else {
          const hit = raycastSurfaceInternal(
            { x: origin.x, y: origin.y, z: origin.z },
            { x: direction.x, y: direction.y, z: direction.z },
            true,
          );
          rayTargets.push({
            source,
            origin,
            direction,
            distance: hit ? Math.min(SURFACE_SNAP_MAX_RANGE_M, hit.distance) : 1.5,
            contact: hit !== null,
            valid: true,
          });
        }
      }

      placementRays?.update(rayTargets);
      return activeValidation;
    },
    confirmPlacement(source = 'xr') {
      if (!lastValidation?.valid) {
        return null;
      }

      if (relocatingTurretId) {
        const targetId = relocatingTurretId;
        const relocated = controller.relocateTurret(
          targetId,
          {
            mountProfile: lastValidation.mountProfile,
            position: lastValidation.pose.position,
            normal: lastValidation.pose.normal,
            surfaceId: lastValidation.surfaceId,
            surfaceKind: lastValidation.surfaceKind,
            surface: lastValidation.surfaceId
              ? (roomModel.getSurface(lastValidation.surfaceId) ?? null)
              : null,
          },
          source,
        );
        if (relocated) {
          relocatingTurretId = null;
          selectedTier = 'T1';
        }
        return relocated;
      }

      return controller.placeTurret(
        {
          kind: selectedKind,
          tier: 'T1',
          mountProfile: lastValidation.mountProfile,
          position: lastValidation.pose.position,
          normal: lastValidation.pose.normal,
          surfaceId: lastValidation.surfaceId,
          surfaceKind: lastValidation.surfaceKind,
          surface: lastValidation.surfaceId
            ? (roomModel.getSurface(lastValidation.surfaceId) ?? null)
            : null,
        },
        source,
      );
    },
    placeTurret(input, source = 'xr') {
      const kind = input.kind ?? selectedKind;
      const tier = input.tier ?? 'T1';
      const surface =
        input.surface ?? (input.surfaceId ? (roomModel.getSurface(input.surfaceId) ?? null) : null);
      const surfaceId = input.surfaceId ?? surface?.id ?? null;
      const surfaceKind = input.surfaceKind ?? surface?.kind ?? null;
      const profile: TurretMountProfileId =
        input.mountProfile ?? (surface || surfaceId ? 'surface-clamp' : 'hover-pod');

      const validation = validateTurretPlacement(
        {
          kind,
          mountProfile: profile,
          position: input.position,
          normal: input.normal ?? surface?.normal,
          surface,
          surfaceId,
          surfaceKind,
          rayOrigin: input.rayOrigin,
          rayDistanceM: input.rayDistanceM,
          depthM: input.depthM,
          forwardHint: input.forwardHint,
        },
        {
          existingTurrets: [...placedTurretsMap.values()],
          coreAnchor: resolveCoreAnchor(),
          portalAnchors: resolvePortalAnchors(),
          credits: resolveCredits(),
        },
      );

      lastValidation = validation;
      if (!validation.valid) {
        ghost.update({ validation, kind, tier, visible: active });
        notify();
        return null;
      }

      if (internalCredits !== undefined && !options.getCredits) {
        internalCredits = Math.max(0, internalCredits - validation.cost);
      }

      const id = `turret-${nextTurretSeq++}`;
      const def = getTurretDefinition(kind);
      const priority = input.priority ?? def.defaultPriority;
      const visual = buildPlacedTurretVisual(id, kind, tier, validation.mountProfile);
      placedTurretsGroup.add(visual);

      const collider: PlacedTurretCollider = {
        radiusM: TURRET_FOOTPRINT_RADIUS_M,
        position: new THREE.Vector3(
          validation.pose.position.x,
          validation.pose.position.y,
          validation.pose.position.z,
        ),
        quaternion: new THREE.Quaternion(
          validation.pose.quaternion.x,
          validation.pose.quaternion.y,
          validation.pose.quaternion.z,
          validation.pose.quaternion.w,
        ),
        scale: new THREE.Vector3(1, 1, 1),
        matrix: new THREE.Matrix4(),
        visible: true,
      };

      const record: PlacedTurretRecord = {
        id,
        kind,
        tier,
        priority,
        mountProfile: validation.mountProfile,
        position: cloneVec3(validation.pose.position),
        normal: cloneVec3(validation.pose.normal),
        quaternion: cloneQuat(validation.pose.quaternion),
        surfaceId: validation.surfaceId,
        surfaceKind: validation.surfaceKind,
        surfaceAnchor: null,
        coreLocalMatrix: null,
        coreLocalOffset: null,
        visual,
        collider,
        tracked: true,
        visible: true,
        investedCredits: getTurretBuildCost(kind),
      };

      attachTurretAnchoring(record, validation.pose, validation.surfaceId);
      placedTurretsMap.set(id, record);

      actionBus?.dispatch(
        {
          type: 'turret/build',
          kind,
          position: cloneVec3(record.position),
          ...(record.surfaceId ? { surfaceId: record.surfaceId } : {}),
        },
        source,
      );

      // Re-validate current ghost preview against the updated turret list
      if (lastRayOrigin && lastRayDirection) {
        controller.updateFromRay(lastRayOrigin, lastRayDirection);
      } else {
        notify();
      }
      return record;
    },
    relocateTurret(turretId, input, source = 'xr') {
      const existing = placedTurretsMap.get(turretId);
      if (!existing) return null;

      const surface =
        input.surface ?? (input.surfaceId ? (roomModel.getSurface(input.surfaceId) ?? null) : null);
      const surfaceId = input.surfaceId ?? surface?.id ?? null;
      const surfaceKind = input.surfaceKind ?? surface?.kind ?? null;
      const profile: TurretMountProfileId =
        input.mountProfile ?? (surface || surfaceId ? 'surface-clamp' : 'hover-pod');

      const validation = validateTurretPlacement(
        {
          kind: existing.kind,
          mountProfile: profile,
          position: input.position,
          normal: input.normal ?? surface?.normal,
          surface,
          surfaceId,
          surfaceKind,
          rayOrigin: input.rayOrigin,
          rayDistanceM: input.rayDistanceM,
          depthM: input.depthM,
          forwardHint: input.forwardHint,
        },
        {
          existingTurrets: [...placedTurretsMap.values()],
          coreAnchor: resolveCoreAnchor(),
          portalAnchors: resolvePortalAnchors(),
          credits: resolveCredits(),
          relocatingTurretId: turretId,
        },
      );

      lastValidation = validation;
      if (!validation.valid) {
        ghost.update({
          validation,
          kind: existing.kind,
          tier: existing.tier,
          visible: active,
        });
        notify();
        return null;
      }

      if (internalCredits !== undefined && !options.getCredits) {
        internalCredits = Math.max(0, internalCredits - TURRET_RELOCATE_COST);
      }

      existing.mountProfile = validation.mountProfile;
      existing.position = cloneVec3(validation.pose.position);
      existing.normal = cloneVec3(validation.pose.normal);
      existing.quaternion = cloneQuat(validation.pose.quaternion);
      existing.surfaceId = validation.surfaceId;
      existing.surfaceKind = validation.surfaceKind;
      existing.visual.userData.mountProfile = validation.mountProfile;

      attachTurretAnchoring(existing, validation.pose, validation.surfaceId);

      actionBus?.dispatch(
        {
          type: 'turret/relocate',
          turretId,
          position: cloneVec3(existing.position),
          ...(existing.surfaceId ? { surfaceId: existing.surfaceId } : {}),
        },
        source,
      );

      if (lastRayOrigin && lastRayDirection) {
        controller.updateFromRay(lastRayOrigin, lastRayDirection);
      } else {
        notify();
      }
      return existing;
    },
    upgradeTurret(turretId, source = 'xr') {
      const existing = placedTurretsMap.get(turretId);
      if (!existing) return null;
      const nextTier = getNextTurretTier(existing.tier);
      const upgradeCost = getTurretUpgradeCost(existing.kind, existing.tier);
      if (!nextTier || upgradeCost === null) return null;

      const available = resolveCredits();
      if (typeof available === 'number' && available < upgradeCost) {
        return null;
      }
      if (internalCredits !== undefined && !options.getCredits) {
        internalCredits = Math.max(0, internalCredits - upgradeCost);
      }

      existing.tier = nextTier;
      existing.investedCredits += upgradeCost;
      existing.visual.userData.turretTier = nextTier;

      actionBus?.dispatch({ type: 'turret/upgrade', turretId }, source);
      notify();
      return existing;
    },
    sellTurret(turretId, source = 'xr') {
      const existing = placedTurretsMap.get(turretId);
      if (!existing) return 0;
      const refund = getTurretSellRefund(existing.kind, existing.tier);
      controller.removeTurret(turretId);
      if (internalCredits !== undefined && !options.getCredits) {
        internalCredits += refund;
      }
      actionBus?.dispatch({ type: 'turret/sell', turretId }, source);
      notify();
      return refund;
    },
    setTurretPriority(turretId, priority, source = 'xr') {
      const existing = placedTurretsMap.get(turretId);
      if (!existing) return null;
      existing.priority = priority;
      actionBus?.dispatch({ type: 'turret/set-priority', turretId, priority }, source);
      notify();
      return existing;
    },
    removeTurret(turretId) {
      const existing = placedTurretsMap.get(turretId);
      if (!existing) return false;
      if (existing.surfaceAnchor) {
        roomModel.detachAnchor(existing.surfaceAnchor.id);
      }
      placedTurretsGroup.remove(existing.visual);
      (existing.visual.userData.disposeVisual as (() => void) | undefined)?.();
      placedTurretsMap.delete(turretId);
      if (relocatingTurretId === turretId) {
        relocatingTurretId = null;
      }
      if (lastRayOrigin && lastRayDirection) {
        controller.updateFromRay(lastRayOrigin, lastRayDirection);
      } else {
        notify();
      }
      return true;
    },
    getTurret(turretId) {
      return placedTurretsMap.get(turretId);
    },
    pickPlacedTurret(rayOrigin, rayDirection) {
      const dirLen = Math.hypot(rayDirection.x, rayDirection.y, rayDirection.z);
      if (dirLen < 1e-8) return null;
      const dx = rayDirection.x / dirLen;
      const dy = rayDirection.y / dirLen;
      const dz = rayDirection.z / dirLen;

      let bestRecord: PlacedTurretRecord | null = null;
      let bestT = Number.POSITIVE_INFINITY;

      for (const record of placedTurretsMap.values()) {
        if (!record.visible) continue;
        // Sphere intersection around turret base + head center
        const cx = record.position.x + record.normal.x * 0.12;
        const cy = record.position.y + record.normal.y * 0.12;
        const cz = record.position.z + record.normal.z * 0.12;
        const radius = record.collider.radiusM * 1.15;

        const ocx = rayOrigin.x - cx;
        const ocy = rayOrigin.y - cy;
        const ocz = rayOrigin.z - cz;
        const b = ocx * dx + ocy * dy + ocz * dz;
        const c = ocx * ocx + ocy * ocy + ocz * ocz - radius * radius;
        const disc = b * b - c;
        if (disc < 0) continue;
        const t = -b - Math.sqrt(disc);
        const hitT = t >= 0 ? t : -b + Math.sqrt(disc);
        if (hitT >= 0.05 && hitT <= SURFACE_SNAP_MAX_RANGE_M && hitT < bestT) {
          bestT = hitT;
          bestRecord = record;
        }
      }
      return bestRecord;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      for (const unsub of unsubscribers) unsub();
      unsubscribers.length = 0;
      listeners.clear();

      for (const id of [...placedTurretsMap.keys()]) {
        controller.removeTurret(id);
      }
      clearPickMeshes();
      pickMaterial.dispose();

      placedTurretsGroup.removeFromParent();
      surfacePickGroup.removeFromParent();

      if (ownsPlacementRays && placementRays) {
        placementRays.dispose();
      }
      if (ownsGhost) {
        ghost.group.removeFromParent();
        ghost.dispose();
      }
    },
  };

  syncSurfacePickMeshes();
  return controller;
}

export const createPlacementController = createTurretPlacementController;
