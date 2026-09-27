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
| M5-03 | SSR app served by api on brand host; Redis page cache keyed by audience with… | #119 | not started |
| M5-04 | SEO: canonical, hreflang, sitemap per brand, OG, JSON-LD | #120 | not started |
| M5-05 | Search: tsvector per language (`english`, `arabic`) + trigram fuzzy; semantic merge… | #121 | in review — see [Search](#m5-05-search) |
| M5-06 | Theme tokens, logo, favicon, sanitized custom CSS, header/footer links, home layout | #122 | not started |
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
- **The search log** keeps the query and never who asked. A search with no word in it ("?!") is neither run nor logged; only the first page of a search is logged, and the widget's suggestions while a chat message is typed are not logged at all (`SearchQuery.log: false`). **Retention:** the log is kept for the brand's search log window (Brand › Data retention, 180 days by default, DOMAIN-RULES §11) and hard-deleted by `maintenance.retention`, which also deletes the view rows older than the same window.

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
- **The search log counts partial queries** the help center's search box sends while the visitor types, as the widget's search does, each as its own search.
- **Insights reads the log live**; there is no daily rollup, which the 180-day window and the brand limits keep cheap enough for now.

## Accepted gaps (M5-01, M5-02, M5-09)

- **Preview and "View help center"** on the artboards need the pages of M5-03 and are not drawn until it lands.
- **Settings › Theme, Home page and links** are M5-06; the Settings tab holds "Who can read it" alone.
- **An image in an internal article** is served by the same public redirect as any other: its address is a UUIDv7 nobody can list, but whoever has it can load it. Tying an image to the visibility of the articles that use it needs a reference table and is left for M5-03 to decide with the page renderer.
- **Article images of a deleted brand** are not yet purged from the bucket by retention (M1-14 knows attachments only).
- **The category and section dialogs** name a new category or section in both languages; there is no artboard for them beyond DESIGN §6.4 Dialog, and renaming an existing one is available over the api only.

## Exit criteria

- [ ] `support.<brand>` answers over TLS with a published article, in both locales, with a valid sitemap.
- [ ] Article search returns results in Arabic and English.
- [ ] RTL snapshot test passes.
- [ ] An internal article never appears in the sitemap, public search, or a `public` cached response, tested after toggling an article from public to internal.

## Open questions

- None yet.

## Pull requests

- Custom domains (M5-07): #131.
- Help center content, the editor and visibility (M5-01, M5-02, M5-09): this branch.
- Search, feedback, Insights and the widget's help center (M5-05, M5-08, M5-10): this branch.
