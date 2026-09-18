import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The api serves this build from `dist/` (ARCHITECTURE §3), so the bundle is
 * emitted there and the dev server proxies nothing yet: until M0-05 the admin
 * app talks to the in-memory `MockAuthApi` instead of a backend.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5273,
  },
  preview: {
    port: 4173,
  },
});
