/**
 * Shared Playwright Chromium GPU configuration and runtime guard.
 *
 * Every browser harness in this repository imports from this module so no script silently drifts
 * back to SwiftShader or bare Chromium defaults. On macOS, Chromium launches on native Metal GPU;
 * software WebGL (`PW_GPU=swiftshader`) is strictly opt-in for GPU-less hosts.
 */
import type { LaunchOptions, Page } from 'playwright';

export const SWIFTSHADER = process.env.PW_GPU === 'swiftshader';

export const GPU_ARGS: readonly string[] = SWIFTSHADER
  ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  : process.platform === 'darwin'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--enable-gpu', '--ignore-gpu-blocklist'];

export interface GpuLaunchOverrides {
  headless?: boolean;
  extraArgs?: readonly string[];
}

export interface GpuInfo {
  renderer: string | null;
  vendor: string | null;
  adapter: string | null;
  webgl2: boolean;
}

export function getGpuLaunchOptions(overrides: GpuLaunchOverrides = {}): LaunchOptions {
  return {
    channel: 'chromium',
    headless: overrides.headless ?? true,
    args: [...GPU_ARGS, ...(overrides.extraArgs ?? [])],
  };
}

/** Reads `UNMASKED_RENDERER_WEBGL` (plus vendor and WebGPU adapter when available) from a page. */
export async function probeGpu(page: Page): Promise<GpuInfo> {
  return page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    const gl2 = canvas.getContext('webgl2');
    const gl = gl2 ?? canvas.getContext('webgl');
    let renderer: string | null = null;
    let vendor: string | null = null;
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = ext
        ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
        : String(gl.getParameter(gl.RENDERER));
      vendor = ext
        ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL))
        : String(gl.getParameter(gl.VENDOR));
    }

    let adapter: string | null = null;
    try {
      const nav = navigator as Navigator & {
        gpu?: {
          requestAdapter(): Promise<{
            info?: { vendor?: string; architecture?: string; description?: string };
          } | null>;
        };
      };
      const gpuAdapter = nav.gpu ? await nav.gpu.requestAdapter() : null;
      if (gpuAdapter?.info) {
        const parts = [
          gpuAdapter.info.vendor,
          gpuAdapter.info.architecture,
          gpuAdapter.info.description,
        ].filter((part): part is string => typeof part === 'string' && part.length > 0);
        adapter = parts.length > 0 ? parts.join(' ') : null;
      }
    } catch {
      adapter = null;
    }

    return { renderer, vendor, adapter, webgl2: gl2 !== null };
  });
}

const SOFTWARE_RENDERER_PATTERN = /swiftshader|llvmpipe|software/i;

/** Returns blocking GPU problems for a probe result; empty array means acceptable. */
export function gpuProblems(info: GpuInfo, allowSwiftShader: boolean = SWIFTSHADER): string[] {
  const problems: string[] = [];
  if (!info.renderer) {
    problems.push('UNMASKED_RENDERER_WEBGL unavailable (no WebGL context)');
  }
  if (!info.webgl2) {
    problems.push('WebGL2 context unavailable');
  }
  if (
    !allowSwiftShader &&
    SOFTWARE_RENDERER_PATTERN.test(`${info.renderer ?? ''} ${info.adapter ?? ''}`)
  ) {
    problems.push(
      `Software/SwiftShader renderer detected without PW_GPU=swiftshader (UNMASKED_RENDERER_WEBGL=${info.renderer ?? 'null'}, adapter=${info.adapter ?? 'null'})`,
    );
  }
  return problems;
}

/** Throws loudly if a GPU run fell back to SwiftShader or failed to acquire WebGL2. */
export function assertRealGpu(info: GpuInfo, allowSwiftShader: boolean = SWIFTSHADER): GpuInfo {
  const problems = gpuProblems(info, allowSwiftShader);
  if (problems.length > 0) {
    throw new Error(
      `GPU guard failed: ${problems.join('; ')}. Set PW_GPU=swiftshader only when running on a GPU-less host.`,
    );
  }
  return info;
}
