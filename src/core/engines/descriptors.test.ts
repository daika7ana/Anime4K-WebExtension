/**
 * Catalog composition guard.
 *
 * `anime4kEffectDescriptors` from the dependency-free
 * `anime4k-webgpu-async/engines/anime4k/catalog` subpath is now the single
 * source of truth for the 15 Anime4K descriptors, so there is no extension-side
 * mirror left to drift. This test pins the composed seam catalog instead: 18
 * descriptors in registration order (15 library + 3 extension-owned core) with
 * the expected ids and metadata.
 */
import { describe, it, expect } from 'vitest';
import { anime4kEffectDescriptors } from 'anime4k-webgpu-async/engines/anime4k/catalog';
import { coreEffectDescriptors, extensionEffectDescriptors } from './descriptors';

/** Exact expected id order of the composed 18-descriptor seam catalog. */
const EXPECTED_IDS = [
  // 15 Anime4K descriptors (library catalog, ascending registration order)
  'anime4k/Helper/ClampHighlights',
  'anime4k/Deblur/DoG',
  'anime4k/Denoise/BilateralMean',
  'anime4k/Restore/CNNM',
  'anime4k/Restore/CNNSoftM',
  'anime4k/Restore/CNNSoftVL',
  'anime4k/Restore/CNNVL',
  'anime4k/Restore/CNNUL',
  'anime4k/Restore/GANUUL',
  'anime4k/Upscale/CNNx2M',
  'anime4k/Upscale/CNNx2VL',
  'anime4k/Upscale/DenoiseCNNx2VL',
  'anime4k/Upscale/CNNx2UL',
  'anime4k/Upscale/GANx3L',
  'anime4k/Upscale/GANx4UUL',
  // 3 extension-owned core descriptors
  'anime4k/Sharpen/CAS',
  'anime4k/Debanding/Debanding',
  'anime4k/ColorGrading/ColorAdjust',
] as const;

describe('extensionEffectDescriptors composition', () => {
  it('has 18 descriptors in the expected registration order', () => {
    expect(extensionEffectDescriptors).toHaveLength(18);
    expect(extensionEffectDescriptors.map((descriptor) => descriptor.id)).toEqual(EXPECTED_IDS);
  });

  it('starts with the 15 library Anime4K descriptors, unmodified', () => {
    expect(anime4kEffectDescriptors).toHaveLength(15);
    expect(extensionEffectDescriptors.slice(0, 15)).toEqual(anime4kEffectDescriptors);
  });

  it('appends exactly the 3 extension-owned core descriptors', () => {
    expect(coreEffectDescriptors).toHaveLength(3);
    expect(extensionEffectDescriptors.slice(15)).toEqual(coreEffectDescriptors);
  });

  it('keeps backend ownership intact (anime4k first, then core)', () => {
    expect(extensionEffectDescriptors.slice(0, 15).every((d) => d.backendId === 'anime4k')).toBe(
      true,
    );
    expect(extensionEffectDescriptors.slice(15).every((d) => d.backendId === 'core')).toBe(true);
  });
});
