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
7. **New ticket numbers in 1.0**; the vendor's number is kept in
   `import_external_ids`, shown on the ticket and searchable. This follows the
   owner's selected default; importing does not replace the local sequence.
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

### 2026-10-18 — source-file control and article-media events

The permitted control/media events include `import.file_uploaded`, which
requests private source-file sealing/validation, and `help_center.media_uploaded`,
which processes imported article images/files through the existing media worker.
They carry validated run/file or media references and are committed through the
outbox. They grant no customer-notification, rule, webhook or AI subscription.
The quiet-import allow-list is therefore `import.work_requested`,
`import.file_uploaded`, `attachment.uploaded`, `media.objects.purge`,
`help_center.media_uploaded` and the final `help_center.imported`. Source-file
preparation and article-media processing remain part of the existing M11 file
and media scope; this makes their event names explicit in the contract.

### 2026-10-18 — imported knowledge makes no provider calls

Search reindexing and knowledge re-chunking are local work. The import-completed
subscriber must not enqueue embeddings. Mark imported article language versions
as deferred for embedding; ordinary pending-embedding and full-reembedding jobs
must filter those versions before selecting provider inputs, including jobs that
were queued before the import. Full-text retrieval remains available. An explicit
staff publication, including a publication scheduled by staff, clears the
deferral for that language and resumes ordinary embedding. Unchanged import
repeats preserve that choice; a changed source version defers its replacement
again. This requires one internal boolean on `hc_article_versions`, no public
API option or new screen. This closes an audit gap where the existing knowledge
subscriber scheduled provider work for imported published text.

### 2026-10-18 — per-file dry-run availability is a sealed inspection

The bounded report issue list cannot prove a particular attachment is available:
an issue may fall beyond its first 100 samples. Persist `import_records.dry_run_media`
for ticket attachment records (migration 0080), containing the validated inspection
outcome and its source payload hash, dry-run fingerprint and content-policy hash.
Save it in the same fenced transaction as the media cursor. Preview reads expose
only the outcome after checking those bindings and that the current media cursor
has passed the record; a new, invalidated or changed-policy review shows not checked.
No source URL, storage key or secret is returned. This column is temporary staging
data and follows existing run retention. It does not authorize loading or replace
loading-time byte checks. The UI adds only a status caption to the existing file list.

### 2026-10-17 — Persist Zoho access tokens only inside the run's encrypted credentials

Reuse a validated access token across worker continuations through the existing
AES-256-GCM `credentialsEncrypted` blob. Its internal Zoho shape may carry an
access token and expiry alongside the refresh credentials; the public connection
schema never accepts that internal field. A worker refresh stores the new token
only after renewing the exact brand/run/phase claim, and publishes it to its
local session only after that save succeeds. Losing a claim or cancelling a run
must not recreate purged credentials. Terminal cleanup clears the same blob,
including the cached token, using existing constraints and cleanup paths.

Do not retain a process-wide map of plaintext refresh credentials or create a
second token store with a separate cleanup lifetime. Each connection coalesces
its own concurrent refreshes; later continuations and replacement workers read
the encrypted snapshot. This replaces the earlier process-wide session-cache
proposal. It adds no new setting, table, queue or external dependency.

The native `GET /myProfile` response is a permission profile, not an agent
identity. The official reference lists `Desk.permissions.READ` and
`Desk.basic.READ` for it (checked 2026-10-17). Connection probes must validate
the export profile and actual read capabilities rather than interpreting that
profile's `id` as an agent ID.

The local full-export connection probe conservatively requires the documented
Administrator profile and cross-department, recycle-bin, export and agent-field
permissions, then reads bounded samples from the required export endpoints.
Custom/restricted profiles and refused grants fail the connection check rather
than being described as a complete source connection. The probe includes one
satisfaction query, which the vendor prices at 50 credits. This restriction and
cost must be visible in the connection guidance. No write scope is requested.

### 2026-10-17 — Reconcile a changed article translation anchor through existing ownership

A source with an unsupported primary language may initially import only Arabic,
then add English later. Changing the supported fallback anchor must not create
a second destination article. Keep each locale's source ID and receipt intact.
Before allocating an unmapped primary article, look for one validated staged
translation that points to it and already owns a destination receipt in the same
brand, vendor and verified source account. Reuse that article only when the
staged relationship has the opposite language and the same current section.
Reject ambiguous, skipped, corrupt or inconsistent candidates and missing
destination rows. This inference never changes an existing receipt's target ID
and never grants permission to replace an unowned locale version.

Share this lookup between preflight and loading. Dry run must distinguish a
direct source binding from an inferred group destination so an occupied locale
still blocks import. Loading keeps its existing brand knowledge lock and
source-ownership checks. Add a partial expression index on the existing
`import_records` table for brand/run/article `translationOf` lookup; no new
tenant table or normalized record format is needed. Asset preparation remains
bound to the currently reviewed source relationship and locale, and files from
the previous relationship remain subject to the existing retention rules.

### 2026-10-17 — Zoho recycle-bin reads and translation grouping

Supplement ordinary taxonomy and article listings with the documented read-only
`/kbCategory/trashedCategories` and `/articleTranslations/trashedTranslations`
feeds. Preserve recoverable metadata and bodies without restoring or deleting
source records. Recycle taxonomy membership establishes trash state even though
its example omits `isTrashed`; distinguish root categories from sections using
the native root and parent relationships, rejecting inconsistent shapes. Article
trash rows lack `rootCategoryId`, so hydrate the identified translation before
using a parent. A source record that cannot be read stops extraction rather than
being replaced with a fabricated body or parent.

Both feeds use positive offsets, at most 50 rows, ascending `deletedTime`, a
current-page fingerprint and the previous full-page fingerprint. Refuse shifted
pages, backwards deletion times and repeated full pages. Ordinary article and
taxonomy readers also reject a repeated full page after advancing the offset.

Collect the supported translation indices before emitting either language.
Native `availableLocaleTranslations` hints recover deleted siblings absent from
live translation lists; validate native article/translation IDs, locale, trash
state and any supplied version. The recycle example omits versions from some
hints, so resolve those through a validated detail read and pin the resulting
version before extracting content. Active source primaries are traversed by the
ordinary feed; otherwise one deterministic deleted native translation represents
the group in the recycle feed. This avoids replaying the same article for each
deleted language without retaining an account-sized seen-ID set.

Keep an English or Arabic native source language as the first translation,
independent of status ordering, and link its siblings to that identity. Deleted
copies remain internal drafts even when they retain an older published snapshot.
Destination identity reconciliation when a new supported language changes the
fallback anchor of an unsupported native primary uses the ownership lookup in
the amendment above. Its local implementation and integration cases remain
unverified before M11 can be declared complete; this is not an accepted omission.

### 2026-10-17 — Separate working and published article copies

Zoho's documented `latestVersion`, `latestPublishedVersion`, `currentVersion`
and overall publishing status describe different facts. Importing only the
latest answer with the overall Published status could publish an unfinished
draft. Preserve both current working content and the last published snapshot
using Helpdock's existing working/published version columns. Extend normalized
articles with an optional explicit published snapshot; older single-copy
sources retain their current projection. A null snapshot means the source has
no published copy. Unknown original publication time remains null rather than
being replaced with an import timestamp.

Prepare and seal each copy's HTML and attachment set separately. The private
asset manifest may reuse an identical resource between copies, but a working
file must not be appended to the public snapshot. Loading validates both
prepared copies before writing either; public file authorization continues to
require an actual link in the published body. Source permission/ancestor
restrictions still apply before either copy becomes public. This adds no table,
dependency or new editor layout; it uses the editor's existing preview and
working/published model. Final acceptance must prove that draft-only text and
files never appear through public article, search, knowledge or file reads.

Article-list pagination starts without an explicit `from`, then compares a
bounded `from=1` probe to prove the native offset origin before advancing. Both
the inferred origin and the page fingerprint survive continuations; ambiguous
or shifted responses stop extraction. Delta knowledge reads rescan translations
because the official modified-time filter description contradicts its name.

Native article attachments may advertise separate view and download addresses.
Normalized URL references may retain bounded `sourceUrls` as rewrite aliases,
alongside the primary fetch `url`. Aliases never authorize a request and are
excluded from content receipts and dry-run attachment metadata. Zoho validates
their regional origin and documented locator shape, then constructs downloads
from the native article, locale and resource ID. Legacy `/support/DocsDisplay`
locators are rewritten only; they never receive OAuth credentials. Two native
files claiming the same alias within one article copy stop preparation instead
of choosing one file by array order. Versioned native identities keep separate
working and published file sets independent.

Zoho collection readers accept documented HTTP 204 as an empty `data` list,
validated against the collection response schema. Detail reads and HTTP 200
responses with missing JSON remain errors; authentication or server failures
never become successful empty exports.

Reconcile Zoho's current article-file list with its pinned working detail before
emitting the article. Because the reference advertises pagination but shows a
single-file response, request one file per positive offset, accepting that
documented object or a validated one-item `data` envelope. The latter is an
explicit inferred compatibility case, warned in the import log and dry run.
Checkpoint each native resource ID, refuse repeated/missing/changed files, then
re-read the pinned detail to refuse concurrent source edits. Signed display URL
rotation alone does not change the snapshot. The file list has no documented
version parameter, so it must never replace an older published version's file
set. That set continues to come from the pinned published detail. A discrepancy
stops extraction rather than silently assigning a current file to old content.

### 2026-10-17 — Durable private article asset preparation

Use the existing private S3-compatible store and media worker for imported
article images and downloadable files. Extend help-center media with a file
kind, scan outcome and an audit-only importing-run identifier; normal uploads
retain the image defaults. An audit identifier is not run ownership: prepared
content must survive deletion of transient import runs. Record source-account,
article-root/locale and native asset identity in a new brand-scoped
`hc_import_assets` table, with composite brand/parent and brand/media foreign
keys and FORCE RLS. Asset identity includes validated metadata and actual content
hashes; unchanged content can reuse an immutable prepared asset across runs.

A rejected processing attempt that has never been bound to an article may be
replaced by a fresh media candidate in a later run. Keep the asset's source,
metadata and content identity unchanged, guard the old media pointer and null
article binding under the import claim, and publish the replacement pointer,
media job and checkpoint together. A bound asset cannot be replaced this way.
This permits a fresh import after exhausted infrastructure retries or changed
file policy without rewriting an already-published resource.

Keep run-specific preparation progress on the staged article record, fenced by
its payload hash and the active import claim. Process a bounded amount of media
per continuation, with network/storage I/O outside transactions. Journal candidate
objects as importing media rows before upload, publish processing and its outbox
event together, and retain enough state to recover after worker death. Garbage
collection must preserve active/paused runs and every referenced asset, and may
remove abandoned importing candidates only after the documented grace period.

Images still pass magic-byte checks and WebP re-encoding. Other files remain
download-only, pass MIME/size policy and configured malware scanning, and never
render inline. Download routes check the current parent article and locale,
including current readership and publication/preview authorization, before
issuing a short-lived presigned URL. An opaque asset UUID alone is insufficient
authorization. Existing image-route behavior is unchanged. No source credentials
or bucket keys become article links or API response fields.

The fallback help center keeps its existing staff-cookie scope at `/hc/<brand>`.
Rendered article file links on that fallback use
`/hc/<brand>/_hd/assets/<asset>` so browsers send that cookie; stored article
links and the ordinary API download route keep the canonical brand/asset path.
Both routes share the same parent/locale authorization service. Custom-domain
help centers keep the canonical path because their staff cookie is scoped to
the root. Do not widen fallback cookies to the install root to make file links
work.

Imported image originals and refused file objects are deleted through the
transactional outbox after their media state commits. A conversion may write
its WebP before commit, but retains the source until that commit, so rollback
or worker death can retry against the same verified bytes. Native image upload
behavior is unchanged. Cleanup events name only the media row's canonical
brand/UUID key, and repeated processing of a completed media row adds no work.

Loading must verify the complete prepared manifest, attach assets to the same
source-owned article in its content transaction and reconcile current links.
Declared files cannot disappear merely because body HTML was prepared. Source
asset refusal/policy outcomes must remain visible in the import log and the
resulting article's file availability state; storage/worker failures must retry
without being misreported as unavailable source files. Final integration and
browser evidence must prove this whole path before the milestone is complete.

### 2026-10-17 — Explicit article attachment references

Normalized articles may carry optional attachment references using the same
validated native identity, filename, size and exactly-one URL/bundle-path shape
as message files. Keep this field optional so existing bundles and source
receipts retain their previous shape. Duplicate native asset identities within
one article are refused. Bundle validation must check article file members as
well as message/ticket attachment members. These references describe files to
prepare privately; parsing a vendor URL grants no network or publication rights.
The article preparation/load path must preserve their files and authorized
links before an article with these references can be considered loaded.

### 2026-10-17 — Zoho knowledge taxonomy and inherited readership

Keep knowledge pagination independent from ticket pagination. Root/section
lists document positive, one-based offsets; enumerate activation and trash
states explicitly, and hydrate translated details before normalization. Preserve
native root and nested section references. Do not overwrite differing regional
translations that collapse into one Helpdock locale or invent an English/Arabic
translation when the source supplies neither.

Article readership must include every source ancestor, not only the article's
permission field. Walk section parents to the declared root with one durable
checkpoint per hop. Group/agent/private-IP restrictions become internal
readership; hidden, disabled or trashed ancestors also force draft. Unsupported
visibility, cross-root parents and cycles fail closed. Source groups remain
history and cannot create local memberships. This is deliberately stricter than
publicizing an article whose original restriction Helpdock cannot express.

### 2026-10-17 — Durable constant-space continuation cycle detection

The worker's per-entity continuation guard must use constant checkpoint space,
not an in-memory set proportional to all extracted history pages. Persist the
existing token cycle detector's hashed anchor and counters alongside the entity
cursor, in the same transaction as staged rows. This also prevents repeated
worker deferrals from forgetting a nontrivial continuation loop. Seed legacy
checkpoints from their saved cursor, retain immediate-repeat rejection and clear
detector metadata when the entity completes. Detector state belongs to the
worker, not the connector's page payload. No new table or tenant context is
introduced; existing run RLS and claim serialization still govern the update.

### 2026-10-17 — Zoho ticket-level attachment history

Scan the documented ticket attachment collection separately from thread and
comment files. The API does not promise that those collections are disjoint.
Retain each documented parent relationship with a parent-scoped import identity;
do not discard a ticket-level file merely because its ID appeared on a thread.
Represent a ticket-level file as an attachment-only historical message, with its
source creation time and public/private flag. An untyped source creator remains
a source-only name and native reference, never an inferred local staff identity.
Keep the visible message body empty rather than inventing historical prose.
These messages are inert and do not count as staff replies.

Ticket-level download refresh must re-read the validated collection page that
supplied the file; there is no documented single-file metadata endpoint to
invent. A moved/missing entry on that page stops refresh as a stale snapshot
instead of declaring the file expired. Verify the parent, native ID, name and
size before retrying a credential-bearing download. Thread/comment downloads
retain their exact-parent binding. Page hints are transport metadata and do not
change attachment content identity or receipt hashes.

### 2026-10-17 — Zoho historical satisfaction timestamps and content

Read complete feedback by its documented thread-ID content resource, while
retaining the feedback's own native ID for import receipts. Rescan ratings for
deltas because rating-time filters cannot find edits to older responses. Bound
the scan's end time before network work and checkpoint each answer, with a page
fingerprint to reject shifted results after restart. Keep all original time
fields and timezone text. Prefer `customerRatedTime` when supplied, otherwise
`ratedTime`, and require timestamp review: the reference shows differing
Z-labelled instants without a complete conversion contract. Never subtract an
offset from an already offset-bearing source value. Preserve original sentiment
while proposing acknowledged 5/3/1 normalization for known values; unknown
sentiments remain unscored. Missing complete content fails instead of silently
accepting a potentially shortened list preview. The documented 50-credit list
cost must inform the eventual runtime budget, independently of HTTP request rate.

### 2026-10-17 — Zoho custom field value fidelity

Use the documented module field catalog for both mapper definitions and hydrated
custom values. Read the complete vendor envelope, then checkpoint bounded local
batches with a catalog fingerprint. Refuse a changed catalog after restart.
Normalize only exact supported shapes; do not guess multiselect delimiters or
coerce unsafe numeric IDs/counts. Preserve currency, decimal and percent source
text instead of rounding it through JavaScript numbers, and preserve DateTime
text instead of dropping timezone/time in a date-only destination. Unsupported
lookup/formula semantics and oversized or empty selections become inert text
with a dry-run review warning. These are explicit mapper choices, not recreated
source automation. Missing custom definitions stop extraction instead of leaving
an apparently complete import with unmappable values. Encrypted/computed fields
require review and cannot imply that masked source data has been recovered.

### 2026-10-17 — Zoho profile rescans and native metadata

The ordinary contact and account APIs expose created-time ordering but no
documented modified-time delta contract. Rescan them for deltas and rely on
source-account receipts for unchanged destination writes. Page a bounded set of
native IDs and hydrate each detail separately so multiline descriptions and
custom fields are not lost to thin list responses. Enumerate all documented
agent statuses and both department enablement states explicitly.

Keep source-only address, social/CRM, revenue, lifecycle and SLA-reference facts
as namespaced mapper fields. They do not grant roles, enable policies or delete
local records. Accessible deleted/trashed/spam profiles require a review warning.
A website alone is not proof of company email-domain ownership, so it must not
drive an automatic domain merge. Canonical JSON text for compound native values
sorts object keys and retains array order; harmless response-key reordering must
not create a changed import. This serialization is shared with Freshdesk's
native compound projections.

### 2026-10-17 — Zoho history checkpoints and unattributed descriptions

Zoho history uses the same account-bound ID scan as ticket extraction. Persist a
source page offset, item offset and page fingerprint, and commit each thread or
comment separately. Cache only the current validated source page inside the
iterator; after restart, re-read and compare it before applying the saved item
offset. Ignore volatile attachment URLs in page fingerprints. Reject a changed
page or mismatched detail identity instead of risking missing or duplicated
history. This bounds memory without repeating one list request per source item.

The ticket description is not a second message when an `isDescriptionThread`
already exists. If no such thread exists, retain the description as a private,
system-attributed history note, with original ticket creation time and a review
warning. The description field alone proves neither author identity nor original
visibility, so it cannot create a public customer reply implicitly. No lifecycle
hook, delivery request or permission is derived from this fallback.

### 2026-10-17 — inert message provenance and unsent source threads

Imported messages can retain bounded, allowlisted source status, channel,
direction, author kind/type and `via` values in nullable
`ticket_messages.import_details`. These are historical metadata and never drive
delivery, permissions, automations or SLA clocks. The API validates the output;
the admin thread shows it in an existing native disclosure pattern. Unknown
source author identities preserve their display name without acquiring a local
user identity or being mislabeled as a former agent when the source says customer.

Zoho draft, failed and pending threads are retained as private history, with an
explicit review warning and their original status. Their original body remains
unchanged apart from the common sanitizer. A delivered/public message requires
the documented SUCCESS state and public visibility. Metadata participates in
the source fingerprint, so source corrections update the original historical
message and exact repeats remain unchanged. Existing receipts and manually
edited content are not invalidated globally just to populate optional metadata.

### 2026-10-17 — source-only historical author displays

Normalized messages may carry an optional `authorName`, bounded to the existing
200-character `ticket_messages.author_display` column. When the connector cannot
establish a stable author identity, it may preserve that name with system
attribution and a source warning. This grants no local staff/contact attribution
and bypasses no mapping requirement: non-system authors still require their
normal source identity mapping. System attribution never resolves an incidental
source ID to a local staff identity. Dry-run thread previews retain the source
display, and message hashes include it so an explicit source correction updates
the same historical message. No new database column or outbound event is needed.

### 2026-10-17 — Zoho regional token-domain validation

Desk's API reference says `api_domain` is the regional Desk origin. The generic
OAuth refresh example instead returns `api.zoho.com`, without a Desk mapping
contract. The client therefore requires the selected region's documented Desk
origin and refuses generic or cross-region domains. It does not fetch an
unverified domain or infer a replacement. This can refuse an unexpected but
legitimate token response; confirm the Desk-specific response with a real account
before claiming vendor acceptance. Accounts and Desk origins use explicit
regional tables, including Canada's `zohocloud.ca` hosts.

Token refresh posts form fields, refuses all redirects, and translates OAuth
error bodies into safe keys. A session coalesces refreshes and holds an access
token only in memory until its expiry margin. Authenticated Desk JSON reads also
refuse redirects, preserving source-origin binding even when approved asset hosts
exist in the transport's allowlist. Desk calls send the selected
`orgId`; an authenticated organization probe must find it before binding the
`region:orgId` account namespace. A 401 permits one token refresh and retry;
403 remains a scope/access refusal. Neither error silently selects another
region, organization or API.

### 2026-10-17 — inventory approval and bounded file polling

Vendor ticket inventories use the existing private source-file upload and outbox
preparation path, with a separate native-ID mapping and whole-file validation
snapshot. Scope confirmation records a server-generated fingerprint over sealed
file revisions, hashes, locations, coverage mode and verified account. Extraction
requires the current fingerprint; remapping or replacing a file requires renewed
approval. Duplicate IDs within a location are read once. Conflicting locations
across files are refused before extraction rather than chosen implicitly.

File polling returns at most 100 lightweight summaries. SQL excludes headers,
sample rows, mapping rules and validation previews; readiness and pending states
are projected as booleans. A separate brand/run-scoped file-detail route serves
the selected mapper, and its browser cache is discarded when inactive. Otherwise
100 valid CSV previews could be repeatedly materialized even when only one file
is visible. The public schemas distinguish summaries from complete file views.

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

Dependency versions were checked against npm on 2026-10-13 and rechecked on
2026-10-18: `csv-parse` 7.0.3,
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


### 2026-10-15 — resumable dry-run work and explicit review boundary

Add `import.dry_run` to the existing import queue/outbox protocol rather than
running whole-source validation inside an HTTP request. Each delivery checkpoints
one bounded step using the same fenced claims and retry/recovery controls as
loading. The request body and queue payload contain no credentials. Validation
completion retains a bounded public report, releases the claim and returns to
`awaiting_mapping` for review, regardless of whether errors were found. It does
not set `ready` or authorize loading. Approval requires the remaining freshness
and completeness checks; a report's `complete` flag must never serve as approval.


### 2026-10-15 — destination freshness and report-bound load approval

Bind approval to a SHA-256 review token over the full persisted validation
checkpoint, including its source and destination fingerprints and warning totals.
`complete` remains a validation state, not authorization. `/start` requires the
exact token, no blocking errors and explicit acknowledgement of warnings, checks
both snapshots again, and atomically records approval and publishes load work.
Invitations recheck `staff:manage` at start.

The destination fingerprint hashes 500-row metadata pages of local contacts,
identities, companies, routing/field definitions, memberships and knowledge
hierarchy, plus the same-account import ledger. Pagination uses indexed UUID/native keys. The brand revision covers policy,
locale, timezone, prefix and availability. Staff revisions are install-wide because
invitation uniqueness is global. Only record keys and PostgreSQL row revisions
leave SQL; no profile payloads, staff addresses or password/session values enter
the checkpoint. Any staff-row update can require revalidation; session-table
changes do not. Revisions detect committed changes even when values are reverted
during the scan, which a final-value digest alone would miss. A failing real-DB
regression reproduced that reverted staff-state case before correction.
This conservative snapshot may invalidate on unrelated destination edits. Prefer
that refusal over silently approving a different matching/provisioning plan;
operators can validate during a quiet cutover window.

The first load transaction rechecks the receipt and snapshots before a domain
write. Stale queued approvals return to review with credentials retained. A
`loadApprovalChecked` receipt in internal counters prevents subsequent own writes
from invalidating the original snapshot; the ordinary loader still validates live
targets. Existing internal/system load drivers without a public approval receipt
retain their direct-driver behavior. Public starts always require and persist a
receipt. The reviewed calling code reaches the loader unchanged, fixing a path
where national phone numbers passed validation but were omitted during loading.


### 2026-10-15 — effective knowledge ancestry and locale ownership checks

Validate the graph that loading will apply: staged parent changes override live
metadata, and unstaged ancestors resolve only through receipts in the same
brand/vendor/account. Category and section nodes use physical target IDs for cycle
detection when known; source aliases cannot become self-parents. Direct writers
must enforce that same rule. Category aliases resolving to one destination are
compatible when checking section membership.

Article translations are locale versions of one local article, so their physical
aliases are legitimate. Traverse their staged native translation graph and check
container/identity compatibility at live leaves. Refuse duplicate staged locales
and an unowned translation that would collide with an existing locale, matching
the loader's refusal to overwrite a version without a receipt. Include article
version row revisions in destination freshness. Use metadata projections for live
ancestry, bounded paths and existing help-center limits; do not load complete
knowledge bodies into a graph or synthesize fake normalized source records from
local rows. No schema change is needed.

### 2026-10-15 — unchanged report rows and independently rescanned satisfaction

A run records whether its ticket/history writes changed data in the same
transaction as their load checkpoints. An unchanged repeat must preserve report
rows too; checkpoints from older drivers without that marker retain conservative
backfilling.

Satisfaction APIs can require a full rescan while the ticket export is incremental.
An unbundled satisfaction record may therefore update an existing imported parent
through its brand/vendor/account receipt, under the loading claim and the same
parent lock as ticket loading. Reject missing, deleted, foreign or mismatched
parents; never fabricate a normalized ticket from local columns. Upsert the answer
with its original date and expired token, checkpoint it atomically and rebuild
reports from the existing parent's original day when changed. Invalidate the
parent's aggregate receipt after an independent change so later source reversions
cannot be hidden by an old whole-thread hash. Other unbundled child types remain
refused until their own reconciliation contract is implemented.

Satisfaction row uniqueness must include the verified source-account key, just
like its native-ID ledger. The previous brand/vendor/native-ID index rejects
valid answers from a second account. Add `csat_responses.import_source_account_key`
with the legacy zero-key default and include it in that index. Backfill from the
same-brand/vendor CSAT receipts, refusing ambiguous account ownership. Live
surveys retain the zero sentinel and their existing ticket/close uniqueness.

### 2026-10-15 — streamed file uploads and immutable preparation

Manual source files use the existing private object store's size-bound presigned
PUT flow, rather than buffering multipart bodies in the API. An `import_files`
tenant table binds each upload to its brand and run. Confirmation queues
preparation through the outbox. The worker downloads with a byte cap and seals
the source under a fresh private key before exposing headers or validating a
mapping. The signed upload key is never the extraction source: it can still be
overwritten until its signature expires. Preparation records the sealed hash,
and stale revisions cannot approve a newly edited mapping. Each worker attempt
uses a different sealed key; a losing attempt schedules its own object cleanup.
File preparation does not stage domain records. A complete file validation must
succeed before extraction, separately from the twenty-row preview.

Discarding a source file before extraction revokes its mapping revision and
removes it from active listings and input fingerprints. Its private object keys
remain in the tenant row until cleanup, including any upload attempt still in
flight. The fixed 30-day staging window also covers discarded files, measured
from discard time. Completed, failed and cancelled runs lose source-file rows,
staged records, mappings and logs 30 days after finish. The nightly tenant-scoped
retention job deletes bounded batches and atomically publishes object-purge
events. Run summaries, reusable presets and native-ID receipts stay. Retention
counts include removed staging rows, while object deletion follows through the
outbox. An index on brand/finish time supports the terminal-run cutoff.

### 2026-10-15 — explicit CSV omissions and structured values

CSV transforms include explicit number parsing and JSON decoding for normalized
arrays/objects such as field options and source history details. Numbers use
finite JSON-number syntax; JSON is bounded to twenty nesting levels and ten
thousand values before the normalized record schema validates its shape. No
structured value is inferred merely because a cell resembles JSON.

The file-mapper artboard permits skipping rows with errors. Keep that choice in
the saved mapping as optional `skipInvalidRows`, false when absent. Whole-file
validation always records its invalid-row count and bounded issue sample. With
the option off, any invalid mapped row blocks extraction. With it on, extraction
omits only rows failing mapping/normalized validation, retaining physical row
offset checkpoints even for pages containing only omitted rows. CSV structural,
encoding/size and bundle safety errors remain fatal. Each validation revision
records the omission count in the import log once. A fresh dry-run receipt counts
the omitted rows as warnings and requires acknowledgment, so skipping cannot
silently authorize an incomplete migration.

The API exposes an ordered-header fingerprint alongside source headers for exact
preset selection. The UI automatically proposes a sole matching entity/header
preset; multiple matches require explicit selection. Neither proposal saves a
mapping or skips complete-file validation.

### 2026-10-15 — SLA activation is explicit after migration

Avoiding lifecycle hooks during loading is insufficient: a later staff edit,
reopen or policy/calendar change could otherwise start clocks on historical
tickets. Persist `tickets.import_sla_started_at`, null until an administrator
explicitly activates imported work. Normal SLA synchronization and reopening
must leave imported tickets without this marker inert. Activation locks and
re-reads the ticket, refuses closed/deleted/merged targets and absent policies,
then marks and synchronizes it atomically. Clocks start from activation time;
the ticket's original creation date remains unchanged. A repeat activation
does not reset clocks. The import writer never calls this operation, and a
delta must preserve the marker rather than opting the ticket in or out.

Bulk activation uses durable ticket/native-ID receipts for the completed run's
verified source account, rather than temporary staging rows. Otherwise the
30-day staging purge would silently remove an administrator's ability to start
clocks later. The confirmation explicitly covers all currently open imported
tickets from that account in this brand. Freeze `requestedAt`; tickets imported
after that instant are outside the request and keep the opt-in default. Persist
a revision, UUID cursor and counters in run options, and publish every bounded
continuation through the outbox. Committed ticket markers, progress and the next
continuation share one transaction. Recovery republishes only the current
cursor; explicit retry resumes a failed cursor. Source credentials and temporary
files are neither retained nor required by this action.

### 2026-10-16 — workspace provenance and install visibility

Ticket source metadata is resolved through authorized parent tickets, in a
single receipt lookup for a list page. If more than one receipt claims a parent,
publish no guessed number/link. Read-only provenance links omit query strings
and fragments so signed/authentication addresses are not published as source
navigation. Reject non-HTTP(S) and embedded credentials. Apply the same policy to
the imported activity payload and at the header boundary. Store raw provenance
internally for lineage; this does not authorize fetching its URL.

Original source numbers/native IDs participate in ticket search through indexed
receipt lookups, with the final ticket query retaining its ordinary department
RLS. Source filters use that same predicate and view schema. Preserve historical
name-only staff via `authorDisplay`, with no synthetic user or role assignment.

Install visibility follows existing worker-reported status patterns. Sample
import counts/latest retained error codes per active brand in short audited
system transactions; publish a bounded Redis reading with a 180-second TTL.
The install-admin status route reads only that cache. Unknown/expired readings
are not zero counts. Totals cover all sampled active brands; the current card
lists at most fifty prioritized brand summaries. Full summary pagination remains
implementation work, not an accepted permanent omission.

### 2026-10-16 — historical activity pagination

The newest hundred activity rows cannot represent a long imported audit trail.
Expose older pages using a UUID anchor scoped to the already authorized parent
ticket. Compare `(created_at, id)` against that row inside PostgreSQL, retaining
native timestamp precision instead of reconstructing a cursor from a JavaScript
Date. Reject missing/foreign anchors and bound pages to one hundred rows. Keep
one older page at a time in the workspace and carry the newest cursor through
realtime refresh. Imported provenance/audit actions must be admitted by the
thread's event allowlist, independently of their formatting functions.

### 2026-10-16 — paged install import snapshots

Keep a versioned Redis hash and ordered index for every sampled brand, with the
same short TTL as the summary. Publish the snapshot pointer only after its
record count is complete. The install-admin endpoint pages that immutable
version, so worker refreshes cannot shift a page midway through inspection.
Retain only one page in the UI. A missing/expired/incomplete cache answers
unknown and offers a new reading; it never silently omits brands or falls back
to a cross-tenant SQL query. Redis writes happen after each brand transaction
has committed, and abandoned snapshot versions expire automatically.

### 2026-10-17 — Freshdesk bounded lists and archive discovery

Current official API research confirms a 300-page ticket list ceiling and
separate archived-ticket detail/conversation endpoints. The connector must not
interpret the list ceiling as end of history. Continue ordered extraction with
a one-second overlap at the last timestamp; receipts make overlap idempotent.
If the overlap cannot advance (too many tickets share its timestamp), stop with
a completeness error and require an export inventory rather than skip records.
The source remains unavailable until the inventory path is implemented.

There is no documented generic archive-list endpoint. Use archive IDs supplied
from the vendor's documented export mechanism and hydrate each with the archive
detail/conversation APIs. Do not invent numeric-ID brute force or an undocumented
endpoint. An unverified/incomplete archive inventory cannot be represented as
full migration completion. New satisfaction surveys also need their documented
version/question structure; never guess a score from an arbitrary numeric answer.

### 2026-10-17 — bounded attachment metadata refresh

Amendment, 2026-10-18: message and attachment exports can read the same native
file at different times and receive different signed download URLs. Match their
thread membership using the existing attachment identity (source ID, name, size
and declared MIME), together with the exact bundle member when applicable.
Transport URLs and `sourcePage` hints do not establish file identity. The staged
attachment remains the canonical download input; its complete payload and policy
are still bound by dry-run approval, the parent references must match, and every
fetch retains the exact-host and `safeFetch` checks. Do not accept a changed file
name, declared size/MIME, native identity or bundle member as an equivalent file.

Normalized attachment references may carry an optional positive `sourcePage`
(up to one million) as a transport hint. It is not a source identity, content
change or permission grant. Freshdesk stores the conversation-list page on which
the native message/attachment was observed. An expired download refreshes that
page through the authenticated account API, validates the native parent/message/
attachment IDs, then downloads without account authorization. This avoids
restarting an unbounded scan after each rate-limit retry. If the source page
changed and the expected record is absent, report unavailable and require fresh
extraction; do not substitute another attachment or silently search forever.

The hint is retained only with source staging/references, not in public ticket
responses. Attachment/message business hashes ignore it along with expiring
download paths, so a changed page hint cannot duplicate files or rewrite history.

### 2026-10-17 — Freshdesk field and Solutions projections

Freshdesk nested ticket fields become separate text fields using each native
field name and label. Their stored scalar values survive unchanged; their
conditional dropdown/form rules do not become Helpdock automation. Record the
semantic difference as a source warning requiring dry-run acknowledgement.
Dropdown definitions beyond Helpdock's destination option limit (currently 50) also become text
fields with the same warning, preserving values without truncating choices.
Unknown field types stop extraction instead of silently skipping data.

Solutions traversal uses bounded category/folder/article pages and a persisted
DFS stack. Category listings can include nested folders, so native-ID staging
receipts deduplicate repeated discoveries. Folder parent chains are resolved
independently of discovery order before deciding article readership. Only
visibility 1 through the complete ancestor chain permits public content; any
restricted ancestor keeps the article internal and produces a warning. Cycles,
contradictory parent/category IDs and non-progressing pages stop extraction.

Read configured primary/supported languages from Helpdesk Settings. Preserve
English and Arabic translations under stable native IDs; missing optional
translations produce explicit warnings, and unsupported or colliding locale
variants stop extraction rather than being discarded or arbitrarily chosen.
Do not infer the primary language from article text or assume it is English.

Ancestor privacy traversal checkpoints one parent per hop, with a cycle/depth
guard of 128, before fetching article bodies. A rate-limit retry resumes the
remaining parent chain rather than repeating an unbounded pre-yield scan.
The traversal caches one category, folder and article-index page at a time.

### 2026-10-17 — preserve satisfaction answers without guessing historical scales

Freshdesk's new survey responses name a `survey_version_id`, but the documented
survey listing does not expose that version's question schema or a historical
version retrieval endpoint (checked https://developers.freshdesk.com/api/ on
2026-10-17). A current numeric answer cannot safely establish a historical CSAT
scale, theme or direction. Preserve every original answer, question text, version,
response status and source timestamp. Store a null comparable rating with the
explicit `ratingUnmapped: true` provenance marker. Never substitute zero or count
such responses in rating averages. Native surveys retain their existing 1–5
contract. Imported unscored responses have no usable rating link and show their
original answers to authorized staff in the existing Satisfaction card.

Extraction emits a dry-run warning requiring acknowledgement. Both full and
delta runs rescan response pages, because a creation-time filter misses edits.
Pagination follows only validated same-origin, same-resource continuation tokens.

Changed imported satisfaction answers also write an inert `ticket.imported.event`
row with the same stable ID as the answer, at its original response date. Store
source details and a bounded display projection, without executable lifecycle
actions. Replays leave both rows untouched. Keep native survey selection
separate from historical display fallback so channel delivery cannot select an
imported response. Source status IDs may carry an optional `statusLabel` for
mapper display/name matching; mapping identities continue to use the native ID.

### 2026-10-17 — explicit mapping for Freshdesk native profile attributes

Contact address, job title, contact type, Twitter/social handles, tags, additional
companies, device metadata and company-ticket visibility have no equivalent
native Helpdock profile columns. Company health score, account tier, renewal
date and industry have the same gap. Expose them as namespaced source field
definitions (`contact:native:<name>` / `organization:native:<name>`) and values
under `freshdesk_<name>`. Preserve compound values as JSON text. Their labels
are the original attribute names, editable when creating the destination field.
Every value follows the existing explicit field mapper, validation and skip
acknowledgement; no hidden raw-profile blob bypasses privacy choices. Preserve
company visibility as historical field data only, never as a Helpdock permission.
A native/custom key collision stops extraction rather than overwriting either.

Opaque survey pagination retains a constant-size cycle detector in the durable
checkpoint. Repeated token cycles fail instead of looping until the export cap;
raw tokens are not accumulated in memory or logs.

### 2026-10-17 — Zoho Desk contract corrections before implementation

The current official Desk API reference contradicts the original milestone's
ordinary-ticket `sortBy=modifiedTime` assumption. Use ordinary creation-ordered
full listing plus hydrated details; bounded modified-time search is a distinct
contract with a 5,000-result depth ceiling and must not silently truncate deltas.
The separate archived-ticket list also has that depth ceiling per department.
An unsplittable result requires complete source inventory rather than a falsely
successful migration. Record window bounds durably before fetching pages.

Validate regional endpoints against the documented Desk host set, including
`desk.zohocloud.ca` and CN/SG/UAE. Generic Accounts API-domain examples are not
permission to send Desk credentials to arbitrary returned hosts. Bind the
verified region and organization ID as the source account. Send its matching
`orgId` despite conflicting optional/mandatory language in the reference.

Single-thread detail can itself be truncated; full-content retrieval is required
when flagged. Comments are public or private, not private-only. Preserve both
under their source visibility. Keep native IDs as strings and never infer local
deletes from source absence. Credit-remaining headers do not reveal total daily
entitlement; percentage-based pacing requires an authoritative denominator.
These decisions update the plan before Zoho implementation; stand-ins and
production verification remain pending.

Migration 0074 backfills inert timeline rows for existing imported answers before
normal repeat processing. It preserves answer rows/tokens, never publishes an
outbox event, refuses activity-ID ownership collisions and leaves existing
matching history untouched. Original answer details remain available through a
validated staff display projection. Upgrade/replay/collision cases are authored
but unrun.

### 2026-10-17 — sealed source ticket inventories for vendor completeness limits

Vendor APIs with capped search/listing or no archive enumeration need an explicit
source export inventory. An inventory contains native ticket IDs and a location
hint (`active`, `archived`, `auto`), never a URL or credentials. `archives` mode
appends those IDs to the ordinary live export; `complete` mode hydrates the full
inventory instead of relying on a capped list. The same reader feeds ticket,
tag, description, conversation and attachment extraction so children cannot lose
archived parents. A complete-mode delta rescans its newly supplied inventory;
it must not silently reuse an old snapshot to claim coverage of new tickets.

The inventory is a private sealed CSV bound to its source account, run and
mapping revision. Persist validated IDs in a brand-admin staging table for
bounded keyset reads, with FORCE RLS and composite brand/run/file ownership.
Fingerprint the sealed file set, mappings and mode. Every continuation carries
that fingerprint and the last committed native ID; changed inventory, duplicate
ordering or a missing/inaccessible native record stops extraction. One hydrated
ticket per checkpoint prevents request-budget retries from starving progress.
An archive-only inventory cannot solve an unsplittable live-list timestamp cap;
that needs a complete inventory. A source freeze/cutover reconciliation remains
required because vendor APIs do not promise a transactionally frozen snapshot.

### 2026-10-18 — automatically enumerate Zoho archives before requiring an inventory

Zoho's documented `GET /api/v1/tickets/archivedTickets` supports per-department
archive enumeration (`from` 0–4999, `limit` 1–100, `Desk.search.READ` and
`Desk.tickets.READ`). Its compact example omits `modifiedTime`; discovery reads
only the native ID, department and archived flag, then hydrates the ordinary
ticket detail resource. Enumerate enabled and disabled departments, retain a
bounded page per continuation and include archives in full and delta scans.
Archives have no documented modified-time partition, so deltas rescan them.
Overlap the previous page's last ID to detect shifted offset pages. Repeated
pages, cross-department rows and inaccessible records stop extraction.

Zoho's default path does not require a CSV export. A reviewed ticket inventory
is an explicit optional fallback, with the existing sealed fingerprint and
confirmation rules. Freshdesk still requires its archive inventory because its
official API lacks a general archive list. Reaching Zoho's unprovable archive
depth or an indivisible search window refuses completion with an actionable
complete-inventory diagnostic; never report truncated history as successful.
No new table, permission or credential path is introduced.

### 2026-10-18 — retain original Zoho mail identity separately from its rendered body

For successful email threads, read the documented parent-bound `originalContent`
resource (`Desk.tickets.READ`, 1 credit). Its JSON metadata supplies Message-ID,
mail date, sender, recipients, subject and return path. This is not the
`fullContent` resource used to recover truncated rendered history. Keep the
thread's original creation time for the timeline and a separate optional nullable
`email.sentAt` for the parsed mail date; preserve unparseable source date text in
inert message provenance and warn rather than inventing a date. Retain subject
and return path there too. These JSONB projections need no new tenant table.

Do not persist the duplicate MIME string or extract attachments from it; complete
rendered bodies and native attachment resources retain their existing independent
validation. Existing bounded safe HTTP limits still apply. Original-mail reads
never follow a vendor URL or redirect. Refuse mismatched sender/recipient
snapshots when both endpoints supply them. A documented resource that is no
longer available (404/410) yields an explicit warning and retains the thread's
available metadata; 403, malformed responses, 429 and server errors do not become
successful fallback. Never invent a Message-ID, request original mail for an
unsent draft, or use imported metadata to send anything.
An unavailable OAuth token endpoint is a protocol failure, never an original-mail
404 fallback; the OAuth boundary reclassifies that error before it reaches any
record reader.

### 2026-10-18 — resolve relative article images with an explicit per-copy origin

Add optional `assetOrigin` to normalized working and published article copies.
It accepts only an HTTP(S) origin, without credentials, path, query or fragment.
The Zoho adapter supplies its selected regional Desk origin for each copy; file
sources may declare one explicitly for relative remote images. An origin grants
no network access: existing approved-host, DNS/IP, redirect and content policies
still apply. Relative bundle members retain their existing archive semantics.

Use the shared HTML parser's decoded image attributes, resolve relative locators
before matching declared native-file aliases, and preserve original locators for
rewriting. Equivalent absolute/relative references share one image request.
Working and published copies keep their own origin and attachment authority;
one copy must not inherit the other's private resource set. The origin is part
of the reviewed source payload and cannot change under an existing approval.

Synthetic remote images receive no vendor credentials, including regional
`/DocsDisplay` or `/support/ImageDisplay` locators. Those documented URL examples
do not establish an OAuth-capable download contract. A 401/403 on this explicitly
unauthenticated path means the image is unavailable, with a reviewed warning and
placeholder; it must not masquerade as invalid connector credentials or trigger
credential replay. Native authenticated attachment refusals remain errors, and
429/server failures remain retryable rather than becoming missing files.

Inventory staging rows additionally bind the exact source SHA-256, not only the
mapping revision. A browser may overwrite its temporary upload between failed
preparation attempts; rows derived from different bytes cannot mix into the
published sealed inventory. A ready manifest joins both hash and revision,
checks recorded unique-row totals, and fingerprints the verified source account.
Once any source file exists, account rebinding requires a new run. Retention
removes inventory rows in bounded batches before deleting their source file,
so the foreign-key cascade cannot turn one file deletion into an unbounded job.
Migration 0075 creates the parent composite unique key before its child foreign
key; this ordering was corrected in generated SQL before applying it anywhere.

### Owner review: resumable live extraction and upgrade boundary (2026-10-18)

The unshipped import schema is one migration, `0054_imports`, generated from the
already merged `0053_sso` snapshot. It creates the final schema directly, with no
backfills for intermediate states that existed only on PR #215. Constraints
compare the newly added satisfaction channel through `rated_via::text`, because
Drizzle applies pending migrations in one transaction. Upgrade coverage starts
from the actual migration prefix, with existing native tickets and answers.

A page hash detects mutation but cannot make an offset within a live page
resumable. Extraction therefore stores successful GET responses in a run-scoped
`import_pages` tenant table before exposing them to the connector. The key is a
hash of the request URL; request authorization headers are never persisted.
Only pagination and content-type response headers are retained. Responses retain
the existing 50 MiB limit, FORCE RLS and composite brand/run ownership. Claim
renewal fences every read and write. A database trigger deletes snapshots when
extraction ends or is cancelled/failed; pausing extraction preserves them. OAuth
POSTs and attachment downloading outside extraction do not use this cache.
This replaces earlier amendments that fail a run when a partially consumed live
page changes. A resumed worker reuses its immutable response instead.

Freshdesk ticket enumeration uses ascending `created_at` with `updated_since`
instead of sorting by the mutable `updated_at`. A scanned ticket being updated
therefore cannot shift an unchanged unread ticket behind the next offset. A
nonempty page at the 300-page ceiling is refused; operators use the existing
complete native-ID inventory mode rather than rely on timestamp windows to prove
completeness. Zoho delta enumeration similarly scans the creation-ordered ticket
list and filters its returned modified timestamps locally, avoiding mutable
search-result membership. Snapshot consistency across different resource pages
is not a vendor guarantee; subsequent deltas still reconcile newer source state.

Dry-run warnings identify each closed ticket outside the mapped brand's current
closed-ticket retention window. The existing warning acknowledgment is required
before starting. Retention policy values participate in the destination review
fingerprint; nightly job bookkeeping does not. This does not extend retention or
change historical close timestamps.

### Owner review: existing SLA clocks and bounded bundle reads (2026-10-18)

An import still creates no SLA clocks until explicit admin activation. A later
delta must reconcile clocks that activation already created: imported public
agent replies satisfy response clocks; mapped paused, closed, excluded or moved
statuses reconcile resolution clocks and their ticket summaries. The writer
reuses the pure clock/calendar/policy functions and the database repository. It
never calls `SlaService`, live lifecycle hooks or event producers. Historical
replies cannot satisfy a clock before its activation instant. This changes the
previous assumption that an inert writer could simply ignore existing clocks.

Bundle attachment processing keeps at most one verified compressed source file
(up to the existing 2 GiB cap), one validated ZIP directory index and one leased
reader per worker process. Identity includes the storage instance, sealed object
key, size and digest. Reads serialize while holding the lease. A source change
closes/removes the old cache before another is prepared; idle expiry is one
minute. Private temporary directories and read-only verified files contain the
cache; normal exit removes it and a new preparation removes abandoned caches
from dead worker processes. A crash requires one new download/hash/index, rather
than doing that work again for every attachment. The final managed attachments
still use the configured S3-compatible storage and existing authorization.

Zendesk tickets unavailable during extraction are logged and their staged
thread graph is discarded. Subsequent child pages for those same ticket IDs are
ignored within the run. This never deletes existing Helpdock tickets or
unrelated entities sharing the native ID. A deleted Freshdesk author is retained
as a name-only system author using its native ID, with a review warning; no
staff or contact identity is invented for an unavailable person.

The static guard now checks direct outbox references, explicit allowed producer
events, payload overrides and raw SQL inserts, as well as live lifecycle names.
It scans dedicated import files outside `imports/` too. Explicit admin SLA
activation scheduling remains allowed outside the strict writer. Runtime
stand-in tripwires and negative domain-row assertions remain necessary alongside
the static guard.


Content-only deltas retain the existing status timestamp when the mapped status
ID is unchanged. They cannot create a new scheduled-rule match key by rewriting
an old source updated timestamp. Actual status transitions keep the existing
database trigger's arrival-time baseline; the source's historical transition
activity remains independently dated.
