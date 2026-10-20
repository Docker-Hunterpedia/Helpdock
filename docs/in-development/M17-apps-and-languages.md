# M17 Apps and languages

Status: planned (not started)
Owner: @Docker-Hunterpedia
Phase: 5 — 1.x. Proposed release: 1.3 (owner decision D-01)
Depends on: M4 (widget protocol), M3-07 (web push), M5 (help center)
Effort: about 59 working days for one person, about 12 weeks; 6 weeks of calendar time with parallel tracks (see Deliverables)
PRD: [Phase 5 · M17](../planning/PRD.md#m17-apps-and-languages)
Owner decisions: D-46 to D-49 in [decisions-1-x.md](../planning/decisions-1-x.md#m17-apps-and-languages) (the split from M20 is D-02)
ADRs (proposed): [0047](../decisions/0047-locale-registry-and-lazy-widget-locales.md), [0048](../decisions/0048-translations-through-hosted-weblate.md), [0049](../decisions/0049-installable-admin-before-native-agent-apps.md)

More locales on the customer surfaces and then the admin, a contributor translation workflow, and Helpdock as an installable app on desktop and phone with mobile agent layouts.

## Why M20 is a separate milestone

The draft for this area covered about 105 person-days in four tracks and
recommended running it as two milestones. This plan does so: M17 holds the
languages track and the installable desk (about 59 days), and
[M20 Native clients and SDKs](M20-native-clients-and-sdks.md) holds the widget
client, the React Native and Flutter SDKs and the desktop shell (about 45–57
days). The second half is a milestone of its own, not "M17b", because
deliverable ids, issues and GitHub milestones follow `M<n>-<nn>` and a letter
suffix would break that, and because the two halves have different
dependencies, exit criteria and release timing: M17 is proposed for 1.3, and
M20 waits until the PWA from M17-06 has shown demand. The owner confirms the
split in D-02.

Effort is in working days for one experienced contributor working with AI
agents, with the Definition of done included: tests, docs and review fixes.
Calendar time with agents will be shorter, but review and translator time are
human time that agents do not shorten. Translator time is not counted.

## Goal

The people Helpdock serves read it in their own language: first the
customer-facing surfaces, then the agent app. Contributors can translate
without touching code. Agents get Helpdock as an installable app on desktop and
phone, with notifications and a badge, without the project running any push
service.

## Recommended order (value per effort)

1. **Customer-facing locales** (widget, help center chrome, CSAT page, web form,
   customer emails): about 450 strings per locale and the widest reach. The
   work is mostly translation once the infrastructure exists.
2. **Installable admin (PWA) and mobile agent layouts**:
   - Web push and a service worker already exist
     ([ADR 0002](../decisions/0002-web-push-via-vapid.md),
     `apps/admin/public/sw.js`).
   - The manifest and the Badging API make Helpdock installable on Chrome and
     Edge (desktop and Android) and Safari (macOS "Add to Dock", iOS home
     screen with push on 16.4+).
   - Mobile layouts are the real work.
   - This one track covers most of what a desktop shell or a phone app would
     give an agent, at a fraction of the cost.
3. **Admin app locales**: about 5,800 strings across 29 namespaces; the large
   translation effort, so it comes after the workflow has proved itself on the
   customer surfaces.
4. Later, in M20: the headless widget client and the React Native SDK, then the
   desktop shell, with Flutter community-led.
5. **Native iOS and Android agent apps: not in 1.x.** A native app needs APNs
   and FCM keys owned by the publisher, and therefore a push relay the project
   would have to run. That is a hosted service, against the self-hosted
   principle ([ADR 0049](../decisions/0049-installable-admin-before-native-agent-apps.md)).

## Scope

In scope: track D (languages, M17-01 to M17-05), track A (the installable desk,
M17-06 to M17-08) and docs (M17-09).

## Non-goals

- Native agent apps.
- A project-run push relay.
- The widget client, the React Native and Flutter SDKs, and the desktop shell:
  [M20](M20-native-clients-and-sdks.md).
- Offline ticket data in the PWA (the service worker caches the app shell
  only).
- Per-department language routing (backlog).
- Machine-translated catalogs shipped without human review.
- AI quality claims for languages without an eval set: auto-reply works in any
  language the model speaks, but the admin labels other languages "not
  evaluated" (DOMAIN-RULES §9 covers `en` and `ar` only).
- Arabic-Indic and Persian digits (DESIGN §7 keeps them a later setting).

## What exists today

- `packages/i18n` holds 29 namespaces per locale (`packages/i18n/locales/en/*.json`),
  `en` and `ar`, with a strict parity test.
- The `locale` Postgres enum is `('en', 'ar')` (`packages/db/src/schema/enums.ts`)
  and 12 columns in `packages/db/src/schema` use it; brands carry
  `default_locale`.
- The widget ships a catalog-compatible translator and lazy chunks
  ([ADR 0012](../decisions/0012-widget-bundle-shape.md)).
- The admin registers a service worker for web push (`apps/admin/public/sw.js`,
  ADR 0002); `push_subscriptions` is an install-scope table.

## Deliverables

**Track D — languages**

| Id | Deliverable | Spec | Effort (d) | Depends on |
|---|---|---|---|---|
| M17-01 | **Locale registry and plumbing.**<br>• `packages/i18n/src/locales.ts` is the single registry: code, native name, `dir`, CLDR plural categories, font script, Postgres text-search config (`english`, `arabic`, `french`, `spanish`, `german`, `portuguese`, `turkish`, `indonesian` …, and `simple` plus trigram for languages Postgres has no config for), status `shipped \| beta`, and per-surface completeness.<br>• Zod `localeSchema` and `widgetLocaleSchema` are derived from it; `locale` Postgres enum values are added by migration (`ALTER TYPE … ADD VALUE`).<br>• Two concepts kept apart: **UI locales** (catalogs shipped) and **content locales** (`brands.enabled_locales`, for articles, canned responses and auto-responders).<br>• Browser-language negotiation (`navigator.languages` → registry) in the widget and help center.<br>• Widget catalogs other than `en` and the brand default become **lazy chunks** (about 3 KB gzipped each), with the DOMAIN-RULES §14 amendment and the size check counting one alternative-locale chunk.<br>• Help center hreflang, sitemap and language switcher for N locales.<br>• Email templates (auto-acknowledgement, transcript, CSAT) per locale with `en` fallback.<br>• The parity test stays strict for `en`↔`ar`; other locales may fall back key by key to `en`, and a locale reaches `shipped` on a surface only at 100 % of that surface's keys. | R §4.13, D §5, §14; ADR 0047 | 10 | — |
| M17-02 | **Translation workflow**, [ADR 0048](../decisions/0048-translations-through-hosted-weblate.md) (recommended: Hosted Weblate on its free plan for libre projects).<br>• One component per namespace, in i18next JSON v4 format.<br>• Weblate opens PRs to a `translations` branch, and CI runs catalog checks: JSON validity, `{{placeholder}}` parity with `en`, CLDR plural keys, **no markup** (catalog strings are text), length budget for widget keys, no new keys that are not in `en`.<br>• A glossary of Helpdock terms; artboard snapshots from `docs/design/screens/` as screenshot context.<br>• `CONTRIBUTING.md` section, and a CODEOWNERS reviewer per language. `ar` stays maintainer-reviewed.<br>• Machine suggestions allowed in the editor, but a string ships only once approved by a reviewer. | AGENTS i18n rule | 4 | M17-01 |
| M17-03 | **Wave 1 customer-facing locales.** Proposed: `fr`, `es`, `de`, `pt-BR`, `tr`, `id` and **`fa`** (a second RTL language, to prove the RTL work is not Arabic-specific; IBM Plex Sans Arabic's Persian coverage to be checked, D-49).<br>• Surfaces: `widget`, `hcSite`, `helpCenter` (public parts), `csat`, `webform` and customer email templates. About 450 strings per locale.<br>• Engineering per locale: registry entry, fonts (IBM Plex Sans covers the Latin-script ones), Playwright smoke and an RTL snapshot for `fa`.<br>• Translator time is not counted: it is community or paid (D-48). | R §4.13 | 8 | M17-01, M17-02 |
| M17-04 | **Content locales for the help center and knowledge.**<br>• Articles, sections and categories in any enabled content locale, with the fallback locale.<br>• Search with the registry's text-search config, and `simple` plus `pg_trgm` for CJK, with a documented limitation.<br>• Retrieval's locale boost generalised from `en`/`ar`.<br>• The M11 importers stop skipping articles in enabled locales (their "other languages skipped" gap closes for those).<br>• AI admin shows "not evaluated" for a brand language without an eval set. | D §5, §8, §9 | 6 | M17-01 |
| M17-05 | **Admin app locales.** Infrastructure is ready from M17-01; this is the integration of the first one or two admin locales once Weblate reaches 100 % on all 29 namespaces (about 5,800 strings), the language picker in Me, and screenshot tests per new locale on the reference screens. Likely candidates are the first wave's most complete languages. | R §4.13 | 5 | M17-02, M17-03 |

**Track A — the installable desk**

| Id | Deliverable | Spec | Effort (d) | Depends on |
|---|---|---|---|---|
| M17-06 | **Admin PWA.**<br>• `manifest.webmanifest` served by the api per install (name, colours from DESIGN tokens, maskable icons, `display: standalone`, `shortcuts`: My open, Unassigned, New ticket).<br>• Service worker extended to cache the **app shell only** (hashed assets); API responses never cached; caches cleared on sign-out.<br>• **Badging API** (`navigator.setAppBadge(unread)`) driven by the notification bell's count.<br>• Notification click focuses or opens the ticket.<br>• "Install Helpdock" entry in Me › Notifications with the iOS home-screen instructions.<br>• Per-device push list with Remove in Me › Notifications (push subscriptions get a device label and last-used date). | R §4.9, ADR 0002, ADR 0049 | 5 | — |
| M17-07 | **Mobile agent layouts** (below 600 px, and DESIGN §6.5's breakpoints extended), built on M14-22's list-first narrow layout:<br>• ticket list with views switcher;<br>• ticket thread;<br>• composer (reply, note, macro, attachment);<br>• details as a bottom sheet (status, priority, assignee, department, tags);<br>• notifications;<br>• a bottom navigation (Tickets, Notifications, Search, Me).<br>Settings and admin pages show an "Open on a larger screen" state rather than a squeezed layout. New components (BottomNav, BottomSheet) are added to DESIGN.md §6 in the same PR. | DESIGN §6.5, §10 | 13 | M17-06, M14-22 |
| M17-08 | **Push on installed apps**: a test matrix (Chrome and Edge desktop, Android Chrome, macOS Safari Add-to-Dock, iOS 16.4+ home screen), payload deep links, and documenting the iOS and EU limitations already noted in ADR 0002. A Playwright check on the subscription and click routing (push delivery itself stays a manual matrix). | ADR 0002 | 3 | M17-06 |

**Cross-track**

| Id | Deliverable | Spec | Effort (d) | Depends on |
|---|---|---|---|---|
| M17-09 | **Docs:**<br>• `translating.md` (contributors);<br>• `languages.md` (operators: enabling content locales, search limits, AI evaluation coverage);<br>• `install-the-app.md` (the PWA per platform; M20 adds desktop downloads);<br>• `CONTRIBUTING.md` translation section;<br>• DESIGN.md §6 additions and the §7 note for `fa`; DOMAIN-RULES §14; ARCHITECTURE §1 (translation platform) and §2. | AGENTS DoD 1 | 5 | all |

**Totals:** track D 33 days, track A 21 days, docs 5 days: about **59 days**
(about 12 weeks for one person; about 6 weeks of calendar time with the two
tracks in parallel).

## Data model

One migration, numbered with the next free number at implementation time
(`0054_imports` is the last shipped).

- **`locale` enum**: new values per shipped locale (additive
  `ALTER TYPE … ADD VALUE`, outside a transaction as Postgres requires; the
  migration runner already handles separate statements). Every column that
  uses it (12 in `packages/db/src/schema`) accepts the new values with no
  further change.
- **Per-brand locales**: `brands.enabled_locales locale[] not null default '{en}'`,
  backfilled from today's `en`/`ar` use, with a check that `default_locale` is
  in it.
- **Search configuration**: `help_center_search` and `ticket_search_tokens`
  resolve their regconfig through a SQL function `hd_regconfig(locale)`
  generated from the registry, rather than the current two-language branches.
- **Push devices**: `push_subscriptions` (the existing M3-07 table) gains
  `device_label varchar(80)` and `last_used_at`.
- **No new tenant tables.** The public `client-config` route and the native
  sign-in exchange used by the desktop shell belong to
  [M20](M20-native-clients-and-sdks.md).

## Domain rules to add or change (proposed)

These land in DOMAIN-RULES with the deliverables, not now.

- **§14 Performance test conditions** (M17-01): alternative-locale widget
  chunks count one at a time towards the 100 KB lazy total, because only one
  ever loads; each locale chunk is capped at 4 KB gzipped.
- **§5 and §8** (M17-04): search and retrieval use the registry's text-search
  configuration per content locale.

## Security and privacy

- **Translations are untrusted input.**
  - Catalogs are text only; CI rejects HTML, `<`, `javascript:` and
    placeholders not present in `en`.
  - `<Trans>` components keep markup in code.
  - Email templates escape catalog strings (existing renderer rule).
  - Weblate PRs need a maintainer approval; its access is limited to opening
    PRs on one branch, never pushing to `main`.
- **PWA:**
  - No caching of API responses or attachments, so nothing is left on shared
    devices.
  - Cache and push subscription are dropped on sign-out and on "log out
    everywhere".
  - Manifest and service worker are served same-origin with the existing CSP.
  - Push payloads stay VAPID-encrypted (ADR 0002).
- **Locales and RLS**: no new tenant data. `enabled_locales` changes are
  `brand:manage` and audited.

## Design artboards

Drawn by the orchestrating session on the design canvas before the screens are
built.

| Artboard | For | Must show |
|---|---|---|
| `Widget/Locale-FA` and `HC/Article-FA` | M17-03 | The Persian RTL rendering of chat and an article, digits and mixed text per DESIGN §7 |
| `HC/LanguageSwitcher` | M17-01 | Switcher for 2 to 13 locales, current marked, native names, mobile variant |
| `Admin/Brand-Languages` | M17-01, M17-04 | Enabled content locales, default, per-locale article counts, "AI not evaluated" note |
| `Admin/Me-Language` | M17-05 | Admin language picker with beta labels |
| `Admin/Me-InstallApp` and `Admin/Me-Devices` | M17-06, M17-08 | Install instructions per platform; push device list with Remove |
| `Admin/Mobile-TicketList`, `-Ticket`, `-Composer`, `-Details`, `-Notifications`, `-LargeScreenOnly`, each in **EN and AR** | M17-07 | The mobile agent flows; BottomNav and BottomSheet as new DESIGN §6 components |

## Tests

- **Unit:**
  - registry negotiation (`fa-IR` → `fa`, `pt` → `pt-BR`, `zh-TW` → none);
  - plural selection per locale;
  - the catalog lint rules;
  - `hd_regconfig` mapping;
  - badge count logic.
- **Integration:**
  - an article search in each content locale against real Postgres;
  - email templates rendering per locale with fallback.
- **Size:** widget initial bundle still ≤ 40 KB, each locale chunk ≤ 4 KB
  gzipped (new cap in DOMAIN-RULES §14).
- **Playwright:**
  - each wave-1 locale's widget and help-center smoke, with axe;
  - `fa` RTL snapshot against the mirrored `en` baseline (DESIGN §7's method);
  - mobile viewport projects (iPhone 15 and Pixel 8 emulation) for every
    M17-07 flow in `en` and `ar`;
  - PWA manifest and service-worker checks (no API response in Cache Storage
    after a session).
- **Manual matrix recorded in the milestone doc:** push on the platforms in
  M17-08.

## Docs

Listed in M17-09.

## ADRs

- **[0047](../decisions/0047-locale-registry-and-lazy-widget-locales.md)**, locale
  registry, UI vs content locales, regconfig per locale, and lazy widget locale
  chunks (with the DOMAIN-RULES §14 amendment).
- **[0048](../decisions/0048-translations-through-hosted-weblate.md)**,
  translation platform: Hosted Weblate. It is a contributor service, not a
  runtime dependency, but it gains PR access, so it is recorded. Crowdin was
  considered and rejected: proprietary, though free for open source. Weblate is
  itself open source and self-hostable, which fits AGPL Helpdock.
- **[0049](../decisions/0049-installable-admin-before-native-agent-apps.md)**,
  installable admin (PWA) before native agent apps, and no push relay in 1.x.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Translations stall below 100 %, so locales never ship | Medium | Customer surfaces first (small); `beta` status lets a brand opt in to a locale at 90 % or more with `en` fallback (owner choice, D-48); paid translation for wave 1 if needed |
| A wrong translation on a customer surface (legal, CSAT wording) | Medium | Reviewer per language, glossary, screenshot context, and per-brand overrides of individual widget strings (already possible in widget settings for greeting texts; extend only if asked) |
| Widget bundle grows with locales | High | Locale chunks are lazy, with a size cap per chunk in CI |
| Search in CJK is poor with `simple` | Low | Documented; trigram fuzzy helps; Japanese and Chinese placed in wave 2 |
| Mobile layouts fork the admin UI | Medium | Same components, responsive breakpoints, two new components only, screenshot tests at mobile size |
| iOS PWA push is unreliable (EU DMA changes) | Medium | Stated in the UI (ADR 0002), with email and in-app as fallbacks |

## Open questions

1. (D-02) **Split** this area into M17 "Apps and languages" and M20 "Native
   clients and SDKs" (done in this plan), or keep one milestone?
2. (D-46) **Wave 1 locales:** is `fr, es, de, pt-BR, tr, id, fa` right for
   Helpdock's audience? Is Urdu or Hebrew wanted early (RTL), or Hindi and
   Bengali for South Asia?
3. (D-47) Is **Weblate** (hosted, free for libre projects) acceptable, or should
   the project self-host Weblate, or keep PR-only translation?
4. (D-48) Should locales below 100 % be offered as **"beta"** to brands, or
   hidden until complete? Is paid translation acceptable for wave 1?
5. (D-49) **Fonts:** does IBM Plex Sans Arabic cover Persian and Urdu well
   enough to stay the default face for them? (Coverage to be verified.) DESIGN
   §8's curated brand fonts already include **Vazirmatn**, which is
   Persian-first and could become the admin default for `fa` instead.

## Build order

1. M17-01, then M17-02, then M17-03 and M17-04, in parallel with M17-06, then
   M17-07 and M17-08.
2. M17-05 when admin catalogs reach the threshold, which can trail the
   milestone.
3. M17-09 grows with each.

## Exit criteria

- [ ] The widget, help center, CSAT page, web form and customer emails are
      shipped in the wave-1 locales. A visitor whose browser asks for one gets
      it, with no layout regression, and `fa` passes the mirrored RTL snapshot
      test.
- [ ] The widget's initial bundle is still ≤ 40 KB, and each locale chunk is
      within its cap.
- [ ] Contributors can translate through Weblate, and CI rejects a catalog
      string with markup or a broken placeholder.
- [ ] Articles in an enabled content locale are searchable in that locale, and
      the AI admin marks unevaluated languages.
- [ ] Helpdock installs as an app on Chrome or Edge desktop, Android and iOS
      16.4+. It shows an unread badge, a push opens the ticket, and no API
      response is in Cache Storage after sign-out.
- [ ] An agent can triage, reply, note, assign and close a ticket on a 390 px
      screen, in `en` and `ar` (Playwright mobile projects with axe).

## External dependencies

| Needed for | Dependency | Owner | Status |
|---|---|---|---|
| M17-02 | A Weblate project (Hosted Weblate, libre plan) | @Docker-Hunterpedia | needed |
| M17-03, M17-05 | Translators, community or paid, for wave 1 (D-48) | @Docker-Hunterpedia | needed |
| M17-08 | An iOS device and an Android device for the push matrix | @Docker-Hunterpedia | needed |
