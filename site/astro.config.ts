import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';
import { SITE_URL } from './src/data/site.ts';
import { releaseVersion } from './src/lib/repo.ts';
import { parseStars } from './src/lib/stars.ts';

// Resolved here, once, so a wrong HELPDOCK_VERSION stops the build before any page renders.
const version = releaseVersion(new URL('./', import.meta.url));
// A build-time snapshot; without one the site shows its GitHub links without a count.
const stars = parseStars(process.env.HELPDOCK_STARS);

export default defineConfig({
  site: SITE_URL,
  // Every link and canonical URL is written with its slash; 'ignore' lets an
  // address typed without one still reach the page or the site's own 404.
  trailingSlash: 'ignore',
  build: { format: 'directory', inlineStylesheets: 'auto' },
  // Nothing on the site loads from a third party, and the dev toolbar would.
  devToolbar: { enabled: false },
  vite: {
    define: {
      'import.meta.env.HELPDOCK_VERSION': JSON.stringify(version),
      'import.meta.env.HELPDOCK_STARS': JSON.stringify(stars ?? null),
    },
  },
  markdown: {
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark-default' },
      defaultColor: false,
      // install.md shows Caddyfiles, a language Shiki does not ship.
      langAlias: { caddyfile: 'txt' },
    },
  },
  integrations: [
    sitemap({
      filter: (page) => !/\/404\/?$/.test(page),
      i18n: { defaultLocale: 'en', locales: { en: 'en', ar: 'ar' } },
    }),
  ],
});
