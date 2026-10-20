# Helpdock threat model for automated scanning

Guidance for Anthropic's OSS Scanner, and for anyone else auditing this
repository with an automated tool. [SECURITY.md](../SECURITY.md) is the
project's policy; this file adds what an auditor needs to know to rate and
report a finding. The longer human-facing version is
[docs/guides/security.md](../docs/guides/security.md).

## What Helpdock is

Helpdock is a self-hosted customer support platform (AGPL-3.0). One install
serves many **brands**, each with its own staff, tickets, contacts, help center,
widget and channels. A brand is a tenant: brand A must never read or change
brand B's data. Staff answer customers who write in through:

- an embeddable chat widget (REST plus a Socket.IO namespace, with an SSE fallback),
- a hosted web form,
- email (IMAP polling, or an inbound-parse webhook from an email provider),
- Telegram bots,
- WhatsApp, Messenger and Instagram through Meta's Graph API.

Brands also publish a help center (server-rendered by the api), can turn on AI
answers grounded in their own knowledge, expose a public REST API with scoped
keys, send signed outbound webhooks, and import history from Zendesk,
Freshdesk and Zoho Desk.

Stack: TypeScript, NestJS on Fastify (`apps/api`), React admin SPA
(`apps/admin`), Preact widget (`apps/widget`), Postgres 17 with pgvector and
`FORCE`d row-level security, Redis with BullMQ, S3-compatible object storage,
Caddy in front. One image runs as `APP_ROLE=api` (HTTP and sockets) or
`APP_ROLE=worker` (queues). The design is in
[docs/planning/ARCHITECTURE.md](../docs/planning/ARCHITECTURE.md) and the rules
the code must follow are in
[docs/planning/DOMAIN-RULES.md](../docs/planning/DOMAIN-RULES.md). When the code
and DOMAIN-RULES disagree, the code is wrong, and that disagreement is a
finding.

## Who the attackers are

From least to most trusted:

1. **Anyone on the internet.** Reaches the widget routes, the web form, the
   help center, CSAT rating links, sign-in, password reset, magic links,
   invitations, OAuth and SSO callbacks, and the channel webhooks.
2. **A customer of a brand.** Everything above, plus a visitor secret for their
   own widget conversation, and the ability to send arbitrary email, Telegram
   or Meta messages, attachments and file names into a brand's desk. Customer
   content is shown to staff in the admin app.
3. **A holder of an API key.** Limited to one brand and to the key's scopes.
4. **A staff member of a brand.** Roles are Viewer, Agent, Team Leader and
   Admin, and Agents are limited to their departments
   ([DOMAIN-RULES §1.2](../docs/planning/DOMAIN-RULES.md#12-scope-rules)).
   A staff member of brand A is an attacker against brand B, and a lower role
   is an attacker against a higher one.
5. **A brand Admin.** Trusted inside their own brand only. They configure URLs
   (webhook destinations, crawl sources, IMAP and SMTP hosts, importer
   accounts), upload files and write help center HTML and CSS.
   They must not reach another brand, the install's internal network, the
   host, or the install's secrets.
6. **The install admin**, the person who runs the deploy. Fully trusted. Staff
   SSO and the install's AI providers are configured at this level.

The external services Helpdock calls (LLM providers, mail servers, Telegram,
Meta, Zendesk, Freshdesk, Zoho, OAuth and SAML identity providers, CAPTCHA
providers) are not trusted to be honest: their responses are input. Their own
vulnerabilities are out of scope.

## Where untrusted input enters

| Entry point | Code to start from |
|---|---|
| Widget REST `/api/widget/:brandId/…`, socket namespace `/widget`, SSE stream | `apps/api/src/widget/` (`widget-gate.ts`, `widget.gateway.ts`, `origin.ts`, `conversation-access.ts`, `widget-session.service.ts` for signed identity), protocol in [docs/guides/widget-protocol.md](../docs/guides/widget-protocol.md) |
| Hosted web form `/contact`, `/contact/<brandId>` | `apps/api/src/web-form/` |
| Help center pages `/hc/<brandId>/…` and verified custom domains, search, feedback, staff pass | `apps/api/src/help-center/site/`, `apps/api/src/help-center/visibility.ts`, `apps/api/src/help-center/site/custom-css.ts` |
| CSAT links `/csat/<token>`, `/api/public/csat/:token` | `apps/api/src/csat/` |
| Inbound email over IMAP | `apps/api/src/channels/email-poll.job.ts`, `packages/channels/src/email/` |
| Inbound-parse webhooks `/internal/inbound-parse/*` (Postmark, SendGrid, Mailgun, Resend, generic), guarded by a per-brand shared secret | `apps/api/src/channels/inbound/` |
| Email threading and HTML | `apps/api/src/channels/inbound/conversation-router.ts`, `packages/channels/src/html/sanitize.ts`, remote image proxy `apps/api/src/channels/remote-images.service.ts` |
| Telegram webhook `POST /api/telegram/<botId>/webhook` (secret token header) | `apps/api/src/telegram/telegram-webhook.service.ts` |
| Meta webhook `/api/meta/webhook` (verify token on `GET`, `X-Hub-Signature-256` on `POST`) and media fetched from Meta's CDN | `apps/api/src/meta/meta-webhook.service.ts`, `apps/api/src/meta/meta-media.job.ts` |
| Uploads from staff and visitors, presigned URLs, the media pipeline (magic bytes, sharp, ffmpeg, optional ClamAV) | `apps/api/src/media/` (`magic-bytes.ts`, `process.job.ts`, `storage.ts`) |
| Importers: vendor API responses, CSV and NDJSON uploads, attachment downloads | `packages/importers/src/`, `apps/api/src/imports/` |
| Knowledge sources: website crawl (optionally rendered in headless Chromium), Notion, Google Drive, uploaded files (PDF, DOCX, ZIP) | `apps/api/src/knowledge/`, `packages/ai/src/knowledge/` |
| AI: prompts built from tickets and knowledge, PII redaction, injection filter, auto-reply quality gate | `packages/ai/src/` (`complete.ts`, `guardrails/`, `auto-reply/`) |
| Any user-supplied URL fetched by the server | `packages/net/src/safe-fetch.ts`, `packages/net/src/blocked-ranges.ts`, [DOMAIN-RULES §13](../docs/planning/DOMAIN-RULES.md#13-outbound-network-safety) |
| Staff sign-in: password, magic link, password reset, invitations, TOTP and recovery codes, sessions and refresh | `apps/api/src/auth/` |
| Google and GitHub sign-in | `apps/api/src/auth/oauth/` |
| Staff SSO over SAML and OIDC | `apps/api/src/sso/` |
| Public API `/api/v1/*` with scoped keys, idempotency, outbound webhooks | `apps/api/src/api-v1/`, `apps/api/src/api-keys/`, `apps/api/src/webhooks/` |
| Staff REST and the `/staff` socket namespace | `apps/api/src/auth/permission.guard.ts`, `apps/api/src/realtime/` |
| First-run setup (`HD_SETUP_TOKEN`) | `apps/api/src/install/` |
| Admin SPA rendering customer content | `apps/admin/src/` |
| Deployment defaults | `docker/docker-compose.yml`, `docker/caddy/Caddyfile`, `docker/caddy/Caddyfile.cloudflare`, `docker/Dockerfile` |

## Assets, in order of importance

1. **Brand isolation.** Every tenant table has `brand_id` and a `FORCE`d
   row-level security policy, and ticket-scoped tables also check the
   department. Each request runs in a transaction that sets `app.*` settings
   (`packages/db/src/tenant.ts`); the policies are in `packages/db/src/rls.ts`.
   The runtime role `helpdock_app` is `NOBYPASSRLS` and owns nothing
   (`packages/db/src/roles.ts`). Paths without a tenant context are explicit
   install-scope or system paths (`apps/api/src/tenant/`). Worker jobs carry a
   `brandId` and run under it.
2. **Customer data**: conversations, contacts, attachments, PII. Visitors
   reach only their own conversation, or the verified contact's.
3. **Stored secrets**: SMTP, IMAP and inbound-parse credentials, Telegram and
   Meta tokens, webhook and widget signing secrets, CAPTCHA secrets, connector
   credentials, AI provider keys, staff TOTP secrets and the token signing key.
   They are encrypted with AES-256-GCM under `APP_MASTER_KEY`
   (`packages/config/src/crypto.ts`), returned to the browser only once, and
   never logged.
4. **Staff accounts and sessions**: Argon2id with a pepper, ES256 access
   tokens with Redis revocation, rotating refresh tokens with reuse detection,
   TOTP required for Admins.
5. **The install's internal network**: Postgres, Redis (no password on the
   Compose network by design), object storage, the `/internal/*` routes, cloud
   metadata endpoints.
6. **Internal-only knowledge**: help center articles and knowledge marked
   internal must not reach visitors, by page, search or AI answer. Visibility
   is filtered in SQL before ranking.

## In scope

- `apps/api` (the api and the worker), including the help center it renders.
- `packages/*`: `db`, `net`, `channels`, `importers`, `ai`, `config`, `jobs`,
  `schemas`, `i18n`, `ui`.
- `apps/widget`, the script customers embed on their own sites.
- `apps/admin`, where it renders customer-supplied or imported content.
- `apps/helpcenter` is a placeholder; the help center lives in `apps/api`.
- `docker/`: the Compose file, the Caddyfiles and the production Dockerfile, as
  shipped defaults.

## Out of scope

- Test code and fixtures: `*.test.ts`, `*.integration.test.ts`, `apps/*/e2e/`,
  `apps/api/src/testing/`, `packages/*/src/testing.ts` and `testing/`
  directories (including the AI eval and perf harnesses under
  `apps/api/src/testing/`), `apps/widget/harness/`.
- `apps/api/src/seed/` (the dev seed refuses `NODE_ENV=production`).
- `scripts/` (CI and developer tooling), `.github/`, `.semgrep/`, `.zap/`,
  `.agents/`, `docs/`.
- Vulnerabilities in dependencies with no reachable call path from Helpdock.
- Denial of service by volume or resource exhaustion. A missing rate limit on a
  route that guards a secret (sign-in, second factor, tokens) is in scope.
- Anything that needs a compromised host, the install admin account,
  `APP_MASTER_KEY` or direct database or Redis access.
- Operator choices the docs warn against: `TRUST_PROXY=true` behind an
  untrusted proxy, a wide `OUTBOUND_ALLOW_CIDRS`, publishing Redis or Postgres,
  routing `/internal/*` or `/metrics` to the internet without the documented
  protections.
- Self-XSS, and a brand Admin attacking their own brand's data.
- Third-party services themselves (LLM providers, mail, Telegram, Meta,
  identity providers). Helpdock's code that calls them and parses their
  answers is in scope.

## How to rate severity

Rate by the attacker's real position in the list under "Who the attackers
are", what they need beforehand, and what they get. Do not rate by bug class
alone.

**Critical**

- Reading or changing another brand's data, by any route: an RLS gap, a
  missing or wrong `app.*` setting, an install-scope path reachable by a brand
  user, a worker job that acts outside its `brandId`, a socket room joined
  across brands. Any SQL injection counts here, because it can rewrite the
  session settings RLS depends on.
- Authentication bypass: a staff, API key or install admin session without
  the credential, including SAML signature or assertion wrapping, OIDC or
  OAuth flaws that sign in as another account with no action from the victim,
  or skipping a required second factor.
- Remote code execution in the api, the worker or the media pipeline.
- SSRF that reaches the internal network, loopback or cloud metadata from any
  user-controlled URL (DNS rebinding, redirects, IPv6 forms and the crawler's
  rendered page included).
- Disclosure of `APP_MASTER_KEY`, the token signing key, or decrypted stored
  secrets, to anyone below the install admin.

**High**

- Stored XSS that runs in the admin app or on a help center origin, from
  customer content (email, widget, Telegram, Meta), imported data, file names,
  or help center HTML and CSS written by staff.
- Privilege escalation inside a brand: an Agent or Viewer gaining a higher
  role's permission, an Agent reading a department they are not in, an API key
  acting outside its scopes.
- A visitor reading or writing another visitor's conversation in the same brand.
- CSRF on a state-changing staff route.
- Account takeover that needs a victim action or a narrow precondition:
  password reset, magic link, invitation, OAuth or SSO account linking, session
  fixation, refresh token reuse.
- Forged inbound messages: bypassing the Telegram secret, the Meta signature,
  the inbound-parse secret, or email threading, so that a message lands in a
  ticket it does not belong to.
- Internal-only knowledge served to a visitor by page, search or AI answer.
- An upload served as active content (HTML, SVG with script) from a Helpdock
  origin.

**Medium**

- IDOR inside a brand that exposes data the role should not see but does not
  cross a department or brand.
- A missing rate limit on a route that guards a guessable secret.
- A secret or personal data written to logs, or sent to an LLM without PII
  redaction.
- Prompt injection that makes auto-reply send a customer content the quality
  gate should have stopped. The model has no tools, so injection cannot act.
- Open redirects, and revoked sessions or sockets that keep access well past
  the documented 5 seconds (sockets) or 10 minutes (access tokens).

**Low**

- Disclosure of non-sensitive facts (that a brand id exists, version strings).
- Missing hardening with no demonstrated exploit: a header, a cookie attribute,
  a timing difference that is not practical to measure.

Cap a finding at Medium when it depends on an operator choice the docs warn
against, and at Low when it needs the install admin's cooperation.

## Known and accepted

These are recorded and need no report unless the finding goes further than
the record:

- The [internal security review](../docs/completed/internal-security-review.md):
  F1 to F6 and N1 are fixed. F3 stays open for removing an allowed origin and
  rotating the widget signing secret: neither disconnects sockets already
  admitted.
- Its informational items: the help center media route answers a short-lived
  URL for any ready image, guarded only by the UUIDv7 id, including images in
  internal-only articles; `/api/v1` keys with `tickets:read` receive internal
  notes by design; `POST /api/auth/exchange` has no rate limit (256-bit code,
  60-second life).
- The rows left Partial in the [ASVS Level 2 walk-through](../docs/completed/asvs-l2.md):
  API key `expiresAt` is optional, a refused Telegram update is logged only at
  `debug`, the knowledge connectors' OAuth flow has no PKCE verifier, and
  email-link and Telegram Bot API tokens travel in URLs as their protocols
  require.
- The shipped Caddyfile answers `/internal/*` with 404, so inbound-parse
  webhooks are not reachable through it without an operator's own route.
- Redis has no password on the Compose network; it is never published.
- The injection filter on AI input is heuristic by design.
- The open questions for the external pentest are in
  [docs/planning/pentest-scope.md](../docs/planning/pentest-scope.md) ("What a
  vendor should attack first"). A confirmed problem in any of them is a finding.

## How to exercise it

The image built from [.oss-scanner/Dockerfile](Dockerfile) holds the checkout
at `/src` with its dependencies installed and every workspace built (`dist/`
in each package, the admin SPA and the widget bundle).

- Rebuild: `pnpm exec turbo run build`.
- Unit tests: `pnpm exec vitest run --project='!integration'`, or one file with
  `pnpm exec vitest run path/to/file.test.ts`. Unit tests run offline.
- The integration suites (`*.integration.test.ts`) start Postgres 17 with
  pgvector and Redis through Testcontainers, so they need a Docker daemon. The
  image has none, and those suites skip themselves (`describe.skipIf(!hasDocker)`).
  The RLS negative tests are in `packages/db/src/rls.integration.test.ts`; read
  them to see what isolation is meant to hold.
- The Playwright suites under `apps/*/e2e/` need the running stack and are not
  expected to run in the image.
- Test doubles and fakes (a Redis stub, mail doubles, fake OAuth, OIDC and
  SAML identity providers, a fake Telegram) are in `apps/api/src/testing/`, and
  `packages/ai`, `packages/channels` and `packages/importers` export more from
  `src/testing.ts`; reuse them in a proof of concept.
- `pnpm check:routes` names every handler without `@Requires`,
  `@Authenticated()` or `@Public()`, and `pnpm check:validation` every
  controller parameter without a named Zod schema.

## How to report

- One finding per report, with the attacker's position from the list above,
  what they must have first, and the impact.
- Point at `file:line` at the scanned commit, and name the DOMAIN-RULES or
  ARCHITECTURE section the code breaks, if one does.
- Proof of concept: a failing Vitest test colocated with the code
  (`*.test.ts`) is preferred. Where the bug needs Postgres or Redis, write it as
  a `*.integration.test.ts` in the style of the existing suites and say it was
  not run. Use synthetic data; no real credentials or services are needed.
- Patch: the smallest change that closes the issue at its root, in the
  repository's style (TypeScript strict, Zod at boundaries, side effects
  through the outbox), with the failing test turned green. No refactors.

## Deduplication

- Group by root cause: a missing check in a shared guard, interceptor or
  helper is one report even when many routes inherit it. List the affected
  routes in that one report.
- Split when the fixes go in different places, even if the symptom is the same.
- A variant of an item under "Known and accepted" is new only when it reaches
  further than the recorded item.
