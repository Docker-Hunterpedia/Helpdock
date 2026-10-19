# 0046 Imported macros, SLA policies and automations as disabled drafts

Status: proposed
Date: 2026-10-20

## Context

M11 imports ticket history but leaves configuration behind: its gap note says
macros, automations and SLA policies are not imported, because importing rules that
behave differently from the source is worse than importing none. Teams moving from
Zendesk, Freshdesk, Zoho Desk and the five tools added by
[M16 More importers and undo](../in-development/M16-more-importers-and-undo.md)
then retype dozens of replies, policies and rules from a blank page. Vendors'
placeholder languages, condition sets and SLA matchers do not map one-to-one onto
Helpdock's macros (M3-06), SLA policies (M3-02) and workflow rules (M3-03).

## Decision

1. Macros and canned responses (Zendesk macros, Freshdesk canned responses, Zoho Desk
   templates, Help Scout saved replies, Intercom and Gorgias macros, Front message
   templates, Zammad text modules) import as Helpdock canned responses and macros,
   **disabled**. Placeholders translate where a one-to-one equivalent exists; the
   rest stay visible as `[[unmapped: …]]`. Macro actions map when one-to-one; the
   others are listed.
2. Business hours, holidays and SLA policies (Zendesk, Freshdesk, Zoho Desk, Zammad)
   import **inactive**, with targets per priority and the conditions Helpdock cannot
   express listed. Starting clocks on imported tickets stays the explicit "Start SLA
   clocks" action.
3. Automations (Zendesk triggers and automations; Freshdesk dispatcher, supervisor and
   observer rules) translate through a per-vendor table into the rule schema. A rule
   translates only when **every** condition and action maps; otherwise it is stored
   as a draft marked `needs_review` with the sanitised source JSON for reference.
4. Every imported item carries `imported_from` (source, run, external id,
   untranslated parts) and a review state, and appears on an "Imported settings"
   review screen.
5. **Nothing runs until a person enables it.** Enabling an imported rule runs the
   existing rule test-run first. Imported items that are still disabled and never
   edited are removed by an undo of their run
   ([ADR 0045](0045-import-provenance-ledger-and-undo.md)).

This supersedes M11's gap note on configuration while keeping its reasoning.

## Consequences

- Teams start from their own replies, policies and rules instead of a blank page,
  with every untranslated part shown rather than guessed.
- Per-vendor translation tables are code to maintain as vendors change.
- Stored source JSON is size-capped and rendered as text, never as HTML.
- An admin may still enable a rule without understanding it; the forced test-run and
  the needs-review marking are the guard.

## Alternatives considered

- **Keep leaving configuration behind.** Safe, but the cost of switching stays high.
- **Import and enable what translates.** A rule that behaves slightly differently
  from the source would act on live tickets before anyone checked it.
- **Translate partially and drop unmapped conditions.** Silently widens what a rule
  matches.
