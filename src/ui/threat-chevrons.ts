/**
 * Edge-of-View Directional Threat Chevrons (`src/ui/threat-chevrons.ts`).
 *
 * Implements `PRD.md` §D4 (Seated & Standing Play Arc) and `plans/phase-2-combat-simulation-and-waves.md` (P2-T5):
 * - Points toward off-FOV newly opened dimensional rift portals (`portal-opened` events for `4.0 s`)
 *   and active enemies within `1.8 m` of the Core Bastion (`NEAR_CORE_THREAT_RADIUS_M = 1.8`).
 * - Renders both:
 *   1. **Desktop DOM Edge Indicators (`desktopElement`):** CSSOM-styled directional chevrons
 *      anchored around the viewport perimeter (` strict production CSP safe).
 *   2. **XR Camera-Anchored Ring Indicators (`xrRoot`):** Spatial peripheral ring anchored in
 *      front of the viewer camera using `@par/xr-workspace` `keepAbove` (`OVERLAY_RENDER_ORDER`).
 */

import { keepAbove, OVERLAY_RENDER_ORDER } from '@par/xr-workspace';
import * as THREE from 'three';
import type { Vec3 } from '../content/turrets.ts';
import type { CombatSimulationState, SimEnemy, SimEvent } from '../sim/engine.ts';

/** Distance threshold from the Core Bastion within which off-FOV enemies trigger threat chevrons (`1.8 m`, PRD D4). */
export const NEAR_CORE_THREAT_RADIUS_M = 1.8;

/** Duration (`4.0 s`) a newly opened portal triggers an off-FOV directional chevron after `portal-opened`. */
export const PORTAL_THREAT_ALERT_DURATION_SEC = 4.0;

/** Default viewer FOV half-angle cone (`42°` in radians) beyond which targets are considered off-FOV. */
export const DEFAULT_THREAT_FOV_HALF_ANGLE_RAD = (42 * Math.PI) / 180;

/** Maximum number of simultaneous directional threat chevrons rendered around the view edge. */
export const MAX_VISIBLE_THREAT_CHEVRONS = 6;

/** Distance in meters ahead of the XR viewer camera where the peripheral chevron ring is anchored. */
export const XR_CHEVRON_RING_DISTANCE_M = 0.52;

/** Radius in meters of the XR peripheral chevron ring around the camera forward axis. */
export const XR_CHEVRON_RING_RADIUS_M = 0.17;

export type ThreatChevronMode = 'desktop' | 'xr';
export type ThreatChevronKind = 'near-core' | 'portal-opened';

export interface ViewerPoseInput {
  readonly position: Readonly<Vec3>;
  /** Optional unit forward vector (defaults to horizontal forward from `yaw` or `(0, 0, -1)`). */
  readonly forward?: Readonly<Vec3>;
  /** Optional unit up vector (defaults to `(0, 1, 0)`). */
  readonly up?: Readonly<Vec3>;
  /** Optional horizontal yaw in radians (`0` = `-Z`, `+PI/2` = `-X`). Used when `forward` and `quaternion` are omitted. */
  readonly yaw?: number;
  /** Optional world quaternion (`{ x, y, z, w }`). Supersedes `forward` and `yaw` when provided. */
  readonly quaternion?: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly w: number;
  };
}

export interface ThreatAngularProjection {
  /** `true` when the target lies outside the viewer's forward FOV cone. */
  readonly offFov: boolean;
  /** 3D angle in radians `[0, PI]` between viewer forward vector and target direction. */
  readonly angleFromForwardRad: number;
  /** Signed horizontal azimuth in viewer space `[-PI, PI]` (`0` = ahead, `+PI/2` = right, `-PI/2` = left). */
  readonly azimuthRad: number;
  /** Signed vertical elevation in viewer space `[-PI/2, PI/2]`. */
  readonly elevationRad: number;
  /**
   * 2D view-plane / peripheral-ring polar angle in radians `[-PI, PI]`:
   * `0` = right (`+X`), `+PI/2` = top (`+Y`), `-PI/2` = bottom (`-Y`), `±PI` = left (`-X`).
   */
  readonly edgeAngleRad: number;
  /** Unit X component on the 2D HUD ring (`cos(edgeAngleRad)`). */
  readonly edgeDirX: number;
  /** Unit Y component on the 2D HUD ring (`sin(edgeAngleRad)`). */
  readonly edgeDirY: number;
  /** Viewport perimeter-clamped normalized X coordinate in `[-1, 1]`. */
  readonly edgeNdcX: number;
  /** Viewport perimeter-clamped normalized Y coordinate in `[-1, 1]`. */
  readonly edgeNdcY: number;
  /** Euclidean 3D distance from viewer to target in meters. */
  readonly distanceToViewerM: number;
}

export interface PortalThreatAlert {
  readonly portalId: string;
  readonly position: Vec3;
  readonly waveNumber: number;
  remainingSec: number;
}

export interface ThreatChevronDescriptor {
  readonly id: string;
  readonly kind: ThreatChevronKind;
  readonly sourceId: string;
  readonly label: string;
  readonly position: Vec3;
  readonly distanceToCoreM: number;
  readonly urgency: number;
  readonly isBoss: boolean;
  readonly projection: ThreatAngularProjection;
}

export interface EvaluateThreatsInput {
  readonly viewer: ViewerPoseInput;
  readonly corePosition: Readonly<Vec3>;
  readonly enemies: readonly Pick<SimEnemy, 'id' | 'archetypeId' | 'position' | 'hp' | 'isBoss'>[];
  readonly portalAlerts?: readonly PortalThreatAlert[];
  readonly nearCoreRadiusM?: number;
  readonly fovHalfAngleRad?: number;
  readonly maxChevrons?: number;
}

export interface ThreatChevronsUpdateInput {
  readonly snapshot: Pick<CombatSimulationState, 'corePosition' | 'enemies'>;
  readonly events?: readonly SimEvent[];
  readonly dt: number;
  readonly camera?: THREE.Camera | null;
  readonly viewer?: ViewerPoseInput;
}

export interface ThreatChevronsOptions {
  readonly container?: HTMLElement | null;
  readonly initialMode?: ThreatChevronMode;
  readonly initialVisible?: boolean;
  readonly nearCoreRadiusM?: number;
  readonly portalAlertDurationSec?: number;
  readonly fovHalfAngleRad?: number;
  readonly maxChevrons?: number;
  readonly renderOrder?: number;
}

export interface ThreatChevrons {
  readonly xrRoot: THREE.Group;
  readonly desktopElement: HTMLElement | null;
  readonly activeThreats: readonly ThreatChevronDescriptor[];
  readonly portalAlerts: readonly PortalThreatAlert[];
  readonly mode: ThreatChevronMode;
  readonly visible: boolean;
  ingestEvents(events: readonly SimEvent[]): void;
  update(input: ThreatChevronsUpdateInput): readonly ThreatChevronDescriptor[];
  setMode(mode: ThreatChevronMode): void;
  setVisible(visible: boolean): void;
  clear(): void;
  dispose(): void;
}

const COLOR_NEAR_CORE_HEX = 0xff3b5c;
const COLOR_BOSS_HEX = 0xff9f1c;
const COLOR_PORTAL_HEX = 0xa855f7;

function applyStyle(element: HTMLElement, css: Partial<CSSStyleDeclaration>): void {
  Object.assign(element.style, css);
}

function distance3D(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function resolveViewerBasis(viewer: ViewerPoseInput): {
  readonly right: Vec3;
  readonly up: Vec3;
  readonly forward: Vec3;
} {
  if (viewer.quaternion) {
    const q = new THREE.Quaternion(
      viewer.quaternion.x,
      viewer.quaternion.y,
      viewer.quaternion.z,
      viewer.quaternion.w,
    );
    const rightV = new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize();
    const upV = new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize();
    const fwdV = new THREE.Vector3(0, 0, -1).applyQuaternion(q).normalize();
    return {
      right: { x: rightV.x, y: rightV.y, z: rightV.z },
      up: { x: upV.x, y: upV.y, z: upV.z },
      forward: { x: fwdV.x, y: fwdV.y, z: fwdV.z },
    };
  }

  if (viewer.forward) {
    const fwdV = new THREE.Vector3(
      viewer.forward.x,
      viewer.forward.y,
      viewer.forward.z,
    ).normalize();
    if (fwdV.lengthSq() < 1e-8) fwdV.set(0, 0, -1);
    const upHint = viewer.up
      ? new THREE.Vector3(viewer.up.x, viewer.up.y, viewer.up.z).normalize()
      : new THREE.Vector3(0, 1, 0);
    const rightV = new THREE.Vector3().crossVectors(fwdV, upHint);
    if (rightV.lengthSq() < 1e-8) {
      rightV.set(1, 0, 0);
    } else {
      rightV.normalize();
    }
    const upV = new THREE.Vector3().crossVectors(rightV, fwdV).normalize();
    return {
      right: { x: rightV.x, y: rightV.y, z: rightV.z },
      up: { x: upV.x, y: upV.y, z: upV.z },
      forward: { x: fwdV.x, y: fwdV.y, z: fwdV.z },
    };
  }

  const yaw = viewer.yaw ?? 0;
  return {
    right: { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) },
    up: { x: 0, y: 1, z: 0 },
    forward: { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) },
  };
}

/**
 * Extracts a `ViewerPoseInput` from a Three.js `Camera` or `Object3D`.
 */
export function extractViewerPoseFromCamera(camera: THREE.Object3D): ViewerPoseInput {
  camera.updateMatrixWorld(true);
  const pos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  const quat = new THREE.Quaternion().setFromRotationMatrix(camera.matrixWorld);
  return {
    position: { x: pos.x, y: pos.y, z: pos.z },
    quaternion: { x: quat.x, y: quat.y, z: quat.z, w: quat.w },
  };
}

/**
 * Pure angular projection of a 3D world threat position into viewer-relative azimuth, elevation,
 * off-FOV classification, and 2D screen-edge / peripheral-ring coordinates.
 */
export function projectThreatDirection(
  viewer: ViewerPoseInput,
  targetPosition: Readonly<Vec3>,
  fovHalfAngleRad = DEFAULT_THREAT_FOV_HALF_ANGLE_RAD,
): ThreatAngularProjection {
  const basis = resolveViewerBasis(viewer);
  const dx = targetPosition.x - viewer.position.x;
  const dy = targetPosition.y - viewer.position.y;
  const dz = targetPosition.z - viewer.position.z;
  const dist = Math.hypot(dx, dy, dz);

  if (dist < 1e-6) {
    return {
      offFov: false,
      angleFromForwardRad: 0,
      azimuthRad: 0,
      elevationRad: 0,
      edgeAngleRad: 0,
      edgeDirX: 1,
      edgeDirY: 0,
      edgeNdcX: 1,
      edgeNdcY: 0,
      distanceToViewerM: 0,
    };
  }

  const localX = dx * basis.right.x + dy * basis.right.y + dz * basis.right.z;
  const localY = dx * basis.up.x + dy * basis.up.y + dz * basis.up.z;
  const localForward = dx * basis.forward.x + dy * basis.forward.y + dz * basis.forward.z;

  const cosAngle = THREE.MathUtils.clamp(localForward / dist, -1, 1);
  const angleFromForwardRad = Math.acos(cosAngle);
  const azimuthRad = Math.atan2(localX, localForward);
  const elevationRad = Math.asin(THREE.MathUtils.clamp(localY / dist, -1, 1));

  const offFov =
    localForward <= 0 ||
    angleFromForwardRad > fovHalfAngleRad ||
    Math.abs(azimuthRad) > fovHalfAngleRad;

  // Project onto the 2D HUD plane (X = right, Y = up). If the target is behind the viewer
  // near the center axis (|localX| & |localY| small), bias horizontally toward the shorter turn direction.
  let planeX = localX;
  const planeY = localY;
  if (localForward < 0 && Math.hypot(planeX, planeY) < dist * 0.25) {
    planeX = Math.abs(planeX) > 1e-5 ? Math.sign(planeX) * dist : dist;
  }

  const planeLen = Math.hypot(planeX, planeY);
  const edgeDirX = planeLen > 1e-6 ? planeX / planeLen : 1;
  const edgeDirY = planeLen > 1e-6 ? planeY / planeLen : 0;
  const edgeAngleRad = Math.atan2(edgeDirY, edgeDirX);

  const maxAbs = Math.max(Math.abs(edgeDirX), Math.abs(edgeDirY), 1e-6);
  const edgeNdcX = edgeDirX / maxAbs;
  const edgeNdcY = edgeDirY / maxAbs;

  return {
    offFov,
    angleFromForwardRad,
    azimuthRad,
    elevationRad,
    edgeAngleRad,
    edgeDirX,
    edgeDirY,
    edgeNdcX,
    edgeNdcY,
    distanceToViewerM: dist,
  };
}

/**
 * Evaluates all active enemies within `nearCoreRadiusM` (`1.8 m`) of the Core Bastion and
 * recently opened portals (`portal-opened` within `4.0 s`), returning off-FOV threat chevrons
 * sorted by priority.
 */
export function evaluateThreatIndicators(input: EvaluateThreatsInput): ThreatChevronDescriptor[] {
  const nearCoreRadiusM = input.nearCoreRadiusM ?? NEAR_CORE_THREAT_RADIUS_M;
  const fovHalfAngleRad = input.fovHalfAngleRad ?? DEFAULT_THREAT_FOV_HALF_ANGLE_RAD;
  const maxChevrons = input.maxChevrons ?? MAX_VISIBLE_THREAT_CHEVRONS;

  const descriptors: ThreatChevronDescriptor[] = [];

  for (const enemy of input.enemies) {
    if (enemy.hp <= 0) continue;
    const distToCore = distance3D(enemy.position, input.corePosition);
    if (distToCore > nearCoreRadiusM + 1e-6) continue;

    const projection = projectThreatDirection(input.viewer, enemy.position, fovHalfAngleRad);
    if (!projection.offFov) continue;

    const urgency = 1 - Math.min(1, distToCore / Math.max(0.01, nearCoreRadiusM));
    descriptors.push({
      id: `threat-enemy:${enemy.id}`,
      kind: 'near-core',
      sourceId: enemy.id,
      label: enemy.isBoss ? 'BOSS NEAR CORE' : 'CORE THREAT',
      position: { x: enemy.position.x, y: enemy.position.y, z: enemy.position.z },
      distanceToCoreM: distToCore,
      urgency: enemy.isBoss ? urgency + 0.5 : urgency,
      isBoss: enemy.isBoss,
      projection,
    });
  }

  for (const alert of input.portalAlerts ?? []) {
    if (alert.remainingSec <= 0) continue;
    const projection = projectThreatDirection(input.viewer, alert.position, fovHalfAngleRad);
    if (!projection.offFov) continue;

    const distToCore = distance3D(alert.position, input.corePosition);
    const urgency = Math.min(1, alert.remainingSec / PORTAL_THREAT_ALERT_DURATION_SEC);
    descriptors.push({
      id: `threat-portal:${alert.portalId}`,
      kind: 'portal-opened',
      sourceId: alert.portalId,
      label: 'RIFT OPENED',
      position: { x: alert.position.x, y: alert.position.y, z: alert.position.z },
      distanceToCoreM: distToCore,
      urgency,
      isBoss: false,
      projection,
    });
  }

  descriptors.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'near-core' ? -1 : 1;
    }
    if (Math.abs(b.urgency - a.urgency) > 1e-5) {
      return b.urgency - a.urgency;
    }
    return a.sourceId.localeCompare(b.sourceId);
  });

  return descriptors.slice(0, Math.max(0, maxChevrons));
}

function buildChevronShapeGeometry(): THREE.BufferGeometry {
  // Flat chevron arrow pointing along +Y in local XY plane
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.022);
  shape.lineTo(0.018, -0.014);
  shape.lineTo(0.007, -0.008);
  shape.lineTo(0, -0.018);
  shape.lineTo(-0.007, -0.008);
  shape.lineTo(-0.018, -0.014);
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}

/**
 * Creates the hybrid Desktop DOM & Spatial XR edge-of-view directional threat chevron controller.
 */
export function createThreatChevrons(options: ThreatChevronsOptions = {}): ThreatChevrons {
  const nearCoreRadiusM = options.nearCoreRadiusM ?? NEAR_CORE_THREAT_RADIUS_M;
  const portalAlertDurationSec = options.portalAlertDurationSec ?? PORTAL_THREAT_ALERT_DURATION_SEC;
  const fovHalfAngleRad = options.fovHalfAngleRad ?? DEFAULT_THREAT_FOV_HALF_ANGLE_RAD;
  const maxChevrons = options.maxChevrons ?? MAX_VISIBLE_THREAT_CHEVRONS;
  const renderOrder = options.renderOrder ?? OVERLAY_RENDER_ORDER;

  let mode: ThreatChevronMode = options.initialMode ?? 'desktop';
  let visible = options.initialVisible ?? true;
  let activeThreats: ThreatChevronDescriptor[] = [];
  let pulsePhase = 0;
  let disposed = false;

  const portalAlertsMap = new Map<string, PortalThreatAlert>();

  // --- Spatial XR Peripheral Ring ---
  const xrRoot = new THREE.Group();
  xrRoot.name = 'threat-chevrons-xr-root';
  xrRoot.raycast = () => undefined;

  const chevronGeo = buildChevronShapeGeometry();
  const xrSlots: Array<{
    readonly mesh: THREE.Mesh;
    readonly material: THREE.MeshBasicMaterial;
  }> = [];

  for (let i = 0; i < maxChevrons; i += 1) {
    const material = new THREE.MeshBasicMaterial({
      color: COLOR_NEAR_CORE_HEX,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });
    material.forceSinglePass = true;
    const mesh = new THREE.Mesh(chevronGeo, material);
    mesh.name = `threat-chevron-xr-${i}`;
    mesh.visible = false;
    mesh.raycast = () => undefined;
    xrRoot.add(mesh);
    xrSlots.push({ mesh, material });
  }

  const stopKeepAbove = keepAbove(xrRoot, renderOrder);

  // --- Desktop DOM Perimeter Container ---
  const container =
    options.container !== undefined
      ? options.container
      : typeof document !== 'undefined'
        ? document.body
        : null;

  let desktopElement: HTMLElement | null = null;
  const domSlots: Array<{
    readonly badge: HTMLDivElement;
    readonly arrow: HTMLSpanElement;
    readonly text: HTMLSpanElement;
  }> = [];

  if (container) {
    const doc = container.ownerDocument;
    const rootEl = doc.createElement('div');
    rootEl.dataset.ui = 'threat-chevrons';
    rootEl.setAttribute('aria-label', 'Directional Threat Indicators');
    applyStyle(rootEl, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '6800',
      overflow: 'hidden',
    });

    for (let i = 0; i < maxChevrons; i += 1) {
      const badge = doc.createElement('div');
      badge.dataset.threatChevron = String(i);
      badge.hidden = true;
      applyStyle(badge, {
        position: 'absolute',
        display: 'none',
        alignItems: 'center',
        gap: '6px',
        padding: '5px 10px',
        borderRadius: '999px',
        background: 'rgba(18, 10, 18, 0.88)',
        border: '1.5px solid #ff3b5c',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.5)',
        color: '#ffeef2',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontSize: '11px',
        fontWeight: '700',
        letterSpacing: '0.06em',
        transform: 'translate(-50%, -50%)',
        whiteSpace: 'nowrap',
      });

      const arrow = doc.createElement('span');
      arrow.dataset.threatArrow = String(i);
      arrow.textContent = '▲';
      applyStyle(arrow, {
        display: 'inline-block',
        fontSize: '13px',
        lineHeight: '1',
      });

      const text = doc.createElement('span');
      text.dataset.threatLabel = String(i);

      badge.append(arrow, text);
      rootEl.appendChild(badge);
      domSlots.push({ badge, arrow, text });
    }

    container.appendChild(rootEl);
    desktopElement = rootEl;
  }

  function syncModeVisibility(): void {
    const hasThreats = activeThreats.length > 0;
    xrRoot.visible = visible && mode === 'xr' && hasThreats;
    if (desktopElement) {
      const showDom = visible && mode === 'desktop' && hasThreats;
      desktopElement.hidden = !showDom;
      applyStyle(desktopElement, { display: showDom ? 'block' : 'none' });
    }
  }

  function ingestEvents(events: readonly SimEvent[]): void {
    if (disposed) return;
    for (const ev of events) {
      if (ev.type === 'portal-opened') {
        portalAlertsMap.set(ev.portalId, {
          portalId: ev.portalId,
          position: { x: ev.position.x, y: ev.position.y, z: ev.position.z },
          waveNumber: ev.waveNumber,
          remainingSec: portalAlertDurationSec,
        });
      }
    }
  }

  const _camPos = new THREE.Vector3();
  const _camQuat = new THREE.Quaternion();
  const _forwardOffset = new THREE.Vector3();

  return {
    xrRoot,
    desktopElement,
    get activeThreats() {
      return activeThreats;
    },
    get portalAlerts() {
      return [...portalAlertsMap.values()];
    },
    get mode() {
      return mode;
    },
    get visible() {
      return visible;
    },
    ingestEvents,
    update(input) {
      if (disposed) return activeThreats;

      const dt = Number.isFinite(input.dt) && input.dt > 0 ? input.dt : 0;
      pulsePhase = (pulsePhase + dt * 6) % (Math.PI * 2);

      // Decay existing portal alerts before ingesting new events from this step
      if (dt > 0) {
        for (const [portalId, alert] of portalAlertsMap.entries()) {
          alert.remainingSec = Math.max(0, alert.remainingSec - dt);
          if (alert.remainingSec <= 0) {
            portalAlertsMap.delete(portalId);
          }
        }
      }

      if (input.events && input.events.length > 0) {
        ingestEvents(input.events);
      }

      const viewer: ViewerPoseInput = input.viewer
        ? input.viewer
        : input.camera
          ? extractViewerPoseFromCamera(input.camera)
          : { position: { x: 0, y: 1.55, z: 1.45 }, yaw: 0 };

      // Anchor xrRoot in front of the active camera so peripheral ring indicators stay in view
      if (input.camera) {
        input.camera.updateMatrixWorld(true);
        _camPos.setFromMatrixPosition(input.camera.matrixWorld);
        _camQuat.setFromRotationMatrix(input.camera.matrixWorld);
        _forwardOffset.set(0, 0, -XR_CHEVRON_RING_DISTANCE_M).applyQuaternion(_camQuat);
        xrRoot.position.copy(_camPos).add(_forwardOffset);
        xrRoot.quaternion.copy(_camQuat);
        xrRoot.updateMatrixWorld(true);
      }

      activeThreats = evaluateThreatIndicators({
        viewer,
        corePosition: input.snapshot.corePosition,
        enemies: input.snapshot.enemies,
        portalAlerts: [...portalAlertsMap.values()],
        nearCoreRadiusM,
        fovHalfAngleRad,
        maxChevrons,
      });

      const pulseOpacity = 0.78 + 0.22 * Math.sin(pulsePhase);

      // Update XR peripheral ring slots
      for (let i = 0; i < xrSlots.length; i += 1) {
        const slot = xrSlots[i];
        if (!slot) continue;
        const threat = activeThreats[i];
        if (!threat) {
          slot.mesh.visible = false;
          continue;
        }
        slot.mesh.visible = true;
        const angle = threat.projection.edgeAngleRad;
        slot.mesh.position.set(
          Math.cos(angle) * XR_CHEVRON_RING_RADIUS_M,
          Math.sin(angle) * XR_CHEVRON_RING_RADIUS_M,
          0,
        );
        // Local +Y points outward along angle
        slot.mesh.rotation.set(0, 0, angle - Math.PI / 2);
        const colorHex =
          threat.kind === 'near-core'
            ? threat.isBoss
              ? COLOR_BOSS_HEX
              : COLOR_NEAR_CORE_HEX
            : COLOR_PORTAL_HEX;
        slot.material.color.setHex(colorHex);
        slot.material.opacity = pulseOpacity;
        slot.mesh.userData.threatId = threat.id;
        slot.mesh.userData.threatKind = threat.kind;
        slot.mesh.userData.sourceId = threat.sourceId;
      }

      // Update Desktop DOM edge chevron badges
      for (let i = 0; i < domSlots.length; i += 1) {
        const slot = domSlots[i];
        if (!slot) continue;
        const threat = activeThreats[i];
        if (!threat) {
          slot.badge.hidden = true;
          applyStyle(slot.badge, { display: 'none' });
          continue;
        }
        slot.badge.hidden = false;
        slot.badge.dataset.threatKind = threat.kind;
        slot.badge.dataset.sourceId = threat.sourceId;

        // Map edgeNdcX/Y in [-1, 1] to [8%, 92%] of viewport
        const leftPct = 50 + threat.projection.edgeNdcX * 42;
        const topPct = 50 - threat.projection.edgeNdcY * 40;
        const deg = 90 - (threat.projection.edgeAngleRad * 180) / Math.PI;
        const accent =
          threat.kind === 'near-core' ? (threat.isBoss ? '#ff9f1c' : '#ff3b5c') : '#c084fc';

        slot.text.textContent =
          threat.kind === 'near-core'
            ? `${threat.label} (${threat.distanceToCoreM.toFixed(1)}m)`
            : threat.label;

        applyStyle(slot.arrow, {
          color: accent,
          transform: `rotate(${deg.toFixed(1)}deg)`,
        });
        applyStyle(slot.badge, {
          display: 'flex',
          left: `${leftPct.toFixed(1)}%`,
          top: `${topPct.toFixed(1)}%`,
          borderColor: accent,
        });
      }

      syncModeVisibility();
      return activeThreats;
    },
    setMode(nextMode) {
      if (disposed || mode === nextMode) return;
      mode = nextMode;
      syncModeVisibility();
    },
    setVisible(nextVisible) {
      if (disposed || visible === nextVisible) return;
      visible = nextVisible;
      syncModeVisibility();
    },
    clear() {
      portalAlertsMap.clear();
      activeThreats = [];
      for (const slot of xrSlots) {
        slot.mesh.visible = false;
      }
      for (const slot of domSlots) {
        slot.badge.hidden = true;
        applyStyle(slot.badge, { display: 'none' });
      }
      syncModeVisibility();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopKeepAbove();
      portalAlertsMap.clear();
      activeThreats = [];
      chevronGeo.dispose();
      for (const slot of xrSlots) {
        slot.material.dispose();
      }
      xrRoot.clear();
      xrRoot.removeFromParent();
      desktopElement?.remove();
    },
  };
}
