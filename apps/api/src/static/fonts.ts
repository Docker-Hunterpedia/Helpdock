import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';

/**
 * The self-hosted type of DESIGN §3 — IBM Plex Sans, Sans Arabic and Mono as
 * subset woff2, and the `@font-face` sheet that names them — for the pages the
 * api renders itself: the hosted web form now (M4-09), the help center when
 * M5 renders it. "Fonts are self-hosted … never from a third party."
 *
 * Read once into memory at boot: the directory is a few hundred kilobytes and
 * never changes while the process runs, and a request then names a file by a
 * key in a map rather than by a path on disk.
 */

export const FONTS_PREFIX = '/_hd/fonts';

export const fontFileParamSchema = z.object({
  file: z.string().regex(/^[a-z0-9-]+\.(woff2|css)$/),
});
export type FontFileParam = z.infer<typeof fontFileParamSchema>;

export interface FontFile {
  readonly body: Buffer;
  readonly contentType: string;
}

/** `packages/ui/fonts`, found through the package's own export map. */
export const fontsDirectory = (): string =>
  path.dirname(createRequire(import.meta.url).resolve('@helpdock/ui/fonts.css'));

export const loadFonts = (directory: string = fontsDirectory()): ReadonlyMap<string, FontFile> => {
  const files = new Map<string, FontFile>();
  for (const name of readdirSync(directory)) {
    if (fontFileParamSchema.safeParse({ file: name }).success) {
      files.set(name, {
        body: readFileSync(path.join(directory, name)),
        contentType: name.endsWith('.css') ? 'text/css; charset=utf-8' : 'font/woff2',
      });
    }
  }
  return files;
};

/** A week: the names carry no hash, so a new subset has to reach browsers in days, not a year. */
export const FONT_CACHE_CONTROL = 'public, max-age=604800';
