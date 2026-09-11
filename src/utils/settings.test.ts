import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  synchronizeEffectsForCustomModes,
  getEffectsForMode,
  getSettings,
  getLocalSettings,
  normalizeSyncedSettings,
  normalizeLocalSettings,
  BUILTIN_MODES,
} from './settings';

// Capture the storage-change listener registered by settings.ts at import time.
// Restoring mocks between tests can clear `mock.calls`, so hold the reference now.
const capturedOnChanged = (
  chrome.storage.onChanged.addListener as unknown as { mock: { calls: unknown[][] } }
).mock.calls[0]?.[0] as (() => void) | undefined;
import { AVAILABLE_EFFECTS } from './effects-map';
import { resolveEffectChain } from './effect-chain-templates';
import type { CustomMode, BuiltInMode, PerformanceTier } from '../types';

describe('BUILTIN_MODES', () => {
  it('contains exactly 6 modes', () => {
    expect(BUILTIN_MODES).toHaveLength(6);
  });

  it('each mode has required fields', () => {
    for (const mode of BUILTIN_MODES) {
      expect(mode).toHaveProperty('id');
      expect(mode).toHaveProperty('baseMode');
      expect(mode).toHaveProperty('name');
      expect(mode.isBuiltIn).toBe(true);
    }
  });

  it('covers all base modes', () => {
    const baseModes = BUILTIN_MODES.map(m => m.baseMode);
    expect(baseModes).toContain('A');
    expect(baseModes).toContain('B');
    expect(baseModes).toContain('C');
    expect(baseModes).toContain('A+A');
    expect(baseModes).toContain('B+B');
    expect(baseModes).toContain('C+A');
  });
});

describe('synchronizeEffectsForCustomModes', () => {
  it('returns empty array for empty input', () => {
    expect(synchronizeEffectsForCustomModes([])).toEqual([]);
  });

  it('preserves mode structure', () => {
    const modes: CustomMode[] = [
      { id: 'custom-1', name: 'My Mode', isBuiltIn: false, effects: [] },
    ];
    const result = synchronizeEffectsForCustomModes(modes);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('custom-1');
    expect(result[0].name).toBe('My Mode');
    expect(result[0].isBuiltIn).toBe(false);
  });

  it('resolves effect IDs to catalog effects', () => {
    const casEffect = AVAILABLE_EFFECTS.find(e => e.className === 'CAS')!;
    const modes: CustomMode[] = [
      {
        id: 'custom-1',
        name: 'Test',
        isBuiltIn: false,
        effects: [{ id: casEffect.id, name: 'Old Name', className: 'CAS' }],
      },
    ];
    const result = synchronizeEffectsForCustomModes(modes);
    expect(result[0].effects[0].name).toBe(casEffect.name);
  });

  it('preserves user-customized params over catalog defaults', () => {
    const casEffect = AVAILABLE_EFFECTS.find(e => e.className === 'CAS')!;
    const modes: CustomMode[] = [
      {
        id: 'custom-1',
        name: 'Test',
        isBuiltIn: false,
        effects: [{ ...casEffect, params: { sharpness: 0.9 } }],
      },
    ];
    const result = synchronizeEffectsForCustomModes(modes);
    expect(result[0].effects[0].params).toEqual({ sharpness: 0.9 });
  });

  it('drops effects whose IDs are not in the catalog', () => {
    const modes: CustomMode[] = [
      {
        id: 'custom-1',
        name: 'Test',
        isBuiltIn: false,
        effects: [
          { id: 'nonexistent/effect', name: 'Ghost', className: 'Ghost' },
        ],
      },
    ];
    const result = synchronizeEffectsForCustomModes(modes);
    expect(result[0].effects).toHaveLength(0);
  });

  it('handles multiple modes independently', () => {
    const casEffect = AVAILABLE_EFFECTS.find(e => e.className === 'CAS')!;
    const modes: CustomMode[] = [
      { id: 'c1', name: 'Mode 1', isBuiltIn: false, effects: [casEffect] },
      { id: 'c2', name: 'Mode 2', isBuiltIn: false, effects: [] },
    ];
    const result = synchronizeEffectsForCustomModes(modes);
    expect(result).toHaveLength(2);
    expect(result[0].effects).toHaveLength(1);
    expect(result[1].effects).toHaveLength(0);
  });
});

describe('getEffectsForMode', () => {
  it('resolves built-in mode effects based on tier', () => {
    const mode: BuiltInMode = { id: 'builtin-mode-a', baseMode: 'A', name: 'Mode A', isBuiltIn: true };
    const effects = getEffectsForMode(mode, 'balanced');
    // Should match resolveEffectChain('A', 'balanced')
    const expected = resolveEffectChain('A', 'balanced');
    expect(effects).toEqual(expected);
  });

  it('returns different effects for different tiers', () => {
    const mode: BuiltInMode = { id: 'builtin-mode-a', baseMode: 'A', name: 'Mode A', isBuiltIn: true };
    const perfEffects = getEffectsForMode(mode, 'performance');
    const qualityEffects = getEffectsForMode(mode, 'quality');
    // Performance and quality should have different effect chains
    expect(perfEffects.map(e => e.className)).not.toEqual(qualityEffects.map(e => e.className));
  });

  it('returns custom mode effects directly without tier resolution', () => {
    const casEffect = AVAILABLE_EFFECTS.find(e => e.className === 'CAS')!;
    const mode: CustomMode = {
      id: 'custom-1',
      name: 'My Custom',
      isBuiltIn: false,
      effects: [casEffect],
    };
    const effects = getEffectsForMode(mode, 'performance');
    expect(effects).toEqual([casEffect]);
  });

  it('custom mode ignores tier parameter', () => {
    const casEffect = AVAILABLE_EFFECTS.find(e => e.className === 'CAS')!;
    const mode: CustomMode = {
      id: 'custom-1',
      name: 'My Custom',
      isBuiltIn: false,
      effects: [casEffect],
    };
    expect(getEffectsForMode(mode, 'performance')).toEqual(getEffectsForMode(mode, 'ultra'));
  });

  it('each built-in base mode resolves to non-empty effects for each tier', () => {
    const tiers: PerformanceTier[] = ['performance', 'balanced', 'quality', 'ultra'];
    for (const builtin of BUILTIN_MODES) {
      for (const tier of tiers) {
        const effects = getEffectsForMode(builtin, tier);
        expect(effects.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('normalizeSyncedSettings', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to defaults for every corrupt field', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = normalizeSyncedSettings({
      selectedModeId: 123,
      targetResolutionSetting: 'bogus',
      whitelistEnabled: 'yes',
      whitelist: 'nope',
      customModes: 'nope',
      enableCrossOriginFix: null,
      autoEnableOnWhitelist: 'x',
      enableHotkey: 1,
      colorGrading: { enabled: 'yes', brightness: 5, gamma: 99 },
    });

    expect(result.selectedModeId).toBe('builtin-mode-a');
    expect(result.targetResolutionSetting).toBe('x2');
    expect(result.whitelistEnabled).toBe(false);
    expect(result.whitelist).toEqual([]);
    expect(result.customModes).toEqual([]);
    expect(result.enableCrossOriginFix).toBe(false);
    expect(result.autoEnableOnWhitelist).toBe(false);
    // enableHotkey defaults to true
    expect(result.enableHotkey).toBe(true);
    expect(result.colorGrading).toEqual({
      enabled: false,
      brightness: 0,
      gamma: 1,
      contrast: 1,
      saturation: 1,
      vibrance: 0,
      exposure: 0,
    });
    expect(warn).toHaveBeenCalled();
  });

  it('preserves valid custom modes and settings', () => {
    const result = normalizeSyncedSettings({
      selectedModeId: 'custom-1',
      targetResolutionSetting: 'native',
      whitelistEnabled: true,
      whitelist: [{ pattern: 'example.com', enabled: true }],
      customModes: [
        {
          id: 'custom-1',
          name: 'Mine',
          isBuiltIn: false,
          effects: [{ id: 'anime4k/Sharpen/CAS', params: { sharpness: 0.9 } }],
        },
      ],
      enableCrossOriginFix: true,
      autoEnableOnWhitelist: true,
      enableHotkey: false,
      colorGrading: { enabled: true, brightness: 0.2, gamma: 1.5, contrast: 1, saturation: 1, vibrance: 0, exposure: 0 },
    });

    expect(result.selectedModeId).toBe('custom-1');
    expect(result.targetResolutionSetting).toBe('native');
    expect(result.whitelistEnabled).toBe(true);
    expect(result.customModes).toHaveLength(1);
    expect(result.customModes[0].effects[0].params).toEqual({ sharpness: 0.9 });
    expect(result.enableHotkey).toBe(false);
    expect(result.colorGrading.enabled).toBe(true);
    expect(result.colorGrading.brightness).toBe(0.2);
  });

  it('treats missing fields as defaults without warning', () => {
    const result = normalizeSyncedSettings({});
    expect(result.selectedModeId).toBe('builtin-mode-a');
    expect(result.targetResolutionSetting).toBe('x2');
    expect(result.customModes).toEqual([]);
  });
});

describe('normalizeLocalSettings', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to defaults for corrupt fields', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = normalizeLocalSettings({
      performanceTier: 'turbo',
      gpuBenchmarkResult: { tier: 'nope' },
      hasCompletedOnboarding: 'no',
      showDiagnostics: 1,
    });

    expect(result.performanceTier).toBe('balanced');
    expect(result.gpuBenchmarkResult).toBeNull();
    expect(result.hasCompletedOnboarding).toBe(false);
    expect(result.showDiagnostics).toBe(false);
  });

  it('preserves valid values', () => {
    const result = normalizeLocalSettings({
      performanceTier: 'quality',
      gpuBenchmarkResult: {
        tier: 'quality',
        scores: { performance: 1, balanced: 2, quality: 3, ultra: 4 },
        maxScores: { performance: 1, balanced: 2, quality: 3, ultra: 4 },
        timestamp: 1,
        adapterInfo: 'mock',
      },
      hasCompletedOnboarding: true,
      showDiagnostics: true,
    });

    expect(result.performanceTier).toBe('quality');
    expect(result.gpuBenchmarkResult?.tier).toBe('quality');
    expect(result.hasCompletedOnboarding).toBe(true);
    expect(result.showDiagnostics).toBe(true);
  });
});

describe('getSettings storage read path', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns defaults when stored settings are corrupt and does not throw', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    (chrome.storage.sync.get as any).mockImplementation((_keys: any, cb: any) =>
      cb({ customModes: 'corrupt', selectedModeId: 42, colorGrading: 'bad' }),
    );
    (chrome.storage.local.get as any).mockImplementation((_keys: any, cb: any) =>
      cb({ performanceTier: 'turbo', showDiagnostics: 'yes', gpuBenchmarkResult: { bad: true } }),
    );

    // Invalidate the module-level TTL cache so the corrupt values are re-read.
    capturedOnChanged?.();

    const [settings, local] = await Promise.all([getSettings(), getLocalSettings()]);

    expect(settings.customModes).toEqual([]);
    expect(settings.selectedModeId).toBe('builtin-mode-a');
    expect(settings.performanceTier).toBe('balanced');
    expect(local.showDiagnostics).toBe(false);
    expect(local.gpuBenchmarkResult).toBeNull();
    // Built-ins are always present even with no stored custom modes
    expect(settings.enhancementModes).toHaveLength(BUILTIN_MODES.length);
  });
});
