# Configuration reference

<!-- Generated from packages/config (env.ts, registry.ts) and .env.example.
     Do not edit by hand: change those, then run
     pnpm vitest run --project @helpdock/config reference -u -->

Every key Helpdock reads, in three layers
([ARCHITECTURE §4](../planning/ARCHITECTURE.md#4-configuration-model)):

1. **Bootstrap keys** in `.env`: what the process needs before it can read the
   database. Checked at boot by `loadEnv` (`packages/config/src/env.ts`); a
   missing or invalid key stops the api and the worker with one message naming
   every key at fault, never its value.
2. **Compose keys** in the same `.env`, read by `docker/docker-compose.yml`
   and not by the application.
3. **Settings**, edited in admin and stored in the `settings` table. Any of
   them can be pinned from the environment with its `HD_*` variable, which
   overrides the database and locks the field in admin.

Start from `.env.example`: `cp .env.example docker/.env`. An empty value
counts as unset. The [install guide](install.md#install) says which keys a
first install must fill in.

## Bootstrap keys

### APP_URL

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `APP_URL` | yes | — | `https://support.example.com` |

Public http(s) URL of this install. Links in emails are built from it.

### APP_ROLE

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `APP_ROLE` | yes | — | `api` |

What this container runs: `api` serves HTTP and WebSockets, `worker` drains queues.

### APP_MASTER_KEY

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `APP_MASTER_KEY` | yes | — | — |

32 bytes of base64, generated with: openssl rand -base64 32
Every secret in the `settings` table is encrypted with it. Back it up with the
database: without it, stored secrets are unrecoverable (DOMAIN-RULES §10).

### APP_MASTER_KEY_PREVIOUS

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `APP_MASTER_KEY_PREVIOUS` | no | — | — |

Optional. During a key rotation, the key being rotated away from, so rows
encrypted under either key stay readable until every secret has been
re-encrypted under the new one with `node dist/cli.js keys rotate`
(DOMAIN-RULES §10). Passwords move to the new key only as each person signs
in, so keep it set for a while after the rotation
(docs/guides/operations.md#rotating-the-master-key).

### NODE_ENV

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `NODE_ENV` | yes | — | `production` |

development | test | production

### LOG_LEVEL

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `LOG_LEVEL` | no | `info` | `info` |

Optional. How much the api and the worker log: trace, debug, info, warn,
error, fatal or silent. Defaults to info, which is one JSON line per request
plus anything that went wrong. Raise it to debug when you are chasing
something; logs never contain message bodies, email addresses or headers
(docs/guides/operations.md). With NODE_ENV=development the lines are
prettified instead of JSON.

### METRICS_TOKEN

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `METRICS_TOKEN` | no | — | — |

Optional. A bearer token for /metrics; at least 16 characters, generated with:
openssl rand -hex 24.

Without it, /metrics answers only to requests that reached the api directly
from a private or loopback address — which is what a Prometheus scraping
api:3000 inside Compose or Kubernetes does. A request that arrives through the
reverse proxy always needs the token, because the socket it arrives on belongs
to the proxy and says nothing about who sent it.

The reverse proxy must not route /metrics publicly either way; that is the
first line and this is the backstop (docs/guides/operations.md).

### HD_SETUP_TOKEN

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `HD_SETUP_TOKEN` | no | — | — |

Optional, and recommended for any host reachable before setup is finished.
A key the first-run wizard asks for on its first step, so only someone who can
read this file can create the install administrator. At least 32 characters,
generated with: openssl rand -base64 32

Without it, whoever reaches a fresh install first can claim it. The key is
compared in constant time, counted by the wizard's rate limit, never logged
and never sent to a browser, and it stops mattering once the administrator
exists; remove it then if you like (docs/guides/install.md#first-run).

### PORT

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `PORT` | no | `3000` | `3000` |

Optional. HTTP port the api listens on. Defaults to 3000.

### TRUST_PROXY

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `TRUST_PROXY` | no | `false` | `false` |

Optional. `true` only when a reverse proxy Helpdock controls sits in front of
the api and sets `x-forwarded-*` and `x-request-id`. It decides whether the
api believes those headers, so leaving it `false` behind an untrusted network
is the safe default. Defaults to false.

### DATABASE_URL

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `DATABASE_URL` | yes | — | `postgres://helpdock_app:change-me@postgres:5432/helpdock` |

Postgres connection for the runtime role. The role is named `helpdock_app`,
is NOBYPASSRLS, and owns nothing, so every query is subject to the row-level
security policies (DOMAIN-RULES §1.5). The first migration creates it with the
password given here; api refuses to serve if this role can bypass RLS.

### DATABASE_MIGRATION_URL

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `DATABASE_MIGRATION_URL` | yes | — | `postgres://helpdock_owner:change-me@postgres:5432/helpdock` |

Postgres connection for the migration owner role, used only to run migrations.
It owns every table and needs CREATEROLE the first time, to create the
runtime role above.

### REDIS_URL

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `REDIS_URL` | yes | — | `redis://redis:6379` |

Redis, used for queues, sessions, rate limits and settings invalidation.

### S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `S3_ENDPOINT` | yes | — | `http://minio:9000` |
| `S3_REGION` | yes | — | `us-east-1` |
| `S3_BUCKET` | yes | — | `helpdock` |
| `S3_ACCESS_KEY_ID` | yes | — | — |
| `S3_SECRET_ACCESS_KEY` | yes | — | — |

S3-compatible object storage for attachments and article images. The bucket is
the only copy of them, so it is part of the backup set. It must be **private**:
every object is served through a presigned URL that lives five minutes and is
issued only after the caller has been authorised on the parent ticket
(docs/guides/attachments.md, DOMAIN-RULES §4.5).

### S3_FORCE_PATH_STYLE

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `S3_FORCE_PATH_STYLE` | no | `false` | `false` |

Optional. `true` addresses the bucket as a path (endpoint/bucket/key) instead
of as a subdomain (bucket.endpoint/key). MinIO and most other S3-compatible
servers need it; Amazon S3 does not. Defaults to false, and the dev stack
below sets it to true because it runs MinIO.

### FFMPEG_PATH, FFPROBE_PATH

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `FFMPEG_PATH` | no | `ffmpeg` | `ffmpeg` |
| `FFPROBE_PATH` | no | `ffprobe` | `ffprobe` |

Optional. Where the media worker finds ffmpeg and ffprobe, which it spawns to
normalise voice notes to Opus and to take a video's poster frame. Bare names
are resolved on PATH, which is what the Docker image installs them as; set a
full path when you run the worker outside the image. Without them, image and
file attachments still work and audio and video are rejected with
`processing_failed` (docs/guides/attachments.md).

### CLAMAV_HOST, CLAMAV_PORT

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `CLAMAV_HOST` | no | — | — |
| `CLAMAV_PORT` | no | `3310` | `3310` |

Optional. Host and port of a clamd daemon. Set CLAMAV_HOST and every uploaded
*file* is scanned before it can be downloaded; an infected one is deleted from
the bucket and its row is marked `infected`. Leave it unset and scanning is
skipped, which is the default (ARCHITECTURE §17). The Compose stack ships a
`clamav` profile: `docker compose --profile clamav up -d`.

### ADMIN_DIST_DIR

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `ADMIN_DIST_DIR` | no | `/app/admin` | `/app/admin` |

Optional. Directory the api serves the built admin SPA from (ARCHITECTURE §3).
The image puts it at /app/admin, which is the default; set it only when you
run the api outside the image and want it to serve a local `apps/admin/dist`.

### WIDGET_DIST_DIR

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `WIDGET_DIST_DIR` | no | — | `/app/widget` |

Optional. Directory the api serves the chat widget from: `/widget.js`, its
lazy `/chunks/` and `/widget-fonts/` (M4-01). The image puts it at
/app/widget, which is the default; set it only when you run the api outside
the image and want it to serve a local `apps/widget/dist`.

### OUTBOUND_ALLOW_CIDRS

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `OUTBOUND_ALLOW_CIDRS` | no | — | — |

Optional. Comma-separated CIDRs the SSRF-safe outbound client may reach even
though they are private, for a self-hosted proxy or connector (DOMAIN-RULES §13).
Outbound webhooks (M8-03) honour it too: an endpoint on an internal address is
delivered to only when its range is listed here.
Example: 10.0.0.0/8,192.168.0.0/16

### HELPCENTER_CNAME_TARGET

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `HELPCENTER_CNAME_TARGET` | no | — | — |

Optional. The hostname a brand's help center domain points at with a CNAME
record (M5-07). Brand › Domains shows it as the record to create, and the
domain check accepts a name whose CNAME is this host or which resolves to the
same addresses. Defaults to the host of APP_URL; set it when that host is not
the one you want customers' DNS to depend on, for example edge.example.com.
docs/guides/install.md#custom-domains has the rest.

### TELEGRAM_POLLING

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `TELEGRAM_POLLING` | no | — | `false` |

Optional. `true` makes the worker long-poll every Telegram bot every few
seconds instead of receiving updates by webhook, for development on a machine
Telegram cannot reach. Leave it `false` in production and press "Set webhook"
on each bot instead; a bot with a webhook set refuses polling
(docs/guides/telegram.md). Defaults to false.

### TELEGRAM_API_ROOT

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `TELEGRAM_API_ROOT` | no | — | `https://api.telegram.org` |

Optional. The Telegram Bot API server. Defaults to https://api.telegram.org;
set it only when you run your own Bot API server.

### KNOWLEDGE_CRAWL_RENDER

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `KNOWLEDGE_CRAWL_RENDER` | no | — | `false` |

Optional. `true` lets a knowledge website crawl tick "Render JavaScript" and
read pages in a headless Chromium, for sites that build their pages in the
browser. The worker needs Chromium installed (`npx playwright install
chromium`); the browser's every request still goes through the SSRF-safe
client (docs/guides/ai.md#website-crawl). Defaults to false.

### AUTH_SESSION_IDLE_MINUTES, AUTH_SESSION_MAX_HOURS

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `AUTH_SESSION_IDLE_MINUTES` | no | — | `240` |
| `AUTH_SESSION_MAX_HOURS` | no | — | `12` |

Optional. How long a staff sign-in lasts (docs/guides/authentication.md#the-session).
A browser that has not used its session for AUTH_SESSION_IDLE_MINUTES must
sign in again, and so must every browser AUTH_SESSION_MAX_HOURS after it
signed in, however busy it was. Defaults to 240 minutes and 12 hours, which is
what OWASP ASVS Level 2 asks for; the longest either may be is 30 days.

### OUTBOX_CONCURRENCY

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `OUTBOX_CONCURRENCY` | no | — | `8` |

Optional. How many outbox events one worker process runs at once (socket
frames, SLA clocks, rules, notifications, email). Events that name the same
ticket still run one at a time and in order; this only lets different tickets
overlap (docs/guides/operations.md#scaling-the-worker). Each running event
holds a database connection. Defaults to 8.

## Compose keys

Read by `docker/docker-compose.yml` only; `packages/config` does not know them. **Required** means Compose refuses to start without the key; the default is the one the Compose file falls back to.

### ADMIN_HOST, API_HOST

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `ADMIN_HOST` | yes | — | `admin.example.com` |
| `API_HOST` | yes | — | `api.example.com` |

Hostname the admin SPA and the REST API answer on. Caddy gets a certificate
for each of them and sends both to the api container.

### ACME_EMAIL

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `ACME_EMAIL` | no | — | — |

Address Let's Encrypt sends expiry warnings to. It may stay blank, and Caddy
then registers without contact details — the Caddyfile quotes the placeholder
so an empty value is an empty argument rather than a missing one.

### CADDYFILE

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `CADDYFILE` | no | `./caddy/Caddyfile` | `./caddy/Caddyfile` |

Caddy configuration the caddy container mounts. Behind Cloudflare's proxy,
point it at ./caddy/Caddyfile.cloudflare: Cloudflare terminates TLS, so
on-demand certificates for brand help-center domains must be off.

### POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `POSTGRES_USER` | no | `helpdock_owner` | `helpdock_owner` |
| `POSTGRES_PASSWORD` | yes | — | — |
| `POSTGRES_DB` | no | `helpdock` | `helpdock` |

Postgres superuser the container creates on first boot. It is the migration
owner, so DATABASE_MIGRATION_URL above has to carry the same credentials.

### HELPDOCK_APP_PASSWORD

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `HELPDOCK_APP_PASSWORD` | yes | — | — |

Password for the `helpdock_app` runtime role. `docker/postgres/init.sql`
creates that role with this password on first boot, and the first migration
creates it with the password in DATABASE_URL if it does not exist yet. The two
must be the same string, or the api cannot connect.

### HELPDOCK_VERSION

| Key | Required | Default | In `.env.example` |
|---|---|---|---|
| `HELPDOCK_VERSION` | no | `latest` | `latest` |

Image tag the stack runs. Pin it to a release before an upgrade
(DOMAIN-RULES §10); `latest` is convenient and not reproducible.

## Settings you can pin with `HD_*`

Every setting in the registry (`packages/config/src/registry.ts`). **Scope** `brand` means a brand can override the install's value in admin. A **secret** is encrypted under `APP_MASTER_KEY` when stored, never logged and never sent to a browser; pinned in `.env`, it is not stored at all. JSON-valued settings (`HD_AI_PROVIDERS`) take JSON.

| Variable | Setting | Scope | Secret | Default | What it is |
|---|---|---|---|---|---|
| `HD_SMTP_HOST` | `smtp.host` | brand | no | — | SMTP server used to send mail. Empty until the first-run wizard sets it. |
| `HD_SMTP_PORT` | `smtp.port` | brand | no | `587` | SMTP port. 587 for STARTTLS, 465 for implicit TLS. |
| `HD_SMTP_TLS` | `smtp.tls` | brand | no | `starttls` | How the SMTP connection is protected: starttls upgrades an open connection (587), tls is implicit TLS (465), none is an unencrypted relay. |
| `HD_SMTP_USER` | `smtp.user` | brand | no | — | SMTP username. Empty for a relay that does not authenticate. |
| `HD_SMTP_PASSWORD` | `smtp.password` | brand | yes | — | SMTP password. |
| `HD_SMTP_FROM` | `smtp.from` | brand | no | — | Envelope and header From address. The display name is smtp.fromName. |
| `HD_SMTP_FROM_NAME` | `smtp.fromName` | brand | no | — | Display name shown beside the From address, for example the brand name. |
| `HD_OAUTH_GOOGLE_CLIENT_ID` | `oauth.google.clientId` | install | no | — | Google OAuth client id for staff sign-in. Empty disables the button. |
| `HD_OAUTH_GOOGLE_CLIENT_SECRET` | `oauth.google.clientSecret` | install | yes | — | Google OAuth client secret. |
| `HD_OAUTH_GITHUB_CLIENT_ID` | `oauth.github.clientId` | install | no | — | GitHub OAuth client id for staff sign-in. Empty disables the button. |
| `HD_OAUTH_GITHUB_CLIENT_SECRET` | `oauth.github.clientSecret` | install | yes | — | GitHub OAuth client secret. |
| `HD_AUTH_REQUIRE2FA` | `auth.require2fa` | install | no | `false` | Require TOTP for every staff account on this install. |
| `HD_AUTH_JWT_SIGNING_KEY` | `auth.jwtSigningKey` | install | yes | — | ES256 key pair the api signs access tokens with, as JSON. Generated at first boot and shared by every replica; never set by hand. Rotating it signs every session out (ARCHITECTURE §7). |
| `HD_AUTH_MAGIC_LINK_TTL_MINUTES` | `auth.magicLinkTtlMinutes` | install | no | `10` | Lifetime of a single-use magic link, in minutes (DOMAIN-RULES §4.6). |
| `HD_ROLES_VIEWER_ENABLED` | `roles.viewerEnabled` | install | no | `true` | Whether the optional read-only Viewer role can be assigned (REQUIREMENTS §2). |
| `HD_CONTACTS_DEFAULT_CALLING_CODE` | `contacts.defaultCallingCode` | brand | no | — | Country calling code prefixed to phone numbers typed without one, for example 49. Empty refuses them instead (ADR 0008). |
| `HD_CAPTCHA_PROVIDER` | `captcha.provider` | brand | no | `none` | CAPTCHA for visitor-facing forms. Off by default; Turnstile is the recommended provider (ADR 0003). |
| `HD_CAPTCHA_SITE_KEY` | `captcha.siteKey` | brand | no | — | Public CAPTCHA site key, rendered by the widget and the web form. |
| `HD_CAPTCHA_SECRET` | `captcha.secret` | brand | yes | — | CAPTCHA secret used server-side to verify a challenge token. |
| `HD_PUSH_VAPID_PUBLIC_KEY` | `push.vapidPublicKey` | install | no | — | VAPID public key served to the admin app as applicationServerKey (ADR 0002). |
| `HD_PUSH_VAPID_PRIVATE_KEY` | `push.vapidPrivateKey` | install | yes | — | VAPID private key used to sign web push messages. |
| `HD_EMBEDDING_PROVIDER` | `embedding.provider` | install | no | — | Embedding provider for knowledge retrieval. One per install (ADR 0005). |
| `HD_EMBEDDING_MODEL` | `embedding.model` | install | no | — | Embedding model. Changing it re-embeds every chunk (ADR 0005). |
| `HD_EMBEDDING_DIMS` | `embedding.dims` | install | no | `0` | Dimension of the embedding column, derived from the model when it is first saved. |
| `HD_EMBEDDING_BASE_URL` | `embedding.baseUrl` | install | no | — | OpenAI-compatible embeddings endpoint, for example https://api.openai.com/v1 or http://ollama:11434/v1. |
| `HD_EMBEDDING_API_KEY` | `embedding.apiKey` | install | yes | — | API key for the embeddings endpoint. Empty for a local server that asks for none. |
| `HD_EMBEDDING_PRICE_PER_MILLION_TOKENS` | `embedding.pricePerMillionTokens` | install | no | `0` | US dollars per million input tokens of the embedding model, for the AI cost log. 0 for a local model. |
| `HD_AI_PROVIDERS` | `ai.providers` | install | yes | `[]` | Model providers and their credentials (API key or OAuth tokens), as a JSON array. Never returned to the client (ADR 0018). |
| `HD_AI_DEFAULT_PROVIDER` | `ai.defaultProvider` | install | no | — | Id of the provider every brand uses unless it overrides it. |
| `HD_AI_DEFAULT_MODEL` | `ai.defaultModel` | install | no | — | Model id, of the default provider, every brand uses unless it overrides it. |
| `HD_KNOWLEDGE_NOTION_CLIENT_ID` | `knowledge.notion.clientId` | install | no | — | OAuth client id of the install’s public Notion integration, for brands connecting Notion (M7-03). |
| `HD_KNOWLEDGE_NOTION_CLIENT_SECRET` | `knowledge.notion.clientSecret` | install | yes | — | OAuth client secret of the Notion integration. |
| `HD_KNOWLEDGE_GOOGLE_CLIENT_ID` | `knowledge.google.clientId` | install | no | — | OAuth client id of the install’s Google Cloud app, for brands connecting Google Drive (M7-03). |
| `HD_KNOWLEDGE_GOOGLE_CLIENT_SECRET` | `knowledge.google.clientSecret` | install | yes | — | OAuth client secret of the Google Cloud app. |
| `HD_TRANSCRIPTION_ENDPOINT` | `transcription.endpoint` | install | no | — | Whisper-compatible transcription endpoint for voice notes, for example https://api.openai.com/v1/audio/transcriptions. Empty turns transcription off. |
| `HD_TRANSCRIPTION_MODEL` | `transcription.model` | install | no | `whisper-1` | Model the transcription endpoint is asked for. |
| `HD_TRANSCRIPTION_API_KEY` | `transcription.apiKey` | install | yes | — | API key for the transcription endpoint. Empty for a local server that asks for none. |

## Tracing

Tracing uses the standard OpenTelemetry variables rather than Helpdock ones
(`apps/api/src/observability/tracing.ts`):

| Variable | What it does |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | A collector's base URL, for example `http://otel-collector:4318`. Set, the api and the worker export spans over OTLP/HTTP; unset, nothing is traced. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | A traces-only endpoint, which wins over the one above. |
| `OTEL_SERVICE_NAME` | Overrides the default `helpdock-api` / `helpdock-worker`. |

[Operations › Tracing](operations.md#tracing) has the rest.

## Development only

`HD_DEV_PRINCIPAL_HEADER=1`, with `NODE_ENV` other than `production`, makes the
api read a whole principal from the `x-hd-dev-principal` request header instead
of verifying a session (`apps/api/src/auth/principal-resolver.ts`). Anyone who
can reach the port can then name themselves an install admin. The api refuses
it under `NODE_ENV=production`. Never set it on an install.
