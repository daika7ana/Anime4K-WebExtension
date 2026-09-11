/**
 * Tests for {@link computeRemainingUpscaleFactors} and
 * {@link planIntermediateDownscale} — the shared per-step remaining-factor
 * heuristic used by both the pipeline builder and the GPU benchmark.
 *
 * The heuristic must reproduce the previous inline behavior byte-for-byte:
 * width-only trigger, strict `>` against `ideal * 1.1`, `Math.ceil` on each axis.
 */
import { describe, it, expect } from 'vitest';
import type { Dimensions, EnhancementEffect } from '@/types';
import {
    computeRemainingUpscaleFactors,
    planIntermediateDownscale,
    INTERMEDIATE_DOWNSCALE_THRESHOLD,
} from './effect-chain';

/** Build a minimal effect whose only relevant field is `upscaleFactor`. */
function effect(upscaleFactor?: number): Pick<EnhancementEffect, 'upscaleFactor'> {
    return { upscaleFactor };
}

describe('computeRemainingUpscaleFactors', () => {
    it('returns the product of every later upscale factor', () => {
        expect(computeRemainingUpscaleFactors([effect(1), effect(2), effect(1), effect(2)]))
            .toEqual([4, 2, 2, 1]);
    });

    it('returns all ones for an all-1 chain', () => {
        expect(computeRemainingUpscaleFactors([effect(1), effect(1), effect(1)]))
            .toEqual([1, 1, 1]);
    });

    it('returns 1 for the final element of a chain ending in an upscale', () => {
        expect(computeRemainingUpscaleFactors([effect(1), effect(2)])).toEqual([2, 1]);
        expect(computeRemainingUpscaleFactors([effect(2)])).toEqual([1]);
    });

    it('returns an empty array for an empty chain', () => {
        expect(computeRemainingUpscaleFactors([])).toEqual([]);
    });

    it('treats effects without an upscaleFactor as factor 1', () => {
        expect(computeRemainingUpscaleFactors([
            {},
            { upscaleFactor: 2 },
            {},
        ])).toEqual([2, 1, 1]);
    });

    it('falls back to 1 for an explicit undefined upscaleFactor', () => {
        expect(computeRemainingUpscaleFactors([effect(undefined), effect(2)]))
            .toEqual([2, 1]);
    });
});

describe('planIntermediateDownscale', () => {
    it('plans an intermediate Downscale when the current width overshoots', () => {
        const plan = planIntermediateDownscale({
            curWidth: 3840,
            curHeight: 2160,
            targetDimensions: { width: 1920, height: 1080 },
            remainingFactor: 2,
        });

        // ideal = 1920 / 2 = 960, 1080 / 2 = 540
        expect(plan).toEqual({ width: 960, height: 540 });
    });

    it('returns null when there is no remaining upscale (remainingFactor <= 1)', () => {
        expect(planIntermediateDownscale({
            curWidth: 100_000,
            curHeight: 100_000,
            targetDimensions: { width: 1920, height: 1080 },
            remainingFactor: 1,
        })).toBeNull();

        expect(planIntermediateDownscale({
            curWidth: 100_000,
            curHeight: 100_000,
            targetDimensions: { width: 1920, height: 1080 },
            remainingFactor: 0.5,
        })).toBeNull();
    });

    it('returns null at the exact threshold boundary (strict >)', () => {
        const ideal = 1920 / 2; // 960
        const boundary = ideal * INTERMEDIATE_DOWNSCALE_THRESHOLD; // 1056

        expect(planIntermediateDownscale({
            curWidth: boundary,
            curHeight: 1080,
            targetDimensions: { width: 1920, height: 1080 },
            remainingFactor: 2,
        })).toBeNull();
    });

    it('plans a Downscale just above the threshold boundary', () => {
        const ideal = 1920 / 2; // 960
        const boundary = ideal * INTERMEDIATE_DOWNSCALE_THRESHOLD; // 1056

        expect(planIntermediateDownscale({
            curWidth: boundary + 1,
            curHeight: 1080,
            targetDimensions: { width: 1920, height: 1080 },
            remainingFactor: 2,
        })).toEqual({ width: 960, height: 540 });
    });

    it('rounds each axis up independently with Math.ceil', () => {
        const plan = planIntermediateDownscale({
            curWidth: 2000,
            curHeight: 2000,
            targetDimensions: { width: 1921, height: 1081 },
            remainingFactor: 2,
        });

        // ideal = 960.5 x 540.5 -> ceil 961 x 541
        expect(plan).toEqual({ width: 961, height: 541 });
    });

    it('uses width only as the trigger, ignoring the current height', () => {
        // Width below threshold with an enormous height -> no Downscale.
        expect(planIntermediateDownscale({
            curWidth: 1000,
            curHeight: 100_000,
            targetDimensions: { width: 1920, height: 1080 },
            remainingFactor: 2,
        })).toBeNull();

        // Width above threshold with a tiny height -> Downscale still planned.
        expect(planIntermediateDownscale({
            curWidth: 2000,
            curHeight: 1,
            targetDimensions: { width: 1920, height: 1080 },
            remainingFactor: 2,
        })).toEqual({ width: 960, height: 540 });
    });

    it('matches the plan the old inline benchmark traversal produced', () => {
        // Benchmark scene: 1080p source, 4K target, chain upscale factors [1,2,1,2].
        // Traversal mirrors runEffectChainTest: upscale then decide, threading dims.
        const effects = [effect(1), effect(2), effect(1), effect(2)];
        const remaining = computeRemainingUpscaleFactors(effects);
        const target: Dimensions = { width: 3840, height: 2160 };

        let curWidth = 1920;
        let curHeight = 1080;
        const inserted: Dimensions[] = [];

        effects.forEach((e, i) => {
            const factor = e.upscaleFactor ?? 1;
            if (factor > 1) {
                curWidth *= factor;
                curHeight *= factor;

                const plan = planIntermediateDownscale({
                    curWidth,
                    curHeight,
                    targetDimensions: target,
                    remainingFactor: remaining[i],
                });
                if (plan) {
                    inserted.push(plan);
                    curWidth = plan.width;
                    curHeight = plan.height;
                }
            }
        });

        // Step index 1 (2x, remaining 2) overshoots 3840 > 1920*1.1 -> insert 1920x1080.
        // Step index 3 (2x, remaining 1) has no remaining upscale -> no insert.
        expect(inserted).toEqual([{ width: 1920, height: 1080 }]);
        expect({ width: curWidth, height: curHeight }).toEqual({ width: 3840, height: 2160 });

        // The single triggering call, spelled out.
        expect(planIntermediateDownscale({
            curWidth: 3840,
            curHeight: 2160,
            targetDimensions: target,
            remainingFactor: 2,
        })).toEqual({ width: 1920, height: 1080 });
    });
});
