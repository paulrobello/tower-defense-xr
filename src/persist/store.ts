import {
  DEFAULT_SETTINGS,
  FIXED_FOVEATION_OPTIONS,
  FRAMEBUFFER_SCALE_OPTIONS,
  PLAY_ARC_OPTIONS,
  parseStoredSettingsEnvelope,
  QUALITY_TIER_OPTIONS,
  ROOM_OCCLUSION_OPTIONS,
  SETTINGS_SCHEMA_VERSION,
  type SettingKey,
  type Settings,
  type SettingsStorageAdapter,
  type StoredSettingsEnvelope,
  validateSettings,
} from '../settings/store';

export {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  type Settings,
  type SettingsStorageAdapter,
  type StoredSettingsEnvelope,
};

/** Alias for `Settings` from `src/settings/store.ts` used by persistence consumers. */
export type UserSettings = Settings;

export const PERSIST_DB_NAME = 'rift-bastion-db' as const;
export const PERSIST_SCHEMA_VERSION = 1 as const;
export const MAX_RECENT_RUNS = 20 as const;
export const MAX_MISSION_WAVE = 12 as const;
export const MAX_SCORE_BOUND = 100_000_000 as const;
export const MAX_RUNS_BOUND = 10_000_000 as const;

export const PERSIST_META_STORE = 'meta' as const;
export const PERSIST_SETTINGS_STORE = 'settings' as const;
export const PERSIST_MISSION_STORE = 'missionRecords' as const;

const RECORD_KEY_CURRENT = 'current' as const;
const META_KEY_SCHEMA = 'schemaVersion' as const;

/**
 * Explicit invariant (`PRD.md` Non-Goals & D12):
 * Raw room meshes, detected planes, depth textures, and camera frames live only for the active
 * session and must NEVER be written to IndexedDB or backup JSON.
 */
export const FORBIDDEN_SPATIAL_KEYS = Object.freeze([
  'roomMesh',
  'roomMeshes',
  'planes',
  'detectedPlanes',
  'detectedMeshes',
  'cameraFrame',
  'cameraFrames',
  'cameraImage',
  'cameraImages',
  'depthTexture',
  'depthData',
  'rawRoomScan',
] as const);

export type StarRating = 0 | 1 | 2 | 3;

export interface StarCalculationInput {
  readonly victory: boolean;
  /**
   * Remaining Core HP at mission end.
   * When `maxCoreHp` is omitted:
   * - values in `(0, 1]` are treated as a normalized ratio (`0..1`)
   * - values in `(1, 100]` are treated as a percentage (`0..100`)
   */
  readonly remainingCoreHp: number;
  /** Maximum Core HP (e.g. `100`). When provided, ratio is `remainingCoreHp / maxCoreHp`. */
  readonly maxCoreHp?: number;
}

export interface MissionRunInput {
  readonly score: number;
  readonly waveCleared: number;
  readonly victory: boolean;
  /**
   * Remaining Core HP at the end of the run (or `0..1` ratio / `0..100` percentage if `maxCoreHp`
   * is omitted).
   */
  readonly remainingCoreHp: number;
  /** Maximum Core HP (defaults to `100` when `remainingCoreHp > 1`, or `1` when `<= 1`). */
  readonly maxCoreHp?: number;
  /** Optional explicit epoch timestamp in ms (defaults to `Date.now()`). */
  readonly timestamp?: number;
  /** Optional run duration in ms. */
  readonly durationMs?: number;
  /** Optional deterministic run seed. */
  readonly seed?: number;
}

export interface MissionRunRecord {
  readonly timestamp: number;
  readonly score: number;
  readonly waveCleared: number;
  readonly victory: boolean;
  readonly stars: StarRating;
  /** Remaining Core HP percentage in `[0, 100]`. */
  readonly remainingCoreHpPct: number;
  readonly remainingCoreHp: number;
  readonly maxCoreHp: number;
  readonly durationMs?: number;
  readonly seed?: number;
}

export interface MissionRecords {
  readonly bestScore: number;
  readonly highestWaveCleared: number;
  readonly bestStars: StarRating;
  readonly totalRuns: number;
  readonly victories: number;
  readonly recentRuns: readonly MissionRunRecord[];
}

export const DEFAULT_MISSION_RECORDS: Readonly<MissionRecords> = Object.freeze({
  bestScore: 0,
  highestWaveCleared: 0,
  bestStars: 0,
  totalRuns: 0,
  victories: 0,
  recentRuns: Object.freeze([]),
});

export interface PersistMigrationContext {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly settings: UserSettings;
  readonly missionRecords: MissionRecords;
}

export interface PersistMigrationResult {
  readonly settings: UserSettings;
  readonly missionRecords: MissionRecords;
}

export type PersistMigrationHook = (
  context: PersistMigrationContext,
) => PersistMigrationResult | Promise<PersistMigrationResult>;

export interface PersistBackupPayload {
  readonly app: 'rift-bastion';
  readonly schemaVersion: number;
  readonly exportedAt: string;
  readonly settings: UserSettings;
  readonly missionRecords: MissionRecords;
}

export type PersistBackendMode = 'indexeddb' | 'memory-fallback';

export interface CreatePersistStoreOptions {
  /** IndexedDB database name (defaults to `'rift-bastion-db'`). */
  readonly dbName?: string;
  /** Target schema version (defaults to `PERSIST_SCHEMA_VERSION = 1`). */
  readonly schemaVersion?: number;
  /**
   * Custom IndexedDB factory (`window.indexedDB` by default).
   * Pass `null` to simulate an environment where IndexedDB is unavailable.
   */
  readonly idbFactory?: IDBFactory | null;
  /**
   * Optional migration runner hook invoked when opening a store whose persisted
   * schema version is lower than `schemaVersion`.
   */
  readonly migrationHook?: PersistMigrationHook;
  /**
   * Optional step-by-step migration map keyed by the target step version (`1..schemaVersion`).
   */
  readonly migrations?: Readonly<Record<number, PersistMigrationHook>>;
  /** Optional clock override for deterministic timestamps in tests. */
  readonly now?: () => number;
}

export interface PersistStore {
  readonly dbName: string;
  readonly schemaVersion: number;
  init(): Promise<void>;
  getBackendMode(): PersistBackendMode;
  isFallbackMode(): boolean;
  loadSettings(): Promise<Readonly<UserSettings>>;
  saveSettings(settings: Partial<UserSettings> | UserSettings): Promise<Readonly<UserSettings>>;
  clearSettings(): Promise<void>;
  loadMissionRecords(): Promise<Readonly<MissionRecords>>;
  saveMissionRecords(records: MissionRecords): Promise<Readonly<MissionRecords>>;
  recordMissionRun(input: MissionRunInput): Promise<Readonly<MissionRecords>>;
  clearMissionRecords(): Promise<void>;
  createSettingsAdapter(): IndexedDbSettingsAdapter;
  exportBackupJson(pretty?: boolean): Promise<string>;
  importBackupJson(raw: string): Promise<PersistBackupPayload>;
  close(): void;
}

export class PersistValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersistValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBinaryOrSpatialBuffer(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  const ctorName = (value as { constructor?: { name?: string } }).constructor?.name;
  return (
    ctorName === 'ImageBitmap' ||
    ctorName === 'VideoFrame' ||
    ctorName === 'HTMLCanvasElement' ||
    ctorName === 'HTMLImageElement' ||
    ctorName === 'XRMesh' ||
    ctorName === 'XRPlane' ||
    ctorName === 'XRCPUDepthInformation' ||
    ctorName === 'XRWebGLDepthInformation'
  );
}

/**
 * Checks whether an arbitrary payload contains forbidden room-scan meshes, planes, depth buffers,
 * or camera frame objects.
 */
export function containsForbiddenSpatialData(
  value: unknown,
  visited = new Set<object>(),
): string | null {
  if (isBinaryOrSpatialBuffer(value)) {
    return 'binary buffer or spatial frame object';
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  if (visited.has(value)) {
    return null;
  }
  visited.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = containsForbiddenSpatialData(item, visited);
      if (found) return found;
    }
    return null;
  }

  for (const [key, entry] of Object.entries(value)) {
    if ((FORBIDDEN_SPATIAL_KEYS as readonly string[]).includes(key)) {
      return key;
    }
    const nested = containsForbiddenSpatialData(entry, visited);
    if (nested) return nested;
  }
  return null;
}

export function assertNoSpatialData(value: unknown, context = 'persistence payload'): void {
  const forbidden = containsForbiddenSpatialData(value);
  if (forbidden !== null) {
    throw new PersistValidationError(
      `Persistence invariant violation in ${context}: forbidden spatial data (${forbidden}). Never store room meshes, planes, or camera frames.`,
    );
  }
}

function normalizeCoreHpPct(remainingCoreHp: number, maxCoreHp?: number): number {
  if (!Number.isFinite(remainingCoreHp) || remainingCoreHp <= 0) {
    return 0;
  }
  if (maxCoreHp !== undefined) {
    if (!Number.isFinite(maxCoreHp) || maxCoreHp <= 0) {
      return 0;
    }
    const pct = (remainingCoreHp / maxCoreHp) * 100;
    return Math.min(100, Math.max(0, Math.round(pct * 100) / 100));
  }
  // When maxCoreHp is omitted, support both normalized ratio (0..1] and percentage (1..100].
  const pct = remainingCoreHp <= 1 ? remainingCoreHp * 100 : remainingCoreHp;
  return Math.min(100, Math.max(0, Math.round(pct * 100) / 100));
}

/**
 * Computes mission star rating (`0 | 1 | 2 | 3`) from mission completion and remaining Core HP %:
 * - `0` stars: mission failed (`victory === false` or `remainingCoreHp <= 0`)
 * - `1` star: mission cleared (`> 0%` Core HP remaining, `< 60%`)
 * - `2` stars: mission cleared with `>= 60%` Core HP remaining (`< 90%`)
 * - `3` stars: mission cleared with `>= 90%` Core HP remaining
 */
export function calculateStarRating(input: StarCalculationInput): StarRating;
export function calculateStarRating(
  remainingCoreHpOrPct: number,
  maxCoreHpOrVictory?: number | boolean,
  victory?: boolean,
): StarRating;
export function calculateStarRating(
  first: StarCalculationInput | number,
  second?: number | boolean,
  third?: boolean,
): StarRating {
  let isVictory = true;
  let remainingCoreHp: number;
  let maxCoreHp: number | undefined;

  if (typeof first === 'object' && first !== null) {
    isVictory = first.victory;
    remainingCoreHp = first.remainingCoreHp;
    maxCoreHp = first.maxCoreHp;
  } else {
    remainingCoreHp = first;
    if (typeof second === 'boolean') {
      isVictory = second;
    } else if (typeof second === 'number') {
      maxCoreHp = second;
      isVictory = third ?? true;
    } else if (typeof third === 'boolean') {
      isVictory = third;
    }
  }

  if (!isVictory || !Number.isFinite(remainingCoreHp) || remainingCoreHp <= 0) {
    return 0;
  }
  if (maxCoreHp !== undefined && (!Number.isFinite(maxCoreHp) || maxCoreHp <= 0)) {
    return 0;
  }

  const pct = normalizeCoreHpPct(remainingCoreHp, maxCoreHp);
  if (pct <= 0) return 0;
  if (pct + 1e-6 >= 90) return 3;
  if (pct + 1e-6 >= 60) return 2;
  return 1;
}

/** Alias for `calculateStarRating`. */
export const computeMissionStars = calculateStarRating;

function isStarRating(value: unknown): value is StarRating {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

function matchNumericOption<T extends number>(
  value: unknown,
  options: readonly T[],
): T | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return options.find((candidate) => Math.abs(candidate - value) < 1e-6);
}

function matchStringOption<T extends string>(value: unknown, options: readonly T[]): T | undefined {
  if (typeof value !== 'string') return undefined;
  return options.find((candidate) => candidate === value);
}

const ALLOWED_SETTING_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_SETTINGS));

/**
 * Strictly validates a complete `UserSettings` object without silently coercing out-of-range values
 * or wrong types. Used by `importBackupJson` to reject corrupt payloads.
 */
export function validateSettingsStrict(input: unknown): UserSettings {
  assertNoSpatialData(input, 'settings');
  if (!isRecord(input)) {
    throw new PersistValidationError('Settings payload must be a JSON object.');
  }

  for (const key of Object.keys(input)) {
    if (!ALLOWED_SETTING_KEYS.has(key)) {
      throw new PersistValidationError(`Unknown settings field "${key}".`);
    }
  }

  for (const requiredKey of ALLOWED_SETTING_KEYS) {
    if (!(requiredKey in input)) {
      throw new PersistValidationError(`Missing required settings field "${requiredKey}".`);
    }
  }

  if (typeof input.showFps !== 'boolean') {
    throw new PersistValidationError('Settings "showFps" must be a boolean.');
  }

  const fixedFoveation = matchNumericOption(input.fixedFoveation, FIXED_FOVEATION_OPTIONS);
  if (fixedFoveation === undefined) {
    throw new PersistValidationError('Settings "fixedFoveation" must be one of 0, 0.5, or 1.');
  }

  const framebufferScale = matchNumericOption(input.framebufferScale, FRAMEBUFFER_SCALE_OPTIONS);
  if (framebufferScale === undefined) {
    throw new PersistValidationError(
      'Settings "framebufferScale" must be one of 1.0, 1.1, 1.15, or 1.2.',
    );
  }

  const playArc = matchStringOption(input.playArc, PLAY_ARC_OPTIONS);
  if (playArc === undefined) {
    throw new PersistValidationError('Settings "playArc" must be "front-180" or "full-360".');
  }

  const roomOcclusion = matchStringOption(input.roomOcclusion, ROOM_OCCLUSION_OPTIONS);
  if (roomOcclusion === undefined) {
    throw new PersistValidationError(
      'Settings "roomOcclusion" must be "auto-depth", "room-mesh", or "off".',
    );
  }

  const qualityTier = matchStringOption(input.qualityTier, QUALITY_TIER_OPTIONS);
  if (qualityTier === undefined) {
    throw new PersistValidationError(
      'Settings "qualityTier" must be "balanced", "max-beauty", or "high-fps".',
    );
  }

  const validateVolume = (name: SettingKey, raw: unknown): number => {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
      throw new PersistValidationError(
        `Settings "${name}" must be a finite number between 0 and 1.`,
      );
    }
    return Math.round(raw * 1000) / 1000;
  };

  return {
    showFps: input.showFps,
    fixedFoveation,
    framebufferScale,
    playArc,
    roomOcclusion,
    qualityTier,
    masterVolume: validateVolume('masterVolume', input.masterVolume),
    musicVolume: validateVolume('musicVolume', input.musicVolume),
    sfxVolume: validateVolume('sfxVolume', input.sfxVolume),
  };
}

const ALLOWED_RUN_KEYS: ReadonlySet<string> = new Set([
  'timestamp',
  'score',
  'waveCleared',
  'victory',
  'stars',
  'remainingCoreHpPct',
  'remainingCoreHp',
  'maxCoreHp',
  'durationMs',
  'seed',
]);

export function validateMissionRunRecordStrict(input: unknown, index = 0): MissionRunRecord {
  assertNoSpatialData(input, `recentRuns[${index}]`);
  if (!isRecord(input)) {
    throw new PersistValidationError(`recentRuns[${index}] must be an object.`);
  }

  for (const key of Object.keys(input)) {
    if (!ALLOWED_RUN_KEYS.has(key)) {
      throw new PersistValidationError(`Unknown field "${key}" in recentRuns[${index}].`);
    }
  }

  if (
    typeof input.timestamp !== 'number' ||
    !Number.isFinite(input.timestamp) ||
    input.timestamp < 0
  ) {
    throw new PersistValidationError(
      `recentRuns[${index}].timestamp must be a non-negative number.`,
    );
  }

  if (
    typeof input.score !== 'number' ||
    !Number.isSafeInteger(input.score) ||
    input.score < 0 ||
    input.score > MAX_SCORE_BOUND
  ) {
    throw new PersistValidationError(
      `recentRuns[${index}].score must be an integer in [0, ${MAX_SCORE_BOUND}].`,
    );
  }

  if (
    typeof input.waveCleared !== 'number' ||
    !Number.isSafeInteger(input.waveCleared) ||
    input.waveCleared < 0 ||
    input.waveCleared > MAX_MISSION_WAVE
  ) {
    throw new PersistValidationError(
      `recentRuns[${index}].waveCleared must be an integer in [0, ${MAX_MISSION_WAVE}].`,
    );
  }

  if (typeof input.victory !== 'boolean') {
    throw new PersistValidationError(`recentRuns[${index}].victory must be a boolean.`);
  }

  if (!isStarRating(input.stars)) {
    throw new PersistValidationError(`recentRuns[${index}].stars must be 0, 1, 2, or 3.`);
  }

  if (!input.victory && input.stars !== 0) {
    throw new PersistValidationError(`recentRuns[${index}].stars must be 0 when victory is false.`);
  }

  let maxCoreHp = 100;
  if (input.maxCoreHp !== undefined) {
    if (
      typeof input.maxCoreHp !== 'number' ||
      !Number.isFinite(input.maxCoreHp) ||
      input.maxCoreHp <= 0 ||
      input.maxCoreHp > 1_000_000
    ) {
      throw new PersistValidationError(`recentRuns[${index}].maxCoreHp must be a positive number.`);
    }
    maxCoreHp = input.maxCoreHp;
  }

  let remainingCoreHpPct: number;
  let remainingCoreHp: number;

  if (input.remainingCoreHpPct !== undefined) {
    if (
      typeof input.remainingCoreHpPct !== 'number' ||
      !Number.isFinite(input.remainingCoreHpPct) ||
      input.remainingCoreHpPct < 0 ||
      input.remainingCoreHpPct > 100
    ) {
      throw new PersistValidationError(
        `recentRuns[${index}].remainingCoreHpPct must be in [0, 100].`,
      );
    }
    remainingCoreHpPct = Math.round(input.remainingCoreHpPct * 100) / 100;
    remainingCoreHp =
      typeof input.remainingCoreHp === 'number' &&
      Number.isFinite(input.remainingCoreHp) &&
      input.remainingCoreHp >= 0 &&
      input.remainingCoreHp <= maxCoreHp
        ? input.remainingCoreHp
        : Math.round((remainingCoreHpPct / 100) * maxCoreHp * 100) / 100;
  } else if (input.remainingCoreHp !== undefined) {
    if (
      typeof input.remainingCoreHp !== 'number' ||
      !Number.isFinite(input.remainingCoreHp) ||
      input.remainingCoreHp < 0 ||
      input.remainingCoreHp > maxCoreHp
    ) {
      throw new PersistValidationError(
        `recentRuns[${index}].remainingCoreHp must be in [0, ${maxCoreHp}].`,
      );
    }
    remainingCoreHp = input.remainingCoreHp;
    remainingCoreHpPct = normalizeCoreHpPct(remainingCoreHp, maxCoreHp);
  } else {
    throw new PersistValidationError(
      `recentRuns[${index}] must include remainingCoreHpPct or remainingCoreHp.`,
    );
  }

  let durationMs: number | undefined;
  if (input.durationMs !== undefined) {
    if (
      typeof input.durationMs !== 'number' ||
      !Number.isFinite(input.durationMs) ||
      input.durationMs < 0
    ) {
      throw new PersistValidationError(
        `recentRuns[${index}].durationMs must be a non-negative number.`,
      );
    }
    durationMs = input.durationMs;
  }

  let seed: number | undefined;
  if (input.seed !== undefined) {
    if (typeof input.seed !== 'number' || !Number.isFinite(input.seed)) {
      throw new PersistValidationError(`recentRuns[${index}].seed must be a finite number.`);
    }
    seed = input.seed;
  }

  return Object.freeze({
    timestamp: input.timestamp,
    score: input.score,
    waveCleared: input.waveCleared,
    victory: input.victory,
    stars: input.stars,
    remainingCoreHpPct,
    remainingCoreHp,
    maxCoreHp,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(seed !== undefined ? { seed } : {}),
  });
}

const ALLOWED_MISSION_RECORD_KEYS: ReadonlySet<string> = new Set([
  'bestScore',
  'highestWaveCleared',
  'bestStars',
  'totalRuns',
  'victories',
  'recentRuns',
]);

/**
 * Strictly validates a `MissionRecords` object for backup import and persistence writes.
 */
export function validateMissionRecordsStrict(input: unknown): MissionRecords {
  assertNoSpatialData(input, 'missionRecords');
  if (!isRecord(input)) {
    throw new PersistValidationError('Mission records payload must be a JSON object.');
  }

  for (const key of Object.keys(input)) {
    if (!ALLOWED_MISSION_RECORD_KEYS.has(key)) {
      throw new PersistValidationError(`Unknown missionRecords field "${key}".`);
    }
  }

  if (
    typeof input.bestScore !== 'number' ||
    !Number.isSafeInteger(input.bestScore) ||
    input.bestScore < 0 ||
    input.bestScore > MAX_SCORE_BOUND
  ) {
    throw new PersistValidationError(
      `missionRecords.bestScore must be an integer in [0, ${MAX_SCORE_BOUND}].`,
    );
  }

  if (
    typeof input.highestWaveCleared !== 'number' ||
    !Number.isSafeInteger(input.highestWaveCleared) ||
    input.highestWaveCleared < 0 ||
    input.highestWaveCleared > MAX_MISSION_WAVE
  ) {
    throw new PersistValidationError(
      `missionRecords.highestWaveCleared must be an integer in [0, ${MAX_MISSION_WAVE}].`,
    );
  }

  if (!isStarRating(input.bestStars)) {
    throw new PersistValidationError('missionRecords.bestStars must be 0, 1, 2, or 3.');
  }

  if (
    typeof input.totalRuns !== 'number' ||
    !Number.isSafeInteger(input.totalRuns) ||
    input.totalRuns < 0 ||
    input.totalRuns > MAX_RUNS_BOUND
  ) {
    throw new PersistValidationError(
      `missionRecords.totalRuns must be an integer in [0, ${MAX_RUNS_BOUND}].`,
    );
  }

  if (
    typeof input.victories !== 'number' ||
    !Number.isSafeInteger(input.victories) ||
    input.victories < 0 ||
    input.victories > input.totalRuns
  ) {
    throw new PersistValidationError(
      'missionRecords.victories must be a non-negative integer <= totalRuns.',
    );
  }

  if (!Array.isArray(input.recentRuns)) {
    throw new PersistValidationError('missionRecords.recentRuns must be an array.');
  }

  if (input.recentRuns.length > MAX_RECENT_RUNS) {
    throw new PersistValidationError(
      `missionRecords.recentRuns cannot exceed ${MAX_RECENT_RUNS} entries (got ${input.recentRuns.length}).`,
    );
  }

  const recentRuns = input.recentRuns.map((entry, idx) =>
    validateMissionRunRecordStrict(entry, idx),
  );

  return Object.freeze({
    bestScore: input.bestScore,
    highestWaveCleared: input.highestWaveCleared,
    bestStars: input.bestStars,
    totalRuns: input.totalRuns,
    victories: input.victories,
    recentRuns: Object.freeze(recentRuns),
  });
}

function coerceMissionRecords(raw: unknown): MissionRecords {
  if (!isRecord(raw)) return DEFAULT_MISSION_RECORDS;
  try {
    const candidate = Array.isArray(raw.recentRuns)
      ? { ...raw, recentRuns: raw.recentRuns.slice(0, MAX_RECENT_RUNS) }
      : raw;
    return validateMissionRecordsStrict(candidate);
  } catch {
    return DEFAULT_MISSION_RECORDS;
  }
}

const ALLOWED_BACKUP_KEYS: ReadonlySet<string> = new Set([
  'app',
  'schemaVersion',
  'version',
  'exportedAt',
  'settings',
  'missionRecords',
]);

/**
 * Parses and strictly validates an exported backup JSON string.
 * Throws `PersistValidationError` on corrupt JSON, unsupported/future schema version,
 * out-of-range numbers, wrong types, or forbidden spatial data.
 */
export function parseAndValidateBackupJson(
  raw: string,
  maxSupportedVersion: number = PERSIST_SCHEMA_VERSION,
): PersistBackupPayload {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new PersistValidationError('Backup payload must be a non-empty JSON string.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PersistValidationError(
      `Corrupt or truncated backup JSON: ${(error as Error).message}`,
    );
  }

  assertNoSpatialData(parsed, 'backup JSON');

  if (!isRecord(parsed)) {
    throw new PersistValidationError('Backup JSON root must be an object.');
  }

  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_BACKUP_KEYS.has(key)) {
      throw new PersistValidationError(`Unknown top-level field "${key}" in backup JSON.`);
    }
  }

  if (parsed.app !== undefined && parsed.app !== 'rift-bastion') {
    throw new PersistValidationError(`Unsupported backup app identifier "${String(parsed.app)}".`);
  }

  const rawVersion = parsed.schemaVersion !== undefined ? parsed.schemaVersion : parsed.version;
  if (
    typeof rawVersion !== 'number' ||
    !Number.isSafeInteger(rawVersion) ||
    rawVersion < 1 ||
    rawVersion > maxSupportedVersion
  ) {
    throw new PersistValidationError(
      `Unsupported or future backup schemaVersion: ${String(rawVersion)} (supported: 1..${maxSupportedVersion}).`,
    );
  }

  const exportedAt =
    typeof parsed.exportedAt === 'string' && parsed.exportedAt.trim() !== ''
      ? parsed.exportedAt
      : new Date(0).toISOString();

  const settings = validateSettingsStrict(parsed.settings);
  const missionRecords = validateMissionRecordsStrict(parsed.missionRecords);

  return Object.freeze({
    app: 'rift-bastion',
    schemaVersion: rawVersion,
    exportedAt,
    settings: Object.freeze({ ...settings }),
    missionRecords,
  });
}

/**
 * Executes schema migration hooks from `fromVersion` to `toVersion`.
 */
export async function runPersistMigrations(
  context: PersistMigrationContext,
  options: {
    readonly migrationHook?: PersistMigrationHook;
    readonly migrations?: Readonly<Record<number, PersistMigrationHook>>;
  },
): Promise<PersistMigrationResult> {
  let currentSettings: UserSettings = { ...context.settings };
  let currentRecords: MissionRecords = {
    ...context.missionRecords,
    recentRuns: [...context.missionRecords.recentRuns],
  };

  if (context.fromVersion >= context.toVersion) {
    return {
      settings: currentSettings,
      missionRecords: currentRecords,
    };
  }

  if (options.migrations) {
    for (let step = context.fromVersion + 1; step <= context.toVersion; step += 1) {
      const stepHook = options.migrations[step];
      if (!stepHook) continue;
      const stepResult = await stepHook({
        fromVersion: step - 1,
        toVersion: step,
        settings: currentSettings,
        missionRecords: currentRecords,
      });
      assertNoSpatialData(stepResult, `migration step ${step - 1}->${step}`);
      currentSettings = validateSettings(stepResult.settings);
      currentRecords = validateMissionRecordsStrict({
        ...stepResult.missionRecords,
        recentRuns: stepResult.missionRecords.recentRuns.slice(0, MAX_RECENT_RUNS),
      });
    }
  }

  if (options.migrationHook) {
    const hookResult = await options.migrationHook({
      fromVersion: context.fromVersion,
      toVersion: context.toVersion,
      settings: currentSettings,
      missionRecords: currentRecords,
    });
    assertNoSpatialData(hookResult, `migrationHook ${context.fromVersion}->${context.toVersion}`);
    currentSettings = validateSettings(hookResult.settings);
    currentRecords = validateMissionRecordsStrict({
      ...hookResult.missionRecords,
      recentRuns: hookResult.missionRecords.recentRuns.slice(0, MAX_RECENT_RUNS),
    });
  }

  return {
    settings: Object.freeze({ ...currentSettings }),
    missionRecords: currentRecords,
  };
}

/**
 * Adapter implementing `SettingsStorageAdapter` from `src/settings/store.ts` backed by
 * `PersistStore` (IndexedDB with graceful memory fallback).
 */
export class IndexedDbSettingsAdapter implements SettingsStorageAdapter {
  private readonly store: PersistStore;
  private cachedEnvelope: StoredSettingsEnvelope | null;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(store: PersistStore, initialEnvelope: StoredSettingsEnvelope | null = null) {
    this.store = store;
    this.cachedEnvelope = initialEnvelope ? parseStoredSettingsEnvelope(initialEnvelope) : null;
  }

  read(): StoredSettingsEnvelope | null {
    if (!this.cachedEnvelope) return null;
    return {
      version: SETTINGS_SCHEMA_VERSION,
      settings: { ...this.cachedEnvelope.settings },
    };
  }

  write(envelope: StoredSettingsEnvelope): void {
    const parsed = parseStoredSettingsEnvelope(envelope);
    if (!parsed) return;
    this.cachedEnvelope = {
      version: SETTINGS_SCHEMA_VERSION,
      settings: { ...parsed.settings },
    };
    this.enqueueWrite(async () => {
      await this.store.saveSettings(parsed.settings);
    });
  }

  remove(): void {
    this.cachedEnvelope = null;
    this.enqueueWrite(async () => {
      await this.store.clearSettings();
    });
  }

  async readAsync(): Promise<StoredSettingsEnvelope | null> {
    await this.pendingWrite;
    const settings = await this.store.loadSettings();
    const envelope: StoredSettingsEnvelope = {
      version: SETTINGS_SCHEMA_VERSION,
      settings: { ...settings },
    };
    this.cachedEnvelope = envelope;
    return {
      version: SETTINGS_SCHEMA_VERSION,
      settings: { ...envelope.settings },
    };
  }

  async writeAsync(envelope: StoredSettingsEnvelope): Promise<void> {
    const parsed = parseStoredSettingsEnvelope(envelope);
    if (!parsed) return;
    this.cachedEnvelope = {
      version: SETTINGS_SCHEMA_VERSION,
      settings: { ...parsed.settings },
    };
    const task = this.pendingWrite.then(async () => {
      await this.store.saveSettings(parsed.settings);
    });
    this.pendingWrite = task.catch(() => undefined);
    await task;
  }

  async flush(): Promise<void> {
    await this.pendingWrite;
  }

  private enqueueWrite(fn: () => Promise<void>): void {
    this.pendingWrite = this.pendingWrite.then(fn).catch(() => undefined);
  }
}

export function createIndexedDbSettingsAdapter(
  store: PersistStore,
  initialEnvelope: StoredSettingsEnvelope | null = null,
): IndexedDbSettingsAdapter {
  return new IndexedDbSettingsAdapter(store, initialEnvelope);
}

function defaultIdbFactory(): IDBFactory | null {
  try {
    if (typeof indexedDB !== 'undefined' && indexedDB !== null) {
      return indexedDB;
    }
    if (typeof window !== 'undefined' && window.indexedDB) {
      return window.indexedDB;
    }
    return null;
  } catch {
    return null;
  }
}

function idbGet<T>(store: IDBObjectStore, key: IDBValidKey): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB get failed'));
  });
}

function idbTransactionComplete(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export function createPersistStore(options: CreatePersistStoreOptions = {}): PersistStore {
  const dbName = options.dbName ?? PERSIST_DB_NAME;
  const schemaVersion = options.schemaVersion ?? PERSIST_SCHEMA_VERSION;
  const idbFactory = options.idbFactory !== undefined ? options.idbFactory : defaultIdbFactory();
  const now = options.now ?? (() => Date.now());

  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw new PersistValidationError(`Invalid schemaVersion: ${String(schemaVersion)}`);
  }

  let backendMode: PersistBackendMode = idbFactory ? 'indexeddb' : 'memory-fallback';
  let dbInstance: IDBDatabase | null = null;
  let initPromise: Promise<void> | null = null;

  let memorySettings: UserSettings = { ...DEFAULT_SETTINGS };
  let memoryMissionRecords: MissionRecords = DEFAULT_MISSION_RECORDS;
  let memorySchemaVersion = 0;

  const openIdb = (): Promise<{ db: IDBDatabase; upgradedFromVersion: number | null }> => {
    return new Promise((resolve, reject) => {
      if (!idbFactory) {
        reject(new Error('IndexedDB is unavailable'));
        return;
      }

      let upgradedFromVersion: number | null = null;
      let request: IDBOpenDBRequest;
      try {
        request = idbFactory.open(dbName, schemaVersion);
      } catch (error) {
        reject(error);
        return;
      }

      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        upgradedFromVersion = event.oldVersion;
        const db = request.result;
        if (!db.objectStoreNames.contains(PERSIST_META_STORE)) {
          db.createObjectStore(PERSIST_META_STORE);
        }
        if (!db.objectStoreNames.contains(PERSIST_SETTINGS_STORE)) {
          db.createObjectStore(PERSIST_SETTINGS_STORE);
        }
        if (!db.objectStoreNames.contains(PERSIST_MISSION_STORE)) {
          db.createObjectStore(PERSIST_MISSION_STORE);
        }
      };

      request.onsuccess = () => {
        resolve({ db: request.result, upgradedFromVersion });
      };

      request.onerror = () => {
        reject(request.error ?? new Error('Failed to open IndexedDB'));
      };

      request.onblocked = () => {
        reject(new Error('IndexedDB open request was blocked'));
      };
    });
  };

  const readAllFromIdb = async (
    db: IDBDatabase,
  ): Promise<{
    storedSchemaVersion: number | undefined;
    rawSettings: unknown;
    rawMissionRecords: unknown;
  }> => {
    const tx = db.transaction(
      [PERSIST_META_STORE, PERSIST_SETTINGS_STORE, PERSIST_MISSION_STORE],
      'readonly',
    );
    const metaStore = tx.objectStore(PERSIST_META_STORE);
    const settingsStore = tx.objectStore(PERSIST_SETTINGS_STORE);
    const missionStore = tx.objectStore(PERSIST_MISSION_STORE);

    const [storedSchemaVersion, rawSettings, rawMissionRecords] = await Promise.all([
      idbGet<number>(metaStore, META_KEY_SCHEMA),
      idbGet<unknown>(settingsStore, RECORD_KEY_CURRENT),
      idbGet<unknown>(missionStore, RECORD_KEY_CURRENT),
    ]);
    await idbTransactionComplete(tx);

    return { storedSchemaVersion, rawSettings, rawMissionRecords };
  };

  const writeAllToIdb = async (
    db: IDBDatabase,
    nextVersion: number,
    nextSettings: UserSettings,
    nextMissionRecords: MissionRecords,
  ): Promise<void> => {
    const tx = db.transaction(
      [PERSIST_META_STORE, PERSIST_SETTINGS_STORE, PERSIST_MISSION_STORE],
      'readwrite',
    );
    tx.objectStore(PERSIST_META_STORE).put(nextVersion, META_KEY_SCHEMA);
    tx.objectStore(PERSIST_SETTINGS_STORE).put(
      {
        version: SETTINGS_SCHEMA_VERSION,
        settings: { ...nextSettings },
      } satisfies StoredSettingsEnvelope,
      RECORD_KEY_CURRENT,
    );
    tx.objectStore(PERSIST_MISSION_STORE).put(
      {
        bestScore: nextMissionRecords.bestScore,
        highestWaveCleared: nextMissionRecords.highestWaveCleared,
        bestStars: nextMissionRecords.bestStars,
        totalRuns: nextMissionRecords.totalRuns,
        victories: nextMissionRecords.victories,
        recentRuns: nextMissionRecords.recentRuns.map((run) => ({ ...run })),
      },
      RECORD_KEY_CURRENT,
    );
    await idbTransactionComplete(tx);
  };

  const performInit = async (): Promise<void> => {
    if (!idbFactory) {
      backendMode = 'memory-fallback';
      if (memorySchemaVersion < schemaVersion) {
        const migrated = await runPersistMigrations(
          {
            fromVersion: memorySchemaVersion,
            toVersion: schemaVersion,
            settings: memorySettings,
            missionRecords: memoryMissionRecords,
          },
          {
            migrationHook: options.migrationHook,
            migrations: options.migrations,
          },
        );
        memorySettings = { ...migrated.settings };
        memoryMissionRecords = migrated.missionRecords;
        memorySchemaVersion = schemaVersion;
      }
      return;
    }

    try {
      const { db, upgradedFromVersion } = await openIdb();
      dbInstance = db;
      backendMode = 'indexeddb';

      const { storedSchemaVersion, rawSettings, rawMissionRecords } = await readAllFromIdb(db);
      const parsedEnvelope = parseStoredSettingsEnvelope(rawSettings);
      const currentSettings = parsedEnvelope
        ? { ...parsedEnvelope.settings }
        : isRecord(rawSettings)
          ? validateSettings(rawSettings)
          : { ...DEFAULT_SETTINGS };
      const currentRecords = coerceMissionRecords(rawMissionRecords);

      const effectiveFromVersion =
        typeof storedSchemaVersion === 'number' && Number.isSafeInteger(storedSchemaVersion)
          ? storedSchemaVersion
          : (upgradedFromVersion ?? 0);

      if (effectiveFromVersion < schemaVersion) {
        const migrated = await runPersistMigrations(
          {
            fromVersion: effectiveFromVersion,
            toVersion: schemaVersion,
            settings: currentSettings,
            missionRecords: currentRecords,
          },
          {
            migrationHook: options.migrationHook,
            migrations: options.migrations,
          },
        );
        memorySettings = { ...migrated.settings };
        memoryMissionRecords = migrated.missionRecords;
        memorySchemaVersion = schemaVersion;
        await writeAllToIdb(db, schemaVersion, memorySettings, memoryMissionRecords);
      } else {
        memorySettings = currentSettings;
        memoryMissionRecords = currentRecords;
        memorySchemaVersion = effectiveFromVersion;
      }
    } catch {
      // Restricted browser environment / IndexedDB denied -> graceful in-memory fallback
      backendMode = 'memory-fallback';
      dbInstance = null;
      if (memorySchemaVersion < schemaVersion) {
        const migrated = await runPersistMigrations(
          {
            fromVersion: memorySchemaVersion,
            toVersion: schemaVersion,
            settings: memorySettings,
            missionRecords: memoryMissionRecords,
          },
          {
            migrationHook: options.migrationHook,
            migrations: options.migrations,
          },
        );
        memorySettings = { ...migrated.settings };
        memoryMissionRecords = migrated.missionRecords;
        memorySchemaVersion = schemaVersion;
      }
    }
  };

  const ensureInitialized = async (): Promise<void> => {
    if (!initPromise) {
      initPromise = performInit();
    }
    await initPromise;
  };

  const loadSettings = async (): Promise<Readonly<UserSettings>> => {
    await ensureInitialized();
    if (backendMode === 'indexeddb' && dbInstance) {
      try {
        const tx = dbInstance.transaction(PERSIST_SETTINGS_STORE, 'readonly');
        const raw = await idbGet<unknown>(
          tx.objectStore(PERSIST_SETTINGS_STORE),
          RECORD_KEY_CURRENT,
        );
        await idbTransactionComplete(tx);
        const parsed = parseStoredSettingsEnvelope(raw);
        if (parsed) {
          memorySettings = { ...parsed.settings };
        } else if (isRecord(raw)) {
          memorySettings = validateSettings(raw);
        }
      } catch {
        backendMode = 'memory-fallback';
      }
    }
    return Object.freeze({ ...memorySettings });
  };

  const saveSettings = async (
    patchOrSettings: Partial<UserSettings> | UserSettings,
  ): Promise<Readonly<UserSettings>> => {
    assertNoSpatialData(patchOrSettings, 'saveSettings');
    await ensureInitialized();
    const merged = validateSettings({
      ...memorySettings,
      ...patchOrSettings,
    });
    memorySettings = { ...merged };

    if (backendMode === 'indexeddb' && dbInstance) {
      try {
        const tx = dbInstance.transaction(PERSIST_SETTINGS_STORE, 'readwrite');
        tx.objectStore(PERSIST_SETTINGS_STORE).put(
          {
            version: SETTINGS_SCHEMA_VERSION,
            settings: { ...memorySettings },
          } satisfies StoredSettingsEnvelope,
          RECORD_KEY_CURRENT,
        );
        await idbTransactionComplete(tx);
      } catch {
        backendMode = 'memory-fallback';
      }
    }
    return Object.freeze({ ...memorySettings });
  };

  const clearSettings = async (): Promise<void> => {
    await ensureInitialized();
    memorySettings = { ...DEFAULT_SETTINGS };
    if (backendMode === 'indexeddb' && dbInstance) {
      try {
        const tx = dbInstance.transaction(PERSIST_SETTINGS_STORE, 'readwrite');
        tx.objectStore(PERSIST_SETTINGS_STORE).put(
          {
            version: SETTINGS_SCHEMA_VERSION,
            settings: { ...DEFAULT_SETTINGS },
          } satisfies StoredSettingsEnvelope,
          RECORD_KEY_CURRENT,
        );
        await idbTransactionComplete(tx);
      } catch {
        backendMode = 'memory-fallback';
      }
    }
  };

  const loadMissionRecords = async (): Promise<Readonly<MissionRecords>> => {
    await ensureInitialized();
    if (backendMode === 'indexeddb' && dbInstance) {
      try {
        const tx = dbInstance.transaction(PERSIST_MISSION_STORE, 'readonly');
        const raw = await idbGet<unknown>(
          tx.objectStore(PERSIST_MISSION_STORE),
          RECORD_KEY_CURRENT,
        );
        await idbTransactionComplete(tx);
        if (raw !== undefined) {
          memoryMissionRecords = coerceMissionRecords(raw);
        }
      } catch {
        backendMode = 'memory-fallback';
      }
    }
    return memoryMissionRecords;
  };

  const saveMissionRecords = async (records: MissionRecords): Promise<Readonly<MissionRecords>> => {
    assertNoSpatialData(records, 'saveMissionRecords');
    await ensureInitialized();
    const cappedInput: MissionRecords = {
      ...records,
      recentRuns: Array.isArray(records.recentRuns)
        ? records.recentRuns.slice(0, MAX_RECENT_RUNS)
        : [],
    };
    const validated = validateMissionRecordsStrict(cappedInput);
    memoryMissionRecords = validated;

    if (backendMode === 'indexeddb' && dbInstance) {
      try {
        const tx = dbInstance.transaction(PERSIST_MISSION_STORE, 'readwrite');
        tx.objectStore(PERSIST_MISSION_STORE).put(
          {
            bestScore: validated.bestScore,
            highestWaveCleared: validated.highestWaveCleared,
            bestStars: validated.bestStars,
            totalRuns: validated.totalRuns,
            victories: validated.victories,
            recentRuns: validated.recentRuns.map((run) => ({ ...run })),
          },
          RECORD_KEY_CURRENT,
        );
        await idbTransactionComplete(tx);
      } catch {
        backendMode = 'memory-fallback';
      }
    }
    return memoryMissionRecords;
  };

  const recordMissionRun = async (input: MissionRunInput): Promise<Readonly<MissionRecords>> => {
    assertNoSpatialData(input, 'recordMissionRun');
    await ensureInitialized();
    const current = await loadMissionRecords();

    const score =
      typeof input.score === 'number' && Number.isFinite(input.score)
        ? Math.min(MAX_SCORE_BOUND, Math.max(0, Math.round(input.score)))
        : 0;
    const waveCleared =
      typeof input.waveCleared === 'number' && Number.isFinite(input.waveCleared)
        ? Math.min(MAX_MISSION_WAVE, Math.max(0, Math.round(input.waveCleared)))
        : 0;
    const victory = Boolean(input.victory);
    const maxCoreHp =
      input.maxCoreHp !== undefined && Number.isFinite(input.maxCoreHp) && input.maxCoreHp > 0
        ? input.maxCoreHp
        : 100;
    const remainingCoreHpPct = normalizeCoreHpPct(input.remainingCoreHp, input.maxCoreHp);
    const remainingCoreHp =
      input.maxCoreHp !== undefined
        ? Math.min(maxCoreHp, Math.max(0, input.remainingCoreHp))
        : Math.round((remainingCoreHpPct / 100) * maxCoreHp * 100) / 100;

    const stars = calculateStarRating({
      victory,
      remainingCoreHp: input.remainingCoreHp,
      maxCoreHp: input.maxCoreHp,
    });

    const timestamp =
      input.timestamp !== undefined && Number.isFinite(input.timestamp) && input.timestamp >= 0
        ? input.timestamp
        : now();

    const runRecord: MissionRunRecord = Object.freeze({
      timestamp,
      score,
      waveCleared,
      victory,
      stars,
      remainingCoreHpPct,
      remainingCoreHp,
      maxCoreHp,
      ...(input.durationMs !== undefined &&
      Number.isFinite(input.durationMs) &&
      input.durationMs >= 0
        ? { durationMs: input.durationMs }
        : {}),
      ...(input.seed !== undefined && Number.isFinite(input.seed) ? { seed: input.seed } : {}),
    });

    const nextRecords: MissionRecords = {
      bestScore: Math.max(current.bestScore, runRecord.score),
      highestWaveCleared: Math.max(current.highestWaveCleared, runRecord.waveCleared),
      bestStars: Math.max(current.bestStars, runRecord.stars) as StarRating,
      totalRuns: current.totalRuns + 1,
      victories: current.victories + (runRecord.victory ? 1 : 0),
      recentRuns: [runRecord, ...current.recentRuns].slice(0, MAX_RECENT_RUNS),
    };

    return saveMissionRecords(nextRecords);
  };

  const clearMissionRecords = async (): Promise<void> => {
    await saveMissionRecords(DEFAULT_MISSION_RECORDS);
  };

  const exportBackupJson = async (pretty = true): Promise<string> => {
    await ensureInitialized();
    const [settings, missionRecords] = await Promise.all([loadSettings(), loadMissionRecords()]);
    const payload: PersistBackupPayload = {
      app: 'rift-bastion',
      schemaVersion,
      exportedAt: new Date(now()).toISOString(),
      settings: { ...settings },
      missionRecords: {
        bestScore: missionRecords.bestScore,
        highestWaveCleared: missionRecords.highestWaveCleared,
        bestStars: missionRecords.bestStars,
        totalRuns: missionRecords.totalRuns,
        victories: missionRecords.victories,
        recentRuns: missionRecords.recentRuns.map((run) => ({ ...run })),
      },
    };
    return JSON.stringify(payload, null, pretty ? 2 : undefined);
  };

  const importBackupJson = async (raw: string): Promise<PersistBackupPayload> => {
    await ensureInitialized();
    // Strictly validate everything BEFORE mutating memory or IndexedDB state.
    const validated = parseAndValidateBackupJson(raw, schemaVersion);

    let finalSettings = validated.settings;
    let finalRecords = validated.missionRecords;
    if (validated.schemaVersion < schemaVersion) {
      const migrated = await runPersistMigrations(
        {
          fromVersion: validated.schemaVersion,
          toVersion: schemaVersion,
          settings: validated.settings,
          missionRecords: validated.missionRecords,
        },
        {
          migrationHook: options.migrationHook,
          migrations: options.migrations,
        },
      );
      finalSettings = migrated.settings;
      finalRecords = migrated.missionRecords;
    }

    memorySettings = { ...finalSettings };
    memoryMissionRecords = finalRecords;

    if (backendMode === 'indexeddb' && dbInstance) {
      try {
        await writeAllToIdb(dbInstance, schemaVersion, memorySettings, memoryMissionRecords);
      } catch {
        backendMode = 'memory-fallback';
      }
    }

    return Object.freeze({
      app: 'rift-bastion',
      schemaVersion,
      exportedAt: validated.exportedAt,
      settings: Object.freeze({ ...memorySettings }),
      missionRecords: memoryMissionRecords,
    });
  };

  const close = (): void => {
    if (dbInstance) {
      dbInstance.close();
      dbInstance = null;
    }
    initPromise = null;
  };

  const store: PersistStore = {
    dbName,
    schemaVersion,
    init: ensureInitialized,
    getBackendMode: () => backendMode,
    isFallbackMode: () => backendMode === 'memory-fallback',
    loadSettings,
    saveSettings,
    clearSettings,
    loadMissionRecords,
    saveMissionRecords,
    recordMissionRun,
    clearMissionRecords,
    createSettingsAdapter: () => new IndexedDbSettingsAdapter(store),
    exportBackupJson,
    importBackupJson,
    close,
  };

  return store;
}
