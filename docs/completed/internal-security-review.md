# Internal security review (M9-01)

Status: internal pre-pentest review of 2026-10-09 against `3579972`. This is
not the external pentest, which is still to be commissioned (#153). It was a
read-only review of the code: nothing was attacked live.

Deliverable: M9-01 ([PRD §4 · M9](../planning/PRD.md#m9-hardening-and-10)).
Paths are relative to the repository root; `api` is `apps/api/src`. Line
numbers refer to `3579972`.

## Method

Each candidate was traced from its input to its impact through routes, guards,
schemas, services and SQL. Candidates that could not be confirmed in code were
dropped. Severity follows the M9-01 brief: High is cross-tenant access, auth
bypass, RCE or SSRF, and stored XSS on staff; Medium is IDOR, an abusable
endpoint with no rate limit, or weak crypto in practice.

## Findings

| Id | Severity | Title | Where | Status |
|---|---|---|---|---|
| F1 | Medium | Widget socket events bypass every throttle | `api/widget/widget-gate.ts`, `api/widget/widget.gateway.ts` | Fixed in `606405f` |
| F2 | Medium | `TRUST_PROXY=true` with the Cloudflare Caddyfile keys every per-address limit on Cloudflare's edge | `docker/docker-compose.yml`, `docker/caddy/Caddyfile.cloudflare`, `api/bootstrap.ts`, `packages/config/src/env.ts` | Fixed in `cfb64b4` |
| F3 | Low | A widget socket keeps its conversation rooms after the signed-identity link is withdrawn | `api/widget/widget.gateway.ts`, `api/widget/widget-session.service.ts` | Fixed for sockets in `82683dc` and for SSE streams after; open for origin removal and secret rotation |
| F4 | Low | OAuth callback not bound to the browser that started it (login CSRF) | `api/auth/oauth/oauth.service.ts`, `api/auth/auth.controller.ts` | Fixed in `10ac844` |
| F5 | Low | API keys and webhook deliveries ignore a brand's deletion grace | `api/api-keys/api-key-principal-resolver.ts`, `api/tenant/all-brands.ts`, `api/webhooks/webhook-deliver.job.ts` | Fixed in `275a3f2` |
| F6 | Low | The magic link is spent by a plain `GET` | `api/auth/auth.controller.ts`, `api/auth/auth.service.ts` | Open: the confirm screen needs an artboard first |
| N1 | Not rated | The `/widget` handshake's address budget is shared by every visitor behind Caddy | `api/widget/widget.gateway.ts` | Open: fix not written |

Count: High 0, Medium 2, Low 4. N1 is not in the review. It was found while
fixing F1, and it is listed so the M9 deliverable carries it.

**Where the fixes are.** The five fix commits and `.changeset/pre-pentest-fixes.md`
are in the pull request that lands this record (#167). Each fix was read in its
commit, and the tests those commits add run in that pull request's CI.

## Findings in detail

**F1, Medium: widget socket events bypass every throttle.** A visitor secret
pays the address throttle once, at the handshake. After that, `WidgetGate.visitor`
skipped the per-address rule for socket events and applied the per-visitor rule
only to writes, so `conversation:join`, `typing:set` and `message:read` each ran
an unthrottled transaction and fanned out to agents. Fixed in `606405f`: every
socket event spends `WIDGET_SOCKET_EVENT_RULE` (120 a minute per visitor, in
Redis) in `WidgetGateway.#ack` before the payload is parsed. Over budget, the
ack is `rate_limited` and the socket stays open. Tests: `api/widget/widget-gate.test.ts`
(new) and `api/widget/widget.integration.test.ts`.

**F2, Medium: proxy trust collapses every per-address limit behind Cloudflare.**
`TRUST_PROXY: 'true'` (`docker/docker-compose.yml`) makes Fastify believe every
hop, and `docker/caddy/Caddyfile.cloudflare` named no trusted proxies, so Caddy
passed on Cloudflare's edge address. Sign-in, widget, web-form, rating and invite
limits were all keyed on that edge. Fixed in `cfb64b4`: `TRUST_PROXY`
(`packages/config/src/env.ts`) takes `true`, `false`, or a list of addresses,
CIDRs and the names `loopback`, `linklocal` and `uniquelocal`. A hop count is
refused, because Fastify's documentation says a numeric `trustProxy` is disabled,
so the review's `TRUST_PROXY=1` would not have worked. Compose sets `uniquelocal`.
The Cloudflare Caddyfile trusts the 22 published Cloudflare ranges and reads
`CF-Connecting-IP` only from them; the ranges match Cloudflare's `ips-v4` and
`ips-v6` lists as fetched on 2026-10-11. `api/bootstrap.ts` passes the list to
Fastify. Operators copy the new Caddyfile (`docs/guides/install.md`, "Behind
Cloudflare"). Not proven live: the Caddy half was run locally, not on a
Cloudflare zone.

**F3, Low: sockets outlived the link that granted their rooms.** Fixed for
sockets in `82683dc`, and for SSE streams after review. A `/widget` socket joins `visitor:<id>` on connect
(`api/widget/widget.gateway.ts`, `api/widget/widget-relay.ts`). When
`WidgetSessionService.session` (`api/widget/widget-session.service.ts`) clears or
changes the verified contact, `WidgetHub.disconnectVisitor` (`api/widget/widget-hub.ts`)
disconnects that visitor's sockets, and the client reconnects and re-joins. It
also publishes an instruction on the widget channel, and each replica's hub ends
the visitor's SSE streams (`api/widget/widget-stream.controller.ts`), which the
client opens again and the gate judges afresh. Still open: removing an origin or
rotating the signing secret (`api/widget/widget-settings.service.ts`) does not
disconnect sockets.

**F4, Low: OAuth callback not bound to its browser.** The state lived only on the
server, so a copied callback URL could finish an attacker's sign-in in a victim's
browser. Fixed in `10ac844`: starting a flow sets a ten-minute `hd_oauth` cookie
(`__Secure-` prefixed over https, `Path=/api/auth/oauth`; `api/auth/session/cookies.ts`).
The state keeps only the hash of the nonce, and `OauthService.complete`
(`api/auth/oauth/oauth.service.ts`) refuses a callback without the matching nonce,
before any token request. `api/auth/auth.controller.ts` clears the cookie on every
callback. A sign-in begun before the upgrade has to be started again.

**F5, Low: a brand in deletion grace kept its API keys and webhooks.** `/api/v1`
routes are not `@Public()`, so `BrandGoneGuard` never ran, and `withAllBrands`
(`api/tenant/all-brands.ts`) includes brands in `deleting`. Fixed in `275a3f2`:
`ApiKeyPrincipalResolver` answers 410 from the shared `BrandAvailability`
cache, after the key's per-minute budget is spent so that a gone brand's key is
throttled like any other (`api/api-keys/api-key-principal-resolver.ts`), and
`webhook-deliver.job.ts` marks the delivery `skipped`. A restore brings the keys
back; skipped deliveries are not replayed.

**F6, Low: the magic link is spent by a `GET`.** `GET /api/auth/magic-link/:token`
(`api/auth/auth.controller.ts:234-250`) spends the token with `GETDEL`
(`api/auth/auth.service.ts:554`) and sets the session cookie. A mail scanner that
fetches the link therefore consumes the sign-in. Open. The fix is an admin page at
`/sign-in/magic` plus `POST /api/auth/magic-link/consume`. Invites already preview
without spending (`api/auth/email-token.store.ts`). AGENTS.md requires an artboard
before a screen is built, so this waits for one.

**N1, not rated: the handshake's address budget is shared behind Caddy.** The
`/widget` handshake spends `widget-ip` (300 per 5 minutes per brand) against
`socket.handshake.address` (`api/widget/widget.gateway.ts:233`). Behind Caddy that
address is Caddy's, and the handshake does not read `request.ip`, so `TRUST_PROXY`
does not reach it. Every visitor of a brand who connects through Caddy shares one
budget, and F2 does not change that. The per-address socket budget considered for
F1 would share the same key, which is why F1 has none. Open: resolve the handshake
address under the same `TRUST_PROXY` rule HTTP uses, with a test through the proxy.

## Checked and sound

Traced by the reviewer on 2026-10-09 as evidence for the ASVS walk-through. Every
path listed exists at `3579972`.

- **Tenancy.** Tenant transactions set `app.*` through bound parameters. Install
  scope needs the install sentinel alone and is audited (`packages/db/src/tenant.ts`,
  `api/tenant/install-scope.ts`, `api/tenant/tenant.interceptor.ts`). Every table is
  classified, and policies are `ENABLE`, `FORCE` and fail to no rows (`packages/db/src/rls.ts`).
- **Authorisation.** `PermissionGuard` refuses undeclared routes and socket events.
  API keys pass only for their own brand and scopes (`api/auth/permission.guard.ts`,
  `api/auth/permissions.ts`, `api/auth/target-brand.ts`).
- **Widget identity.** Origin is compared as a normalised string, and a missing or
  `null` origin is refused (`api/widget/origin.ts`). The gate runs throttle, brand,
  origin, then visitor by hash (`api/widget/widget-gate.ts`). Secrets are 256-bit,
  shown once and never stored (`api/widget/visitor-credential.ts`). Signed identity
  is HMAC-SHA256 with a ±300 s window (`api/widget/widget-session.service.ts`).
  Conversation access is the visitor's own or the verified contact's
  (`api/widget/conversation-access.ts`).
- **Widget writes.** Sends are idempotent by `clientId` under the ticket lock, and
  CAPTCHA runs before any write and fails closed (`api/widget/widget-conversations.service.ts`).
  Uploads link only on the visitor's own ticket (`api/widget/widget-uploads.service.ts`).
  Response DTOs carry no notes, author ids or object keys (`api/widget/widget-view.ts`).
- **Staff realtime.** The handshake uses the HTTP session resolver and checks `Origin`
  (`api/realtime/handshake.ts`, `api/realtime/staff.gateway.ts`). Rooms are checked
  under the principal's RLS scope (`api/realtime/rooms.ts`, `api/realtime/room-reader.ts`).
  Revocation is per browser family (`api/realtime/revocation.subscriber.ts`).
- **Public API.** Keys are 256-bit and stored as SHA-256 (`api/api-keys/api-key-credential.ts`).
  Idempotency is per key (`api/api-v1/idempotency.interceptor.ts`).
- **Outbound HTTP.** `safeFetch` checks every resolved address, pins the socket and
  re-validates redirects (`packages/net/src/safe-fetch.ts`, `packages/net/src/destination.ts`).
  Blocked ranges and strict IP parsing (`packages/net/src/blocked-ranges.ts`,
  `packages/net/src/ip-address.ts`). Webhook destinations are re-checked and
  signed (`api/webhooks/webhook-destination.ts`, `api/webhooks/webhook-signature.ts`).
- **Help center.** Staff audience comes from a brand-bound JWS cookie with a live
  Redis family (`api/help-center/site/staff-access.ts`). Visibility is filtered in
  SQL before ranking (`api/help-center/visibility.ts`). Article HTML is allow-listed
  on save (`packages/channels/src/html/sanitize-article.ts`). Pages carry a
  per-response nonce CSP (`api/help-center/site/site.ts`).
- **Email, web form, CSAT.** Inbound mail threads only on a known `Message-ID` from a
  participant (`api/channels/inbound/conversation-router.ts`). Message HTML is
  allow-listed (`packages/channels/src/html/sanitize.ts`). The web form checks honeypot,
  limits and CAPTCHA before any write (`api/web-form/web-form-public.service.ts`).
  CSAT tokens are HMAC-derived and single-use (`api/csat/tokens.ts`).
- **Uploads.** Object keys come from UUIDs (`api/media/keys.ts`). Magic bytes are
  sniffed and images re-encoded (`api/media/magic-bytes.ts`, `api/media/process.job.ts`).
  Downloads are five-minute presigned URLs (`api/media/storage.ts`).
- **Authentication.** Sign-in windows are consumed before the password is judged
  (`api/auth/auth.service.ts`, `api/auth/rate-limit.ts`). Access tokens are ES256 with
  Redis revocation that fails closed (`api/auth/session/access-token.ts`). Refresh
  rotation has reuse detection (`api/auth/session/refresh-store.ts`). Email tokens are
  256-bit and `GETDEL`-spent (`api/auth/email-token.store.ts`). Setup needs a
  constant-time token (`api/install/setup-key.ts`).
- **AI.** PII redaction runs inside `complete()` (`packages/ai/src/complete.ts`).
  Auto-reply forbids outside knowledge and hands off on citations outside the
  retrieved set (`packages/ai/src/auto-reply/decide.ts`). The budget is checked before
  each call (`api/ai/budget-meter.ts`).
- **Headers, errors, static.** JSON answers carry a deny-all CSP and `nosniff`
  (`api/http/security-headers.ts`). `/metrics` decides on the socket peer
  (`api/observability/metrics.guard.ts`). Static paths refuse `..`, NUL and symlinks
  out of the root (`api/static/admin-assets.ts`).
- **Secrets and Telegram.** Stored secrets are encrypted and returned once
  (`api/widget/widget-settings.service.ts`, `api/webhooks/webhooks.service.ts`). The
  Telegram secret token is compared in constant time (`api/telegram/telegram-webhook.service.ts`).

## Informational, no action for M9-01

- The help-center media route (`api/help-center/media.service.ts`) is public by
  design. It answers a five-minute URL for any ready image, including images in
  internal-only articles, guarded only by the UUIDv7 id.
- `/api/v1` keys with `tickets:read` receive internal notes, as `docs/guides/api.md`
  says. Webhooks never carry notes (`api/webhooks/webhook-payload.ts`).
- `POST /api/auth/exchange` has no rate limit. Its code is 256 bits and lives 60 seconds.

## Still to attack live (for the vendor)

1. **Proxy trust end to end (F2).** Send `X-Forwarded-For` and `Forwarded` through the
   real Caddy, plain and Cloudflare. Confirm `request.ip`, `audit_log.request_ip`
   and the limiter keys.
2. **Socket behaviour across replicas.** The F3 disconnect on two api replicas, the
   F1 budget under load, and a connection flood per address on `/widget` and `/staff`.
3. **Socket.IO engine limits.** Connection floods, `maxHttpBufferSize`, ping
   starvation. The engine defaults were not reviewed.
4. **Object storage.** Signed `Content-Length` and `Content-Type` enforced on presigned
   PUTs, bucket listing and anonymous GET denied, `Response-Content-Disposition` honoured.
5. **Browser-side rendering.** The DOMPurify configuration in the admin and the widget,
   `javascript:` in `cite`, CSS through allowed attributes such as `width`, and
   help-center pages with every allowed element.
6. **Prompt injection.** The ingestion filter is heuristic. Try pages, PDFs and tickets
   that steer auto-reply or assist output, and measure what the quality gate catches.
7. **Second factor.** Brute force across many challenges and the three code routes
   (`/totp`, `/recovery-code`, `/enrolment/confirm`) from distributed addresses.
   Confirm the lock is per account.
8. **Email threading.** Forged `In-Reply-To` and `References` with a participant's
   `From` while `authFailureIsSpam` is off, and forged `Authentication-Results`.
9. **CAPTCHA and ClamAV** against the real providers, including outage behaviour.
   Both fail closed in code.
10. **Live Postgres role.** `helpdock_app` is `NOBYPASSRLS`, owns nothing, and
    `SET row_security = off` is refused. `assertRuntimeRoleIsSafe` was not exercised.
11. **DNS rebinding** against the crawler's renderer sub-resources and the IMAP and
    SMTP test endpoints.
12. **Redis** on the production Compose network, which has no password by design,
    and the adapter and revocation channels an attacker there could publish to.

**Open for 1.0:** F6 (the magic-link confirm screen, which needs an artboard) and the shared handshake budget (N1).
