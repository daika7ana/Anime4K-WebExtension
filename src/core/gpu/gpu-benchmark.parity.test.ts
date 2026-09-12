/**
 * Golden tests for the benchmark's effect-chain compiler.
 *
 * `runEffectChainTest` is exercised directly for the real `A+A` chain across all
 * four tiers through the engine registry. The mocked backend registry constructs
 * the fake library classes, so the recorded class/dimension sequences are an
 * exact regression golden for the registry dispatch path (the former legacy half
 * of the legacy-vs-registry parity comparison was removed with the legacy path).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installGPUMock, removeGPUMock, createMockGPUTexture } from '@/test/webgpu-mock';
import type { MockGPUObjects } from '@/test/webgpu-mock';
import * as Anime4KModule from 'anime4k-webgpu-async';
import { resolveEffectChain } from '@utils/effect-chain-templates';
import type { EnhancementEffect } from '@/types';

// ─── Hoisted fake library classes + construction recorder ───
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

  /** Two-stage epilogue node with a distinct marker output. */
  function makeApplyClass() {
    return class MockClampHighlightsApply {
      static effectName = 'ClampHighlightsApply';
      descriptor: any;
      outputTexture: { width: number; height: number; kind: string };
      constructor(descriptor: any) {
        this.descriptor = descriptor;
        this.outputTexture = {
          width: descriptor.inputTexture?.width ?? 0,
          height: descriptor.inputTexture?.height ?? 0,
          kind: 'clamp-apply',
        };
        constructed.push({ effectName: 'ClampHighlightsApply', descriptor, paramUpdates: [] });
      }
      pass() { return Promise.resolve(); }
      getOutputTexture() { return this.outputTexture; }
      updateParam() {}
      destroy() {}
    };
  }

  const scaleByKey: Record<string, number> = {
    CNNx2M: 2,
    CNNx2VL: 2,
    DenoiseCNNx2VL: 2,
    CNNx2UL: 2,
    GANx3L: 3,
    GANx4UUL: 4,
  };

  const ClampHighlightsApplyClass = makeApplyClass();
  const ClampHighlightsClass = class extends makeEffectClass('ClampHighlights') {
    getDeferredPipeline(finalInputTexture: any) {
      return new ClampHighlightsApplyClass({ inputTexture: finalInputTexture });
    }
  };

  const libraryClasses: Record<string, any> = {
    ClampHighlights: ClampHighlightsClass,
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
    ClampHighlightsApply: ClampHighlightsApplyClass,
    Downscale: makeEffectClass('Downscale'),
  };

  return { constructed, libraryClasses, scaleByKey, backendCompiles: 0 };
});

vi.mock('anime4k-webgpu-async', () => ({ ...mocks.libraryClasses }));

vi.mock('@core/engines/registry.js', () => {
  const anime4kBackend = {
    backendId: 'anime4k',
    displayName: 'Anime4K (benchmark golden fake)',
    listEffects: () => [],
    async compileEffect(ref: any, ctx: any) {
      const Ctor = mocks.libraryClasses[ref.key];
      if (!Ctor) throw new Error(`[benchmark-golden-fake] no constructor for "${ref.key}"`);
      mocks.backendCompiles += 1;

      const pipeline = new Ctor({
        device: ctx.device,
        inputTexture: ctx.inputTexture,
        nativeDimensions: ctx.currentDimensions,
        targetDimensions: ctx.targetDimensions,
      });

      const scale = mocks.scaleByKey[ref.key] ?? 1;
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
      throw new Error(`[benchmark-golden-fake] backend "${backendId}" is not registered`);
    },
    listEffects: () => [],
    getDescriptorById: () => undefined,
    getDescriptorByBackendKey: () => undefined,
  };

  return { getBackendRegistry: () => registry };
});

// ─── Import AFTER mocks ───
import { runEffectChainTest } from './gpu-benchmark';

// ─── Helpers ───

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

/** Build one expected normalized constructor record. */
function makeStep(
  effectName: string,
  nativeDimensions: { width: number; height: number } | null,
  targetDimensions: { width: number; height: number } | null,
  inputTexture: { width: number; height: number } | null,
) {
  return { effectName, nativeDimensions, targetDimensions, inputTexture };
}

const HD = { width: 1920, height: 1080 };
const UHD = { width: 3840, height: 2160 };

/**
 * Exact recorded registry sequences for the `A+A` chain per tier. Captured from
 * the registry path (the previous legacy-vs-registry parity golden) so these
 * remain a byte-exact regression guard now that legacy dispatch is gone.
 */
const A_A_GOLDEN = {
  performance: {
    classSequence: ['ClampHighlights', 'CNNM', 'CNNx2M', 'Downscale', 'CNNM', 'CNNx2M', 'ClampHighlightsApply'],
    constructors: [
      makeStep('ClampHighlights', HD, UHD, HD),
      makeStep('CNNM', HD, UHD, HD),
      makeStep('CNNx2M', HD, UHD, HD),
      makeStep('Downscale', null, HD, HD),
      makeStep('CNNM', HD, UHD, HD),
      makeStep('CNNx2M', HD, UHD, HD),
      makeStep('ClampHighlightsApply', null, null, HD),
    ],
    paramUpdates: [[], [], [], [], [], [], []],
  },
  balanced: {
    classSequence: ['ClampHighlights', 'CNNVL', 'CNNx2VL', 'Downscale', 'CNNVL', 'CNNx2M', 'ClampHighlightsApply'],
    constructors: [
      makeStep('ClampHighlights', HD, UHD, HD),
      makeStep('CNNVL', HD, UHD, HD),
      makeStep('CNNx2VL', HD, UHD, HD),
      makeStep('Downscale', null, HD, HD),
      makeStep('CNNVL', HD, UHD, HD),
      makeStep('CNNx2M', HD, UHD, HD),
      makeStep('ClampHighlightsApply', null, null, HD),
    ],
    paramUpdates: [[], [], [], [], [], [], []],
  },
  quality: {
    classSequence: ['ClampHighlights', 'CNNUL', 'CNNx2UL', 'Downscale', 'CNNUL', 'CNNx2VL', 'ClampHighlightsApply'],
    constructors: [
      makeStep('ClampHighlights', HD, UHD, HD),
      makeStep('CNNUL', HD, UHD, HD),
      makeStep('CNNx2UL', HD, UHD, HD),
      makeStep('Downscale', null, HD, HD),
      makeStep('CNNUL', HD, UHD, HD),
      makeStep('CNNx2VL', HD, UHD, HD),
      makeStep('ClampHighlightsApply', null, null, HD),
    ],
    paramUpdates: [[], [], [], [], [], [], []],
  },
  ultra: {
    classSequence: ['ClampHighlights', 'CNNUL', 'CNNx2UL', 'CNNUL', 'CNNUL', 'ClampHighlightsApply'],
    constructors: [
      makeStep('ClampHighlights', HD, UHD, HD),
      makeStep('CNNUL', HD, UHD, HD),
      makeStep('CNNx2UL', HD, UHD, HD),
      makeStep('CNNUL', UHD, UHD, HD),
      makeStep('CNNUL', UHD, UHD, HD),
      makeStep('ClampHighlightsApply', null, null, HD),
    ],
    paramUpdates: [[], [], [], [], [], []],
  },
};

describe('runEffectChainTest golden (engine registry)', () => {
  let mock: MockGPUObjects;

  beforeEach(() => {
    mock = installGPUMock();
    mocks.constructed.length = 0;
    mocks.backendCompiles = 0;
  });

  afterEach(() => {
    removeGPUMock();
  });

  async function run(
    effects: EnhancementEffect[],
    sourceDimensions: { width: number; height: number } = { width: 1920, height: 1080 },
  ) {
    mocks.constructed.length = 0;
    mocks.backendCompiles = 0;
    const device = mock.device as unknown as GPUDevice;
    const inputTexture = createMockGPUTexture(
      sourceDimensions.width,
      sourceDimensions.height,
    ) as unknown as GPUTexture;

    await runEffectChainTest(
      device,
      inputTexture,
      effects,
      Anime4KModule as unknown as typeof import('anime4k-webgpu-async'),
      sourceDimensions,
    );

    return {
      classSequence: mocks.constructed.map((record) => record.effectName),
      constructors: mocks.constructed.map(normalizeStep),
      paramUpdates: mocks.constructed.map((record) =>
        record.paramUpdates.map(([key, value]) => [key, value]),
      ),
      backendCompiles: mocks.backendCompiles,
    };
  }

  const tiers = ['performance', 'balanced', 'quality', 'ultra'] as const;

  for (const tier of tiers) {
    it(`records the registry pipeline sequence for A+A / ${tier}`, async () => {
      const effects = resolveEffectChain('A+A', tier);

      const registry = await run(effects);

      // Every retained effect is compiled through the backend; Downscale and the
      // deferred apply node are built directly, not via the backend.
      const effectCount = registry.classSequence
        .filter((name) => name !== 'Downscale' && name !== 'ClampHighlightsApply').length;
      expect(registry.backendCompiles).toBe(effectCount);

      const { backendCompiles: _compiles, ...snapshot } = registry;
      expect(snapshot).toEqual(A_A_GOLDEN[tier]);
    });
  }

  it('suppresses the over-limit 8K upscaler and appends the target Downscale', async () => {
    const effects: EnhancementEffect[] = [
      { id: 'anime4k/Upscale/CNNx2M', name: 'Upscale CNN x2 (M)', className: 'CNNx2M', upscaleFactor: 2 },
    ];
    const source = { width: 7680, height: 4320 };

    const registry = await run(effects, source);

    // 8K * 2x would emit a 15360-wide intermediate; the guard suppresses the
    // upscaler and emits only the Downscale from the pre-upscale 8K texture.
    expect(registry.classSequence).toEqual(['Downscale']);
    expect(registry.backendCompiles).toBe(0);
  });

  it('threads device.limits.maxTextureDimension2D into the benchmark geometry', async () => {
    const effects = resolveEffectChain('A+A', 'performance');

    // Default mock ceiling (8192): the 1080p->4K A+A chain keeps its upscalers.
    const wide = await run(effects);
    expect(wide.classSequence).toContain('CNNx2M');

    // A tighter adapter ceiling suppresses the over-limit upscalers.
    mock.device.limits.maxTextureDimension2D = 2048;
    const narrow = await run(effects);
    expect(narrow.classSequence).not.toContain('CNNx2M');
    expect(narrow.classSequence.length).toBeLessThan(wide.classSequence.length);
  });
});
