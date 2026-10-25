import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';
import { SITE_URL } from './src/data/site.ts';
import { releaseVersion } from './src/lib/repo.ts';

// Resolved here, once, so a wrong HELPDOCK_VERSION stops the build before any page renders.
const version = releaseVersion(new URL('./', import.meta.url));

export default defineConfig({
  site: SITE_URL,
  trailingSlash: 'always',
  build: { format: 'directory', inlineStylesheets: 'auto' },
  // Nothing on the site loads from a third party, and the dev toolbar would.
  devToolbar: { enabled: false },
  vite: {
    define: { 'import.meta.env.HELPDOCK_VERSION': JSON.stringify(version) },
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
      filter: (page) => !page.endsWith('/404/'),
      i18n: { defaultLocale: 'en', locales: { en: 'en', ar: 'ar' } },
    }),
  ],
});
