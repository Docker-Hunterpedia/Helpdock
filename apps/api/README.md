# @helpdock/api

The NestJS application. One image, two roles: `APP_ROLE=api` serves HTTP and
(from M0-13) WebSockets and the server-rendered help center; `APP_ROLE=worker`
drains queues. Specs: [ARCHITECTURE
§6](../../docs/planning/ARCHITECTURE.md#6-request-lifecycle--tenancy) for the
request lifecycle and [DOMAIN-RULES
§1](../../docs/planning/DOMAIN-RULES.md#1-authorization) for authorization.

It runs on the Fastify adapter ([ADR
0006](../../docs/decisions/0006-fastify-adapter-for-the-api.md)).

Running it locally — Postgres, Redis and the `.env` it needs — is in [the
development guide](../../docs/guides/development.md#api). In short:
`pnpm --filter @helpdock/api dev:build` in one terminal compiles, and
`pnpm --filter @helpdock/api dev` in another runs what it compiled. Node's type
stripping does not transform decorators, so the api is always compiled before it
runs.

## Boot sequence

`main.ts` does one thing: load the environment and call `start(env)`. What
follows is in `bootstrap.ts`, in this order, because each step depends on the
one before it.

1. **`loadEnv()`** — every bootstrap key, validated by `@helpdock/config`. One
   error lists every key that needs attention.
2. **Migrations, `APP_ROLE=api` only.** `runMigrations` connects as the owner
   role from `DATABASE_MIGRATION_URL`, takes a Postgres advisory lock and
   applies what is pending. Several replicas starting at once serialise on the
   lock and only one of them applies anything.
3. **`createDb`** — the runtime pool, on `DATABASE_URL`.
4. **Wait for the schema, `APP_ROLE=worker` only.** A worker never migrates. It
   polls a table the first migration creates, backing off from 250 ms to 5 s,
   and gives up after 60 s with a message naming `APP_ROLE=api`.
5. **`assertRuntimeRoleIsSafe`** — refuses to serve when the connected role is a
   superuser, has `BYPASSRLS`, or owns a table
   ([DOMAIN-RULES §1.5](../../docs/planning/DOMAIN-RULES.md#15-database-roles)).
   The facts it returns are logged, so an operator can see which role was
   verified.
6. **Redis and settings** — the invalidation channel, a client for `/ready`, and
   the install-scope settings resolver over the `settings` table.
7. **Queues, `APP_ROLE=worker` only.** `src/worker/start-worker.ts` registers the
   `outbox.event` consumer and then starts the outbox relay, in the order
   [`packages/jobs/README.md`](../../packages/jobs/README.md) requires: a job
   that arrives before its consumer exists burns attempts.
8. **Listen**, for `APP_ROLE=api`, after registering `@fastify/static` against
   `ADMIN_DIST_DIR` so the admin build can be served (see below).

`SIGTERM` and `SIGINT` close the HTTP server — or, in a worker, the relay, then
the consumer, then the queue connection — and then the settings resolver, Redis
and the database pool, in that order. A second signal during a shutdown is
ignored, and a drain that has not finished after 15 seconds exits 1 with a line
saying so rather than waiting for `docker stop` to send SIGKILL.

## Request lifecycle

In the order Nest runs it:

| Step | Where | What it does |
|---|---|---|
| 1 | `RequestContextMiddleware` | Request id, start time, brand from the `Host` header, all of it in `AsyncLocalStorage`. Logs one line when the response finishes. |
| 2 | `AuthGuard` | Resolves the `Principal` through `PrincipalResolver`, or 401. |
| 3 | `PermissionGuard` | Reads the route's declaration, resolves the target brand, checks the role, decides the tenant scope, or 403/400. |
| 4 | `ZodSerializerInterceptor` | Parses the response through its output schema — outside the transaction, so parsing holds no connection. |
| 5 | `TenantInterceptor` | Opens the transaction and sets `app.brand_ids`, `app.department_ids`, `app.all_departments`, `app.principal_type` and `app.principal_id`. |
| 6 | `ZodValidationPipe` | Parses body, query and params through their input schemas. |
| 7 | `AllExceptionsFilter` | One body shape for every failure. |

Inside a handler, `getTx()` returns that transaction. Every query goes through
it; a query made any other way carries no `app.*` settings and the policies show
it nothing.

Throwing from a handler rolls the transaction back, including the
`install.scope.access` audit row an install route was charged for on the way in.

## Adding a route

Every handler declares one of three things. A handler that declares none is
refused at runtime by `PermissionGuard` and in CI by `pnpm check:routes`
([DOMAIN-RULES §1.3](../../docs/planning/DOMAIN-RULES.md#13-enforcement-layers)).

| Decorator | Principal | Transaction |
|---|---|---|
| `@Public()` | none | none |
| `@Authenticated()` | required | every brand the principal holds a role in |
| `@Requires(permission)` | required, with the permission in the target brand | the target brand alone |
| `@Requires('install:admin')` | required, and `installAdmin` | install scope, audited |

```ts
@Controller('api')
export class TicketsController {
  @Get('brands/:brandId/tickets')
  @Requires('ticket:read')
  @ZodSerializerDto(TicketListDto)
  async list(@Param() { brandId }: BrandIdParamDto): Promise<TicketList> {
    return { tickets: await getTx().select().from(tickets) };
  }
}
```

Three rules that are not enforced by a decorator:

- **Declare the output schema.** `@ZodSerializerDto(SomeDto)` is what keeps a
  column that nobody meant to publish out of the response.
- **Put the schema in `packages/schemas`.** `apps/admin` and `apps/widget` parse
  the same shapes; `apps/api/src/routes/dto.ts` wraps them with `createZodDto`.
- **Name every injected dependency with `@Inject(...)`.** Nothing in this app
  relies on a constructor parameter's *type* for injection: an `import type`
  erases the class the metadata would need, and the formatter is free to rewrite
  an import it sees used only as a type.

### The target brand

`@Requires(permission)` acts on exactly one brand, resolved in this order:

1. the `:brandId` path parameter, which must be a UUID or the request is 400;
2. the brand the `Host` header named, for help-center and widget routes;
3. the principal's brand, when it holds exactly one;
4. otherwise 400 — a principal with several brands and no `:brandId` is an
   ambiguous request, not permission to open all of them.

### Permissions

`src/auth/permissions.ts` holds the `Permission` union and the role matrix,
transcribed from [DOMAIN-RULES
§1.2](../../docs/planning/DOMAIN-RULES.md#12-scope-rules). `install:admin` is in
no role's list: it belongs to `principal.installAdmin` alone, and an install
admin does **not** inherit a role in any brand — it reaches a brand's data by
being given one.

## Install scope

An install-scope route runs with `INSTALL_SCOPE_BRAND_ID` in `app.brand_ids`,
which is what makes install-wide `settings` and `audit_log` rows reachable. The
tenant interceptor writes an `audit_log` row with action `install.scope.access`,
naming the principal, the route and the request id, inside the same transaction
as the handler.

A route that needs both install-wide rows *and* a brand's own rows has to name
that brand on top of the sentinel, deliberately, in the same place.

`INSTALL_SCOPE_BRAND_ID` is the nil UUID, so it is a well-formed brand id and a
`:brandId` parameter or a principal could otherwise name it. It is refused in
both places: a brand-scoped route that resolves to it answers 400, and a
principal scope drops it. `@Requires('install:admin')` is the only way in.

`GET /api/brands` is not an install path: it lists the brands the principal
holds a role in, and for an install admin with no roles that is an empty list.
The all-brands read is `GET /api/install/brands`, which is audited.

## Workers

`withSystemJob(db, brandId, jobId, fn)` is the worker's equivalent of the
request transaction: one brand, every department, `principal_type = system`, and
`principal_id` set to the job id so an audit row names the job that wrote it
([DOMAIN-RULES §1.4](../../docs/planning/DOMAIN-RULES.md#14-workers-and-websockets)).
A job that needs several brands enqueues one child job per brand.

`src/worker/start-worker.ts` is what `APP_ROLE=worker` boots. It takes the three
things `@helpdock/jobs` needs — a queue connection, the `outbox.event` consumer
and the relay — through an interface, so a unit test proves the start and
shutdown order without Redis. Adding a consumed event means calling
`registerEventHandler` there, before the worker is created.

## Serving the admin SPA

`src/static/` serves `apps/admin/dist` at `/` on the admin host
(ARCHITECTURE §3). `ADMIN_DIST_DIR` says where the build is; the image sets it to
`/app/admin`, which is also the default, and a process that finds no build there
logs one warning at boot and serves `/api` alone.

| Path | Answer |
|---|---|
| a file in the build | that file; `Cache-Control: immutable` for a year under `assets/`, an hour elsewhere |
| `/`, or any path that is not a file | `index.html`, `Cache-Control: no-store`, with the install meta tags rewritten |
| `/api/…` with no matching route | the JSON 404 every other failure uses |

The two `helpdock:*` meta tags are rewritten per request from this install's
brands (`InstallInfoService`), because they are the only thing the sign-in card
may know before anyone has signed in and no endpoint may enumerate brands to an
anonymous visitor. A database that is down falls back to the `APP_URL` host
rather than failing the page.

`index.html` also leaves with a `Content-Security-Policy` of its own, replacing
the `default-src 'none'` every api response carries — under which the SPA could
not load a single byte. The policy admits the one inline script `index.html`
runs by its SHA-256 hash rather than with `'unsafe-inline'`, computed from the
file that is being served, so editing that script cannot leave a stale policy
behind. `'unsafe-inline'` stays on `style-src`, because Emotion writes MUI's
styles into `<style>` elements at runtime; removing it means giving that cache a
nonce, in `apps/admin`.

`@fastify/static` is registered with `serve: false`: it contributes
`reply.sendFile` and no routes, so `AdminSpaController` stays the one place that
decides what a path means. Fastify's router prefers a static route to the
controller's `/*`, which is what keeps `/health`, `/ready` and every declared
`/api/…` route reachable.

## The development principal header

M0-05 replaces `PrincipalResolver` with the real session resolver. Until then
the only way to authenticate is `HeaderPrincipalResolver`, which reads a whole
principal out of the `x-hd-dev-principal` header as JSON.

It is enabled only when **both** are true:

- `NODE_ENV` is not `production`, and
- `HD_DEV_PRINCIPAL_HEADER=1`.

It trusts the header completely: anyone who can reach the port can name
themselves an install admin. Boot logs a warning when it is on, and an error if
the flag is set while `NODE_ENV=production` — in which case it stays off.

```bash
curl -s localhost:3000/api/me \
  -H 'x-hd-dev-principal: {"type":"staff","id":"0199f4b2-6a91-7c27-9a1f-000000000001","brands":{"0199f4b2-6a91-7c27-9a1f-00000000000a":{"role":"admin","departmentIds":"all"}},"installAdmin":false}'
```

Without the flag the resolver is `DenyAllPrincipalResolver` and everything but
`/health` and `/ready` answers 401.

## Endpoints

| Route | Declaration | Answers |
|---|---|---|
| `GET /health` | `@Public()` | Liveness. Says nothing about dependencies. |
| `GET /ready` | `@Public()` | Database, Redis and settings. 503 when any is down. |
| `GET /api/me` | `@Authenticated()` | The principal. |
| `GET /api/brands` | `@Authenticated()` | Brands the principal holds a role in. |
| `GET /api/install/brands` | `@Requires('install:admin')` | Every brand. Audited. |
| `GET /api/brands/:brandId` | `@Requires('brand:read')` | One brand. |
| `GET /internal/domain-check` | `@Public()` | Caddy's on-demand TLS gate. 200 for a verified help-center domain, 403 otherwise. |
| `GET /*` | `@Public()` | The admin SPA, above. |

Most of these exist to prove the plumbing; M0-06 onwards replaces them with real
ones. `/internal/domain-check` is not one of them: it is what stops Caddy
issuing a certificate for a hostname this install does not serve
(ARCHITECTURE §3).

It reads `brand_domains` on an install-scope path — every brand id named
explicitly, one statement, that table only — because the brand is exactly what
the question is asking. The answer is logged at `debug` as `domain.check` and
not written to `audit_log`: Caddy asks on every handshake for an unknown host,
so a row per call would be a way for a stranger to fill the table.

`@Public()` because Caddy's `ask` carries no headers, so the `/internal/*`
shared secret of [ARCHITECTURE
§7](../../docs/planning/ARCHITECTURE.md#7-auth-design) cannot apply. Two things
stand in its place: `docker/caddy/Caddyfile` answers 404 to `/internal/*` from
outside, so the route is reachable only from inside the Compose network, and the
handler rate-limits per source address.

## Errors

Every failure answers with the same body:

```json
{ "error": { "code": "forbidden", "message": "…", "requestId": "0199f4b2-…" } }
```

A failed input schema adds `fields`, each with the path as the request carried
it. An unexpected error answers `internal_error` with a fixed message — the
cause, the stack and the SQL go to the log under that request id, and nowhere
else. A response that fails its *output* schema is a bug in the api, so it is a
500 with no field detail.

The request id is on every response in the `x-request-id` header. It is taken
from the client only when `TRUST_PROXY=true`, and even then only if it is at
most 128 characters of `A-Za-z0-9._:-` — otherwise a caller could choose the id
an operator greps for, or write newlines into the log stream.

## Security headers

`@fastify/helmet`, configured in `src/http/security-headers.ts`:
`Content-Security-Policy` denying everything (a JSON response loads nothing),
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and HSTS only
when `APP_URL` is https. The admin SPA, the help center and the widget are
served by later milestones and each brings the policy its own content needs.

## Tests

```bash
pnpm --filter @helpdock/api test          # unit
pnpm test:integration                     # Testcontainers: real Postgres and Redis
```

`src/*.test.ts` need nothing installed. `src/api.integration.test.ts` starts
`pgvector/pgvector:pg17` and `redis:7-alpine`, boots the real app against them
and runs the negative suite of [DOMAIN-RULES
§1.6](../../docs/planning/DOMAIN-RULES.md#16-required-negative-tests) at the HTTP
layer. It skips itself, and says so, when Docker is not running.

`src/testing/` is test scaffolding — an `ExecutionContext` double and a probe
controller that reads the session settings back from inside a handler.
`tsconfig.json` keeps it out of the build, and the app mounts the controller
only when a test passes it as an extra controller.

## Known gaps

- `NoopBrandResolver` resolves every host to nothing. `brand_domains` exists
  from M0-09, for the on-demand TLS check; M5 adds the rows, their verification,
  and the resolver that turns a `Host` header into a brand.
- `DenyAllPrincipalResolver` is the default until M0-05.
- The WebSocket gateway is M0-13. `PermissionGuard` refuses any non-HTTP
  execution context outright, so M0-13 has to say what a socket event needs
  ([DOMAIN-RULES §1.4](../../docs/planning/DOMAIN-RULES.md#14-workers-and-websockets))
  rather than inherit silence. `pnpm check:routes` covers `@Controller`
  handlers only; M0-13 extends it to `@SubscribeMessage`.
- `/metrics` and OpenTelemetry are M0-10. The logger here is deliberately small
  enough to extend rather than replace.
