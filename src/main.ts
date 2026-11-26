import { OVERLAY_RENDER_ORDER } from '@par/xr-workspace';
import * as THREE from 'three';
import { createSpatialAudioEngine, type SpatialAudioEngine } from './audio/engine.ts';
import { readRecordedGameCue } from './audio/recorded-game-sfx.ts';
import { GAMEPLAY_OBJECT_SCALE, RIFT_PORTAL_SPEC } from './content/index.ts';
import { type ActionBus, createActionBus } from './core/action-bus.ts';
import { createSeededStreams, resolveSeed } from './core/prng.ts';
import { createGameStateMachine, type GameStateMachine } from './core/state.ts';
import {
  applyRoomPbrMaterials,
  createDesktopShell,
  type DesktopShell,
} from './desktop/bootstrap.ts';
import { createDesktopCommandStrip } from './desktop/command-strip.ts';
import { createDesktopControls, type DesktopControls } from './desktop/controls.ts';
import { createRoomMeshFlightTest } from './mr/flight-collision.ts';
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
import { createRuntimeAssetLibrary, type RuntimeAssetLibrary } from './render/asset-loader.ts';
import { type BlockoutRenderer, createBlockoutRenderer } from './render/blockouts.ts';
import { createLightingController, type LightingController } from './render/lighting.ts';
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
import { createTacticalAtlas } from './ui/tactical-atlas.ts';
import { createTacticalHud, type TacticalHud } from './ui/tactical-hud.ts';
import { createThreatChevrons, type ThreatChevrons } from './ui/threat-chevrons.ts';
import { createTurretInspector, type TurretInspector } from './ui/turret-inspector.ts';
import { createVersionWatcher, type VersionWatcher } from './ui/version-check.ts';
import { createVersionNotice, type VersionNotice } from './ui/version-notice.ts';
import {
  type CalibrationController,
  type CalibrationPreview,
  createCalibrationController,
  createCalibrationPreview,
  extractHeadsetPoseFromObject,
  type HeadsetPose,
  isCoreSupportSurface,
  type PortalAnchor,
  yawFromForward,
} from './xr/calibration.ts';
import { createTurretPlacementController, type TurretPlacementController } from './xr/placement.ts';
import {
  createXrRadialControls,
  turretKindFromRadialAction,
  type XrRadialControls,
} from './xr/radial-controls.ts';

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
  readonly turretInspector: TurretInspector;
  readonly desktopControls: DesktopControls;
  readonly assets: RuntimeAssetLibrary;
  readonly lighting: LightingController;
  readonly audio: SpatialAudioEngine;
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
    ...(s.meshWorldMatrix ? { meshWorldMatrix: s.meshWorldMatrix } : {}),
    ...(s.meshIndices ? { indices: s.meshIndices } : {}),
    bounds: s.bounds,
  }));
}

function toPortalApertures(portals: readonly PortalAnchor[]): PortalAperture[] {
  const defaultRx = RIFT_PORTAL_SPEC.apertureWidthM * 0.5;
  const defaultRy = RIFT_PORTAL_SPEC.apertureHeightM * 0.5;
  return portals.map((p) => {
    const radiusX = (p.width > 0 ? p.width * 0.5 : defaultRx) * GAMEPLAY_OBJECT_SCALE;
    const radiusY = (p.height > 0 ? p.height * 0.5 : defaultRy) * GAMEPLAY_OBJECT_SCALE;
    return {
      id: p.id,
      center: new THREE.Vector3(p.position.x, p.position.y, p.position.z),
      normal: new THREE.Vector3(p.normal.x, p.normal.y, p.normal.z),
      radius: Math.max(radiusX, radiusY),
      radiusX,
      radiusY,
      ...(p.surfaceId ? { hostSurfaceId: p.surfaceId } : {}),
      hostKind: p.hostKind === 'virtual-rift' ? 'other' : p.hostKind,
    };
  });
}

function portalAnchorSignature(portals: readonly PortalAnchor[]): string {
  return portals
    .map(
      (p) =>
        `${p.id}:${p.surfaceId ?? ''}:${p.position.x.toFixed(3)},${p.position.y.toFixed(3)},${p.position.z.toFixed(3)}:${p.normal.x.toFixed(3)},${p.normal.y.toFixed(3)},${p.normal.z.toFixed(3)}`,
    )
    .join('|');
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
  shell.xrOverlayRoot.add(xrHudRoot);

  // Hide static bootstrap placeholder core crystal so Core Bastion GLB owns the pedestal
  const placeholderCore = shell.room.getObjectByName('core-placeholder');
  if (placeholderCore) {
    placeholderCore.visible = false;
  }

  // Upgrade bootstrap lights to AAA tactical lighting + transient explosion point-light pool
  const bootstrapLights = shell.scene.getObjectByName('scene-lights');
  if (bootstrapLights) {
    shell.scene.remove(bootstrapLights);
  }
  const lighting = createLightingController(shell.scene, shell.renderer);

  // Runtime AAA GLB/KTX2 asset library + shader precompilation behind load veil
  const assets = createRuntimeAssetLibrary({ renderer: shell.renderer });
  const tacticalAtlas = createTacticalAtlas();
  const audio = createSpatialAudioEngine({
    recordedCueBytes: readRecordedGameCue,
    previewMusic: true,
    initialVolumes: {
      masterVolume: initial.masterVolume,
      sfxVolume: initial.sfxVolume,
      musicVolume: initial.musicVolume,
    },
  });

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
    renderOrder: OVERLAY_RENDER_ORDER + 10,
  });
  shell.xrOverlayRoot.add(perfHud.xrRoot);
  const perfCloseButton = perfHud.gauge.root.getObjectByName('perf-gauge-close');
  const perfHudPanel = perfCloseButton
    ? {
        root: perfCloseButton,
        cellAt: () => 'close',
        activate: () => {
          perfHud.activate(perfCloseButton);
          return true;
        },
      }
    : null;

  const domSettings = createDomSettingsPanel(settings, { container });
  const xrSettings = createXrSettingsPanel(settings, {
    renderOrder: OVERLAY_RENDER_ORDER + 20,
    onClose: () => bus.dispatch({ type: 'menu/close-settings' }, 'xr'),
  });
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
  occlusion.setRoomMeshDebugVisible(initial.showRoomMesh);
  shell.scene.add(occlusion.root);

  const shadowCatchers = createShadowCatcherManager();
  shell.scene.add(shadowCatchers.root);

  const syncRoomOccluders = (surfaces: readonly OcclusionSurface[]): void => {
    const useVirtualRoom = !shell.xr.presenting || roomModel.usingVirtualFallback;
    occlusion.syncRoomSurfaces(
      surfaces.filter(
        (surface) =>
          (surface.kind !== 'other' || (surface.vertices && surface.indices)) &&
          (surface.source === 'virtual') === useVirtualRoom,
      ),
    );
  };

  const syncRoomGeometryToMr = (surfaces: readonly RoomSurface[]): void => {
    const occlusionSurfaces = toOcclusionSurfaces(surfaces);
    syncRoomOccluders(occlusionSurfaces);
    shadowCatchers.sync(occlusionSurfaces);
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
    pickCoreSupport: (origin, direction) =>
      placement.raycastSurface(origin, direction, isCoreSupportSurface),
  });
  calibrationPreview.setVisible(false);

  // --- Navigation Graph & Deterministic 60 Hz Combat Simulation ---
  let currentNavGraph: RoomNavigationGraph = buildNavigationGraph({
    roomModel,
    coreAnchor: calibration.coreAnchor,
    portalAnchors: calibration.portalAnchors,
  });
  let syncedPortalSignature = portalAnchorSignature(calibration.portalAnchors);
  occlusion.setPortals(toPortalApertures(calibration.portalAnchors));

  let currentSim: CombatSimulation = createCombatSimulation({
    seed,
    navGraph: currentNavGraph,
    surfaces: roomModel.surfaces,
    coreAnchor: calibration.coreAnchor,
    portalAnchors: calibration.portalAnchors,
  });

  // --- AAA Renderer, Turret Placement, Radial Menu, HUD, Chevrons & Mission Overlay ---
  const blockouts = createBlockoutRenderer(shell.scene, occlusion, { assets, lighting });

  let syncedAssetsReady = false;
  const unsubAssets = assets.subscribe((prog) => {
    if (prog.total > 0 && !prog.ready) {
      shell.overlay.setLoadStatus?.(`Loading AAA assets (${prog.loaded}/${prog.total})…`);
    } else if (prog.ready && !prog.precompiled) {
      shell.overlay.setLoadStatus?.('Precompiling shaders…');
    } else {
      shell.overlay.setLoadStatus?.(null);
    }
    if (prog.ready && !syncedAssetsReady) {
      syncedAssetsReady = true;
      applyRoomPbrMaterials(shell.room, assets);
      if (assets.manifest?.sfx) {
        audio.registerManifestCues(assets.manifest.sfx);
      }
      blockouts.syncFromSim(currentSim.getState(), [], 0, shell.camera);
    }
  });
  void assets
    .loadAll()
    .then((ok) => {
      if (ok) return assets.precompile(shell.renderer, shell.scene, shell.camera);
      return undefined;
    })
    .catch(() => undefined);

  const placement = createTurretPlacementController({
    roomModel,
    scene: shell.scene,
    rayOverlayRoot: shell.xrOverlayRoot,
    assets,
    coreAnchor: () => calibration.coreAnchor,
    portalAnchors: () => calibration.portalAnchors,
    actionBus: bus,
    getCredits: () => currentSim.getState().credits,
    initialActive: false,
    onPlacementRejected: (_reason, pos) => {
      audio.play('invalid-placement', { position: pos });
    },
  });
  // BlockoutRenderer renders the articulated tier-specific turrets; keep placement records for ray picking
  placement.placedTurretsGroup.visible = false;

  let selectedXrTurretId: string | null = null;
  const turretInspector = createTurretInspector({
    container,
    renderOrder: OVERLAY_RENDER_ORDER + 12,
    onClose: () => {
      selectedXrTurretId = null;
      if (!shell.xr.presenting) desktopControls.setSelectedTurret(null);
      syncTacticalHud();
    },
    onSell: (turret) => {
      if (selectedXrTurretId === turret.id) selectedXrTurretId = null;
      bus.dispatch(
        { type: 'turret/sell', turretId: turret.id },
        shell.xr.presenting ? 'xr' : 'desktop',
      );
    },
  });
  shell.scene.add(turretInspector.rangeRoot);
  xrHudRoot.add(turretInspector.xrRoot);
  const turretInspectorPanel = {
    root: turretInspector.xrRoot,
    cellAt: turretInspector.panel.cellAt,
    setHovered: turretInspector.panel.setHovered,
    activate: turretInspector.panel.activate,
  };

  const radialControls = createXrRadialControls({
    scene: shell.scene,
    overlayRoot: shell.xrOverlayRoot,
    actionBus: bus,
    placement,
    atlas: tacticalAtlas,
    renderOrder: OVERLAY_RENDER_ORDER + 30,
    onActionDispatched: () => {
      audio.play('radial-tick');
    },
    onCancel: () => {
      selectedXrTurretId = null;
      placement.cancelPlacement();
      syncTacticalHud();
    },
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
    isBusy: () =>
      xrSettings.visible || turretInspector.xrRoot.visible || state.phase === 'calibrate',
    getMovableWidgets: () => [
      xrSettings.visible
        ? xrSettings.root
        : turretInspector.xrRoot.visible
          ? turretInspector.xrRoot
          : tacticalHud.xrRoot,
      perfHud.xrRoot,
    ],
    getPanels: () => {
      let mainPanel = tacticalHudPanel;
      if (turretInspector.xrRoot.visible) mainPanel = turretInspectorPanel;
      if (missionOverlay.visible) mainPanel = missionOverlayPanel;
      if (xrSettings.visible) mainPanel = xrSettings;
      return perfHudPanel && perfHud.xrRoot.visible ? [mainPanel, perfHudPanel] : [mainPanel];
    },
  });

  const tacticalHud = createTacticalHud({
    actionBus: bus,
    atlas: tacticalAtlas,
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
  shell.xrOverlayRoot.add(tacticalHud.xrRoot);
  const recenterAuxiliaryWidgets = (): void => {
    const { position, quaternion } = tacticalHud.xrRoot;
    xrHudRoot.position.copy(position);
    xrHudRoot.position.y += 0.18;
    xrHudRoot.quaternion.copy(quaternion);
    xrSettings.root.position.set(0, 0, 0);
    xrSettings.root.quaternion.identity();
    turretInspector.xrRoot.position.set(0, 0, 0);
    turretInspector.xrRoot.quaternion.identity();
    perfHud.xrRoot.position.set(0.55, 0.25, 0).applyQuaternion(quaternion).add(position);
    perfHud.xrRoot.quaternion.copy(quaternion);
  };
  const tacticalHudPanel = {
    root: tacticalHud.xrRoot,
    cellAt: tacticalHud.cellAt,
    setHovered: tacticalHud.setHovered,
    activate: tacticalHud.activate,
  };

  const threatChevrons = createThreatChevrons({
    container,
    initialMode: 'desktop',
    initialVisible: true,
    renderOrder: OVERLAY_RENDER_ORDER + 50,
  });
  shell.xrOverlayRoot.add(threatChevrons.xrRoot);

  const missionOverlay = createMissionOverlay({
    persistStore: persist,
    actionBus: bus,
    settingsStore: settings,
    atlas: tacticalAtlas,
    container,
    initialMode: 'desktop',
    renderOrder: OVERLAY_RENDER_ORDER + 20,
    onReplay: () => {
      audio.play('mission-confirm');
    },
  });
  xrHudRoot.add(missionOverlay.xrRoot);
  const missionOverlayPanel = {
    root: missionOverlay.xrRoot,
    cellAt: missionOverlay.cellAt,
    setHovered: missionOverlay.setHovered,
    activate: missionOverlay.activate,
  };

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
    onTurretSelected: () => syncTacticalHud(),
    onBuildKindSelected: () => syncTacticalHud(),
  });

  const commandStrip = createDesktopCommandStrip(container, tacticalAtlas, (actionId) => {
    audio.play('radial-tick');
    const kind = turretKindFromRadialAction(actionId);
    if (kind) {
      desktopControls.selectTurretKind(kind);
      syncTacticalHud();
      return;
    }
    if (actionId === 'wave:launch') {
      bus.dispatch({ type: 'wave/launch' }, 'desktop');
      return;
    }
    if (
      actionId === 'turret:upgrade' ||
      actionId === 'turret:priority' ||
      actionId === 'turret:relocate' ||
      actionId === 'turret:sell'
    ) {
      desktopControls.issueTurretCommand(actionId);
      syncTacticalHud();
    }
  });

  let isSyncingTurretAction = false;
  let desktopPlaying = false;

  const syncTacticalHud = (): void => {
    const simState = currentSim.getState();
    const inXr = shell.xr.presenting;
    const canInspect =
      state.phase === 'prep' || state.phase === 'wave' || state.phase === 'intermission';
    const inspectorId =
      canInspect && !xrSettings.visible && !domSettings.open && !missionOverlay.visible
        ? inXr
          ? selectedXrTurretId
          : desktopControls.state.selectedTurretId
        : null;
    turretInspector.setTurret(inspectorId ? (currentSim.getTurret(inspectorId) ?? null) : null);

    const showHud = inXr
      ? !xrSettings.visible && !missionOverlay.visible && !turretInspector.xrRoot.visible
      : state.phase !== 'title';
    tacticalHud.setVisible(showHud);
    tacticalHud.updateState({
      phase: state.phase,
      coreHp: simState.coreHp,
      coreMaxHp: simState.maxCoreHp,
      credits: simState.credits,
      wave: simState.currentWave,
      totalWaves: simState.totalWaves,
      enemiesRemaining: simState.pendingWaveSpawns + simState.enemies.length,
      activeTurrets: simState.turrets.length,
      maxTurrets: HARD_TURRET_CAP,
      playArc: calibration.playArc,
      canLockCore: calibration.isValid,
      canLaunchWave: state.phase === 'prep' || state.phase === 'intermission',
      selectedTurretKind: placement.selectedKind,
      mountMode: placement.mountMode,
      disruptedTurretCount: simState.turrets.filter((t) => t.disabledRemainingSec > 0).length,
    });

    const showStrip =
      !shell.xr.presenting &&
      desktopPlaying &&
      !domSettings.open &&
      !missionOverlay.visible &&
      (state.phase === 'prep' || state.phase === 'wave' || state.phase === 'intermission');
    if (showStrip) {
      const selectedId = desktopControls.state.selectedTurretId;
      const selectedRec = selectedId ? placement.getTurret(selectedId) : null;
      commandStrip.update(
        {
          credits: simState.credits,
          activeTurretCount: simState.turrets.length,
          hardTurretCap: HARD_TURRET_CAP,
          canLaunchWave: state.phase === 'prep' || state.phase === 'intermission',
          phase: state.phase,
        },
        selectedRec
          ? {
              id: selectedRec.id,
              kind: selectedRec.kind,
              tier: selectedRec.tier,
              priority: selectedRec.priority,
            }
          : null,
        placement.state.active ? placement.selectedKind : null,
      );
    } else {
      commandStrip.hide();
    }
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

    const aerialSpanBlocked = createRoomMeshFlightTest(roomModel.surfaces);
    currentNavGraph = buildNavigationGraph({
      roomModel,
      ...(aerialSpanBlocked ? { aerialSpanBlocked } : {}),
      coreAnchor: calibration.coreAnchor,
      portalAnchors: calibration.portalAnchors,
    });
    syncedPortalSignature = portalAnchorSignature(calibration.portalAnchors);
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
    const nextSignature = portalAnchorSignature(calibration.portalAnchors);
    if (nextSignature !== syncedPortalSignature) {
      syncedPortalSignature = nextSignature;
      occlusion.setPortals(toPortalApertures(calibration.portalAnchors));
    }
    syncTacticalHud();
  });

  const syncXrStatus = (): void => {
    const xrState = shell.xr.state;
    const status = {
      inSession: xrState.presenting,
      appliedFramebufferScale: xrState.appliedFramebufferScale,
      reportedFoveation: xrState.presenting ? xrState.foveation : null,
      roomOcclusion: occlusion.state,
    };
    domSettings.setXrStatus(status);
    xrSettings.setXrStatus(status);
  };

  const unsubOcclusion = occlusion.subscribe(syncXrStatus);

  let detachRadialSession: (() => void) | null = null;
  let pendingXrCalibrationPose = false;
  let wasPresenting = shell.xr.state.presenting;
  const unsubXr = shell.xr.subscribe((xrState) => {
    syncXrStatus();
    if (xrState.presenting !== wasPresenting) {
      wasPresenting = xrState.presenting;
      if (xrState.presenting) {
        void audio.unlock();
        perfRecorder.onXrSessionStart();
        perfHud.setMode('xr');
        tacticalHud.setMode('xr');
        turretInspector.setMode('xr');
        threatChevrons.setMode('xr');
        missionOverlay.setMode('xr');
        domSettings.hide();
        desktopControls.setEnabled(false);

        if (shell.xr.session) {
          roomModel.setSession(shell.xr.session);
          syncRoomOccluders(toOcclusionSurfaces(roomModel.surfaces));
          detachRadialSession?.();
          detachRadialSession = radialControls.attachSession(shell.xr.session, (start) => {
            const reference = shell.xr.reference;
            if (!reference || !start.inputSource.gamepad || start.inputSource.hand) return null;
            const phaseAtPress = state.phase;
            if (phaseAtPress === 'calibrate') {
              return (event) => {
                if (state.phase !== 'calibrate') return;
                const pose = event.frame.getPose(event.inputSource.targetRaySpace, reference);
                if (!pose) return;
                const { position, orientation } = pose.transform;
                const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(
                  new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.w),
                );
                calibration.moveCoreByRay(position, direction);
              };
            }
            if (
              phaseAtPress !== 'prep' &&
              phaseAtPress !== 'wave' &&
              phaseAtPress !== 'intermission'
            ) {
              return null;
            }

            const pickTurret = (event: XRInputSourceEvent): string | null => {
              const pose = event.frame.getPose(event.inputSource.targetRaySpace, reference);
              if (!pose) return null;
              const { position, orientation } = pose.transform;
              const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(
                new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.w),
              );
              return placement.pickPlacedTurret(position, direction)?.id ?? null;
            };
            const turretId = pickTurret(start);
            if (turretId) {
              return (event) => {
                if (state.phase !== phaseAtPress || pickTurret(event) !== turretId) return;
                placement.cancelPlacement();
                selectedXrTurretId = turretId;
                syncTacticalHud();
              };
            }
            if (!placement.active) return null;
            return (event) => {
              if (state.phase !== phaseAtPress) return;
              placement.confirmXrPlacement(event.frame, reference, event.inputSource);
            };
          });
        }

        pendingXrCalibrationPose = true;
        if (state.phase === 'title') {
          state.transition('calibrate', 'xr-enter');
          const xrPose = extractHeadsetPoseFromObject(shell.renderer.xr.getCamera());
          calibration.beginCalibration(xrPose);
          tacticalHud.recenterToHeadset(xrPose);
        }
      } else {
        pendingXrCalibrationPose = false;
        detachRadialSession?.();
        detachRadialSession = null;
        radialControls.reset();
        roomModel.setSession(null);
        occlusion.resetDepth();
        syncRoomOccluders(toOcclusionSurfaces(roomModel.surfaces));

        perfRecorder.onXrSessionEnd();
        perfHud.setMode('desktop');
        tacticalHud.setMode('desktop');
        selectedXrTurretId = null;
        turretInspector.setMode('desktop');
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

  const unsubSettings = settings.subscribe((next, previous) => {
    shell.xr.setFoveation(next.fixedFoveation);
    shell.xr.setFramebufferScale(next.framebufferScale);
    audio.setVolumes({
      masterVolume: next.masterVolume,
      sfxVolume: next.sfxVolume,
      musicVolume: next.musicVolume,
    });
    if (next.roomOcclusion !== previous.roomOcclusion) {
      occlusion.setMode(next.roomOcclusion);
    }
    if (next.showRoomMesh !== previous.showRoomMesh) {
      occlusion.setRoomMeshDebugVisible(next.showRoomMesh);
    }
    syncXrStatus();
  });

  const unsubState = state.subscribe((change) => {
    versionNotice.refresh();
    if (change.to === 'calibrate') {
      selectedXrTurretId = null;
      desktopControls.setSelectedTurret(null);
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
      audio.syncOpenPortals([]);
      audio.play('mission-confirm');
      void missionOverlay.presentFromSim(currentSim.getState());
    } else if (change.to === 'title') {
      audio.syncOpenPortals([]);
      calibrationPreview.setVisible(false);
      missionOverlay.hide();
      threatChevrons.clear();
      desktopControls.setEnabled(false);
    }
    syncTacticalHud();
  });

  const unsubBus = [
    bus.on('view/recenter', () => {
      if (shell.xr.presenting) recenterAuxiliaryWidgets();
    }),
    bus.on('menu/open-settings', () => {
      if (shell.xr.presenting) {
        xrSettings.toggle();
        syncTacticalHud();
      } else domSettings.toggle();
    }),
    bus.on('menu/close-settings', () => {
      domSettings.hide();
      xrSettings.hide();
      syncTacticalHud();
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
          audio.play('invalid-placement', { position: action.position });
        }
      } finally {
        isSyncingTurretAction = false;
      }
      const buildState = currentSim.getState();
      const buildEvents = currentSim.drainEvents();
      blockouts.syncFromSim(buildState, buildEvents, 0);
      audio.processSimEvents(buildEvents, buildState);
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
      const upgradeState = currentSim.getState();
      const upgradeEvents = currentSim.drainEvents();
      blockouts.syncFromSim(upgradeState, upgradeEvents, 0);
      audio.processSimEvents(upgradeEvents, upgradeState);
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
      const relocState = currentSim.getState();
      const relocEvents = currentSim.drainEvents();
      blockouts.syncFromSim(relocState, relocEvents, 0);
      audio.processSimEvents(relocEvents, relocState);
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
      const sellState = currentSim.getState();
      const sellEvents = currentSim.drainEvents();
      blockouts.syncFromSim(sellState, sellEvents, 0);
      audio.processSimEvents(sellEvents, sellState);
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
      if (state.phase !== 'prep' && state.phase !== 'intermission') return;
      const res = currentSim.launchWave();
      if (res.ok && state.can('wave')) {
        state.transition('wave', 'wave/launch');
      }
      const waveState = currentSim.getState();
      const waveEvents = currentSim.drainEvents();
      blockouts.syncFromSim(waveState, waveEvents, 0);
      audio.processSimEvents(waveEvents, waveState);
      syncTacticalHud();
    }),
  ];

  const onVisibility = (): void => {
    const isVisible = !document.hidden;
    perfRecorder.onVisibilityChange(isVisible);
    audio.setVisibility(isVisible);
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

    // 1. Ingest XR spatial surfaces, radial menu, and controller placement
    if (frame && shell.xr.reference) {
      if (pendingXrCalibrationPose) {
        const viewerPose = frame.getViewerPose(shell.xr.reference);
        if (viewerPose) {
          pendingXrCalibrationPose = false;
          const t = viewerPose.transform;
          const q = new THREE.Quaternion(
            t.orientation.x,
            t.orientation.y,
            t.orientation.z,
            t.orientation.w,
          );
          const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
          const liveXrPose: HeadsetPose = {
            position: { x: t.position.x, y: t.position.y, z: t.position.z },
            yaw: yawFromForward({ x: fwd.x, y: fwd.y, z: fwd.z }),
          };
          if (state.phase === 'calibrate') calibration.beginCalibration(liveXrPose);
          tacticalHud.recenterToHeadset(liveXrPose);
          recenterAuxiliaryWidgets();
          syncTacticalHud();
        }
      }

      radialControls.update(
        frame,
        shell.xr.reference,
        timeMs,
        xrSettings.visible || missionOverlay.visible || turretInspector.xrRoot.visible,
      );

      roomModel.updateFromFrame(frame, shell.xr.reference, { nowMs: timeMs, resumeLiveScan: true });
      const xrRenderer = shell.renderer.xr;
      const gpuDepth =
        frame.session.enabledFeatures?.includes('depth-sensing') &&
        frame.session.depthUsage === 'gpu-optimized';
      if (gpuDepth) {
        // The app's per-material pass owns room depth, including portal apertures.
        const automaticDepthMesh = xrRenderer.getDepthSensingMesh();
        if (automaticDepthMesh) automaticDepthMesh.visible = false;
      }
      occlusion.updateFromXrFrame(frame, shell.xr.reference, {
        glBinding: gpuDepth ? xrRenderer.getBinding() : null,
      });

      if (state.phase === 'prep' || state.phase === 'wave' || state.phase === 'intermission') {
        placement.updateFromXrFrame(
          frame,
          shell.xr.reference,
          dt,
          radialControls.shouldSuppressWorldTrigger,
        );
      }
    }

    // 2. Step deterministic 60 Hz combat simulation & sync visuals + 3D spatial audio
    lighting.update(dt);
    audio.updateListener(activeCamera);
    if (state.phase === 'prep' || state.phase === 'wave' || state.phase === 'intermission') {
      const stepRes = currentSim.step(dt);
      const simState = stepRes.state;
      const events = currentSim.drainEvents();

      if (simState.phase !== state.phase && state.can(simState.phase)) {
        state.transition(simState.phase, 'sim-step');
      }

      blockouts.syncFromSim(simState, events, dt, activeCamera);
      audio.processSimEvents(events, simState);
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
      blockouts.syncFromSim(
        {
          ...currentSim.getState(),
          corePosition: calibration.coreAnchor.position,
          portals: calibration.portalAnchors.map((portal, portalIndex) => ({
            id: portal.id,
            portalIndex,
            position: portal.position,
            normal: portal.normal,
            hostKind: portal.hostKind,
            isOpen: false,
            openedAtTick: null,
          })),
        },
        [],
        dt,
        activeCamera,
      );
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
    turretInspector,
    desktopControls,
    assets,
    lighting,
    audio,
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
      unsubOcclusion();
      unsubCalibration();
      unsubAssets();
      detachRadialSession?.();
      detachRadialSession = null;
      for (const fn of unsubBus) fn();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      commandStrip.dispose();
      desktopControls.dispose();
      missionOverlay.dispose();
      threatChevrons.dispose();
      tacticalHud.dispose();
      turretInspector.dispose();
      radialControls.dispose();
      tacticalAtlas.dispose();
      placement.dispose();
      blockouts.dispose();
      audio.dispose();
      assets.dispose();
      lighting.dispose();
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
