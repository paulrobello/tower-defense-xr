import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import {
  calculateStarRating,
  computeMissionStars,
  createIndexedDbSettingsAdapter,
  createPersistStore,
  DEFAULT_MISSION_RECORDS,
  DEFAULT_SETTINGS,
  MAX_RECENT_RUNS,
  PERSIST_DB_NAME,
  PERSIST_SCHEMA_VERSION,
  PersistValidationError,
  type UserSettings,
} from '../src/persist/store';
import { createSettingsStore } from '../src/settings/store';

function createIsolatedIdb(): IDBFactory {
  return new IDBFactory();
}

describe('persist/store (IndexedDB persistence & JSON backup)', () => {
  it('computes 0, 1, 2, and 3 star ratings from victory status and remaining Core HP %', () => {
    // Defeat or 0 HP remaining -> 0 stars regardless of HP
    expect(calculateStarRating({ victory: false, remainingCoreHp: 100, maxCoreHp: 100 })).toBe(0);
    expect(calculateStarRating({ victory: false, remainingCoreHp: 60, maxCoreHp: 100 })).toBe(0);
    expect(calculateStarRating({ victory: true, remainingCoreHp: 0, maxCoreHp: 100 })).toBe(0);
    expect(calculateStarRating({ victory: true, remainingCoreHp: -10, maxCoreHp: 100 })).toBe(0);

    // 1 star: mission clear with < 60% Core HP
    expect(calculateStarRating({ victory: true, remainingCoreHp: 1, maxCoreHp: 100 })).toBe(1);
    expect(calculateStarRating({ victory: true, remainingCoreHp: 35, maxCoreHp: 100 })).toBe(1);
    expect(calculateStarRating({ victory: true, remainingCoreHp: 59.9, maxCoreHp: 100 })).toBe(1);

    // 2 stars: mission clear with >= 60% and < 90% Core HP
    expect(calculateStarRating({ victory: true, remainingCoreHp: 60, maxCoreHp: 100 })).toBe(2);
    expect(calculateStarRating({ victory: true, remainingCoreHp: 75, maxCoreHp: 100 })).toBe(2);
    expect(calculateStarRating({ victory: true, remainingCoreHp: 89.9, maxCoreHp: 100 })).toBe(2);

    // 3 stars: mission clear with >= 90% Core HP
    expect(calculateStarRating({ victory: true, remainingCoreHp: 90, maxCoreHp: 100 })).toBe(3);
    expect(calculateStarRating({ victory: true, remainingCoreHp: 100, maxCoreHp: 100 })).toBe(3);

    // Supports normalized ratios (0..1) and custom maxCoreHp via positional overload
    expect(computeMissionStars(0.25, true)).toBe(1);
    expect(computeMissionStars(0.6, true)).toBe(2);
    expect(computeMissionStars(0.9, true)).toBe(3);
    expect(computeMissionStars(0.95, false)).toBe(0);
    expect(computeMissionStars(450, 500, true)).toBe(3);
    expect(computeMissionStars(300, 500, true)).toBe(2);
    expect(computeMissionStars(299, 500, true)).toBe(1);
  });

  it('reads and writes settings and missionRecords across store instances in IndexedDB', async () => {
    const idbFactory = createIsolatedIdb();
    const storeA = createPersistStore({ idbFactory });
    expect(storeA.dbName).toBe(PERSIST_DB_NAME);
    expect(storeA.schemaVersion).toBe(PERSIST_SCHEMA_VERSION);

    expect(await storeA.loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await storeA.loadMissionRecords()).toEqual(DEFAULT_MISSION_RECORDS);
    expect(storeA.getBackendMode()).toBe('indexeddb');
    expect(storeA.isFallbackMode()).toBe(false);

    const updatedSettings = await storeA.saveSettings({
      showFps: true,
      fixedFoveation: 1,
      framebufferScale: 1.2,
      playArc: 'full-360',
      roomOcclusion: 'room-mesh',
      qualityTier: 'balanced',
      masterVolume: 0.8,
      musicVolume: 0.5,
      sfxVolume: 0.9,
    });
    expect(updatedSettings.playArc).toBe('full-360');
    expect(updatedSettings.framebufferScale).toBe(1.2);

    // Record a defeat run followed by a 2-star victory and a 3-star victory
    await storeA.recordMissionRun({
      score: 4200,
      waveCleared: 7,
      victory: false,
      remainingCoreHp: 0,
      maxCoreHp: 100,
      timestamp: 1_700_000_001_000,
      durationMs: 410_000,
      seed: 101,
    });

    await storeA.recordMissionRun({
      score: 12_500,
      waveCleared: 12,
      victory: true,
      remainingCoreHp: 68,
      maxCoreHp: 100,
      timestamp: 1_700_000_002_000,
      durationMs: 720_000,
      seed: 202,
    });

    await storeA.recordMissionRun({
      score: 11_900,
      waveCleared: 12,
      victory: true,
      remainingCoreHp: 94,
      maxCoreHp: 100,
      timestamp: 1_700_000_003_000,
      durationMs: 695_000,
      seed: 303,
    });

    storeA.close();

    // Reopen against the same IndexedDB instance and verify durability
    const storeB = createPersistStore({ idbFactory });
    const persistedSettings = await storeB.loadSettings();
    expect(persistedSettings).toEqual(updatedSettings);

    const records = await storeB.loadMissionRecords();
    expect(records.bestScore).toBe(12_500);
    expect(records.highestWaveCleared).toBe(12);
    expect(records.bestStars).toBe(3);
    expect(records.totalRuns).toBe(3);
    expect(records.victories).toBe(2);
    expect(records.recentRuns).toHaveLength(3);
    expect(records.recentRuns[0]?.stars).toBe(3);
    expect(records.recentRuns[0]?.seed).toBe(303);
    expect(records.recentRuns[1]?.stars).toBe(2);
    expect(records.recentRuns[2]?.stars).toBe(0);

    storeB.close();
  });

  it('caps recentRuns at the 20 most recent runs while accumulating lifetime totals', async () => {
    const idbFactory = createIsolatedIdb();
    const store = createPersistStore({ idbFactory });

    for (let i = 1; i <= 26; i += 1) {
      const victory = i % 2 === 0;
      await store.recordMissionRun({
        score: i * 1000,
        waveCleared: victory ? 12 : Math.min(11, i % 12),
        victory,
        remainingCoreHp: victory ? (i === 26 ? 95 : 65) : 0,
        maxCoreHp: 100,
        timestamp: 1_700_000_000_000 + i * 1000,
        seed: i,
      });
    }

    const records = await store.loadMissionRecords();
    expect(records.totalRuns).toBe(26);
    expect(records.victories).toBe(13);
    expect(records.bestScore).toBe(26_000);
    expect(records.highestWaveCleared).toBe(12);
    expect(records.bestStars).toBe(3);
    expect(records.recentRuns).toHaveLength(MAX_RECENT_RUNS);
    // Most recent run (#26) is first; oldest retained run is #7 (runs #1..#6 evicted)
    expect(records.recentRuns[0]?.score).toBe(26_000);
    expect(records.recentRuns[0]?.seed).toBe(26);
    expect(records.recentRuns[MAX_RECENT_RUNS - 1]?.score).toBe(7_000);
    expect(records.recentRuns[MAX_RECENT_RUNS - 1]?.seed).toBe(7);

    store.close();
  });

  it('executes schema migration runner hooks when upgrading database versions', async () => {
    const idbFactory = createIsolatedIdb();
    const initialHook = vi.fn(({ settings, missionRecords }) => ({
      settings,
      missionRecords,
    }));

    // Initialize v1 DB and store data
    const storeV1 = createPersistStore({
      idbFactory,
      schemaVersion: 1,
      migrationHook: initialHook,
    });
    await storeV1.saveSettings({ playArc: 'full-360', musicVolume: 0.45 });
    await storeV1.recordMissionRun({
      score: 9800,
      waveCleared: 12,
      victory: true,
      remainingCoreHp: 62,
      maxCoreHp: 100,
      timestamp: 1_700_100_000_000,
    });
    expect(initialHook).toHaveBeenCalledTimes(1);
    expect(initialHook).toHaveBeenCalledWith(
      expect.objectContaining({ fromVersion: 0, toVersion: 1 }),
    );
    storeV1.close();

    // Re-opening at v1 does not re-run migration
    const reopenHook = vi.fn(({ settings, missionRecords }) => ({
      settings,
      missionRecords,
    }));
    const storeV1Again = createPersistStore({
      idbFactory,
      schemaVersion: 1,
      migrationHook: reopenHook,
    });
    await storeV1Again.init();
    expect(reopenHook).not.toHaveBeenCalled();
    storeV1Again.close();

    // Open at schemaVersion 2 with a migration hook that upgrades data
    const upgradeHook = vi.fn(({ fromVersion, toVersion, settings, missionRecords }) => ({
      settings: {
        ...settings,
        qualityTier: 'high-fps' as const,
      },
      missionRecords: {
        ...missionRecords,
        bestScore: missionRecords.bestScore + 200,
      },
      fromVersion,
      toVersion,
    }));

    const storeV2 = createPersistStore({
      idbFactory,
      schemaVersion: 2,
      migrationHook: upgradeHook,
    });
    const migratedSettings = await storeV2.loadSettings();
    const migratedRecords = await storeV2.loadMissionRecords();

    expect(upgradeHook).toHaveBeenCalledTimes(1);
    expect(upgradeHook).toHaveBeenCalledWith(
      expect.objectContaining({
        fromVersion: 1,
        toVersion: 2,
      }),
    );
    expect(migratedSettings.playArc).toBe('full-360');
    expect(migratedSettings.qualityTier).toBe('high-fps');
    expect(migratedRecords.bestScore).toBe(10_000);
    expect(migratedRecords.bestStars).toBe(2);

    storeV2.close();
  });

  it('integrates cleanly with SettingsStore via IndexedDbSettingsAdapter', async () => {
    const idbFactory = createIsolatedIdb();
    const persistA = createPersistStore({ idbFactory });
    const adapterA = createIndexedDbSettingsAdapter(persistA);

    const settingsStoreA = createSettingsStore({
      adapter: adapterA,
      search: '',
    });

    settingsStoreA.update({
      showFps: true,
      fixedFoveation: 1,
      framebufferScale: 1.1,
      playArc: 'full-360',
      roomOcclusion: 'off',
      qualityTier: 'high-fps',
      masterVolume: 0.65,
    });
    await adapterA.flush();
    persistA.close();

    // Second session hydrates SettingsStore from IndexedDB while preserving URL overrides
    const persistB = createPersistStore({ idbFactory });
    const adapterB = persistB.createSettingsAdapter();
    const settingsStoreB = createSettingsStore({
      adapter: adapterB,
      search: '?quality=balanced',
    });

    await settingsStoreB.hydrateFromAdapter();
    expect(settingsStoreB.getPersisted().playArc).toBe('full-360');
    expect(settingsStoreB.getPersisted().roomOcclusion).toBe('off');
    expect(settingsStoreB.getPersisted().framebufferScale).toBe(1.1);
    expect(settingsStoreB.getPersisted().masterVolume).toBe(0.65);
    expect(settingsStoreB.getPersisted().qualityTier).toBe('high-fps');
    // URL override remains active for get() without clobbering persisted qualityTier
    expect(settingsStoreB.get().qualityTier).toBe('balanced');

    persistB.close();
  });

  it('round-trips exportBackupJson and importBackupJson accurately', async () => {
    const idbA = createIsolatedIdb();
    const storeA = createPersistStore({ idbFactory: idbA, now: () => 1_700_500_000_000 });

    await storeA.saveSettings({
      showFps: true,
      fixedFoveation: 0,
      framebufferScale: 1.2,
      playArc: 'full-360',
      roomOcclusion: 'room-mesh',
      showRoomMesh: true,
      qualityTier: 'max-beauty',
      masterVolume: 0.9,
      musicVolume: 0.6,
      sfxVolume: 0.8,
    });

    await storeA.recordMissionRun({
      score: 18_450,
      waveCleared: 12,
      victory: true,
      remainingCoreHp: 92,
      maxCoreHp: 100,
      timestamp: 1_700_499_000_000,
      durationMs: 780_000,
      seed: 777,
    });

    const backupJson = await storeA.exportBackupJson();
    const expectedSettings = await storeA.loadSettings();
    const expectedRecords = await storeA.loadMissionRecords();
    storeA.close();

    // Import into a brand-new database
    const idbB = createIsolatedIdb();
    const storeB = createPersistStore({ idbFactory: idbB });
    const imported = await storeB.importBackupJson(backupJson);

    expect(imported.app).toBe('rift-bastion');
    expect(imported.schemaVersion).toBe(PERSIST_SCHEMA_VERSION);
    expect(await storeB.loadSettings()).toEqual(expectedSettings);
    expect(await storeB.loadMissionRecords()).toEqual(expectedRecords);

    const legacyBackup = JSON.parse(backupJson);
    delete legacyBackup.settings.showRoomMesh;
    await storeB.importBackupJson(JSON.stringify(legacyBackup));
    expect(await storeB.loadSettings()).toEqual({ ...expectedSettings, showRoomMesh: false });

    storeB.close();
  });

  it('rejects corrupt, wrong-type, out-of-bounds, future-version, or spatial-data JSON without mutating existing records', async () => {
    const idbFactory = createIsolatedIdb();
    const store = createPersistStore({ idbFactory });

    const goodSettings = await store.saveSettings({
      playArc: 'full-360',
      masterVolume: 0.75,
    });
    const goodRecords = await store.recordMissionRun({
      score: 14_000,
      waveCleared: 12,
      victory: true,
      remainingCoreHp: 95,
      maxCoreHp: 100,
      timestamp: 1_700_200_000_000,
    });

    const validBackup = JSON.parse(await store.exportBackupJson()) as Record<string, unknown>;

    const invalidPayloads: string[] = [
      // Empty or truncated JSON
      '',
      '{"app":"rift-bastion","schemaVersion":1,"settings":',
      // Future schema version
      JSON.stringify({ ...validBackup, schemaVersion: 99 }),
      // Invalid schema version (0)
      JSON.stringify({ ...validBackup, schemaVersion: 0 }),
      // Wrong setting type
      JSON.stringify({
        ...validBackup,
        settings: { ...(validBackup.settings as object), showFps: 'yes' },
      }),
      // Out-of-bounds volume (> 1)
      JSON.stringify({
        ...validBackup,
        settings: { ...(validBackup.settings as object), masterVolume: 1.5 },
      }),
      // Out-of-bounds wave (> 12)
      JSON.stringify({
        ...validBackup,
        missionRecords: { ...(validBackup.missionRecords as object), highestWaveCleared: 99 },
      }),
      // Invalid star rating (4)
      JSON.stringify({
        ...validBackup,
        missionRecords: { ...(validBackup.missionRecords as object), bestStars: 4 },
      }),
      // Negative bestScore
      JSON.stringify({
        ...validBackup,
        missionRecords: { ...(validBackup.missionRecords as object), bestScore: -100 },
      }),
      // More victories than totalRuns
      JSON.stringify({
        ...validBackup,
        missionRecords: {
          ...(validBackup.missionRecords as object),
          totalRuns: 2,
          victories: 5,
        },
      }),
      // Forbidden spatial room mesh / camera data inside backup
      JSON.stringify({
        ...validBackup,
        missionRecords: {
          ...(validBackup.missionRecords as object),
          roomMeshes: [{ vertices: [0, 1, 2] }],
        },
      }),
    ];

    for (const badRaw of invalidPayloads) {
      await expect(store.importBackupJson(badRaw)).rejects.toThrow(PersistValidationError);
    }

    // Also verify direct write methods reject forbidden spatial data
    await expect(
      store.saveSettings({
        ...DEFAULT_SETTINGS,
        roomMesh: { vertices: [] },
      } as unknown as UserSettings),
    ).rejects.toThrow(PersistValidationError);

    // Existing good data remains completely intact in IndexedDB
    expect(await store.loadSettings()).toEqual(goodSettings);
    expect(await store.loadMissionRecords()).toEqual(goodRecords);

    store.close();
  });

  it('falls back gracefully to in-memory persistence when IndexedDB is unavailable', async () => {
    const store = createPersistStore({ idbFactory: null });
    await store.init();
    expect(store.getBackendMode()).toBe('memory-fallback');
    expect(store.isFallbackMode()).toBe(true);

    await store.saveSettings({ showFps: true, qualityTier: 'high-fps' });
    await store.recordMissionRun({
      score: 8500,
      waveCleared: 12,
      victory: true,
      remainingCoreHp: 72,
      maxCoreHp: 100,
      timestamp: 1_700_300_000_000,
    });

    expect((await store.loadSettings()).showFps).toBe(true);
    expect((await store.loadMissionRecords()).bestStars).toBe(2);

    const exported = await store.exportBackupJson();
    await store.clearMissionRecords();
    expect((await store.loadMissionRecords()).totalRuns).toBe(0);

    await store.importBackupJson(exported);
    expect((await store.loadMissionRecords()).bestScore).toBe(8500);
    expect((await store.loadMissionRecords()).bestStars).toBe(2);
  });
});
