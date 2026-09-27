import { defineConfig } from 'vite';

/**
 * `widget.js` (ARCHITECTURE §12): library mode, ES2022, one entry, lazy chunks
 * under `chunks/` (D §14). ES output rather than IIFE because an IIFE cannot
 * split, and the lazy chunks are what keep the entry under 40 KB; the embed
 * tag is therefore `<script type="module">`. The api serves `dist/`.
 */
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
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
