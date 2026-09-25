# M1 Ticketing core

Status: shipped
Started: 2026-09-19
Shipped: 2026-09-25
Owner: @Docker-Hunterpedia

## Scope

Agents work tickets with Zoho-style discipline before any customer-facing
surface exists: brands, departments and teams; tickets, threads and the
activity log; contacts and accounts; saved views; tags, custom fields and
templates; assignment; the state machine; merge and split; attachments; spam;
time tracking and CSAT; contact identity rules; data retention; and the admin
workspace over all of it.

Full deliverable list and specs: [PRD §4 · M1 Ticketing core](../planning/PRD.md#m1-ticketing-core). Depends on M0 (shipped 2026-09-19).

Built from the design canvas artboards `Admin · ticket view`, `Admin/Contacts`,
`Admin/Contact`, `Admin/Ticketing` and its tabs, `AdminTicketDialogs`,
`Admin/View-Dialogs`, `AdminBrandDanger`, `CsatEN` and `CsatAR`.

## Deliverables

| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M1-01 | Brands | #45 | shipped (#66) |
| M1-02 | Tickets | #46 | shipped (#63) |
| M1-03 | Messages | #47 | shipped (#63) |
| M1-04 | Contacts and accounts | #48 | shipped (#64) |
| M1-05 | Views | #49 | shipped (#74) |
| M1-06 | Tags, custom fields, ticket templates | #50 | shipped (#72) |
| M1-07 | Assignment | #51 | shipped (#73) |
| M1-08 | Ticket state machine | #52 | shipped (#69) |
| M1-09 | Merge and split | #53 | shipped (#73) |
| M1-10 | Media pipeline | #54 | shipped (#71) |
| M1-11 | Spam | #55 | shipped (#73) |
| M1-12 | Time tracking, CSAT model and rating page | #56 | shipped (#73) |
| M1-13 | Contact identity rules | #57 | shipped (#73) |
| M1-14 | Data retention and contact anonymisation | #58 | shipped (#73) |
| M1-15 | Admin UI, ticket list index set | #59 | shipped (#70, #73, #74) |

## Exit criteria

Copied from the PRD. Four of five are met; the first is met for seven of its
eight verbs, and the eighth is written down below with the reason. Every test
named here was run on 2026-09-25 against `aad60e3`: the admin Playwright specs
in both locales (76 passed), the lifecycle unit tests (127 passed) and eight
integration suites against real Postgres and Redis (574 passed).

- [ ] **An agent can create, assign, reply to, note, tag, merge, split and close
      tickets in the admin UI, in English and Arabic.** Seven of eight. Every
      spec below runs in the `en` and `ar` projects of
      `apps/admin/playwright.config.ts`:
      - create: `e2e/tickets.spec.ts` "creates a ticket from the dialog and opens it"
      - assign: `e2e/assignment.spec.ts` "assigns an agent at cap by hand"
      - reply: `e2e/tickets.spec.ts` "sends a reply and shows it in the thread once it has a seq"
      - note: `e2e/tickets.spec.ts` "adds an internal note in note mode"
      - merge: `e2e/merge-split.spec.ts` "closes a ticket into another, shows its messages inline there, and undoes it"
      - split: `e2e/merge-split.spec.ts` "copies the ticked messages onto a new ticket and opens it"
      - close: `e2e/feedback.spec.ts` "appears pending when the ticket closes, and its link opens the rating page", which closes the ticket from the details panel's status picker
      - **tag: not met.** The api takes `PUT /tickets/:id/tags` (M1-06,
        covered by `ticketing.integration.test.ts`), and the header draws a
        ticket's tags, but the workspace has no control that puts a tag on a
        ticket. No artboard draws one, and DESIGN-first means the control is
        not improvised; a browser test for it cannot be written until it
        exists. Carried as the first gap below.
- [x] **An Agent cannot see or open a ticket in another department, by list, by
      direct URL, by contact timeline, or by socket room.** All four in
      `apps/api/src/tickets/tickets.integration.test.ts`:
      - list: "department scope (DOMAIN-RULES §1.3, §1.6)" › "hides another department’s ticket from the list"
      - direct URL: the same block › "answers 404 to a direct read of it, not 403", with the message cursor, activity, reply and patch refused beside it
      - contact timeline: "what the contact screens read (M1-04’s seam)" › "counts only the tickets the reader may see, and says how many it hid"
      - socket room: "realtime (DOMAIN-RULES §1.4, §7)" › "lets the ticket’s own department into its room and refuses another"; `realtime/realtime.integration.test.ts` › "lets an agent into their own department and refuses every other"
- [x] **Every transition in DOMAIN-RULES §2.2 and each reopen policy value has a
      test.** `apps/api/src/tickets/lifecycle/transitions.test.ts` asserts every
      state against every event, cell by cell, against a copy of the table
      typed out from the document, and refuses every event on a merged or
      deleted ticket. Row by row:

      | §2.2 row | Tests |
      |---|---|
      | 1. open-like + customer reply → open | `lifecycle.service.test.ts` "a customer reply to an open-like ticket (§2.2 row 1)" |
      | 2. open + agent reply, toggle on → Awaiting customer | `lifecycle.service.test.ts` "an agent public reply (§2.2 row 2)", toggle on and off |
      | 3. any + agent sets status, actor logged | `status-change.test.ts` "applyStatusChange"; `tickets.integration.test.ts` "stamps closed_at through the status hook and logs the transition", which now also asserts the actor |
      | 4. open-like + agent closes | `lifecycle.service.test.ts` "closing (§2.2 row 4)"; `tickets.integration.test.ts` "closing and reopening" |
      | 5. closed + customer reply → reopen policy | `lifecycle.service.test.ts` "a customer reply to a closed ticket (§2.2 row 5, §2.3)" |
      | 6. closed + agent reopens | `status-change.test.ts` "clears closed_at and reports a reopen when a ticket leaves a closed state"; `tickets.integration.test.ts` "logs the close and the reopen beside the status change" |
      | 7. any + marked spam | `lifecycle.service.test.ts` "marking as spam (§2.2 row 7, M1-11)"; `ticketing/spam.integration.test.ts` |
      | 8. any + merged | `merge/merge-rules.test.ts` "mergeRefusal"; `merge/merge.integration.test.ts` "merge" |
      | 9. any + soft-deleted | `lifecycle.service.test.ts` "soft deletion (§2.2 row 9)"; `tickets.integration.test.ts` "soft deletion (§2.2)" |

      Reopen policy values: `reopen-policy.test.ts` covers `always`, `never`
      and `within_days` at the default seven (inside, on the last day, exactly
      at, and past the window) and at one day; `lifecycle.service.test.ts`
      carries each value through the service, including the linked
      continuation ticket.
- [x] **Every new tenant table has brand and, where applicable, department RLS
      policies and is covered by the negative test suite.** Migrations
      0006–0023 create 26 tables, and every one is in `TENANT_TABLES`
      (`packages/db/src/rls.ts`). `packages/db/src/rls.integration.test.ts`
      "covers every tenant table" fails when a table is missing from its
      fixtures, and each fixture runs the cross-brand negatives plus "has row
      security enabled and forced". The nine department-scoped tables have an
      other-department test each: `tickets`, `ticket_messages`,
      `ticket_activity` and `ticket_search_tokens` in
      `tickets.integration.test.ts`; `attachments` in `media.integration.test.ts`;
      `ticket_tags` in `ticketing.integration.test.ts`; `ticket_participants` in
      `participants.integration.test.ts`; `ticket_time_entries` and
      `csat_responses` in `csat/feedback.integration.test.ts`. `views` has an
      extra restrictive owner policy with its own block, "a personal view (M1-05)".
- [x] **Ticket list of 50k seeded tickets loads under 150 ms p95 under the D §14
      conditions.** `pnpm --filter @helpdock/api perf:tickets`, the full §14 run
      of 2026-09-25 on an idle machine pinned to two cores: slowest gated
      scenario p95 115 ms (`renewa` as an Admin), zero-match search p95 56 ms,
      0 errors. [Tickets guide, What it measured last](../guides/tickets.md#what-it-measured-last-2026-09-25).

## Effort

| | |
|---|---|
| Estimated | 6–8 weeks (PRD status board) |
| Started | 2026-09-19 |
| Shipped | 2026-09-25 |
| Actual | 7 days |

Built the way M0 was: AI coding agents in parallel worktrees, one deliverable
each, with the maintainer reviewing and merging. Six deliverables were built in
parallel and integrated on one branch (see [Integration](#integration)).

## Gaps accepted

Written down and carried forward. The first one is the unmet part of an exit
criterion; none of the others blocks M2, M3 or M5.

| Gap | Why it was accepted | Where it is written down |
|---|---|---|
| **No control puts a tag on a ticket, or edits its custom field values, in the workspace** | The api does both (`PUT /tickets/:id/tags`, `PATCH` with `custom`), the header draws tags and the details panel draws values read-only. No artboard draws the control, and the design-first rule forbids improvising one. It needs an artboard, then the control and its en/ar Playwright test. | [tickets guide](../guides/tickets.md#what-the-screen-cannot-do-yet-and-why), this file |
| **A Team Leader reads the whole brand's roster and contact timeline counts**, not only their own departments | DOMAIN-RULES §1.2 does not narrow *reading* them, and narrowing is a product decision nobody has taken. | [staff-and-roles](../guides/staff-and-roles.md#known-gaps) |
| **Nothing re-routes a ticket nobody was eligible for** | It shows in Unassigned, which is where a person looks. Re-routing later is a rule (M3). | [M1-07 notes](#m1-07-assignment) |
| **Auto-unassign ignores business hours** | Business hours are M3; "never while closed" is a seam in the job. | [M1-07 notes](#m1-07-assignment) |
| **Deactivation unassigns in one brand** | The hook fires for the brand the action was taken in; the rotation never picks the account anywhere. | [staff-and-roles](../guides/staff-and-roles.md#known-gaps) |
| **Clocks are seams, not clocks** | `onMerged`, `onUnmerged` and `onReopened` fire, and `merged_ms` is stored, but SLA clocks are M3-02. | `apps/api/src/tickets/lifecycle/hooks.ts` |
| **Nothing calls the sender gate yet** | No M1 path creates a ticket from a customer. M2, M4 and M6 call `isSenderBlocked`. | [M1-11 notes](#m1-11-spam) |
| **CSAT surveys are not delivered** | Delivery per channel is M8-06; until then the details panel offers Copy survey link. | [M1-12 notes](#m1-12-time-tracking-and-csat) |
| **The rating page lives in the admin bundle** and has no "Browse the help center" link | `apps/helpcenter` has no router or theming until M5. | [ADR 0010](../decisions/0010-csat-page-in-the-admin-bundle.md) |
| **AI call logs, the help center search log and visitor sessions are not purged**; unsent composer uploads are not swept | Their tables do not exist yet; the milestone that creates each adds its purge. Unsent uploads go with their ticket. | [data-retention](../guides/data-retention.md#known-gaps) |
| **Search misses a typo in the first three letters, has no phrase operator, and reads only the subject and first message** | The trade-offs of the token table that makes a zero-match search two index probes under `FORCE ROW LEVEL SECURITY`. | [ADR 0011](../decisions/0011-ticket-search-token-table.md) |
| **Contact search is `ILIKE`**, and a contact merge does not carry the merged contact's other duplicate suggestions over | Same RLS limit as ticket search; the suggestions come back if the merge is undone. | [contacts](../guides/contacts.md#known-gaps) |
| **The benchmark host is not §14's** | It runs on whatever runs the command, with no worker or widget traffic. The pinned idle run is the evidence; a busy host measures its queue. | [tickets guide](../guides/tickets.md#performance) |
| **Artboard gaps** | Built without an artboard, each noted: the Satisfaction card, "Not spam", the Rename and Share with… dialogs (from `ConfirmDialog`). The Telegram block-list row matches a numeric chat id, not the drawn `@handle`. The contact merge dialog lists identifiers without checkboxes, because every identifier is kept. | The notes below |

## Decisions settled

| Decision | Where |
|---|---|
| Ticket search through a token table, because GIN operators are not `LEAKPROOF` under forced RLS | [ADR 0011](../decisions/0011-ticket-search-token-table.md) |
| The CSAT rating page is hosted in the admin bundle until M5 | [ADR 0010](../decisions/0010-csat-page-in-the-admin-bundle.md) |
| `on_unassign` on a scope change: tickets the person can no longer work are unassigned and follow their department's `on_unassign`; a widened scope moves nothing | [M1-07 notes](#m1-07-assignment) |
| The load cap counts per department; Agents are in rotation by default, Team Leaders and Admins opt in; skills are per agent per department; teams play no part in rotation | [M1-07 notes](#m1-07-assignment) |
| Personal views are not audited, only shared ones can be hidden, and a Team Leader restricted to some departments cannot share with the whole brand | [M1-05 notes](#m1-05-views) |
| Anonymise is Admin only, as DOMAIN-RULES §1.2 says; the artboard note was corrected | [M1-14 notes](#m1-14-data-retention) |
| The rating page names the closer only when they are active staff who wrote a public reply on the ticket | [M1-15 part 2 notes](#m1-15-part-2-the-admin-ui-gaps) |
| Spam is `system_key = 'spam'`, with `is_spam` generated from it | [Integration](#integration) |

## What an operator can do with this milestone

Create brands with their departments and teams, and give staff roles in them.
Agents file tickets by hand, reply, write notes, attach files, assign, merge,
split, mark spam and close, in English or Arabic, and see only their own
departments' tickets. Team Leaders configure statuses, tags, custom fields,
templates, views, assignment, spam and feedback. Admins set retention and
anonymise contacts. No ticket arrives from a customer yet: that is
[M2](../planning/PRD.md#m2-email-channel).

## Deliverable notes

### M1-05 Views

Migration `0022_views`: tenant table `views`, in the RLS negative suite, with a
restrictive `views_owner_only` policy from `OWNER_SCOPED_TABLES` in
`packages/db/src/rls.ts`. Guides: [tickets › Views](../guides/tickets.md#views),
[ticketing settings › Views](../guides/ticketing-settings.md#views).

- **One schema.** A view's `filters` is `ticketListQuerySchema` less `cursor` and `limit`
  (`packages/schemas/src/views.ts`). The list gained two server-side predicates for it:
  `assigneeId=me` and `overdue=true` (not closed, clock not paused, breached or past a due time).
- **Never widens access.** A view resolves to list parameters, and its count is the list's own `WHERE`
  in the reader's transaction. A personal view is invisible to anybody else at the database (404, not 403).
- **Built-ins are rows** seeded by `seedBrandViews` (`packages/db/src/views.ts`) on brand creation,
  install, the dev seed and department creation. A brand that predates M1-05 gets its defaults on the
  first views read. Department views cascade on delete and follow a rename unless the brand renamed the
  view. Renamable, reorderable, hideable; `view-is-built-in` (409) otherwise.
- **Counts** are one statement per request (a capped scalar subquery per view, `LIMIT 1000`), gated as
  `list · view counts (sidebar)`. `0022` adds `tickets_brand_status_updated_idx`.
- **Admin UI**: the sidebar's Views group with "Mine", Save as a view, Rename, Share with…, the
  "Filters changed · Reset · Save as new · Save" bar (`Admin/View-Dialogs` panels 1–4), and the
  Ticketing › Views tab. `?view=<id>` plus the filter set with `custom=1` keeps the URL the state.

### M1-07 Assignment

Migration `0015_assignment`: departments gain `assignment_mode`, `load_cap`,
`auto_unassign_offline`, `auto_unassign_after_minutes`, `on_unassign`; new
tenant tables `assignment_agents` and `assignment_skills`. Guide:
[ticketing settings › Assignment](../guides/ticketing-settings.md#assignment).

- **Rotation** (round-robin, skill-based) runs in the worker from `assignment.requested`, written in the same transaction as a ticket created or moved unassigned into a routing department. Eligible = can work the department, in rotation, online, under the cap; longest waiting first. Skills match among the eligible, falling back to everyone eligible. A per-brand `pg_advisory_xact_lock` makes concurrent picks cap-safe.
- **Manual assignment** is held to the ticket's department and to DOMAIN-RULES §1.2's ceiling: only an Admin assigns to an Admin (`assignee-above-actor`, 403). The cap never refuses a person. A move the assignee cannot follow clears the assignee.
- **Assignable read** for the picker: `GET /brands/:id/assignment/:departmentId/assignable` under `ticket:write`.
- **Auto-unassign on offline**: `STAFF_OFFLINE_HOOK` writes `assignment.staff_offline`; the worker adds one delayed `assignment.offline_unassign` job per department that asks for it, on the `assignment` queue.
- **`on_unassign`**: after a role or department change, deactivation or removal, `StaffLifecycleHooks` write `assignment.access_changed` in the request's transaction.

### M1-09 Merge and split

Merge, unmerge and split per DOMAIN-RULES §2.4, and "is replying" on the
collision indicator, from `AdminTicketDialogs` panels 1, 2, 4 and 7. Guide:
[tickets › Merge and split](../guides/tickets.md#merge-and-split).

- **Migration `0016_merge_and_split`**: the columns an unmerge restores from
  (`merged_at`, `merged_by_id`, `pre_merge_status_id`, `pre_merge_department_id`,
  `merge_message_id`, `merged_ms`), a split's provenance
  (`copied_from_message_id`, `copied_from_attachment_id`, with `s3_key` unique
  among originals only), `ticket_statuses.system_key`, and the
  `tickets_merged_follow_primary` trigger. No new tenant table.
- **A merge moves the secondary into the primary's department**, and the
  trigger keeps it there, so access to its messages and attachments follows the
  primary under the ordinary policy. Unmerge moves it back; with a deleted
  primary it is refused as `merge-primary-deleted` (409).
- **Participants**: M1-13's `ParticipantsMergeHook` makes the secondary's
  contact a `merge` CC of the primary, and an unmerge takes that CC off again
  (never one an agent added).
- **Split copies and retention**: a split's attachment copies share their
  original's object, so a purge queues an object only when no other row names
  its key.

### M1-11 Spam

- **Schema** (migration `0017_spam_and_block_list`): `ticket_statuses.is_spam`,
  generated from `system_key = 'spam'`; `blocked_senders` (brand-scoped, unique
  on `(brand_id, kind, value)`, with `dropped_count` and `last_dropped_at`).
- **Lifecycle**: `markSpam` / `unmarkSpam` on §2.2's `mark.spam` row. Spam fires
  `onResolved`, never `onClosedForCsat`, and enqueues `ticket.spam` instead of
  `ticket.closed`, also when Spam is picked from the status picker. "Not spam"
  is an agent reopen.
- **Contract for later milestones**: `isSpamStatus` and `countsInReports` in
  `@helpdock/schemas`; `isSenderBlocked` in `apps/api/src/ticketing/sender-gate.ts`.
  Own senders are the install's `smtp.from` and the brand's `brand_domains`;
  per-brand mailboxes (M2-08) join the check when they exist.
- **UI**: Ticketing › Spam tab and the Mark as spam dialog (`AdminTicketingSpam`,
  `AdminTicketDialogs` panels 2 and 5).

### M1-12 Time tracking and CSAT

- **Schema** (`0018_time_tracking_and_csat`): `ticket_time_entries` and `csat_responses`, both department-scoped on the shared ticket-child triggers. Brand settings gain `csatEnabled` (on), `timeTrackingEnabled` (off), `timerStartsWithComposer` (off). No new environment keys: the link key is derived from `APP_MASTER_KEY`.
- **Survey creation** goes through the outbox: `onClosedForCsat` writes `csat.requested` when the brand has CSAT on; the worker creates one row per `(ticket, closed_at)` and skips a close undone before it ran. Spam and merged tickets are excluded.
- **The per-reply timer** rides on `POST …/messages` as `timeSpentSeconds`; dropped, not refused, while tracking is off.
- **The rating page** is at `/csat/<token>` in the admin bundle ([ADR 0010](../decisions/0010-csat-page-in-the-admin-bundle.md)); the Feedback tab's Preview opens `/csat/preview` over a fixed sample.
- **The header ⋯ menu** is one items array (`ticket-actions-menu.tsx`): Merge, Split, Log time, then Mark as spam behind a divider.

### M1-13 Contact identity rules

DOMAIN-RULES §2.5, §4.4. Guides: [contacts](../guides/contacts.md#identity-rules-and-merging-m1-13), [tickets](../guides/tickets.md#participants-m1-13).

- **Verification comes from the source, not the caller.** `IDENTITY_SOURCE_RULES` in `packages/schemas/src/identity-rules.ts` is the §4.4 table as data; `findOrCreateContactByIdentity` takes `{ kind, value, source }`.
- **Auto-merge needs both sides verified.** A verified claim meeting an identifier another contact holds unverified starts a new contact that takes the identifier and leaves a duplicate suggestion; an unverified claim never joins anybody.
- **Duplicate reasons:** the identifier kind, or `similar_name` (same account, pg_trgm `similarity` ≥ 0.4). "Not the same" is permanent for the pair in both directions.
- **Merge** (`POST /contacts/:survivorId/merge`) moves identifiers as they are, notes, and every ticket, hidden departments included, through `helpdock_contact_reassign_tickets`. **Undo** within 24 hours moves back exactly what the merge moved. Anonymised contacts cannot be merged, and a merged contact cannot be anonymised.
- **Participants:** `ticket_participants` holds the CCs; `GET/POST/DELETE /tickets/:id/participants`.
- **Migration** `0019_contact_identity_and_participants`: `contact_merges`, `ticket_participants`, `contacts.merged_into_id`/`merged_at`.
- **Merge with any contact** came with M1-15 part 2: the contact's ⋯ menu › Merge with… reads `GET /contacts?mergeable=true`.

### M1-14 Data retention

[The data retention guide](../guides/data-retention.md) is the reference.

- **Schema** (migration `0020_data_retention`): `retention_settings`, one row per brand, and `tickets_brand_closed_at_idx`.
- **API**: `GET`/`PUT /api/brands/:brandId/retention`, `brand:manage` (Admin). Zod refuses a partial form and an audit log under 90 days.
- **Worker**: `maintenance.retention.schedule` at 03:00 UTC adds one `maintenance.retention` per brand and purges `job_receipts`; each brand's run purges closed tickets (never by default), spam, the audit log and the published outbox in batches of 500, and ends with a `retention.purged` audit row carrying counts only.
- **Objects**: a purged ticket's attachment keys ride a `media.objects.purge` outbox row; the handler refuses any key outside the brand's prefix.
- **Erasure** deletes the attachments a contact sent and clears `external_message_id` on their messages; bodies stay.
- **Cascades**: CSAT and future AI calls go with their ticket by `ON DELETE CASCADE`; the retention suite fails for a foreign key into `tickets` that neither cascades nor sets null.
- **Admin UI**: `/admin/brand/danger` with the Data retention card, and the type-the-name Anonymise dialog.

### M1-15 The ticket list index set and the 50k gate

- **Index set** (`0021_ticket_list_indexes.sql`): `tickets_brand_updated_idx (brand_id, updated_at, id)`;
  `(brand_id, assignee_id, updated_at, id)`; the department/status index gains `id`. Every ordered list
  index ends in the keyset `(updated_at, id)`.
- **The list names its brand** (`tickets.brand_id = :brandId` beside the policy's `= ANY(app.brand_ids)`),
  so the planner reads the brand's index in order and stops after one page. Isolation stays with RLS.
- **Rows embed `contact: { id, name }`** on the list and the ticket read, when the caller holds `contact:read`.
- **The gate** is `pnpm --filter @helpdock/api perf:tickets` (`apps/api/src/testing/perf/`): the §14 dataset,
  two api replicas, 50 staff sessions, Admin and department-restricted Agent.
  Method, plans and numbers: [tickets guide, Performance](../guides/tickets.md#performance).

### M1-15 part 2, ticket search through a token table

- **Migration** `0023_ticket_search_tokens`: `ticket_search_tokens (ticket_id, brand_id, department_id, token)`,
  brand- and department-scoped, written only by triggers on a ticket's insert, a subject edit and its first
  message, in the same transaction, and moved with the ticket's department. Also `tickets_brand_contact_idx`.
- **Query**: `q` → lexemes → all-of match on `ticket_search_tokens_brand_token_idx`. The fuzzy fallback runs
  only when the exact half returns less than a page and the term has three or more characters, and reads the
  same index, so a zero-match search never reads every ticket.
- **Proved** by an integration test that `EXPLAIN`s both halves as the runtime role under RLS, and by the
  benchmark: zero-match p95 went from 284 ms alone to 56 ms inside the full load.

### M1-15 part 2, the admin UI gaps

No migration. Guides: [tickets](../guides/tickets.md#linked-tickets), [contacts](../guides/contacts.md#identity-rules-and-merging-m1-13).

- **Linked tickets**: the read's `related` is `RelatedTicket[]`, each with a `relation` (`parent`, `mergedInto`, `mergedFrom`, `splitFrom`, `splitTo`) and the linked ticket's status. A link the reader cannot open is `{ visible: false, relation }` and carries nothing else (§1.2).
- **Arabic horizontal overflow**: a visually-hidden span sized `width: 1`, which MUI reads as `100%`, is replaced by one shared `ui/visually-hidden.ts`. `e2e/linked-tickets.spec.ts` asserts no sideways scroll at 1440 and 1280 in both locales.
- **CSAT**: the rating page's "closed by <first name>" is sent only when the closer is active staff who wrote a public reply on the ticket, which is how we read §4.6's "nothing beyond their purpose".

## Integration

M1-07, 09, 11, 12, 13, 14 and the M1-15 data side were built in parallel and
integrated on one branch before #73. What the merges had to decide:

- **Migrations** run in number order, 0015 → 0021, with snapshot `prevId`s
  chained in that order; the 0021 snapshot is regenerated from the full schema,
  so `drizzle-kit generate` finds nothing to do.
- **`helpdock_ticket_department_moved`** carries every child table (messages,
  activity, attachments, tags, participants, time entries, CSAT responses and,
  from 0023, search tokens). The follow-the-primary trigger is separate.
- **Backfills under FORCE RLS**: 0016, 0017, 0020 and 0023 lift the force around
  their `UPDATE`s, so existing brands are backfilled when the migration role is
  not a superuser.
- **One PR** for the integrated deliverables, because they were resolved against
  each other (spam model, menu, merge CCs, shared attachment objects) and
  separate PRs would each have been incomplete.
- **Screenshot baselines** were re-rendered by the screenshots workflow on the
  integrated branch (runs 36068915967 and 36125308634).

## Open questions

- Should a Team Leader read only their own departments' rows of the staff list and contact timeline? Carried as a gap above; DOMAIN-RULES §1.2 does not narrow it.

## Pull requests

- #61 milestone doc
- #63 tickets, threads and the activity log (M1-02, M1-03)
- #64 contacts, accounts and the identity seam (M1-04); #65 its screenshot baselines
- #66 brands, departments, teams and team members (M1-01)
- #68 team membership follows the role-change ceiling (DOMAIN-RULES §1.2)
- #69 ticket state machine, escalation and the Statuses tab (M1-08)
- #70 the ticket workspace (M1-15, part 1)
- #71 attachments and the media pipeline (M1-10)
- #72 tags, custom fields and ticket templates (M1-06)
- #73 assignment, merge and split, spam, CSAT and time, identity rules, retention, and the list gate (M1-07, 09, 11, 12, 13, 14, 15)
- #74 saved views, search through a token table, and the last workspace gaps (M1-05, M1-15 part 2)
