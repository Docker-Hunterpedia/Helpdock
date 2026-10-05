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
| M8-04 | Reports | | built (api and screen), PR pending: [Reports](#m8-04-reports) |
| M8-05 | System page | | built (api and screen), PR pending: [System page](#m8-05-system-page) |
| M8-06 | CSAT delivery wired on close for email, widget, Telegram | | built, PR pending: [CSAT delivery](#m8-06-csat-delivery) |
| M8-07 | Brand deletion with 30-day grace and full purge (rows, S3 prefix, Redis keys, Caddy domain); product metrics on the System page | | built (api and screens), PR pending: [Brand deletion](#m8-07-brand-deletion-and-product-metrics) |

## Exit criteria

Copied from the PRD, ticked as they are met.

- [x] A ticket created via the API triggers a signed `ticket.created` webhook received by a test endpoint (`apps/api/src/api-v1/api-v1.integration.test.ts`).
- [x] Reports match seeded data in an integration test: `apps/api/src/reports/reports.integration.test.ts`, "the summary matches the seeded tickets".

## Open questions

- REQUIREMENTS §4.12 lists the webhook events; the M8 brief also named `ticket.status_changed` and `message.created`. The shipped list follows REQUIREMENTS (`ticket.updated` carries status changes, `ticket.replied` every thread message but notes). Adding the other two is an alias each in `webhooks/webhook-events.ts` if they are wanted.
- An API key's public message is `author_type = system` and is not emailed (only an agent's public reply is). Whether an integration may speak as an agent or as the customer is open.

## M8-01 Tenant API keys

- Table `api_keys` (brand): name, `prefix` (first 12 characters), `key_hash` (SHA-256, unique across the install), `scopes text[]`, `rate_limit_per_minute` (default 600), `created_by`, `last_used_at`, `revoked_at`/`revoked_by`. In `TENANT_TABLES` and the RLS negative suite.
- Admin routes, `brand:manage`: `GET`/`POST /api/brands/:brandId/api-keys`, `DELETE …/:keyId` (revoke). The key is in the create answer only. `api_key.created` and `api_key.revoked` audit rows carry the prefix and scopes, never the key.
- `ApiKeyPrincipalResolver` (`api-keys/api-key-principal-resolver.ts`) wraps the session resolver in `bootstrap.ts`: an `hd_live_` bearer is hashed and looked up in an all-brands system transaction (`tenant/all-brands.ts`, shared with inbound parse), throttled per key in Redis (sliding window, bucket `api-key`), and becomes `{ type: 'apikey', id, brandId, scopes }`. `last_used_at` is written at most once a minute.
- The six scopes are permissions of their own (`auth/permissions.ts`); no role holds one. An API key's tenant context is its brand with every department ([ADR 0019](../decisions/0019-api-scopes-and-openapi-from-zod.md)).

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

- `0039_api_keys_and_webhooks.sql`: `api_keys`, `api_idempotency_keys`, `webhooks`, `webhook_deliveries`, the `webhook_delivery_status` enum, and their RLS policies.

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
  `AI_USAGE_SOURCE`, bound by `ReportsModule.forRoot({ aiUsage })`). Until M7
  binds a reader of `ai_calls`, `NoAiUsage` answers `{ available: false }` in
  reports, `{ configured: false }` for LLM spend and `null` for deflection.
- **Screen** (artboard `Admin/Reports`, `apps/admin/src/screens/reports/`):
  date range, department and channel filters; four MetricTiles compared with
  the previous period from a second read; a ChartCard per report with "Table"
  and "Export CSV" (through `HttpTransport.requestBlob`, saved as
  `reportExportFileName`, now in `@helpdock/schemas`); the AI cards "not
  available" until M7. The sidebar offers Reports to Admin, Team Leader and
  Viewer. No charting dependency is in the ARCHITECTURE §1 stack, so the
  charts are plain SVG components (`charts.tsx`): column, line with an end
  label, share rows and Heatmap, per DESIGN §9 (legend, direct labels, Table
  view, Tooltip naming the series). The adapter is `ReportsApi`
  (`apps/admin/src/reports/`), on the shared transport.
- **Where the screen differs from the artboard**, because the summary does not
  carry it: volume per day is one series (created) with the Channel, Status or
  Priority breakdown as totals beside it rather than stacked per day; response
  and resolution times are the period's median and p90, not a line per day;
  SLA is by clock, not by priority; Agent workload has open, solved and replies
  (no per-agent times, SLA or CSAT, no Unassigned row); there is no Agent
  filter; CSAT has no "% of surveys answered" or comment count. The heatmap
  runs Monday to Sunday (brands have no week-start setting).
- Tests: `reports-page.test.tsx`, `report-math.test.ts`,
  `reports/api.test.ts`, `ui/usage-meter.test.tsx`; Playwright
  `e2e/reports.spec.ts` (en and ar, axe, the api failing).
- Guide: [reports](../guides/reports.md).

### M8-05 System page

- **Channels:** every brand's mailboxes and Telegram bots, through M6's
  reader (`apps/api/src/channels/channel-status.ts`, bound to
  `CHANNEL_STATUS`).
- **Storage:** measured per brand by `stats.rollup` when the reading is over 6
  hours old (`S3BrandObjects.usage`, prefix `brands/<id>/`), kept in the Redis
  hash `hd:storage:usage`, shown in total and per brand.
- **LLM spend:** `AiUsageSource.installSpend`.
- **Bull Board** at `/api/install/queues/board/`, reached through
  `POST /api/install/system/queue-board` (a one-use pass) and an `hd_queue_board`
  session that re-checks the admin's refresh family and install-admin status on
  every request ([ADR 0017](../decisions/0017-bull-board-behind-a-one-use-pass.md),
  amending ADR 0004). New dependencies `@bull-board/api` and
  `@bull-board/fastify` 9.10.1.
- **Screen** (artboard `Admin/System-1.0`): the health cards, a Product
  metrics row, Queues, Channels grouped by kind with an attention count,
  Version and migrations, Storage (UsageMeter against the soft limit, per brand
  with "pending deletion" marked), Audit log, LLM spend (install-wide, "not
  available" until M7) and Brands pending deletion. "Open queue dashboard" asks
  for the one-use pass and opens the board in a new tab opened before the
  request, so popup blockers let it through. The page's api adapter now sends
  the access token (it did not before, which a real install would have
  refused); `SystemApi` is provided by `SystemApiProvider` from `createApis`.
- **Where the screen differs from the artboard:** LLM spend is install-wide
  (the seam has no per-brand spend or budgets); Storage has no Postgres
  column; Version has no image name or migration list; Channels show no brand
  name or Widget rows; the queue button is in the header only. Each needs the
  api to report it.
- Tests: `system-page.test.tsx`, `side-cards.test.tsx`, `system-api.test.ts`,
  `product-metrics.test.ts`; Playwright `e2e/system.spec.ts`.
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
  sends it, so a redelivered job sends nothing.
- **Feedback settings.** `AdminTicketingFeedback` has one toggle and no delay or
  channel choice, so the survey goes out at once on the ticket's own channel.
  The tab's delivery note now says so.
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
  `report_help_center_daily`), AI deflection (seam).
- **Telegram:** the webhook names a bot, not a brand, so `BrandGoneGuard`
  does not see it; `TelegramWebhookService` answers 410 through `isBrandGone`
  after the secret check (`telegram.integration.test.ts`).
- **Screens:** Brand › Danger zone (artboard `Admin/Brand-Danger`) gains
  "Delete this brand" for install admins. The artboard asks for the brand's
  name; the api checks its ticket prefix (`confirmPrefix`), so the screen asks
  for the prefix ("Type HD to confirm"). During the grace every Brand tab shows
  a warning Banner "Scheduled for deletion on …" with Restore and is
  read-only (a disabled fieldset). System lists the pending brands with
  PendingDeletionRow; "Deleted by" is not drawn, since the deletion read does
  not name who asked. Tests: `brand-page.test.tsx`; Playwright
  `e2e/brand-deletion.spec.ts`.
- Guides: [data retention](../guides/data-retention.md#deleting-a-brand),
  [operations](../guides/operations.md#product-metrics).

## Pull requests

- None yet.
