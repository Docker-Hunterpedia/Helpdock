# Helpdock — Product Requirements Document

Status: planning
Version: 1.2 (2026-10-20)
Owner: @Docker-Hunterpedia

This document is the execution plan for Helpdock v1 and, from Phase 5, for the 1.x line. It turns [REQUIREMENTS.md](REQUIREMENTS.md) (what), [ARCHITECTURE.md](ARCHITECTURE.md) (how) and [DOMAIN-RULES.md](DOMAIN-RULES.md) (behavioural contracts: authorization, ticket lifecycle, SLA maths, identity, knowledge visibility, delivery guarantees, operations) into phases, milestones, deliverables and exit criteria that can be tracked on GitHub. When this document and the others disagree, fix this document.

---

## 1. Summary

| | |
|---|---|
| **Product** | Open-source, self-hosted customer support platform: ticketing + help center + live chat widget + grounded AI. One deploy serves many brands. |
| **Target users** | Small and mid-size teams that pay for Zoho Desk / Zendesk / Freshdesk today and want a self-hosted, multi-brand, AI-capable alternative. |
| **Release goal** | `1.0.0`: a team can `docker compose up`, finish a wizard, embed the widget on two sites under two brands, receive email and Telegram tickets, publish a help center on a custom domain with TLS, and get AI auto-replies with citations — with no High findings in an external pentest. |
| **License** | AGPL-3.0 |
| **Locales (v1)** | English, Arabic (RTL) |
| **Deployment (v1)** | Docker Compose only |

### Problem

Teams need ticketing discipline (departments, SLAs, rules, macros), a help center, and live chat. Open-source options stop at basic ticketing, bolt AI on, or cannot serve several websites from one install without becoming SaaS. Commercial tools charge per agent per brand and own the data.

### Principles

1. One deploy, many brands. Brand is the tenant boundary, enforced in the database.
2. Zoho-style ticketing discipline, not a chat inbox with labels.
3. AI is grounded in the team's own knowledge, never takes actions in v1, and every AI feature is a toggle.
4. Security and speed are requirements, not features.

### Non-goals for v1

Visual process builder · community forums · phone/VoIP · billing/SaaS metering · SLA credits · Slack/Discord · customer login portal · backup tooling · one-click cloud deploy · custom permission sets · native mobile SDKs.

### Non-goals for 1.x

Planned on 2026-10-20 ([Phase 5](#phase-5--1x)): three of the v1 non-goals move into 1.x milestones. Backup tooling is [M15](#m15-self-host-operations) (`helpdock-ctl backup`, `restore`, `verify`); the one-click deploy becomes M15's verified installer, cloud-init recipe and Coolify template, with Docker Compose still the only supported runtime; native mobile SDKs for customers' own apps are [M20](#m20-native-clients-and-sdks). The rest stay non-goals for 1.x, joined by three the plans rule out:

Visual process builder · community forums · phone/VoIP · billing/SaaS metering · SLA credits · Slack/Discord · customer login portal (backlog) · custom permission sets (backlog) · native iOS and Android **agent** apps (they need a push relay the project would have to host; the installable admin of M17 covers phones) · a hosted Helpdock · deploying on Vercel or Cloudflare (no long-running workers, Socket.IO rooms or on-demand TLS).

---

## 2. Success metrics

| Metric | Target | Measured by |
|---|---|---|
| Time from `docker compose up` to first Telegram ticket, following the docs | < 30 min | Onboarding test on a clean VM before release |
| Widget bundle size | < 40 KB gzipped | CI size check on `apps/widget` build |
| API p95 for ticket list/read at 50k tickets per brand | < 150 ms | Load test in M9 |
| Help center SSR TTFB (cached) | < 200 ms | Load test in M9 |
| Realtime delivery, agent reply to widget | < 500 ms end-to-end | E2E measurement in M4 |
| Cross-brand data isolation | 0 leaks | RLS integration tests in every milestone that adds a tenant table |
| External pentest of widget + API | 0 High findings | M9 |
| Test coverage on `packages/*` | ≥ 80 % | CI gate from M0 |
| WCAG 2.1 AA on widget and help center | Pass | axe audit + manual keyboard pass in M9 |
| AI answer quality (EN and AR evaluation set) | Thresholds in DOMAIN-RULES §9 | Nightly eval run against a real provider, M7 and M9 |
| Restore drill from dump + bucket + `.env` on a clean VM | Completed within RTO 1 h | M9 |

Performance numbers are measured under the host, dataset, load and network conditions defined in [DOMAIN-RULES §14](DOMAIN-RULES.md#14-performance-test-conditions). The 40 KB widget limit applies to the initial bundle; lazy chunks have their own caps there.

Product metrics (activation, agent efficiency, AI deflection rate with its exact definition, handoff quality, help center self-service) are defined in [DOMAIN-RULES §15](DOMAIN-RULES.md#15-product-metrics) and reported on the System page from M8.

---

## 3. Tracking model

Everything is tracked on GitHub so progress is visible without asking anyone.

| Level | GitHub object | Naming |
|---|---|---|
| Phase | Label | `phase:0-foundation` … `phase:4-release`, `phase:5-1x` |
| Milestone | GitHub Milestone | `M0 Skeleton`, `M1 Ticketing core`, … |
| Deliverable | Issue | Title starts with the deliverable id, e.g. `M1-04 Contacts and accounts` |
| Work | Pull request | Linked to its issue with `Closes #n`; squash-merged |
| Living status | `docs/in-development/M<n>-<slug>.md` | Created when a milestone starts, moved to `docs/completed/` when it ships |
| Decisions | `docs/decisions/NNNN-*.md` | ADR per settled decision |

Rules:

- A milestone is **started** when its doc exists in `docs/in-development/` and its issues are created.
- A milestone is **shipped** when every exit criterion below is met, every issue is closed, and its doc is moved to `docs/completed/`.
- **Dependencies govern scheduling, not phases.** A milestone may start when every milestone it depends on has shipped. Phases group milestones for reporting; they are not gates. Example: M8 depends on M1 and M3, so it may run while M7 is in progress.
- Shared infrastructure lands in the earliest milestone that needs it (realtime gateway, outbox and presence are in M0 because M1 and M3 use them).
- Scope changes go through a PR to this document, not through issue comments.

### Status board

Update this table in the same PR that changes a milestone's status.

| Phase | Milestone | Depends on | Effort (weeks) | Status | Started | Shipped |
|---|---|---|---|---|---|---|
| 0 Foundation | M0 Skeleton | — | 5–7 | shipped | 2026-09-18 | 2026-09-19 |
| 1 Core desk | M1 Ticketing core | M0 | 6–8 | shipped | 2026-09-19 | 2026-09-25 |
| 1 Core desk | M2 Email channel | M1 | 3–4 | shipped | 2026-09-27 | 2026-09-27 |
| 1 Core desk | M3 Automation and SLAs | M1 | 4–5 | shipped | 2026-09-27 | 2026-09-27 |
| 2 Customer surfaces | M4 Widget and realtime | M1, M3 | 5–6 | shipped | 2026-09-27 | 2026-09-27 |
| 2 Customer surfaces | M5 Help center | M1 | 5–6 | shipped | 2026-09-27 | 2026-09-27 |
| 2 Customer surfaces | M6 Telegram | M2 | 2 | shipped | 2026-10-05 | 2026-10-07 |
| 3 Intelligence | M7 AI | M3, M4, M5, M6 | 7–9 | shipped | 2026-10-05 | 2026-10-07 |
| 4 Release | M8 API, webhooks, reports | M1, M3 | 4–5 | shipped | 2026-10-05 | 2026-10-07 |
| 4 Release | M9 Hardening and 1.0 | all | 5–7 | shipped: 1.0.0 released (M9-09, [#159](https://github.com/Docker-Hunterpedia/Helpdock/issues/159)) | 2026-10-05 | 2026-10-20 |
| 4 Release | M10 Meta channels | M6, M9 (code side) | 5–6 | shipped | 2026-10-11 | 2026-10-13 |
| 4 Release | M11 SSO and migration | M0, M1, M3, M5, M8 | 9–13 | shipped for 1.0 (M11-01 to M11-18, [#215](https://github.com/Docker-Hunterpedia/Helpdock/pull/215)); M11-19 to M11-23 moved to M16-04 to M16-08 | 2026-10-13 | 2026-10-18 |
| | **Total, phases 0–4** | | **60–78** | | | |
| 5 1.x | M12 AI workspace | M3, M4, M7, M8 | 14–15 | planned | | |
| 5 1.x | M13 AI actions and integrations | M12, M8, M0 (M13-09 to M13-11: M8 only) | 14–15 | planned | | |
| 5 1.x | M14 Inbox productivity | M1, M3, M4, M5, M7, M8, M11 | 20–21 | shipped for 1.1 (all 29 deliverables, [#288](https://github.com/Docker-Hunterpedia/Helpdock/issues/288)–[#316](https://github.com/Docker-Hunterpedia/Helpdock/issues/316)); the manual screen-reader run is carried | 2026-10-20 | 2026-11-01 |
| 5 1.x | M15 Self-host operations | M9, M11 | 13–14 | in progress (#337: M15-08 and platform templates) | | |
| 5 1.x | M16 More importers and undo | M11 | 15–16 | planned | | |
| 5 1.x | M17 Apps and languages | M3, M4, M5 | 12 | planned | | |
| 5 1.x | M18 Sign-in options | M0, M4, M9, M11 | 5–7 | in development ([#275](https://github.com/Docker-Hunterpedia/Helpdock/issues/275)–[#287](https://github.com/Docker-Hunterpedia/Helpdock/issues/287)) | 2026-10-20 | |
| 5 1.x | M19 Customer surfaces polish | M2, M4, M5 (M19-08: M15-11) | 9–10 | planned | | |
| 5 1.x | M20 Native clients and SDKs | M4, M15-01, M17 | 9–11 | planned | | |
| | **Total, phase 5 (M12–M19)** | | **102–110** (about 533 person-days; M20 adds 45–57) | | | |

Effort assumes one full-time maintainer working with AI coding agents, including tests and docs per the Definition of done. Phase 5 figures are the plans' person-day estimates divided by five; milestones from M0 to M11 were built far faster than estimated, but review, the owner's verification and real-provider runs do not shrink the same way, so they stay the planning number. M2 and M3 can overlap, as can M4 and M5, so calendar time is shorter than the sum. Re-estimate at the start of each milestone and record the actual in the milestone doc.

### External dependencies

| Needed for | Dependency | Owner | Status |
|---|---|---|---|
| M0-05 | Google and GitHub OAuth app credentials for the dev and test environments | @Docker-Hunterpedia | needed |
| M2 | SMTP provider account and one IMAP mailbox for E2E against a real provider (CI uses Mailpit for SMTP and GreenMail for IMAP) | @Docker-Hunterpedia | needed |
| M5-07 | A registered domain with DNS control for the TLS onboarding test | @Docker-Hunterpedia | needed |
| M6 | A Telegram bot token for the staging bot | @Docker-Hunterpedia | needed |
| M7 | LLM and embeddings API keys for the nightly evaluation run (stored as CI secrets: `AI_EVAL_API_KEY` and the keys named in `.github/workflows/ai-eval.yml`) | @Docker-Hunterpedia | done: `AI_EVAL_API_KEY` is set, and embeddings run on a local Ollama ([#234](https://github.com/Docker-Hunterpedia/Helpdock/pull/234)) |
| M7-03 | Notion integration and Google Cloud OAuth app for the connectors | @Docker-Hunterpedia | needed |
| M9-01 | External pentest vendor, budget and a 2-week slot booked at least 6 weeks ahead ([statement of work](pentest-scope.md)) | @Docker-Hunterpedia | done: the owner confirmed the pentest complete on 2026-10-19 (#153); the results are held by the owner |
| M9-07 | Three outside testers for the usability pass, and a clean VM for the onboarding run and the restore drill for the record (`docs/completed/onboarding-test.md`, `docs/completed/restore-drill.md`) | @Docker-Hunterpedia | done: the owner confirmed the onboarding run, the three testers (#157) and the restore drill (#160) complete on 2026-10-19; the results are held by the owner |
| M9-08 | GHCR publish permissions on the org (done: `v0.4.0` is published). No signing key is needed: Cosign signs keylessly through GitHub OIDC, and `v0.4.0` was signed that way on 2026-10-09 (#158, closed) | @Docker-Hunterpedia | done |
| M10 | A Meta developer account and a Business-type app with the WhatsApp, Messenger and Instagram products in Live mode, with its app secret and Instagram app secret | @Docker-Hunterpedia | needed |
| M10-03 | A WhatsApp Business account with its test number, and a payment method for a real number | @Docker-Hunterpedia | needed |
| M10-04, M10-05 | A Facebook Page and an Instagram professional account for staging, with the maintainer in an app role | @Docker-Hunterpedia | needed |
| M10-04, M10-05, M10-09 | App Review of `pages_messaging`, `instagram_business_manage_messages` and the Human Agent feature on the staging app, so messages from people outside the app's roles arrive | @Docker-Hunterpedia | not started |
| M11-02 to M11-06 | Developer tenants of Okta and Microsoft Entra ID, and a Google Workspace or Keycloak instance, each with a test user in two groups | @Docker-Hunterpedia | needed; not a 1.0 blocker (owner, 2026-10-19): SSO is verified against the stand-in IdPs |
| M11-12 to M11-14 | Trial accounts of Zendesk, Freshdesk and Zoho Desk seeded with the M11 reference dataset | @Docker-Hunterpedia | needed; not a 1.0 blocker (owner, 2026-10-19): the importers are verified against stand-ins built from the vendors' published API documentation |
| M13-06 | Developer accounts with Linear, GitHub, Jira and Confluence, Sentry, Slack, Notion, Stripe and Zapier to verify each catalog connect flow; whether they gate the release is D-18 | @Docker-Hunterpedia | not started |
| M15-13 | A Coolify instance to validate the service template | @Docker-Hunterpedia | not started |
| M16-04 to M16-08 | Trial or sandbox accounts of Help Scout, Intercom, Gorgias, Zammad (self-hosted in CI is possible) and Front, seeded with the reference dataset; not blockers, following the owner's M11 ruling | @Docker-Hunterpedia | not started |
| M17-02 | A Hosted Weblate project for Helpdock (D-47) | @Docker-Hunterpedia | not started |
| M17-03 | Translators, or a translation budget, for the wave 1 locales (D-48) | @Docker-Hunterpedia | not started |
| M17-08 | An iOS device (16.4 or later) and an Android device for the push matrix | @Docker-Hunterpedia | not started |
| M20-01, M20-02 | An npm organisation `@helpdock` with two-factor authentication | @Docker-Hunterpedia | not started |
| M20-04 | An Apple Developer ID and Windows code signing (Azure Trusted Signing) for the desktop app (D-59) | @Docker-Hunterpedia | not started |

---

## 4. Phases and milestones

Each deliverable references the section of REQUIREMENTS.md (R), ARCHITECTURE.md (A) or DOMAIN-RULES.md (D) that specifies it.

### Phase 0 — Foundation

Goal: a running, empty, secure skeleton that every later milestone builds on. Nothing user-visible beyond login and an empty admin shell.

#### M0 Skeleton

Depends on: nothing.

| Id | Deliverable | Spec |
|---|---|---|
| M0-01 | Monorepo: pnpm + Turborepo, `apps/{api,admin,helpcenter,widget}`, `packages/{db,schemas,ai,channels,ui,i18n,config}`, Biome, TypeScript strict | A §2 |
| M0-02 | Config loader: `.env` bootstrap + `settings` table, Zod-validated, AES-256-GCM secret encryption, Redis pub/sub invalidation, "locked by environment" flag | A §4 |
| M0-03 | Database: Drizzle schema for `users`, `brands`, `user_brand_roles`, `settings`, `audit_log`, `outbox`, `job_receipts`; UUIDv7; migrations run on api boot with lock using the owner role; RLS helper (brand and department policies, `FORCE ROW LEVEL SECURITY`) that every tenant table uses; separate owner and runtime DB roles with a boot check that the runtime role cannot bypass RLS | A §5, §6, D §1.3, §1.5 |
| M0-04 | Tenancy plumbing: `RequestContextMiddleware`, auth guard producing the `Principal` shape, `TenantInterceptor` with `SET LOCAL` for brand, department and principal settings, `@Requires(permission)` decorator with a CI check that every route has one; the full negative test suite from D §1.6 | A §6, D §1 |
| M0-05 | Auth: argon2id password, magic link, Google + GitHub OAuth, TOTP with recovery codes, JWT access + rotating refresh in Redis, "log out everywhere", `principal.revoked` broadcast | R §5.1, A §7, D §1.4 |
| M0-06 | Roles and staff lifecycle: Admin, Team Leader, Agent, Viewer (toggle) with server-side guards; invite, activate, role change, deactivate, reactivate, delete, per-brand removal with the effects in D §12 | R §2, D §12 |
| M0-07 | Admin shell: Vite + React + MUI, i18next `en`/`ar`, RTL provider, login, brand switcher, empty nav | A §1 |
| M0-08 | First-run wizard: admin account, first brand, SMTP test. The LLM provider step is added by M7-10. | R §5.5 |
| M0-09 | Docker: single image with `APP_ROLE=api\|worker`, `docker-compose.yml`, dev compose, Caddyfile with host routing, `/health` and `/ready` | A §3, §17 |
| M0-10 | Observability: pino JSON logs with request id and brand id, OpenTelemetry auto-instrumentation, `/metrics` | A §14 |
| M0-11 | CI: Biome, typecheck, unit + integration (Testcontainers), build image, coverage gate 80 %; CodeQL; Renovate; required status check added to the `main` ruleset | A §15, §16 |
| M0-12 | ADRs for the open decisions: editor library, web push, CAPTCHA default, queue dashboard, single install-wide embedding model | A §19, D §8 |
| M0-13 | Realtime gateway skeleton: Socket.IO with Redis adapter, authenticated `/staff` namespace, room authorization hook that reuses the REST permission check, staff presence (online/away/offline), disconnect on `principal.revoked` | A §8, D §1.4, §12 |
| M0-14 | Transactional outbox: `outbox` table written inside domain transactions, `outbox.relay` worker with `LISTEN/NOTIFY`, idempotent enqueue by `jobId`, `job_receipts` helper for consumers; crash and rollback tests from D §6 | D §6 |
| M0-15 | Outbound HTTP client with SSRF protection (resolved-IP pinning, private range blocking on every redirect, timeouts, size caps, `OUTBOUND_ALLOW_CIDRS`) used by every later feature that fetches a URL | D §13 |

Exit criteria:

- [x] `docker compose up` on a clean machine reaches the wizard and creates an admin and a brand.
- [ ] All four auth methods and TOTP work end-to-end in a Playwright test. **Partly**: password and TOTP are; sign-in links are covered at the HTTP layer instead, and Google and GitHub wait on the OAuth credentials listed under external dependencies. See [the milestone doc](../completed/M0-skeleton.md#exit-criteria).
- [x] Every negative test in DOMAIN-RULES §1.6 passes and is required in CI.
- [x] Killing the relay between commit and publish loses no job; a rolled-back transaction enqueues nothing.
- [x] Two admin sessions on different api replicas see each other's presence change within 5 seconds.
- [x] CI is green and is a required check on `main`.
- [x] [`docs/completed/M0-skeleton.md`](../completed/M0-skeleton.md) describes what was built.

---

### Phase 1 — Core desk

Goal: agents can work tickets that arrive by email, with Zoho-style discipline. Usable internally before any customer-facing surface exists.

#### M1 Ticketing core

Depends on: M0.

| Id | Deliverable | Spec |
|---|---|---|
| M1-01 | Brands: create with prefix and per-brand ticket sequence; departments, teams, team members; user role per brand | R §3 |
| M1-02 | Tickets: full field set, system states + custom statuses with `pauses_sla` and `awaiting_customer` flags, built-in Awaiting customer and Spam statuses, priorities with editable labels, channels enum | R §4.1, D §2.1 |
| M1-03 | Messages: public replies, internal notes, system entries; sanitized HTML; activity log for every state change with actor and origin | R §4.1 |
| M1-04 | Contacts and accounts: identity merge across email/phone/telegram/visitor id; contact timeline | R §4.1 |
| M1-05 | Views: personal and shared saved filters; defaults (My open, Unassigned, Overdue, All open per department, Escalated) | R §4.1 |
| M1-06 | Tags, custom fields (text, number, date, select, multi-select, checkbox) on ticket, contact, account; ticket templates | R §4.1 |
| M1-07 | Assignment: manual, round-robin per department, skill-based, load cap, auto-unassign after 15 min offline using M0-13 presence | R §4.1, D §12 |
| M1-08 | Ticket state machine: transition table, `auto_await_on_agent_reply`, per-brand reopen policy (`within_days` default 7, `always`, `never`) editable by Team Leaders, parent–child linking for continued tickets | D §2.2, §2.3 |
| M1-09 | Merge and split with the exact semantics in D §2.4 (secondary closed and linked, messages shown inline not moved, clocks stopped, 24 h unmerge; split copies messages and starts fresh clocks); agent collision indicator over the M0-13 gateway | R §4.1, D §2.4 |
| M1-10 | Media pipeline: presigned PUT, `media.process` job with sharp (WebP, thumbnails, EXIF strip), ffmpeg for audio/video, ClamAV optional, presigned GET issued only after authorization on the parent ticket | A §9, D §4.5 |
| M1-11 | Spam: mark as spam, sender block list, spam status semantics (no auto-responder, no CSAT, excluded from reports) | R §4.1, D §2.2 |
| M1-12 | Time tracking (toggle), CSAT model and rating page with single-use signed tokens (delivery wired per channel later) | R §4.1, D §4.6 |
| M1-13 | Contact identity rules: verified vs unverified identifiers, auto-merge only on verified matches, duplicate suggestions, manual merge with 24 h undo, participants (contact + CCs) on tickets | D §2.5, §4.4 |
| M1-14 | Data retention settings per brand and nightly `maintenance.retention` job for tickets, spam, audit log, visitor sessions, outbox; contact anonymisation action | D §11 |
| M1-15 | Admin UI for all of the above; ticket list index set `(brand_id, department_id, status, updated_at)`, `(brand_id, assignee_id)`, tsvector GIN | R §5.2 |

Exit criteria:

- [x] An agent can create, assign, reply to, note, tag, merge, split and close tickets in the admin UI, in English and Arabic. All eight verbs have browser tests in both locales; tagging came last, with the details panel's tags row (M1-15, `Admin/Ticket-Tags`). See [the milestone doc](../completed/M1-ticketing-core.md#exit-criteria).
- [x] An Agent cannot see or open a ticket in another department, by list, by direct URL, by contact timeline, or by socket room.
- [x] Every transition in DOMAIN-RULES §2.2 and each reopen policy value has a test.
- [x] Every new tenant table has brand and, where applicable, department RLS policies and is covered by the negative test suite.
- [x] Ticket list of 50k seeded tickets loads under 150 ms p95 under the D §14 conditions.

#### M2 Email channel

Depends on: M1.

| Id | Deliverable | Spec |
|---|---|---|
| M2-01 | `ChannelAdapter` interface and `ConversationRouter` (find contact, find open ticket by thread key, else create) | A §8 |
| M2-02 | Inbound IMAP: imapflow per mailbox as repeatable `email.poll` job, mailparser, dedupe by `Message-ID`, attachments to S3 | R §4.4 |
| M2-03 | Inbound parse webhooks: Postmark, SendGrid, Mailgun, Resend, generic JSON at `/internal/inbound-parse/*` with shared secret | R §4.4 |
| M2-04 | Threading: thread hint (`In-Reply-To`/`References` or `[PREFIX-N]`) **and** sender-is-participant check, otherwise new ticket with a mismatch note; quoted-reply stripping; inline images preserved; auto-generated senders never create tickets | R §4.4, D §4.3 |
| M2-05 | Outbound SMTP: Nodemailer per brand, `From`/`Reply-To` per department, HTML + text, agent signatures, `email.send` consumed from the outbox with deterministic `Message-ID` per ticket message (idempotent), retries and DLQ; CC participants receive public replies | R §4.4, D §2.5, §6 |
| M2-06 | Auto-responders: acknowledgment and out-of-hours; loop protection (`Auto-Submitted`, `Precedence: bulk`, per-sender cap) | R §4.4 |
| M2-07 | Email security: sanitized HTML allowlist, no scripts or forms, remote image proxy/block toggle, optional SPF/DKIM-failure spam heuristics | R §5.1 |
| M2-08 | Admin: mailbox CRUD with IMAP/SMTP test buttons, inbound-parse endpoint config, health status | R §4.10 |

Exit criteria:

- [x] Email to a mailbox creates a ticket; agent reply arrives in the customer's inbox; customer reply threads onto the same ticket. Verified with Mailpit in CI. See [the milestone doc](../completed/M2-email-channel.md#exit-criteria).
- [x] A reply quoting a valid ticket number from a non-participant address creates a separate ticket and never attaches to the original. See [the milestone doc](../completed/M2-email-channel.md#exit-criteria).
- [x] Delivering the same outbox job twice sends one email. See [the milestone doc](../completed/M2-email-channel.md#exit-criteria).
- [x] Sending fails gracefully into the DLQ, visible in admin. See [the milestone doc](../completed/M2-email-channel.md#exit-criteria).

#### M3 Automation and SLAs

Depends on: M1. Can run in parallel with M2.

| Id | Deliverable | Spec |
|---|---|---|
| M3-01 | Business hours, holidays, timezone per brand and optionally per department | R §4.2 |
| M3-02 | SLA engine implementing D §3: two clocks with elapsed-time accounting in business hours, pause/resume on `pauses_sla`, recompute on priority/department/policy change, `ai_counts_as_first_response` toggle, `counts_as_response` on rule actions, reopen clocks, breach once per clock, escalation steps by percent, timers keyed per clock and step, `sla.rebuild` on worker boot; unit tests reproduce the worked examples in D §3.6 | R §4.2, D §3 |
| M3-03 | Workflow rules engine: events, conditions, actions; ordered; depth guard 3 with cycle detection; execution log | R §4.3 |
| M3-04 | Time-based rules on a cron queue | R §4.3 |
| M3-05 | Rule builder UI with test-run against a sample ticket | R §4.3 |
| M3-06 | Macros and canned responses with placeholders and `en`/`ar` variants | R §4.1 |
| M3-07 | Notifications: in-app over the M0-13 `/staff` namespace, email, web push (VAPID) for assignment, reply, mention, SLA warning/breach, escalation; per-user preferences; all sends via outbox | R §4.9, D §6 |
| M3-08 | Admin audit log viewer | R §4.10 |

Exit criteria:

- [x] A rule "on create, if subject contains X, assign to team Y and reply with canned Z" runs and is logged, with a real canned response. See [the milestone doc](../completed/M3-automation-and-slas.md#exit-criteria).
- [x] An SLA breach fires escalation and a notification, and pauses correctly on Awaiting customer. See [the milestone doc](../completed/M3-automation-and-slas.md#exit-criteria).
- [x] The four worked examples in DOMAIN-RULES §3.6 pass as unit tests to the minute. See [the milestone doc](../completed/M3-automation-and-slas.md#exit-criteria).
- [x] Deleting Redis while tickets are open and restarting the worker recreates every timer. See [the milestone doc](../completed/M3-automation-and-slas.md#exit-criteria).
- [x] Rule loop is prevented by a test. See [the milestone doc](../completed/M3-automation-and-slas.md#exit-criteria).

---

### Phase 2 — Customer surfaces

Goal: customers can reach the desk through the widget, the help center and Telegram. Everything in this phase is public-facing and must pass the security checklist before merge.

#### M4 Widget and realtime

Depends on: M1, M3 (notifications).

| Id | Deliverable | Spec |
|---|---|---|
| M4-01 | Widget build: Preact + Shadow DOM, Vite lib mode, single `widget.js`, size check in CI (< 40 KB gzipped) | R §4.6, A §12 |
| M4-02 | Visitor identity per D §4.1–4.2: server-issued `visitor_id` + `visitor_secret` (hashed at rest) as the credential, conversation ownership by visitor, unverified pre-chat email with agent badge, optional signed identity (HMAC, 5-minute window) that links a verified `external_id` and grants continuity for widget conversations only, `signed_identity_sees_all_channels` toggle | A §7, D §4.1, §4.2 |
| M4-03 | Origin allow-list on config, token and Socket.IO handshake; per-visitor and per-IP throttles; optional Turnstile before first message | R §5.1 |
| M4-04 | Realtime delivery contract per D §7: `client_id` + per-conversation `seq`, dedupe on `(conversation_id, client_id)`, "sending/sent/not sent" UI states, cursor catch-up `?after=<seq>` on reconnect and on gaps, SSE fallback with the same payloads, ephemeral typing/presence/queue position; `/widget` namespace on the M0-13 gateway | A §8, D §7 |
| M4-05 | Four modes: chat, chat + suggested articles (stub until M7), help center only (stub until M5), contact form | R §4.6 |
| M4-06 | Theme tokens with live preview in admin; dark/light/auto; RTL by locale | R §4.6 |
| M4-07 | Rich content policy per brand: text, emoji, images, video, voice, files with size and MIME caps; voice via MediaRecorder normalized to Opus | R §4.6 |
| M4-08 | Pre-chat form, business-hours awareness, transcript by email, agent avatar/name | R §4.6 |
| M4-09 | Hosted web form per brand with custom fields and CAPTCHA toggle | R §4.4 |
| M4-10 | Widget protocol documented in `docs/guides/widget-protocol.md` for native apps | R §4.6 |
| M4-11 | Accessibility: keyboard, focus, contrast, ARIA live regions | R §5.4 |

Exit criteria:

- [x] Widget embedded on two origins under two brands, each with its own theme, exchanging messages with agents in the admin. See [the milestone doc](../completed/M4-widget-and-realtime.md#exit-criteria).
- [x] Requests from a non-allowed origin are rejected in an E2E test. See [the milestone doc](../completed/M4-widget-and-realtime.md#exit-criteria).
- [x] Dropping the network mid-send, restarting the api, and double-submitting each leave exactly one message and the widget catches up without user action (Playwright with network interruption). See [the milestone doc](../completed/M4-widget-and-realtime.md#exit-criteria).
- [x] A visitor with a guessed or leaked email address cannot open another contact's conversations. See [the milestone doc](../completed/M4-widget-and-realtime.md#exit-criteria).
- [x] Initial bundle ≤ 40 KB and lazy chunk caps pass in CI per D §14. The real transport is a lazy chunk, so first paint waits for it ([ADR 0012, amendment](../decisions/0012-widget-bundle-shape.md#amendment-the-transport-is-a-lazy-chunk-2026-09-27)). See [the milestone doc](../completed/M4-widget-and-realtime.md#exit-criteria).

#### M5 Help center

Depends on: M1. Can run in parallel with M4.

| Id | Deliverable | Spec |
|---|---|---|
| M5-01 | Content model: category → section → article, versions per locale, draft/published/archived, scheduled publish, fallback locale | R §4.5 |
| M5-02 | Editor (per ADR): rich text, images to WebP, code, callouts, tables, video embed, anchors; Markdown import/export | R §4.5 |
| M5-03 | SSR app served by api on brand host; Redis page cache keyed by audience with invalidation; ETag; `Cache-Control: public` for public pages only, `private, no-store` for internal pages and staff sessions | A §11, D §5 |
| M5-04 | SEO: canonical, hreflang, sitemap per brand, OG, JSON-LD | A §11 |
| M5-05 | Search: tsvector per language (`english`, `arabic`) + trigram fuzzy; semantic merge added in M7; search log with zero-result tracking | R §4.5 |
| M5-06 | Theme tokens, logo, favicon, sanitized custom CSS, header/footer links, home layout | R §4.5 |
| M5-07 | Custom domains: CNAME + TXT verification in admin, `/internal/domain-check` for Caddy on-demand TLS, "proxied by Cloudflare" flag | A §3, §11 |
| M5-08 | Article feedback, view counts, "Still need help?" handoff to widget/form with article context | R §4.5 |
| M5-09 | Visibility model: `public`/`internal` on article versions, internal-only help center mode, sitemap and search index restricted to public content, state changes propagate to search and (from M7) chunks within 60 s | R §4.5, D §5 |
| M5-10 | Widget "help center" and "chat + articles" modes wired to real content | R §4.6 |

Exit criteria:

- [x] `support.<brand>` answers over TLS with a published article, in both locales, with a valid sitemap. Host routing, both locales and the sitemap are tested; a certificate for a real domain waits on the M5-07 external dependency. See [the milestone doc](../completed/M5-help-center.md#exit-criteria).
- [x] Article search returns results in Arabic and English. See [the milestone doc](../completed/M5-help-center.md#exit-criteria).
- [x] RTL snapshot test passes. See [the milestone doc](../completed/M5-help-center.md#exit-criteria).
- [x] An internal article never appears in the sitemap, public search, or a `public` cached response, tested after toggling an article from public to internal. See [the milestone doc](../completed/M5-help-center.md#exit-criteria).

#### M6 Telegram

Depends on: M2 (adapter interface), M1 (media pipeline).

| Id | Deliverable | Spec |
|---|---|---|
| M6-01 | grammY adapter: webhook mode with secret token in prod, long polling in dev; one or more bots per brand | R §4.4 |
| M6-02 | Identity: `chat_id` → contact; open ticket per chat; agent replies delivered back | A §8 |
| M6-03 | Media: photos, documents, voice (normalized via media pipeline), locations as text | R §4.4 |
| M6-04 | `/start` welcome and language pick | R §4.4 |
| M6-05 | Admin: bot token (encrypted), "set webhook" button, health | R §4.10 |

Exit criteria:

- [x] A Telegram message creates a ticket and the agent reply arrives in the chat, tested against a mocked Bot API. See [the milestone doc](../completed/M6-telegram.md#exit-criteria).

---

### Phase 3 — Intelligence

Goal: grounded AI that assists agents and deflects simple questions, under strict guardrails.

#### M7 AI

Depends on: M5 (articles as knowledge), M4 and M6 (auto-reply surfaces), M3 (rule actions).

| Id | Deliverable | Spec |
|---|---|---|
| M7-01 | Provider layer on pi-ai: API key and OAuth/subscription credentials (encrypted), model discovery, per-brand override, cost tracking in `ai_calls` | R §4.7, A §10 |
| M7-02 | Embeddings per D §8: one install-wide model, `vector(<dims>)` column and HNSW index created by `knowledge.configure`, `embedding_model` on every chunk filtered at retrieval, `knowledge.reembed` job with `reindexing` status that never serves mixed spaces, 2000-dim limit | A §10, D §8 |
| M7-03 | Ingest: articles (auto), files (PDF via unpdf, DOCX via mammoth, MD, TXT), crawl (sitemap/seed, cheerio, optional Playwright, through the M0-15 SSRF-safe client, `robots.txt`), Notion, Google Drive; chunker; sync schedule and status; `visibility` per source defaulting to `internal`; removal deletes chunks immediately | R §4.7, D §5, §11, §13 |
| M7-04 | Hybrid retrieval with `audience`: visibility and published filters in SQL before ranking for `visitor`, pgvector + tsvector with reciprocal rank fusion and locale boost, post-generation citation validation with degrade-to-handoff; semantic search merged into help center and widget suggestions | A §10, D §5 |
| M7-05 | Agent assist: suggest reply with citations, summarize, suggest tags/priority/department, translate AR↔EN, rewrite tone, draft article from ticket (Team Leader approval) | R §4.7 |
| M7-06 | Auto-reply on widget, Telegram and email with confidence threshold, transparent handoff, "talk to a human", AI badge and citations; `ai_paused_until` handoff persistence checked immediately before every send, "return to assistant" staff action; AI reply satisfies first-response SLA per brand toggle | R §4.7, D §3.1, §9 |
| M7-07 | Auto-triage as a workflow action | R §4.7 |
| M7-08 | Guardrails: PII redaction (reversible for agents), injection filter on ingested content, no tools, per-brand daily/monthly budget with 80 % alert and hard stop, output logging visible on ticket, per-brand system prompt | R §4.7 |
| M7-09 | Voice transcription job (Whisper-compatible endpoint) shown to agents | R §4.6 |
| M7-10 | Admin: providers, models, embeddings, knowledge sources with "sync now" and logs, modes, guardrails, budget, prompt; LLM provider step added to the first-run wizard | R §4.10 |
| M7-11 | Evaluation harness: EN + AR eval set over a fixture knowledge base, LLM-judge scoring, citation validity check, nightly CI job against a real provider, report published as a CI artifact | D §9 |

Exit criteria:

- [x] Auto-reply answers a question from an uploaded PDF with a citation, and hands off when confidence is below threshold, in an E2E test with a mocked provider. See [the milestone doc](../completed/M7-ai.md#exit-criteria).
- [x] The evaluation run meets every threshold in DOMAIN-RULES §9 for both English and Arabic. The harness and nightly workflow are in (M7-11) and pass in mock mode; the live run against a real provider passed every threshold on 2026-10-19 ([run 39322685646](https://github.com/Docker-Hunterpedia/Helpdock/actions/runs/39322685646), #161: `glm-4.6` answering, `glm-5.1` judging, `bge-m3:567m` embeddings; answerable en 97.5 %, ar 94.6 %; unanswerable handed off 100 % in both). One provider pair only. See [the milestone doc](../completed/M7-ai.md#exit-criteria).
- [x] After a handoff, no auto-reply is sent for the rest of the conversation even if a queued job fires late. See [the milestone doc](../completed/M7-ai.md#exit-criteria).
- [x] A visitor-audience query never retrieves an internal chunk (SQL-level test), and a fabricated citation is dropped. See [the milestone doc](../completed/M7-ai.md#exit-criteria).
- [x] Budget hard stop disables auto-reply and is visible in admin. See [the milestone doc](../completed/M7-ai.md#exit-criteria).
- [x] PII redaction is covered by unit tests for emails, phones, cards (Luhn), IBANs. See [the milestone doc](../completed/M7-ai.md#exit-criteria).

---

### Phase 4 — Release

Goal: integrations, reporting, hardening and a public `1.0.0`.

#### M8 API, webhooks, reports

Depends on: M1, M3. May run in parallel with M7.

| Id | Deliverable | Spec |
|---|---|---|
| M8-01 | Tenant API keys: `hd_live_*` shown once, SHA-256 stored, scopes, per-key throttle, last used, revoke | R §4.11, A §7 |
| M8-02 | REST v1: tickets CRUD + messages, contacts upsert/search, articles search/get, webhooks CRUD; idempotency keys; OpenAPI 3.1 at `/api/docs` generated from Zod | R §4.11 |
| M8-03 | Outbound webhooks: events, HMAC-SHA256 signature, retries with backoff, delivery log, replay; delivered through the M0-15 SSRF-safe client, responses never followed | R §4.12, D §13 |
| M8-04 | Reports: volume by channel/status/priority, first-response and resolution time, SLA compliance, backlog trend, CSAT, agent workload, busiest hours, top and zero-result searches, AI deflection and cost; CSV export; `stats.rollup` cron | R §4.8 |
| M8-05 | System page: version, migrations, queue health with Bull Board, channel status, storage usage, LLM spend | R §4.10 |
| M8-06 | CSAT delivery wired on close for email, widget, Telegram | R §4.1 |
| M8-07 | Brand deletion with 30-day grace and full purge (rows, S3 prefix, Redis keys, Caddy domain); product metrics on the System page (activation, deflection, self-service) | D §11, §15 |

Exit criteria:

- [x] A ticket created via the API triggers a signed `ticket.created` webhook received by a test endpoint. See [the milestone doc](../completed/M8-api-webhooks-reports.md#exit-criteria).
- [x] Reports match seeded data in an integration test. See [the milestone doc](../completed/M8-api-webhooks-reports.md#exit-criteria).

#### M9 Hardening and 1.0

Depends on: everything above.

| Id | Deliverable | Spec |
|---|---|---|
| M9-01 | External pentest of widget + API; fix all High and Medium findings | R §7 |
| M9-02 | OWASP ASVS L2 checklist walk-through with evidence recorded in `docs/completed/` | R §5.1 |
| M9-03 | Load tests: ticket list p95, help center TTFB, realtime latency; index and cache tuning | R §5.2 |
| M9-04 | Accessibility audit (axe + manual keyboard) on widget and help center | R §5.4 |
| M9-05 | Semgrep rules for Nest, ZAP baseline scan on release branches, SBOM on release | A §15, §16 |
| M9-06 | User docs under `docs/guides/`: install, configuration, channels, help center, AI, API, security, widget protocol, **operations** (backup, restore, upgrade, master key rotation, Redis loss) | A §2, D §10 |
| M9-07 | Onboarding test on a clean VM against the 30-minute target; usability pass with three outside testers on the 3-click reply task; fix friction | R §7, D §15 |
| M9-08 | Release pipeline: Changesets, multi-arch image to GHCR, GitHub release with changelog | A §16 |
| M9-09 | Tag `1.0.0`, after M11's exit criteria are met | |
| M9-10 | Restore drill: dump + bucket + `.env` restored on a clean VM within RTO; master key rotation rehearsed; results recorded in `docs/completed/` | D §10 |

Exit criteria:

- [x] All success metrics in §2 are met and recorded, including the AI evaluation thresholds and the restore drill. The AI evaluation is recorded with its run, [run 39322685646](https://github.com/Docker-Hunterpedia/Helpdock/actions/runs/39322685646) (2026-10-19, #161), in [the M9 doc](../completed/M9-hardening-and-1-0.md#ai-evaluation-with-a-chat-only-key). The owner confirmed on 2026-10-19 that the pentest (#153), performance run (#154), screen-reader pass (#155), clean-VM onboarding and outside testers (#157) and restore drill (#160) are complete; their results are held by the owner and are not recorded in this repository.
- [x] `ghcr.io/docker-hunterpedia/helpdock:1.0.0` is published and the README install instructions work against it. Published on 2026-10-20 for `linux/amd64` and `linux/arm64`, signed and verified with Cosign, with the [GitHub Release](https://github.com/Docker-Hunterpedia/Helpdock/releases/tag/v1.0.0) and its SBOM; `HELPDOCK_VERSION=1.0.0 ./scripts/compose-smoke.sh` passed against the pulled image ([record](../completed/M9-hardening-and-1-0.md#m9-09-the-100-release)).

#### M10 Meta channels

Depends on: M6 (the channel pattern), M9's code side. Runs beside M9's remaining items, which need people rather than code. Design: [ADR 0025](../decisions/0025-meta-channels-through-one-graph-adapter.md). Milestone doc: [docs/completed/M10-meta-channels.md](../completed/M10-meta-channels.md).

| Id | Deliverable | Spec |
|---|---|---|
| M10-01 | Schema, config and the shared Graph adapter: `meta_accounts`, `meta_conversations`, `meta_deliveries` with RLS; the `whatsapp`, `messenger`, `instagram` channel and identity kinds; `META_*` keys and the `meta.*` settings; `packages/channels/src/meta/` (Graph client over the M0-15 SSRF-safe client with a host allow-list, `X-Hub-Signature-256`, envelope schemas, error classifier, splitter); the Graph stand-in and signed-webhook driver for tests | A §5, §8, §13, D §13 |
| M10-02 | Webhook: `GET\|POST /api/meta/webhook`, handshake, raw-body signature check against the app secrets, routing by `object` and `entry[].id` to the account across brands, one transaction per entry, dedupe on the platform message id, 200 after a valid signature | D §6 |
| M10-03 | WhatsApp inbound → tickets: identity on the business-scoped user id with `wa_id` as a verified phone; text, media through `meta.media_fetch` and the M1-10 pipeline with the digest check; locations and contacts as text; `user_changed_number`; delivery statuses | R §4.4, D §4.4, §4.7, §4.8 |
| M10-04 | Messenger inbound → tickets: page-scoped id, CDN attachments, echoes of Helpdock's sends dropped, delivery and read watermarks, reactions and edits as system lines | R §4.4, D §4.7, §4.8 |
| M10-05 | Instagram inbound → tickets through the Instagram API with Instagram Login: Instagram-scoped id and `@username`, story replies and mentions, unsent messages marked, `messaging_seen` | R §4.4, D §4.7, §4.8 |
| M10-06 | Agent replies on all three through the delivery hooks: the reply window refused at compose time and checked again in `meta.send`, per-platform splitting, attachments as messages of their own, per-recipient pacing, deliveries with `delivered`, `read`, `refused` and `failed` with Retry | A §8, §13, D §2.6, §6 |
| M10-07 | Admin: Channels › Meta with the App card, connecting an account per platform by pasted token, Test, Subscribe, health, Human Agent switch, Disconnect; the System page's Channels card | R §4.10 |
| M10-08 | Ticket thread: channel chip, "via" and "to" lines, delivery states, the reply-window strip with Send disabled when closed, the composer's message count, the channel identity card per platform | DESIGN §6.3, D §2.6 |
| M10-09 | WhatsApp templates (sync, picker, send after the window) and the Messenger and Instagram `HUMAN_AGENT` tag for a person's reply between 24 h and 7 d when the account's switch is on. May ship after the rest; the tag shipped early, with M10-06, after the review found the extended window open and its replies untagged | D §2.6 |
| M10-10 | Health jobs: `meta.health` per account (token check, `subscribed_apps` with re-subscribe, Instagram token refresh) and Reconnect | A §13 |
| M10-11 | Docs: `docs/guides/meta-channels.md` (dashboard walk-through, App Review, pricing, limits), the configuration, channels, contacts, tickets and retention guides, `.env.example`, OpenAPI | A §2 |

Exit criteria:

- [x] A message on each platform opens a ticket with the right contact: WhatsApp on the business-scoped user id with the phone recorded as verified, Messenger on the page-scoped id, Instagram on the Instagram-scoped id with the `@username`; two accounts of two brands in one batch file two tickets, each in its brand.
- [x] A reply from the ticket arrives on the same platform, once when the job runs twice, and shows Sent, Delivered and Read from the status webhook.
- [x] A reply after the window is refused at compose time with `reply-window-closed`, and one whose window closed while queued is recorded `refused` with the platform's code and never retried.
- [x] Brand A cannot read brand B's rows in the three new tables (DOMAIN-RULES §1.6).
- [x] The stand-in suites pass in CI: webhook, inbound per platform, replies, health.
- [x] Channels › Meta and the Meta ticket pass Playwright in `en` and `ar` with axe. See [the milestone doc](../completed/M10-meta-channels.md#exit-criteria).

#### M11 SSO and migration

Depends on: M0 (auth, settings, outbox, SSRF-safe client), M1, M3, M5, M8. Part of 1.0: M9-09 waits for its exit criteria. Design: [ADR 0026](../decisions/0026-staff-sso-over-saml-and-oidc.md), [ADR 0027](../decisions/0027-imports-through-one-normalised-record-engine.md). Milestone doc: [docs/completed/M11-sso-and-migration.md](../completed/M11-sso-and-migration.md).

| Id | Deliverable | Spec |
|---|---|---|
| M11-01 | SSO schema, settings and shared service: `sso_connections`, `sso_role_mappings`, `user_sso_identities` (install scope), `user_brand_roles.source`, `sso.*` settings, the SP key, the Redis request store, audit | A §7, R §5.1 |
| M11-02 | OIDC sign-in through `openid-client` with discovery and JWKS over the SSRF-safe client, PKCE, `state` and `nonce` | A §7, D §13 |
| M11-03 | SAML sign-in through `@node-saml/node-saml`: SP metadata, signed AuthnRequest, ACS with signed assertions, single-use `InResponseTo`, certificate rotation | A §7 |
| M11-04 | Sign-in integration: linking, JIT provisioning, group-to-role sync at every sign-in, IdP MFA, enforcement with break-glass, email-first discovery, invites through SSO | A §7, D §1 |
| M11-05 | Admin: Settings › Single sign-on, connection page with mappings and Test, sign-in buttons and discovery, Staff badges | R §4.10 |
| M11-06 | SSO docs: `docs/guides/sso.md` with Okta, Entra ID, Google Workspace and Keycloak walk-throughs; authentication and configuration guides | A §2 |
| M11-07 | Import schema: `import_runs`, `import_records`, `import_mappings`, `import_external_ids`, `import_log`, `import_file_presets` with RLS; `tickets.imported_at`, `tickets.import_source`, `attachments.origin`, `ticket_messages.author_display`; the `import` queue | A §5, §13 |
| M11-08 | Normalised import records and the Helpdock import bundle format | A §5 |
| M11-09 | The loader: direct writes with no lifecycle hooks and no outbound events, original dates kept, idempotent, reports rebuilt over the imported range | D §2, §4, §7 |
| M11-10 | Import jobs: extract, load, attachments, finish; resumable, rate-limit aware, pause and cancel, dry run, delta sync, credentials purged at the end | A §13 |
| M11-11 | Connector SDK (`@helpdock/importers`) and a stand-in server per vendor | A §5 |
| M11-12 | Zendesk connector | |
| M11-13 | Freshdesk connector | |
| M11-14 | Zoho Desk connector | |
| M11-15 | Manual mapper: CSV or bundle upload, column mapping with transforms, preview, saved presets | |
| M11-16 | Admin: Brand › Import with the wizard (source, connect, scope, map, dry run, import, done) | R §4.10 |
| M11-17 | Imported tickets in the workspace: "Imported from" chip, activity line, view filter, System page card | DESIGN §6.3 |
| M11-18 | Import docs: `docs/guides/importing.md` with the cutover runbook; retention, reports, tickets guides | A §2 |
| M11-19 to M11-23 | Help Scout, Intercom, Gorgias, Zammad and Front connectors on the same SDK. Deferred to later work by the owner on 2026-10-17; moved on 2026-10-20 to [M16](#m16-more-importers-and-undo) as M16-04 to M16-08, keeping issues #201 to #205 | |

The 2026-10-18 owner-review corrections pass the named suites in the
[milestone evidence index](../completed/M11-sso-and-migration.md#evidence-index-2026-10-18)
and all 25 checks on implementation commit `1e053b1`, including the three native
reference imports. PR #215 merged on 2026-10-18 and was released in v0.6.0.
Real-provider runs remain in External dependencies; the owner ruled on
2026-10-19 that they are not 1.0 blockers, because M11 is verified against the
stand-ins and the vendors' published API documentation.

Exit criteria:

- [x] A staff member signs in through an OIDC IdP and a SAML IdP; the first sign-in creates the account and memberships from the IdP's groups; a group removed in the IdP removes the matching SSO role at the next sign-in.
- [x] With SSO enforced, password, magic link and OAuth are refused for everyone except the break-glass install admin.
- [x] Zendesk, Freshdesk and Zoho Desk accounts (stand-ins with the reference dataset) import into a brand with every thread, author, date, note, attachment, tag, field and assignee intact.
- [x] An import sends nothing: no email, Telegram or Meta send, webhook, rule run, SLA clock, notification or AI call exists for imported tickets.
- [x] Reports show the imported history on its original days.
- [x] A repeated import writes nothing, a delta brings only changes, and a resumed import loses and duplicates nothing.
- [x] A CSV from a tool without a connector imports through the manual mapper.
- [x] Brand A cannot read brand B's import tables (DOMAIN-RULES §1.6); vendor credentials are never returned and are deleted when a run ends.
- [x] The SSO and Import screens pass Playwright in `en` and `ar` with axe.

---

### Phase 5 — 1.x

Goal: make Helpdock better to run, to work in and to move to, release by release after 1.0, without loosening any rule 1.0 shipped with. Planned on 2026-10-20; nothing in this phase has started.

Each milestone has a plan document in [`docs/in-development/`](../in-development/README.md) with `Status: planned (not started)`, written in the shape M11 used: scope and non-goals, deliverables with effort and dependencies, data model, API, proposed domain-rule changes, security, artboards, tests, docs, ADRs, risks, open questions, build order and exit criteria. A milestone starts as §3 says: its doc moves to `in progress` and its issues are created. The open questions of every plan are gathered, numbered `D-01` to `D-61`, with the plans' recommendations, in [decisions-1-x.md](decisions-1-x.md). The ADRs the plans need are written as proposed, [0028](../decisions/0028-ai-workspace-runs-the-production-path-dry.md) to [0057](../decisions/0057-desktop-shell-on-electron.md).

DOMAIN-RULES, ARCHITECTURE and DESIGN.md do not change now. Each plan carries the rule changes it proposes, and they land in the pull request of the deliverable that needs them; the section numbers the plans give new rules (§2.7 to §2.9, §10.1, §12.1, §17 to §20) are provisional until then. Scope statements in REQUIREMENTS and the backlog below are updated now.

Every milestone is useful on its own, so the phase can stop after any of them. Effort is in working days for one experienced contributor, Definition of done included. After the drafts were written, the plans were checked against a full walk through another open-source helpdesk's screens; the gaps worth closing were added as deliverables (M12-17, M14-25 to M14-29, M16-15, M19-10 and small additions to M12-02, M13-11, M19-01 and M19-05, about 20 days in all), and the rest are listed with reasons in [decisions-1-x.md](decisions-1-x.md#prior-art-gap-check).

**Proposed releases** (a proposal for the owner, [D-01](decisions-1-x.md#general)):

| Release | Contents | Effort (person-days) |
|---|---|---|
| 1.0.1 | Security and UX patch, in flight in separate pull requests: OAuth sign-in identities bound by subject (the first part of M18-07, [ADR 0051](../decisions/0051-oauth-identities-bound-by-subject.md)) and group A of the [1.0 UX review](../completed/ux-review-1-0.md) | — |
| 1.1 | M12 AI workspace, M14 Inbox productivity, M18 Sign-in options, and Helpdock as an MCP server (M13-09 to M13-11, pulled forward because it gives Helpdock's own model no tools and so fits the 1.0 AI rule) | about 225 |
| 1.2 | The rest of M13, M15 Self-host operations, M16 More importers and undo, M19 Customer surfaces polish | about 249 |
| 1.3 | M17 Apps and languages | about 59 |
| Later 1.x | M20 Native clients and SDKs, once M17's installable admin has shown demand | 45–57 |

#### M12 AI workspace

Depends on: M7, M3 (rules), M4 (widget), M8 (reports, API keys). About 72 working days. Proposed for 1.1. Design: ADRs [0028](../decisions/0028-ai-workspace-runs-the-production-path-dry.md), [0029](../decisions/0029-staff-assistant-reads-through-validated-read-plans.md), [0030](../decisions/0030-ai-decisions-in-automation-are-confidence-gated.md), [0031](../decisions/0031-personas-change-the-voice-never-the-rules.md) (proposed). Plan: [M12-ai-workspace.md](../in-development/M12-ai-workspace.md). Decisions: D-04 to D-10.

Gives the people who run a brand's assistant the tools to make it good and keep it good: a playground, saved tests, a review queue that turns a bad answer into a Q&A snippet, cost estimates and usage, writing, guardrails and personas, confidence-gated triage, an AI yes/no rule condition, ticket summaries that stay current, and a read-only staff assistant panel. All of it inside the 1.0 rule: the model reads and writes text and never calls a tool.

| Id | Deliverable | Spec |
|---|---|---|
| M12-01 | Schema, settings and permissions: personas, tests and runs, snippets, review items, summaries, rule answers, assistant threads, each with `FORCE`d RLS; `ai_calls.actor_user_id`; nullable `notifications.ticket_id` | A §5; D §1.6 |
| M12-02 | Writing (tone, reply language, Instructions) and Guardrails (declined topics, reply cap, email before handoff) | R §4.7; D §9 |
| M12-03 | Personas: up to 10 per brand, uploaded avatar, assignment per widget, mailbox and Telegram bot; the AI badge always shown | R §4.6, §4.7 |
| M12-04 | Playground: the production auto-reply path run dry with unsaved settings overlaid; writes nothing but `ai_calls` | ADR 0028 |
| M12-05 | Saved tests with expectations, run as a job, and "Run tests with these changes first" on save | ADR 0028; D §9 |
| M12-06 | Needs review, Improve answer, and Q&A snippets as a knowledge source kind | D §5 |
| M12-07 | Overview: a readiness checklist and date-ranged figures | D §15 |
| M12-08 | Cost estimates next to every AI toggle; usage by feature, day, staff member and model with CSV | ADR 0018 |
| M12-09 | Budget notifications at 80 % and 100 %, provider-failure and handoff notifications, a quiet handoff at the hard stop, a headroom check | R §4.7 |
| M12-10 | Confidence-gated triage: mode `auto` with a threshold, raise-only priority, add-only tags, guarded department moves | R §4.7; ADR 0030 |
| M12-11 | AI yes/no rule condition, at most 3 per event rule, batched into one call per event and cached | R §4.3; ADR 0030 |
| M12-12 | Ticket summaries kept current in the background | R §4.7 |
| M12-13 | Staff assistant panel, read-only, reading through validated read plans under the user's own permissions | ADR 0029 |
| M12-16 | Draft one article from several solved tickets, from public messages and knowledge only | R §4.5, §4.7 |
| M12-14 | Eval extension: declined topics, reply limit, persona, triage, AI questions, panel reads | D §9 |
| M12-17 | More assist rewrites (longer, fix spelling and grammar, simpler) and draft with instructions | R §4.7 |
| M12-15 | Docs, OpenAPI, widget protocol, DESIGN §6 components | AGENTS.md DoD |

Exit criteria:

- [ ] A playground answer to an unsaved Instructions change shows answer, citations, confidence, decision and cost, and leaves no `tickets`, `ticket_messages` or `outbox` row.
- [ ] "Run tests with these changes first" runs every test with the draft, shows a newly failing test, and saves only on confirmation.
- [ ] A thumbs-down puts an answer in Needs review; Improve answer creates a public snippet that the next playground answer cites before embedding; an internal snippet never reaches a visitor answer.
- [ ] A declined topic gets the persona's decline line; the reply cap hands off with `reply_limit`; a widget handoff with no email asks for one.
- [ ] A widget, a mailbox and a Telegram bot of one brand answer with three personas, each answer with the AI badge, in `en` and `ar`.
- [ ] Budget, provider and handoff notifications reach the right people once, per their preferences; at 100 % a conversation the assistant was in gets the handoff line with no model call.
- [ ] Usage matches seeded `ai_calls`, and every AI toggle shows an estimate.
- [ ] Triage in `auto` applies above the threshold, suggests below, never lowers a priority, and logs each change with its confidence.
- [ ] A rule with AI questions makes one model call per event and does not run when the budget is spent.
- [ ] The panel answers "which of my tickets breach SLA in the next hour" with links, and an Agent's panel never reads another department's ticket (negative test on the logged prompt).
- [ ] Brand A cannot read brand B's rows in any new table; another user's assistant threads are invisible to an Admin.
- [ ] The eval meets M12's DOMAIN-RULES §9 additions in both languages, live, with the run recorded.
- [ ] Every new screen passes Playwright in `en` and `ar` with axe.

#### M13 AI actions and integrations

Depends on: M12, M8, M0. M13-09 to M13-11 depend only on M8 and M0 and may start beside M12 (D-11). About 72.5 working days, of which the MCP-server track is about 16.5. Proposed: M13-09 to M13-11 in 1.1, the rest in 1.2. Design: ADRs [0032](../decisions/0032-ai-tools-reads-run-changes-wait-for-a-person.md), [0033](../decisions/0033-helpdock-as-an-mcp-server-with-oauth-2-1.md), [0034](../decisions/0034-one-mcp-client-over-safefetch.md) (proposed). Plan: [M13-ai-actions-and-integrations.md](../in-development/M13-ai-actions-and-integrations.md). Decisions: D-11 to D-18.

Lets AI act, with a person's consent every time something changes: reads run, changes become proposals that only the person who asked can approve, executed through the outbox as the approver and audited "on behalf of". Three ways in: outside AI clients through Helpdock's own MCP server, the staff assistant with approval cards and connected integrations, and customer-facing agent tools the visitor confirms. M13-01 replaces the 1.0 rule "no tool calls or actions" (principle 3, REQUIREMENTS §4.7, AGENTS.md) with a written contract; until it merges, the 1.0 rule stands.

| Id | Deliverable | Spec |
|---|---|---|
| M13-01 | The rule change: ADR 0032, DOMAIN-RULES §19, REQUIREMENTS §4.7, principle 3, AGENTS.md; `assertToolPolicy` replaces `assertNoTools` | ADR 0032 |
| M13-02 | Tool runtime on pi-agent-core: registry, turn limits, redaction across turns, tool output screened and wrapped as data, `ai_tool_calls` | ADR 0032 |
| M13-03 | Proposals and approvals: previews computed by Helpdock, an approval token the model never sees, 15 minutes, execution through the outbox | D §19 |
| M13-04 | Staff assistant actions: field and bulk changes (at most 50 tickets), notes, public replies, article drafts, personal views, integration tools | R §4.7 |
| M13-05 | MCP client (`packages/mcp`) over `safeFetch`: Streamable HTTP, OAuth 2.1 with discovery, registration, PKCE and resource indicators | D §13; ADR 0034 |
| M13-06 | Integrations catalog: Linear, GitHub, Jira and Confluence, Sentry, Slack, Notion, Stripe, Zapier, any MCP server by URL | R §4.10 |
| M13-07 | Ticket links back to items created in connected tools | — |
| M13-08 | Customer-facing agent tools: look-up tools, and change tools the visitor confirms in the widget, signed identity by default | R §4.6, §4.7 |
| M13-09 | Helpdock MCP server at `/mcp`, each tool mapped to an existing permission or API scope and run under the user's RLS context | A §7; ADR 0033 |
| M13-10 | OAuth 2.1 authorization server: metadata, dynamic client registration, PKCE S256, refresh rotation with reuse detection, revocation | A §7; ADR 0033 |
| M13-11 | Connected clients: setup per client, the user's grants, Admin revocation; API key expiry in the admin | R §4.10, §4.11 |
| M13-12 | Eval for tool use with a stand-in shop MCP server; zero-tolerance measures | D §9 |
| M13-13 | Security review, pentest-scope addendum, docs | AGENTS.md DoD |

Exit criteria:

- [ ] ADR 0032 is accepted, and AGENTS.md, REQUIREMENTS §4.7, principle 3 and DOMAIN-RULES §19 say the same thing.
- [ ] An MCP client connects to `/mcp` by OAuth with dynamic registration and PKCE, lists only the tools the user's role allows, adds a note as that user, and loses access at once when the grant is revoked or the user leaves the brand; an API key connects with its scopes.
- [ ] An Agent's grant cannot read another department's ticket; a Viewer's cannot write.
- [ ] The staff assistant proposes a bulk priority change for 12 tickets; approval executes it once through the outbox; a ticket changed meanwhile is skipped and listed; an unanswered proposal lapses at 15 minutes.
- [ ] An integration item is created from a ticket after approval and linked back; every outbound request went through `safeFetch`.
- [ ] In the widget, a signed-in visitor's change runs only after Confirm; an unsigned visitor is never offered it; on email the change tool is never offered.
- [ ] Brand A cannot read brand B's rows in any new table.
- [ ] The tool-use eval meets every §9 measure in `en` and `ar`, live, recorded.
- [ ] Every new screen passes Playwright in `en` and `ar` with axe; `security-audit` findings are fixed or accepted in writing, and the pentest scope covers `/mcp`, `/oauth/*`, approvals and widget actions.

#### M14 Inbox productivity

Depends on: M1, M3, M4, M5, M7 (the routing trail only), M8, M11. About 103.5 working days: 75 for the inbox plan, 16 for group B of the [1.0 UX review](../completed/ux-review-1-0.md), and 12.5 for the prior-art gaps M14-25 to M14-29. Shipped for 1.1 on 2026-11-01. Design: ADRs [0035](../decisions/0035-snooze-as-a-system-status.md), [0036](../decisions/0036-bulk-changes-previewed-all-or-nothing-with-undo.md), [0037](../decisions/0037-paced-notification-email-and-digests.md), [0038](../decisions/0038-keyboard-registry-and-command-palette.md) (accepted). Plan, with what was built and the gaps left open: [M14-inbox-productivity.md](../completed/M14-inbox-productivity.md). Decisions: D-19 to D-32.

An agent who lives in Helpdock all day works the queue at the speed of their hands: snooze, bulk edit with undo, a command palette and shortcuts that work on an Arabic keyboard, the routing trail, paced notification email, a customer-facing profile, a setup checklist, and the workspace density fixes from the UX review. Every change goes through the same service paths, RLS, outbox and activity log as a single click; nothing gives the AI a new power.

| Id | Deliverable | Spec |
|---|---|---|
| M14-01 | Keyboard foundation: one registry, physical keys, `g` sequences, the `?` sheet, ticket and list shortcuts, a single-key switch (WCAG 2.1.4) | DESIGN §10; UX-09 |
| M14-02 | Snooze: a seeded Snoozed status, presets from the department's business hours, a wake timer through the outbox | D §2, §3; ADR 0035; UX-26 |
| M14-03 | Bulk edit API: preview and apply on up to 50 tickets, per-ticket authorization, one transaction, Undo within 60 s | ADR 0036; UX-26 |
| M14-04 | Bulk edit UI: checkboxes, the bulk bar, the preview dialog, the Undo toast | DESIGN §6.3; UX-26 |
| M14-05 | Command palette: tickets (exact number first), contacts, articles, pages and settings, actions | ADR 0038; UX-09 |
| M14-06 | Inbox empty states with keyboard hints, and the `Kbd` component | UX-09, UX-10 |
| M14-07 | Sort by SLA due | D §3, §14 |
| M14-08 | Routing trail: arrival recorded on every creation path, "How it got here" on the ticket | D §2 |
| M14-09 | Routing page and a Test routing dry run that writes nothing | R §4.3 |
| M14-10 | Notification pacing: batching with back-off, digests, pause, a read re-check before every send, a presence hold | R §4.9; ADR 0037 |
| M14-11 | Notification settings and one-click unsubscribe (RFC 8058) | ADR 0037 |
| M14-12 | Profile for customers: public name, title, phone, photo, time zone; agent placeholders | R §4.1 |
| M14-13 | Setup checklist that ticks itself | D §15; UX-10 |
| M14-14 | Saved-reply and macro polish: `/shortcut`, `{{` picker, fallbacks, save-time checks | R §4.1 |
| M14-15 | `@` mention picker in notes | R §4.9 |
| M14-16 | Custom-field filters in the list and views, and a pinned field chip (the answer to Severity) | R §4.1 |
| M14-17 | Fields required to close | R §4.1 |
| M14-18 | Idle agents marked away | D §12 |
| M14-19 | Compact composer and workspace breakpoints | UX-01, UX-21 |
| M14-20 | Ticket row and details panel density | UX-07, UX-08 |
| M14-21 | Settings area with grouped sub-navigation, old URLs redirected | UX-11 |
| M14-22 | List-first tickets on narrow screens | UX-13 |
| M14-23 | Skeletons and empty states beyond 1.0.1 | UX-10, UX-12 |
| M14-24 | Docs, ADRs, DESIGN.md and DOMAIN-RULES updates, OpenAPI | AGENTS.md DoD |
| M14-25 | Notification sounds per event, with a reminder while a live chat waits | R §4.9 |
| M14-26 | Mailbox-aware views and rules: mailbox and address-written-to filters and conditions; "set reply address" and "mark as spam" actions | R §4.3 |
| M14-27 | More custom field types: long text, link, email, person | R §4.1 |
| M14-28 | More webhook events for tickets, messages, contacts and accounts | R §4.12 |
| M14-29 | Reports: volume by tag, and backlog by status with its unassigned share | R §4.8 |

Exit criteria:

- [x] A ticket snoozed until the next business day leaves My open, appears in Snoozed and returns to its previous status at the department's opening time; a customer reply wakes it earlier; the wake survives a Redis flush and worker restart.
- [x] While snoozed, the resolution clock is paused and an unanswered ticket's first-response clock keeps running (a worked example to the minute); an SLA warning wakes the ticket.
- [x] An agent selects 30 tickets with `x` and Shift-click, closes them in one request and undoes it from the toast: all 30 are back and no survey was sent.
- [x] A bulk change across two departments, one hidden from the agent, changes only the visible tickets and reports the other as not found.
- [x] ⌘K / Ctrl+K finds `HD-1042` by number, a contact, an article and the SLA settings typed in Arabic, and runs "Assign to me"; a Viewer sees navigation only.
- [x] Every shortcut on the `?` sheet works on an English and an Arabic keyboard layout, and none fires with the single-key switch off.
- [x] Each ticket shows how it arrived and every automatic step after it; Test routing leaves the database, the outbox and the rotation unchanged.
- [x] With *Right away*, twelve notifications in an hour reach the person as no more than six emails; one read in the app first is left out; a daily digest arrives at the chosen hour in the person's time zone; pause sends nothing, later included; a one-click unsubscribe POST stops notification email and a GET changes nothing until confirmed.
- [x] A reply signed `{{agent.name}}, {{agent.title}}` shows the public name and title in the customer's language, in email and in the widget.
- [x] A new brand's Admin sees the setup checklist, and each step ticks itself as it is done.
- [x] At 1280 × 720 the compact composer leaves the conversation readable; below 1024 px the ticket list opens first; every admin setting is reachable from the grouped Settings area and the old URLs redirect.
- [x] A view filtered by mailbox and a rule conditioned on the address written to match a new email ticket; the new custom field types and webhook events work end to end.
- [x] Brand A cannot read brand B's rows in the new tables, and an Agent cannot read another department's bulk items.
- [ ] Every new or changed screen passes Playwright in `en` and `ar` with axe, and the shortcut sheet and palette pass a manual NVDA and VoiceOver run. Axe passes in both locales; the manual run is not done and is carried.

#### M15 Self-host operations

Depends on: M9 (release pipeline, restore drill, `keys rotate`), M11 (the import writer, for sample data). About 67 working days. Proposed for 1.2. Design: ADRs [0039](../decisions/0039-signed-release-bundle-and-installer.md) to [0044](../decisions/0044-supported-deploy-targets.md) (proposed). Plan: [M15-self-host-operations.md](../in-development/M15-self-host-operations.md). Decisions: D-33 to D-39.

An operator gets from a bare Linux VM to a signed, pinned, healthy Helpdock with one command, and every later chore (backup, restore, upgrade, key rotation, health) is one verb that cannot silently lose data. The System page says when a new release is out and when the last backup was taken. Automatic updates are opt-in, patch-only and wait 72 hours. Someone evaluating Helpdock can load a bilingual sample brand that sends nothing and remove it in one click. Success measure: the first-ticket target drops from 30 to 10 minutes on a fresh VM with DNS in place.

| Id | Deliverable | Spec |
|---|---|---|
| M15-01 | Signed release bundle: deploy files, `install.sh`, `release-manifest.json`, `SHA256SUMS` signed keylessly with Cosign; third-party images pinned by digest | A §16; ADR 0039 |
| M15-02 | `helpdock-ctl` core: `status`, `logs`, `backup`, `restore`, `verify`, sharing one library with the restore drill | D §10; ADR 0041 |
| M15-03 | `helpdock-ctl upgrade` with signature checks, a migration plan, an optional rehearsal, a pre-upgrade backup and rollback | D §10 |
| M15-04 | `helpdock-ctl rotate-key start` and `finish` | D §10 |
| M15-05 | api CLI additions (`migrations plan`, `ops report`, `version`) and the `install_ops_events` table | A §14 |
| M15-06 | `install.sh`: checks, wizard, `--dry-run`, offline bundles; never regenerates a secret | R §5.6 |
| M15-07 | Bundled object storage for production (a Compose profile) | A §17 |
| M15-08 | External-proxy Compose override, with the custom-domain limitation documented | A §3 |
| M15-09 | Update notices through `safeFetch`, sending nothing about the install | D §13; ADR 0042 |
| M15-10 | Automatic updates, opt-in: patch-only by default, 72-hour cool-down, per-release veto, health-gated rollback | ADR 0040 |
| M15-11 | Sample brand loaded through the import writer, refused at every delivery hook, removed at once | D §11, §15; ADR 0043 |
| M15-12 | System page: Updates and Backups cards, an operations log | R §4.10 |
| M15-13 | Deploy paths: a cloud-init recipe, a Coolify template, a Railway spike | ADR 0044 |
| M15-14 | CI for the operations tooling: shellcheck, install, upgrade, rollback and tamper end-to-end tests, a nightly signature check | A §15 |
| M15-15 | Docs, including a supply-chain guide | AGENTS.md DoD |

Exit criteria:

- [ ] On a clean Ubuntu 24.04 VM with DNS in place, the one-line install reaches the web wizard within 10 minutes; a tampered bundle, `SHA256SUMS` or image digest stops it with a clear message.
- [ ] `helpdock-ctl backup`, `restore` onto a fresh VM and `verify` match row counts and attachment hashes, and the restore drill still passes on the same library.
- [ ] An upgrade from the previous published release succeeds, and an image with a failing migration rolls back and restores with unchanged row counts.
- [ ] With automatic updates on, a patch release older than 72 hours installs overnight and is reported; a major, a pre-release, a vetoed or a previously failed release is skipped and reported.
- [ ] The System page shows an available update within 6 hours, sends no instance data, and shows the last backup's age.
- [ ] The sample brand loads in both languages, sends nothing on any channel, triggers no AI call or webhook, is left out of product metrics, and is purged at once by Remove.
- [ ] `rotate-key start` and `finish` complete on a restored stack.
- [ ] Every new screen passes Playwright in `en` and `ar` with axe.

#### M16 More importers and undo

Depends on: M11 (engine, wizard, writer). About 79 working days. Proposed for 1.2. Design: ADRs [0045](../decisions/0045-import-provenance-ledger-and-undo.md) (amends 0027) and [0046](../decisions/0046-imported-configuration-as-disabled-drafts.md) (proposed). Plan: [M16-more-importers-and-undo.md](../in-development/M16-more-importers-and-undo.md). Decisions: D-40 to D-45.

Teams leaving Help Scout, Intercom, Gorgias, Zammad or Front move in with the same quiet, dry-run-first wizard as M11's sources. An admin who imported into the wrong brand or with the wrong mapping presses **Undo import**: Helpdock removes only what that run created and keeps every ticket someone has worked on since. Macros, SLA policies and automations come over as disabled drafts with a translation report. M11-19 to M11-23 become M16-04 to M16-08; issues #201 to #205 move to the M16 GitHub milestone and keep their history.

| Id | Deliverable | Spec |
|---|---|---|
| M16-01 | Provenance ledger: every object an import creates or matches, recorded per run | ADR 0045; D §2.9 |
| M16-02 | Undo plan (read-only): what is removed, what is kept and why | D §2.9 |
| M16-03 | Undo job: claim-fenced, resumable, sends nothing; kept tickets stay linked to their source | D §2.9, §11 |
| M16-04 | Help Scout connector (formerly M11-19, #201) | ADR 0027 |
| M16-05 | Intercom connector (formerly M11-20, #202) | ADR 0027 |
| M16-06 | Gorgias connector (formerly M11-21, #203) | ADR 0027 |
| M16-07 | Zammad connector on an operator-supplied URL through `safeFetch` (formerly M11-22, #204) | ADR 0027; D §13 |
| M16-08 | Front connector (formerly M11-23, #205) | ADR 0027 |
| M16-09 | Credentials and the cutover loop: pause on refused credentials, resume with new ones, an opt-in 30-day connection for "Bring over changes" | ADR 0045 |
| M16-10 | Canned responses and macros imported, disabled | R §4.1; ADR 0046 |
| M16-11 | SLA policies and business hours imported, inactive | R §4.2; ADR 0046 |
| M16-12 | Automations imported as disabled drafts, enabled only after a test run | R §4.3; ADR 0046 |
| M16-13 | Admin UI: Undo with its plan dialog, run states, five connection forms, the imported-settings review | R §4.10 |
| M16-14 | Docs | AGENTS.md DoD |
| M16-15 | Downloadable CSV templates for the manual mapper, one row per message included | R §4.10 |

Exit criteria:

- [ ] Help Scout, Intercom, Gorgias, Zammad and Front (stand-ins with the reference dataset) import into a brand with threads, authors, dates, notes, attachments, tags, fields and assignees intact; a delta brings only changes; a resumed run loses and duplicates nothing.
- [ ] An import sends nothing, for all eight sources.
- [ ] Undo removes exactly what the run created and keeps every touched ticket with its reason; matched contacts and existing tags survive; a re-import afterwards duplicates nothing.
- [ ] Undo sends nothing and leaves no orphaned S3 object, search token or report row.
- [ ] Refused credentials pause a run, and resuming with new credentials for the same account continues it.
- [ ] Imported macros, SLA policies and rules arrive disabled with a translation report, and none runs until a person enables it after a test run.
- [ ] Brand A cannot read, plan or undo brand B's imports; a Zammad URL on a private address is refused unless allowed.
- [ ] Every new screen passes Playwright in `en` and `ar` with axe; #201 to #205 are closed under M16 and the M11 GitHub milestone is closed.

#### M17 Apps and languages

Depends on: M3 (web push), M4 (widget), M5 (help center). About 59 working days. Proposed for 1.3. Design: ADRs [0047](../decisions/0047-locale-registry-and-lazy-widget-locales.md), [0048](../decisions/0048-translations-through-hosted-weblate.md), [0049](../decisions/0049-installable-admin-before-native-agent-apps.md) (proposed). Plan: [M17-apps-and-languages.md](../in-development/M17-apps-and-languages.md). Decisions: D-02, D-46 to D-49.

People read Helpdock in their own language, customer-facing surfaces first, then the agent app; contributors translate without touching code; agents get Helpdock as an installable app on desktop and phone with notifications and a badge, with no push service run by the project. The native SDKs and desktop shell are a separate milestone, M20 (D-02).

| Id | Deliverable | Spec |
|---|---|---|
| M17-01 | Locale registry and plumbing: UI and content locales, browser negotiation, lazy widget locale chunks, search configuration per locale | R §4.13; D §5, §14; ADR 0047 |
| M17-02 | Translation workflow on Hosted Weblate, with catalog checks in CI | ADR 0048 |
| M17-03 | Wave 1 customer-facing locales: `fr`, `es`, `de`, `pt-BR`, `tr`, `id`, `fa` | R §4.13 |
| M17-04 | Content locales for the help center and knowledge | D §5, §8, §9 |
| M17-05 | Admin app locales, once a language reaches 100 % | R §4.13 |
| M17-06 | Admin as an installable app (PWA), with a badge and per-device push | R §4.9; ADR 0049 |
| M17-07 | Mobile agent layouts below 600 px | DESIGN §6.5, §10 |
| M17-08 | Push on installed apps across platforms | ADR 0002 |
| M17-09 | Docs | AGENTS.md DoD |

Exit criteria:

- [ ] The widget, help center, CSAT page, web form and customer emails ship in the wave 1 locales; a browser that asks for one gets it, and `fa` passes the mirrored RTL snapshot test.
- [ ] The widget's initial bundle is still at most 40 KB, and each locale chunk is within its cap.
- [ ] Contributors translate through Weblate, and CI rejects a catalog string with markup or a broken placeholder.
- [ ] Articles in an enabled content locale are searchable in that locale, and the AI admin marks unevaluated languages.
- [ ] Helpdock installs as an app on Chrome or Edge desktop, Android and iOS 16.4+, shows an unread badge, opens the ticket from a push, and keeps no API response in Cache Storage after sign-out.
- [ ] An agent triages, replies, notes, assigns and closes a ticket on a 390 px screen in `en` and `ar` (Playwright mobile projects with axe).

#### M18 Sign-in options

Depends on: M0 (auth, settings, outbox, SSRF-safe client), M4 (CAPTCHA interface), M9 (ASVS walk), M11 (SSO enforcement, break-glass). About 32.5 working days. Proposed for 1.1. Design: ADRs [0050](../decisions/0050-passkeys-for-staff-over-webauthn.md), [0051](../decisions/0051-oauth-identities-bound-by-subject.md), [0052](../decisions/0052-built-in-proof-of-work-captcha.md) (amends 0003), [0053](../decisions/0053-break-glass-with-a-passkey.md) (amends 0026) (proposed). Plan: [M18-sign-in-options.md](../in-development/M18-sign-in-options.md). Decisions: D-50 to D-55.

Staff sign in with a phishing-resistant passkey, as a second factor or on its own; the Google and GitHub buttons bind by provider subject so they can no longer hand an account to an identity that never proved it owns it; Microsoft work accounts get the same button; operators who cannot send visitor data to a CAPTCHA vendor get a built-in proof-of-work provider. The subject binding of M18-07 is being implemented ahead of the milestone as a 1.0.1 security fix in a separate pull request; M18-07 keeps what that fix leaves.

| Id | Deliverable | Spec |
|---|---|---|
| M18-01 | WebAuthn foundation: credentials table (install scope), RP ID pinned to `APP_URL`, attestation `none`, purpose-bound ceremonies | A §1, §7; ADR 0050 |
| M18-02 | Register and manage passkeys, with step-up and security emails | ASVS 2.2.3, 3.7.1 |
| M18-03 | Passkey as a second factor beside TOTP; "has a second factor" means TOTP or a passkey | ASVS 4.3.1 |
| M18-04 | Passwordless sign-in with user verification required; refused under SSO enforcement | ASVS 2.2.1, 3.2.1 |
| M18-05 | SSO and break-glass integration | ADR 0053 |
| M18-06 | Admin passkey screens | DESIGN §6, §10 |
| M18-07 | OAuth identities bound by `(issuer, subject)`, first link only with provider authority, connect and disconnect, Google domain allow-list | ADR 0051 |
| M18-08 | Microsoft sign-in, single tenant, through `openid-client` and `safeFetch` | A §7; D §13 |
| M18-09 | Google Workspace and Entra ID presets in the SSO connection form | ADR 0026 |
| M18-10 | Built-in proof-of-work CAPTCHA provider | ADR 0052 |
| M18-11 | CAPTCHA hostname check and per-IP limits on sign-in-link, reset and feedback requests | ASVS 11.1.4 |
| M18-12 | Docs, including a sign-in providers guide | AGENTS.md DoD |
| M18-13 | Security pass: ASVS V2 and V3 re-walk, `security-audit`, negative tests | M9-02 |

Exit criteria:

- [ ] A staff member registers a passkey, signs out and signs in with it alone; no TOTP is asked.
- [ ] An Admin with no second factor enrols a passkey, receives recovery codes and cannot remove the last factor.
- [ ] After a password, a passkey answers the second factor; recovery codes still work; three failures lock as before.
- [ ] With SSO enforced, passkey sign-in is refused for ordinary staff, and break-glass works as D-50 decides.
- [ ] A ceremony cannot be replayed or used for another purpose; one account cannot read or change another's passkeys or identities.
- [ ] A 1.0 Google user is bound by subject at the first sign-in after the upgrade; a GitHub identity is answered `oauth-link-required` until connected from Security; a second subject for a bound provider is refused.
- [ ] A Microsoft work account in the configured tenant signs in to an invited account; another tenant, or a first link without `xms_edov`, is refused.
- [ ] The widget and the web form accept a solved proof-of-work challenge once and refuse a replay, with no request leaving the install; a Turnstile or hCaptcha token for another hostname is refused.
- [ ] ASVS 2.3.2 and 2.9.1 to 2.9.3 are Met with evidence; every new or changed screen passes Playwright in `en` and `ar` with axe.

#### M19 Customer surfaces polish

Depends on: M2, M4, M5; M12-03 for a persona per widget, M14-12 for team faces, M15-11 for M19-08. About 47 working days: 40 for the customer-surface plan, 3 for group C of the [1.0 UX review](../completed/ux-review-1-0.md), and 4 for the prior-art gaps. Proposed for 1.2. Design: ADRs [0054](../decisions/0054-several-widgets-per-brand.md), [0055](../decisions/0055-custom-html-email-layout.md) (proposed). Plan: [M19-customer-surfaces-polish.md](../in-development/M19-customer-surfaces-polish.md). Decisions: D-56 to D-58.

What customers see gets the same care as what agents see: an email design editor with a live preview and a test send, several widgets per brand, a widget home with suggested questions, topics that route, team faces, a reply-time subtitle and an offline path, a richer widget preview, and help-center polish including its phone layout. Since M19 is proposed before M17, its editors read locales from a list rather than hard-coding `en` and `ar`.

| Id | Deliverable | Spec |
|---|---|---|
| M19-01 | Email design editor per brand: Simple and Custom HTML modes, footer placeholders, the satisfaction email, a variables reference, live preview in `en` and `ar`, test send | R §4.4; ADR 0055 |
| M19-02 | Several widgets per brand, each with its origins, appearance and default department; old embeds keep working | R §4.6; ADR 0054 |
| M19-03 | Widget home: suggested questions, topics that route, team faces (opt-in), reply-time subtitle, reply by email when nobody answers, a help search and the last conversation | R §4.6; UX-16 |
| M19-04 | Widget editor live preview with real states | R §4.6 |
| M19-05 | Help center polish: visitor theme toggle, search hero, designed empty state, per-brand title and description, a redirect from a changed article slug | R §4.5 |
| M19-06 | Help center on phones: header and section navigation | DESIGN §6.7; UX-14 |
| M19-07 | Widget captions with auto-reply on, and the phone close control | UX-15, UX-27 |
| M19-08 | Reports empty state linked to the sample brand; "Handing over an install" in the staff guide | UX-25 |
| M19-10 | Quoted history in reply emails, with a quote-line template; notes never quoted | R §4.4 |
| M19-09 | Docs and tests | AGENTS.md DoD |

Exit criteria:

- [ ] A brand admin designs a branded email layout, previews it at desktop and phone widths in `en` and `ar`, and receives a test send; a Custom HTML layout that fails the sanitiser falls back to the Plain layout.
- [ ] Two widgets of one brand on two origins carry their own appearance and default department, and an embed without a widget id keeps working with the brand's default widget.
- [ ] The widget home shows suggested questions, routes a chosen topic to its department, shows only staff who opted in, and keeps the initial bundle at most 40 KB.
- [ ] On a 390 px phone the help center's section navigation follows the breadcrumb and the language link stays on the first row.
- [ ] A reply email quotes the previous public message under the brand's quote line and never a note; an article's old slug redirects to its new one.
- [ ] Brand A cannot read brand B's `widgets` rows.
- [ ] Every new or changed screen passes Playwright in `en` and `ar` with axe.

#### M20 Native clients and SDKs

Depends on: M17 (the installable admin ships first and shows demand), M15-01 (signed artefacts), M4 (widget protocol). About 45 to 57 working days, depending on whether the Flutter SDK is built in-house (D-60). Proposed for later 1.x, on demand. Design: ADRs [0056](../decisions/0056-public-npm-packages-for-client-sdks.md), [0057](../decisions/0057-desktop-shell-on-electron.md) (proposed). Plan: [M20-native-clients-and-sdks.md](../in-development/M20-native-clients-and-sdks.md). Decisions: D-59 to D-61.

Teams with their own mobile apps embed Helpdock chat natively, starting with React Native, on a headless client that every SDK shares and a conformance kit every SDK must pass; agents who want a desktop app get a hardened Electron shell around their own instance. Native iOS and Android agent apps stay out of 1.x, because they would need a push relay the project would have to host.

| Id | Deliverable | Spec |
|---|---|---|
| M20-01 | `@helpdock/widget-client`: a headless client extracted from the widget, a conformance kit, the first public npm package | M4-10; D §7; ADR 0056 |
| M20-02 | React Native SDK `@helpdock/react-native` | M4-10 |
| M20-03 | Flutter SDK, community-led on the conformance kit (D-60) | — |
| M20-04 | Desktop shell on Electron: the instance's own admin only, sign-in in the system browser, signed updates | ADR 0057 |
| M20-05 | Docs | AGENTS.md DoD |

Exit criteria:

- [ ] `@helpdock/widget-client` and `@helpdock/react-native` pass the conformance kit, are published with npm provenance, and the example app holds a conversation with an agent in both locales.
- [ ] The desktop app installs signed on macOS, Windows and Linux (or is labelled unsigned per D-59), cannot navigate off the instance, signs in through the system browser, shows a badge and notifications, and updates itself only to a newer signed version.

---

## 5. Post-1.0 backlog (v1.1+)

Not scheduled. Each item needs its own PRD section before work starts.

- Slack, Discord, Viber, LINE
- Meta channels beyond M10: OAuth connect flows and Embedded Signup, Instagram through Facebook Login, importing replies typed in Meta Business Suite, backfill of missed webhooks, auto-reply and the satisfaction survey on these channels
- Customer portal with magic-link login, ticket history, restricted KB; customer sign-in is planned with it, brand-scoped (see M18's plan)
- Custom roles and permission sets; SCIM provisioning and single logout (SSO itself is M11)
- Per-department language routing
- Importers beyond M16: Kayako, HubSpot Service, Salesforce Service Cloud, osTicket and other tools
- Scheduled reports, custom dashboards
- Article versioning and review workflow
- Knowledge: Confluence, GitHub docs, generic MCP servers (ingesting from MCP is a different contract from M13's tool calls)
- Tool use in rules (a rule action that calls an MCP tool); M13 keeps rules on their fixed actions
- Kubernetes and Helm; a DigitalOcean Marketplace listing once the installer has been stable for two releases; community deploy templates (Dokploy, CapRover)
- Tag groups, one-tag-at-a-time groups, tag merge and archive
- A policy refusing synced passkeys for Admins (see M18's risks)
- Community forums, Blueprint-style process designer
- Telegram notifications to agents

**Moved into Phase 5 on 2026-10-20**, each now a planned milestone with its own plan:

| Item | Now | Why it moved |
|---|---|---|
| AI actions via MCP tools with approval flow | [M13](#m13-ai-actions-and-integrations) | The plan writes the contract that lets AI act safely: reads run, changes wait for a person's approval |
| Importers beyond M11, and importing macros, automations and SLA policies | [M16](#m16-more-importers-and-undo) (M16-04 to M16-12) | M11's engine and wizard exist; the five deferred connectors (#201 to #205) and configuration as disabled drafts reuse them |
| Backup/restore tooling | [M15](#m15-self-host-operations) (M15-02 to M15-04) | The restore drill's scripts become `helpdock-ctl` verbs |
| Coolify deploy path | [M15-13](#m15-self-host-operations) | Compose-native, on the external-proxy override; with a cloud-init recipe beside it |
| More UI locales | [M17](#m17-apps-and-languages) | A locale registry and a translation workflow; customer-facing surfaces first |
| React Native and Flutter widget SDKs | [M20](#m20-native-clients-and-sdks) | A headless widget client and a conformance kit every SDK passes |

**Dropped on 2026-10-20:**

| Item | Why |
|---|---|
| Cloudflare and Vercel deploy paths | Architecturally incompatible: Helpdock needs long-running workers, IMAP pollers, Socket.IO rooms and Caddy's on-demand TLS, none of which those platforms run. They would need a different architecture |
| Railway deploy path | Not maintained: it needs a custom Postgres image with pgvector, external S3 and four services, and its edge terminates TLS, so brand domains' on-demand certificates do not work. M15-13 runs a one-day spike and writes the result up |

---

## 6. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| RLS misconfiguration leaks data across brands | Critical | Shared RLS helper, isolation test required for every tenant table, CI gate |
| Widget grows past 40 KB as features land | High | Size check in CI from M4-01; features behind lazy chunks |
| LLM provider OAuth/subscription flows break or violate terms | Medium | API-key path is the supported one; subscription documented as at-your-own-risk |
| Email threading edge cases (broken clients, forwarded mail) | Medium | Thread-key resolver unit tests with a corpus of real-world headers |
| Caddy on-demand TLS abused for unverified domains | High | `/internal/domain-check` only answers 200 for verified domains; rate-limited |
| Scope creep from v1.1 requests | Medium | AGENTS.md and CONTRIBUTING.md forbid it; changes go through this PRD |
| Solo maintainer bottleneck on reviews | Medium | Admin PR-only bypass on the ruleset; small PRs; milestone docs keep context |
| Total effort of 46–59 weeks for one maintainer (phases 0–4) | High | Ship M0–M3 as an internal-desk preview to attract contributors; keep every milestone independently useful; re-estimate at each milestone start |
| Internal knowledge leaks through AI answers or caches | Critical | Visibility filtered in SQL before ranking, citation validation, audience-keyed cache, tests in M5 and M7 |
| Queued side effects drift from committed data | High | Transactional outbox from M0 with crash and rollback tests |
| Pentest vendor unavailable when M9 starts | Medium | Book 6 weeks ahead; listed in external dependencies |
| Messenger and Instagram need Meta's App Review per install before real customers' messages arrive (M10) | High | Everything works in Standard Access with the operator's own accounts; the guide walks through the review; recorded as a gap accepted up front |
| WhatsApp charges per delivered message, and a split reply or an attachment is several (M10) | Medium | The composer counts the messages a reply becomes; the guide links Meta's pricing; no part is sent twice |
| Messenger and Instagram unsubscribe the app after an hour of failed webhook deliveries, with no replay (M10) | Medium | The webhook answers 200 for everything after a valid signature; `meta.health` re-subscribes hourly; backfill is backlog |
| Meta's pages disagree on deadlines, retry windows and which secret signs Instagram webhooks (M10) | Medium | The design assumes the worse case of each; the open questions are settled against the staging accounts and recorded in the milestone doc |
| The pinned Graph version expires (M10) | Low | `META_GRAPH_VERSION` is one key; the stand-in's fixtures carry the version; the operations guide notes the date |
| A SAML library vulnerability (signature wrapping, XML parsing) lets someone sign in as staff (M11) | Critical | Signed assertions required, single-use `InResponseTo`, pinned `xml-crypto`/`@xmldom/xmldom` under the CI dependency audit, signature-wrapping and replay cases in the test suite |
| An import emails customers or fires rules about old tickets (M11) | High | One writer that never calls the live creation paths, a check script that fails the build if it does, and an exit criterion asserting nothing left the install |
| Vendor APIs change or rate-limit harder than documented (M11) | Medium | Connectors are thin over one engine; each is checked against the vendor's docs in its PR; runs resume from cursors and honour `Retry-After` |
| M11 delays 1.0 by two months or more | Medium | SSO and import are independent tracks; connectors beyond the first three may ship after 1.0 |
| Phase 5 totals about 533 person-days for M12 to M19 (about 105 weeks for one person), plus 45–57 for M20, on a solo maintainer | High | Phase by release (D-01) so each release ships a coherent subset; every milestone is independently useful and the phase can stop after any of them; tracks inside each milestone are independent so community contributors can take one; re-estimate at each milestone start and record the actual |
| Solo-maintainer review load on security-critical subsystems: the OAuth authorization server and MCP client (M13), passkeys and OAuth binding (M18), the installer and automatic updates (M15) | High | Split pull requests by subsystem; `security-audit` on each; negative tests and conformance runs in CI; the pentest scope extended before the release that ships them; outside review where it can be found |
| AI questions in rules or background summaries multiply cost on a busy brand (M12) | High | Event rules only, at most 3 questions per rule, one call per event, answers cached per message; summaries debounced; estimates shown; headroom check; the budget's hard stop applies to automation |
| The staff assistant panel leaks a ticket from another department (M12) | Critical | Reads run under the user's own RLS; read plans validated against a closed list; a negative test on the logged prompt; an eval measure of 0 |
| Prompt injection through tool output or customer text leads to a harmful proposal that a tired agent approves (M13) | Critical | Previews show every argument that leaves the install and what was read; one proposal per run; at most 50 targets; no standing approvals; zero-tolerance eval items |
| A bug in the OAuth authorization server lets an MCP client act beyond its user (M13) | Critical | One brand per grant, the role re-read on every request, negative tests, a client conformance run, a pentest-scope addendum |
| Snooze used to hide tickets from SLAs, or a mistaken bulk close emails fifty surveys (M14) | High | Response clocks keep running while snoozed and an SLA warning wakes the ticket; bulk changes are previewed, undoable for 60 s, and surveys wait for the undo window |
| Notification pacing delays an SLA-breach email (M14) | High | The bell is always immediate, urgent kinds cut the wait, the state machine is tested on a fake clock, and batches are rebuilt after Redis loss |
| A bad release is installed automatically on many servers (M15) | High | Automatic updates are off by default, patch-only, wait 72 hours, can be vetoed per release, and roll back on a failed health check |
| Undoing an import deletes something a person relied on (M16) | High | Deletion only from the provenance ledger, a broad "touched" rule that keeps worked tickets, a preview with reasons, a typed confirmation and an audit row |
| The widget outgrows 40 KB with personas, action cards, locale chunks and a home panel (M12, M13, M17, M19) | High | Each addition in a lazy chunk with its own cap; the CI size check on every pull request |
| Translations stall below 100 %, so locales never ship (M17) | Medium | Customer surfaces first (about 450 strings a locale); a "beta" status at 90 % with English fallback if D-48 allows it; paid translation for wave 1 if needed |
| Changing `APP_URL`'s host breaks every passkey, or 1.0 GitHub users are surprised by re-linking (M18) | Medium | The RP ID is pinned and drift is reported, with other sign-in methods still working; release notes and a clear `oauth-link-required` message with its next step |
| Custom HTML email layouts break in some clients or try to slip past the sanitiser (M19) | Medium | The existing sanitiser, a size cap, a preview, and a Plain layout fallback when a template fails validation |
| Public npm packages and desktop signing add supply-chain surface (M20) | Medium | npm provenance and two-factor authentication, CODEOWNERS on the SDKs, signed desktop builds with credentials in a protected environment |

---

## 7. Change log

| Date | Change |
|---|---|
| 2026-09-16 | Initial version. |
| 2026-09-16 | 1.1: added DOMAIN-RULES.md and referenced it throughout; fixed milestone dependency contradictions (realtime gateway, outbox, presence and SSRF client moved to M0; LLM wizard step moved to M7; dependencies govern scheduling instead of phase gates); new deliverables M0-13..15, M1-13..14, M7-11, M8-07, M9-10; effort estimates and external dependencies; performance conditions and product metrics; five new risks. |
| 2026-09-18 | M0 started. |
| 2026-09-19 | M0 shipped. All fifteen deliverables merged; six of seven exit criteria met and the seventh ([all four auth methods in a Playwright test](#m0-skeleton)) met in part, because Google and GitHub wait on the OAuth credentials under external dependencies. Actual effort two days against an estimate of 5–7 weeks; the M1 estimate is left as it stands until there is more than one milestone to calibrate against. What was built, and the ten accepted gaps, are in [docs/completed/M0-skeleton.md](../completed/M0-skeleton.md). M1 Ticketing core is next. |
| 2026-09-19 | M1 started. |
| 2026-09-25 | M1 shipped. All fifteen deliverables merged (#63, #64, #66, #69, #70, #71, #72, #73, #74); all five exit criteria met: the first ([create, assign, reply, note, tag, merge, split and close in en and ar](#m1-ticketing-core)) was met for seven of eight verbs at close-out, and the eighth the same day, when the details panel gained its tags row and editable custom fields (M1-15, artboard `Admin/Ticket-Tags`). Actual effort seven days against an estimate of 6–8 weeks. What was built, and the accepted gaps, are in [docs/completed/M1-ticketing-core.md](../completed/M1-ticketing-core.md#gaps-accepted). M2 Email channel, M3 Automation and SLAs and M5 Help center depend only on M1 and may start. |
| 2026-09-27 | Version 0.1.0 (M0 and M1) prepared for release. M2 and M3 started in parallel; issues #80–#95, artboards on the design canvas. |
| 2026-09-27 | M2 and M3 shipped. All sixteen deliverables merged (M2: #97, #99; M3: #100, #101, #102, #103) and all nine exit criteria met, each proved by a named test in [docs/completed/M2-email-channel.md](../completed/M2-email-channel.md#exit-criteria) and [docs/completed/M3-automation-and-slas.md](../completed/M3-automation-and-slas.md#exit-criteria). Actual effort one day for both, run in parallel, against estimates of 3–4 and 4–5 weeks. The gaps carried forward are in each doc; the M2 external dependency on a real SMTP provider and IMAP mailbox stays `needed`, as CI uses Mailpit and GreenMail. M4 Widget and realtime (M1, M3), M5 Help center (M1), M6 Telegram (M2) and M8 API, webhooks, reports (M1, M3) may now start. |
| 2026-09-27 | M4 and M5 started in parallel; issues #106–#126, artboards on the design canvas. |
| 2026-09-27 | M4 and M5 shipped. All twenty-one deliverables merged (M4: #129, #132, #133; M5: #131, #134, #135, #136) and all nine exit criteria met, each proved by a named test in [docs/completed/M4-widget-and-realtime.md](../completed/M4-widget-and-realtime.md#exit-criteria) and [docs/completed/M5-help-center.md](../completed/M5-help-center.md#exit-criteria). Two brands on two origins and an api restart mid-send are proved in a browser against the real api. M5's first criterion is met short of a certificate for a real domain: the M5-07 external dependency on a registered domain stays `needed`. The widget's initial bundle keeps to 40 KB by loading the real transport as a lazy chunk, a departure from D §14's "everything for first paint" that ADR 0012's amendment leaves to a reviewer. Close-out found that a brand added after setup had no ticket statuses, so no ticket could be filed in it, and fixed it. Actual effort one day for both, run in parallel, against estimates of 5–6 weeks each. The gaps carried forward are in each doc, including the widget and api-page Playwright suites that CI does not run yet. M6 Telegram (M2) and M8 API, webhooks, reports (M1, M3) may start; M7 AI waits for M6. |
| 2026-10-07 | M6, M7 and M8 shipped, with the code-side half of M9. All twenty-three deliverables merged in one pull request (#147) and eight of nine exit criteria met, each proved by a named test in [docs/completed/M6-telegram.md](../completed/M6-telegram.md#exit-criteria), [docs/completed/M7-ai.md](../completed/M7-ai.md#exit-criteria) and [docs/completed/M8-api-webhooks-reports.md](../completed/M8-api-webhooks-reports.md#exit-criteria). M7's evaluation criterion stays open: the harness passes in mock mode and the nightly workflow is in, but the run against a real provider waits on the `AI_EVAL_API_KEY` external dependency, which stays `needed`, as do the staging Telegram bot token and the Notion and Google OAuth apps. Actual effort two days for the three, run in parallel, against estimates of 2, 7–9 and 4–5 weeks. The gaps carried forward are in each doc. M9 continues: ASVS gaps closed, Semgrep, ZAP and the dependency audit in CI, the load-test suites, the accessibility audit, the user guides, master key rotation and the restore and onboarding tooling shipped in #147; the external pentest, the §14 host run, the clean-VM onboarding and restore drills, the usability pass and the 1.0.0 tag remain. |
| 2026-10-11 | M9 pre-pentest fixes, the ASVS re-walk and the M6–M8 gaps, in #167 (open when this was written). Landed: the internal pre-pentest review ([record](../completed/internal-security-review.md)) with its fixes F1 to F5, F6 and N1 still open; the re-walk's gaps closed, so [asvs-l2](../completed/asvs-l2.md) reads 198 Met, 35 Partial, 0 Gap, 24 N/A and 1 Operator; the automated zoom, forced-colours, semantics and bidi audit ([accessibility-audit](../completed/accessibility-audit.md)); `v0.4.0` signed keylessly on 2026-10-09 and #158 closed; the per-bot Telegram language prompt, the ticket list's AI state and agent assist's Arabic prompt. Still needs people or a decision: the external pentest (M9-01), the screen-reader pass (M9-04), the §14 host run (M9-03), the clean-VM onboarding and restore drills and the three outside testers (M9-07, M9-10), and a decision or an artboard for F6, N1, the Telegram empty welcome, the ticket list's `answeredAt` and the AIPausedStrip caption in DESIGN.md. |
| 2026-10-11 | **Scope change: the Meta channels are in scope as M10.** The owner brought WhatsApp Cloud API, Facebook Messenger and Instagram direct messages into scope as a new milestone, M10 Meta channels, stacked after M9: every message to a connected number, Page or account opens or continues a ticket, and the agent's reply reaches the customer on the same platform. Removed from §1's non-goals and §5's backlog, where REQUIREMENTS §1, §4.4 and §6 listed them as v1.1; eleven deliverables M10-01 to M10-11 in §4, a status board row (5–6 weeks, started 2026-10-11), four external dependencies (a Meta app with the three products, a WhatsApp Business account and test number, a Page and an Instagram professional account for staging, App Review for Messenger and Instagram), five risks. The design is [ADR 0025](../decisions/0025-meta-channels-through-one-graph-adapter.md); the milestone doc is [M10-meta-channels.md](../completed/M10-meta-channels.md). §1's release goal for 1.0.0 is unchanged. |
| 2026-10-13 | M10 shipped. Ten of eleven deliverables merged in #168 (M10-01 to M10-08, M10-10, M10-11) with M10-09's Human Agent tag, released in 0.5.0; all six exit criteria met against the Graph stand-in, each proved in [docs/completed/M10-meta-channels.md](../completed/M10-meta-channels.md#exit-criteria). M10-09's WhatsApp templates and a run against Meta itself are carried as [gaps](../completed/M10-meta-channels.md#gaps-and-follow-ups). |
| 2026-10-13 | **Scope change: SSO and migration are in scope for 1.0 as M11.** The owner brought SAML 2.0 and OpenID Connect sign-in for staff (JIT provisioning and group-to-role sync, enforcement with break-glass; no SCIM) and importers into 1.0, on the user feedback in [#180](https://github.com/Docker-Hunterpedia/Helpdock/issues/180): teams switch when migration does not hurt. Importers cover every helpdesk whose API can export a whole account (Zendesk, Freshdesk and Zoho Desk for 1.0; Help Scout, Intercom, Gorgias, Zammad and Front on the same SDK, may ship after 1.0) and a manual CSV mapper for the rest. Removed from §5's backlog, where REQUIREMENTS §6 listed both as v1.1; twenty-three deliverables M11-01 to M11-23 in §4, a status board row (9–13 weeks), two external dependencies (IdP developer tenants; vendor trial accounts), four risks. M9-09 now waits for M11. The designs are [ADR 0026](../decisions/0026-staff-sso-over-saml-and-oidc.md) and [ADR 0027](../decisions/0027-imports-through-one-normalised-record-engine.md); the milestone doc is [M11-sso-and-migration.md](../completed/M11-sso-and-migration.md). |
| 2026-10-18 | **M11 SSO and migration shipped for 1.0.** M11-01 to M11-18 merged ([#207](https://github.com/Docker-Hunterpedia/Helpdock/pull/207), [#210](https://github.com/Docker-Hunterpedia/Helpdock/pull/210)–[#212](https://github.com/Docker-Hunterpedia/Helpdock/pull/212), [#215](https://github.com/Docker-Hunterpedia/Helpdock/pull/215), with review fixes [#220](https://github.com/Docker-Hunterpedia/Helpdock/pull/220) and [#223](https://github.com/Docker-Hunterpedia/Helpdock/pull/223)) and released in v0.6.0. The owner deferred M11-19 to M11-23 (#201 to #205). Runs against real IdPs and vendor accounts remain external dependencies. The milestone doc moves to [completed](../completed/M11-sso-and-migration.md). |
| 2026-10-19 | **1.0.0 prepared (M9-09, [#159](https://github.com/Docker-Hunterpedia/Helpdock/issues/159)).** The owner confirmed the remaining M9 release gates complete: the external pentest (M9-01, #153), the §14 host load run (M9-03, #154), the screen-reader pass (M9-04, #155), the clean-VM onboarding run with three outside testers (M9-07, #157) and the restore drill (M9-10, #160). Their results are held by the owner and are not recorded in this repository. [asvs-l2](../completed/asvs-l2.md) has no gap. The owner also ruled that runs against real IdPs (Okta, Entra ID) and real Zendesk, Freshdesk and Zoho Desk accounts are not 1.0 blockers: M11 is verified against stand-ins and the vendors' published API documentation, and those runs stay external dependencies. The live AI evaluation passed every DOMAIN-RULES §9 threshold in both languages: [run 39322685646](https://github.com/Docker-Hunterpedia/Helpdock/actions/runs/39322685646), `glm-4.6` answering and `glm-5.1` judging with `bge-m3:567m` embeddings (one provider pair). The first live run (39314026498) failed answerable and unanswerable and found the auto-reply issues fixed in [#238](https://github.com/Docker-Hunterpedia/Helpdock/pull/238). M9's success-metrics criterion is met; M9 stays in progress until `ghcr.io/docker-hunterpedia/helpdock:1.0.0` is published and the README install works against it. |
| 2026-10-20 | **M9 Hardening and 1.0 shipped; 1.0.0 released (M9-09, [#159](https://github.com/Docker-Hunterpedia/Helpdock/issues/159)).** The version pull request [#236](https://github.com/Docker-Hunterpedia/Helpdock/pull/236) merged; Changesets run [39326893609](https://github.com/Docker-Hunterpedia/Helpdock/actions/runs/39326893609) tagged `v1.0.0` and `release.yml` published the [GitHub Release](https://github.com/Docker-Hunterpedia/Helpdock/releases/tag/v1.0.0) with its CycloneDX SBOM. `ghcr.io/docker-hunterpedia/helpdock:1.0.0` (`linux/amd64`, `linux/arm64`; `latest` is the same digest) is signed keylessly with Cosign and verified against the workflow identity in the same run, and the README install was checked against the pulled image with `scripts/compose-smoke.sh`. Both M9 exit criteria are met. The milestone doc moves to [completed](../completed/M9-hardening-and-1-0.md). |
| 2026-10-20 | **1.2: Phase 5 — 1.x planned (M12 to M20).** Nine milestones added to §4 with status board rows, each with a plan document in `docs/in-development/` (`Status: planned`): M12 AI workspace, M13 AI actions and integrations, M14 Inbox productivity, M15 Self-host operations, M16 More importers and undo, M17 Apps and languages, M18 Sign-in options, M19 Customer surfaces polish and M20 Native clients and SDKs; about 533 person-days for M12 to M19 and 45–57 for M20. A proposed release mapping for the owner: 1.0.1 (security and UX patch, in flight), 1.1 (M12, M14, M18 and M13-09 to M13-11), 1.2 (the rest of M13, M15, M16, M19), 1.3 (M17), M20 later. M11-19 to M11-23 move to M16-04 to M16-08 with issues #201 to #205. The apps and languages work is split into M17 and M20 so ids keep the `M<n>-<nn>` form. Thirty proposed ADRs, 0028 to 0057; 61 owner decisions gathered in [decisions-1-x.md](decisions-1-x.md) with the plans' recommendations, and a prior-art gap check that added about 20 days of deliverables. Group B of the [1.0 UX review](../completed/ux-review-1-0.md) is folded into M14 and group C into M19. §1 gains non-goals for 1.x; §5 moves six backlog items into Phase 5 and drops the Cloudflare, Vercel and Railway deploy paths, with reasons; §6 gains fifteen risks, including the total effort on a solo maintainer; eight external dependencies are added. DOMAIN-RULES and ARCHITECTURE change with each milestone, not now. |
| 2026-10-20 | M14 Inbox productivity and M18 Sign-in options started in parallel, for 1.1. GitHub milestones M14 and M18 with issues [#275](https://github.com/Docker-Hunterpedia/Helpdock/issues/275)–[#316](https://github.com/Docker-Hunterpedia/Helpdock/issues/316); 34 artboards on the design canvas, approved by the owner. |
| 2026-11-01 | **M14 Inbox productivity shipped for 1.1.** All 29 deliverables merged (M14-01 to M14-29, issues [#288](https://github.com/Docker-Hunterpedia/Helpdock/issues/288)–[#316](https://github.com/Docker-Hunterpedia/Helpdock/issues/316)); the last pull request, M14-22 ([#441](https://github.com/Docker-Hunterpedia/Helpdock/pull/441)), was in review when this was written. Thirteen of fourteen exit criteria are met by named tests and ticked; the fourteenth, the manual NVDA and VoiceOver run, is carried. ADR 0038 is accepted (0035 to 0037 were accepted with their deliverables). The plan moved to [docs/completed/M14-inbox-productivity.md](../completed/M14-inbox-productivity.md) with a close-out of the evidence and the gaps left open; guides, DESIGN.md (1.66) and DOMAIN-RULES (§1.2, §3.1) were checked against the code, and the guides' paths to Settings follow the M14-21 groups. |
