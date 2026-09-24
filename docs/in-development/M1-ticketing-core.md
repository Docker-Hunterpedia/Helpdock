# M1 Ticketing core

Status: in progress
Started: 2026-09-19
Owner: @Docker-Hunterpedia

## Scope
[PRD §4 · M1 Ticketing core](../planning/PRD.md#m1-ticketing-core). Depends on M0 (shipped 2026-09-19). Goal: agents can work tickets with Zoho-style discipline before any customer-facing surface exists.

Artboards on the design canvas for this milestone: `Admin · ticket view` (list + thread + details, from the foundations row), `Admin/Contacts`, `Admin/Contact`, `Admin/Ticketing` (settings tabs; the Statuses tab is drawn in full and the other tabs follow its list-plus-side-editor pattern). Screens not yet drawn must be requested before implementation (design-first rule).

## Deliverables
| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M1-01 | Brands | #45 | in review (#66) |
| M1-02 | Tickets | #46 | in review (#63) |
| M1-03 | Messages | #47 | in review (#63) |
| M1-04 | Contacts and accounts | #48 | in review (#64) |
| M1-05 | Views | #49 | planned |
| M1-06 | Tags, custom fields (text, number, date, select | #50 | in review (#72) |
| M1-07 | Assignment | #51 | planned |
| M1-08 | Ticket state machine | #52 | in review (#69) |
| M1-09 | Merge and split with the exact semantics in D §2.4 | #53 | planned |
| M1-10 | Media pipeline | #54 | in review (#71) |
| M1-11 | Spam | #55 | planned |
| M1-12 | Time tracking (toggle), CSAT model and rating page with | #56 | done in branch, awaiting PR |
| M1-13 | Contact identity rules | #57 | planned |
| M1-14 | Data retention settings per brand and nightly | #58 | planned |
| M1-15 | Admin UI for all of the above; ticket list index set | #59 | in review (#70) — the M1-02/03/04 surfaces: list, thread, composer, details, creation, realtime. M1-05/06/08/09/10 extend it |

## Exit criteria
Copied from the PRD, ticked as they are met.
- [ ] An agent can create, assign, reply to, note, tag, merge, split and close tickets in the admin UI, in English and Arabic.
- [ ] An Agent cannot see or open a ticket in another department, by list, by direct URL, by contact timeline, or by socket room.
- [ ] Every transition in DOMAIN-RULES §2.2 and each reopen policy value has a test.
- [ ] Every new tenant table has brand and, where applicable, department RLS policies and is covered by the negative test suite.
- [ ] Ticket list of 50k seeded tickets loads under 150 ms p95 under the D §14 conditions.

## Open questions
- Should a Team Leader read only their own departments' rows of the staff list and contact timeline? (raised in M0-06; DOMAIN-RULES §1.2 does not narrow it)
- `on_unassign` semantics on scope change: which tickets move when a role widens vs narrows (hook `onStaffScopeChanged` exists)

## M1-12 notes

- **Schema** (`0018_time_tracking_and_csat`): `ticket_time_entries` and `csat_responses`, both department-scoped, on the shared `helpdock_ticket_child_department` trigger and in `helpdock_ticket_department_moved`; both in `TENANT_TABLES` and the RLS negative suite. Brand settings gain `csatEnabled` (on), `timeTrackingEnabled` (off), `timerStartsWithComposer` (off). No new environment keys: the link key is derived from `APP_MASTER_KEY`.
- **Survey creation** goes through the outbox: `onClosedForCsat` (the M1-08 hook, now `CsatLifecycleHooks`) writes `csat.requested` when the brand has CSAT on; the worker creates one row per `(ticket, closed_at)` and skips a close undone before it ran. Spam and merge are excluded by the lifecycle through `excluded_from_reports` and `merged_into_id`; **seam for M1-11**: if `isSpam` differs from `excluded_from_reports`, swap it into `lifecycle.service.ts#onClosed` and `csat-events.ts`.
- **The per-reply timer** rides on `POST …/messages` as `timeSpentSeconds`, written in the reply's transaction; dropped (not refused) while tracking is off.
- **The rating page is hosted in the admin bundle** at `/csat/<token>`, outside the admin app, because `apps/helpcenter` is a one-line stub and its SSR host is M5's: [ADR 0010](../decisions/0010-csat-page-in-the-admin-bundle.md).
- **Delivery is M8-06**; until then the details panel shows the survey's state and a Copy survey link button.
- **Seam for M1-09**: the header ⋯ menu is `ticket-actions-menu.tsx`, an items array; merge, split and spam add their items to `headerActions` in `ticket-view.tsx`.
- **Artboard gaps**: the Satisfaction card in the details panel has no artboard (built after the SLA card); the Feedback tab's "Preview" link and the rating page's "Browse the help center" link and "closed by <agent>" are not built (no survey to preview, no help center yet, and DOMAIN-RULES §4.6 keeps the agent's name off the link).

## Pull requests
- this PR: milestone doc
