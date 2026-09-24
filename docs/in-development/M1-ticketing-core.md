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
| M1-13 | Contact identity rules | #57 | done in branch, awaiting PR |
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
