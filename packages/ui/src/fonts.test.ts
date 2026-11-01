import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FONT_BUDGET_BYTES } from '../scripts/sync-fonts.ts';
import { BRAND_FONTS } from './brand.js';

const fontsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fonts');
const stylesheet = await readFile(path.join(fontsDir, 'fonts.css'), 'utf8');
const files = await readdir(fontsDir);

const faces = [...stylesheet.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body = '']) => ({
  family: /font-family:\s*["']([^"']+)["']/.exec(body)?.[1],
  weight: Number(/font-weight:\s*(\d+)/.exec(body)?.[1]),
  display: /font-display:\s*([\w-]+)/.exec(body)?.[1],
  file: /url\(["']\.\/([^"']+)["']\)/.exec(body)?.[1],
  unicodeRange: /unicode-range:\s*([^;]+)/.exec(body)?.[1],
}));

describe('fonts.css', () => {
  it('declares the families of every curated brand pair', () => {
    expect(new Set(faces.map((face) => face.family))).toEqual(
      new Set([
        'IBM Plex Sans',
        'IBM Plex Sans Arabic',
        'IBM Plex Mono',
        'Noto Sans',
        'Noto Sans Arabic',
        'Noto Sans Mono',
        'Vazirmatn',
      ]),
    );
  });

  it('loads only the three weights, and only two for the mono faces', () => {
    const weightsOf = (family: string) =>
      new Set(faces.filter((face) => face.family === family).map((face) => face.weight));

    for (const family of [
      'IBM Plex Sans',
      'IBM Plex Sans Arabic',
      'Noto Sans',
      'Noto Sans Arabic',
      'Vazirmatn',
    ]) {
      expect(weightsOf(family)).toEqual(new Set([400, 500, 600]));
    }
    expect(weightsOf('IBM Plex Mono')).toEqual(new Set([400, 500]));
    expect(weightsOf('Noto Sans Mono')).toEqual(new Set([400, 500]));
  });

  it('ships an Arabic-script subset for each Arabic companion', () => {
    for (const family of ['IBM Plex Sans Arabic', 'Noto Sans Arabic', 'Vazirmatn']) {
      expect(faces.some((face) => face.family === family && face.file?.includes('-arabic-'))).toBe(
        true,
      );
    }
  });

  it('never loads bold, which DESIGN §3.2 rules out', () => {
    expect(faces.map((face) => face.weight)).not.toContain(700);
  });

  it('swaps rather than blocking, and subsets by unicode range', () => {
    for (const face of faces) {
      expect(face.display).toBe('swap');
      expect(face.unicodeRange).toMatch(/^U\+/);
    }
  });

  it('points every rule at a committed woff2', () => {
    for (const face of faces) {
      expect(face.file).toBeDefined();
      expect(files).toContain(face.file);
    }
  });

  it('ships nothing the stylesheet does not reference', () => {
    const referenced = new Set(faces.map((face) => face.file));

    expect(files.filter((file) => file !== 'fonts.css' && !referenced.has(file))).toEqual([]);
  });

  it('ships every family a curated brand font names first', () => {
    const shipped = new Set(faces.map((face) => face.family));

    for (const pair of Object.values(BRAND_FONTS)) {
      for (const stack of [pair.sans, pair.arabic, pair.mono]) {
        const first = /^'([^']+)'/.exec(stack)?.[1];
        expect(shipped).toContain(first);
      }
    }
  });

  it('stays inside the size budget', async () => {
    let bytes = 0;
    for (const file of files) {
      bytes += (await stat(path.join(fontsDir, file))).size;
    }

    expect(bytes).toBeLessThanOrEqual(FONT_BUDGET_BYTES);
  });
});
