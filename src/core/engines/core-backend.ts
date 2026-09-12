/**
 * Core backend — the extension-owned custom effects (CAS, Debanding, ColorAdjust).
 *
 * Wraps the existing `CUSTOM_EFFECTS` registry in `@core/gpu/pipeline-builder` so
 * these effects participate in the engine contract without moving any shader or
 * math logic. Descriptors reuse the legacy ids (`anime4k/...`) even though the
 * backend id is `core`, so no storage migration is required.
 */
import type {
  AlgorithmBackend,
  CompileEffectContext,
  CompiledEffectNode,
  EffectReference,
} from 'anime4k-webgpu-async';
import { CUSTOM_EFFECTS } from '@core/gpu/pipeline-builder';
import { coreEffectDescriptors } from './descriptors';

// Re-exported for existing consumers. The descriptors are defined in
// `./descriptors` (metadata only) so the persistence/validation path never
// pulls the GPU pipeline builder that this module imports for `CUSTOM_EFFECTS`.
export { coreEffectDescriptors };

export function createCoreBackend(): AlgorithmBackend {
  return {
    backendId: 'core',
    displayName: 'Core',
    listEffects: () => coreEffectDescriptors,
    async compileEffect(
      ref: EffectReference,
      ctx: CompileEffectContext,
    ): Promise<CompiledEffectNode> {
      const custom = CUSTOM_EFFECTS[ref.key];
      if (!custom) {
        throw new Error(`[core] Unknown effect key "${ref.key}" (id "${ref.id}").`);
      }

      // Core effects only expose numeric params; `getDescriptor` narrows each
      // param to its default when absent (see `CUSTOM_EFFECTS`).
      const params = ctx.params as Record<string, number> | undefined;
      const pipeline = new custom.EffectClass(
        custom.getDescriptor(ctx.device, ctx.inputTexture, params),
      );

      return {
        pipeline,
        outputTexture: pipeline.getOutputTexture(),
        outputDimensions: ctx.currentDimensions,
        profileLabel: ref.key,
      };
    },
  };
}
