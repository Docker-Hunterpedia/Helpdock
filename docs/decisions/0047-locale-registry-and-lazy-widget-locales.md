# 0047 A locale registry, UI and content locales, and lazy widget locale chunks

Status: proposed
Date: 2026-10-20

## Context

Helpdock 1.0 ships English and Arabic everywhere. The two languages are spread
through the code as literals: the `locale` Postgres enum is `('en', 'ar')`,
search and retrieval branch on the `english` and `arabic` text-search
configurations, Zod schemas list the two codes, and the widget bundles both
catalogs. REQUIREMENTS §4.13 says that adding a locale means adding a file; in
practice it means touching every one of those places. A brand also needs to say
which languages its own content is written in, which is a different question
from which languages Helpdock's interface is translated into. The widget's
initial bundle is held to 40 KB (DOMAIN-RULES §14).

Planned in [M17 Apps and languages](../in-development/M17-apps-and-languages.md)
(M17-01, M17-04).

## Decision

1. **One registry.** `packages/i18n/src/locales.ts` lists every locale: code,
   native name, `dir`, CLDR plural categories, font script, Postgres
   text-search configuration (`simple` plus trigram where Postgres has none),
   status `shipped | beta`, and completeness per surface. Zod `localeSchema` and
   `widgetLocaleSchema` are derived from it, and the `locale` enum gains values
   by additive migrations.
2. **UI locales and content locales are separate.** UI locales are the catalogs
   Helpdock ships. Content locales are a brand's `enabled_locales`, for
   articles, canned responses and auto-responders, with `default_locale` among
   them.
3. **Regconfig per locale** through a SQL function `hd_regconfig(locale)`
   generated from the registry, used by help-center search and the ticket
   search tokens instead of two-language branches. Retrieval's locale boost is
   generalised the same way.
4. **Lazy widget locale chunks.** The widget's initial bundle carries `en` and
   the brand's default locale; every other catalog is a lazy chunk of about
   3 KB gzipped. DOMAIN-RULES §14 is amended so that alternative-locale chunks
   count one at a time towards the lazy total, since only one ever loads, with
   a 4 KB cap per chunk.
5. **Completeness gates shipping.** The parity test stays strict for `en` and
   `ar`; other locales may fall back key by key to `en`, and a locale is
   `shipped` on a surface only at 100 % of that surface's keys.

## Consequences

- Adding a locale becomes a registry entry, a catalog and a migration value.
- Languages Postgres has no configuration for (CJK among them) get `simple`
  plus trigram search, which is weaker; the limitation is documented.
- The widget size check gains a per-locale-chunk cap.
- AI quality is evaluated for `en` and `ar` only (DOMAIN-RULES §9); the admin
  marks other brand languages "not evaluated".

## Alternatives considered

- Keep literals and add each locale by hand: every new language would touch the
  schema, search, retrieval and the widget, and they would drift.
- Bundle every widget catalog in the initial script: breaks the 40 KB budget
  after two or three languages.
- One locale list for both UI and content: a brand writing articles in French
  would need a French interface first, or the reverse.
