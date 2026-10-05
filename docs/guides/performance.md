# Performance

How Helpdock's performance targets are measured and how to run the
measurements yourself (M1-15, M9-03). The targets are
[PRD §2](../planning/PRD.md#2-success-metrics); the conditions they hold under
are [DOMAIN-RULES §14](../planning/DOMAIN-RULES.md#14-performance-test-conditions).
A change to either is a planning change, not a test change.

## Targets

| Metric | Target | Gate | Measured by |
|---|---|---|---|
| Ticket list and read, 50 000 tickets in the brand | p95 < 150 ms | `perf:tickets` | 50 staff sessions listing, searching and opening tickets |
| Help center page, cached | p95 TTFB < 200 ms | `perf:help-center` | 50 visitors browsing home, category, section and article pages in `en` and `ar` |
| Help center page, cold render | p95 TTFB < 800 ms | `perf:help-center` | one visitor opening pages nobody has opened yet |
| Realtime, agent reply to widget | p95 < 500 ms | `perf:realtime` | agent reply submitted → the visitor's socket has the message |
| Widget initial bundle | ≤ 40 KB gzipped; lazy chunks ≤ 20 KB each | `apps/widget/scripts/size.test.ts`, in CI's `unit` job; `pnpm --filter @helpdock/widget size` locally | every pull request |

## The conditions (DOMAIN-RULES §14)

- **Host**: 2 vCPU, 4 GB RAM, SSD, Linux. Two api replicas, one worker,
  Postgres and Redis on the same host. No CDN.
- **Dataset**: five brands; the measured one has 50 000 tickets, 200 000
  messages, 20 000 contacts and 2 000 help center articles in two languages.
  (Knowledge chunks arrive with M7.)
- **Load**: ten minutes measured after two of warm-up, p95 by nearest rank.

The numbers mean something only on that host. On a laptop, or a CI runner
shared with other jobs, the suites are a smoke test of the harness: they show
the shape of the latency and catch a regression of an order of magnitude, not
a 10 % one.

## Running them

Each suite starts its own Postgres and Redis in containers (Docker is
required), migrates and seeds them, and runs the api from `dist/`, so build
first:

```sh
pnpm --filter @helpdock/api build
pnpm --filter @helpdock/api perf:tickets       # ~15 minutes
pnpm --filter @helpdock/api perf:help-center   # ~15 minutes
pnpm --filter @helpdock/api perf:realtime      # ~15 minutes
```

None of them is part of `pnpm test`, `pnpm test:integration` or CI. They print
a table and fail when a gate is missed. `PERF_REPORT=/path/report.json` also
writes the numbers as JSON, which is what to attach to a release.

For a quick run of the harness, shrink everything:

```sh
PERF_SCALE=0.02 PERF_WARMUP_S=5 PERF_DURATION_S=30 PERF_CONCURRENCY=10 \
  pnpm --filter @helpdock/api perf:help-center
```

### Settings every suite reads

| Variable | Default | Meaning |
|---|---|---|
| `PERF_WARMUP_S` | 120 | Warm-up, not measured |
| `PERF_DURATION_S` | 600 | Measured window |
| `PERF_REPLICAS` | 2 | Api processes |
| `PERF_SCALE` | 1 | Multiplies the ticket dataset (`0.02` for a smoke run) |
| `PERF_REPORT` | — | Also write the results to this JSON file |

### `perf:tickets` (M1-15)

`apps/api/src/testing/perf/ticket-list.perf.ts`. Fifty staff sessions, half an
Admin and half an Agent confined to the two smallest departments, cycle through
every default view, three searches, a tag filter, the second page, opening a
ticket and the sidebar's view counts. It also prints the `EXPLAIN (ANALYZE,
BUFFERS)` plan of every list query as the runtime role. Its own settings and
the history of the index work behind it are in
[tickets](tickets.md#how-it-is-measured): `PERF_CONCURRENCY` (50),
`PERF_THINK_MS` (1000), `PERF_P95_MS` (150), `PERF_NO_MATCH_P95_MS` (150).

### `perf:help-center` (M9-03)

`apps/api/src/testing/perf/help-center.perf.ts`, seeding the help center with
`help-center-dataset.ts`: 8 categories, 40 sections and 2 000 articles, each
published in `en` and `ar` with a body of about 300 words.

1. **Cold.** One visitor opens `PERF_COLD_PAGES` (100) article pages nobody has
   opened, one at a time, alternating languages, so each is rendered from the
   database. p95 TTFB is gated at `PERF_COLD_P95_MS` (800).
2. **Warm.** Every page of the browsing set — both home pages, every category,
   a section per category and 40 articles, in both languages — is requested
   once on every replica, which fills the Redis page cache. The same set is
   then requested once more by one visitor and reported (not gated), to show
   what a hit costs without queueing.
3. **Cached.** `PERF_CONCURRENCY` (50) visitors browse the set, waiting
   `PERF_THINK_MS` (1000) between pages. p95 TTFB per page kind and language is
   gated at `PERF_TTFB_P95_MS` (200). TTFB is the time to the status line and
   headers, as a browser's navigation timing reports it.

Pages are read at `/hc/<brandId>/…`. A custom domain renders the same page;
only the host differs.

### `perf:realtime` (M9-03)

`apps/api/src/testing/perf/realtime.perf.ts`. The stack includes **the worker**,
because a reply reaches a visitor through the outbox, the worker and Redis
pub/sub.

1. `PERF_WIDGET_SESSIONS` (200) visitors each open a widget session, start a
   conversation and connect a `/widget` socket, spread over the replicas, from
   an allowed origin. The api runs with `TRUST_PROXY=true` and each visitor
   sends its own `x-forwarded-for`, so the per-address budgets see two hundred
   browsers rather than one load generator.
2. Every visitor sends one message a minute over its socket (§14's widget
   load), starting at a different point in the minute.
3. `PERF_AGENTS` (5) agent loops reply to the conversations in turn, waiting
   `PERF_REPLY_THINK_MS` (5000) between replies — about one reply a second in
   all.
4. A sample is the time from just before the reply's `POST` to the moment the
   visitor's socket receives that message. A reply that has not arrived five
   seconds after the run is lost; any loss fails the run. p95 is gated at
   `PERF_REALTIME_P95_MS` (500).

## Results

The §14 host runs are recorded here before a release. Runs on other machines
are smoke runs and say so.

| Date | Host | Suite | Result |
|---|---|---|---|
| 2026-10-05 | development sandbox, 4 vCPU shared with other builds (load average ~20), `PERF_SCALE=0.02`, 10 visitors, 20 s | `perf:help-center` | cold p95 391 ms; cached, one visitor, p95 73 ms; cached under load p95 54–93 ms per page kind. Passes. |
| 2026-10-05 | the same | `perf:realtime`, 20 visitors, 2 agents, one reply a second, 40 s | p50 84 ms, p95 257 ms, nothing lost. Passes. |
| 2026-10-05 | the same | `perf:realtime`, 20 visitors, 2 agents, five replies a second, 30 s | p50 196 ms, **p95 4.9 s**, nothing lost. See below. |

### What the realtime runs showed

Delivery is fast while the worker keeps up and degrades by queueing when it
does not. The worker consumes `outbox.event` with BullMQ's default
concurrency of one, and every subscriber of an event — the widget relay, the
SLA clocks, rules, notifications, email — runs inside that one job. On the
loaded sandbox, five replies a second plus the visitors' messages was more
than one consumer could take, the queue grew, and the tail grew with it to the
length of the backlog. At one reply a second it stayed under the gate.

This was not tuned in M9-03: raising that concurrency lets two events of the
same ticket run at once, which the SLA and rules handlers have not been
reviewed for, and the sandbox was not the §14 host. The §14 run decides
whether it is needed; if it is, the change is per-event concurrency with the
handlers' ordering assumptions checked first, and a scaled-out worker in the
meantime (more `worker` replicas consume the same queue).

No index or cache change was made: the help center served cached pages at a
fraction of its budget on a host far busier than §14's, and the ticket list
has its own record in [tickets](tickets.md#how-it-is-measured).
