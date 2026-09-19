# Authentication

How staff sign in to Helpdock, what a session is made of, and what an operator
has to configure. Specified by [REQUIREMENTS
§5.1](../planning/REQUIREMENTS.md#51-security-non-negotiable), [ARCHITECTURE
§7](../planning/ARCHITECTURE.md#7-auth-design) and [DOMAIN-RULES
§1.4](../planning/DOMAIN-RULES.md#14-workers-and-websockets), §4.6 and §12.
Implemented by M0-05.

Visitors (the widget, M4) and API keys (M8) are different principals with
different credentials and are not covered here. What an account may *do* once it
has signed in is [staff and roles](staff-and-roles.md), which also covers
invitations and a person's own security page.

## The four ways in

| | |
|---|---|
| **Password** | Argon2id with a pepper. Always available. |
| **Sign-in link** | A single-use link by email, valid for `auth.magicLinkTtlMinutes` (10 by default). |
| **Google / GitHub** | OAuth. Shown only when the install has configured that provider. |
| **Password reset** | A single-use link by email, valid for 10 minutes. |

Whichever of them is used, if the account has an authenticator enrolled the
second factor is asked for afterwards. There is no path that skips it, apart
from a browser the person has explicitly chosen to trust.

`GET /api/auth/methods` reports which of them this install offers. The sign-in
screen calls it and draws only the buttons that would work.

## The session

```
access token   JWT, ES256, 10 minutes, in memory in the browser
refresh token  opaque, 256 bits, rotating, 30 days, httpOnly cookie
```

The **access token** carries everything a request needs to be authorised: the
user id, the session id, the refresh family, the role and department scope per
brand, and whether the account is an install admin. Verifying one is a signature
check and a single Redis lookup, so an authorised request never reads the
database to find out who is making it.

It is short-lived because the claims can go stale: a role change does not rewrite
a token that has already been issued. It revokes the refresh family instead, so
the next refresh fails, which caps how stale a token can be at ten minutes — the
window [DOMAIN-RULES §1.6](../planning/DOMAIN-RULES.md#16-required-negative-tests)
allows.

The **refresh token** is opaque and is stored in Redis as a SHA-256 hash, keyed
by the family it belongs to. Every refresh mints a new token and forgets the old
one. If a token that has already been rotated is presented, two parties hold the
same chain and there is no way to tell which is the legitimate one, so the whole
family is revoked and `principal.revoked` is published. That is what makes
rotation worth having.

The **signing keys** are an ES256 key pair generated at first boot and stored,
encrypted, in the `auth.jwtSigningKey` setting, so every replica verifies what
any other replica signed. Clearing that setting and restarting signs everybody
out; that is the whole of key rotation in v1.

### Cookies

| Cookie | What it is | Attributes |
|---|---|---|
| `hd_refresh` | The refresh token and its family | `HttpOnly`, `SameSite=Lax`, `Path=/api/auth`, 30 days, `Secure` when `APP_URL` is https |
| `hd_trust` | A browser the person chose to trust | the same, 30 days |

`SameSite=Lax` means a cross-site POST carries neither, which is what makes
`/api/auth/refresh` safe without a CSRF token of its own. `Path=/api/auth` means
no other route in the application ever receives them. Neither has a `Domain`, so
neither is readable by a sibling subdomain.

`Secure` is set only when `APP_URL` is https: a `Secure` cookie is dropped
silently over plain http, and a local `http://localhost` install would otherwise
be unable to sign in with nothing on screen to say why.

### What the browser holds

The access token lives in a field on the http adapter and nowhere else — not in
`localStorage`, not in `sessionStorage`, not in a cookie a script can read. A
reload starts with no token and calls `POST /api/auth/refresh`, which is what
the `httpOnly` cookie is for. A 401 on any request is retried once, after a
refresh, and only when a token was actually sent.

## Passwords

Argon2id at the current OWASP minimum — 19 MiB of memory, two passes, one lane —
with a **pepper** derived from `APP_MASTER_KEY` with HKDF and handed to argon2
as its secret. The pepper is never stored: without `.env`, a stolen database is
not a set of crackable hashes, because no candidate password can even be tested.

A hash made with weaker parameters, or by an older release, is replaced on the
next successful sign-in — the one moment the plaintext is in hand.

A password must be at least 12 characters. There are no composition rules.

### Nothing confirms who works here

An unknown address and a wrong password answer the same code, `invalid-credentials`,
after the same amount of work: the unknown-address branch still runs argon2,
against a hash nobody knows the password to. The sign-in link and the password
reset answer `204` whoever asks. Without that, the sign-in form is a way to find
out who has an account here.

## Two-factor

TOTP, SHA-1, six digits, a thirty-second step, and a window of one step either
side, which covers the drift between a phone and a server.

The secret is stored encrypted with AES-256-GCM under `APP_MASTER_KEY`. Turning
`auth.require2fa` on makes an authenticator mandatory for every staff account on
the install.

### Enrolling

1. `POST /api/auth/totp/enrol` stages a secret and returns the `otpauth://` URI
   for a QR code. Nothing is enabled yet, so a code that did not save cannot
   lock anybody out.
2. `POST /api/auth/totp/confirm` with a live code enables the second factor and
   returns **ten recovery codes, once**.

The screen that draws the QR code is `/sign-in/enrol`, which an install with
`auth.require2fa` on sends an account without an authenticator to. It stages the
secret, draws it as a QR code and as a key that can be typed, and hands over the
recovery codes behind a checkbox that says they have been saved. The QR is drawn
in the browser as SVG, because the `otpauth://` URI is a credential and asking a
server to draw it would put it in a second place. [Staff and
roles](staff-and-roles.md#two-factor-enrolment) walks through it.

Turning the second factor **off** again, and redrawing the recovery codes, are
on the security page and each cost a live code: a session proves somebody signed
in, not that the person at the keyboard now is the account holder. Neither is
offered while `auth.require2fa` is on.

### Recovery codes

Ten, shaped `RC-4KQ2-9XMT`, in an alphabet with no character that can be
confused with another on paper. Each works once. They are stored as argon2
hashes under the same pepper as a password, because a recovery code *is* a
password.

### Attempts and the lock

A challenge allows **three** attempts in total, whichever field the value was
typed into: an authenticator code and a recovery code share the budget, so a
lock cannot be dodged by switching forms. On the third failure the challenge is
deleted and the account is locked for **15 minutes**.

The lock is reported only after the password has been proved. Saying it earlier
would tell a stranger that the address exists.

### Trusting a browser

"Trust this browser for 30 days" sets `hd_trust`, which is
`<userId>.<nonce>.<mac>` where the MAC is HMAC-SHA256 under a key derived from
`APP_MASTER_KEY`. The nonce's hash is also a Redis key and both have to check
out: without the MAC, anyone who can list Redis keys could mint one; without
Redis, it could not be revoked. "Log out everywhere" forgets every trusted
browser.

## The sign-in link and the password reset

Both are 256 bits of randomness, stored in Redis as a hash with the user id and
the purpose, single use, and short-lived ([DOMAIN-RULES
§4.6](../planning/DOMAIN-RULES.md#46-tokens-sent-to-customers)). The purpose is
part of the record and not only of the key, so a sign-in link cannot be posted
to the password-reset endpoint.

A password reset ends **every** session the account holds, everywhere, and
forgets every browser it trusted. Somebody resets a password because they think
somebody else has it.

### A token in a path never reaches the log

A query string never reaches the request log at all, so the password reset's
token is safe by construction. The sign-in link and the staff invitation put
theirs in a *path*, and the invitation's is served as a page by the admin SPA —
through the catch-all route, which never reaches a handler that knows what the
segment is. So `RequestContextMiddleware` collapses `/invite/<token>` and
`/api/auth/magic-link/<token>` to `:token` before the line is written, where
every request passes, rather than in each handler.

### Sending

SMTP arrives with M2. Until then the development sender writes one line to the
log — the recipient, the subject and the locale, never the body, because a
sign-in link *is* a credential — and the message itself is in the log of the
process that made it. The interface it implements is
[`packages/channels/src/email/sender.ts`](../../packages/channels/src/email/sender.ts),
and M2 puts a real transport behind it without the auth service changing.

The two messages are rendered from the `email` catalogs in `@helpdock/i18n`, in
the recipient's own language, right to left for Arabic.

## OAuth

Written against Google's and GitHub's endpoints directly with `jose` and
`fetch`, not with passport. The strategies that would have carried it —
`passport-github2` and `passport-google-oauth20` — were last published in 2022
and 2023, neither implements PKCE, and both are Express-middleware shaped, which
on Fastify means a shim around the part of the codebase that most needs to be
readable. What they would have replaced is two `fetch` calls to fixed hosts and
one `jwtVerify`.

Three things make the flow safe:

- **State.** 256 bits of randomness, stored server-side under its own hash and
  spent on the callback. A callback whose state this install did not issue is
  refused, and a state issued for one provider cannot complete the other's flow.
- **PKCE.** S256. The verifier never leaves the server. GitHub OAuth Apps ignore
  it; it is sent anyway, and state is the defence there.
- **A fixed redirect.** Built from `APP_URL` and never echoed from the request,
  so there is no open redirect to point at.

Matching is by **verified address only** and no account is created: owning a
Google address is not a reason to be staff here. An unrecognised address answers
`no-account`. People are invited on [the staff
screen](staff-and-roles.md#inviting-somebody).

### Configuring a provider

Set these in admin (or with the matching `HD_*` environment variable). A
provider with no client id is reported as disabled and its button is not drawn.

| Setting | |
|---|---|
| `oauth.google.clientId` / `oauth.google.clientSecret` | From the Google Cloud console, an OAuth 2.0 Client ID of type "Web application". |
| `oauth.github.clientId` / `oauth.github.clientSecret` | From GitHub → Settings → Developer settings → OAuth Apps. |

The redirect URL to register with the provider is
`<APP_URL>/api/auth/oauth/<provider>/callback`, for example:

```
https://support.example.com/api/auth/oauth/google/callback
https://support.example.com/api/auth/oauth/github/callback
```

## How a redirect hands over a session

A sign-in link and an OAuth callback both end as a `302` back to the admin app,
and an access token cannot ride in that URL: it would be in browser history, in
the `Referer` of the next request, and in every proxy log on the way. So the
redirect carries a **one-time code**, valid for 60 seconds, which the app posts
to `POST /api/auth/exchange` to get the token. The refresh cookie is set on the
redirect itself.

If the account has a second factor, the redirect carries a challenge id instead
and the app goes to its code screen.

## Revocation

| Event | What happens |
|---|---|
| Sign out | That family is revoked; other browsers keep working |
| Sign out everywhere | Every family, and every trusted browser |
| Password reset | The same as signing out everywhere |
| Refresh-token reuse | That family, immediately |
| Role or department change | Every family, so the next refresh carries new claims |
| Deactivation, or removal from a brand | Every family, and every trusted browser |
| Password change from the security page | Every family but the one it was done on |

Revoking a family marks every access token it issued in the last ten minutes, so
a token already in a browser stops working on its next request rather than when
it expires. The marker expires with the tokens it is about, so the set of
revoked session ids can never grow without bound.

Every revocation publishes `principal.revoked` on Redis. M0-13 is the subscriber
that disconnects that principal's sockets within five seconds
([DOMAIN-RULES §1.4](../planning/DOMAIN-RULES.md#14-workers-and-websockets)).

## Rate limits

Sliding-window counters in Redis. A fixed window would let an attacker spend the
whole budget at the end of one window and again at the start of the next.

| Bucket | Limit |
|---|---|
| Sign-in, per address | 5 attempts per 15 minutes |
| Sign-in, per IP | 20 attempts per 15 minutes |
| Sign-in link, password reset and staff invitation, per address | 5 per 15 minutes |
| Reading or accepting an invitation, per IP | 30 per 15 minutes |
| Re-proving a credential from inside a session, per account | 5 per 15 minutes |

Over the limit, the answer is `unavailable` — the same answer a lock gives, so
neither confirms that an address exists. A successful sign-in gives that
address its budget back.

The address is hashed before it becomes a key, so Redis holds no list of who has
tried to sign in here.

The last bucket is the one the security page spends. Signing in has a spendable
challenge — three attempts, then a fifteen-minute lock — and the routes that
re-prove a credential from inside a session have none, so the budget is the
lock. It covers `POST /api/me/password`, `POST /api/me/totp/disable` and
`POST /api/me/recovery-codes/regenerate`.

## Settings

Everything below is edited in admin and stored in the `settings` table. Any of
them can be pinned from the environment with its `HD_*` name, which also locks
it in the UI ([ARCHITECTURE §4](../planning/ARCHITECTURE.md#4-configuration-model)).

| Key | Default | |
|---|---|---|
| `auth.require2fa` | `false` | Require an authenticator for every staff account |
| `auth.magicLinkTtlMinutes` | `10` | Lifetime of a sign-in link |
| `roles.viewerEnabled` | `true` | Whether the read-only Viewer role can be assigned ([staff and roles](staff-and-roles.md#the-viewer-toggle)) |
| `auth.jwtSigningKey` | generated | The ES256 key pair. Secret, generated at first boot, never set by hand |
| `oauth.google.clientId` / `…clientSecret` | empty | Empty disables the button |
| `oauth.github.clientId` / `…clientSecret` | empty | Empty disables the button |

No new `.env` key. Auth derives everything it needs from `APP_MASTER_KEY`, which
`.env.example` already documents.

## Endpoints

| Route | Declaration | |
|---|---|---|
| `GET /api/auth/methods` | `@Public()` | Which ways in this install offers |
| `POST /api/auth/sign-in` | `@Public()` | Email and password |
| `POST /api/auth/totp` | `@Public()` | Answer a second-factor challenge |
| `POST /api/auth/recovery-code` | `@Public()` | Answer it with a recovery code |
| `POST /api/auth/magic-link` | `@Public()` | Ask for a sign-in link. Always 204 |
| `GET /api/auth/magic-link/:token` | `@Public()` | Spend one. Redirects |
| `POST /api/auth/exchange` | `@Public()` | One-time code → access token |
| `POST /api/auth/password/forgot` | `@Public()` | Always 204 |
| `POST /api/auth/password/reset` | `@Public()` | Token and a new password |
| `GET /api/auth/oauth/:provider/start` | `@Public()` | Redirects to the provider |
| `GET /api/auth/oauth/:provider/callback` | `@Public()` | Redirects back to the app |
| `POST /api/auth/refresh` | `@Public()` | The cookie is the credential |
| `GET /api/auth/me` | `@Authenticated()` | The session: user, brands, current brand |
| `POST /api/auth/sign-out` | `@Authenticated()` | This browser |
| `POST /api/auth/sign-out-everywhere` | `@Authenticated()` | Every browser |
| `POST /api/auth/totp/enrol` | `@Authenticated()` | Stage a secret for a QR code |
| `POST /api/auth/totp/confirm` | `@Authenticated()` | Enable it, return recovery codes |
| `GET /api/auth/invites/:token` | `@Public()` | Read an invitation without spending it |
| `POST /api/auth/invites/:token/accept` | `@Public()` | Spend it, and sign in |

The `/api/me/*` routes that change a password, turn the second factor off or
list the browsers an account is signed in on are in [staff and
roles](staff-and-roles.md#endpoints).

A failure answers with the api's one error body, plus the detail the sign-in
screens need:

```json
{
  "error": {
    "code": "unauthenticated",
    "message": "That authentication code does not match",
    "requestId": "0199f4b2-…",
    "auth": { "code": "totp-mismatch", "attemptsLeft": 2 }
  }
}
```

`error.auth.code` is one of `invalid-credentials`, `totp-mismatch`,
`totp-locked`, `challenge-expired`, `recovery-invalid`, `no-account` or
`unavailable`. The admin turns it into a translated sentence; no user-facing
English crosses that boundary.

## The development install

```bash
pnpm build
pnpm --filter @helpdock/api seed:dev
```

It migrates, then creates one brand and one install admin. It refuses to run
with `NODE_ENV=production`, because the password is published here:

| | |
|---|---|
| Email | `admin@helpdock.test` |
| Password | `helpdock dev password` |

Running it twice is safe and does not reset a password that has been changed.
`--with-totp` also enrols an authenticator and prints the secret;
`--with-invite` leaves one unaccepted invitation and prints its link, so the
invite screen has something live to open; `--json` prints one machine-readable
line, which is what the browser tests read.

To run the admin app against a real api rather than the fixture:

```bash
pnpm --filter @helpdock/api dev:build     # in one terminal
pnpm --filter @helpdock/api dev           # in another
VITE_AUTH_API=http pnpm --filter @helpdock/admin dev
```

The Vite dev server proxies `/api` to `http://localhost:3000`, so the browser
sees one origin and the `SameSite=Lax` refresh cookie is actually sent.
`VITE_API_ORIGIN` moves the target.

## Tests

| | |
|---|---|
| `pnpm --filter @helpdock/api test` | The unit suites: hashing, tokens, rotation, TOTP, rate limits, the resolver |
| `pnpm test:integration` | The whole flow over HTTP against a real Postgres and Redis |
| `pnpm --filter @helpdock/api test:coverage` | Both, with the 90 % line gate for `apps/api/src` |
| `pnpm --filter @helpdock/admin e2e:api` | The screens against a real api, in a browser |

The last one needs Docker and a build; without Docker it skips itself and says
so.
