# M8 API, webhooks, reports

Status: in progress
Started: 2026-10-05
Owner: @Docker-Hunterpedia

## Scope

Full deliverable list and specs: [PRD §4 · M8 API, webhooks, reports](../planning/PRD.md#m8-api-webhooks-reports).
Depends on M1 and M3, both shipped. Runs in parallel with M7.

## Deliverables

| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M8-01 | Tenant API keys | | planned |
| M8-02 | REST v1 | | planned |
| M8-03 | Outbound webhooks | | planned |
| M8-04 | Reports | | planned |
| M8-05 | System page | | planned |
| M8-06 | CSAT delivery wired on close for email, widget, Telegram | | planned |
| M8-07 | Brand deletion with 30-day grace and full purge (rows, S3 prefix, Redis keys, Caddy domain | | planned |

## Exit criteria

Copied from the PRD, ticked as they are met.

- [ ] A ticket created via the API triggers a signed `ticket.created` webhook received by a test endpoint.
- [ ] Reports match seeded data in an integration test.

## Open questions

- None yet.

## Pull requests

- None yet.
