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
| M1-09 | Merge and split with the exact semantics in D §2.4 | #53 | done in branch, awaiting PR |
| M1-10 | Media pipeline | #54 | in review (#71) |
| M1-11 | Spam | #55 | planned |
| M1-12 | Time tracking (toggle), CSAT model and rating page with | #56 | planned |
| M1-13 | Contact identity rules | #57 | planned |
| M1-14 | Data retention settings per brand and nightly | #58 | planned |
| M1-15 | Admin UI for all of the above; ticket list index set | #59 | in review (#70) — the M1-02/03/04 surfaces: list, thread, composer, details, creation, realtime. M1-05/06/08/09/10 extend it |

## M1-09 notes

Merge, unmerge and split per DOMAIN-RULES §2.4, and "is replying" on the
collision indicator. Built from `AdminTicketDialogs` panels 1, 2, 4 and 7;
behaviour and endpoints are in [the ticket guide](../guides/tickets.md#merge-and-split).

- **Migration `0016_merge_and_split`**: `tickets.merged_at`, `merged_by_id`,
  `pre_merge_status_id`, `pre_merge_department_id`, `merge_message_id`,
  `merged_ms`; `ticket_messages.copied_from_message_id`;
  `attachments.copied_from_attachment_id`, with `s3_key` unique among originals
  only; `ticket_statuses.system_key` (seeded, backfilled); and the
  `tickets_merged_follow_primary` trigger. No new tenant table, so the RLS
  negative suite gains no table; the merge integration suite adds the
  cross-brand and cross-department refusals.
- **A merge moves the secondary into the primary's department**, and the
  trigger keeps it there, so access to its messages and attachments follows the
  primary under the ordinary policy. Unmerge moves it back.
- **Seams left**: `MergeParticipantsHook` (M1-13 makes the secondary's contact a
  CC), `onMerged` / `onUnmerged` in `lifecycle/hooks.ts` (M3-02 stops and
  resumes clocks; `merged_ms` is the time to leave out), and the ⋯ menu's
  `actions` array (M1-11 Mark as spam, M1-12 Log time).
- **For M1-14**: a split's attachment copies share their original's object, so
  retention may delete an object only when no row names its key.
- **For M1-11**: Spam is found by `system_key = 'spam'` the same way Merged is.

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

## Pull requests
- this PR: milestone doc
