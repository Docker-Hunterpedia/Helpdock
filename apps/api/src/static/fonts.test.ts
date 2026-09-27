import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fontFileParamSchema, fontsDirectory, loadFonts } from './fonts.js';

describe('the self-hosted fonts', () => {
  it('finds the woff2 files and their stylesheet in @helpdock/ui', () => {
    const fonts = loadFonts(fontsDirectory());

    expect(fonts.get('fonts.css')?.contentType).toBe('text/css; charset=utf-8');
    expect(fonts.get('ibm-plex-sans-arabic-arabic-400-normal.woff2')?.contentType).toBe(
      'font/woff2',
    );
  });

  it.each(['../secret.css', 'fonts.css/..', 'a.woff', 'Fonts.CSS', 'x.woff2?y'])(
    'refuses the name %s',
    (file) => {
      expect(fontFileParamSchema.safeParse({ file }).success).toBe(false);
    },
  );

  describe('a directory with other files in it', () => {
    let dir: string;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'fonts-'));
      await writeFile(path.join(dir, 'a.woff2'), 'woff');
      await writeFile(path.join(dir, 'README.md'), 'not a font');
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('serves only what the schema would let a request name', () => {
      expect([...loadFonts(dir).keys()]).toEqual(['a.woff2']);
    });
  });
});
