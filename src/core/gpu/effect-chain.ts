/**
 * Effect Chain — shared helpers for effect-chain geometry planning.
 *
 * Both the renderer's pipeline builder and the GPU benchmark walk an effect
 * chain, tracking the current texture dimensions and deciding when an
 * intermediate `Downscale` must be inserted between two upscaling effects to
 * keep intermediate textures from ballooning past the render target.
 *
 * The decision is a per-step remaining-upscale rule:
 *
 *  - {@link computeRemainingUpscaleFactors} pre-computes, for every effect, the
 *    product of the upscale factors of all effects strictly after it.
 *  - {@link planIntermediateDownscale} then, after an upscaling step, compares
 *    the current width against the ideal intermediate size (target width
 *    divided by the remaining upscale factor) and requests a Downscale when the
 *    current width exceeds that ideal by more than
 *    {@link INTERMEDIATE_DOWNSCALE_THRESHOLD}.
 *
 * This is deliberately NOT the `anime4k-webgpu-async` `PipelineChain` /
 * `AutoDownscale` / `planAutoDownscale` heuristic, which reasons about preset
 * native→target ratio bands. The rule here is a per-step remaining-factor rule
 * and must stay behavior-identical across call sites.
 *
 * The module is pure and dependency-free (type-only imports); it performs no
 * GPU work and constructs no pipelines.
 */
import type { Dimensions, EnhancementEffect, DestroyablePipeline } from '@/types';

/**
 * Fraction of the ideal intermediate width that the current width must exceed
 * before an intermediate Downscale is inserted. Strictly greater-than: a width
 * exactly equal to `ideal * INTERMEDIATE_DOWNSCALE_THRESHOLD` does NOT trigger.
 */
export const INTERMEDIATE_DOWNSCALE_THRESHOLD = 1.1;

/**
 * Constructor signature for a pipeline that consumes an input texture and emits
 * an output texture, as accepted by the library effect classes and `Downscale`.
 */
export type PipelineCtor = new (descriptor: {
    device: GPUDevice;
    inputTexture: GPUTexture;
    nativeDimensions: Dimensions;
    targetDimensions: Dimensions;
}) => DestroyablePipeline;

/**
 * Compute, for every effect index `i`, the product of the `upscaleFactor`
 * (defaulting to `1`) of every effect strictly after index `i`.
 *
 * For `[1, 2, 1, 2]` this yields `[4, 2, 2, 1]`: the last effect has no
 * remaining upscales after it, so its factor is `1` (the empty-product
 * identity).
 *
 * @param effects Effect chain in encode order.
 * @returns One remaining-upscale factor per effect, in the same order.
 */
export function computeRemainingUpscaleFactors(
    effects: ReadonlyArray<Pick<EnhancementEffect, 'upscaleFactor'>>,
): number[] {
    const upscaleFactors = effects.map(e => e.upscaleFactor ?? 1);
    return upscaleFactors.map((_, i) =>
        upscaleFactors.slice(i + 1).reduce((acc, val) => acc * val, 1)
    );
}

/**
 * Decide whether an intermediate Downscale is required after an upscaling step.
 *
 * An intermediate Downscale is requested only when BOTH hold:
 *
 *  1. `remainingFactor > 1` — there is still at least one upscale after this
 *     step, so the chain will grow again.
 *  2. `curWidth > (targetDimensions.width / remainingFactor) * 1.1` — the
 *     current width overshoots the ideal intermediate width by more than
 *     {@link INTERMEDIATE_DOWNSCALE_THRESHOLD} (strict `>`).
 *
 * The trigger considers width only. Both axes are still rounded up
 * independently with `Math.ceil`, so an odd/indivisible target yields the
 * smallest integer dimensions that fully contain the ideal.
 *
 * @param params Current width/height, the render target, and the product of the
 *   upscale factors remaining after the current step.
 * @returns The `Math.ceil`-rounded intermediate dimensions to hand to a
 *   Downscale, or `null` when no intermediate Downscale is needed.
 */
export function planIntermediateDownscale(params: {
    curWidth: number;
    curHeight: number;
    targetDimensions: Dimensions;
    remainingFactor: number;
}): Dimensions | null {
    const { curWidth, targetDimensions, remainingFactor } = params;
    if (remainingFactor <= 1) return null;

    const idealIntermediateWidth = targetDimensions.width / remainingFactor;
    const idealIntermediateHeight = targetDimensions.height / remainingFactor;

    if (curWidth > idealIntermediateWidth * INTERMEDIATE_DOWNSCALE_THRESHOLD) {
        return {
            width: Math.ceil(idealIntermediateWidth),
            height: Math.ceil(idealIntermediateHeight),
        };
    }
    return null;
}
