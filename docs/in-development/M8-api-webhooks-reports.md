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
| M8-04 | Reports | | built (api and screen), PR pending: [Reports](#m8-04-reports) |
| M8-05 | System page | | built (api and screen), PR pending: [System page](#m8-05-system-page) |
| M8-06 | CSAT delivery wired on close for email, widget, Telegram | | planned |
| M8-07 | Brand deletion with 30-day grace and full purge (rows, S3 prefix, Redis keys, Caddy domain); product metrics on the System page | | built (api and screens), PR pending: [Brand deletion](#m8-07-brand-deletion-and-product-metrics) |

## Exit criteria

Copied from the PRD, ticked as they are met.

- [ ] A ticket created via the API triggers a signed `ticket.created` webhook received by a test endpoint.
- [x] Reports match seeded data in an integration test: `apps/api/src/reports/reports.integration.test.ts`, "the summary matches the seeded tickets".

## Open questions

- None yet.

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
