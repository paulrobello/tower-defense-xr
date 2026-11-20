/**
 * Self-hosted font configuration for every SDF text path.
 *
 * Troika typesets on the main thread (`useWorker: false`) because the production CSP forbids blob
 * workers, and every font comes from the same origin (`public/fonts/`, staged by
 * `scripts/prepare-assets.ts`) so no CDN fetch is ever attempted.
 */
import { configureLabelFonts, type LabelFonts } from '@par/xr-workspace';
import { configureTextBuilder } from 'troika-three-text';

export const MAIN_FONT_PATH = 'fonts/NotoSans-Regular.ttf';
export const SYMBOL_FONT_PATH = 'fonts/NotoSansSymbols2-Regular.ttf';

/** Joins the app base URL (`/` in production) with a font path. */
export function fontUrl(path: string, base = '/'): string {
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return `${prefix}${path.replace(/^\/+/, '')}`;
}

export function resolveFontUrls(base = '/'): LabelFonts {
  return { main: fontUrl(MAIN_FONT_PATH, base), symbols: fontUrl(SYMBOL_FONT_PATH, base) };
}

let configured: LabelFonts | null = null;

/**
 * Points troika and `@par/xr-workspace` labels at the local fonts. Idempotent per base URL; call
 * once at boot before creating any label or `Text`.
 */
export function configureFonts(base: string = import.meta.env?.BASE_URL ?? '/'): LabelFonts {
  const fonts = resolveFontUrls(base);
  if (configured && configured.main === fonts.main && configured.symbols === fonts.symbols) {
    return configured;
  }
  configureTextBuilder({ defaultFontURL: fonts.main, useWorker: false });
  configureLabelFonts(fonts);
  configured = fonts;
  return fonts;
}

/** The fonts last applied by `configureFonts`, or `null` before boot. */
export function configuredFonts(): LabelFonts | null {
  return configured;
}
