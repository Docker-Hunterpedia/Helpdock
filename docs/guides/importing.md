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

The remaining mapping, scope, dry-run, load approval and control endpoints are
pending. Imports preserve original history through the direct writer and must not
send customer communications or start SLA timers. The completed cutover runbook
and vendor-specific acceptance evidence will be added with those workflows.
