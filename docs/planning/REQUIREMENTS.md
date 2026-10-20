# Helpdock — Product Requirements (v1)

> Open-source customer support platform: ticketing + help center + live chat + AI, in one deploy that serves many brands.
> License: AGPL-3.0 · Repo: `github.com/Docker-Hunterpedia/helpdock` · Docs language: English · Product UI: English + Arabic (RTL) in v1.

---

## 1. Vision

Most teams pay Zoho Desk / Zendesk / Freshdesk for two things: a ticketing system and a help center. The open-source options either stop at basic ticketing, bolt AI on as an afterthought, or can't serve several websites from one install without becoming a SaaS.

Helpdock is built from day one around four ideas:

1. **One deploy, many brands.** A single installation hosts any number of brands. Each brand has its own inboxes, help center (on its own domain, e.g. `support.helpdock.com`), widget theme, channels, and AI knowledge.
2. **Zoho-style ticketing discipline.** Departments, SLAs, workflow rules, macros, views, and agent collision — not "a chat inbox with labels".
3. **AI that is grounded and controlled.** The AI answers from *your* knowledge (help center, files, crawled sites, Notion, Google Drive), never takes actions, and every AI feature is a toggle. Any LLM provider, by API key or subscription.
4. **Security and speed are requirements, not features.** Row-level tenant isolation in Postgres, encrypted secrets, signed widget identities, rate limits everywhere, and a widget under 40 KB.

### Non-goals (v1)
Blueprint-style visual process builder · community forums · phone/VoIP · billing or SaaS metering · SLA credits · Slack/Discord · customer login portal · backups tooling · one-click cloud deploy (Docker Compose only).

### 1.x
Helpdock 1.x is planned as Phase 5 of the [PRD](PRD.md#phase-5--1x) (M12 to M20, planned on 2026-10-20). Two v1 non-goals are now in scope: backup tooling (M15, `helpdock-ctl`) and a guided deploy (M15's verified installer, cloud-init recipe and Coolify template; Docker Compose stays the only supported runtime). The rest stay non-goals, joined by native iOS and Android **agent** apps (they need a push relay the project would host), a hosted Helpdock, and deploying on Vercel or Cloudflare. The scope statements below say where 1.x changes a v1 limit; the behavioural rules for each change land in DOMAIN-RULES with the milestone that builds it.

---

## 2. Personas & roles

| Role | Scope | Can |
|---|---|---|
| **Admin** | Whole install | Everything: brands, users, channels, AI providers, config, roles toggle, system page |
| **Team Leader** | Brand(s) / department(s) assigned | Manage agents in their departments, SLAs, workflow rules, macros, canned responses, help center content, widget theme, chat content policy (voice/image/video/files), view reports |
| **Agent** | Departments assigned | Work tickets **in their departments only** (tickets elsewhere are invisible, even when assigned to them), reply, internal notes, use macros/canned responses, propose articles |
| **Viewer** *(optional, admin can disable the role)* | Brand(s) | Read-only tickets, reports, help center |
| **Visitor / Contact** | Public | Use widget, browse help center, receive email/Telegram replies. No login in v1. |

Rules:
- Roles are fixed in v1; custom permission sets are v1.1.
- A user can hold different roles in different brands.
- Every permission check is enforced server-side (guards + RLS on brand and department) and reflected in UI. Full matrix in DOMAIN-RULES §1.

---

## 3. Multi-brand model

```
Install
└── Brand (e.g. Helpdock)
    ├── Domains: support.helpdock.com (help center), widget allowed origins
    ├── Departments (Billing, Technical, Sales)
    │   └── Teams → Agents
    ├── Channels: email mailboxes, Telegram bots, WhatsApp numbers, Facebook Pages, Instagram accounts, web widget(s), API keys
    ├── Help Center (categories → sections → articles, per locale)
    ├── Theme (tokens) for widget + help center
    ├── AI config: provider, model, knowledge sources, modes, guardrails
    ├── Content policy for chat (voice/image/video/files, sizes, types)
    └── SLAs, business hours, holidays, workflow rules, macros, views, tags
```

- Brand is the tenant boundary. Every table carries `brand_id` (or `install`-level for global objects) and Postgres RLS enforces it.
- Global objects: users, roles, LLM provider credentials (can be shared across brands or scoped to one), system settings.
- Ticket numbers are auto-generated per brand: `<BRAND_PREFIX>-<sequence>` (e.g. `HD-1042`). Prefix editable once at brand creation; sequence is a Postgres sequence per brand — never reused.

---

## 4. Functional requirements

### 4.1 Ticketing (Zoho-style)

**Ticket** = subject, description (first message), contact, brand, department, status, priority, channel, assignee, team, tags, due date, SLA policy, custom fields, CSAT, thread of messages (public replies + internal notes), attachments, activity log.

- **Statuses:** Open, On Hold, Escalated, Closed (system) + custom statuses per brand mapped to one of the four system states with `pauses_sla` and `awaiting_customer` flags (so SLA/reporting stay consistent). Transition table in DOMAIN-RULES §2.
- **Reopen policy** per brand, set by Team Leaders: customer reply to a closed ticket reopens it within N days (default 7), always, or never (new linked ticket). DOMAIN-RULES §2.3.
- **Priorities:** Low, Medium, High, Urgent (labels editable).
- **Channels:** Email, Web chat, Telegram, WhatsApp, Messenger, Instagram, Web form, API, Manual.
- **Contacts & Accounts:** contact = person (email/phone/telegram id/WhatsApp, Messenger and Instagram ids/visitor id merged into one identity, automatically only when both identifiers are verified, DOMAIN-RULES §4.4); account = customer company; contacts belong to accounts; contact timeline shows all tickets across channels that the viewer is allowed to see.
- **Views:** saved filters (personal + shared), Zoho-like defaults: My open, Unassigned, Overdue, All open per department, Escalated.
- **Assignment:** manual, round-robin per department, skill-based (tags on agents ↔ ticket tags/department), load-cap per agent, auto-unassign when agent goes offline (toggle).
- **Agent collision:** live indicator when another agent is viewing/replying.
- **Merge / Split / Parent–child** tickets, with the semantics in DOMAIN-RULES §2.4.
- **Spam:** mark as spam; sender-level block list; optional spam heuristics on email (SPF/DKIM failures + keyword rules).
- **Macros:** one-click bundles of actions (set status, priority, tags, assignee, reply with canned response).
- **Canned responses:** per brand, per department, with placeholders (`{{contact.first_name}}`, `{{ticket.number}}`), EN/AR variants.
- **Ticket templates:** predefined subject/fields for manual creation.
- **Custom fields:** text, number, date, select, multi-select, checkbox; per brand; shown on ticket, contact, or account.
- **Tags:** free-form, per brand, color-coded.
- **CSAT:** on close, send rating link (email/widget/Telegram) — 1–5 + comment; toggle per brand.
- **Time tracking:** optional per-reply timer, manual entries (toggle).
- **Activity log:** every state change with who/when/via what (UI, rule, API, AI).

### 4.2 SLAs & business hours
- Business hours + holidays per brand (and optionally per department), timezone-aware.
- SLA policy: first-response and resolution targets per priority; escalation steps (notify, reassign, raise priority) at % thresholds; pause on statuses flagged `pauses_sla`. An AI auto-reply counts as first response when the brand toggle `ai_counts_as_first_response` is on (default on); auto-acknowledgments never count. Full calculation rules and worked examples in DOMAIN-RULES §3.
- SLA timers computed by the worker (BullMQ delayed jobs), visible on ticket and in views; breach badge.

### 4.3 Automation

**Workflow rules** (event-driven): `WHEN <event> IF <conditions> THEN <actions>`
- Events: ticket created, updated, replied (by contact / agent), status changed, assigned, tag added, SLA warning/breach, CSAT received, article viewed → no ticket (for analytics).
- Conditions: any ticket/contact/account field, channel, department, time in status, business hours, contains text (subject/body), AI classification output.
- Actions: set field, assign (user/team/round-robin), add/remove tag, send email/Telegram/widget reply (canned response), create internal note, notify agent/team, call webhook, run AI classify/summarize, escalate, close.

**Time-based rules:** run every N minutes over matching tickets (e.g. "awaiting customer > 72h → close with template").

- Rule builder in admin: visual, no code; ordered; per brand; test-run against a sample ticket; execution log.
- Guard: rules cannot trigger themselves in a loop (max depth 3, cycle detection).

### 4.4 Channels

All channels implement one `ChannelAdapter` interface (normalize inbound → message; render outbound; identity mapping; health check).

**Email**
- Inbound: IMAP polling per mailbox (imapflow + mailparser) **and** inbound-parse webhooks (Postmark, SendGrid, Mailgun, Resend, generic JSON).
- Threading by `Message-ID`/`In-Reply-To`/`References` + ticket-number token in subject `[HD-1042]`; quoted-reply stripping; inline images preserved; attachments → S3.
- Outbound: SMTP per brand (Nodemailer), `From`/`Reply-To` per department, HTML + plain text, signature per agent, DKIM handled by the SMTP provider.
- Auto-responders: new ticket acknowledgment, out-of-hours notice (per brand).
- Loop protection: `Auto-Submitted`, `Precedence: bulk`, rate cap per sender.

**Telegram**
- One or more bots per brand (`grammY`); webhook mode with secret token in production, long polling for dev.
- Each chat with the bot = one contact; new message when no open ticket → new ticket; replies from agents go back to the chat.
- Supports text, photos, documents, voice notes (OGG/Opus → normalized), locations (stored as text).
- Optional `/start` welcome text and language pick.

**WhatsApp, Messenger and Instagram (Meta)** — M10, [ADR 0025](../decisions/0025-meta-channels-through-one-graph-adapter.md)
- One connected account per WhatsApp business number (Cloud API), Facebook Page (Messenger) or Instagram professional account (Instagram API with Instagram Login); several per brand; an account belongs to one brand. Connected by pasting the token and id from the operator's Meta developer app; one Meta app per install, with one webhook callback (`/api/meta/webhook`) signed with the app secret.
- Each customer on an account = one contact, keyed on the platform's scoped id (WhatsApp business-scoped user id, with the phone recorded as a verified identifier when Meta sends it; Messenger page-scoped id; Instagram-scoped id with the `@username`); a new message with no open ticket → new ticket in the account's department; agent replies go back on the same platform.
- Inbound: text, images, video, documents, audio and voice notes, stickers (through the media pipeline, fetched by a job), locations and shared contacts as text, quoted context, story replies and mentions; delivery and read reports update the reply's state. Unsent messages are marked, not removed.
- Outbound: text split at the platform's limit, each attachment as a message of its own, within Meta's limits per platform.
- **Reply window** (DOMAIN-RULES §2.6): a reply is accepted only within 24 hours of the customer's last message; on Messenger and Instagram within 7 days for a person's reply when the account's Human Agent feature is on. The composer says how long is left and the api refuses a late reply. WhatsApp templates reach a customer after the window (M10-09).
- Health: token check, webhook subscription check with re-subscribe, Instagram token refresh, Reconnect in admin.
- Not in M10: OAuth connect flows and Embedded Signup, Instagram through Facebook Login, importing replies typed in Meta Business Suite, backfill of missed webhooks, AI auto-reply and the satisfaction survey on these channels, Messenger profile names before App Review. Operators carry Meta's App Review for Messenger and Instagram and WhatsApp's per-message pricing.

**Web widget** — see 4.6.

**Web form** — hosted form per brand (embed or link) with custom fields, CAPTCHA (Turnstile/hCaptcha) toggle.

**API** — tenant API keys (scoped) can create/update tickets, add messages, upsert contacts, search articles.

**Not in v1 (adapter interface ready):** Slack, Discord.

### 4.5 Help center
- Structure: Category → Section → Article. Draft / published / archived. Scheduled publish.
- Editor: rich text with images (auto WebP), code blocks, callouts, tables, embedded video (URL), anchors. Markdown import/export.
- **Multilingual:** one article, many locale versions; fallback to brand default locale; RTL correct.
- Per brand: theme (tokens), logo, favicon, custom CSS (sanitized), header/footer links, home layout (featured articles, popular, search).
- **Custom domain** per brand with TLS (Caddy on-demand) or behind Cloudflare; canonical URL + sitemap + Open Graph per article; SSR for SEO.
- Search: Postgres full-text (tsvector, per-language config `english`/`arabic`) + trigram fuzzy + semantic (pgvector) merged and ranked.
- Article feedback (👍/👎 + comment), view counts, "related articles" (semantic).
- Access: public, or restricted to logged-in agents (internal KB) in v1; contact-authenticated KB is v1.1. Internal content is never used for visitor-facing AI answers, public search, sitemaps or public caches (DOMAIN-RULES §5).
- Article → ticket handoff: "Still need help?" opens widget/form with article context.
- Agents can propose an article from a resolved ticket (AI drafts it, Team Leader approves).

### 4.6 Live chat widget
- Single `<script>` tag + `<helpdock-widget brand="…">` web component; Shadow DOM; < 40 KB gzipped; CSP-friendly; loads theme from brand.
- **Modes per brand** (admin switch, live preview):
  1. Chat only
  2. Chat + suggested articles (typing → semantic suggestions before sending)
  3. Help center only (search + browse inside widget)
  4. Contact form (offline / no agents online)
- **Theme tokens:** logo, primary/secondary colors, background, text, border radius, shape (rounded/square/pill), font family, position (left/right), launcher icon/text, dark/light/auto, RTL auto by locale.
- Visitor identity: anonymous visitor id (cookie/localStorage, per brand); optional **signed identity** (site passes `user_id` + HMAC with brand secret) — toggle in admin.
- Allowed origins list per brand; requests from unknown origins are rejected.
- Pre-chat form (name/email/custom fields) toggle; business-hours awareness; queue position; typing indicators; read receipts; agent avatar/name; transcript by email (toggle).
- **Rich content policy (Team Leader controls per brand):** text · emoji · images · video · voice messages · files — each on/off, max size, allowed MIME types, max attachments per message.
  - Voice: recorded via MediaRecorder (WebM/Opus, or MP4/AAC on Safari), normalized server-side to Opus; optional AI transcription shown to agents.
  - Images: converted to WebP, thumbnails generated, EXIF stripped.
  - Video: size-capped, stored as-is, poster frame generated.
- Mobile: v1 = documented widget REST + WebSocket protocol (so native apps can integrate). 1.x plans a headless widget client and React Native and Flutter SDKs (PRD M20), and an installable admin with mobile agent layouts (PRD M17).

### 4.7 AI

**Provider layer** (`@mariozechner/pi-ai`): any supported provider (OpenAI, Anthropic, Google, OpenRouter, Ollama/vLLM/OpenAI-compatible, …) via **API key** or **OAuth/subscription** login. Configured in admin (global, or per brand override). Model list auto-discovered. Token/cost tracked per brand.
Embeddings: separate configurable OpenAI-compatible endpoint (OpenAI, Voyage, local Ollama).

**Knowledge sources** (per brand, each with sync schedule + status):
- Help center articles (auto)
- Uploaded files: PDF, DOCX, MD, TXT
- Website crawl: sitemap or seed URLs, depth/limit, include/exclude patterns, cheerio by default, Playwright optional for JS sites
- Notion (official API, OAuth per brand, selected pages/databases)
- Google Drive (Docs/Sheets/PDF, OAuth per brand, selected folders)
- Chunk → embed → store in pgvector with source/URL/locale metadata; re-index on change.

**Modes** (each toggleable per brand):
1. **Agent assist:** suggest reply (with citations), summarize ticket, suggest tags/priority/department, translate message (AR↔EN), rewrite tone, draft article from ticket.
2. **Auto-reply in widget/Telegram/email:** answers from knowledge with citations; **confidence threshold**; below threshold → hand off to human with a transparent message; customer can always type "talk to a human".
3. **Auto-triage:** classify intent/category, set priority/department/tags via workflow action.

**Guardrails** (default on):
- PII redaction before sending to LLM (emails, phones, card numbers, IBANs masked; reversible for agents).
- Prompt-injection filter on crawled/imported content (strip instructions, mark suspicious chunks).
- No tool/actions in v1 — the AI can only read knowledge and write text. This rule stands until PRD M13-01 replaces it (ADR 0032, proposed): in 1.x reads may run and changes are proposed and run only after a person approves them. M12 (the AI workspace: playground, saved tests, review queue, personas, guardrails, cost estimates, confidence-gated triage, a read-only staff assistant) stays inside the v1 rule.
- Per-brand token budget (daily/monthly) with alerts and hard stop.
- Every AI output is logged with model, prompt hash, sources, cost; visible on the ticket.
- System prompt per brand (tone, language policy, forbidden topics) editable by Team Leader.

### 4.8 Reports & dashboards
- Per brand/department/agent, date range: ticket volume by channel/status/priority, first-response & resolution time, SLA compliance, backlog trend, CSAT, agent workload, busiest hours, help-center top searches / zero-result searches, AI deflection rate and cost.
- CSV export. Scheduled email report (weekly) v1.1.

### 4.9 Notifications
- In-app (realtime) + email + browser push (web push) for agents: assignment, reply, mention (`@name` in notes), SLA warning/breach, escalation.
- Per-user notification preferences.
- Telegram notifications to agents: v1.1.

### 4.10 Admin panel (everything dynamic)
- Brands, domains (with verification status), departments, teams, users, roles (enable/disable Viewer), invitations.
- Channels: mailboxes (IMAP/SMTP test button), inbound-parse endpoints, Telegram bots (token, set webhook button, health), Meta accounts (WhatsApp numbers, Facebook Pages, Instagram accounts: token, subscribe, health, Human Agent switch), widget origins, API keys (scopes, rate limit, last used, revoke).
- Ticketing config: statuses, priorities, tags, custom fields, templates, canned responses, macros, views, SLAs, business hours, holidays, workflow rules (with logs).
- Help center: content tree, theme, custom CSS, domain, locales.
- Widget: theme tokens, mode, pre-chat form, content policy, allowed origins, install snippet, live preview.
- AI: providers (key/OAuth), models, embeddings, knowledge sources (sync now / logs), modes, guardrails, budget, prompt.
- **Settings:** any non-bootstrap config editable here (stored encrypted); shows which keys are overridden by `.env`.
- **System:** version, migrations state, queue health, channel connection status, storage usage, LLM usage/cost, health checks, audit log.

### 4.11 Public REST API (tenant)
- Auth: `Authorization: Bearer hd_live_…` scoped keys (tickets:read/write, contacts:read/write, articles:read).
- Endpoints (v1): tickets CRUD + messages, contacts upsert/search, articles search/get, webhooks CRUD.
- Per-key rate limits; idempotency keys on create; OpenAPI 3.1 spec served at `/api/docs`.

### 4.12 Outbound webhooks
- Events: `ticket.created`, `ticket.updated`, `ticket.replied`, `ticket.closed`, `contact.created`, `csat.received`, `article.published`.
- 1.1 (M14-28) adds `ticket.assigned`, `ticket.status_changed`, `ticket.merged`, `message.created`, `contact.updated`, `contact.merged`, `account.created` and `account.updated`. Per-endpoint `includeInternalNotes` defaults off; notes are delivered without either body unless opted in. Ticket/message events carry the department; contact/account events are brand-scoped. No configuration-object events.
- HMAC-SHA256 signature header, retries with backoff, delivery log, replay.

### 4.13 Internationalization
- UI (admin, widget, help center, emails): **English + Arabic** in v1, full RTL, i18next JSON catalogs; adding a locale = adding a file. 1.x adds a locale registry, a contributor translation workflow and more locales, customer-facing surfaces first (PRD M17).
- Content: articles, canned responses, auto-responders have per-locale versions.
- Date/number formatting per locale; Arabic search config in Postgres.

---

## 5. Non-functional requirements

### 5.1 Security (non-negotiable)
- Passwords: argon2id. Sessions: short-lived JWT (jose) + rotating refresh token in httpOnly/SameSite cookie, refresh state in Redis (revocable). TOTP 2FA (otplib) for all staff, enforceable per install. OAuth: Google, GitHub. Magic link. 1.x plans passkeys (WebAuthn) for staff, OAuth identities bound by provider subject, Microsoft sign-in and a built-in proof-of-work CAPTCHA (PRD M18). SSO for staff over SAML 2.0 and OpenID Connect with just-in-time provisioning and group-to-role sync, enforceable per install with break-glass admins (M11).
- **Postgres Row-Level Security** on every tenant table, set per request (`SET LOCAL app.brand_ids`). No query runs outside a tenant context except admin/system paths.
- Secrets (SMTP, bot tokens, LLM keys, OAuth tokens) encrypted at rest with AES-256-GCM under a master key from `.env`; never returned to the UI after save.
- Widget: allowed-origin check, signed visitor identity (optional), per-visitor and per-IP rate limits, CAPTCHA option, no inline scripts, strict CSP on the served bundle.
- Uploads: MIME sniffing (not trusting extension), size caps, image re-encode via sharp (kills polyglots + strips EXIF), optional ClamAV scan, S3 private bucket with short-lived presigned URLs, `Content-Disposition: attachment` for non-images.
- Email: no HTML JS/forms rendered; sanitized HTML (allowlist), remote images proxied/blocked (toggle).
- API: Zod validation on every boundary, output DTOs (no leaking internal fields), throttling (Redis) per IP/user/key, request-id, audit log of admin actions.
- Headers: HSTS, CSP, X-Content-Type-Options, Referrer-Policy; cookies `Secure`.
- Dependency policy: Renovate + `pnpm audit` in CI; SBOM generated on release.
- Security.md with disclosure process. OWASP ASVS L2 as the checklist for v1.

### 5.2 Performance
- Widget bundle < 40 KB gzipped, first paint < 300 ms on 3G.
- API p95 < 150 ms for ticket list/read at 50k tickets per brand; help-center SSR TTFB < 200 ms (cached).
- Realtime message delivery < 500 ms end-to-end, with reconnect catch-up and deduplication guaranteed by the delivery contract in DOMAIN-RULES §7.
- Horizontal: stateless API replicas behind Caddy; Socket.IO Redis adapter; workers scale independently.
- DB: indexes on `(brand_id, status, updated_at)`, `(brand_id, assignee_id)`, tsvector GIN, pgvector HNSW.

### 5.3 Reliability
- All side effects (email send, Telegram send, AI calls, indexing, webhooks) go through BullMQ with retries + dead-letter queue visible in admin.
- Idempotent inbound handling (dedupe by channel message id). Side effects are enqueued through a transactional outbox so a committed change is never left without its job and a rolled-back change never produces one (DOMAIN-RULES §6).
- Health/readiness endpoints; graceful shutdown.

### 5.4 Accessibility
- WCAG 2.1 AA for widget and help center (keyboard, focus, contrast, ARIA live regions for chat).

### 5.5 Data lifecycle and operations
- Per-brand retention for tickets, spam, AI logs, search log, audit log and visitor sessions; brand deletion with a 30-day grace; contact anonymisation. DOMAIN-RULES §11.
- Documented backup, restore, upgrade and master-key rotation procedures with a rehearsed restore drill before 1.0 (no backup tooling shipped in v1; 1.x plans `helpdock-ctl` for backup, restore, verify, upgrade and key rotation, PRD M15). DOMAIN-RULES §10.

### 5.6 Deployment
- **Docker Compose only** in v1: `api`, `worker`, `postgres:17` (+pgvector), `redis:7`, `caddy`, `minio` (dev) / external S3 (prod), optional `clamav`, optional `ffmpeg` sidecar (bundled in image).
- Single image for api/worker (`APP_ROLE=api|worker`).
- First-run wizard: admin account, first brand, SMTP test, LLM provider.
- Migrations run automatically on `api` start (lock-protected).
- 1.x keeps Docker Compose as the only supported runtime and plans a verified one-command installer, an external-proxy override, a bundled object-storage profile for production, opt-in automatic patch updates and a sample brand (PRD M15).

---

## 6. Add-on features (v1.1+ backlog)

**Planned for 1.x** (PRD Phase 5, 2026-10-20):

- AI actions via MCP tools (order lookup, refunds) with approval flow: PRD M13
- Importers beyond M11's connectors (Help Scout, Intercom, Gorgias, Zammad, Front), undo of an import, and importing macros, automations and SLA policies as disabled drafts: PRD M16
- Backup/restore tooling, and Coolify and cloud-init deploy paths: PRD M15
- More UI locales: PRD M17
- React Native + Flutter widget SDKs: PRD M20

**Backlog** (not scheduled):

- Slack, Discord, Viber, LINE
- Meta channels beyond M10: OAuth connect flows and Embedded Signup, Instagram through Facebook Login, Business Suite echo import, webhook backfill, auto-reply and surveys on these channels
- Customer portal (magic-link login, ticket history, restricted KB)
- Custom roles / permission sets; SCIM provisioning and single logout (SAML/OIDC SSO moved into 1.0 as M11)
- Per-department language routing
- Importers for further tools beyond PRD M16
- Scheduled reports, custom dashboards
- Article versioning + review workflow
- Knowledge: Confluence, GitHub docs, generic MCP servers
- Kubernetes / Helm
- Community forums, Blueprint-style process designer

**Dropped:** Cloudflare, Vercel and Railway deploy paths (Helpdock needs long-running workers, Socket.IO rooms and on-demand TLS; PRD §5 has the reasons).

---

## 7. Success criteria for v1

- A new user runs `docker compose up`, finishes the wizard, embeds the widget on two different sites under two brands, and receives a Telegram ticket — in under 30 minutes.
- Help center for a brand answers on `support.<brand>.com` with valid TLS and indexed by Google.
- AI auto-reply resolves a question from an uploaded PDF with a citation, and hands off when it isn't sure.
- An external pentest of the widget + API finds no High findings.
