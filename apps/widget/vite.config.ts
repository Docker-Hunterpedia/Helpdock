import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const FONTS_DIR = fileURLToPath(new URL('../../packages/ui/fonts/', import.meta.url));

/**
 * The design system's self-hosted fonts, copied to `dist/widget-fonts/`. The
 * api serves them from its own origin, and the config lists them with their
 * URLs (`apps/api/src/widget/widget-theme.ts`), so the widget registers them
 * through the FontFace API: a shadow root cannot hold `@font-face` (DESIGN §8).
 */
const widgetFonts = (): Plugin => ({
  name: 'helpdock-widget-fonts',
  apply: 'build',
  async generateBundle() {
    for (const file of await readdir(FONTS_DIR)) {
      if (file.endsWith('.woff2')) {
        this.emitFile({
          type: 'asset',
          fileName: `widget-fonts/${file}`,
          source: await readFile(`${FONTS_DIR}${file}`),
        });
      }
    }
  },
});

/**
 * `widget.js` (ARCHITECTURE §12): library mode, ES2022, one entry, lazy chunks
 * under `chunks/` (D §14). ES output rather than IIFE because an IIFE cannot
 * split, and the lazy chunks are what keep the entry under 40 KB; the embed
 * tag is therefore `<script type="module">`. The api serves `dist/`
 * (`WIDGET_DIST_DIR`).
 */
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  plugins: [widgetFonts()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    // Everything, CSS included, arrives as JavaScript: the stylesheet is
    // adopted by the shadow root, never linked from the host page.
    cssCodeSplit: false,
    lib: {
      entry: 'src/main.ts',
      formats: ['es'],
      fileName: () => 'widget.js',
    },
    rollupOptions: {
      // Lets shared modules fold into widget.js instead of a common chunk
      // the entry would have to fetch before first paint.
      preserveEntrySignatures: 'allow-extension',
      output: {
        chunkFileNames: 'chunks/[name]-[hash].js',
        // Library mode keeps whitespace for downstream bundlers; widget.js is
        // the shipped artefact, so it is minified in full.
        minify: true,
      },
    },
  },
});
