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
