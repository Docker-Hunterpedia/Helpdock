# Website

The product website at <https://helpdock.oday-bakkour.com>: how it is built,
what it may say, how to add a page, and how it is deployed to GitHub Pages.
This guide is for whoever maintains the site, so the site does not publish it.

## What it is

A static [Astro](https://astro.build) site in [`site/`](../../site/), the
private workspace package `@helpdock/website`
([ADR 0058](../decisions/0058-astro-for-the-product-website.md)). Its only
dependencies are `astro`, `@astrojs/sitemap` and `@astrojs/rss` (Playwright and
axe are its test tools); there is no UI framework and no CSS framework. Nothing
on it calls a third party: fonts, icons and images are served from the site
itself, and there is no analytics or tracking. The `dev`, `build` and `preview`
scripts also turn off Astro's own telemetry (`ASTRO_TELEMETRY_DISABLED=1`).

| Path | What it is |
|---|---|
| `site/astro.config.ts` | Site URL, trailing slashes, the release number, the sitemap and the code-highlighting themes |
| `site/src/pages/` | One file per route; `[slug].astro` files generate a page per item of a data file |
| `site/src/data/` | The words: `home.ts`, `competitors.ts`, `channels.ts`, `features.ts`, `migration.ts`, `docs.ts` (the docs sidebar) and `site.ts` (header, footer, links) |
| `site/src/content.config.ts` | Two collections: the guides, read from `docs/guides/`, and the releases, read from the changelogs |
| `site/src/lib/` | Pure helpers with their tests: the release number, the link rewriter, the changelog parser, guide titles and summaries, the competitor schema, JSON-LD |
| `site/src/layouts/Base.astro` | The one page shell: the head tags, the header, the footer |
| `site/src/components/` | Shared parts and the page templates shared by English and Arabic |
| `site/src/styles/site.css` | Every style, light and dark |
| `site/src/scripts/site.ts` | Copy buttons and the scroll reveal; every page works without it |
| `site/public/` | Copied as is: `CNAME`, `robots.txt`, the favicon, the icon sprite, the fonts and the images |
| `site/e2e/` | Playwright smoke tests of the built site |

## Pages

| Route | Built from |
|---|---|
| `/`, `/ar/` | `data/home.ts` through `components/HomePage.astro` |
| `/compare/helpdock-vs-<x>/`, `/ar/compare/…` | `data/competitors.ts`; Arabic only for a competitor with an `ar` copy |
| `/alternatives/<x>/` | The `alternative` part of a competitor, only for the three with an importer, and `data/migration.ts` |
| `/channels/<x>/`, `/ar/channels/<x>/` | `data/channels.ts`, English and Arabic |
| `/features/<x>/` | `data/features.ts`, English only |
| `/docs/<guide>/` | `docs/guides/<guide>.md`, English only |
| `/changelog/`, `/changelog/rss.xml` | `CHANGELOG.md`, `apps/api/CHANGELOG.md` and the release tags |
| `/compare/`, `/channels/`, `/features/`, `/docs/` | Index pages over the same data |
| `/404.html` | `pages/404.astro`, which GitHub Pages serves for an unknown path |

Every page gets a title and a description of its own, a canonical URL, Open
Graph and Twitter tags, and `lang` and `dir`. A page with a counterpart in the
other language also gets `hreflang` links for `en`, `ar` and `x-default`; a page
without one gets none. JSON-LD: `SoftwareApplication` on the home pages,
`FAQPage` where the page shows a FAQ, `BreadcrumbList` on inner pages and
`TechArticle` on the docs. `@astrojs/sitemap` writes `sitemap-index.xml` with the
same language alternates, and `robots.txt` points at it.

## What it may say

Every statement on the site must be backed by the repository: the README, the
changelogs, the guides, the [PRD](../planning/PRD.md) for the roadmap, and the
recorded AI evaluation. No invented customers, figures, testimonials or logos.
The roadmap on the home page separates what shipped in a release from what the
PRD only proposes; update it with the PRD.

About another product the site states two things only: how it is delivered
(hosted, self-hosted, or both) and its licence. Each fact carries its source
link and the date it was checked (`checked` in `competitors.ts`), and the page
prints both. No prices, and no feature-by-feature claims. Everything else on a
comparison page is about Helpdock, and each page needs content that is true of
that competitor only (its migration path, its licence's consequences); a
competitor with too little for that gets no page. Intercom, Help Scout and Front
are left out for that reason: hosted and proprietary, with no importer yet.

Only Zendesk, Freshdesk and Zoho Desk have an importer. The schema in
`lib/competitor-schema.ts` refuses `importer: true` for any other source, and
requires the Arabic page and the migration guide for those three.

Arabic copy is Modern Standard Arabic, with the terms of
`packages/i18n/locales/ar/` (تذكرة، مركز المساعدة، العلامة التجارية،
اتفاقية مستوى الخدمة، نافذة الدردشة…). Links from an Arabic page to an English
page say so: «(بالإنجليزية)».

## Develop and preview

```bash
pnpm install
pnpm --filter @helpdock/website dev        # http://localhost:4321, rebuilds on change
pnpm --filter @helpdock/website build      # writes site/dist
pnpm --filter @helpdock/website preview    # serves site/dist on http://localhost:4321
```

`astro preview` detaches into the background when it is not started from a
terminal; stop it with `pnpm --filter @helpdock/website exec astro preview stop`.
Any static server works on `site/dist` too, for example
`python3 -m http.server 4321 --directory site/dist`.

`pnpm build` at the root builds the site with every other workspace. The image
build leaves it out (`docker/Dockerfile`), because the docs it renders are not
in the image's build context.

## Adding a page

- **A competitor:** add an entry to `site/src/data/competitors.ts` with its
  delivery and licence, a source for each and the date checked, then the
  English copy. The comparison page, its card on `/compare/` and the links
  from the other comparisons follow. `pnpm --filter @helpdock/website test`
  checks the entry against the schema.
- **A channel:** add an entry to `site/src/data/channels.ts`, in English and
  Arabic, with its Lucide icon name and the guides it is from. A new icon goes
  into `site/public/assets/icons.svg` as a `<symbol>` copied from Lucide.
- **A feature:** add an entry to `site/src/data/features.ts`. Only a feature
  that ships in a release, and "Not yet" lists only what its guides say is
  missing.
- **A guide:** add the Markdown file to `docs/guides/`; it appears under
  `/docs/` without a change here. Place it in a sidebar group in
  `site/src/data/docs.ts` (otherwise it lands under "More guides"), and give it
  a description there if its first paragraph is not a good one. A guide that is
  not for Helpdock's users goes in `UNPUBLISHED`, as this one does.

In a guide, a link to another published guide becomes `/docs/<guide>/`; any
other repository path becomes its page on GitHub. The guide's `# Title` becomes
the page's only `h1`.

## The changelog

`/changelog/` lists every release up to the one the site shows, newest first.
A release's section of `CHANGELOG.md` is used when it has one; otherwise its
section of `apps/api/CHANGELOG.md`, the list Changesets writes; a release tag
with neither gets an entry pointing at its GitHub Release. Dates come from the
`CHANGELOG.md` heading or the tag (the Pages workflow fetches tags). The RSS
feed at `/changelog/rss.xml` carries the same entries.

## The release number

Nobody edits the version by hand. The site reads it once, at build time
(`src/lib/version.ts`):

- The Pages workflow asks GitHub for the latest published, non-prerelease
  Release and passes its number as `HELPDOCK_VERSION`. If the lookup fails, the
  step fails and nothing is published.
- A value that is set but is not a plain `x.y.z`, an empty one included, fails
  the build rather than publish a wrong number.
- A local build without `HELPDOCK_VERSION` uses the `@helpdock/api` package
  version.

The number appears wherever a page needs it (the release pill, the install
commands, the image name, the JSON-LD) from that one value, and the changelog
leaves out any release newer than it, so a version bump merged before its
Release is created shows nothing early. `release.yml` dispatches the Pages
workflow after it creates a stable Release (a Release made with `GITHUB_TOKEN`
does not fire `release` events). If that dispatch fails, the release run stays
green with a warning; run **Actions › Pages › Run workflow** by hand. GitHub's
latest Release is the most recently created one, so a backport patch to an
older line published after a newer release makes the site show the older
number until Pages runs again after the newer one.

## Design

The colours, families, spacing, radii, elevation and motion are the tokens of
[DESIGN.md](../../DESIGN.md), as CSS custom properties. The website adds the
display sizes, the 96 and 128 px section spacings and the reveal listed in
DESIGN.md §11; the product screens keep DESIGN.md's scales. Layout uses logical
CSS properties only, so an Arabic page is its English one mirrored.

The header carries a light, dark and system switch: three buttons with
`aria-pressed` in a labelled group. A choice is stored in `localStorage`
(`helpdock-theme`), inside `try`, and an inline script in the `<head>` applies
it before the first paint, so the wrong theme never flashes. With no stored
choice, or with storage blocked, the page follows `prefers-color-scheme`.
Without script the switch is hidden and the page follows the system.

Blocks marked `.reveal` rise into place the first time they scroll into view.
Only blocks that start below the fold are held back, and nothing moves under
`prefers-reduced-motion: reduce`.

## Images

| File in `site/public/assets/img/` | Source |
|---|---|
| `ticket-view-en.webp`, `ticket-view-ar.webp` | The admin's Playwright baselines, `apps/admin/e2e/__screenshots__/{en,ar}/ticket-view.png` |
| `sign-in-en.webp`, `sign-in-ar.webp` | The same baselines' `sign-in.png`, cropped to the form |
| `widget-en.webp`, `widget-ar.webp`, `help-center-article.webp` | Renders of the design artboards in `docs/design/screens/applications/`; the pages say so |
| `release-1-0.webp` | The poster of the 1.0 release video, which links to the video on X |
| `og.png` | The 1280 × 640 social preview, used by every page |

Convert a PNG with `cwebp -q 88 -m 6 in.png -o out.webp`, and give every
`<img>` its `width` and `height`; images below the fold load lazily.

## Tests

```bash
pnpm --filter @helpdock/website test    # Vitest: version, links, changelog, guides, competitor schema
pnpm --filter @helpdock/website build
pnpm --filter @helpdock/website e2e     # Playwright on site/dist
```

The Playwright suite checks the theme switch (a stored choice survives a
reload, System clears it, blocked storage breaks nothing), that the Arabic home
is right to left with its `hreflang`, that no page loads anything from another
origin, and axe on both home pages in both themes. It serves `site/dist` with
Python's static server, so build first.

## Deployment

[`.github/workflows/pages.yml`](../../.github/workflows/pages.yml) installs the
workspace with pnpm, runs the site's unit tests, looks up the release number,
builds the site, runs the smoke tests and uploads `site/dist` with
`actions/upload-pages-artifact`; `actions/deploy-pages` publishes it. It runs on
every push to `main` that changes `site/**`, `docs/guides/**`, either changelog,
`apps/api/package.json`, the lockfile or the workflow; on demand from
**Actions › Pages › Run workflow**; and after each stable release. A pull
request that touches those paths runs the same build and tests without
deploying. The build job's token reads the repository and the Releases API
only; the deploy job's can only write Pages and request an OIDC token.

CI's path classifier, [`scripts/ci-scope.ts`](../../scripts/ci-scope.ts),
treats `site/` like documentation, so a pull request that changes only the site
starts none of the app suites, the image build or Semgrep; the Pages workflow
covers it. Lint and the other repository-wide checks still run.

### One-time setup

These are done once by a repository admin and the owner of the domain:

1. **DNS.** At the DNS host of `oday-bakkour.com`, add a `CNAME` record named
   `helpdock` with the value `docker-hunterpedia.github.io`. If the zone is on
   Cloudflare, leave the record DNS-only (grey cloud) until GitHub has issued
   the certificate.
2. **Pages source.** In the repository, **Settings › Pages › Build and
   deployment › Source: GitHub Actions**.
3. **Custom domain.** On the same page, set the custom domain to
   `helpdock.oday-bakkour.com` and save. GitHub checks the DNS record.
4. **HTTPS.** Once the certificate is issued, tick **Enforce HTTPS**.
5. Run the **Pages** workflow once, or merge a change to `site/`.

Optionally, verify the domain for the account or organisation under **Settings ›
Pages › Verified domains**, so no other repository can claim it.
