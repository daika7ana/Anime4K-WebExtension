import { getSettings, getEffectsForMode, getLocalSettings } from '@utils/settings';
import { sendMessage } from '@utils/messaging';
import { t } from '@utils/i18n';
import { Renderer } from '@core/renderer';
import { ANIME4K_APPLIED_ATTR } from '@/constants';
import { Dimensions, Anime4KWebExtSettings, EnhancementMode, EnhancementEffect, ColorGradingSettings } from '@/types';
import { OverlayManager } from '@core/ui/overlay-manager';
import { DiagnosticsOverlay } from '@core/ui/diagnostics-overlay';
import { yieldToAnimationFrame } from '@core/utils/yield-utils';

/**
 * Video enhancer class that encapsulates Anime4K processing logic.
 * Manages the enhancement state, renderer instance, and resource cleanup for a single video element.
 */
export class VideoEnhancer {
  private renderer: Renderer | null = null;
  private currentModeId: string | null = null;
  private overlay: OverlayManager;
  private button: HTMLButtonElement;
  private diagnosticsOverlay: DiagnosticsOverlay | null = null;
  private currentPipelineCount = 0;

  private constructor(private video: HTMLVideoElement) {
    this.overlay = OverlayManager.create(this.video);
    this.button = this.overlay.getButton();
    this.initUI();
  }

  /**
   * Creates and initializes a new VideoEnhancer instance.
   * This is the recommended instantiation method.
   */
  public static create(video: HTMLVideoElement): VideoEnhancer {
    return new VideoEnhancer(video);
  }

  /**
   * Initializes UI components and event listeners
   */
  private initUI(): void {
    this.button.onclick = (e) => {
      e.stopPropagation();
      this.toggleEnhancement();
    };
  }

  private fixAttempted = false;
  private initializing = false;

  /**
   * Checks and fixes cross-origin issues with the video.
   * @param isFallback - Whether this is called as a fallback after an error
   * @returns {Promise<void>}
   */
  private async fixCrossOrigin(isFallback = false): Promise<void> {
    console.log(`[Anime4KWebExt] Executing cross-origin fix. Is fallback: ${isFallback}`);
    this.fixAttempted = true;
    this.video.crossOrigin = 'anonymous';

    const currentTime = this.video.currentTime;
    const originalSrc = this.video.src;
    const isPaused = this.video.paused;

    return new Promise<void>((resolve, reject) => {
      const onCanPlay = () => {
        cleanup();
        this.video.currentTime = currentTime;
        if (!isPaused) {
          this.video.play().catch(e => console.warn('[Anime4KWebExt] Autoplay after reload was blocked.', e));
        }
        console.log('[Anime4KWebExt] Video reloaded successfully with crossOrigin attribute.');
        resolve();
      };

      const onError = (e: Event) => {
        cleanup();
        console.error('[Anime4KWebExt] Failed to reload video after setting crossOrigin.', e);
        reject(new Error('Failed to reload video with cross-origin attribute.'));
      };

      const cleanup = () => {
        this.video.removeEventListener('canplay', onCanPlay);
        this.video.removeEventListener('error', onError);
      };

      this.video.addEventListener('canplay', onCanPlay, { once: true });
      this.video.addEventListener('error', onError, { once: true });

      this.video.src = '';
      this.video.src = originalSrc;
      this.video.load();
    });
  }

  /**
   * Toggles the video enhancement on/off
   */
  async toggleEnhancement(): Promise<void> {
    if (this.renderer) {
      console.log('[Anime4KWebExt] Disabling video enhancement.');
      this.disableEnhancement();
      return;
    }

    if (this.initializing) return;
    this.initializing = true;

    this.button.innerText = t('enhancing');
    this.button.disabled = true;
    this.fixAttempted = false; // Reset the fix attempt flag

    // Defer heavy initialization to the next animation frame so the browser can
    // repaint the "Enhancing..." button text before any blocking GPU work begins.
    await yieldToAnimationFrame();

    const settings = await getSettings();

    try {
      if (settings.enableCrossOriginFix) {
        // --- First line of defense: proactive check ---
        const videoUrl = this.video.src;
        if (videoUrl && videoUrl.startsWith('http') && !this.video.crossOrigin) {
          try {
            const videoOrigin = new URL(videoUrl).origin;
            if (videoOrigin !== window.location.origin) {
              console.log('[Anime4KWebExt] Proactive check: Cross-origin video detected. Applying fix...');
              await this.fixCrossOrigin();
            }
          } catch (e) {
            console.warn('[Anime4KWebExt] Could not parse video src URL for proactive check.', e);
          }
        }
      }

      // --- Core operation ---
      await this.initRenderer();
      this.video.setAttribute(ANIME4K_APPLIED_ATTR, 'true');
      this.button.innerText = t('cancelEnhance');

    } catch (error) {
      const err = error as Error;
      const isCrossOriginError = err.name === 'SecurityError' && err.message.includes('tainted');

      if (isCrossOriginError && settings.enableCrossOriginFix && !this.fixAttempted) {
        // --- Second line of defense: error fallback ---
        console.warn('[Anime4KWebExt] Fallback: Caught a SecurityError. Attempting to fix and retry...');
        try {
          await this.fixCrossOrigin();
          await this.initRenderer(); // Retry
          this.video.setAttribute(ANIME4K_APPLIED_ATTR, 'true');
          this.button.innerText = t('cancelEnhance');
        } catch (retryError) {
          console.error('[Anime4KWebExt] Enhancer failed even after retry:', retryError);
          this.disableEnhancement();
          this.showErrorModal((retryError as Error).message || t('enhanceError'));
        }
      } else if (isCrossOriginError && !settings.enableCrossOriginFix) {
        // --- User prompt ---
        console.warn('[Anime4KWebExt] Cross-origin error detected, but fix is disabled. Prompting user.');
        this.disableEnhancement();
          this.showErrorModal(t('crossOriginHint', 'Enhancement failed due to cross-origin restrictions. Please enable Compatibility Mode in the options.'), true);
      } else {
        // --- Other errors ---
        console.error('[Anime4KWebExt] Failed to initialize enhancer:', err);
        this.disableEnhancement();
        this.showErrorModal(err.message || t('enhanceError'));
      }
    } finally {
      this.initializing = false;
      this.button.disabled = false;
    }
  }


  /**
   * Initializes the renderer, including loading settings, loading modules, and creating the Renderer instance
   */
  private async initRenderer(): Promise<void> {
    // Detect DRM-protected content early (EME sets mediaKeys on the video element)
    if (this.video.mediaKeys) {
      throw new Error('DRM detected. Video enhancement is not supported for DRM-protected content.');
    }

    // Ensure metadata is loaded before initializing the renderer
    if (this.video.readyState < 1) { // HAVE_METADATA
      this.button.innerText = t('waitingVideoLoad', '⏳ Waiting for video...');
      await new Promise(resolve => {
        this.video.addEventListener('loadedmetadata', resolve, { once: true });
      });
    }

    if (!navigator.gpu) {
      throw new Error('WebGPU is not supported on this browser.');
    }

    const settings = await getSettings();

    const { selectedModeId, enhancementModes, targetResolutionSetting } = settings;
    const selectedMode =
      enhancementModes.find((m: EnhancementMode) => m.id === selectedModeId)
      ?? enhancementModes.find((m: EnhancementMode) => m.isBuiltIn);
    if (!selectedMode) {
      throw new Error('No valid enhancement mode found');
    }
    this.currentModeId = selectedMode.id;

    const targetDimensions = this.calculateTargetDimensions(
      this.video.videoWidth,
      this.video.videoHeight,
      targetResolutionSetting
    );

    const canvas = this.overlay.getCanvas();
    canvas.width = targetDimensions.width;
    canvas.height = targetDimensions.height;

    // Get the actual effect chain based on mode and performance tier
    const baseEffects = getEffectsForMode(selectedMode, settings.performanceTier);
    const effects = this.getEffectsWithColorGrading(baseEffects, settings.colorGrading);

    // Store pipeline count for diagnostics
    this.currentPipelineCount = effects.length;

    // Create diagnostics overlay if enabled in local settings
    const localSettings = await getLocalSettings();
    if (localSettings.showDiagnostics) {
      const adapterInfo = await this.getAdapterInfo();
      this.diagnosticsOverlay = DiagnosticsOverlay.create(this.video, adapterInfo);
      this.diagnosticsOverlay.show();
    }

    this.renderer = await Renderer.create({
      video: this.video,
      canvas: canvas,
      effects: effects,
      targetDimensions,
      onError: async (error: Error) => {
        console.error('[Anime4KWebExt] Renderer runtime error:', error);
        const isCrossOriginError = error.name === 'SecurityError' && error.message.includes('tainted');
        const isDrmError = error.message.includes('DRM') || error.message.includes('copy protection');
        const settings = await getSettings();

        if (isDrmError) {
          this.showErrorModal('This video uses DRM copy protection. Video enhancement is not supported for DRM-protected content.');
        } else if (isCrossOriginError && !settings.enableCrossOriginFix) {
        this.showErrorModal(t('crossOriginHint', 'Enhancement failed due to cross-origin restrictions. Please enable Compatibility Mode in the options.'), true);
        } else {
          this.showErrorModal(t('renderError', 'A rendering error occurred.'));
        }
        this.disableEnhancement();
      },
      onFirstFrameRendered: () => {
        this.overlay.showCanvas();
      },
      onProgress: (stage: string | null) => {
        if (stage === null) {
          // Warmup complete, restore button text
          this.button.innerText = t('cancelEnhance');
        } else {
          this.button.innerText = stage;
        }
      },
      onFrameRendered: (frameTime: number) => {
        this.diagnosticsOverlay?.update(frameTime, this.currentPipelineCount);
      },
    });

    console.log(`[Anime4KWebExt] Renderer initialized with mode: ${selectedMode.name}`);
  }

  /**
   * Updates the renderer with new settings.
   * This is much more efficient than a full reinitialization.
   * @param newSettings - The latest settings object
   */
  public async updateSettings(newSettings: Anime4KWebExtSettings): Promise<void> {
    if (!this.renderer) return;

    console.log('[Anime4KWebExt] Updating renderer with new settings...');
    const { selectedModeId, enhancementModes, targetResolutionSetting } = newSettings;
    const selectedMode =
      enhancementModes.find((m: EnhancementMode) => m.id === selectedModeId)
      ?? enhancementModes.find((m: EnhancementMode) => m.isBuiltIn);
    if (!selectedMode) {
      throw new Error('No valid enhancement mode found');
    }

    const newTargetDimensions = this.calculateTargetDimensions(
      this.video.videoWidth,
      this.video.videoHeight,
      targetResolutionSetting
    );

    // If the target dimensions have changed, update the canvas size. This must be done before calling the renderer update.
    const canvas = this.overlay.getCanvas();
    if (newTargetDimensions.width !== canvas.width || newTargetDimensions.height !== canvas.height) {
      console.log(`[Anime4KWebExt] Target resolution changed, resizing canvas to ${newTargetDimensions.width}x${newTargetDimensions.height}.`);
      canvas.width = newTargetDimensions.width;
      canvas.height = newTargetDimensions.height;
    }

    // Get the actual effect chain based on mode and performance tier
    const baseEffects = getEffectsForMode(selectedMode, newSettings.performanceTier);
    const effects = this.getEffectsWithColorGrading(baseEffects, newSettings.colorGrading);

    // Call the renderer's unified configuration update method, which intelligently handles changes
    await this.renderer.updateConfiguration({
      effects: effects,
      targetDimensions: newTargetDimensions
    });

    this.currentModeId = selectedMode.id;
    console.log(`[Anime4KWebExt] Renderer updated to mode: ${selectedMode.name}`);

    // Update pipeline count for diagnostics
    this.currentPipelineCount = effects.length;

    // Handle diagnostics overlay toggle
    const localSettings = await getLocalSettings();
    if (localSettings.showDiagnostics && !this.diagnosticsOverlay) {
      const adapterInfo = await this.getAdapterInfo();
      this.diagnosticsOverlay = DiagnosticsOverlay.create(this.video, adapterInfo);
      this.diagnosticsOverlay.show();
    } else if (!localSettings.showDiagnostics && this.diagnosticsOverlay) {
      this.diagnosticsOverlay.destroy();
      this.diagnosticsOverlay = null;
    }
  }

  /**
   * Reapplies enhancement with fresh settings.
   * Performs a clean disable-then-enable cycle to ensure all old filters are removed and new ones applied.
   */
  public async reapply(): Promise<void> {
    if (!this.renderer) return;

    console.log('[Anime4KWebExt] Reapplying enhancement with fresh settings...');
    this.disableEnhancement();
    await this.toggleEnhancement();
  }

  /**
   * Calculates the target rendering dimensions (capped at 8K to prevent OOM)
   */
  private calculateTargetDimensions(videoWidth: number, videoHeight: number, resolutionSetting: string): Dimensions {
    const MAX_WIDTH = 7680;
    const MAX_HEIGHT = 4320;

    const multipliers: Record<string, number> = { 'x2': 2, 'x4': 4, 'x8': 8 };
    const fixedResolutions: Record<string, Dimensions> = {
      '720p': { width: 1280, height: 720 },
      '1080p': { width: 1920, height: 1080 },
      '2k': { width: 2560, height: 1440 },
      '4k': { width: 3840, height: 2160 },
    };

    let width: number;
    let height: number;

    if (multipliers[resolutionSetting]) {
      width = videoWidth * multipliers[resolutionSetting];
      height = videoHeight * multipliers[resolutionSetting];
    } else if (fixedResolutions[resolutionSetting]) {
      return fixedResolutions[resolutionSetting];
    } else {
      return { width: videoWidth, height: videoHeight };
    }

    // Cap maximum resolution to prevent textures from being too large and causing OOM
    if (width > MAX_WIDTH || height > MAX_HEIGHT) {
      const scale = Math.min(MAX_WIDTH / width, MAX_HEIGHT / height);
      width = Math.floor(width * scale);
      height = Math.floor(height * scale);
    }

    return { width, height };
  }

  /**
   * Appends a ColorAdjust effect to the end of the effect chain when color grading is enabled.
   * Color grading is always applied last (after all enhancement effects).
   */
  private getEffectsWithColorGrading(
    effects: EnhancementEffect[],
    colorGrading: ColorGradingSettings | undefined,
  ): EnhancementEffect[] {
    if (!colorGrading?.enabled) return effects;
    return [...effects, {
      id: 'anime4k/ColorGrading/ColorAdjust',
      name: 'Color Grading',
      className: 'ColorAdjust',
      params: {
        brightness: colorGrading.brightness,
        gamma: colorGrading.gamma,
        contrast: colorGrading.contrast,
        saturation: colorGrading.saturation,
        vibrance: colorGrading.vibrance,
        exposure: colorGrading.exposure,
      },
    }];
  }

  /**
   * Gets the ID of the currently active mode
   */
  public getCurrentModeId(): string | null {
    return this.currentModeId;
  }

  public getVideoElement(): HTMLVideoElement {
    return this.video;
  }

  /**
   * Detach method
   */
  public detach(): void {
    console.log('[Anime4KWebExt] Detaching enhancer from video.');
    this.overlay.detach();
    // Remove the attribute since it is no longer "applied" to any DOM element at this point
    this.video.removeAttribute(ANIME4K_APPLIED_ATTR);
  }

  /**
   * Reattach method
   */
  public async reattach(newVideo: HTMLVideoElement): Promise<void> {
    console.log('[Anime4KWebExt] Re-attaching enhancer to new video.');
    this.video = newVideo;
    this.overlay.reattach(newVideo);



    // Update the renderer
    if (this.renderer) {
      await this.renderer.updateVideoSource(newVideo);
      // Re-apply the attribute
      this.video.setAttribute(ANIME4K_APPLIED_ATTR, 'true');
    } else {
      this.disableEnhancement();
    }
  }

  /**
   * Destroys the entire enhancer instance (including UI elements and internal resources)
   */
  public destroy(): void {
    console.log('[Anime4KWebExt] Destroying enhancer instance:', this);
    this.disableEnhancement();
    this.overlay.destroy();
    console.log('[Anime4KWebExt] Enhancer destroyed')
  }

  /**
   * Disables video enhancement (releases resources and resets video state)
   */
  private disableEnhancement(): void {
    console.log('[Anime4KWebExt] disableEnhancement called. Current renderer:', this.renderer);
    console.log('[Anime4KWebExt] Video opacity before:', this.video.style.opacity);
    if (this.diagnosticsOverlay) {
      this.diagnosticsOverlay.destroy();
      this.diagnosticsOverlay = null;
    }
    this.releaseWebGPUResources();
    this.overlay.hideCanvas();
    console.log('[Anime4KWebExt] Video opacity after hideCanvas:', this.video.style.opacity);
    this.video.removeAttribute(ANIME4K_APPLIED_ATTR);
    this.button.innerText = t('enhanceButton');
    this.currentModeId = null;
    console.log('[Anime4KWebExt] disableEnhancement completed.');
  }

  /**
   * Gets GPU adapter info string for diagnostics display.
   * Tries WebGPU adapter info first, then falls back to WebGL renderer info
   * when WebGPU info is unavailable (common with anti-fingerprinting hardening).
   */
  private async getAdapterInfo(): Promise<string> {
    // Try WebGPU adapter info first
    try {
      if (navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) {
          const gpuAdapter = adapter as unknown as {
            requestAdapterInfo?: () => Promise<{ vendor: string; architecture: string; device: string; description: string }>
          };
          if (gpuAdapter.requestAdapterInfo) {
            const info = await gpuAdapter.requestAdapterInfo();
            const parts = [info.vendor, info.architecture, info.device]
              .filter(Boolean)
              .filter(s => s.length > 0);
            if (parts.length > 0) {
              return parts.join(' ');
            }
          }
        }
      }
    } catch {
      // Fall through to WebGL fallback
    }

    // Fallback: WebGL debug renderer info
    try {
      const canvas = document.createElement('canvas');
      const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext | null;
      if (gl) {
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        if (debugInfo) {
          const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
          if (renderer && typeof renderer === 'string' && renderer.length > 0) {
            return renderer;
          }
        }
        // Last resort: standard RENDERER parameter
        const renderer = gl.getParameter(gl.RENDERER);
        if (renderer && typeof renderer === 'string' && renderer.length > 0 && renderer !== 'WebKit WebGL') {
          return renderer;
        }
      }
    } catch {
      // Fall through to default
    }

    return 'Unknown GPU';
  }

  /**
   * Releases WebGPU-related resources
   */
  private releaseWebGPUResources(): void {
    if (this.renderer) {
      console.log('[Anime4KWebExt] Releasing WebGPU resources. Entering release block.');
      try {
        this.renderer.destroy();
        console.log('[Anime4KWebExt] renderer.destroy() completed.');
      } catch (e) {
        console.error('[Anime4KWebExt] Error caught during renderer.destroy():', e);
      } finally {
        this.renderer = null;
        console.log('[Anime4KWebExt] renderer set to null.');
      }
    }
  }

  /**
   * Shows an error notification (uses a singleton notification element to avoid duplicate DOM creation)
   */
  private static activeNotification: HTMLElement | null = null;
  private static notificationTimeout: number | null = null;

  private showErrorModal(message: string, showOptionsLink = false): void {
    // Reuse existing notification element
    if (VideoEnhancer.activeNotification) {
      VideoEnhancer.activeNotification.remove();
      VideoEnhancer.activeNotification = null;
    }
    if (VideoEnhancer.notificationTimeout !== null) {
      clearTimeout(VideoEnhancer.notificationTimeout);
      VideoEnhancer.notificationTimeout = null;
    }

    const notification = document.createElement('div');
    Object.assign(notification.style, {
      position: 'fixed', top: '20px', right: '20px',
      backgroundColor: '#333', color: '#fff', padding: '15px 20px',
      borderRadius: '4px', boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
      zIndex: '10000', maxWidth: '350px', fontFamily: 'Arial, sans-serif',
      fontSize: '14px', lineHeight: '1.5'
    });

    const messageNode = document.createElement('p');
    messageNode.textContent = `[Anime4K WebExtension] ${message}`;
    messageNode.style.margin = '0';
    notification.appendChild(messageNode);

    if (showOptionsLink) {
      const link = document.createElement('a');
      link.textContent = t('goToOptions', 'Go to Options');
      link.href = '#';
      link.style.color = '#8ab4f8';
      link.style.marginTop = '8px';
      link.style.display = 'block';
      link.onclick = (e) => {
        e.preventDefault();
        sendMessage({ type: 'OPEN_OPTIONS_PAGE' });
      };
      notification.appendChild(link);
    }

    document.body.appendChild(notification);
    VideoEnhancer.activeNotification = notification;

    VideoEnhancer.notificationTimeout = window.setTimeout(() => {
      notification.remove();
      if (VideoEnhancer.activeNotification === notification) {
        VideoEnhancer.activeNotification = null;
      }
      VideoEnhancer.notificationTimeout = null;
    }, 8000);
  }
}