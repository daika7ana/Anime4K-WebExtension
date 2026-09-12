import { defineConfig } from '@playwright/test';

/**
 * C3 Phase 1 — Playwright configuration for the headless-WebGPU correctness
 * gate.
 *
 * Kept separate from `playwright.config.ts` (which stays GPU-free) so the
 * normal `pnpm test:e2e` smoke suite never launches a GPU device.
 *
 * The Chromium flags below are copied verbatim from
 * `scripts/verify-wgsl-compilation.mjs` (its `CHROMIUM_ARGS`): WebGPU in
 * headless mode is only exposed with these, and SwiftShader provides a CPU
 * fallback on GPU-less runners. `channel: 'chromium'` selects the full
 * Chromium build (the headless shell does not expose WebGPU).
 */
const CHROMIUM_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=swiftshader',
  '--use-vulkan=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-vulkan-surface',
  '--no-sandbox',
];

const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e/gpu',

  // The chain-ablation specs are multi-minute experiments, not gates. Keep the
  // default GPU run fast; execute them explicitly with `pnpm test:gpu:ablation`.
  testIgnore: ['**/chain-ablation*.spec.ts'],

  // One GPU device at a time; the suite is a numeric gate, not a throughput test.
  fullyParallel: false,
  workers: 1,

  forbidOnly: isCI,
  retries: isCI ? 1 : 0,

  timeout: 60_000,
  expect: { timeout: 10_000 },

  reporter: isCI ? [['github'], ['list']] : [['list']],

  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium-webgpu',
      use: {
        browserName: 'chromium',
        channel: 'chromium',
        launchOptions: { args: CHROMIUM_ARGS },
      },
    },
  ],
});
