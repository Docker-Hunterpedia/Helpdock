---
"@helpdock/api": minor
---

Prepare tenant-isolated import staging, historical ticket and attachment provenance, and validated normalized records for support-platform migrations. Restrict importer HTTP requests to explicitly allowed vendor hosts on every redirect hop.

Preserve bilingual imported knowledge versions and source descriptions, and raise help-center article titles to 500 characters. Reject malformed UTF-8 rather than silently altering imported text.

Process shared historical attachments without live events or AI transcription, and preserve imported author names and file origin when splitting tickets.

Commit historical ticket/thread progress atomically, retain changed source subjects on delta, and refuse deleted migration targets rather than reporting them as imported.

Invalidate previous dry-run approval when import mappings change, and refuse mapping edits during active or terminal import phases.

Preserve source ticket audit events with their original dates, actors and changes as inert imported activity, including idempotent repeat and delta checkpoints.

Retain final vendor watermarks for delta extraction and preserve CC relationships supplied as source user IDs. Reconcile import-owned CCs without removing manual participants, and validate required fields for imported email-only contacts.

Add initial Zendesk core exports and resumable contact hydration. Preserve native profile notes, descriptions, dates and identity provenance without granting verification or staff access from vendor data.

Extract paged Zendesk public replies, private notes and attachment references with original authors/dates and resumable thread checkpoints.

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
