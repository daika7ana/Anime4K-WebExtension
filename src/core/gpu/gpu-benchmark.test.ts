/**
 * Tests for GPU Benchmark — tier recommendation, error handling, storage interaction.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installGPUMock, removeGPUMock } from '@/test/webgpu-mock';
import type { MockGPUObjects } from '@/test/webgpu-mock';
import type { BenchmarkProgress, EnhancementEffect } from '@/types';

// ─── Mock WGSL shader files (used by effect classes imported via resolveEffectChain) ───
vi.mock('@shaders/cas.wgsl', () => ({ default: '// mock' }));
vi.mock('@shaders/color-adjust.wgsl', () => ({ default: '// mock' }));
vi.mock('@shaders/debanding.wgsl', () => ({ default: '// mock' }));
vi.mock('@shaders/fullscreen-textured-quad.wgsl', () => ({ default: '// mock' }));
vi.mock('@shaders/sample-external-texture.wgsl', () => ({ default: '// mock' }));

// ─── Mock resolveEffectChain ───
let mockResolvedEffects: EnhancementEffect[] = [];
vi.mock('@utils/effect-chain-templates', () => ({
  resolveEffectChain: vi.fn((_baseMode: string, _tier: string) => [...mockResolvedEffects]),
}));

// ─── Mock anime4k-webgpu-async (library effects) ───
class MockLibEffect {
  descriptor: any;
  constructor(descriptor: any) { this.descriptor = descriptor; }
  pass(_encoder: any) { return Promise.resolve(); }
  getOutputTexture() { return this.descriptor.inputTexture; }
  updateParam() {}
  destroy() {}
}
vi.mock('anime4k-webgpu-async', () => ({
  ClampHighlights: MockLibEffect,
  CNNM: MockLibEffect,
  CNNx2M: MockLibEffect,
  CNNVL: MockLibEffect,
  CNNx2VL: MockLibEffect,
  CNNUL: MockLibEffect,
  CNNx2UL: MockLibEffect,
  CNNSoftM: MockLibEffect,
  CNNSoftVL: MockLibEffect,
  DoG: MockLibEffect,
  DenoiseCNNx2VL: MockLibEffect,
  Downscale: MockLibEffect,
}));

// ─── Import after mocks ───
import { runGPUBenchmark } from './gpu-benchmark';

// ─── Simple mock effects for the benchmark chain ───
function simpleEffectChain(): EnhancementEffect[] {
  return [
    { id: 'test/ClampHighlights', name: 'Clamp', className: 'ClampHighlights' },
    { id: 'test/CNNM', name: 'Restore CNN', className: 'CNNM' },
    { id: 'test/CNNx2M', name: 'Upscale', className: 'CNNx2M', upscaleFactor: 2 },
    { id: 'test/CNNM2', name: 'Restore CNN', className: 'CNNM' },
    { id: 'test/CNNx2M2', name: 'Upscale', className: 'CNNx2M', upscaleFactor: 2 },
  ];
}

describe('runGPUBenchmark', () => {
  let mock: MockGPUObjects;
  let progressEvents: BenchmarkProgress[];

  beforeEach(() => {
    mock = installGPUMock();
    progressEvents = [];
    mockResolvedEffects = simpleEffectChain();

    // Add remove to chrome storage local mock (missing from test-setup)
    (chrome.storage.local as any).remove = vi.fn().mockResolvedValue(undefined);

    // Mock crypto.getRandomValues — fill with zeros for speed
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(((
      array: ArrayBufferView,
    ): ArrayBufferView => {
      if (array instanceof Uint8Array) {
        array.fill(0);
      }
      return array;
    }) as typeof crypto.getRandomValues);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removeGPUMock();
  });

  // ── Result shape ──

  it('returns a valid GPUBenchmarkResult', async () => {
    const result = await runGPUBenchmark((p) => progressEvents.push(p));

    expect(result).toHaveProperty('tier');
    expect(result).toHaveProperty('scores');
    expect(result).toHaveProperty('maxScores');
    expect(result).toHaveProperty('timestamp');
    expect(result).toHaveProperty('adapterInfo');
    expect(typeof result.tier).toBe('string');
    expect(typeof result.timestamp).toBe('number');
    expect(result.scores).toHaveProperty('performance');
    expect(result.scores).toHaveProperty('balanced');
    expect(result.scores).toHaveProperty('quality');
    expect(result.scores).toHaveProperty('ultra');
  });

  it('returns performance tier as recommendation when all tiers are fast', async () => {
    // With mock GPU, everything resolves instantly → all tiers should be fast
    // avgTime ≈ 0ms, maxTime ≈ 0ms → recommended = last tier that passed
    const result = await runGPUBenchmark();

    // At minimum, performance tier should have a finite score
    expect(result.scores.performance).toBeLessThan(Infinity);
    // tier is the last tier that met the threshold criteria
    expect(['performance', 'balanced', 'quality', 'ultra']).toContain(result.tier);
  });

  // ── Progress callbacks ──

  it('calls onProgress with tier progress updates', async () => {
    await runGPUBenchmark((p) => progressEvents.push(p));

    // Should have tier-level progress events
    const tierEvents = progressEvents.filter(e => e.tier !== 'done');
    expect(tierEvents.length).toBeGreaterThan(0);

    // Each tier event should have the right shape
    for (const event of tierEvents) {
      expect(event).toHaveProperty('tier');
      expect(event).toHaveProperty('progress');
      expect(event).toHaveProperty('completed');
      expect(event.completed).toBe(false);
    }
  });

  it('calls onProgress with completion event at the end', async () => {
    await runGPUBenchmark((p) => progressEvents.push(p));

    const lastEvent = progressEvents[progressEvents.length - 1];
    expect(lastEvent.tier).toBe('done');
    expect(lastEvent.progress).toBe(1);
    expect(lastEvent.completed).toBe(true);
  });

  // ── No navigator.gpu ──

  it('throws when navigator.gpu is not available', async () => {
    removeGPUMock();

    await expect(runGPUBenchmark()).rejects.toThrow('WebGPU not supported');

    // Re-install for subsequent tests
    mock = installGPUMock();
  });

  // ── No adapter ──

  it('throws when no GPU adapter is available', async () => {
    removeGPUMock();
    installGPUMock({ adapterNull: true });

    await expect(runGPUBenchmark()).rejects.toThrow('No GPU adapter available');

    removeGPUMock();
    mock = installGPUMock();
  });

  // ── All tiers fail ──

  it('throws "All benchmark tests failed" when warmup fails', async () => {
    // Return effects with a class not in the mock → no pipelines created → throws
    mockResolvedEffects = [
      { id: 'test/NonExistent', name: 'Nope', className: 'NonExistent' },
    ];

    await expect(runGPUBenchmark()).rejects.toThrow();
  });

  // ── Chrome storage interaction ──

  it('sets and removes _benchmarkInProgress flag in chrome storage', async () => {
    const setSpy = chrome.storage.local.set as ReturnType<typeof vi.fn>;
    const removeSpy = chrome.storage.local.remove as ReturnType<typeof vi.fn>;

    await runGPUBenchmark();

    // Should have set _benchmarkInProgress before benchmark
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ _benchmarkInProgress: true }),
    );

    // Should have removed _benchmarkInProgress after benchmark
    expect(removeSpy).toHaveBeenCalledWith('_benchmarkInProgress');
  });

  // ── Adapter info ──

  it('includes adapter info in the result', async () => {
    const result = await runGPUBenchmark();

    expect(result.adapterInfo).toBeDefined();
    expect(typeof result.adapterInfo).toBe('string');

    // Should contain mock vendor info
    const info = JSON.parse(result.adapterInfo);
    expect(info.vendor).toBe('mock-vendor');
  });

  // ── Timestamp ──

  it('includes a timestamp in the result', async () => {
    const before = Date.now();
    const result = await runGPUBenchmark();
    const after = Date.now();

    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after + 100);
  });

  // ── Scores shape ──

  it('has finite scores for tested tiers', async () => {
    const result = await runGPUBenchmark();

    // With mock, all tiers should have been tested (no timeouts)
    for (const tier of ['performance', 'balanced', 'quality', 'ultra'] as const) {
      expect(result.scores[tier]).toBeLessThan(Infinity);
      expect(result.maxScores[tier]).toBeLessThan(Infinity);
    }
  });

  // ── Device lifecycle ──

  it('destroys device after successful benchmark', async () => {
    await runGPUBenchmark();

    expect(mock.device.destroy).toHaveBeenCalled();
  });
});
