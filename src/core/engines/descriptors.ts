/**
 * Static descriptor metadata for the extension's effect backends.
 *
 * The 15 Anime4K descriptors are imported from the library's dependency-free
 * ESM catalog subpath (`anime4k-webgpu-async/engines/anime4k/catalog`). That
 * module is a standalone `anime4kEffectDescriptors` export with no pipeline or
 * WGSL imports, so the persistence/validation seam can consume it without
 * inlining the ~3.3 MiB library into the UI entry chunks.
 *
 * Do NOT import the package root or the `engines` / `engines/anime4k` barrels
 * here: those eagerly pull the Anime4K backend, constructors and pipelines and
 * would inline the whole library. `seam-bundle-purity.test.ts` enforces this.
 *
 * The extension-owned core effects (CAS / Debanding / ColorAdjust) are defined
 * here (metadata only) so this module has no runtime dependency on the GPU
 * pipeline builder; `./core-backend` imports {@link coreEffectDescriptors}
 * from here.
 */
import type { EffectDescriptor, EffectParamSchema } from 'anime4k-webgpu-async';
import { anime4kEffectDescriptors } from 'anime4k-webgpu-async/engines/anime4k/catalog';

const SAME = { kind: 'same' } as const;

function numberParam(
  min: number,
  max: number,
  step: number,
  defaultValue: number,
): EffectParamSchema {
  return { type: 'number', min, max, step, defaultValue };
}

/**
 * Catalog of the extension-owned effects (backend `core`).
 *
 * `paramsSchema` mirrors the slider bounds/defaults in
 * `src/ui/options/param-sliders.ts` and the validation bounds in
 * `src/utils/validation.ts` (`EFFECT_PARAM_BOUNDS` / `COLOR_GRADING_BOUNDS`).
 * Defined here (metadata only) so the persistence/validation path never pulls
 * the GPU pipeline builder; `./core-backend` imports this for compilation.
 */
export const coreEffectDescriptors: readonly EffectDescriptor[] = [
  {
    id: 'anime4k/Sharpen/CAS',
    backendId: 'core',
    key: 'CAS',
    name: 'Contrast Adaptive Sharpening (CAS)',
    category: 'sharpen',
    dimensionBehavior: SAME,
    paramsSchema: {
      sharpness: numberParam(0, 1, 0.01, 0.5),
    },
  },
  {
    id: 'anime4k/Debanding/Debanding',
    backendId: 'core',
    key: 'Debanding',
    name: 'Debanding',
    category: 'deband',
    dimensionBehavior: SAME,
    paramsSchema: {
      strength: numberParam(0, 1, 0.01, 0.5),
      bandThreshold: numberParam(0, 1, 0.01, 0.08),
    },
  },
  {
    id: 'anime4k/ColorGrading/ColorAdjust',
    backendId: 'core',
    key: 'ColorAdjust',
    name: 'Color Grading',
    category: 'color',
    dimensionBehavior: SAME,
    hidden: true,
    paramsSchema: {
      brightness: numberParam(-1, 1, 0.01, 0),
      gamma: numberParam(0.1, 4, 0.01, 1),
      contrast: numberParam(0, 2, 0.01, 1),
      saturation: numberParam(0, 2, 0.01, 1),
      vibrance: numberParam(-1, 1, 0.01, 0),
      exposure: numberParam(-3, 3, 0.1, 0),
    },
  },
];

/**
 * All static descriptors known to the seam, in backend-registration order:
 * the 15 library Anime4K effects (from the catalog-only subpath) followed by
 * the 3 extension core effects. (18 total, of which ColorAdjust is hidden.)
 */
export const extensionEffectDescriptors: readonly EffectDescriptor[] = [
  ...anime4kEffectDescriptors,
  ...coreEffectDescriptors,
];
