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
| M8-01 | Tenant API keys | | built, in review |
| M8-02 | REST v1 | | built, in review |
| M8-03 | Outbound webhooks | | built, in review |
| M8-04 | Reports | | planned |
| M8-05 | System page | | planned |
| M8-06 | CSAT delivery wired on close for email, widget, Telegram | | planned |
| M8-07 | Brand deletion with 30-day grace and full purge (rows, S3 prefix, Redis keys, Caddy domain | | planned |

## Exit criteria

Copied from the PRD, ticked as they are met.

- [x] A ticket created via the API triggers a signed `ticket.created` webhook received by a test endpoint (`apps/api/src/api-v1/api-v1.integration.test.ts`).
- [ ] Reports match seeded data in an integration test.

## Open questions

- REQUIREMENTS §4.12 lists the webhook events; the M8 brief also named `ticket.status_changed` and `message.created`. The shipped list follows REQUIREMENTS (`ticket.updated` carries status changes, `ticket.replied` every thread message but notes). Adding the other two is an alias each in `webhooks/webhook-events.ts` if they are wanted.
- An API key's public message is `author_type = system` and is not emailed (only an agent's public reply is). Whether an integration may speak as an agent or as the customer is open.

## M8-01 Tenant API keys

- Table `api_keys` (brand): name, `prefix` (first 12 characters), `key_hash` (SHA-256, unique across the install), `scopes text[]`, `rate_limit_per_minute` (default 600), `created_by`, `last_used_at`, `revoked_at`/`revoked_by`. In `TENANT_TABLES` and the RLS negative suite.
- Admin routes, `brand:manage`: `GET`/`POST /api/brands/:brandId/api-keys`, `DELETE …/:keyId` (revoke). The key is in the create answer only. `api_key.created` and `api_key.revoked` audit rows carry the prefix and scopes, never the key.
- `ApiKeyPrincipalResolver` (`api-keys/api-key-principal-resolver.ts`) wraps the session resolver in `bootstrap.ts`: an `hd_live_` bearer is hashed and looked up in an all-brands system transaction (`tenant/all-brands.ts`, shared with inbound parse), throttled per key in Redis (sliding window, bucket `api-key`), and becomes `{ type: 'apikey', id, brandId, scopes }`. `last_used_at` is written at most once a minute.
- The six scopes are permissions of their own (`auth/permissions.ts`); no role holds one. An API key's tenant context is its brand with every department ([ADR 0017](../decisions/0017-api-scopes-and-openapi-from-zod.md)).

## M8-02 REST v1

- Controllers in `apps/api/src/api-v1/` over the admin's own services: `TicketsService` (create on the `api` channel, read, update, soft delete, messages), `ContactsService` (new `upsert`, by `externalId` then by identifier), `HelpCenterSearch` and `readArticle` with the public audience, `WebhooksService`.
- `Idempotency-Key` on the creating `POST`s (`idempotency.interceptor.ts`), stored in `api_idempotency_keys` (brand) in the request's transaction for 24 hours: same request replays with `Idempotent-Replayed: true`, a different one is 422 (`conflict`), a concurrent one waits.
- `/api/docs` (page) and `/api/docs/openapi.json` (OpenAPI 3.1), generated with `z.toJSONSchema` from the route schemas in `openapi.ts`; `openapi.test.ts` fails when a v1 route is missing from it.
- `contact.created` is now an outbox event, written by `insertContact` for every path that creates a contact; `csat.received` is written when a customer rates (the rules engine already listened for it).
- Guide: [docs/guides/api.md](../guides/api.md).

## M8-03 Outbound webhooks

- Tables `webhooks` (brand; `secret` encrypted under `APP_MASTER_KEY`, `consecutive_failures`, `disabled_reason`) and `webhook_deliveries` (brand; frozen payload, status, attempts, last status code, 1 KB excerpt, duration, error, `replay_of`; unique `(webhook_id, event_id)` unless a replay).
- Events: `ticket.created`, `ticket.updated` (also on reopen), `ticket.replied` (never notes), `ticket.closed`, `contact.created`, `csat.received`, `article.published`. The `webhooks` subscriber writes one delivery per endpoint plus a `webhook.delivery_requested` outbox row; that handler adds `webhook.deliver` (queue `webhooks`, job id `webhook.deliver.<deliveryId>`) once the row has committed.
- `webhook.deliver` signs `X-Helpdock-Signature: t=<ts>,v1=<hex HMAC-SHA256 of "ts.body">`, POSTs through `safeFetch` with the `webhook` policy, `maxRedirects: 0` and `OUTBOUND_ALLOW_CIDRS`; 8 attempts, exponential from 30 s; the endpoint is switched off after 10 failed deliveries in a row.
- Admin routes (`brand:manage`) at `/api/brands/:brandId/webhooks` and API routes (`webhooks:manage`) at `/api/v1/webhooks`: CRUD, rotate secret, delivery log, replay.
- Guide: [docs/guides/webhooks.md](../guides/webhooks.md).

## Migrations

- `0037_api_keys_and_webhooks.sql`: `api_keys`, `api_idempotency_keys`, `webhooks`, `webhook_deliveries`, the `webhook_delivery_status` enum, and their RLS policies.

## Pull requests

- None yet.
