# 0043 Sample data through the import engine, in a flagged sample brand

Status: proposed
Date: 2026-10-20

## Context

Someone evaluating Helpdock sees empty screens until real tickets arrive. Prior art
offers test workspaces with sample data. [M15 Self-host
operations](../in-development/M15-self-host-operations.md) adds "Try with sample
data". Sample tickets must look real (channels, threads, attachments, dates spread
over weeks) without sending anything, triggering rules, starting clocks or polluting
product metrics, and must be removable at once. M11's import writer already loads
tickets with original dates and no side effects
([ADR 0027](0027-imports-through-one-normalised-record-engine.md)).

## Decision

1. A bilingual Helpdock import bundle (`apps/api/sample-data/<v>/{en,ar}.zip`) ships
   in the image: about 40 tickets across email, widget, Telegram, WhatsApp, form and
   API; 25 contacts on reserved domains with invented names; 12 articles in each
   language; macros, rules, an SLA policy, business hours and views.
2. It is loaded **through the M11 `ImportWriter`**, so nothing is sent or triggered.
   Dates are shifted relative to the load time so reports look alive.
3. It goes into its own brand with `brands.is_sample = true` and prefix `SAMPLE`,
   exempt from prefix reservation; a partial unique index allows one per install.
4. While the flag is set, every outbound path refuses at the delivery hooks and the
   AI gateway (email, Telegram, Meta, webhooks, AI calls), connecting channels is
   disabled, the widget has no allowed origins, and product metrics, activation and
   install LLM totals skip the brand. Every screen of the brand shows a persistent
   banner.
5. Remove purges the brand at once through the existing brand purge with no grace
   period, after a confirmation, and is audited.
6. Sample numbers are never mixed into a real brand's charts; a real brand's empty
   Reports links to the sample brand's Reports instead.

## Consequences

- No second seeding path to maintain: the sample data exercises the same writer that
  real migrations use.
- The refusal sits where messages leave, not in the UI, so a rule or a job in the
  sample brand cannot send by another route; each hook has a test.
- The sample content has to be written and reviewed in both languages for each
  version that changes it.

## Alternatives considered

- **Sample rows inside the operator's real brand.** Mixes fiction with real data and
  makes removal a selective delete.
- **A seed script writing through the live creation paths.** Would fire
  auto-replies, rules, clocks and webhooks unless every path learned an exception.
- **Labelled sample figures drawn in place in empty reports.** Not chosen: a separate
  brand shows every screen, not only reports, and keeps real figures untouched.
