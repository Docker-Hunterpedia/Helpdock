# 0045 Import provenance ledger and undo (amends 0027)

Status: proposed
Date: 2026-10-20

Amends [0027](0027-imports-through-one-normalised-record-engine.md).

## Context

[ADR 0027](0027-imports-through-one-normalised-record-engine.md) made imports quiet,
idempotent and resumable, but not reversible: "cancellation is not rollback", and
the importing guide's only way back from an import into the wrong brand or with the
wrong mapping is a full restore. `import_external_ids` records what a source object
became, with `imported_at` and `payload_hash`, but not which run wrote it, and not
whether the object was **created** by the import or **matched** to something that
already existed (a contact attached by email, an existing tag). Without that, an
undo cannot tell what is safe to delete. Credentials are purged when a run ends, so
every "Bring over changes" delta needs them pasted again.
[M16 More importers and undo](../in-development/M16-more-importers-and-undo.md) adds
undo and a smoother cutover loop.

## Decision

1. **A provenance ledger.** A new tenant table, `import_created_objects`
   (`brand_id`, `run_id`, `entity`, `helpdock_id`, `disposition` created or matched,
   `department_id` for tickets), under `FORCE`d RLS. `import_external_ids` gains
   `first_run_id` and `disposition`. The writer records every object it creates and
   every match it makes through one helper, `recordCreated()`; the
   `check-import-writer` script fails the build when the writer inserts into a
   tracked table without it.
2. **Undo works from the ledger, not from staging.** An undo plan, computed
   read-only, lists what would be removed and what would be kept, with a reason for
   each kept object, and carries a plan token. The undo job runs through the outbox,
   claim-fenced and resumable in batches, deletes in reverse load order (including
   S3 objects and search tokens), rebuilds report rollups and sends nothing.
3. **Touched tickets are kept.** A ticket is kept when anything not part of the
   import happened to it after `imported_at`: a live message, staff, rule, api or AI
   activity, a merge, split or link, a time entry, a live CSAT response, a non-import
   attachment. Contacts, accounts, tags, fields, invitations and articles are removed
   only when the run created them and nothing else depends on them. The rules land as
   DOMAIN-RULES §2.9 (number provisional).
4. **Kept tickets stay linked.** Their external ids remain, so a later import of the
   same source updates them rather than creating duplicates.
5. **Deltas form a chain.** Undoing a full run whose deltas remain requires undoing
   them first, or an explicit cascade.
6. **Legacy runs** (before the ledger) are backfilled for tickets, their messages and
   attachments, and articles only, and can be undone only as a whole source chain.
   Their contacts, companies and tags are not undoable, because creation and match
   cannot be told apart.
7. **Retained connections.** Credentials are still purged at completion by default.
   An opt-in keeps them, encrypted, for up to 30 days for "Bring over changes", purged
   by a sweep and on Undo, Cancel or Finish. A refused credential mid-run pauses the
   run with `needs_credentials`, and resuming accepts only credentials for the same
   source account.
8. The ledger lives as long as the run is undoable: until the run is undone or the
   brand is deleted.

## Consequences

- An admin can reverse a mistaken import without a restore, and without losing work
  done since on the tickets that matter.
- Every create path in the writer carries one more call, enforced by a build check.
- The ledger costs one row per created object, kept indefinitely while the run is
  undoable.
- Keeping credentials, when chosen, widens exposure for up to 30 days; it is opt-in,
  encrypted, visible on the System page and swept.

## Alternatives considered

- **Undo from the staging tables.** Staging is purged after 30 days, and does not
  record matches.
- **Unlink kept tickets from their source.** A later import would then bring a second
  copy of each.
- **No undo; document restore.** A full restore also discards every other change made
  since, across all brands.
- **A narrow "touched" rule (a reply only).** Would delete tickets a rule or an agent
  had already re-routed or tagged.
