# Agent guide for Helpdock

Instructions for AI coding agents (Claude Code, Codex, Cursor, Copilot and others) working in this repository. Humans should read [CONTRIBUTING.md](CONTRIBUTING.md).

## What this project is

Helpdock is an open-source (AGPL-3.0), self-hosted customer support platform: ticketing, help center, live chat widget and grounded AI, with one deploy serving many brands. Read the two planning documents before doing any non-trivial work:

- [docs/planning/PRD.md](docs/planning/PRD.md) is the execution plan: phases, milestones, deliverable ids (`M1-04`), exit criteria and the status board. Work is always tied to a deliverable id.
- [docs/planning/REQUIREMENTS.md](docs/planning/REQUIREMENTS.md) defines scope. Anything under "Non-goals" or "v1.1+" is out of scope for v1.
- [docs/planning/ARCHITECTURE.md](docs/planning/ARCHITECTURE.md) defines the stack, repository layout, data model, tenancy, auth, queues and milestones.
- [DESIGN.md](DESIGN.md) defines the design system ("Quiet desk"): tokens, type scale, components, RTL rules, brand theming limits and the accessibility checklist. Every screen in admin, widget and help center is built from it.
- [docs/planning/DOMAIN-RULES.md](docs/planning/DOMAIN-RULES.md) defines behaviour: the authorization matrix, ticket transitions, SLA maths, identity and ownership, knowledge visibility, the outbox, the realtime delivery contract, embeddings, AI quality gate, operations, retention and SSRF rules. When code and this file disagree, the code is wrong.

Current state: pre-alpha. **M0 Skeleton shipped on 2026-09-19** — see [docs/completed/M0-skeleton.md](docs/completed/M0-skeleton.md) for what was built and the ten gaps it left open. **M1 Ticketing core** is in progress; see [docs/in-development/M1-ticketing-core.md](docs/in-development/M1-ticketing-core.md).

## Repository layout

```
docs/planning/         PRD, requirements, architecture, domain rules (source of truth)
docs/in-development/   one doc per milestone being built
docs/completed/        docs for shipped work
docs/decisions/        ADRs
apps/                  api, admin, helpcenter, widget      (from M0)
packages/              db, schemas, ai, channels, ui, i18n, config, net, jobs   (from M0)
docker/                Dockerfile, compose files, Caddyfile (from M0)
```

Rule: `apps/*` never import each other. They share code only through `packages/*`.

## Workflow rules

- `main` is protected. Never push to it. Create a branch, open a pull request, and stop. A human merges.
- Commit messages follow Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
- Every piece of work maps to a deliverable id in the PRD and a GitHub issue in the matching milestone. PRs link the issue with `Closes #n`. If no deliverable fits, stop and ask; do not invent scope.
- When you start a milestone, create `docs/in-development/M<n>-<slug>.md` from the template in that folder, keep its task list current, and update the status board in the PRD.
- When you settle one of the open decisions in ARCHITECTURE.md §19, write an ADR in `docs/decisions/`.
- **Design first.** Every screen, dialog, widget mode, help center page and email template is designed as an artboard on the Helpdock design canvas (link in DESIGN.md) before it is implemented, by the orchestrating session, not by implementing agents. An implementing agent builds from the named artboard plus DESIGN.md. If a task needs a screen that has no artboard, stop and ask for one; do not improvise a layout. Customer-facing screens get `en` and `ar` artboards.
- Do not add dependencies outside the stack table in ARCHITECTURE.md §1 without an ADR.
- Do not build v1.1 features, however small, even if asked in passing. Point to the backlog instead.

## Definition of done

This is an open-source project. Strangers will read the code, run the tests and follow the docs, so every PR must leave all three consistent. A PR is not done until:

1. **Docs are updated.** Anything added or changed in behaviour, configuration, API, schema, UI or deployment is reflected in the docs in the same PR: the milestone doc in `docs/in-development/`, the relevant user guide under `docs/guides/` once it exists, `.env.example` for new config keys, and the OpenAPI schema for API changes. New architectural choices get an ADR. No "docs later".
2. **Unit tests exist** for every new function, service, rule, resolver or schema, and for every bug fix (a failing test first, then the fix). Vitest, colocated as `*.test.ts`.
3. **Integration tests exist** for anything that touches the database, Redis, queues or channel adapters. Testcontainers, real Postgres and Redis. Every new tenant table is added to the RLS isolation test.
4. **Browser tests exist** for every new or changed user-facing screen or flow in the admin app, help center or widget. Playwright, under `apps/<app>/e2e/`. Cover the happy path and the main failure path, in both `en` and `ar` when the screen has text.
5. **CI is green**, including the coverage gate and the widget size check.
6. **The PR description** states the deliverable id, what changed, why, and how it was tested.

If any of these cannot be met, say so explicitly in the PR description and why. A reviewer decides, not the author.

## Engineering rules

These are non-negotiable and come from the security section of the requirements.

- **Tenancy.** Every tenant table has `brand_id` and a `FORCE`d row-level security policy; ticket-scoped tables also enforce department scope. Every request runs inside a transaction that sets the `app.*` session settings. Every route declares `@Requires(permission)`. Any code path that queries without a tenant context must be an explicit, audited install-admin or system path. New tenant tables extend the negative test suite in DOMAIN-RULES §1.6.
- **Validation.** Zod at every boundary: HTTP input, queue job payloads, channel inbound messages, config. Responses go through Zod output schemas so internal fields never leak.
- **Side effects.** Email, Telegram, AI calls, webhooks, indexing and media processing are enqueued through the transactional outbox in the same transaction as the domain change, then run as idempotent BullMQ jobs. Never enqueue directly from a request handler or an event listener.
- **Secrets.** Encrypted with AES-256-GCM under `APP_MASTER_KEY`. Never logged, never returned to the client after save.
- **Uploads.** Sniff MIME by magic bytes, re-encode images with sharp, cap sizes, serve through short-lived presigned URLs issued only after authorization on the parent ticket.
- **Outbound HTTP.** Any fetch of a user-supplied URL goes through the SSRF-safe client (DOMAIN-RULES §13). Never call `fetch` on user input directly.
- **Knowledge.** Retrieval always takes an `audience`; visitor-facing paths filter visibility in SQL before ranking.
- **AI.** No tool calls or actions in v1. The model reads knowledge and writes text. PII redaction runs before any LLM call. Every call is logged to `ai_calls` with cost.
- **UI.** Build only from the tokens and components in DESIGN.md. No new colors, font sizes, radii or spacing values outside its scales; no new component without adding it to DESIGN.md §6 in the same PR. Logical CSS properties only (no `left`/`right`), Lucide icons only, no emoji. Every UI PR ticks the accessibility checklist in DESIGN.md §10.
- **i18n.** Every user-facing string goes through i18next with `en` and `ar` catalogs. Layouts must work in RTL.
- **Tests.** Unit tests with Vitest. Integration tests use Testcontainers with real Postgres and Redis. RLS isolation must be covered by a test that proves brand A cannot read brand B.

## Style

- TypeScript strict. Biome for lint and format. No `any` without a comment explaining why.
- Prefer small modules with one responsibility. Follow NestJS module boundaries.
- No comments that restate the code. Comment only the why.
- Keep documentation in `docs/` current when behaviour changes. A PR that changes behaviour without touching docs is incomplete.

## Review skills

The repository ships review skills under `.agents/skills/`: `clean-code-guard`, `test-guard`, `docs-guard` and `security-audit`. Run the matching one before opening a PR that touches production code, tests or docs.
