/**
 * GPU Resource Cache — per-device de-duplication of immutable WebGPU resources.
 *
 * Repeated pipeline rebuilds (settings toggles, resizes) recreate identical shader
 * modules, bind-group layouts, samplers and pipelines. Those objects are immutable
 * and safe to share across pipeline instances, so this cache returns the *same*
 * object for a semantically identical descriptor and de-duplicates concurrent
 * async pipeline creation (same key => same in-flight promise).
 *
 * Design
 * ------
 * - One `GpuResourceCache` instance owns a `WeakMap<GPUDevice, DeviceResourceCaches>`,
 *   so entry lifetime is tied to the device and a device can be dropped with
 *   {@link GpuResourceCache.release}. A shared singleton ({@link gpuResourceCache})
 *   is exported for the extension's own shader/pipeline/effect construction.
 * - Shader modules are keyed by their WGSL `code` (plus optional label). Caches of
 *   BGLs / samplers / pipelines are keyed by the caller-supplied logical `key`
 *   combined with a deterministic fingerprint of the descriptor. Two calls with
 *   the same key but a semantically different descriptor therefore never share an
 *   object.
 * - Fingerprinting serializes plain data with sorted keys. Opaque GPU objects
 *   (e.g. a `GPUShaderModule` or `GPUPipelineLayout` inside a pipeline descriptor)
 *   cannot be serialized structurally, so they are identified by their label plus
 *   a stable per-object token. Passing the same cached object reference every time
 *   (which callers do, by fetching the module from this cache) yields a stable key;
 *   passing a freshly created but equivalent module is treated as a distinct
 *   descriptor (a safe cache miss, never a stale hit).
 * - Creation is wrapped in a `pushErrorScope('validation')` / `popErrorScope()`
 *   pair when the device implements them (feature-detected — some mocks and older
 *   devices do not). Async pipelines await the pop result and throw a clear Error
 *   containing the key/label before anything is cached; failures are never cached.
 *   For synchronous creators the scope is still pushed/popped for hygiene, but a
 *   validation error reported asynchronously cannot be thrown from a synchronous
 *   method — it is logged and the returned object is left cached (see note below).
 *
 * Note: `stats()` counts live cache entries across all devices and is decremented
 * by `release()`. Devices that are garbage-collected without an explicit
 * `release()` are not observable through a `WeakMap`, so their counts remain until
 * `release()` or a new class instance is used.
 */

/** Key under which a resource is stored inside one device's caches. */
type ResourceKey = string;

interface DeviceResourceCaches {
  shaderModules: Map<ResourceKey, GPUShaderModule>;
  bindGroupLayouts: Map<ResourceKey, GPUBindGroupLayout>;
  samplers: Map<ResourceKey, GPUSampler>;
  computePipelines: Map<ResourceKey, Promise<GPUComputePipeline>>;
  renderPipelines: Map<ResourceKey, Promise<GPURenderPipeline>>;
}

export interface GpuResourceCacheStats {
  shaderModules: number;
  bindGroupLayouts: number;
  samplers: number;
  computePipelines: number;
  renderPipelines: number;
}

// ─── Stable descriptor fingerprinting ───

/** Stable token assigned to each opaque (non-plain) object seen so far. */
const objectTokens = new WeakMap<object, number>();
let nextObjectToken = 1;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function stableSerialize(value: unknown, seen?: WeakSet<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'undefined':
      return 'undefined';
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'string':
      return JSON.stringify(value);
    case 'function':
      return `fn:${value.name || 'anonymous'}`;
    default:
      break;
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item, seen)).join(',')}]`;
  }

  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as ArrayLike<number>;
    return `${value.constructor.name}(${Array.from(view).join(',')})`;
  }

  if (isPlainObject(value)) {
    const guard = seen ?? new WeakSet<object>();
    if (guard.has(value)) return '[circular]';
    guard.add(value);
    const keys = Object.keys(value).sort();
    const body = keys.map(key => `${JSON.stringify(key)}:${stableSerialize(value[key], guard)}`).join(',');
    return `{${body}}`;
  }

  // Opaque GPU object (shader module, pipeline layout, ...): label + identity.
  const label = (value as { label?: string }).label ?? '';
  let token = objectTokens.get(value);
  if (token === undefined) {
    token = nextObjectToken++;
    objectTokens.set(value, token);
  }
  return `obj:${label}:${token}`;
}

// ─── Error scope feature-detection helpers ───

function supportsErrorScope(device: GPUDevice): boolean {
  const candidate = device as Partial<GPUDevice>;
  return typeof candidate.pushErrorScope === 'function' && typeof candidate.popErrorScope === 'function';
}

function wrapCreationError(kind: string, key: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`[GpuResourceCache] Failed to create ${kind} "${key}": ${message}`);
}

// ─── Cache ───

/**
 * Per-device cache of immutable WebGPU resources.
 *
 * See the module header for key-identity and error-handling semantics.
 */
export class GpuResourceCache {
  private readonly caches = new WeakMap<GPUDevice, DeviceResourceCaches>();
  private readonly counts: GpuResourceCacheStats = {
    shaderModules: 0,
    bindGroupLayouts: 0,
    samplers: 0,
    computePipelines: 0,
    renderPipelines: 0,
  };

  private cacheFor(device: GPUDevice): DeviceResourceCaches {
    let cache = this.caches.get(device);
    if (!cache) {
      cache = {
        shaderModules: new Map(),
        bindGroupLayouts: new Map(),
        samplers: new Map(),
        computePipelines: new Map(),
        renderPipelines: new Map(),
      };
      this.caches.set(device, cache);
    }
    return cache;
  }

  /**
   * Return a cached shader module for `code`, creating it once per device.
   * The optional `label` is forwarded to the descriptor and used in log messages.
   */
  getShaderModule(device: GPUDevice, code: string, label?: string): GPUShaderModule {
    const cache = this.cacheFor(device);
    const key = `shader:${label ?? ''}\u0000${code}`;
    const existing = cache.shaderModules.get(key);
    if (existing) return existing;

    const module = this.createSync(device, 'shader module', label ?? 'shader', () =>
      device.createShaderModule({ code, label }),
    );
    cache.shaderModules.set(key, module);
    this.counts.shaderModules++;
    return module;
  }

  /** Return a cached bind-group layout for `key` + `descriptor`, creating it once per device. */
  getBindGroupLayout(
    device: GPUDevice,
    key: string,
    descriptor: GPUBindGroupLayoutDescriptor,
  ): GPUBindGroupLayout {
    const cache = this.cacheFor(device);
    const fullKey = `bgl:${key}\u0000${stableSerialize(descriptor)}`;
    const existing = cache.bindGroupLayouts.get(fullKey);
    if (existing) return existing;

    const layout = this.createSync(device, 'bind group layout', key, () =>
      device.createBindGroupLayout(descriptor),
    );
    cache.bindGroupLayouts.set(fullKey, layout);
    this.counts.bindGroupLayouts++;
    return layout;
  }

  /** Return a cached sampler for `key` + `descriptor`, creating it once per device. */
  getSampler(device: GPUDevice, key: string, descriptor: GPUSamplerDescriptor): GPUSampler {
    const cache = this.cacheFor(device);
    const fullKey = `sampler:${key}\u0000${stableSerialize(descriptor)}`;
    const existing = cache.samplers.get(fullKey);
    if (existing) return existing;

    const sampler = this.createSync(device, 'sampler', key, () =>
      device.createSampler(descriptor),
    );
    cache.samplers.set(fullKey, sampler);
    this.counts.samplers++;
    return sampler;
  }

  /**
   * Return the async-created compute pipeline for `key` + `descriptor`.
   *
   * Concurrent calls for the same descriptor (on the same device) share one
   * in-flight promise, so `device.createComputePipelineAsync` is invoked once.
   * Failures reject every waiter and are not cached.
   */
  getComputePipeline(
    device: GPUDevice,
    key: string,
    descriptor: GPUComputePipelineDescriptor,
  ): Promise<GPUComputePipeline> {
    const cache = this.cacheFor(device);
    const fullKey = `compute:${key}\u0000${stableSerialize(descriptor)}`;
    const existing = cache.computePipelines.get(fullKey);
    if (existing) return existing;

    const promise = this.createAsync(device, 'compute pipeline', key, () =>
      device.createComputePipelineAsync(descriptor),
    ).catch((error: unknown) => {
      // Never cache a failed creation.
      cache.computePipelines.delete(fullKey);
      this.counts.computePipelines--;
      throw error;
    });
    cache.computePipelines.set(fullKey, promise);
    this.counts.computePipelines++;
    return promise;
  }

  /**
   * Return the async-created render pipeline for `key` + `descriptor`.
   *
   * Concurrent calls for the same descriptor (on the same device) share one
   * in-flight promise, so `device.createRenderPipelineAsync` is invoked once.
   * Failures reject every waiter and are not cached.
   */
  getRenderPipeline(
    device: GPUDevice,
    key: string,
    descriptor: GPURenderPipelineDescriptor,
  ): Promise<GPURenderPipeline> {
    const cache = this.cacheFor(device);
    const fullKey = `render:${key}\u0000${stableSerialize(descriptor)}`;
    const existing = cache.renderPipelines.get(fullKey);
    if (existing) return existing;

    const promise = this.createAsync(device, 'render pipeline', key, () =>
      device.createRenderPipelineAsync(descriptor),
    ).catch((error: unknown) => {
      // Never cache a failed creation.
      cache.renderPipelines.delete(fullKey);
      this.counts.renderPipelines--;
      throw error;
    });
    cache.renderPipelines.set(fullKey, promise);
    this.counts.renderPipelines++;
    return promise;
  }

  /** Drop only `device`'s caches (device loss / teardown). */
  release(device: GPUDevice): void {
    const cache = this.caches.get(device);
    if (!cache) return;
    this.caches.delete(device);
    this.counts.shaderModules -= cache.shaderModules.size;
    this.counts.bindGroupLayouts -= cache.bindGroupLayouts.size;
    this.counts.samplers -= cache.samplers.size;
    this.counts.computePipelines -= cache.computePipelines.size;
    this.counts.renderPipelines -= cache.renderPipelines.size;
  }

  /** Live entry counts across all devices tracked by this cache. */
  stats(): GpuResourceCacheStats {
    return { ...this.counts };
  }

  // ─── Internal creation helpers ───

  private createSync<T>(device: GPUDevice, kind: string, key: string, create: () => T): T {
    if (!supportsErrorScope(device)) {
      try {
        return create();
      } catch (error) {
        throw wrapCreationError(kind, key, error);
      }
    }

    let pushed = false;
    try {
      device.pushErrorScope('validation');
      pushed = true;
    } catch {
      // push failed despite feature detection — proceed without a scope.
    }
    if (!pushed) {
      try {
        return create();
      } catch (error) {
        throw wrapCreationError(kind, key, error);
      }
    }

    let result: T | undefined;
    let createError: unknown;
    let createFailed = false;
    try {
      result = create();
    } catch (error) {
      createError = error;
      createFailed = true;
    }

    // Balance the scope. For synchronous creators the pop result is inherently
    // asynchronous; surface it for diagnostics but do not throw from a sync API.
    try {
      const popResult = device.popErrorScope();
      if (popResult && typeof popResult.then === 'function') {
        popResult
          .then(error => {
            if (error) {
              console.error(
                `[GpuResourceCache] GPU validation error creating ${kind} "${key}": ${error.message}`,
              );
            }
          })
          .catch(() => {
            // A misbehaving mock/device pop must not escape as an unhandled rejection.
          });
      }
    } catch {
      // Pop unavailable despite feature detection — ignore.
    }

    if (createFailed) throw wrapCreationError(kind, key, createError);
    return result as T;
  }

  private async createAsync<T>(
    device: GPUDevice,
    kind: string,
    key: string,
    create: () => Promise<T>,
  ): Promise<T> {
    if (!supportsErrorScope(device)) {
      try {
        return await create();
      } catch (error) {
        throw wrapCreationError(kind, key, error);
      }
    }

    let pushed = false;
    try {
      device.pushErrorScope('validation');
      pushed = true;
    } catch {
      // push failed despite feature detection — proceed without a scope.
    }

    let result: T | undefined;
    let createError: unknown;
    let createFailed = false;
    try {
      result = await create();
    } catch (error) {
      createError = error;
      createFailed = true;
    }

    let validationError: GPUError | null = null;
    if (pushed) {
      try {
        validationError = await device.popErrorScope();
      } catch {
        validationError = null;
      }
    }

    if (validationError) {
      throw new Error(
        `[GpuResourceCache] GPU validation failed for ${kind} "${key}": ${validationError.message}`,
      );
    }
    if (createFailed) throw wrapCreationError(kind, key, createError);
    return result as T;
  }
}

/**
 * Shared cache for the extension's own shader/pipeline/effect construction.
 *
 * Keyed per `GPUDevice`; call {@link GpuResourceCache.release} on device loss or
 * teardown.
 */
export const gpuResourceCache = new GpuResourceCache();
