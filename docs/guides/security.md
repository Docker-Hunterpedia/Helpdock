# Security

How Helpdock protects an install, and what an operator still has to do. The
requirements are [REQUIREMENTS §5.1](../planning/REQUIREMENTS.md#51-security-non-negotiable);
the evidence, requirement by requirement, is the OWASP ASVS Level 2
walk-through in [`docs/completed/asvs-l2.md`](../completed/asvs-l2.md).

**Report a vulnerability privately**, as [SECURITY.md](../../SECURITY.md)
describes: GitHub's private vulnerability reporting, never a public issue.

## Threat model in brief

| Who | Wants | Stopped by |
|---|---|---|
| A visitor on a brand's site | Another visitor's conversation, or to flood the desk | A per-visitor secret only the api issues and only its hash stored, the origin allow-list, per-visitor limits on every write and every socket event, per-address limits, optional CAPTCHA ([widget protocol](widget-protocol.md)) |
| A staff member of brand A | Brand B's data, or a department they are not in | Row-level security on every tenant table, below |
| Someone on the internet | A staff account | Argon2id with a pepper, the breached-password list, a mandatory second factor for Admins, sign-in rate limits ([authentication](authentication.md)) |
| Someone with a stolen database dump | Credentials stored in it | Secrets encrypted under a key that is not in the database; password hashes they cannot test without it |
| A brand Admin configuring a URL | The install's internal network | The SSRF-safe client, below |
| A customer sending a file | Code run in an agent's browser, or malware passed on | Magic-byte sniffing, re-encoding, a private bucket, optional ClamAV, below |
| Whoever reaches a new install first | The install administrator's account | `HD_SETUP_TOKEN` ([install](install.md#the-setup-key)) |

Out of scope, as SECURITY.md says: services you connect (LLM providers, SMTP,
Telegram), denial of service by resource exhaustion, and a compromised host or
install admin account.

## Tenancy and row-level security

Brand isolation is enforced by Postgres, not only by the api
([DOMAIN-RULES §1](../planning/DOMAIN-RULES.md#1-authorization)):

- Every tenant table has a `brand_id` and a `FORCE`d row-level security policy;
  ticket-scoped tables also check the department. The list is `TENANT_TABLES`
  in `packages/db/src/rls.ts`, and `rls.integration.test.ts` proves brand A
  cannot read or write brand B in every one of them.
- Every request runs in a transaction that sets `app.brand_ids`,
  `app.department_ids` and the principal (`withTenant`,
  `packages/db/src/tenant.ts`). Without them a policy sees nothing: the failure
  is "no rows", never "every row".
- The api connects as `helpdock_app`, which owns no table and cannot bypass
  row-level security; it refuses to start on a connection that could
  (`assertRuntimeRoleIsSafe`, `packages/db/src/roles.ts`). Only migrations use
  the owner role.
- Every route declares its permission (`@Requires`), and CI fails on one that
  does not (`pnpm check:routes`). Inputs and outputs go through Zod schemas
  (`pnpm check:validation`), so internal fields never reach a response.

## Secrets and the master key

- Stored secrets (SMTP, IMAP and inbound-parse credentials, Telegram tokens,
  the Meta app secrets, the Meta webhook verify token and each Meta account's
  access token, webhook and widget signing secrets, CAPTCHA secrets, knowledge connector
  credentials, AI provider keys, staff authenticator secrets, the token signing
  key) are encrypted with AES-256-GCM under `APP_MASTER_KEY`
  (`packages/config/src/crypto.ts`). Each value names the key that wrote it,
  and the version and key id are authenticated with it.
- A secret is never returned to a browser after it is saved, and never logged:
  pino redacts `password`, `token` and `secret` fields and the `Authorization`
  and `Cookie` headers ([operations](operations.md#what-a-line-never-carries)).
- Password hashes are Argon2id with a pepper derived from the same key, so a
  dump without `.env` cannot be used to test guesses.
- Keep `.env` out of the database backup's storage, and rotate the key when it
  may have leaked ([operations › Rotating the master key](operations.md#rotating-the-master-key)).

## Outbound requests

Anything that fetches a URL a user supplied (webhook deliveries, the website
crawler, remote images in email, the Notion and Google Drive connectors, an
IMAP host) goes through the SSRF-safe client in `packages/net`
([DOMAIN-RULES §13](../planning/DOMAIN-RULES.md#13-outbound-network-safety)):
`http` and `https` only, the name resolved first and the connection made to the
resolved address, every redirect hop checked again, loopback, private,
link-local, CGNAT, multicast and cloud metadata ranges refused, and timeouts and
size caps on every response. `OUTBOUND_ALLOW_CIDRS` is the one way to let it
reach an internal range, and only the ranges it names
([configuration](configuration.md#outbound_allow_cidrs)). One call is not made through it: chat completions go through the model vendors' own clients, so a provider's base URL, like the embeddings and transcription URLs, is checked when an admin saves it (https, no private or metadata address unless allowed; [AI guide](ai.md#providers)). A Semgrep rule fails
CI on a `fetch` of a non-constant URL outside `packages/net`
([security scanning](security-scanning.md#semgrep)).

Meta's Graph calls, and the download of a customer's file from Meta, go through
the same client with a host allow-list: `graph.facebook.com` and
`graph.instagram.com` (or the hosts `META_GRAPH_API_ROOT` and
`META_INSTAGRAM_API_ROOT` name), `lookaside.fbsbx.com`, and `*.fbcdn.net`. Any
other host is refused, no redirect is followed, and an access token is sent only
to Meta's API hosts and to `lookaside.fbsbx.com`, never to a CDN host
([Meta channels](meta-channels.md#how-metas-posts-are-checked),
[ADR 0025](../decisions/0025-meta-channels-through-one-graph-adapter.md), 2).

## Meta's webhook

Meta posts to one public route, `/api/meta/webhook`, which has no session. Two
checks stand in for one:

- The **handshake** (`GET`) answers only when `hub.verify_token` equals the
  install's verify token, compared in constant time.
- Every **delivery** (`POST`) carries `X-Hub-Signature-256`, the HMAC-SHA256 of
  the raw bytes Meta sent under the app secret or, when it is set, the Instagram
  app secret. Both secrets are tried, in constant time, over the bytes as they
  arrive and before the body is parsed; the Instagram secret vouches for an
  Instagram batch only. A missing, malformed or wrong signature, and an install
  with no app secret, get `401`, and nothing in the body is filed or parsed.

The route answers at most 3,000 requests a minute from one address and accepts
a body up to 3 MiB. A signed body that is not a Meta envelope is `400`. The
webhook itself never calls Meta. A Messenger or Instagram file names a CDN URL
in the body, and a job fetches it later, through the client above: a URL on any
host outside the allow-list is refused, whatever the body says.

## Uploads

[Attachments](attachments.md) has the detail. In short:

- The type a client claims is checked against the object's magic bytes in the
  worker ([ADR 0009](../decisions/0009-magic-byte-sniffing.md)), and every kind
  has a size cap.
- Images are re-encoded to WebP with sharp, and voice notes to Opus, which
  strips metadata and disarms polyglots. Only what the install encoded is served
  inline; everything else is a download.
- The bucket is private. Each object is served through a presigned URL that
  lives five minutes and is issued only after the caller has been authorised on
  the parent ticket.
- With `CLAMAV_HOST` set, files are scanned, and a scanner that does not answer
  rejects the file rather than passing it.

## Authentication and sessions

[Authentication](authentication.md) has the detail. What the M9 ASVS work
added or confirmed ([asvs-l2](../completed/asvs-l2.md#gaps-and-partials-closed-before-10)):

- **Passwords** are checked against a bundled list of breached passwords
  wherever one is set ([ADR 0021](../decisions/0021-bundled-breached-password-list.md)).
- **A second factor** is required for every Admin and install admin, whatever
  `auth.require2fa` says, and a TOTP code is refused if it is replayed.
- **Sessions** end after `AUTH_SESSION_IDLE_MINUTES` without use (240) and
  `AUTH_SESSION_MAX_HOURS` after sign-in (12). Over https the refresh and
  trusted-browser cookies carry the `__Secure-` prefix.
- **Credential changes** (password, second factor, recovery codes) send the
  account an email.
- **Sign-in failures and successes** are written to the install's audit log
  ([ADR 0022](../decisions/0022-auth-audit-trail-in-install-scope.md)), and
  every rate-limit refusal is counted in `rate_limit_refusals_total`, which the
  [first alert set](operations.md#a-first-alert-set) watches.

## API keys

[API keys](api.md#api-keys) are the one credential that is not a person's, and
they are held tighter than a session:

- A key is stored as its SHA-256, scoped to one brand and to the scopes it was
  issued with, throttled per key, and revoked at once. It may be given an
  `expiresAt` when it is made; past it, it is refused like a revoked key.
- A key reaches `/api/v1` and nothing else. Every route that acts for a person
  (`@Authenticated()`, such as `/api/me`) answers it `403`
  ([ADR 0019](../decisions/0019-api-scopes-and-openapi-from-zod.md)).
- `webhooks:manage` cannot be used to read data the key could not read itself: an
  endpoint's events need the matching `tickets:read`, `contacts:read` or
  `articles:read` ([webhooks](webhooks.md)).
- A refused key is a warning in the api's log with its prefix and the caller's
  address, and a revoked or expired one is an `api_key.refused` row in its
  brand's [audit log](audit-log.md#api-keys). The key itself is never logged.

## Headers

The api's JSON responses carry a deny-everything Content-Security-Policy,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and HSTS
when `APP_URL` is https (`apps/api/src/http/security-headers.ts`). Every JSON
answer, errors included, also carries `Content-Disposition: attachment;
filename="api.json"` (a browser that navigates to an API URL downloads it
instead of rendering it) and `Cache-Control: no-store`, so no cache keeps a
brand's tickets, contacts or settings (`apps/api/src/http/json-disposition.ts`,
ASVS 8.2.1). A route that caches its JSON on purpose sets its own
`Cache-Control` and keeps it: the widget's `config` (`no-cache` with an ETag).
Pages, scripts and fonts are not JSON and keep the caching they set. The admin,
the help center, the web form and the widget each send the policy their own
content needs. The admin hashes its bootstrap script and gives Emotion a fresh
style nonce on every response; it does not permit inline script or un-nonced
style. A `Permissions-Policy` denies camera, display capture, geolocation,
payment and USB, while allowing same-origin microphone access for voice
replies.

## What the operator does

- Set `HD_SETUP_TOKEN`, or keep the host closed, until the first-run wizard is
  finished ([install](install.md#the-setup-key)).
- Keep the bucket private, with credentials for that bucket only
  ([install](install.md#install)).
- Back up `.env` somewhere other than the server
  ([operations](operations.md#backups)).
- Keep `/internal/*` and `/metrics` away from the internet. The shipped
  Caddyfile answers 404 for `/internal/*`, and the api refuses `/metrics` to
  a request that came through a proxy without `METRICS_TOKEN`
  ([operations](operations.md#metrics-is-never-routed-publicly)); a proxy of
  your own should do the same.
- Keep `TRUST_PROXY` to the proxies you run. Every per-address limit and the
  audit log use the address the api resolves under it. The Compose file sets
  `uniquelocal`, and the Cloudflare Caddyfile forwards the visitor's address
  from Cloudflare's ranges only; `true` believes every hop, so a client could
  choose its own address ([install](install.md#behind-a-proxy-of-your-own)).
- Keep Postgres and Redis on the Compose network. The production Compose file
  publishes neither; Redis has no password there, so it must stay unreachable
  from anywhere else.
- Give API keys an `expiresAt` when you create them, and revoke the ones an
  integration no longer uses ([API keys](api.md#api-keys)).
- Pin the image to a release and upgrade when a security release is published
  ([operations › Upgrading](operations.md#upgrading)). Each release has a
  CycloneDX SBOM attached ([security scanning](security-scanning.md#sbom)).

## Staff SAML boundary (M11-03)

Signed assertions are mandatory even when the enclosing response is signed.
Identity is read from the library's authenticated assertion XML; issuer,
audience, bearer recipient, request correlation and validity are checked before
completion. DTDs/entities, duplicate attributes, wrapping, weak signatures and
legacy encryption are refused. Atomic Redis assertion/request replay claims
cover concurrent replicas. A local GET handoff binds the validated assertion to
a host-bound Lax nonce cookie before any session is created. Optional
IdP-initiated login requires a fresh SP round trip for the same subject.

Metadata URLs use the shared SSRF-safe, socket-pinned client with redirects
refused. A daily refresh never replaces every currently trusted certificate
without admin confirmation. See [SSO setup and rotation](sso.md#saml-protocol-m11-03).
