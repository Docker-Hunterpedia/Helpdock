# Authentication

How staff sign in to Helpdock, what a session is made of, and what an operator
has to configure. Specified by [REQUIREMENTS
§5.1](../planning/REQUIREMENTS.md#51-security-non-negotiable), [ARCHITECTURE
§7](../planning/ARCHITECTURE.md#7-auth-design) and [DOMAIN-RULES
§1.4](../planning/DOMAIN-RULES.md#14-workers-and-websockets), §4.6 and §12.
Implemented by M0-05 and M11-01–06; the passkey foundation by M18-01, adding and managing passkeys by M18-02, a passkey as a second factor by M18-03, passwordless sign-in by M18-04, break-glass with a passkey by M18-05, the passkey screens by M18-06, OAuth identities bound by subject by M18-07 and Microsoft sign-in by M18-08. Setting up the Google, Microsoft and GitHub apps, step by step, is [sign-in providers](sign-in-providers.md).

Visitors (the widget, M4) and API keys (M8) are different principals with
different credentials and are not covered here. What an account may *do* once it
has signed in is [staff and roles](staff-and-roles.md), which also covers
invitations and a person's own security page.

## Sign-in methods

| | |
|---|---|
| **Password** | Argon2id with a pepper; blocked by SSO enforcement except emergency admins. |
| **Sign-in link** | A single-use link by email, valid for `auth.magicLinkTtlMinutes` (10 by default). Opening it spends nothing; the click on its confirm screen does. |
| **Google / Microsoft / GitHub** | OAuth. Shown only when the install has configured that provider. Microsoft is one organisation's work accounts, see [Microsoft](#microsoft). |
| **Passkey** | A discoverable passkey on its own, with a PIN or biometric: no password and no second step. Shown only when the install offers passkeys and SSO is not enforced; see [Signing in with a passkey](#signing-in-with-a-passkey). |
| **Staff SSO** | OIDC or SAML company sign-in; see [SSO setup](sso.md). |
| **Password reset** | A single-use link by email, valid for 10 minutes. |

Except when an administrator vouches for IdP MFA on an SSO connection, if the account has a second factor (an
authenticator app, a passkey, or both) it is asked for afterwards. There is no path that skips it, apart
from a browser the person has explicitly chosen to trust. An account that must
have one and has none — an Admin, an install admin, or anybody on an install
with `auth.require2fa` on — is sent to enrolment instead of being given a
session ([Who must have a second factor](#who-must-have-a-second-factor)).

`GET /api/auth/methods` reports which of them this install offers. The sign-in
screen calls it and draws only the buttons that would work. From 1.1 it also
reports `passkey` and `passkeysPaused` ([Passkeys](#passkeys)).

## The session

```
access token   JWT, ES256, 10 minutes, in memory in the browser
refresh token  opaque, 256 bits, rotating, httpOnly cookie
               ends after 4 hours unused, and 12 hours after sign-in at most
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

### How long a sign-in lasts

Two limits, both from `.env` (ASVS 3.3.2):

| Key | Default | |
|---|---|---|
| `AUTH_SESSION_IDLE_MINUTES` | `240` | A browser that has not refreshed for this long signs in again |
| `AUTH_SESSION_MAX_HOURS` | `12` | Every browser signs in again this long after it signed in, however busy it was |

SSO families additionally cap the absolute lifetime at 12 hours, even if
`AUTH_SESSION_MAX_HOURS` is longer. Access JWTs expire no later than their family.

The family's Redis record lives for the idle limit and each refresh renews it,
but never past what is left of the absolute one; the cookie's `Max-Age` is the
absolute limit. The defaults are the figure ASVS Level 2 gives. A browser the
person chose to trust skips the second factor on the next sign-in, so a daily
sign-in costs a password. Lowering `AUTH_SESSION_MAX_HOURS` ends families that
are already older than the new limit at their next refresh. Neither may be more
than 30 days.

The **signing keys** are an ES256 key pair generated at first boot and stored,
encrypted, in the `auth.jwtSigningKey` setting, so every replica verifies what
any other replica signed. Clearing that setting and restarting signs everybody
out; that is the whole of key rotation in v1.

### Cookies

| Cookie | What it is | Attributes |
|---|---|---|
| `__Secure-hd_refresh` | The refresh token and its family | `HttpOnly`, `SameSite=Lax`, `Path=/api/auth`, `Max-Age` of `AUTH_SESSION_MAX_HOURS`, `Secure` |
| `__Secure-hd_trust` | A browser the person chose to trust | the same, 30 days |
| `__Secure-hd_oauth` | The browser that began an OAuth sign-in, until the provider sends it back | `HttpOnly`, `SameSite=Lax`, `Path=/api/auth/oauth/<provider>`, `Secure`, 10 minutes, cleared by the callback |

`SameSite=Lax` means a cross-site POST carries neither, which is what makes
`/api/auth/refresh` safe without a CSRF token of its own. `Path=/api/auth` means
no other route in the application ever receives the first two, and
`Path=/api/auth/oauth` the third. None has a `Domain`, so none is readable by a
sibling subdomain.

`Secure` is set only when `APP_URL` is https: a `Secure` cookie is dropped
silently over plain http, and a local `http://localhost` install would otherwise
be unable to sign in with nothing on screen to say why. The names carry the
`__Secure-` prefix on the same condition — a browser accepts such a cookie only
from a secure origin with `Secure` set, so a plain-http page or a network
attacker cannot plant one — and are the bare `hd_refresh`, `hd_trust` and
`hd_oauth` on a plain-http install.

**`__Secure-`, not `__Host-`** (ASVS 3.4.4). `__Host-` also requires
`Path=/`, which would send the refresh token to every route in the app instead
of the five that read it. The other half of `__Host-` — no `Domain` — already
holds. The narrow path is worth more than the stricter prefix; the deviation is
recorded in [asvs-l2](../completed/asvs-l2.md). Upgrading to this release
renames the cookies, so every browser signs in once more.

### What the browser holds

The access token lives in a field on the http adapter and nowhere else — not in
`localStorage`, not in `sessionStorage`, not in a cookie a script can read. A
reload starts with no token and calls `POST /api/auth/refresh`, which is what
the `httpOnly` cookie is for. A 401 on any request is retried once, after a
refresh, and only when a token was actually sent and the 401 refused that
token. The api tells the two kinds of 401 apart in the body: the guard's
answer to a missing or expired token has no `error.auth`, while a refused
credential — a sign-in, or the current password or code a step-up on the
security page asks for — always carries one (`invalid-credentials`,
`totp-mismatch` and so on). The admin passes the second kind straight to the
screen, so one wrong password costs one step-up attempt, not two.

## Passwords

Argon2id at the current OWASP minimum — 19 MiB of memory, two passes, one lane —
with a **pepper** derived from `APP_MASTER_KEY` with HKDF and handed to argon2
as its secret. The pepper is never stored: without `.env`, a stolen database is
not a set of crackable hashes, because no candidate password can even be tested.

A hash made with weaker parameters, or by an older release, is replaced on the
next successful sign-in — the one moment the plaintext is in hand.

A password must be at least 12 characters. There are no composition rules.

### Breached passwords

A new password — in the wizard, on an invitation, on a reset and on a change —
is checked against a list of passwords already known to attackers (ASVS
2.1.7): the 46 146 entries of 12 characters or more among the million most
common in SecLists' `xato-net` list, compared without regard to case. The list
ships in the image (`apps/api/src/auth/breached/`); the password is never sent
anywhere to be checked ([ADR 0021](../decisions/0021-bundled-breached-password-list.md)).
A match answers `400` with `error.auth.code` `password-breached`, and the
screen says so on the field. A reset refuses it before the link is spent, so
the same link takes a better password.

Every field that chooses a password (`Admin/PasswordField`) has a show/hide
toggle and a strength bar; the breached and too-short errors are drawn on the
field after the api answers.

### Nothing confirms who works here

An unknown address and a wrong password answer the same code, `invalid-credentials`,
after the same amount of work: the unknown-address branch still runs argon2,
against a hash nobody knows the password to. The sign-in link and the password
reset answer `204` whoever asks. Without that, the sign-in form is a way to find
out who has an account here.

## Two-factor

TOTP, SHA-1, six digits, a thirty-second step, and a window of one step either
side, which covers the drift between a phone and a server.

The secret is stored encrypted with AES-256-GCM under `APP_MASTER_KEY`.

**Each code works once** (ASVS 2.8.4). The thirty-second step an account's code
was last accepted at is kept in Redis (`auth:totp-step:<user>`) for as long as
that code could still match, and only a later step is accepted after it. A code
that comes back — at a second challenge, or to prove a step-up — is refused as
`totp-mismatch`, costs an attempt like any wrong code, and is logged and
audited as `auth.second_factor.replayed`, because a valid code arriving twice
means somebody else saw it.

### Who must have a second factor

- **Every Admin of any brand, and every install admin**, whatever the setting
  (ASVS 4.3.1): their sessions decide who else works here.
- **Everybody**, when `auth.require2fa` is on.

"Has a second factor" means an authenticator app is on **or** at least one
passkey is registered; either meets the rule. Such an account cannot remove its
last second factor of either kind (turning the app off while a passkey remains
is allowed, and so is removing a passkey while the app is on), and the security
page says why. An Admin who had none before this rule existed keeps their current session
until it ends (at most `AUTH_SESSION_MAX_HOURS`) and is sent to enrolment at the
next sign-in, as is somebody invited as an Admin.

### Enrolling

1. `POST /api/auth/totp/enrol` stages a secret and returns the `otpauth://` URI
   for a QR code. Nothing is enabled yet, so a code that did not save cannot
   lock anybody out.
2. `POST /api/auth/totp/confirm` with a live code enables the second factor and
   returns **ten recovery codes, once**.

Before a session exists, the same two steps take the **enrolment challenge**
that sign-in answered with instead. Its name is `second-factor-enrolment-required`
in this documentation and in the code, but for one release the api still **sends**
`totp-enrolment-required` on the wire, so an admin bundle cached from before 1.1
keeps working; every reader accepts both, and the new name goes on the wire in the
release after. The challenge is honoured only while the account has no second
factor: if an app or a passkey was set since it was handed out, `enrolment/start`,
`enrolment/confirm` and the passkey routes answer `challenge-expired`, and the
check and the enabling run under the account-row lock.

`POST /api/auth/enrolment/start` stages the secret, and
`POST /api/auth/enrolment/confirm` with a live code turns it on, spends the
challenge, sets the refresh cookie and answers the recovery codes together with
the session. A wrong code costs one of the challenge's three attempts. The
challenge lasts fifteen minutes.

The enrolment challenge also takes **a passkey** instead of an app. The screen
offers the passkey first and marked recommended; a browser that cannot create
passkeys, or an install that has paused them, disables that card and
preselects the app.

| Route | |
|---|---|
| `POST /api/auth/enrolment/passkey/options` | `{ challengeId }`; answers `{ ceremonyId, options }` for `navigator.credentials.create()`. The ceremony is bound to the person and to the challenge, and the challenge is not spent |
| `POST /api/auth/enrolment/passkey/confirm` | `{ challengeId, ceremonyId, response, name }`; checks the registration, spends the challenge, stores the passkey, draws the recovery codes, sets the refresh cookie and answers the codes together with the session, as `enrolment/confirm` does |

A registration that does not verify (another origin, a ceremony that is spent or
belongs to another challenge, an attestation this install does not take) costs
one of the challenge's three attempts and answers `401 passkey-invalid` with
`attemptsLeft`; the budget and the 15-minute lock are the ones codes use. The
registration is checked before the challenge is spent, and the challenge is spent
before anything is stored, so a challenge enrols once. The first successful
registration pins the RP ID, as it does from the security page. Under SSO
enforcement the route answers `403 sso-required` for a challenge that followed a
local first factor, because a local second factor opens no session there; one
that followed an SSO assertion is honoured.

The screen that draws the QR code is `/sign-in/enrol`, which sign-in sends an
account that must have an authenticator and has none to. It stages the
secret, draws it as a QR code and as a key that can be typed, and hands over the
recovery codes behind a checkbox that says they have been saved. The QR is drawn
in the browser as SVG, because the `otpauth://` URI is a credential and asking a
server to draw it would put it in a second place. [Staff and
roles](staff-and-roles.md#two-factor-enrolment) walks through it.

`POST /api/auth/totp/enrol` never replaces an authenticator that is on: it answers
`409 totp-already-enabled`. Replacing one is the **rotation** below, done from the
security page; for an account that need not keep a second factor, turning it off
with a live code and enrolling again also works.

### Replacing the app (#373)

An account that must have a second factor and holds only the app can neither turn
it off (no factor would remain) nor enrol over it (one is on), so the security
page offers **Replace app**, which swaps the secret in one confirmed step:

1. `POST /api/me/totp/rotate/start` with one proof: a live code from the current
   app, a single-use recovery code, an assertion from a passkey the account
   holds (in answer to `POST /api/me/passkeys/step-up/options`), or the current
   password **with** a recovery code (DOMAIN-RULES §12.1 rule 7). It answers
   `{ rotationId, secret, uri }` — the staged secret for the QR code.
2. `POST /api/me/totp/rotate/confirm` with `{ rotationId, code }`, where `code`
   is a live code from the **new** app. Only then is the secret swapped, in one
   transaction under the account-row lock, so a failure anywhere leaves the old
   app working and nothing half-done. The staged secret waits fifteen minutes
   in Redis, sealed, and is spent by the confirmation.

The holder is emailed (`securityChange`, `twoFactorRotated`) through the outbox,
the api writes `auth.second_factor.rotated`, and the recovery codes stay. Each
of the two requests costs the step-up budget (five per fifteen minutes), so the
staged secret's six digits cannot be walked. The start takes the account-row lock
before it reads the recovery codes, as turning the app off and redrawing the codes
do, so one recovery code starts one rotation and a start racing a redraw cannot
bring the old codes back.

The staged secret is bound to the secret it replaces (a digest of the sealed live
secret). An account has one open rotation: staging another, or turning the app
off, enrolling, or completing a rotation, ends it, and a confirmation whose bound
secret is no longer the live one is refused with `challenge-expired`, and the swap
`UPDATE` names the old secret too. The confirm code is checked against the staged
secret only, so the old app cannot confirm its own replacement; the old app's
codes stop working at the swap. The confirm code's time step is then recorded as
used, after the commit, so that code cannot also sign in; the new app's next code
can.

While SSO is enforced, an account that is on the break-glass list or eligible for
it cannot prove with a recovery code (alone or with the password): the start
answers `403 recovery-code-not-allowed`, spends no code and no attempt, and the
security page does not offer the option. Those accounts prove with the current
app's code or a passkey. Everyone else, and everyone while enforcement is off,
may still use a recovery code.

With a lost phone the recovery code (alone, or with the password) proves the
step-up; with a passkey, the passkey does.

### When a person has lost the phone and the recovery codes

An install admin can reset another person's second factor (#398): **Staff**, the
row menu, **Reset second factor** (install admins only; absent on your own row,
on people with no second factor, and on anyone who is not active). The admin
confirms it is them first (their passkey, password or a live app code, from the
step-up budget), then a destructive confirm lists what goes, with live counts
from the server: the app, the passkeys and the unused recovery codes. It warns
to check the person's identity out of band, because whoever knows their password
can enrol the next second factor.

In one transaction the app, the passkeys and the recovery codes are removed, every
session and trusted browser is revoked, `auth.second_factor.reset` is audited
(actor, target, counts) and the person is emailed (`secondFactorReset`, naming
the administrator). At their next sign-in an Admin, install admin or anyone while
`auth.require2fa` is on goes to enrolment before a session opens; everyone else
signs in with the password alone until they set one up from their security page,
and the confirm and the email say which applies. Sessions are revoked before
the commit (a failed revoke undoes the reset) and again after it; a reset that
fails may still have signed the person out, but never leaves the factors removed
with sessions alive. Refused with `409`: your own account, a person
with nothing to reset, factors that changed while the confirm was open, and the
last configured break-glass admin while SSO is enforced (make another install
admin ready for break-glass first). Ten resets an hour per admin
(`second-factor-reset`).

Turning the second factor **off** again, and redrawing the recovery codes, are
on the security page and each cost a live code: a session proves somebody signed
in, not that the person at the keyboard now is the account holder. Turning it
off is not offered to an account that must have one — replacing the app is.

### Recovery codes

One set per account, drawn with the account's **first** second factor of either
kind: with the app at `totp/confirm` or `enrolment/confirm`, and with the first
passkey at `enrolment/passkey/confirm` or, from the security page, in the
`recoveryCodes` field of the `POST /api/me/passkeys/finish` answer. An app added
beside a passkey, or a passkey beside an app, brings no new set. Removing the
last second factor forgets the set; turning the app off while a passkey remains
keeps it.

Redrawing them needs a live authenticator code (`POST /api/me/recovery-codes/regenerate`)
**or** an assertion from a passkey the account holds (`POST /api/me/passkeys/recovery-codes`
with `{ passkey: { ceremonyId, response } }`, answering the ceremony from
`POST /api/me/passkeys/step-up/options`). On Security, **Regenerate with a
passkey** (offered when the account holds a passkey and the browser supports
them) asks the browser for one and shows the new codes once. Both spend the step-up budget. A recovery
code answers a second-factor challenge only: it never opens a passwordless
sign-in, and it is not a break-glass credential, even with a passkey on the account.
Under SSO enforcement it may finish a sign-in that began with an SSO assertion
(#387); it still never finishes break-glass, whose first factor is a password.
It also proves the step-up that starts replacing the authenticator app
([Replacing the app](#replacing-the-app-373)), alone or with the password —
the one path a person whose phone is gone and who holds no passkey can still take.

Ten, shaped `RC-4KQ2-9XMT`, in an alphabet with no character that can be
confused with another on paper. Each works once. They are stored as argon2
hashes under the same pepper as a password, because a recovery code *is* a
password.

### Attempts and the lock

A challenge allows **three** attempts in total, whatever answered it: an
authenticator code, a recovery code and a passkey share the budget, so a lock
cannot be dodged by switching forms. An attempt is reserved, atomically, on the
challenge and on a per-account counter **before** the answer is evaluated, so no
more than three answers are ever evaluated for an account within 15 minutes of
each other, even in a parallel burst; the answer that is correct spends the
challenge in one atomic step that fails if a lock has landed meanwhile. On the
third failure the challenge is deleted and the account is locked for **15
minutes**. Minting a passkey's options evaluates no answer and spends no
attempt; a closed browser prompt never reaches the api, so it spends none either.

The lock is reported only after the password has been proved. Saying it earlier
would tell a stranger that the address exists.

### A passkey as the second factor

After a password, a sign-in link, OAuth or an SSO assertion that does not vouch
for IdP MFA, the sign-in answer is `{ kind: "totp-required", challengeId, email,
factors: { totp, passkey } }`: `factors` says which ways can answer it (the
redirect from OAuth and SSO carries them as `factors=totp,passkey`; none means an
app alone). `passkey` is false for an account with an app when the install has
paused passkeys, and true regardless for a passkey-only account, so the screen
can say why it cannot be used.

| Route | |
|---|---|
| `POST /api/auth/passkey/second-factor/options` | `{ challengeId }`; answers `{ ceremonyId, options }` for `navigator.credentials.get()`, with the account's passkeys in `allowCredentials` (named only now that a first factor is proved) |
| `POST /api/auth/passkey/second-factor/verify` | `{ challengeId, ceremonyId, response, trustDevice }`; answers a session and sets the refresh cookie, and `hd_trust` when asked |

User presence is enough here, so a security key with no PIN works. The ceremony
is bound to the person and to the challenge and is spent when it is checked,
whether it then passes or fails, so a captured answer replayed on the same or on
a later challenge fails and costs an attempt. Every refusal answers `401
passkey-invalid` with `attemptsLeft`: another person's passkey (even one signed
over this challenge's options), a credential nobody holds, another origin, a
wrong challenge, a counter that went backwards, or a ceremony that is gone. The
reason goes to the audit trail as `auth.second_factor.failed` with `meta.factor`
`passkey` and `meta.reason` (`unknown-credential`, `wrong-user`, `bad-assertion`,
`counter-regressed`, `ceremony-gone`); a counter regression also writes
`auth.passkey.counter_regressed`. A success writes `auth.sign_in.succeeded` with
`secondFactor: passkey`, and records the use (`last_used_at`, the counter).

"Trust this browser" applies to whichever factor succeeded. Under SSO
enforcement a passkey second factor is accepted in two cases only: after an SSO
assertion that does not vouch for IdP MFA, and after the password of a configured
break-glass install admin ([ADR 0053](../decisions/0053-break-glass-with-a-passkey.md)).
For break-glass the ceremony has its own purpose and requires user verification
(and the key must have registered with it),
so a key that proves presence only is refused as `passkey-invalid` and costs an
attempt. After any other local first factor it answers `403 sso-required` (from
`options` too, so no ceremony is minted for it), as a recovery code does. A
ceremony minted before enforcement came on is refused when it is checked, and the
person asks again.

### Signing in with a passkey

A passkey can be the whole sign-in (M18-04, `Admin/Login-Passkey`). It is a
discoverable credential asked for with user verification required, so one
assertion is possession plus the PIN or biometric the authenticator checked:
both factors, and no second step follows. A trusted-browser cookie plays no part,
and a recovery code never opens this door.

| Route | |
|---|---|
| `POST /api/auth/passkey/options` | No body. Answers `{ ceremonyId, options }` with `userVerification: "required"` and **no** `allowCredentials`: the options are the same for every caller and name no account |
| `POST /api/auth/passkey/verify` | `{ ceremonyId, response }`; answers a session and sets the refresh cookie, exactly as a password followed by a code does |

Every refusal that could say something about who holds an account answers `401
invalid-credentials`: a credential nobody holds, a bad signature, an assertion
without user verification, another origin, a counter that went backwards, a
spent or unknown ceremony (a replay), a deactivated person, an account with no
role in any brand, and a user handle that is not the credential owner's. The
reason goes to the audit trail only, as `auth.sign_in.failed` with
`meta.method: passkey` and `meta.reason` (`unknown-credential`, `bad-assertion`,
`counter-regressed`, `ceremony-gone`, `unusable-account`, `no-brand-role`,
`user-handle-mismatch`); a regression also writes `auth.passkey.counter_regressed`.
An assertion for an unknown credential is checked against a throwaway key so it
costs about what a known one does. The same brand-membership check as every
other sign-in runs before a session opens, and a success records the use
(`last_used_at`, the counter) and writes `auth.sign_in.succeeded` with
`method: passkey, secondFactor: passkey-uv`.

Failures draw on the **same per-IP budget** as the password form (100 per 15
minutes): a failed assertion keeps its slot, a success gives it back, and
`rate-limited` is the same answer for both. Fetching options evaluates no guess,
so it gives its slot back too, and a bucket of its own (120 per 15 minutes per
IP) only stops one source filling Redis with ceremonies.

Under SSO enforcement both routes answer `403 sso-required` before anything is
spent: a passkey is a local method, and without it a person deactivated in the
identity provider could keep signing in. An install with `passkey: false` in
`GET /api/auth/methods` (plain http, or SSO enforced) answers `passkeys-unavailable`
or `sso-required`, and a paused install `passkeys-rp-changed`.

On the sign-in page the email field carries `autocomplete="username webauthn"`
and the page asks the browser for its autofill list on load (conditional
mediation), so choosing a saved passkey there signs in directly; the button
"Sign in with a passkey" runs the same ceremony in the browser's own prompt. A
closed prompt is a neutral notice that counts for nothing; neither control is
drawn under enforcement or when `passkey` is false, and a paused install shows a
warning in place of the button.

### Trusting a browser

"Trust this browser for 30 days" sets `hd_trust`, which is
`<userId>.<nonce>.<mac>` where the MAC is HMAC-SHA256 under a key derived from
`APP_MASTER_KEY`. The nonce's hash is also a Redis key and both have to check
out: without the MAC, anyone who can list Redis keys could mint one; without
Redis, it could not be revoked. "Log out everywhere" forgets every trusted
browser.

## Passkeys

Staff passkeys (WebAuthn) arrive in 1.1 with M18
([ADR 0050](../decisions/0050-passkeys-for-staff-over-webauthn.md)). M18-01
lays the foundation described here and M18-02 adds
[registering and managing them](#adding-renaming-and-removing-passkeys); using
one as a second factor ([A passkey as the second factor](#a-passkey-as-the-second-factor),
M18-03) builds on it, and [signing in with one alone](#signing-in-with-a-passkey)
(M18-04) needs nothing else. [Break-glass with a passkey](sso.md#roles-mfa-and-enforcement)
(M18-05, ADR 0053) is described with SSO enforcement. The rest of the passkey
screens (M18-06) are still to come.

### Where passkeys work

A passkey is bound to a relying party, and this install is one: its **RP ID**
is the host name of `APP_URL`, and the only origin an answer may come from is
`APP_URL`'s origin. Both come from `APP_URL` alone, never from the `Host` or
`Origin` header of a request, so nothing a proxy or a client sends can change
them. Brand help-center domains play no part: staff never sign in there.

Browsers run WebAuthn only in a secure context, and an RP ID has to be a
domain. So passkeys are available when `APP_URL` is `https://` on a host
name, or `http://localhost` while developing. On any other plain-http install,
or one reached by IP address, `GET /api/auth/methods` reports
`passkey: false` and a ceremony answers `passkeys-unavailable`.

### The RP ID is pinned

The first successful passkey registration writes the RP ID into the install
setting `auth.webauthn.rpId`, once, and records `auth.passkey.rp_pinned` in the
audit trail. Nothing else writes it: until a passkey exists, ceremonies run
against `APP_URL`'s host and leave no trace, so an install first opened on
`localhost` or a staging host is not pinned there by a sign-in page that only
offered passkeys. Every ceremony after the pin compares `APP_URL`'s host with
it. Two replicas finishing the first registration at the same moment agree on
one value: the write is a single statement that does nothing if a value is
already there, and the registration that lost to another host is refused with
`passkeys-rp-changed`.

If an operator later moves `APP_URL` to another host, every passkey the
install holds stops working, because each was made for the old host. Helpdock
does not orphan them silently:

- passkey ceremonies are refused with `passkeys-rp-changed`, including one
  begun before the change;
- `GET /api/auth/methods` reports `passkey: false, passkeysPaused: true`, so the
  sign-in screen can say so instead of drawing the button;
- password, sign-in links, TOTP, OAuth and SSO keep working.

Moving the passkeys to the new host means re-pinning the setting, after which
staff add their passkeys again. An install admin does it from **Settings ›
Authentication**: the Passkeys section shows `Paused`, both hosts, and a
**Move passkeys to <new host>** button. The button opens a confirmation that says
every existing passkey stops working, and that people with no authenticator app also
lose their recovery codes and will set up a second factor again. Then, in **one
transaction**, it moves the pin only while it still holds the old host (two moves
cannot both run), locks the holders' accounts, removes every passkey on the
install (a passkey made for the old host cannot work on the new one, and left in
place it would still count as a second factor), forgets the recovery codes of
anyone with no app, writes `auth.passkey.rp_moved` (`from`, `to`, `passkeys`,
`holders`) and queues each holder a `securityChange` notice through the outbox. If
any step fails, none of it happens. The same warning shows on the System page.

The move is refused while it would lock people out: when SSO is enforced and a
configured break-glass admin relies on a passkey (they have no authenticator app),
or when an account that must have a second factor (an Admin, an install admin, or
everyone under `auth.require2fa`) has only passkeys. The dialog shows how many
accounts, and the admin adds authenticator apps first. Behind the button are two
routes, both `install:admin`:

| Route | |
|---|---|
| `GET /api/install/passkeys` | `state` (`available`, `paused`, `unavailable`), the `rpId` `APP_URL` implies, the `pinnedRpId` and when it was pinned, `pinLocked`, the counts `passkeyCount` and `holderCount`, and, while paused, `blockers` (`breakGlassAccounts`, `secondFactorAccounts`). Counts only: it names nobody |
| `POST /api/install/passkeys/move` | Only while `paused`. Answers `{ rpId, passkeysRemoved, holdersNotified }`, or `409` with `error.passkeys.reason`: `not-paused`, `pin-locked` (`HD_AUTH_WEBAUTHN_RP_ID` pins the RP ID) or `move-blocked` |

`HD_AUTH_WEBAUTHN_RP_ID` also sets the pin: while it is set, the environment value
is the pin and nothing is written to the database, so the button is not offered
and the section says to change it there.

### Ceremonies

Each ceremony (handing the browser its options, then checking what the
authenticator signed) is a record in Redis under `auth:webauthn:<hash>`:

- it is addressed by a 256-bit random id, of which Redis holds only the
  SHA-256;
- its challenge is 32 random bytes;
- it lives five minutes, the same as the browser prompt's `timeout`;
- it is spent with `GETDEL` before anything is checked, so it works once,
  whether the answer passes or fails;
- it names its purpose (`register`, `second-factor`, `passwordless`,
  `step-up`, `break-glass`) and the person it belongs to, and for a
  registration the browser session too. Passwordless sign-in is the one
  purpose that names nobody; every other one must, so only that person's
  passkey can answer it. A challenge minted for one purpose, person or
  session cannot complete another; it answers `challenge-expired`.

The options fix what the install has an opinion on: EdDSA, ES256 and RS256
only; attestation `none`, with no metadata service; a discoverable credential preferred, with the
`credProps` extension so the api knows whether it got one. User verification
(a PIN or a biometric) is **required** for passwordless sign-in and break-glass,
where one assertion stands for two factors, and only **preferred** elsewhere, so
a security key without a PIN still works as a second factor.

Two kinds of answer are refused before the library parses them. A
registration's attestation statement must be `none`, or a `packed`
self-attestation (signed with the new credential's own key, which some
authenticators send whatever was asked); a statement that names a
certificate chain is refused, so no vendor chain is ever walked and no
revocation list fetched. And client data that says it was made inside a
frame (`crossOrigin: true`) is refused: the admin is never framed.

The user handle an authenticator stores is 32 random bytes per account
(`users.webauthn_user_handle`), not the account id, whose UUIDv7 carries the
time the account was made. The name sent with it is cut to 64 bytes on a
character boundary, which keeps about 30 Arabic letters whole.

A credential's signature counter is compared only once either side is above
zero, because synced passkeys always report zero; after that it has to grow,
and it is checked only after the signature is: a forged assertion cannot raise
a counter alarm.

### Adding, renaming and removing passkeys

A person manages their own passkeys on **Security** (`/settings/account/security`, the
Passkeys card), through `/api/me/passkeys`. Every route is `@Authenticated()`,
names no user, and treats a passkey that is not the caller's exactly like one
that does not exist (`404`).

| Route | |
|---|---|
| `GET /api/me/passkeys` | The caller's passkeys (name, when added, last used, "synced" when the platform backs it up), the limit, the install's passkey state (`available`, `paused`, `unavailable`), `removalBlocked` and `authenticatorApp` |
| `POST /api/me/passkeys/step-up/options` | Options for answering a step-up with a passkey the account holds |
| `POST /api/me/passkeys/begin` | `{ proof }`; answers `{ ceremonyId, options }` for `navigator.credentials.create()` |
| `POST /api/me/passkeys/finish` | `{ ceremonyId, response, name }`; stores the credential and answers it, with `recoveryCodes` (once) when it is the account's first second factor of either kind |
| `POST /api/me/passkeys/recovery-codes` | `{ passkey: { ceremonyId, response } }`; redraws the recovery codes after an assertion from a passkey the account holds |
| `PATCH /api/me/passkeys/:id` | `{ name, proof }` |
| `DELETE /api/me/passkeys/:id` | `{ proof }` |

**Every change needs a proof** (ASVS 3.7.1): the current password, a live
authenticator code, or an assertion from a passkey the account already holds
(`{ passkey: { ceremonyId, response } }`, answering the ceremony from
`step-up/options`). Exactly one. The three share the step-up budget of five in
fifteen minutes that Connect and Disconnect on a provider use: a refused
attempt spends one, so does an accepted one, and the sixth answers `429
totp-locked` until the window slides. Minting options has a budget of its own
(30 in fifteen minutes) so it cannot spend the owner's step-up attempts. The
ten-passkey limit and the last-factor refusal are checked before the proof, so
they spend no attempt.

**Registering** is two calls so the browser's prompt sits between them.
`begin` checks the proof, draws the account's 32-byte user handle on its first
registration, and lists the account's existing passkeys in `excludeCredentials`
so one authenticator is not added twice. The ceremony it opens is bound to the
person and to the browser session (the `fam` claim of the access token), so
another tab, another browser or another person cannot finish it. `finish` takes
what the authenticator made and the name the person chose (1 to 64
characters, no control characters), and spends the ceremony before it checks
anything:

| Answer | Why |
|---|---|
| `401 challenge-expired` | The ceremony is spent, expired (five minutes), of another purpose, or another person's or session's. A replay ends here |
| `401 invalid-credentials` | The answer is for another origin or RP ID, is framed, has an attestation this install does not take, or does not verify |
| `409 passkey-limit` | The account holds ten. `begin` says so before the proof; `finish` says it again under a lock on the account row, so two parallel registrations cannot both take the last place |
| `409 passkey-duplicate` | This authenticator's credential id is already stored |
| `409 passkeys-rp-changed` / `403 passkeys-unavailable` | See [The RP ID is pinned](#the-rp-id-is-pinned) |

**Removing** the account's last passkey is refused with `409
second-factor-required` when the account must have a second factor (an Admin,
an install admin, or any account while `auth.require2fa` is on) and has no
authenticator app. Another passkey, or an app, is enough; `GET` reports
`removalBlocked` so the card disables the button instead of letting the person
find out. Removal stays available while passkeys are paused after an `APP_URL`
change: nobody is stuck with passkeys that cannot sign. Removing a passkey and
turning the authenticator app off take the same lock on the account row and each
count the other factor under it, so the two done at once cannot leave an Admin
with neither: one of them is refused. Removing the last second factor of an
account that may go without one also forgets its recovery codes.

Each change writes an audit row in install scope, actor `staff`:

| Action | `meta` |
|---|---|
| `auth.passkey.added` | `passkey` (id), `name`, `synced` |
| `auth.passkey.renamed` | `passkey`, `from`, `to`. Nothing when the name did not change |
| `auth.passkey.removed` | `passkey`, `name` |

and a refused proof by passkey writes `auth.step_up.refused` with `meta.reason`
`passkey-unknown-credential`, `passkey-wrong-user`, `passkey-bad-assertion` or
`passkey-counter-regressed`; the last also writes `auth.passkey.counter_regressed`.
The caller sees `invalid-credentials` for all of them. An addition or a removal
also emails the holder ([When a credential changes](#when-a-credential-changes));
a rename does not, because it changes no way in. A password reset keeps every
passkey (it proves the mailbox, not the person), and its notice says how many
were kept so they can be checked.

### Storage

`webauthn_credentials` holds one row per passkey: the credential id, the COSE
public key (the private key never leaves the authenticator), its algorithm,
the counter, transports, the authenticator's AAGUID when the browser reports
one (for display, never for policy), whether it is discoverable, its backup
flags, a name and when it was made and last used. Deleting an account deletes
its passkeys.

Like `users`, the table is install-wide and in `GLOBAL_TABLES`, with no
`brand_id`: a passwordless sign-in looks a credential up before any brand is
known, and one key belongs to one person in every brand they work in. Only
the sign-in path, by credential id, and a person's own `/api/me/passkeys`
routes, filtered to their own id, reach it.

## The sign-in link and the password reset

Both are 256 bits of randomness, stored in Redis as a hash with the user id and
the purpose, single use, and short-lived ([DOMAIN-RULES
§4.6](../planning/DOMAIN-RULES.md#46-tokens-sent-to-customers)). The purpose is
part of the record and not only of the key, so a sign-in link cannot be posted
to the password-reset endpoint.

A password reset ends **every** session the account holds, everywhere, and
forgets every browser it trusted. Somebody resets a password because they think
somebody else has it.

### Opening a sign-in link spends nothing

A mail scanner or a chat app's link preview fetches every link in a message, so
a link spent by a `GET` would be spent before the person clicks it. The email
therefore links to an admin page, `/sign-in/magic#token=…`, and the page asks
first:

1. It reads the token from the URL fragment. A browser never sends a fragment to
   a server, so the token reaches no request log and no `Referer` header.
2. `POST /api/auth/magic-link/preview` with `{ "token": … }` answers the address
   of the account the link opens and `auth.magicLinkTtlMinutes`. It reads the
   token without spending it. Every dead, used or unknown token answers the same
   `401 challenge-expired`, so the call cannot be asked about an address.
3. **Continue to Helpdock** sends `POST /api/auth/magic-link/consume` with the
   same body. That spends the link (`GETDEL`, so two clicks race and one wins)
   and answers exactly as `POST /api/auth/sign-in` does: a session, a
   second-factor challenge, or enrolment.

Both calls take the token in the body, refuse with `sso-required` while SSO is
enforced (before the token is touched, so it is not burnt), and share a budget
of 30 a quarter-hour per address (`unavailable` once it is spent). A refused
click is in the audit trail as `auth.sign_in.failed` with `method: magic-link`.

A link sent before this page existed points at `GET /api/auth/magic-link/<token>`.
That route still answers, but only with a redirect to the page, the token moved
into the fragment; it reads nothing and spends nothing.

### A token in a path never reaches the log

A query string never reaches the request log at all, so the password reset's
token is safe by construction, and a fragment never reaches the server, which is
where a sign-in link carries its token now. A sign-in link sent before the
confirm screen and the staff invitation put theirs in a *path*, and the
invitation's is served as a page by the admin SPA —
through the catch-all route, which never reaches a handler that knows what the
segment is. So `RequestContextMiddleware` collapses `/invite/<token>` and
`/api/auth/magic-link/<token>` to `:token` before the line is written, where
every request passes, rather than in each handler. `/magic-link/preview` and
`/magic-link/consume` keep their names: their token is in the body.

### Sending

Sign-in links, password resets and staff invitations are sent by the **worker**,
from the install's system sender: the `smtp.*` settings the first-run wizard
saves (or `HD_SMTP_*`), the same sender staff notifications use. The api never
talks to a mail server for them.

1. The request writes an `auth.email_requested` row to the outbox
   (DOMAIN-RULES §6). An invitation writes it in the staff route's own
   transaction, so an invitation that rolls back sends nothing. A sign-in link
   and a password reset have no transaction to join — their token lives in
   Redis alone — so the row is written in a transaction of its own *after* the
   token is stored: if that write fails, nobody gets an email and the token
   expires unused. It is routed through a brand the account works in; an
   account with no role in an active brand is sent nothing, and could not have
   signed in with the link anyway.
2. The relay publishes the row, and its handler adds one `auth.email` job to the
   `notify` queue with a job id derived from the row.
3. The job reads the recipient's address, name and language from `users` at
   send time — a deactivated account is sent nothing — renders the message and
   sends it. It claims `auth.email:<outbox id>` in the transaction it runs in,
   so a redelivered job sends nothing a second time.

**The link is sealed.** The token is a working credential and Redis only holds
its hash, so the link is encrypted with AES-256-GCM under `APP_MASTER_KEY`
before it reaches the outbox row, and stays sealed in the job's data in Redis.
Only the job opens it, to put it in the message. Neither the api nor the worker
logs a link: the lines name the kind of email and the account id.

**Without SMTP** — an install that skipped the wizard's email step — nothing
is claimed and nothing pretends. A sign-in link or password reset is refused
with `email-unavailable`, the same answer for every address (it says how the
install is configured, never which accounts exist), and the screen says no
link was sent and points to **Admin › System › Outgoing email** instead of an
inbox. A job that was already queued when the sender disappeared logs, at
`warn`, that the email *would* have been sent, with the kind and the account
id, and finishes; it never logs the link, in any `NODE_ENV`.

**Setting the sender after setup** needs no `.env` edit and no restart:
**Admin › System › Outgoing email** (install admins) holds the same fields the
wizard's step 3 does — server, port, TLS mode, credentials, the From address
and name — plus **Send a test email** showing the server's answer. The
password is write-only: the field shows "Saved · type to change", and the
stored one is used only while the server, port and username are unchanged;
changing any of them asks for the password again (`smtp-password-required`), so
a stolen session cannot send it to another host. A test is limited like the
wizard's (ten per address in fifteen minutes; the card says "Wait N seconds"). A
field an `HD_SMTP_*` variable pins is read-only with a caption naming the
variable, because the environment wins and the worker reads the settings when it
sends. With SSO enforced, a magic-link request answers `sso-required` before it
answers `email-unavailable`. To follow a sign-in link
locally, point `smtp.*` at the Mailpit of the dev compose file
(`localhost:1025`, TLS `none`) and read it at <http://localhost:8025>.

The messages are rendered from the `email` catalogs in `@helpdock/i18n`,
in the recipient's own language, right to left for Arabic.

### When a credential changes

The account holder is told by email whenever their password is changed or
reset, their second factor is turned on or off, their recovery codes are
redrawn, a Google or GitHub account is connected to or disconnected from their
account, or a passkey is added or removed, or all passkeys are removed because the install moved (ASVS 2.2.3, 2.5.5) — a `securityChange`
auth email naming which one, when it happened, what to do if it was not them,
and a link to their security page. A passkey notice names the passkey, and an
addition also says where it came from (the browser and system the user agent
names, and the address cut to its network part: `Chrome on macOS · 85.12.x.x`);
a removal says what still protects the account. The reset notice of an account
that holds passkeys says how many were kept and to remove any it does not
recognise. "When" is told in the time zone of the brand the email is routed
through, because a staff account has no zone of its own. A provider notice
also names the provider account by its address ("The GitHub account
lina@example.com is connected."). Security emails ignore notification
preferences and cannot be turned off. From
inside a session the outbox row joins the request's transaction, so a change
that rolls back sends nothing; a reset, which has none, goes the way the reset
link went. The link is to a page, not a credential, and does not expire.

## The audit trail

Every authentication decision is a row of `audit_log` in install scope, which
install admins read in the [audit log](audit-log.md) with **Brand: install**
and an `auth.*` action ([ADR 0022](../decisions/0022-auth-audit-trail-in-install-scope.md),
ASVS 7.1.3, 7.2.1):

| Action | When |
|---|---|
| `auth.sign_in.succeeded` | A session was opened. `meta` has the first factor (`password`, `magic-link`, `oauth`, `invite`) and the second (`totp`, `recovery-code`, `trusted-browser` or none) |
| `auth.sign_in.failed` | A first factor was refused. `meta.reason`: `wrong-password`, `unknown-account`, `unusable-account`, `locked`, `no-brand-role`, `invalid-link` for a sign-in link that was dead, used or never issued, and for OAuth `link-required` or `identity-conflict` (see [Which account a provider signs in as](#which-account-a-provider-signs-in-as)) |
| `auth.second_factor.failed` / `.replayed` | A wrong authenticator or recovery code, or a passkey that did not verify (`meta.factor`, `meta.reason`); a code used twice |
| `auth.account.locked` | A challenge spent its last attempt |
| `auth.step_up.refused` | A security-page check refused: wrong password, a wrong or replayed code, a passkey assertion that did not verify, or the rate limit |
| `auth.refresh_token.reused` | A rotated refresh token came back; the family was revoked |
| `auth.password.changed` / `.reset`, `auth.second_factor.enabled` / `.disabled`, `auth.recovery_codes.regenerated` (`meta.proof`: `code` or `passkey`), `auth.recovery_code.used` | A credential changed |
| `auth.oauth.linked` / `.unlinked` | A Google, Microsoft or GitHub account was connected or disconnected. `meta.provider`, and for a link `meta.via`: `sign-in` (a first link Google vouched for, written by the system) or `connect` (from the person's session) |
| `auth.oauth.link_refused` | A connect or first link found that provider account bound to somebody else, or this person already holding one |
| `auth.passkey.rp_moved` | An install admin moved the passkeys to the install's new address. `meta` has `from`, `to`, `passkeys` (removed) and `holders` |
| `auth.passkey.rp_pinned` | The first passkey registration pinned `auth.webauthn.rpId`. Written by the system, with `meta.rpId` |
| `auth.passkey.added` / `.renamed` / `.removed` | A passkey was registered, renamed or removed from the person's session ([Adding, renaming and removing passkeys](#adding-renaming-and-removing-passkeys)) |
| `auth.sign_in.failed` with `meta.method: passkey` | A passwordless sign-in refused; `meta.reason` names why, and the person was told only `invalid-credentials` (see [Signing in with a passkey](#signing-in-with-a-passkey)) |
| `auth.passkey.counter_regressed` | A passkey presented a counter that did not grow, after its signature verified. Written by the system |

The rows are written by the `auth` system principal in a transaction of their
own, so a refused attempt is recorded although the request fails, and carry the
request id, client address and user agent. An unknown address is recorded as
`unknown-account` with no target, never spelled out. A row that cannot be
written is logged and does not stop the sign-in.

## OAuth

Google and GitHub are written against the providers' endpoints directly with
`jose` and `fetch`, not with passport; Microsoft goes through `openid-client`
([below](#microsoft)). The strategies that would have carried it —
`passport-github2` and `passport-google-oauth20` — were last published in 2022
and 2023, neither implements PKCE, and both are Express-middleware shaped, which
on Fastify means a shim around the part of the codebase that most needs to be
readable. What they would have replaced is two `fetch` calls to fixed hosts and
one `jwtVerify`.

Four things make the flow safe:

- **State.** 256 bits of randomness, stored server-side under its own hash and
  spent on the callback. A callback whose state this install did not issue is
  refused, and a state issued for one provider cannot complete the other's flow.
- **The browser.** The callback is a plain `GET`, so on its own the state would
  let anyone who captured the callback URL finish their own sign-in in someone
  else's browser. Starting a flow therefore also sets the short-lived
  `hd_oauth` cookie, a random value the server keeps only the hash of, and the
  callback is refused unless the browser sends it back. The cookie's path
  names the provider, so a Google sign-in and a GitHub one begun in the same
  browser each keep their own. A person who opens a sign-in on one device and
  finishes it on another is refused too; they start again.
- **PKCE.** S256. The verifier never leaves the server. GitHub OAuth Apps ignore
  it; it is sent anyway, and state is the defence there.
- **A fixed redirect.** Built from `APP_URL` and never echoed from the request,
  so there is no open redirect to point at.

No account is ever created: owning a Google address is not a reason to be
staff here. People are invited on [the staff
screen](staff-and-roles.md#inviting-somebody).

### Which account a provider signs in as

From 1.0.1 a provider account is **bound to a staff account by its stable
subject** (Google's `sub`, GitHub's numeric user id) in `user_oauth_identities`
([ADR 0051](../decisions/0051-oauth-identities-bound-by-subject.md)). Before
that, every sign-in matched the provider's verified address to an account,
which let whoever held a stale or recycled address at the provider sign in as
the person who holds it here.

- **A bound provider account signs in as its account,** whatever address the
  provider reports today. Each account has at most one identity per provider,
  and each provider account belongs to at most one staff account.
- **The address makes the first link only where the provider controls it:**
  - **Google:** a verified address that is either a managed Workspace account
    on its own domain (the `hd` claim equals the address's domain) or a
    `@gmail.com` / `@googlemail.com` address. The first such sign-in binds the
    Google account, is audited as `auth.oauth.linked` (`via: sign-in`) and
    emails the holder.
  - **GitHub: never.** GitHub keeps an address "verified" after its owner loses
    the mailbox, so a GitHub account is linked only from inside a session (below).
  - Anything else, a consumer Google account on a company address included,
    answers **`oauth-link-required`**. The callback screen says "Connect your
    GitHub account first" and lists the steps: sign in with the password or a
    sign-in link, open Your account → Security → Sign-in methods, choose
    Connect. It answers the same whether or not anybody here holds the
    address, so it confirms nobody.
- **An authoritative address whose account is already bound** to another
  account of that provider answers **`oauth-identity-conflict`** and changes
  nothing: a recycled Workspace address does not move the account.
- **The allowed Workspace domains** (`oauth.google.allowedDomains`, M18-07)
  narrow Google further. Empty, the default, allows every Google account the
  rules above allow. A list allows only managed Workspace accounts whose `hd`
  claim is one of the listed domains, so a Gmail or other consumer account is
  refused. The check is on `hd`, which Google asserts, not on the address's
  domain, and it is checked at every Google sign-in, connect and invitation
  acceptance, **bound accounts included**: taking a domain off the list turns
  away the accounts on it from their next sign-in. It does **not** end sessions
  already open, which last until they expire or are revoked. To cut someone off
  at once, deactivate them, which revokes their sessions
  ([staff and roles](staff-and-roles.md#changing-somebody)), or have them sign
  out everywhere from their own security page ([revocation](#revocation)).
  A refusal answers **`oauth-domain-not-allowed`** ("This Google account can't
  sign in here"), says nothing about whether an account exists, and is audited
  as `auth.sign_in.failed` (or `auth.oauth.link_refused` for a connect) with
  `reason: domain-not-allowed`. GitHub has no such list (D-53).
- **Microsoft** links like Google, under the stricter rules in
  [Microsoft](#microsoft).
- **An invitation can be accepted with a provider** (M18-07). The invite
  screen offers the configured providers beside the password. The invitation
  token already proved the mailbox, so the provider account is bound when its
  verified address is the invited one: Google's verified address, or any
  verified address on the GitHub account, or Microsoft's `email` claim when
  `xms_edov` says its domain is verified. Otherwise the person comes back to
  the invite screen, which names the address that answered; nothing is spent
  or created and they can try another account or choose a password. A match
  spends the invitation once, activates the account **with no password**, binds
  the provider account (`linked_via: invite`, audited `auth.oauth.linked` with
  `via: invite`, emailed) and signs them in, with enrolment next when the
  install requires a second factor. Such an account sets a password later
  through the reset flow. An invitation spent between the two steps lands on
  `invite-expired`. The allowed domains and SSO enforcement apply here too.
- **Each identity records how it was linked and when it last signed in**
  (`linked_via`: `sign-in`, `connect` or `invite`; `last_used_at`). The
  security page shows "last used" beside each provider, so a provider account
  somebody else linked and uses stands out. Identities linked before 1.1 show
  no `linked_via`, and "not used to sign in yet" until their next sign-in.
- **Nothing else changes after the first factor.** The second factor, the
  trusted-browser check and enrolment for those who must have one run exactly
  as after a password. Deactivated accounts still cannot sign in.

### Connecting and disconnecting a provider

A signed-in person connects a provider account from **Your account → Security
→ Sign-in methods** (`/settings/account/security`; the card was called "Sign-in providers"
in 1.0.2). The card lists each
provider the install has configured; with none configured it is not shown.
Each row says whether the provider is connected, with the address it had and
the day it was linked, and offers **Connect** or **Disconnect**. Both open a
"Confirm it's you" dialog that takes the current password or a 6-digit code
from the authenticator app. Connect then goes to the provider and back to the
page, which says the provider is connected; a refusal lands on the sign-in
callback screen with its reason. When a provider is the account's only way in,
its Disconnect is disabled and a note under the list says to set a password or
connect another provider first. While nothing is linked, the card explains
that since 1.0.1 a provider signs in only after it is connected here once.

Under the card, the API does the following:

1. `POST /api/auth/oauth/<provider>/connect` with a step-up, either
   `{ "currentPassword": "…" }` or `{ "code": "123456" }` (a live authenticator
   code). It answers `{ "url": "…" }` and sets the `hd_oauth` cookie; the app
   sends the browser to that URL.
2. The provider sends the browser back to the usual callback, which binds
   whichever provider account came back to the person who started the flow
   (the flow's state carries their id), audits `auth.oauth.linked`
   (`via: connect`), emails them, and redirects to `/settings/account/security?connected=<provider>`.
   A provider account bound to somebody else lands on `/oauth/callback` with
   `oauth-identity-conflict`.

`POST /api/auth/oauth/<provider>/disconnect` with the same step-up removes it,
audits `auth.oauth.unlinked` and emails the holder. Both share the step-up rate
limit of the other security-page checks. Connecting is refused with
`sso-required` while single sign-on is enforced; disconnecting is not, since it
only removes a way in. An account with neither a
password nor an authenticator cannot pass the step-up; it sets a password
through the reset flow first. Disconnecting the account's last way in, when it
has no password and no other provider account, is refused with
`oauth-last-sign-in` (409) before the step-up is checked, so the refusal
spends no attempt; the security page disables that button and says why.
`GET /api/auth/oauth/identities` lists the caller's own as
`{ identities, passwordSet }`; `passwordSet` is what the page needs to tell
which provider is the last way in.

1.0.1 added the API, the sign-in screen's message for `oauth-link-required`
and the security notice; 1.0.2 added the security page's card and the
last-way-in refusal. 1.1 (M18-07) adds the allowed Workspace domains, the
callback screens that explain `oauth-link-required` and
`oauth-domain-not-allowed`, and the security notice that names the provider
account and when it changed.

### Microsoft

M18-08 adds Microsoft as a third built-in provider for **one organisation's
work accounts** (Microsoft Entra ID). It is the only provider that goes through
`openid-client` rather than hand-written calls, because it needs OpenID Connect
discovery; discovery, the token request and the key set all go out through the
SSRF-safe client with no redirect followed, and every endpoint discovery names
must be on `login.microsoftonline.com` over HTTPS.

One tenant per install. `oauth.microsoft.tenantId` is required and is a GUID;
`common`, `organizations`, `consumers` and the personal-accounts tenant
(`9188040d-6c67-4c5b-b112-36a304b66dad`) are refused as the tenant. That closes the
"nOAuth" hole, where in a multi-tenant app the `email` claim is whatever a
tenant admin typed. What the code checks on every callback:

- **The issuer is exact:** `https://login.microsoftonline.com/<tenant>/v2.0`,
  from discovery of that tenant, and the id token's `iss` must equal it.
- **`tid` equals the tenant.** A token from any other directory answers
  **`oauth-tenant-mismatch`** ("This Microsoft account can't sign in here"),
  says nothing about accounts, and is audited as `auth.sign_in.failed` with
  `reason: tenant-mismatch`.
- **Personal accounts only if you allow them** (below): the one other tenant a
  token may come from is the consumers tenant, with its own exact issuer.
- **The usual:** the id token's signature, audience (your client id), expiry and
  `nonce`, PKCE (S256), the single-use `state` and the `hd_oauth` browser
  cookie. A replayed callback finds its state spent.
- **The subject is `<tid>:<oid>`.** `oid` is stable for the account within the
  tenant, unlike `sub`, which is different for every application, so it
  survives an app re-registration.

**The first link** (an address matching an account that has no Microsoft
identity yet) needs Microsoft to vouch for the address: the token must carry the
`email` claim with **`xms_edov` as the JSON boolean `true`** (the email's domain
owner is verified) **and `acct` as the number `0`** (a member of the tenant,
never a guest). Strings such as `"true"` or `"0"` do not count. Without either,
or without the claim at all, the answer is `oauth-link-required`, as for GitHub:
sign in another way once and connect Microsoft from the security page. A bound
account signs in whatever the token says its address is, and the sign-in name
(`preferred_username`) stands in for a missing `email` only for that, never for
a link. This is the same rule the Entra ID OIDC preset uses for SSO.

**Personal accounts** (`oauth.microsoft.allowConsumers`, off by default; the
checkbox "Also allow personal Microsoft accounts", or
`HD_OAUTH_MICROSOFT_ALLOW_CONSUMERS`). Outlook.com and Hotmail accounts belong
to the consumers tenant. With the setting on, the sign-in starts at Microsoft's
`common` authority, and a token is accepted from the pinned tenant or from the
consumers tenant, each with its own exact issuer; any other work tenant is
`oauth-tenant-mismatch`. Their subject is `<tid>:<oid>` as before. A personal
account **never links by address**, whatever claims it carries (it chose its own
address): its holder signs in another way once, then uses **Connect Microsoft**
on the security page, and after that the button signs them in. Switching the
setting off strands the personal accounts that were connected (below).

Turning personal accounts on **breaks B2B guests of your tenant**: at the
`common` authority a guest authenticates in their home tenant, so their token
names that tenant and the answer is `oauth-tenant-mismatch`. Guests could not
first-link before either (a guest is never vouched for), but a guest who had
connected Microsoft from a session stops being able to use it while the setting
is on. Leave it off if guests need the button.

**Changing the tenant** (or switching personal accounts off) strands the
identities bound to a tenant the install no longer accepts. Nothing is deleted:
a stranded row cannot sign anyone in (a token from the old tenant gets
`oauth-tenant-mismatch`), so leaving it is safe, and deleting it would take a
sign-in method away behind the last-way-in guard. Instead each person's stranded
row is **replaced when they link Microsoft again**:

- with the `email`, `xms_edov` and `acct` claims configured, a verified member of
  the new tenant signs in with the button and is linked by address, replacing
  the old row;
- otherwise they sign in another way once (a sign-in link works for someone with
  no password) and choose **Connect Microsoft** on the security page, which
  replaces it.

The replacement is one transaction: the new row, an audit row
`auth.oauth.identity_replaced` (with the old and new tenant) and the usual
"Microsoft was connected to your account" email through the outbox all commit
together or not at all. Only a person whose existing identity is of a tenant
that is still accepted gets `oauth-identity-conflict`. At boot the api logs one
warning with how many stranded identities exist; it writes and emails nothing.
Until someone reconnects, their security page still lists the Microsoft row
(it does not yet say the tenant is no longer accepted).

Add the optional claims `email`, `xms_edov` and `acct` to the app registration's
ID token (Token configuration → Add optional claim) if you want first links by
address. Without them everyone connects from the security page, which works
the same.

### Upgrading from 1.0

- **Google:** people whose Workspace or Gmail address matches their account
  sign in as before; that sign-in binds their Google account. People who signed
  in with a consumer Google account on a company address get
  `oauth-link-required` and connect it once from Your account → Security.
- **GitHub:** everybody who signed in with GitHub gets `oauth-link-required`
  once. They sign in with their password or a sign-in link, then connect GitHub
  from Your account → Security.
- **Passkeys:** nothing changes until somebody adds one. The first successful
  registration pins the relying party ID to the host of `APP_URL`
  ([The RP ID is pinned](#the-rp-id-is-pinned)), so set `APP_URL` to the address
  staff will keep using before the first passkey is added. If it changes later,
  passkeys pause and every other method keeps working until an install admin
  moves them, which removes every passkey.

### Configuring a provider

The step-by-step setup of each provider's app is [sign-in providers](sign-in-providers.md). An install admin sets these under **Settings → Install → Authentication** (or
with the matching `HD_*` environment variable). The page shows the exact
redirect URLs derived from `APP_URL`. A provider with no client id or client
secret is reported as disabled and its button is not drawn.

Client secrets are write-only: after one is saved the browser receives only
`clientSecretConfigured: true` and a fixed mask. Replacing it opens an empty
field. A value pinned by an `HD_*` variable is marked **Set by environment**
and cannot be changed in admin.

| Setting | |
|---|---|
| `oauth.google.clientId` / `oauth.google.clientSecret` | From the Google Cloud console, an OAuth 2.0 Client ID of type "Web application". |
| `oauth.google.allowedDomains` | **Allowed Workspace domains**: type a domain and press Enter for each. Lower-case host names, at most 20; `HD_OAUTH_GOOGLE_ALLOWED_DOMAINS` takes a JSON array such as `["example.com"]`. |
| `oauth.microsoft.tenantId` | **Directory (tenant) ID**, a GUID from Entra ID → Overview. Required: the button is not drawn without it. `HD_OAUTH_MICROSOFT_TENANT_ID`. |
| `oauth.microsoft.allowConsumers` | **Also allow personal Microsoft accounts**, off by default. Connect-only, never linked by address. `HD_OAUTH_MICROSOFT_ALLOW_CONSUMERS`. |
| `oauth.microsoft.clientId` / `oauth.microsoft.clientSecret` | From an Entra app registration (single tenant, platform Web, the redirect URL below; "accounts in any organizational directory and personal Microsoft accounts" if you turn on personal accounts). The secret is the secret's **value**, shown once when it is created; it expires after at most 24 months and Helpdock cannot see the date, so put it in your calendar. |
| `oauth.github.clientId` / `oauth.github.clientSecret` | From GitHub → Settings → Developer settings → OAuth Apps. |

The redirect URL to register with the provider is
`<APP_URL>/api/auth/oauth/<provider>/callback`, for example:

```
https://support.example.com/api/auth/oauth/google/callback
https://support.example.com/api/auth/oauth/microsoft/callback
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
A revocation of particular families names them in `familyIds`, and only the
sockets of those browsers close ([realtime](realtime.md#revocation)).

## Rate limits

Sliding-window counters in Redis. A fixed window would let an attacker spend the
whole budget at the end of one window and again at the start of the next.

| Bucket | Limit |
|---|---|
| Sign-in password step, per address | 10 failures per 15 minutes |
| Sign-in password, second-factor and passkey sign-in steps, per IP | 100 failures per 15 minutes |
| Passkey sign-in options, per IP (`passkey-signin-options`) | 120 per 15 minutes |
| Options for adding a passkey from the security page (`passkey-options`), per account | 30 per 15 minutes |
| Options for a passkey second factor or enrolment while signing in (`passkey-ceremony-options`), per account | 30 per 15 minutes |
| SSO discovery, per IP (`sso-discovery`) | 20 per minute |
| SSO starts, per IP (`sso-start`) | 20 per minute |
| SSO OIDC callbacks, per IP (`sso-callback`) | 40 per minute |
| SSO SAML ACS, per IP (`sso-saml-acs`) | 40 per minute |
| SSO SAML completion, per IP (`sso-saml-complete`) | 40 per minute |
| SSO SAML metadata, per IP (`sso-saml-metadata`) | 30 per minute |
| Sign-in link, password reset and staff invitation, per address | 5 per 15 minutes |
| Sign-in link and password reset, per IP | 30 per 15 minutes |
| Reading or accepting an invitation, per IP | 30 per 15 minutes |
| Re-proving a credential from inside a session, per account | 5 per 15 minutes |
| "Was this helpful?" on a help center article (`hc-feedback-ip`), per IP and brand | 30 per 15 minutes |

The per-address bucket guards the password and is spent only by the password
step. The per-IP bucket is spent by the password step, by a passwordless passkey
sign-in, and by every second-factor step (TOTP, recovery code, sign-in
enrolment). A second-factor step never spends
or is blocked by the per-address bucket, so junk passwords sent for a known
address cannot lock that person out of an SSO, magic-link or OAuth sign-in. Guesses
at a code are bounded per account: an attempt is reserved atomically, before the
authenticator or recovery code is checked, on the challenge (three attempts) and
on a per-user counter that outlives the challenge, so starting a new challenge
does not buy new tries and a parallel burst cannot get more than three codes
checked. The counter's fifteen minutes slide from the last reservation, so no
three-code allowance renews at a window boundary. A fourth reservation, or a wrong third code, locks the account for
fifteen minutes (`totp-locked`). A correct code spends the challenge in one
atomic step that refuses if the lock landed first, so no session opens after the
lock. Only someone holding a live challenge can spend the counter, and a
sign-in completed through a code, recovery code or passkey second factor clears
it. A passwordless passkey sign-in neither reads nor clears it. In-flight verification reserves a slot atomically so parallel
guesses cannot exceed the limit. A proved password that issues a TOTP or
required-enrolment challenge atomically removes only its own reservation from
both buckets, preserving earlier failures. Abandoning a challenge adds no
password failure. Address failures are cleared, and only the successful attempt
is refunded from the IP bucket, when every required factor has succeeded and a
session opens; nothing else refunds or resets either bucket. Earlier IP failures
remain until they expire.
SSO discovery, starts and callbacks have separate named buckets. Discovery moved
from the shared 20-per-15-minute credential bucket to its own 20-per-minute bucket.

Over a sign-in limit, the answer is HTTP 429 with `error.auth.code` set to
`rate-limited` and a `Retry-After` header in seconds, rounded up until the oldest
counted failure expires (the larger wait if both buckets block). The body is
the same for either bucket and for known and unknown addresses. The sign-in,
TOTP, recovery-code and enrolment screens round this duration up to minutes. A sign-in link or reset request
over its limit still answers 204 and sends nothing.

The per-IP link and reset bucket is separate from the sign-in one, so somebody
asking for many links from an office's address does not lock that office out
of signing in. It stops one source walking many addresses; there is no
CAPTCHA on these forms, since an email goes only to an existing account.

The address is hashed before it becomes a key, so Redis holds no list of who has
tried to sign in here.

The "Re-proving a credential from inside a session" row above is the bucket the security page spends. Signing
in has a spendable challenge — three attempts, then a fifteen-minute lock — and the routes that
re-prove a credential from inside a session have none, so the budget is the
lock. It covers `POST /api/me/password`, `POST /api/me/totp/disable` and
`POST /api/me/recovery-codes/regenerate`.

## Settings

The authentication values below are edited by an install admin under **Settings →
Install → Authentication** and stored in the `settings` table. Any of them can
be pinned from the environment with its `HD_*` name, which also locks it in the
UI ([ARCHITECTURE §4](../planning/ARCHITECTURE.md#4-configuration-model)). The
Viewer toggle remains on **Staff and roles**; the signing key is generated and
is never editable.

| Key | Default | |
|---|---|---|
| `auth.require2fa` | `false` | Require an authenticator for every staff account. Admins and install admins need one either way |
| `auth.magicLinkTtlMinutes` | `10` | Lifetime of a sign-in link |
| `roles.viewerEnabled` | `true` | Whether the read-only Viewer role can be assigned ([staff and roles](staff-and-roles.md#the-viewer-toggle)) |
| `auth.jwtSigningKey` | generated | The ES256 key pair. Secret, generated at first boot, never set by hand |
| `auth.webauthn.rpId` | empty | The passkey RP ID, written by the first passkey registration and not edited ([The RP ID is pinned](#the-rp-id-is-pinned)) |
| `oauth.google.clientId` / `…clientSecret` | empty | Empty disables the button |
| `oauth.google.allowedDomains` | `[]` | Workspace domains whose accounts may use Google sign-in. Empty allows any address Google vouches for |
| `oauth.microsoft.tenantId` | empty | One Entra tenant GUID, in either case. Empty disables the button |
| `oauth.microsoft.allowConsumers` | `false` | Also accept personal Microsoft accounts, connect-only |
| `oauth.microsoft.clientId` / `…clientSecret` | empty | Empty disables the button |
| `oauth.github.clientId` / `…clientSecret` | empty | Empty disables the button |

From `.env`: `APP_MASTER_KEY`, and the two session limits in
[How long a sign-in lasts](#how-long-a-sign-in-lasts).

## Endpoints

| Route | Declaration | |
|---|---|---|
| `GET /api/auth/methods` | `@Public()` | Which ways in this install offers |
| `POST /api/auth/sign-in` | `@Public()` | Email and password |
| `POST /api/auth/totp` | `@Public()` | Answer a second-factor challenge |
| `POST /api/auth/recovery-code` | `@Public()` | Answer it with a recovery code |
| `POST /api/auth/enrolment/start` | `@Public()` | Stage a secret against an enrolment challenge |
| `POST /api/auth/enrolment/confirm` | `@Public()` | Turn it on with a live code; answers the recovery codes and the session |
| `POST /api/auth/magic-link` | `@Public()` | Ask for a sign-in link. Always 204 |
| `POST /api/auth/magic-link/preview` | `@Public()` | Whose account a link opens, without spending it |
| `POST /api/auth/magic-link/consume` | `@Public()` | Spend one; answers like `/sign-in` |
| `GET /api/auth/magic-link/:token` | `@Public()` | A link sent before the confirm screen. Redirects to it, spends nothing |
| `POST /api/auth/exchange` | `@Public()` | One-time code → access token |
| `POST /api/auth/password/forgot` | `@Public()` | Always 204 |
| `POST /api/auth/password/reset` | `@Public()` | Token and a new password |
| `GET /api/auth/oauth/:provider/start` | `@Public()` | Redirects to the provider |
| `GET /api/auth/oauth/:provider/callback` | `@Public()` | Redirects back to the app |
| `GET /api/auth/oauth/identities` | `@Authenticated()` | The caller's connected Google, Microsoft and GitHub accounts, and whether they have a password |
| `POST /api/auth/oauth/:provider/connect` | `@Authenticated()` | Step-up, then the provider URL to connect one |
| `POST /api/auth/oauth/:provider/disconnect` | `@Authenticated()` | Step-up, then removes it. 204; 409 `oauth-last-sign-in` for the last way in |
| `POST /api/auth/refresh` | `@Public()` | The cookie is the credential |
| `GET /api/auth/me` | `@Authenticated()` | The session: user, brands, current brand |
| `POST /api/auth/sign-out` | `@Authenticated()` | This browser |
| `POST /api/auth/sign-out-everywhere` | `@Authenticated()` | Every browser |
| `GET /api/install/settings/authentication` | `@Requires('install:admin')` | Authentication settings, environment locks and OAuth redirect URLs; no secret values |
| `PUT /api/install/settings/authentication` | `@Requires('install:admin')` | Save 2FA, sign-in-link and OAuth app settings; omitted secrets stay unchanged |
| `POST /api/auth/totp/enrol` | `@Authenticated()` | Stage a secret for a QR code |
| `POST /api/auth/totp/confirm` | `@Authenticated()` | Enable it, return recovery codes |
| `GET /api/auth/invites/:token` | `@Public()` | Read an invitation without spending it |
| `POST /api/auth/invites/:token/accept` | `@Public()` | Spend it, and sign in |
| `POST /api/auth/invites/:token/oauth/:provider` | `@Public()` | Start accepting it with a provider: `{ name, locale }` in, `{ url }` out and the `hd_oauth` cookie set. Spends nothing; the callback does |

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

Credential refusal codes include `rate-limited`, `invalid-credentials`, `totp-mismatch`,
`totp-locked`, `challenge-expired`, `recovery-invalid`, `no-account`,
`unavailable` or `password-breached`. The admin turns it into a translated sentence; no user-facing
English crosses that boundary.

## The development install

The first account on a real install is created by [the first-run
wizard](install.md#first-run), which is the only thing an install with no
accounts will show. For development there is a shortcut:

```bash
pnpm build
pnpm --filter @helpdock/api seed:dev
```

It migrates, then creates one brand and one install admin, who enrols an
authenticator at the first sign-in because an install admin must have one. It refuses to run
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

## M11 staff SSO

Install admins manage connections and mappings through `/api/install/sso`.
[Staff SSO](sso.md) documents the configuration, encrypted secrets and OIDC/SAML
protocols. M11-02/M11-03 verify OIDC/SAML and complete already-linked subjects through
the existing local TOTP/session flow. JIT provisioning, role sync and sign-in
enforcement belong to M11-04. Saving enforcement configuration
alone does not disable the existing password, magic-link or OAuth methods.

## Required single sign-on

When `sso.enforced` is on, local password, magic links, Google/Microsoft/GitHub OAuth and
password invitation acceptance refuse sign-in. Discovery matches enabled
provider domains without looking up accounts. Existing sessions stay open.
Configured break-glass install admins may use their password followed by a fresh
authenticator code or a user-verified passkey; trusted browsers, recovery codes
and passwordless passkey sign-in do not qualify. A sign-in that began with an
SSO assertion may still finish with a fresh authenticator code, a passkey or a
single-use recovery code, which is the way back in for a person whose IdP does
not vouch for MFA and who lost the phone their authenticator was on (#387); a
trusted browser may not. Enforcement and
connection status are rechecked for pending challenges. Completing SSO accepts
an invitation only after its required factors and keeps manual membership grants.
See [SSO policy and setup](sso.md#roles-mfa-and-enforcement).
