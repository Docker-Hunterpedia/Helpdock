# Reports

What a brand's reports count, where the numbers come from, and how to export
them (M8-04, [REQUIREMENTS §4.8](../planning/REQUIREMENTS.md#48-reports--dashboards)).
The admin screen that draws them is a later task; this guide describes the api
it will read.

## Who may read them

`report:read`: an **Admin**, a **Team Leader** and a **Viewer** (DOMAIN-RULES
§1.2: a Viewer "may read reports"). An **Agent** may not.

A Team Leader or a Viewer restricted to some departments gets those
departments' numbers and no others. The rollup tables are department-scoped
under row-level security like the tickets they summarise, so asking for a
department they cannot see answers zeroes, not another team's figures.

## What is counted

A ticket counts unless it is **spam**, **merged** into another, or
**soft-deleted**: the statuses marked "excluded from reports" (Spam and Merged,
M1-11) and `deleted_at` keep it out of every number below.

Every number is filed under the ticket's department, channel and priority **as
they are now**: a ticket moved to Billing last week reports under Billing.

| Report | What it is | When it counts |
|---|---|---|
| Volume | Tickets created and resolved, by day, channel and priority | Created on creation; resolved on `closed_at` |
| By status | Tickets created in the range, by the status they are in now | A current state, read from the tickets themselves |
| First response time | Median and p90 | On the day of the response |
| Resolution time | Median and p90 | On the day of the resolution |
| SLA compliance | Response and resolution clocks met, over met plus breached | On the day the clock was satisfied or breached |
| Backlog trend | Tickets open at the end of each day | A snapshot at the day's end |
| CSAT | Responses, average, share of 4 and 5, and the 1–5 distribution | On the day of the rating |
| Agent workload | Public replies and resolutions per agent, and the open tickets assigned to them at the end of the range | On the day of the reply or resolution |
| Busiest hours | Tickets created per weekday and hour | On creation |
| Help center searches | Top searches with the share that opened a result, and searches that found nothing | On the day of the search |
| AI deflection and cost | "Not available" until the AI subsystem (M7) records calls | — |

Days are the **brand's** calendar days, in its time zone (Brand settings), so
"yesterday" is the brand's yesterday.

### Response and resolution times

A ticket under an SLA policy is timed by its clocks (DOMAIN-RULES §3): satisfied
minus started, **less the time paused** waiting on the customer
(`paused_total_ms`). A ticket no policy matched has no clocks, and is timed from
its creation to the first public staff reply, and to `closed_at`.

Only a ticket's **initial** clocks count, unless the brand turns on "count
reopens" (`slaCountReopens`, Ticketing › SLAs): then a reopened ticket's
next-response clock counts as a response and its later resolution clocks as
resolutions, in times and in compliance alike (DOMAIN-RULES §3.5). The rollup
reads the setting when it runs, so a change shows in the trailing week at the
next hourly run.

Medians and p90s are taken over every response or resolution in the range, not
averaged from daily figures.

## Filters

| Filter | Applies to |
|---|---|
| `from`, `to` | Everything. Inclusive local days, at most 366 apart |
| `departmentId` | Every ticket report. Not help center searches, which have no department |
| `channel` | Every ticket report. Not help center searches |

## How fresh it is

The numbers are read from rollup tables that the worker's `stats.rollup` job
rebuilds hourly, at seven minutes past, for every active brand:

```
:07 every hour  stats.rollup.schedule   one job per active brand
                stats.rollup (brand)    rebuild the last 7 local days
```

- A run deletes the days it covers and writes them again from the tickets, so
  running it twice changes nothing, and a ticket marked spam or deleted during
  the week drops out of the days it was counted in.
- A brand with no rollups yet — an install upgraded to M8, or a new brand — is
  backfilled from its first ticket, up to 400 days back, in transactions of 31
  days.
- Days older than a week are not rebuilt. A ticket deleted after that stays in
  the history it was counted in, the backlog of a past day is the snapshot
  taken at the time, and retention purging old tickets does not rewrite old
  reports. Help center searches stay in the rollups after the search log itself
  is purged (DOMAIN-RULES §11: "aggregates for reports kept").

`computedAt` in the answer is when the oldest rollup in the range was written.

The rollup tables are `report_daily` and `report_agent_daily`
(department-scoped), and `report_search_daily` and `report_help_center_daily`
(brand-scoped), from migration `0037_report_rollups`.

## API

| Route | Permission | |
|---|---|---|
| `GET /api/brands/:brandId/reports?from=&to=[&departmentId=][&channel=]` | `report:read` | The summary: every report above, ranked lists cut at 20 rows |
| `GET /api/brands/:brandId/reports/exports/:report?from=&to=[…]` | `report:read` | One report as CSV, every row |

The summary's shape is `reportSummarySchema` in `@helpdock/schemas`. A range
that ends before it starts, or runs past 366 days, is a 400.

## CSV export

`:report` is one of `volume`, `response_times`, `sla`, `backlog`, `csat`,
`agents`, `busiest_hours` and `searches`. The file is UTF-8 with CRLF line
ends, named `helpdock-<report>-<from>-<to>.csv`, with a header row of English
column keys: a script reading the file should not break when the reader's
language changes.

The ticket reports have one row per day, department, channel and priority;
`response_times` carries that slice's own percentiles.

**Safe to open in a spreadsheet.** A cell that starts with `=`, `+`, `-` or `@`
(or a tab or a carriage return) is written with a leading `'`, so a department
called `=HYPERLINK(…)` or a search for `+1 555` opens as text and never runs as
a formula.

The rows are read inside the request's transaction, where row-level security
applies, and then streamed out; a stream that read the database as it went
would run outside that transaction.

## Known gaps

- **AI deflection and cost** read "not available" until M7 adds `ai_calls`. The
  seam is `AiUsageSource` in `apps/api/src/reports/ai-usage.ts`, bound in
  `ReportsModule.forRoot({ aiUsage })`.
- **No admin screen yet.** The Reports screen needs its artboard first.
- **Agent workload** counts open tickets by today's assignee, as departments
  count by today's department.
- **Scheduled email reports** are v1.1 (REQUIREMENTS §4.8).
