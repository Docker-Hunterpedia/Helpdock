# Helpdock — Architecture & Stack (v1)

Companion to `REQUIREMENTS.md` and `DOMAIN-RULES.md` (same folder). Behavioural contracts (authorization, ticket lifecycle, SLA maths, identity, knowledge visibility, delivery guarantees, operations) live in DOMAIN-RULES.md; this file describes components. Every choice below was checked against current package versions (September 2026). Pin ranges at scaffold time; Renovate keeps them current.

---

## 1. Stack at a glance

| Layer | Choice | Version (latest, Sept 2026) | Why |
|---|---|---|---|
| Runtime | Node.js | **24 LTS** | Current LTS; native `fetch`, WebSocket client, `--env-file` |
| Language | TypeScript (strict) | 7.x (native compiler) | 10× faster type-check; same semantics |
| Package manager | pnpm + Turborepo | turbo 2.10 | Fast monorepo, remote cache |
| Backend | NestJS | 12.0 | Modules, DI, guards, gateways, first-class BullMQ |
| Validation | Zod + nestjs-zod | zod 4.6 / nestjs-zod 5.5 | One schema → DTO + OpenAPI + client types |
| DB | PostgreSQL 17 + pgvector + pg_trgm | — | One store for data, search, vectors |
| ORM | Drizzle ORM + drizzle-kit | 0.45 / 0.31 | SQL-close, RLS-friendly, fast |
| Driver | `postgres` (porsager) | 3.4 | Fastest Node PG driver, prepared statements |
| Cache/queues | Redis 7 + BullMQ + ioredis | bullmq 6.3 / ioredis 6.0 | Jobs, delayed SLA timers, rate limits, sessions |
| Realtime | Socket.IO + Redis adapter | 4.8 / 8.3 | Multi-replica rooms; SSE fallback for widget |
| Email out | Nodemailer | 10.0 | SMTP per brand |
| Email in | imapflow + mailparser | 2.0 / 3.9 | IMAP IDLE/polling, robust MIME parsing |
| Telegram | grammY | 1.46 | Webhook + polling, typed Bot API |
| AI | @mariozechner/pi-ai + pi-agent-core | 0.73 | Multi-provider, API key **or** OAuth/subscription, cost tracking |
| Images | sharp | 0.35 | WebP conversion, thumbnails, EXIF strip |
| Audio/video | ffmpeg (static binary in image) | — | Voice-note normalization, video posters |
| Auth | passport + argon2 + jose + otplib | 0.7 / 0.45 / 6.2 / 13.5 | Hand-wired, auditable |
| Storage | @aws-sdk/client-s3 | 3.x | S3 / MinIO / R2 — S3-only in v1 |
| Docs parsing | unpdf, mammoth, cheerio, playwright (optional) | 1.8 / 1.12 / 1.2 / 1.63 | PDF, DOCX, HTML crawl |
| Connectors | @notionhq/client, googleapis | 5.26 / 181 | Notion + Google Drive knowledge |
| Admin UI | Vite + React + MUI + TanStack Query + React Router | vite 8.3 / react 19.3 / mui 9.4 / rq 5.103 / rr 8.4 | Fast build, mature components, RTL support in MUI |
| Help center | Vite SSR React (served by Nest) | — | SEO + custom domains |
| Widget | Preact + Shadow DOM, Vite lib mode | preact 10.29 | < 40 KB, framework-free embed |
| i18n | i18next + react-i18next | 26.4 / 17.0 | JSON catalogs, RTL |
| Logging/metrics | pino + OpenTelemetry + prom-client | pino 10.3 | JSON logs, traces, `/metrics` |
| Tests | Vitest + Testcontainers + Playwright | 5.0 / 12.1 / 1.63 | Real PG/Redis in tests, e2e |
| Lint/format | Biome | 2.5 | One tool, fast |
| Release | Conventional Commits + Changesets | 3.0 | Auto changelog + semver |
| Antivirus | ClamAV container + clamscan | 2.4 | Optional attachment scanning |
| Reverse proxy | Caddy | 2.x | Automatic TLS, on-demand certs for custom domains |

Dropped from the original list: `EventEmitter` as a cross-service bus (Nest `@nestjs/event-emitter` is used in-process only for non-critical effects such as cache invalidation; anything with side effects goes through the transactional outbox, DOMAIN-RULES §6); Cloudflare/Vercel targets (v1.1+).

---

## 2. Repository layout

```
helpdock/
├── apps/
│   ├── api/            # NestJS — REST, WebSocket gateway, SSR host, worker (APP_ROLE)
│   ├── admin/          # Vite + React + MUI SPA (agents & admins)
│   ├── helpcenter/     # Vite SSR React app, rendered by api on brand domains
│   └── widget/         # Preact web component, built to a single JS file
├── packages/
│   ├── db/             # Drizzle schema, migrations, RLS policies, seed
│   ├── schemas/        # Zod schemas shared by api/admin/widget (single source of truth)
│   ├── ai/             # pi-ai wrapper: providers, embeddings, chunking, guardrails
│   ├── channels/       # ChannelAdapter interface + email, telegram, widget, form, api adapters
│   ├── ui/             # Shared React bits (theme tokens → MUI theme, RTL provider)
│   ├── i18n/           # en/, ar/ catalogs for all apps + email templates
│   └── config/         # Config loader: .env + DB settings, Zod-validated, typed
├── docker/
│   ├── Dockerfile      # single image (api + worker + built admin/helpcenter/widget)
│   ├── docker-compose.yml
│   ├── docker-compose.dev.yml
│   └── caddy/Caddyfile
├── docs/               # Docusaurus or plain MD: install, config, channels, AI, API, security
├── .github/workflows/  # ci (lint, typecheck, test), release, docker publish, codeql
├── SECURITY.md · LICENSE (AGPL-3.0) · CONTRIBUTING.md · README.md
```

Rule: `apps/*` never import each other; they share only `packages/*`.

---

## 3. Runtime topology (Docker Compose)

```
                 ┌────────────┐   :443 / :80
   Internet ───▶ │   caddy    │  TLS (on-demand for brand domains)
                 └─────┬──────┘
        host-based routing: admin.example.com → api (serves admin SPA)
                         support.brandA.com  → api (SSR help center)
                         api.example.com     → api (REST/WS/widget)
                 ┌─────▼──────┐        ┌──────────┐
                 │    api     │◀──────▶│  redis   │◀───┐
                 │ (N replicas)│        └──────────┘    │
                 └─────┬──────┘                        │
                       │           ┌──────────┐   ┌────▼─────┐
                       └──────────▶│ postgres │   │  worker  │ (N replicas)
                                   │ 17+pgvec │   │ BullMQ   │
                                   └──────────┘   └────┬─────┘
                                                       │ IMAP poll, Telegram send,
        ┌──────────┐   ┌─────────┐                     │ SLA timers, AI, indexing,
        │  minio/  │   │ clamav  │ (optional)          │ webhooks, media transcode
        │  S3      │   └─────────┘                     ▼
        └──────────┘
```

- **One image, two roles:** `APP_ROLE=api` boots HTTP + WebSocket + SSR; `APP_ROLE=worker` boots only BullMQ processors and IMAP/Telegram pollers. Same code, same config.
- **Caddy on-demand TLS:** Caddy asks `GET /internal/domain-check?domain=…` before issuing a cert; api answers 200 only for verified brand domains (CNAME + TXT verified in admin). Behind Cloudflare proxy, on-demand TLS is skipped and host routing alone applies.
- Redis is used for: BullMQ, Socket.IO adapter, refresh-token state, throttler counters, short-lived caches (brand config, theme, help-center pages).

---

## 4. Configuration model

Two layers, one typed object (`packages/config`), validated with Zod at boot.

1. **`.env` — bootstrap + overrides** (required to start):
   `DATABASE_URL`, `REDIS_URL`, `S3_*`, `APP_MASTER_KEY` (32 bytes, base64), `APP_URL`, `APP_ROLE`, `NODE_ENV`, `PORT`.
   Any other setting *may* be set here; if it is, it **overrides** the DB value and the admin UI shows it as locked ("set by environment").
2. **Database `settings` table — everything else** (editable in admin): SMTP defaults, OAuth client ids/secrets, LLM providers, feature toggles, limits, branding, CAPTCHA keys, etc.
   Secret-typed keys are encrypted with AES-256-GCM under `APP_MASTER_KEY` (key id stored with each row for rotation) and never returned to the client after save.

Config is cached in-process with a Redis pub/sub invalidation so a change in admin applies to all replicas within a second, without restart.

---

## 5. Data model (core tables)

All tenant tables have `brand_id uuid not null` + RLS policy `brand_id = ANY(current_setting('app.brand_ids')::uuid[])`. Ticket-scoped tables additionally enforce department scope (DOMAIN-RULES §1.3). All policies are `FORCE`d; the runtime DB role is `NOBYPASSRLS` and separate from the migration owner role (DOMAIN-RULES §1.5). IDs are **UUIDv7** (time-ordered → good index locality). Ticket display numbers come from `brand_ticket_seq` (a sequence per brand, created with the brand).

```
users, user_brand_roles(user_id, brand_id, role, department_ids[])
brands, brand_domains(domain, kind: helpcenter|widget_origin, verified_at, txt_token)
departments, teams, team_members
contacts(brand_id, primary_email, phone, telegram_chat_id, external_id, visitor_ids[], account_id)
accounts
tickets(brand_id, number, prefix, subject, status_id, priority, channel, department_id, team_id, assignee_id, merged_into_id, split_from_id,
        contact_id, sla_policy_id, first_response_due_at, resolution_due_at, sla_breached, closed_at, custom jsonb,
        search tsvector, parent_id)
ticket_messages(ticket_id, department_id /*denormalised for RLS*/, seq, client_id, kind: public|note|system|ai, author_type, author_id, body_html, body_text, channel,
                external_message_id, ai_meta jsonb)
attachments(message_id, s3_key, mime, size, kind: image|video|audio|file, variants jsonb, scan_status)
tags, ticket_tags, ticket_statuses, custom_field_defs
views, macros, canned_responses(locale), ticket_templates
sla_policies, business_hours, holidays
workflow_rules(trigger, conditions jsonb, actions jsonb, order, enabled), workflow_runs
channels(kind, config_encrypted, status, last_error) ; mailbox/telegram/widget/form/api rows
api_keys(brand_id, hash, scopes[], rate_limit, last_used_at)
webhooks, webhook_deliveries
hc_categories, hc_sections, hc_articles, hc_article_versions(locale, title, body, search tsvector, status)
hc_article_feedback, hc_search_log
knowledge_sources(kind: article|file|crawl|notion|gdrive, config_encrypted, sync_status)
knowledge_chunks(source_id, locale, content, embedding vector(<dims>), embedding_model, visibility, meta jsonb)   -- HNSW index; dims set by knowledge.configure (DOMAIN-RULES §8)
outbox(id, brand_id, event, payload jsonb, created_at, published_at), job_receipts(key, completed_at)   -- DOMAIN-RULES §6
ai_settings(brand_id, provider_id, model, embeddings_model, modes jsonb, guardrails jsonb, budget jsonb, system_prompt)
ai_calls(brand_id, ticket_id, purpose, model, tokens_in, tokens_out, cost, sources jsonb)
csat_responses, notifications, notification_prefs, audit_log, settings(key, value_encrypted, is_secret, updated_by)
```

Search: `tickets.search` and `hc_article_versions.search` are generated tsvectors using `english` or `arabic` config by locale; trigram GIN on subjects/titles for fuzzy matching; semantic search via `knowledge_chunks`.

---

## 6. Request lifecycle & tenancy

1. Caddy → api. `RequestContextMiddleware` sets request id, resolves brand from host (help center / widget) or from session/API key (admin/API).
2. Auth guard populates the `Principal` (DOMAIN-RULES §1.1): staff carry a role and department list **per brand**; visitors carry their conversation ids; API keys carry scopes; workers run as `system` for one brand.
3. `TenantInterceptor` opens a transaction and runs `SET LOCAL` for `app.brand_ids`, `app.department_ids`, `app.all_departments`, `app.principal_type`, `app.principal_id`. Every Drizzle query in the request runs inside it → RLS applies. Install-admin "all brands" paths set the full list explicitly and are audited. Route handlers declare `@Requires('<permission>')`; a CI check fails on any route without one.
4. Controllers validate with Zod pipes; services write domain rows **and an `outbox` row in the same transaction** for every side effect (rules, notifications, sends, indexing, webhooks). The worker's `outbox.relay` publishes rows to BullMQ with `jobId = outbox.id`; consumers are idempotent (DOMAIN-RULES §6). `@nestjs/event-emitter` is used only for in-process, non-critical effects.
5. Response DTOs are Zod-parsed on the way out (no accidental field leaks).

---

## 7. Auth design

- **Staff:** email+password (argon2id, pepper from master key) · magic link (single-use, 10 min) · Google/GitHub OAuth (passport strategies) · TOTP (otplib) with recovery codes; admin can enforce 2FA install-wide.
  Session = access JWT (jose, ES256, 10 min) in memory + refresh token (opaque, rotating, 30 days) in `httpOnly; Secure; SameSite=Lax` cookie; refresh family stored in Redis → revocation on logout/"log out everywhere"/password change. Reuse of a rotated refresh token kills the family.
- **Visitors (widget):** `visitor_id` (UUIDv7) plus a server-issued `visitor_secret` (hashed at rest) on first load, stored in localStorage for the brand and sent as the credential on REST and the socket handshake; a visitor reaches only conversations created with their `visitor_id`. Optional signed identity `{user_id, email, name, ts}` + HMAC-SHA256 with brand secret, ts ≤ 5 min, links a verified `external_id` (DOMAIN-RULES §4.1–4.2). Origin allow-list enforced on the token issue endpoint and on Socket.IO handshake.
- **API keys:** `hd_live_<random>` shown once; stored as SHA-256 hash; scopes; per-key throttle; brand-bound.
- **Internal endpoints** (`/internal/*`, e.g. domain-check, inbound-parse) require a shared secret header and are not exposed by Caddy publicly except where needed.

---

## 8. Channel adapters

```ts
interface ChannelAdapter {
  kind: 'email' | 'telegram' | 'widget' | 'form' | 'api' | /* v1.1: */ 'whatsapp' | 'slack' | …;
  init(channel: ChannelConfig): Promise<void>;        // start poller / register webhook
  handleInbound(raw: unknown): Promise<InboundMessage>; // normalize (text, attachments, identity, thread hints)
  send(msg: OutboundMessage): Promise<SendResult>;      // render + deliver
  health(): Promise<ChannelHealth>;
}
```

- Inbound path: adapter → `InboundMessage` → `ConversationRouter` (find contact by identity, find open ticket by thread key, else create ticket in the channel's default department) → `ticket.replied|created` events.
- Email thread key: `In-Reply-To`/`References` → known message ids, or `[PREFIX-N]` in subject, **and** the sender must be a ticket participant; otherwise new ticket with a mismatch note (DOMAIN-RULES §4.3).
- Telegram: `chat_id` = identity; open ticket per chat; media downloaded via Bot API `getFile` into S3 then processed.
- Widget: Socket.IO namespace `/widget`, rooms per conversation; SSE fallback via `GET /widget/stream`.
- Outbound always through the outbox → BullMQ (`send-email`, `send-telegram`, …) with retries, idempotency by `ticket_message_id`, and per-channel rate limits.

---

## 9. Media pipeline

1. Client requests a presigned PUT (after policy check: kind allowed, size, MIME) → uploads directly to S3 → confirms.
2. Worker job `media.process`: sniff MIME (magic bytes), reject mismatch;
   - **image** → sharp: re-encode to WebP (quality 82), max 2048 px, thumbnails 320/960, strip EXIF/ICC; original discarded unless "keep originals" is on.
   - **audio (voice)** → ffmpeg: normalize to Opus/OGG 48 kHz mono 32 kbps; duration stored; optional transcription job (AI provider, Whisper-compatible endpoint) → stored on the message.
   - **video** → size cap; poster frame via ffmpeg; no transcode in v1.
   - **file** → ClamAV scan if enabled; `Content-Disposition: attachment`.
3. Serving: short-lived presigned GET (5 min) via api redirect; never public bucket.

Per-brand **content policy** (Team Leader): `{voice, image, video, file}` each `{enabled, maxBytes, allowedMime[]}`, `maxAttachmentsPerMessage`. Enforced at presign time and again in the worker.

---

## 10. AI subsystem

```
packages/ai
├── providers/     pi-ai model registry; credentials from settings (api key | oauth tokens, encrypted)
├── embeddings/    OpenAI-compatible embeddings client (configurable base URL + model + dims)
├── ingest/        loaders: article | pdf(unpdf) | docx(mammoth) | md/txt | crawl(cheerio, optional playwright, sitemap)
│                  | notion(@notionhq/client) | gdrive(googleapis)  → chunker (by headings, ~500 tokens, overlap 60)
├── retrieval/     hybrid: audience filter (visibility, published) in SQL → pgvector cosine top-k + tsvector → reciprocal rank fusion → per-locale boost → citation validation (DOMAIN-RULES §5)
├── guardrails/    pii-redact (regex + Luhn), injection-filter for ingested text, budget meter, output checks
├── tasks/         suggestReply, summarize, classify, translate, draftArticle, autoReply(confidence)
└── agent/         pi-agent-core loop, tools = [] in v1 (read-only); streaming to admin/widget over WS
```

- **Auto-reply confidence:** model returns answer + cited chunk ids + self-rated confidence; combined with retrieval score; below brand threshold → handoff. Every reply carries "AI" badge and citations to the visitor. Handoff sets `ai_paused_until` and is checked immediately before every send (DOMAIN-RULES §9). Quality is gated by the EN/AR evaluation set, not only by mocked E2E tests.
- **Budget:** `ai_calls` aggregated per brand per day/month; soft alert at 80 %, hard stop at 100 % (auto-reply off, assist still allowed if configured).
- **OAuth/subscription providers:** supported through pi-ai's OAuth entry point; docs mark API-key as the officially supported path and subscription login as "at your own risk / check provider terms".

---

## 11. Help center SSR & custom domains

- `apps/helpcenter` is a Vite SSR React app; the api hosts it (`ssr-manifest`, streaming render) under a `HelpCenterController` that resolves the brand from `Host`.
- Cache: rendered HTML per `(brand, locale, path, audience)` in Redis, invalidated on article publish/theme change; ETag. Public pages: `Cache-Control: public, s-maxage=300, stale-while-revalidate=60`. Internal pages and staff sessions: `private, no-store`, never stored in Redis (DOMAIN-RULES §5).
- SEO: canonical, hreflang for locales, sitemap.xml per brand, OG tags, JSON-LD `FAQPage`/`Article`.
- Theme tokens → CSS custom properties injected inline; custom CSS sanitized (no `@import`, no `url()` to external hosts except allow-list).
- Domain onboarding: admin adds `support.brand.com` → shows CNAME target + TXT token → "Verify" → verified → Caddy on-demand TLS starts answering; behind Cloudflare, mark "proxied" to skip ACME.

---

## 12. Widget

- Built with Vite lib mode to `widget.js` (ES2022, Preact, no polyfills); mounts `<helpdock-widget brand="…" locale="…" mode="…">` with Shadow DOM; theme fetched from `GET /widget/:brand/config` (cached, ETag).
- Connection: Socket.IO client (only the websocket transport, no long-polling) with SSE fallback; heartbeat; reconnect with backoff. Delivery contract: client `client_id`, server `seq`, REST cursor catch-up on reconnect or gap; sockets are notifications, REST is truth (DOMAIN-RULES §7).
- Modes: chat · chat+articles · helpcenter · form. Article suggestions call `POST /widget/:brand/suggest` (debounced, semantic).
- Voice recording via `MediaRecorder`; file picker constrained by the brand policy received in config.
- Security: no `eval`, no inline styles outside Shadow DOM, origin check, per-visitor throttle, optional Turnstile before first message.
- Protocol documented in `docs/widget-protocol.md` for native apps.

---

## 13. Background jobs (BullMQ queues)

| Queue | Jobs | Notes |
|---|---|---|
| `inbound` | `email.poll` (per mailbox, repeatable), `telegram.update`, `form.submit` | dedupe by external id |
| `outbound` | `email.send`, `telegram.send`, `widget.deliver` | retries 5, backoff exp, DLQ |
| `sla` | `sla.first_response`, `sla.resolution` (delayed), `sla.escalate` | rescheduled on status change |
| `rules` | `rules.evaluate`, `rules.time_based` (cron) | depth guard |
| `ai` | `ai.assist`, `ai.autoreply`, `ai.classify`, `ai.transcribe` | per-brand concurrency + budget check |
| `knowledge` | `ingest.source`, `ingest.chunk_embed`, `crawl.page` | rate-limited crawl |
| `media` | `media.process`, `media.scan` | |
| `notify` | `notify.inapp`, `notify.email`, `notify.push` | |
| `webhooks` | `webhook.deliver` | HMAC, retry, log |
| `outbox` | `outbox.relay` | LISTEN/NOTIFY + 500 ms poll; publishes with `jobId = outbox.id` |
| `maintenance` | `cleanup.tokens`, `maintenance.retention`, `stats.rollup`, `sla.rebuild` (on boot) | cron |

Bull Board (auth-protected) mounted in admin System page for queue inspection.

---

## 14. Observability

- pino JSON logs with request id, brand id, principal (no PII bodies); log level per env.
- OpenTelemetry auto-instrumentation (http, pg, ioredis, bullmq) → OTLP exporter (optional endpoint).
- `/metrics` (Prometheus): http latency histograms, queue depth/failed, socket connections, AI tokens/cost, SLA breaches.
- `/health` (liveness) and `/ready` (DB, Redis, S3 reachability).
- Admin System page: version + git sha, pending migrations, queue health, channel status, storage usage, LLM spend.

---

## 15. Testing strategy

- **Unit** (Vitest): services, rule engine, thread-key resolver, guardrails, chunker.
- **Integration** (Vitest + Testcontainers): real Postgres (RLS policies verified: a brand can never read another brand's rows), Redis, MinIO; adapters with mocked external APIs (Telegram, SMTP via Mailpit).
- **E2E** (Playwright): admin flows (create brand → mailbox → rule → ticket lifecycle), widget in all four modes, help center SSR + RTL snapshot.
- **Security**: CI runs `pnpm audit`, CodeQL, Semgrep rules for Nest; a ZAP baseline scan against the docker-compose stack on release branches.
- Coverage gate 80 % on `packages/*`.

---

## 16. CI/CD

- PR: Biome → typecheck → unit/integration → e2e (sharded) → build image (not pushed).
- Main: Changesets version PR → on merge: tag, GitHub release with changelog + SBOM (CycloneDX), push `ghcr.io/docker-hunterpedia/helpdock:<ver>` and `:latest`, multi-arch (amd64/arm64).
- Renovate weekly for dependencies; security updates immediate.

---

## 17. Docker Compose (production shape)

```yaml
services:
  caddy:    { image: caddy:2, ports: ["80:80","443:443"], volumes: [./caddy/Caddyfile:/etc/caddy/Caddyfile, caddy_data:/data] }
  api:      { image: ghcr.io/docker-hunterpedia/helpdock:latest, env_file: .env, environment: { APP_ROLE: api }, depends_on: [postgres, redis] , deploy: { replicas: 2 } }
  worker:   { image: ghcr.io/docker-hunterpedia/helpdock:latest, env_file: .env, environment: { APP_ROLE: worker }, depends_on: [postgres, redis] }
  postgres: { image: pgvector/pgvector:pg17, volumes: [pg_data:/var/lib/postgresql/data] }
  redis:    { image: redis:7-alpine, command: ["redis-server","--appendonly","yes"], volumes: [redis_data:/data] }
  minio:    { image: minio/minio, profiles: [dev] }        # prod: external S3
  clamav:   { image: clamav/clamav, profiles: [clamav] }   # optional
```

`.env.example` documents every bootstrap key (`DATABASE_URL` is the runtime role, `DATABASE_MIGRATION_URL` the owner role); the wizard at first `/` creates the admin, the first brand, and tests SMTP (LLM step arrives with M7). Backup, restore, upgrade and key-rotation procedures: DOMAIN-RULES §10.

---

## 18. Milestones (suggested)

| # | Milestone | Scope |
|---|---|---|
| M0 | Skeleton | Monorepo, config loader, DB + RLS, auth (password/magic/TOTP/OAuth), admin shell, Compose, CI |
| M1 | Ticketing core | Brands, departments, tickets, messages, contacts/accounts, views, tags, custom fields, notes, attachments + media pipeline |
| M2 | Email channel | IMAP + inbound-parse, threading, SMTP out, auto-responders |
| M3 | Automation & SLA | Rules engine, time-based rules, macros, canned responses, SLAs, business hours, notifications |
| M4 | Widget + realtime | Widget (4 modes, theme, content policy, voice), Socket.IO, forms, CAPTCHA |
| M5 | Help center | Content model, editor, SSR, search, custom domains + Caddy, i18n content |
| M6 | Telegram | Bot adapter, media, health |
| M7 | AI | Providers (key/OAuth), knowledge sources (articles/files/crawl/Notion/Drive), assist/auto-reply/triage, guardrails, budget |
| M8 | API, webhooks, reports | Tenant API + keys, outbound webhooks, dashboards, CSV |
| M9 | Hardening & release | Pentest, a11y pass, docs, `1.0.0` |

---

## 19. Open decisions (small, can settle during M0)

- Editor library for articles/replies: TipTap (ProseMirror) vs Lexical — lean TipTap for RTL maturity.
- Web push: VAPID via `web-push` package (yes, small).
- CAPTCHA default: Cloudflare Turnstile (free, privacy-friendly), hCaptcha as alternative.
- Bull Board vs custom queue page: Bull Board embedded, custom summary on System page.
- Embedding model scope: one per install, no per-brand override in v1 (DOMAIN-RULES §8).
