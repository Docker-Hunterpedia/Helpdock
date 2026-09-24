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
| M1-07 | Assignment | #51 | done in branch, awaiting PR |
| M1-08 | Ticket state machine | #52 | in review (#69) |
| M1-09 | Merge and split with the exact semantics in D §2.4 | #53 | planned |
| M1-10 | Media pipeline | #54 | in review (#71) |
| M1-11 | Spam | #55 | done in branch, awaiting PR |
| M1-12 | Time tracking (toggle), CSAT model and rating page with | #56 | planned |
| M1-13 | Contact identity rules | #57 | done in branch, awaiting PR |
| M1-14 | Data retention settings per brand and nightly | #58 | planned |
| M1-15 | Admin UI for all of the above; ticket list index set | #59 | in review (#70) — the M1-02/03/04 surfaces: list, thread, composer, details, creation, realtime. M1-05/06/08/09/10 extend it. Index set, 50k performance gate and the embedded contact name: done in branch, awaiting PR |

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
- ~~`on_unassign` semantics on scope change~~ — answered by M1-07: after any role or department change, deactivation or removal, the tickets the person can no longer work are unassigned and each follows its department's `on_unassign`; a widened scope moves nothing. See the M1-07 notes.

## M1-07 notes

Assignment, in migration `0015_assignment` (departments gain `assignment_mode`, `load_cap`, `auto_unassign_offline`, `auto_unassign_after_minutes`, `on_unassign`; new tenant tables `assignment_agents` and `assignment_skills`, both in the RLS negative suite). Guide: [ticketing settings › Assignment](../guides/ticketing-settings.md#assignment).

- **Rotation** (round-robin, skill-based) runs in the worker from `assignment.requested`, written in the same transaction as a ticket created or moved unassigned into a routing department. Eligible = can work the department, in rotation, online (not away), under the cap; longest waiting first. Skills match among the *eligible*; nobody skilled and eligible falls back to everyone eligible. A per-brand `pg_advisory_xact_lock` makes concurrent picks cap-safe (integration test fails without it).
- **Manual assignment** is held to the ticket's (target) department and to DOMAIN-RULES §1.2's ceiling: only an Admin assigns to an Admin (`assignee-above-actor`, 403). The cap never refuses a person. A move the assignee cannot follow clears the assignee.
- **Assignable read** for the picker: `GET /brands/:id/assignment/:departmentId/assignable` under `ticket:write` — id, name, presence, open count, cap.
- **Auto-unassign on offline**: `STAFF_OFFLINE_HOOK` now writes `assignment.staff_offline`; the worker adds one delayed `assignment.offline_unassign` job (new `assignment` queue, ARCHITECTURE §13) per department that asks for it. Business hours are M3: the "never while closed" check is a seam in the job.
- **`on_unassign`**: `StaffLifecycleHooks` now carry the request `tx` and write `assignment.access_changed`; `removeFromBrand` calls the hook too.

Decisions a reviewer should confirm:
1. The load cap counts open + escalated tickets **in that department**, not across the brand — so the picker (read by an Agent under department RLS) and the rotation agree.
2. With no stored choice, **Agents are in rotation and Team Leaders/Admins are not**.
3. Skills are **per agent per department**, so a Team Leader edits skills only where they lead.
4. Nothing re-routes a ticket left unassigned because nobody was eligible (e.g. when an agent comes online); that would be a rule (M3).
5. Teams play no part in the rotation; the department's default team is still unused (the `teamId` refusal in `tickets.service.ts` predates M1-01 and was left alone).

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

## M1-13 notes

Contact identity rules, manual merge with a 24-hour undo, and ticket participants (DOMAIN-RULES §2.5, §4.4). Guides: [contacts](../guides/contacts.md#identity-rules-and-merging-m1-13), [tickets](../guides/tickets.md#participants-m1-13).

- **Verification comes from the source, not the caller.** `IDENTITY_SOURCE_RULES` in `packages/schemas/src/identity-rules.ts` is the §4.4 table as data; `findOrCreateContactByIdentity` now takes `{ kind, value, source }` and no `verified` flag.
- **Auto-merge needs both sides verified.** A verified claim meeting an identifier another contact holds *unverified* starts a new contact that takes the identifier (verified) and leaves a duplicate suggestion on the pair; an unverified claim never joins anybody. M1-04's "promote the typed address in place" is gone.
- **Duplicate reasons:** the identifier kind, or `similar_name` (same account, pg_trgm `similarity` ≥ 0.4). "Not the same" is permanent for the pair in both directions.
- **Merge** (`POST /contacts/:survivorId/merge`) moves identifiers as they are (verification never upgrades), notes, and *every* ticket — hidden departments included, through `helpdock_contact_reassign_tickets` (migration `0019`). Tickets are not merged. The merged contact stays with `merged_into_id` set, is hidden from lists and refuses writes (`merged`). **Undo** (`POST /contacts/:survivorId/merges/:mergeId/undo`) moves back exactly what the merge moved, within 24 hours; refused (`merge-blocked`) once the survivor has been merged onwards or either side erased.
- **Anonymised contacts** (M1-14) cannot be merged (`anonymised`), and a merged contact cannot be anonymised (`merged`).
- **Participants:** `ticket_participants` holds the CCs (department-scoped, follows department moves); the contact and staff are derived. `GET/POST/DELETE /tickets/:id/participants`. `TicketParticipantsService.addCcParticipant(context, ticketId, contactId)` is the seam M1-09's ticket merge calls to add the secondary's contact as a CC; `ParticipantsModule` exports the service.
- **Migration** `0019_contact_identity_and_participants`: `contact_duplicate_reason` enum, `contacts.merged_into_id`/`merged_at`, `contact_merges`, `ticket_participants`, RLS for both new tables, and `helpdock_ticket_department_moved` replaced to include `ticket_participants`.
- **Artboard gaps:** a "merge with any contact" picker from the contact ⋯ menu is not drawn, so merging starts from a suggestion only (the api accepts any contact). The merge dialog lists identifiers without the drawn checkboxes, because every identifier is kept.
