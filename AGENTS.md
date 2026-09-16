# Agent guide for Helpdock

Instructions for AI coding agents (Claude Code, Codex, Cursor, Copilot and others) working in this repository. Humans should read [CONTRIBUTING.md](CONTRIBUTING.md).

## What this project is

Helpdock is an open-source (AGPL-3.0), self-hosted customer support platform: ticketing, help center, live chat widget and grounded AI, with one deploy serving many brands. Read the two planning documents before doing any non-trivial work:

- [docs/planning/REQUIREMENTS.md](docs/planning/REQUIREMENTS.md) defines scope. Anything under "Non-goals" or "v1.1+" is out of scope for v1.
- [docs/planning/ARCHITECTURE.md](docs/planning/ARCHITECTURE.md) defines the stack, repository layout, data model, tenancy, auth, queues and milestones.

Current state: pre-alpha. No application code exists yet. The first milestone is M0 Skeleton.

## Repository layout

```
docs/planning/         requirements and architecture (source of truth)
docs/in-development/   one doc per milestone being built
docs/completed/        docs for shipped work
docs/decisions/        ADRs
apps/                  api, admin, helpcenter, widget      (from M0)
packages/              db, schemas, ai, channels, ui, i18n, config   (from M0)
docker/                Dockerfile, compose files, Caddyfile (from M0)
```

Rule: `apps/*` never import each other. They share code only through `packages/*`.

## Workflow rules

- `main` is protected. Never push to it. Create a branch, open a pull request, and stop. A human merges.
- Commit messages follow Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
- When you start a milestone, create `docs/in-development/M<n>-<slug>.md` from the template in that folder and keep its task list current.
- When you settle one of the open decisions in ARCHITECTURE.md §19, write an ADR in `docs/decisions/`.
- Do not add dependencies outside the stack table in ARCHITECTURE.md §1 without an ADR.
- Do not build v1.1 features, however small, even if asked in passing. Point to the backlog instead.

## Engineering rules

These are non-negotiable and come from the security section of the requirements.

- **Tenancy.** Every tenant table has `brand_id` and a row-level security policy. Every request runs inside a transaction that sets `app.brand_ids`. Any code path that queries without a tenant context must be an explicit, audited admin or system path.
- **Validation.** Zod at every boundary: HTTP input, queue job payloads, channel inbound messages, config. Responses go through Zod output schemas so internal fields never leak.
- **Side effects.** Email, Telegram, AI calls, webhooks, indexing and media processing go through BullMQ jobs, never inline in a request handler.
- **Secrets.** Encrypted with AES-256-GCM under `APP_MASTER_KEY`. Never logged, never returned to the client after save.
- **Uploads.** Sniff MIME by magic bytes, re-encode images with sharp, cap sizes, serve through short-lived presigned URLs.
- **AI.** No tool calls or actions in v1. The model reads knowledge and writes text. PII redaction runs before any LLM call. Every call is logged to `ai_calls` with cost.
- **i18n.** Every user-facing string goes through i18next with `en` and `ar` catalogs. Layouts must work in RTL.
- **Tests.** Unit tests with Vitest. Integration tests use Testcontainers with real Postgres and Redis. RLS isolation must be covered by a test that proves brand A cannot read brand B.

## Style

- TypeScript strict. Biome for lint and format. No `any` without a comment explaining why.
- Prefer small modules with one responsibility. Follow NestJS module boundaries.
- No comments that restate the code. Comment only the why.
- Keep documentation in `docs/` current when behaviour changes. A PR that changes behaviour without touching docs is incomplete.

## Review skills

The repository ships review skills under `.agents/skills/`: `clean-code-guard`, `test-guard`, `docs-guard` and `security-audit`. Run the matching one before opening a PR that touches production code, tests or docs.
