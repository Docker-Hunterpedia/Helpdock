---
"@helpdock/api": minor
---

Prepare tenant-isolated import staging, historical ticket and attachment provenance, and validated normalized records for support-platform migrations. Restrict importer HTTP requests to explicitly allowed vendor hosts on every redirect hop.

Add private, size-bound manual source uploads, sealed source preparation, CSV mappings and transforms, bounded previews, full-file validation, and brand-scoped reusable mapping presets. Feed prepared CSV files and bundles into resumable import phases without synthetic credentials. Honor object-download backpressure for large source files.

Expire source-file and import staging rows thirty days after finish or discard, and publish private-object cleanup through the outbox while retaining run summaries and native-ID receipts for future deltas.

Add the bilingual Brand import area with runtime source availability, creator/account labels, connection and scope controls, phase progress, pause/resume/cancel, delta creation and dry-run ticket samples. Keep Start disabled until the current report and previews are available, blocking issues are resolved and warnings are acknowledged for that report.

Page observed source mapping values with explicit defaults and read-only match suggestions. Save a mapping page atomically without replacing other pages, and invalidate prior approval whenever mappings change.

Add local CSV column/constant mapping, ordered transforms, exact-header presets, validation previews and explicit skipped-row warnings. Review paged source threads and contact matches before loading. Expose severity-filtered import logs and CSV downloads.

Show wizard progress and per-file dry-run availability in English and Arabic. Bind temporary inspection results to the reviewed source and file policy, including files beyond the report's issue samples.

Keep imported tickets outside automatic SLA synchronization until explicitly activated; starting clocks preserves their original history dates.

Refuse stale SLA timer actions after a quiet source update closes an imported ticket, and read timer eligibility while holding the parent lock.

Show imported ticket provenance and former-agent names, search original numbers/native IDs under ticket RLS, and save imported/native Source filters in views. Report import health through expiring worker snapshots on the install System page.

Page older ticket activity under the parent ticket's scope, preserving events with equal or sub-millisecond timestamps and rendering imported audit events in the thread.

Preserve bilingual imported knowledge versions and source descriptions, and raise help-center article titles to 500 characters. Reject malformed UTF-8 rather than silently altering imported text.

Process shared historical attachments without live events or AI transcription, and preserve imported author names and file origin when splitting tickets.

Keep imported knowledge searchable without scheduling AI embeddings. Previously queued embedding and re-embedding work skips imported language versions until staff explicitly publishes them.

Commit historical ticket/thread progress atomically, retain changed source subjects on delta, and refuse deleted migration targets rather than reporting them as imported.

Invalidate previous dry-run approval when import mappings change, and refuse mapping edits during active or terminal import phases.

Preserve source ticket audit events with their original dates, actors and changes as inert imported activity, including idempotent repeat and delta checkpoints.

Retain final vendor watermarks for delta extraction and preserve CC relationships supplied as source user IDs. Reconcile import-owned CCs without removing manual participants, and validate required fields for imported email-only contacts.

Add initial Zendesk core exports and resumable contact hydration. Preserve native profile notes, descriptions, dates and identity provenance without granting verification or staff access from vendor data.

Extract paged Zendesk public replies, private notes and attachment references with original authors/dates and resumable thread checkpoints.

Stage Zendesk organization exports above 1,000 records without losing timestamp ties. Preserve exact vendor watermarks and refuse changed pages during chunked resume.

Extract Zendesk ticket, contact and company field definitions with separate source scopes, and discover historical tags from ticket exports rather than the limited popular-tag listing.

Extract historical Zendesk audit changes and notification records as inert activity with original dates and actors, resumable pagination and changed-history delta watermarks.

Extract Zendesk legacy and current survey satisfaction answers. Preserve native scores, answer metadata and timestamp provenance after staging purge, with explicit warnings for normalization and inferred legacy timestamps.

Extract bilingual Zendesk Guide taxonomy and article translations with original dates and separate draft/readership states. Restricted or unknown readership stays internal with a warning.

Retain nested source section ancestry and bilingual breadcrumb names within the flat help center. Refuse cycles and cross-category parents, and refresh breadcrumbs when source parent names change.

Checkpoint profile, field and prepared knowledge loads atomically with progress and resolved-request fingerprints. Reject changed mappings on resume, validate target availability, and follow manual contact merges without duplicating progress.

Validate source-to-destination custom-field mappings before profile loads. Preserve confirmed values and explicit clears, and reject unknown, ambiguous or substituted field data.

Resolve ticket routing from confirmed status, department, priority, channel, staff and tag mappings. Require explicit defaults for missing source values and preserve requester/CC links through source identities.

Assemble ticket history and confirmed authors from staged records. Preserve name-only historical authors, reject incomplete or corrupted child history, and keep resume receipts deterministic.

Checkpoint existing, invited and name-only staff mappings with import progress. Name-only history creates no account, and invited staff receive no invitation delivery or activation during import.

Build field, profile, staff and knowledge load operations directly from staged source records and confirmed mappings. Resolve company links and require prepared article content before committing it.

Select staged metadata in dependency order and refuse unresolved parents or cycles instead of reporting the loading phase as finished.

Refuse repeated or delta imports whose historical message targets have been purged, rather than reporting incomplete local history as unchanged.

Apply source message edits, redactions and confirmed author corrections to existing historical rows without appending or delivering replies.

Reconcile source attachment additions/removals on message deltas, preserve shared files and manual uploads, and queue last-link object cleanup transactionally. Changed native file metadata receives a fresh pending object.

Prepare bounded, MIME-validated imported file downloads with temporary-file cleanup. Fence attachment storage attempts and queue silent processing only under a live claim; derive media variants beside the stored object key.

Refuse an attachment rejection receipt when its local target disappeared during the vendor download.

Include pending import credential envelopes in master-key rotation while preserving worker fencing nonces.

Rebuild imported report history in resumable local-day chunks and atomically complete runs with credential purge and an audit record. Reindex changed imported help-center versions through a bounded run event; preserve draft visibility and avoid reindex events for unchanged repeat imports.

Namespace imported native IDs by verified vendor account, keeping tickets, contacts, attachments and dependency references from different accounts separate and rejecting mismatched delta parents.

Preserve historical RFC Message-IDs without colliding with live-email deduplication. Refuse ambiguous imported thread references, prefer verified Helpdock/live references, reject header injection characters, and retain historical mail provenance in split copies.

Define strict import phase jobs and schedule work through validated transactional outbox requests, with stable delayed delivery IDs and safeguards for paused, unbound or mismatched-account runs.

Consume validated import phase jobs with fenced claim release/continuations, credential-retaining rate-limit deferral, and safe terminal failure logs, audit and credential purge.

Schedule recovery for abandoned import work without replacing fresh claims or resuming paused runs, respecting retry deadlines and throttling duplicate requests.

Download up to four historical attachments concurrently, drain partial-failure batches before retry, and preserve successful files. Retry transient vendor outages with a bounded budget without spending it on 429 waits, resetting it after successful continuation.

Refresh expired Zendesk attachment links once through authenticated metadata, and retain named placeholders for unavailable imported files.

Register the production import worker and validate encrypted Zendesk account credentials and exact per-run attachment destinations.

Add guarded staff import draft, connection and extraction endpoints with shared input/output schemas, write-only credentials and verified delta account binding.

Add guarded import entity/report scope and pause/resume/cancel controls; prove staff role and brand isolation with real authenticated HTTP sessions.

Expose guarded mapping confirmation and paged input fingerprints; invalidate earlier dry-run reports when mappings change.

Share staged integrity checks between ticket loading and read-only preflight, and validate account-scoped historical dependencies without creating domain rows or jobs.

Detect cyclic staged knowledge ancestry and translation dependencies during read-only preflight.

Add read-only checks of live mapping destinations, eligible staff and safe field bindings before import provisioning.

Validate complete field creation plans for shared destination keys, combined capacity and immutable account-scoped reuse without provisioning.

Share ticket-assignee department eligibility between loading and preflight, and check invitation collisions and reused staff scope without provisioning.

Validate duplicate new invitation emails across the complete import plan with account-scoped reuse and no provisioning side effects.

Project custom values against existing and proposed field definitions using the loader’s validation rules without creating fields.

Plan contact identity reuse and ambiguity through the loader’s matching rules without locks, profile changes or verification upgrades.

Detect conflicting contact identifier claims across the proposed import while allowing aliases of one existing local person.

Share organization domain matching between read-only preflight and loading, preserving local names and refusing ambiguous company links.

Expose a brand-admin ticket-history preview endpoint with validated pagination, sanitized bodies, source-author checks and filtered attachment metadata. Refuse foreign-brand access and invalid source author kinds without returning source/download URL fields.

Expose contact source details and read-only identity/company plans, and select up to three stable ticket/contact sample IDs within a run. Preserve local profile verification and links, and reject malformed lookup IDs or invalid mapped values before returning a preview.

Add outbox-backed, resumable dry-run execution and a bounded validation report API. Dry runs support pause/resume/recovery and stop at review without approving or starting destination writes.

Preserve refused-phone warnings and exact omission totals through whole-run dry-run checkpoints and public reports, including pause/resume, without exposing phone values.

Bind import approval to the reviewed report, require explicit warning acknowledgement, and refuse stale source or destination snapshots at approval and before the first queued domain write. Preserve the reviewed calling code during loading so national phone numbers are not silently omitted.

Validate effective staged/live knowledge ancestry and locale conflicts before importing. Refuse aliased category/section self-cycles in both preflight and loading, while allowing valid staged reparenting and shared article translations. Include article version changes in approval freshness.

Preserve report rows on unchanged repeats and reconcile satisfaction-only deltas against existing imported tickets. Retain original answer dates, refuse unavailable parents and invalidate aggregate receipts so reverted source answers are reapplied. Namespace satisfaction rows by vendor account and backfill ownership without guessing ambiguous receipts.

Preserve original source references and former-agent names in imported ticket views, add imported/native filters and source-number search, and page long historical activity without dropping timestamp ties.

Add worker-cached install import summaries with immutable brand pagination and unknown/expired states. Include connector extraction warnings in the reviewed dry-run receipt and preserve attachment page hints independently of historical message identity.

Preserve unscored historical satisfaction answers and original question values without distorting score averages. Show imported answers in dated inert history and a separate staff display fallback, while leaving native survey delivery selection unchanged. Retain native status IDs and source labels for custom status mapping.

Add sealed native-ticket inventory staging, FORCE RLS, strict streaming CSV ID parsing and bounded cleanup. Freshdesk extraction can hydrate archived histories or use a complete ID inventory to bypass list ceilings. Connect Freshdesk through the admin source picker, map and validate private ticket-ID CSV files, and require explicit inventory confirmation before extracting ticket history. Mapping or mode changes require a fresh confirmation; server fingerprints reject stale approvals.

Poll lightweight source-file summaries and load preview/mapping details for only the selected file, reducing API and browser memory during large migration setup.

Retain original message state, transport and author facts as inert provenance, visible in English/Arabic message disclosures and preserved on ticket splits. Keep source-only author names without assigning a local identity or counting unresolved customer messages as staff responses. Retain unsent source replies as private history rather than sending them.

Preserve Zoho profile history and source-only native fields without applying source roles, lifecycle flags or SLA references as local behavior. Use stable JSON serialization for compound Zoho/Freshdesk fields so response-key reordering does not create false updates.

Read Zoho's module field catalogs for mapper definitions and hydrated custom values, with bounded resume checkpoints. Keep exact booleans, dates and declared selections; preserve unsupported semantics and precision-sensitive values as reviewable source text.

Preserve full historical Zoho satisfaction feedback and original time/sentiment provenance, with bounded resume checkpoints and reviewed normalization. Unknown sentiments remain unscored.

Include files uploaded directly to Zoho tickets alongside thread/comment files, retaining source visibility, creation dates and source-only creator names. Refresh refused downloads through the checked source page without inventing metadata endpoints.

Bound extraction cursor bookkeeping independently of history size and detect continuation loops across worker deferrals using atomically persisted cycle state.

Preserve Zoho's bilingual knowledge taxonomy and nested section relationships, including inactive source states. Prepare inherited readership through resumable ancestry checks so source restrictions cannot become public access.

Retain explicit article attachment references in normalized bundles, reject missing archive members and prevent article loading from silently discarding declared source files while asset preparation is completed.

Add durable private article-asset identities, resumable preparation and sealed-manifest loading. Check source hashes before image conversion or file scanning, authorize downloads against the current article and live readership, and clean abandoned importing objects through retention and the outbox. Keep unavailable files visible in the import log and localized article content.

Preserve separate working and published article content and files, so importing a published article with a newer draft cannot expose unpublished edits. Keep full source descriptions and unknown publication dates without inventing a migration timestamp.

Retain source file view/download links as rewrite aliases while keeping authenticated Zoho downloads bound to the exact native resource. Reject ambiguous aliases and distinguish empty Zoho collections from missing detail responses.

Reconcile paged Zoho article files against their pinned working snapshot, checkpoint each file and stop on incomplete or changed metadata. Expose inferred list envelopes in the import log and dry-run review in English and Arabic.

Read recoverable Zoho recycle-bin taxonomy and article translations without restoring source data. Keep deleted copies private, preserve language relationships across active/deleted siblings, and refuse shifted or repeated pagination.

Keep translations on their existing imported article when a later language changes the source anchor. Resolve the destination through validated same-account sibling ownership, with matching dry-run checks and protection for unowned manual content.

Connect Zoho's normalized readers to the API and worker runtime, validate its export profile and read grants, and reuse access tokens through the run's encrypted credential blob. Keep internal token snapshots outside public credential input and preserve terminal credential purge after worker restarts or late refreshes.

Add English and Arabic Zoho connection fields with a regional data-center selector, exact organization IDs and masked OAuth credentials. Explain the export permissions and connection-check credit cost, and clear secrets after connecting.

Discover Zoho archives automatically across enabled and disabled departments for full and delta imports. Retain reviewed ticket-ID inventories as an explicit fallback, and refuse archive depth limits or shifted pages before loading incomplete history.

Preserve original Zoho email Message-IDs and separate sent dates, show source subject/date/return-path metadata in the existing EN/AR disclosure, and expose unavailable or unparseable source mail as reviewed warnings without sending anything.

Resolve relative article images using a validated per-copy asset origin, retain native file authority for matching aliases, and keep vendor credentials off remote image requests. Report inaccessible gallery images explicitly while preserving API permission failures and retryable source errors.

Rewrite prepared article image/file references through the existing sanitizer using only explicit paths of the same brand.
