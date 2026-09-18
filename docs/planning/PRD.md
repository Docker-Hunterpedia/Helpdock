# Helpdock — Product Requirements Document

Status: planning
Version: 1.1 (2026-09-16)
Owner: @Docker-Hunterpedia

This document is the execution plan for Helpdock v1. It turns [REQUIREMENTS.md](REQUIREMENTS.md) (what), [ARCHITECTURE.md](ARCHITECTURE.md) (how) and [DOMAIN-RULES.md](DOMAIN-RULES.md) (behavioural contracts: authorization, ticket lifecycle, SLA maths, identity, knowledge visibility, delivery guarantees, operations) into phases, milestones, deliverables and exit criteria that can be tracked on GitHub. When this document and the others disagree, fix this document.

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
| AI answer quality (EN and AR evaluation set) | Thresholds in DOMAIN-RULES §9 | Nightly eval run against a real provider, M7 and M9 |
| Restore drill from dump + bucket + `.env` on a clean VM | Completed within RTO 1 h | M9 |

Performance numbers are measured under the host, dataset, load and network conditions defined in [DOMAIN-RULES §14](DOMAIN-RULES.md#14-performance-test-conditions). The 40 KB widget limit applies to the initial bundle; lazy chunks have their own caps there.

Product metrics (activation, agent efficiency, AI deflection rate with its exact definition, handoff quality, help center self-service) are defined in [DOMAIN-RULES §15](DOMAIN-RULES.md#15-product-metrics) and reported on the System page from M8.

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
- **Dependencies govern scheduling, not phases.** A milestone may start when every milestone it depends on has shipped. Phases group milestones for reporting; they are not gates. Example: M8 depends on M1 and M3, so it may run while M7 is in progress.
- Shared infrastructure lands in the earliest milestone that needs it (realtime gateway, outbox and presence are in M0 because M1 and M3 use them).
- Scope changes go through a PR to this document, not through issue comments.

### Status board

Update this table in the same PR that changes a milestone's status.

| Phase | Milestone | Depends on | Effort (weeks) | Status | Started | Shipped |
|---|---|---|---|---|---|---|
| 0 Foundation | M0 Skeleton | — | 5–7 | in progress | 2026-09-18 | |
| 1 Core desk | M1 Ticketing core | M0 | 6–8 | planned | | |
| 1 Core desk | M2 Email channel | M1 | 3–4 | planned | | |
| 1 Core desk | M3 Automation and SLAs | M1 | 4–5 | planned | | |
| 2 Customer surfaces | M4 Widget and realtime | M1, M3 | 5–6 | planned | | |
| 2 Customer surfaces | M5 Help center | M1 | 5–6 | planned | | |
| 2 Customer surfaces | M6 Telegram | M2 | 2 | planned | | |
| 3 Intelligence | M7 AI | M3, M4, M5, M6 | 7–9 | planned | | |
| 4 Release | M8 API, webhooks, reports | M1, M3 | 4–5 | planned | | |
| 4 Release | M9 Hardening and 1.0 | all | 5–7 | planned | | |
| | **Total** | | **46–59** | | | |

Effort assumes one full-time maintainer working with AI coding agents, including tests and docs per the Definition of done. M2 and M3 can overlap, as can M4 and M5, so calendar time is shorter than the sum. Re-estimate at the start of each milestone and record the actual in the milestone doc.

### External dependencies

| Needed for | Dependency | Owner | Status |
|---|---|---|---|
| M0-05 | Google and GitHub OAuth app credentials for the dev and test environments | @Docker-Hunterpedia | needed |
| M2 | SMTP provider account and one IMAP mailbox for E2E against a real provider (CI uses Mailpit) | @Docker-Hunterpedia | needed |
| M5-07 | A registered domain with DNS control for the TLS onboarding test | @Docker-Hunterpedia | needed |
| M6 | A Telegram bot token for the staging bot | @Docker-Hunterpedia | needed |
| M7 | LLM and embeddings API keys for the nightly evaluation run (stored as CI secrets) | @Docker-Hunterpedia | needed |
| M7-03 | Notion integration and Google Cloud OAuth app for the connectors | @Docker-Hunterpedia | needed |
| M9-01 | External pentest vendor, budget and a 2-week slot booked at least 6 weeks ahead | @Docker-Hunterpedia | not started |
| M9-04 | Three outside testers for the usability pass | @Docker-Hunterpedia | not started |
| M9-08 | GHCR publish permissions on the org and a signing key for images | @Docker-Hunterpedia | needed |

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

- [ ] `docker compose up` on a clean machine reaches the wizard and creates an admin and a brand.
- [ ] All four auth methods and TOTP work end-to-end in a Playwright test.
- [ ] Every negative test in DOMAIN-RULES §1.6 passes and is required in CI.
- [ ] Killing the relay between commit and publish loses no job; a rolled-back transaction enqueues nothing.
- [ ] Two admin sessions on different api replicas see each other's presence change within 5 seconds.
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

- [ ] An agent can create, assign, reply to, note, tag, merge, split and close tickets in the admin UI, in English and Arabic.
- [ ] An Agent cannot see or open a ticket in another department, by list, by direct URL, by contact timeline, or by socket room.
- [ ] Every transition in DOMAIN-RULES §2.2 and each reopen policy value has a test.
- [ ] Every new tenant table has brand and, where applicable, department RLS policies and is covered by the negative test suite.
- [ ] Ticket list of 50k seeded tickets loads under 150 ms p95 under the D §14 conditions.

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

- [ ] Email to a mailbox creates a ticket; agent reply arrives in the customer's inbox; customer reply threads onto the same ticket. Verified with Mailpit in CI.
- [ ] A reply quoting a valid ticket number from a non-participant address creates a separate ticket and never attaches to the original.
- [ ] Delivering the same outbox job twice sends one email.
- [ ] Sending fails gracefully into the DLQ, visible in admin.

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

- [ ] A rule "on create, if subject contains X, assign to team Y and reply with canned Z" runs and is logged.
- [ ] An SLA breach fires escalation and a notification, and pauses correctly on Awaiting customer.
- [ ] The four worked examples in DOMAIN-RULES §3.6 pass as unit tests to the minute.
- [ ] Deleting Redis while tickets are open and restarting the worker recreates every timer.
- [ ] Rule loop is prevented by a test.

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

- [ ] Widget embedded on two origins under two brands, each with its own theme, exchanging messages with agents in the admin.
- [ ] Requests from a non-allowed origin are rejected in an E2E test.
- [ ] Dropping the network mid-send, restarting the api, and double-submitting each leave exactly one message and the widget catches up without user action (Playwright with network interruption).
- [ ] A visitor with a guessed or leaked email address cannot open another contact's conversations.
- [ ] Initial bundle ≤ 40 KB and lazy chunk caps pass in CI per D §14.

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

- [ ] `support.<brand>` answers over TLS with a published article, in both locales, with a valid sitemap.
- [ ] Article search returns results in Arabic and English.
- [ ] RTL snapshot test passes.
- [ ] An internal article never appears in the sitemap, public search, or a `public` cached response, tested after toggling an article from public to internal.

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

- [ ] Auto-reply answers a question from an uploaded PDF with a citation, and hands off when confidence is below threshold, in an E2E test with a mocked provider.
- [ ] The evaluation run meets every threshold in DOMAIN-RULES §9 for both English and Arabic.
- [ ] After a handoff, no auto-reply is sent for the rest of the conversation even if a queued job fires late.
- [ ] A visitor-audience query never retrieves an internal chunk (SQL-level test), and a fabricated citation is dropped.
- [ ] Budget hard stop disables auto-reply and is visible in admin.
- [ ] PII redaction is covered by unit tests for emails, phones, cards (Luhn), IBANs.

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
| M9-06 | User docs under `docs/guides/`: install, configuration, channels, help center, AI, API, security, widget protocol, **operations** (backup, restore, upgrade, master key rotation, Redis loss) | A §2, D §10 |
| M9-07 | Onboarding test on a clean VM against the 30-minute target; usability pass with three outside testers on the 3-click reply task; fix friction | R §7, D §15 |
| M9-08 | Release pipeline: Changesets, multi-arch image to GHCR, GitHub release with changelog | A §16 |
| M9-09 | Tag `1.0.0` | |
| M9-10 | Restore drill: dump + bucket + `.env` restored on a clean VM within RTO; master key rotation rehearsed; results recorded in `docs/completed/` | D §10 |

Exit criteria:

- [ ] All success metrics in §2 are met and recorded, including the AI evaluation thresholds and the restore drill.
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
| Total effort of 46–59 weeks for one maintainer | High | Ship M0–M3 as an internal-desk preview to attract contributors; keep every milestone independently useful; re-estimate at each milestone start |
| Internal knowledge leaks through AI answers or caches | Critical | Visibility filtered in SQL before ranking, citation validation, audience-keyed cache, tests in M5 and M7 |
| Queued side effects drift from committed data | High | Transactional outbox from M0 with crash and rollback tests |
| Pentest vendor unavailable when M9 starts | Medium | Book 6 weeks ahead; listed in external dependencies |

---

## 7. Change log

| Date | Change |
|---|---|
| 2026-09-16 | Initial version. |
| 2026-09-16 | 1.1: added DOMAIN-RULES.md and referenced it throughout; fixed milestone dependency contradictions (realtime gateway, outbox, presence and SSRF client moved to M0; LLM wizard step moved to M7; dependencies govern scheduling instead of phase gates); new deliverables M0-13..15, M1-13..14, M7-11, M8-07, M9-10; effort estimates and external dependencies; performance conditions and product metrics; five new risks. |
| 2026-09-18 | M0 started. |
