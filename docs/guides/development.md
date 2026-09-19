# Development

How to install, build, test and extend the Helpdock monorepo. Contribution rules are in [CONTRIBUTING.md](../../CONTRIBUTING.md); the definition of done is in [AGENTS.md](../../AGENTS.md).

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 24 LTS | Pinned in `.nvmrc` and `.node-version`. `nvm use` or `fnm use` picks it up. |
| pnpm | 12 | Pinned in `packageManager`. `corepack enable pnpm` installs the right one. |
| Docker | any recent version, with the Compose plugin | For the integration tests and the dev stack. The unit tests and the build run without it. |

No database to install by hand: the integration tests start the services they
need in containers themselves, and [the dev Compose stack](#docker) starts
Postgres, Redis, MinIO and Mailpit for the dev loop.

## Install

```bash
pnpm install
```

`packageManager` in the root `package.json` pins pnpm, and pnpm switches to that version itself. `engines` records the supported Node range but pnpm does not enforce it, so check `node --version` if something behaves oddly.

## Scripts

Run these from the repository root.

| Script | What it does |
|---|---|
| `pnpm build` | `turbo run build` — compiles each workspace with `tsc` into its own `dist/`. |
| `pnpm typecheck` | `turbo run typecheck` for workspace sources, then a root `tsc --noEmit` that covers the test files and `scripts/`. |
| `pnpm lint` | `biome check .` — lint, format and import order for the whole repository in one pass. |
| `pnpm lint:fix` | The same, applying the safe fixes. |
| `pnpm format` | Rewrites formatting only. `pnpm format:check` reports without writing. |
| `pnpm test` | Unit tests for every workspace in one run, with the coverage gate. |
| `pnpm test:integration` | The Testcontainers suites. Needs Docker; skips itself without it. |
| `pnpm test:watch` | Vitest in watch mode. |
| `pnpm check:boundaries` | Enforces the app import rule described below. |
| `pnpm check:routes` | Fails when a controller handler declares neither `@Requires`, `@Authenticated` nor `@Public`. |
| `pnpm --filter @helpdock/api seed:dev` | Creates the development install: one brand, one admin, a published password. Refuses `NODE_ENV=production`. |

For a single workspace, use the per-package scripts through pnpm or Turborepo:

```bash
pnpm --filter @helpdock/db test
pnpm turbo run typecheck --filter=@helpdock/api
```

## Layout

```
apps/          api, admin, helpcenter, widget
packages/      db, schemas, ai, channels, ui, i18n, config, net, jobs
scripts/       repository checks run by CI
docs/          planning, guides, decisions
```

Every workspace is `@helpdock/<directory name>`, private, ESM (`"type": "module"`), and has the same four scripts: `build`, `typecheck`, `lint`, `test`. A workspace is a placeholder until its own deliverable lands — it exports a `PACKAGE_NAME` constant and has one test asserting it matches `package.json`, which is enough to prove the pipeline runs end to end. `apps/admin` adds `dev`, `e2e` and `e2e:baselines`, and its `build` is `vite build` rather than `tsc`; see [Admin app](#admin-app).

Seven packages and two apps are real so far. `packages/config` is the configuration loader; see [Configuration](#configuration). `packages/db` is the schema, the migrations and the row-level security; see [Database](#database). `packages/net` is the SSRF-safe outbound HTTP client and URL policy from M0-15, which everything that fetches a user-supplied URL goes through; see [`packages/net/README.md`](../../packages/net/README.md). `packages/jobs` is the queue names, job schemas, outbox relay and idempotent consumers from M0-14; see [Jobs and outbox](#jobs-and-outbox). `packages/schemas` holds the Zod schemas the api, admin and widget share; every request and response shape belongs there rather than in the app that happens to need it first. `packages/ui` and `packages/i18n` hold the design system and the catalogs; see [UI and i18n](#ui-and-i18n). `apps/api` is the NestJS application from M0-04, which carries the request context, the guards and the tenant transaction; see [API](#api). `apps/admin` is the admin SPA from M0-07; see [Admin app](#admin-app).

TypeScript settings live in `tsconfig.base.json` (strict, `nodenext` modules, `verbatimModuleSyntax`). A workspace `tsconfig.json` only adds `rootDir`, `outDir` and which files to include. Because module resolution is `nodenext`, relative imports carry the `.js` extension even when the file on disk is `.ts`.

## Adding a package

1. Create `packages/<name>/` with `src/index.ts` and `src/index.test.ts`.
2. Add `package.json`: name `@helpdock/<name>`, `"private": true`, `"type": "module"`, an `exports` map pointing at `dist/`, and the four scripts. Copy an existing package.
3. Add `tsconfig.json` extending `../../tsconfig.base.json`.
4. Run `pnpm install` so the workspace is linked.
5. Check that `pnpm-lock.yaml` gained an `importers` entry for it, and commit the change.

Vitest discovers the new workspace through the `packages/*` glob in `vitest.config.ts`, and Turborepo through `pnpm-workspace.yaml`. Neither file needs editing. The coverage gate starts applying to it immediately.

Step 5 is not busywork. CI installs with `--frozen-lockfile`, which refuses a workspace that has no `importers` entry — and when the new package has no dependencies of its own, a plain `pnpm install` does not add one, nor does `pnpm install --lockfile-only` despite what the error message suggests. Only a clean resolve writes it:

```bash
rm -rf node_modules pnpm-lock.yaml && pnpm install
```

That produces a one-line diff (`packages/<name>: {}`) and no version drift, because every dependency is pinned exactly. Confirm with `pnpm install --frozen-lockfile` before pushing; it fails locally exactly as it does in CI.

A package that imports another workspace package adds a `resolve.alias` for it in its own `vitest.config.ts`, as `packages/db` does for `@helpdock/config`. Without it the `exports` map sends the test to the other package's last build instead of to its source.

Dependencies must come from the stack table in [ARCHITECTURE.md §1](../planning/ARCHITECTURE.md); anything else needs an ADR first.

## The app import rule

`apps/*` never import each other. They share code only through `packages/*` (ARCHITECTURE §2).

`scripts/check-app-boundaries.ts` enforces it and runs in CI. It scans every source file under `apps/` and fails on two things: importing another app by workspace name (`@helpdock/widget` from `apps/api`), and reaching into another app with a relative path (`../../widget/src/…`). Imports of `packages/*`, of external modules, and within the same app all pass.

It is a lexical scan rather than a parse, so a module specifier written inside a string or a comment can trigger a false positive. That fails loudly, which is the right direction for a boundary check.

## Configuration

Configuration has two layers, both typed and both validated with Zod
([ARCHITECTURE §4](../planning/ARCHITECTURE.md#4-configuration-model)). They live in
`packages/config`.

### The bootstrap environment

`.env` holds what the process needs before it can read the database: the database
and Redis URLs, the S3 credentials, the master key, the public URL, the role and
the port. [`.env.example`](../../.env.example) documents every one of them; copy
it to `.env` and fill it in; `env.test.ts` fails if the two ever drift apart.

```ts
import { loadEnv } from '@helpdock/config';

const env = loadEnv(); // reads process.env; pass a record to test it
```

`loadEnv` returns a frozen, typed object, or throws one `EnvValidationError`
naming every key that is wrong and what it expected. It never quotes the value:
these keys hold the master key and the S3 credentials. An empty value counts as
unset, so an optional key can stay blank in the file.

`APP_MASTER_KEY` is 32 bytes of base64 (`openssl rand -base64 32`). Every secret
setting is encrypted under it with AES-256-GCM and stored as
`v1.<keyId>.<iv>.<ciphertext>.<tag>`. The key id is the first 8 hex characters of
`sha256(key)`, so a row records which key generation wrote it. During a rotation
`APP_MASTER_KEY_PREVIOUS` holds the old key: both generations stay readable, and
`rotateSecret` re-encrypts a value under the current key
([DOMAIN-RULES §10](../planning/DOMAIN-RULES.md#10-operations-and-recovery)).

### The settings registry

Everything else — SMTP, OAuth client ids, CAPTCHA keys, feature toggles — is a
key in the registry in `packages/config/src/registry.ts`. Each entry declares its
Zod schema, its default, whether it is a secret, whether it is install-wide or
per-brand, a description, and the environment variable that can override it.

```ts
import {
  createKeyring,
  createSettings,
  InMemorySettingsStore,
  LocalInvalidation,
} from '@helpdock/config';

const settings = createSettings({
  store: new InMemorySettingsStore(), // PostgresSettingsStore in @helpdock/db for a real install
  keyring: createKeyring(env),
  invalidation: new LocalInvalidation(),
});

await settings.get('smtp.port'); // 587, typed as number
await settings.set('smtp.host', 'smtp.example.com', { updatedBy: userId });
```

A value resolves in one order: **environment override → stored value →
default**. Secret keys are decrypted on the way out and encrypted on the way in;
`getAll()` leaves them out entirely unless it is called with
`{ includeSecrets: true }`, which is for server-side use only and must never
reach a response DTO.

Reading a secret whose master key is gone fails with a `SecretDecryptionError`
rather than falling back to the default, because an OAuth client silently running
on an empty secret is worse than one that refuses to start.

Resolved values are cached in process. `set` publishes the key on the
invalidation channel — `helpdock:settings:invalidate` under `RedisInvalidation` —
every replica drops it from its cache and reads it again on the next `get`, so an
admin change applies everywhere within a second and without a restart.
`LocalInvalidation` does the same in one process, for tests and for an install
running a single replica.

### Locking a setting from the environment

Setting a registry key in the environment pins it. The name is `HD_` plus the key
in upper snake case — `smtp.host` is `HD_SMTP_HOST`, `oauth.google.clientId` is
`HD_OAUTH_GOOGLE_CLIENT_ID` — and a definition may name its own variable instead.

A pinned key wins over the database, `isLockedByEnv(key)` returns `true` so admin
can show it as "set by environment", and `set` rejects it with a
`SettingLockedError`. An override that does not satisfy its schema stops the
process at construction rather than being ignored.

### Adding a setting

1. Add a `defineSetting({ … })` entry to `SETTING_DEFINITIONS`. The key, schema,
   default, `secret`, `scope` and description are all required; `envKey` is
   derived unless you give one.
2. Nothing else needs a type: `SettingKey`, `SettingValues` and `settingsSchema`
   are derived from the list, so `get` and `set` are typed immediately.
3. Add or extend a test in `registry.test.ts` if the key carries a rule worth
   stating, such as a bound or an enum.
4. Document it wherever operators will look for it. Bootstrap keys go in
   `.env.example`; registry keys are described in the registry itself and surface
   in admin.

## UI and i18n

Everything a screen looks like and every word it says come from two packages, so
the admin app, the help center and the widget stay one product.

[`packages/ui`](../../packages/ui/README.md) is
[DESIGN.md](../../DESIGN.md) in code: `tokens.json` is the single source of truth
for colour, type, spacing, radius, elevation and motion, and the package builds
the MUI theme, the light and dark `--hd-*` custom properties the widget uses, the
two Emotion caches that make RTL work, and `resolveBrandTheme` for the per-brand
accent, ramp and radius. Its contrast suite asserts every pair DESIGN §2.2 claims,
in both modes, so a colour change that breaks AA fails CI. The self-hosted IBM
Plex woff2 files live there too, under a 1.5 MB budget.

```ts
import { createHelpdockTheme, createRtlCache, tokens } from '@helpdock/ui';
```

[`packages/i18n`](../../packages/i18n/README.md) holds the `en` and `ar` catalogs,
one namespace per screen area, and `createI18n` plus the `dir(lng)` helper that
decides text direction everywhere. No user-facing string is written in an app —
labels, hints, errors and `aria-label`s all go through `t()`. A key present in one
language and missing in the other fails the parity test, and every plural key
carries all six Arabic forms.

```ts
import { createI18n, dir } from '@helpdock/i18n';
```

Both packages compile with `rootDir` at the package root rather than `src/`,
because `tokens.json` and `locales/` sit beside the source and have to reach
`dist/`. Their `exports` maps therefore point at `./dist/src/index.js`.

Before changing either, read DESIGN.md. A new colour, font size, radius or
spacing value needs a change there first, and a new component needs a DESIGN §6
entry in the same pull request.

## Database

The schema, the migrations and the row-level security policies live in
`packages/db`. Its [README](../../packages/db/README.md) is the reference; this
is what you need to run it.

### The two connection URLs

Helpdock connects to Postgres as two different roles ([DOMAIN-RULES
§1.5](../planning/DOMAIN-RULES.md#1-authorization)):

| Key | Role | Used for |
|---|---|---|
| `DATABASE_MIGRATION_URL` | the owner | migrations only, at api boot |
| `DATABASE_URL` | `helpdock_app` | every runtime query |

`helpdock_app` is `NOSUPERUSER NOBYPASSRLS`, owns nothing, and may only read and
write rows. The first migration creates it, with the password from
`DATABASE_URL`, so a fresh database needs only the owner to exist and to have
`CREATEROLE`. `assertRuntimeRoleIsSafe(db)` throws rather than let a process
serve on a connection that can bypass row-level security; api boot calls it from
M0-04 onwards.

### Running migrations

Migrations run from the application, not from a CLI. Api boot calls this from
M0-04 onwards; until then it is what the integration tests call:

```ts
import { appRolePasswordFromUrl, runMigrations } from '@helpdock/db';

const { applied } = await runMigrations({
  migrationUrl: env.DATABASE_MIGRATION_URL,
  appRolePassword: appRolePasswordFromUrl(env.DATABASE_URL),
});
```

It takes a Postgres advisory lock first, so several api replicas can start
together and the migrations still run once. `drizzle-kit migrate` and
`drizzle-kit push` are deliberately not part of any workflow.

### Changing the schema

```bash
pnpm --filter @helpdock/db gen:migration   # drizzle-kit generate from src/schema
pnpm --filter @helpdock/db gen:rls         # append the missing policies to that migration
```

Both write into `packages/db/drizzle/`, and both belong in the same commit as
the schema change. A new tenant table also has to be added to `TENANT_TABLES`
and to the negative suite in `rls.integration.test.ts`; unit tests fail until it
is, which is how [DOMAIN-RULES
§1.6](../planning/DOMAIN-RULES.md#1-authorization) stays true.

### Integration tests with Postgres

`packages/db/src/*.integration.test.ts` start `pgvector/pgvector:pg17` through
Testcontainers, apply the migrations and run against the real thing, as the real
runtime role:

```bash
pnpm test:integration packages/db
```

The first run pulls the image, which can take a few minutes; pull it in advance
with `docker pull pgvector/pgvector:pg17` if the suite times out. No local
Postgres is needed, and without Docker the suites skip themselves.

## Jobs and outbox

Queues, job schemas, the outbox relay and the consumer wrapper live in
`packages/jobs`. Its [README](../../packages/jobs/README.md) is the reference;
this is the part you need before writing a feature.

One rule governs everything here
([DOMAIN-RULES §6](../planning/DOMAIN-RULES.md#6-transactional-outbox)): **a side
effect is enqueued in the same transaction as the change that causes it, and
executed at least once, idempotently.** Sending an email, calling an LLM,
delivering a webhook, indexing knowledge, processing media — all of them start as
a row in `outbox`.

### Asking for a side effect

Never call `queue.add` from a request handler, a service or an event listener.
Write an outbox row through the transaction you are already in:

```ts
import { enqueueOutbox } from '@helpdock/jobs';

await withTenant(db, context, async (tx) => {
  const ticket = await tx.insert(tickets).values(…).returning();
  await enqueueOutbox(tx, {
    brandId,
    event: 'ticket.replied',
    payload: { ticketId: ticket.id },
  });
});
```

If the transaction rolls back, the row was never there and no job exists. If it
commits, the relay publishes the row to BullMQ with `jobId = outbox.id` and
stamps `published_at` in one transaction, so a crash costs at most a duplicate
job and never a lost one.

### Handling it

Register a handler for the event and let the dispatcher route to it. The handler
runs inside the brand's transaction, next to the `job_receipts` claim that makes
the delivery exactly-once:

```ts
import { registerEventHandler } from '@helpdock/jobs';

registerEventHandler('ticket.replied', async ({ brandId, payload, tx }) => {
  await tx.insert(notifications).values({ brandId, … });
});
```

Throwing asks BullMQ for a retry and rolls back both the writes and the receipt.
Returning commits both, so every later delivery of the same key stops at the
receipt. A payload that fails its Zod schema is not retried at all: it goes
straight to the failed set with the issues in `job.failedReason`.

### Adding a job

Jobs are declared in `packages/jobs/src/jobs.ts` with a name, a queue from
[ARCHITECTURE §13](../planning/ARCHITECTURE.md#13-background-jobs-bullmq-queues),
a Zod payload schema that includes `brandId`, and a retry profile. The schema is
used on enqueue and on consume, so the two cannot drift.

### Running it

The relay and the consumers run in the worker, which is the same image with
`APP_ROLE=worker`. The README's "What the worker host wires at boot" shows the
order: register handlers, start the workers, then start the relay.

The suites in `packages/jobs/src/*.integration.test.ts` start a real Postgres and
a real Redis and prove the guarantees, including a relay killed between the `add`
and the commit:

```bash
pnpm test:integration packages/jobs
```

## Admin app

[`apps/admin`](../../apps/admin/README.md) is the Vite + React SPA agents and
administrators work in. It is the first app with screens, so it is also where
the browser tests live.

```bash
pnpm build                          # once, so the packages have a dist/
pnpm --filter @helpdock/admin dev   # http://localhost:5273
```

The app talks to the api through an `AuthApi` interface with two adapters.
`VITE_AUTH_API` picks one — `mock`, the in-memory fixture, by default in dev and
test; `http`, the real service, in a production build — and
[`apps/admin/.env.example`](../../apps/admin/.env.example) documents it. The
fixture's credentials are in the app's README; running against a real api is in
[the authentication guide](authentication.md#the-development-install).

`apps/admin` owns its whole TypeScript program, including its tests and its
Playwright specs, because they need `jsx`, `dom` types and bundler resolution
that the Node-shaped root config does not have. It is therefore excluded from
the root `tsc --noEmit`, and `pnpm --filter @helpdock/admin typecheck` covers it
instead; `pnpm typecheck` runs both.

### Browser tests

```bash
pnpm --filter @helpdock/admin e2e             # both locales, against the fixture
pnpm --filter @helpdock/admin e2e:api         # against a real api; needs Docker
pnpm --filter @helpdock/admin e2e:screenshots # the tagged screenshot suite
pnpm --filter @helpdock/admin e2e:baselines   # regenerate Linux screenshots
```

Playwright runs every spec twice, once in `en` and once in `ar`, as two projects
that differ only in the locale they seed into `localStorage`. An RTL layout is a
different layout (DESIGN §7), so a spec that passes in one direction proves
nothing about the other. `@axe-core/playwright` scans each screen against WCAG
2.1 A and AA and the suite fails on any violation.

Screenshot baselines belong under `apps/admin/e2e/__screenshots__/<locale>/` as
Linux pixels, because CI runs on `ubuntu-latest`. They are not committed yet, so
that spec is tagged `@screenshot` and excluded from `pnpm e2e`; Playwright fails
a comparison whose baseline is missing rather than skipping it, so leaving it in
would turn CI red for a reason unrelated to the code. `e2e:baselines` generates
them from a macOS host by running the browsers inside
`mcr.microsoft.com/playwright` against a dev server on the host; the admin
README explains why the server stays outside the container and how to switch the
suite back on.

`e2e:api` is a second config: it starts Postgres and Redis with Testcontainers,
runs the built api as its own process, seeds a known account, and drives the
same screens with `VITE_AUTH_API=http`. It needs a `pnpm build` first, and it
skips itself with a message when Docker is not running.

CI installs Chromium with `pnpm exec playwright install --with-deps chromium`,
caches it by the Playwright version in the lockfile, and runs both suites as
steps of the `ci` job after the build.

## Docker

`docker/` holds the image and the Compose stack. Operators read
[the install guide](install.md); this is what the stack is for while developing.

```
docker/Dockerfile              one image, two roles (APP_ROLE=api|worker)
docker/docker-compose.yml      the production stack of ARCHITECTURE §17
docker/docker-compose.dev.yml  local overrides: build here, publish ports
docker/caddy/Caddyfile         host routing and TLS
docker/postgres/init.sql       creates the helpdock_app role on first boot
```

### Infrastructure for the dev loop

The usual loop runs the apps on the host with `pnpm dev` and only the services
in containers:

```bash
cd docker
cp ../.env.example .env         # fill in APP_MASTER_KEY and the passwords
docker compose -f docker-compose.yml -f docker-compose.dev.yml \
  --profile dev up -d postgres redis minio minio-bucket mailpit
```

That publishes Postgres on 5432, Redis on 6379, MinIO on 9000 (console 9001) and
Mailpit on 1025 (inbox at http://localhost:8025). Point the repository-root
`.env` at `localhost` for each of them, as [API](#api) below shows. Mailpit is
there for M2's outbound email and does nothing until then.

Nothing is bind-mounted from the source tree. The containers run what the image
contains; the code you are editing runs on the host.

### The whole stack from your working copy

```bash
cd docker
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
curl -s localhost:3000/health
```

This builds `docker/Dockerfile` from the repository root and runs one api
replica on `127.0.0.1:3000` plus a worker. Caddy is behind the `proxy` profile
and stays down, because it would try to get certificates for hostnames that do
not resolve on your machine.

`scripts/compose-smoke.sh` is the same thing as a check: it writes a throwaway
`docker/.env`, waits for the api to be healthy, and asserts that `/health` and
`/ready` answer 200, that `/` returns the admin build, that an unverified domain
gets no certificate, and that `/api/me` still answers 401. CI runs it after
building the image, and so can you:

```bash
docker build -f docker/Dockerfile -t ghcr.io/docker-hunterpedia/helpdock:ci .
HELPDOCK_VERSION=ci ./scripts/compose-smoke.sh
```

### The image

Three stages: `deps` installs the whole workspace from the lockfile, `build`
runs `pnpm build` and then `pnpm deploy --filter @helpdock/api --prod` into
`/out`, and `runtime` takes that plus `apps/admin/dist` into a `node:24-bookworm-slim`
running as the non-root `helpdock` user. The entry point is
`node dist/main.js` for both roles; `APP_ROLE` decides which one boots.

Two things worth knowing before changing it:

- **The admin build lives at `/app/admin`**, which is the default of
  `ADMIN_DIST_DIR`. The api serves it at `/` and rewrites the install meta tags
  per request; see [Serving the admin SPA](#serving-the-admin-spa).
- **`pnpm fetch` runs with `trustLockfile`**, so the image build does not repeat
  pnpm's supply-chain verification of a lockfile that `pnpm install` has already
  verified on the developer's machine and in CI. It resolves nothing of its own;
  a change to the lockfile still goes through a verified install first.

## API

`apps/api` is the NestJS application. Its
[README](../../apps/api/README.md) is the reference for the boot sequence, the
request lifecycle and how to add a route; this is how to run it.

Start Postgres and Redis with [the dev Compose stack](#docker), then copy
`.env.example` to `.env` at the repository root and set at least:

```bash
APP_URL=http://localhost:3000
APP_ROLE=api
APP_MASTER_KEY=$(openssl rand -base64 32)
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://helpdock_app:app-password@localhost:5432/helpdock
DATABASE_MIGRATION_URL=postgres://helpdock_owner:owner-password@localhost:5432/helpdock
REDIS_URL=redis://localhost:6379
```

`DATABASE_URL` must name `helpdock_app`; the first migration creates that role
with the password you put there. The `S3_*` keys are required to boot but
nothing reads them until M1, so any non-empty values will do for now.

The api is compiled before it runs: Node's built-in type stripping does not
transform decorators, and NestJS is built on them. So a dev loop is two
terminals — one compiling, one running what it compiled.

```bash
pnpm --filter @helpdock/api dev:build   # tsc --watch into dist/
pnpm --filter @helpdock/api dev         # node --watch dist/main.js, reads ../../.env
```

The first start runs the migrations, verifies that the runtime role cannot
bypass row-level security, and logs both. `GET /health` and `GET /ready` answer
without a session.

### Authenticating locally

Sign in the way a person does. `pnpm --filter @helpdock/api seed:dev` creates one
brand and one install admin with a password that is written down in [the
authentication guide](authentication.md#the-development-install), and

```bash
curl -s -X POST localhost:3000/api/auth/sign-in \
  -H 'content-type: application/json' \
  -d '{"email":"admin@helpdock.test","password":"helpdock dev password"}'
```

answers with an access token to send as `Authorization: Bearer …`.

To exercise the tenancy plumbing without a session — a different principal
shape, an api key, a worker — set

```bash
HD_DEV_PRINCIPAL_HEADER=1
```

in `.env` and send a whole principal as JSON in the `x-hd-dev-principal` header
instead. It is refused when `NODE_ENV=production`, and boot logs a warning
whenever it is on, because anyone who can reach the port can name themselves an
install admin.

```bash
curl -s localhost:3000/api/me \
  -H 'x-hd-dev-principal: {"type":"staff","id":"0199f4b2-6a91-7c27-9a1f-000000000001","brands":{},"installAdmin":true}'
```

The flag replaces the session resolver rather than adding to it: a process that
trusts the header trusts it for every request.

### Serving the admin SPA

With `ADMIN_DIST_DIR` pointing at a built `apps/admin/dist`, the api serves the
SPA at `/`: a request for a file in the build gets that file, and anything else
that is not under `/api` gets `index.html` so the client router can take over. A
missing endpoint under `/api` stays a JSON 404, because handing a `fetch` a page
where it asked for data hides the error rather than reporting it.

`index.html` is sent with `no-store` and its two `helpdock:*` meta tags rewritten
from this install's brands; everything under `assets/` is content-hashed by Vite
and sent as `immutable` for a year. The image sets `ADMIN_DIST_DIR=/app/admin`;
outside the image it defaults to that same path, so a dev api simply logs that
it found no build and serves `/api` alone.

The dev loop does not use any of this: `pnpm --filter @helpdock/admin dev` runs
Vite on 5273 and proxies `/api` to `http://localhost:3000`, so the browser sees
one origin and a session cookie works. `VITE_API_ORIGIN` points the proxy
somewhere else.

### The worker role

`APP_ROLE=worker` boots the same process without the HTTP listener and without
running migrations: a worker waits for an `APP_ROLE=api` replica to migrate,
polling for up to 60 seconds. It then registers the `outbox.event` consumer and
starts the outbox relay, in that order, and shuts them down in the reverse one
(`apps/api/src/worker/start-worker.ts`, following
[`packages/jobs/README.md`](../../packages/jobs/README.md)). The relay reports
each cycle to Redis, which is what the System page's Worker card and the
`outbox_relay_up` metric read; with no worker running, both say so.

```bash
cd docker && docker compose -f docker-compose.yml -f docker-compose.dev.yml \
  up -d --build worker
docker compose logs -f worker
```

### Watching it run

Logs are pino JSON on stdout. With `NODE_ENV=development` they are prettified
instead, so a dev loop is readable without a pipe. `LOG_LEVEL` sets the level;
`info` is one line per request.

`GET /metrics` answers from `localhost`, so a local Prometheus or a plain `curl`
reaches it with no token:

```bash
curl -s localhost:3000/metrics | head
```

Tracing is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set. With a collector
running, set it in `.env` and spans go there; the `dev` script already preloads
the SDK with `--import`.

The [operations guide](operations.md) is the reference for all three, and for
what the admin System page shows.
>>>>>>> 5b72ee5 (feat: observability and the admin System page (M0-10))

### Routes declare their permission

Every controller handler carries `@Requires(permission)`, `@Authenticated()` or
`@Public()`. The permission guard refuses a handler that carries none, and
`pnpm check:routes` fails the build for one
([DOMAIN-RULES §1.3](../planning/DOMAIN-RULES.md#1-authorization)). The check is
a token scan over `apps/*/src` using TypeScript's own scanner, so a decorator
name in a comment or a string is not mistaken for a declaration.

§1.3 says "per route **or event**", so a `@SubscribeMessage` handler on a
`@WebSocketGateway` is held to the same rule by the same guard and the same
check.

### Realtime

The api serves a Socket.IO `/staff` namespace on `/socket.io`, and the admin
connects to it as soon as there is a session. Nothing extra has to be
configured: `APP_URL` decides the allowed origin and `REDIS_URL` the adapter's
connections. [The realtime guide](realtime.md) is the contract — namespaces,
the handshake, rooms and their permission rule, presence, revocation, and what
to do to add an event.

## Tests

Unit tests are Vitest, colocated as `src/**/*.test.ts`. `pnpm test` runs one Vitest process across all workspaces, defined as projects in the root `vitest.config.ts`.

Coverage uses `@vitest/coverage-v8` and gates at **80 % of lines across `packages/*`** (ARCHITECTURE §15). The UI apps are outside that gate and are covered by Playwright instead. `apps/api` has no UI, so it has a gate of its own at **90 % of lines across `apps/api/src`**, run by `pnpm --filter @helpdock/api test:coverage`: that command runs the unit *and* the integration suites together, because half of the app is only reached over HTTP and a number from the unit run alone would say more about where the tests are than about what is covered. `apps/admin` gates at **85 % of lines**, run by `pnpm --filter @helpdock/admin test:coverage`; its layout is Playwright's to check, its logic is Vitest's.

### Integration tests

Anything that touches Postgres, Redis, a queue or a channel adapter is tested against the real thing, started by [Testcontainers](https://node.testcontainers.org/). These files are named `*.integration.test.ts`, sit beside the code they cover, and belong to a Vitest project called `integration`:

```bash
pnpm test:integration                                  # the whole project
pnpm test:integration packages/config                  # one directory
pnpm test:integration apps/api                         # the api against real Postgres and Redis
```

One thing they do not cover: input validation. The global `ZodValidationPipe`
finds a DTO's schema through `design:paramtypes`, which `tsc` emits and esbuild —
which Vitest transforms with — does not. The routes that take a credential name
their schema on the parameter instead, so they validate wherever they run; the
rest are validated in a real build and not under Vitest.

They are not part of `pnpm test`, which stays fast and needs nothing installed. CI runs them as a step of its own; GitHub-hosted runners have a Docker daemon, so no service container is declared in the workflow.

Without Docker the suites skip themselves and say so on stderr instead of failing, so `pnpm test:integration` is safe to run anywhere. A skipped run is not a passing run: if you changed anything that talks to infrastructure, start Docker before you open the pull request.

Each file detects Docker for itself and guards its suite:

```ts
const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

describe.skipIf(!hasDocker)('settings invalidation over Redis', () => {
  // …
});
```

## CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`, as a single job named `ci` so it can be the required status check on the `main` ruleset. It installs with `--frozen-lockfile`, then runs lint, the boundary check, the route-permission check, typecheck, test with coverage, the integration tests, the api coverage gate, build, and both Playwright suites — the same commands you run locally. It then builds `docker/Dockerfile` for `linux/amd64` with a BuildKit cache in GitHub Actions and runs [`scripts/compose-smoke.sh`](#the-whole-stack-from-your-working-copy) against the image it produced. The image is not pushed.

The rest of M0-11 (CodeQL and the multi-arch publish) extends this workflow later.

Dependencies are updated by Renovate, configured in `renovate.json`: grouped pull requests weekly, security advisories immediately.
