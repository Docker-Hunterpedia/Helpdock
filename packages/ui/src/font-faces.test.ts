import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FONT_FACES } from './font-faces.js';

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
