import { beforeEach, describe, expect, it, vi } from 'vitest';

const configureTextBuilder = vi.fn();
const configureLabelFonts = vi.fn();
vi.mock('troika-three-text', () => ({ configureTextBuilder }));
vi.mock('@par/xr-workspace', () => ({ configureLabelFonts }));

describe('font configuration', () => {
  beforeEach(() => {
    vi.resetModules();
    configureTextBuilder.mockClear();
    configureLabelFonts.mockClear();
  });

  it('points troika (main thread, no worker) and workspace labels at local fonts', async () => {
    const { configureFonts, configuredFonts } = await import('../src/ui/fonts.ts');
    expect(configuredFonts()).toBeNull();
    const fonts = configureFonts('/');
    expect(fonts).toEqual({
      main: '/fonts/NotoSans-Regular.ttf',
      symbols: '/fonts/NotoSansSymbols2-Regular.ttf',
    });
    expect(configureTextBuilder).toHaveBeenCalledWith({
      defaultFontURL: '/fonts/NotoSans-Regular.ttf',
      useWorker: false,
    });
    expect(configureLabelFonts).toHaveBeenCalledWith(fonts);
    expect(configuredFonts()).toEqual(fonts);
  });

  it('is idempotent for the same base and honours a sub-path base', async () => {
    const { configureFonts, fontUrl } = await import('../src/ui/fonts.ts');
    configureFonts('/');
    configureFonts('/');
    expect(configureTextBuilder).toHaveBeenCalledTimes(1);
    expect(configureFonts('/game').main).toBe('/game/fonts/NotoSans-Regular.ttf');
    expect(configureTextBuilder).toHaveBeenCalledTimes(2);
    expect(fontUrl('/fonts/a.ttf', '/x/')).toBe('/x/fonts/a.ttf');
  });

  it('never references a remote font origin', async () => {
    const { resolveFontUrls } = await import('../src/ui/fonts.ts');
    for (const url of Object.values(resolveFontUrls())) expect(url).toMatch(/^\/fonts\//);
  });
});
