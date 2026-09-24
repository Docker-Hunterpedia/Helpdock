# @helpdock/api

The NestJS application. One image, two roles: `APP_ROLE=api` serves HTTP,
WebSockets and (from M5) the server-rendered help center; `APP_ROLE=worker`
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

The `dev` and `start` scripts and the Docker entrypoint all preload the
OpenTelemetry SDK with `--import ./dist/observability/instrumentation.js`. An
instrumentation patches the module it wraps, so it has to run before anything
has imported `http`, `fastify` or `ioredis`. Nothing is traced unless
`OTEL_EXPORTER_OTLP_ENDPOINT` is set
([operations guide](../../docs/guides/operations.md#tracing)).

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
7. **Signing keys** — the ES256 key pair access tokens are signed with, read
   from the `auth.jwtSigningKey` setting or generated once, under a Redis lock,
   if this is the install's first boot
   ([the authentication guide](../../docs/guides/authentication.md)).
8. **Queues, `APP_ROLE=worker` only.** `src/worker/start-worker.ts` registers the
   `outbox.event` consumer and then starts the outbox relay, in the order
   [`packages/jobs/README.md`](../../packages/jobs/README.md) requires: a job
   that arrives before its consumer exists burns attempts.
9. **Listen**, for `APP_ROLE=api`, after registering `@fastify/static` against
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
| 2 | `AuthGuard` | Resolves the `Principal` through `PrincipalResolver` — `SessionPrincipalResolver`, which verifies the bearer token — or 401. |
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

`src/worker/start-worker.ts` is what `APP_ROLE=worker` boots. It takes what
`@helpdock/jobs` needs — a queue connection, the `outbox.event` consumer, the
`media.process` consumer and the relay — through an interface, so a unit test
proves the start and shutdown order without Redis. Adding a consumed event means
calling `registerEventHandler` there, before the workers are created.

The media worker runs at concurrency 1. sharp and ffmpeg are CPU-bound, and four
conversions at once on a small VPS starve everything else on it; more replicas
is how this scales, not more concurrency.

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

The four `helpdock:*` meta tags are rewritten per request by
`InstallInfoService`, because they are everything the app may know before anyone
has signed in and no endpoint may enumerate an install to an anonymous visitor.

| Tag | What it carries |
|---|---|
| `helpdock:primary-domain` | Help-center host of the install's first brand, for the sign-in caption |
| `helpdock:brand-count` | How many brands this install serves |
| `helpdock:install-state` | `fresh` while the `users` table is empty, `configured` afterwards (M0-08) |
| `helpdock:version` | The api's own version, for the wizard's caption |

A database that is down falls back to the `APP_URL` host rather than failing the
page, and to `configured`: the state tag decides whether the app offers to
create an install admin, and an outage is not a reason to offer that to a
stranger.

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

## The first-run wizard

`src/install/` holds M0-08: the four steps an operator takes on a machine where
nothing has been set up yet. They are the only routes in the api that write
without a principal, because the first of them creates the person everything
else is checked against.

What stands in for authorisation:

- **Step 1** is refused unless the install is `fresh`, which means the `users`
  table is empty (`install-state.ts`). The check is repeated inside the
  transaction, behind `pg_advisory_xact_lock`, so two browsers posting at the
  same instant produce one admin and one 409.
- **Steps 2 to 4** are refused unless they present the token step 1 issued, in
  the `x-helpdock-setup` header. It lives in Redis for thirty minutes under the
  SHA-256 of its value, carries no claims, and is spent when the wizard
  finishes. Every route answers 409 from then on.
- **Every call** is counted against a per-address budget: thirty for the wizard
  as a whole, and ten for the SMTP test, which is the only call in the api that
  opens a socket to a host the caller named.
- **Every call** is also refused with 403 when `Sec-Fetch-Site` says a browser
  made it from another site (`same-site.ts`). A credential-free write is the one
  kind a `SameSite=Lax` cookie cannot protect: a page on another origin could
  post step 1 blind — it could not read the answer, but it chose the password.

Every write runs in an install-scope transaction as
`principal_type = system`, `principal_id = install.setup`, and leaves an
`install.setup.admin`, `install.setup.brand` or `install.setup.smtp` row in
`audit_log`. The SMTP row records the host, the port and the TLS mode, never the
username or the password.

Step 2 writes the brand, the admin's `user_brand_roles` row as `admin`, the
brand's `General` department and, when one was given, an unverified
`brand_domains` row — all in one transaction that names both the install scope
and the new brand.

The admin is signed in on **step 2**, not step 1: a session names the brand it
lands in, and until the brand exists the account holds no role, so
`SessionService.open` correctly refuses to open one. It is also what keeps the
install-admin floor M0-06 added satisfied: the account has a membership from the
moment it has anything.

The fresh-install window is the one moment an install trusts whoever reaches it,
because there is nobody yet to check against. [The install
guide](../../docs/guides/install.md#first-run) tells operators to finish the
wizard before the host is reachable from anywhere else.

## Authentication

`src/auth/` holds M0-05: password, sign-in link, Google and GitHub OAuth, TOTP
with recovery codes, and the session — a ten-minute ES256 access token plus a
rotating refresh token in an `httpOnly` cookie. What it does and how an operator
configures it is [the authentication
guide](../../docs/guides/authentication.md); what follows is what someone
reading this app's code needs.

`SessionPrincipalResolver` is the `PRINCIPAL_RESOLVER`. It verifies the bearer
token and builds the principal out of its claims, so an authorised request costs
one signature check and one Redis `EXISTS` — the revocation marker — and no
database read at all. A revoked session is refused within the ten minutes
[DOMAIN-RULES §1.6](../../docs/planning/DOMAIN-RULES.md#16-required-negative-tests)
allows. Visitors (M4) and api keys (M8) arrive behind the same interface.

`AuthController` is the only place in the app that touches a cookie, and the
only one that names its input schema on the parameter rather than leaving it to
the global pipe — the comment there says why.

`StaffRepository` is the documented system path: sign-in happens before a brand
is known, so it reads `user_brand_roles` in a transaction that names every
active brand, as `principal_type = system`. That is the widest scope in the
application and it is confined to that file.

`AuthModule` is `global: true`. The credential services are cross-cutting —
`src/staff/` changes a password and turns a second factor off — and they must do
it through the same `AuthService`: the same pepper, the same keyring, the same
decoy hash. A second `AuthModule.forRoot` would silently build a second graph.

## Contacts and accounts

`src/contacts/` is M1-04: who a person is, how Helpdock recognises them again,
and what is left of them after a privacy request. The rules, the endpoint table
and the refusal codes are in [the contacts
guide](../../docs/guides/contacts.md); three things matter to anybody working in
this app.

**`findOrCreateContactByIdentity` is the seam.** Every channel — M2 email, M4
widget, M6 Telegram — turns "a message arrived from X" into a contact through
that one function, inside its own transaction. It is where DOMAIN-RULES §4.4
lives: a verified identifier matches an existing contact, an unverified one that
somebody else holds starts a new contact and records a duplicate suggestion
instead.

**Normalisation lives in `packages/schemas`, not here.** `contact_identities` is
unique on the spelled value, and the admin, the api and the widget all have to
spell it the same way. `apps/api` calls `normaliseIdentity` and never compares a
raw string.

**Tickets reach the contact screens through two interfaces.**
`TicketStatsProvider` and `ContactTimelineProvider` in `src/contacts/providers.ts`
have "none yet" implementations, because M1-04 ships before M1-02. M1-02 passes
real ones to `ContactsModule.forRoot` and nothing else in the folder changes.
`hiddenCount` on the timeline is DOMAIN-RULES §1.2's count of the tickets a
viewer's departments exclude.

## Staff and roles

`src/staff/` holds M0-06: the staff list, invitations, the lifecycle changes of
[DOMAIN-RULES §12](../../docs/planning/DOMAIN-RULES.md#12-staff-lifecycle), and
the `/api/me/*` routes a person uses on their own account. What it does and how
an operator thinks about it is [the staff and roles
guide](../../docs/guides/staff-and-roles.md); what follows is for somebody
reading the code.

| File | |
|---|---|
| `staff-scope.ts` | The matrix. Pure functions over values the caller has already read, so who may do what is decided in one place and is testable without a database. |
| `staff-failure.ts` | A refusal by a §12 rule rather than by a permission. The same shape as `auth-failure.ts`, and for the same reason: the screen needs to pick between four sentences. |
| `anonymise.ts` | What is left of an account after a delete: `Former staff`, and a placeholder address derived from the user id. |
| `invite.store.ts` | The pending-invitation record. It holds the token's *hash* — enough to destroy the previous link on a resend, never enough to present it — and the two dates the staff list prints. |
| `lifecycle-hooks.ts` | The §12 effects that belong to M0-13 and M1, as named calls at the point in the sequence where they have to happen. |
| `invite.service.ts` | The two `@Public()` routes. They open their own transaction, naming the one brand the token names, as `principal_type = system` with `principal_id = invite` — narrower than the sign-in path, which has to name every active brand. |

Four things are easy to get wrong here and are written down where they happen:

- **An Agent's empty department list means "no departments", not "all".** The
  mapping is `roles.ts`, and it is the one mistake that would hand a new starter
  the whole brand.
- **Reading an invitation does not spend it.** `EmailTokenStore.read` exists for
  that one purpose; a preview that burned the token would mean one refresh cost
  somebody their invitation.
- **An account that already exists and is active is never sent an invitation.**
  It gains the role and nothing else: a link that could set a new password would
  be a way to take over an existing account.
- **Two actions are not confined to the brand they are performed in**, because
  `users` is a global table: attaching an account that already exists
  install-wide, and deactivating one. Both take the brand's highest standing —
  `role === 'admin'` — and an install admin's account is adoptable by nobody.
  Without that, a Team Leader of any brand could attach a stranger's account as
  an agent of a department they lead and then disable it install-wide.

## Brands, departments and teams

`src/brands/` holds M1-01: the brand itself, the departments under it, the teams
inside those, and who is on them. What it does and how an operator thinks about
it is [the ticketing settings
guide](../../docs/guides/ticketing-settings.md); what follows is for somebody
reading the code.

| File | |
|---|---|
| `department-scope.ts` | Who may change what. Pure functions over values the caller has already read, so DOMAIN-RULES §1.2 is transcribed in one place and is testable without a database. |
| `department-deletion.ts` | The two reasons a department may not be deleted: the brand's last one, and one tickets still point at. The count runs in the caller's transaction, which is safe because deleting is `brand:manage` and an Admin's department scope is always "all". |
| `ticketing-failure.ts` | A refusal by a rule rather than by a permission, in the shape `staff-failure.ts` uses and for the same reason. |
| `install-brands.service.ts` | An additional brand, in one transaction. |
| `departments.repository.ts` | Every read and write, through the request's own transaction, so the policies do the filtering. |

Three things are easy to get wrong here and are written down where they happen:

- **Two permissions, because §1.2 draws two lines.** Which departments a brand
  *has* is `brand:manage` — Admin only. What is *inside* one is `staff:manage`,
  narrowed to the departments a Team Leader actually leads.
- **Team membership has a ceiling as well as a scope.** `canManageMember` is
  DOMAIN-RULES §1.2's "a Team Leader adds Agents and Viewers, nobody else", and
  it shares `LED_ROLES` with `staff/staff-scope.ts` rather than keeping a second
  copy. `reachesDepartment` is the other half — could this person see the work?
  — and the picker applies both, so it never offers somebody the save refuses.
- **A reorder is the whole list.** A partial one is a 400 rather than a silent
  half-reorder, and both the drag handle and the row menu build it the same way.
- **`InstallBrandsService` widens `app.brand_ids` inside its own transaction**
  so the new brand's role and department are visible to the policies. It is
  `set_config(…, true)` — `SET LOCAL` semantics — on an `install:admin` route, with an id the method generated a
  statement earlier — and the alternative, a second transaction, could commit a
  brand's departments after the brand itself rolled back.

### The development principal header

`HeaderPrincipalResolver` reads a whole principal out of the
`x-hd-dev-principal` header as JSON, instead of the session resolver, so the
tenancy plumbing can be exercised without signing in.

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

Without the flag the session resolver is used, and everything but the public
routes answers 401 without a valid bearer token.

## Endpoints

| Route | Declaration | Answers |
|---|---|---|
| `GET /health` | `@Public()` | Liveness. Says nothing about dependencies. |
| `GET /ready` | `@Public()` | Database, Redis and settings. 503 when any is down. |
| `GET /api/me` | `@Authenticated()` | The principal. |
| `GET /api/brands` | `@Authenticated()` | Brands the principal holds a role in. |
| `GET /api/install/brands` | `@Requires('install:admin')` | Every brand. Audited. |
| `POST /api/install/brands` | `@Requires('install:admin')` | An additional brand, with a role, a department and a ticket sequence. Audited. |
| `GET /api/brands/:brandId` | `@Requires('brand:read')` | One brand. |
| `PATCH /api/brands/:brandId` | `@Requires('brand:manage')` | Name, default locale, time zone, ticketing settings. Never the prefix. |
| `/api/brands/:brandId/staff/*` | `@Requires('staff:manage')` | Staff and roles. [The guide](../../docs/guides/staff-and-roles.md#endpoints) lists them. |
| `/api/brands/:brandId/contacts/*` | `@Requires('contact:read'\|'contact:write')` | Contacts, identifiers, notes, duplicate suggestions and erasure. [The guide](../../docs/guides/contacts.md#api) lists them. |
| `/api/brands/:brandId/accounts/*` | `@Requires('contact:read'\|'contact:write')` | The customer companies of a brand. |
| `/api/brands/:brandId/departments*` | `brand:read` to read the list and a department's teams, `brand:manage` to add, delete or reorder, `staff:manage` to edit one, its teams and its member picker | Departments, teams and team members. [The guide](../../docs/guides/ticketing-settings.md#endpoints) lists them. |
| `GET /api/brands/:brandId/presence` | `@Requires('staff:read')` | Who is online in that brand. [The realtime guide](../../docs/guides/realtime.md#presence). |
| `GET /api/brands/:brandId/ticket-statuses` | `@Requires('ticket:read')` | The brand's statuses. [The ticket guide](../../docs/guides/tickets.md#endpoints). |
| `/api/brands/:brandId/tickets/*` | `ticket:read` / `ticket:write`, and `brand:manage` for the soft delete | Tickets, their threads, their activity and their tags. [The ticket guide](../../docs/guides/tickets.md#endpoints) lists them. |
| `/api/brands/:brandId/ticket-statuses/*` | `@Requires('ticketing:manage')` | The Statuses tab: create, edit, reorder, delete, and the count a delete confirmation prints. [The guide](../../docs/guides/ticketing-settings.md#statuses). |
| `PATCH /api/brands/:brandId/ticketing/reply-behaviour` | `@Requires('ticketing:manage')` | The two settings of DOMAIN-RULES §2.3 a Team Leader may change. |
| `/api/brands/:brandId/{tags,custom-fields,ticket-templates}*` | `ticket:read` or `ticket:write` to read, `ticketing:manage` to change | The brand's tags, custom field definitions and ticket templates. [The settings guide](../../docs/guides/ticketing-settings.md#endpoints) lists them. |
| `DELETE /api/install/staff/:userId` | `@Requires('install:admin')` | Delete and anonymise an account. Audited. |
| `/api/me/*` | `@Authenticated()` | A person's own profile, password, second factor and sessions. |
| `GET /metrics` | `@Public()` + `MetricsGuard` | Prometheus. A direct connection from a private address, or `METRICS_TOKEN` as a bearer; anything else is a 404. |
| `GET /api/install/system` | `@Requires('install:admin')` | The System page's read. Audited. |
| `GET /api/install/system/queues` | `@Requires('install:admin')` | Every queue, paginated. Audited. |
| `POST /api/install/setup/admin` | `@Public()` | [The first-run wizard](#the-first-run-wizard). 409 once the install has an account. |
| `POST /api/install/setup/brand` | `@Public()` | 409 without the wizard token. Sets the refresh cookie. |
| `POST /api/install/setup/smtp` | `@Public()` | Saves or skips the `smtp.*` settings. |
| `POST /api/install/setup/smtp/test` | `@Public()` | Sends one message with the credentials in the body. |
| `POST /api/install/setup/complete` | `@Public()` | Spends the wizard token. |
| `GET /internal/domain-check` | `@Public()` | Caddy's on-demand TLS gate. 200 for a verified help-center domain, 403 otherwise. |
| `/api/auth/*` | mostly `@Public()` | Signing in. [The authentication guide](../../docs/guides/authentication.md#endpoints) lists them. |
| `GET /socket.io` | handshake | The `/staff` namespace. [The realtime guide](../../docs/guides/realtime.md). |
| `GET /*` | `@Public()` | The admin SPA, above. |

Most of the first few exist to prove the plumbing; the milestones after M0-06
replace them with real ones. `/api/auth/*` and `/internal/domain-check` are not among them. The second
is what stops Caddy
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

## Tickets

`src/tickets/` holds M1-02, M1-03, M1-08 and M1-09: the ticket, its thread,
its activity log, the state machine of DOMAIN-RULES §2 and merge and split
(§2.4). What the model is and what the endpoints answer is [the ticket
guide](../../docs/guides/tickets.md); what follows is for somebody reading the
code.

| File | |
|---|---|
| `tickets.repository.ts` | Every statement, and not one of them filters by brand or department. The request's transaction carries the scope and the policies apply it (DOMAIN-RULES §1.3); a `WHERE brand_id = …` on top would be a second place for isolation to live, and the one that is easy to forget on the next query. |
| `ticket-query.ts` | The list's `WHERE` and `ORDER BY`, built from the parsed query. Pure, so what a filter compiles to is asserted against rendered SQL rather than against a database. |
| `cursor.ts` | Keyset pagination. The cursor is opaque but is **not** a token: every row it can reach is a row the policies would have shown anyway, so a forged one is a differently-ordered page. It is validated all the same. |
| `status-change.ts` | Where a status change lands: the transition table is consulted, a status that is not this brand's is refused, and `closed_at` is kept in step with the system state. It answers *whether* the move closed or reopened the ticket; what that costs is the service's. |
| `lifecycle/transitions.ts` | DOMAIN-RULES §2.2 as one constant. `transitions.test.ts` holds a second copy typed out from the document and asserts the two agree cell by cell. |
| `lifecycle/reopen-policy.ts` | §2.3, as a pure function of a policy, a `closed_at` and a `now`. The boundary — "less than N days" — is named in the test in both directions. |
| `lifecycle/hooks.ts` | The moments M3-02 and M1-12 fill: `onResolved`, `onClosedForCsat`, `onReopened`, and M1-09's `onMerged` and `onUnmerged`. A provider, so they replace one line of `TicketsModule`. |
| `lifecycle/lifecycle.service.ts` | The transitions carried out: the reply paths, the reopen, the continuation ticket and its two system messages, the soft delete. |
| `lifecycle/status-rules.ts` | What may be done to a status row, as pure functions — the same shape `brands/department-scope.ts` uses, and for the same reason. |
| `lifecycle/ticketing-settings.*` | The Statuses tab and the Reply behaviour card over HTTP, under the new `ticketing:manage`. |
| `ticket-activity.ts` | The activity row, written in the caller's transaction. |
| `ticket-events.ts` | The four outbox events and the handler the worker registers for them. |
| `ticket-view.ts` | Rows to the wire shapes, in one place, so a column added to a table does not quietly become a field in a response. |
| `merge/merge-rules.ts` | §2.4 as pure functions: which merges and unmerges are refused and why, the 24-hour window, `closed_at` across a merge and back, which messages a split may copy. |
| `merge/merge.service.ts` | Merge, unmerge and split carried out, each in the request's transaction with activity and outbox rows on both tickets. A merge moves the secondary into the primary's department, which is what makes "access follows the primary" true. |
| `merge/merge-view.ts` | What a ticket read adds: the tickets merged into it with their messages, where it was merged to, and what a split joined to it. A plain function, so `TicketsService.find` calls it without depending on the merge service. |
| `merge/participants.hook.ts` | `MergeParticipantsHook`: where the secondary's contact becomes a CC of the primary. Does nothing until M1-13 replaces the provider. |

Four things are easy to get wrong here and are written down where they happen:

- **`seq` is assigned under a lock on the *ticket* row**, and the `client_id`
  lookup happens inside it. Swapping the two would make a retry that arrives
  mid-commit write a second message (DOMAIN-RULES §7).
- **A ticket in another department answers 404, not 403.** The transaction
  cannot see the row, so the api genuinely does not know whether it exists;
  "forbidden" would confirm that it does.
- **Nothing emits to a socket from a request.** A ticket change reaches a socket
  through the outbox and the worker (§6), which is also why `TicketsModule` does
  not depend on `RealtimeModule`.
- **The `tagId` filter has all-of semantics** (M1-06). Two chips narrow a queue;
  "any" would widen it, which is the reading that is wrong in the direction that
  shows rows the reader asked to exclude.

## Tags, custom fields and templates

`src/ticketing/` holds M1-06. What a brand configures and what the endpoints
answer is [the settings guide](../../docs/guides/ticketing-settings.md); what
follows is for somebody reading the code.

| File | |
|---|---|
| `template-render.ts` | Fills `{{contact.first_name}}` from a **`Map` of fixed names**, never by walking a path into an object. A `Map` has no prototype, so `{{constructor.constructor}}` and `{{__proto__}}` resolve to nothing and are left spelled out. Also `paragraphsFrom`, which escapes a template's plain-text body before wrapping it, so the sanitiser is the second answer rather than the only one. |
| `custom-values.ts` | The one way a `custom jsonb` value is written: reads the brand's definitions inside the request's transaction, builds the Zod schema from them (`@helpdock/schemas/custom-fields`) and turns a failure into a 400. Three callers — `POST /tickets`, `PATCH /tickets/:id`, and the contact and account patches. |
| `ticket-tags.ts` | Reading and replacing a ticket's chips. Plain functions over the caller's transaction, as `tickets/ticket-activity.ts` is, so the ticket service uses them without depending on this module. `tagsOfTickets` reads a whole page in one query. |
| `custom-fields.repository.ts` | The only jsonb work in the app: counting rows that carry a value or an option, and clearing an option from them under `force`. |
| `audit.ts` | Definition changes go to `audit_log`; putting a tag on a ticket goes to `ticket_activity`, because that one is part of the ticket and is purged with it. |

Three things are easy to get wrong here:

- **A key never moves.** `customFieldUpdateRequestSchema` has no `key` field at
  all, rather than a branch that refuses one: a request that cannot name it is a
  request the api never has to say no to.
- **A refusal is a code.** `field-in-use` and `option-in-use` join the five
  `TicketingRefusal` values M1-01 introduced, so the screen picks the sentence.
- **`TicketingModule.forRoot()` is built once**, by `AppModule`, and imported by
  `TicketsModule` as a value — the same trick `AuthModule` uses. A second call
  would be a second module to Nest and its controllers would register twice.

M1-10 added one thing to the message path: `POST …/messages` accepts
`attachmentIds`, and `TicketsService` calls `linkAttachmentsToMessage` from
`src/media/link.ts` inside the same transaction as the insert. The rules it
enforces are the media pipeline's; what stays here is turning a refusal into a
status code.

## Attachments

`src/media/` holds M1-10: presign, confirm, download, delete, and the
`media.process` worker. What the pipeline does and what the endpoints answer is
[the attachments guide](../../docs/guides/attachments.md); what follows is for
somebody reading the code.

| File | |
|---|---|
| `storage.ts` | The bucket. It lives in `apps/api` rather than in `packages/channels` because a bucket is not a channel and nothing outside this process needs one in M1; the interface is the whole surface, so M5's public image prefix can move it to a package of its own by renaming the file. |
| `keys.ts` | `brands/<brandId>/tickets/<ticketId>/<attachmentId>/<variant>`. Every segment is a uuid or a name from a closed set, and a segment that is not a uuid throws — so nothing a caller typed can reach the bucket's namespace. |
| `magic-bytes.ts` | The sniffer, and [ADR 0009](../../docs/decisions/0009-magic-byte-sniffing.md) for why it is a table here rather than `file-type`. |
| `content-policy.ts` | The brand's policy and the one function both the presign endpoint and the worker measure an upload against, so the two cannot drift. |
| `variants.ts` | What each kind is turned into, and the numbers ARCHITECTURE §9 fixes. |
| `process.job.ts` | The worker. A verdict about the bytes marks the row and returns; only infrastructure throws and is retried. |
| `ffmpeg.ts` | `execFile` with an argument array and no shell, a deadline on every call, and `-protocol_whitelist file` so a crafted "voice note" cannot make the worker fetch a URL. |
| `link.ts` | `linkAttachmentsToMessage`, called from `tickets/tickets.service.ts`. |

Four things are easy to get wrong here and are written down where they happen:

- **A rejection at confirm is answered, not thrown.** The request runs inside
  the tenant transaction, so an exception rolls the `rejected` row back and
  leaves the attachment at `pending` with nothing saying why.
- **The uploaded object is deleted for an image and a voice note** unless the
  brand keeps originals. Re-encoding is what disarms a polyglot; keeping the
  original keeps exactly what it exists to get rid of.
- **`reject_reason` is a key and never a tool's stderr**, which quotes the
  worker's paths and the binaries on it.
- **`media.process` holds its transaction for the length of the conversion**,
  because `createWorker` claims the receipt before the handler runs. Every step
  has a deadline for that reason, and `MEDIA_BUDGET_MS` is their sum.

## Observability

`src/observability/` holds M0-10: the metrics registry and the `/metrics`
endpoint, the 15-second sampler behind the gauges, and the System page's read.
`src/logging/logger.ts` is the pino logger every line goes through.

What an operator needs to know — the log fields, why `/metrics` answers 404 to a
stranger, which OpenTelemetry variables turn tracing on, and what the System
page's numbers mean — is in the
[operations guide](../../docs/guides/operations.md).

Two shapes worth knowing while reading the code:

- **`/metrics` is `@Public()` but not public.** `MetricsGuard` decides, on the
  socket's peer address (never `x-forwarded-for`) or on `METRICS_TOKEN`. A
  request that arrived through a trusted proxy gets no credit for the peer
  address at all — behind a proxy that address is the proxy's — so it must carry
  the token.
- **The outbox backlog and the migration count are not queried by the request.**
  The relay reports the backlog to Redis because an install-scope transaction
  cannot see another brand's `outbox` rows; the migration count is read at boot
  by the owner connection because the runtime role is not granted the `drizzle`
  schema. `src/observability/boot-facts.ts` is what carries the second.

## Errors

Every failure answers with the same body:

```json
{ "error": { "code": "forbidden", "message": "…", "requestId": "0199f4b2-…" } }
```

A failed input schema adds `fields`, each with the path as the request carried
it. A failed sign-in adds `error.auth`, which is the code the sign-in screens
turn into a sentence. An unexpected error answers `internal_error` with a fixed message — the
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
pnpm --filter @helpdock/api test           # unit
pnpm test:integration                      # Testcontainers: real Postgres and Redis
pnpm --filter @helpdock/api test:coverage  # both, with the 90 % line gate for src/
```

The gate is measured across both runs because half of this app — the controller,
the guards, the request lifecycle — is only reached over HTTP. A number from the
unit run alone would say more about where the tests are than about what is
covered.

`src/*.test.ts` need nothing installed. `src/api.integration.test.ts` starts
`pgvector/pgvector:pg17` and `redis:7-alpine`, boots the real app against them
and runs the negative suite of [DOMAIN-RULES
§1.6](../../docs/planning/DOMAIN-RULES.md#16-required-negative-tests) at the HTTP
layer. `src/realtime/realtime.integration.test.ts` starts *two* replicas on two
ports over one Redis, which is the only way to prove that a room spans them and
that a sign-out on one closes a socket on the other. Both skip themselves, and
say so, when Docker is not running.

`src/observability/observability.integration.test.ts` boots the same stack again
to prove `/metrics` is served and guarded and that the System page's read
reports a live install.

`src/install/setup.integration.test.ts` adds a third container,
`axllent/mailpit`, and takes a genuinely empty install through all four wizard
steps — including Nodemailer delivering the test message to that mail server and
the advisory lock turning two simultaneous first accounts into one.

`src/testing/` is test scaffolding — an `ExecutionContext` double and a probe
controller that reads the session settings back from inside a handler.
`tsconfig.json` keeps it out of the build, and the app mounts the controller
only when a test passes it as an extra controller.

## Known gaps

- **`on_unassign` is not implemented.** Deactivating somebody, or narrowing what
  they may see, leaves their tickets assigned to them. `staff/lifecycle-hooks.ts`
  names the calls M1 fills in.
- **Own-account actions write no `audit_log` row.** `audit_log` is keyed on
  `brand_id` and a password change belongs to a person; the reasoning is at the
  top of `staff/account.service.ts` and in the guide. They are logged instead.
- `NoopBrandResolver` resolves every host to nothing. `brand_domains` exists
  from M0-09, for the on-demand TLS check; M5 adds the rows, their verification,
  and the resolver that turns a `Host` header into a brand. Until it does, every
  brand in a session is shown with the install's own host.
- Input validation no longer depends on `emitDecoratorMetadata` (M0-11, issue
  #36): every `@Param`, `@Query` and `@Body` names its schema on the parameter,
  so the routes validate under `tsc` and under esbuild alike, and
  `pnpm check:validation` fails the build for one that does not. What a schema
  *allows* is still a judgement: `oauthProviderParamSchema` bounds the
  `:provider` segment rather than listing the providers, because both OAuth
  routes answer a browser with a redirect and a pipe can only answer with a
  body.
- The `/widget` namespace is M4. `src/realtime/` is the whole gateway; [the
  realtime guide](../../docs/guides/realtime.md) is what to read before adding
  an event to it.
- **A department move out of the actor's own scope runs in a widened window.**
  DOMAIN-RULES §1.2 allows it — it is how escalation works — and the `WITH
  CHECK` half of the department policy does not. Rather than a second policy
  shape or a `SECURITY DEFINER` function, the `UPDATE`, the trigger that follows
  the thread and the activity row all run inside `withWidenedDepartments`
  (`packages/db/src/tenant.ts`): the brand is never widened, the scope is
  restored in a `finally`, and the audit row is written *outside* the window
  because `audit_log` does not need it. Afterwards the ticket answers 404 to the
  actor who moved it.
- **`tickets.contact_id` and `tickets.team_id` carry no foreign key** until
  M1-04 and M1-01 create the tables they point at. The columns are here so that
  neither milestone has to backfill every row already written.
- **A tag's ticket count is "tickets you can see".** `ticket_tags` is
  department-scoped, so a Team Leader restricted to two departments reads the
  count of those two. Reaching past the department policy to count rows the
  reader may not know exist would not be an improvement — so instead, the two
  changes that *act* on such a count (moving a custom field's type, and forcing
  an option removal) are refused to anybody whose scope is not every
  department.
- **`ticket_templates.usage_count` is the whole record of which tickets came
  from a template.** There is no `tickets.template_id`: the number is what the
  list prints, and a column on `tickets` would be read by nothing else in v1.
- There is no instrumentation for the `postgres` driver or for BullMQ, so
  neither appears as its own span. Both gaps are explained in the
  [operations guide](../../docs/guides/operations.md#what-is-instrumented).
- The System page's Worker card and the three outbox metrics read the relay's
  heartbeat, so they say "not reporting" whenever no `APP_ROLE=worker` replica
  is running. That is the state they are built to show.
