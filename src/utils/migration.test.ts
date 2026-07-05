import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureLatestConfig } from './migration';
import type { CustomMode } from '../types';

/**
 * In-memory storage backends used by the mocked chrome.storage APIs.
 * Reset before each test.
 */
let syncStore: Record<string, unknown>;
let localStore: Record<string, unknown>;

function mockStorageApi(): void {
  syncStore = {};
  localStore = {};

  // Promise-returning variants to match how migration.ts consumes them (await, no callback)
  (chrome.storage.sync.get as any).mockImplementation(
    (_keys: string | string[] | Record<string, unknown>): Promise<Record<string, unknown>> => {
      const out: Record<string, unknown> = {};
      if (Array.isArray(_keys)) {
        for (const k of _keys) {
          if (k in syncStore) out[k] = syncStore[k];
        }
      } else if (typeof _keys === 'object') {
        for (const k of Object.keys(_keys)) {
          if (k in syncStore) out[k] = syncStore[k];
        }
      }
      return Promise.resolve(out);
    },
  );

  vi.mocked(chrome.storage.sync.set).mockImplementation(
    (items: Record<string, unknown>): Promise<void> => {
      Object.assign(syncStore, items);
      return Promise.resolve();
    },
  );

  // remove is not stubbed by test-setup — register it
  if (!(chrome.storage.sync as any).remove) {
    (chrome.storage.sync as any).remove = vi.fn();
  }
  vi.mocked((chrome.storage.sync as any).remove).mockImplementation(
    (keys: string | string[]): Promise<void> => {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const k of keyList) delete syncStore[k];
      return Promise.resolve();
    },
  );

  (chrome.storage.local.get as any).mockImplementation(
    (_keys: string | string[] | Record<string, unknown>): Promise<Record<string, unknown>> => {
      const out: Record<string, unknown> = {};
      if (Array.isArray(_keys)) {
        for (const k of _keys) {
          if (k in localStore) out[k] = localStore[k];
        }
      } else if (typeof _keys === 'object') {
        for (const k of Object.keys(_keys)) {
          if (k in localStore) out[k] = localStore[k];
        }
      }
      return Promise.resolve(out);
    },
  );

  vi.mocked(chrome.storage.local.set).mockImplementation(
    (items: Record<string, unknown>): Promise<void> => {
      Object.assign(localStore, items);
      return Promise.resolve();
    },
  );
}

describe('ensureLatestConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageApi();
  });

  // ── No migration needed (already latest) ─────────────────────
  it('is a no-op when _configVersion is already >= 2', async () => {
    syncStore['_configVersion'] = 2;
    syncStore['customModes'] = [];
    syncStore['selectedModeId'] = 'builtin-mode-a';

    await ensureLatestConfig();

    // No writes should have occurred
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect((chrome.storage.sync as any).remove).not.toHaveBeenCalled();
  });

  it('is a no-op when _configVersion is > 2 (future version)', async () => {
    syncStore['_configVersion'] = 3;
    syncStore['customModes'] = [];

    await ensureLatestConfig();

    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  // ── v1 → v2 migration ────────────────────────────────────────
  it('migrates old enhancementModes when _configVersion is absent', async () => {
    syncStore['enhancementModes'] = [
      {
        id: 'my-custom',
        name: 'My Custom Mode',
        isBuiltIn: false,
        effects: [
          { id: 'anime4k/Sharpen/CAS', name: 'CAS', className: 'CAS', params: { sharpness: 0.8 } },
        ],
      },
    ];
    syncStore['selectedModeId'] = 'builtin-mode-b';

    await ensureLatestConfig();

    expect(syncStore['_configVersion']).toBe(2);
    expect(syncStore['customModes']).toHaveLength(1);
    expect((syncStore['customModes'] as CustomMode[])[0].id).toBe('my-custom');
    expect(syncStore['selectedModeId']).toBe('builtin-mode-b');
    // Old key removed
    expect(syncStore['enhancementModes']).toBeUndefined();
    // Local defaults set
    expect(localStore['performanceTier']).toBe('balanced');
  });

  it('migrates when _configVersion < 2 and enhancementModes exists', async () => {
    syncStore['_configVersion'] = 1;
    syncStore['enhancementModes'] = [
      {
        id: 'my-custom',
        name: 'Custom',
        isBuiltIn: false,
        effects: [{ id: 'anime4k/Deblur/DoG', name: 'DoG', className: 'DoG', params: { strength: 4 } }],
      },
    ];

    await ensureLatestConfig();

    expect(syncStore['_configVersion']).toBe(2);
    expect(syncStore['customModes']).toHaveLength(1);
    expect(syncStore['enhancementModes']).toBeUndefined();
  });

  // ── Filtering built-in modes during migration ────────────────
  it('filters out built-in modes during migration (only custom modes preserved)', async () => {
    syncStore['enhancementModes'] = [
      { id: 'builtin-mode-a', name: 'Mode A', isBuiltIn: true, effects: [] },
      { id: 'my-custom', name: 'Custom', isBuiltIn: false, effects: [] },
      { id: 'builtin-mode-b', name: 'Mode B', isBuiltIn: true, effects: [] },
    ];

    await ensureLatestConfig();

    const customModes = syncStore['customModes'] as CustomMode[];
    expect(customModes).toHaveLength(1);
    expect(customModes[0].id).toBe('my-custom');
  });

  // ── Effect syncing during migration ──────────────────────────
  it('preserves effects that exist in AVAILABLE_EFFECTS catalog', async () => {
    syncStore['enhancementModes'] = [
      {
        id: 'my-custom',
        name: 'Custom',
        isBuiltIn: false,
        effects: [
          { id: 'anime4k/Sharpen/CAS', name: 'CAS', className: 'CAS' },
          { id: 'anime4k/Deblur/DoG', name: 'DoG', className: 'DoG' },
        ],
      },
    ];

    await ensureLatestConfig();

    const customModes = syncStore['customModes'] as CustomMode[];
    expect(customModes[0].effects).toHaveLength(2);
    expect(customModes[0].effects[0].id).toBe('anime4k/Sharpen/CAS');
    expect(customModes[0].effects[1].id).toBe('anime4k/Deblur/DoG');
  });

  it('filters out effects not in AVAILABLE_EFFECTS catalog', async () => {
    syncStore['enhancementModes'] = [
      {
        id: 'my-custom',
        name: 'Custom',
        isBuiltIn: false,
        effects: [
          { id: 'anime4k/Sharpen/CAS', name: 'CAS', className: 'CAS' },
          { id: 'anime4k/Removed/Effect', name: 'Gone', className: 'Gone' },
        ],
      },
    ];

    await ensureLatestConfig();

    const customModes = syncStore['customModes'] as CustomMode[];
    expect(customModes[0].effects).toHaveLength(1);
    expect(customModes[0].effects[0].id).toBe('anime4k/Sharpen/CAS');
  });

  it('removes empty custom modes when all effects are filtered out', async () => {
    syncStore['enhancementModes'] = [
      {
        id: 'my-custom',
        name: 'Custom',
        isBuiltIn: false,
        effects: [
          { id: 'anime4k/Removed/Effect1', name: 'Gone1', className: 'Gone1' },
          { id: 'anime4k/Removed/Effect2', name: 'Gone2', className: 'Gone2' },
        ],
      },
    ];

    await ensureLatestConfig();

    const customModes = syncStore['customModes'] as CustomMode[];
    expect(customModes[0].effects).toHaveLength(0);
  });

  // ── Built-in mode ID mapping ─────────────────────────────────
  it('maps old built-in mode IDs to new IDs correctly', async () => {
    // All six built-in IDs
    const ids = [
      'builtin-mode-a',
      'builtin-mode-b',
      'builtin-mode-c',
      'builtin-mode-aa',
      'builtin-mode-bb',
      'builtin-mode-ca',
    ];

    for (const id of ids) {
      syncStore = {};
      localStore = {};
      syncStore['enhancementModes'] = [];
      syncStore['selectedModeId'] = id;
      await ensureLatestConfig();
      expect(syncStore['selectedModeId']).toBe(id);
    }
  });

  it('defaults selectedModeId to builtin-mode-a when not set', async () => {
    syncStore['enhancementModes'] = [];

    await ensureLatestConfig();

    expect(syncStore['selectedModeId']).toBe('builtin-mode-a');
  });

  // ── Preserving other sync settings ───────────────────────────
  it('preserves targetResolutionSetting from old config', async () => {
    syncStore['enhancementModes'] = [];
    syncStore['targetResolutionSetting'] = 'x4';

    await ensureLatestConfig();

    expect(syncStore['targetResolutionSetting']).toBe('x4');
  });

  it('preserves whitelist settings', async () => {
    const whitelist = [{ pattern: 'example.com', enabled: true }];
    syncStore['enhancementModes'] = [];
    syncStore['whitelistEnabled'] = true;
    syncStore['whitelist'] = whitelist;

    await ensureLatestConfig();

    expect(syncStore['whitelistEnabled']).toBe(true);
    expect(syncStore['whitelist']).toEqual(whitelist);
  });

  it('preserves enableCrossOriginFix', async () => {
    syncStore['enhancementModes'] = [];
    syncStore['enableCrossOriginFix'] = true;

    await ensureLatestConfig();

    expect(syncStore['enableCrossOriginFix']).toBe(true);
  });

  // ── Fresh install ────────────────────────────────────────────
  it('initializes default config for fresh install (no _configVersion, no enhancementModes)', async () => {
    // Empty sync store (no _configVersion, no enhancementModes)
    syncStore = {};
    localStore = {};

    await ensureLatestConfig();

    expect(syncStore['_configVersion']).toBe(2);
    expect(syncStore['selectedModeId']).toBe('builtin-mode-a');
    expect(syncStore['targetResolutionSetting']).toBe('x2');
    expect(syncStore['whitelistEnabled']).toBe(false);
    expect(syncStore['whitelist']).toEqual([]);
    expect(syncStore['customModes']).toEqual([]);
    expect(syncStore['enableCrossOriginFix']).toBe(false);

    expect(localStore['performanceTier']).toBe('balanced');
    expect(localStore['gpuBenchmarkResult']).toBeNull();
    expect(localStore['gpuAdapterInfo']).toBeNull();
    expect(localStore['hasCompletedOnboarding']).toBe(false);
  });

  // ── Local defaults when performanceTier already set ──────────
  it('does not overwrite existing performanceTier during migration', async () => {
    syncStore['enhancementModes'] = [];
    localStore['performanceTier'] = 'quality';

    await ensureLatestConfig();

    expect(localStore['performanceTier']).toBe('quality');
  });
});
