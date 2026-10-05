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
| M8-04 | Reports | | built, PR pending: [Reports](#m8-04-reports) |
| M8-05 | System page | | built (api), PR pending: [System page](#m8-05-system-page) |
| M8-06 | CSAT delivery wired on close for email, widget, Telegram | | planned |
| M8-07 | Brand deletion with 30-day grace and full purge (rows, S3 prefix, Redis keys, Caddy domain); product metrics on the System page | | built (api), PR pending: [Brand deletion](#m8-07-brand-deletion-and-product-metrics) |

## Exit criteria

Copied from the PRD, ticked as they are met.

- [ ] A ticket created via the API triggers a signed `ticket.created` webhook received by a test endpoint.
- [x] Reports match seeded data in an integration test: `apps/api/src/reports/reports.integration.test.ts`, "the summary matches the seeded tickets".

## Open questions

- None yet.

## Deliverable notes

### M8-04 Reports

- **Rollups** (migration `0036_report_rollups`): `report_daily` and
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
- Guide: [reports](../guides/reports.md).

### M8-05 System page

- **Channels:** every active brand's mailboxes with M2's health rule
  (`apps/api/src/observability/channel-status.ts`). Telegram adds a
  `ChannelStatusSource` to `CHANNEL_STATUS_SOURCES` in
  `observability.module.ts`.
- **Storage:** measured per brand by `stats.rollup` when the reading is over 6
  hours old (`S3BrandObjects.usage`, prefix `brands/<id>/`), kept in the Redis
  hash `hd:storage:usage`, shown in total and per brand.
- **LLM spend:** `AiUsageSource.installSpend`.
- **Bull Board** at `/api/install/queues/board/`, reached through
  `POST /api/install/system/queue-board` (a one-use pass) and an `hd_queue_board`
  session that re-checks the admin's refresh family and install-admin status on
  every request ([ADR 0016](../decisions/0016-bull-board-behind-a-one-use-pass.md),
  amending ADR 0004). New dependencies `@bull-board/api` and
  `@bull-board/fastify` 9.10.1.
- The admin screen's new cards (per-brand storage, product metrics, the board
  button) wait for their artboards; the api is done.
- Guide: [operations](../guides/operations.md#the-system-page).

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
- Guides: [data retention](../guides/data-retention.md#deleting-a-brand),
  [operations](../guides/operations.md#product-metrics).

## Pull requests

- None yet.
