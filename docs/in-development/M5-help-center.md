# M5 Help center

Status: in progress
Started: 2026-09-27
Owner: @Docker-Hunterpedia

## Scope

[PRD, M5 Help center](../planning/PRD.md#m5-help-center). Depends on M1; runs in parallel with M4 (M5-10 waits for M4-05).

## Deliverables

| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M5-01 | Content model: category → section → article, versions per locale,… | #117 | in review — see [Content model](#m5-01-content-model) |
| M5-02 | Editor (per ADR): rich text, images to WebP, code, callouts, tables, video embed,… | #118 | in review — see [Editor](#m5-02-editor) |
| M5-03 | SSR app served by api on brand host; Redis page cache keyed by audience with… | #119 | in review — see [Pages](#m5-03-pages) |
| M5-04 | SEO: canonical, hreflang, sitemap per brand, OG, JSON-LD | #120 | in review — see [SEO](#m5-04-seo) |
| M5-05 | Search: tsvector per language (`english`, `arabic`) + trigram fuzzy; semantic merge… | #121 | in review — see [Search](#m5-05-search) |
| M5-06 | Theme tokens, logo, favicon, sanitized custom CSS, header/footer links, home layout | #122 | in review — see [Theme and site settings](#m5-06-theme-and-site-settings); migration 0035 |
| M5-07 | Custom domains: CNAME + TXT verification in admin, `/internal/domain-check` for Caddy… | #123 | in review: DNS verification (`domains` queue, `domain.verify` every 15 min), Caddy `/internal/domain-check`, Cloudflare flag, `BrandHostResolver`, Brand › Domains and General tabs; migration 0030; new env `HELPCENTER_CNAME_TARGET` |
| M5-08 | Article feedback, view counts, "Still need help?" handoff to widget/form with article… | #124 | in review — see [Feedback, views and Insights](#m5-08-feedback-views-and-insights) |
| M5-09 | Visibility model: `public`/`internal` on article versions, internal-only help center… | #125 | in review — see [Visibility](#m5-09-visibility) |
| M5-10 | Widget "help center" and "chat + articles" modes wired to real content | #126 | in review — see [The widget](#m5-10-the-widget) |

## Artboards

On the [design canvas](https://claude.ai/artifact/RQd32d1RXK8DST8SKC1VBQ), under "M5 Help center": `HelpCenter/Home-EN`, `HelpCenter/Home-AR`, `HelpCenter/Category-EN`, `HelpCenter/Category-AR`, `Help center · article`, `HelpCenter/Article-AR`, `HelpCenter/Search-EN`, `HelpCenter/Search-AR`, `HelpCenter/States-EN`, `Admin/HelpCenter`, `Admin/HelpCenter-Editor`, `Admin/HelpCenter-Settings`, `Admin/Brand-Domains`. The canvas note beside them records the decisions they settle.

## M5-01 Content model

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

### `HelpCenterContentService` (the read side, for M5-03, M5-04, M5-05, M5-10)

`apps/api/src/help-center/content.service.ts`, exported by `HelpCenterModule`. Every method takes an `audience` and opens its own transaction for the brand; every query starts from the `readable` CTE of `visibility.ts`, whose `WHERE` is the visibility rule, so nothing after it sees a row the audience may not read (DOMAIN-RULES §5; `visibility.test.ts` asserts the filter is in the SQL).

| Method | Answers |
|---|---|
| `tree({ brandId, audience, locale })` | categories → sections → readable articles in staff's order; empty sections and categories are left out |
| `articleBySlug({ brandId, audience, locale, slug })` | `found` (with `fallback`, `locales` for hreflang, breadcrumb names), `gone` (archived: answer 410), or `not_found` (draft, internal to a visitor, or unknown: answer 404) |
| `sitemap(brandId)` | one entry per article and readable language with its alternates; always the public audience; empty when internal-only |
| `changedSince({ brandId, audience, since, limit? })` | versions whose published state moved after `since`, oldest first, at most 500, with `visible` for the audience and the slug only when visible |

`public` reads published, public versions of a help center that is not internal-only; `internal` reads every published version. Whether a request may use `internal` (a signed-in staff member of the brand) is the caller's decision.

## M5-02 Editor

- **Admin:** Help center › Articles (`Admin/HelpCenter`): the Structure tree (drag, or ArrowUp / ArrowDown on a handle; dropping an article on another section moves it), filters by title, status, visibility and missing language, the section as a removable chip, and a list with status, visibility, language chips (dashed when missing) and the last editor. "New article" opens a draft in the selected section. New categories and sections are named in the §6.4 Dialog.
- **Editor** (`Admin/HelpCenter-Editor`, `/help-center/articles/:id`, a split route per ADR 0001): TipTap 3.31.3 with headings 2–3 (and 4 kept from imports) carrying an anchor id, bold, italic, lists, links (absolute, `#anchor` or a path on this help center), images, video embeds (YouTube through its no-cookie host, and Vimeo), tables, code blocks, tip and caution callouts, and a per-block direction control over `textDirection: 'auto'`. The Arabic version's page is `dir="rtl"`. Autosave runs 800 ms after typing stops.
- **Images** go through the M1-10 pipeline: presign, PUT to the bucket, confirm (`help_center.media_uploaded` in the outbox), then `help_center.media_process` on the `media` queue sniffs the magic bytes, re-encodes to WebP at quality 82 and at most 2048 px, strips metadata and discards the original. PNG, JPEG, WebP and GIF up to 10 MB. An article's `<img src>` is `/api/help-center/brands/:brandId/media/:mediaId`, a public route that redirects to a five-minute presigned URL.
- **Sanitising:** every save goes through `sanitizeArticleHtml` in `packages/channels` — the ADR 0007 library and stance with the article's allowlist. Only this brand's media route survives in an `<img src>`, only an allowed player address in a video, and no `<iframe>` is ever stored.
- **Markdown** import and export run in the browser through `@tiptap/markdown` ([ADR 0014](../decisions/0014-markdown-through-tiptap.md)); an import is saved like any other edit, so it is sanitised on the server.
- **Activity** is the article's `hc_article.*` rows of `audit_log` (created, edited — once per person and language per 15 minutes —, published, scheduled, unpublished, archived, visibility changed, moved, address changed), with a link to the audit log for an install admin. Versioning with restore or compare is v1.1.

## M5-09 Visibility

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

## M5-03 Pages

[ADR 0015](../decisions/0015-help-center-pages-rendered-by-the-api.md) records the choice: the api renders the pages as plain HTML from `apps/api/src/help-center/site/`, as ADR 0013 does for the web form, and `apps/helpcenter` stays an empty package (the render code belongs to the api that serves it, and `apps/*` never import each other). [The help center guide](../guides/help-center.md) is the operator's view.

- **Where.** On a verified help center host (M5-07's `BrandHostResolver`) every path is the help center's: the admin SPA's catch-all hands the request to the pages (`HOST_PAGES`). A brand without a domain is served on the install's host under `/hc/<brandId>`; one brand's domain never serves another's pages.
- **Pages** (`paths.ts`): `/` redirects to the reader's language by `Accept-Language`, else the brand's default; `/<locale>` home, `/<locale>/categories/<slug>`, `/<locale>/sections/<slug>` (the category layout with one card, as the artboard's note says), `/<locale>/articles/<slug>`, `/<locale>/search?q=`, and the states: 404 (also for an internal or draft article asked for by a visitor), 410 for an archived article, 401 for the internal-only wall. Everything is `dir="rtl"` in Arabic; an article missing in the language asked for is shown in the default language with the notice of `HelpCenter/Article-AR`, its text marked `lang`/`dir`.
- **Audience.** `internal` only for a request with a live staff session of the brand, carried to the brand's host by the **staff pass** (ADR 0015): `POST /api/brands/:brandId/help-center/staff-pass` (`help_center:read`) answers a one-minute, one-use `/_hd/staff?pass=…` address; spending it sets the host-only `hd_hc_staff` cookie (ES256, eight hours), which every page checks against the admin session's refresh family, so an admin sign-out ends it. Staff see internal articles inline with the Internal badge, their name and a Sign out button. Everything else is `public`.
- **Preview.** The editor's Preview opens the article's working copy at its real address with `?preview=1`, staff only, under the banner of `HelpCenter/States-EN` panel 5 (draft, scheduled, unpublished changes, archived, published). Feedback and "Still need help?" are off, views are not counted, nothing is cached.
- **Caching** (`page-cache.ts`): public pages in Redis per brand, host, path, locale and audience for 10 minutes, under a per-brand generation that the page cache's own outbox subscriber (`help_center.page_cache`, `cache-events.ts`) bumps on `help_center.article_changed`, `structure_changed`, `access_changed` and the new `help_center.site_changed`. A page rendered before an invalidation is stored under the old generation, where nobody reads it. Headers: public pages `Cache-Control: public, s-maxage=300, stale-while-revalidate=60` with a strong `ETag` and 304; staff pages, previews, the wall and search `private, no-store`, never stored.
- **CSP.** Per response, with a fresh nonce even for a cached page (stored with a placeholder): `default-src 'none'`, the page's nonce'd style, fonts from `/_hd/fonts/`, images from this origin, `data:` and the bucket, frames for the two video players only, `form-action 'self'`, `frame-ancestors 'none'`; scripts only on a page that loads the widget.
- **Search and feedback** go through the two ports of `ports.ts` only, which `HelpCenterModule` binds to M5-05's `HelpCenterSearchService` and M5-08's `HelpCenterFeedbackService`. Search is called with the request's audience and `source: 'help_center'`; "Was this helpful?" posts to `/_hd/feedback` (origin-checked, the article re-read for the audience) and calls `recordVote`; an article page calls `recordView` for a visitor, on a cache hit too, with the `searchId` of the results page it was opened from (`?sid=`); staff and previews record neither views nor votes. The visitor key is the first-party `hd_hc_v` cookie (set only when a visitor votes) or a keyed hash of address and user agent; nothing third-party.
- **"Still need help?"** links to the web form (`/contact?lang=…` on the host, `/contact/<brandId>?lang=…` on the fallback, with `&article=<id>` on an article) and, where the brand's widget may run on this origin (Channels › Widget, allowed origins), loads `widget.js` and opens it with `Helpdock('open', { article: <id> })` on an article, `Helpdock('open', null)` elsewhere.
- **Images in internal articles** (decided here, as M5-02 left open): the page renderer does **not** gate them. The article page itself is what is gated (404 to a visitor, `private, no-store` to staff), the image address is a UUIDv7 nobody can list, and the redirect it answers with is a five-minute presigned URL; tying each image to the visibility of every article that uses it would need a reference table kept in step with every save and publish, for an address that has already been handed only to readers who could see it. The pages' referrer policy is `strict-origin-when-cross-origin`, so an image address does not leave in a Referer.

## M5-04 SEO

- **Canonical and hreflang** on every page a visitor may read: one `<link rel="alternate">` per language the page exists in and an `x-default` on the brand's default; a fallback article's canonical is the article in its own language, with no alternate in the language asked for. On the fallback path of a brand that has a domain, the canonical points at the domain.
- **Open Graph** (`og:type`, title, description, url, site name, locale, the logo as image) and **JSON-LD**: `WebSite` with a `SearchAction` on home, `BreadcrumbList` on categories, sections and articles, `Article` on articles.
- **`sitemap.xml`** per brand from `HelpCenterContentService.sitemap` (public audience only): both home pages and every readable article and language with its alternates; **404 when internal-only**.
- **`robots.txt`**: a public help center disallows its search results and `/_hd/` and names its sitemap; an internal-only one is `Disallow: /`.
- Every state, search, staff and preview page is `noindex` (meta and `X-Robots-Tag`) with no canonical.

## M5-05 Search

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

## M5-06 Theme and site settings

Migration `0035_help_center_site` adds to `hc_settings` (no new table): `theme`, `logo_media_id`, `favicon_media_id`, `home`, `links` (jsonb, validated by `help-center-site.ts` in `@helpdock/schemas` and read with defaults underneath) and `custom_css`; and `hc_media.purpose` (`article` · `logo` · `favicon`).

- **Help center › Settings** (`Admin/HelpCenter-Settings`), each card saving on its own under `help_center:manage`, audited as `hc_settings.updated` with the card, and announced as `help_center.site_changed`:
  - **Theme** — accent (refused below 3:1 on the page in any mode the brand shows, `low-contrast`; the card shows white text's ratio on it), surface tone, corner radius 0–12, light / dark / auto, typeface pair (`resolveBrandTheme`, DESIGN §8), and logo and favicon uploaded through the M5-02 pipeline with their purpose, which scales them to 512 px. The page's tokens are `tokensCssBundle(resolveBrandTheme(theme))`.
  - **Home page** — category cards, featured articles (up to six, ordered; each must be this brand's, `unknown-article`), popular articles. Search is always shown.
  - **Header and footer links** — up to eight each, a label per language and an http(s) or mailto address.
  - **Custom CSS** — up to 20 000 characters, sanitised on save by an allowlist parser (`site/custom-css.ts`; ADR 0007's library has no stylesheet parser): only style rules and `@media` blocks; no `@import` or other at-rule, no `url()` except an inline PNG/JPEG/GIF/WebP or this brand's own media route, no `expression()`, `javascript:` or binding, no `position: fixed`, and never a backslash or a `<`. What was removed is answered and listed on the card with the reason.
- **View help center** (page header) and the editor's **Preview** open `/help-center/open` in a new tab, which asks for a staff pass and leaves for the help center.

## M5-08 Feedback, views and Insights

`HelpCenterFeedback` is bound to `HelpCenterFeedbackService` (`help-center/feedback/`).

- **`recordView`** inserts one row per visitor per article per UTC day and ignores a repeat. The visitor is whatever key the caller passes (the widget passes its visitor id, the pages their visitor cookie), stored as SHA-256 of the brand and the key. With the `searchId` a search answered, it marks that search as opened. A view of a version that is not published is ignored. Staff visits and previews are the caller's to leave out.
- **`recordVote`** writes one answer per visitor per article version; a second answer replaces the first, comment included. `comment` (optional, at most 1 000 characters) is the "What was missing?" after a "No" on `HelpCenter/Article-AR`.
- **`popular`** answers the audience's readable articles by views over the last 30 days, in the reader's language or the default; articles nobody viewed follow, newest first, so a new help center still lists something.
- **Help center › Insights** (`Admin/HelpCenter-Settings` board 2) reads `GET /api/brands/:brandId/help-center/insights?days=7|30|90&locale=en|ar&sort=views|least_helpful` under `help_center:read`: Top searches (searches and the share that opened a result), Searches with no results (with "Write article", which opens a draft titled with the search in the first section, for someone who may manage the help center), and Articles (views, the helpful share as a meter with "x of y", and the comment count). Ten rows in each search table, twenty articles.
- **"Still need help?"** The widget takes `Helpdock('open', { article })` and sends `articleId` with the next conversation or contact form it starts; the web form takes `?article=` into a hidden field. When the id names a published, public article of the brand, the ticket gets one `ticket.source_article` activity row, which its thread shows as "Came from the help center article “…”". Anything else is dropped without an error.

## M5-10 The widget

- The config's `popularArticles` is `popular` for the public audience, five articles in the config's language.
- `GET /api/widget/:brandId/articles?q=&locale=&purpose=search|suggest` and `GET /api/widget/:brandId/articles/:articleId?locale=&searchId=` are the widget's search and article reads, behind the same gate as every widget route (origin, visitor credential, throttle), public audience only; an internal article is `not_found` like a missing one. `docs/guides/widget-protocol.md` § Help center is the reference.
- The widget's help center mode searches and opens real articles; the chat + articles strip suggests articles from the text being typed (unlogged, 400 ms after typing stops). An article's `url` is on the brand's primary help center domain, or null without one, and then the widget offers no link out. `widget.js` is 25.6 KB gzipped.

## Accepted gaps (M5-05, M5-08, M5-10)

- **Comments are counted, not listed.** The Articles table shows "n comments" as text; the artboard links it to a list that has no artboard yet.
- **Typos are forgiven in titles only.** A misspelt word that appears only in an article's body does not match; trigram matching over bodies needs an index row-level security cannot use.
- **The search log counts partial queries** the widget's search sends while the visitor types, each as its own search. The help center's search box submits a whole query.
- **Insights reads the log live**; there is no daily rollup, which the 180-day window and the brand limits keep cheap enough for now.

## Accepted gaps (M5-01, M5-02, M5-09)

- **An image in an internal article** is served by the same public redirect as any other; M5-03 decided to keep it so (see [Pages](#m5-03-pages)).
- **Article images of a deleted brand** are not yet purged from the bucket by retention (M1-14 knows attachments only).
- **The category and section dialogs** name a new category or section in both languages; there is no artboard for them beyond DESIGN §6.4 Dialog, and renaming an existing one is available over the api only.

## Accepted gaps (M5-03, M5-04, M5-06)

- **Spelling correction and "Popular searches"** on the search artboards are not drawn: the search port answers neither.
- **"Was this helpful?" has no comment step** (`HelpCenter/Article-AR` panel 2): `recordVote` accepts an optional comment, but the page does not draw the comment form yet, so both answers go straight to the thanks.
- **Category icons** on the artboards need an icon per category, which the content model does not have: every category is drawn with Lucide `Folder`. The category page's "Updated" date is left out for the same reason (the tree has no dates).
- **Typefaces.** Only IBM Plex ships in `packages/ui/fonts`; Noto Sans and Vazirmatn fall back to the system stack until their files arrive (`BRAND_FONTS`). "System fonts" on the artboard is not one of DESIGN §8's pairs and is not offered. SVG logos are not accepted: rasterising an uploaded SVG lets it reference other files, and the pipeline takes PNG, JPEG, WebP and GIF.
- **The Custom CSS card's "the contrast and focus checks still run on the result"** is not claimed: nothing checks the rendered page at save time. The axe runs of the Playwright suite cover the shipped styles.
- **A CDN in front** of a help center may serve a public page for up to five minutes without the api seeing it, and that view is not counted.
- **The staff cookie is not revoked by the pass alone:** it ends with the admin session's refresh family (sign-out, sign-out everywhere, password reset, role change) or after eight hours.
- **Section pages** have no artboard of their own; they follow the category artboard's note ("reuses this layout with one card").
- **`/help-center/open`** has no artboard: it shows a status line while it asks for the pass and the DESIGN §6.4 Banner if it cannot.

## Exit criteria

- [ ] `support.<brand>` answers over TLS with a published article, in both locales, with a valid sitemap.
- [ ] Article search returns results in Arabic and English.
- [ ] RTL snapshot test passes.
- [ ] An internal article never appears in the sitemap, public search, or a `public` cached response, tested after toggling an article from public to internal.

## Open questions

- None yet.

## Pull requests

- Custom domains (M5-07): #131.
- Help center content, the editor and visibility (M5-01, M5-02, M5-09): #134.
- Search, feedback, Insights and the widget's help center (M5-05, M5-08, M5-10): #135.
- The pages, SEO and the site settings (M5-03, M5-04, M5-06): this branch.
