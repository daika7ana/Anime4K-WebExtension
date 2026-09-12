/**
 * Golden-parity tests for the benchmark's effect-chain compiler.
 *
 * `runEffectChainTest` is exercised directly for the real `A+A` chain across all
 * four tiers in both legacy and registry modes. The mocked Anime4K library and
 * the mocked backend registry share the SAME fake classes, so the comparison is
 * a genuine assertion that the registry path reproduces the legacy construction,
 * dimensions and intermediate-downscale insertions.
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

  const scaleByKey: Record<string, number> = {
    CNNx2M: 2,
    CNNx2VL: 2,
    DenoiseCNNx2VL: 2,
    CNNx2UL: 2,
    GANx3L: 3,
    GANx4UUL: 4,
  };

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

  return { constructed, libraryClasses, scaleByKey, backendCompiles: 0 };
});

vi.mock('anime4k-webgpu-async', () => ({ ...mocks.libraryClasses }));

vi.mock('@core/engines/registry.js', () => {
  const anime4kBackend = {
    backendId: 'anime4k',
    displayName: 'Anime4K (benchmark parity fake)',
    listEffects: () => [],
    async compileEffect(ref: any, ctx: any) {
      const Ctor = mocks.libraryClasses[ref.key];
      if (!Ctor) throw new Error(`[benchmark-parity-fake] no constructor for "${ref.key}"`);
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
      throw new Error(`[benchmark-parity-fake] backend "${backendId}" is not registered`);
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

describe('runEffectChainTest golden parity (legacy vs registry)', () => {
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
    backendMode: 'legacy' | 'registry',
  ) {
    mocks.constructed.length = 0;
    mocks.backendCompiles = 0;
    const device = mock.device as unknown as GPUDevice;
    const inputTexture = createMockGPUTexture(1920, 1080) as unknown as GPUTexture;

    await runEffectChainTest(
      device,
      inputTexture,
      effects,
      Anime4KModule as unknown as typeof import('anime4k-webgpu-async'),
      backendMode,
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
    it(`is identical for A+A / ${tier}`, async () => {
      const effects = resolveEffectChain('A+A', tier);

      const legacy = await run(effects, 'legacy');
      const registry = await run(effects, 'registry');

      // The registry path must compile every effect through the backend.
      expect(legacy.backendCompiles).toBe(0);
      expect(registry.backendCompiles).toBe(effects.length);

      const { backendCompiles: _legacyCompiles, ...legacySnapshot } = legacy;
      const { backendCompiles: _registryCompiles, ...registrySnapshot } = registry;
      expect(registrySnapshot).toEqual(legacySnapshot);
    });
  }
});
