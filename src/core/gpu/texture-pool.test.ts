/**
 * Tests for {@link TexturePool}: reuse, in-flight tracking, LRU budget
 * eviction, dispose, and release-safety.
 *
 * Uses the shared WebGPU mock from `@/test/webgpu-mock` (which provides
 * `createTexture` textures with spy-able `destroy`) — it is not modified here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installGPUMock, removeGPUMock } from '@/test/webgpu-mock';
import type { MockGPUObjects, MockGPUTexture } from '@/test/webgpu-mock';
import { TexturePool } from './texture-pool';
import type { TexturePoolDescriptor } from './texture-pool';

function makeDescriptor(
    overrides: Partial<TexturePoolDescriptor> = {},
): TexturePoolDescriptor {
    return {
        width: 10,
        height: 10,
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        ...overrides,
    };
}

function destroySpy(texture: GPUTexture): ReturnType<typeof vi.fn> {
    return (texture as unknown as MockGPUTexture).destroy;
}

describe('TexturePool', () => {
    let mock: MockGPUObjects;
    let device: GPUDevice;

    beforeEach(() => {
        mock = installGPUMock();
        device = mock.device as unknown as GPUDevice;
    });

    afterEach(() => {
        removeGPUMock();
    });

    // ── Reuse / hit accounting ──

    it('returns the SAME texture after acquire → release → acquire and counts a hit', () => {
        const pool = new TexturePool(device);
        const descriptor = makeDescriptor();

        const first = pool.acquire(descriptor);
        expect(pool.stats().misses).toBe(1);
        expect(pool.stats().checkedOut).toBe(1);

        pool.release(first);
        expect(pool.stats().free).toBe(1);
        expect(pool.stats().checkedOut).toBe(0);

        const second = pool.acquire(descriptor);
        expect(second).toBe(first);
        expect(pool.stats().hits).toBe(1);
        expect(pool.stats().misses).toBe(1);
    });

    it('treats label as part of the identity (label group)', () => {
        const pool = new TexturePool(device);

        const unlabelled = pool.acquire(makeDescriptor());
        const labelled = pool.acquire(makeDescriptor({ label: 'tier-input' }));

        expect(labelled).not.toBe(unlabelled);
        expect(pool.stats().misses).toBe(2);
    });

    // ── Distinct descriptors ──

    it('allocates distinct textures for size, format and usage differences', () => {
        const pool = new TexturePool(device);

        const base = pool.acquire(makeDescriptor());
        const bigger = pool.acquire(makeDescriptor({ width: 20 }));
        const otherFormat = pool.acquire(makeDescriptor({ format: 'bgra8unorm' }));
        const otherUsage = pool.acquire(
            makeDescriptor({ usage: GPUTextureUsage.TEXTURE_BINDING }),
        );

        expect(new Set([base, bigger, otherFormat, otherUsage]).size).toBe(4);
        expect(pool.stats().misses).toBe(4);
        expect(pool.stats().hits).toBe(0);
        expect(pool.stats().checkedOut).toBe(4);
    });

    // ── In-flight safety ──

    it('never hands out a texture that is still checked out', () => {
        const pool = new TexturePool(device);
        const descriptor = makeDescriptor();

        const first = pool.acquire(descriptor);
        const second = pool.acquire(descriptor);

        expect(second).not.toBe(first);
        expect(pool.stats().checkedOut).toBe(2);
        expect(pool.stats().hits).toBe(0);
        expect(pool.stats().misses).toBe(2);
    });

    // ── Byte accounting ──

    it('accounts bytes from size/format/sampleCount (rgba8unorm = 4 Bpp)', () => {
        const pool = new TexturePool(device);

        pool.acquire(makeDescriptor()); // 10 × 10 × 4 = 400
        expect(pool.stats().bytes).toBe(400);

        pool.acquire(makeDescriptor({ width: 20 })); // 20 × 10 × 4 = 800
        expect(pool.stats().bytes).toBe(1200);

        pool.acquire(makeDescriptor({ sampleCount: 4 })); // 10 × 10 × 4 × 4 = 1600
        expect(pool.stats().bytes).toBe(2800);
    });

    // ── LRU eviction under budget ──

    it('evicts the least-recently-used free texture (not the newest) and preserves the budget', () => {
        const pool = new TexturePool(device, 900); // each 10×10 rgba8 = 400 bytes
        const x = pool.acquire(makeDescriptor({ label: 'x' }));
        const y = pool.acquire(makeDescriptor({ label: 'y' }));

        pool.release(x);
        pool.release(y);
        expect(pool.stats().free).toBe(2);
        expect(pool.stats().bytes).toBe(800); // within budget → no eviction yet

        // A third, distinct texture pushes total bytes to 1200 (> budget) while
        // x and y remain free. Releasing it must evict the OLDEST free texture
        // (x), not the texture that was just released.
        const z = pool.acquire(makeDescriptor({ label: 'z' }));
        expect(pool.stats().bytes).toBe(1200);

        pool.release(z);
        expect(pool.stats().evictions).toBe(1);
        expect(pool.stats().free).toBe(2);
        expect(pool.stats().bytes).toBeLessThanOrEqual(pool.stats().budgetBytes);

        expect(destroySpy(x)).toHaveBeenCalledTimes(1);
        expect(destroySpy(y)).not.toHaveBeenCalled();
        expect(destroySpy(z)).not.toHaveBeenCalled();
    });

    it('evicts checked-out-free textures in LRU order until within budget', () => {
        const pool = new TexturePool(device, 500); // room for a single 400-byte texture
        const descriptor = makeDescriptor();

        const a = pool.acquire(descriptor);
        const b = pool.acquire(descriptor);
        const c = pool.acquire(descriptor);
        pool.release(a);
        pool.release(b);
        pool.release(c);

        expect(pool.stats().bytes).toBeLessThanOrEqual(pool.stats().budgetBytes);
        expect(pool.stats().evictions).toBe(2);
        expect(destroySpy(a)).toHaveBeenCalledTimes(1);
        expect(destroySpy(b)).toHaveBeenCalledTimes(1);
        expect(destroySpy(c)).not.toHaveBeenCalled();
    });

    // ── dispose ──

    it('dispose destroys all free textures and resets stats', () => {
        const pool = new TexturePool(device);
        const descriptor = makeDescriptor();

        const a = pool.acquire(descriptor);
        const b = pool.acquire(descriptor);
        pool.release(a);
        pool.release(b);
        expect(pool.stats().free).toBe(2);

        pool.dispose();

        expect(destroySpy(a)).toHaveBeenCalledTimes(1);
        expect(destroySpy(b)).toHaveBeenCalledTimes(1);
        expect(pool.stats()).toMatchObject({
            free: 0,
            checkedOut: 0,
            bytes: 0,
            evictions: 0,
            hits: 0,
            misses: 0,
        });
    });

    it('dispose leaves checked-out textures untouched and forgets them', () => {
        const pool = new TexturePool(device);
        const texture = pool.acquire(makeDescriptor());

        pool.dispose();

        expect(destroySpy(texture)).not.toHaveBeenCalled();
        expect(pool.stats().checkedOut).toBe(0);

        // A release after dispose is a safe no-op (ownership was forgotten).
        expect(() => pool.release(texture)).not.toThrow();
        expect(pool.stats().free).toBe(0);
    });

    // ── release safety ──

    it('treats double-release and foreign-release as no-ops', () => {
        const pool = new TexturePool(device);
        const descriptor = makeDescriptor();

        const owned = pool.acquire(descriptor);
        const foreign = device.createTexture({
            size: [1, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING,
        });

        expect(() => pool.release(foreign)).not.toThrow();

        pool.release(owned);
        expect(pool.stats().free).toBe(1);

        expect(() => pool.release(owned)).not.toThrow();
        expect(pool.stats().free).toBe(1);

        expect(destroySpy(owned)).not.toHaveBeenCalled();
        expect(destroySpy(foreign)).not.toHaveBeenCalled();
    });
});
