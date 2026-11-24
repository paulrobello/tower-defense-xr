export const SETTINGS_SCHEMA_VERSION = 1 as const;
export const SETTINGS_STORAGE_KEY = 'rift-bastion:settings:v1';

export const FIXED_FOVEATION_OPTIONS = [0, 0.5, 1] as const;
export type FixedFoveationOption = (typeof FIXED_FOVEATION_OPTIONS)[number];

export const FRAMEBUFFER_SCALE_OPTIONS = [1.0, 1.1, 1.15, 1.2] as const;
export type FramebufferScaleOption = (typeof FRAMEBUFFER_SCALE_OPTIONS)[number];

export const PLAY_ARC_OPTIONS = ['front-180', 'full-360'] as const;
export type PlayArcOption = (typeof PLAY_ARC_OPTIONS)[number];

export const ROOM_OCCLUSION_OPTIONS = ['auto-depth', 'room-mesh', 'off'] as const;
export type RoomOcclusionOption = (typeof ROOM_OCCLUSION_OPTIONS)[number];

export const QUALITY_TIER_OPTIONS = ['balanced', 'max-beauty', 'high-fps'] as const;
export type QualityTierOption = (typeof QUALITY_TIER_OPTIONS)[number];

export interface Settings {
  showFps: boolean;
  fixedFoveation: FixedFoveationOption;
  framebufferScale: FramebufferScaleOption;
  playArc: PlayArcOption;
  roomOcclusion: RoomOcclusionOption;
  showRoomMesh: boolean;
  qualityTier: QualityTierOption;
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
}

export type SettingKey = keyof Settings;

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  showFps: false,
  fixedFoveation: 0.5,
  framebufferScale: 1.15,
  playArc: 'front-180',
  roomOcclusion: 'auto-depth',
  showRoomMesh: false,
  qualityTier: 'max-beauty',
  masterVolume: 1,
  musicVolume: 0.7,
  sfxVolume: 0.85,
});

export interface SettingMetadata {
  readonly key: SettingKey;
  readonly label: string;
  readonly requiresXrReentry: boolean;
  readonly note?: string;
}

export const SETTINGS_METADATA: Readonly<Record<SettingKey, SettingMetadata>> = Object.freeze({
  showFps: {
    key: 'showFps',
    label: 'Show FPS',
    requiresXrReentry: false,
  },
  fixedFoveation: {
    key: 'fixedFoveation',
    label: 'Fixed Foveation',
    requiresXrReentry: false,
    note: 'Applies live to the active XR projection layer and persists across quality changes.',
  },
  framebufferScale: {
    key: 'framebufferScale',
    label: 'Framebuffer Scale',
    requiresXrReentry: true,
    note: 'Takes effect on XR re-entry.',
  },
  playArc: {
    key: 'playArc',
    label: 'Play Arc',
    requiresXrReentry: false,
  },
  roomOcclusion: {
    key: 'roomOcclusion',
    label: 'Room Occlusion',
    requiresXrReentry: false,
  },
  showRoomMesh: {
    key: 'showRoomMesh',
    label: 'Show Room Mesh',
    requiresXrReentry: false,
  },
  qualityTier: {
    key: 'qualityTier',
    label: 'Quality Tier',
    requiresXrReentry: false,
  },
  masterVolume: {
    key: 'masterVolume',
    label: 'Master Volume',
    requiresXrReentry: false,
  },
  musicVolume: {
    key: 'musicVolume',
    label: 'Music Volume',
    requiresXrReentry: false,
  },
  sfxVolume: {
    key: 'sfxVolume',
    label: 'SFX Volume',
    requiresXrReentry: false,
  },
});

export interface StoredSettingsEnvelope {
  readonly version: typeof SETTINGS_SCHEMA_VERSION;
  readonly settings: Settings;
}

/**
 * Storage adapter interface backed by localStorage in P0 and designed so a P2
 * IndexedDB persistence adapter can plug in without changing callers.
 */
export interface SettingsStorageAdapter {
  read(): StoredSettingsEnvelope | null;
  write(envelope: StoredSettingsEnvelope): void;
  remove(): void;
  /** Optional asynchronous read hook for P2 IndexedDB hydration. */
  readAsync?(): Promise<StoredSettingsEnvelope | null>;
  /** Optional asynchronous write hook for P2 IndexedDB mirroring. */
  writeAsync?(envelope: StoredSettingsEnvelope): Promise<void>;
}

export type SettingsListener = (
  next: Readonly<Settings>,
  prev: Readonly<Settings>,
  changedKeys: readonly SettingKey[],
) => void;

export interface SettingsStore {
  get(): Readonly<Settings>;
  getPersisted(): Readonly<Settings>;
  getOverrides(): Readonly<Partial<Settings>>;
  set<K extends SettingKey>(key: K, value: Settings[K]): boolean;
  update(patch: Partial<Settings>): readonly SettingKey[];
  reset(): Readonly<Settings>;
  subscribe(listener: SettingsListener): () => void;
  hydrateFromAdapter(): Promise<Readonly<Settings>>;
  requiresXrReentry(key: SettingKey): boolean;
  isPendingXrReentry(appliedFramebufferScale: number | null | undefined): boolean;
}

export interface CreateSettingsStoreOptions {
  adapter?: SettingsStorageAdapter;
  storage?: Storage | null;
  storageKey?: string;
  search?: string | URLSearchParams;
  overrides?: Partial<Settings>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampUnitVolume(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round(clamped * 1000) / 1000;
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

export function validateSettingValue<K extends SettingKey>(
  key: K,
  value: unknown,
): { readonly valid: true; readonly value: Settings[K] } | { readonly valid: false } {
  switch (key) {
    case 'showFps':
    case 'showRoomMesh':
      if (typeof value === 'boolean') return { valid: true, value: value as Settings[K] };
      return { valid: false };
    case 'fixedFoveation': {
      const matched = matchNumericOption(value, FIXED_FOVEATION_OPTIONS);
      return matched !== undefined
        ? { valid: true, value: matched as Settings[K] }
        : { valid: false };
    }
    case 'framebufferScale': {
      const matched = matchNumericOption(value, FRAMEBUFFER_SCALE_OPTIONS);
      return matched !== undefined
        ? { valid: true, value: matched as Settings[K] }
        : { valid: false };
    }
    case 'playArc': {
      const matched = matchStringOption(value, PLAY_ARC_OPTIONS);
      return matched !== undefined
        ? { valid: true, value: matched as Settings[K] }
        : { valid: false };
    }
    case 'roomOcclusion': {
      const matched = matchStringOption(value, ROOM_OCCLUSION_OPTIONS);
      return matched !== undefined
        ? { valid: true, value: matched as Settings[K] }
        : { valid: false };
    }
    case 'qualityTier': {
      const matched = matchStringOption(value, QUALITY_TIER_OPTIONS);
      return matched !== undefined
        ? { valid: true, value: matched as Settings[K] }
        : { valid: false };
    }
    case 'masterVolume':
    case 'musicVolume':
    case 'sfxVolume':
      if (typeof value === 'number' && Number.isFinite(value)) {
        return { valid: true, value: clampUnitVolume(value) as Settings[K] };
      }
      return { valid: false };
  }
}

export function validatePartialSettings(input: unknown): Partial<Settings> {
  if (!isRecord(input)) return {};
  const result: Partial<Settings> = {};
  const keys = Object.keys(DEFAULT_SETTINGS) as SettingKey[];
  for (const key of keys) {
    if (!(key in input)) continue;
    const checked = validateSettingValue(key, input[key]);
    if (checked.valid) {
      (result as Record<SettingKey, Settings[SettingKey]>)[key] = checked.value;
    }
  }
  return result;
}

export function validateSettings(input: unknown): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...validatePartialSettings(input),
  };
}

export function parseStoredSettingsEnvelope(raw: unknown): StoredSettingsEnvelope | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== SETTINGS_SCHEMA_VERSION) return null;
  if (!isRecord(raw.settings)) return null;
  return {
    version: SETTINGS_SCHEMA_VERSION,
    settings: validateSettings(raw.settings),
  };
}

function parseBooleanFlag(raw: string): boolean | undefined {
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === '' ||
    normalized === '1' ||
    normalized === 'true' ||
    normalized === 'on' ||
    normalized === 'yes'
  ) {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no') {
    return false;
  }
  return undefined;
}

/**
 * Parses supported URL override flags:
 * - `?perf` (or `?perf=1` / `?perf=0`) -> `showFps`
 * - `?quality=balanced|max-beauty|high-fps` -> `qualityTier`
 * - `?scale=1.0|1.1|1.15|1.2` -> `framebufferScale`
 * - `?fov=off|0|0.5|1` -> `fixedFoveation`
 */
export function parseSettingsUrlOverrides(search: string | URLSearchParams): Partial<Settings> {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const overrides: Partial<Settings> = {};

  if (params.has('perf')) {
    const parsed = parseBooleanFlag(params.get('perf') ?? '');
    if (parsed !== undefined) overrides.showFps = parsed;
  }

  const qualityRaw = params.get('quality');
  if (qualityRaw !== null) {
    const matched = matchStringOption(qualityRaw.trim().toLowerCase(), QUALITY_TIER_OPTIONS);
    if (matched !== undefined) overrides.qualityTier = matched;
  }

  const scaleRaw = params.get('scale');
  if (scaleRaw !== null && scaleRaw.trim() !== '') {
    const parsed = Number(scaleRaw.trim());
    const matched = matchNumericOption(parsed, FRAMEBUFFER_SCALE_OPTIONS);
    if (matched !== undefined) overrides.framebufferScale = matched;
  }

  const fovRaw = params.get('fov');
  if (fovRaw !== null && fovRaw.trim() !== '') {
    const normalized = fovRaw.trim().toLowerCase();
    if (normalized === 'off') {
      overrides.fixedFoveation = 0;
    } else {
      const parsed = Number(normalized);
      const matched = matchNumericOption(parsed, FIXED_FOVEATION_OPTIONS);
      if (matched !== undefined) overrides.fixedFoveation = matched;
    }
  }

  return overrides;
}

function defaultBrowserStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function defaultBrowserSearch(): string {
  try {
    return typeof window !== 'undefined' ? window.location.search : '';
  } catch {
    return '';
  }
}

export function createLocalStorageAdapter(
  storage: Storage | null = defaultBrowserStorage(),
  key = SETTINGS_STORAGE_KEY,
): SettingsStorageAdapter {
  return {
    read() {
      if (!storage) return null;
      try {
        const raw = storage.getItem(key);
        if (!raw) return null;
        return parseStoredSettingsEnvelope(JSON.parse(raw));
      } catch {
        return null;
      }
    },
    write(envelope) {
      if (!storage) return;
      try {
        storage.setItem(key, JSON.stringify(envelope));
      } catch {
        // Storage can be denied or full; in-memory state remains authoritative.
      }
    },
    remove() {
      if (!storage) return;
      try {
        storage.removeItem(key);
      } catch {
        // Ignore storage access errors.
      }
    },
  };
}

export function createMemoryStorageAdapter(
  initial: StoredSettingsEnvelope | null = null,
): SettingsStorageAdapter {
  let stored = initial ? parseStoredSettingsEnvelope(initial) : null;
  return {
    read() {
      return stored ? { version: SETTINGS_SCHEMA_VERSION, settings: { ...stored.settings } } : null;
    },
    write(envelope) {
      stored = { version: SETTINGS_SCHEMA_VERSION, settings: { ...envelope.settings } };
    },
    remove() {
      stored = null;
    },
  };
}

export function requiresXrReentry(key: SettingKey): boolean {
  return SETTINGS_METADATA[key].requiresXrReentry;
}

function diffKeys(prev: Settings, next: Settings): SettingKey[] {
  const changed: SettingKey[] = [];
  for (const key of Object.keys(DEFAULT_SETTINGS) as SettingKey[]) {
    if (prev[key] !== next[key]) changed.push(key);
  }
  return changed;
}

export function createSettingsStore(options: CreateSettingsStoreOptions = {}): SettingsStore {
  const adapter =
    options.adapter ??
    createLocalStorageAdapter(
      options.storage !== undefined ? options.storage : defaultBrowserStorage(),
      options.storageKey ?? SETTINGS_STORAGE_KEY,
    );

  const urlOverrides = parseSettingsUrlOverrides(options.search ?? defaultBrowserSearch());
  const explicitOverrides = validatePartialSettings(options.overrides);
  let activeOverrides: Partial<Settings> = { ...urlOverrides, ...explicitOverrides };

  const storedEnvelope = adapter.read();
  let persisted: Settings = storedEnvelope
    ? { ...storedEnvelope.settings }
    : { ...DEFAULT_SETTINGS };
  let current: Settings = { ...persisted, ...activeOverrides };

  const listeners = new Set<SettingsListener>();

  const persistCurrent = (): void => {
    const envelope: StoredSettingsEnvelope = {
      version: SETTINGS_SCHEMA_VERSION,
      settings: { ...persisted },
    };
    adapter.write(envelope);
    if (adapter.writeAsync) {
      void adapter.writeAsync(envelope).catch(() => undefined);
    }
  };

  const notify = (prev: Settings, next: Settings, changed: readonly SettingKey[]): void => {
    if (changed.length === 0) return;
    const frozenNext = Object.freeze({ ...next });
    const frozenPrev = Object.freeze({ ...prev });
    const frozenChanged = Object.freeze([...changed]);
    for (const listener of [...listeners]) {
      listener(frozenNext, frozenPrev, frozenChanged);
    }
  };

  const applyPatch = (patch: Partial<Settings>): readonly SettingKey[] => {
    const validated = validatePartialSettings(patch);
    const patchKeys = Object.keys(validated) as SettingKey[];
    if (patchKeys.length === 0) return [];

    const prev = { ...current };
    const nextPersisted = { ...persisted };
    const nextOverrides = { ...activeOverrides };

    for (const key of patchKeys) {
      const value = validated[key];
      if (value === undefined) continue;
      (nextPersisted as Record<SettingKey, Settings[SettingKey]>)[key] = value;
      // An explicit user/runtime update supersedes any startup URL override for this key.
      delete nextOverrides[key];
    }

    const nextCurrent: Settings = { ...nextPersisted, ...nextOverrides };
    const changed = diffKeys(prev, nextCurrent);
    const persistedChanged = diffKeys(persisted, nextPersisted).length > 0;

    persisted = nextPersisted;
    activeOverrides = nextOverrides;
    current = nextCurrent;

    if (persistedChanged || changed.length > 0) {
      persistCurrent();
    }
    notify(prev, current, changed);
    return changed;
  };

  return {
    get() {
      return Object.freeze({ ...current });
    },
    getPersisted() {
      return Object.freeze({ ...persisted });
    },
    getOverrides() {
      return Object.freeze({ ...activeOverrides });
    },
    set(key, value) {
      const changed = applyPatch({ [key]: value } as Partial<Settings>);
      return changed.includes(key);
    },
    update(patch) {
      return applyPatch(patch);
    },
    reset() {
      const prev = { ...current };
      persisted = { ...DEFAULT_SETTINGS };
      activeOverrides = {};
      current = { ...DEFAULT_SETTINGS };
      persistCurrent();
      const changed = diffKeys(prev, current);
      notify(prev, current, changed);
      return Object.freeze({ ...current });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async hydrateFromAdapter() {
      const envelope = adapter.readAsync ? await adapter.readAsync() : adapter.read();
      if (!envelope) return Object.freeze({ ...current });
      const parsed = parseStoredSettingsEnvelope(envelope);
      if (!parsed) return Object.freeze({ ...current });

      const prev = { ...current };
      persisted = { ...parsed.settings };
      current = { ...persisted, ...activeOverrides };
      const changed = diffKeys(prev, current);
      notify(prev, current, changed);
      return Object.freeze({ ...current });
    },
    requiresXrReentry,
    isPendingXrReentry(appliedFramebufferScale) {
      if (
        typeof appliedFramebufferScale !== 'number' ||
        !Number.isFinite(appliedFramebufferScale)
      ) {
        return false;
      }
      return Math.abs(current.framebufferScale - appliedFramebufferScale) > 1e-6;
    },
  };
}
