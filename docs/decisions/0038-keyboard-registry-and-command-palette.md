# 0038 One keyboard registry, physical keys, and a command palette without a new dependency

Status: proposed
Date: 2026-10-20

## Context

Helpdock 1.0 answers to `j`, `k`, `r`, `n` and `Esc` in the ticket workspace
(`apps/admin/src/screens/tickets/keyboard.ts`). Nothing on screen says so, and
two defects sit in it: letters are matched on `event.key`, so on an Arabic
keyboard layout `j` arrives as `ت` and no shortcut works; and single-key
shortcuts cannot be turned off, which WCAG 2.1.4 (Level A) requires. There is
no `?` sheet, no navigation keys and no global search; DESIGN §6.1 already
promises a `⌘K` hint.

M14 adds a shortcut sheet, `g` sequences, ticket and list keys, and a command
palette. The stack table (ARCHITECTURE §1) admits no new UI dependency without
an ADR.

The plan is [M14-01 and M14-05 in M14 Inbox productivity](../in-development/M14-inbox-productivity.md#m14-01-keyboard-foundation);
owner decisions D-03 and D-32.

## Decision

1. **One registry** (`apps/admin/src/keyboard/registry.ts`) names every
   shortcut once: id, keys, scope (global, list, ticket, composer), i18n label
   and required permission. The `?` sheet, the palette's actions, each button's
   `aria-keyshortcuts` and the tooltips read it; a unit test fails when a
   registered shortcut has no handler or a handler has no entry.
2. **Physical keys.** A letter is the one a Latin layout types, and on a
   layout that types no Latin letter (Arabic, Russian) the physical key
   (`event.code`, `KeyJ`) decides, so shortcuts work on every layout and a
   Dvorak or AZERTY user presses the key engraved with the letter the sheet
   shows; `?` matches both `?` and the Arabic `؟` (U+061F). The sheet shows the
   Latin letter, which bilingual keyboards engrave beside the Arabic one.
   (Amended with M14-01: matching on `event.code` alone would have moved
   Dvorak and AZERTY users' letters, which 1.0 already followed since #244.)
3. **A single-key switch** (`users.single_key_shortcuts`, default on, stored on
   the server so it follows the person) turns off every shortcut without a
   modifier, which satisfies WCAG 2.1.4. Shortcuts never fire in a field, a
   select or the rich-text editor; no container takes `role="application"`.
4. **The palette is built on MUI's existing primitives**: a dialog with an
   ARIA 1.2 combobox and a grouped listbox, fed by one quick-search read
   (tickets with the exact-number path first, contacts, articles, each section
   under the reader's own scope), a client registry of pages and settings with
   `en` and `ar` keywords, and actions from the shortcut registry filtered by
   permission. A test walks `route-paths.ts` so no page is missing.
5. **The palette calls no model.** Its actions are a person's actions. The one
   AI hook is M12-13's: Tab hands the typed text to the read-only assistant
   panel (D-03).

## Consequences

- The sheet cannot drift from what the keys do, and the keys work for Arabic
  speakers on their own layout.
- Screen-reader users in browse mode never get letters taken from them; every
  shortcut has a visible button or menu item, and the palette (a modifier
  shortcut) reaches every action.
- No new dependency and no bundle-size surprise in the admin app.
- The existing shortcuts move onto the registry, with a failing test for the
  Arabic layout first, per the bug-fix rule.

## Alternatives considered

- **`cmdk` or a similar palette library:** a new dependency outside the stack
  table for what MUI's dialog, autocomplete and list primitives already do.
- **Keep `event.key` matching with a per-layout map:** brittle and incomplete
  across layouts.
- **Shortcuts off by default:** safer for screen-reader users and worse for
  everyone else; the switch gives the choice (D-32).
- **AI in the palette:** an assistant that proposes changes is M13; the palette
  stays a list of human actions.
