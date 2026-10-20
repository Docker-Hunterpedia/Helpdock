# M19 Customer surfaces polish

Status: planned (not started)
Owner: @Docker-Hunterpedia
Phase: 5 — 1.x. Proposed release: 1.2 (owner decision D-01)
Depends on: M2 (email), M4 (widget), M5 (help center); M12-03 (personas, picked per widget once M19-02 lands); M14-12 (profile photo and opt-in, for team faces); M15-11 (sample brand, for M19-08)
Effort: about 47 working days for one person, about 9–10 weeks (see Deliverables)
PRD: [Phase 5 · M19](../planning/PRD.md#m19-customer-surfaces-polish)
Owner decisions: D-56 to D-58 in [decisions-1-x.md](../planning/decisions-1-x.md#m19-customer-surfaces-polish)
ADRs (proposed): [0054](../decisions/0054-several-widgets-per-brand.md), [0055](../decisions/0055-custom-html-email-layout.md)

An email design editor per brand, several widgets per brand with a richer home, help-center polish including phones, and the customer-surface fixes from the 1.0 UX review.

## Why a milestone of its own

This work is an email design editor, widget-editor additions, help-center
polish and a sample-data empty state in Reports, plus the customer-surface
findings of the [1.0 UX review](../completed/ux-review-1-0.md#findings)
(group C). It does not belong in M15 to M17:

- M15 is about the operator and the host.
- M16 is about the import engine.
- M17 is about locales and clients.

Customer-surface design work is a different skill set: artboard-heavy, with the
brand-theming limits of [DESIGN §8](../../DESIGN.md#8-brand-theming) and a widget
data-model change. Mixed into the milestones above, it would slow every one of
them.

**Locales.** M19 is proposed for 1.2 and M17 for 1.3, so M19 lands first. Its
editors and previews read the brand's locales from a list rather than
hard-coding `en` and `ar`, and pick up the M17-01 locale registry when it
lands.

Effort is in working days for one experienced contributor working with AI
agents, with the Definition of done included: tests, docs and review fixes. The
UX review's sizes are converted at S ≤ 1 day, S–M 2 days, M 3 days.

## Goal

A brand's customers see email, a widget and a help center that look like the
brand and answer the first questions before anyone types: replies in the
brand's own layout, a widget home with suggested questions, topics that route
to the right team and an honest reply-time line, a help center that works on a
phone, and an empty Reports screen that shows what it will look like.

## Scope

In scope: M19-01 to M19-09 below.

## Non-goals

- Free-form CSS or remote content in email layouts
  ([ADR 0055](../decisions/0055-custom-html-email-layout.md)).
- Widget changes that push the initial bundle past 40 KB; home extras go in a
  lazy chunk.
- An "ownership transfer" feature: handing over an install is *grant install
  admin, then step down*, and needs a docs line (M19-08), not a feature.
- AI changes: the email ask at an offline handoff (UX-15) is
  [M12-02](M12-ai-workspace.md); the playground and cost estimates (UX-28) are
  M12-04 and M12-08.
- More widget locales: [M17](M17-apps-and-languages.md).

## What exists today

- **Widget:** one `widget_settings` row per brand (`appearance` and
  `conversation` jsonb, allowed origins, CAPTCHA and signed-identity settings;
  `packages/db/src/schema/widget-settings.ts`). The theme tokens, launcher
  (`icon`, `icon+text`, `text`, inline start or end), live preview, pre-chat
  form, business-hours awareness (`whenUnavailable`), transcript by email and
  agent identity are already there (M4-06, M4-08;
  [widget protocol](../guides/widget-protocol.md#configuration) "Configuration").
- **Help center:** theme, logo, favicon, light/dark/auto, sanitised custom CSS
  ([help-center guide](../guides/help-center.md), "Help center › Settings").
- **Email:** one fixed layout. Auto-responder templates are subject and plain
  text per locale with `{{…}}` placeholders
  ([outbound-email guide](../guides/outbound-email.md)). There is no designer,
  no preview and no test send for the reply layout.
- **Owner hand-over and deletion:** several install admins are possible, with a
  floor so the last one keeps access ([staff guide](../guides/staff-and-roles.md)),
  and brand deletion has a 30-day grace (M8-07).

## Deliverables

| Id | Deliverable | Spec | Effort (d) | Depends on |
|---|---|---|---|---|
| M19-01 | **Email design editor per brand** (Brand › Email design).<br>• Two modes:<br>  – **Simple**: logo on or off, accent from the brand token, font from the DESIGN §8 curated list, footer text per locale, Plain or Branded layout.<br>  – **Custom HTML**: one layout template with `{{content}}`, `{{signature}}` and `{{brand.*}}` slots, run through the M2-07 email sanitiser (no scripts, forms or remote fonts) and size-capped (D-56).<br>• Tabs: Replies, Auto-replies, Satisfaction email, Variables (a reference list).<br>• **Live preview** with sample data at desktop and mobile widths, in `en` and `ar` (RTL).<br>• **Send test** to the editor's own address through the outbox.<br>• Text alternative generated from the HTML.<br>• Added after the prior-art sweep of 2026-10-20 (+1 d): the footer accepts the same placeholders as signatures and canned responses (M14-12, M14-14: one pass over a fixed list with fallbacks, no logic language); the Satisfaction email tab edits the survey email's subject and body, the ticket reference is added to the subject for threading, and a body without the survey link placeholder is refused on save; the Variables tab lists every placeholder with a sample value and a copy button. | R §4.4; ADR 0055 | 11 | — |
| M19-02 | **Several widgets per brand** (D-58). A new `widgets` table (id, brand, name, allowed origins, appearance, conversation, department or team default).<br>• The current row migrates as the brand's default widget.<br>• The embed tag gains `data-widget`; the widget protocol's configuration route accepts an optional widget id, and old embeds keep working with the default.<br>• Origin checks per widget; RLS on the new tenant table; widget-protocol docs and Zod schemas updated.<br>• Each widget may name its own AI persona (M12-03) and its own department default, which answers D-29 (the widget's department). | R §4.6; ADR 0054 | 8 | — |
| M19-03 | **Widget home additions** (CS-03, UX-16):<br>• up to 4 **suggested questions** per locale, which start a conversation or open an article;<br>• **topics before the first message**, each routing to a department or team (reuses the pre-chat form's routing);<br>• **team faces**: up to 3 staff avatars, available first, only for staff who opted in on Me › Profile (M14-12; D-57);<br>• a **reply-time subtitle** from the brand's real median first response over the last 14 days (the `stats.rollup` data), falling back to a custom text;<br>• "reply by email when you leave" when no agent answers within N minutes (the offline state);<br>• a help search and the visitor's last conversation on the home (UX-16).<br>All within the widget's 40 KB budget: home extras go in a lazy chunk. | R §4.6; D §14 | 9 | M19-02, M14-12 |
| M19-04 | **Widget editor live preview with real states:** Launcher, Home, Chat, Offline, in light and dark, `en` and `ar`, rendered by the real widget bundle in an isolated frame with fixture data (no API calls to the live brand). Extends M4-06's preview. | R §4.6 | 4 | M19-03 |
| M19-05 | **Help center polish:** a visitor theme toggle (persisted locally, honours `prefers-color-scheme`), a "How can we help?" search hero option on the home layout, a designed empty state for a help center with no published articles, and per-brand title and meta description. Also, after the prior-art sweep of 2026-10-20 (+1 d): changing a published article's slug warns that links to the old address will move, and the old slug keeps answering with a permanent redirect to the new one (per locale, until the article is deleted). | R §4.5 | 5 | — |
| M19-06 | **Help center on phones: header and section nav** (UX-14). Below 1024 px the section nav becomes a `<details>` or `<select>` after the breadcrumb, with no JavaScript (DESIGN §6.7 already says it collapses). On a phone the categories move into a scrollable row or behind a `<details>` "Menu", and the language link stays on the first row. | DESIGN §6.7 | 2 | — |
| M19-07 | **Widget captions and phone controls** (UX-15, UX-27). When auto-reply is on, the header caption reads "Our assistant answers now · the team follows up" instead of promising email to a visitor who never gave one. The phone layout's close control becomes `ChevronDown` (or `X`) with the same accessible name, "Minimise chat". The email ask at an offline handoff is M12-02. | R §4.6 | 1 | — |
| M19-08 | **Reports empty state linked to the sample brand** (CS-06, UX-25): a brand with no tickets offers "See reports with sample data", which opens the sample brand's Reports (M15-11); sample numbers are never mixed into a real brand's charts. Also a docs line, "Handing over an install", in the staff guide. | R §4.8 | 1 | M15-11 |
| M19-10 | **Quoted history in reply emails.** Today a public reply's email carries only the new message. A per-brand setting in Email design chooses what follows it: nothing, or the previous public message, quoted under a **quote line** built from a template with placeholders (default "On {{message.date}}, {{message.author}} wrote:", in the reply's language). Internal notes are never quoted, and nothing from another ticket is. The quote is rendered by the same sanitiser and layout as the reply and is part of the preview. Found in the prior-art sweep of 2026-10-20. | R §4.4 | 2 | M19-01 |
| M19-09 | **Docs and tests:** the outbound-email, channels, widget-protocol, help-center and DESIGN §6.6/§8 updates; Playwright `en`/`ar` with axe for every editor and widget state; widget size check; RLS negative suite for `widgets`. | AGENTS DoD 1 | 4 | all |

**Total: about 47 days** (the drafted 40 for M19-01 to M19-05, M19-08 and
M19-09, plus 3 for the UX review's group C items M19-06 and M19-07, and 4 for
the prior-art additions to M19-01 and M19-05 and the new M19-10).

## Data model

One migration, numbered with the next free number at implementation time
(`0054_imports` is the last shipped).

- `widgets` (tenant table, `brand_id`, `FORCE`d RLS, in `TENANT_TABLES` with an
  isolation fixture): `id`, `brand_id`, `name`, `allowed_origins`,
  `appearance jsonb`, `conversation jsonb`, a department or team default, an
  optional persona (M12-03), `is_default` (one per brand), timestamps. The
  current `widget_settings` row migrates as the default widget; which of its
  other columns (CAPTCHA, signed identity, signing secret) stay per brand is
  settled in [ADR 0054](../decisions/0054-several-widgets-per-brand.md).
- Widget home settings (suggested questions per locale, topics with their
  routing, team faces on or off, reply-time fallback text, the offline delay)
  live in the widget's `conversation` jsonb, Zod-parsed.
- Email design per brand: mode (`simple` \| `custom`), the Simple settings,
  and the sanitised custom template, in the brand's settings, Zod-parsed and
  size-capped.
- Team faces read the M14-12 profile photo and a per-person opt-in.

## Security and privacy

- **Custom HTML email** passes the M2-07 sanitiser on save and on render: no
  scripts, forms, remote fonts or remote content; a size cap; the Plain layout
  is used when a template fails validation.
- **Several widgets** keep the origin allow-list per widget; a widget id in the
  protocol never widens what an origin may reach; RLS covers `widgets`.
- **Team faces** show only staff who opted in, defaulting to off (D-57).
- **The reply-time subtitle** shows an aggregate (the median), never an
  individual's figures.
- **The widget preview** renders fixture data in an isolated frame and makes no
  call to the live brand.
- **Send test** goes to the editor's own address only, through the outbox.

## Design artboards

Drawn by the orchestrating session on the design canvas before the screens are
built; customer-facing ones in `en` and `ar`.

| Artboard | For | Must show |
|---|---|---|
| `Admin/Brand-EmailDesign` | M19-01, M19-10 | Simple and Custom HTML modes, the footer with placeholders, the Satisfaction email and Variables tabs, the quoted-history setting and quote line, preview at both widths, test-send states, EN and AR preview |
| `Email/Reply-Branded-EN-AR` | M19-01 | A reply in the Branded layout in both languages |
| `Admin/Channels-Widgets` | M19-02 | The list of widgets per brand, the default, add |
| `Admin/Widget-Editor` | M19-02 to M19-04 | Sections and the live preview with its state switcher |
| `Widget/Home-Suggested-EN`, `-AR` | M19-03 | Home with suggested questions, help search, last conversation, team faces, reply-time subtitle |
| `Widget/Topics-EN`, `-AR` | M19-03 | Topics before the first message |
| `Widget/Offline-EN`, `-AR` | M19-03 | "Reply by email when you leave" |
| `Widget/States` (update), en and ar | M19-07 | The caption with auto-reply on; the phone header's close control |
| `HC/Home-SearchHero` | M19-05 | The search hero option |
| `HC/Empty` | M19-05 | A help center with no published articles |
| `Admin/HelpCenter-ArticleSlug` | M19-05 | The slug field's warning when a published article's address changes |
| `HelpCenter/Mobile-EN`, `-AR` | M19-06 | Phone header with the language link on the first row, categories row or Menu, section nav as a select or details |
| `Admin/Reports-Empty` | M19-08 | The empty state with "See reports with sample data" |

## Tests

- **Unit:** the email template validator (allowed slots, refused markup, size
  cap, Plain fallback); the text alternative; widget id resolution with the
  default; suggested-question and topic schemas; the reply-time median and its
  fallback; the quote-line template and "never a note" rule; the satisfaction
  body's required survey link; the slug redirect table.
- **Integration (Testcontainers):** `widgets` RLS isolation (brand A cannot read
  brand B's widgets) in the D §1.6 suite; the migration turns each brand's
  `widget_settings` row into its default widget; an old embed without
  `data-widget` gets the default; an origin allowed on one widget is refused on
  another; a topic routes the new ticket to its department; Send test goes
  through the outbox to the editor only; a reply email carries the quoted
  previous public message and no note; an old article slug answers with a
  permanent redirect.
- **Browser (Playwright, `en` and `ar`, axe):** the email design editor in both
  modes with preview and test send; the widgets list and editor with every
  preview state; the widget home, topics, offline and phone close control in
  `apps/widget/e2e/`; the help center on a phone viewport, without JavaScript
  for the section nav; the Reports empty state.
- **Size:** widget initial bundle ≤ 40 KB; the home chunk within its lazy cap
  (D §14).

## Docs

Listed in M19-09: `outbound-email.md` (email design), `channels.md` and
`widget-protocol.md` (several widgets, the optional widget id, the home),
`help-center.md` (theme toggle, search hero, phones), `reports.md` (the empty
state), `staff-and-roles.md` ("Handing over an install"), DESIGN §6.6 and §8,
OpenAPI.

## ADRs

- **[0054](../decisions/0054-several-widgets-per-brand.md)**, several widgets
  per brand and the protocol's optional widget id (backward compatible).
- **[0055](../decisions/0055-custom-html-email-layout.md)**, a custom HTML email
  layout behind the existing sanitiser, which records why there is no
  free-form CSS or remote content.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Custom HTML email breaks rendering in some clients, or tries to get past the sanitiser | Medium | The sanitiser, a size cap, a preview, and a Plain layout fallback when the template fails validation |
| Team faces expose staff identities | Medium | Opt-in per staff member, default off |
| The widget outgrows 40 KB | High | A lazy home chunk and the CI size check |
| Several widgets per brand complicate the protocol and every widget path | Medium | The widget id is optional and defaults to the brand's default widget; old embeds keep working; tests cover both |

## Open questions

1. (D-56) Is **Custom HTML email** wanted at all, or only Simple (lower risk)?
2. (D-57) Should **team faces** default to off for every staff member?
   Proposed: yes.
3. (D-58) **Several widgets per brand**, or several brands as today's answer?
   The data-model change is the expensive part.

## Build order

1. M19-02 (the data model the widget work builds on), in parallel with M19-01,
   M19-05, M19-06 and M19-07.
2. M19-03, then M19-04.
3. M19-08 once M15-11 has shipped.
4. M19-10 after M19-01.
5. M19-09 alongside each deliverable, closed last.

## Exit criteria

- [ ] A brand admin designs the reply layout in Simple mode, previews it at
      desktop and mobile widths in `en` and `ar`, sends a test to their own
      address, and customers' replies use it; a Custom HTML template with a
      script or remote font is refused and the Plain layout is used.
- [ ] A brand runs two widgets on two origins with different appearance and
      department defaults; an embed without `data-widget` still gets the
      brand's default; an origin allowed on one widget is refused on the other.
- [ ] The widget home shows suggested questions, a help search, the last
      conversation, opted-in team faces and the reply-time subtitle; a topic
      routes the conversation to its department; with no agent answering, the
      visitor is offered a reply by email.
- [ ] The widget editor previews Launcher, Home, Chat and Offline in light and
      dark, `en` and `ar`, without calling the live brand.
- [ ] The help center offers a theme toggle, the search hero and an empty
      state; on a phone the language link stays on the first row and the
      section nav is a select or details that works without JavaScript.
- [ ] With auto-reply on, the widget caption no longer promises email; the
      phone close control is a down chevron or X named "Minimise chat".
- [ ] A brand with no tickets can open Reports with sample data, which never
      mixes into its own charts.
- [ ] A reply email quotes the previous public message under the brand's quote
      line and never quotes a note; a satisfaction email without the survey
      link is refused on save.
- [ ] A published article whose slug changed still answers at its old address
      with a permanent redirect.
- [ ] Brand A cannot read brand B's `widgets` rows (DOMAIN-RULES §1.6).
- [ ] The widget's initial bundle is still ≤ 40 KB, and the home chunk is
      within its cap.
- [ ] Every new or changed screen passes Playwright in `en` and `ar` with axe.
