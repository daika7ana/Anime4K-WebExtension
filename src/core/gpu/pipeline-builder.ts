/**
 * Pipeline Builder — constructs Anime4K processing pipelines from an effect chain.
 *
 * Extracted from Renderer to isolate pipeline construction responsibilities.
 * Handles:
 *  - Engine-registry dispatch: every effect compiles through its backend
 *  - 3-phase pipeline building: shader pre-warm → pipeline creation → fire-and-forget warmup
 *  - Generation counter to prevent concurrent builds from clobbering each other
 *  - Shallow params comparison (replaces JSON.stringify)
 */
import type { Dimensions, EnhancementEffect, DestroyablePipeline } from '@/types';
import type { BackendRegistry } from 'anime4k-webgpu-async';
import { t } from '@utils/i18n';
import { gpuResourceCache } from '@core/gpu/gpu-resource-cache';
import { resolveEffectReference, type EffectResolution } from '@utils/effect-registry';
import { PipelinePreWarmer } from './pipeline-prewarmer';
import type { PreWarmEffectRef, PreWarmTarget } from './pipeline-prewarmer';
import { computeRemainingUpscaleFactors, planChainGeometryPreview, isSuppressedIndex, DEFAULT_MAX_INTERMEDIATE_PIXELS, type ChainGeometryLimits, type RestoreSuppression } from './effect-chain';
import { compileEffectChain } from './effect-chain-compiler';

/** Cached anime4k-webgpu-async module (avoids repeated dynamic imports) */
let cachedAnime4KModule: typeof import('anime4k-webgpu-async') | null = null;

/**
 * Cached engine backend registry, loaded lazily so a static import never inlines
 * the monolithic library.
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
   * Local "Preserve fine detail" preference. For built-in modes only, keeps the
   * V2 restore policy (`'trailing'`): skip the scale-1 restore passes emitted
   * after the target-exact final Downscale. When `false`, built-in modes use the
   * full-enhancement V1 chain (`'off'`, every restore retained). Custom chains
   * always use `'off'` regardless. Defaults to `true` (V2).
   */
  preserveDetail?: boolean;
  /**
   * Whether the active chain is a built-in mode (tier-driven). Custom chains
   * are authored by the user and are never silently mutated. Defaults to
   * `true` so existing callers/tests keep the built-in V2 behavior.
   */
  isBuiltInMode?: boolean;
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
    preserveDetail = true, isBuiltInMode = true,
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

  // Use the cached module to avoid repeated dynamic imports
  if (!cachedAnime4KModule) {
    cachedAnime4KModule = await import('anime4k-webgpu-async');
  }
  const anime4kModule = cachedAnime4KModule;

  // --- Effect resolution and per-effect geometry ---
  // Every effect is resolved against the static descriptor table and compiled
  // through its engine backend. `resolutions` mirrors `effects` one-to-one so a
  // suppressed or failed index keeps its slot.
  const resolutions: EffectResolution[] = effects.map((effect) =>
    resolveEffectReference(effect),
  );

  // Load the composed backend registry lazily: a static import would inline the
  // monolithic `anime4k-webgpu-async` into the content chunk.
  if (!cachedBackendRegistry) {
    // Explicit `.js` specifier: TypeScript's node16 dynamic-import resolution
    // requires an extension; webpack's extensionAlias maps it to the `.ts`.
    const { getBackendRegistry } = await import('@core/engines/registry.js');
    cachedBackendRegistry = getBackendRegistry();
  }
  const registry = cachedBackendRegistry;

  // --- Effect-chain geometry pre-pass ---
  // The descriptor's declared scale is the authority; unresolved entries fall
  // back to `effect.upscaleFactor` so their geometry slot is still planned.
  const upscaleFactors = effects.map((effect, i) => {
    const resolution = resolutions[i];
    if (resolution.status === 'resolved') {
      return resolution.effect.descriptor.dimensionBehavior.scale ?? 1;
    }
    return effect.upscaleFactor ?? 1;
  });
  // Restore-role flags come from the authoritative descriptor category, so
  // helpers (e.g. ClampHighlights → 'helper') are never misclassified. The
  // geometry planner stays library-free and only sees booleans.
  const restoreFlags = resolutions.map(
    (resolution) =>
      resolution.status === 'resolved'
      && resolution.effect.descriptor.category === 'restore',
  );
  // Color-category effects (color grading) must run AFTER the deferred
  // ClampHighlightsApply epilogue; see compileEffectChain.
  const postEpilogueFlags = resolutions.map(
    (resolution) =>
      resolution.status === 'resolved'
      && resolution.effect.descriptor.category === 'color',
  );
  // Built-in modes default to V2 (drop restores after the final Downscale).
  // Turning "Preserve fine detail" off restores the full-enhancement V1 chain,
  // and custom chains are user-authored so they are never mutated.
  const restoreSuppression: RestoreSuppression =
    isBuiltInMode && preserveDetail ? 'trailing' : 'off';
  const remainingUpscaleFactors = computeRemainingUpscaleFactors(
    upscaleFactors.map((upscaleFactor) => ({ upscaleFactor })),
  );
  // Device-derived intermediate-texture ceilings. The render target is already
  // clamped upstream; this keeps the *intermediates* from exceeding the
  // adapter's per-axis texture limit or the per-texture memory budget.
  const limits: ChainGeometryLimits = {
    maxDimension: device.limits.maxTextureDimension2D,
    maxIntermediatePixels: DEFAULT_MAX_INTERMEDIATE_PIXELS,
  };
  const geometryPreview = planChainGeometryPreview({
    sourceDimensions: { width: video.videoWidth, height: video.videoHeight },
    targetDimensions,
    upscaleFactors,
    limits,
    restoreFlags,
    restoreSuppression,
  });
  const suppressActive = geometryPreview.suppressFromIndex !== null;

  /** Pre-warm targets: engine identity + descriptor capabilities (resolved only). */
  const buildPrewarmTargets = (): PreWarmTarget[] =>
    effects
      .map((effect, i): PreWarmTarget | null => {
        // Suppressed later upscalers are never constructed, so they are not
        // pre-warmed either.
        if (isSuppressedIndex(geometryPreview, upscaleFactors, i)) return null;
        // Unresolved/unknown effects are never compiled, so they cannot be
        // pre-warmed.
        const resolution = resolutions[i];
        if (resolution.status !== 'resolved') return null;
        const descriptor = resolution.effect.descriptor;
        return {
          ref: {
            backendId: descriptor.backendId,
            key: descriptor.key,
            className: effect.className,
          },
          capabilities: descriptor.capabilities,
        };
      })
      .filter((target): target is PreWarmTarget => target !== null);

  /**
   * Registry dummy construction. Returns `null` when the target has no backend
   * id or its backend cannot be resolved (such effects are skipped, never
   * pre-warmed).
   */
  const compileDummy = async (
    ref: PreWarmEffectRef,
    dev: GPUDevice,
    tex: GPUTexture,
  ): Promise<DestroyablePipeline | null> => {
    if (!ref.backendId) return null;
    let backend;
    try {
      backend = await registry.getBackendAsync(ref.backendId);
    } catch {
      // Unregistered backend: skip the effect.
      return null;
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
      compileDummy,
    );
  } catch (e) {
    console.warn('[Anime4KWebExt] Phase 0 pre-warm failed (non-fatal):', e);
  }
  if (isStale()) return []; // Superseded

  // If needed, get the Downscale class. In non-suppressed mode this is the
  // per-step intermediate rule; when suppression is active the only possible
  // Downscale is the single final one.
  const needsDownscaling = suppressActive
    ? geometryPreview.finalDownscale !== null
    : upscaleFactors.some(
      (factor, i) => factor > 1 && remainingUpscaleFactors[i] > 1,
    );
  const DownscaleClass = needsDownscaling ? anime4kModule.Downscale : null;

  // --- Phase 1: Create all pipeline instances (no GPU submission) ---
  // The shared compiler owns the ordered chain walk (safe-geometry suppression,
  // intermediate/final Downscales, deferred epilogue materialization, per-step
  // yielding); this caller supplies only the per-effect compilation policy.
  const result = await compileEffectChain({
    device,
    inputTexture: videoFrameTexture,
    sourceDimensions: { width: video.videoWidth, height: video.videoHeight },
    targetDimensions,
    effects,
    upscaleFactors,
    downscaleCtor: DownscaleClass,
    limits,
    restoreFlags,
    postEpilogueFlags,
    restoreSuppression,
    compileEffect: async ({
      effect,
      index,
      inputTexture,
      currentDimensions,
      targetDimensions: effectTargetDimensions,
    }) => {
      const resolution = resolutions[index];

      if (resolution.status === 'resolved') {
        const { descriptor, reference } = resolution.effect;
        try {
          const backend = await registry.getBackendAsync(descriptor.backendId);
          const node = await backend.compileEffect(reference, {
            device,
            inputTexture,
            sourceDimensions: { width: video.videoWidth, height: video.videoHeight },
            currentDimensions,
            targetDimensions: effectTargetDimensions,
            params: effect.params,
            resources: gpuResourceCache,
            isStale,
          });
          return {
            pipeline: node.pipeline,
            label: node.profileLabel,
            scaleApplied: descriptor.dimensionBehavior.kind === 'scale',
            postDimensions: node.outputDimensions,
          };
        } catch (e) {
          console.warn(
            `[Anime4KWebExt] Registry compile failed for "${effect.className}" `
            + `(backend "${descriptor.backendId}"); skipping effect.`,
            e,
          );
          return null;
        }
      }

      // New-style references for unregistered backends are preserved in
      // storage but cannot be compiled here; legacy entries unknown to the
      // catalog are equally unbuildable. Skip the effect, never crash.
      console.warn(
        `[Anime4KWebExt] ${resolution.status === 'unresolved' ? 'Unresolved new-style' : 'Unknown legacy'} `
        + `effect (id "${effect.id}", className "${effect.className}"); skipping effect.`,
      );
      return null;
    },
    onEffectStart: (index, total) => {
      // Report progress
      const loadingMsg = t('loadingEffect', `⏳ Loading effect ${index + 1}/${total}...`, [String(index + 1), String(total)]);
      onProgress?.(loadingMsg, index + 1, total);
    },
    isStale,
  });

  if (result.superseded) {
    // Discard everything: keep `labels` consistent with the returned [].
    labels?.splice(0, labels.length);
    return []; // Superseded
  }

  // Copy labels only after a successful (non-superseded) compile so a
  // superseded build never leaves partial labels behind.
  if (labels) {
    labels.push(...result.labels);
  }
  const { pipelines } = result;

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
