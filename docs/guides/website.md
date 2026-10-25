# Website

The product website at <https://helpdock.oday-bakkour.com>: how it is built,
what it may say, how to add a page, and how it is deployed to GitHub Pages.
This guide is for whoever maintains the site, so the site does not publish it.

## What it is

A static [Astro](https://astro.build) site in [`site/`](../../site/), the
private workspace package `@helpdock/website`
([ADR 0058](../decisions/0058-astro-for-the-product-website.md)). Its only
dependencies are `astro`, `@astrojs/sitemap` and `@astrojs/rss`, with `pagefind`
to index it at build time (Playwright and axe are its test tools); there is no UI
framework and no CSS framework. Nothing on it calls a third party: fonts, icons,
images and the search index are served from the site itself, and there is no
analytics or tracking. Only a reader's own click on "Open in Claude" or "Open in
ChatGPT" leaves the site. The `dev`, `build` and `preview` scripts also turn off
Astro's own telemetry (`ASTRO_TELEMETRY_DISABLED=1`).

| Path | What it is |
|---|---|
| `site/astro.config.ts` | Site URL, trailing slashes, the release number, the sitemap and the code-highlighting themes |
| `site/src/pages/` | One file per route; `[slug].astro` files generate a page per item of a data file |
| `site/src/data/` | The words: `home.ts`, `competitors.ts`, `channels.ts`, `features.ts`, `migration.ts`, `docs.ts` (the docs sidebar) and `site.ts` (header, footer, links) |
| `site/src/content.config.ts` | Two collections: the guides, read from `docs/guides/`, and the releases, read from the changelogs |
| `site/src/lib/` | Pure helpers with their tests: the release number, the link rewriters, the changelog and release-notes parsers, guide titles and summaries, the competitor schema, the star count, the zip writer, the agent skill and llms.txt, JSON-LD |
| `site/src/layouts/Base.astro` | The one page shell: the head tags, the header, the footer |
| `site/src/components/` | Shared parts and the page templates shared by English and Arabic |
| `site/src/styles/site.css` | Every style, light and dark |
| `site/src/scripts/site.ts` | Copy buttons, the menus' Escape key and the scroll reveal; every page works without it |
| `site/src/scripts/search.ts` | The search dialog over Pagefind's index |
| `site/src/scripts/not-found.ts` | The 404 page's "did you mean" and inline search |
| `site/public/` | Copied as is: `CNAME`, the favicon, the icon sprite, the fonts and the images |
| `site/e2e/` | Playwright smoke tests of the built site |

## Pages

| Route | Built from |
|---|---|
| `/`, `/ar/` | `data/home.ts` through `components/HomePage.astro` |
| `/compare/helpdock-vs-<x>/`, `/ar/compare/…` | `data/competitors.ts`; Arabic only for a competitor with an `ar` copy |
| `/alternatives/<x>/` | The `alternative` part of a competitor, only for the three with an importer, and `data/migration.ts` |
| `/channels/<x>/`, `/ar/channels/<x>/` | `data/channels.ts`, English and Arabic |
| `/features/<x>/` | `data/features.ts`, English only |
| `/docs/<guide>/`, `/docs/<guide>.md` | `docs/guides/<guide>.md`, English only; the `.md` is the guide with absolute links |
| `/docs/api-reference/`, `/docs/api-reference/openapi.json` | The api's OpenAPI 3.1 document, written at build time by `scripts/site/write-openapi.ts` |
| `/changelog/`, `/changelog/<version>/`, `/changelog/rss.xml` | `CHANGELOG.md`, `apps/api/CHANGELOG.md` and the release tags |
| `/llms.txt`, `/llms-full.txt` | The guides, for AI tools ([llmstxt.org](https://llmstxt.org)) |
| `/downloads/helpdock-docs-<version>.zip`, `/downloads/helpdock-skill-<version>.zip` | The guides, and the `helpdock` Agent Skill; each also as `-latest.zip` |
| `/skill/helpdock/SKILL.md`, `/skill/helpdock/references/<guide>.md` | The same skill, unzipped |
| `/compare/`, `/channels/`, `/features/`, `/docs/` | Index pages over the same data |
| `/404.html` | `pages/404.astro`, which GitHub Pages serves for an unknown path, in English or, under `/ar/`, in Arabic ([The 404 page](#the-404-page)) |

Every page gets a title and a description of its own, a canonical URL, Open
Graph and Twitter tags, and `lang` and `dir`. A page with a counterpart in the
other language also gets `hreflang` links for `en`, `ar` and `x-default`; a page
without one gets none. JSON-LD: `SoftwareApplication` on the home pages,
`FAQPage` where the page shows a FAQ, `BreadcrumbList` on inner pages and
`TechArticle` on the docs. `@astrojs/sitemap` writes `sitemap-index.xml` with the
same language alternates, and `robots.txt` points at it.

Every page but the 404 carries `<meta name="robots" content="index, follow,
max-image-preview:large, max-snippet:-1, max-video-preview:-1">`, set in
`Base.astro` from `src/lib/robots.ts`, so search results and Google Discover may
show large image previews and full snippets; the 404 page carries `noindex`.

The Markdown copies of the guides (`/docs/<guide>.md`, the skill's `.md` files
and `/llms-full.txt`) repeat the HTML guides, which stay the canonical pages.
`robots.txt`, written by `src/pages/robots.txt.ts`, lets every crawler read
everything under `User-agent: *`, so AI agents still get the Markdown, and adds
groups for `Googlebot` and `Bingbot` with `Disallow: /*.md$` and
`Disallow: /llms-full.txt` before their `Allow: /`, so the search engines index
the HTML guides and not their duplicates. A unit test checks those rules, and a
browser test checks that every page in the sitemap has the index meta and a
canonical URL of its own.

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
Any static server works on `site/dist` too, though only one that answers a
missing path with `404.html` shows the site's own 404 page:
`node site/e2e/static-server.ts 4321` does, as GitHub Pages does.

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

`/changelog/` is a timeline of every release up to the one the site shows,
newest first. A release's section of `CHANGELOG.md` is used when it has one;
otherwise its section of `apps/api/CHANGELOG.md`, the list Changesets writes,
which `CHANGELOG.md` lacks for the 1.0.x patches, 1.1 and 1.2; a release tag
with neither gets an entry pointing at its GitHub Release. Nothing is copied:
both files are parsed at build time (`src/lib/changelog.ts`,
`src/lib/release-notes.ts`). Dates come from the `CHANGELOG.md` heading or the
tag (the Pages workflow fetches tags).

Each release becomes its intro and its `###` groups. A group gets an icon and a
label by its heading ("New" or a milestone, "Fixes", "Upgrading", "Known
limits", "Before the release", or a list icon for anything else), and "Known
limits", "Known gaps" and "Before the release" fold in a native `<details>`.
An item's bold opening sentence becomes its title; a Changesets entry that
opens with a name and a colon gets that name as its title. Pull request links
that close a paragraph become chips. The rail shows the version, the date and
"Latest" or the semver step from the release before.

The index shows the newest release in full and the older ones as their intro
and group names, each linking to `/changelog/<version>/`: one page per release,
with its canonical URL and links to the releases on either side, which is also
what the RSS feed at `/changelog/rss.xml` links to. That keeps the index
scannable and each release's notes at one address.

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

## The star count

The header's GitHub link and the "Star on GitHub" button carry the
repository's star count, written compactly (`1.2K`; Latin digits on Arabic
pages), and the link's accessible name gives the full number ("Star Helpdock
on GitHub, 1,234 stars"). It is a build-time snapshot, never a request from the
visitor's browser: the Pages workflow reads `stargazers_count` with
`gh api repos/<repository>` and passes it as `HELPDOCK_STARS`
(`src/lib/stars.ts`). The workflow also runs daily at 04:17 UTC, so the count
refreshes without a push.

A failed lookup only warns: the site is built and deployed without the count,
and the links read as they would without one. A local build has no
`HELPDOCK_STARS` and never calls the network, so it shows no count; set the
variable by hand to see one.

## Search

The header and the docs sidebar open a search dialog (also `⌘K`, `Ctrl+K` or
`/`). The build runs [Pagefind](https://pagefind.app) (`pagefind --site dist`)
after Astro, which writes a static index to `dist/pagefind/`; the dialog
(`src/scripts/search.ts`) loads Pagefind's script from there on its first open,
never before. It indexes the docs, features, channels, comparisons, migration
guides and release pages, the pages whose `Base` gets `indexed`, and skips what
carries `data-pagefind-ignore` (breadcrumbs, sidebars, calls to action, lists of
other pages). Arabic pages are indexed under `lang="ar"`, so a search from an
Arabic page finds Arabic pages. Results are grouped by page: the page's title
once, with an icon for its kind (guide, feature, channel, comparison, release),
then up to three matching sections under it, each with a two-line excerpt.
Arrow keys move, Enter opens, Escape closes and returns focus; a footer line
says so. The dialog uses the product's 12, 13, 14 and 16 px sizes, as a command
palette would. In `pnpm dev` there is no index, and the dialog says search works
on the built site.

## The 404 page

GitHub Pages answers an unknown path with `404.html` and a 404 status, and a
folder asked for without its slash (`/docs/install`) with a redirect to
`/docs/install/`. `astro.config.ts` sets `trailingSlash: 'ignore'` so that
`astro dev` and `astro preview` answer the same way; every link, canonical URL,
`hreflang` and sitemap entry is still written with its slash.

One `404.html` serves both languages. A head script switches it to Arabic
(`lang="ar"`, `dir="rtl"`, the Arabic header, copy and footer) before paint when
the path starts with `/ar/`. The page shows the missing path on a closed
"HD-404" ticket card, offers up to three "did you mean" links from the site's
routes (`src/lib/routes.ts`, matched by `src/lib/suggest.ts`), runs the site
search on the path's words once the page has painted and shows its top five
results inline, with "Search everything" opening the search dialog on the same
words, and links to the install guide, the docs, the channels and the
comparisons. It is `noindex` and left out of the sitemap.

## The API reference

`/docs/api-reference/` lists every `/api/v1` endpoint by tag (its method and
path, summary, required scope, parameters, request body and success response
as field tables, and its errors) and every webhook event's payload. It is built
from the OpenAPI 3.1 document, not written by hand: the site's `build` and
`dev` scripts run `pnpm openapi`, which builds `@helpdock/schemas` and runs
`scripts/site/write-openapi.ts`. That script calls `buildOpenApiDocument()` from
`apps/api/src/api-v1/openapi.ts`, the function the api serves at
`/api/docs/openapi.json`, and writes `site/src/generated/openapi.json`
(gitignored); `src/lib/openapi.ts` turns it into the page. The document is also
published at `/docs/api-reference/openapi.json`.

## Docs for AI tools and offline reading

- **On every guide**, a "Use with AI" menu copies the page as Markdown, opens
  `/docs/<guide>.md`, or opens Claude or ChatGPT with a prompt to read that
  URL. Nothing loads from those services; only the reader's click goes there.
- **`/llms.txt`** lists every guide's Markdown in the [llmstxt.org](https://llmstxt.org)
  format, and **`/llms-full.txt`** holds them all in one file, each with its
  source URL.
- **`/downloads/helpdock-docs-<version>.zip`** holds every guide and a
  `README.md` index; **`/downloads/helpdock-skill-<version>.zip`** holds the
  `helpdock` Agent Skill, a `helpdock/` folder to drop into `.claude/skills/`:
  a `SKILL.md` (when to use it, the release it documents, a task map, the
  install and upgrade commands and the API essentials, all from the guides) and
  the guides under `references/`. Each also exists as `-latest.zip`, and the
  skill is served unzipped under `/skill/helpdock/`. `src/lib/zip.ts` writes the
  archives with Node's `zlib`, so they need no dependency; `src/lib/skill.ts`
  fails the build if its task map names a guide that is not published.
- In every one of these, links are absolute (`src/lib/links.ts`,
  `rewriteMarkdownLinks`), so a file reads correctly wherever it is copied.

## Where the docs come from

The deployed site takes `docs/guides/`, `CHANGELOG.md`,
`apps/api/CHANGELOG.md`, `packages/schemas/src` and
`apps/api/src/api-v1/openapi.ts` from the latest release's tag, not from `main`:
the Pages workflow checks those paths out of `v<version>` after it looks the
release up, so the API reference describes the released API too. The docs pages, the Markdown copies, the downloads, the skill and the
changelog therefore always describe the released version. A guide edited on
`main` reaches the site with the next release, when `release.yml` dispatches the
Pages workflow, so a push that only changes docs does not redeploy. A pull
request builds with its own docs, so a docs change can be previewed, and a
local build uses the working tree.

## Logos

The comparison pages and cards show each competitor's logo, and the channel
tiles show Telegram's, WhatsApp's, Messenger's and Instagram's. They come from
[Simple Icons](https://simpleicons.org) (`simple-icons`, CC0-1.0, pinned exactly
and used at build time only): `src/lib/brand-marks.ts` imports the few it
needs, and their paths are inlined into the pages, so nothing loads from
elsewhere. Competitor logos are monochrome (`currentColor`); channel marks keep
the platform's colour on a neutral tile, beside the Lucide glyphs of email, the
widget, the web form and the API. A product Simple Icons does not carry
(Freshdesk, Zoho Desk, Zammad, FreeScout, osTicket) gets a lettermark tile,
never a drawn imitation. The product itself keeps DESIGN.md §5's generic channel
icons; brand marks are a website-only exception (DESIGN.md §11). The footer
says that product names and logos are trademarks of their owners, used only to
identify the products compared.

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

On the docs pages the guide list and the on-page contents stay below the header
while the page scrolls, each scrolling on its own; the list opens scrolled to
the current guide. Below 900 px the list folds into "All guides" above the page.

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
pnpm --filter @helpdock/website test    # Vitest: the helpers in src/lib
pnpm --filter @helpdock/website build
pnpm --filter @helpdock/website e2e     # Playwright on site/dist
```

The Playwright suite checks the theme switch (a stored choice survives a
reload, System clears it, blocked storage breaks nothing), that the Arabic home
is right to left with its `hreflang`, that no page loads anything from another
origin, axe on both home pages in both themes, search ("telegram" from the
keyboard, an empty result, focus back on Escape), the docs AI menu and the 404
page (the custom page with a 404 status, a "did you mean" for a misspelt guide,
"Search everything", Arabic and right to left under `/ar/`, a slashless address
reaching its page, and axe in both languages). It serves `site/dist` with
`e2e/static-server.ts`, which answers as GitHub Pages does, so build first.

## Deployment

[`.github/workflows/pages.yml`](../../.github/workflows/pages.yml) installs the
workspace with pnpm, runs the site's unit tests, looks up the release number,
takes the docs and changelogs from its tag, looks up the star count, builds the
site and its search index, runs the smoke tests and uploads `site/dist` with
`actions/upload-pages-artifact`; `actions/deploy-pages` publishes it. It runs on
every push to `main` that changes `site/**`, the lockfile or the workflow; on
demand from **Actions › Pages › Run workflow**; after each stable release; and
daily at 04:17 UTC. A pull request that touches the site, the guides, either
changelog, `apps/api/package.json`, the lockfile or the workflow runs the same
build and tests without deploying. The build job's token reads the repository and the Releases API
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
