/**
 * Pipeline Builder — constructs Anime4K processing pipelines from an effect chain.
 *
 * Extracted from Renderer to isolate pipeline construction responsibilities.
 * Handles:
 *  - CUSTOM_EFFECTS registry for non-anime4k-webgpu-async effects (CAS, Debanding)
 *  - 3-phase pipeline building: shader pre-warm → pipeline creation → fire-and-forget warmup
 *  - Generation counter to prevent concurrent builds from clobbering each other
 *  - Shallow params comparison (replaces JSON.stringify)
 */
import type { Dimensions, EnhancementEffect, CustomEffectDescriptor, DestroyablePipeline, Anime4KClassMap } from '@/types';
import { CAS } from '@core/effects/cas';
import { ColorAdjust } from '@core/effects/color-adjust';
import { Debanding } from '@core/effects/debanding';
import { t } from '@utils/i18n';
import { yieldToMain } from '@core/utils/yield-utils';
import { PipelinePreWarmer } from './pipeline-prewarmer';
import { computeRemainingUpscaleFactors, planIntermediateDownscale } from './effect-chain';

/**
 * Registry of custom (non-anime4k-webgpu-async) effects.
 *
 * Maps an effect's `className` to its constructor and a descriptor builder. Adding a
 * new custom effect is a one-entry change here — no edits to the pipeline build loop
 * or prewarmer. The descriptor builder receives the live effect params so per-effect
 * values (e.g. strength, threshold) flow through uniformly.
 */
const CUSTOM_EFFECTS: Record<string, CustomEffectDescriptor> = {
  CAS: {
    EffectClass: CAS,
    getDescriptor: (device, inputTexture, params) => ({
      device,
      inputTexture,
      sharpness: params?.sharpness ?? 0.5,
    }),
  },
  Debanding: {
    EffectClass: Debanding,
    getDescriptor: (device, inputTexture, params) => ({
      device,
      inputTexture,
      strength: params?.strength ?? 0.5,
      bandThreshold: params?.bandThreshold ?? 0.08,
    }),
  },
  ColorAdjust: {
    EffectClass: ColorAdjust,
    getDescriptor: (device, inputTexture, params) => ({
      device,
      inputTexture,
      brightness: params?.brightness ?? 0,
      gamma: params?.gamma ?? 1,
      contrast: params?.contrast ?? 1,
      saturation: params?.saturation ?? 1,
      vibrance: params?.vibrance ?? 0,
      exposure: params?.exposure ?? 0,
    }),
  },
};

/** Cached anime4k-webgpu-async module (avoids repeated dynamic imports) */
let cachedAnime4KModule: typeof import('anime4k-webgpu-async') | null = null;

/**
 * Shallow comparison of two params objects.
 * Avoids JSON.stringify overhead and key-order sensitivity.
 */
export function paramsEqual(a?: Record<string, unknown>, b?: Record<string, unknown>): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(k => a[k] === b[k]);
}

/** Parameters for buildEffectPipelines */
interface BuildPipelinesParams {
  device: GPUDevice;
  videoFrameTexture: GPUTexture;
  video: HTMLVideoElement;
  targetDimensions: Dimensions;
  effects: EnhancementEffect[];
  /** Previously built pipelines to destroy before creating new ones */
  oldPipelines: DestroyablePipeline[];
  /** Shared PipelinePreWarmer for shader pre-warming */
  preWarmer: PipelinePreWarmer;
  /** Progress callback for UI updates */
  onProgress?: (stage: string | null, current?: number, total?: number) => void;
  /** Check if a newer build has superseded this one (generation counter) */
  isStale: () => boolean;
  /**
   * Optional out-parameter receiving one label per built pipeline, in encode
   * order: the effect's `className` for each effect pipeline, `'Downscale'` for
   * each intermediate downscale stage, and `'passthrough'` for the empty dummy
   * pipeline. Left untouched when omitted.
   */
  labels?: string[];
}

/**
 * Builds Anime4K processing pipelines based on the current effect chain.
 *
 * This is a standalone function extracted from Renderer.buildPipelines() (C1).
 * It handles all 3 phases:
 *  - Phase 0: Speculative shader pre-warming via PipelinePreWarmer
 *  - Phase 1: Create pipeline instances (with yieldToMain between each)
 *  - Phase 2: Fire-and-forget warmup submission
 *
 * @returns Array of built pipelines, or empty array if superseded by a newer build
 */
export async function buildEffectPipelines(params: BuildPipelinesParams): Promise<DestroyablePipeline[]> {
  const {
    device, videoFrameTexture, video, targetDimensions, effects,
    oldPipelines, preWarmer: pipelinePreWarmer, onProgress, isStale, labels,
  } = params;

  // Wait for the GPU queue to finish before destroying old pipelines to avoid resource contention
  try {
    await device.queue.onSubmittedWorkDone();
  } catch {
    // Ignore error; the device may have been lost
  }
  if (isStale()) return []; // Superseded by a newer build

  // Safely destroy old pipelines
  for (const p of oldPipelines) {
    try {
      p.destroy?.();
    } catch {
      // Ignore individual pipeline destruction errors
    }
  }

  const pipelines: DestroyablePipeline[] = [];
  let currentTexture = videoFrameTexture;
  let curWidth = video.videoWidth;
  let curHeight = video.videoHeight;

  // Use the cached module to avoid repeated dynamic imports
  if (!cachedAnime4KModule) {
    cachedAnime4KModule = await import('anime4k-webgpu-async');
  }
  const anime4kModule = cachedAnime4KModule;

  // --- Phase 0: Speculative shader pre-warming ---
  // Construct dummy 1×1 pipelines to trigger driver-level shader compilation and caching.
  // The real pipeline construction in Phase 1 will then hit the cache (~1-3ms instead of ~25ms).
  // On subsequent calls (same effect chain), the pre-warmer skips via in-memory deduplication,
  // and the driver cache makes Phase 1 fast regardless.
  onProgress?.(t('warmupShadersProgress', '⏳ Compiling shaders...'));
  try {
    await pipelinePreWarmer.warm(device, effects, (className, dev, tex) => {
      const custom = CUSTOM_EFFECTS[className];
      if (!custom) return null;
      // Prewarm uses default params; the real build supplies effect.params.
      return {
        EffectClass: custom.EffectClass,
        descriptor: custom.getDescriptor(dev, tex),
      };
    });
  } catch (e) {
    console.warn('[Anime4KWebExt] Phase 0 pre-warm failed (non-fatal):', e);
  }
  if (isStale()) return []; // Superseded

  const remainingUpscaleFactors = computeRemainingUpscaleFactors(effects);

  // If needed, get the Downscale class
  const needsDownscaling = effects.some((effect, i) =>
    (effect.upscaleFactor ?? 1) > 1 && remainingUpscaleFactors[i] > 1
  );
  const DownscaleClass = needsDownscaling ? anime4kModule.Downscale : null;

  // --- Phase 1: Create all pipeline instances (no GPU submission) ---
  // Each pipeline constructor may trigger synchronous GPU shader compilation (200-500ms on first run),
  // so we yield the main thread after each pipeline creation to keep the UI responsive.
  for (let i = 0; i < effects.length; i++) {
    // Report progress
    const loadingMsg = t('loadingEffect', `⏳ Loading effect ${i + 1}/${effects.length}...`, [String(i + 1), String(effects.length)]);
    onProgress?.(loadingMsg, i + 1, effects.length);

    const effect = effects[i];
    let pipeline: DestroyablePipeline | null = null;

    // Check for custom effects first (not from anime4k-webgpu-async library)
    const custom = CUSTOM_EFFECTS[effect.className];
    if (custom) {
      pipeline = new custom.EffectClass(
        custom.getDescriptor(device, currentTexture, effect.params),
      );
    } else {
      const EffectClass = (anime4kModule as unknown as Anime4KClassMap)[effect.className];

      if (EffectClass) {
        pipeline = new EffectClass({
          device,
          inputTexture: currentTexture,
          nativeDimensions: { width: curWidth, height: curHeight },
          targetDimensions,
        });
        // Apply effect params (e.g. DoG strength) after construction
        if (effect.params && pipeline) {
          for (const [key, value] of Object.entries(effect.params)) {
            pipeline.updateParam(key, value);
          }
        }
      } else {
        console.warn(`[Anime4KWebExt] Effect class "${effect.className}" not found in anime4k-webgpu-async module.`);
      }
    }

    if (pipeline) {
      pipelines.push(pipeline);
      labels?.push(effect.className);
      currentTexture = pipeline.getOutputTexture();

      if (effect.upscaleFactor) {
        curWidth *= effect.upscaleFactor;
        curHeight *= effect.upscaleFactor;

        if (DownscaleClass) {
          const intermediate = planIntermediateDownscale({
            curWidth,
            curHeight,
            targetDimensions,
            remainingFactor: remainingUpscaleFactors[i],
          });
          if (intermediate) {
            const intermediateDownscale = new DownscaleClass({
              device,
              inputTexture: currentTexture,
              targetDimensions: intermediate,
            });
            pipelines.push(intermediateDownscale);
            labels?.push('Downscale');

            currentTexture = intermediateDownscale.getOutputTexture();
            curWidth = intermediate.width;
            curHeight = intermediate.height;
          }
        }
      }
    }

    // Yield to let the browser process input events between synchronous GPU operations.
    // Uses scheduler.yield() (Chrome 115+) or MessageChannel fallback for faster
    // yielding than requestAnimationFrame, which waits for the next frame boundary.
    await yieldToMain();
  }
  if (isStale()) return []; // Superseded

  // --- Phase 2: Fire-and-forget warmup ---
  // Submit all shader compilations as a single batch without waiting for GPU completion.
  // Shader compilation happens at createComputePipeline() time (Phase 1), not at execution
  // time. The warmup pass validates the pipeline can execute and triggers minor GPU-side
  // optimizations. By NOT waiting for onSubmittedWorkDone(), we eliminate 400-800ms of
  // UI freeze. The first real render frame will naturally wait for this to complete
  // because GPUQueue.submit() maintains ordering.
  if (pipelines.length > 1) { // Skip dummy pipeline case
    try {
      const warmupEncoder = device.createCommandEncoder();
      for (const pipeline of pipelines) {
        await pipeline.pass(warmupEncoder);
      }
      device.queue.submit([warmupEncoder.finish()]);
      // NO onSubmittedWorkDone() — let the GPU process this asynchronously.
      // The first real render frame will naturally wait for this to complete.
    } catch (e) {
      console.warn('[Anime4KWebExt] Warmup submission failed, shaders will compile on first frame:', e);
    }
  }

  if (pipelines.length === 0) {
    // If no effects are applied, create a dummy pipeline
    pipelines.push({
      pass: () => Promise.resolve(),
      getOutputTexture: () => videoFrameTexture,
      updateParam: () => { },
    } as unknown as DestroyablePipeline);
    labels?.push('passthrough');
  }

  // Notify that warmup is complete
  onProgress?.(null);

  console.log(`[Anime4KWebExt] Built ${pipelines.length} pipelines with warmup complete.`);
  return pipelines;
}
