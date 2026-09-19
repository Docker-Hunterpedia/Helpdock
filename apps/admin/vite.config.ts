import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The api serves this build from `dist/` (ARCHITECTURE §3), so the bundle is
 * emitted there.
 *
 * In development the two halves run apart — Vite here, the api on 3000 — and
 * the proxy below is what makes them share an origin. Without it the app would
 * have to know an absolute api URL, and the `SameSite=Lax`, host-only refresh
 * cookie set on `localhost:3000` would not be sent from `localhost:5273`. With
 * `VITE_AUTH_API=mock`, which is the default in dev, nothing under `/api` is
 * proxied because nothing is called.
 */
const API_ORIGIN = process.env.VITE_API_ORIGIN ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5273,
    proxy: {
      '/api': { target: API_ORIGIN, changeOrigin: false },
      // The readiness probe sits beside `/api`, not under it (ARCHITECTURE
      // §14), and the first-run wizard's caption reads it (M0-08).
      '/ready': { target: API_ORIGIN, changeOrigin: false },
    },
  },
  preview: {
    port: 4173,
  },
});
