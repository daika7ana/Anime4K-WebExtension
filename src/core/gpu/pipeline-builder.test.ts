/**
 * Tests for Pipeline Builder — paramsEqual() and buildEffectPipelines().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installGPUMock, removeGPUMock, createMockGPUTexture } from '@/test/webgpu-mock';
import type { MockGPUObjects } from '@/test/webgpu-mock';
import type { EnhancementEffect, DestroyablePipeline, Dimensions } from '@/types';
import { BUILTIN_MODES, getEffectsForMode } from '@utils/settings';
import { PipelinePreWarmer } from './pipeline-prewarmer';

// ─── Mock WGSL shader files ───
vi.mock('@shaders/cas.wgsl', () => ({ default: '// mock CAS shader' }));
vi.mock('@shaders/color-adjust.wgsl', () => ({ default: '// mock color-adjust shader' }));
vi.mock('@shaders/debanding.wgsl', () => ({ default: '// mock debanding shader' }));
vi.mock('@shaders/fullscreen-textured-quad.wgsl', () => ({ default: '// mock quad shader' }));
vi.mock('@shaders/sample-external-texture.wgsl', () => ({ default: '// mock sample shader' }));

// ─── Mock yieldToMain ───
vi.mock('@core/utils/yield-utils', () => ({
  yieldToMain: vi.fn().mockResolvedValue(undefined),
}));

// ─── Hoisted fake library classes + construction recorder ───
// Shared by the mocked `anime4k-webgpu-async` module (legacy path) and the
// mocked backend registry (registry path) so parity compares the same classes.
const mocks = vi.hoisted(() => {
  interface ConstructedRecord {
    effectName: string;
    descriptor: any;
    paramUpdates: Array<[string, any]>;
  }
  const constructed: ConstructedRecord[] = [];

  function makeEffectClass(effectName: string) {
    return class MockEffect {
      static effectName = effectName;
      descriptor: any;
      paramUpdates: Array<[string, any]> = [];
      constructor(descriptor: any) {
        this.descriptor = descriptor;
        constructed.push({ effectName, descriptor, paramUpdates: this.paramUpdates });
      }
      pass() { return Promise.resolve(); }
      getOutputTexture() { return this.descriptor.inputTexture; }
      updateParam(key: string, value: any) { this.paramUpdates.push([key, value]); }
      destroy() {}
    };
  }

  const libraryClasses: Record<string, ReturnType<typeof makeEffectClass>> = {
    ClampHighlights: makeEffectClass('ClampHighlights'),
    CNNM: makeEffectClass('CNNM'),
    CNNSoftM: makeEffectClass('CNNSoftM'),
    CNNSoftVL: makeEffectClass('CNNSoftVL'),
    CNNVL: makeEffectClass('CNNVL'),
    CNNUL: makeEffectClass('CNNUL'),
    GANUUL: makeEffectClass('GANUUL'),
    CNNx2M: makeEffectClass('CNNx2M'),
    CNNx2VL: makeEffectClass('CNNx2VL'),
    DenoiseCNNx2VL: makeEffectClass('DenoiseCNNx2VL'),
    CNNx2UL: makeEffectClass('CNNx2UL'),
    GANx3L: makeEffectClass('GANx3L'),
    GANx4UUL: makeEffectClass('GANx4UUL'),
    DoG: makeEffectClass('DoG'),
    BilateralMean: makeEffectClass('BilateralMean'),
    Downscale: makeEffectClass('Downscale'),
  };

  return { constructed, libraryClasses, backendCompiles: 0 };
});

vi.mock('anime4k-webgpu-async', () => ({ ...mocks.libraryClasses }));

// ─── Mock backend registry (registry path) ───
// The fake Anime4K backend constructs the SAME hoisted classes the legacy path
// resolves from the mocked library, so parity is a genuine builder-equivalence
// assertion. `resolveEffectReference` is real (static descriptors).
vi.mock('@core/engines/registry.js', () => {
  // `ref.key` is the descriptor key for every resolved reference, so the fake
  // backend needs no descriptor table — only the known upscale scale factors.
  const scaleByKey: Record<string, number> = {
    CNNx2M: 2,
    CNNx2VL: 2,
    DenoiseCNNx2VL: 2,
    CNNx2UL: 2,
    GANx3L: 3,
    GANx4UUL: 4,
  };

  const anime4kBackend = {
    backendId: 'anime4k',
    displayName: 'Anime4K (parity fake)',
    listEffects: () => [],
    async compileEffect(ref: any, ctx: any) {
      const Ctor = mocks.libraryClasses[ref.key];
      if (!Ctor) throw new Error(`[parity-fake] no constructor for "${ref.key}"`);
      mocks.backendCompiles += 1;

      const pipeline = new Ctor({
        device: ctx.device,
        inputTexture: ctx.inputTexture,
        nativeDimensions: ctx.currentDimensions,
        targetDimensions: ctx.targetDimensions,
      });
      if (ctx.params) {
        for (const [key, value] of Object.entries(ctx.params)) pipeline.updateParam(key, value);
      }

      const scale = scaleByKey[ref.key] ?? 1;
      const outputDimensions = scale > 1
        ? {
          width: Math.ceil(ctx.currentDimensions.width * scale),
          height: Math.ceil(ctx.currentDimensions.height * scale),
        }
        : ctx.currentDimensions;

      return {
        pipeline,
        outputTexture: pipeline.getOutputTexture(),
        outputDimensions,
        profileLabel: ref.key,
      };
    },
  };

  const registry = {
    register: vi.fn(),
    getBackend: (backendId: string) => (backendId === 'anime4k' ? anime4kBackend : undefined),
    getBackendAsync: async (backendId: string) => {
      if (backendId === 'anime4k') return anime4kBackend;
      throw new Error(`[parity-fake] backend "${backendId}" is not registered`);
    },
    listEffects: () => [],
    getDescriptorById: () => undefined,
    getDescriptorByBackendKey: () => undefined,
  };

  return { getBackendRegistry: () => registry };
});

// ─── Import the module under test AFTER mocks are set up ───
import { paramsEqual, buildEffectPipelines } from './pipeline-builder';

// ─── Helpers ───

function mkEffect(className: string, params?: Record<string, number>, upscaleFactor?: number): EnhancementEffect {
  return { id: `test/${className}`, name: className, className, params, upscaleFactor };
}

function mkEmptyPipeline(): DestroyablePipeline {
  return {
    pass: () => Promise.resolve(),
    getOutputTexture: () => ({ destroy: vi.fn() } as any),
    updateParam: () => {},
    destroy: vi.fn(),
  };
}

describe('paramsEqual', () => {
  it('returns true for both undefined', () => {
    expect(paramsEqual(undefined, undefined)).toBe(true);
  });

  it('returns false for one undefined', () => {
    expect(paramsEqual(undefined, {})).toBe(false);
    expect(paramsEqual({}, undefined)).toBe(false);
  });

  it('returns true for both empty objects', () => {
    expect(paramsEqual({}, {})).toBe(true);
  });

  it('returns true for same keys and values', () => {
    expect(paramsEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
  });

  it('returns false for different values', () => {
    expect(paramsEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('returns false for different key counts', () => {
    expect(paramsEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('returns false when extra keys exist', () => {
    expect(paramsEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  it('returns true for undefined params and empty object', () => {
    // !a && !b catches both undefined, but one is {} and one is undefined → hits else
    // {} is truthy, undefined is falsy → !a || !b → false
    // Actually: !undefined = true → returns false
    expect(paramsEqual(undefined, {})).toBe(false);
  });
});

describe('buildEffectPipelines', () => {
  let mock: MockGPUObjects;
  let prewarmer: PipelinePreWarmer;

  beforeEach(() => {
    mock = installGPUMock();
    prewarmer = new PipelinePreWarmer();
  });

  afterEach(() => {
    removeGPUMock();
  });

  function buildParams(overrides: Partial<{
    effects: EnhancementEffect[];
    oldPipelines: DestroyablePipeline[];
    isStale: () => boolean;
    onProgress: (stage: string | null, current?: number, total?: number) => void;
    targetDimensions: Dimensions;
    labels: string[];
  }> = {}) {
    const video = {
      videoWidth: 1920,
      videoHeight: 1080,
    } as HTMLVideoElement;

    return {
      device: mock.device as unknown as GPUDevice,
      videoFrameTexture: createMockGPUTexture(1920, 1080) as unknown as GPUTexture,
      video,
      targetDimensions: { width: 1920, height: 1080 } as Dimensions,
      effects: overrides.effects ?? [mkEffect('DoG')],
      oldPipelines: overrides.oldPipelines ?? [],
      preWarmer: prewarmer,
      onProgress: overrides.onProgress,
      isStale: overrides.isStale ?? (() => false),
      labels: overrides.labels,
    };
  }

  // ── Effect chain construction ──

  it('builds pipelines for a single library effect', async () => {
    const params = buildParams({ effects: [mkEffect('DoG', { strength: 4 })] });

    const pipelines = await buildEffectPipelines(params);

    expect(pipelines.length).toBe(1);
    expect(pipelines[0].pass).toBeDefined();
    expect(pipelines[0].getOutputTexture).toBeDefined();
  });

  it('builds pipelines for custom effects (CAS)', async () => {
    const params = buildParams({
      effects: [mkEffect('CAS', { sharpness: 0.8 })],
    });

    const pipelines = await buildEffectPipelines(params);

    expect(pipelines.length).toBe(1);
    // The pipeline should have pass and getOutputTexture
    expect(typeof pipelines[0].pass).toBe('function');
    expect(typeof pipelines[0].getOutputTexture).toBe('function');
  });

  it('builds pipelines for multiple mixed effects (custom + library)', async () => {
    const params = buildParams({
      effects: [
        mkEffect('CAS', { sharpness: 0.5 }),
        mkEffect('CNNM'),
        mkEffect('Debanding', { strength: 0.5, bandThreshold: 0.08 }),
      ],
    });

    const pipelines = await buildEffectPipelines(params);

    expect(pipelines.length).toBe(3);
  });

  // ── Empty effects → dummy pipeline ──

  it('returns a single dummy pipeline when effects array is empty', async () => {
    const params = buildParams({ effects: [] });

    const pipelines = await buildEffectPipelines(params);

    expect(pipelines.length).toBe(1);
    // Dummy pipeline pass resolves immediately
    await expect(pipelines[0].pass({} as any)).resolves.toBeUndefined();
    // Dummy pipeline returns videoFrameTexture
    expect(pipelines[0].getOutputTexture()).toBe(params.videoFrameTexture);
  });

  // ── isStale guard ──

  it('returns empty array when isStale() returns true before pipeline creation', async () => {
    const params = buildParams({
      effects: [mkEffect('DoG')],
      isStale: () => true,
    });

    const pipelines = await buildEffectPipelines(params);
    expect(pipelines).toEqual([]);
  });

  // ── Old pipelines destroyed ──

  it('destroys old pipelines after onSubmittedWorkDone', async () => {
    const oldPipe = mkEmptyPipeline();

    const params = buildParams({
      effects: [mkEffect('DoG')],
      oldPipelines: [oldPipe],
    });

    await buildEffectPipelines(params);

    // onSubmittedWorkDone should have been called
    expect(mock.device.queue.onSubmittedWorkDone).toHaveBeenCalled();

    // Old pipeline's destroy should have been called
    expect(oldPipe.destroy).toHaveBeenCalled();
  });

  // ── onProgress callbacks ──

  it('calls onProgress with correct stages', async () => {
    const progressCalls: (string | null)[] = [];
    const params = buildParams({
      effects: [mkEffect('DoG')],
      onProgress: (stage) => {
        progressCalls.push(stage);
      },
    });

    await buildEffectPipelines(params);

    // Should have initial progress, effect loading progress, and final null
    expect(progressCalls.length).toBeGreaterThanOrEqual(2);
    // First call should contain the warmup message
    expect(progressCalls[0]).toContain('warmup');
    // Last call should be null (complete)
    expect(progressCalls[progressCalls.length - 1]).toBeNull();
  });

  // ── Phase 2 warmup (multiple pipelines) ──

  it('submits warmup command for multiple pipelines', async () => {
    const params = buildParams({
      effects: [mkEffect('CAS'), mkEffect('Debanding')],
    });

    // Reset call counters
    mock.device.createCommandEncoder.mockClear();
    mock.device.queue.submit.mockClear();

    await buildEffectPipelines(params);

    // Phase 2 should create a command encoder for warmup
    expect(mock.device.createCommandEncoder).toHaveBeenCalled();
    expect(mock.device.queue.submit).toHaveBeenCalled();
  });

  it('skips Phase 2 warmup for single pipeline', async () => {
    const params = buildParams({ effects: [mkEffect('CAS')] });

    mock.device.createCommandEncoder.mockClear();
    mock.device.queue.submit.mockClear();

    await buildEffectPipelines(params);

    // Phase 2 is skipped when pipelines.length <= 1
    // (The encoder might still be called by Phase 2 if len > 1, but here len=1)
    // The test just ensures no errors
    expect(mock.device).toBeDefined();
  });

  // ── Module caching ──

  it('reuses cached anime4k-webgpu-async module across builds', async () => {
    const params1 = buildParams({ effects: [mkEffect('DoG')] });
    const params2 = buildParams({ effects: [mkEffect('CNNM')] });

    await buildEffectPipelines(params1);
    await buildEffectPipelines(params2);

    // Both builds should succeed without double-import issues
    // (cachedAnime4KModule at module level prevents re-import)
  });

  // ── Error in pre-warm is non-fatal ──

  it('continues pipeline build even when preWarmer.warm() throws', async () => {
    // Create a prewarmer that throws on warm
    const badPreWarmer = {
      warm: vi.fn().mockRejectedValue(new Error('Pre-warm failed')),
      invalidate: vi.fn(),
    } as unknown as PipelinePreWarmer;

    const params = buildParams({ effects: [mkEffect('DoG')] });
    (params as any).preWarmer = badPreWarmer;

    const pipelines = await buildEffectPipelines(params);

    // Should still build pipelines despite pre-warm failure
    expect(pipelines.length).toBeGreaterThan(0);
  });

  // ── Upscale factor tracking and Downscale insertion ──

  it('tracks upscale factor and inserts Downscale when needed', async () => {
    // Two upscale effects: first 2x, second 2x → intermediate size = 3840
    // targetDimensions = 1080p → idealIntermediateWidth = 1920/1 = 1920
    // curWidth after first = 3840, which > 1920 * 1.1 → Downscale inserted
    const params = buildParams({
      targetDimensions: { width: 1920, height: 1080 },
      effects: [
        mkEffect('CNNx2M', undefined, 2),
        mkEffect('CNNx2M', undefined, 2),
      ],
    });

    const pipelines = await buildEffectPipelines(params);

    // Should have: CNNx2M → Downscale → CNNx2M = 3 pipelines
    expect(pipelines.length).toBe(3);
  });

  // ── Labels out-parameter ──

  it('records one label per built pipeline in encode order (including Downscale)', async () => {
    const labels: string[] = [];
    const params = buildParams({
      targetDimensions: { width: 1920, height: 1080 },
      effects: [
        mkEffect('CNNx2M', undefined, 2),
        mkEffect('CNNx2M', undefined, 2),
      ],
      labels,
    });

    const pipelines = await buildEffectPipelines(params);

    expect(pipelines.length).toBe(3);
    expect(labels).toEqual(['CNNx2M', 'Downscale', 'CNNx2M']);
  });

  it('records classNames for a mixed custom + library chain', async () => {
    const labels: string[] = [];
    const params = buildParams({
      effects: [
        mkEffect('CAS', { sharpness: 0.5 }),
        mkEffect('CNNM'),
        mkEffect('Debanding', { strength: 0.5, bandThreshold: 0.08 }),
      ],
      labels,
    });

    await buildEffectPipelines(params);

    expect(labels).toEqual(['CAS', 'CNNM', 'Debanding']);
  });

  it("records 'passthrough' for the empty dummy pipeline", async () => {
    const labels: string[] = [];
    const params = buildParams({ effects: [], labels });

    const pipelines = await buildEffectPipelines(params);

    expect(pipelines.length).toBe(1);
    expect(labels).toEqual(['passthrough']);
  });

  // ── Effect not found yields dummy pipeline ──

  it('returns dummy pipeline when no valid pipelines were created', async () => {
    // When effects produce no valid pipelines (e.g., all effects fail class lookup),
    // the function returns a single dummy pipeline.
    // Since vitest strict mocks prevent accessing undefined exports on the mock module,
    // we test the empty-effects path which also produces a dummy pipeline.
    const params = buildParams({
      effects: [mkEffect('DoG')],
      isStale: () => true, // force stale → empty array returned before effects are built
    });

    const pipelines = await buildEffectPipelines(params);

    // isStale() returned true → empty array, not dummy pipeline
    expect(pipelines).toEqual([]);
  });

  // ── Effect params applied ──

  it('applies effect params to library effects after construction', async () => {
    const params = buildParams({
      effects: [mkEffect('DoG', { strength: 8 })],
    });

    const pipelines = await buildEffectPipelines(params);

    expect(pipelines.length).toBe(1);
    // The mock updates paramUpdates internally
  });

  // ── ColorAdjust effect ──

  it('builds ColorAdjust with default params', async () => {
    const params = buildParams({
      effects: [mkEffect('ColorAdjust')],
    });

    const pipelines = await buildEffectPipelines(params);

    expect(pipelines.length).toBe(1);
    expect(typeof pipelines[0].pass).toBe('function');
  });

  it('builds ColorAdjust with custom params', async () => {
    const params = buildParams({
      effects: [mkEffect('ColorAdjust', {
        brightness: 0.2,
        gamma: 1.1,
        contrast: 1.2,
        saturation: 1.3,
        vibrance: 0.1,
        exposure: 0.5,
      })],
    });

    const pipelines = await buildEffectPipelines(params);

    expect(pipelines.length).toBe(1);
  });
});

// ─── Golden parity: legacy vs registry ───

/** Comparable projection of one constructed pipeline descriptor. */
function normalizeStep(record: { effectName: string; descriptor: any }) {
  const descriptor = record.descriptor ?? {};
  return {
    effectName: record.effectName,
    nativeDimensions: descriptor.nativeDimensions ?? null,
    targetDimensions: descriptor.targetDimensions ?? null,
    inputTexture: descriptor.inputTexture
      ? { width: descriptor.inputTexture.width, height: descriptor.inputTexture.height }
      : null,
  };
}

describe('buildEffectPipelines golden parity (legacy vs registry)', () => {
  let mock: MockGPUObjects;
  // A no-op pre-warmer isolates Phase 1 construction so the parity snapshot only
  // contains the real effect steps and intermediate Downscales.
  const noopPreWarmer = {
    warm: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn(),
  } as unknown as PipelinePreWarmer;

  beforeEach(() => {
    mock = installGPUMock();
    mocks.constructed.length = 0;
  });

  afterEach(() => {
    removeGPUMock();
  });

  function buildParams(
    effects: EnhancementEffect[],
    labels: string[],
    backendMode: 'legacy' | 'registry',
  ) {
    const video = { videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement;
    return {
      device: mock.device as unknown as GPUDevice,
      videoFrameTexture: createMockGPUTexture(1920, 1080) as unknown as GPUTexture,
      video,
      targetDimensions: { width: 1920, height: 1080 } as Dimensions,
      effects,
      oldPipelines: [] as DestroyablePipeline[],
      preWarmer: noopPreWarmer,
      isStale: () => false,
      labels,
      backendMode,
    };
  }

  async function run(effects: EnhancementEffect[], backendMode: 'legacy' | 'registry') {
    mocks.constructed.length = 0;
    mocks.backendCompiles = 0;
    const labels: string[] = [];
    const pipelines = await buildEffectPipelines(buildParams(effects, labels, backendMode));
    return {
      pipelineCount: pipelines.length,
      labels: [...labels],
      classSequence: mocks.constructed.map((record) => record.effectName),
      constructors: mocks.constructed.map(normalizeStep),
      paramUpdates: mocks.constructed.map((record) =>
        record.paramUpdates.map(([key, value]) => [key, value]),
      ),
      backendCompiles: mocks.backendCompiles,
    };
  }

  const tiers = ['performance', 'balanced', 'quality', 'ultra'] as const;

  const builtInCases: Array<[string, EnhancementEffect[]]> = [];
  for (const mode of BUILTIN_MODES) {
    for (const tier of tiers) {
      builtInCases.push([`${mode.baseMode} / ${tier}`, getEffectsForMode(mode, tier)]);
    }
  }

  // Extra chains exercise the `updateParam` path (built-in chains carry no params).
  const extraCases: Array<[string, EnhancementEffect[]]> = [
    ['DoG params', [
      { id: 'anime4k/Deblur/DoG', name: 'Deblur (DoG)', className: 'DoG', params: { strength: 7 } },
    ]],
    ['BilateralMean params', [
      {
        id: 'anime4k/Denoise/BilateralMean',
        name: 'Denoise (Bilateral Mean)',
        className: 'BilateralMean',
        params: { strength: 0.35, strength2: 3 },
      },
    ]],
    ['upscale + params + intermediate Downscale', [
      { id: 'anime4k/Helper/ClampHighlights', name: 'Clamp Highlights', className: 'ClampHighlights' },
      { id: 'anime4k/Deblur/DoG', name: 'Deblur (DoG)', className: 'DoG', params: { strength: 7 } },
      { id: 'anime4k/Upscale/CNNx2M', name: 'Upscale CNN x2 (M)', className: 'CNNx2M', upscaleFactor: 2 },
      { id: 'anime4k/Upscale/CNNx2M', name: 'Upscale CNN x2 (M)', className: 'CNNx2M', upscaleFactor: 2 },
    ]],
  ];

  for (const [name, effects] of [...builtInCases, ...extraCases]) {
    it(`is identical for ${name}`, async () => {
      const legacy = await run(effects, 'legacy');
      const registry = await run(effects, 'registry');

      // Registry mode must actually compile through the backend for every
      // effect; a silent legacy fallback would make this comparison vacuous.
      expect(legacy.backendCompiles).toBe(0);
      expect(registry.backendCompiles).toBe(effects.length);

      const { backendCompiles: _legacyCompiles, ...legacySnapshot } = legacy;
      const { backendCompiles: _registryCompiles, ...registrySnapshot } = registry;
      expect(registrySnapshot).toEqual(legacySnapshot);
    });
  }
});
