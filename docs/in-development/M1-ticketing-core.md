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
| M1-12 | Time tracking (toggle), CSAT model and rating page with | #56 | planned |
| M1-13 | Contact identity rules | #57 | planned |
| M1-14 | Data retention settings per brand and nightly | #58 | planned |
| M1-15 | Admin UI for all of the above; ticket list index set | #59 | in review (#70) — the M1-02/03/04 surfaces: list, thread, composer, details, creation, realtime. M1-05/06/08/09/10 extend it. Index set, 50k performance gate and the embedded contact name: done in branch, awaiting PR |

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

## Notes: M1-15, the ticket list index set and the 50k gate

- **Index set** (`0021_ticket_list_indexes.sql`): new `tickets_brand_updated_idx (brand_id, updated_at, id)`;
  `(brand_id, assignee_id)` becomes `(brand_id, assignee_id, updated_at, id)`; the department/status index gains
  `id`. Every ordered list index now ends in the keyset `(updated_at, id)`.
- **The list names its brand** (`tickets.brand_id = :brandId` beside the policy's `= ANY(app.brand_ids)`). Not
  isolation: without it the planner cannot read the brand's index in order and sorted every visible ticket
  (27 ms at 50k, before load) instead of stopping after one page (0.2 ms).
- **Search cannot use its GIN indexes under `FORCE ROW LEVEL SECURITY`**: `@@` and `<%` are not `LEAKPROOF`, so
  Postgres will not evaluate them ahead of the policy. Common terms stop after a few hundred rows; a term that
  matches nothing reads every visible ticket (257 ms as an Admin at 50k). Measured and reported outside the gate;
  fixing it is an ADR (leakproof wrappers, or a token table), not an index.
- **Rows embed `contact: { id, name }`** on the list and the ticket read, when the caller holds `contact:read`.
  The workspace no longer reads the first page of `GET /contacts` to name rows.
- **The gate** is `pnpm --filter @helpdock/api perf:tickets` (`apps/api/src/testing/perf/`): the §14 dataset, two
  api replicas, 50 staff sessions, Admin and department-restricted Agent. Method, plans and numbers:
  [tickets guide, Performance](../guides/tickets.md#performance). **Not yet demonstrated**: the only machine
  available was shared with six other jobs (load average 27–64 on 4 vCPUs), and there the full run's list p95
  was 0.8–2.1 s; with the machine quieter the api's own cost was a p95 of 14–52 ms. The exit criterion stays
  unticked until a run on an idle §14 host.

## Pull requests
- this PR: milestone doc
