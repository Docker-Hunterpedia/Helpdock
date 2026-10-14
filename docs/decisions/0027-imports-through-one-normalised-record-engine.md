# 0027 Imports through one engine of normalised records, written without side effects

Status: accepted
Date: 2026-10-13

## Context

A team moves to Helpdock when its ticket history comes along intact (issue #180).
The owner put importers for Zendesk, Freshdesk and Zoho Desk, more API connectors
where a vendor allows a full export, and a manual mapper for everything else into
1.0 as M11. Writing history through the normal creation paths would fire
everything a live ticket fires: auto-replies, CSAT surveys, rules, SLA timers,
notifications, webhooks, AI answers. Vendors rate-limit hard, so an import runs
for hours and must survive restarts.

## Decision

1. **Two phases.** *Extract* stages vendor data as normalised records in
   `import_records`; *load* turns staged records into Helpdock rows. A run can
   stop and resume at either phase from saved cursors.
2. **One normalised record model** (`packages/schemas/src/import.ts`) shared by
   every connector, the CSV mapper and the Helpdock import bundle (a zip of NDJSON
   files). The loader never sees a vendor's shape.
3. **Mappings are data** (`import_mappings`): statuses, priorities, groups to
   departments, agents to staff, fields, tags, channels; proposed by the
   connector and name matching, confirmed by an admin, validated by a dry run
   that writes nothing.
4. **A dedicated writer.** `ImportWriter` inserts tickets, messages, activity,
   tags, participants, contacts, accounts, CSAT and help-center rows directly. It
   does not call `TicketsService`, lifecycle hooks, reply delivery, auto-assign or
   `enqueueContactCreated`, and writes no `ticket.*`, `contact.*` or `email.*`
   outbox event. A check script fails the build if it imports any of them.
5. **The only events** an import emits are `attachment.uploaded` (media
   processing) and one `help_center.imported` (search reindex and knowledge
   re-chunk, not webhooks).
6. **Original times are kept** (`created_at`, message times, `closed_at`,
   `status_changed_at`); `tickets.imported_at` records when it arrived, and
   time-based rules measure from `greatest(status_changed_at, imported_at)`.
7. **New ticket numbers by default**; the vendor's number is kept in
   `import_external_ids` and shown on the ticket. Keeping vendor numbers is allowed
   only into an empty brand, with the sequence moved past the highest.
8. **Idempotency through `import_external_ids`** (brand, source, entity, external
   id → Helpdock id, payload hash). A repeated run writes nothing; a delta run
   updates changed tickets and appends new messages, never rewriting old ones.
9. **Jobs on a new `import` queue**, one brand's load never concurrent with itself,
   one ticket per transaction, `Retry-After` honoured without spending attempts,
   credentials encrypted and deleted when the run ends.
10. **Connectors** live in a new workspace `@helpdock/importers` behind one
    `Connector` interface, with an HTTP stand-in per vendor for tests (as
    `FakeGraph` for M10). All vendor HTTP goes through `safeFetch` with a per-vendor
    host allow-list.
11. **The manual mapper** parses CSV with `csv-parse` 7.x (streaming) and reads zips
    with `yauzl` 3.x (streaming), both new dependencies.

## Consequences

- A small set of downstream guards: time-based rules use `imported_at`;
  transcription skips `attachments.origin = 'import'`; the dry run warns when the
  brand's retention window would purge imported history.
- Reports must be rebuilt over the imported range explicitly (the rollup's
  normal window is 7 days); history older than 400 days needs the opt-in full
  rebuild.
- A connector is a thin adapter, so adding Help Scout, Intercom, Gorgias, Zammad
  or Front later does not touch the loader.
- Vendor API details drift; each connector's notes are corrected against the
  vendor's documentation in its own pull request.

## Alternatives considered

- **Load through `TicketsService` with a "silent" flag**: every hook and event
  path would need to honour the flag forever; one forgotten path emails a
  customer about a ticket closed in 2019.
- **Direct vendor-to-Helpdock loaders per vendor**: three copies of mapping,
  idempotency and side-effect rules, which then drift.
- **Third-party migration services**: paid, and they would need a Helpdock write
  API covering history (original authors and dates), which v1 does not expose.
- **Import over the public REST API**: the v1 API creates live tickets with live
  side effects by design.

## Amendments

### 2026-10-13 — one remaining-milestone PR and database invariants

The owner requested one PR for M11-07 through M11-23. Keep the dependency order,
per-connector official-documentation research and distinct reviewable commits.

Import child tables bind `(brand_id, run_id)` to the same run through composite
foreign keys, so a row cannot claim one brand while referencing another brand's
run. Delta parents likewise bind to their own brand. Terminal run states require
null credentials in the database, not only in application cleanup. Payload hashes
are lowercase SHA-256. These constraints reinforce the existing tenancy and
credential-purge decisions without adding a new table or protocol.

The outbound client gains an optional exact `allowedHosts` policy checked before
DNS on every redirect hop. Importers provide their documented API and download
hosts; a public redirect outside that list is refused. The existing DNS/IP, port,
credential-stripping and total-time protections continue to apply.

Bundle resource bounds are explicit: 2 GiB compressed and expanded, 100,000 ZIP
members, 64 KiB manifest, 4 MiB per NDJSON line and 100 JSON nesting levels. ZIP
links/encrypted members, traversal, duplicate members, missing attachments and
count mismatches are refused. Normal attachment directory entries are allowed.
Validation is streaming; failed extraction never advances to domain loading.

Dependency versions were checked against npm on 2026-10-13: `csv-parse` 7.0.3,
`yauzl` 3.4.0 and its matching `@types/yauzl` 3.4.0. ZIP reading uses the documented
3.4 promise/async-iterator API, avoiding a custom archive parser.

Delta parent deletion cascades to its dependent runs. Import runs remain permanent
under normal retention and have no user deletion route; this cascade makes the
existing batched brand purge work regardless of parent/delta deletion order. A
real-Postgres regression reproduced the restrictive-key failure before the fix.

### 2026-10-13 — shared attachment references and compiler guard

A source file appearing in several messages keeps one asset identity/storage key.
Other message references use the existing `copied_from_attachment_id` mechanism.
Sorted per-asset advisory locks prevent concurrent ticket transactions from
claiming different originals. Expiring URL query strings are excluded from the
message hash; message/file IDs, content metadata and body remain authoritative.
Imported-media completion must propagate the processed result to these copies.

The writer check uses the repository's TypeScript 7 token scanner; its native
compiler has no JavaScript `createSourceFile` API. The check rejects forbidden
hooks and imports outside the reviewed loader boundary, including dynamic module
loading and impure channel exports. Run it through `pnpm check:routes` or the
dedicated `pnpm check:imports`.

### 2026-10-14 — source metadata without silently dropping organization details

Accounts have a single primary `domain` and no notes column. Contacts support EN/AR
locale and normalized identities, but source platforms can return additional
domains, company notes, local phone strings and other locales. Nullable
`imported_details` JSON columns on accounts/contacts retain these bounded source
values. They are not authentication identities or arbitrary raw vendor payloads;
credentials and URLs are excluded. Existing output mappers whitelist fields so
these columns do not leak into ordinary API responses. Contact erasure must clear
its imported details along with name, locale, timezone, external ID and custom data.
Organization matching considers all retained source domains and refuses ambiguous
multiple-account matches. No contact or organization is merged automatically.

Profile imports preserve the existing local name/custom values when matching a
contact or company. New normalized identifiers are unverified; existing verified
identities keep their verification. Conflicting contact owners or company-domain
matches refuse loading rather than merging automatically. Supported regional
EN/AR locale codes reduce to their language, while raw locale/phone/timezone
values remain in imported details.

Source contact identity pointers remain stable across manual merge/undo; the
current profile resolver follows the existing merge chain. Erasure clears source
metadata and staged customer records for the survivor and its merged ancestors.
Historical invited staff may remain assignees when their brand/department role
is eligible; import does not activate them or send an invitation.

Supporting issue [#213](https://github.com/Docker-Hunterpedia/Helpdock/issues/213)
fixes an existing erasure uniqueness collision for multiple identifiers of one
kind. Profile erasure salts each placeholder with the identity row ID; existing
channel-trace callers keep their per-contact placeholder contract. This necessary
M11 gap fix is included in the owner-requested combined remaining-milestone PR.

### 2026-10-14 — historical CSAT provenance

The live `(ticket_id, closed_at)` uniqueness constraint cannot represent multiple
source ratings associated with a close. Imported responses gain source/external-ID
provenance and their own unique key. The live unique index remains, restricted to
responses without import provenance. A close timestamp may be unknown on an
imported rating; keep it null rather than invent a timestamp. A database shape
check still requires every live survey's close time, and every imported rating's
source, external ID, rating, rated time and `rated_via = import`. Live survey
lookup/insertion excludes imported responses. Reports count ratings on `rated_at`.

### 2026-10-14 — explicit historical staff grants

Import creates only new invited Agent accounts, scoped to the departments the
administrator confirms. The membership uses the existing `manual` source because
it is an explicit administrator grant, not an IdP group grant. It must survive
SSO sync. No invitation token or email is created; the existing Staff resend path
can issue the first invitation later. An existing global email is not enough to
grant membership: the operator must explicitly map an eligible staff member
already in this brand. This avoids cross-brand account linking and activation
through vendor data. Name-only authors have no account or role. New staff creation
is audited under the importing brand and system run actor.

### 2026-10-14 — fenced import worker claims

A heartbeat alone does not stop a worker that wakes after stale-claim takeover
from committing a second batch. Import runs therefore add a UUID `claim_token`,
checked under the run's row lock on every batch transaction, and `paused_from`
for durable resume of the exact interrupted phase. A partial unique index enforces one claim per brand,
with a 30-minute stale timeout and heartbeat renewal at page/batch boundaries.
Pause/cancel clear the token; takeover replaces it. The previous worker loses
write authority immediately at its next batch boundary. SQL requires complete
claim metadata on active phases and a resumable phase on paused runs. Terminal
runs clear claims and credentials.

### 2026-10-14 — durable extraction retries and opaque adapter failures

Retry deadlines and consecutive transient-failure counts live on the run, not
only in worker memory. A 429 spends no failure attempt; a committed page resets
the consecutive-error budget. Three consecutive vendor outages end the run,
while a graceful worker shutdown releases its claim and keeps credentials for
resumption. Known fatal errors and opaque adapter exceptions terminate with fixed
error codes and purge credentials. Raw adapter error messages and vendor bodies
are not persisted or returned; this deliberately favors credential privacy over
exception-detail diagnostics. Connector log messages use a fixed code allow-list.

### 2026-10-14 — source knowledge metadata and destination limits

Helpdock has categories and sections, not an arbitrary-depth knowledge tree.
Imported nested categories retain a private parent external ID and a bilingual
breadcrumb name, with an import-log warning. Missing parents and cycles are
blocked. Category/section source descriptions and article source descriptions
are retained in nullable private metadata; public descriptions still respect the
existing 300/160-character bounds. Article title storage and the shared schema
increase from 200 to 500 characters to match the normalized import contract.
Content exceeding remaining destination limits is blocked, not silently dropped.

Translation records share the source article's destination ID and preserve each
locale's original version dates, draft state and visibility. Repeat hashes avoid
overwriting local edits when source content is unchanged. Article bodies must
already reference ready same-brand WebP media before loading; media preparation
remains outside the transaction-only writer. No ordinary publication event is
emitted while loading history.

### 2026-10-14 — imported media settles silently

Imported ticket files use the existing ticket/attachment `/original` key layout,
not a separate run-specific format, so existing variant reads and retention
purges remain valid. Processing updates all imported rows sharing the same asset
key in the same brand, without emitting the live `attachment.ready` event.
Transcription also checks origin at both subscription and worker execution.
Preserving attachment origin and historical author display names through ticket
splits closes supporting issue #214 without changing ordinary split permissions
or download authorization.

### 2026-10-14 — atomic ticket checkpoints and bounded thread materialization

One ticket's domain writes, staged message/rating/attachment pointers and loaded
counters commit in the same fenced transaction. A checkpoint cannot omit or
alter staged thread records. Child pointers are updated in 1,000-record groups.
Before materializing a thread, measure its expanded staged JSON in PostgreSQL;
more than 50 MiB is blocked, with no partial load. Preview and dry-run validation
must apply the same bound. This protects worker memory without silently discarding
history; it is separate from the attachment byte limits.

Repeated and delta imports refuse deleted/purged local ticket targets instead of
reporting a dangling source pointer as success or reviving deleted data. Changed
source subjects participate in delta updates; creation dates remain original.

### 2026-10-14 — verified Zendesk traversal, ACLs and media

Use returned ticket/user cursor checkpoints and organization time checkpoints;
the original start-minus-one-hour delta proposal is a reconciliation overlap.
Ticket exports explicitly request all Support ticket types and retain deletion
tombstones. Hydrate per-ticket audits because account-wide audits omit archives.
Complete archived-comment equivalence and child-only redaction coverage are not
established by the docs; preflight/dry run must expose missing or unknown coverage.

Prefer OAuth, following current deprecation/distribution guidance. Guide editorial
permission groups are not read ACLs: preserve draft state separately from user
segments, default unrepresentable restricted readership to internal with a warning,
and never publish it by approximation. Support-authenticated media can redirect to
temporary CDN URLs; validate every hop, strip credentials across origins and
refresh from the stable source URL on expiry. Do not substitute Support tokens
for Sunshine Conversations credentials. Official sources and remaining gaps are
dated and linked in the M11-12 section of the milestone plan.

### 2026-10-14 — preserve source activity without replay

The normalized engine adds `activity` alongside messages. Source audits and
timeline events are neither public replies nor executable local mutations.
Preserve their source ID, author, action, before/after values, details and date
in department-scoped `ticket_activity`, using the fixed inert action
`ticket.imported.event`. Store the original action as source metadata. No new
tenant table is required; `import_entity` gains the new discriminator so bundle,
staging, source identity and progress records share one validated contract.

Source activity checkpoints commit with their ticket. Stable external IDs make
repeats no-ops and allow source event changes/redactions to update the same row.
Keep historical name-only authors without creating staff access. This closes
the plan's missing representation for audit history; it does not replay source
automation or replace the import-time administrative audit entry.

### 2026-10-14 — terminal watermarks and source CC ownership

SDK pages may retain a final `deltaCursor` alongside `cursor: null`. Commit it
with the final page; only completed, same-brand/same-vendor parent runs supply
initial delta watermarks. Current child continuations take priority on resume.
The date overlap remains a fallback/reconciliation input, not a substitute for
the vendor's durable cursor. Source-account binding is still a required invariant.

Normalized tickets retain vendor CC user IDs through `ccExternalIds`, with
explicit contact mappings required before load. Identity-only participants use
null addresses rather than invented email. Add `import` participant provenance
so a source delta can remove stale source-owned CCs without removing manual
participants. Known source email can fill an imported null address, while manual
addresses remain untouched. Email-only contact creation must validate required
fields. These changes replace the earlier additive-only CC delta behaviour and
close source relationship omissions without introducing delivery side effects.

### 2026-10-14 — profile provenance and resumable contact hydration

Normalized contacts retain native identity type/value/verification-method metadata
privately, alongside notes, descriptions and original profile dates. This does
not turn vendor verification into Helpdock verification or reinterpret foreign
social identifiers as trusted channel identities. Contact erasure clears the
existing private imported-details column. Organizations likewise retain source
descriptions and dates. New profiles can use complete original date pairs;
existing local profile dates are preserved.

Zendesk contact hydration checkpoints one profile at a time with a source-page
fingerprint and offset. On resume, a changed page is refused before completed
profiles are skipped. Cursor state contains a fingerprint and traversal position,
not emails, identity values or credentials. All subsequent authenticated
pagination must stay on the expected source origin and endpoint.

### 2026-10-14 — source satisfaction provenance

Retain normalized CSAT `sourceDetails` in a private nullable JSON column on
`csat_responses`, so staging purge does not discard native scores, scale semantics,
answer metadata, source actor IDs or timestamp provenance. Historical repeats
are inert; source deltas update the same answer and provenance together.

Zendesk legacy good/bad map to 5/1. Creation time is a documented source field,
not a proven submission time, so record the timestamp basis and emit a safe
warning. Current survey CSAT categories map bad/neutral/good to 1/3/5 while
preserving original numeric ratings, question definitions and every answer type.
Emit a normalization warning rather than presenting that conversion as the source
scale. Both APIs rescan on delta because creation-time filters do not prove that
old edits are included. API availability/completeness must be established before
approving a run; a failed endpoint is not a successful empty export.

### 2026-10-14 — nested section ancestry in a flat help center

Keep the destination's category/section model. Normalized sections carry their
root category and optional immediate source-section parent separately. Preserve
that source parent on the imported section row and use bilingual breadcrumb
names to expose the hierarchy, with a flattening warning. Do not create extra
categories for every source section or silently drop its parent relationship.

Resolve ancestors through scoped source identities, reject cycles and category
mismatches, and load parents before children. A nested child's idempotency hash
includes its parent's source hash, allowing source parent renames to update the
breadcrumb on delta. The shared breadcrumb formatter preserves existing category
behaviour and never manufactures a missing child locale. Flat section hashes
retain their prior shape.

### 2026-10-14 — atomic resolved-load receipts

Persist a hash of each resolved record-load request beside its staged checkpoint.
Native payload identity alone cannot detect a changed mapping or prepared body
when resuming a completed record. The load receipt, domain write, target pointer,
status and progress commit in the same fenced transaction. Refuse a changed
receipt rather than silently treating it as completed. Explicit field skips
receive a receipt and their own progress counter.

Apply the receipt to ticket/thread checkpoints as well. Resume validates source
identity and target availability. A contact's stable source pointer can follow a
manual merge to its current profile without rewriting the original staging
pointer; an article requires the imported locale version as well as its parent
article. These checkpoints do not replace the ordered runner or dry-run approval.

### Imported message source corrections

Imported source messages are updated in place when their source body, public/note
state, email metadata or date changes, or a confirmed author mapping is corrected.
They retain their local message ID and sequence. Sanitization still runs before
writes, and source receipts update in the same transaction. The import never
uses reply delivery to apply a correction. Download-URL rotation does not change
the message fingerprint. Attachment membership changes must reconcile media
before the corresponding source receipt can be acknowledged; the attachment reconciliation amendment below defines that transaction.

### Source attachment reconciliation and cleanup

Source attachment membership is reconciled in the same transaction as message
corrections. The writer may call the reviewed `enqueueObjectPurge` helper for
removed source-owned links, creating only `media.objects.purge` maintenance
events. It still cannot enqueue delivery events or invoke live ticket hooks.
Ordinary uploads are preserved, and shared bytes are deleted only after the last
link disappears. Changed native file metadata uses a fresh pending object so old
historical links retain their bytes. A brand/source advisory lock serializes
shared-asset changes across tickets. Download-URL rotation does not replace an
asset. This supersedes the temporary refusal of attachment membership changes in
the source-message edit checkpoint; physical downloading remains a separate job.

### Fenced physical attachment uploads

Reserve a fresh server-generated object key for each pending attachment download
attempt under the import loading claim. Shared pending links switch together;
network and object upload run outside the transaction. Only the live claim may
publish `attachment.uploaded` and mark the asset processing. Resumed attempts use
a different key, so a revoked in-flight upload cannot overwrite their bytes.
Old attempt keys use the transactional object cleanup helper. A stale upload
finishing after earlier cleanup requests cleanup again, while keys still named
by rows remain protected. Derived variants follow the stored object folder,
rather than rebuilding it from the logical attachment ID. Policy refusals keep
an explicit rejected placeholder and a safe warning, without processing events.

### 2026-10-14 — reference-only receipts

Customer user records alias imported contacts rather than creating staff users.
Group and tag records resolve confirmed run mappings rather than creating
departments, teams or tags. Their staged receipts retain the resolved target and
a hash of the payload and selection, with atomic progress and validated retries.
They do not create global `import_external_ids` entries for these aliases: a
customer pointer already exists as a contact, and group targets can be either
departments or teams. Staff user records retain their existing identity handling.
Contact aliases retain the original source pointer while validating the surviving
contact after manual merges, preserving existing merge undo semantics.

### 2026-10-14 — report ranges include subsequent backlog days

The milestone's proposed range ending at the last closure omitted the days on
which imported open tickets contribute to backlog. Rebuild from the earliest
loaded ticket creation day through the brand's current local day, in inclusive
31-day transactions. Keep the existing 400-day default and explicit
`rebuildAllReports` opt-in. Persist the next day with each chunk's rows so retries
resume rather than restarting. Freeze the local timezone and SLA reopen metric
choice for that checkpoint; refuse configuration changes mid-backfill rather than
mixing report grains. A completed report checkpoint does not repeat row writes.

### 2026-10-14 — one bounded help-center import event

Use `help_center.imported { runId }`, with the brand in the outbox envelope,
instead of placing every article ID in a single queue payload. Retained staged
receipts supply distinct article targets in keyset pages of ten, joining the
same-brand article table and skipping deleted targets. This keeps the event small
and limits bodies buffered by knowledge conversion. Article load checkpoints
record whether any version changed; unchanged repeat imports emit no event.
Completion, event, audit and credential purge share a transaction. Search, page
cache and knowledge subscribers handle the event; it has no webhook subscription.

### 2026-10-14 — vendor account namespaces

A vendor name alone does not identify the source: two Zendesk accounts can both
contain ticket 42. Add a SHA-256 `source_account_key` to runs and the external-ID
ledger, and include it in that ledger's primary key. Derive it from the vendor and
its verified canonical account identifier, not from credentials, so credential
rotation does not change identity. Resolve the namespace from the run inside the
writer rather than trusting a client-supplied key. Dependency selectors, thread
receipts and attachment identity lookups use that same namespace.

Pre-existing unbound runs and ledger rows retain a reserved all-zero namespace;
they are not silently attributed to an account. New connection and manual-file
flows must bind an account namespace before extraction/loading. Delta binding
requires a completed parent in the same brand, vendor and namespace. Binding may
change only before records exist, and cannot change active or terminal runs.

### 2026-10-14 — historical RFC headers are not live delivery keys

Preserve original RFC Message-IDs on imported messages, but mark their source
account with a nullable `ticket_messages.import_source_account_key`. The live
external-ID unique index excludes historical rows; native import identity remains
in the account-scoped ledger. Migration backfills known imported messages and
message copies. Split copies retain the marker and original historical mail
headers. Inbound email deduplication checks live rows only. Thread lookup prefers
real Helpdock deliveries, then live received email; a historical reference is used
only when it identifies one ticket. Ambiguous history never chooses an arbitrary
ticket, and a known ambiguous reference prevents fallback to a possibly reused
subject ticket number. Ordinary participant authorization still applies. Reject line breaks
and NULs in imported Message-IDs at the normalized boundary.

### 2026-10-14 — recover abandoned phase requests

A worker can die after a domain batch commits but before it publishes continuation.
An import recovery sweep runs every minute on maintenance, outside the potentially
busy import queue. It reads active brands globally, then reads/writes runs only in
brand system transactions under the same lock as controls and claim renewal.
Recover extracting/loading/finishing runs only when unclaimed or older than the
30-minute lease; respect retry deadlines and a one-minute request cooldown. Resume
loading first because its record checkpoints safely lead back to attachments.

`import.work_requested` is an additional internal control outbox event, necessary
for transactional start/continuation/recovery scheduling. It carries only phase,
run and optional delay, with the brand in the envelope. It has no customer, rule,
AI or webhook subscriber. Silent-import acceptance includes this control event
beside the already allowed media processing/cleanup and help-center reindex events.

### 2026-10-14 — exact per-run attachment destinations

The runtime derives the vendor API host from validated credentials. Vendor
attachment content URLs may point to external hosts, so `import_runs.options`
includes `downloadHosts`: at most 32 exact lowercase hostnames, with no URL,
port or wildcard. The connection/dry-run UI must show and confirm these hosts
before work starts; an unknown redirect remains a blocking completeness error
until its host is approved. This extends the documented vendor host list without
trusting arbitrary redirect destinations. Every hop still passes safeFetch DNS/IP
checks and account credentials are stripped on cross-origin redirects. Production
restricts destination ports to 443; internal CIDR exceptions continue to require operator configuration.

The initial runtime supports Zendesk; other source factories are added with their
verified connectors. Unsupported sources fail rather than selecting a fallback.
A bounded process-local account token bucket survives job continuations, but is
not a distributed cross-install rate limiter and resets on process restart.

The Zendesk runtime starts conservatively with ten local tokens at 60 requests
per minute. A local exhaustion delay refills the burst rather than only one
token: resumed pages may need to re-read their parent and hydrate a child before
writing the next cursor. Vendor Retry-After continues to take precedence.

### 2026-10-14 — durable identity claims for dry-run collision checks

Add nullable `import_records.dry_run_identity` to the existing brand-scoped,
FORCE-RLS staging table. Each successful contact/company preflight stores a
versioned projection: the staged payload hash, a proposed destination identifier
(`new:<source-ID hash>` or `existing:<local UUID>`) and hashes of normalized identity
claims. Contacts claim normalized email/phone values; companies claim normalized
domains. An unchanged import receipt adds no claims because the loader adds no
identities for it. The projection contains no readable email, phone or domain.

Commit these projections with each record-scan checkpoint. Reset them when a new
scan starts. Compare claims in Postgres across the current brand/run and entity,
considering only projections matching their staged payload hash. A claim pointing
at multiple proposed destinations blocks all participating source records; aliases
pointing at one existing destination are allowed. Return the complete affected
source count with at most 100 samples, without reading the complete identity graph
into worker memory. This changes only staging; it does not merge people/companies
or approve loading. Final approval must still validate input and live-target
freshness, media completeness and the other dry-run checks.
