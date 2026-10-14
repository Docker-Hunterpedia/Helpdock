# Importing historical support data

M11 is under development. The SSO track is complete; the import wizard, dry-run
approval, manual mapper and additional vendor connectors are still being built.
Do not use the current backend checkpoint as a completed migration workflow.
Track implementation and acceptance in [the milestone plan](../in-development/M11-sso-and-migration.md).

## Current staff API checkpoint

These routes use the authenticated staff session and require `brand:manage`.
They are separate from the scoped public REST API. Requests and responses are
validated with Zod and included in the generated OpenAPI document.

| Method | Path below `/api/brands/:brandId/imports` | Behavior |
|---|---|---|
| GET | `/` | Up to 100 newest runs, newest first |
| POST | `/` | Create a draft using `source`, `mode`, and a completed same-brand `parentRunId` for delta mode |
| GET | `/:runId` | Public run state and extracted/loaded/skipped counters |
| PUT | `/:runId/connection` | Test and encrypt credentials; bind the verified account |
| POST | `/:runId/extract` | Start extraction through a transactional outbox event |
| PUT | `/:runId/scope` | Select unique entity types and whether to rebuild all report history before extraction |
| POST | `/:runId/pause` | Revoke an active worker claim and retain credentials |
| POST | `/:runId/resume` | Resume extraction/loading/finishing with a transactional work request |
| POST | `/:runId/cancel` | Stop further work and purge credentials |
| GET | `/:runId/mappings` | Confirmed mappings and their current input fingerprint |
| PUT | `/:runId/mappings` | Replace confirmed mappings and invalidate an older dry-run report |

Only the Zendesk factory is currently registered. A connection request has
`credentials` and `downloadHosts`. OAuth credentials contain `auth: "oauth"`,
`subdomain` and `accessToken`. Labelled legacy API-token credentials contain
`auth: "api_token"`, `subdomain`, `email` and `apiToken`.

`downloadHosts` is an explicit list of up to 32 exact lowercase hostnames, without
schemes, ports or wildcards. The account API host comes from the validated
subdomain. Every attachment redirect must stay inside the approved host list and
pass DNS/IP checks. The UI confirmation of external download hosts is pending.

A successful connection returns the verified account and moves the run to
`connecting`. A failed test leaves the draft unchanged. Credentials are encrypted
under `APP_MASTER_KEY` and never returned after save; reads expose only
`hasCredentials`. Delta connection refuses an account different from its completed
parent. Extraction can start once from `connecting`, commits its queue request
with its state change, and eventually stops at `awaiting_mapping`.

Scope updates accept nonempty, unique `entities` and `rebuildAllReports`; saved
scope appears in run reads. Connection updates preserve it. Scope is frozen once
extraction starts. Date-range filtering, automatic mapping proposals, dry-run and load approval are
pending. Mapping confirmation is available after extraction; automatic mapping
proposals and the read-only dry-run validator are still pending. Resume of a paused dry-run is refused until its consumer is implemented.
Cancel does not remove history already imported. Imports preserve original history through the direct writer and must not
send customer communications or start SLA timers. The completed cutover runbook
and vendor-specific acceptance evidence will be added with those workflows.

## Mapping confirmation checkpoint

PUT mappings takes `{ "mappings": [...] }`, with the documented status, priority,
channel, group, agent, field and tag target shapes from the shared import schemas.
Each kind/source-value pair is unique. Invited-agent mappings additionally require
`staff:manage`. Saving from awaiting_mapping or ready returns to awaiting_mapping
and clears the previous dry-run report. Edits during extraction/loading are refused.

The returned fingerprint covers the run's source account/options, staged record
identifiers/hashes/parents/status and confirmed mappings. It is a paged metadata
snapshot, not a validation result or authorization to start loading. It does not
fetch attachments or create contacts, tickets, staff or fields. The pending dry-run
validator must verify actual payload integrity, relationships, destination targets
and completeness before approving a report.

The read-only preflight foundation checks staged IDs/hashes/parents and required
source relationships. Prior identities may satisfy delta references only within
the same brand, vendor and verified account. Corrupted or missing references and
mismatched attachment parents/metadata block validation. The complete dry-run
consumer, destination checks, availability report and UI remain under development;
these structural checks do not authorize loading.

Staged category, section and translation cycles are structural blockers, including
cycles reached through an otherwise valid prefix. Live destination hierarchy and
complete dry-run approval are still pending.
