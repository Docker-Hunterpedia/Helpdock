# Development

How to install, build, test and extend the Helpdock monorepo. Contribution rules are in [CONTRIBUTING.md](../../CONTRIBUTING.md); the definition of done is in [AGENTS.md](../../AGENTS.md).

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 24 LTS | Pinned in `.nvmrc` and `.node-version`. `nvm use` or `fnm use` picks it up. |
| pnpm | 12 | Pinned in `packageManager`. `corepack enable pnpm` installs the right one. |
| Docker | any recent version | Only for the integration tests. Everything else runs without it. |

No database to install by hand: the integration tests start the services they
need in containers themselves, and the full Compose stack arrives with M0-09.

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

For a single workspace, use the per-package scripts through pnpm or Turborepo:

```bash
pnpm --filter @helpdock/db test
pnpm turbo run typecheck --filter=@helpdock/api
```

## Layout

```
apps/          api, admin, helpcenter, widget
packages/      db, schemas, ai, channels, ui, i18n, config, net
scripts/       repository checks run by CI
docs/          planning, guides, decisions
```

Every workspace is `@helpdock/<directory name>`, private, ESM (`"type": "module"`), and has the same four scripts: `build`, `typecheck`, `lint`, `test`. A workspace is a placeholder until its own deliverable lands — it exports a `PACKAGE_NAME` constant and has one test asserting it matches `package.json`, which is enough to prove the pipeline runs end to end.

Two are real so far. `packages/config` is the configuration loader; see [Configuration](#configuration). `packages/net` is the SSRF-safe outbound HTTP client and URL policy from M0-15, which everything that fetches a user-supplied URL goes through; see [`packages/net/README.md`](../../packages/net/README.md).

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
  store: new InMemorySettingsStore(), // the Postgres store arrives with M0-03
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

## Tests

Unit tests are Vitest, colocated as `src/**/*.test.ts`. `pnpm test` runs one Vitest process across all workspaces, defined as projects in the root `vitest.config.ts`.

Coverage uses `@vitest/coverage-v8` and gates at **80 % of lines across `packages/*`** (ARCHITECTURE §15). Apps are excluded: they are covered by Playwright from M0-07 onwards. Browser tests with Playwright join the pipeline with their own deliverables.

### Integration tests

Anything that touches Postgres, Redis, a queue or a channel adapter is tested against the real thing, started by [Testcontainers](https://node.testcontainers.org/). These files are named `*.integration.test.ts`, sit beside the code they cover, and belong to a Vitest project called `integration`:

```bash
pnpm test:integration                                  # the whole project
pnpm test:integration -- packages/config               # one directory
```

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

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`, as a single job named `ci` so it can be the required status check on the `main` ruleset. It installs with `--frozen-lockfile`, then runs lint, the boundary check, typecheck, test with coverage, the integration tests, and build — the same commands you run locally.

The rest of M0-11 (CodeQL, the image build and publish) extends this workflow later.

Dependencies are updated by Renovate, configured in `renovate.json`: grouped pull requests weekly, security advisories immediately.
