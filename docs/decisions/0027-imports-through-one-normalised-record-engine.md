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
