# Operating Helpdock

How a running install is observed: what it logs, what it measures, what it
traces, and where to look when something is wrong.

Specs: [ARCHITECTURE §14](../planning/ARCHITECTURE.md#14-observability) for the
observability contract, [§13](../planning/ARCHITECTURE.md#13-background-jobs-bullmq-queues)
for the queues, and [DOMAIN-RULES §10](../planning/DOMAIN-RULES.md#10-operations-and-recovery)
for recovery. Backup, restore, upgrade and key rotation are written up by M9-06;
this guide covers what M0-10 shipped.

---

## Logs

Both roles write [pino](https://getpino.io) JSON to stdout, one object per line.
A container runtime collects it; Helpdock does not write log files.

### What a line carries

```json
{"level":"info","time":1789765607157,"role":"api","requestId":"0199f4b2-6a91-7c27-9a1f-9c9a3f1f0a11","traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"b7ad6b7169203331","brandId":"0192c3f0-1a2b-7c3d-8e4f-000000000001","method":"GET","path":"/api/brands/0192c3f0-1a2b-7c3d-8e4f-000000000001","status":200,"durationMs":12,"principalType":"staff","principalId":"0192c3f0-1a2b-7c3d-8e4f-00000000000a","msg":"request"}
```

| Field | What it is |
|---|---|
| `role` | `api` or `worker` — which half of the image wrote the line |
| `requestId` | The `x-request-id` on the response. A user quoting it points at one line. |
| `traceId`, `spanId` | Present only while tracing is on (below). Joins the line to a trace. |
| `brandId` | The brand the request acted in, when one was resolved |
| `principalType`, `principalId` | Who asked. Never a name, never an email. |
| `durationMs` | Time to the response finishing |

### What a line never carries

Bodies, query strings, headers and email addresses are not logged, on purpose
(ARCHITECTURE §14). `Authorization`, `Cookie`, and any field called `password`,
`token` or `secret` are removed by pino's redaction even if something logs an
object that happens to contain one, and so are a driver error's `query` and
`parameters` — which would otherwise be a way to log a row.

A principal is named by its id. That id is the one `audit_log` records, so an
investigation joins the two without a log stream carrying personal details.

### Level

`LOG_LEVEL` sets it: `trace`, `debug`, `info`, `warn`, `error`, `fatal` or
`silent`. The default is `info`, which is one line per request plus anything
that went wrong. Raise it to `debug` while chasing something and put it back.

With `NODE_ENV=development` the lines are prettified by `pino-pretty` instead of
being JSON. `pino-pretty` is a development dependency and is resolved lazily, so
a production image that never installed it still starts.

---

## Metrics

`GET /metrics` serves the Prometheus text format from the api role.

### Scraping it

```yaml
# prometheus.yml
scrape_configs:
  - job_name: helpdock
    static_configs:
      - targets: ['api:3000']
```

### `/metrics` is never routed publicly

The series name every route this install serves, how many 5xx it returns, how
deep its queues are and how many jobs have failed, plus the process's heap and
handle counts. That is reconnaissance, so the endpoint is closed by default and
open in exactly two ways:

1. **The request reached the api directly from a private or loopback address.**
   RFC 1918 (`10/8`, `172.16/12`, `192.168/16`), carrier-grade NAT (`100.64/10`),
   link-local (`169.254/16`, `fe80::/10`), IPv6 unique-local (`fc00::/7`),
   loopback (`127/8`, `::1`) and the unspecified addresses (`0.0.0.0/8`, `::`).
   A Prometheus in the same Compose network or Kubernetes namespace, scraping
   `api:3000`, needs nothing else.
2. **The request presents `METRICS_TOKEN` as a bearer.** For everything else:
   ```
   Authorization: Bearer <METRICS_TOKEN>
   ```
   Set it to at least 16 characters — `openssl rand -hex 24`.

A refused request answers **404**, not 401, so a scanner learns nothing it would
not have learned from an install with no metrics at all. The reason is written
to the log — peer address, whether a bearer was offered, never the bearer — so
an operator whose scraper is being refused can see why, and a token guess leaves
a trail.

Two details about the address, and the second is the one that matters.

The address checked is the **socket's peer**, never `x-forwarded-for`: a header
a client controls must not be able to claim a private address.

But a socket peer only says who dialled the port. **Behind a reverse proxy it is
always the proxy**, which sits on the private network — so a request the proxy
forwarded in from the internet would otherwise pass on the proxy's credentials
rather than its own. So when `TRUST_PROXY=true` and a request carries a
forwarding header, the private-address door is closed for it and the token is
required. A scraper that dials the api itself carries no such header and is
unaffected.

**The reverse proxy must still not route `/metrics` publicly.** That is the
first line and the one to get right: configure the proxy to serve the admin app,
the help center and the api's public routes by host, and exclude `/metrics` from
any route you add. The token rule above is what holds when that is
misconfigured — it is a backstop, not a reason to skip the exclusion.

### What is measured

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `http_request_duration_seconds` | histogram | `route`, `method`, `status` | `route` is the Fastify route *template* (`/api/brands/:brandId`), never a URL, so one route is one series whatever ids are in it. A request that matched no route is labelled `__unmatched__`. |
| `http_requests_total` | counter | `route`, `method`, `status` | Recorded from a Fastify `onResponse` hook, so 401s, 403s and 404s are counted too. |
| `queue_jobs` | gauge | `queue`, `state` | All twelve queues, sampled every 15 s with BullMQ's `getJobCounts`. States: `waiting`, `active`, `failed`, `delayed`, `completed`. |
| `outbox_unpublished_rows` | gauge | — | The backlog, as the relay last reported it. `0` when no relay is reporting, which is why the next row exists. |
| `outbox_relay_up` | gauge | — | `1` when a relay reported a cycle in the last minute, `0` otherwise — a heartbeat older than that is aged out here exactly as it is on the System page, so an alert and the screen agree. A backlog of `0` means "nothing to publish" only when this is `1`. |
| `outbox_relay_cycle_seconds` | histogram | — | One observation per *reported* cycle. The relay cycles far more often than the api samples, so this is a sample of cycles, not all of them. |
| `db_pool_connections` | gauge | `state` | Sessions the runtime role holds on the server, by the state Postgres reports — `active`, `idle`, `idle_in_transaction`, `idle_in_transaction_(aborted)`, and `unknown` for a session Postgres reports no state for. Install-wide, not per replica. |
| `db_up`, `redis_up` | gauge | — | `1` when the readiness probe reached it, `0` when it did not. |
| `socket_connections` | gauge | `namespace` | Open Socket.IO connections on this replica, per namespace (`/staff`; `/widget` from M4). |

`prom-client`'s default Node metrics are on the same registry: event-loop lag,
heap, handles, GC and process start time.

No metric is labelled by brand, user, ticket or request id. A metric describes
the install; the log line describes the request.

### A first alert set

- `rate(http_requests_total{status=~"5.."}[5m])` above zero for five minutes.
- `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))`
  above your target.
- `queue_jobs{state="failed"}` rising — jobs are landing in a dead-letter set.
- `outbox_relay_up == 0` — no worker is relaying the outbox, so side effects are
  piling up unpublished. This is the one to page on.
- `outbox_unpublished_rows` above zero and not falling while `outbox_relay_up`
  is `1` — the relay is running but behind.
- `db_up == 0` or `redis_up == 0`.

---

## Tracing

OpenTelemetry, exported over OTLP/HTTP, and **off unless an endpoint is set**.

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

These are the standard OpenTelemetry variables, not Helpdock ones, so an
existing collector needs no new names. They are deliberately not in the
`packages/config` schema: the SDK has to start before `loadEnv()` can run.

| Variable | Effect |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector base URL. Setting it turns tracing on. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | The traces URL in full, if it differs. |
| `OTEL_SERVICE_NAME` | Overrides the default `helpdock-api` / `helpdock-worker`. |

Without an endpoint the SDK is not started at all: no exporter, no batching, and
nothing patched.

### How it is started

An instrumentation works by replacing the exports of the module it patches, so
it must run before anything has imported `http`, `fastify` or `ioredis`. It is
therefore preloaded rather than imported:

```bash
node --import ./dist/observability/instrumentation.js dist/main.js
```

The `dev` and `start` scripts and the Docker entrypoint all carry that flag.

### What is instrumented

`http` (server and client spans), `fastify` (spans named by route) and `ioredis`
(Redis, and through it BullMQ's Redis traffic).

Two gaps, both deliberate, so a trace that looks thin is not mistaken for a
broken one:

- **Postgres.** `@opentelemetry/instrumentation-pg` patches `pg`
  (node-postgres). Helpdock uses `postgres` (porsager) per ARCHITECTURE §1, and
  `opentelemetry-js-contrib` has no instrumentation for it. Database calls show
  as time inside their parent span rather than as spans of their own.
- **BullMQ.** Contrib has no BullMQ instrumentation. BullMQ ships its own
  telemetry interface, wired per queue and worker rather than by patching, so
  adopting it is a change to `@helpdock/jobs` and a dependency decision of its
  own.

Every log line written while a span is active carries its `traceId` and
`spanId`, and the per-request line carries both those and the `x-request-id`.
That is what joins the two views: find the trace from a request id a user
quoted, or find the log lines of a trace that looks slow.

---

## Health endpoints

| Route | Answers |
|---|---|
| `GET /health` | The process is alive. Says nothing about dependencies. |
| `GET /ready` | Postgres, Redis and the settings resolver all answered. `503` when any is down, which takes the replica out of rotation without killing it. |

Both are public: an orchestrator has no session, and neither answer says
anything a stranger could not learn by trying the port.

---

## The System page

`Admin → System`, for install admins only. One read of
`GET /api/install/system`, refreshed every ten seconds.

| Card | What it tells you |
|---|---|
| Header | The release, the commit the image was built from and the Node version — `helpdock 0.1.0 · a2cf2b3 · node v24.18.0`. The commit comes from the `HELPDOCK_GIT_SHA` build argument; a tree built without one says `unknown`. |
| API | The three readiness probes and the slowest of them |
| Worker | The outbox relay's last cycle and the backlog it reported. "no relay has reported" means no worker is running, or none has finished a cycle. |
| Postgres | Server version, migrations applied at boot, and the runtime role — which must be `helpdock_app` with RLS forced (DOMAIN-RULES §1.5) |
| Redis | Version, latency, and whether an AOF rewrite is running (not a failure, but it costs latency) |
| Queues | The first few, with waiting, active, failed, delayed and the age of the oldest waiting job; "All queues" fetches the rest. A failed count is a dead-letter count. |
| Channels | Empty until M2 adds the email channel |
| Storage and AI spend | "Not configured" until M1 measures the bucket and M7 measures spend. A subsystem that is not measured says so rather than showing a zero. |
| Audit log | The most recent install-scope entries |

The endpoint is `@Requires('install:admin')`: everything on it is install-wide,
so it runs in install scope and writes an `install.scope.access` audit row on
every read. Those rows are what the page's own audit card shows first.

A brand admin who reaches `/admin/system` is refused by the api and the page
draws "Not allowed"; the nav item is not offered to them in the first place.

### Where the numbers come from

Two are worth knowing:

- **The outbox backlog is reported by the relay, not queried by the api.** An
  install-scope request holds only the install sentinel in `app.brand_ids`, so
  it cannot see another brand's `outbox` rows, and widening its transaction to
  count them would be the kind of quiet cross-tenant read DOMAIN-RULES §1.3
  exists to prevent. The relay already runs with the system context it needs, so
  after every cycle it writes `hd:relay:last` to Redis and the api repeats it.
  Nothing durable lives only in Redis: losing the key costs one line on a page.
- **The migration count is read at boot by the owner connection.** The migration
  log lives in the `drizzle` schema, which the runtime role is deliberately not
  granted. An api replica counts the migrations while it is applying them and
  carries the number; a worker never migrates, so it reports nothing.

---

## Configuration

| Key | Default | What it does |
|---|---|---|
| `LOG_LEVEL` | `info` | pino's level for both roles |
| `METRICS_TOKEN` | unset | Bearer token for `/metrics`. Required for any request that arrives through the reverse proxy. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Turns tracing on and says where spans go |

`.env.example` documents all three.

---

## The master key

`APP_MASTER_KEY` in `.env` is 32 bytes of base64 that every secret Helpdock
stores is encrypted with: SMTP and OAuth credentials, CAPTCHA secrets, the token
signing key, and from M7 the LLM provider keys. It is also the input the
password pepper and the trusted-device cookie signature are derived from.

**Back it up with the database, somewhere other than the server.** Nothing can
recover a stored secret without it — not a database dump, not a support request
([DOMAIN-RULES
§10](../planning/DOMAIN-RULES.md#10-operations-and-recovery)). This is what the
first-run wizard's note is about, and it is the one thing an operator can get
irreversibly wrong on day one.

```bash
# Generate it, once, before the first start:
openssl rand -base64 32

# Compare the running stack's key with your backup without printing either:
cd Helpdock/docker
grep '^APP_MASTER_KEY=' .env | cut -d= -f2- | openssl dgst -sha256 | cut -c1-24
```

Run the same line against your backup copy. Equal fingerprints mean the backup
opens what the database holds.

Rotation (`APP_MASTER_KEY_PREVIOUS` and `helpdock keys rotate`) arrives with
M9-06; each encrypted value already records the key generation that wrote it, so
the two keys can coexist when it does.

---

## Still to come

- **M8-05** embeds Bull Board in the System page ([ADR
  0004](../decisions/0004-bull-board-for-queues.md)). Until then "Open queue
  dashboard" opens the full queue table.
- **M9-06** adds backup, restore, upgrade and key rotation to this guide, and
  **M9-10** rehearses them (DOMAIN-RULES §10).
