# 0058 Astro for the product website, still on GitHub Pages

Status: proposed
Date: 2026-10-25

## Context

The product website at <https://helpdock.oday-bakkour.com> was two
hand-written HTML pages, English and Arabic, with one stylesheet and a script
that rewrote the release number into the files at deploy time
(`scripts/site/stamp-release.mjs`). Issue #418 asks for much more: a page per
channel, per feature and per comparison, the guides from `docs/guides/`
published under `/docs`, the changelog with an RSS feed, a light, dark and
system theme switch, and per-page SEO (canonical, `hreflang`, JSON-LD, a
sitemap). That is close to a hundred pages, about a third of them in Arabic.

By hand, every page would repeat the header, footer, head tags and structured
data; the guides would be copied, and drift from the repository; and the
sitemap and alternate links would be kept in step by hand. The stamp script
already showed the cost of editing generated text in place: it had to match
versions with care and could not tell a historical "1.0" from the current one.

The site must keep its promises: no tracking, no request to a third party,
fonts and icons served locally, and a build that fails rather than publish a
wrong release number.

## Decision

1. The website is an **Astro** project with **static output**, in `site/`, a
   private workspace package `@helpdock/website` that Changesets ignores.
2. Its only dependencies are `astro`, `@astrojs/sitemap` and `@astrojs/rss`. No
   UI framework, no CSS framework and no client-side framework: plain CSS with
   DESIGN.md's tokens as custom properties, and two small inline scripts (the
   theme, applied before first paint, and its switch) plus one bundled script
   (copy buttons and the scroll reveal).
3. Pages are generated from typed data (`site/src/data/`): competitors, checked
   by a Zod schema that refuses an importer for any source but Zendesk,
   Freshdesk and Zoho Desk; channels; features; the home page copy.
4. The guides are a **content collection whose loader reads `docs/guides/`
   from the repository**, not copies. Links to another guide become `/docs/…`;
   any other repository path becomes its page on GitHub.
5. The release number is resolved at build time: `HELPDOCK_VERSION`, which the
   Pages workflow sets from the latest published non-prerelease Release, or
   the `@helpdock/api` version for a local build. A value that is not a plain
   `x.y.z` fails the build. The stamp script is removed.
6. **Hosting stays on GitHub Pages**, at the same domain (`site/public/CNAME`),
   deployed by `.github/workflows/pages.yml`, which now installs with pnpm,
   tests the site's helpers, builds it, smoke-tests the built pages and uploads
   `site/dist`. Astro's telemetry is turned off in every script.

## Consequences

- One layout gives every page the same head: title, description, canonical,
  `hreflang` only where a counterpart exists, Open Graph and JSON-LD. The
  sitemap and its alternates are generated.
- The docs on the site are always the docs on `main`, and a guide change
  redeploys the site.
- The release number appears wherever a page needs it, from one variable, so
  release prose and historical versions no longer collide.
- The site now has a build and a dependency tree to keep up, and the release
  image build must leave it out (`turbo run build --filter='!@helpdock/website'`
  in the Dockerfile), since the docs it renders are not in the image's context.
- Biome cannot see template usage in `.astro` files, so its unused-import and
  unused-variable rules are off for them.
- When this is accepted, ARCHITECTURE §1 and §2 gain Astro and `site/`; the
  website imports nothing from `apps/*` or `packages/*`, and they import
  nothing from it.

## Alternatives considered

- **Hand-written HTML, as before:** no dependency, but every one of the new
  pages would duplicate the chrome and the head, and the guides would be copied.
- **Eleventy or Hugo:** both generate static sites well. Astro's typed content
  collections and component templates fit a TypeScript repository without a
  second templating language or a Go binary.
- **Starlight (Astro's docs theme):** a full docs UI, but it brings its own
  design and dependencies; the docs here follow DESIGN.md instead.
- **Another host (Cloudflare Pages, Netlify, Vercel):** none is needed for a
  static site, and GitHub Pages keeps the deploy inside the repository's own
  permissions, with no third party.
