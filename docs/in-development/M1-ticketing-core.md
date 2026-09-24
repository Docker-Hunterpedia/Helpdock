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
| M1-11 | Spam | #55 | done in branch, awaiting PR |
| M1-12 | Time tracking (toggle), CSAT model and rating page with | #56 | planned |
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

## M1-11 Spam

- **Schema** (migration `0017_spam_and_block_list`): `ticket_statuses.is_spam`,
  one per brand by a partial unique index, set on the seeded Spam row and
  backfilled on existing brands; `blocked_senders` (brand-scoped tenant table,
  unique on `(brand_id, kind, value)`, `dropped_count`, `last_dropped_at`),
  added to `TENANT_TABLES` and the RLS negative suite.
- **Lifecycle**: `TicketLifecycleService.markSpam` / `unmarkSpam` on the §2.2
  table's `mark.spam` row. Spam fires `onResolved`, never `onClosedForCsat`,
  and enqueues the new `ticket.spam` event instead of `ticket.closed` — also
  when Spam is picked from the status picker. "Not spam" is an agent reopen.
- **Contract for other deliverables**: `isSpamStatus` and `countsInReports` in
  `@helpdock/schemas`; `isSenderBlocked` in `apps/api/src/ticketing/sender-gate.ts`
  for M2/M4/M6 to call before creating a contact or a ticket. Nothing in M1
  calls the gate: no M1 path creates a ticket from a customer.
- **Own senders**: the install's `smtp.from` and the brand's `brand_domains`.
  Per-brand mailboxes (M2-08) join the check when they exist.
- **UI**: Ticketing › Spam tab and the ticket header ⋯ menu with the Mark as
  spam dialog (artboards `AdminTicketingSpam`, `AdminTicketDialogs` panels 2
  and 5). The menu takes an items array so M1-09 and M1-12 add entries.
- Gaps: the artboard's Telegram row shows `@crypto_bot_9`; a chat is stored and
  matched as the Bot API's numeric chat id, as `contact_identities` stores it.
  "Not spam" has no artboard; it is the same menu slot without the danger tone.

## Open questions
- Should a Team Leader read only their own departments' rows of the staff list and contact timeline? (raised in M0-06; DOMAIN-RULES §1.2 does not narrow it)
- `on_unassign` semantics on scope change: which tickets move when a role widens vs narrows (hook `onStaffScopeChanged` exists)

## Pull requests
- this PR: milestone doc
