# Importing historical support data

M11 is implemented in [PR #215](https://github.com/Docker-Hunterpedia/Helpdock/pull/215),
awaiting review and merge. It includes Zendesk, Freshdesk,
Zoho Desk and manual CSV/bundle sources, the bilingual wizard, mapping presets,
dry-run previews and explicit approval. Track scope, functional acceptance and
current-head CI in
[the milestone plan](../in-development/M11-sso-and-migration.md).

Importing creates history without sending customer messages or starting rules,
notifications, SLA timers or AI work. Published help-center articles remain
searchable through full-text search; their AI embeddings are deferred, including
when an older embedding job runs. Review and publish an article revision to
resume ordinary embedding for that language. A changed source version in a
later import defers the replacement again. Starting imported-ticket SLA clocks
is also a separate, explicit admin action.

Imported open chat conversations do not join the live widget queue. A visitor
waiting after a migration is not counted behind historical chats. If the
customer writes in an imported chat again, it joins the queue from that
message, as a new conversation would.

Imported ticket attachments and article files are copied into Helpdock's
configured private S3-compatible bucket (`S3_ENDPOINT`, `S3_BUCKET`), such as a
self-hosted MinIO store or S3. The worker uses local disk for bounded temporary
inspection and processing, then removes those files. Persistent media uses the
object store; users receive authorized Helpdock downloads rather than a
permanent dependency on an expiring vendor URL.

## Limits to plan for

- **Freshdesk accounts with more than 30,000 tickets need a complete ticket ID
  inventory.** Freshdesk's ticket list stops at 300 pages of 100 tickets for one
  `updated_since` window. When the 300th page is not empty, extraction stops
  instead of skipping tickets. Start a run in **Complete ticket ID inventory**
  mode and upload an export of every ticket ID (see
  [Connect and map](#connect-and-map)). The same limit applies to a delta that
  covers more than 30,000 changed tickets.
- **Each Zoho Desk delta lists every ticket, so it costs about as many API credits
  as a full import's ticket listing.** Zoho's change-time search pages are
  unstable while tickets change, so a delta reads all tickets in creation order,
  100 per request, keeps the changed ones and rescans every department's archive.
  Check the account's daily credit allowance before scheduling deltas. When it
  runs out, the run waits 24 hours, or until the time Zoho sends in `Retry-After`,
  rather than retrying.

## Cutover runbook

1. Record the source account, region, selected entities and expected active/archive
   counts. Arrange a quiet source window: changing pages can stop extraction
   instead of silently skipping records. Take a consistent Helpdock database,
   object-bucket and configuration backup using the
   [operations procedure](operations.md#backups), and verify the
   [restore drill](restore-drill.md).
2. Create the run in the target brand. Use read-only vendor permissions from the
   connector sections below. For manual files, choose a stable dataset label and
   keep it unchanged for later repeats. For Freshdesk ticket history, prepare and
   confirm the archive or complete-ID inventory; above 30,000 tickets only the
   complete inventory works ([limits](#limits-to-plan-for)). Zoho's automatic
   archive reader normally needs no CSV.
3. Map departments, staff, statuses, priorities, channels, tags and custom fields.
   Choose existing staff, an invited person without sending an email, or a name
   only. Review contact/company matches and required fields. Tickets receive new
   Helpdock numbers; native IDs and numbers remain searchable provenance, from
   any ticket view.
4. Run the dry run. Compare expected counts, inspect public replies and private
   notes, authors, original dates, contacts and file availability. Resolve blocking
   errors and review each warning before acknowledging it. Check the brand's
   [retention window](data-retention.md) before loading old closed history;
   changing relevant inputs or policy requires another dry run.
5. Start the approved run and monitor its progress and log. Pause and resume if
   needed. Cancellation stops future work and keeps history already committed.
   Failed/cancelled/completed runs purge credentials; a new run needs a fresh
   connection. Repeating the same account/dataset reconciles existing native IDs.
6. After completion, compare counts and sampled ticket/contact histories with
   the source, open copied files, and check the original date range in
   [reports](reports.md). Inspect both language versions of imported articles.
   Missing or blocked source files remain visible findings; completion alone does
   not establish that the vendor account exposed every record.
7. For an automated source, create a delta from the completed run in the same
   brand and connect the same account. Reconfirm any inventory required by that
   source. Keep the source quiet during the final delta and repeat the checks.
   Snapshot readers and historical satisfaction scans may revisit unchanged
   records; unchanged business rows remain untouched.
8. Switch live channels only after verification, using the separate
   [email](email.md), [Telegram](telegram.md) and [Meta](meta-channels.md) guides.
   The importer does not copy channel credentials or enable sends. Rebuild the
   source's macros, automations, SLA policies and views by hand. Starting SLA
   clocks on eligible imported open tickets is an explicit admin action;
   publishing reviewed article revisions separately enables their embeddings.

If the run must stop, cancel it; cancellation is not rollback. To return to the
pre-import install, follow the [restore procedure](operations.md#restoring) and
account for live work added after the backup before replacing its state.

The importer covers supported ticket history, contacts and companies, staff
attribution, fields/tags, satisfaction, help-center content and their declared
files. It does not import side conversations, vendor macros/automation rules,
SLA policies or saved views. External call-recording systems, chat transcripts
outside tickets and community forums are outside this milestone's record model.

## Staff API

All routes below use an authenticated staff session and require `brand:manage`.
Creating staff through agent mappings additionally requires `staff:manage`.
Inputs and outputs use Zod and the generated OpenAPI schemas. These routes are
separate from the scoped public REST API.

The local admin implementation now mounts Brand › Import and individual run
routes. It includes source availability, recent runs, connection/scope forms,
progress, column/value mapping, saved presets and dry-run contact/ticket samples
with file availability. Focused browser checks and the real-API import wizard
pass in English and Arabic with axe; coverage and required current-head CI are
recorded in the milestone and PR.
The API contract below also supports scripted preparation and review.

| Method | Path below `/api/brands/:brandId/imports` | Behavior |
|---|---|---|
| GET | `/` | Up to 100 newest runs, newest first |
| GET | `/sources` | Sources with a registered production runtime; the UI disables the others |
| POST | `/` | Create a draft with `source`, `mode` and a completed same-brand `parentRunId` for delta mode |
| GET | `/:runId` | Run state and extracted/loaded/skipped counters; no worker or credential internals |
| PUT | `/:runId/connection` | Test and encrypt credentials; bind the verified account |
| PUT | `/:runId/scope` | Select entity types and report-backfill scope before extraction |
| POST | `/:runId/extract` | Start extraction through the transactional outbox |
| GET/PUT | `/:runId/mappings` | Read/replace confirmed mappings and their input fingerprint |
| GET | `/:runId/mapping-values` | Page observed source values and read-only suggestions by `kind`, `after` and `limit` |
| PATCH | `/:runId/mappings` | Upsert 1–100 mappings without removing mappings on other pages; invalidates the reviewed report |
| POST | `/:runId/dry-run` | Start resumable validation |
| GET | `/:runId/dry-run` | Read counters, issue samples and a completed report's review token |
| GET | `/:runId/preview/ticket` | Read paged ticket history |
| GET | `/:runId/preview/contact` | Read source details and the proposed identity/company match |
| GET | `/:runId/preview/samples` | Select up to three ticket and three contact source IDs |
| POST | `/:runId/start` | Approve the reviewed report and queue loading |
| POST | `/:runId/pause` | Revoke an active claim and retain credentials |
| POST | `/:runId/resume` | Resume extraction, validation, loading or finishing through the outbox |
| POST | `/:runId/cancel` | Stop further work and purge credentials |
| GET | `/:runId/log` | Read a bounded log page with level, direction and cursor filters |
| GET | `/:runId/log/export` | Download the log as spreadsheet-safe CSV, optionally filtered by level |
| GET | `/:runId/sla` | Read explicit SLA activation status and eligible open imported-ticket count |
| POST | `/:runId/sla/start` | Confirm `{ "acknowledge": true }` and queue/resume explicit SLA activation |

Run views also expose the creator's public ID/name when available, a verified
source account label and `hasDryRun`. A paused run also exposes its previous
active phase in `pausedFrom`, so progress remains accurate; otherwise that field
is null. Worker claim tokens and leases remain private. The label identifies the account/dataset
being migrated; it contains no credential. An absent dry-run is distinct from a
report that failed to load. The admin waits for the reviewed report and sample
requests before enabling Start, and ties warning acknowledgment to its review
token.

## Connect and map

The local API registers Zendesk, Freshdesk, Zoho Desk and manual files. All three
native reference sequences and the manual bundle/CSV database acceptance pass;
remaining batch checks are tracked in the milestone plan. An automated connection
body contains `credentials` and `downloadHosts`. Zendesk OAuth credentials use `auth: "oauth"`, `subdomain` and
`accessToken`; labelled legacy API-token credentials use `auth: "api_token"`,
`subdomain`, `email` and `apiToken`.

`downloadHosts` allows up to 32 exact lowercase hostnames, without schemes, ports
or wildcards. Every attachment redirect must stay within these approved hosts and
pass DNS/IP checks. The account API host comes from the validated workspace or
regional source configuration. Enter only external attachment hosts you have
reviewed and trust.

A successful connection returns the verified account and moves the run to
`connecting`. A refused test leaves the draft unchanged. Credentials are encrypted
under `APP_MASTER_KEY` and never returned after saving; reads expose only
`hasCredentials`. Delta connection refuses an account different from its completed
parent. Extraction starts once from `connecting` and ends at `awaiting_mapping`.

Zendesk organization exports may return more than 1,000 records when update
timestamps tie. The connector stages these in chunks, retaining the exact
vendor time checkpoint. Resuming within a chunked page checks its fingerprint;
a changed page is refused rather than silently skipping changed records.

Scope accepts nonempty, unique `entities` and `rebuildAllReports`. It is frozen
once extraction starts. Mapping proposals remain suggestions until confirmed.
There is no arbitrary date-range filter, and the run list shows the newest 100
runs; use the documented vendor inventory modes for completeness.

PUT mappings accepts `{ "mappings": [...] }` using the shared schemas' status,
priority, channel, group, agent, field and tag target shapes. Each kind/source-value
pair is unique. Saving from `awaiting_mapping` or `ready` clears the old report;
edits during extraction or loading are refused. The returned input fingerprint
covers source account/options, staged metadata and confirmed mappings. It is not
an approval or a substitute for validation.

The local wizard mapping editor uses `mapping-values`. Choose `kind`
from `status`, `priority`, `channel`, `group`, `agent`, `field` or `tag`.
Responses contain at most 100 values (50 by default), counts where applicable,
source names/agent metadata, a bounded field summary, and separate `confirmed`
and `proposed` mappings. `confirmedChoice` and `proposedChoice` name those
mappings' destinations in the same shape as a `mapping-targets` choice (`id`,
`label`, `nameAr`, `detail`, `selection`). They are `null` when there is no
mapping or it names no destination in this brand's catalog, such as a name-only
agent, a skipped field or tag, or a deleted status. The Map screen uses
them so each row shows its destination's name, in Arabic where one is set, before
the picker is opened. `nextCursor` is the last returned source value. Pass it
as `after` for the next page; an empty string is a valid default-value cursor.
Counts use ticket metadata and source definitions, without loading message
bodies into the API response.

Suggestions prefer existing same-brand/vendor/account receipts. Other matches
must be unambiguous: status semantics or labels, department/team names, existing
staff email, field key/type/options and tag names. Unmatched agents can retain
their source name. Suggestions create no people or fields and do not grant
roles; an admin must confirm them. Assignment department eligibility is still
checked by the dry run and loader. Creating invited people still requires
`staff:manage`. A missing priority/channel has an explicit medium/manual
suggestion; other unknown values remain for manual review.

Use `PATCH mappings` with `{ mappings: [...] }` when saving a page. `PUT mappings`
replaces the entire set and is appropriate only when sending every mapping.
Both refuse editing during active/terminal phases, and the complete set remains
limited to 50,000 entries. Every edit requires a fresh dry run. These paged APIs
and their suggestions are covered by focused unit/database checks; aggregate
coverage and CI remain separate acceptance gates.

The wizard groups mappings into statuses, priorities, channels, groups, agents,
fields and tags. It pages source values and searches only the current brand's
destinations through `mapping-targets`; field creation reads one staged field
through `mapping-field`. Confirming a page preserves mappings on other pages.
Suggestions remain separate from saved choices. Unsaved edits block page/tab
switches and dry-run/start actions until saved or discarded. Saving invalidates
the previous review receipt. People may map to existing staff, an invited person
with explicit departments and no email sent, or a name only. Fields may map to
compatible existing definitions, be explicitly skipped, or be created at import
time with all supported source options preserved. Over-limit options block a
new definition rather than being truncated. The routed editor is implemented
locally, with focused component and bilingual import-flow browser checks.

The local dry-run screen also offers ticket history in pages of twenty messages
and private notes, with original authors/dates, attachment names and expandable
plain-text bodies. Contact samples show planned identities, company links and
create/link/update decisions. The default country calling code accepts digits
without `+`; leaving it blank omits ambiguous national numbers. Changing it
requires another dry run before Start becomes available. Preview queries use
the report's calling code and review token. The dry-run flow passes focused
component/database checks and the real-API browser test in both languages with
axe. The seven-step progress strip links to currently visible
sections; extraction freezes source and scope edits. Unsaved mappings disable
navigation until saved or discarded.

Each previewed file names its current dry-run state: available, unavailable at
the source, blocked by safety checks, or not checked. These are recorded file
inspections, independent of the report's bounded issue sample. Changing the
source record, content policy or review makes an older inspection inapplicable.
No source download URL is exposed. An available dry-run result describes that
check only; loading fetches and validates the file again.

The local run screen now includes a severity-filtered log. Its latest page
refreshes while work is active; opening older pages freezes the upper boundary
so new entries do not move the page. Return to latest to follow progress again.
`log` accepts `level` (`info`, `warning`, `error`), `direction` (`asc`/`desc`),
`after`, `through` and `limit` (default 50, maximum 500). Reuse the returned
`through` and `nextCursor` for a stable paged boundary. CSV export captures the
current upper boundary and reads 500 entries per short tenant transaction; it
escapes spreadsheet formulas using the shared report CSV writer. The admin
download uses the existing Blob download pattern. Both endpoints require
`brand:manage`, including after a run finishes, and normal staging retention
still applies to its logs. Integration/browser verification remains deferred.

Queued SLA timers recheck the locked parent before acting; a ticket closed by
a later import delta cannot be escalated by a stale timer. Import loading does
not invoke SLA hooks or change the administrator's activation marker.

Imported tickets keep SLA clocks off until an administrator explicitly starts
them. The completed-run SLA card covers open imported tickets from that source
account in the current brand, including prior runs. It does not depend on
temporary staging rows or retained credentials. Confirming freezes the request
time: later imports stay outside that request. Applicable clocks start when
each ticket is activated, without changing its original creation date. Closed,
deleted, merged and already activated tickets are excluded. Tickets without a
matching SLA policy are skipped; configure a policy and request activation again
if needed. Configured SLA scheduling and escalation behavior applies after
activation. Leaving the page does not stop the worker. A failed action can be
retried from its saved cursor without resetting previously started clocks.
The local implementation includes fifty-ticket batches, outbox continuations
and five-minute recovery; tests and browser acceptance have not been run yet.

The local workspace also displays the import source and original number, and
searches source numbers/native IDs under normal ticket RLS. An exact original
number (`580` or `#580`) or native ID finds the ticket from any view, ahead of
the view's other matches, even when the view's status filter would hide it, as
it does for most imported history, which is closed
([Tickets: listing](tickets.md#listing)). Use the Source
filter to select imported or native tickets and save that choice in a view.
Former-agent names survive in thread messages. Source navigation links omit
queries and fragments, and imported audit lines show original actors/dates and
field changes. The install-only System page shows worker-reported import counts
and latest retained errors; it does not broaden the request's tenant context.
Its snapshot expires after three minutes and displays unknown when unavailable.
These workspace/health paths are implemented locally and await verification.

## Manual file mapping (local implementation batch)

For a tickets export with its initial customer message, upload a contacts file
as well so the author reference resolves. For example:

```csv
Contact ID,Name,Email
customer-7,Original customer,person@example.test
```

Choose Contact as the entity. Map `externalId` from Contact ID, `name` from Name
and `emails` from Email with a Split transform (for example, separator `;`) to
produce an email list. Keep IDs as text. Then upload this tickets file:

```csv
Ticket ID,Requester,Subject,Created,Body
0007,customer-7,Old question,03/11/2024 14:20,"مرحبًا
""الرد الأصلي"""
```

Map the ticket's `externalId` from Ticket ID, `requesterExternalId` from
Requester and `subject` from Subject. Map both `createdAt` and `updatedAt` from
Created with the explicit `dmy` format and `Asia/Riyadh` timezone; this example
becomes `2024-11-03T11:20:00.000Z`. Map `status` to a constant `open`.

In the initial-message fields, map `bodyText` from Body and `authorExternalId`
from Requester, choose the constant `customer` for `authorKind`, and set `public`
to true using a Boolean transform. The mapper supplies the stable message ID,
parent ticket ID and creation date from the ticket. For private notes use false
and the corresponding original author's reference. A display name alone does
not replace a missing contact/staff reference.

Validate both files, then extract Contact, Ticket and Message. Confirm the value
mappings, including the default department/priority/channel, and review the dry
run before starting. Save the column mappings as presets for future files with
the same ordered headers. Reuse the same dataset label for an unchanged repeat;
the native ID `0007` remains text throughout.

The normalized bundle format can now retain article `attachments` using the same
file-reference shape as message files. Every referenced `bundlePath` must exist
inside the archive. Articles may also carry an explicit `published` snapshot
with its own `title`, `bodyHtml`, optional `description`/`attachments`, and nullable
`publishedAt`. The top-level content is the working copy; files in that copy are
not added to the public snapshot. `published: null` means the source has no
published copy and requires `draft: true`. Omitting `published` keeps the existing
single-copy format. This preserves a published article alongside newer draft
edits; unknown publication dates remain null. Both file sets are validated against
the archive independently.

The local implementation now connects article preparation,
media processing and loading. Preparation records one file per continuation,
then waits for the media worker and seals the resulting HTML against the exact
staged source. The loader checks that manifest and binds every retained file to
its source-owned article in the article transaction. Refreshed download URLs do
not change a prepared article's content receipt.

Automated connectors may retain a file's display/download addresses as bounded
`sourceUrls` aliases alongside its primary `url`. These aliases only identify
links or images to rewrite to the imported file; they never grant permission to
download another URL. Archive references using `bundlePath` do not accept URL
aliases. Conflicting aliases within one article copy stop preparation so a link
cannot silently point at a different source file.

The Zoho reader reconciles article files against the pinned working version
before importing the article. Missing, repeated or changed file metadata stops
extraction; keep the source unchanged during migration, then retry after
reviewing the source. If Zoho uses a file-list envelope that differs from its
documentation example, the import log and dry run flag that inference for
review. This reconciliation does not substitute current files for the older
published version's attachments.

The local Zoho reader includes recoverable recycle-bin article and taxonomy
records alongside active data. Deleted article translations stay internal
drafts, with original working content and any recoverable last published copy
kept separate. The reader groups active/deleted language siblings before output
and never restores or deletes anything in Zoho. Unreadable source records,
inconsistent parents, changing pages or repeated pagination stop extraction
rather than silently producing an incomplete history. The Zoho stand-in's full
reference import, process-kill recovery, unchanged repeat and active/archive
delta pass on real Postgres and Redis. This is local acceptance against the
documented API shapes; a real Zoho account run remains an owner check.

In the Zoho connection card, select the data center that hosts the source
organization. Enter its organization ID unchanged, along with the OAuth client
ID, client secret and refresh token issued for that region. Client secret and
refresh token are masked and cleared after a successful connection; an invalid
organization ID is rejected before connecting. A refused connection keeps the
masked values available for correction. EN/AR browser and accessibility evidence is recorded in the milestone; a real
Zoho account remains an owner verification step.

Successful Zoho email threads also read the original-mail resource to preserve
Message-ID and the source mail date independently of the thread's timeline date.
The existing **Original message details** disclosure shows the original email
subject, date header and return path. An unparseable mail date stays unknown in
the email metadata, while its raw text remains available in that disclosure;
the import log and dry run include a warning. If the source no longer provides
original mail (404/410), the importer preserves the available rendered thread
and attachments and explicitly warns that Message-ID could not be recovered.
Permission, malformed-response, rate-limit and server errors do not silently
drop mail metadata. Unsent drafts are never sent or queried as original mail.
The duplicate raw MIME response is discarded after its header metadata is read.
The milestone records the stand-in, database and browser coverage for these
cases and distinguishes it from real-provider verification.

Article copies can declare `assetOrigin`, an HTTP(S) origin without a path,
credentials, query or fragment, to resolve relative image URLs. The Zoho reader
sets its selected regional Desk origin on both working and published copies.
Manual bundles must declare an origin separately on each copy that needs one;
relative `attachments/` members keep their normal bundle behavior. The origin
does not approve a host or bypass download policies. Equivalent absolute and
relative image references are downloaded once and rewritten to Helpdock media.

Gallery/display image URLs receive no vendor credentials. If an unauthenticated
image returns 401/403, its unavailable-file warning must be reviewed in the dry
run and the imported content keeps an explicit placeholder. Native API permission
failures still stop the import; rate limits and server failures remain retries.
There is no call to a source-side image-migration or upload endpoint. Working
and published images are prepared independently, and only images referenced by
the published copy can appear in that copy. Relative-image transport and real-DB
conversion/visibility cases are authored but await batch execution.

Zoho's default extraction discovers active and archived tickets without a CSV.
It enumerates archives in enabled and disabled departments and rescans archives
for deltas, since that endpoint has no documented change-time filter. If the
archive pagination ceiling or an indivisible change-time window prevents proving
completeness, extraction fails before destination loading. Start a new run and
select **Use a reviewed ticket ID inventory instead of automatic archive discovery**
under Scope, then upload and confirm a complete ID export. Archive-only inventory
mode supplements live discovery; complete mode bypasses both native lists.
Changing the selected inventory or mode requires confirmation again. The source
must be frozen for final cutover reconciliation because the API does not provide
a transactionally frozen account snapshot. This local path is awaiting native
acceptance and end-to-end verification.

Zoho connection checks use an Administrator permission profile with export,
cross-department, recycle-bin and agent-field access. Request only the documented
read grants: `Desk.tickets.READ`, `Desk.contacts.READ`, `Desk.accounts.READ`,
`Desk.agents.READ`, `Desk.departments.READ`, `Desk.organization.READ`,
`Desk.basic.READ`, `Desk.permissions.READ`, `Desk.fields.READ`, `Desk.search.READ`
and `Desk.articles.READ`. The check probes the corresponding read endpoints and
includes one satisfaction query, which costs 50 Zoho API credits. Custom or
restricted profiles fail this full-export check.

Worker access tokens are cached inside the run's encrypted credentials so a
continuation or replacement worker can reuse them. They are never accepted as an
internal snapshot through the public form or returned by run responses. Terminal
cleanup clears both the refresh credentials and cached access token; a late
refresh cannot restore a cancelled run's credentials.

Adding a supported language can change which imported translation anchors the
group when Zoho's native primary language is outside English/Arabic. The local
loader uses the existing source-owned sibling to keep both languages on the
same destination article. Dry run refuses an occupied language that the import
does not own; it also refuses conflicting sibling relationships. Receipts from
another brand, vendor or source account never authorize that reuse. This path
has authored database coverage and still awaits batch verification.

Images and other files recheck the source digest and current MIME/size policy.
Images are re-encoded to WebP; other files use the existing optional ClamAV
scanner and are served as downloads. Scanner errors remain retry failures.
Original-image and rejected-file deletion is queued with the committed media
state, so a failed transaction retains its source bytes for a retry.
Missing source files or policy refusals leave a warning in the import log and
an EN/AR availability message in the article. Their original download links are
removed. Storage and exhausted processing failures stop the run rather than
being described as missing source data.

File downloads check the current parent article, locale and readership. Public
readers need a published public article; private previews require the existing
help-center staff session, including its revocation check. Removing the actual
file link revokes new download URLs. Files cannot use the image route. Existing
fallback help-center links stay within the staff cookie's `/hc/<brand>` path;
the cookie is not widened to the rest of the install. Existing
image-route behavior remains unchanged. Nightly retention removes abandoned
importing assets after 30 days, protects current working/published references
and active/paused imports, and sends object cleanup through the outbox. Native
uploads are outside this cleanup.

Database integration covers file authorization, locale/readership changes,
processing failures and image ownership. English and Arabic browser checks with
axe cover the rendered file link, downloaded fixture bytes and unavailable-file
message. The browser storage response is a stand-in; it does not prove a real
object-store deployment or vendor account.

The dry run now inspects declared article files, remote article images and
inline raster images as well as ticket attachments. It reads one bounded file
per continuation, checks source size, MIME and brand policy, and adds missing
files or safety failures to the existing review. It creates no article-media
rows, uploads or processing jobs. This inspection does not replace scanning and
image conversion during the actual import. Earlier attachment-only approvals
are invalidated by the new input-fingerprint revision and require a fresh dry run.

The manual upload/wizard has a local implementation awaiting verification. The reader and mapper are being
implemented locally; the transform/preset additions below await batch validation.

CSV mapping keeps identifiers and other cells as strings. A field selects one or
more named columns, or a literal, then applies its ordered transforms. Multiple
columns require a join transform before string transforms. Dates use an explicit
ISO, day/month/year, month/day/year or epoch format; local calendar dates/times
also require a timezone. Ambiguous or nonexistent daylight-saving times are
errors rather than guessed timestamps. Value maps and booleans reject unknown
values. HTML and plain text map to distinct normalized body fields.

A tickets mapping can additionally define `firstMessageFields`. The generated
message links to that ticket and defaults to its creation time, a system author
and private visibility; map author, timestamp and visibility when those source
columns exist. Attachment URL transforms retain addresses for the authorized
download pipeline; mapping never fetches them. File-derived attachment identities
are stable by parent message and list position.

`previewImportCsv` reads at most twenty data rows and closes its input.
`validateImportCsv` scans the complete file, counts invalid rows and retains at
most one hundred issue samples. A preview alone does not authorize staging.
`skipInvalidRows` is optional and off by default. When explicitly enabled,
invalid mapped rows are omitted during extraction. Whole-file validation still
counts them and returns bounded issues. The dry run counts omissions as warnings
and requires acknowledgment before loading. This cannot bypass malformed CSV,
unsafe bundle members, encoding/size checks or other source-file errors.

Source-file routes live below `/api/brands/:brandId/imports/:runId`:

| Method | Path | Behavior |
|---|---|---|
| PUT | `/file-source` | Bind a stable `dataset` label and approved `downloadHosts` before uploading |
| POST | `/files/presign` | Allocate a private size-bound upload; body contains `fileName`, byte `size`, `format`, and CSV `entity` |
| POST | `/files/:fileId/confirm` | Check stored size and queue preparation through the outbox |
| GET | `/files` | Poll up to 100 lightweight file summaries and readiness flags; excludes source previews and complete mappings |
| GET | `/files/:fileId` | Load one file's detected headers, mapping, twenty bounded sample rows and validation details |
| PUT | `/files/:fileId/mapping` | Save `{ mapping }`, invalidate the old result and queue complete-file validation |
| PUT | `/files/:fileId/inventory-mapping` | Select the native ticket-ID column and location for a vendor inventory, then validate the sealed CSV |
| DELETE | `/files/:fileId` | Discard a file before extraction and revoke its pending mapping work |

The browser uploads directly using the returned URL and signed headers. The
worker reads from disk and creates a separate private sealed copy; the upload
URL cannot change this source. Mapping changes advance a revision, so a stale
worker cannot publish validation for another mapping. File views expose neither
storage keys nor checksums. Keep the same dataset label for repeats/deltas from
the same legacy dataset; different datasets must use different labels.
The local adapter connects prepared files to extraction, dry-run and loading.
Database acceptance covers a 500-ticket bundle, an unchanged repeat and CSV
presets with explicit local dates and quoted multiline Arabic. The run screen
offers CSV/entity or bundle selection, upload progress/cancellation, preparation
polling and removal confirmation. Uploads use the same injectable PUT transport
pattern as media; the mock simulates progress without issuing storage requests.
The local column editor offers ordered transforms, multiple-column or constant
sources, first-message fields, custom keys, twenty-row validation previews and
brand presets. A unique preset for the exact ordered headers/entity is proposed
automatically; several matches require an explicit choice. Saving still runs
complete-file validation. Rules are shown twenty at a time, preserving edits
across pages. The manual mapping browser flow passes in English and Arabic with
axe; full-file preparation is covered by the database acceptance. A run accepts
up to 100 CSV files, or one bundle instead of CSV files. Start extraction only
after every file is ready and each CSV validation either has zero invalid rows
or explicitly skips them. Mapping
edits are frozen once extraction starts. Manual deltas rescan the supplied files
and let existing load hashes identify changed records; they do not remove local
records absent from the snapshot. Different payloads sharing a native ID in one
file run are refused during extraction. File and row cursor offsets support
resume, with source checksums checked again on every read. An exhausted file
preparation can be rescheduled by recovery after one hour without a checkpoint.
Source files and the other staging tables now have a local 30-day retention
implementation; run summaries and native-ID receipts remain. Discarded sources
expire 30 days from discard. This and complete acceptance await batch validation.

Preset routes live below `/api/brands/:brandId/import-presets`, require
`brand:manage` and use the request's tenant transaction:

| Method | Path | Behavior |
|---|---|---|
| POST | `/` | Save `{ name, headers, mapping }`; duplicate names ignoring case return 409 |
| GET | `/` | Filter by `entity` or `headerFingerprint`; paginate fifty rows using `after` and `nextCursor` |
| DELETE | `/:presetId` | Delete a same-brand preset; an unavailable ID returns 404 |

Header fingerprints include column order, spelling and case. They are calculated
by the server; connector credentials and source rows are not added to presets.

## Validate and inspect

1. Send `POST /api/brands/{brandId}/imports/{runId}/dry-run` with `{}` or
   `{ "defaultCallingCode": "963" }`. Duplicate starts or unavailable phases
   return 409; malformed settings return 400.
2. Poll `GET /api/brands/{brandId}/imports/{runId}/dry-run`. A report that does
   not exist returns 404. Validation returns to `awaiting_mapping` for review.
3. Inspect previews and correct blocking errors. Rerun validation after edits.
   Pause/resume retains committed progress; recovery also handles abandoned claims.

The report exposes checked counters, full error/warning totals and at most 500
issue samples. Retention loss warnings appear first, followed by blocking errors
and other warnings. This priority also applies to bounded checkpoint samples.
Totals can exceed displayed samples. `refusedPhones` counts phone
numbers that cannot be normalized; each affected contact contributes one
`phone-refused` warning without exposing phone values. A completed report can
contain blocking errors. `complete: true` alone never authorizes loading.

Validation checks staged integrity/references, effective knowledge ancestry, routing,
required/custom field values, live mapping targets, combined field/invitation
plans and contact/company identity collisions across record pages. Prior delta
identities are reused only in the same brand/vendor/account. Ambiguous existing
matches or different new destinations sharing an identity block validation;
source aliases may link to the same existing local profile. Linking preserves
local names, company links and verification. Imports do not automatically merge
people or send invitations.

Knowledge ancestry uses staged edits first and existing same-account receipts
second. Cycles through existing categories/sections, missing ancestors, deleted
targets and wrong category/section bindings block validation. Physical target keys
also prevent source aliases from becoming self-parents. Valid staged reparenting
can replace old ancestry, and category aliases resolving to the same local target
are allowed.

Article locale versions share one local article, so legitimate translation aliases
are not treated as physical parent cycles. Staged source translation cycles still
block validation, as do redirected article identities, different sections and
repeated staged locales in a translation chain. A new translation cannot overwrite
an already occupied locale without its own import receipt. Existing owned
translations can be updated; another language's version remains unchanged. Article
version revisions are included in the destination freshness snapshot.

Attachment validation downloads one bounded file at a time to temporary storage,
checks bytes and content policy, and removes the temporary file. Missing files
produce warnings; policy refusals produce errors. Throttling/transient failures
do not advance the file cursor. These checks do not replace final image processing
or antivirus work during loading.

Validation also snapshots local destination revisions. Changes to destination
profiles, memberships, field/routing definitions, knowledge hierarchy, brand
policy or same-account import identities can invalidate it. Staff-row revisions are checked install-wide because invitation emails are unique
across the install. Password values are never read, but any staff-row update can
require validation again. Session-table changes do not affect this snapshot.
This is conservative: unrelated destination edits can require validation again.
Use a quiet cutover window if active edits repeatedly invalidate a run. The worker
retains bounded metadata pages rather than full profile/knowledge bodies.

Ticket previews accept `externalId`, `offset` (default 0) and `limit` (default 20,
maximum 50). They return chronological public messages/private notes with original
dates, staged source-author names and attachment metadata. Follow `nextOffset`
until null; the 4 MiB message-entry budget never truncates an individual message.
Preview and storage use the same safe body renderer. Source/download URL fields
and mail transport headers are omitted.

Contact previews accept `externalId` and optional `defaultCallingCode`. They show
original notes, dates, locale, identity provenance and a separate source-company
plan; a proposed new company has no allocated ID. Use the dry run's calling code
when comparing the plan. Sample selection returns up to three source IDs of each
type, ordered by source ID. It aids navigation and does not prove representative
coverage. Blank/NUL lookup IDs return 400, missing or foreign-brand records return
404, and corrupt/oversized history or invalid mapped values return 409.

## Approve and load

Send `POST /api/brands/{brandId}/imports/{runId}/start` with the completed report's
`reviewToken`. If warnings are acceptable after inspection, include
`"acknowledgeWarnings": true`. Do not acknowledge omissions without checking them.

Blocking errors return 409 even when warnings are acknowledged. A wrong token,
changed source/mappings or changed destinations returns `import.dry-run-stale`
inside the standard error envelope, with status 409. Rerun validation and review
the new report. Missing warning acknowledgement returns
`import.warnings-not-acknowledged`. Paused, terminal or already-loading runs cannot
start again.

Approval and its load request commit atomically through the outbox. The worker
rechecks the approved snapshot before its first domain write; if the queued report
has become stale, it returns to review without loading and retains credentials.
Each run has at most one queued request at a time. A run whose worker stopped
renewing its claim, or whose queued request left the outbox but never started,
is resumed by the per-minute recovery sweep 30 minutes later. A request still
waiting in the outbox is never duplicated.
The calling code used by validation is also used by loading. Later batches retain
their approval receipt while normal loader checks still validate live targets.

Loading uses the direct historical writer. It must not send customer messages,
run customer automation or start SLA timers. Cancel does not delete history
already imported. Credentials are purged on terminal completion, cancellation or
failure. Review the dry run's capacity, completeness and retention findings before
loading. Vendor stand-in acceptance and process recovery are recorded in the
milestone plan; final coverage, CI and real-account runs remain separate checks.

## Repeat imports and satisfaction deltas

The loader skips unchanged business data and leaves report rows untouched when
no ticket history or satisfaction answer changed. Run records, validation and
load checkpoints still record the attempt. Older checkpoints without a change
marker rebuild reports conservatively.

A satisfaction rescan can update an existing imported ticket without exporting
that ticket again. The loader requires the same brand, vendor and verified
source account, preserves the answer's original date and never sends a survey.
Deleted or unavailable parents are refused; dry-run reference checks also reject
a deleted imported ticket. Independently changed answers invalidate the stored
whole-ticket receipt so a later source reversion is applied rather than missed.
Changed answers trigger report rebuilding from their parent ticket's original day.

Satisfaction native IDs are unique within a source account. Migration
The unshipped import schema is consolidated in `0054_imports`, after the already
merged `0053_sso`. Imports created by intermediate PR #215 builds are development
data and are not a released upgrade boundary. Released 0052 and merged 0053
installations upgrade directly to the final schema without rewriting native
satisfaction answers.

## Original message facts

When a connector supplies original message facts, **Original message details**
under the message shows its source status, channel, direction and author type.
These are historical text, not delivery controls. Draft, failed or pending source
replies are retained as private history with a dry-run warning; importing never
sends or retries them. The original body and dates remain intact apart from the
normal HTML sanitizer.

A source may provide an author's name without a stable identity. Helpdock can
retain that name with **original author** attribution instead of assigning it to
a local user. A known original agent can remain name-only; an unresolved customer
is not labeled as an agent. These source-only customer/unknown messages do not
count as staff first responses in historical reports. Splitting a ticket retains
its copied messages' original facts.

## Install-wide import status

Install admins can open the Imports card on System to see active and paused
runs across active brands, with the latest retained error for each brand. The
worker publishes readings that expire after three minutes; an unavailable
reading means unknown, not zero. Previous/next controls show fifty brands at a
time from the same reading. Return to latest snapshot picks up the newest
worker reading. If a reading expires while paging, return to latest; System
never queries tenant import tables directly from install scope.

Connector warnings about unavailable source records, inferred rating dates or
restricted readership appear in the dry-run review and require warning
acknowledgement before loading. Counts include every distinct source warning;
the review keeps a bounded sample, and the run log keeps the retained entries.

For a Freshdesk import, enter the workspace label (`acme` for
`https://acme.freshdesk.com`) and an agent API key with ticket and agent read access.
Choose the satisfaction API supported by your account. A permission refusal does
not fall back to another satisfaction API.

Before extracting Freshdesk ticket history, upload a CSV inventory of source ticket IDs.
Select its ID column and whether those IDs are active, archived, or need automatic
location detection. Only a not-found response permits automatic archive fallback.
The server seals the uploaded file and validates every selected ID; a wrong column
can be corrected without uploading again. The preview shows the first source ID
values, followed by validated unique and duplicate counts. Correct invalid rows
before continuing; values that cannot safely identify a vendor ticket are refused.

Use **Archive IDs plus the live export** to append the archive inventory to the vendor's live
listing, or **Complete ticket ID inventory** to fetch all tickets from the uploaded
IDs and bypass listing ceilings. Confirm that the selected inventory covers what
you need. Helpdock can validate those IDs, but cannot prove an export includes
every record in your vendor account. Changing files, their mappings or the mode
requires a fresh confirmation. Conflicting locations for an ID in overlapping
files must be corrected. Contact/company-only imports do not require ticket IDs.

Freshdesk’s newer satisfaction responses preserve the original questions, answers,
response status and dates. When the historical scale cannot be established, the
ticket shows an imported answer without a comparable score. Expand Original survey
answers in the Satisfaction card to read it. These answers have no live survey
link and do not contribute to rating averages. Review and acknowledge the
unmapped-rating warning in the dry run before loading them.

Freshdesk native profile attributes that have no Helpdock profile column appear
as fields with their original attribute names in the mapper. Choose an existing
field, create one, or explicitly skip it. Additional companies, social handles,
contact tags and devices are preserved as JSON text when mapped. The original
company-ticket visibility flag is historical data and never grants access to
Helpdock tickets. Dropdowns with more than Helpdock’s 50 allowed choices are
proposed as text fields; their stored values remain unchanged.


### Review safeguards added after the merge-blocking audit

Closed source tickets mapped to a closed Helpdock status are checked against the
brand's Data retention window during the dry run. A warning states that the next
retention job will permanently remove each affected ticket and its attachments.
Change the retention policy before importing if you want to keep that history,
then rerun validation. Warnings require explicit acknowledgment; a policy change
invalidates the previous review. Imported close dates and the retention policy
itself are not changed by the importer.

Time-based rules measure their waiting period from the later of source status
change and first import arrival. A delta that keeps the same status retains its
existing status timestamp; updating the subject or thread does not start a new
waiting period. If an admin has activated SLAs, subsequent deltas
satisfy response clocks for imported agent replies and reconcile paused statuses
without emitting live ticket hooks, notifications or new SLA timer events.

A resumed extraction reuses the source GET responses its last checkpoint still
points into, with the original page boundaries: for example the ticket list page
and the comment page being walked. Responses no checkpoint points into, such as
an earlier ticket's comments or an author lookup, are removed when the next
checkpoint is saved, so storage stays bounded while a large account is extracted.
List pages that several entities walk, such as the ticket list used by tickets,
tags and conversations, are kept for the whole extraction so every entity sees
the same records. A resume re-reads a per-record detail page, such as an author,
from the source. These private, tenant-isolated page snapshots are removed when
extraction ends or is cancelled/failed. A new run fetches new source state;
attachment downloads still refresh their signed URLs.
Freshdesk scans in creation order; a nonempty 300th page requires the complete
native-ID inventory mode. Zoho deltas scan creation-ordered tickets and filter
modified timestamps locally instead of paging mutable search results.

The worker retains at most one verified bundle and ZIP index for attachment
reads, reusing it while the sealed object key, store, size and digest match. Its
idle cache expires after one minute; a restart validates the source again.
Attachments continue into the configured private S3-compatible bucket, subject
to MIME/size checks and authorized downloads.
