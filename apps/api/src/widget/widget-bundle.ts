import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveAssetPath } from '../static/admin-assets.js';

/**
 * The widget build the api serves to customers' sites (M4-01, ARCHITECTURE
 * §12): `widget.js`, the lazy `chunks/` Vite hashes, and the fonts under
 * `widget-fonts/`. Pure path and header rules, so they are proved without a
 * server; `widget-bundle.controller.ts` does the sending.
 */

export const WIDGET_ENTRY = 'widget.js';
export const WIDGET_CHUNKS_DIR = 'chunks';
export const WIDGET_FONTS_DIR = 'widget-fonts';

/** A file name inside one of those folders: no separators, no climbing out. */
export const widgetFileParamSchema = z.object({
  file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 'not a widget file name'),
});
export type WidgetFileParam = z.infer<typeof widgetFileParamSchema>;

/** The build directory, or `undefined` when there is no `widget.js` in it. */
export const resolveWidgetDist = (configured: string): string | undefined => {
  const directory = path.resolve(configured);
  return existsSync(path.join(directory, WIDGET_ENTRY)) ? directory : undefined;
};

/** The file a request names inside the build, or `undefined` when there is none. */
export const widgetAssetPath = (
  root: string,
  folder: typeof WIDGET_CHUNKS_DIR | typeof WIDGET_FONTS_DIR | null,
  file: string,
): string | undefined => resolveAssetPath(root, folder === null ? file : `${folder}/${file}`);

const ONE_YEAR_SECONDS = 31_536_000;
const ONE_WEEK_SECONDS = 604_800;
/** Short, because `widget.js` keeps its name across deploys and names the new chunks. */
const ENTRY_MAX_AGE_SECONDS = 300;

const TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/**
 * The headers every widget file answers with. Any site may load it —
 * whether that site may *talk* to the brand is the origin allow-list's call,
 * made on every `/api/widget` route (M4-03) — so the file itself is public:
 * `Access-Control-Allow-Origin: *`, which a module script and a font both
 * need, and `Cross-Origin-Resource-Policy: cross-origin` in place of the api's
 * `same-origin`.
 */
export const widgetFileHeaders = (relativePath: string): Record<string, string> => {
  const [first] = relativePath.split(path.sep);
  const cacheControl =
    first === WIDGET_CHUNKS_DIR
      ? `public, max-age=${ONE_YEAR_SECONDS}, immutable`
      : first === WIDGET_FONTS_DIR
        ? `public, max-age=${ONE_WEEK_SECONDS}`
        : `public, max-age=${ENTRY_MAX_AGE_SECONDS}`;

  return {
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
    'cache-control': cacheControl,
    'content-type': TYPES[path.extname(relativePath)] ?? 'application/octet-stream',
  };
};
