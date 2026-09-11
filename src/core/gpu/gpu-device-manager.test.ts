/**
 * Tests for GPU Device Manager — device lifecycle, pre-warming, and recovery.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installGPUMock, removeGPUMock } from '@/test/webgpu-mock';
import type { MockGPUObjects } from '@/test/webgpu-mock';
import {
  preWarmGPU,
  claimPreWarmedDevice,
  requestGPUDevice,
  invalidatePreWarm,
  getPreWarmer,
} from './gpu-device-manager';

/** Helper: wait for preWarmGPU's internal async work to complete */
async function awaitPreWarm(): Promise<void> {
  // preWarmGPU is fire-and-forget. We wait by scheduling a microtask
  // after the internal promise chain resolves. The mock resolves synchronously
  // on the next microtask tick, so Promise.resolve() + setTimeout(0) covers it.
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

describe('gpu-device-manager', () => {
  describe('basic preWarm and device operations', () => {
    let mock: MockGPUObjects;

    beforeEach(() => {
      invalidatePreWarm();
      mock = installGPUMock();
    });

    afterEach(() => {
      removeGPUMock();
    });

    // ── preWarmGPU ──

    it('preWarmGPU() makes claimPreWarmedDevice() return a device', async () => {
      preWarmGPU();
      await awaitPreWarm();

      const device = claimPreWarmedDevice();
      expect(device).toBeTruthy();
      expect(device).toBe(mock.device);
    });

    it('preWarmGPU() is idempotent — second call is a no-op', async () => {
      preWarmGPU();
      preWarmGPU(); // second call should return immediately
      await awaitPreWarm();

      const gpu = navigator.gpu as any;
      expect(gpu.requestAdapter).toHaveBeenCalledTimes(1);
    });

    it('preWarmGPU() requests adapter with high-performance on non-Windows', async () => {
      preWarmGPU();
      await awaitPreWarm();

      const gpu = navigator.gpu as any;
      expect(gpu.requestAdapter).toHaveBeenCalledWith(
        expect.objectContaining({ powerPreference: 'high-performance' }),
      );
    });

    it('preWarmGPU() does not set powerPreference on Windows', async () => {
      const origPlatform = navigator.platform;
      try {
        Object.defineProperty(navigator, 'platform', {
          value: 'Win32',
          configurable: true,
          writable: true,
        });
      } catch {
        (navigator as any).platform = 'Win32';
      }

      preWarmGPU();
      await awaitPreWarm();

      const gpu = navigator.gpu as any;
      expect(gpu.requestAdapter).toHaveBeenCalled();
      expect(gpu.requestAdapter).toHaveBeenCalledWith({});

      // Restore
      try {
        Object.defineProperty(navigator, 'platform', {
          value: origPlatform,
          configurable: true,
          writable: true,
        });
      } catch {
        (navigator as any).platform = origPlatform;
      }
    });

    it('requestGPUDevice() returns device and adapter with correct limits', async () => {
      const result = await requestGPUDevice();

      expect(result.device).toBe(mock.device);
      expect(result.adapter).toBeDefined();

      expect(mock.adapter.requestDevice).toHaveBeenCalledWith(
        expect.objectContaining({
          requiredLimits: expect.objectContaining({
            maxBufferSize: expect.any(Number),
            maxStorageBufferBindingSize: expect.any(Number),
          }),
          requiredFeatures: expect.any(Array),
        }),
      );
    });

    it('requestGPUDevice() requests timestamp-query when the adapter advertises it', async () => {
      mock.adapter.features.add('timestamp-query');

      await requestGPUDevice();

      expect(mock.adapter.requestDevice).toHaveBeenCalledWith(
        expect.objectContaining({ requiredFeatures: ['timestamp-query'] }),
      );
    });

    it('requestGPUDevice() omits timestamp-query when the adapter does not advertise it', async () => {
      mock.adapter.features.delete('timestamp-query');

      await requestGPUDevice();

      expect(mock.adapter.requestDevice).toHaveBeenCalledWith(
        expect.objectContaining({ requiredFeatures: [] }),
      );
    });

    it('preWarmGPU() requests timestamp-query when the adapter advertises it', async () => {
      mock.adapter.features.add('timestamp-query');

      preWarmGPU();
      await awaitPreWarm();

      expect(mock.adapter.requestDevice).toHaveBeenCalledWith(
        expect.objectContaining({ requiredFeatures: ['timestamp-query'] }),
      );
    });

    it('preWarmGPU() omits timestamp-query when the adapter does not advertise it', async () => {
      mock.adapter.features.delete('timestamp-query');

      preWarmGPU();
      await awaitPreWarm();

      expect(mock.adapter.requestDevice).toHaveBeenCalledWith(
        expect.objectContaining({ requiredFeatures: [] }),
      );
    });

    it('requestGPUDevice() throws when adapter is null', async () => {
      removeGPUMock();
      installGPUMock({ adapterNull: true });

      await expect(requestGPUDevice()).rejects.toThrow('WebGPU not supported: No adapter found.');

      removeGPUMock();
      mock = installGPUMock();
    });

    it('claimPreWarmedDevice() returns device and clears cached reference', async () => {
      preWarmGPU();
      await awaitPreWarm();

      const device = claimPreWarmedDevice();
      expect(device).toBe(mock.device);

      const second = claimPreWarmedDevice();
      expect(second).toBeNull();
    });

    it('getPreWarmer() returns the same singleton instance', () => {
      const a = getPreWarmer();
      const b = getPreWarmer();
      expect(a).toBe(b);
      expect(a).toBeDefined();
    });

    it('requestGPUDevice() uses high-performance on non-Windows', async () => {
      await requestGPUDevice();

      const gpu = navigator.gpu as any;
      expect(gpu.requestAdapter).toHaveBeenCalledWith(
        expect.objectContaining({ powerPreference: 'high-performance' }),
      );
    });
  });

  // ── 30-second auto-destroy timer (uses fake timers) ──

  describe('30s auto-destroy timer', () => {
    let mock: MockGPUObjects;

    beforeEach(() => {
      invalidatePreWarm();
      mock = installGPUMock();
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      removeGPUMock();
    });

    it('destroys prewarmed device after 30s if unclaimed', async () => {
      preWarmGPU();
      // Let the prewarm async work complete (microtasks)
      await vi.advanceTimersByTimeAsync(0);

      const device = mock.device;
      expect(device.destroy).not.toHaveBeenCalled();

      // Advance 30 seconds
      vi.advanceTimersByTime(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect(device.destroy).toHaveBeenCalled();
    });

    it('claimPreWarmedDevice() cancels the 30s auto-destroy timer', async () => {
      preWarmGPU();
      await vi.advanceTimersByTimeAsync(0);

      claimPreWarmedDevice();

      // Advance 30 seconds — device should NOT be destroyed
      vi.advanceTimersByTime(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mock.device.destroy).not.toHaveBeenCalled();
    });

    it('invalidatePreWarm() clears timer and destroys device', async () => {
      preWarmGPU();
      await vi.advanceTimersByTimeAsync(0);

      // Don't claim — we want the device still present so invalidatePreWarm destroys it
      invalidatePreWarm();

      // Device should be destroyed
      expect(mock.device.destroy).toHaveBeenCalled();
      expect(claimPreWarmedDevice()).toBeNull();

      // Advance 30s — no new destroy (timer was cleared)
      const destroyCallCount = mock.device.destroy.mock.calls.length;
      vi.advanceTimersByTime(30000);
      await vi.advanceTimersByTimeAsync(0);
      expect(mock.device.destroy).toHaveBeenCalledTimes(destroyCallCount);
    });
  });

  // ── No navigator.gpu ──

  describe('without navigator.gpu', () => {
    beforeEach(() => {
      invalidatePreWarm();
      removeGPUMock();
    });

    it('preWarmGPU() is a no-op when navigator.gpu is absent', async () => {
      preWarmGPU();
      await Promise.resolve();
      expect(claimPreWarmedDevice()).toBeNull();
    });
  });

  // ── No adapter (adapter returns null) ──

  describe('with null adapter', () => {
    beforeEach(() => {
      invalidatePreWarm();
      installGPUMock({ adapterNull: true });
    });

    afterEach(() => {
      removeGPUMock();
    });

    it('preWarmGPU() is a no-op when requestAdapter returns null', async () => {
      preWarmGPU();
      await Promise.resolve();
      expect(claimPreWarmedDevice()).toBeNull();
    });
  });
});
