/**
 * Ordering tests for {@link compileEffectChain}'s post-epilogue pass.
 *
 * Color-grading effects are flagged via `postEpilogueFlags` so they compile
 * AFTER the deferred `ClampHighlightsApply` epilogues. Otherwise the deferred
 * apply clamps the graded frame back to the pre-grading luma stats, making the
 * color effect appear to do nothing. These tests stub the per-effect compiler
 * (no GPU mock) and assert the emitted pipeline order plus the texture threaded
 * into the post effect.
 */
import { describe, it, expect } from 'vitest';
import type { DestroyablePipeline, EnhancementEffect } from '@/types';
import {
  compileEffectChain,
  DEFERRED_APPLY_LABEL,
  type CompileChainEffectArgs,
  type ChainEffectStep,
} from './effect-chain-compiler';

/** Minimal effect; only identity fields matter to the compiler. */
function effect(className: string): EnhancementEffect {
  return { id: className, name: className, className, upscaleFactor: 1 };
}

/** Placeholder texture; identity is all the assertions need. */
function texture(label: string): GPUTexture {
  return { label } as unknown as GPUTexture;
}

describe('compileEffectChain post-epilogue ordering', () => {
  it('compiles post-epilogue effects after the deferred epilogue, threading the deferred output', async () => {
    const firstOutput = texture('first-output');
    const deferredOutput = texture('deferred-output');
    const postOutput = texture('post-output');

    const deferredPipeline = {
      getOutputTexture: () => deferredOutput,
    } as unknown as DestroyablePipeline;

    const firstPipeline = {
      getOutputTexture: () => firstOutput,
      getDeferredPipeline: () => deferredPipeline,
    } as unknown as DestroyablePipeline;

    const postPipeline = {
      getOutputTexture: () => postOutput,
    } as unknown as DestroyablePipeline;

    let postInputTexture: GPUTexture | undefined;
    const compileOrder: number[] = [];

    const compileEffect = async (
      args: CompileChainEffectArgs,
    ): Promise<ChainEffectStep | null> => {
      compileOrder.push(args.index);
      if (args.index === 0) {
        return {
          pipeline: firstPipeline,
          label: 'first',
          scaleApplied: false,
          postDimensions: { width: 32, height: 24 },
        };
      }
      postInputTexture = args.inputTexture;
      return {
        pipeline: postPipeline,
        label: 'post',
        scaleApplied: false,
        postDimensions: { width: 16, height: 12 },
      };
    };

    const result = await compileEffectChain({
      device: { limits: { maxTextureDimension2D: 8192 } } as unknown as GPUDevice,
      inputTexture: texture('input'),
      sourceDimensions: { width: 16, height: 12 },
      targetDimensions: { width: 16, height: 12 },
      effects: [effect('First'), effect('Post')],
      upscaleFactors: [1, 1],
      restoreFlags: [false, false],
      postEpilogueFlags: [false, true],
      downscaleCtor: null,
      compileEffect,
    });

    expect(result.superseded).toBe(false);
    expect(result.labels).toEqual(['first', DEFERRED_APPLY_LABEL, 'post']);
    expect(result.pipelines).toEqual([firstPipeline, deferredPipeline, postPipeline]);
    // The post effect must consume the deferred apply's output, not `firstOutput`.
    expect(postInputTexture).toBe(deferredOutput);
    // The deferred epilogue must not compile the post effect in the main loop.
    expect(compileOrder).toEqual([0, 1]);
    // Final dimensions come from the last (post) step.
    expect(result.outputDimensions).toEqual({ width: 16, height: 12 });
  });
});
