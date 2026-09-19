# M0 Skeleton

Status: shipped
Started: 2026-09-18
Shipped: 2026-09-19
Owner: @Docker-Hunterpedia

## Scope

A running, empty, secure skeleton that every later milestone builds on:
monorepo, config, database with row-level security, tenancy plumbing, auth, the
admin shell, Docker, observability, CI, the realtime gateway, the transactional
outbox and the SSRF-safe HTTP client. Nothing user-visible beyond login, the
first-run wizard, the staff screens and the System page.

Full deliverable list and specs: [PRD §4 — M0 Skeleton](../planning/PRD.md#m0-skeleton). Depends on nothing.

## Deliverables

| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M0-01 | Monorepo | #4 | shipped (#21) |
| M0-02 | Config loader | #5 | shipped (#25) |
| M0-03 | Database | #6 | shipped (#28) |
| M0-04 | Tenancy plumbing | #7 | shipped (#33, #60) |
| M0-05 | Auth | #8 | shipped (#37) |
| M0-06 | Roles and staff lifecycle | #9 | shipped (#42) |
| M0-07 | Admin shell | #10 | shipped (#26, #31, #60) |
| M0-08 | First-run wizard | #11 | shipped (#41) |
| M0-09 | Docker | #12 | shipped (#35) |
| M0-10 | Observability | #13 | shipped (#38) |
| M0-11 | CI | #14 | shipped (#60) |
| M0-12 | ADRs for the open decisions | #15 | shipped (#19) |
| M0-13 | Realtime gateway skeleton | #16 | shipped (#44) |
| M0-14 | Transactional outbox | #17 | shipped (#30) |
| M0-15 | Outbound HTTP client with SSRF protection | #18 | shipped (#24) |

## Exit criteria

Copied from the PRD. Six of seven are met; the seventh is met in part and says
where the rest of it is.

- [x] **`docker compose up` on a clean machine reaches the wizard and creates an
      admin and a brand.** Two halves, both in CI.
      [`scripts/compose-smoke.sh`](../../scripts/compose-smoke.sh) brings the
      stack up from the image this commit built and asserts the api serves the
      admin build with `helpdock:install-state=fresh`, which is what mounts the
      wizard. `apps/admin/e2e/api/setup.api.spec.ts` drives the four steps
      against a second api that serves `dist/` itself and ends in the shell with
      an admin and a brand created.
- [ ] **All four auth methods and TOTP work end-to-end in a Playwright test.**
      Partly. Password and TOTP — and an invitation, enrolment and recovery — are
      driven end-to-end against a real api in `e2e:api`. **Sign-in links and the
      two OAuth providers are not**: the magic link is covered by
      `auth.integration.test.ts` at the HTTP layer rather than in a browser, and
      Google and GitHub cannot be driven at all until the install has real client
      credentials, which is an
      [open external dependency](../planning/PRD.md#external-dependencies) on
      @Docker-Hunterpedia. What CI does prove for those two is that the buttons
      are hidden when no client id is configured and that a callback never
      redirects off `APP_URL`.
- [x] **Every negative test in DOMAIN-RULES §1.6 passes and is required in CI.**
      `apps/api/src/api.integration.test.ts` runs the suite against a real
      Postgres with the real policies. `pnpm test:integration` is a step of the
      `ci` job, and `ci` is the required status check on the `main` ruleset.
- [x] **Killing the relay between commit and publish loses no job; a rolled-back
      transaction enqueues nothing.** `packages/jobs/src/relay.integration.test.ts`
      — "loses nothing when it is killed between the add and the commit" and
      "enqueues nothing for a transaction that rolled back", plus the two-relay
      and per-brand-lock cases.
- [x] **Two admin sessions on different api replicas see each other's presence
      change within 5 seconds.** `apps/api/src/realtime/realtime.integration.test.ts`
      — "reaches the other replica over REST and over the brand room", with the
      revocation case asserting the five-second bound explicitly.
- [x] **CI is green and is a required check on `main`.** The `protect-main`
      ruleset requires the `ci` context with a strict (up-to-date) policy, one
      code-owner approval, linear history and squash merges.
- [x] **`docs/completed/M0-skeleton.md` describes what was built.** This file.

## Effort

| | |
|---|---|
| Estimated | 5–7 weeks (PRD status board) |
| Started | 2026-09-18 |
| Shipped | 2026-09-19 |
| Actual | 2 days |

The estimate was written for one maintainer. The work was done by AI coding
agents running in parallel worktrees, one deliverable at a time, with the
maintainer reviewing and merging. The estimate for M1 is left as it stands until
there is more than one milestone to calibrate against.

## Known gaps

Accepted, written down, and carried forward. None of them blocks M1. Each is
recorded where somebody would look for it, which is what the last column says.

| Gap | Why it was accepted | Where it is written down |
|---|---|---|
| A **Team Leader reads the whole brand's roster**, not only their own departments | `user_brand_roles` is brand-scoped and DOMAIN-RULES §1.2 does not narrow *reading* the list. They can still only act on their own departments. Narrowing the read is a product decision for M1, when departments have a screen. | [staff-and-roles](../guides/staff-and-roles.md#known-gaps) |
| **Own-account actions write no `audit_log` row** | `audit_log` is keyed on `brand_id`, and a password change belongs to a person. Writing it under whichever brand came first would put a fact somewhere it is not true; writing it under the install sentinel would mean an ordinary staff principal opening an install-scope transaction. They go to the structured log with the user id and the reason. | `apps/api/src/staff/account.service.ts`, [staff-and-roles](../guides/staff-and-roles.md#known-gaps) |
| **Socket events are not rate-limited** | HTTP is. Only an authenticated staff principal can send `room:join`, `presence:set` or `presence:heartbeat`, and each costs a few Redis commands. | [realtime](../guides/realtime.md#known-gaps) |
| **Revocation is per person, not per browser** | `principal.revoked` carries only the user id, which is M0-05's contract. It fails closed — signing out of one browser closes that person's sockets everywhere — which is the right direction. Narrowing it means adding the family id to the published payload. | [realtime](../guides/realtime.md#known-gaps) |
| **The first-run window is narrowed, not closed** | Step 1 of the wizard is unauthenticated by nature: on a fresh install, whoever reaches the host first can create the owner. A per-IP rate limit, a `Sec-Fetch-Site` refusal and the install guide's advice mitigate it. An optional `HD_SETUP_TOKEN` bootstrap key would close it. | [#43](https://github.com/Docker-Hunterpedia/Helpdock/issues/43), M9 |
| **`on_unassign` is not implemented** | Deactivating somebody leaves their tickets assigned to them — and there are no tickets until M1. The calls are named in `apps/api/src/staff/lifecycle-hooks.ts`. | [staff-and-roles](../guides/staff-and-roles.md#known-gaps) |
| **`NoopBrandResolver` resolves every host to nothing** | `brand_domains` exists from M0-09 for the on-demand TLS check; the rows, their verification and the `Host`-to-brand resolver are M5. | [apps/api/README](../../apps/api/README.md#known-gaps) |
| **No Postgres-driver or BullMQ spans** | Neither has an OpenTelemetry instrumentation in the stack table. Both gaps are named rather than papered over. | [operations](../guides/operations.md#what-is-instrumented) |
| **Semgrep and the ZAP baseline are not in CI** | ARCHITECTURE §15 names all three security checks; M0-11 ships CodeQL with the `security-extended` pack. Semgrep's Nest rules and a ZAP baseline against the Compose stack are **M9-05**, where the release hardening lives. | [development](../guides/development.md#security-scanning) |
| **The screenshot suite is not part of `pnpm e2e`** | Its baselines are Linux pixels, so the comparison fails on macOS and Windows, and `pnpm e2e` has to be a command any contributor can run. CI runs `pnpm e2e:screenshots` as a step of its own, and the baselines are rendered by `screenshots.yml` on the same runner image that compares them. | [apps/admin/README](../../apps/admin/README.md#screenshots) |

## Decisions settled

M0-12 settles the five open decisions in [ARCHITECTURE §19](../planning/ARCHITECTURE.md#19-open-decisions-small-can-settle-during-m0):

| ADR | Decision |
|---|---|
| [0001](../decisions/0001-tiptap-for-rich-text.md) | TipTap for article and reply editing |
| [0002](../decisions/0002-web-push-via-vapid.md) | Web push via VAPID for agent notifications |
| [0003](../decisions/0003-turnstile-default-captcha.md) | Cloudflare Turnstile as the default CAPTCHA |
| [0004](../decisions/0004-bull-board-for-queues.md) | Bull Board for queue inspection |
| [0005](../decisions/0005-single-embedding-model-per-install.md) | One embedding model per install |

## What an operator can do with this milestone

Stand the stack up with Docker Compose, finish the first-run wizard, sign in
with a password and a second factor, invite colleagues and give them roles, and
watch the install's health on the System page — in English or in Arabic. There
is no ticketing: that is [M1](../planning/PRD.md#m1-ticketing-core).

## Open questions

None. The five that M0 opened are settled as ADRs above; everything else became
an issue.

## Pull requests

- #19 milestone doc + ADRs 0001–0005 (M0-12)
- #20 DESIGN.md design system and UI rules
- #21 monorepo scaffold, Biome, Vitest, `ci` workflow (M0-01, part of M0-11)
- #24 SSRF-safe outbound HTTP client, `packages/net` (M0-15)
- #25 config loader, secret encryption, settings invalidation (M0-02)
- #26 design tokens, MUI theme, en/ar catalogs (M0-07 foundations)
- #28 Drizzle schema, migrations, RLS, DB roles (M0-03)
- #30 transactional outbox relay, `packages/jobs` (M0-14)
- #31 admin shell with sign-in, TOTP, nav (M0-07)
- #33 NestJS api, tenancy plumbing, permission guard (M0-04)
- #35 Docker image, Compose stack, Caddy on-demand TLS (M0-09)
- #37 argon2id, magic link, OAuth, TOTP, rotating refresh (M0-05)
- #38 observability and the admin System page (M0-10)
- #40 ARCHITECTURE §14 aligned with the implementation
- #41 first-run wizard (M0-08)
- #42 roles and the staff lifecycle (M0-06)
- #44 realtime gateway, rooms and staff presence (M0-13)
- #60 CI, the input-validation check, screenshot baselines and this close-out (M0-11)
