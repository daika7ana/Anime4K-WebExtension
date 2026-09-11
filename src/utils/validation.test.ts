import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  EFFECT_PARAM_BOUNDS,
  MODES_IMPORT_VERSION,
  formatValidationIssues,
  isPerformanceTier,
  isValidResolutionSetting,
  parseAndValidateModesImport,
  sanitizeColorGrading,
  sanitizeCustomModes,
  sanitizeWhitelist,
  validateColorGrading,
  validateGPUBenchmarkResult,
  validateModesImport,
} from './validation';
import { AVAILABLE_EFFECTS } from './effects-map';
import type { EnhancementEffect, GPUBenchmarkResult } from '../types';

const CAS = AVAILABLE_EFFECTS.find(e => e.className === 'CAS')!;
const DEBANDING = AVAILABLE_EFFECTS.find(e => e.className === 'Debanding')!;
const CLAMP = AVAILABLE_EFFECTS.find(e => e.className === 'ClampHighlights')!;

afterEach(() => {
  vi.restoreAllMocks();
});

/** Minimal shape of a valid exported custom mode. */
function validMode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'My Mode',
    effects: [
      { id: CLAMP.id },
      { id: CAS.id, params: { sharpness: 0.7 } },
      { id: DEBANDING.id, params: { strength: 0.3, bandThreshold: 0.05 } },
    ],
    ...overrides,
  };
}

describe('validateModesImport', () => {
  it('accepts a valid legacy array and normalizes effects', () => {
    const result = validateModesImport([validMode()]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(1);
    const mode = result.value[0];
    expect(mode.name).toBe('My Mode');
    expect(mode.isBuiltIn).toBe(false);
    expect(mode.id).toMatch(/^custom-/);
    expect(mode.effects.map(e => e.id)).toEqual([CLAMP.id, CAS.id, DEBANDING.id]);
    expect(mode.effects.find(e => e.id === CAS.id)?.params).toEqual({ sharpness: 0.7 });
  });

  it('preserves effect order from the payload', () => {
    const reversed = [validMode(), validMode({ name: 'Reversed', effects: [{ id: CAS.id }, { id: CLAMP.id }] })];
    const result = validateModesImport(reversed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[1].effects.map(e => e.id)).toEqual([CAS.id, CLAMP.id]);
  });

  it('accepts a versioned { version, modes } envelope', () => {
    const result = validateModesImport({ version: MODES_IMPORT_VERSION, modes: [validMode()] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
  });

  it('accepts an empty modes array', () => {
    const result = validateModesImport([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it('rejects an unsupported schema version', () => {
    const result = validateModesImport({ version: 99, modes: [validMode()] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some(i => i.path === 'version' && /Unsupported version/.test(i.message))).toBe(true);
  });

  it('rejects an envelope missing the version field', () => {
    const result = validateModesImport({ modes: [validMode()] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some(i => i.path === 'version')).toBe(true);
  });

  it('rejects an envelope missing the modes array', () => {
    const result = validateModesImport({ version: MODES_IMPORT_VERSION });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some(i => i.path === 'modes')).toBe(true);
  });

  it('rejects a non-array, non-envelope payload', () => {
    const result = validateModesImport('not-a-payload');
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown effect id', () => {
    const result = validateModesImport([
      validMode({ effects: [{ id: 'evil/UnknownEffect' }] }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.issues.some(
        i => i.path === 'modes[0].effects[0].id' && /Unknown effect id/.test(i.message),
      ),
    ).toBe(true);
  });

  it('rejects an effect with a missing id', () => {
    const result = validateModesImport([validMode({ effects: [{}] })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some(i => /missing a valid id/.test(i.message))).toBe(true);
  });

  it('rejects an out-of-range numeric param', () => {
    const result = validateModesImport([
      validMode({ effects: [{ id: CAS.id, params: { sharpness: 5 } }] }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issue = result.issues.find(i => i.path === 'modes[0].effects[0].params.sharpness');
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/between 0 and 1/);
  });

  it('rejects a non-numeric param', () => {
    const result = validateModesImport([
      validMode({ effects: [{ id: CAS.id, params: { sharpness: 'high' } }] }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some(i => /finite number/.test(i.message))).toBe(true);
  });

  it('rejects an unknown param key', () => {
    const result = validateModesImport([
      validMode({ effects: [{ id: CAS.id, params: { bogus: 1 } }] }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some(i => /Unknown parameter/.test(i.message))).toBe(true);
  });

  it('rejects a mode missing its name', () => {
    const result = validateModesImport([{ effects: [] }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some(i => i.path === 'modes[0].name')).toBe(true);
  });

  it('rejects a mode missing its effects array', () => {
    const result = validateModesImport([{ name: 'No effects' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some(i => i.path === 'modes[0].effects')).toBe(true);
  });

  it('rejects a mixed valid + invalid payload atomically (no partial value)', () => {
    const result = validateModesImport([
      validMode(),
      { name: 'Broken', effects: [{ id: 'nope/Effect' }] },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Failure carries issues only; callers cannot apply a partial import.
    expect(result).not.toHaveProperty('value');
    expect(result.issues.some(i => i.path === 'modes[1].effects[0].id')).toBe(true);
  });
});

describe('parseAndValidateModesImport', () => {
  it('returns a structured error for malformed JSON', () => {
    const result = parseAndValidateModesImport('{ this is not json ');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].message).toMatch(/not valid JSON/i);
  });

  it('parses and validates valid JSON', () => {
    const result = parseAndValidateModesImport(JSON.stringify([validMode()]));
    expect(result.ok).toBe(true);
  });
});

describe('formatValidationIssues', () => {
  it('formats paths and truncates long lists', () => {
    const issues = [
      { path: 'modes[0].name', message: 'required' },
      { path: 'modes[1].id', message: 'unknown' },
      { path: 'modes[2].id', message: 'unknown' },
      { path: 'modes[3].id', message: 'unknown' },
    ];
    const text = formatValidationIssues(issues, 2);
    expect(text).toBe('modes[0].name: required; modes[1].id: unknown (+2 more)');
  });

  it('handles an empty issue list defensively', () => {
    expect(formatValidationIssues([])).toBe('Unknown validation error');
  });
});

describe('EFFECT_PARAM_BOUNDS', () => {
  it('matches the catalog default for every bounded parameter', () => {
    for (const [className, params] of Object.entries(EFFECT_PARAM_BOUNDS)) {
      const catalog = AVAILABLE_EFFECTS.find(e => e.className === className);
      expect(catalog, `catalog effect ${className}`).toBeDefined();
      for (const [key, bound] of Object.entries(params)) {
        expect(catalog?.params?.[key], `${className}.${key}`).toBe(bound.defaultValue);
      }
    }
  });

  it('covers every parameter exposed by the catalog', () => {
    for (const effect of AVAILABLE_EFFECTS) {
      if (!effect.params) continue;
      const bounds = EFFECT_PARAM_BOUNDS[effect.className];
      expect(bounds, `bounds for ${effect.className}`).toBeDefined();
      for (const key of Object.keys(effect.params)) {
        expect(bounds?.[key], `${effect.className}.${key}`).toBeDefined();
      }
    }
  });
});

describe('sanitizeCustomModes', () => {
  it('returns [] for a non-array value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(sanitizeCustomModes('nope')).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('preserves valid modes, ids and order', () => {
    const input = [
      { id: 'custom-keep', name: 'Keep', isBuiltIn: false, effects: [{ id: CAS.id, params: { sharpness: 0.9 } }] },
    ];
    const result = sanitizeCustomModes(input);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('custom-keep');
    expect(result[0].name).toBe('Keep');
    expect(result[0].effects[0].params).toEqual({ sharpness: 0.9 });
  });

  it('drops unknown effects instead of poisoning the chain', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const input = [
      { id: 'custom-1', name: 'M', isBuiltIn: false, effects: [{ id: 'nope/Effect' }, { id: CAS.id }] },
    ];
    const result = sanitizeCustomModes(input);
    expect(result[0].effects.map(e => e.id)).toEqual([CAS.id]);
  });

  it('falls back to catalog defaults for out-of-range params', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const input = [
      { id: 'custom-1', name: 'M', isBuiltIn: false, effects: [{ id: CAS.id, params: { sharpness: 42 } }] },
    ];
    const result = sanitizeCustomModes(input);
    const params = result[0].effects[0].params as Record<string, number>;
    expect(params.sharpness).toBe(0.5);
  });

  it('drops modes missing required fields', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const input = [
      { id: 'bad-1', effects: [] },
      { id: 'bad-2', name: 'No effects' },
      { id: 'good', name: 'Good', effects: [CAS] as unknown[] },
    ];
    const result = sanitizeCustomModes(input);
    expect(result.map(m => m.id)).toEqual(['good']);
  });
});

describe('sanitizeColorGrading / validateColorGrading', () => {
  it('keeps valid values and falls back on invalid ones', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = sanitizeColorGrading({
      enabled: true,
      brightness: 0.5,
      gamma: 99,
      contrast: 'nope',
    });
    expect(result.enabled).toBe(true);
    expect(result.brightness).toBe(0.5);
    expect(result.gamma).toBe(1);
    expect(result.contrast).toBe(1);
  });

  it('returns defaults for a non-object', () => {
    const result = sanitizeColorGrading(undefined);
    expect(result).toEqual({
      enabled: false,
      brightness: 0,
      gamma: 1,
      contrast: 1,
      saturation: 1,
      vibrance: 0,
      exposure: 0,
    });
  });

  it('strict validator rejects out-of-range fields', () => {
    const result = validateColorGrading({
      enabled: false,
      brightness: 0,
      gamma: 1,
      contrast: 1,
      saturation: 1,
      vibrance: 0,
      exposure: 5,
    });
    expect(result.ok).toBe(false);
  });
});

describe('sanitizeWhitelist', () => {
  it('drops invalid rules and keeps valid ones', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = sanitizeWhitelist([
      { pattern: 'a.com', enabled: true },
      { pattern: '', enabled: true },
      { pattern: 'b.com', enabled: 'yes' },
      null,
    ]);
    expect(result).toEqual([{ pattern: 'a.com', enabled: true }]);
  });
});

describe('settings field guards', () => {
  it('isPerformanceTier accepts only known tiers', () => {
    expect(isPerformanceTier('balanced')).toBe(true);
    expect(isPerformanceTier('turbo')).toBe(false);
    expect(isPerformanceTier(5)).toBe(false);
  });

  it('isValidResolutionSetting accepts only known resolutions', () => {
    expect(isValidResolutionSetting('x4')).toBe(true);
    expect(isValidResolutionSetting('native')).toBe(true);
    expect(isValidResolutionSetting('display')).toBe(true);
    expect(isValidResolutionSetting('bogus')).toBe(false);
  });
});

describe('validateGPUBenchmarkResult', () => {
  const valid: GPUBenchmarkResult = {
    tier: 'balanced',
    scores: { performance: 10, balanced: 20, quality: 30, ultra: 40 },
    maxScores: { performance: 11, balanced: 21, quality: 31, ultra: 41 },
    timestamp: 123,
    adapterInfo: 'mock',
  };

  it('accepts null and undefined', () => {
    expect(validateGPUBenchmarkResult(null).ok).toBe(true);
    expect(validateGPUBenchmarkResult(undefined).ok).toBe(true);
  });

  it('accepts a valid result', () => {
    const result = validateGPUBenchmarkResult(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ tier: 'balanced' });
  });

  it('rejects a NaN score', () => {
    const result = validateGPUBenchmarkResult({
      ...valid,
      scores: { ...valid.scores, balanced: Number.NaN },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an invalid tier', () => {
    const result = validateGPUBenchmarkResult({ ...valid, tier: 'turbo' });
    expect(result.ok).toBe(false);
  });

  it('accepts Infinity scores (untested tiers keep Infinity)', () => {
    const result = validateGPUBenchmarkResult({
      ...valid,
      scores: { ...valid.scores, ultra: Number.POSITIVE_INFINITY },
    });
    expect(result.ok).toBe(true);
  });
});

// Guard against accidental catalog drift in the test fixture itself.
describe('test fixtures', () => {
  it('references effects that exist', () => {
    const ids: EnhancementEffect[] = [CAS, DEBANDING, CLAMP];
    expect(ids.every(e => AVAILABLE_EFFECTS.includes(e))).toBe(true);
  });
});
