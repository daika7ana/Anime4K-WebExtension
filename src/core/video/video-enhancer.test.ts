import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted ensures these are available when vi.mock factories execute (they're hoisted too)
const { mockOverlay, mockRenderer, mockDiagnosticsOverlay } = vi.hoisted(() => {
  const mockOverlay = {
    getButton: vi.fn(() => document.createElement('button')),
    getCanvas: vi.fn(() => document.createElement('canvas')),
    showCanvas: vi.fn(),
    hideCanvas: vi.fn(),
    detach: vi.fn(),
    reattach: vi.fn(),
    destroy: vi.fn(),
  };

  const mockRenderer = {
    destroy: vi.fn(),
    updateConfiguration: vi.fn().mockResolvedValue(undefined),
    updateVideoSource: vi.fn().mockResolvedValue(undefined),
  };

  const mockDiagnosticsOverlay = {
    show: vi.fn(),
    hide: vi.fn(),
    update: vi.fn(),
    destroy: vi.fn(),
  };

  return { mockOverlay, mockRenderer, mockDiagnosticsOverlay };
});

vi.mock('@core/ui/overlay-manager', () => ({
  OverlayManager: {
    create: vi.fn(() => mockOverlay),
  },
}));

vi.mock('@core/ui/diagnostics-overlay', () => ({
  DiagnosticsOverlay: {
    create: vi.fn(() => mockDiagnosticsOverlay),
  },
}));

vi.mock('@core/renderer', () => ({
  Renderer: {
    create: vi.fn().mockResolvedValue(mockRenderer),
  },
}));

vi.mock('@utils/settings', () => ({
  getSettings: vi.fn().mockResolvedValue({
    selectedModeId: 'builtin-mode-a',
    enhancementModes: [
      { id: 'builtin-mode-a', baseMode: 'A', name: 'Mode A', isBuiltIn: true },
    ],
    targetResolutionSetting: 'x2',
    performanceTier: 'balanced',
    enableCrossOriginFix: false,
  }),
  getEffectsForMode: vi.fn().mockReturnValue([
    { id: 'anime4k/Helper/ClampHighlights', name: 'Clamp Highlights', className: 'ClampHighlights' },
  ]),
  getLocalSettings: vi.fn().mockResolvedValue({
    showDiagnostics: false,
  }),
}));

vi.mock('@/constants', () => ({
  ANIME4K_APPLIED_ATTR: 'data-anime4k-applied',
}));

vi.mock('@core/utils/yield-utils', () => ({
  yieldToAnimationFrame: vi.fn().mockResolvedValue(undefined),
  yieldToMain: vi.fn().mockResolvedValue(undefined),
}));

import { VideoEnhancer } from './video-enhancer';
import { OverlayManager } from '@core/ui/overlay-manager';
import { DiagnosticsOverlay } from '@core/ui/diagnostics-overlay';
import { Renderer } from '@core/renderer';
import { getSettings, getLocalSettings } from '@utils/settings';

describe('VideoEnhancer', () => {
  let video: HTMLVideoElement;

  beforeEach(() => {
    vi.clearAllMocks();
    video = document.createElement('video');
    document.body.appendChild(video);

    // jsdom videos have readyState=0 by default, but initRenderer() awaits
    // loadedmetadata when readyState < 1 — set it to 1 (HAVE_METADATA) to avoid hang
    Object.defineProperty(video, 'readyState', { value: 1, configurable: true });

    // initRenderer() checks navigator.gpu — stub it for jsdom
    vi.stubGlobal('navigator', { ...navigator, gpu: {} });

    // Reset mock implementations to defaults
    mockOverlay.getButton.mockReturnValue(document.createElement('button'));
    mockOverlay.getCanvas.mockReturnValue(document.createElement('canvas'));
    (Renderer.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockRenderer);
    (getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      selectedModeId: 'builtin-mode-a',
      enhancementModes: [
        { id: 'builtin-mode-a', baseMode: 'A', name: 'Mode A', isBuiltIn: true },
      ],
      targetResolutionSetting: 'x2',
      performanceTier: 'balanced',
      enableCrossOriginFix: false,
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('creation', () => {
    it('create() returns an instance', () => {
      const enhancer = VideoEnhancer.create(video);
      expect(enhancer).toBeDefined();
      enhancer.destroy();
    });

    it('creates an overlay for the video', () => {
      const enhancer = VideoEnhancer.create(video);
      expect(OverlayManager.create).toHaveBeenCalledWith(video);
      enhancer.destroy();
    });

    it('initially has no active mode', () => {
      const enhancer = VideoEnhancer.create(video);
      expect(enhancer.getCurrentModeId()).toBeNull();
      enhancer.destroy();
    });

    it('getVideoElement() returns the video', () => {
      const enhancer = VideoEnhancer.create(video);
      expect(enhancer.getVideoElement()).toBe(video);
      enhancer.destroy();
    });
  });

  describe('toggleEnhancement (off → on)', () => {
    it('sets data-anime4k-applied attribute on video', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      expect(video.getAttribute('data-anime4k-applied')).toBe('true');
      enhancer.destroy();
    });

    it('creates a Renderer', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      expect(Renderer.create).toHaveBeenCalled();
      enhancer.destroy();
    });

    it('sets currentModeId after successful toggle', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      expect(enhancer.getCurrentModeId()).toBe('builtin-mode-a');
      enhancer.destroy();
    });

    it('does not reinitialize while already initializing', async () => {
      const enhancer = VideoEnhancer.create(video);

      // Fire two toggles in quick succession
      const p1 = enhancer.toggleEnhancement();
      const p2 = enhancer.toggleEnhancement();

      await Promise.all([p1, p2]);

      // Second toggle should have been a no-op (initializing guard)
      // Only one Renderer.create should have been called
      expect((Renderer.create as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(1);
      enhancer.destroy();
    });
  });

  describe('toggleEnhancement (on → off)', () => {
    it('removes data-anime4k-applied attribute', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();
      expect(video.getAttribute('data-anime4k-applied')).toBe('true');

      await enhancer.toggleEnhancement();
      expect(video.hasAttribute('data-anime4k-applied')).toBe(false);
    });

    it('destroys the renderer', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      await enhancer.toggleEnhancement();
      expect(mockRenderer.destroy).toHaveBeenCalled();
    });

    it('clears currentModeId', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();
      expect(enhancer.getCurrentModeId()).toBe('builtin-mode-a');

      await enhancer.toggleEnhancement();
      expect(enhancer.getCurrentModeId()).toBeNull();
    });
  });

  describe('destroy()', () => {
    it('destroys renderer and overlay', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      enhancer.destroy();

      expect(mockRenderer.destroy).toHaveBeenCalled();
      expect(mockOverlay.destroy).toHaveBeenCalled();
    });

    it('removes data-anime4k-applied attribute', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      enhancer.destroy();

      expect(video.hasAttribute('data-anime4k-applied')).toBe(false);
    });

    it('is safe to call without prior toggle', () => {
      const enhancer = VideoEnhancer.create(video);
      expect(() => enhancer.destroy()).not.toThrow();
    });
  });

  describe('detach() / reattach()', () => {
    it('detach removes overlay and attribute', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      enhancer.detach();

      expect(mockOverlay.detach).toHaveBeenCalled();
      expect(video.hasAttribute('data-anime4k-applied')).toBe(false);
    });

    it('reattach updates video source on renderer', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      const newVideo = document.createElement('video');
      document.body.appendChild(newVideo);

      await enhancer.reattach(newVideo);

      expect(mockOverlay.reattach).toHaveBeenCalledWith(newVideo);
      expect(mockRenderer.updateVideoSource).toHaveBeenCalledWith(newVideo);
      expect(enhancer.getVideoElement()).toBe(newVideo);

      enhancer.destroy();
    });

    it('reattach without renderer calls disableEnhancement', async () => {
      const enhancer = VideoEnhancer.create(video);
      // Don't toggle — no renderer

      const newVideo = document.createElement('video');
      document.body.appendChild(newVideo);

      // Should not throw
      await enhancer.reattach(newVideo);
      enhancer.destroy();
    });
  });

  describe('updateSettings()', () => {
    it('updates renderer configuration when renderer exists', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      const newSettings = {
        selectedModeId: 'builtin-mode-a',
        enhancementModes: [
          { id: 'builtin-mode-a', baseMode: 'A' as const, name: 'Mode A', isBuiltIn: true as const },
        ],
        targetResolutionSetting: 'x4',
        performanceTier: 'quality' as const,
        customModes: [],
        whitelist: [],
        whitelistEnabled: false,
        enableCrossOriginFix: false,
        autoEnableOnWhitelist: false,
        enableHotkey: true,
        colorGrading: { enabled: false, brightness: 0, gamma: 1, contrast: 1, saturation: 1, vibrance: 0, exposure: 0 },
      };

      await enhancer.updateSettings(newSettings);

      expect(mockRenderer.updateConfiguration).toHaveBeenCalled();
      enhancer.destroy();
    });

    it('does nothing when no renderer exists', async () => {
      const enhancer = VideoEnhancer.create(video);
      // Don't toggle

      await enhancer.updateSettings({} as any);

      expect(mockRenderer.updateConfiguration).not.toHaveBeenCalled();
      enhancer.destroy();
    });
  });

  describe('reapply()', () => {
    it('calls disable then toggle', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      const toggleSpy = vi.spyOn(enhancer, 'toggleEnhancement');

      await enhancer.reapply();

      // After reapply, renderer should have been destroyed then recreated
      expect(mockRenderer.destroy).toHaveBeenCalled();
      expect(toggleSpy).toHaveBeenCalled();
      enhancer.destroy();
    });

    it('does nothing when no renderer exists', async () => {
      const enhancer = VideoEnhancer.create(video);
      // Don't toggle

      await enhancer.reapply();

      expect(Renderer.create).not.toHaveBeenCalled();
      enhancer.destroy();
    });
  });

  describe('calculateTargetDimensions (via toggle)', () => {
    it('applies x2 multiplier', async () => {
      Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
      Object.defineProperty(video, 'videoHeight', { value: 360, configurable: true });

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      const createCall = (Renderer.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.targetDimensions).toEqual({ width: 1280, height: 720 });

      enhancer.destroy();
    });

    it('caps dimensions at 8K', async () => {
      Object.defineProperty(video, 'videoWidth', { value: 3840, configurable: true });
      Object.defineProperty(video, 'videoHeight', { value: 2160, configurable: true });

      (getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        selectedModeId: 'builtin-mode-a',
        enhancementModes: [
          { id: 'builtin-mode-a', baseMode: 'A', name: 'Mode A', isBuiltIn: true },
        ],
        targetResolutionSetting: 'x4',
        performanceTier: 'balanced',
        enableCrossOriginFix: false,
      });

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      const createCall = (Renderer.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.targetDimensions.width).toBeLessThanOrEqual(7680);
      expect(createCall.targetDimensions.height).toBeLessThanOrEqual(4320);

      enhancer.destroy();
    });

    it('uses fixed resolution when specified', async () => {
      Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
      Object.defineProperty(video, 'videoHeight', { value: 360, configurable: true });

      (getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        selectedModeId: 'builtin-mode-a',
        enhancementModes: [
          { id: 'builtin-mode-a', baseMode: 'A', name: 'Mode A', isBuiltIn: true },
        ],
        targetResolutionSetting: '1080p',
        performanceTier: 'balanced',
        enableCrossOriginFix: false,
      });

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      const createCall = (Renderer.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.targetDimensions).toEqual({ width: 1920, height: 1080 });

      enhancer.destroy();
    });
  });

  describe('display resolution (Match Display)', () => {
    const DISPLAY_SETTINGS = {
      selectedModeId: 'builtin-mode-a',
      enhancementModes: [
        { id: 'builtin-mode-a', baseMode: 'A', name: 'Mode A', isBuiltIn: true },
      ],
      targetResolutionSetting: 'display',
      performanceTier: 'balanced',
      enableCrossOriginFix: false,
    };

    function useDisplaySettings(): void {
      (getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ ...DISPLAY_SETTINGS });
    }

    function setSourceSize(width: number, height: number): void {
      Object.defineProperty(video, 'videoWidth', { value: width, configurable: true });
      Object.defineProperty(video, 'videoHeight', { value: height, configurable: true });
    }

    function setScreenSize(width: number, height: number): void {
      Object.defineProperty(window.screen, 'width', { value: width, configurable: true });
      Object.defineProperty(window.screen, 'height', { value: height, configurable: true });
    }

    function setViewport(width: number, height: number): void {
      Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
    }

    function setDpr(dpr: number): void {
      Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true });
    }

    function firstCreateTargetDimensions(): { width: number; height: number } {
      return (Renderer.create as ReturnType<typeof vi.fn>).mock.calls[0][0].targetDimensions;
    }

    /** Installs a matchMedia stub and returns a function to fire its change event. */
    function stubMatchMedia(): { fireChange: () => void; matchMedia: ReturnType<typeof vi.fn> } {
      const listeners = new Set<() => void>();
      const mql = {
        matches: false,
        media: '',
        onchange: null,
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => false),
      };
      const matchMedia = vi.fn(() => mql);
      Object.defineProperty(window, 'matchMedia', { value: matchMedia, configurable: true });
      return { fireChange: () => listeners.forEach((listener) => listener()), matchMedia };
    }

    // Capture original descriptors so mocks can be restored precisely.
    // (vi.unstubAllGlobals would also drop test-setup.ts's chrome stub.)
    const originalDpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    const originalScreenWidth = Object.getOwnPropertyDescriptor(window.screen, 'width');
    const originalScreenHeight = Object.getOwnPropertyDescriptor(window.screen, 'height');
    const originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');

    function restoreProperty(
      target: object,
      key: string,
      descriptor: PropertyDescriptor | undefined,
    ): void {
      if (descriptor) {
        Object.defineProperty(target, key, descriptor);
      } else {
        Reflect.deleteProperty(target, key);
      }
    }

    afterEach(() => {
      vi.useRealTimers();
      restoreProperty(window, 'devicePixelRatio', originalDpr);
      restoreProperty(window, 'innerWidth', originalInnerWidth);
      restoreProperty(window, 'innerHeight', originalInnerHeight);
      restoreProperty(window, 'matchMedia', originalMatchMedia);
      restoreProperty(window.screen, 'width', originalScreenWidth);
      restoreProperty(window.screen, 'height', originalScreenHeight);
      restoreProperty(globalThis, 'ResizeObserver', originalResizeObserver);
    });

    it('sizes to a 1920x1080 monitor at dpr 1 (not the player box)', async () => {
      setSourceSize(1920, 1080);
      setScreenSize(1920, 1080);
      setViewport(800, 600); // player is windowed; the monitor must drive the target
      setDpr(1);
      useDisplaySettings();

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      expect(firstCreateTargetDimensions()).toEqual({ width: 1920, height: 1080 });
      enhancer.destroy();
    });

    it('doubles the target on a 1280x720 monitor at dpr 2', async () => {
      setSourceSize(1920, 1080);
      setScreenSize(1280, 720);
      setViewport(500, 500);
      setDpr(2);
      useDisplaySettings();

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      expect(firstCreateTargetDimensions()).toEqual({ width: 2560, height: 1440 });
      enhancer.destroy();
    });

    it('fits a 4:3 source into a 16:9 monitor, height-limited and aspect-preserved', async () => {
      setSourceSize(640, 480);
      setScreenSize(1920, 1080);
      setViewport(800, 600);
      setDpr(1);
      useDisplaySettings();

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      // 1080 * (640/480) = 1440; height stays 1080
      expect(firstCreateTargetDimensions()).toEqual({ width: 1440, height: 1080 });
      enhancer.destroy();
    });

    it('caps the monitor-sized target at 8K', async () => {
      setSourceSize(1920, 1080);
      setScreenSize(10000, 10000);
      setViewport(800, 600);
      setDpr(1);
      useDisplaySettings();

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      const dimensions = firstCreateTargetDimensions();
      expect(dimensions.width).toBeLessThanOrEqual(7680);
      expect(dimensions.height).toBeLessThanOrEqual(4320);
      enhancer.destroy();
    });

    it('falls back to the viewport when screen dimensions are invalid', async () => {
      setSourceSize(1920, 1080);
      setScreenSize(0, 0);
      setViewport(1600, 900);
      setDpr(1);
      useDisplaySettings();

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      expect(firstCreateTargetDimensions()).toEqual({ width: 1600, height: 900 });
      enhancer.destroy();
    });

    it('falls back to source dimensions when screen and viewport are invalid', async () => {
      setSourceSize(640, 360);
      setScreenSize(0, 0);
      setViewport(0, 0);
      setDpr(2);
      useDisplaySettings();

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      expect(firstCreateTargetDimensions()).toEqual({ width: 640, height: 360 });
      enhancer.destroy();
    });

    it('does not create a video ResizeObserver for display mode', async () => {
      const ResizeObserverMock = vi.fn();
      Object.defineProperty(globalThis, 'ResizeObserver', {
        value: ResizeObserverMock,
        configurable: true,
      });

      setSourceSize(1920, 1080);
      setScreenSize(1920, 1080);
      setViewport(800, 600);
      setDpr(1);
      useDisplaySettings();

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      expect(ResizeObserverMock).not.toHaveBeenCalled();
      enhancer.destroy();
    });

    it('does not rebuild when the player/window resizes', async () => {
      vi.useFakeTimers();
      setSourceSize(1920, 1080);
      setScreenSize(1920, 1080);
      setViewport(1920, 1080);
      setDpr(1);
      useDisplaySettings();

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      const canvas = mockOverlay.getCanvas.mock.results.at(-1)!.value as HTMLCanvasElement;
      expect(canvas.width).toBe(1920);
      expect(canvas.height).toBe(1080);

      // Shrink the viewport (windowed player): the monitor-sized target is
      // unchanged, so no pipeline rebuild is triggered.
      setViewport(800, 600);
      window.dispatchEvent(new Event('resize'));
      await vi.advanceTimersByTimeAsync(300);

      expect(mockRenderer.updateConfiguration).not.toHaveBeenCalled();
      expect(canvas.width).toBe(1920);
      expect(canvas.height).toBe(1080);

      enhancer.destroy();
    });

    it('recomputes when the device pixel ratio changes', async () => {
      vi.useFakeTimers();
      const { fireChange } = stubMatchMedia();
      setSourceSize(1920, 1080);
      setScreenSize(1920, 1080);
      setViewport(800, 600);
      setDpr(1);
      useDisplaySettings();

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      const canvas = mockOverlay.getCanvas.mock.results.at(-1)!.value as HTMLCanvasElement;
      expect(canvas.width).toBe(1920);
      expect(canvas.height).toBe(1080);

      // Simulate a monitor/DPR change firing the resolution media query.
      setDpr(2);
      fireChange();
      await vi.advanceTimersByTimeAsync(300);

      expect(mockRenderer.updateConfiguration).toHaveBeenCalledTimes(1);
      expect(canvas.width).toBe(3840);
      expect(canvas.height).toBe(2160);

      enhancer.destroy();
    });

    it('does not react to resize for non-display settings', async () => {
      vi.useFakeTimers();
      const { matchMedia } = stubMatchMedia();
      setSourceSize(1920, 1080);
      setScreenSize(1920, 1080);
      setViewport(800, 600);
      setDpr(2);
      // Default beforeEach settings use targetResolutionSetting 'x2'.

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      window.dispatchEvent(new Event('resize'));
      await vi.advanceTimersByTimeAsync(300);

      expect(matchMedia).not.toHaveBeenCalled();
      expect(mockRenderer.updateConfiguration).not.toHaveBeenCalled();

      enhancer.destroy();
    });
  });

  describe('diagnostics overlay', () => {
    beforeEach(() => {
      // Provide a minimal requestAdapter stub so getAdapterInfo resolves quickly
      vi.stubGlobal('navigator', {
        ...navigator,
        gpu: {
          requestAdapter: vi.fn().mockResolvedValue(null),
        },
      });
    });

    it('creates diagnostics overlay when showDiagnostics is true', async () => {
      (getLocalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        showDiagnostics: true,
      });

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      expect(DiagnosticsOverlay.create).toHaveBeenCalled();
      expect(mockDiagnosticsOverlay.show).toHaveBeenCalled();
      enhancer.destroy();
    });

    it('does not create diagnostics overlay when showDiagnostics is false', async () => {
      (getLocalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        showDiagnostics: false,
      });

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      // create should not have been called from initRenderer
      // (the mock may have been called from vi.mock factory init, so check it wasn't
      // called more than initial factory calls — but since create is used as a static
      // factory, the only calls should be from the enhancer if showDiagnostics is true)
      // Use mockDiagnosticsOverlay.show to verify overlay was not created
      expect(mockDiagnosticsOverlay.show).not.toHaveBeenCalled();
      enhancer.destroy();
    });

    it('destroys diagnostics overlay on disableEnhancement', async () => {
      (getLocalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        showDiagnostics: true,
      });

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      expect(DiagnosticsOverlay.create).toHaveBeenCalled();

      await enhancer.toggleEnhancement();

      expect(mockDiagnosticsOverlay.destroy).toHaveBeenCalled();
    });

    it('onFrameRendered callback forwards the profiler snapshot to the diagnostics overlay', async () => {
      (getLocalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        showDiagnostics: true,
      });

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      // Get the onFrameRendered callback passed to Renderer.create
      const createCall = (Renderer.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.onFrameRendered).toBeDefined();

      // Simulate a frame render with a profiler snapshot
      const snapshot = {
        status: 'active' as const,
        framesSampled: 1,
        totalGpuP50: 1.5,
        totalGpuP95: 2.5,
        passes: [{ label: 'ClampHighlights', gpuP50: 1.5 }],
      };
      createCall.onFrameRendered!(12.5, snapshot);

      expect(mockDiagnosticsOverlay.update).toHaveBeenCalledWith(12.5, 1, snapshot);
      enhancer.destroy();
    });

    it('passes enableGpuTimings=true to the renderer when diagnostics are shown', async () => {
      (getLocalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        showDiagnostics: true,
      });

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      const createCall = (Renderer.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.enableGpuTimings).toBe(true);
      enhancer.destroy();
    });

    it('passes enableGpuTimings=false to the renderer when diagnostics are hidden', async () => {
      (getLocalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        showDiagnostics: false,
      });

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      const createCall = (Renderer.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.enableGpuTimings).toBe(false);
      enhancer.destroy();
    });

    it('handles showDiagnostics toggle in updateSettings', async () => {
      (getLocalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        showDiagnostics: true,
      });

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      expect(DiagnosticsOverlay.create).toHaveBeenCalled();
      vi.clearAllMocks();

      // Now toggle showDiagnostics off
      (getLocalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        showDiagnostics: false,
      });

      const emptySettings = {
        selectedModeId: 'builtin-mode-a',
        enhancementModes: [
          { id: 'builtin-mode-a', baseMode: 'A' as const, name: 'Mode A', isBuiltIn: true as const },
        ],
        targetResolutionSetting: 'x2',
        performanceTier: 'balanced' as const,
        customModes: [],
        whitelist: [],
        whitelistEnabled: false,
        enableCrossOriginFix: false,
        autoEnableOnWhitelist: false,
        enableHotkey: false,
        colorGrading: { enabled: false, brightness: 0, gamma: 1, contrast: 1, saturation: 1, vibrance: 0, exposure: 0 },
      };

      await enhancer.updateSettings(emptySettings);

      expect(mockDiagnosticsOverlay.destroy).toHaveBeenCalled();
      enhancer.destroy();
    });

    describe('getAdapterInfo', () => {
      beforeEach(() => {
        vi.clearAllMocks();
      });

      it('returns WebGPU info when adapter info is available', async () => {
        vi.stubGlobal('navigator', {
          ...navigator,
          gpu: {
            requestAdapter: vi.fn().mockResolvedValue({
              requestAdapterInfo: vi.fn().mockResolvedValue({
                vendor: 'NVIDIA',
                architecture: 'ampere',
                device: 'RTX 4090',
                description: '',
              }),
            }),
          },
        });

        (getLocalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ showDiagnostics: true });

        const enhancer = VideoEnhancer.create(video);
        await enhancer.toggleEnhancement();

        const createCalls = (DiagnosticsOverlay.create as ReturnType<typeof vi.fn>).mock.calls;
        const adapterInfo = createCalls[createCalls.length - 1][1];
        expect(adapterInfo).toBe('NVIDIA ampere RTX 4090');

        enhancer.destroy();
      });

      it('falls back to WebGL when WebGPU returns empty strings', async () => {
        const mockGetParameter = vi.fn((param: number): string => {
          if (param === 0x9246) return 'Fake GPU (WebGL fallback)';
          return '';
        });
        const mockGl = {
          getExtension: vi.fn((name: string) =>
            name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null
          ),
          getParameter: mockGetParameter,
          RENDERER: 0x1F01,
        };

        vi.stubGlobal('navigator', {
          ...navigator,
          gpu: {
            requestAdapter: vi.fn().mockResolvedValue({
              requestAdapterInfo: vi.fn().mockResolvedValue({
                vendor: '',
                architecture: '',
                device: '',
                description: '',
              }),
            }),
          },
        });
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(mockGl as any);

        (getLocalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ showDiagnostics: true });

        const enhancer = VideoEnhancer.create(video);
        await enhancer.toggleEnhancement();

        const createCalls = (DiagnosticsOverlay.create as ReturnType<typeof vi.fn>).mock.calls;
        const adapterInfo = createCalls[createCalls.length - 1][1];
        expect(adapterInfo).toBe('Fake GPU (WebGL fallback)');

        enhancer.destroy();
      });

      it('falls back to WebGL when WebGPU throws', async () => {
        const mockGetParameter = vi.fn((param: number): string => {
          if (param === 0x9246) return 'Fake GPU (WebGL fallback)';
          return '';
        });
        const mockGl = {
          getExtension: vi.fn((name: string) =>
            name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null
          ),
          getParameter: mockGetParameter,
          RENDERER: 0x1F01,
        };

        vi.stubGlobal('navigator', {
          ...navigator,
          gpu: {
            requestAdapter: vi.fn().mockRejectedValue(new Error('Blocked')),
          },
        });
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(mockGl as any);

        (getLocalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ showDiagnostics: true });

        const enhancer = VideoEnhancer.create(video);
        await enhancer.toggleEnhancement();

        const createCalls = (DiagnosticsOverlay.create as ReturnType<typeof vi.fn>).mock.calls;
        const adapterInfo = createCalls[createCalls.length - 1][1];
        expect(adapterInfo).toBe('Fake GPU (WebGL fallback)');

        enhancer.destroy();
      });

      it('falls back to WebGL standard RENDERER when debug info unavailable', async () => {
        const mockGetParameter = vi.fn((param: number): string => {
          if (param === 0x1F01) return 'Intel Iris Xe Graphics';
          return '';
        });
        const mockGl = {
          getExtension: vi.fn(() => null),
          getParameter: mockGetParameter,
          RENDERER: 0x1F01,
        };

        vi.stubGlobal('navigator', {
          ...navigator,
          gpu: {
            requestAdapter: vi.fn().mockRejectedValue(new Error('Blocked')),
          },
        });
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(mockGl as any);

        (getLocalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ showDiagnostics: true });

        const enhancer = VideoEnhancer.create(video);
        await enhancer.toggleEnhancement();

        const createCalls = (DiagnosticsOverlay.create as ReturnType<typeof vi.fn>).mock.calls;
        const adapterInfo = createCalls[createCalls.length - 1][1];
        expect(adapterInfo).toBe('Intel Iris Xe Graphics');

        enhancer.destroy();
      });

      it('returns "Unknown GPU" when both WebGPU and WebGL fail', async () => {
        const mockGl = {
          getExtension: vi.fn(() => null),
          getParameter: vi.fn(() => ''),
          RENDERER: 0x1F01,
        };

        vi.stubGlobal('navigator', {
          ...navigator,
          gpu: {
            requestAdapter: vi.fn().mockResolvedValue(null),
          },
        });
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(mockGl as any);

        (getLocalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ showDiagnostics: true });

        const enhancer = VideoEnhancer.create(video);
        await enhancer.toggleEnhancement();

        const createCalls = (DiagnosticsOverlay.create as ReturnType<typeof vi.fn>).mock.calls;
        const adapterInfo = createCalls[createCalls.length - 1][1];
        expect(adapterInfo).toBe('Unknown GPU');

        enhancer.destroy();
      });

      it('filters out generic WebKit WebGL renderer string', async () => {
        const mockGetParameter = vi.fn((param: number): string => {
          if (param === 0x1F01) return 'WebKit WebGL';
          return '';
        });
        const mockGl = {
          getExtension: vi.fn(() => null),
          getParameter: mockGetParameter,
          RENDERER: 0x1F01,
        };

        vi.stubGlobal('navigator', {
          ...navigator,
          gpu: {
            requestAdapter: vi.fn().mockRejectedValue(new Error('Blocked')),
          },
        });
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(mockGl as any);

        (getLocalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ showDiagnostics: true });

        const enhancer = VideoEnhancer.create(video);
        await enhancer.toggleEnhancement();

        const createCalls = (DiagnosticsOverlay.create as ReturnType<typeof vi.fn>).mock.calls;
        const adapterInfo = createCalls[createCalls.length - 1][1];
        expect(adapterInfo).toBe('Unknown GPU');

        enhancer.destroy();
      });
    });
  });

  describe('color grading (differentiator)', () => {
    const COLOR_GRADING = {
      enabled: true,
      brightness: 0.2,
      gamma: 1.3,
      contrast: 1.1,
      saturation: 0.9,
      vibrance: 0.4,
      exposure: 0.5,
    };

    function settingsWithColorGrading(colorGrading: unknown = COLOR_GRADING) {
      return {
        selectedModeId: 'builtin-mode-a',
        enhancementModes: [
          { id: 'builtin-mode-a', baseMode: 'A', name: 'Mode A', isBuiltIn: true },
        ],
        targetResolutionSetting: 'x2',
        performanceTier: 'balanced',
        enableCrossOriginFix: false,
        colorGrading,
      };
    }

    function createdEffects(): any[] {
      return (Renderer.create as ReturnType<typeof vi.fn>).mock.calls[0][0].effects;
    }

    it('appends a ColorAdjust effect with the configured grade to the end of the chain', async () => {
      (getSettings as ReturnType<typeof vi.fn>).mockResolvedValue(settingsWithColorGrading());

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      const effects = createdEffects();
      const gradeEffect = effects[effects.length - 1];
      expect(gradeEffect.className).toBe('ColorAdjust');
      expect(gradeEffect.params).toEqual({
        brightness: 0.2,
        gamma: 1.3,
        contrast: 1.1,
        saturation: 0.9,
        vibrance: 0.4,
        exposure: 0.5,
      });
      // Base chain effect must still precede the grading stage.
      expect(effects.length).toBeGreaterThan(1);
      expect(effects[0].className).toBe('ClampHighlights');

      enhancer.destroy();
    });

    it('does not append ColorAdjust when color grading is disabled', async () => {
      (getSettings as ReturnType<typeof vi.fn>).mockResolvedValue(
        settingsWithColorGrading({ ...COLOR_GRADING, enabled: false }),
      );

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      expect(createdEffects().some((e) => e.className === 'ColorAdjust')).toBe(false);

      enhancer.destroy();
    });

    it('does not append ColorAdjust when settings omit colorGrading entirely', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      expect(createdEffects().some((e) => e.className === 'ColorAdjust')).toBe(false);

      enhancer.destroy();
    });

    it('forwards color grading through updateSettings to updateConfiguration', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      await enhancer.updateSettings(settingsWithColorGrading() as any);

      const updateCall = (mockRenderer.updateConfiguration as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      const effects = updateCall[0].effects;
      const gradeEffect = effects[effects.length - 1];
      expect(gradeEffect.className).toBe('ColorAdjust');
      expect(gradeEffect.params.saturation).toBe(0.9);
      expect(gradeEffect.params.exposure).toBe(0.5);

      enhancer.destroy();
    });
  });

  describe('DRM/EME detection (differentiator)', () => {
    it('refuses to initialize when the video element has mediaKeys (EME)', async () => {
      Object.defineProperty(video, 'mediaKeys', { value: {}, configurable: true });

      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      expect(Renderer.create).not.toHaveBeenCalled();
      expect(video.hasAttribute('data-anime4k-applied')).toBe(false);
      expect(document.body.textContent).toContain('DRM');

      enhancer.destroy();
    });

    it('allows initialization when mediaKeys is absent', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      expect(Renderer.create).toHaveBeenCalled();

      enhancer.destroy();
    });

    it('shows the DRM-specific message when the renderer reports a copy-protection error', async () => {
      const enhancer = VideoEnhancer.create(video);
      await enhancer.toggleEnhancement();

      const onError = (Renderer.create as ReturnType<typeof vi.fn>).mock.calls[0][0].onError;
      expect(onError).toBeDefined();
      await onError(
        new Error('DRM detected. Video enhancement is not supported for this content due to copy protection.'),
      );

      expect(document.body.textContent).toContain('DRM copy protection');

      enhancer.destroy();
    });
  });
});
