import * as THREE from 'three';
import { RIFT_PORTAL_SPEC } from './content/index.ts';
import { type ActionBus, createActionBus } from './core/action-bus.ts';
import { createSeededStreams, resolveSeed } from './core/prng.ts';
import { createGameStateMachine, type GameStateMachine } from './core/state.ts';
import { createDesktopShell, type DesktopShell } from './desktop/bootstrap.ts';
import { createDesktopControls, type DesktopControls } from './desktop/controls.ts';
import {
  createOcclusionController,
  type OcclusionController,
  type OcclusionSurface,
  type PortalAperture,
} from './mr/occlusion.ts';
import { createRoomSurfaceModel, type RoomSurface, type RoomSurfaceModel } from './mr/room-scan.ts';
import { createShadowCatcherManager, type ShadowCatcherManager } from './mr/shadow-catchers.ts';
import { createVirtualRoomSurfaces } from './mr/virtual-room.ts';
import { buildNavigationGraph, type RoomNavigationGraph } from './nav/graph.ts';
import { createPerfHud, type PerfHud } from './perf/hud.ts';
import { createPerfRecorder, type PerfRecorder } from './perf/recorder.ts';
import { createPersistStore, type PersistStore } from './persist/store.ts';
import { type BlockoutRenderer, createBlockoutRenderer } from './render/blockouts.ts';
import {
  createDomSettingsPanel,
  createXrSettingsPanel,
  type DomSettingsPanel,
  type XrSettingsPanel,
} from './settings/panel.ts';
import {
  createLocalStorageAdapter,
  createSettingsStore,
  type SettingsStorageAdapter,
  type SettingsStore,
} from './settings/store.ts';
import {
  type CombatSimulation,
  createCombatSimulation,
  type DebugJumpToWaveOptions,
  type DebugSpawnEnemyOptions,
  type EnemyId,
  HARD_TURRET_CAP,
  type SimEnemy,
  type WaveDefinition,
} from './sim/engine.ts';
import { createMissionOverlay, type MissionOverlay } from './ui/mission-overlay.ts';
import { createTacticalHud, type TacticalHud } from './ui/tactical-hud.ts';
import { createThreatChevrons, type ThreatChevrons } from './ui/threat-chevrons.ts';
import { createVersionWatcher, type VersionWatcher } from './ui/version-check.ts';
import { createVersionNotice, type VersionNotice } from './ui/version-notice.ts';
import {
  type CalibrationController,
  type CalibrationPreview,
  createCalibrationController,
  createCalibrationPreview,
  extractHeadsetPoseFromObject,
  type PortalAnchor,
} from './xr/calibration.ts';
import { createTurretPlacementController, type TurretPlacementController } from './xr/placement.ts';
import { createXrRadialControls, type XrRadialControls } from './xr/radial-controls.ts';

export const APP_NAME = 'Rift Bastion';

export interface AppRuntime {
  readonly shell: DesktopShell;
  readonly bus: ActionBus;
  readonly state: GameStateMachine;
  readonly settings: SettingsStore;
  readonly domSettings: DomSettingsPanel;
  readonly xrSettings: XrSettingsPanel;
  readonly perfRecorder: PerfRecorder;
  readonly perfHud: PerfHud;
  readonly versionNotice: VersionNotice;
  readonly versionWatcher: VersionWatcher;
  readonly roomModel: RoomSurfaceModel;
  readonly occlusion: OcclusionController;
  readonly shadowCatchers: ShadowCatcherManager;
  readonly calibration: CalibrationController;
  readonly calibrationPreview: CalibrationPreview;
  readonly placement: TurretPlacementController;
  readonly radialControls: XrRadialControls;
  readonly tacticalHud: TacticalHud;
  readonly desktopControls: DesktopControls;
  readonly blockouts: BlockoutRenderer;
  readonly threatChevrons: ThreatChevrons;
  readonly missionOverlay: MissionOverlay;
  readonly persist: PersistStore;
  readonly sim: CombatSimulation;
  readonly nav: RoomNavigationGraph;
  readonly seed: number;
  readonly debugEnabled: boolean;
  debugJumpToWave(waveNumber: number, options?: DebugJumpToWaveOptions): WaveDefinition;
  debugGrantCredits(amount: number): number;
  debugSpawnBoss(options?: DebugSpawnEnemyOptions): SimEnemy;
  debugSpawnEnemy(enemyId: EnemyId, options?: DebugSpawnEnemyOptions): SimEnemy;
  dispose(): void;
}

declare global {
  interface Window {
    __riftBastionApp?: AppRuntime;
  }
}

function toOcclusionSurfaces(surfaces: readonly RoomSurface[]): OcclusionSurface[] {
  return surfaces.map((s) => ({
    id: s.id,
    kind: s.kind,
    source: s.source,
    revision: s.revision,
    worldMatrix: s.worldMatrix,
    normal: s.normal,
    polygon: s.localPolygon,
    ...(s.meshVertices ? { vertices: s.meshVertices } : {}),
    ...(s.meshIndices ? { indices: s.meshIndices } : {}),
    bounds: s.bounds,
  }));
}

function toPortalApertures(portals: readonly PortalAnchor[]): PortalAperture[] {
  const defaultRadius =
    Math.max(RIFT_PORTAL_SPEC.apertureWidthM, RIFT_PORTAL_SPEC.apertureHeightM) * 0.5;
  return portals.map((p) => ({
    id: p.id,
    center: new THREE.Vector3(p.position.x, p.position.y, p.position.z),
    normal: new THREE.Vector3(p.normal.x, p.normal.y, p.normal.z),
    radius: Math.max(p.width, p.height) * 0.5 || defaultRadius,
    ...(p.surfaceId ? { hostSurfaceId: p.surfaceId } : {}),
    hostKind: p.hostKind === 'virtual-rift' ? 'other' : p.hostKind,
  }));
}

export function mountApp(container: HTMLElement): AppRuntime {
  const search = typeof location === 'undefined' ? '' : location.search;
  const searchParams = new URLSearchParams(search);
  const debugEnabled = searchParams.has('debug');
  const seed = resolveSeed(search);
  createSeededStreams(seed);

  const bus = createActionBus();
  const state = createGameStateMachine();

  // IndexedDB persistence + synchronous localStorage mirror for instant page-reload parity
  const persist = createPersistStore();
  const idbSettingsAdapter = persist.createSettingsAdapter();
  const localSettingsAdapter = createLocalStorageAdapter();
  const settingsAdapter: SettingsStorageAdapter = {
    read: () => localSettingsAdapter.read() ?? idbSettingsAdapter.read(),
    write: (envelope) => {
      localSettingsAdapter.write(envelope);
      idbSettingsAdapter.write(envelope);
    },
    remove: () => {
      localSettingsAdapter.remove();
      idbSettingsAdapter.remove();
    },
    readAsync: async () => {
      const local = localSettingsAdapter.read();
      if (local) {
        await idbSettingsAdapter.writeAsync(local);
        return local;
      }
      const fromIdb = await idbSettingsAdapter.readAsync();
      if (fromIdb) {
        localSettingsAdapter.write(fromIdb);
      }
      return fromIdb;
    },
    writeAsync: async (envelope) => {
      localSettingsAdapter.write(envelope);
      await idbSettingsAdapter.writeAsync(envelope);
    },
  };

  const settings = createSettingsStore({ search, adapter: settingsAdapter });
  void persist
    .init()
    .then(() => settings.hydrateFromAdapter())
    .catch(() => undefined);

  const initial = settings.get();

  const xrHudRoot = new THREE.Group();
  xrHudRoot.name = 'rift-bastion-xr-hud';
  xrHudRoot.position.set(0, 1.35, -1.25);

  const shell = createDesktopShell({
    container,
    bus,
    search,
    xr: {
      framebufferScale: initial.framebufferScale,
      foveation: initial.fixedFoveation,
    },
  });
  shell.scene.add(xrHudRoot);

  // Hide static bootstrap placeholder core crystal so BlockoutRenderer's Core Bastion owns the pedestal
  const placeholderCore = shell.room.getObjectByName('core-placeholder');
  if (placeholderCore) {
    placeholderCore.visible = false;
  }

  const buildId =
    typeof window !== 'undefined' && typeof window.__APP_BUILD === 'string'
      ? window.__APP_BUILD
      : typeof __APP_BUILD === 'string'
        ? __APP_BUILD
        : 'dev';

  const perfRecorder = createPerfRecorder({ build: buildId });
  const perfHud = createPerfHud(perfRecorder, settings, {
    container,
    initialMode: 'desktop',
  });
  perfHud.xrRoot.position.set(0.55, 0.25, 0);
  xrHudRoot.add(perfHud.xrRoot);

  const domSettings = createDomSettingsPanel(settings, { container });
  const xrSettings = createXrSettingsPanel(settings);
  xrSettings.root.position.set(0, 0, 0);
  xrHudRoot.add(xrSettings.root);

  const versionNotice = createVersionNotice({
    getSession: () => shell.xr.session,
    hasUnsavedState: () => state.phase === 'wave',
    xrHud: {
      attach: (root) => {
        root.position.set(0, 0.36, 0);
        xrHudRoot.add(root);
      },
      detach: (root) => {
        xrHudRoot.remove(root);
      },
    },
  });
  const versionWatcher = createVersionWatcher({
    currentBuildId: buildId,
    search,
    onChange: (id) => versionNotice.update(id),
  });
  versionWatcher.start();

  // --- Room Scan Model, Layered MR Occlusion & Shadow Catchers ---
  const roomModel = createRoomSurfaceModel({
    initialMode: 'virtual-fallback',
    autoFallbackOnUnavailable: true,
    virtualSurfacesProvider: createVirtualRoomSurfaces,
  });

  const occlusion = createOcclusionController({
    initialMode: initial.roomOcclusion,
  });
  shell.scene.add(occlusion.root);

  const shadowCatchers = createShadowCatcherManager();
  shell.scene.add(shadowCatchers.root);

  const syncRoomGeometryToMr = (surfaces: readonly RoomSurface[]): void => {
    const occSurfaces = toOcclusionSurfaces(surfaces);
    occlusion.syncRoomSurfaces(occSurfaces);
    shadowCatchers.sync(occSurfaces);
  };
  syncRoomGeometryToMr(roomModel.surfaces);

  const unsubRoomModel = roomModel.subscribe((snap) => {
    syncRoomGeometryToMr(snap.surfaces);
  });

  // --- Pre-Mission Core Anchor Calibration + Preview ---
  const calibrationPreview = createCalibrationPreview();
  shell.scene.add(calibrationPreview.group);

  const initialHeadsetPose = extractHeadsetPoseFromObject(shell.camera);
  const calibration = createCalibrationController({
    roomModel,
    settingsStore: settings,
    actionBus: bus,
    gameState: state,
    initialHeadsetPose,
    preview: calibrationPreview,
  });
  calibrationPreview.setVisible(false);

  // --- Navigation Graph & Deterministic 60 Hz Combat Simulation ---
  let currentNavGraph: RoomNavigationGraph = buildNavigationGraph({
    roomModel,
    coreAnchor: calibration.coreAnchor,
    portalAnchors: calibration.portalAnchors,
  });
  occlusion.setPortals(toPortalApertures(calibration.portalAnchors));

  let currentSim: CombatSimulation = createCombatSimulation({
    seed,
    navGraph: currentNavGraph,
    surfaces: roomModel.surfaces,
    coreAnchor: calibration.coreAnchor,
    portalAnchors: calibration.portalAnchors,
  });

  // --- Blockout Renderer, Turret Placement, Radial Menu, HUD, Chevrons & Mission Overlay ---
  const blockouts = createBlockoutRenderer(shell.scene, occlusion);

  const placement = createTurretPlacementController({
    roomModel,
    scene: shell.scene,
    coreAnchor: () => calibration.coreAnchor,
    portalAnchors: () => calibration.portalAnchors,
    actionBus: bus,
    getCredits: () => currentSim.getState().credits,
  });
  // BlockoutRenderer renders the articulated tier-specific turrets; keep placement records for ray picking
  placement.placedTurretsGroup.visible = false;

  const radialControls = createXrRadialControls({
    scene: shell.scene,
    actionBus: bus,
    placement,
    getBuildState: () => {
      const simState = currentSim.getState();
      return {
        credits: simState.credits,
        activeTurretCount: simState.turrets.length,
        hardTurretCap: HARD_TURRET_CAP,
        canLaunchWave: state.phase === 'prep' || state.phase === 'intermission',
        phase: state.phase,
      };
    },
    isBusy: () => xrSettings.visible || state.phase === 'calibrate',
  });

  const tacticalHud = createTacticalHud({
    actionBus: bus,
    container,
    initialMode: 'desktop',
    initialVisible: false,
    getHeadsetPose: () =>
      extractHeadsetPoseFromObject(
        shell.xr.presenting ? shell.renderer.xr.getCamera() : shell.camera,
      ),
    initialState: {
      phase: state.phase,
      coreHp: currentSim.getState().coreHp,
      coreMaxHp: currentSim.getState().maxCoreHp,
      credits: currentSim.getState().credits,
      wave: currentSim.getState().currentWave,
      totalWaves: currentSim.getState().totalWaves,
      activeTurrets: 0,
      maxTurrets: HARD_TURRET_CAP,
      playArc: calibration.playArc,
      canLockCore: calibration.isValid,
      canLaunchWave: true,
      selectedTurretKind: placement.selectedKind,
      mountMode: placement.mountMode,
    },
  });
  shell.scene.add(tacticalHud.xrRoot);

  const threatChevrons = createThreatChevrons({
    container,
    initialMode: 'desktop',
    initialVisible: true,
  });
  shell.scene.add(threatChevrons.xrRoot);

  const missionOverlay = createMissionOverlay({
    persistStore: persist,
    actionBus: bus,
    settingsStore: settings,
    container,
    initialMode: 'desktop',
  });
  xrHudRoot.add(missionOverlay.xrRoot);

  const desktopControls = createDesktopControls({
    actionBus: bus,
    camera: shell.camera,
    domElement: shell.renderer.domElement,
    gameState: state,
    calibration,
    placement,
    roomModel,
    isSettingsOpen: () => domSettings.open,
    getPlayArc: () => calibration.playArc,
    enabled: false,
  });

  let isSyncingTurretAction = false;
  let desktopPlaying = false;

  const syncTacticalHud = (): void => {
    const simState = currentSim.getState();
    const showHud = state.phase !== 'title' || shell.xr.presenting;
    tacticalHud.setVisible(showHud);
    tacticalHud.updateState({
      phase: state.phase,
      coreHp: simState.coreHp,
      coreMaxHp: simState.maxCoreHp,
      credits: simState.credits,
      wave: simState.currentWave,
      totalWaves: simState.totalWaves,
      activeTurrets: simState.turrets.length,
      maxTurrets: HARD_TURRET_CAP,
      playArc: calibration.playArc,
      canLockCore: calibration.isValid,
      canLaunchWave: state.phase === 'prep' || state.phase === 'intermission',
      selectedTurretKind: placement.selectedKind,
      mountMode: placement.mountMode,
    });
  };

  const initializeMissionFromCalibration = (): void => {
    isSyncingTurretAction = true;
    try {
      for (const existing of [...placement.placedTurrets]) {
        placement.removeTurret(existing.id);
      }
    } finally {
      isSyncingTurretAction = false;
    }

    currentNavGraph = buildNavigationGraph({
      roomModel,
      coreAnchor: calibration.coreAnchor,
      portalAnchors: calibration.portalAnchors,
    });
    occlusion.setPortals(toPortalApertures(calibration.portalAnchors));
    syncRoomGeometryToMr(roomModel.surfaces);

    currentSim = createCombatSimulation({
      seed,
      navGraph: currentNavGraph,
      surfaces: roomModel.surfaces,
      coreAnchor: calibration.coreAnchor,
      portalAnchors: calibration.portalAnchors,
    });

    placement.setCoreAnchor(calibration.coreAnchor);
    placement.setPortalAnchors(calibration.portalAnchors);
    placement.cancelPlacement();
    missionOverlay.hide();
    threatChevrons.clear();
    blockouts.syncFromSim(currentSim.getState(), currentSim.drainEvents(), 0);
    syncTacticalHud();
  };

  // Initialize initial blockouts so the Core Bastion and portals are ready immediately
  blockouts.syncFromSim(currentSim.getState(), currentSim.drainEvents(), 0);

  const unsubCalibration = calibration.subscribe(() => {
    occlusion.setPortals(toPortalApertures(calibration.portalAnchors));
    if (state.phase === 'calibrate' || state.phase === 'title') {
      currentNavGraph = buildNavigationGraph({
        roomModel,
        coreAnchor: calibration.coreAnchor,
        portalAnchors: calibration.portalAnchors,
      });
      currentSim.setNavigationGraph(currentNavGraph);
      blockouts.syncFromSim(currentSim.getState(), [], 0);
    }
    syncTacticalHud();
  });

  const syncXrStatus = (): void => {
    const xrState = shell.xr.state;
    const status = {
      inSession: xrState.presenting,
      appliedFramebufferScale: xrState.appliedFramebufferScale,
      reportedFoveation: xrState.presenting ? xrState.foveation : null,
    };
    domSettings.setXrStatus(status);
    xrSettings.setXrStatus(status);
  };

  let detachRadialSession: (() => void) | null = null;
  let wasPresenting = shell.xr.state.presenting;
  const unsubXr = shell.xr.subscribe((xrState) => {
    syncXrStatus();
    if (xrState.presenting !== wasPresenting) {
      wasPresenting = xrState.presenting;
      if (xrState.presenting) {
        perfRecorder.onXrSessionStart();
        perfHud.setMode('xr');
        tacticalHud.setMode('xr');
        threatChevrons.setMode('xr');
        missionOverlay.setMode('xr');
        domSettings.hide();
        desktopControls.setEnabled(false);

        if (shell.xr.session) {
          roomModel.setSession(shell.xr.session);
          detachRadialSession?.();
          detachRadialSession = radialControls.attachSession(shell.xr.session);
        }

        if (state.phase === 'title') {
          state.transition('calibrate', 'xr-enter');
          const xrPose = extractHeadsetPoseFromObject(shell.renderer.xr.getCamera());
          calibration.beginCalibration(xrPose);
          tacticalHud.recenterToHeadset(xrPose);
        }
      } else {
        detachRadialSession?.();
        detachRadialSession = null;
        radialControls.reset();
        roomModel.setSession(null);
        occlusion.resetDepth();

        perfRecorder.onXrSessionEnd();
        perfHud.setMode('desktop');
        tacticalHud.setMode('desktop');
        threatChevrons.setMode('desktop');
        missionOverlay.setMode('desktop');
        xrSettings.hide();

        if (!desktopPlaying && state.phase === 'calibrate') {
          state.transition('title', 'xr-exit-to-launch');
          calibrationPreview.setVisible(false);
        }
        desktopControls.setEnabled(desktopPlaying && state.phase !== 'title');
      }
      syncTacticalHud();
      versionNotice.refresh();
    }
  });

  const unsubSettings = settings.subscribe((next) => {
    shell.xr.setFoveation(next.fixedFoveation);
    shell.xr.setFramebufferScale(next.framebufferScale);
    occlusion.setMode(next.roomOcclusion);
    syncXrStatus();
  });

  const unsubState = state.subscribe((change) => {
    versionNotice.refresh();
    if (change.to === 'calibrate') {
      missionOverlay.hide();
      threatChevrons.clear();
      placement.cancelPlacement();
      calibrationPreview.setVisible(true);
      desktopControls.setEnabled(!shell.xr.presenting);
    } else if (change.from === 'calibrate' && change.to === 'prep') {
      calibrationPreview.setVisible(false);
      initializeMissionFromCalibration();
      desktopControls.setEnabled(!shell.xr.presenting);
    } else if (change.to === 'victory' || change.to === 'defeat') {
      placement.cancelPlacement();
      void missionOverlay.presentFromSim(currentSim.getState());
    } else if (change.to === 'title') {
      calibrationPreview.setVisible(false);
      missionOverlay.hide();
      threatChevrons.clear();
      desktopControls.setEnabled(false);
    }
    syncTacticalHud();
  });

  const unsubBus = [
    bus.on('menu/open-settings', () => {
      if (shell.xr.presenting) xrSettings.toggle();
      else domSettings.toggle();
    }),
    bus.on('menu/close-settings', () => {
      domSettings.hide();
      xrSettings.hide();
    }),
    bus.on('menu/play-desktop', () => {
      desktopPlaying = true;
      if (state.phase === 'title') {
        state.transition('calibrate', 'menu/play-desktop');
        const pose = extractHeadsetPoseFromObject(shell.camera);
        calibration.beginCalibration(pose);
      }
      desktopControls.setEnabled(!shell.xr.presenting);
      syncTacticalHud();
    }),
    bus.on('turret/build', (action) => {
      if (isSyncingTurretAction) return;
      isSyncingTurretAction = true;
      try {
        // Match against a record just placed by TurretPlacementController, or create one if dispatched directly
        const simTurretIds = new Set(currentSim.getState().turrets.map((t) => t.id));
        let matched = placement.placedTurrets.find((t) => !simTurretIds.has(t.id));
        if (!matched) {
          matched =
            placement.placeTurret(
              {
                kind: action.kind,
                position: action.position,
                ...(action.surfaceId ? { surfaceId: action.surfaceId } : {}),
              },
              'system',
            ) ?? undefined;
        }

        const simRes = currentSim.placeTurret({
          ...(matched ? { id: matched.id } : {}),
          kind: action.kind,
          position: matched?.position ?? action.position,
          mountProfile: matched?.mountProfile ?? (action.surfaceId ? 'surface-clamp' : 'hover-pod'),
          ...(matched?.normal ? { normal: matched.normal } : {}),
          ...((action.surfaceId ?? matched?.surfaceId)
            ? { surfaceId: action.surfaceId ?? matched?.surfaceId }
            : {}),
          ...(matched?.surfaceKind ? { surfaceKind: matched.surfaceKind } : {}),
        });

        if (!simRes.ok && matched) {
          placement.removeTurret(matched.id);
        }
      } finally {
        isSyncingTurretAction = false;
      }
      blockouts.syncFromSim(currentSim.getState(), currentSim.drainEvents(), 0);
      syncTacticalHud();
    }),
    bus.on('turret/upgrade', (action) => {
      if (isSyncingTurretAction) return;
      const res = currentSim.upgradeTurret(action.turretId);
      if (res.ok && res.turret) {
        const rec = placement.getTurret(action.turretId);
        if (rec) {
          rec.tier = res.turret.tier;
          rec.investedCredits = res.turret.investedCredits;
        }
      }
      blockouts.syncFromSim(currentSim.getState(), currentSim.drainEvents(), 0);
      syncTacticalHud();
    }),
    bus.on('turret/relocate', (action) => {
      if (isSyncingTurretAction) return;
      isSyncingTurretAction = true;
      try {
        let rec = placement.getTurret(action.turretId);
        if (
          rec &&
          Math.hypot(
            rec.position.x - action.position.x,
            rec.position.y - action.position.y,
            rec.position.z - action.position.z,
          ) > 1e-4
        ) {
          rec =
            placement.relocateTurret(
              action.turretId,
              {
                position: action.position,
                ...(action.surfaceId ? { surfaceId: action.surfaceId } : {}),
              },
              'system',
            ) ?? rec;
        }
        currentSim.relocateTurret({
          turretId: action.turretId,
          position: rec?.position ?? action.position,
          ...(rec?.mountProfile ? { mountProfile: rec.mountProfile } : {}),
          ...(rec?.normal ? { normal: rec.normal } : {}),
          ...((action.surfaceId ?? rec?.surfaceId)
            ? { surfaceId: action.surfaceId ?? rec?.surfaceId }
            : {}),
          ...(rec?.surfaceKind ? { surfaceKind: rec.surfaceKind } : {}),
        });
      } finally {
        isSyncingTurretAction = false;
      }
      blockouts.syncFromSim(currentSim.getState(), currentSim.drainEvents(), 0);
      syncTacticalHud();
    }),
    bus.on('turret/sell', (action) => {
      if (isSyncingTurretAction) return;
      isSyncingTurretAction = true;
      try {
        currentSim.sellTurret(action.turretId);
        if (placement.getTurret(action.turretId)) {
          placement.removeTurret(action.turretId);
        }
      } finally {
        isSyncingTurretAction = false;
      }
      blockouts.syncFromSim(currentSim.getState(), currentSim.drainEvents(), 0);
      syncTacticalHud();
    }),
    bus.on('turret/set-priority', (action) => {
      currentSim.setTurretPriority(action.turretId, action.priority);
      const rec = placement.getTurret(action.turretId);
      if (rec) {
        rec.priority = action.priority;
      }
      syncTacticalHud();
    }),
    bus.on('wave/launch', () => {
      if (state.phase === 'calibrate') {
        calibration.confirmLockCore();
      }
      const res = currentSim.launchWave();
      if (res.ok && state.phase !== 'wave' && state.can('wave')) {
        state.transition('wave', 'wave/launch');
      }
      blockouts.syncFromSim(currentSim.getState(), currentSim.drainEvents(), 0);
      syncTacticalHud();
    }),
  ];

  const onVisibility = (): void => {
    perfRecorder.onVisibilityChange(!document.hidden);
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  const unsubFrame = shell.onFrame((dt, timeMs, frame) => {
    const cur = settings.get();
    const xrState = shell.xr.state;
    const mode = xrState.presenting ? 'xr' : 'desktop';
    const activeCamera: THREE.Camera = xrState.presenting
      ? shell.renderer.xr.getCamera()
      : shell.camera;

    // 1. Ingest XR spatial surfaces, depth-sensing, radial menu, and controller placement
    if (frame && shell.xr.reference) {
      const hasLivePlanes =
        ((frame.detectedPlanes as Set<XRPlane> | undefined)?.size ?? 0) > 0 ||
        ((frame.detectedMeshes as Set<XRMesh> | undefined)?.size ?? 0) > 0;
      if (hasLivePlanes && roomModel.usingVirtualFallback) {
        roomModel.deactivateVirtualFallback();
      }
      roomModel.updateFromFrame(frame, shell.xr.reference, { nowMs: timeMs });
      occlusion.updateFromXrFrame(frame, shell.xr.reference);
      occlusion.bindCamera(
        activeCamera,
        shell.renderer.xr.getCamera() as unknown as { cameras?: readonly THREE.Camera[] },
      );

      radialControls.update(
        frame,
        shell.xr.reference,
        timeMs,
        xrSettings.visible || missionOverlay.visible,
      );

      if (
        !radialControls.shouldSuppressWorldTrigger() &&
        (state.phase === 'prep' || state.phase === 'wave' || state.phase === 'intermission')
      ) {
        placement.updateFromXrFrame(frame, shell.xr.reference, dt);
      }
    }

    // 2. Step deterministic 60 Hz combat simulation & sync visuals
    if (state.phase === 'prep' || state.phase === 'wave' || state.phase === 'intermission') {
      const stepRes = currentSim.step(dt);
      const simState = stepRes.state;
      const events = currentSim.drainEvents();

      if (simState.phase !== state.phase && state.can(simState.phase)) {
        state.transition(simState.phase, 'sim-step');
      }

      blockouts.syncFromSim(simState, events, dt);
      threatChevrons.update({
        snapshot: simState,
        events,
        dt,
        camera: activeCamera,
      });

      if (simState.phase === 'victory' || simState.phase === 'defeat') {
        void missionOverlay.presentFromSim(simState);
      }
      syncTacticalHud();
    } else if (state.phase === 'calibrate') {
      blockouts.syncFromSim(currentSim.getState(), [], dt);
    }

    // 3. Record 1-second monotonic performance buckets
    const info = shell.renderer.info.render;
    perfRecorder.recordFrame(
      timeMs,
      {
        mode,
        phase: state.phase,
        requestedHz: mode === 'xr' ? xrState.targetFrameRate : 60,
        reportedHz: mode === 'xr' ? xrState.negotiatedFrameRate : null,
        qualityTier: cur.qualityTier,
        framebufferScale: xrState.appliedFramebufferScale ?? cur.framebufferScale,
        fixedFoveation: mode === 'xr' ? xrState.foveation : null,
      },
      info.calls,
      info.triangles,
    );
    perfHud.update(timeMs);
  });

  syncXrStatus();

  const assertDebugFlag = (): void => {
    if (!debugEnabled) {
      throw new Error('Debug shortcuts require the ?debug URL flag.');
    }
  };

  const ensureActiveCombatPhaseForDebug = (): void => {
    if (state.phase === 'title') {
      desktopPlaying = true;
      state.transition('calibrate', 'debug');
    }
    if (state.phase === 'calibrate') {
      calibration.confirmLockCore();
    }
  };

  let disposed = false;
  const runtime: AppRuntime = {
    shell,
    bus,
    state,
    settings,
    domSettings,
    xrSettings,
    perfRecorder,
    perfHud,
    versionNotice,
    versionWatcher,
    roomModel,
    occlusion,
    shadowCatchers,
    calibration,
    calibrationPreview,
    placement,
    radialControls,
    tacticalHud,
    desktopControls,
    blockouts,
    threatChevrons,
    missionOverlay,
    persist,
    get sim() {
      return currentSim;
    },
    get nav() {
      return currentNavGraph;
    },
    seed,
    debugEnabled,
    debugJumpToWave(waveNumber, options) {
      assertDebugFlag();
      ensureActiveCombatPhaseForDebug();
      const waveDef = currentSim.debugJumpToWave(waveNumber, options);
      const simState = currentSim.getState();
      if (simState.phase !== state.phase && state.can(simState.phase)) {
        state.transition(simState.phase, 'debugJumpToWave');
      }
      blockouts.syncFromSim(simState, currentSim.drainEvents(), 0);
      syncTacticalHud();
      return waveDef;
    },
    debugGrantCredits(amount) {
      assertDebugFlag();
      const nextCredits = currentSim.debugGrantCredits(amount);
      syncTacticalHud();
      return nextCredits;
    },
    debugSpawnBoss(options) {
      assertDebugFlag();
      ensureActiveCombatPhaseForDebug();
      const boss = currentSim.debugSpawnBoss(options);
      const simState = currentSim.getState();
      blockouts.syncFromSim(simState, currentSim.drainEvents(), 0);
      syncTacticalHud();
      return boss;
    },
    debugSpawnEnemy(enemyId, options) {
      assertDebugFlag();
      ensureActiveCombatPhaseForDebug();
      const enemy = currentSim.debugSpawnEnemy(enemyId, options);
      const simState = currentSim.getState();
      blockouts.syncFromSim(simState, currentSim.drainEvents(), 0);
      syncTacticalHud();
      return enemy;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubFrame();
      unsubXr();
      unsubSettings();
      unsubState();
      unsubRoomModel();
      unsubCalibration();
      detachRadialSession?.();
      detachRadialSession = null;
      for (const fn of unsubBus) fn();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      desktopControls.dispose();
      missionOverlay.dispose();
      threatChevrons.dispose();
      tacticalHud.dispose();
      radialControls.dispose();
      placement.dispose();
      blockouts.dispose();
      calibrationPreview.dispose();
      calibration.dispose();
      shadowCatchers.dispose();
      occlusion.dispose();
      versionWatcher.dispose();
      versionNotice.dispose();
      domSettings.dispose();
      xrSettings.dispose();
      perfHud.dispose();
      perfRecorder.dispose();
      persist.close();
      shell.dispose();
    },
  };

  if (typeof window !== 'undefined') {
    window.__riftBastionApp = runtime;
  }
  return runtime;
}

if (typeof document !== 'undefined') {
  const root = document.getElementById('app');
  if (root) {
    mountApp(root);
  }
}
