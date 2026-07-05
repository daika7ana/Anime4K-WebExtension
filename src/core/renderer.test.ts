import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installGPUMock, removeGPUMock, type MockGPUObjects } from '@/test/webgpu-mock';
import type { Dimensions, EnhancementEffect } from '@/types';
import { RendererInitializationError } from '@core/errors';

const {
  mockClaimPreWarmedDevice,
  mockRequestGPUDevice,
  mockInvalidatePreWarm,
  mockGetPreWarmer,
  mockBuildEffectPipelines,
  mockParamsEqual,
} = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    mockClaimPreWarmedDevice: fn(),
    mockRequestGPUDevice: fn(),
    mockInvalidatePreWarm: fn(),
    mockGetPreWarmer: fn(),
    mockBuildEffectPipelines: fn(),
    mockParamsEqual: fn(),
  };
});

vi.mock('@core/gpu/gpu-device-manager', () => ({
  preWarmGPU: vi.fn(),
  claimPreWarmedDevice: mockClaimPreWarmedDevice,
  requestGPUDevice: mockRequestGPUDevice,
  invalidatePreWarm: mockInvalidatePreWarm,
  getPreWarmer: mockGetPreWarmer,
}));

vi.mock('@core/gpu/pipeline-builder', () => ({
  buildEffectPipelines: mockBuildEffectPipelines,
  paramsEqual: mockParamsEqual,
}));

vi.mock('@core/utils/yield-utils', () => ({
  yieldToMain: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@utils/i18n', () => ({
  t: vi.fn((_key: string, fallback?: string) => fallback ?? _key),
}));

vi.mock('@shaders/fullscreen-textured-quad.wgsl', () => ({ default: '// mock' }));
vi.mock('@shaders/sample-external-texture.wgsl', () => ({ default: '// mock' }));

import { Renderer } from '@core/renderer';

const HAVE_ENOUGH_DATA = 4;
const HAVE_NOTHING = 0;

const DEFAULT_EFFECTS: EnhancementEffect[] = [
  { id: 'test/effect', name: 'Test Effect', className: 'TestEffect', params: { strength: 1.0 } },
];

const DEFAULT_DIMENSIONS: Dimensions = { width: 1920, height: 1080 };

function createMockVideo(opts: { readyState?: number; videoWidth?: number; videoHeight?: number } = {}) {
  const video = document.createElement('video');
  Object.defineProperty(video, 'readyState', { value: opts.readyState ?? HAVE_ENOUGH_DATA, configurable: true, writable: true });
  Object.defineProperty(video, 'videoWidth', { value: opts.videoWidth ?? 1920, configurable: true });
  Object.defineProperty(video, 'videoHeight', { value: opts.videoHeight ?? 1080, configurable: true });
  // jsdom doesn't always define HTMLMediaElement constants — polyfill them
  Object.defineProperty(video, 'HAVE_NOTHING', { value: 0, configurable: true });
  Object.defineProperty(video, 'HAVE_METADATA', { value: 1, configurable: true });
  Object.defineProperty(video, 'HAVE_CURRENT_DATA', { value: 2, configurable: true });
  Object.defineProperty(video, 'HAVE_FUTURE_DATA', { value: 3, configurable: true });
  Object.defineProperty(video, 'HAVE_ENOUGH_DATA', { value: 4, configurable: true });
  Object.defineProperty(video, 'requestVideoFrameCallback', { value: vi.fn(() => 1), configurable: true });
  Object.defineProperty(video, 'cancelVideoFrameCallback', { value: vi.fn(), configurable: true });
  return video;
}

function createMockPipeline() {
  return {
    pass: vi.fn().mockResolvedValue(undefined),
    getOutputTexture: vi.fn().mockReturnValue({
      createView: vi.fn(() => ({ label: 'output-view' })),
      width: 1920,
      height: 1080,
      destroy: vi.fn(),
    }),
    destroy: vi.fn(),
    updateParam: vi.fn(),
  };
}

describe('Renderer', () => {
  let mock: MockGPUObjects;
  let video: HTMLVideoElement;
  let canvas: HTMLCanvasElement;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = installGPUMock();
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 1920, height: 1080 }));
    vi.stubGlobal('OffscreenCanvas', class {
      width: number; height: number;
      constructor(w: number, h: number) { this.width = w; this.height = h; }
      getContext(_t: string) {
        return { fillRect: vi.fn(), drawImage: vi.fn(), getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([100, 100, 100, 255]) })) };
      }
    });
    vi.stubGlobal('VideoFrame', class {
      constructor(_src: unknown, _init?: unknown) {}
      close = vi.fn();
    });

    mockClaimPreWarmedDevice.mockReturnValue(null);
    mockRequestGPUDevice.mockResolvedValue({ device: mock.device as unknown as GPUDevice, adapter: mock.adapter as unknown as GPUAdapter });
    mockInvalidatePreWarm.mockImplementation(() => {});
    mockGetPreWarmer.mockReturnValue({ warm: vi.fn().mockResolvedValue(undefined) });
    mockParamsEqual.mockReturnValue(false);
    mockBuildEffectPipelines.mockResolvedValue([createMockPipeline()]);

    video = createMockVideo();
    canvas = document.createElement('canvas');
  });

  afterEach(() => {
    removeGPUMock();
  });

  async function createRenderer(overrides: Record<string, unknown> = {}): Promise<Renderer> {
    const r = await Renderer.create({
      video: (overrides.video as HTMLVideoElement) ?? video,
      canvas: (overrides.canvas as HTMLCanvasElement) ?? canvas,
      effects: (overrides.effects as EnhancementEffect[]) ?? DEFAULT_EFFECTS,
      targetDimensions: (overrides.targetDimensions as Dimensions) ?? DEFAULT_DIMENSIONS,
      onError: overrides.onError as ((error: Error) => void) | undefined,
      onFirstFrameRendered: overrides.onFirstFrameRendered as (() => void) | undefined,
      onFrameRendered: overrides.onFrameRendered as ((frameTime: number) => void) | undefined,
      onProgress: overrides.onProgress as ((stage: string | null, current?: number, total?: number) => void) | undefined,
    });
    await Promise.resolve();
    return r;
  }

  describe('create()', () => {
    it('claims prewarmed device when available', async () => {
      mockClaimPreWarmedDevice.mockReturnValue(mock.device as unknown as GPUDevice);
      const r = await createRenderer();
      expect(mockClaimPreWarmedDevice).toHaveBeenCalled();
      expect(mockRequestGPUDevice).not.toHaveBeenCalled();
      r.destroy();
    });

    it('falls back to requestGPUDevice when no prewarmed device', async () => {
      mockClaimPreWarmedDevice.mockReturnValue(null);
      const r = await createRenderer();
      expect(mockRequestGPUDevice).toHaveBeenCalled();
      r.destroy();
    });

    it('waits for video loadeddata when readyState < HAVE_FUTURE_DATA', async () => {
      const slowVideo = createMockVideo({ readyState: HAVE_NOTHING });
      mockClaimPreWarmedDevice.mockReturnValue(mock.device as unknown as GPUDevice);

      const createPromise = createRenderer({ video: slowVideo });
      expect(mockClaimPreWarmedDevice).not.toHaveBeenCalled();

      slowVideo.dispatchEvent(new Event('loadeddata'));
      const r = await createPromise;
      expect(mockClaimPreWarmedDevice).toHaveBeenCalled();
      r.destroy();
    });

    it('gets WebGPU context from canvas', async () => {
      const getContextSpy = vi.spyOn(canvas, 'getContext');
      const r = await createRenderer();
      expect(getContextSpy).toHaveBeenCalledWith('webgpu');
      r.destroy();
    });

    it('configures WebGPU context', async () => {
      const r = await createRenderer();
      expect(mock.context.configure).toHaveBeenCalled();
      const cfgCall = (mock.context.configure as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(cfgCall.device).toBeDefined();
      expect(cfgCall.format).toBe('bgra8unorm');
      expect(cfgCall.alphaMode).toBe('premultiplied');
      r.destroy();
    });

    it('throws RendererInitializationError when WebGPU context unavailable', async () => {
      const orig = HTMLCanvasElement.prototype.getContext;
      (HTMLCanvasElement.prototype as any).getContext = function (ctxId: string, ...args: unknown[]) {
        if (ctxId === 'webgpu') return null;
        return (orig as any).apply(this, [ctxId, ...args]);
      };
      await expect(createRenderer()).rejects.toThrow(RendererInitializationError);
    });

    it('throws RendererInitializationError when requestGPUDevice fails', async () => {
      mockClaimPreWarmedDevice.mockReturnValue(null);
      mockRequestGPUDevice.mockRejectedValue(new Error('WebGPU not supported'));
      await expect(createRenderer()).rejects.toThrow(RendererInitializationError);
    });

    it('calls onProgress during initialization', async () => {
      const onProgress = vi.fn();
      const r = await createRenderer({ onProgress });
      expect(onProgress).toHaveBeenCalled();
      r.destroy();
    });

    it('calls onFirstFrameRendered after first frame', async () => {
      const onFirstFrameRendered = vi.fn();
      const r = await createRenderer({ onFirstFrameRendered });
      expect(onFirstFrameRendered).toHaveBeenCalled();
      r.destroy();
    });

    it('starts render loop via requestVideoFrameCallback', async () => {
      const r = await createRenderer();
      const rvfc = (video as unknown as { requestVideoFrameCallback: ReturnType<typeof vi.fn> }).requestVideoFrameCallback;
      expect(rvfc).toHaveBeenCalled();
      r.destroy();
    });
  });

  describe('destroy()', () => {
    it('stops render loop by calling cancelVideoFrameCallback', async () => {
      const r = await createRenderer();
      r.destroy();
      const cvfc = (video as unknown as { cancelVideoFrameCallback: ReturnType<typeof vi.fn> }).cancelVideoFrameCallback;
      expect(cvfc).toHaveBeenCalled();
    });

    it('destroys all effect pipelines', async () => {
      const mockPipeline = createMockPipeline();
      mockBuildEffectPipelines.mockResolvedValue([mockPipeline]);
      const r = await createRenderer();
      r.destroy();
      expect(mockPipeline.destroy).toHaveBeenCalled();
    });

    it('unconfigures the WebGPU context', async () => {
      const r = await createRenderer();
      r.destroy();
      expect(mock.context.unconfigure).toHaveBeenCalled();
    });

    it('calls invalidatePreWarm', async () => {
      const r = await createRenderer();
      r.destroy();
      expect(mockInvalidatePreWarm).toHaveBeenCalled();
    });

    it('destroys the GPU device', async () => {
      const r = await createRenderer();
      r.destroy();
      const dev = mock.device as unknown as { destroy: ReturnType<typeof vi.fn> };
      expect(dev.destroy).toHaveBeenCalled();
    });

    it('is idempotent', async () => {
      const r = await createRenderer();
      r.destroy();
      expect(() => r.destroy()).not.toThrow();
    });
  });

  describe('device loss recovery', () => {
    it('recovers when device.lost reason !== "destroyed"', async () => {
      const r = await createRenderer();
      mockRequestGPUDevice.mockClear();
      mock.deviceLostDeferred.resolve({ reason: 'unknown', message: 'lost' });
      await Promise.resolve(); await Promise.resolve();
      expect(mockRequestGPUDevice).toHaveBeenCalled();
      r.destroy();
    });

    it('does NOT recover when reason is "destroyed"', async () => {
      const r = await createRenderer();
      mockRequestGPUDevice.mockClear();
      mock.deviceLostDeferred.resolve({ reason: 'destroyed', message: 'destroyed' });
      await Promise.resolve(); await Promise.resolve();
      expect(mockRequestGPUDevice).not.toHaveBeenCalled();
      r.destroy();
    });

    it('prevents overlapping recovery', async () => {
      let resolveReq: (v: unknown) => void;
      const hangingReq = new Promise<unknown>((res) => { resolveReq = res; });

      const r = await createRenderer();
      mockRequestGPUDevice.mockClear();
      mockRequestGPUDevice.mockReturnValue(hangingReq);

      mock.deviceLostDeferred.resolve({ reason: 'unknown', message: 'first' });
      await Promise.resolve();
      mock.deviceLostDeferred.resolve({ reason: 'unknown', message: 'second' });
      await Promise.resolve();

      expect(mockRequestGPUDevice).toHaveBeenCalledTimes(1);

      resolveReq!({ device: mock.device, adapter: mock.adapter });
      await Promise.resolve(); await Promise.resolve();
      r.destroy();
    });
  });

  describe('updateConfiguration()', () => {
    it('no change → no rebuild', async () => {
      mockParamsEqual.mockReturnValue(true);
      const r = await createRenderer();
      mockBuildEffectPipelines.mockClear();
      await r.updateConfiguration({ effects: DEFAULT_EFFECTS, targetDimensions: DEFAULT_DIMENSIONS });
      expect(mockBuildEffectPipelines).not.toHaveBeenCalled();
      r.destroy();
    });

    it('effects change → rebuild', async () => {
      const newEffects: EnhancementEffect[] = [{ id: 't/new', name: 'N', className: 'N', params: {} }];
      const r = await createRenderer();
      mockBuildEffectPipelines.mockClear();
      await r.updateConfiguration({ effects: newEffects, targetDimensions: DEFAULT_DIMENSIONS });
      expect(mockBuildEffectPipelines).toHaveBeenCalled();
      r.destroy();
    });

    it('dimensions change → rebuild', async () => {
      const r = await createRenderer();
      mockBuildEffectPipelines.mockClear();
      await r.updateConfiguration({ effects: DEFAULT_EFFECTS, targetDimensions: { width: 3840, height: 2160 } });
      expect(mockBuildEffectPipelines).toHaveBeenCalled();
      r.destroy();
    });

    it('does nothing when destroyed', async () => {
      const r = await createRenderer();
      r.destroy();
      mockBuildEffectPipelines.mockClear();
      await r.updateConfiguration({ effects: [], targetDimensions: DEFAULT_DIMENSIONS });
      expect(mockBuildEffectPipelines).not.toHaveBeenCalled();
    });
  });

  describe('visibility pause', () => {
    beforeEach(() => {
      // Ensure visibilityState starts as 'visible' before each test
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true, writable: true });
    });

    afterEach(() => {
      // Restore visibilityState to 'visible' after each test
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true, writable: true });
    });

    it('does not submit GPU commands when tab is hidden', async () => {
      // Set hidden before creating renderer so first frame is also skipped
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true, writable: true });
      const r = await createRenderer();
      const submitSpy = mock.device.queue.submit as ReturnType<typeof vi.fn>;
      expect(submitSpy).not.toHaveBeenCalled();
      r.destroy();
    });

    it('resumes rendering when tab becomes visible', async () => {
      // Start hidden — no GPU commands
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true, writable: true });
      const r = await createRenderer();
      const submitSpy = mock.device.queue.submit as ReturnType<typeof vi.fn>;
      expect(submitSpy).not.toHaveBeenCalled();

      const rvfc = video.requestVideoFrameCallback as ReturnType<typeof vi.fn>;
      rvfc.mockClear();

      // Simulate tab becoming visible
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true, writable: true });
      document.dispatchEvent(new Event('visibilitychange'));

      // The visibilitychange handler should cancel the pending callback and request an immediate one
      const cvfc = video.cancelVideoFrameCallback as ReturnType<typeof vi.fn>;
      expect(cvfc).toHaveBeenCalled();
      expect(rvfc).toHaveBeenCalled();
      r.destroy();
    });

    it('removes visibilitychange listener on destroy', async () => {
      const r = await createRenderer();
      r.destroy();

      // After destroy, dispatching visibilitychange should not throw or cause errors
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true, writable: true });
      expect(() => document.dispatchEvent(new Event('visibilitychange'))).not.toThrow();
    });
  });

  describe('onFrameRendered callback', () => {
    it('calls onFrameRendered after successful frame with frame time', async () => {
      const onFrameRendered = vi.fn();
      const r = await createRenderer({ onFrameRendered });

      expect(onFrameRendered).toHaveBeenCalledTimes(1);
      const frameTime = onFrameRendered.mock.calls[0][0];
      expect(typeof frameTime).toBe('number');
      expect(frameTime).toBeGreaterThanOrEqual(0);

      r.destroy();
    });

    it('does not call onFrameRendered when frame is skipped (visibility hidden)', async () => {
      const onFrameRendered = vi.fn();
      // Set visibilityState to hidden so processFrame() skips rendering
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true, writable: true });

      const r = await Renderer.create({
        video: createMockVideo({ readyState: HAVE_ENOUGH_DATA }),
        canvas,
        effects: DEFAULT_EFFECTS,
        targetDimensions: DEFAULT_DIMENSIONS,
        onFrameRendered,
      });
      await Promise.resolve();

      // The first frame should be skipped because visibilityState is hidden
      expect(onFrameRendered).not.toHaveBeenCalled();

      // Restore visibility
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true, writable: true });
      r.destroy();
    });

    it('onFrameRendered is optional — no error when not provided', async () => {
      const r = await createRenderer(); // no onFrameRendered
      // Should not throw
      expect(() => r.destroy()).not.toThrow();
    });
  });
});
