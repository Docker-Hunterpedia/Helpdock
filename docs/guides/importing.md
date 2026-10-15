# Importing historical support data

M11 is under development. The backend has a partial Zendesk connector, mapping,
dry-run, preview and approval APIs. The bilingual wizard, manual mapper, additional
connectors and complete vendor/completeness acceptance are unfinished. Do not treat
this checkpoint as a completed migration product. Track scope and evidence in
[the milestone plan](../in-development/M11-sso-and-migration.md).

## Staff API

All routes below use an authenticated staff session and require `brand:manage`.
Creating staff through agent mappings additionally requires `staff:manage`.
Inputs and outputs use Zod and the generated OpenAPI schemas. These routes are
separate from the scoped public REST API.

| Method | Path below `/api/brands/:brandId/imports` | Behavior |
|---|---|---|
| GET | `/` | Up to 100 newest runs, newest first |
| POST | `/` | Create a draft with `source`, `mode` and a completed same-brand `parentRunId` for delta mode |
| GET | `/:runId` | Run state and extracted/loaded/skipped counters; no worker or credential internals |
| PUT | `/:runId/connection` | Test and encrypt credentials; bind the verified account |
| PUT | `/:runId/scope` | Select entity types and report-backfill scope before extraction |
| POST | `/:runId/extract` | Start extraction through the transactional outbox |
| GET/PUT | `/:runId/mappings` | Read/replace confirmed mappings and their input fingerprint |
| POST | `/:runId/dry-run` | Start resumable validation |
| GET | `/:runId/dry-run` | Read counters, issue samples and a completed report's review token |
| GET | `/:runId/preview/ticket` | Read paged ticket history |
| GET | `/:runId/preview/contact` | Read source details and the proposed identity/company match |
| GET | `/:runId/preview/samples` | Select up to three ticket and three contact source IDs |
| POST | `/:runId/start` | Approve the reviewed report and queue loading |
| POST | `/:runId/pause` | Revoke an active claim and retain credentials |
| POST | `/:runId/resume` | Resume extraction, validation, loading or finishing through the outbox |
| POST | `/:runId/cancel` | Stop further work and purge credentials |

## Connect and map

Only the Zendesk factory is registered. A connection body contains `credentials`
and `downloadHosts`. OAuth credentials use `auth: "oauth"`, `subdomain` and
`accessToken`; labelled legacy API-token credentials use `auth: "api_token"`,
`subdomain`, `email` and `apiToken`.

`downloadHosts` allows up to 32 exact lowercase hostnames, without schemes, ports
or wildcards. Every attachment redirect must stay within these approved hosts and
pass DNS/IP checks. The account API host comes from the validated subdomain. UI
confirmation of external download hosts is still pending.

A successful connection returns the verified account and moves the run to
`connecting`. A refused test leaves the draft unchanged. Credentials are encrypted
under `APP_MASTER_KEY` and never returned after saving; reads expose only
`hasCredentials`. Delta connection refuses an account different from its completed
parent. Extraction starts once from `connecting` and ends at `awaiting_mapping`.

Scope accepts nonempty, unique `entities` and `rebuildAllReports`. It is frozen
once extraction starts. Date-range filtering, paged run listing, automatic mapping
proposals and the manual mapper are unfinished.

PUT mappings accepts `{ "mappings": [...] }` using the shared schemas' status,
priority, channel, group, agent, field and tag target shapes. Each kind/source-value
pair is unique. Saving from `awaiting_mapping` or `ready` clears the old report;
edits during extraction or loading are refused. The returned input fingerprint
covers source account/options, staged metadata and confirmed mappings. It is not
an approval or a substitute for validation.

## Validate and inspect

1. Send `POST /api/brands/{brandId}/imports/{runId}/dry-run` with `{}` or
   `{ "defaultCallingCode": "963" }`. Duplicate starts or unavailable phases
   return 409; malformed settings return 400.
2. Poll `GET /api/brands/{brandId}/imports/{runId}/dry-run`. A report that does
   not exist returns 404. Validation returns to `awaiting_mapping` for review.
3. Inspect previews and correct blocking errors. Rerun validation after edits.
   Pause/resume retains committed progress; recovery also handles abandoned claims.

The report exposes checked counters, full error/warning totals and at most 500
issue samples. Totals can exceed displayed samples. `refusedPhones` counts phone
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
The calling code used by validation is also used by loading. Later batches retain
their approval receipt while normal loader checks still validate live targets.

Loading uses the direct historical writer. It must not send customer messages,
run customer automation or start SLA timers. Cancel does not delete history
already imported. Credentials are purged on terminal completion, cancellation or
failure. Whole-run knowledge provisioning/capacity and completeness/retention
reporting, final vendor datasets and worker-termination/browser acceptance remain
unfinished, along with the bilingual review UI and cutover runbook.
