/**
 * Tests for the per-device GPU resource cache.
 *
 * The shared WebGPU mock (src/test/webgpu-mock.ts) is used for the synchronous
 * resource paths (shader modules, bind-group layouts, samplers). It does not
 * implement `createComputePipelineAsync`, so the async pipeline paths and the
 * validation-failure paths use a minimal local fake device defined here.
 * The shared mock is intentionally not modified.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installGPUMock, removeGPUMock } from '@/test/webgpu-mock';
import { GpuResourceCache } from './gpu-resource-cache';

// ─── Minimal local fake device (covers the async + error-scope paths) ───

interface FakeDevice {
  createShaderModule: ReturnType<typeof vi.fn>;
  createBindGroupLayout: ReturnType<typeof vi.fn>;
  createSampler: ReturnType<typeof vi.fn>;
  createComputePipelineAsync: ReturnType<typeof vi.fn>;
  createRenderPipelineAsync: ReturnType<typeof vi.fn>;
  pushErrorScope: ReturnType<typeof vi.fn>;
  popErrorScope: ReturnType<typeof vi.fn>;
}

function createFakeDevice(overrides: Record<string, unknown> = {}): FakeDevice {
  const device: FakeDevice = {
    createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => ({ __kind: 'shader', ...descriptor })),
    createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => ({ __kind: 'bgl', ...descriptor })),
    createSampler: vi.fn((descriptor: GPUSamplerDescriptor) => ({ __kind: 'sampler', ...descriptor })),
    createComputePipelineAsync: vi.fn(async (descriptor: GPUComputePipelineDescriptor) => ({ __kind: 'compute', ...descriptor })),
    createRenderPipelineAsync: vi.fn(async (descriptor: GPURenderPipelineDescriptor) => ({ __kind: 'render', ...descriptor })),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(async () => null),
  };
  return Object.assign(device, overrides);
}

function asDevice(device: FakeDevice | object): GPUDevice {
  return device as unknown as GPUDevice;
}

// A single shared (opaque) module object so repeated descriptor builders produce
// the same cache fingerprint, mirroring how real callers reuse a cached module.
const SHARED_MODULE = { __kind: 'module' } as unknown as GPUShaderModule;

function computeDescriptor(): GPUComputePipelineDescriptor {
  return { layout: 'auto', compute: { module: SHARED_MODULE, entryPoint: 'main' } };
}

function renderDescriptor(): GPURenderPipelineDescriptor {
  return {
    layout: 'auto',
    vertex: { module: SHARED_MODULE, entryPoint: 'main' },
  } as GPURenderPipelineDescriptor;
}

describe('GpuResourceCache (shared WebGPU mock, synchronous resources)', () => {
  let cache: GpuResourceCache;
  let device: GPUDevice;

  beforeEach(() => {
    const mock = installGPUMock();
    cache = new GpuResourceCache();
    device = mock.device as unknown as GPUDevice;
  });

  afterEach(() => {
    removeGPUMock();
  });

  it('returns identical shader module object identity for the same code', () => {
    const a = cache.getShaderModule(device, 'shader-code', 'my-shader');
    const b = cache.getShaderModule(device, 'shader-code', 'my-shader');

    expect(a).toBe(b);
    expect(cache.stats().shaderModules).toBe(1);
  });

  it('returns distinct shader modules for different code', () => {
    const a = cache.getShaderModule(device, 'shader-a');
    const b = cache.getShaderModule(device, 'shader-b');

    expect(a).not.toBe(b);
    expect(cache.stats().shaderModules).toBe(2);
  });

  it('returns identical bind-group layout object identity for the same key + descriptor', () => {
    const a = cache.getBindGroupLayout(device, 'bgl-key', { entries: [] });
    const b = cache.getBindGroupLayout(device, 'bgl-key', { entries: [] });

    expect(a).toBe(b);
    expect(cache.stats().bindGroupLayouts).toBe(1);
  });

  it('returns distinct bind-group layouts for different descriptors under the same key', () => {
    const a = cache.getBindGroupLayout(device, 'bgl-key', { entries: [] });
    const b = cache.getBindGroupLayout(device, 'bgl-key', {
      entries: [{ binding: 0, visibility: 4, buffer: { type: 'uniform' } }],
    });

    expect(a).not.toBe(b);
    expect(cache.stats().bindGroupLayouts).toBe(2);
  });

  it('returns identical sampler object identity for the same key + descriptor', () => {
    const a = cache.getSampler(device, 'sampler-key', { magFilter: 'linear' });
    const b = cache.getSampler(device, 'sampler-key', { magFilter: 'linear' });

    expect(a).toBe(b);
    expect(cache.stats().samplers).toBe(1);
  });

  it('returns distinct samplers for different descriptors under the same key', () => {
    const a = cache.getSampler(device, 'sampler-key', { magFilter: 'linear' });
    const b = cache.getSampler(device, 'sampler-key', { magFilter: 'nearest' });

    expect(a).not.toBe(b);
    expect(cache.stats().samplers).toBe(2);
  });

  it('does not share resources across different devices', () => {
    const other = asDevice(createFakeDevice());
    const a = cache.getShaderModule(device, 'code');
    const b = cache.getShaderModule(other, 'code');

    expect(a).not.toBe(b);
    expect(cache.stats().shaderModules).toBe(2);
  });
});

describe('GpuResourceCache (local fake device, async pipelines + validation)', () => {
  it('de-duplicates concurrent compute pipeline creation for the same key', async () => {
    const cache = new GpuResourceCache();
    const device = createFakeDevice();
    const descriptor: GPUComputePipelineDescriptor = computeDescriptor();

    const [a, b] = await Promise.all([
      cache.getComputePipeline(asDevice(device), 'shared', descriptor),
      cache.getComputePipeline(asDevice(device), 'shared', descriptor),
    ]);

    expect(device.createComputePipelineAsync).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(cache.stats().computePipelines).toBe(1);
  });

  it('returns distinct pipelines for different keys', async () => {
    const cache = new GpuResourceCache();
    const device = createFakeDevice();
    const descriptor: GPUComputePipelineDescriptor = computeDescriptor();

    const a = await cache.getComputePipeline(asDevice(device), 'key-a', descriptor);
    const b = await cache.getComputePipeline(asDevice(device), 'key-b', descriptor);

    expect(device.createComputePipelineAsync).toHaveBeenCalledTimes(2);
    expect(a).not.toBe(b);
    expect(cache.stats().computePipelines).toBe(2);
  });

  it('caches a resolved compute pipeline promise for subsequent calls', async () => {
    const cache = new GpuResourceCache();
    const device = createFakeDevice();

    const first = cache.getComputePipeline(asDevice(device), 'key', computeDescriptor());
    const second = cache.getComputePipeline(asDevice(device), 'key', computeDescriptor());

    expect(first).toBe(second);
    expect(device.createComputePipelineAsync).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates concurrent render pipeline creation for the same key', async () => {
    const cache = new GpuResourceCache();
    const device = createFakeDevice();
    const descriptor = renderDescriptor();

    const [a, b] = await Promise.all([
      cache.getRenderPipeline(asDevice(device), 'shared', descriptor),
      cache.getRenderPipeline(asDevice(device), 'shared', descriptor),
    ]);

    expect(device.createRenderPipelineAsync).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(cache.stats().renderPipelines).toBe(1);
  });

  it('throws and does not cache when createComputePipelineAsync rejects', async () => {
    const cache = new GpuResourceCache();
    const device = createFakeDevice({
      createComputePipelineAsync: vi.fn().mockRejectedValue(new Error('boom')),
    });

    await expect(
      cache.getComputePipeline(asDevice(device), 'bad-key', computeDescriptor()),
    ).rejects.toThrow(/bad-key/);

    expect(cache.stats().computePipelines).toBe(0);

    // A retry must call the device again (the failed promise was evicted).
    await expect(
      cache.getComputePipeline(asDevice(device), 'bad-key', computeDescriptor()),
    ).rejects.toThrow();
    expect(device.createComputePipelineAsync).toHaveBeenCalledTimes(2);
  });

  it('throws and does not cache when popErrorScope reports a validation error', async () => {
    const cache = new GpuResourceCache();
    const device = createFakeDevice({
      popErrorScope: vi.fn().mockResolvedValue({ message: 'invalid shader module' }),
    });

    await expect(
      cache.getComputePipeline(asDevice(device), 'invalid-key', computeDescriptor()),
    ).rejects.toThrow(/invalid shader module/);

    expect(cache.stats().computePipelines).toBe(0);
  });

  it('wraps synchronous creation failures and does not cache them', () => {
    const cache = new GpuResourceCache();
    const device = createFakeDevice({
      createShaderModule: vi.fn(() => {
        throw new Error('synchronous failure');
      }),
    });

    expect(() => cache.getShaderModule(asDevice(device), 'code', 'bad')).toThrow(/bad/);
    expect(cache.stats().shaderModules).toBe(0);
  });

  it('works without error-scope support (feature-detected)', async () => {
    const cache = new GpuResourceCache();
    const noScopeDevice = {
      createShaderModule: vi.fn(() => ({ __kind: 'shader' })),
      createComputePipelineAsync: vi.fn(async () => ({ __kind: 'compute' })),
    };

    const shader = cache.getShaderModule(asDevice(noScopeDevice), 'code');
    expect(shader).toBeDefined();
    await expect(
      cache.getComputePipeline(asDevice(noScopeDevice), 'key', computeDescriptor()),
    ).resolves.toBeDefined();
    expect(cache.stats().shaderModules).toBe(1);
    expect(cache.stats().computePipelines).toBe(1);
  });

  it('release(device) drops that device caches and resets stats', async () => {
    const cache = new GpuResourceCache();
    const device = createFakeDevice();

    cache.getShaderModule(asDevice(device), 'code', 'shader');
    cache.getBindGroupLayout(asDevice(device), 'bgl', { entries: [] });
    cache.getSampler(asDevice(device), 'sampler', { magFilter: 'linear' });
    await cache.getComputePipeline(asDevice(device), 'compute', computeDescriptor());
    await cache.getRenderPipeline(asDevice(device), 'render', renderDescriptor());

    expect(cache.stats()).toEqual({
      shaderModules: 1,
      bindGroupLayouts: 1,
      samplers: 1,
      computePipelines: 1,
      renderPipelines: 1,
    });

    cache.release(asDevice(device));

    expect(cache.stats()).toEqual({
      shaderModules: 0,
      bindGroupLayouts: 0,
      samplers: 0,
      computePipelines: 0,
      renderPipelines: 0,
    });

    // After release, resources are recreated rather than served stale.
    cache.getShaderModule(asDevice(device), 'code', 'shader');
    expect(device.createShaderModule).toHaveBeenCalledTimes(2);
  });

  it('release(device) only affects the released device', () => {
    const cache = new GpuResourceCache();
    const deviceA = createFakeDevice();
    const deviceB = createFakeDevice();

    cache.getShaderModule(asDevice(deviceA), 'code');
    cache.getShaderModule(asDevice(deviceB), 'code');

    cache.release(asDevice(deviceA));

    expect(cache.getShaderModule(asDevice(deviceB), 'code')).toBeDefined();
    // Device B still serves its cached object (no extra creation).
    expect(deviceB.createShaderModule).toHaveBeenCalledTimes(1);
    expect(cache.stats().shaderModules).toBe(1);
  });
});
