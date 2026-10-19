# 0054 Several widgets per brand, with an optional widget id in the protocol

Status: accepted (owner decision D-58, 2026-10-20)
Date: 2026-10-20

## Context

A brand has one widget today: one `widget_settings` row keyed by brand
(`packages/db/src/schema/widget-settings.ts`) with its appearance, conversation
settings, allowed origins, CAPTCHA and signed-identity settings. A brand that
runs a store, a docs site and an app wants a different look, a different
department or team, and later a different AI persona (M12-03) on each, without
creating a second brand, which would split its tickets, contacts and reports.
The widget protocol is public and embedded on customers' sites, so a change
must not break existing embeds.

Planned in [M19 Customer surfaces polish](../in-development/M19-customer-surfaces-polish.md)
(M19-02). Whether to do this at all, rather than keep "several brands" as the
answer, is owner decision D-58.

## Decision

1. A new tenant table **`widgets`** (id, brand, name, allowed origins,
   appearance, conversation, a department or team default, an optional persona,
   one default per brand), with `brand_id`, `FORCE`d row-level security and an
   isolation test.
2. Each brand's current `widget_settings` row migrates as its **default
   widget**.
3. The embed tag gains **`data-widget`**; the protocol's configuration route
   accepts an **optional widget id**. Without one, the brand's default widget
   answers, so every existing embed keeps working.
4. **Origin checks are per widget**: an origin allowed on one widget is refused
   on another.
5. CAPTCHA, signed identity and the signing secret stay brand-level in the first
   version; moving any of them per widget is a later decision.

## Consequences

- Per-widget appearance, routing and persona without splitting a brand.
- The widget's Zod schemas, the protocol guide and the admin's Channels screens
  change; the widget list becomes a new screen.
- Every widget path resolves a widget before it reads settings, which tests
  cover for both the default and a named widget.

## Alternatives considered

- **Several brands:** works today, but splits tickets, contacts, reports and
  knowledge that belong together.
- **Per-origin overrides inside one settings row:** keeps one row but turns the
  settings into a matrix that the editor and the protocol both have to resolve.
- **A required widget id:** breaks every existing embed.
