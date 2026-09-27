# M5 Help center

Status: in progress
Started: 2026-09-27
Owner: @Docker-Hunterpedia

## Scope

[PRD, M5 Help center](../planning/PRD.md#m5-help-center). Depends on M1; runs in parallel with M4 (M5-10 waits for M4-05).

## Deliverables

| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M5-01 | Content model: category → section → article, versions per locale,… | #117 | not started |
| M5-02 | Editor (per ADR): rich text, images to WebP, code, callouts, tables, video embed,… | #118 | not started |
| M5-03 | SSR app served by api on brand host; Redis page cache keyed by audience with… | #119 | not started |
| M5-04 | SEO: canonical, hreflang, sitemap per brand, OG, JSON-LD | #120 | not started |
| M5-05 | Search: tsvector per language (`english`, `arabic`) + trigram fuzzy; semantic merge… | #121 | not started |
| M5-06 | Theme tokens, logo, favicon, sanitized custom CSS, header/footer links, home layout | #122 | not started |
| M5-07 | Custom domains: CNAME + TXT verification in admin, `/internal/domain-check` for Caddy… | #123 | in review: DNS verification (`domains` queue, `domain.verify` every 15 min), Caddy `/internal/domain-check`, Cloudflare flag, `BrandHostResolver`, Brand › Domains and General tabs; migration 0030; new env `HELPCENTER_CNAME_TARGET` |
| M5-08 | Article feedback, view counts, "Still need help?" handoff to widget/form with article… | #124 | not started |
| M5-09 | Visibility model: `public`/`internal` on article versions, internal-only help center… | #125 | not started |
| M5-10 | Widget "help center" and "chat + articles" modes wired to real content | #126 | not started |

## Artboards

On the [design canvas](https://claude.ai/artifact/RQd32d1RXK8DST8SKC1VBQ), under "M5 Help center": `HelpCenter/Home-EN`, `HelpCenter/Home-AR`, `HelpCenter/Category-EN`, `HelpCenter/Category-AR`, `Help center · article`, `HelpCenter/Article-AR`, `HelpCenter/Search-EN`, `HelpCenter/Search-AR`, `HelpCenter/States-EN`, `Admin/HelpCenter`, `Admin/HelpCenter-Editor`, `Admin/HelpCenter-Settings`, `Admin/Brand-Domains`. The canvas note beside them records the decisions they settle.

## Exit criteria

- [ ] `support.<brand>` answers over TLS with a published article, in both locales, with a valid sitemap.
- [ ] Article search returns results in Arabic and English.
- [ ] RTL snapshot test passes.
- [ ] An internal article never appears in the sitemap, public search, or a `public` cached response, tested after toggling an article from public to internal.

## Open questions

- None yet.

## Pull requests

- Custom domains (M5-07): this branch.
