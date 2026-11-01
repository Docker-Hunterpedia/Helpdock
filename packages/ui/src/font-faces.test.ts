import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BRAND_FONT_NAMES } from './brand.js';
import { FONT_FACES, fontFacesFor } from './font-faces.js';

const stylesheet = await readFile(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fonts/fonts.css'),
  'utf8',
);

describe('FONT_FACES', () => {
  it('lists every @font-face rule of fonts.css, in order, with the same range', () => {
    const rules = [...stylesheet.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body = '']) => ({
      family: /font-family:\s*'([^']+)'/.exec(body)?.[1],
      weight: Number(/font-weight:\s*(\d+)/.exec(body)?.[1]),
      file: /url\('\.\/([^']+)'\)/.exec(body)?.[1],
      unicodeRange: /unicode-range:\s*([^;]+)/.exec(body)?.[1]?.trim(),
    }));

    expect(FONT_FACES).toEqual(rules);
  });
});

describe('fontFacesFor', () => {
  const familiesOf = (font: (typeof BRAND_FONT_NAMES)[number]) =>
    new Set(fontFacesFor(font).map((face) => face.family));

  it("lists only the chosen pair's families", () => {
    expect(familiesOf('ibm-plex')).toEqual(
      new Set(['IBM Plex Sans', 'IBM Plex Sans Arabic', 'IBM Plex Mono']),
    );
    expect(familiesOf('noto-sans')).toEqual(
      new Set(['Noto Sans', 'Noto Sans Arabic', 'Noto Sans Mono']),
    );
  });

  it("keeps Vazirmatn's IBM Plex Mono companion", () => {
    expect(familiesOf('vazirmatn')).toEqual(new Set(['Vazirmatn', 'IBM Plex Mono']));
  });

  it('gives every pair at least one face and never repeats a file', () => {
    for (const font of BRAND_FONT_NAMES) {
      const files = fontFacesFor(font).map((face) => face.file);

      expect(files.length).toBeGreaterThan(0);
      expect(new Set(files).size).toBe(files.length);
    }
  });
});
