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
| M1-01 | Brands | #45 | done (#66) |
| M1-02 | Tickets | #46 | done (#63) |
| M1-03 | Messages | #47 | done (#63) |
| M1-04 | Contacts and accounts | #48 | done (#64) |
| M1-05 | Views | #49 | planned |
| M1-06 | Tags, custom fields (text, number, date, select | #50 | in review (#72) |
| M1-07 | Assignment | #51 | integrated on `claude/hopeful-hawking-onzqjf` (2026-09-24), awaiting PR |
| M1-08 | Ticket state machine | #52 | done (#69) |
| M1-09 | Merge and split with the exact semantics in D §2.4 | #53 | integrated on `claude/hopeful-hawking-onzqjf` (2026-09-24), awaiting PR |
| M1-10 | Media pipeline | #54 | done (#71) |
| M1-11 | Spam | #55 | integrated on `claude/hopeful-hawking-onzqjf` (2026-09-24), awaiting PR |
| M1-12 | Time tracking (toggle), CSAT model and rating page with | #56 | integrated on `claude/hopeful-hawking-onzqjf` (2026-09-24), awaiting PR |
| M1-13 | Contact identity rules | #57 | integrated on `claude/hopeful-hawking-onzqjf` (2026-09-24), awaiting PR |
| M1-14 | Data retention settings per brand and nightly | #58 | integrated on `claude/hopeful-hawking-onzqjf` (2026-09-24), awaiting PR |
| M1-15 | Admin UI for all of the above; ticket list index set | #59 | in review (#70) — the M1-02/03/04 surfaces: list, thread, composer, details, creation, realtime. M1-05/06/08/09/10 extend it. Index set, 50k performance gate and the embedded contact name: integrated on `claude/hopeful-hawking-onzqjf` (2026-09-24), awaiting PR; part 2 (search through a token table, ADR 0011): done in branch, awaiting PR |

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
- **Seams**: `MergeParticipantsHook` — filled at integration by M1-13's
  `ParticipantsMergeHook`: the secondary's contact becomes a `merge` CC of the
  primary and an unmerge takes that CC off again (never one an agent added);
  `onMerged` / `onUnmerged` in `lifecycle/hooks.ts` (M3-02 stops and
  resumes clocks; `merged_ms` is the time to leave out), and the ⋯ menu's
  `actions` array (M1-11 Mark as spam, M1-12 Log time).
- **For M1-14** (done at integration): a split's attachment copies share their
  original's object, so a purge queues an object only when no other row names
  its key, and downloads and purges build variant keys beside `s3_key` rather
  than from the row's ids.
- **For M1-11** (done at integration): Spam is found by `system_key = 'spam'`
  the same way Merged is; `is_spam` is generated from it.

## Exit criteria
Copied from the PRD, ticked as they are met.
- [ ] An agent can create, assign, reply to, note, tag, merge, split and close tickets in the admin UI, in English and Arabic.
- [ ] An Agent cannot see or open a ticket in another department, by list, by direct URL, by contact timeline, or by socket room.
- [ ] Every transition in DOMAIN-RULES §2.2 and each reopen policy value has a test.
- [ ] Every new tenant table has brand and, where applicable, department RLS policies and is covered by the negative test suite.
- [x] Ticket list of 50k seeded tickets loads under 150 ms p95 under the D §14 conditions. (2026-09-25: worst list p95 53 ms, 0 errors; see the M1-15 notes.)

## M1-11 Spam

- **Schema** (migration `0017_spam_and_block_list`): `ticket_statuses.is_spam`,
  since integration a **generated** column, `coalesce(system_key = 'spam',
  false)` — M1-09's `system_key` is the one answer to "which row is Spam?" and
  its partial unique index keeps it to one per brand; `blocked_senders` (brand-scoped tenant table,
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
  fixed by [ADR 0011](../decisions/0011-ticket-search-token-table.md) in M1-15 part 2.
- **Rows embed `contact: { id, name }`** on the list and the ticket read, when the caller holds `contact:read`.
  The workspace no longer reads the first page of `GET /contacts` to name rows.
- **The gate** is `pnpm --filter @helpdock/api perf:tickets` (`apps/api/src/testing/perf/`): the §14 dataset, two
  api replicas, 50 staff sessions, Admin and department-restricted Agent. Method, plans and numbers:
  [tickets guide, Performance](../guides/tickets.md#performance). **Passed on 2026-09-25**: an idle run
  pinned to 2 cores put the slowest gated list scenario at p95 53 ms (0 errors). An earlier run on the same
  machine while it was shared with six other jobs measured the queue, not the api (p95 0.8–2.1 s).

## Notes: M1-15 part 2, ticket search through a token table

- **Migration** `0023_ticket_search_tokens`: `ticket_search_tokens (ticket_id, brand_id, department_id, token)`,
  brand- and department-scoped with `FORCE`d policies, filled by `helpdock_ticket_child_department` and moved by
  `helpdock_ticket_department_moved` (replaced, keeping every child table `0019` moved). Written only by triggers
  (`helpdock_ticket_search_refresh`) on a ticket's insert, a subject edit, and its first message (`seq = 1`), in
  the same transaction. Backfilled in the migration with `FORCE` lifted around it, as `0016`/`0017` do. Cascades on
  ticket delete. Also `tickets_brand_contact_idx` for the contact-name half of the search.
- **Query**: `q` → lexemes (`helpdock_search_lexemes`, the `english` configuration `tickets.search` uses) →
  all-of match on `ticket_search_tokens_brand_token_idx`. The fuzzy fallback runs only when the exact half returns
  less than a page and the term has ≥ 3 characters; it also reads the token table (a prefix range of the same
  index, then `<%`), so a zero-match search never reads every ticket. The cursor carries the fallback. `-word`
  still excludes; M1-09's reference and contact-name matches are kept.
- **Proved** by an integration test that `EXPLAIN`s both halves as the runtime role under RLS and finds the token
  lookup in `Index Cond`, and by the benchmark's plans (tickets guide, Search under row-level security).
- **Benchmark**: the zero-match search is now in the gated mix with its own budget, `PERF_NO_MATCH_P95_MS`
  (150 ms). Full §14 run on 2026-09-25, unpinned because the shared container's load stayed above 3: zero-match
  p95 51 ms (was 284 ms alone), slowest list scenario 110 ms (`renewa`, which runs both halves), 0 errors.
  [Tickets guide](../guides/tickets.md#what-it-measured-last-2026-09-25).
- **Trade-offs**: a typo in the first three letters is not caught by the fallback; quotes are not a phrase
  operator; later replies are not searched (the first message is new: before, only the subject was).

## M1-14 notes

Data retention and contact anonymisation. [The data retention
guide](../guides/data-retention.md) is the reference.

- **Schema** (migration `0020_data_retention`): `retention_settings` (one row
  per brand, tenant table, RLS + negative suite) and
  `tickets_brand_closed_at_idx`. Spam is found by M1-11's `ticket_statuses.is_spam`
  (migration 0017); 0020 no longer adds the column (integration).
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
  M1-11's `ticket_statuses.is_spam`.
- **Stored, not yet acted on**: AI call logs (M7), help center search log (M5),
  visitor sessions (M4). Unsent composer uploads are not swept.

## M1-12 notes

- **Schema** (`0018_time_tracking_and_csat`): `ticket_time_entries` and `csat_responses`, both department-scoped, on the shared `helpdock_ticket_child_department` trigger and in `helpdock_ticket_department_moved`; both in `TENANT_TABLES` and the RLS negative suite. Brand settings gain `csatEnabled` (on), `timeTrackingEnabled` (off), `timerStartsWithComposer` (off). No new environment keys: the link key is derived from `APP_MASTER_KEY`.
- **Survey creation** goes through the outbox: `onClosedForCsat` (the M1-08 hook, now `CsatLifecycleHooks`) writes `csat.requested` when the brand has CSAT on; the worker creates one row per `(ticket, closed_at)` and skips a close undone before it ran. Spam and merge are excluded by the lifecycle and the survey job through `isSpamStatus` (M1-11's `is_spam`) and `merged_into_id` — swapped in at integration.
- **The per-reply timer** rides on `POST …/messages` as `timeSpentSeconds`, written in the reply's transaction; dropped (not refused) while tracking is off.
- **The rating page is hosted in the admin bundle** at `/csat/<token>`, outside the admin app, because `apps/helpcenter` is a one-line stub and its SSR host is M5's: [ADR 0010](../decisions/0010-csat-page-in-the-admin-bundle.md).
- **Delivery is M8-06**; until then the details panel shows the survey's state and a Copy survey link button.
- **The header ⋯ menu** is one items array (`ticket-actions-menu.tsx`, M1-09's `TicketAction`): Merge, Split, Log time, then Mark as spam behind a divider.
- **Artboard gaps**: the Satisfaction card in the details panel has no artboard (built after the SLA card); the Feedback tab's "Preview" link and the rating page's "Browse the help center" link and "closed by <agent>" are not built (no survey to preview, no help center yet, and DOMAIN-RULES §4.6 keeps the agent's name off the link).

## Integration (2026-09-24)

M1-07, 09, 11, 12, 13, 14 and the M1-15 data side were built in parallel and
merged onto `claude/hopeful-hawking-onzqjf`. What the merges had to decide:

- **Migrations** run in number order, 0015 → 0021, with snapshot `prevId`s
  chained in that order; the last snapshot (0021) is regenerated from the full
  schema, so `drizzle-kit generate` finds nothing to do. Intermediate snapshots
  describe only their own branch's schema.
- **`helpdock_ticket_department_moved`** is last replaced by 0019, which carries
  every child table: messages, activity, attachments, tags, participants, time
  entries and CSAT responses. M1-09's follow-the-primary trigger is separate.
- **Backfills under FORCE RLS**: 0016 and 0017 lift the force for their
  `UPDATE`s, as 0020 did, so existing brands are backfilled when the migration
  role is not a superuser.
- **Spam** is `system_key = 'spam'`; `is_spam` is generated from it (0017) and
  0020 no longer adds its own. CSAT, the lifecycle and retention read it
  through `isSpamStatus` / `is_spam`; `excluded_from_reports` stays the wider
  "leave it out of a count".
- **One ⋯ menu** in the ticket header, in the artboard's order.
- **Split copies and retention**: see the M1-09 notes.
- **Screenshot baselines**: the screenshots workflow re-rendered every
  baseline on the integrated branch (run 36068915967) and they matched the
  committed ones byte for byte; the 4 % `ticket-view` difference seen locally is
  this container's older Chromium and fonts, not a change.

## Decisions (2026-09-25)

Settled after integration, following the planning documents where they speak:

- **Pull requests**: one PR from `claude/hopeful-hawking-onzqjf`, merged after
  #72 (M1-06) and #70 (M1-15 part 1), which it contains. The deliverables were
  resolved against each other during integration (spam model, menu, merge CCs,
  shared attachment objects), so separate PRs would each be incomplete.
- **Search under RLS**: [ADR 0011](../decisions/0011-ticket-search-token-table.md),
  a token table, built with M1-15 part 2.
- **M1-07 defaults** stand as written in the M1-07 notes: the load cap counts
  per department; Agents are in rotation by default, Team Leaders and Admins
  opt in; skills are per agent per department; a ticket nobody was eligible for
  is not retried (it shows in Unassigned, which is where a person looks);
  teams play no part in rotation until a deliverable asks for it.
- **CSAT page**: in the admin bundle for now ([ADR 0010](../decisions/0010-csat-page-in-the-admin-bundle.md));
  it moves to `apps/helpcenter` when M5 gives that app a router and theming.
- **Anonymise** is Admin only, as DOMAIN-RULES §1.2 says; the artboard note that
  said "Admin and Team Leader" was corrected on the canvas.

## Pull requests
- #61: milestone doc
- M1-07, 09, 11, 12, 13, 14 and the M1-15 data side: one PR from `claude/hopeful-hawking-onzqjf`

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
