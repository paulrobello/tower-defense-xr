import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('troika-three-text', async (importOriginal) => {
  const actual = await importOriginal<typeof import('troika-three-text')>();
  const THREE = await import('three');
  return {
    ...actual,
    configureTextBuilder: vi.fn(),
    Text: class MockText extends THREE.Mesh {
      text = '';
      font: string | null = null;
      fontSize = 0;
      maxWidth = 0;
      anchorX: number | string = 0;
      anchorY: number | string = 0;
      textAlign = '';
      whiteSpace = '';
      lineHeight: number | string = 'normal';
      overflowWrap = '';
      color: number | string = 0;
      depthOffset = 0;
      constructor() {
        super(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
      }
      sync(callback?: () => void): void {
        queueMicrotask(() => callback?.());
      }
      dispose(): void {
        this.geometry.dispose();
      }
    },
  };
});

import { OVERLAY_RENDER_ORDER } from '@par/xr-workspace';

import { createDomSettingsPanel, createXrSettingsPanel } from '../src/settings/panel';
import {
  createMemoryStorageAdapter,
  createSettingsStore,
  DEFAULT_SETTINGS,
  parseSettingsUrlOverrides,
  parseStoredSettingsEnvelope,
  requiresXrReentry,
  SETTINGS_SCHEMA_VERSION,
  SETTINGS_STORAGE_KEY,
  type Settings,
  type SettingsStorageAdapter,
  type StoredSettingsEnvelope,
  validatePartialSettings,
  validateSettings,
  validateSettingValue,
} from '../src/settings/store';

function clearLocalStorage(): void {
  window.localStorage.clear();
}

describe('settings/store', () => {
  beforeEach(() => {
    clearLocalStorage();
  });

  it('exposes exact default settings and flags framebufferScale as requiring XR re-entry', () => {
    const store = createSettingsStore({ search: '' });
    expect(store.get()).toEqual({
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

    expect(requiresXrReentry('framebufferScale')).toBe(true);
    expect(store.requiresXrReentry('framebufferScale')).toBe(true);
    expect(store.requiresXrReentry('fixedFoveation')).toBe(false);
    expect(store.requiresXrReentry('qualityTier')).toBe(false);
    expect(store.isPendingXrReentry(1.15)).toBe(false);
    store.set('framebufferScale', 1.2);
    expect(store.isPendingXrReentry(1.15)).toBe(true);
    expect(store.isPendingXrReentry(1.2)).toBe(false);
    expect(store.isPendingXrReentry(null)).toBe(false);
  });

  it('validates schema strictly, clamps finite volumes, and rejects invalid values', () => {
    expect(validateSettingValue('showFps', true)).toEqual({ valid: true, value: true });
    expect(validateSettingValue('showFps', 'true')).toEqual({ valid: false });
    expect(validateSettingValue('fixedFoveation', 0.25)).toEqual({ valid: false });
    expect(validateSettingValue('fixedFoveation', 1)).toEqual({ valid: true, value: 1 });
    expect(validateSettingValue('framebufferScale', 1.5)).toEqual({ valid: false });
    expect(validateSettingValue('framebufferScale', 1.1)).toEqual({ valid: true, value: 1.1 });
    expect(validateSettingValue('playArc', '90-deg')).toEqual({ valid: false });
    expect(validateSettingValue('roomOcclusion', 'magic')).toEqual({ valid: false });
    expect(validateSettingValue('qualityTier', 'ultra')).toEqual({ valid: false });
    expect(validateSettingValue('masterVolume', 1.4)).toEqual({ valid: true, value: 1 });
    expect(validateSettingValue('musicVolume', -0.25)).toEqual({ valid: true, value: 0 });
    expect(validateSettingValue('sfxVolume', Number.NaN)).toEqual({ valid: false });
    expect(validateSettingValue('sfxVolume', Number.POSITIVE_INFINITY)).toEqual({ valid: false });

    const validated = validateSettings({
      showFps: 'yes',
      fixedFoveation: 0.75,
      framebufferScale: 1.2,
      playArc: 'full-360',
      roomOcclusion: 'invalid',
      qualityTier: 'high-fps',
      masterVolume: 2.5,
      musicVolume: -1,
      sfxVolume: Number.NaN,
      unknownExtraKey: 123,
    });
    expect(validated).toEqual({
      ...DEFAULT_SETTINGS,
      framebufferScale: 1.2,
      playArc: 'full-360',
      qualityTier: 'high-fps',
      masterVolume: 1,
      musicVolume: 0,
    });

    expect(parseStoredSettingsEnvelope({ version: 99, settings: DEFAULT_SETTINGS })).toBeNull();
    expect(parseStoredSettingsEnvelope('not-an-object')).toBeNull();
    expect(validatePartialSettings(null)).toEqual({});
  });

  it('persists validated settings to localStorage and recovers cleanly from corrupt JSON', () => {
    const storeA = createSettingsStore({ search: '' });
    storeA.update({
      showFps: true,
      fixedFoveation: 1,
      framebufferScale: 1.2,
      playArc: 'full-360',
      roomOcclusion: 'room-mesh',
      qualityTier: 'balanced',
      masterVolume: 0.6,
      musicVolume: 0.4,
      sfxVolume: 0.9,
    });

    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as StoredSettingsEnvelope;
    expect(parsed.version).toBe(SETTINGS_SCHEMA_VERSION);
    expect(parsed.settings.framebufferScale).toBe(1.2);

    const storeB = createSettingsStore({ search: '' });
    expect(storeB.get()).toEqual(storeA.get());

    // Corrupt storage falls back safely to defaults
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, '{corrupt json');
    const storeC = createSettingsStore({ search: '' });
    expect(storeC.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('supports URL overrides without clobbering persisted settings until explicitly changed', () => {
    const parsed = parseSettingsUrlOverrides('?perf&quality=high-fps&scale=1.2&fov=off');
    expect(parsed).toEqual({
      showFps: true,
      qualityTier: 'high-fps',
      framebufferScale: 1.2,
      fixedFoveation: 0,
    });

    expect(parseSettingsUrlOverrides('?perf=0&quality=invalid&scale=9&fov=0.5')).toEqual({
      showFps: false,
      fixedFoveation: 0.5,
    });

    const memory = createMemoryStorageAdapter({
      version: SETTINGS_SCHEMA_VERSION,
      settings: {
        ...DEFAULT_SETTINGS,
        showFps: false,
        qualityTier: 'max-beauty',
        framebufferScale: 1.15,
        fixedFoveation: 0.5,
      },
    });

    const store = createSettingsStore({
      adapter: memory,
      search: '?perf&quality=balanced&scale=1.0&fov=1',
    });

    // Active values reflect URL overrides
    expect(store.get().showFps).toBe(true);
    expect(store.get().qualityTier).toBe('balanced');
    expect(store.get().framebufferScale).toBe(1.0);
    expect(store.get().fixedFoveation).toBe(1);
    expect(store.getOverrides()).toEqual({
      showFps: true,
      qualityTier: 'balanced',
      framebufferScale: 1.0,
      fixedFoveation: 1,
    });

    // Persisted storage was NOT overwritten merely by loading URL overrides
    expect(store.getPersisted().showFps).toBe(false);
    expect(memory.read()?.settings.showFps).toBe(false);

    // Explicitly toggling showFps overrides the URL flag and persists
    expect(store.set('showFps', false)).toBe(true);
    expect(store.get().showFps).toBe(false);
    expect(store.getOverrides().showFps).toBeUndefined();
    expect(memory.read()?.settings.showFps).toBe(false);
  });

  it('preserves fixedFoveation across qualityTier changes and notifies subscribers accurately', () => {
    const store = createSettingsStore({ adapter: createMemoryStorageAdapter(), search: '' });
    const listener = vi.fn();
    const unsub = store.subscribe(listener);

    store.set('fixedFoveation', 1);
    store.set('qualityTier', 'high-fps');
    expect(store.get().fixedFoveation).toBe(1);
    expect(store.get().qualityTier).toBe('high-fps');

    // No-op update does not trigger listener
    const beforeCalls = listener.mock.calls.length;
    expect(store.set('qualityTier', 'high-fps')).toBe(false);
    expect(listener.mock.calls.length).toBe(beforeCalls);

    // Invalid value via cast is ignored
    expect(store.set('fixedFoveation', 0.33 as Settings['fixedFoveation'])).toBe(false);
    expect(store.get().fixedFoveation).toBe(1);

    // Check changedKeys payload
    const lastCall = listener.mock.calls[listener.mock.calls.length - 1];
    expect(lastCall?.[2]).toEqual(['qualityTier']);

    unsub();
    store.set('playArc', 'full-360');
    expect(listener.mock.calls.length).toBe(beforeCalls);
  });

  it('resets to defaults, clears overrides, and supports async adapter hydration for P2 IndexedDB', async () => {
    let remoteEnvelope: StoredSettingsEnvelope | null = {
      version: SETTINGS_SCHEMA_VERSION,
      settings: {
        ...DEFAULT_SETTINGS,
        playArc: 'full-360',
        roomOcclusion: 'off',
        musicVolume: 0.35,
      },
    };
    const writeAsync = vi.fn(async (env: StoredSettingsEnvelope) => {
      remoteEnvelope = env;
    });
    const asyncAdapter: SettingsStorageAdapter = {
      read: () => null,
      write: () => undefined,
      remove: () => {
        remoteEnvelope = null;
      },
      readAsync: async () => remoteEnvelope,
      writeAsync,
    };

    const store = createSettingsStore({ adapter: asyncAdapter, search: '?perf' });
    expect(store.get().showFps).toBe(true);
    expect(store.get().playArc).toBe('front-180');

    await store.hydrateFromAdapter();
    expect(store.get().playArc).toBe('full-360');
    expect(store.get().roomOcclusion).toBe('off');
    expect(store.get().musicVolume).toBe(0.35);
    // Startup URL override stays applied on top of hydrated persisted values
    expect(store.get().showFps).toBe(true);

    // Reset restores defaults and clears overrides
    const afterReset = store.reset();
    expect(afterReset).toEqual(DEFAULT_SETTINGS);
    expect(store.getOverrides()).toEqual({});
    expect(writeAsync).toHaveBeenCalled();
  });
});

describe('settings/panel (DOM + XR live store sync)', () => {
  beforeEach(() => {
    clearLocalStorage();
    document.body.innerHTML = '';
  });

  it('renders DOM overlay, syncs bidirectionally with store, shows XR re-entry notice, and traps Escape', () => {
    const store = createSettingsStore({ adapter: createMemoryStorageAdapter(), search: '' });
    const onClose = vi.fn();
    const domPanel = createDomSettingsPanel(store, {
      container: document.body,
      initialOpen: true,
      onClose,
    });

    expect(domPanel.open).toBe(true);
    expect(domPanel.element.hidden).toBe(false);

    const scaleNote = domPanel.element.querySelector('[data-settings-note="framebufferScale"]');
    expect(scaleNote?.textContent).toContain('XR re-entry');
    expect((scaleNote as HTMLElement).dataset.pending).toBe('false');

    // Change framebufferScale via DOM select
    const scaleSelect = domPanel.element.querySelector(
      'select[data-setting-key="framebufferScale"]',
    ) as HTMLSelectElement;
    scaleSelect.value = '1.2';
    scaleSelect.dispatchEvent(new Event('change'));
    expect(store.get().framebufferScale).toBe(1.2);

    // Mark active XR session with scale 1.15 -> highlights pending XR re-entry
    domPanel.setXrStatus({
      inSession: true,
      appliedFramebufferScale: 1.15,
      reportedFoveation: 0.5,
    });
    expect(scaleNote?.textContent).toContain('active XR scale: 1.15x');
    expect((scaleNote as HTMLElement).dataset.pending).toBe('true');

    const fovNote = domPanel.element.querySelector('[data-settings-note="fixedFoveation"]');
    expect(fovNote?.textContent).toContain('0.50');

    // Volume slider updates store and readout
    const masterInput = domPanel.element.querySelector(
      'input[data-setting-key="masterVolume"]',
    ) as HTMLInputElement;
    masterInput.value = '0.45';
    masterInput.dispatchEvent(new Event('input'));
    expect(store.get().masterVolume).toBe(0.45);
    const masterReadout = domPanel.element.querySelector('[data-setting-readout="masterVolume"]');
    expect(masterReadout?.textContent).toBe('45%');

    // Escape closes overlay and stops propagation so game shortcuts don't fire
    const leakedKey = vi.fn();
    window.addEventListener('keydown', leakedKey);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(domPanel.open).toBe(false);
    expect(domPanel.element.hidden).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(leakedKey).not.toHaveBeenCalled();
    window.removeEventListener('keydown', leakedKey);

    // Reset button restores defaults
    domPanel.show();
    const resetBtn = domPanel.element.querySelector(
      '[data-settings-action="reset"]',
    ) as HTMLButtonElement;
    resetBtn.click();
    expect(store.get()).toEqual(DEFAULT_SETTINGS);

    domPanel.dispose();
    expect(domPanel.element.isConnected).toBe(false);
  });

  it('builds XR panel via createMenuPanel + keepAbove and shares exact live state with DOM panel', () => {
    const store = createSettingsStore({ adapter: createMemoryStorageAdapter(), search: '' });
    const domPanel = createDomSettingsPanel(store, {
      container: document.body,
      initialOpen: true,
    });
    const onXrClose = vi.fn();
    const xrPanel = createXrSettingsPanel(store, {
      initialVisible: true,
      onClose: onXrClose,
    });

    expect(xrPanel.visible).toBe(true);
    expect(xrPanel.root.renderOrder).toBe(OVERLAY_RENDER_ORDER);
    expect(xrPanel.panel.root.renderOrder).toBe(OVERLAY_RENDER_ORDER);
    expect(xrPanel.panel.pageCount).toBe(2);

    // Check XR re-entry note exists as a non-interactive label on page 1
    const scaleNoteMesh = xrPanel.panel.root.getObjectByName('settings-framebuffer-scale-note');
    expect(scaleNoteMesh?.userData.labelText).toContain('XR re-entry');

    // Activating controls in XR updates the shared store AND the DOM panel immediately
    expect(xrPanel.activate('show-fps')).toBe(true);
    expect(store.get().showFps).toBe(true);
    const domCheckbox = domPanel.element.querySelector(
      'input[data-setting-key="showFps"]',
    ) as HTMLInputElement;
    expect(domCheckbox.checked).toBe(true);

    expect(xrPanel.activate('framebuffer-scale')).toBe(true);
    expect(store.get().framebufferScale).toBe(1.2);

    // XR status updates scale pending notice on XR panel too
    xrPanel.setXrStatus({
      inSession: true,
      appliedFramebufferScale: 1.15,
      reportedFoveation: 0.5,
    });
    expect(scaleNoteMesh?.userData.labelText).toContain('pending XR re-entry');

    // Navigate to page 2 (audio + occlusion + reset)
    expect(xrPanel.activate('next')).toBe(true);
    expect(xrPanel.panel.page).toBe(1);
    expect(xrPanel.activate('room-occlusion')).toBe(true);
    expect(store.get().roomOcclusion).toBe('room-mesh');
    expect(xrPanel.activate('show-room-mesh')).toBe(true);
    expect(store.get().showRoomMesh).toBe(true);
    expect(
      domPanel.element.querySelector<HTMLInputElement>('[data-setting-key="showRoomMesh"]')
        ?.checked,
    ).toBe(true);
    expect(xrPanel.activate('master-down')).toBe(true);
    expect(store.get().masterVolume).toBe(0.9);

    // Reset from XR resets DOM as well
    expect(xrPanel.activate('reset')).toBe(true);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(domCheckbox.checked).toBe(false);

    // Close hides XR panel and fires callback
    expect(xrPanel.activate('close')).toBe(true);
    expect(xrPanel.visible).toBe(false);
    expect(onXrClose).toHaveBeenCalledTimes(1);

    xrPanel.dispose();
    domPanel.dispose();
  });
});
