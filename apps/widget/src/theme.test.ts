import { describe, expect, it, vi } from 'vitest';
import { cssName, registerFonts, resolveScheme, themeCss } from './theme.js';
import { sampleConfig } from './transport/fixtures.js';
import type { WidgetTheme } from './transport/types.js';

const theme = sampleConfig('en').theme;

describe('themeCss', () => {
  it('names tokens the way packages/ui does', () => {
    expect(cssName('bg.canvas')).toBe('--hd-bg-canvas');
    expect(cssName('action.primary.text')).toBe('--hd-action-primary-text');
  });

  it('paints the scheme it is asked for, with the brand radius and the script’s font', () => {
    const light = themeCss(theme, 'light', false);
    const dark = themeCss(theme, 'dark', true);

    expect(light).toContain('--hd-action-primary:#0F766E;');
    expect(light).toContain('--hd-radius-md:6px;');
    expect(light).toContain("--hd-font-sans:'IBM Plex Sans',");
    expect(dark).toContain('--hd-action-primary:#5FB8AC;');
    expect(dark).toContain("--hd-font-sans:'IBM Plex Sans Arabic'");
    expect(dark).toContain('color-scheme:dark;');
  });

  it('drops a value that could break out of the declaration', () => {
    const hostile: WidgetTheme = {
      ...theme,
      tokens: { ...theme.tokens, light: { 'bg.canvas': 'red;}body{display:none' } },
    };

    expect(themeCss(hostile, 'light', false)).not.toContain('display:none');
  });
});

describe('resolveScheme', () => {
  it('follows the OS only in auto', () => {
    expect(resolveScheme('auto', true)).toBe('dark');
    expect(resolveScheme('auto', false)).toBe('light');
    expect(resolveScheme('light', true)).toBe('light');
    expect(resolveScheme('dark', false)).toBe('dark');
  });
});

describe('registerFonts', () => {
  it('adds each brand font file to the document, since a shadow root cannot declare one', () => {
    const load = vi.fn(() => Promise.resolve());
    const FontFaceStub = vi.fn(function (this: Record<string, unknown>, family: string) {
      this.family = family;
      this.load = load;
    });
    vi.stubGlobal('FontFace', FontFaceStub);
    const add = vi.fn();

    registerFonts(
      {
        ...theme,
        fonts: [
          { family: 'IBM Plex Sans', weight: 400, url: 'https://support.example.com/f.woff2' },
        ],
      },
      { add } as unknown as FontFaceSet,
    );

    expect(FontFaceStub).toHaveBeenCalledWith(
      'IBM Plex Sans',
      'url("https://support.example.com/f.woff2") format(\'woff2\')',
      { weight: '400', display: 'swap' },
    );
    expect(add).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
