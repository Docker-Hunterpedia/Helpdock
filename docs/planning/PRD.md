# Helpdock — Product Requirements Document

Status: planning
Version: 1.0 (2026-09-16)
Owner: @Docker-Hunterpedia

This document is the execution plan for Helpdock v1. It turns [REQUIREMENTS.md](REQUIREMENTS.md) (what) and [ARCHITECTURE.md](ARCHITECTURE.md) (how) into phases, milestones, deliverables and exit criteria that can be tracked on GitHub. When this document and the other two disagree, fix this document.

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

Visual process builder · community forums · phone/VoIP · billing/SaaS metering · SLA credits · Meta channels (WhatsApp, Messenger, Instagram) · Slack/Discord · customer login portal · backup tooling · one-click cloud deploy · custom permission sets · native mobile SDKs.

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

---

## 3. Tracking model

Everything is tracked on GitHub so progress is visible without asking anyone.

| Level | GitHub object | Naming |
|---|---|---|
| Phase | Label | `phase:0-foundation` … `phase:4-release` |
| Milestone | GitHub Milestone | `M0 Skeleton`, `M1 Ticketing core`, … |
| Deliverable | Issue | Title starts with the deliverable id, e.g. `M1-04 Contacts and accounts` |
| Work | Pull request | Linked to its issue with `Closes #n`; squash-merged |
| Living status | `docs/in-development/M<n>-<slug>.md` | Created when a milestone starts, moved to `docs/completed/` when it ships |
| Decisions | `docs/decisions/NNNN-*.md` | ADR per settled decision |

Rules:

- A milestone is **started** when its doc exists in `docs/in-development/` and its issues are created.
- A milestone is **shipped** when every exit criterion below is met, every issue is closed, and its doc is moved to `docs/completed/`.
- Milestones within a phase may overlap. Phases are sequential: a phase starts only when the previous phase has shipped.
- Scope changes go through a PR to this document, not through issue comments.

### Status board

Update this table in the same PR that changes a milestone's status.

| Phase | Milestone | Status | Started | Shipped |
|---|---|---|---|---|
| 0 Foundation | M0 Skeleton | planned | | |
| 1 Core desk | M1 Ticketing core | planned | | |
| 1 Core desk | M2 Email channel | planned | | |
| 1 Core desk | M3 Automation and SLAs | planned | | |
| 2 Customer surfaces | M4 Widget and realtime | planned | | |
| 2 Customer surfaces | M5 Help center | planned | | |
| 2 Customer surfaces | M6 Telegram | planned | | |
| 3 Intelligence | M7 AI | planned | | |
| 4 Release | M8 API, webhooks, reports | planned | | |
| 4 Release | M9 Hardening and 1.0 | planned | | |

---

## 4. Phases and milestones

Each deliverable references the section of REQUIREMENTS.md (R) or ARCHITECTURE.md (A) that specifies it.

### Phase 0 — Foundation

Goal: a running, empty, secure skeleton that every later milestone builds on. Nothing user-visible beyond login and an empty admin shell.

#### M0 Skeleton

Depends on: nothing.

| Id | Deliverable | Spec |
|---|---|---|
| M0-01 | Monorepo: pnpm + Turborepo, `apps/{api,admin,helpcenter,widget}`, `packages/{db,schemas,ai,channels,ui,i18n,config}`, Biome, TypeScript strict | A §2 |
| M0-02 | Config loader: `.env` bootstrap + `settings` table, Zod-validated, AES-256-GCM secret encryption, Redis pub/sub invalidation, "locked by environment" flag | A §4 |
| M0-03 | Database: Drizzle schema for `users`, `brands`, `user_brand_roles`, `settings`, `audit_log`; UUIDv7; migrations run on api boot with lock; RLS helper that every tenant table uses | A §5, §6 |
| M0-04 | Tenancy plumbing: `RequestContextMiddleware`, auth guard producing `principal`, `TenantInterceptor` with `SET LOCAL app.brand_ids`; integration test proving brand A cannot read brand B | A §6 |
| M0-05 | Auth: argon2id password, magic link, Google + GitHub OAuth, TOTP with recovery codes, JWT access + rotating refresh in Redis, "log out everywhere" | R §5.1, A §7 |
| M0-06 | Roles: Admin, Team Leader, Agent, Viewer (toggle) with server-side guards | R §2 |
| M0-07 | Admin shell: Vite + React + MUI, i18next `en`/`ar`, RTL provider, login, brand switcher, empty nav | A §1 |
| M0-08 | First-run wizard: admin account, first brand, SMTP test, LLM provider test | R §5.5 |
| M0-09 | Docker: single image with `APP_ROLE=api\|worker`, `docker-compose.yml`, dev compose, Caddyfile with host routing, `/health` and `/ready` | A §3, §17 |
| M0-10 | Observability: pino JSON logs with request id and brand id, OpenTelemetry auto-instrumentation, `/metrics` | A §14 |
| M0-11 | CI: Biome, typecheck, unit + integration (Testcontainers), build image, coverage gate 80 %; CodeQL; Renovate; required status check added to the `main` ruleset | A §15, §16 |
| M0-12 | ADRs for the four open decisions: editor library, web push, CAPTCHA default, queue dashboard | A §19 |

Exit criteria:

- [ ] `docker compose up` on a clean machine reaches the wizard and creates an admin and a brand.
- [ ] All four auth methods and TOTP work end-to-end in a Playwright test.
- [ ] RLS isolation test passes and is required in CI.
- [ ] CI is green and is a required check on `main`.
- [ ] `docs/completed/M0-skeleton.md` describes what was built.

---

### Phase 1 — Core desk

Goal: agents can work tickets that arrive by email, with Zoho-style discipline. Usable internally before any customer-facing surface exists.

#### M1 Ticketing core

Depends on: M0.

| Id | Deliverable | Spec |
|---|---|---|
| M1-01 | Brands: create with prefix and per-brand ticket sequence; departments, teams, team members; user role per brand | R §3 |
| M1-02 | Tickets: full field set, system statuses + custom statuses mapped to system states, priorities with editable labels, channels enum | R §4.1 |
| M1-03 | Messages: public replies, internal notes, system entries; sanitized HTML; activity log for every state change with actor and origin | R §4.1 |
| M1-04 | Contacts and accounts: identity merge across email/phone/telegram/visitor id; contact timeline | R §4.1 |
| M1-05 | Views: personal and shared saved filters; defaults (My open, Unassigned, Overdue, All open per department, Escalated) | R §4.1 |
| M1-06 | Tags, custom fields (text, number, date, select, multi-select, checkbox) on ticket, contact, account; ticket templates | R §4.1 |
| M1-07 | Assignment: manual, round-robin per department, skill-based, load cap, auto-unassign on offline | R §4.1 |
| M1-08 | Agent collision indicator over WebSocket; merge, split, parent–child | R §4.1 |
| M1-09 | Media pipeline: presigned PUT, `media.process` job with sharp (WebP, thumbnails, EXIF strip), ffmpeg for audio/video, ClamAV optional, presigned GET | A §9 |
| M1-10 | Spam: mark as spam, sender block list | R §4.1 |
| M1-11 | Time tracking (toggle), CSAT model and rating page (delivery wired per channel later) | R §4.1 |
| M1-12 | Admin UI for all of the above; ticket list p95 index set `(brand_id, status, updated_at)`, `(brand_id, assignee_id)`, tsvector GIN | R §5.2 |

Exit criteria:

- [ ] An agent can create, assign, reply to, note, tag, merge and close tickets in the admin UI, in English and Arabic.
- [ ] Every new tenant table has an RLS policy and is covered by the isolation test.
- [ ] Ticket list of 50k seeded tickets loads under 150 ms p95 locally.

#### M2 Email channel

Depends on: M1.

| Id | Deliverable | Spec |
|---|---|---|
| M2-01 | `ChannelAdapter` interface and `ConversationRouter` (find contact, find open ticket by thread key, else create) | A §8 |
| M2-02 | Inbound IMAP: imapflow per mailbox as repeatable `email.poll` job, mailparser, dedupe by `Message-ID`, attachments to S3 | R §4.4 |
| M2-03 | Inbound parse webhooks: Postmark, SendGrid, Mailgun, Resend, generic JSON at `/internal/inbound-parse/*` with shared secret | R §4.4 |
| M2-04 | Threading: `In-Reply-To`/`References` → `[PREFIX-N]` subject token → new ticket; quoted-reply stripping; inline images preserved | R §4.4 |
| M2-05 | Outbound SMTP: Nodemailer per brand, `From`/`Reply-To` per department, HTML + text, agent signatures, `email.send` queue with retries and DLQ | R §4.4 |
| M2-06 | Auto-responders: acknowledgment and out-of-hours; loop protection (`Auto-Submitted`, `Precedence: bulk`, per-sender cap) | R §4.4 |
| M2-07 | Email security: sanitized HTML allowlist, no scripts or forms, remote image proxy/block toggle, optional SPF/DKIM-failure spam heuristics | R §5.1 |
| M2-08 | Admin: mailbox CRUD with IMAP/SMTP test buttons, inbound-parse endpoint config, health status | R §4.10 |

Exit criteria:

- [ ] Email to a mailbox creates a ticket; agent reply arrives in the customer's inbox; customer reply threads onto the same ticket. Verified with Mailpit in CI.
- [ ] Sending fails gracefully into the DLQ, visible in admin.

#### M3 Automation and SLAs

Depends on: M1. Can run in parallel with M2.

| Id | Deliverable | Spec |
|---|---|---|
| M3-01 | Business hours, holidays, timezone per brand and optionally per department | R §4.2 |
| M3-02 | SLA policies: first-response and resolution per priority, pause on On Hold / awaiting customer, BullMQ delayed timers rescheduled on status change, breach badge | R §4.2 |
| M3-03 | Workflow rules engine: events, conditions, actions; ordered; depth guard 3 with cycle detection; execution log | R §4.3 |
| M3-04 | Time-based rules on a cron queue | R §4.3 |
| M3-05 | Rule builder UI with test-run against a sample ticket | R §4.3 |
| M3-06 | Macros and canned responses with placeholders and `en`/`ar` variants | R §4.1 |
| M3-07 | Notifications: in-app realtime, email, web push (VAPID) for assignment, reply, mention, SLA warning/breach, escalation; per-user preferences | R §4.9 |
| M3-08 | Admin audit log viewer | R §4.10 |

Exit criteria:

- [ ] A rule "on create, if subject contains X, assign to team Y and reply with canned Z" runs and is logged.
- [ ] An SLA breach fires escalation and a notification, and pauses correctly on On Hold.
- [ ] Rule loop is prevented by a test.

---

### Phase 2 — Customer surfaces

Goal: customers can reach the desk through the widget, the help center and Telegram. Everything in this phase is public-facing and must pass the security checklist before merge.

#### M4 Widget and realtime

Depends on: M1, M3 (notifications).

| Id | Deliverable | Spec |
|---|---|---|
| M4-01 | Widget build: Preact + Shadow DOM, Vite lib mode, single `widget.js`, size check in CI (< 40 KB gzipped) | R §4.6, A §12 |
| M4-02 | Visitor identity: `visitor_id` per brand, optional signed identity with HMAC and 5-minute timestamp window, toggle | A §7 |
| M4-03 | Origin allow-list on config, token and Socket.IO handshake; per-visitor and per-IP throttles; optional Turnstile before first message | R §5.1 |
| M4-04 | Realtime: Socket.IO `/widget` namespace with Redis adapter, rooms per conversation, SSE fallback, typing, read receipts, queue position | A §8 |
| M4-05 | Four modes: chat, chat + suggested articles (stub until M7), help center only (stub until M5), contact form | R §4.6 |
| M4-06 | Theme tokens with live preview in admin; dark/light/auto; RTL by locale | R §4.6 |
| M4-07 | Rich content policy per brand: text, emoji, images, video, voice, files with size and MIME caps; voice via MediaRecorder normalized to Opus | R §4.6 |
| M4-08 | Pre-chat form, business-hours awareness, transcript by email, agent avatar/name | R §4.6 |
| M4-09 | Hosted web form per brand with custom fields and CAPTCHA toggle | R §4.4 |
| M4-10 | Widget protocol documented in `docs/guides/widget-protocol.md` for native apps | R §4.6 |
| M4-11 | Accessibility: keyboard, focus, contrast, ARIA live regions | R §5.4 |

Exit criteria:

- [ ] Widget embedded on two origins under two brands, each with its own theme, exchanging messages with agents in the admin.
- [ ] Requests from a non-allowed origin are rejected in an E2E test.
- [ ] Bundle size check passes in CI.

#### M5 Help center

Depends on: M1. Can run in parallel with M4.

| Id | Deliverable | Spec |
|---|---|---|
| M5-01 | Content model: category → section → article, versions per locale, draft/published/archived, scheduled publish, fallback locale | R §4.5 |
| M5-02 | Editor (per ADR): rich text, images to WebP, code, callouts, tables, video embed, anchors; Markdown import/export | R §4.5 |
| M5-03 | SSR app served by api on brand host; Redis page cache with invalidation; ETag; `Cache-Control` | A §11 |
| M5-04 | SEO: canonical, hreflang, sitemap per brand, OG, JSON-LD | A §11 |
| M5-05 | Search: tsvector per language (`english`, `arabic`) + trigram fuzzy; semantic merge added in M7; search log with zero-result tracking | R §4.5 |
| M5-06 | Theme tokens, logo, favicon, sanitized custom CSS, header/footer links, home layout | R §4.5 |
| M5-07 | Custom domains: CNAME + TXT verification in admin, `/internal/domain-check` for Caddy on-demand TLS, "proxied by Cloudflare" flag | A §3, §11 |
| M5-08 | Article feedback, view counts, "Still need help?" handoff to widget/form with article context | R §4.5 |
| M5-09 | Internal-only access mode (staff login) | R §4.5 |
| M5-10 | Widget "help center" and "chat + articles" modes wired to real content | R §4.6 |

Exit criteria:

- [ ] `support.<brand>` answers over TLS with a published article, in both locales, with a valid sitemap.
- [ ] Article search returns results in Arabic and English.
- [ ] RTL snapshot test passes.

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

- [ ] A Telegram message creates a ticket and the agent reply arrives in the chat, tested against a mocked Bot API.

---

### Phase 3 — Intelligence

Goal: grounded AI that assists agents and deflects simple questions, under strict guardrails.

#### M7 AI

Depends on: M5 (articles as knowledge), M4 and M6 (auto-reply surfaces), M3 (rule actions).

| Id | Deliverable | Spec |
|---|---|---|
| M7-01 | Provider layer on pi-ai: API key and OAuth/subscription credentials (encrypted), model discovery, per-brand override, cost tracking in `ai_calls` | R §4.7, A §10 |
| M7-02 | Embeddings client (OpenAI-compatible, configurable base URL, model, dims); `knowledge_chunks` with HNSW index | A §10 |
| M7-03 | Ingest: articles (auto), files (PDF via unpdf, DOCX via mammoth, MD, TXT), crawl (sitemap/seed, cheerio, optional Playwright), Notion, Google Drive; chunker; sync schedule and status | R §4.7 |
| M7-04 | Hybrid retrieval: pgvector + tsvector with reciprocal rank fusion and locale boost; semantic search merged into help center and widget suggestions | A §10 |
| M7-05 | Agent assist: suggest reply with citations, summarize, suggest tags/priority/department, translate AR↔EN, rewrite tone, draft article from ticket (Team Leader approval) | R §4.7 |
| M7-06 | Auto-reply on widget, Telegram and email with confidence threshold, transparent handoff, "talk to a human", AI badge and citations | R §4.7 |
| M7-07 | Auto-triage as a workflow action | R §4.7 |
| M7-08 | Guardrails: PII redaction (reversible for agents), injection filter on ingested content, no tools, per-brand daily/monthly budget with 80 % alert and hard stop, output logging visible on ticket, per-brand system prompt | R §4.7 |
| M7-09 | Voice transcription job (Whisper-compatible endpoint) shown to agents | R §4.6 |
| M7-10 | Admin: providers, models, embeddings, knowledge sources with "sync now" and logs, modes, guardrails, budget, prompt | R §4.10 |

Exit criteria:

- [ ] Auto-reply answers a question from an uploaded PDF with a citation, and hands off when confidence is below threshold, in an E2E test with a mocked provider.
- [ ] Budget hard stop disables auto-reply and is visible in admin.
- [ ] PII redaction is covered by unit tests for emails, phones, cards (Luhn), IBANs.

---

### Phase 4 — Release

Goal: integrations, reporting, hardening and a public `1.0.0`.

#### M8 API, webhooks, reports

Depends on: M1, M3. Can start during Phase 3.

| Id | Deliverable | Spec |
|---|---|---|
| M8-01 | Tenant API keys: `hd_live_*` shown once, SHA-256 stored, scopes, per-key throttle, last used, revoke | R §4.11, A §7 |
| M8-02 | REST v1: tickets CRUD + messages, contacts upsert/search, articles search/get, webhooks CRUD; idempotency keys; OpenAPI 3.1 at `/api/docs` generated from Zod | R §4.11 |
| M8-03 | Outbound webhooks: events, HMAC-SHA256 signature, retries with backoff, delivery log, replay | R §4.12 |
| M8-04 | Reports: volume by channel/status/priority, first-response and resolution time, SLA compliance, backlog trend, CSAT, agent workload, busiest hours, top and zero-result searches, AI deflection and cost; CSV export; `stats.rollup` cron | R §4.8 |
| M8-05 | System page: version, migrations, queue health with Bull Board, channel status, storage usage, LLM spend | R §4.10 |
| M8-06 | CSAT delivery wired on close for email, widget, Telegram | R §4.1 |

Exit criteria:

- [ ] A ticket created via the API triggers a signed `ticket.created` webhook received by a test endpoint.
- [ ] Reports match seeded data in an integration test.

#### M9 Hardening and 1.0

Depends on: everything above.

| Id | Deliverable | Spec |
|---|---|---|
| M9-01 | External pentest of widget + API; fix all High and Medium findings | R §7 |
| M9-02 | OWASP ASVS L2 checklist walk-through with evidence recorded in `docs/completed/` | R §5.1 |
| M9-03 | Load tests: ticket list p95, help center TTFB, realtime latency; index and cache tuning | R §5.2 |
| M9-04 | Accessibility audit (axe + manual keyboard) on widget and help center | R §5.4 |
| M9-05 | Semgrep rules for Nest, ZAP baseline scan on release branches, SBOM on release | A §15, §16 |
| M9-06 | User docs under `docs/guides/`: install, configuration, channels, help center, AI, API, security, widget protocol | A §2 |
| M9-07 | Onboarding test on a clean VM against the 30-minute target; fix friction | R §7 |
| M9-08 | Release pipeline: Changesets, multi-arch image to GHCR, GitHub release with changelog | A §16 |
| M9-09 | Tag `1.0.0` | |

Exit criteria:

- [ ] All success metrics in §2 are met and recorded.
- [ ] `ghcr.io/docker-hunterpedia/helpdock:1.0.0` is published and the README install instructions work against it.

---

## 5. Post-1.0 backlog (v1.1+)

Not scheduled. Each item needs its own PRD section before work starts.

- Meta channels (WhatsApp Cloud, Messenger, Instagram), Slack, Discord, Viber, LINE
- Customer portal with magic-link login, ticket history, restricted KB
- Custom roles and permission sets; SAML/OIDC SSO
- React Native and Flutter widget SDKs
- More UI locales; per-department language routing
- AI actions via MCP tools with approval flow
- Importers: Zoho Desk, Zendesk, Freshdesk
- Scheduled reports, custom dashboards
- Article versioning and review workflow
- Knowledge: Confluence, GitHub docs, generic MCP servers
- Backup/restore tooling
- Cloudflare / Vercel / Railway / Coolify deploy paths
- Community forums, Blueprint-style process designer
- Telegram notifications to agents

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

---

## 7. Change log

| Date | Change |
|---|---|
| 2026-09-16 | Initial version. |
