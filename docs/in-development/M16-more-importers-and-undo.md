# M16 More importers and undo

Status: planned (not started)
Owner: @Docker-Hunterpedia
Phase: 5 — 1.x. Proposed release: 1.2 (owner decision D-01)
Depends on: M11 (engine, wizard, writer). M15 helps with the backup reminder but is not required.
Effort: about 79 working days for one person (see Deliverables)
PRD: [Phase 5 · M16](../planning/PRD.md#m16-more-importers-and-undo)
Owner decisions: D-40 to D-45 in [decisions-1-x.md](../planning/decisions-1-x.md#m16-more-importers-and-undo)
ADRs (proposed): [0045](../decisions/0045-import-provenance-ledger-and-undo.md) (amends 0027), [0046](../decisions/0046-imported-configuration-as-disabled-drafts.md)

Five more connectors, an Undo import that removes only what a run created, and macros, SLA policies and automations brought over as disabled drafts.

**Effort convention.** Working days for one experienced contributor working with
AI agents, Definition of done included. The five connectors are 29 of the 79 days,
about double M11's original 14.5-day estimate for them, which reflects what M11's
three connectors actually took (the Zendesk and Zoho Desk connectors are about
11,000 lines between them).

## Goal

A team leaving **Help Scout, Intercom, Gorgias, Zammad or Front** moves into a brand
with the same quiet, dry-run-first wizard that Zendesk, Freshdesk and Zoho Desk have.
An admin who imported into the wrong brand, or with the wrong mapping, presses
**Undo import**: Helpdock removes only what that run created and keeps every ticket
someone has worked on since. Macros, SLA policies and automations come over as
**disabled drafts** with a report of what translated and what did not, so nobody
rebuilds them from a blank page and nothing behaves differently by surprise.

## What exists today

Checked against the code and the [importing guide](../guides/importing.md) on
2026-10-20:

- **Pause and resume exist**: `POST /:runId/pause` and `/resume`, with `pausedFrom`
  (importing guide, "Staff API").
- **"Bring over changes" exists as delta sync**: a `delta` run from a completed
  parent connects the same account again (importing guide, runbook step 7).
  Credentials are purged when a run ends, so every delta means pasting credentials
  again.
- **Undo does not exist**: "Cancel does not delete history … cancellation is not
  rollback" (importing guide). The runbook's only way back is a full restore.
- **No provenance per run**: `import_external_ids` has `imported_at` and
  `payload_hash` but no run id, and no record of whether an object was **created**
  or **matched** (an existing contact attached by email, an existing tag).
- **The source enum already includes all five sources**: `import_source` =
  `zendesk | freshdesk | zohodesk | helpscout | intercom | gorgias | zammad | front | file`
  (`packages/db/src/schema/enums.ts`). The Front card is already drawn in the
  source chooser (M11 artboards). No enum migration is needed for sources.

## Ids: M11-19 to M11-23 become M16-04 to M16-08

Decided in this plan: **renumber them, keep the issues.** Move #201–#205 to the new
GitHub milestone "M16 More importers and undo" and retitle them (for example
`M16-04 Help Scout connector (formerly M11-19)`). Then close the M11 GitHub
milestone, whose only open issues are those five.

Reasons:
- PRD §3 says a milestone ships when every issue is closed, so M11 cannot formally
  close while they sit there.
- The connectors now depend on M16's undo ledger and exit criteria, which do not
  belong to M11.
- Issue numbers and history are preserved.

The PRD's M11 row carries the line "M11-19 to M11-23 moved to M16-04 to M16-08".

| Was | Now | Issue | Connector |
|---|---|---|---|
| M11-19 | M16-04 | [#201](https://github.com/Docker-Hunterpedia/Helpdock/issues/201) | Help Scout |
| M11-20 | M16-05 | [#202](https://github.com/Docker-Hunterpedia/Helpdock/issues/202) | Intercom |
| M11-21 | M16-06 | [#203](https://github.com/Docker-Hunterpedia/Helpdock/issues/203) | Gorgias |
| M11-22 | M16-07 | [#204](https://github.com/Docker-Hunterpedia/Helpdock/issues/204) | Zammad |
| M11-23 | M16-08 | [#205](https://github.com/Docker-Hunterpedia/Helpdock/issues/205) | Front |

## Scope

In scope:
- five connectors;
- the provenance ledger and Undo, with a preview;
- automatic pause when credentials are refused, and "Resume with new credentials";
- an opt-in to keep credentials for "Bring over changes" for up to 30 days;
- importing macros and canned responses, SLA policies with business hours, and
  automations as disabled drafts, from the sources that expose them;
- docs.

## Non-goals

- Importing views.
- Side conversations and call recordings (unchanged from M11).
- Undo for runs made before this milestone's migration, beyond tickets and articles
  of a whole source chain (D-40).
- Enabling imported automations automatically.
- Real-time two-way sync with the old tool.
- Connectors beyond these five (Kayako, HubSpot Service, Salesforce Service Cloud,
  osTicket and others stay in the backlog).
- Article locales beyond the brand's enabled locales ([M17-04](M17-apps-and-languages.md)
  widens this).

## Deliverables

| Id | Deliverable | Spec | Effort (d) | Depends on |
|---|---|---|---|---|
| M16-01 | **Provenance ledger.**<br>• New tenant table `import_created_objects`.<br>• `import_external_ids` gains `first_run_id uuid null` and `disposition import_disposition ('created','matched') not null default 'created'`.<br>• The writer records **every** object it creates (tickets, messages, attachments, contacts, identities, accounts, tags, custom-field definitions, invited staff placeholders, categories, sections, articles, `hc_import_assets`, CSAT rows), and the **matches** it makes (an existing contact attached by email, an existing tag).<br>• A delta records objects it created, and appends to messages under `entity = message` for that delta's run id.<br>• RLS, `TENANT_TABLES`, negative suite.<br>• The `check-import-writer` script fails the build when the writer inserts into a tracked table without recording it (one helper, `recordCreated()`). | ADR 0045, new D §2.9 | 4 | — |
| M16-02 | **Undo plan (read-only).** `GET /api/brands/:b/imports/:runId/undo-plan` computes from the ledger, under the run's brand:<br>• tickets to remove;<br>• tickets to **keep** because touched, with the reason ([rules](#undo-rules-proposed-domain-rules-29));<br>• contacts, companies, tags, fields, invitations and articles to remove or keep, each with its reason;<br>• which later delta runs depend on this run.<br>Paged lists of the kept items, a stable plan token, and an error if the run is running. | D §2.9 | 3 | M16-01 |
| M16-03 | **Undo job.** `POST /:runId/undo { planToken, confirm: "<brand prefix>" }` enqueues `import.undo` through the outbox: claim-fenced, resumable, about 200 objects per transaction.<br>• Deletes in reverse load order: tickets with their messages, attachments (S3 objects via `media.objects.purge`), search tokens, participants, tags links and imported CSAT; then contacts, accounts, unused tags and fields, pending invitations, articles, empty sections and categories, unreferenced `hc_import_assets`.<br>• Rebuilds report rollups over the affected range, and removes the run's ledger rows and its `import_external_ids` rows for **removed** objects.<br>• Kept tickets keep their external ids, so a later import **updates rather than duplicates** them.<br>• New statuses `undoing` and `undone`; credentials purged at start; one undo per brand at a time; refused while any run of the brand is loading.<br>• Undoing a full run whose deltas are still present requires undoing them first, or `cascade: true` (the UI offers "Undo this import and its 2 updates").<br>• Audit: `import.undo_requested` and `import.undone` with counts, never values.<br>• Sends nothing: no outbox events besides purge and reindex, no webhooks, no notifications except one in-app notice to the requester when done. | D §2.9, §11 | 7 | M16-02 |
| M16-04 | **Help Scout connector** (formerly M11-19, [#201](https://github.com/Docker-Hunterpedia/Helpdock/issues/201)). Inbox API 2.0 with OAuth2 client credentials: conversations, threads (customer, reply, note, line items as activity), customers, mailboxes → departments, tags, custom fields, satisfaction ratings, attachments; Docs API key for collections, categories and articles. No priorities, so everything maps to normal. Rate limits per the vendor's documentation, rechecked in the PR. Stand-in, full and delta runs. | ADR 0027 (10) | 6 | — |
| M16-05 | **Intercom connector** (formerly M11-20, [#202](https://github.com/Docker-Hunterpedia/Helpdock/issues/202)). Access token and region (US, EU, AU): conversations and parts (comments, notes, assignments as activity), contacts (users and leads), companies, teams → departments, admins → staff, tags, conversation ratings, Articles and collections. Fin and workflow parts are "name only, Fin" authors. The API is reported to cap the parts returned per conversation (around 500; to be verified against Intercom's documentation in the PR), so truncated conversations get a dry-run warning. Stand-in, full and delta. | ADR 0027 (10) | 7 | — |
| M16-06 | **Gorgias connector** (formerly M11-21, [#203](https://github.com/Docker-Hunterpedia/Helpdock/issues/203)). Basic auth with email and API key per account subdomain: tickets, messages (channel per message), customers, users, teams, tags, satisfaction surveys, custom fields. No help center. Stand-in, full and delta. | ADR 0027 (10) | 5 | — |
| M16-07 | **Zammad connector** (formerly M11-22, [#204](https://github.com/Docker-Hunterpedia/Helpdock/issues/204)). Token on the **operator-supplied base URL**: tickets, articles (internal → note), users, organisations, groups → departments, states and priorities, tags, knowledge base. **SSRF:** Zammad is often self-hosted on a private network, so the URL goes through `safeFetch` with that one host on the allow-list, and a private address needs `OUTBOUND_ALLOW_CIDRS`. The wizard says so. Stand-in, full and delta. | ADR 0027 (10), D §13 | 5 | — |
| M16-08 | **Front connector** (formerly M11-23, [#205](https://github.com/Docker-Hunterpedia/Helpdock/issues/205)). API token: conversations, messages, comments → notes, contacts, inboxes and teammates → departments and staff, tags, custom fields. No help center (Front Knowledge Base is optional: include it if its API covers export, otherwise log it as a gap). Plan-dependent rate limits are low, so throughput is documented. Stand-in, full and delta. | ADR 0027 (10) | 6 | — |
| M16-09 | **Credentials and the cutover loop.**<br>• A `credentials-refused` mid-run moves the run to `paused` with reason `needs_credentials` and notifies the starter. "Resume with new credentials" accepts only the **same source account key**.<br>• An opt-in **Keep the connection for "Bring over changes" (up to 30 days)** on completed connector runs keeps the encrypted credentials; an hourly sweep purges them after 30 days or on "Finish migration".<br>• "Bring over changes" creates the delta from the run card in one click.<br>• Optional schedule: every 1, 6 or 24 hours until Finish.<br>• Notifications on done, failed and needs-credentials, through the outbox: a new `import` event type in the M3-07 preference matrix (in-app, email, push), sent to the run's starter and the brand's admins. | ADR 0045 | 5 | — |
| M16-10 | **Replies and macros import.** Zendesk macros, Freshdesk canned responses, Zoho Desk templates, Help Scout saved replies, Intercom macros, Gorgias macros, Front message templates, Zammad text modules → Helpdock canned responses and macros (M3-06).<br>• Placeholders translated where a 1:1 exists (`{{ticket.requester.first_name}}` → `{{contact.firstName}}`); the rest are left visibly as `[[unmapped: …]]`.<br>• Macro actions mapped when 1:1 (set status, priority or tag, assign); others listed in the report.<br>• Imported **disabled**; en and ar variants by source locale. | R §4.1, ADR 0046 | 6 | M16-01 |
| M16-11 | **SLA policies and business hours import** (Zendesk, Freshdesk, Zoho Desk, Zammad): schedules, holidays and timezones → M3-01 business hours; policies → M3-02 SLA policies, **inactive**, with targets per priority. Conditions that Helpdock's SLA matcher cannot express are listed. Applying a policy stays the existing explicit "Start SLA clocks" action. | R §4.2, ADR 0046 | 5 | M16-01 |
| M16-12 | **Automations as disabled drafts** (Zendesk triggers and automations; Freshdesk dispatcher, supervisor and observer rules). Conditions and actions translate through a per-vendor table into the M3-03 rule schema.<br>• A rule translates only when **every** condition and action maps. Otherwise it is stored as a draft with `needs_review` and the original JSON (sanitised) for reference.<br>• Never enabled automatically. Enabling one runs the existing rule test-run first. | R §4.3, ADR 0046 | 8 | M16-01 |
| M16-13 | **Admin UI:**<br>• the run menu gains Undo, a **plan dialog** with counts, the kept list and a typed brand prefix, undoing progress and an undone summary;<br>• needs-credentials state;<br>• Keep connection and schedule controls;<br>• five connection forms (Zammad with a URL field and private-network hint);<br>• an "Imported settings" review screen (macros, SLA policies and rules as drafts, with their translation notes and Enable or Delete);<br>• the rule list's "Imported, needs review" chip. | R §4.10 | 8 | M16-03, M16-09–M16-12 |
| M16-14 | **Docs:**<br>• importing guide sections per vendor, Undo (what is kept and why), imported settings, cutover loop, the credentials retention choice;<br>• data-retention guide (the ledger);<br>• ADR 0045 and 0046 accepted;<br>• DOMAIN-RULES §2.9;<br>• OpenAPI. | AGENTS DoD 1 | 3 | all |
| M16-15 | **Manual mapper templates.** The file step of the manual mapper (M11-15) offers a download of a CSV template for each entity (contacts, accounts, tickets with their first message, and messages, one row per message with its ticket's external id), with a header row, one example row in English and one in Arabic, and the mapping preset that matches it, so a team exporting from a tool without a connector starts from a known shape. Templates are static files in the admin bundle, documented in the importing guide. Found in the prior-art sweep of 2026-10-20. | R §4.10 | 1 | — |

**Total: about 79 days** (15–16 weeks; 78 for the draft's deliverables and 1 for M16-15); about 7 weeks of calendar time with two
people (one on the engine and UI, one on connectors).

## Data model

One migration, numbered with the next free number at implementation time
(`0054_imports` is the last shipped).

```
import_created_objects                          -- tenant table, FORCE RLS
  brand_id uuid, run_id uuid  fk (brand_id, run_id) → import_runs
  entity import_entity                          -- reuses the M11 enum (+ 'macro','sla_policy','business_hours','rule','invitation')
  helpdock_id uuid
  disposition import_disposition                -- created | matched
  department_id uuid null                       -- tickets: for the department-scoped undo plan read
  created_at timestamptz
  primary key (brand_id, run_id, entity, helpdock_id)
  index (brand_id, entity, helpdock_id)         -- "which run created this?"

import_external_ids
  + first_run_id uuid null                      -- run that first wrote the row
  + disposition import_disposition not null default 'created'

import_runs
  status  + 'undoing' | 'undone'
  + undo_plan jsonb null, undo_started_at, undo_finished_at, undo_counts jsonb
  + credentials_keep_until timestamptz null     -- M16-09 opt-in
  + schedule_interval interval null             -- M16-09
  + needs_credentials boolean not null default false

canned_responses, macros, sla_policies, business_hours, workflow_rules
  + imported_from jsonb null                    -- {source, runId, externalId, untranslated:[…]}
  + import_review_state ('needs_review'|'reviewed') null
workflow_rules.enabled stays false for imported rows until a person enables it
```

**Retention.** `import_created_objects` rows live as long as the run is undoable,
which is indefinitely until the run is undone or the brand is deleted. The size is
one row per created object, which is acceptable. The staging tables keep their
30-day window. Undo works from the ledger, not from staging, which is why undo stays
available after staging is purged.

**Legacy runs** (completed before the migration) have no ledger. The migration
backfills only `tickets` and their `ticket_messages` and attachments, plus
help-center articles, from `import_external_ids` grouped by
`(source, source_account_key)`. Those can be undone **as a chain** (all runs of
that source account) and never per run. Contacts, companies and tags of legacy runs
are not undoable, because matches and creations cannot be told apart. The UI says
so (D-40).

## Undo rules (proposed DOMAIN-RULES §2.9)

Section number provisional; fixed in the PR that lands it.

A ticket created by the run is **touched**, and therefore kept, when any of these
exists after its `imported_at`:
- a `ticket_messages` row not in the ledger (a reply, note, or customer message
  that arrived live);
- a `ticket_activity` row whose actor is `staff`, `rule`, `api` or `ai`, including
  a status, priority, assignee, department, tag or field change by a person or rule;
- a merge, split or link involving the ticket;
- a time entry;
- a live CSAT response;
- a non-import attachment.

Two things do **not** count, because they are part of the import itself: the
explicit SLA activation for imported tickets, and a later delta of the same chain.
Retention or system maintenance does not count either.

Other objects:

| Object | Removed only when |
|---|---|
| Contact | Created (not matched) by the run, has no kept or native tickets, no live identities added since, no notes, merges or erasure records |
| Account (company) | Created by the run, and no remaining contact belongs to it |
| Tag | Created by the run, and no remaining ticket uses it |
| Custom field definition | Created by the run, no remaining values, not edited since |
| Invited staff | The invitation is still pending (accepted staff are never removed; only their imported authorship goes with the tickets) |
| Article | Created by the run with no native revision since; sections and categories only when empty |
| Macro, SLA policy, rule (M16-10 to M16-12) | Still disabled and never edited |

A kept ticket keeps its "Imported from" chip and its external ids. The undo summary
lists every kept object with its reason, and the list can be exported as CSV.

## Security and privacy

- **Authorization:**
  - Undo uses the same `brand:manage` permission as import.
  - The dialog requires typing the brand's ticket prefix and a fresh plan token, and
    the server re-checks the plan token: a run changed since the plan is refused
    with `import.undo-plan-stale`.
  - Undo adopts the step-up re-authentication that
    [M18-02](M18-sign-in-options.md) adds, if M18 has landed; it does not invent
    one of its own.
- **RLS:**
  - `import_created_objects` is a tenant table with brand RLS. It has a
    `department_id` column for tickets, but the undo job runs in system context with
    `all_departments` for that brand (DOMAIN-RULES §1.4). That is correct because
    only a brand admin can request it.
  - The plan endpoint's kept-ticket list runs in the requester's context, so it
    honours department RLS for display.
  - Negative tests: brand A cannot plan or undo brand B's run; a worker job for A
    touches nothing of B; an API key cannot call undo (staff routes only, as today).
- **Quiet both ways:** no `ticket.*` or `contact.*` webhooks for deletions (imports
  never emitted creations either), and no customer-visible effect. Asserted by the
  same side-effect table checks as M11-09.
- **Credentials:**
  - Keeping a connection for 30 days is opt-in, encrypted, never returned, purged by
    a sweep and on Undo, Cancel or Finish, and listed on the System Imports card.
  - The default stays "purge at completion" (M11 behaviour).
- **Connectors:**
  - Every vendor host goes through `safeFetch` with its allow-list.
  - The Zammad base URL is user input (DOMAIN-RULES §13): https only unless allowed
    by CIDR, and redirects re-validated.
  - Vendor HTML is sanitised by the existing message and article sanitisers;
    attachments go through the M1-10 pipeline and its MIME sniffing.
- **Imported automations cannot run** until a human enables them after a test run.
  Their stored source JSON is size-capped and rendered as text, never as HTML.

## Design artboards

Drawn by the orchestrating session on the design canvas before the screens are
built.

| Artboard | For | Must show |
|---|---|---|
| `Admin/Import-Undo` | M16-02, M16-03, M16-13 | The run menu; the plan dialog (counts to remove and keep, kept list with reasons, dependent deltas, typed prefix); undoing progress; undone summary with CSV export; legacy-chain variant; refused while loading |
| `Admin/Import-Run` (states) | M16-09 | Needs credentials; resume with new credentials; Keep connection opt-in; "Bring over changes" and its schedule; Finish migration |
| `Admin/Import-Wizard` (connect, 5 vendors) | M16-04–M16-08 | One drawn variant per vendor's fields (Help Scout app id/secret plus Docs key; Intercom token and region; Gorgias subdomain, email and key; **Zammad URL with the private-network hint**; Front token) |
| `Admin/Import-ImportedSettings` | M16-10–M16-12 | A table of imported macros, SLA policies and rules with translation status; detail drawer with untranslated parts; Enable (runs the test first) and Delete |
| `Admin/Rules-ImportedChip` | M16-12 | The "Imported, needs review" chip in the rule list and builder |
| `Admin/Import-FileMapper` (amended) | M16-15 | The "Download a template" menu on the file step, per entity |

The admin artboards are drawn in English with DESIGN §7's RTL rules, as M11's were.
Playwright still covers `ar`.

## Tests

- **Unit:**
  - the touched-ticket predicate, with one case for each rule in
    [Undo rules](#undo-rules-proposed-domain-rules-29);
  - undo plan assembly;
  - placeholder and condition translation tables per vendor;
  - the 30-day credential sweep.
- **Integration (Testcontainers, against each vendor's stand-in):**
  - each connector: full run, delta run, 429 handling with `Retry-After`, refused
    credentials pausing the run, attachments;
  - **Undo, reference sequence**:
    1. Import the 500-ticket reference bundle.
    2. Have an agent reply on 3 tickets, a rule tag 2, and a new live email thread
       onto 1.
    3. Undo.
    4. Assert exactly 6 tickets kept with their reasons; every other created row
       gone, including S3 objects (MinIO) and search tokens; matched contacts
       untouched; reports rebuilt; no webhook, email or notification rows besides
       the requester's notice.
    5. Re-import: kept tickets are updated, not duplicated.
  - Undo of a full run with deltas: refused without cascade, works with it.
  - A worker killed mid-undo resumes without errors or double deletes.
  - The legacy-chain backfill on a 0054-era fixture.
  - RLS negative suite for the new table.
  - SSRF: a Zammad URL resolving to 10.0.0.0/8 is refused without
    `OUTBOUND_ALLOW_CIDRS` and allowed with it.
- **Playwright (`en` and `ar`, with axe):** the Undo dialog and summary; needs
  credentials; each connect form's happy path and refusal; the imported-settings
  review; Enable runs the test-run.
- **Nightly** `import-reference` job grows to all eight sources.
- **Real-account runs** are external dependencies (below), as in M11.

## Docs

Listed in M16-14.

## ADRs

- [**0045**](../decisions/0045-import-provenance-ledger-and-undo.md) Import
  provenance ledger and undo (amends
  [0027](../decisions/0027-imports-through-one-normalised-record-engine.md)): the
  ledger, undo semantics, kept tickets staying linked, legacy chains, retained
  connections.
- [**0046**](../decisions/0046-imported-configuration-as-disabled-drafts.md)
  Importing configuration as disabled drafts with a translation report. Supersedes
  the M11 gap note "macros, automations, SLA policies are not imported" while
  keeping its reasoning: nothing runs until a person enables it.

No new dependencies: all five vendors are plain HTTPS JSON over `packages/net`.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Undo deletes something a person relied on | High | Ledger-only deletion, a broad "touched" definition, a preview with reasons, typed confirmation, audit, and a backup reminder in the dialog |
| The writer creates an object without recording it, which Undo then leaves behind | Medium | `recordCreated()` as the only insert path, enforced by `check-import-writer`, with a test comparing every created row against the ledger after the reference import |
| Vendor API differs from its docs (as M11 found) | Medium | Each connector's first task is rechecking the docs; stand-ins; real trial accounts as external dependencies |
| Imported automations mislead admins into enabling them blindly | Medium | Disabled, flagged, with untranslated parts shown; Enable forces a test-run |
| Keeping credentials 30 days widens exposure | Medium | Opt-in, encrypted, swept, visible, purged on Undo, Cancel or Finish |
| Intercom part cap or Front rate limits make imports slow or partial | Low | Dry-run warnings, documented throughput, resumable runs |

## External dependencies

| Needed for | Dependency | Status |
|---|---|---|
| M16-04 to M16-08 | Trial or sandbox accounts for Help Scout, Intercom, Gorgias and Front, seeded with the reference dataset; Zammad self-hosted in CI (a real Zammad container could replace the stand-in for one nightly run, about 1 day extra) | needed; not blockers, following the owner's M11 ruling of 2026-10-19 |

## Open questions

1. (D-40) Legacy runs: allow chain-level undo of tickets and articles only, as
   proposed, or no undo for runs made before this milestone?
2. (D-41) Is there an undo time limit? The proposal is none, with a warning when
   the run is older than 30 days.
3. (D-42) Should kept tickets stay linked to the source (proposed: no duplicates
   later), or be unlinked, as some tools do?
4. (D-43) Should "Keep the connection for 30 days" be offered at all, or should
   re-pasting credentials stay the only way?
5. (D-44) Automations: Zendesk and Freshdesk only in this milestone (proposed), or
   all sources?
6. (D-45) Connector priority if capacity is short. Proposed order by demand: Help
   Scout, Intercom, Front, Zammad, Gorgias.

## Build order

1. M16-01, then M16-02, then M16-03 (undo engine), in parallel with M16-04 and
   M16-05 (connectors don't need the ledger until they load, and the ledger lands
   first).
2. M16-09.
3. M16-06, M16-07, M16-08.
4. M16-10, then M16-11, then M16-12.
5. M16-13 (UI, built incrementally from the start on the drawn artboards), then
   M16-14. M16-15 whenever a slot is free.

## Exit criteria

- [ ] Help Scout, Intercom, Gorgias, Zammad and Front (stand-ins with the reference
  dataset) import into a brand with threads, authors, dates, notes, attachments,
  tags, fields and assignees intact. A delta brings only changes, and a resumed run
  loses and duplicates nothing.
- [ ] An import sends nothing, for all eight sources (the M11 criterion, extended).
- [ ] Undo removes exactly what the run created and keeps every touched ticket, with
  its reason shown, in the reference sequence. Matched contacts and pre-existing
  tags survive. A re-import afterwards duplicates nothing.
- [ ] Undo sends nothing and leaves no orphaned S3 object, search token or report
  row.
- [ ] Refused credentials pause a run, and resuming with new credentials for the
  same account continues it. Credentials for a different account are refused.
- [ ] Imported macros, SLA policies and rules arrive disabled with a translation
  report, and none of them runs until a person enables it after a test-run.
- [ ] Each downloaded mapper template, filled in, imports through its matching
  preset with no further mapping.
- [ ] Brand A cannot read, plan or undo brand B's imports (DOMAIN-RULES §1.6, new
  table included). A Zammad URL on a private address is refused unless allowed.
- [ ] Every new screen passes Playwright in `en` and `ar` with axe. #201–#205 are
  closed under M16 and the M11 GitHub milestone is closed.

## Planning-document changes when this milestone lands

The 2026-10-20 planning PR already moved "Importers beyond M11 … macros,
automations and SLA policies" out of the PRD §5 backlog and REQUIREMENTS §6. With
the deliverables:

- **DOMAIN-RULES:** new §2.9 Import provenance and undo (number provisional); §11
  retention for the ledger.
- **ARCHITECTURE:** §13 the `import.undo` job.
