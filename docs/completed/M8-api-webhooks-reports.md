# M8 API, webhooks, reports

Status: shipped
Started: 2026-10-05
Shipped: 2026-10-07
Owner: @Docker-Hunterpedia

## Scope

Integrations and operations. A brand issues scoped API keys and speaks to
`/api/v1` (tickets and messages, contacts, articles, webhooks) with
idempotency keys and an OpenAPI document generated from the Zod route
schemas. Outbound webhooks carry seven events, signed with HMAC-SHA256,
delivered through the SSRF-safe client with retries, a delivery log and
replay. Reports roll up tickets, SLA, CSAT, agents, busiest hours, searches
and AI into daily tables and a screen with CSV export. The System page shows
version and migrations, queues with Bull Board, channels, storage, LLM spend
and product metrics. CSAT surveys go out on close by email, in the widget and
on Telegram. A brand can be deleted with a 30-day grace and a full purge.

Full deliverable list and specs: [PRD §4 · M8 API, webhooks, reports](../planning/PRD.md#m8-api-webhooks-reports).
Depends on M1 and M3, both shipped. Ran in parallel with
[M6 Telegram](M6-telegram.md), [M7 AI](M7-ai.md) and M9 Hardening; M8-05's
Channels card reads M6's bot status, M8-06's Telegram survey rides M6's
notice job, and M7 binds the AI seam M8-04 and M8-05 left open.

Built from the design canvas artboards `Admin/Developers-ApiKeys`,
`Admin/Developers-Webhooks`, `Admin/Reports`, `Admin/System-1.0`,
`Admin/Brand-Danger`, `Email/CSAT-EN-AR`, `Widget/CSAT-EN`, `Widget/CSAT-AR`
and panels 5 and 6 of `Telegram/Chat-EN` and `Telegram/Chat-AR`. The
operator's views are the [API](../guides/api.md),
[webhooks](../guides/webhooks.md), [reports](../guides/reports.md) and
[operations](../guides/operations.md) guides.

## Deliverables

| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M8-01 | Tenant API keys: `hd_live_*` shown once, SHA-256 stored, scopes, per-key throttle, last used, revoke | | shipped (#147): [Tenant API keys](#m8-01-tenant-api-keys), [Developers page](#m8-01-m8-03-developers-page) |
| M8-02 | REST v1: tickets CRUD + messages, contacts upsert/search, articles search/get, webhooks CRUD; idempotency keys; OpenAPI 3.1 at `/api/docs` | | shipped (#147): [REST v1](#m8-02-rest-v1) |
| M8-03 | Outbound webhooks: events, HMAC-SHA256 signature, retries with backoff, delivery log, replay | | shipped (#147): [Outbound webhooks](#m8-03-outbound-webhooks), [Developers page](#m8-01-m8-03-developers-page) |
| M8-04 | Reports: volume, times, SLA, backlog, CSAT, workload, busiest hours, searches, AI deflection and cost; CSV export; `stats.rollup` cron | | shipped (#147): [Reports](#m8-04-reports) |
| M8-05 | System page: version, migrations, queue health with Bull Board, channel status, storage usage, LLM spend | | shipped (#147): [System page](#m8-05-system-page) |
| M8-06 | CSAT delivery wired on close for email, widget, Telegram | | shipped (#147): [CSAT delivery](#m8-06-csat-delivery) |
| M8-07 | Brand deletion with 30-day grace and full purge (rows, S3 prefix, Redis keys, Caddy domain); product metrics on the System page | | shipped (#147): [Brand deletion and product metrics](#m8-07-brand-deletion-and-product-metrics) |

## Exit criteria

Copied from the PRD. Both are met. The integration tests run against real
Postgres and Redis (Testcontainers) in CI's `integration` job.

- [x] **A ticket created via the API triggers a signed `ticket.created`
      webhook received by a test endpoint.**
      `apps/api/src/api-v1/api-v1.integration.test.ts` › "outbound webhooks
      (M8-03)" › "a ticket created through the API is delivered as a signed
      ticket.created webhook". An API key with `tickets:write` and
      `webhooks:manage` registers an endpoint through `/api/v1/webhooks` and
      creates a ticket through `/api/v1/tickets`; the worker runs the one
      `webhook.deliver` job to a local test endpoint, and the test verifies
      `X-Helpdock-Signature` with the endpoint's secret, reads the
      `ticket.created` envelope naming the ticket, finds the delivery
      `succeeded` in the log and replays it. In a browser against the real
      api:
      `apps/admin/e2e/api/developers.api.spec.ts` (a created key answers
      `/api/v1` and is refused once revoked; an endpoint added and pinged
      through the worker).
- [x] **Reports match seeded data in an integration test.**
      `apps/api/src/reports/reports.integration.test.ts` › "the summary
      matches the seeded tickets": volume by day, channel, priority and status
      with spam, merged and deleted tickets left out; the stacked breakdowns;
      first-response and resolution percentiles less paused time; SLA
      compliance from the initial clocks; the backlog per day; CSAT; each
      agent's work; busiest hours; top and zero-result searches; AI cost from
      `ai_calls`; and never another brand's tickets.

## Effort

| | |
|---|---|
| Estimated | 4–5 weeks (PRD status board) |
| Started | 2026-10-05 |
| Shipped | 2026-10-07 |
| Actual | 2 days, in parallel with M6, M7 and M9 |

AI coding agents built API keys, REST v1 and webhooks first, then reports and
the System page, then CSAT delivery and brand deletion, then the screens. The
branches were merged onto one integration branch, which the maintainer
reviewed and merged as one pull request with M6, M7 and the M9 work.

## Migrations

- `0037_report_rollups`: `report_daily`, `report_agent_daily`
  (department-scoped), `report_search_daily` and `report_help_center_daily`
  (brand-scoped), the rollup tables of M8-04.
- `0039_api_keys_and_webhooks`: `api_keys`, `api_idempotency_keys`,
  `webhooks`, `webhook_deliveries`, the `webhook_delivery_status` enum, and
  their RLS policies.
- `0043_csat_delivery`: `csat_responses.rated_via` (`csat_answer_channel`:
  `link`, `widget`, `telegram`; earlier answers backfilled `link`) and
  `skipped_at`; `email_delivery_kind` gains `csat`;
  `email_deliveries.csat_response_id` with a unique partial index. No new
  tenant table.
- `0044_report_daily_assignee`: `report_daily.assignee_id`, the ticket's
  assignee in the rollup's grain, and `report_daily.rollup_version` (existing
  rows 1) (M8-04).

All eight new tables are tenant tables, in `TENANT_TABLES` and the RLS
negative suite, which M8-07 also made prove that a purge leaves no row.

## Gaps and follow-ups

Written down and carried forward. None of them blocks M9.

| Gap | Why it was accepted | Where it is written down |
|---|---|---|
| **An API key's public message is a system message** | It is `author_type = system` and is not emailed (only an agent's public reply is). Whether an integration may speak as an agent or as the customer is an open question. | [REST v1](#m8-02-rest-v1) |
| **`ticket.status_changed` and `message.created` are not webhook events** | The shipped list follows REQUIREMENTS §4.12: `ticket.updated` carries status changes and `ticket.replied` every thread message but notes. Each is an alias in `webhooks/webhook-events.ts` if wanted. | [Outbound webhooks](#m8-03-outbound-webhooks) |
| **Reports differ from `Admin/Reports`** | Response and resolution times are the period's median and p90, not a line per day; CSAT has no "% of surveys answered" or comment count; the heatmap runs Monday to Sunday (brands have no week-start setting). | [Reports](#m8-04-reports) |
| **The Developers page differs from its artboards** | The retry schedule and the headers are the real ones (30 s doubling to 32 min, a 15 s timeout, `X-Helpdock-Signature: t=…,v1=…`) rather than the artboard's illustration; a key has no description line, because keys have no description field; the delivery log's caption is the delivery time without the ticket reference, which the log does not carry; the attempt chips show each earlier attempt as failed, because only the last attempt's answer is stored. | [Developers page](#m8-01-m8-03-developers-page) |
| **The System page differs from `Admin/System-1.0`** | Storage shows Postgres as one install-wide figure, not per brand (a brand's share would mean reading every row); Version has no image name, and the migration list has names without times (Drizzle records none); Channels show no brand name or Widget rows; the queue button is in the header only. | [System page](#m8-05-system-page), [operations](../guides/operations.md#where-the-numbers-come-from) |
| **Brand deletion asks for the ticket prefix, not the brand's name** | `Admin/Brand-Danger` asks for the name; the api checks the prefix (`confirmPrefix`), which is unique across the install, so the screen asks for that ("Type HD to confirm"). | [Brand deletion](#m8-07-brand-deletion-and-product-metrics) |
| **Feedback settings have no delay or channel choice** | `AdminTicketingFeedback` has one toggle, so the survey goes out at once on the ticket's own channel. The tab says so. | [CSAT delivery](#m8-06-csat-delivery) |
| **Storage is measured at most every six hours** | `stats.rollup` lists a brand's prefix only when its reading is older than that, so the System page's figure can lag a large upload. | [System page](#m8-05-system-page) |
| **Only the last webhook attempt's answer is stored** | The delivery keeps one status code and excerpt; earlier attempts are counted, not recorded. | [Developers page](#m8-01-m8-03-developers-page) |

## Decisions settled

| Decision | Where |
|---|---|
| Bull Board is served by the api behind a one-use pass and its own session, amending ADR 0004 | [ADR 0017](../decisions/0017-bull-board-behind-a-one-use-pass.md) |
| API scopes are permissions of their own that no role holds, and the OpenAPI document is generated from the Zod route schemas | [ADR 0019](../decisions/0019-api-scopes-and-openapi-from-zod.md) |
| The webhook events are REQUIREMENTS §4.12's seven; status changes ride `ticket.updated` | [Outbound webhooks](#m8-03-outbound-webhooks) |
| The report charts are plain SVG components; no charting dependency joins the ARCHITECTURE §1 stack | [Reports](#m8-04-reports) |
| A webhook endpoint's name is resolved and checked when it is saved, not only when it is called; plain `http` only inside `OUTBOUND_ALLOW_CIDRS` | [Developers page](#m8-01-m8-03-developers-page) |
| A deleted brand's row stays `deleted`, so its ticket prefix stays reserved | [Brand deletion](#m8-07-brand-deletion-and-product-metrics) |

## External dependencies

None. Everything is tested against local stand-ins.

## What an operator can do with this milestone

Create scoped API keys on Admin › Developers and build against `/api/v1`
with the documentation at `/api/docs`; add webhook endpoints, read every
delivery with the request that was sent, replay or ping one, and rotate the
secret. Read Reports over any range, by department, channel and agent, and
export each as CSV. Read the System page for version, migrations, queues (and
open Bull Board), every channel's health, storage per brand, LLM spend and the
product metrics. Customers are asked to rate a closed ticket on the channel
they used. An install admin can schedule a brand for deletion, restore it
within 30 days, or let the purge remove every row, object, Redis key and
domain.

## M8-01 Tenant API keys

- Table `api_keys` (brand): name, `prefix` (first 12 characters), `key_hash` (SHA-256, unique across the install), `scopes text[]`, `rate_limit_per_minute` (default 600), `created_by`, `last_used_at`, `revoked_at`/`revoked_by`. In `TENANT_TABLES` and the RLS negative suite.
- Admin routes, `brand:manage`: `GET`/`POST /api/brands/:brandId/api-keys`, `DELETE …/:keyId` (revoke). The key is in the create answer only. `api_key.created` and `api_key.revoked` audit rows carry the prefix and scopes, never the key.
- `ApiKeyPrincipalResolver` (`api-keys/api-key-principal-resolver.ts`) wraps the session resolver in `bootstrap.ts`: an `hd_live_` bearer is hashed and looked up in an all-brands system transaction (`tenant/all-brands.ts`, shared with inbound parse and Telegram), throttled per key in Redis (sliding window, bucket `api-key`), and becomes `{ type: 'apikey', id, brandId, scopes }`. `last_used_at` is written at most once a minute.
- The six scopes are permissions of their own (`auth/permissions.ts`); no role holds one. An API key's tenant context is its brand with every department ([ADR 0019](../decisions/0019-api-scopes-and-openapi-from-zod.md)).

## M8-02 REST v1

- Controllers in `apps/api/src/api-v1/` over the admin's own services: `TicketsService` (create on the `api` channel, read, update, soft delete, messages), `ContactsService` (new `upsert`, by `externalId` then by identifier), `HelpCenterSearch` and `readArticle` with the public audience, `WebhooksService`.
- `Idempotency-Key` on the creating `POST`s (`idempotency.interceptor.ts`), stored in `api_idempotency_keys` (brand) in the request's transaction for 24 hours: same request replays with `Idempotent-Replayed: true`, a different one is 422 (`conflict`), a concurrent one waits.
- `/api/docs` (page) and `/api/docs/openapi.json` (OpenAPI 3.1), generated with `z.toJSONSchema` from the route schemas in `openapi.ts`; `openapi.test.ts` fails when a v1 route is missing from it.
- A public message posted with an API key is `author_type = system`; it is shown to the customer but not emailed, as only an agent's public reply is.
- `contact.created` is an outbox event, written by `insertContact` for every path that creates a contact; `csat.received` is written when a customer rates (the rules engine already listened for it).
- Guide: [docs/guides/api.md](../guides/api.md).

## M8-03 Outbound webhooks

- Tables `webhooks` (brand; `secret` encrypted under `APP_MASTER_KEY`, `consecutive_failures`, `disabled_reason`) and `webhook_deliveries` (brand; frozen payload, status, attempts, last status code, 1 KB excerpt, duration, error, `replay_of`; unique `(webhook_id, event_id)` unless a replay).
- Events: `ticket.created`, `ticket.updated` (also on reopen), `ticket.replied` (never notes), `ticket.closed`, `contact.created`, `csat.received`, `article.published`. The `webhooks` subscriber writes one delivery per endpoint plus a `webhook.delivery_requested` outbox row; that handler adds `webhook.deliver` (queue `webhooks`, job id `webhook.deliver.<deliveryId>`) once the row has committed.
- `webhook.deliver` signs `X-Helpdock-Signature: t=<ts>,v1=<hex HMAC-SHA256 of "ts.body">`, POSTs through `safeFetch` with the `webhook` policy, `maxRedirects: 0` and `OUTBOUND_ALLOW_CIDRS`; 8 attempts, exponential from 30 s; the endpoint is switched off after 10 failed deliveries in a row.
- Admin routes (`brand:manage`) at `/api/brands/:brandId/webhooks` and API routes (`webhooks:manage`) at `/api/v1/webhooks`: CRUD, rotate secret, delivery log, replay.
- Guide: [docs/guides/webhooks.md](../guides/webhooks.md).

## Deliverable notes

### M8-04 Reports

- **Rollups** (migration `0037_report_rollups`): `report_daily` and
  `report_agent_daily` are department-scoped tenant tables, so a Team Leader's
  report is narrowed by the same policy as their ticket list;
  `report_search_daily` and `report_help_center_daily` are brand-scoped. All
  four are in `TENANT_TABLES` and the negative suite. Grain: brand, local day
  (brand time zone), department, channel and priority; durations are kept as
  sample arrays so medians and p90s are exact over any range.
- **Job:** `stats.rollup.schedule` (cron `7 * * * *`, `maintenance` queue)
  adds `stats.rollup` per active brand (job id
  `stats.rollup.<brandId>.<hour ms>`), which rebuilds the trailing 7 days, or
  backfills from the first ticket (at most 400 days) for a brand with no
  rollups, one transaction per 31 days (`apps/api/src/reports/rollup.job.ts`,
  `rollup.repository.ts`).
- **What counts:** spam, merged (status `excluded_from_reports`) and deleted
  tickets count nowhere. Times use the SLA clocks less `paused_total_ms`, and
  only `cycle = 0` unless `slaCountReopens` (both M3 gaps closed); tickets
  without clocks fall back to the first public staff reply and `closed_at`.
- **Routes:** `GET /api/brands/:brandId/reports` and
  `GET /api/brands/:brandId/reports/exports/:report` under the new
  `report:read` permission (Admin, Team Leader, Viewer). CSV cells starting
  with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'` (`csvCell` in
  `@helpdock/schemas`).
- **AI seam:** `AiUsageSource` (`apps/api/src/reports/ai-usage.ts`, token
  `AI_USAGE_SOURCE`, bound by `ReportsModule.forRoot({ aiUsage })`). M8 shipped
  `NoAiUsage`, which answers `{ available: false }` in reports,
  `{ configured: false }` for LLM spend and `null` for deflection; M7-01's
  `DbAiUsage` (`apps/api/src/ai/db-ai-usage.ts`) now binds it, reading
  `ai_calls` for cost and the `tickets` AI timestamps for deflection.
- **Screen** (artboard `Admin/Reports`, `apps/admin/src/screens/reports/`):
  date range, department and channel filters; four MetricTiles compared with
  the previous period from a second read; a ChartCard per report with "Table"
  and "Export CSV" (through `HttpTransport.requestBlob`, saved as
  `reportExportFileName`, in `@helpdock/schemas`); the two AI cards. The
  sidebar offers Reports to Admin, Team Leader and Viewer. No charting
  dependency is in the ARCHITECTURE §1 stack, so the charts are plain SVG
  components (`charts.tsx`): column, line with an end label, share rows and
  Heatmap, per DESIGN §9 (legend, direct labels, Table view, Tooltip naming
  the series). The adapter is `ReportsApi` (`apps/admin/src/reports/`), on
  the shared transport.
- **Closing the artboard gaps** (migration `0044_report_daily_assignee`):
  `report_daily` gains the ticket's assignee in its grain, so the summary
  carries volume per day by channel, priority and status (the last from the
  tickets, as the status totals are), SLA by priority (both clocks), and per
  agent the median first response and resolution, SLA met and CSAT average of
  the tickets assigned to them, with `unassignedOpen` and `agentChoices`. The
  query takes `agentId` (the ticket's assignee for ticket figures, the agent
  for workload). The screen stacks the volume columns per day (five series,
  the rest as "Other", legend, 2 px gaps, a Tooltip naming every series), adds
  "By priority" to SLA, the four columns and the Unassigned row to Agent
  workload, and the Agent filter. New export `volume_by_status`; the ticket
  exports gain `agent_id` and `agent`, and `agents` gains the per-agent
  figures and an unassigned row. Rows built before 0044 are
  `rollup_version` 1; `stats.rollup` compares the brand's rows in its 400-day
  backfill window with `REPORT_ROLLUP_VERSION` (2) and rebuilds the whole
  window once when any is older, so an upgraded install gets per-agent
  history without rewriting data in SQL (`reports.integration.test.ts`).
- **Where the screen still differs from the artboard:** response and
  resolution times are the period's median and p90, not a line per day; CSAT
  has no "% of surveys answered" or comment count. The heatmap runs Monday to
  Sunday (brands have no week-start setting).
- Tests: `reports-page.test.tsx`, `report-math.test.ts`, `volume-stack.test.ts`,
  `reports/api.test.ts`, `ui/usage-meter.test.tsx`; Playwright
  `e2e/reports.spec.ts` (en and ar, axe, the api failing, the stacked
  breakdowns and the Agent filter); `reports.integration.test.ts` checks the
  figures and exports against the seeded tickets.
- Guide: [reports](../guides/reports.md).

### M8-01, M8-03 Developers page

- **Screen:** `Admin/Developers` (`apps/admin/src/screens/admin/developers/`), from
  the artboards `Admin/Developers-ApiKeys` and `Admin/Developers-Webhooks`, with the
  nav item **Developers** (Lucide `Code`) after Channels, offered to Admins only.
  Tabs **API keys** (table, Create dialog, SecretReveal, Revoke confirm, empty
  state, curl and "How keys work" cards) and **Webhooks** (turned-off Banner,
  Endpoints table, the open endpoint with its signing secret and Rotate,
  DeliveryLog, delivery detail with Replay, retry schedule). The `developers`
  i18n namespace in `en` and `ar`. The adapter is `apps/admin/src/developers/`
  (`DevelopersApi`, mock and http).
- **Api additions for the screen** (all `brand:manage`):
  - `GET /api/brands/:brandId/webhooks` answers the overview: each endpoint
    with `createdByName`, `last24h` (finished and succeeded deliveries) and its
    newest delivery. `/api/v1/webhooks` keeps the plain list.
  - `POST …/webhooks/:webhookId/test`: a `ping` delivery through the
    `webhook.delivery_requested` outbox row and the `webhook.deliver` job, like
    any event; audited as `webhook.tested`. `ping` joins the delivery event enum
    (`webhookDeliveryEventSchema`), so it can appear in the v1 delivery log.
  - `GET …/webhooks/:webhookId/deliveries/:deliveryId`: the delivery with
    `request` (URL, body, and the headers of the last attempt). The headers come
    from one builder (`webhooks/webhook-request.ts`) that the job sends with too,
    and the job signs with the clock reading it records as
    `last_attempt_at`, so the signature shown is the one sent.
  - API keys answer `createdByName` and `revokedByName`.
  - Adding or changing an endpoint resolves its name first
    (`webhooks/webhook-destination.ts`): a blocked range is `400` with
    `error.webhooks = { reason: 'webhook-destination-blocked', address }`; plain
    `http` is `webhook-https-required` unless the address is in
    `OUTBOUND_ALLOW_CIDRS`. This applies to `/api/v1/webhooks` too.
  - `WEBHOOK_DELIVERY_ATTEMPTS`, `WEBHOOK_RETRY_BASE_MS` and `WEBHOOK_TIMEOUT_MS`
    in `@helpdock/schemas` describe the retry schedule the page draws; a test in
    `webhook-deliver.job.test.ts` holds them to the job's options.
- **Where the screen differs from the artboard, and why:** the retry schedule
  and the headers are the real ones (30 s doubling to 32 min, a 15 s timeout,
  `X-Helpdock-Signature: t=…,v1=…`) rather than the artboard's illustration; a
  key has no description line, because keys have no description field; the
  delivery log's caption is the delivery time without the ticket reference,
  which the log does not carry; the attempt chips show each earlier attempt as
  failed, because only the last attempt's answer is stored.
- **Tests:** unit (`format`, both adapters, `api-keys-tab`, `webhooks-tab`),
  Playwright `e2e/developers.spec.ts` (en and ar, axe) and
  `e2e/api/developers.api.spec.ts` (a created key answers `/api/v1` and is
  refused once revoked; an endpoint refused for a private address and for
  `http`, then added and pinged through the worker). Api: `webhooks.service`,
  `webhook-destination`, `error-response` and `api-v1.integration.test.ts`
  (overview, ping, delivery detail, refusals).
- Guides: [API keys](../guides/api.md#api-keys),
  [the Webhooks page](../guides/webhooks.md#the-developers--webhooks-page).

### M8-05 System page

- **Channels:** every brand's mailboxes and Telegram bots, through M6's
  reader (`apps/api/src/channels/channel-status.ts`, bound to
  `CHANNEL_STATUS`).
- **Storage:** measured per brand by `stats.rollup` when the reading is over 6
  hours old (`S3BrandObjects.usage`, prefix `brands/<id>/`), kept in the Redis
  hash `hd:storage:usage`, shown in total and per brand.
- **LLM spend:** `AiUsageSource.installSpend`, per brand (`brands`, each
  against its own monthly budget) and in total, from M7-01's `DbAiUsage`;
  "not configured" until the install has a default provider and model.
- **Migrations and Postgres:** the api replica names the migrations it finds
  recorded at boot (`MigrationResult.recorded`, newest first) beside the count;
  `pg_database_size` gives the database's size, install-wide.
- **Bull Board** at `/api/install/queues/board/`, reached through
  `POST /api/install/system/queue-board` (a one-use pass) and an `hd_queue_board`
  session that re-checks the admin's refresh family and install-admin status on
  every request ([ADR 0017](../decisions/0017-bull-board-behind-a-one-use-pass.md),
  amending ADR 0004). New dependencies `@bull-board/api` and
  `@bull-board/fastify` 9.10.1.
- **Screen** (artboard `Admin/System-1.0`): the health cards, a Product
  metrics row, Queues, Channels grouped by kind with an attention count,
  Version and migrations, Storage (UsageMeter against the soft limit, per brand
  with "pending deletion" marked), Audit log, LLM spend (install-wide) and
  Brands pending deletion. "Open queue dashboard" asks for the one-use pass and
  opens the board in a new tab opened before the request, so popup blockers
  let it through. The page's api adapter sends the access token (it did not
  before, which a real install would have refused); `SystemApi` is provided by
  `SystemApiProvider` from `createApis`.
- **Where the screen differs from the artboard:** Storage shows Postgres as
  one install-wide figure, not per brand (a brand's share would mean reading
  every row; see [operations](../guides/operations.md#where-the-numbers-come-from));
  Version has no image name, and the migration list has names without times
  (Drizzle records none); Channels show no brand name or Widget rows; the
  queue button is in the header only.
- Tests: `system-page.test.tsx`, `side-cards.test.tsx`, `system-api.test.ts`,
  `product-metrics.test.ts`; Playwright `e2e/system.spec.ts` (en and ar, axe);
  `system.service.test.ts`, `migrate.test.ts`, and in integration
  `observability`, `migrate` and `ai` (spend per brand).
- Guide: [operations](../guides/operations.md#the-system-page).

### M8-06 CSAT delivery

- **On close** (artboards `Email/CSAT-EN-AR`, `Widget/CSAT-EN`, `Widget/CSAT-AR`,
  `Telegram/Chat-EN` and `Telegram/Chat-AR` panels 5 and 6): the
  `csat.requested` job that creates the survey also sends it, in its
  transaction, on the ticket's channel (`apps/api/src/csat/csat-delivery.ts`).
  `chat` → a `csat` widget frame and the card over REST; `telegram` → a
  `telegram.notice` of kind `csat_survey`; any other channel → an
  `email_deliveries` row of kind `csat` and its `email.send`. Spam, merged and
  CSAT-off closes still get no survey, and only the run that inserts the survey
  sends it, so a redelivered job sends nothing. This closes the M1 gap "CSAT
  surveys are not delivered".
- **Feedback settings.** `AdminTicketingFeedback` has one toggle and no delay or
  channel choice, so the survey goes out at once on the ticket's own channel.
  The tab's delivery note says so.
- **Email** (`packages/channels/src/email/csat-survey.ts`, the CustomerEmail
  survey variant): five link cells, each the single-use link with
  `?rating=<n>&lang=<locale>`. The rating page opens with that score pressed and
  records nothing until Send, so link scanners cannot rate. `Message-ID`
  `<hd.c.<surveyId>@…>`, `Auto-Submitted: auto-generated`, no CCs. `sent_at`
  is set when the relay accepts it.
- **Widget**: `GET`, `POST …/conversations/:id/csat` and `POST …/csat/skip`
  (`widget-csat.controller.ts`), and the `csat` server event. The card
  (`apps/widget/src/ui/CsatCard.tsx`, DESIGN §6.6) replaces the composer until
  answered or skipped. Skip stores `skipped_at` and records no answer. The
  entry is 27.24 KB gzipped (was 25.85).
- **Telegram**: score buttons carry `csat:<surveyId>:<n>`. A tap is recorded
  only from the ticket's contact's chat, then answered with a `csat_rated`
  notice (the score buttons go, **Add a comment** stays, a thanks line with the
  link's expiry date) or `csat_closed` ("This survey has closed."). A tap
  leaves the link open once for a comment: `rate` accepts a link answer over a
  Telegram one with no comment, and the page opens with the tapped score.
- **`csat.received`** is written by every recorded answer
  (`apps/api/src/csat/csat-answers.ts`) with `{ ticketId, surveyId, rating,
  via, ratedAt }`, beside a `csat.rated` audit row. Rules subscribe already
  (M3-03), which closes the M3 gap. The default slot only logs; M8-03's
  webhooks subscribe under their own name.
- **Migration** `0043_csat_delivery`: `csat_responses.rated_via`
  (`csat_answer_channel`: `link`, `widget`, `telegram`; earlier answers are
  backfilled `link`) and `skipped_at`; `email_delivery_kind` gains `csat`;
  `email_deliveries.csat_response_id` with a unique partial index. No new
  tenant table.
- **Tests**: unit tests for every new module; `csat/delivery.integration.test.ts`
  (Postgres, Redis, Mailpit, the Telegram stand-in and a widget socket) for each
  channel, the link-scanner rule and the rules job; email snapshots in both
  languages (`email/render-survey.test.ts`); Playwright for the widget card
  (`apps/widget/e2e/csat.spec.ts`, en and ar, light and dark, axe) and the
  rating page's `?rating=` (`apps/admin/e2e/csat.spec.ts`).
- Guides: [tickets](../guides/tickets.md#satisfaction-surveys),
  [widget protocol](../guides/widget-protocol.md#satisfaction-card),
  [Telegram](../guides/telegram.md#the-satisfaction-survey),
  [automation](../guides/automation.md#a-rule).

### M8-07 Brand deletion and product metrics

- **Routes** (install admin): `GET`, `POST` (with `confirmPrefix`) and `DELETE`
  `/api/install/brands/:id/deletion`. The brand goes `deleting` with
  `deleted_at` stamped; restore within 30 days.
- **410:** `BrandGoneGuard`, a global guard on every `@Public()` route, answers
  410 for a brand that is `deleting` or `deleted` (path `:brandId`, the host's
  brand, or `/hc/<brandId>/`), cached 5 seconds per replica. The IMAP poller
  skips the brand and inbound parse answers 410 after the secret. Other
  channels call `isBrandGone(db, brandId)` (`apps/api/src/brands/brand-availability.ts`).
- **Purge:** `brand.purge.schedule` (cron `0 4 * * *`) adds `brand.purge`
  (job id `brand.purge.<brandId>`) per brand past its grace. Rows through
  `purgeBrandRows` in `@helpdock/db` (every table with `brand_id`, read from
  the catalog, foreign-key order, personal rows in their owner's name), then
  the S3 prefix (closing the M5 `hc_media` gap), Redis keys naming the brand
  (not `bull:*`), IMAP pollers and the storage reading. The brand row stays
  `deleted`, so the prefix stays reserved. Audit rows `brand.deletion_requested`,
  `brand.deletion_cancelled` and `brand.purged` (counts only) in install scope.
  `rls.integration.test.ts` seeds every tenant table and fails if a purge
  leaves a row.
- **Product metrics:** `GET /api/install/system/metrics` — activation,
  help center self-service per brand (widget views, from
  `report_help_center_daily`), AI deflection through the seam M7-06 binds.
- **Telegram:** the webhook names a bot, not a brand, so `BrandGoneGuard`
  does not see it; `TelegramWebhookService` answers 410 through `isBrandGone`
  after the secret check (`telegram.integration.test.ts`).
- **Screens:** Brand › Danger zone (artboard `Admin/Brand-Danger`) gains
  "Delete this brand" for install admins. The artboard asks for the brand's
  name; the api checks its ticket prefix (`confirmPrefix`), so the screen asks
  for the prefix ("Type HD to confirm"). During the grace every Brand tab shows
  a warning Banner "Scheduled for deletion on …" with Restore and is
  read-only (a disabled fieldset). System lists the pending brands with
  PendingDeletionRow, "Deleted by" from the deletion read's `requestedBy`
  (the install-scope `brand.deletion_requested` audit row). Tests:
  `brand-page.test.tsx`, `brand-deletion.integration.test.ts`; Playwright
  `e2e/brand-deletion.spec.ts`, `e2e/system.spec.ts`.
- Guides: [data retention](../guides/data-retention.md#deleting-a-brand),
  [operations](../guides/operations.md#product-metrics).

## Pull requests

- #147 feat: M6 Telegram, M7 AI, M8 API/webhooks/reports and M9 hardening towards 1.0 (M8-01 to M8-07, with M6, M7 and the M9 code-side work)
