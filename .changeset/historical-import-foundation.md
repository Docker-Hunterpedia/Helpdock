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
