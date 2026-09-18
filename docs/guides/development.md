# Development

How to install, build, test and extend the Helpdock monorepo. Contribution rules are in [CONTRIBUTING.md](../../CONTRIBUTING.md); the definition of done is in [AGENTS.md](../../AGENTS.md).

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 24 LTS | Pinned in `.nvmrc` and `.node-version`. `nvm use` or `fnm use` picks it up. |
| pnpm | 12 | Pinned in `packageManager`. `corepack enable pnpm` installs the right one. |

Nothing else is needed yet. Postgres, Redis and Docker arrive with M0-03 and M0-09.

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
| `pnpm test` | `vitest run --coverage` — every workspace in one run, with the coverage gate. |
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
packages/      db, schemas, ai, channels, ui, i18n, config
scripts/       repository checks run by CI
docs/          planning, guides, decisions
```

Every workspace is `@helpdock/<directory name>`, private, ESM (`"type": "module"`), and has the same four scripts: `build`, `typecheck`, `lint`, `test`. All of them are placeholders until their own deliverable lands — each exports a `PACKAGE_NAME` constant and has one test asserting it matches `package.json`, which is enough to prove the pipeline runs end to end.

TypeScript settings live in `tsconfig.base.json` (strict, `nodenext` modules, `verbatimModuleSyntax`). A workspace `tsconfig.json` only adds `rootDir`, `outDir` and which files to include. Because module resolution is `nodenext`, relative imports carry the `.js` extension even when the file on disk is `.ts`.

## Adding a package

1. Create `packages/<name>/` with `src/index.ts` and `src/index.test.ts`.
2. Add `package.json`: name `@helpdock/<name>`, `"private": true`, `"type": "module"`, an `exports` map pointing at `dist/`, and the four scripts. Copy an existing package.
3. Add `tsconfig.json` extending `../../tsconfig.base.json`.
4. Run `pnpm install` so the workspace is linked.

Vitest discovers the new workspace through the `packages/*` glob in `vitest.config.ts`, and Turborepo through `pnpm-workspace.yaml`. Neither file needs editing. The coverage gate starts applying to it immediately.

Dependencies must come from the stack table in [ARCHITECTURE.md §1](../planning/ARCHITECTURE.md); anything else needs an ADR first.

## The app import rule

`apps/*` never import each other. They share code only through `packages/*` (ARCHITECTURE §2).

`scripts/check-app-boundaries.ts` enforces it and runs in CI. It scans every source file under `apps/` and fails on two things: importing another app by workspace name (`@helpdock/widget` from `apps/api`), and reaching into another app with a relative path (`../../widget/src/…`). Imports of `packages/*`, of external modules, and within the same app all pass.

It is a lexical scan rather than a parse, so a module specifier written inside a string or a comment can trigger a false positive. That fails loudly, which is the right direction for a boundary check.

## Tests

Unit tests are Vitest, colocated as `src/**/*.test.ts`. `pnpm test` runs one Vitest process across all workspaces, defined as projects in the root `vitest.config.ts`.

Coverage uses `@vitest/coverage-v8` and gates at **80 % of lines across `packages/*`** (ARCHITECTURE §15). Apps are excluded: they are covered by Playwright from M0-07 onwards. Integration tests with Testcontainers and browser tests with Playwright join the pipeline with their own deliverables.

## CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`, as a single job named `ci` so it can be the required status check on the `main` ruleset. It installs with `--frozen-lockfile`, then runs lint, the boundary check, typecheck, test with coverage, and build — the same commands you run locally.

The rest of M0-11 (integration tests, CodeQL, the image build and publish) extends this workflow later.

Dependencies are updated by Renovate, configured in `renovate.json`: grouped pull requests weekly, security advisories immediately.
