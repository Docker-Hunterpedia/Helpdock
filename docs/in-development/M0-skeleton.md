# M0 Skeleton

Status: in progress
Started: 2026-09-18
Owner: @Docker-Hunterpedia

## Scope

A running, empty, secure skeleton that every later milestone builds on: monorepo, config, database with row-level security, tenancy plumbing, auth, the admin shell, Docker, observability, CI, the realtime gateway, the transactional outbox and the SSRF-safe HTTP client. Nothing user-visible beyond login and an empty admin shell.

Full deliverable list and specs: [PRD §4 — M0 Skeleton](../planning/PRD.md#m0-skeleton). Depends on nothing.

## Deliverables

| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M0-01 | Monorepo | #4 | shipped (#21) |
| M0-02 | Config loader | #5 | in review (#25) |
| M0-03 | Database | #6 | in review (#28) |
| M0-04 | Tenancy plumbing | #7 | planned |
| M0-05 | Auth | #8 | planned |
| M0-06 | Roles and staff lifecycle | #9 | planned |
| M0-07 | Admin shell | #10 | in review (#31) |
| M0-08 | First-run wizard | #11 | planned |
| M0-09 | Docker | #12 | planned |
| M0-10 | Observability | #13 | planned |
| M0-11 | CI | #14 | in progress (`ci` job and required status check from #21; coverage gate live; Testcontainers, CodeQL, image build pending) |
| M0-12 | ADRs for the open decisions | #15 | shipped (#19) |
| M0-13 | Realtime gateway skeleton | #16 | planned |
| M0-14 | Transactional outbox | #17 | in review (#30) |
| M0-15 | Outbound HTTP client with SSRF protection | #18 | in review (#24) |

## Exit criteria

Copied from the PRD, ticked as they are met.

- [ ] `docker compose up` on a clean machine reaches the wizard and creates an admin and a brand.
- [ ] All four auth methods and TOTP work end-to-end in a Playwright test.
- [ ] Every negative test in DOMAIN-RULES §1.6 passes and is required in CI.
- [ ] Killing the relay between commit and publish loses no job; a rolled-back transaction enqueues nothing.
- [ ] Two admin sessions on different api replicas see each other's presence change within 5 seconds.
- [ ] CI is green and is a required check on `main`.
- [ ] `docs/completed/M0-skeleton.md` describes what was built.

## Decisions settled

M0-12 settles the five open decisions in [ARCHITECTURE §19](../planning/ARCHITECTURE.md#19-open-decisions-small-can-settle-during-m0):

| ADR | Decision |
|---|---|
| [0001](../decisions/0001-tiptap-for-rich-text.md) | TipTap for article and reply editing |
| [0002](../decisions/0002-web-push-via-vapid.md) | Web push via VAPID for agent notifications |
| [0003](../decisions/0003-turnstile-default-captcha.md) | Cloudflare Turnstile as the default CAPTCHA |
| [0004](../decisions/0004-bull-board-for-queues.md) | Bull Board for queue inspection |
| [0005](../decisions/0005-single-embedding-model-per-install.md) | One embedding model per install |

## Open questions

None yet.

## Pull requests

- #19 milestone doc + ADRs 0001–0005 (M0-12)
- #20 DESIGN.md design system and UI rules
- #21 monorepo scaffold, Biome, Vitest, `ci` workflow (M0-01, part of M0-11)
