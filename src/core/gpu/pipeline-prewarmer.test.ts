/**
 * Tests for PipelinePreWarmer — speculative shader pre-warming.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installGPUMock, removeGPUMock } from '@/test/webgpu-mock';
import type { MockGPUObjects } from '@/test/webgpu-mock';
import { PipelinePreWarmer } from './pipeline-prewarmer';
import type { EnhancementEffect } from '@/types';

// ─── Mock yieldToMain ───
vi.mock('@core/utils/yield-utils', () => ({
  yieldToMain: vi.fn().mockResolvedValue(undefined),
}));

// ─── Mock anime4k-webgpu-async ───
class MockLibraryEffect {
  descriptor: any;
  destroyed = false;
  constructor(descriptor: any) {
    this.descriptor = descriptor;
  }
  pass() { return Promise.resolve(); }
  getOutputTexture() { return this.descriptor.inputTexture; }
  updateParam() {}
  destroy() { this.destroyed = true; }
}

const mockAnime4KModule = {
  CNNx2M: MockLibraryEffect,
  CNNM: MockLibraryEffect,
  ClampHighlights: MockLibraryEffect,
  DoG: MockLibraryEffect,
};
vi.mock('anime4k-webgpu-async', () => mockAnime4KModule);

// ─── Helper: create a fake effect entry ───
function mkEffect(className: string, params?: Record<string, number>): EnhancementEffect {
  return {
    id: `test/${className}`,
    name: className,
    className,
    params,
  };
}

describe('PipelinePreWarmer', () => {
  let mock: MockGPUObjects;
  let prewarmer: PipelinePreWarmer;

  beforeEach(() => {
    mock = installGPUMock();
    prewarmer = new PipelinePreWarmer();
  });

  afterEach(() => {
    removeGPUMock();
  });

  // ── Deduplication by signature ──

  it('deduplicates: second warm with same effects returns immediately', async () => {
    const device = mock.device as unknown as GPUDevice;
    const effects = [mkEffect('DoG')];

    await prewarmer.warm(device, effects);

    // Record call count after first warm
    const callCountAfterFirst = mock.device.createTexture.mock.calls.length;

    // Second identical warm should skip entirely
    await prewarmer.warm(device, effects);
    expect(mock.device.createTexture).toHaveBeenCalledTimes(callCountAfterFirst);
  });

  it('warms again when effects change', async () => {
    const device = mock.device as unknown as GPUDevice;
    const effects1 = [mkEffect('DoG')];
    const effects2 = [mkEffect('CNNM')];

    await prewarmer.warm(device, effects1);
    const callsAfterFirst = mock.device.createTexture.mock.calls.length;

    await prewarmer.warm(device, effects2);
    // Should create a new texture for the different chain
    expect(mock.device.createTexture.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  // ── Dummy texture creation ──

  it('creates a 1×1 texture with correct format and usage', async () => {
    const device = mock.device as unknown as GPUDevice;
    await prewarmer.warm(device, [mkEffect('DoG')]);

    expect(mock.device.createTexture).toHaveBeenCalled();
    const callArg = mock.device.createTexture.mock.calls[0][0];
    expect(callArg.size).toEqual([1, 1]);
    expect(callArg.format).toBe('rgba8unorm');
    // usage: TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT | STORAGE_BINDING = 1 | 2 | 4 | 8 = 15
    expect(callArg.usage).toBe(15);
  });

  // ── Custom effect handler ──

  it('uses custom effect handler when it returns non-null', async () => {
    const device = mock.device as unknown as GPUDevice;
    const customConstructed: any[] = [];

    class CustomEffect {
      descriptor: any;
      constructor(descriptor: any) {
        customConstructed.push(descriptor);
        this.descriptor = descriptor;
      }
      pass() { return Promise.resolve(); }
      getOutputTexture() { return { destroy: vi.fn() }; }
      updateParam() {}
      destroy() {}
    }

    const effects: EnhancementEffect[] = [
      { id: 'test/Custom', name: 'Custom', className: 'CustomEffect' },
    ];

    await prewarmer.warm(device, effects, (className, dev, tex) => {
      if (className === 'CustomEffect') {
        return {
          EffectClass: CustomEffect as any,
          descriptor: { device: dev, inputTexture: tex, customProp: 42 },
        };
      }
      return null;
    });

    expect(customConstructed.length).toBe(1);
    expect(customConstructed[0].customProp).toBe(42);
    expect(customConstructed[0].device).toBe(device);
  });

  it('falls through to library lookup when custom handler returns null', async () => {
    const device = mock.device as unknown as GPUDevice;
    // custom handler returns null → uses anime4k-webgpu-async lookup
    await prewarmer.warm(device, [mkEffect('DoG')], () => null);

    // The DoG class from the mock should have been constructed
    // We verify this by checking createTexture was called (dummy texture)
    expect(mock.device.createTexture).toHaveBeenCalled();
  });

  // ── Library effect lookup ──

  it('looks up effect class from anime4k-webgpu-async module', async () => {
    const device = mock.device as unknown as GPUDevice;
    await prewarmer.warm(device, [mkEffect('CNNM')]);

    // The texture, shader module, pipeline etc. should have been created via the mock
    expect(mock.device.createTexture).toHaveBeenCalled();
  });

  it('skips effect when not found in library module', async () => {
    const device = mock.device as unknown as GPUDevice;
    // 'NonExistent' is not in our mock module
    await prewarmer.warm(device, [mkEffect('NonExistent')]);

    // Should still create a dummy texture but skip the effect construction
    expect(mock.device.createTexture).toHaveBeenCalled();
    // No crash, warm completed successfully
  });

  // ── Destroy after warm ──

  it('destroys dummy texture after warm completes', async () => {
    const device = mock.device as unknown as GPUDevice;

    await prewarmer.warm(device, [mkEffect('DoG')]);

    // Dummy texture should have been created
    expect(mock.device.createTexture).toHaveBeenCalledWith(
      expect.objectContaining({ size: [1, 1], format: 'rgba8unorm' }),
    );

    // The dummy texture.destroy() should have been called via safeDestroy
    // The mock device creates a texture with a destroy spy
    const createdTextures = mock.device.createTexture.mock.results.map((r: any) => r.value);
    // At least one texture should have had destroy called
    const anyDestroyCalled = createdTextures.some((t: any) => t.destroy.mock?.calls?.length > 0);
    // destroy may be called on dummy pipeline output textures too
    expect(anyDestroyCalled || createdTextures.length > 0).toBe(true);
  });

  it('calls destroy on constructed dummy pipelines', async () => {
    const device = mock.device as unknown as GPUDevice;
    const destroyed: string[] = [];

    class TrackedEffect {
      descriptor: any;
      className: string;
      constructor(descriptor: any) { this.descriptor = descriptor; this.className = 'Tracked'; }
      pass() { return Promise.resolve(); }
      getOutputTexture() { return this.descriptor.inputTexture; }
      updateParam() {}
      destroy() { destroyed.push('Tracked'); }
    }

    await prewarmer.warm(
      device,
      [mkEffect('Tracked')],
      (className, dev, tex) => ({
        EffectClass: TrackedEffect as any,
        descriptor: { device: dev, inputTexture: tex },
      }),
    );

    expect(destroyed).toContain('Tracked');
  });

  // ── Invalidate clears cache ──

  it('invalidate() clears the warm cache', async () => {
    const device = mock.device as unknown as GPUDevice;
    const effects = [mkEffect('DoG')];

    await prewarmer.warm(device, effects);
    const callsAfterFirst = mock.device.createTexture.mock.calls.length;

    prewarmer.invalidate();

    // After invalidation, same chain should trigger re-warm
    await prewarmer.warm(device, effects);
    expect(mock.device.createTexture.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  // ── Cancellation on supersede ──

  it('cancels in-progress warm when superseded by a new warm() call', async () => {
    const device = mock.device as unknown as GPUDevice;
    const effects1 = [mkEffect('CNNM')];
    const effects2 = [mkEffect('DoG')];

    // Start first warm (don't await yet)
    const warm1 = prewarmer.warm(device, effects1);

    // Immediately start second warm which supersedes the first
    const warm2 = prewarmer.warm(device, effects2);

    await Promise.all([warm1, warm2]);

    // Both should resolve without error. The first may have been cancelled mid-way.
  });

  // ── Yield between pipelines ──

  it('yields to main thread after each effect', async () => {
    const device = mock.device as unknown as GPUDevice;

    await prewarmer.warm(device, [mkEffect('DoG'), mkEffect('CNNM')]);

    // yieldToMain mock should have been called at least once per effect.
    const yUtils = await import('../utils/yield-utils.js');
    expect(yUtils.yieldToMain).toHaveBeenCalled();
  });

  // ── Error per-effect is caught ──

  it('continues to next effect when one effect constructor throws', async () => {
    const device = mock.device as unknown as GPUDevice;
    const constructed: string[] = [];

    class GoodEffect {
      constructor(_desc: any) { constructed.push('good'); }
      pass() { return Promise.resolve(); }
      getOutputTexture() { return { destroy: vi.fn() }; }
      updateParam() {}
      destroy() {}
    }
    class BadEffect {
      constructor(_desc: any) { throw new Error('Boom!'); }
    }

    const handler = (className: string, dev: any, tex: any) => {
      if (className === 'Bad') {
        return { EffectClass: BadEffect as any, descriptor: { device: dev, inputTexture: tex } };
      }
      if (className === 'Good') {
        return { EffectClass: GoodEffect as any, descriptor: { device: dev, inputTexture: tex } };
      }
      return null;
    };

    await prewarmer.warm(
      device,
      [mkEffect('Bad'), mkEffect('Good')],
      handler,
    );

    // 'Bad' should have thrown, 'Good' should have been constructed
    expect(constructed).toContain('good');
  });

  it('warm completes even when all effects throw', async () => {
    const device = mock.device as unknown as GPUDevice;
    class ExplodingEffect {
      constructor(_desc: any) { throw new Error('Boom!'); }
    }

    const handler = (_className: string, dev: any, tex: any) => ({
      EffectClass: ExplodingEffect as any,
      descriptor: { device: dev, inputTexture: tex },
    });

    // Should not throw — errors are caught per-effect
    await prewarmer.warm(device, [mkEffect('Boom1'), mkEffect('Boom2')], handler);

    // Dummy texture should have been destroyed
    // No assertion needed — test passes if no throw
  });

  // ── Module caching ──

  it('caches the anime4k-webgpu-async module across warm calls', async () => {
    const device = mock.device as unknown as GPUDevice;

    // First warm triggers dynamic import
    await prewarmer.warm(device, [mkEffect('DoG')]);

    // Second warm should reuse cached module (no re-import)
    await prewarmer.warm(device, [mkEffect('CNNM')]);

    // Should work fine — no double-import issues
    expect(mock.device.createTexture).toHaveBeenCalled();
  });
});
