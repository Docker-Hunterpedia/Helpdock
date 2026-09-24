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
| M1-14 | Data retention settings per brand and nightly | #58 | done in branch, awaiting PR |
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

## M1-14 notes

Data retention and contact anonymisation. [The data retention
guide](../guides/data-retention.md) is the reference.

- **Schema** (migration `0020_data_retention`): `retention_settings` (one row
  per brand, tenant table, RLS + negative suite), `ticket_statuses.is_spam`
  (backfilled for the seeded Spam row; Merged carries the same other flags), and
  `tickets_brand_closed_at_idx`.
- **API**: `GET`/`PUT /api/brands/:brandId/retention`, `brand:manage` (Admin).
  Zod refuses a partial form and an audit log under 90 days.
- **Worker**: `maintenance.retention.schedule` at 03:00 UTC adds one
  `maintenance.retention` per brand (id per brand per night) and purges
  `job_receipts`; each brand's run purges closed tickets (never by default),
  spam, the audit log and the published outbox in batches of 500, each batch a
  short system-principal transaction of that brand alone, and ends with a
  `retention.purged` audit row carrying counts only.
- **Objects**: a purged ticket's attachment keys ride a `media.objects.purge`
  outbox row written with the delete; the handler refuses any key outside the
  brand's prefix.
- **Erasure**: `DbContactErasureProvider` deletes the attachments a contact sent
  (rows now, objects via the outbox) and clears `external_message_id` on their
  messages; bodies stay. The audit row gains `attachmentCount` and
  `messageCount`. Admin only, as DOMAIN-RULES §1.2 says (the artboard's note says
  Admin and Team Leader; the rule wins).
- **Admin UI**: `/admin/brand/danger` (new Brand page, Danger zone tab only, the
  Data retention card) and the type-the-name Anonymise dialog.
- **Seams**: CSAT (M1-12) and AI calls (M7) are purged by `ON DELETE CASCADE`
  from `tickets`; the retention integration suite fails for a foreign key into
  `tickets` that neither cascades nor sets null. `contacts.anonymised_at` is the
  marker duplicate matching (M1-13) must skip. The Spam status is found by
  `ticket_statuses.is_spam` (M1-11 should use the same flag).
- **Stored, not yet acted on**: AI call logs (M7), help center search log (M5),
  visitor sessions (M4). Unsent composer uploads are not swept.

## Pull requests
- this PR: milestone doc
