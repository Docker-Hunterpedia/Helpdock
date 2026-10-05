# M5 Help center

Status: shipped
Started: 2026-09-27
Shipped: 2026-09-27
Owner: @Docker-Hunterpedia

## Scope

Each brand publishes a help center: categories, sections and articles in
English and Arabic, written in the admin's editor and served by the api as
plain HTML on the brand's own domain, or under `/hc/<brandId>` on the install's
host until it has one. Articles are public or internal. Staff read internal
ones in place through a one-use staff pass. The published pages are cached per
audience and dropped on every change, and carry canonical, hreflang, Open
Graph, JSON-LD and a sitemap. Search matches each language with its own
stemming and forgives typos in titles. Views and "Was this helpful?" answers
feed Help center › Insights. The widget's help center and "chat + articles"
modes read the same content.

Full deliverable list and specs: [PRD §4 · M5 Help center](../planning/PRD.md#m5-help-center).
Depends on M1 (shipped 2026-09-25). Ran in parallel with
[M4 Widget and realtime](M4-widget-and-realtime.md). M5-10 waited for M4-05.

Built from the design canvas artboards, under "M5 Help center":
`HelpCenter/Home-EN`, `HelpCenter/Home-AR`, `HelpCenter/Category-EN`,
`HelpCenter/Category-AR`, `Help center · article`, `HelpCenter/Article-AR`,
`HelpCenter/Search-EN`, `HelpCenter/Search-AR`, `HelpCenter/States-EN`,
`Admin/HelpCenter`, `Admin/HelpCenter-Editor`, `Admin/HelpCenter-Settings` and
`Admin/Brand-Domains`. The operator's view is the
[help center guide](../guides/help-center.md).

## Deliverables

| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M5-01 | Content model: category, section, article, versions per locale, states, scheduled publish, fallback locale | #117 | shipped (#134): [Content model](#m5-01-content-model) |
| M5-02 | Editor: rich text, images to WebP, code, callouts, tables, video, anchors, Markdown | #118 | shipped (#134): [Editor](#m5-02-editor) |
| M5-03 | Pages served by the api on the brand host; Redis page cache by audience; ETag; `Cache-Control` | #119 | shipped (#136): [Pages](#m5-03-pages) |
| M5-04 | SEO: canonical, hreflang, sitemap per brand, OG, JSON-LD | #120 | shipped (#136): [SEO](#m5-04-seo) |
| M5-05 | Search: `english` and `arabic` tsvector plus trigram titles; search log | #121 | shipped (#135): [Search](#m5-05-search) |
| M5-06 | Theme tokens, logo, favicon, sanitised custom CSS, header and footer links, home layout | #122 | shipped (#136): [Theme and site settings](#m5-06-theme-and-site-settings) |
| M5-07 | Custom domains: CNAME and TXT verification, `/internal/domain-check` for Caddy, Cloudflare flag | #123 | shipped (#131): [Custom domains](#m5-07-custom-domains) |
| M5-08 | Article feedback, view counts, "Still need help?" with article context | #124 | shipped (#135): [Feedback, views and Insights](#m5-08-feedback-views-and-insights) |
| M5-09 | Visibility: `public` and `internal` versions, internal-only mode, propagation | #125 | shipped (#134): [Visibility](#m5-09-visibility) |
| M5-10 | Widget "help center" and "chat + articles" modes on real content | #126 | shipped (#135): [The widget](#m5-10-the-widget) |

## Exit criteria

Copied from the PRD. All four are met, the first short of real TLS. The
integration tests run against real Postgres and Redis (Testcontainers) in CI's
`integration` job.

- [x] **`support.<brand>` answers over TLS with a published article, in both
      locales, with a valid sitemap.** Met except for real TLS, which is pending
      an external dependency.
      `apps/api/src/help-center/site/help-center-site.integration.test.ts` ›
      "M5 exit criteria, on the brand’s host" › "answers a published article
      in both languages on support.<brand>, with a valid sitemap". An article
      published in English and Arabic answers 200 on the brand's verified host,
      in each language, with `dir`, canonical and hreflang. The sitemap is parsed
      as XML by Postgres (`xml_is_well_formed_document`, `xpath`). It has one
      absolute `<loc>` per `<url>`, all on the host and none twice, both
      languages of the article with both `hreflang` alternates, and a
      parseable `<lastmod>`. Host routing is
      `apps/api/src/domains/domains.integration.test.ts` › "host routing" ›
      "maps a verified host to its brand and primary host, and nothing else",
      and the site suite's "by host and by path" tests. The TLS side stops at
      what the api controls. "verifies, makes the first verified domain
      primary, probes TLS and lets Caddy issue" proves that
      `/internal/domain-check` lets Caddy's on-demand TLS issue for a verified
      domain, against a stubbed probe. **A certificate issued by a real CA for
      a real `support.<brand>` is not tested.** It needs the registered domain
      with DNS control that the PRD lists under external dependencies for
      M5-07, which is still `needed`.
- [x] **Article search returns results in Arabic and English.**
      `apps/api/src/help-center/search/search.integration.test.ts` › "search in
      English and Arabic (M5-05)" › "finds an article by a word of its title,
      above one that only mentions it", "stems English and matches the word
      being typed as a prefix" and "searches Arabic with the arabic
      configuration, diacritics or not". Through the pages:
      `help-center-site.integration.test.ts` › "M5 exit criteria, on the
      brand’s host" › "finds the article from the help center’s search in
      English and in Arabic". In a browser against the real api (English):
      `apps/admin/e2e/api/widget-live.api.spec.ts` › "an article the agent
      publishes is listed, found and read in the widget (M5-10)".
- [x] **RTL snapshot test passes.** `apps/api/e2e/help-center-rtl.spec.ts` ›
      "the Arabic article page matches its RTL snapshot". It compares the
      Arabic article page against two committed text baselines in
      `apps/api/e2e/__snapshots__/`: the aria snapshot of `<main>`, and a list
      of layout facts, such as which column each region is in, which side the
      title and body start from, the mirrored breadcrumb chevrons, and the code
      block staying left to right. The widget has the same kind of test:
      `apps/widget/e2e/rtl-snapshot.spec.ts` › "the Arabic chat window matches
      its RTL snapshot". The baselines are text, not pixels, so they match on
      any platform. Both Playwright projects run in CI since #139.
- [x] **An internal article never appears in the sitemap, public search, or a
      `public` cached response, tested after toggling an article from public to
      internal.** `help-center-site.integration.test.ts` › "M5 exit criteria,
      on the brand’s host" › "drops an article toggled from public to internal
      from the sitemap, public search and every public cached page". First,
      both languages' article pages, the category pages and the sitemap are
      cached with the article in them. Then both versions are made internal.
      Public search stops finding it at once, before any event. Once the page
      cache's handler has run on the events, the sitemap, the category pages
      and the article pages no longer name it, and the article pages answer
      404. The test also reads every page in Redis's current public
      generation, and none names it. Staff still read it. At the service
      level: `help-center.integration.test.ts` › "never answers a public query
      with an article toggled from public to internal", and
      `search.integration.test.ts` › "stops matching a version made internal
      at once, before the subscriber has run".

## Effort

| | |
|---|---|
| Estimated | 5–6 weeks (PRD status board) |
| Started | 2026-09-27 |
| Shipped | 2026-09-27 |
| Actual | 1 day, in parallel with M4 |

AI coding agents built custom domains, then content and the editor, then
search, feedback and the widget, then the pages and settings. Each branch was
merged onto the one before it, and the maintainer reviewed and merged the PRs.

## Migrations

- `0030_brand_domain_verification`: verification, primary, Cloudflare and TLS
  columns on `brand_domains`.
- `0033_help_center`: `hc_categories`, `hc_sections`, `hc_articles`,
  `hc_article_versions`, `hc_settings` and `hc_media`.
- `0034_help_center_search`: `hc_search_documents`, `hc_search_log`,
  `hc_article_views` and `hc_article_feedback`.
- `0035_help_center_site`: the site settings columns on `hc_settings` and
  `hc_media.purpose`.

All ten new tables are brand-scoped, in `TENANT_TABLES` and in the RLS
negative suite.

## Gaps and follow-ups

Written down and carried forward. None of them blocks M6, M7 or M8.

| Gap | Why it was accepted | Where it is written down |
|---|---|---|
| **Images in internal articles are not gated** | An image is served by the same public redirect as any other. The article page itself is gated, the image address is a UUIDv7 nobody can list, and the redirect is a five-minute presigned URL. Tying each image to the visibility of every article that uses it would need a reference table kept in step with every save and publish. | [Pages](#m5-03-pages) |
| ~~No comment form after a "No" vote~~ | Closed in (M9-04 branch): a "No" is recorded and opens the "What was missing?" step of `HelpCenter/Article-AR` panel 2; Send records the note with the vote, Skip goes to the thanks. | [help center guide](../guides/help-center.md#was-this-helpful) |
| **No spelling correction and no "Popular searches"** on the search pages | The search port answers neither. | This doc |
| **Typos are forgiven in titles only** | Trigram matching over bodies needs an index that row-level security cannot use (ADR 0011). | [Search](#m5-05-search) |
| **Partial widget queries are logged** | The widget searches while the visitor types, and each partial query is logged as its own search. The help center's search box submits a whole query. | [Search](#m5-05-search) |
| **Only IBM Plex ships** | Noto Sans and Vazirmatn fall back to the system stack until their files are added to `packages/ui/fonts` (`BRAND_FONTS`). | [Theme and site settings](#m5-06-theme-and-site-settings) |
| **SVG logos are refused** | Rasterising an uploaded SVG lets it reference other files. The pipeline takes PNG, JPEG, WebP and GIF. | [Theme and site settings](#m5-06-theme-and-site-settings) |
| **`hc_media` is not purged when a brand is deleted** | Retention (M1-14) knows ticket attachments only, so a deleted brand's article images, logo and favicon stay in the bucket. | This doc |
| ~~The api's page Playwright project is not in CI~~ | Closed in #139: the admin `e2e` job runs `pnpm --filter @helpdock/api e2e` on its first shard. | [CI workflow](../../.github/workflows/ci.yml) |
| **No real TLS certificate is tested** | See the first exit criterion. It needs the registered domain listed under the PRD's external dependencies. | [PRD, external dependencies](../planning/PRD.md#external-dependencies) |
| Comments are counted, not listed, on Insights | The Articles table shows "n comments" as text. The artboard links it to a list that has no artboard yet. | This doc |
| Insights reads the search log live | There is no daily rollup. The 180-day window and the brand limits keep it cheap enough for now. | This doc |
| The category and section dialogs have no artboard of their own | They follow DESIGN §6.4 Dialog. Renaming an existing category or section is available over the api only. | This doc |
| Category icons and the category page's "Updated" date are left out | The content model has no icon per category and the tree has no dates. Every category is drawn with Lucide `Folder`. | This doc |
| The Custom CSS card does not check contrast or focus on the result | Nothing checks the rendered page at save time. The axe runs of the Playwright suites cover the shipped styles. | This doc |
| A CDN in front of a help center hides up to five minutes of views | It may serve a public page for up to five minutes (`s-maxage=300`) without the api seeing the request, so the view is not counted. | [Pages](#m5-03-pages) |
| The staff cookie is not revoked by spending the pass | It ends with the admin session's refresh family (sign-out, sign-out everywhere, password reset, role change) or after eight hours. | [Pages](#m5-03-pages) |
| ~~The CSAT page's "Browse the help center" link is not drawn~~ | Closed in (M9-04 branch): the thanks and the spent-link screens link to the brand's help center while it has a public article and is not internal-only. | [tickets guide](../guides/tickets.md) |
| Section pages and `/help-center/open` have no artboards | Section pages follow the category artboard's note. `/help-center/open` shows a status line and the DESIGN §6.4 Banner. | This doc |

## Decisions settled

| Decision | Where |
|---|---|
| The help center pages are rendered by the api as plain HTML; `apps/helpcenter` stays empty | [ADR 0015](../decisions/0015-help-center-pages-rendered-by-the-api.md) |
| Markdown import and export run in the browser through `@tiptap/markdown` | [ADR 0014](../decisions/0014-markdown-through-tiptap.md) |
| Staff reach the brand's host through a one-minute, one-use staff pass that sets a host-only cookie | [ADR 0015](../decisions/0015-help-center-pages-rendered-by-the-api.md), [help center guide](../guides/help-center.md#staff-on-the-help-center) |
| No GIN index for search under FORCEd row-level security; the brand and language narrow by btree | [ADR 0011](../decisions/0011-ticket-search-token-table.md), [Search](#m5-05-search) |
| Images in internal articles are not gated | [Pages](#m5-03-pages) |

## External dependencies

| Dependency | Status | What waits on it |
|---|---|---|
| A registered domain with DNS control, for the TLS onboarding test (M5-07) | `needed` ([PRD](../planning/PRD.md#external-dependencies)) | A real certificate for a real `support.<brand>`. Everything short of it is tested. |

## What an operator can do with this milestone

Write articles in English and Arabic in the admin's editor, with images,
tables, code, callouts and video, and import or export Markdown. Order them
into categories and sections, publish now or on a schedule, and make each
language public or internal, or the whole help center internal-only. Point a
brand's own domain at the install on Brand › Domains and have Caddy issue its
certificate once DNS is verified. Theme the pages, add a logo, favicon,
header and footer links and custom CSS, and choose what the home page shows.
Read on Help center › Insights what customers search for, what they do not
find, and which articles help. Customers find the same articles in the widget.

## Deliverable notes

### M5-01 Content model

Migration `0033_help_center` adds six tenant tables, all brand-scoped and none department-scoped (help center content is the brand's, DOMAIN-RULES §1.2), each in `TENANT_TABLES` and the negative suite in `packages/db/src/rls.integration.test.ts`:

| Table | Holds |
|---|---|
| `hc_categories` | slug (unique per brand), names and descriptions as `{ en, ar }`, position |
| `hc_sections` | category, slug, names, position |
| `hc_articles` | section, slug (one for every language: `/en/articles/<slug>` and `/ar/articles/<slug>`), position |
| `hc_article_versions` | one per article and locale: `status` (`draft` · `scheduled` · `published` · `archived`), `visibility` (`public` · `internal`), the **working copy** (`title`, `description`, `body_html`) the editor autosaves, the **published copy** (`published_*`, plus `published_body_text`) visitors read, `scheduled_at`, and `changed_at` |
| `hc_settings` | one row per brand: `access` (`public` · `internal_only`) |
| `hc_media` | article images and what the pipeline made of them |

- **Publishing** copies the working copy to the published columns in one statement, with its audit row and `help_center.article_changed` (`apps/api/src/help-center/publish.ts`). Autosaving a published article changes nothing a visitor reads; the list and the editor show "Publish changes" while the two differ.
- **Scheduled publish.** Scheduling writes `help_center.article_changed` with `change: 'scheduled'` and `scheduledAt`; its handler adds a **delayed** `help_center.publish_due` job for that brand and minute on the `knowledge` queue. An hourly `help_center.publish_due.sweep` adds one per active brand as the safety net, the `sla.timer` / `sla.rebuild` shape. The job publishes every version whose time has passed, as the system actor; the Activity panel shows it as "Scheduled publish".
- **Fallback locale.** A reader in a language an article has no readable version in gets the brand's default language, flagged `fallback: true`; category and section names fall back the same way.
- **Deleting** a category or section with anything in it is refused (`not-empty`); an article that was ever published is archived rather than deleted (`was-published`), so nothing downstream is left pointing at a row that vanished.
- **Limits:** 100 categories, 500 sections, 5 000 articles per brand; slugs 120 characters of `[a-z0-9-]`; titles 200; search descriptions 160; bodies 500 000 characters and 20 000 tags.
- **Permissions:** `help_center:read` for every role, `help_center:manage` for Admin and Team Leader (DOMAIN-RULES §1.2).

#### `HelpCenterContentService` (the read side, for M5-03, M5-04, M5-05, M5-10)

`apps/api/src/help-center/content.service.ts`, exported by `HelpCenterModule`. Every method takes an `audience` and opens its own transaction for the brand; every query starts from the `readable` CTE of `visibility.ts`, whose `WHERE` is the visibility rule, so nothing after it sees a row the audience may not read (DOMAIN-RULES §5; `visibility.test.ts` asserts the filter is in the SQL).

| Method | Answers |
|---|---|
| `tree({ brandId, audience, locale })` | categories → sections → readable articles in staff's order; empty sections and categories are left out |
| `articleBySlug({ brandId, audience, locale, slug })` | `found` (with `fallback`, `locales` for hreflang, breadcrumb names), `gone` (archived: answer 410), or `not_found` (draft, internal to a visitor, or unknown: answer 404) |
| `sitemap(brandId)` | one entry per article and readable language with its alternates; always the public audience; empty when internal-only |
| `changedSince({ brandId, audience, since, limit? })` | versions whose published state moved after `since`, oldest first, at most 500, with `visible` for the audience and the slug only when visible |

`public` reads published, public versions of a help center that is not internal-only; `internal` reads every published version. Whether a request may use `internal` (a signed-in staff member of the brand) is the caller's decision.

### M5-02 Editor

- **Admin:** Help center › Articles (`Admin/HelpCenter`): the Structure tree (drag, or ArrowUp / ArrowDown on a handle; dropping an article on another section moves it), filters by title, status, visibility and missing language, the section as a removable chip, and a list with status, visibility, language chips (dashed when missing) and the last editor. "New article" opens a draft in the selected section. New categories and sections are named in the §6.4 Dialog.
- **Editor** (`Admin/HelpCenter-Editor`, `/help-center/articles/:id`, a split route per ADR 0001): TipTap 3.31.3 with headings 2–3 (and 4 kept from imports) carrying an anchor id, bold, italic, lists, links (absolute, `#anchor` or a path on this help center), images, video embeds (YouTube through its no-cookie host, and Vimeo), tables, code blocks, tip and caution callouts, and a per-block direction control over `textDirection: 'auto'`. The Arabic version's page is `dir="rtl"`. Autosave runs 800 ms after typing stops.
- **Images** go through the M1-10 pipeline: presign, PUT to the bucket, confirm (`help_center.media_uploaded` in the outbox), then `help_center.media_process` on the `media` queue sniffs the magic bytes, re-encodes to WebP at quality 82 and at most 2048 px, strips metadata and discards the original. PNG, JPEG, WebP and GIF up to 10 MB. An article's `<img src>` is `/api/help-center/brands/:brandId/media/:mediaId`, a public route that redirects to a five-minute presigned URL.
- **Sanitising:** every save goes through `sanitizeArticleHtml` in `packages/channels` — the ADR 0007 library and stance with the article's allowlist. Only this brand's media route survives in an `<img src>`, only an allowed player address in a video, and no `<iframe>` is ever stored.
- **Markdown** import and export run in the browser through `@tiptap/markdown` ([ADR 0014](../decisions/0014-markdown-through-tiptap.md)); an import is saved like any other edit, so it is sanitised on the server.
- **Activity** is the article's `hc_article.*` rows of `audit_log` (created, edited — once per person and language per 15 minutes —, published, scheduled, unpublished, archived, visibility changed, moved, address changed), with a link to the audit log for an install admin. Versioning with restore or compare is v1.1.

### M5-09 Visibility

- `visibility` lives on each article version and is live: making a version internal takes it off every public read in the same commit.
- **Internal-only mode** (`hc_settings.access`, Help center › Settings › "Who can read it") makes the read filter false for every public read without rewriting any article, so switching back restores each article's own choice.
- **Events** (DOMAIN-RULES §6), each written in the transaction of the change:

| Event | Payload | Written when |
|---|---|---|
| `help_center.article_changed` | `{ articleId, locale \| null, change, scheduledAt? }`, `change` one of `published`, `unpublished`, `archived`, `scheduled`, `visibility`, `slug`, `moved` | anything a reader of the published help center could notice about one article |
| `help_center.structure_changed` | `{ kind: 'category' \| 'section', id }` | a category or section is created, renamed, reordered or deleted |
| `help_center.access_changed` | `{ access }` | the help center becomes public or internal-only |

  Search (M5-05) subscribes to all three as `search`; the page cache (M5-03) and, from M7, `knowledge.sync` subscribe under their own subscriber names beside it, and the default handler logs them (and adds the delayed publish for `scheduled`). The relay publishes within about a second, so the 60-second budget of DOMAIN-RULES §5 is the consumers' to keep.
- **The exit criterion's setup** is proved in `apps/api/src/help-center/help-center.integration.test.ts`: an article toggled from public to internal is absent from `articleBySlug`, `tree` and `sitemap` for the public audience in both languages, `changedSince` reports it as not visible without its slug, and staff still read it.

### M5-03 Pages

[ADR 0015](../decisions/0015-help-center-pages-rendered-by-the-api.md) records the choice: the api renders the pages as plain HTML from `apps/api/src/help-center/site/`, as ADR 0013 does for the web form, and `apps/helpcenter` stays an empty package (the render code belongs to the api that serves it, and `apps/*` never import each other). [The help center guide](../guides/help-center.md) is the operator's view.

- **Where.** On a verified help center host (M5-07's `BrandHostResolver`) every path is the help center's: the admin SPA's catch-all hands the request to the pages (`HOST_PAGES`). A brand without a domain is served on the install's host under `/hc/<brandId>`; one brand's domain never serves another's pages.
- **Pages** (`paths.ts`): `/` redirects to the reader's language by `Accept-Language`, else the brand's default; `/<locale>` home, `/<locale>/categories/<slug>`, `/<locale>/sections/<slug>` (the category layout with one card, as the artboard's note says), `/<locale>/articles/<slug>`, `/<locale>/search?q=`, and the states: 404 (also for an internal or draft article asked for by a visitor), 410 for an archived article, 401 for the internal-only wall. Everything is `dir="rtl"` in Arabic; an article missing in the language asked for is shown in the default language with the notice of `HelpCenter/Article-AR`, its text marked `lang`/`dir`.
- **Audience.** `internal` only for a request with a live staff session of the brand, carried to the brand's host by the **staff pass** (ADR 0015): `POST /api/brands/:brandId/help-center/staff-pass` (`help_center:read`) answers a one-minute, one-use `/_hd/staff?pass=…` address; spending it sets the host-only `hd_hc_staff` cookie (ES256, eight hours), which every page checks against the admin session's refresh family, so an admin sign-out ends it. Staff see internal articles inline with the Internal badge, their name and a Sign out button. Everything else is `public`.
- **Preview.** The editor's Preview opens the article's working copy at its real address with `?preview=1`, staff only, under the banner of `HelpCenter/States-EN` panel 5 (draft, scheduled, unpublished changes, archived, published). Feedback and "Still need help?" are off, views are not counted, nothing is cached.
- **Caching** (`page-cache.ts`): public pages in Redis per brand, host, path, locale and audience for 10 minutes, under a per-brand generation that the page cache's own outbox subscriber (`help_center.page_cache`, `cache-events.ts`) bumps on `help_center.article_changed`, `structure_changed`, `access_changed` and the new `help_center.site_changed`. A page rendered before an invalidation is stored under the old generation, where nobody reads it. Headers: public pages `Cache-Control: public, s-maxage=300, stale-while-revalidate=60` with a strong `ETag` and 304; staff pages, previews, the wall and search `private, no-store`, never stored.
- **CSP.** Per response, with a fresh nonce even for a cached page (stored with a placeholder): `default-src 'none'`, the page's nonce'd style, fonts from `/_hd/fonts/`, images from this origin, `data:` and the bucket, frames for the two video players only, `form-action 'self'`, `frame-ancestors 'none'`; scripts only on a page that loads the widget.
- **Search and feedback** go through the two ports of `ports.ts` only, which `HelpCenterModule` binds to M5-05's `HelpCenterSearchService` and M5-08's `HelpCenterFeedbackService`. Search is called with the request's audience and `source: 'help_center'`; "Was this helpful?" posts to `/_hd/feedback` (origin-checked, the article re-read for the audience) and calls `recordVote`; a "No" then asks "What was missing?" (since M9-04); an article page calls `recordView` for a visitor, on a cache hit too, with the `searchId` of the results page it was opened from (`?sid=`); staff and previews record neither views nor votes. The visitor key is the first-party `hd_hc_v` cookie (set only when a visitor votes) or a keyed hash of address and user agent; nothing third-party.
- **"Still need help?"** links to the web form (`/contact?lang=…` on the host, `/contact/<brandId>?lang=…` on the fallback, with `&article=<id>` on an article) and, where the brand's widget may run on this origin (Channels › Widget, allowed origins), loads `widget.js` and opens it with `Helpdock('open', { article: <id> })` on an article, `Helpdock('open', null)` elsewhere.
- **Images in internal articles** (decided here, as M5-02 left open): the page renderer does **not** gate them. The article page itself is what is gated (404 to a visitor, `private, no-store` to staff), the image address is a UUIDv7 nobody can list, and the redirect it answers with is a five-minute presigned URL; tying each image to the visibility of every article that uses it would need a reference table kept in step with every save and publish, for an address that has already been handed only to readers who could see it. The pages' referrer policy is `strict-origin-when-cross-origin`, so an image address does not leave in a Referer.

### M5-04 SEO

- **Canonical and hreflang** on every page a visitor may read: one `<link rel="alternate">` per language the page exists in and an `x-default` on the brand's default; a fallback article's canonical is the article in its own language, with no alternate in the language asked for. On the fallback path of a brand that has a domain, the canonical points at the domain.
- **Open Graph** (`og:type`, title, description, url, site name, locale, the logo as image) and **JSON-LD**: `WebSite` with a `SearchAction` on home, `BreadcrumbList` on categories, sections and articles, `Article` on articles.
- **`sitemap.xml`** per brand from `HelpCenterContentService.sitemap` (public audience only): both home pages and every readable article and language with its alternates; **404 when internal-only**.
- **`robots.txt`**: a public help center disallows its search results and `/_hd/` and names its sitemap; an internal-only one is `Disallow: /`.
- Every state, search, staff and preview page is `noindex` (meta and `X-Robots-Tag`) with no canonical.

### M5-05 Search

`HelpCenterSearch` (`apps/api/src/help-center/ports.ts`) is bound in `HelpCenterModule` to `HelpCenterSearchService` (`help-center/search/`), which the help center pages (M5-03) and the widget (M5-10) search through.

Migration `0034_help_center_search` adds the search index, the search log and the two M5-08 tables, all brand-scoped tenant tables in `TENANT_TABLES` and the negative suite:

| Table | Holds |
|---|---|
| `hc_search_documents` | one row per **published** version: its published title, description and body text, a generated `search` tsvector in the language's own configuration (`english` for `en`, `arabic` for `ar`; Postgres ships both), weighted title A, description B, body C, and a generated `title_normalized` for trigram matching (lower case, Arabic diacritics and tatweel removed, alef, yaa and taa marbuta folded) |
| `hc_search_log` | query (trimmed, lower-cased, at most 200 characters), locale, source (`help_center` or `widget`), hit count, when a hit was opened, when |
| `hc_article_views` | one row per visitor per article per UTC day (M5-08) |
| `hc_article_feedback` | one "Was this helpful?" answer per visitor per article version, with an optional comment (M5-08) |

- **Visibility before ranking** (DOMAIN-RULES §5). The query opens with `readableVersions(audience)` and an index row takes part only by joining the live version it lets through, so a visitor never matches an internal, draft or archived version, or anything in an internal-only help center — not even in the second or two before the index catches up. `search/lexical.test.ts` asserts the join precedes the ranking in the SQL; `search.integration.test.ts` toggles an article to internal and back, and switches the help center to internal-only, around searches.
- **Ranking.** Every word must match, the last as a prefix (the widget searches while the visitor types); `ts_rank_cd` of that, plus half the rank of any word matching, plus 0.6 × `word_similarity` of the query and the title, so a misspelt title ("refnd timelnes") still ranks first. A version takes part when any word matches or its title is at least 0.4 similar. One version per article: the reader's language when the index has it, else the brand's default, as the pages fall back. Snippets are `ts_headline` with no markers, plain text for the renderer to escape.
- **The M7 seam.** Search asks each `CandidateSource` (`search/ranking.ts`) for its best 100 articles, each filtering by audience in SQL first, and merges the lists by reciprocal rank fusion. M5 has the lexical source; M7 adds a semantic one over `knowledge_chunks` beside it and changes nothing else.
- **Keeping the index current.** The `search` subscriber of `help_center.article_changed` re-indexes that article in the event's own transaction, about a second after the commit; `structure_changed` and `access_changed` re-index the brand (a statement that skips every current row). The hourly `help_center.search_reindex.sweep` adds one `help_center.search_reindex` per active brand on the `knowledge` queue, the safety net behind the events and what fills the index on an install that already had articles.
- **No GIN index.** Under FORCEd row-level security a GIN index cannot run ahead of the policy (ADR 0011), so the brand and language narrow the rows by btree and the match runs over what is left, at most 5 000 articles × 2 languages per brand.
- **The search log** keeps the query and never who asked. A search with no word in it ("?!") is neither run nor logged; only the first page of a search is logged, and the widget's suggestions while a chat message is typed are not logged at all (`SearchQuery.log: false`); nor are staff searches on the help center pages, as their views and votes are not counted. **Retention:** the log is kept for the brand's search log window (Brand › Data retention, 180 days by default, DOMAIN-RULES §11) and hard-deleted by `maintenance.retention`, which also deletes the view rows older than the same window.

### M5-06 Theme and site settings

Migration `0035_help_center_site` adds to `hc_settings` (no new table): `theme`, `logo_media_id`, `favicon_media_id`, `home`, `links` (jsonb, validated by `help-center-site.ts` in `@helpdock/schemas` and read with defaults underneath) and `custom_css`; and `hc_media.purpose` (`article` · `logo` · `favicon`).

- **Help center › Settings** (`Admin/HelpCenter-Settings`), each card saving on its own under `help_center:manage`, audited as `hc_settings.updated` with the card, and announced as `help_center.site_changed`:
  - **Theme** — accent (refused below 3:1 on the page in any mode the brand shows, `low-contrast`; the card shows white text's ratio on it), surface tone, corner radius 0–12, light / dark / auto, typeface pair (`resolveBrandTheme`, DESIGN §8), and logo and favicon uploaded through the M5-02 pipeline with their purpose, which scales them to 512 px. The page's tokens are `tokensCssBundle(resolveBrandTheme(theme))`.
  - **Home page** — category cards, featured articles (up to six, ordered; each must be this brand's, `unknown-article`), popular articles. Search is always shown.
  - **Header and footer links** — up to eight each, a label per language and an http(s) or mailto address.
  - **Custom CSS** — up to 20 000 characters, sanitised on save by an allowlist parser (`site/custom-css.ts`; ADR 0007's library has no stylesheet parser): only style rules and `@media` blocks; no `@import` or other at-rule, no `url()` except an inline PNG/JPEG/GIF/WebP or this brand's own media route, no `expression()`, `javascript:` or binding, no `position: fixed`, and never a backslash or a `<`. What was removed is answered and listed on the card with the reason.
- **View help center** (page header) and the editor's **Preview** open `/help-center/open` in a new tab, which asks for a staff pass and leaves for the help center.

### M5-07 Custom domains

- **Brand › Domains** adds a host name, shows the CNAME and TXT records to publish with copy buttons, and says what the last check saw: waiting for DNS, verified with the certificate issued, or failed with the reason. **Brand › General** edits the brand's name, default language and time zone.
- **Verification** runs on the `domains` queue: `domain.verify` on request ("Check now", with a cooldown) and every 15 minutes. A domain is verified once both records are seen, and the first verified domain becomes primary. The worker then makes one TLS handshake so Caddy issues the certificate before a customer asks. A domain whose TXT record is gone is un-verified; a DNS timeout never un-verifies one.
- **`/internal/domain-check`** answers 200 only for a verified, unproxied help center domain, which is what Caddy's on-demand TLS asks before it issues. A domain flagged **"Proxied by Cloudflare"** gets no certificate from Caddy.
- **`BrandHostResolver`** maps a verified host to its brand and primary host; one brand's domain never serves another's pages.
- New optional setting: `HELPCENTER_CNAME_TARGET`, the name the CNAME record points at.

### M5-08 Feedback, views and Insights

`HelpCenterFeedback` is bound to `HelpCenterFeedbackService` (`help-center/feedback/`).

- **`recordView`** inserts one row per visitor per article per UTC day and ignores a repeat. The visitor is whatever key the caller passes (the widget passes its visitor id, the pages their visitor cookie), stored as SHA-256 of the brand and the key. With the `searchId` a search answered, it marks that search as opened. A view of a version that is not published is ignored. Staff visits and previews are the caller's to leave out.
- **`recordVote`** writes one answer per visitor per article version; a second answer replaces the first, comment included. `comment` (optional, at most 1 000 characters) is the "What was missing?" after a "No" on `HelpCenter/Article-AR`.
- **`popular`** answers the audience's readable articles by views over the last 30 days, in the reader's language or the default; articles nobody viewed follow, newest first, so a new help center still lists something.
- **Help center › Insights** (`Admin/HelpCenter-Settings` board 2) reads `GET /api/brands/:brandId/help-center/insights?days=7|30|90&locale=en|ar&sort=views|least_helpful` under `help_center:read`: Top searches (searches and the share that opened a result), Searches with no results (with "Write article", which opens a draft titled with the search in the first section, for someone who may manage the help center), and Articles (views, the helpful share as a meter with "x of y", and the comment count). Ten rows in each search table, twenty articles.
- **"Still need help?"** The widget takes `Helpdock('open', { article })` and sends `articleId` with the next conversation or contact form it starts; the web form takes `?article=` into a hidden field. When the id names a published, public article of the brand, the ticket gets one `ticket.source_article` activity row, which its thread shows as "Came from the help center article “…”". Anything else is dropped without an error.

### M5-10 The widget

- The config's `popularArticles` is `popular` for the public audience, five articles in the config's language.
- `GET /api/widget/:brandId/articles?q=&locale=&purpose=search|suggest` and `GET /api/widget/:brandId/articles/:articleId?locale=&searchId=` are the widget's search and article reads, behind the same gate as every widget route (origin, visitor credential, throttle), public audience only; an internal article is `not_found` like a missing one. `docs/guides/widget-protocol.md` § Help center is the reference.
- The widget's help center mode searches and opens real articles; the chat + articles strip suggests articles from the text being typed (unlogged, 400 ms after typing stops). An article's `url` is on the brand's primary help center domain, or null without one, and then the widget offers no link out. `widget.js` is 25.6 KB gzipped.

## Pull requests

- #131 feat(domains): custom help center domains with DNS verification and on-demand TLS (M5-07)
- #134 feat(help-center): content model, article editor and visibility (M5-01, M5-02, M5-09)
- #135 feat(help-center): search, feedback and views, Insights, and the widget on real content (M5-05, M5-08, M5-10)
- #136 feat(help-center): server-rendered pages, SEO and site settings (M5-03, M5-04, M5-06)
