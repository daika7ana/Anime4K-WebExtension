import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import {
  referenceBilinearDownscale,
  referenceDownscale,
} from '../../src/core/effects/reference/downscale';
import { compareRgba, formatComparison } from '../../src/core/effects/reference/compare';
import { fineChecker, gradient, impulse, type RgbaImage } from './fixtures';

/**
 * Headless-WebGPU numeric correctness gate for the shipped compute `Downscale`
 * (ratio-scaled fractional-coverage box filter in linear light).
 *
 * Loads the *real* compiled WGSL string from the linked `anime4k-webgpu-async`
 * package (resolved through the package entry, so it also works with a
 * published, non-linked install), runs it on a GPU (SwiftShader fallback),
 * reads the `rgba16float` storage texture back and compares it against the
 * independent pure-TS oracle in `src/core/effects/reference/downscale.ts`.
 *
 * Launched with `playwright.gpu.config.ts` / `pnpm test:gpu`; the config's
 * `testDir: './e2e/gpu'` picks this file up automatically.
 */

interface GpuRequest {
  wgsl: string;
  srcWidth: number;
  srcHeight: number;
  outWidth: number;
  outHeight: number;
  pixels: number[];
}

interface GpuSuccess {
  ok: true;
  width: number;
  height: number;
  data: number[];
  adapterInfo: string;
  software: boolean;
}

interface GpuFailure {
  ok: false;
  kind: 'unavailable' | 'validation';
  error: string;
}

type GpuResult = GpuSuccess | GpuFailure;

const ALLOW_GPU_SKIP = process.env.ALLOW_GPU_SKIP === '1';

// Trivial rgba16float passthrough (identity) used to probe that this
// environment can create a device, dispatch compute, store to an rgba16float
// storage texture, copy it to a buffer and map it back.
const PREFLIGHT_WGSL = `
@group(0) @binding(0) var tex_in: texture_2d<f32>;
@group(0) @binding(1) var tex_out: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn computeMain(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(tex_out);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }
  textureStore(tex_out, vec2<i32>(gid.xy), textureLoad(tex_in, vec2<i32>(gid.xy), 0));
}
`;

const PAGE_HTML =
  '<!doctype html><html><head><meta charset="utf-8">'
  + '<title>gpu-downscale-correctness</title></head><body></body></html>';

interface DownscaleCase {
  name: string;
  image: RgbaImage;
  outWidth: number;
  outHeight: number;
}

// Every per-axis ratio is exact: 96/72 = 72/54 = 4/3, 96/72 = 64/48 = 3/2,
// 96/72 = 48/36 = 2/1, 80/40 = 48/24 = 5/3 (top of the (1, 1.67) envelope).
const DOWNSCALE_CASES: DownscaleCase[] = [
  { name: 'downscale-4-3', image: fineChecker(96, 72), outWidth: 72, outHeight: 54 },
  { name: 'downscale-3-2', image: fineChecker(96, 72), outWidth: 64, outHeight: 48 },
  { name: 'downscale-2-1', image: impulse(96, 72), outWidth: 48, outHeight: 36 },
  { name: 'downscale-5-3', image: impulse(80, 40), outWidth: 48, outHeight: 24 },
  { name: 'downscale-1-1', image: gradient(64, 48), outWidth: 64, outHeight: 48 },
];

let server: Server | undefined;
let origin = '';
let preflight: GpuResult | null = null;
let downscaleWgsl = '';

/**
 * Resolve the compiled WGSL module robustly: resolve the package entry, then
 * look for the shader text module next to `dist/index.js`. Works for both the
 * linked local repo and a published tarball.
 */
function resolveDownscaleWgslPath(): string {
  const require = createRequire(__filename);
  let entry: string;
  try {
    entry = require.resolve('anime4k-webgpu-async');
  } catch (error) {
    throw new Error(
      `downscale-correctness: cannot resolve 'anime4k-webgpu-async': ${String(error)}`,
      { cause: error },
    );
  }
  const candidate = path.join(
    path.dirname(entry),
    'pipelines',
    'helpers',
    'Downscale',
    'shaders',
    'downscale.wgsl.js',
  );
  if (!existsSync(candidate)) {
    throw new Error(`downscale-correctness: Downscale WGSL module not found at ${candidate}`);
  }
  return candidate;
}

function startSecureOrigin(): Promise<{ server: Server; origin: string }> {
  const created = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(PAGE_HTML);
  });
  return new Promise((resolve, reject) => {
    created.once('error', reject);
    created.listen(0, '127.0.0.1', () => {
      const address = created.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to determine loopback port'));
        return;
      }
      resolve({ server: created, origin: `http://127.0.0.1:${address.port}/` });
    });
  });
}

/** Run one Downscale dispatch + rgba16float readback entirely inside the page. */
async function runGpuCase(page: Page, request: GpuRequest): Promise<GpuResult> {
  return page.evaluate(async (req): Promise<GpuResult> => {
    const unavailable = (message: string): GpuFailure => ({
      ok: false,
      kind: 'unavailable',
      error: message,
    });
    const validation = (message: string): GpuFailure => ({
      ok: false,
      kind: 'validation',
      error: message,
    });

    if (typeof navigator === 'undefined' || !navigator.gpu) {
      return unavailable('navigator.gpu is not defined');
    }

    // Prefer the software fallback adapter, then fall back to any adapter.
    let adapter: GPUAdapter | null = null;
    try {
      adapter = await navigator.gpu.requestAdapter({ forceFallbackAdapter: true });
    } catch {
      // Fall through to the generic adapter request below.
    }
    if (!adapter) {
      try {
        adapter = await navigator.gpu.requestAdapter();
      } catch (error) {
        return unavailable(`requestAdapter() threw: ${String(error)}`);
      }
    }
    if (!adapter) {
      return unavailable('requestAdapter() returned null');
    }

    let device: GPUDevice;
    try {
      device = await adapter.requestDevice();
    } catch (error) {
      return unavailable(`requestDevice() threw: ${String(error)}`);
    }

    const adapterInfo = JSON.stringify({
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      device: adapter.info.device,
    });
    const software =
      adapter.info.isFallbackAdapter || /swiftshader|llvmpipe|software/i.test(adapterInfo);

    // Minimal IEEE-754 binary16 -> float32 decoder. `Float16Array` is not
    // universally available in the headless Chromium build, so decode by hand.
    const halfToFloat = (h: number): number => {
      const sign = (h & 0x8000) !== 0 ? -1 : 1;
      const exponent = (h >> 10) & 0x1f;
      const mantissa = h & 0x3ff;
      if (exponent === 0) {
        // Subnormal (or signed zero) half.
        return sign * Math.pow(2, -14) * (mantissa / 1024);
      }
      if (exponent === 0x1f) {
        return mantissa === 0 ? sign * Infinity : NaN;
      }
      return sign * Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
    };

    const { srcWidth, srcHeight, outWidth, outHeight } = req;
    const bytesPerRow = Math.ceil((outWidth * 8) / 256) * 256; // rgba16float = 8 B/px

    device.pushErrorScope('validation');
    let scopeOpen = true;
    let failure: GpuFailure | null = null;
    let output: number[] = [];

    try {
      const module = device.createShaderModule({ code: req.wgsl, label: 'downscale-under-test' });
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: 'computeMain' },
      });

      const inputTexture = device.createTexture({
        size: { width: srcWidth, height: srcHeight },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      const outputTexture = device.createTexture({
        size: { width: outWidth, height: outHeight },
        format: 'rgba16float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      const readback = device.createBuffer({
        size: bytesPerRow * outHeight,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });

      device.queue.writeTexture(
        { texture: inputTexture },
        new Uint8Array(req.pixels),
        { bytesPerRow: srcWidth * 4, rowsPerImage: srcHeight },
        { width: srcWidth, height: srcHeight },
      );

      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: inputTexture.createView() },
          { binding: 1, resource: outputTexture.createView() },
        ],
      });

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(outWidth / 8), Math.ceil(outHeight / 8));
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: outputTexture },
        { buffer: readback, bytesPerRow, rowsPerImage: outHeight },
        { width: outWidth, height: outHeight },
      );
      device.queue.submit([encoder.finish()]);

      const validationError = await device.popErrorScope();
      scopeOpen = false;
      if (validationError) {
        failure = validation(validationError.message);
      } else {
        await readback.mapAsync(GPUMapMode.READ);
        const view = new DataView(readback.getMappedRange());
        const decoded: number[] = [];
        for (let y = 0; y < outHeight; y++) {
          for (let x = 0; x < outWidth; x++) {
            const offset = y * bytesPerRow + x * 8;
            for (let channel = 0; channel < 4; channel++) {
              const value = halfToFloat(view.getUint16(offset + channel * 2, true));
              const clamped = Math.min(1, Math.max(0, value));
              decoded.push(Math.round(clamped * 255));
            }
          }
        }
        readback.unmap();
        output = decoded;
      }
    } catch (error) {
      failure = validation(String(error));
    } finally {
      if (scopeOpen) {
        try {
          await device.popErrorScope();
        } catch {
          // Ignore; the device/page may already be gone.
        }
      }
    }

    if (failure) return failure;
    return { ok: true, width: outWidth, height: outHeight, data: output, adapterInfo, software };
  }, request);
}

function guardGpu(): void {
  if (!preflight || preflight.ok) return;
  console.warn(
    `[gpu] environment cannot run downscale compute: ${preflight.error}`
    + (ALLOW_GPU_SKIP ? ' (ALLOW_GPU_SKIP=1 -> skipping)' : ''),
  );
  test.skip(ALLOW_GPU_SKIP, `environment cannot run downscale compute: ${preflight.error}`);
  throw new Error(`environment cannot run downscale compute (${preflight.kind}): ${preflight.error}`);
}

function writeArtifacts(
  caseName: string,
  expected: Uint8Array,
  actual: Uint8Array,
  manifest: Record<string, unknown>,
): string {
  const dir = path.resolve(
    __dirname,
    '..',
    '..',
    'test-results',
    'downscale-correctness',
    caseName,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'expected.rgba'), Buffer.from(expected));
  writeFileSync(path.join(dir, 'actual.rgba'), Buffer.from(actual));
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

test.beforeAll(async ({ browser }) => {
  // Fail loudly (before touching the GPU) if the shipped shader module is gone.
  const modulePath = resolveDownscaleWgslPath();
  const imported = (await import(pathToFileURL(modulePath).href)) as { default?: unknown };
  if (typeof imported.default !== 'string' || !imported.default.includes('fn computeMain')) {
    throw new Error(
      `downscale-correctness: ${modulePath} did not export the Downscale WGSL source string`,
    );
  }
  downscaleWgsl = imported.default;
  console.log(`[gpu] loaded Downscale WGSL from ${modulePath}`);

  const started = await startSecureOrigin();
  server = started.server;
  origin = started.origin;

  const page = await browser.newPage();
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    preflight = await runGpuCase(page, {
      wgsl: PREFLIGHT_WGSL,
      srcWidth: 2,
      srcHeight: 2,
      outWidth: 2,
      outHeight: 2,
      pixels: [32, 64, 96, 255, 128, 160, 192, 255, 200, 210, 220, 255, 45, 90, 135, 255],
    });
  } finally {
    await page.close();
  }

  if (preflight.ok) {
    console.log(
      `[gpu] preflight OK; adapter=${preflight.adapterInfo} software=${preflight.software}`,
    );
  } else {
    console.warn(`[gpu] preflight FAILED (${preflight.kind}): ${preflight.error}`);
  }
});

test.afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
  }
});

for (const gpuCase of DOWNSCALE_CASES) {
  test(gpuCase.name, async ({ page }) => {
    guardGpu();
    await page.goto(origin, { waitUntil: 'domcontentloaded' });

    const { image, outWidth, outHeight } = gpuCase;
    const result = await runGpuCase(page, {
      wgsl: downscaleWgsl,
      srcWidth: image.width,
      srcHeight: image.height,
      outWidth,
      outHeight,
      pixels: Array.from(image.data),
    });

    expect(
      result.ok,
      result.ok
        ? 'unexpected result shape'
        : `GPU case failed (${result.kind}): ${result.error}`,
    ).toBe(true);
    if (!result.ok) return;

    const actual = new Uint8Array(result.data);
    const isIdentity = image.width === outWidth && image.height === outHeight;

    const expected = referenceDownscale(image.data, image.width, image.height, outWidth, outHeight);
    const cmp = compareRgba(expected, actual);

    // Contrast guard: prove the GPU is running the fractional box in linear
    // light rather than the old naive bilinear tap. (1:1 has no difference to
    // detect and is skipped.)
    const bilinearCmp = isIdentity
      ? null
      : compareRgba(referenceBilinearDownscale(image.data, image.width, image.height, outWidth, outHeight), actual);

    const dimensionsOk =
      result.width === outWidth
      && result.height === outHeight
      && actual.length === expected.length;
    const metricsOk = cmp.maxAbs <= 2 && cmp.meanAbs <= 0.5 && cmp.psnr >= 40;
    const contrastOk = bilinearCmp === null || bilinearCmp.maxAbs >= 3;

    if (!dimensionsOk || !metricsOk || !contrastOk) {
      const adapter = preflight && preflight.ok ? preflight.adapterInfo : 'unknown';
      const dir = writeArtifacts(gpuCase.name, expected, actual, {
        case: gpuCase.name,
        srcWidth: image.width,
        srcHeight: image.height,
        outWidth,
        outHeight,
        ratioX: image.width / outWidth,
        ratioY: image.height / outHeight,
        adapter,
        software: result.software,
        comparison: cmp,
        bilinearContrast: bilinearCmp,
      });
      console.warn(`[gpu] ${gpuCase.name} artifacts written to ${dir}`);
    }

    const summary = formatComparison(gpuCase.name, cmp);
    expect(dimensionsOk, `${summary} (dimensions mismatch)`).toBe(true);
    expect(cmp.maxAbs, summary).toBeLessThanOrEqual(2);
    expect(cmp.meanAbs, summary).toBeLessThanOrEqual(0.5);
    expect(cmp.psnr, summary).toBeGreaterThanOrEqual(40);

    if (bilinearCmp) {
      expect(
        bilinearCmp.maxAbs,
        `${gpuCase.name}: box-vs-bilinear contrast too small (${bilinearCmp.maxAbs}); `
        + `GPU may be doing a bilinear tap instead of the fractional box`,
      ).toBeGreaterThanOrEqual(3);
    }

    const psnr = cmp.psnr === Infinity ? 'Infinity' : `${cmp.psnr.toFixed(2)}dB`;
    console.log(
      `[gpu] ${gpuCase.name} src=${image.width}x${image.height} -> ${outWidth}x${outHeight}`
      + ` maxAbs=${cmp.maxAbs} meanAbs=${cmp.meanAbs.toFixed(4)} psnr=${psnr}`
      + ` bilinearDelta=${bilinearCmp ? bilinearCmp.maxAbs : 'n/a'}`
      + ` mismatches=${cmp.mismatchCount}`,
    );
  });
}
