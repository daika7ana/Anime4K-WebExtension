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
import type { BackendRegistry } from 'anime4k-webgpu-async';
import type { EngineRegistryMode } from '@core/engines/flag';
import { CAS } from '@core/effects/cas';
import { ColorAdjust } from '@core/effects/color-adjust';
import { Debanding } from '@core/effects/debanding';
import { t } from '@utils/i18n';
import { yieldToMain } from '@core/utils/yield-utils';
import { gpuResourceCache } from '@core/gpu/gpu-resource-cache';
import { resolveEffectReference, type EffectResolution } from '@utils/effect-registry';
import { PipelinePreWarmer } from './pipeline-prewarmer';
import type { PreWarmEffectRef, PreWarmTarget } from './pipeline-prewarmer';
import { computeRemainingUpscaleFactors, planIntermediateDownscale } from './effect-chain';

/** Re-exported so engine adapters can type against the custom-effect registry. */
export type { CustomEffectDescriptor };

/**
 * Registry of custom (non-anime4k-webgpu-async) effects.
 *
 * Maps an effect's `className` to its constructor and a descriptor builder. Adding a
 * new custom effect is a one-entry change here — no edits to the pipeline build loop
 * or prewarmer. The descriptor builder receives the live effect params so per-effect
 * values (e.g. strength, threshold) flow through uniformly.
 */
export const CUSTOM_EFFECTS: Record<string, CustomEffectDescriptor> = {
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
 * Cached engine backend registry. Only populated in registry mode; loaded
 * lazily so a static import never inlines the monolithic library.
 */
let cachedBackendRegistry: BackendRegistry | null = null;

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
  /**
   * Effect-compilation path. Omitted or `'legacy'` keeps the legacy
   * per-className dispatch; `'registry'` compiles through the engine seam.
   */
  backendMode?: EngineRegistryMode;
}

/** Result of constructing one effect pipeline (legacy or registry path). */
interface EffectStep {
  pipeline: DestroyablePipeline;
  /** HUD/profiler label for the pipeline. */
  label: string;
  /** Whether the builder should consider an intermediate Downscale after it. */
  scaleApplied: boolean;
  /** Texture dimensions after this effect (before any intermediate Downscale). */
  postDimensions: Dimensions;
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
    oldPipelines, preWarmer: pipelinePreWarmer, onProgress, isStale, labels, backendMode,
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

  // --- Effect resolution and per-effect geometry ---
  // In legacy mode `resolutions` stays null and `upscaleFactors` reproduces
  // `computeRemainingUpscaleFactors(effects)` exactly, keeping legacy geometry
  // unchanged. In registry mode the descriptor's declared scale is the
  // authority (identical to `effect.upscaleFactor` for every current effect),
  // falling back to `effect.upscaleFactor` for unresolved legacy entries.
  const useRegistry = backendMode === 'registry';
  const resolutions: EffectResolution[] | null = useRegistry
    ? effects.map((effect) => resolveEffectReference(effect))
    : null;

  // Load the composed backend registry lazily: a static import would inline the
  // monolithic `anime4k-webgpu-async` UMD into the content chunk.
  if (useRegistry && !cachedBackendRegistry) {
    // Explicit `.js` specifier: TypeScript's node16 dynamic-import resolution
    // requires an extension; webpack's extensionAlias maps it to the `.ts`.
    const { getBackendRegistry } = await import('@core/engines/registry.js');
    cachedBackendRegistry = getBackendRegistry();
  }
  const registry = useRegistry ? cachedBackendRegistry : null;

  /** Pre-warm targets: engine identity + descriptor capabilities (registry mode). */
  const buildPrewarmTargets = (): PreWarmTarget[] =>
    effects.map((effect, i) => {
      const resolution = resolutions?.[i];
      if (resolution?.status === 'resolved') {
        const descriptor = resolution.effect.descriptor;
        return {
          ref: {
            backendId: descriptor.backendId,
            key: descriptor.key,
            className: effect.className,
          },
          capabilities: descriptor.capabilities,
        };
      }
      return {
        ref: {
          backendId: effect.backendId,
          key: effect.key ?? effect.className,
          className: effect.className,
        },
      };
    });

  /** Legacy dummy construction (CUSTOM_EFFECTS first, then the anime4k class map). */
  const compileLegacyDummy = (
    ref: PreWarmEffectRef,
    dev: GPUDevice,
    tex: GPUTexture,
  ): DestroyablePipeline | null => {
    const custom = CUSTOM_EFFECTS[ref.className];
    if (custom) {
      // Prewarm uses default params; the real build supplies effect.params.
      return new custom.EffectClass(custom.getDescriptor(dev, tex));
    }
    const EffectClass = (anime4kModule as unknown as Anime4KClassMap)[ref.className];
    if (!EffectClass) return null;
    return new EffectClass({
      device: dev,
      inputTexture: tex,
      nativeDimensions: { width: 1, height: 1 },
      targetDimensions: { width: 1, height: 1 },
    });
  };

  /** Registry dummy construction; falls back to the legacy class map per effect. */
  const compileRegistryDummy = async (
    ref: PreWarmEffectRef,
    dev: GPUDevice,
    tex: GPUTexture,
  ): Promise<DestroyablePipeline | null> => {
    if (!ref.backendId || !registry) {
      return compileLegacyDummy(ref, dev, tex);
    }
    let backend;
    try {
      backend = await registry.getBackendAsync(ref.backendId);
    } catch {
      // Unregistered backend: fall back to the legacy class map (may return null).
      return compileLegacyDummy(ref, dev, tex);
    }
    const node = await backend.compileEffect(
      { id: ref.key, backendId: ref.backendId, key: ref.key },
      {
        device: dev,
        inputTexture: tex,
        sourceDimensions: { width: 1, height: 1 },
        currentDimensions: { width: 1, height: 1 },
        targetDimensions: { width: 1, height: 1 },
        resources: gpuResourceCache,
        isStale: () => false,
      },
    );
    return node.pipeline;
  };

  // --- Phase 0: Speculative shader pre-warming ---
  // Construct dummy 1×1 pipelines to trigger driver-level shader compilation and caching.
  // The real pipeline construction in Phase 1 will then hit the cache (~1-3ms instead of ~25ms).
  // On subsequent calls (same effect chain), the pre-warmer skips via in-memory deduplication,
  // and the driver cache makes Phase 1 fast regardless.
  onProgress?.(t('warmupShadersProgress', '⏳ Compiling shaders...'));
  try {
    await pipelinePreWarmer.warm(
      device,
      buildPrewarmTargets(),
      useRegistry ? compileRegistryDummy : compileLegacyDummy,
    );
  } catch (e) {
    console.warn('[Anime4KWebExt] Phase 0 pre-warm failed (non-fatal):', e);
  }
  if (isStale()) return []; // Superseded

  const upscaleFactors = effects.map((effect, i) => {
    const resolution = resolutions?.[i];
    if (resolution?.status === 'resolved') {
      return resolution.effect.descriptor.dimensionBehavior.scale ?? 1;
    }
    return effect.upscaleFactor ?? 1;
  });
  const remainingUpscaleFactors = computeRemainingUpscaleFactors(
    upscaleFactors.map((upscaleFactor) => ({ upscaleFactor })),
  );

  // If needed, get the Downscale class
  const needsDownscaling = upscaleFactors.some(
    (factor, i) => factor > 1 && remainingUpscaleFactors[i] > 1,
  );
  const DownscaleClass = needsDownscaling ? anime4kModule.Downscale : null;

  /**
   * Legacy per-effect construction (CUSTOM_EFFECTS first, then the dynamic
   * anime4k class map). Also the per-effect fallback for registry mode, so the
   * legacy construction logic exists exactly once.
   */
  const buildLegacyStep = (effect: EnhancementEffect): EffectStep | null => {
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

    if (!pipeline) return null;

    return {
      pipeline,
      label: effect.className,
      // Truthiness (not `> 1`) matches the legacy `if (effect.upscaleFactor)` guard.
      scaleApplied: !!effect.upscaleFactor,
      postDimensions: effect.upscaleFactor
        ? { width: curWidth * effect.upscaleFactor, height: curHeight * effect.upscaleFactor }
        : { width: curWidth, height: curHeight },
    };
  };

  // --- Phase 1: Create all pipeline instances (no GPU submission) ---
  // Each pipeline constructor may trigger synchronous GPU shader compilation (200-500ms on first run),
  // so we yield the main thread after each pipeline creation to keep the UI responsive.
  for (let i = 0; i < effects.length; i++) {
    // Report progress
    const loadingMsg = t('loadingEffect', `⏳ Loading effect ${i + 1}/${effects.length}...`, [String(i + 1), String(effects.length)]);
    onProgress?.(loadingMsg, i + 1, effects.length);

    const effect = effects[i];
    let step: EffectStep | null;

    if (useRegistry && registry && resolutions) {
      const resolution = resolutions[i];

      if (resolution.status === 'resolved') {
        const { descriptor, reference } = resolution.effect;
        try {
          const backend = await registry.getBackendAsync(descriptor.backendId);
          const node = await backend.compileEffect(reference, {
            device,
            inputTexture: currentTexture,
            sourceDimensions: { width: video.videoWidth, height: video.videoHeight },
            currentDimensions: { width: curWidth, height: curHeight },
            targetDimensions,
            params: effect.params,
            resources: gpuResourceCache,
            isStale,
          });
          step = {
            pipeline: node.pipeline,
            label: node.profileLabel,
            scaleApplied: descriptor.dimensionBehavior.kind === 'scale',
            postDimensions: node.outputDimensions,
          };
        } catch (e) {
          console.warn(
            `[Anime4KWebExt] Registry compile failed for "${effect.className}" `
            + `(backend "${descriptor.backendId}"); falling back to legacy construction.`,
            e,
          );
          step = buildLegacyStep(effect);
        }
      } else {
        // New-style references for unregistered backends are preserved in
        // storage but cannot be compiled here; legacy entries unknown to the
        // catalog are equally unbuildable. Fall back per effect, never crash.
        console.warn(
          `[Anime4KWebExt] ${resolution.status === 'unresolved' ? 'Unresolved new-style' : 'Unknown legacy'} `
          + `effect (id "${effect.id}", className "${effect.className}"); falling back to legacy construction.`,
        );
        step = buildLegacyStep(effect);
      }
    } else {
      step = buildLegacyStep(effect);
    }

    if (step) {
      pipelines.push(step.pipeline);
      labels?.push(step.label);
      currentTexture = step.pipeline.getOutputTexture();

      let postDimensions = step.postDimensions;
      if (step.scaleApplied && DownscaleClass) {
        const intermediate = planIntermediateDownscale({
          curWidth: postDimensions.width,
          curHeight: postDimensions.height,
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
          postDimensions = intermediate;
        }
      }

      curWidth = postDimensions.width;
      curHeight = postDimensions.height;
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
