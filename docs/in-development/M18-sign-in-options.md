# M18 Sign-in options

Status: in development since 2026-10-20 (issues #275 to #287, GitHub milestone “M18 Sign-in options”)
Owner: @Docker-Hunterpedia
Phase: 5 — 1.x. Proposed release: 1.1 (owner decision D-01)
Depends on: M0 (auth, settings, outbox, SSRF-safe client), M4 (CAPTCHA interface, widget), M9 (ASVS walk), M11 (SSO enforcement, break-glass)
Effort: about 32.5 working days for one person, 5–7 weeks (see [Effort summary](#effort-summary))
PRD: [Phase 5 · M18](../planning/PRD.md#m18-sign-in-options)
Owner decisions: D-50 to D-55 in [decisions-1-x.md](../planning/decisions-1-x.md#m18-sign-in-options)
ADRs (proposed): [0050](../decisions/0050-passkeys-for-staff-over-webauthn.md), [0051](../decisions/0051-oauth-identities-bound-by-subject.md), [0052](../decisions/0052-built-in-proof-of-work-captcha.md), [0053](../decisions/0053-break-glass-with-a-passkey.md)

Staff passkeys as a second factor and on their own, Google and GitHub sign-in bound by subject with Microsoft added, and a CAPTCHA that sends nothing to a third party.

**Note on M18-07.** The subject binding of OAuth identities (M18-07,
[ADR 0051](../decisions/0051-oauth-identities-bound-by-subject.md)) is being
implemented ahead of this milestone as a 1.0.1 security fix in a separate pull
request. M18-07 keeps whatever that fix leaves (connect and disconnect from the
security page, the Google domain allow-list, the Microsoft provider) and is
reconciled with it when the fix merges.

---

## What 1.0 already has

Two of the three sign-in options this milestone looks at already ship in 1.0:

| Item | What 1.0 already has | Where |
|---|---|---|
| CAPTCHA | Cloudflare Turnstile (default) and hCaptcha behind one `CaptchaProvider` interface. Each surface (widget first message, hosted web form) has its own toggle. Both fail closed. | [ADR 0003](../decisions/0003-turnstile-default-captcha.md), `packages/channels/src/captcha.ts`, `apps/api/src/captcha/captcha-keys.ts`, M4-03/M4-09 |
| Google and GitHub sign-in | Hand-wired OAuth with PKCE S256, a hashed single-use `state`, the `hd_oauth` browser-binding cookie and a fixed redirect. It matches a verified email to an existing account and never creates one. The second factor still applies afterwards. | M0-05, `apps/api/src/auth/oauth/*`, [authentication guide](../guides/authentication.md) "OAuth" |
| Enterprise SSO | OIDC and SAML 2.0, JIT, group-to-role sync, enforcement with break-glass | M11, [ADR 0026](../decisions/0026-staff-sso-over-saml-and-oidc.md) |
| Passkeys | **Missing.** ASVS 2.3.2 is Partial ("TOTP only; no WebAuthn/FIDO"), and 2.9.1–2.9.3 are N/A for that reason | [asvs-l2](../completed/asvs-l2.md) V2 |
| Microsoft sign-in | **Missing** as a button. Entra ID is supported as an SSO connection | [sso.md](../guides/sso.md) "Microsoft Entra ID (SAML)" |

So the real questions are: add passkeys, harden and extend the existing social
sign-in, and choose the next CAPTCHA provider and where CAPTCHA applies.

Helpdock 1.0 also already has passwords of 12–200 characters, a per-browser
sessions list (ASVS 3.3.4), and an install-scope `auth.*` audit trail with IP
and user agent ([ADR 0022](../decisions/0022-auth-audit-trail-in-install-scope.md)).
Passkeys are the gap.

Prior art: OpenDesk (Apache-2.0) offers passkeys with the copy "sign in with
fingerprint, face or device PIN instead of a password. A passkey counts as
two-factor", and counts a passkey as two factors only when the authenticator
reports user verification. M18 keeps that user-facing promise and makes it
unconditional: the passwordless path *requires* user verification
(`userVerification: 'required'`), so every passkey sign-in really is two
factors, and a key without a PIN is offered only as a second factor after a
password. The en/ar copy on `Admin/Login-Passkey` and
`Admin/Profile-Security-Passkeys` says the same thing in plain words.

---

## Recommendations

### Passkeys (WebAuthn): add, in M18

**As a second factor, beside TOTP rather than replacing it.**

- Any registered WebAuthn credential can answer the challenge that follows a
  password, sign-in link, OAuth or a non-MFA SSO sign-in. User presence is
  enough here, so a security key without a PIN works.
- TOTP stays, for three reasons:
  - Operators already depend on it.
  - Break-glass is defined around it (ADR 0026, decision 10).
  - Some staff work on shared or locked-down machines where they cannot register
    a platform authenticator.
- "Has a second factor" becomes **TOTP enabled OR at least one passkey**. The
  mandatory rule for Admins, install admins and `auth.require2fa` (ASVS 4.3.1)
  is met by either.
- Recovery codes stay. They are issued once, with the account's **first**
  second factor of either kind. They can replace a missing second factor, and
  never a first factor.

**As passwordless primary sign-in, with user verification required.**

- This is a discoverable-credential ("Sign in with a passkey", plus autofill
  through conditional mediation) ceremony with `userVerification: 'required'`.
- An assertion with UV=1 is possession plus a PIN or biometric, which makes it a
  complete multi-factor sign-in. The session is opened with
  `method: 'passkey', secondFactor: 'passkey-uv'`, and no TOTP is asked.
- An assertion without UV is refused on this path. It is not downgraded to a
  first factor. Downgrading such an assertion to a first factor was considered
  and rejected: it adds a third outcome.
- It also satisfies the mandatory-MFA rule for Admins.

**Why this matters for Helpdock specifically:**

- **Phishing resistance is the only property TOTP and email links lack.**
  Support staff are prime phishing targets: they click customer links all day.
  An origin-bound credential cannot be replayed through a lookalike sign-in page.
- **Self-hosted, with no third party.** WebAuthn needs no external service, no
  network egress and no vendor account. It works on air-gapped installs (an
  argument [ADR 0021](../decisions/0021-bundled-breached-password-list.md)
  already made). Google, Microsoft and GitHub sign-in all depend on a US
  provider being reachable and on the user's account there existing. That is
  not a given for every Arabic-speaking operator: sanctioned regions lose access
  to some of these services, and VPN-heavy networks hit more provider risk
  challenges. Passkeys are the strong method that works everywhere.
- It closes ASVS 2.3.2 (Partial to Met) and turns 2.9.1–2.9.3 from N/A into Met.

**Interactions, decided:**

| Situation | Rule |
|---|---|
| Mandatory 2FA (Admin, install admin, `auth.require2fa`) | Satisfied by TOTP or one or more passkeys. The enrolment challenge (`totp-enrolment-required`, renamed `second-factor-enrolment-required` with the old code kept as an alias for one release) offers **Add a passkey** first and **Use an authenticator app** second. Removing the last second factor of an account that must have one is refused (`second-factor-required`). |
| Recovery codes | One shared set per account, drawn at the first second-factor enrolment of either kind. Redrawing them needs a live TOTP code **or** a passkey assertion. A recovery code answers a second-factor challenge only. It never opens a passwordless sign-in, and never break-glass (unchanged). |
| Trusted browser (`hd_trust`) | Unchanged. It skips the second factor after a first factor. It has no role in passwordless sign-in, which needs no second factor. |
| Break-glass under SSO enforcement | Recommended: **password, then a fresh TOTP code or a fresh passkey assertion with UV**. A FIDO key kept in a safe is the textbook break-glass credential, and it is stronger than TOTP. Recovery codes, trusted browsers and passwordless passkey sign-in stay excluded. The enforcement precondition becomes "an active install admin with a password and (TOTP or a passkey)". This amends ADR 0026 (10) through [ADR 0053](../decisions/0053-break-glass-with-a-passkey.md), so the owner must confirm it (D-50). |
| SSO enforced, ordinary staff | Passwordless passkey sign-in is a **local** method and is refused with `sso-required`, like password, magic link and OAuth. Otherwise a person deactivated in the IdP could keep signing in with a passkey forever, because there is no SCIM. The sign-in screen hides the passkey button, and conditional mediation is not started. |
| SSO, not enforced | Passwordless passkey sign-in is allowed, as magic link is today. Passkeys can answer the second factor after an SSO sign-in whose connection does not vouch for IdP MFA. |
| `idp_enforces_mfa` connection | Unchanged: no local second factor is asked. |
| Password reset | It **keeps** passkeys. A reset proves the mailbox only, so letting it delete passkeys would hand an email-only attacker a way to strip the victim's strongest factor. The reset still revokes every session and trusted browser. The `securityChange` email for a reset names how many passkeys the account holds, links to the security page, and says to remove any the holder does not recognise. |
| Admin "reset second factor" (lost devices) | Extended so that it removes passkeys as well as TOTP. Audited, and emailed to the account holder. |
| Deactivation / deletion | A deactivated account cannot sign in by any path (`#isUsable` check, unchanged). Deletion cascades its credentials. |

**Library: `@simplewebauthn/server` 14.0.3 + `@simplewebauthn/browser` 14.0.0.**

These were checked on npm on 2026-10-20 (server 14.0.3 published 2026-09-25,
browser 14.0.0 published 2026-09-02; both MIT; server engines `node >= 20`).
Recheck with Context7 at the PR, per CLAUDE.md.

- The server package depends on `@peculiar/x509 ^2.1.0`, which Helpdock already
  pins for SSO (ADR 0026). It also pulls in `@peculiar/asn1-*` (including
  `asn1-x509-post-quantum`), `@levischuck/tiny-cbor` and `@hexagon/base64`.
- The browser package has **no dependencies**. It goes in the admin bundle only,
  never in the widget.
- Context7 (`/masterkale/simplewebauthn`) confirms the current verify contract:
  - `verifyAuthenticationResponse({ response, expectedChallenge, expectedOrigin, expectedRPID, credential: { id, publicKey, counter, transports }, requireUserVerification })`.
  - It returns `authenticationInfo.{ newCounter, userVerified, credentialBackedUp, credentialDeviceType }`.
  - It throws on counter regression.
- 14.x adds ML-DSA (post-quantum) handling and a `PQCNotSupportedError`. Pin
  `supportedAlgorithmIDs` to `[-8, -7, -257]` (EdDSA, ES256, RS256) so the
  post-quantum path is never entered until it is wanted.
- Read the 13 → 14 changelog when the ADR is accepted; Context7 indexes 13.3 as
  its latest tagged version.
- Alternatives: hand-rolling CBOR and COSE parsing is not acceptable for an
  authenticator. `@passwordless-id/webauthn` is smaller but less deployed.
- This needs an ADR, because ARCHITECTURE §1's Auth row changes.

**RP ID: per install, not per brand domain.**

- **RP ID = the hostname of `APP_URL`. The one expected origin = `APP_URL`'s
  origin.** Staff accounts are install-wide (`users` is in `GLOBAL_TABLES`),
  and the admin is served from `APP_URL` alone. Brand help-center domains are
  separate registrable domains, and staff never sign in there: the help center
  receives a one-use pass from the admin.
- Related Origin Requests (`/.well-known/webauthn`) cap a credential at five
  distinct registrable-domain labels. That is no basis for a multi-brand
  product, and it is not needed for staff.
- **Pin the RP ID** in a setting, `auth.webauthn.rpId`, written at first use.
  If `APP_URL`'s host later differs:
  - passkey ceremonies are refused, with `passkeys-rp-changed`;
  - the System page and Settings › Authentication show a warning Banner;
  - password, TOTP and the other methods keep working;
  - staff re-register their passkeys.

  Silently orphaning every credential would be worse.
- WebAuthn needs a secure context. Passkeys are available when `APP_URL` is
  https, or `http://localhost` for development. On any other plain-http install
  `GET /api/auth/methods` reports `passkey: false`.
- The expected origin and RP ID always come from `APP_URL`, never from `Host`
  or `Origin` headers. Behind Caddy that means no header trust is involved.

**Attestation: `none`.**

- Request `attestation: 'none'`, keep no AAGUID allow-list and no metadata
  service (FIDO MDS is a network dependency and a privacy leak).
- Store the AAGUID when the browser sends one, for display only.
- A self-hosted, privacy-first product has no business learning the make of a
  staff member's phone. Enterprises that need certified-hardware policies can
  enforce them at their IdP, which they put in front of Helpdock with SSO.
- `none` also keeps the attestation-statement parsers (the riskiest code in any
  WebAuthn library) off the hot path.

**Other parameters:**

- **Registration:**
  - `residentKey: 'preferred'` with the `credProps` extension, so the stored
    `discoverable` flag is known; `userVerification: 'preferred'`.
  - `excludeCredentials` lists the account's existing credentials.
  - At most 10 passkeys per account.
  - The user handle is 32 random bytes per user, stored in a new
    `users.webauthn_user_handle` column. It is not the UUIDv7 id, which leaks
    the account's creation time.
- **Display name:** the person's name; the RP `name` is "Helpdock".
  Authenticators truncate around 64 bytes, which is about 30 Arabic characters,
  so the name is truncated on a UTF-8 code-point boundary before it is sent.
- **Counter:** stored and checked only when non-zero; synced passkeys report 0.
  A regression is refused and audited as `auth.passkey.counter_regressed`.
- **Backup state:** BE/BS flags are stored and shown as a "Synced" chip. They
  are not used for policy in M18.
- **Ceremony state:**
  - Kept in Redis with `GETDEL`, TTL 5 minutes, keyed by a 256-bit id.
  - The challenge is 32 random bytes.
  - The record names its purpose (`register`, `second-factor`, `passwordless`,
    `step-up`, `break-glass`) and, where there is one, the user and the session
    family. A challenge minted for one purpose cannot complete another (the
    rule the magic-link and reset tokens already follow).

### Google, Microsoft and GitHub sign-in

#### Staff: keep Google and GitHub, harden them, and add Microsoft (work accounts), in M18

**First, what "social" means here, versus SSO.**

| | Sign-in buttons (M0-05, extended) | SSO connection (M11) |
|---|---|---|
| Who it is for | Small teams with no IdP admin, or people who already live in Google, GitHub or Microsoft 365 | Organisations that want JIT, group-to-role sync, enforcement and IdP MFA |
| Creates accounts | **Never.** It signs in people who were invited | JIT, by mapping |
| Roles | Set by hand on Staff | Synced from groups |
| Enforceable | No | Yes, with break-glass |
| Protocol | Fixed endpoints, hand-wired (Google via OIDC, GitHub OAuth 2) | Generic OIDC / SAML |

- Google Workspace and Microsoft Entra **as organisations** belong in SSO. M18
  adds **presets** to the SSO connection form (M18-09). A preset pre-fills the
  issuer or discovery URL, claim names and hints for a Google Workspace OIDC or
  an Entra ID OIDC connection. It is a form convenience, not a new protocol.
- The buttons remain a separate, simpler path for teams that just want
  "Continue with Google".
- GitHub is OAuth 2.0, not OIDC: no ID token and no `sub` claim in a JWT, only
  `GET /user` with a numeric `id`. So it **cannot** be an SSO preset. It stays a
  hand-wired button, as today.

**The hardening is the main value of this item.**

Today `completeOauth` looks up `staff.findByEmail(identity.email)` on every
sign-in. No identity link is stored. That is the same class of weakness #219
fixed for SSO ("email linking could hand an already-linked account to another
identity"), and here it is wider:

1. **Stale verified emails.**
   - GitHub keeps an address "verified" after its owner loses the mailbox, for
     example after leaving the company.
   - A consumer Google account can be registered on a non-Gmail address, which
     is verified once at creation.
   - Either can later sign in as whoever holds that address in Helpdock. The
     second factor limits the damage only for accounts that have one.
2. **No subject binding.** If the provider account behind an address changes,
   because the address was recycled or edited, the new account signs in
   silently.
3. **Google `hd` is not checked.** There is no way to restrict Google sign-in to
   the operator's Workspace domain.
4. **Microsoft (when added) has the nOAuth problem.** In multi-tenant Entra apps
   the `email` claim is admin-editable and unverified. It must not be trusted
   without `xms_edov` or a pinned tenant.

**Rules (they mirror #219):**

- **Bind by `(provider, issuer, subject)`.** These go in a new install-scope
  table, `user_oauth_identities`. A bound identity signs in whatever its email
  currently says. Following the #219 rule, an unverified email never blocks an
  existing link, but it can never create one.
- **A first link needs proof, and is the only time email is used.** An unbound
  provider identity links to an account only when all of these hold:
  - the account has **no** identity for that provider yet;
  - the provider says the email is verified;
  - the provider is **authoritative** for that address:
    - **Google:** `email_verified === true` **and** either the `hd` claim
      equals the email's domain (a managed Workspace account) or the address is
      `@gmail.com` / `@googlemail.com`. A consumer Google account on a
      third-party address is not authoritative.
    - **Microsoft:** the tenant is pinned (see below) and either `xms_edov ===
      true` or the account is a personal Microsoft account in the consumers
      tenant `9188040d-6c67-4c5b-b112-36a304b66dad`, if consumers are allowed
      at all (D-52).
    - **GitHub:** **never** authoritative. GitHub verified emails are not
      evidence of current mailbox control, so a GitHub identity links only from
      inside a session (Security › Sign-in methods › Connect) or while accepting
      an invitation.
  - Otherwise the callback answers the new code `oauth-link-required`. The
    sign-in screen says, in en and ar: "Sign in another way once, then connect
    this account from your security page."
- **Connecting from a session** costs a step-up: the current password, a TOTP
  code or a passkey assertion. It writes `auth.oauth.linked` and sends a
  `securityChange` email. Disconnecting needs the same step-up, and is refused
  if it would leave an account with no first factor at all. A passkey counts as
  a first factor.
- **Invitation acceptance with a provider** binds that identity, because the
  invite token already proved the mailbox. This matches DOMAIN-RULES §12,
  "Activate: sets password or OAuth link".
- **Migration for 1.0 installs.** People who sign in with Google today by email
  match keep working through the first-link rule. Their first sign-in after the
  upgrade binds the subject, provided Google is authoritative for the address.
  GitHub users re-link once from the security page. The release notes say so.
- **Domain and tenant allow-lists** (install settings, editable in Settings ›
  Authentication, pinnable by `HD_*`):
  - `oauth.google.allowedDomains`: a list of `hd` values. Empty means any
    authoritative Google address; a non-empty list refuses `@gmail.com`.
  - `oauth.microsoft.tenantId`: **required** and a GUID. One tenant per install
    in M18; `organizations` and `common` are refused, which removes the
    templated-issuer and nOAuth questions. `oauth.microsoft.allowConsumers`
    (default `false`, consumers tenant only) is an open question (D-52).
  - GitHub organisation restriction needs the `read:org` scope and a membership
    call. Deferred (D-53).
- **No account is ever created** by a button. That is unchanged.
- **Microsoft implementation:** through `openid-client` 6.x, already in the
  stack for SSO, with `customFetch` → `safeFetch`. Discovery comes from
  `https://login.microsoftonline.com/<tenantId>/v2.0`, so the issuer is exact.
  The code validates `tid === tenantId`, PKCE, `nonce` and `state`, and binds
  the browser with `hd_oauth` as the other two providers do. Scopes:
  `openid email profile`.
- **Provider mark:** [DESIGN.md §5](../../DESIGN.md#5-iconography) says "No
  other brand mark is drawn anywhere" beyond Google and GitHub. The Microsoft
  button needs a one-line DESIGN.md amendment to add an inline monochrome
  Microsoft mark in `apps/admin/src/ui/provider-marks.tsx`, under the same rules.

**Self-hosters need their own OAuth app per provider.** One guide section per
provider (M18-12):

- **Google Cloud:**
  - Create an OAuth client of type "Web application", with redirect
    `<APP_URL>/api/auth/oauth/google/callback`.
  - On the consent screen, choose *Internal* for Workspace-only installs, which
    avoids verification. Choose *External* plus *Publish app* otherwise; in
    "Testing" status, sign-in is limited to listed test users.
  - Scopes `openid email profile` are non-sensitive.
- **Microsoft Entra:**
  - App registration, single tenant, Web redirect
    `<APP_URL>/api/auth/oauth/microsoft/callback`.
  - Add a client secret and note its expiry (24 months at most). Put the
    rotation in the operator's calendar, because Helpdock cannot see the
    expiry.
  - Add the optional claim `xms_edov` if they want email-based first link.
- **GitHub:** Settings → Developer settings → OAuth Apps, with callback
  `<APP_URL>/api/auth/oauth/github/callback`. Use a GitHub *OAuth App*, not a
  *GitHub App*.

The settings page already shows the exact redirect URL per provider; it gains
Microsoft.

#### Customers (a future customer portal): add later, with the portal, never in M18

- The customer portal is in the backlog ([PRD §5](../planning/PRD.md#5-post-10-backlog-v11)),
  and visitors have "no login in v1" (REQUIREMENTS §2).
- When it is planned, customer sign-in is **brand-scoped**:
  - credentials and identities live in tenant tables with `brand_id` and FORCEd
    RLS (for example `contact_webauthn_credentials`, `contact_oauth_identities`);
  - the passkey RP ID is the **brand's help-center host** (its custom domain),
    so moving a brand to a new domain orphans its customers' passkeys, and the
    portal plan must say so;
  - OAuth apps are per brand, because the redirect host differs per brand;
  - CAPTCHA goes on the portal's magic-link request.
- None of this shares a table with staff auth.

### CAPTCHA

| Surface | Today | Recommendation |
|---|---|---|
| Widget, before a first message | Turnstile/hCaptcha, opt-in per brand | **Keep.** Add a built-in proof-of-work provider (below), and check the token's `hostname` against the brand's allowed widget origins (not checked today: `apps/api/src/widget/widget-conversations.service.ts` and `apps/api/src/web-form/web-form-public.service.ts` ignore `verdict.hostname`). |
| Hosted web form | Turnstile/hCaptcha toggle | **Keep.** Same additions, with `hostname` checked against `APP_URL` or the brand's verified domain. |
| Staff sign-in after failures | Sliding-window limits (5 per address, 20 per IP per 15 min), a three-attempt challenge lock, same answer for unknown and locked accounts. ASVS 2.2.1 Met | **Don't add.** It would put a third-party script into the admin's CSP on the most sensitive page, and add a vendor dependency to staff sign-in, which self-hosters must be able to reach offline. The existing limits already meet ASVS L2, and passkeys remove the password-spraying target for staff who adopt them. Revisit only if `rate_limit_refusals_total` shows real spraying. |
| Sign-in link / password reset request | 5 per address per 15 min; an email is sent only to existing accounts; always 204 | **Don't add CAPTCHA. Add a per-IP bucket** (e.g. 30 per 15 min). Today one IP can request across many addresses: the cost is bounded to real staff inboxes but still annoying. |
| Help-center article feedback | Deduplicated per visitor cookie per day; the comment (≤ 1,000 chars) is read by staff only | **Don't add CAPTCHA.** Add a per-IP rate limit on the vote and comment POST. A CAPTCHA on a "Was this helpful?" button costs more votes than it saves. |
| Future customer-portal magic-link request | n/a | **Add later**, with the portal. It is public and emails contacts. |

**Provider choice for self-hosted, privacy-first and Arabic-speaking users:**

- **Turnstile:**
  - Free, usually invisible, localised (Arabic included).
  - Sends visitor signals to Cloudflare, a US processor.
  - Challenges harder on VPN, Tor and some regional ASNs, which is a real
    false-positive risk for visitors in the region who route through VPNs.
  - Keep it as the "best bot detection" option.
- **hCaptcha:** a similar trade-off (a US/EU processor, puzzles more often).
  Keep as the alternative.
- **reCAPTCHA:** stays rejected (ADR 0003).
- **Proof-of-work (ALTCHA-style): add as the third provider, `pow`, in M18.**
  ADR 0003 named it "a good candidate for a third provider behind the same
  interface once that interface has proven itself", and it has now, across M4
  and M9.
  - No third party, no visitor data leaves the install, and no CSP host is
    added.
  - Nothing to solve or see. That makes it the most accessible of the three, a
    real gain over puzzle CAPTCHAs (WCAG and DESIGN §10).
  - It works on air-gapped installs and in regions where Cloudflare or hCaptcha
    is unreliable.
  - **Limits** (from ADR 0003): it raises the cost of naive floods, not
    of a determined or paid attacker. It taxes low-end phones, so the default
    difficulty is low: about 0.5–1 s on a 2020 mid-range Android, set by
    `maxnumber`. It is defence in depth on top of the origin check, signed
    identity and per-visitor/per-IP limits, never a replacement.
  - **Implementation: no new dependency.**
    - The server signs `{ algorithm: 'SHA-256', challenge, salt, maxnumber, expires }`
      with HMAC-SHA256 under a key derived from `APP_MASTER_KEY` (HKDF, like
      the pepper and the trusted-browser MAC).
    - The client finds `n` such that `SHA-256(salt + n) === challenge`, using
      WebCrypto in a few hundred bytes in a lazy widget chunk and inline in the
      server-rendered web form page.
    - Verify recomputes, checks the HMAC and `expires`, and spends the
      challenge once through a Redis `SET NX` keyed by its hash (TTL =
      remaining validity).
    - The payload is ALTCHA-protocol-compatible, so an operator could swap in
      the ALTCHA widget later.
    - The considered alternatives are `altcha-lib` 2.6.0 (MIT, zero
      dependencies; published 2026-10-05, too new to pin today, 2.5.0 being the
      last version over two weeks old) and the `altcha` web component 3.4.1,
      whose 3.9 MB unpacked size needs measuring against the 40 KB widget
      budget. Recorded in the ADR; rejected for the same reason ADR 0021 kept
      the breached list in-house: about 80 lines of `node:crypto` beat a
      dependency here.
  - **Default when an admin enables CAPTCHA:** recommended to become `pow` (the
    privacy default), with Turnstile as the "stronger bot detection" choice.
    That changes ADR 0003's default, so it needs the owner's confirmation
    (D-51). Existing brands keep their provider.

---

## Goal

Staff can sign in with a phishing-resistant passkey, as a second factor or on
its own. The existing Google and GitHub buttons can no longer hand an account to
a provider identity that never proved it owns it. Microsoft work accounts get
the same button. Operators who cannot send visitor data to a CAPTCHA vendor get
a CAPTCHA that sends nothing anywhere.

## Scope

- WebAuthn registration, second factor, passwordless sign-in, step-up and
  break-glass for staff.
- The `user_oauth_identities` binding, first-link rules, connect and disconnect,
  and the Google `hd` allow-list.
- A Microsoft single-tenant provider.
- Google Workspace and Entra ID presets in the SSO connection form.
- The `pow` CAPTCHA provider, a CAPTCHA hostname check, and per-IP limits on
  sign-in-link and reset requests and on help-center feedback.
- Docs, ASVS re-walk of V2/V3, en/ar artboards, and tests.

## Non-goals

Backlog or never:

- Any customer or visitor login: the customer portal stays in the backlog.
- Account creation through any button.
- SCIM and single logout (still backlog).
- Attestation verification, AAGUID allow-lists, FIDO MDS.
- Related Origin Requests and multiple RP IDs.
- Per-brand OAuth apps.
- Multi-tenant Microsoft (`common`/`organizations`).
- GitHub organisation restriction (D-53).
- SMS or email OTP as a factor.
- CAPTCHA on staff sign-in.
- A "require phishing-resistant MFA for Admins" policy (D-55).
- Passkeys on the widget or help center.
- Native-app passkeys.

## Deliverables

| Id | Deliverable | Spec | Effort (d) | Depends on |
|---|---|---|---|---|
| M18-01 | **WebAuthn foundation.** `webauthn_credentials` table (install scope, `GLOBAL_TABLES`); `users.webauthn_user_handle`; `auth.webauthn.rpId` pinned at first use and the `passkeys-rp-changed` refusal; a Redis ceremony store (`GETDEL`, 5 min, purpose-bound); a thin `WebAuthnService` over `@simplewebauthn/server` 14.0.3 (RP from `APP_URL`, algorithms `[-8,-7,-257]`, attestation `none`); `methods().passkey`; ADR 0050; ARCHITECTURE §1 Auth row | A §1, §7; D §1.5; ADR 0050 | 3 | — |
| M18-02 | **Register and manage passkeys.** `GET/POST/PATCH/DELETE /api/me/passkeys` (begin/finish, rename, remove) with step-up (password, TOTP or existing passkey; 5-per-15-min budget), at most 10 per account, `excludeCredentials`, last-factor refusal, audit `auth.passkey.added/.renamed/.removed`, `securityChange` email (en/ar) | ASVS 2.2.3, 2.5.5, 3.7.1 | 2.5 | M18-01 |
| M18-03 | **Passkey as a second factor.** The challenge answers `POST /api/auth/passkey/second-factor/{options,verify}` beside TOTP and recovery codes, sharing the three-attempt budget and lock; the enrolment challenge accepts a passkey (`second-factor-enrolment-required`, old code aliased); `isSecondFactorRequired` / "has a factor" = TOTP OR passkey; recovery codes issued with the first factor of either kind; redraw by TOTP or passkey; admin "reset second factor" removes passkeys too | ASVS 4.3.1, 2.5.7, 2.6.1 | 3 | M18-01, M18-02 |
| M18-04 | **Passwordless sign-in.** `POST /api/auth/passkey/{options,verify}`: discoverable, UV required, no `allowCredentials`, same refusal (`invalid-credentials`) for unknown credential, bad signature, deactivated or no-brand account; per-IP budget shared with sign-in; counter check; `last_used_at`; audit `method: passkey, secondFactor: passkey-uv`; refused under SSO enforcement (`sso-required`) | ASVS 2.2.1, 3.2.1; D §1.6 | 2.5 | M18-01, M18-03 |
| M18-05 | **SSO and break-glass integration.** The break-glass form accepts password plus fresh TOTP **or** passkey (UV) (pending the owner, D-50); the enforcement precondition becomes TOTP or passkey; pending challenges recheck enforcement; ADR 0053 (amends ADR 0026) | ADR 0026 (10), ADR 0053 | 1.5 | M18-03, M18-04 |
| M18-06 | **Admin passkey screens.** Sign-in: a "Sign in with a passkey" button and conditional mediation on the email field (`autocomplete="username webauthn"`), with cancelled, unsupported and RP-changed states. Second-factor screen: a passkey option. Enrolment chooser. Security › Passkeys card with add, rename and remove dialogs and a step-up dialog. Settings › Authentication: passkeys status and RP ID. `@simplewebauthn/browser` 14.0.0 in the admin bundle only. Lucide `KeyRound`. en/ar | DESIGN §6, §10 | 4 | M18-02 to M18-05 |
| M18-07 | **OAuth identities bound by subject.** `user_oauth_identities` (install scope); first-link-only rules per provider (Google `hd`/gmail, GitHub never by email); `oauth-link-required`; connect and disconnect from Security › Sign-in methods with step-up and email; binding at invitation acceptance; `oauth.google.allowedDomains`; migration behaviour for 1.0 users; audit `auth.oauth.linked/.unlinked`; ADR 0051. The binding itself lands early as a 1.0.1 security fix; this deliverable keeps what that fix leaves | #219 rules; D §12; ADR 0051 | 3.5 | — |
| M18-08 | **Microsoft sign-in.** A third built-in provider via `openid-client` 6.x + `safeFetch`; `oauth.microsoft.{tenantId,clientId,clientSecret}` (secret write-only, `HD_*` pinnable); an exact issuer, a `tid` check, `xms_edov` for first link; provider mark (DESIGN §5 amendment); a stand-in IdP for tests | A §7; D §13 | 2.5 | M18-07 |
| M18-09 | **SSO presets.** "Google Workspace (OIDC)" and "Microsoft Entra ID (OIDC)" presets in the connection form: discovery URL template, email and group claim names, domain hint, links to the guide sections. Form only, no protocol change | ADR 0026 | 1.5 | — |
| M18-10 | **Proof-of-work CAPTCHA provider.** `pow` in `CAPTCHA_PROVIDERS`: an HMAC-signed challenge under an HKDF key from `APP_MASTER_KEY`, single-use spend in Redis, expiry, difficulty setting (`low`/`medium`), WebCrypto solver in a lazy widget chunk and in the web form page, en/ar copy for the "Checking…" and failure states; widget size check stays green; ADR 0052 | ADR 0003, ADR 0052; R §5.1 | 3 | — |
| M18-11 | **CAPTCHA and abuse hardening.** Verify Turnstile/hCaptcha `hostname` against the brand's widget origins or the web form host; Turnstile `action` per surface (`widget-first-message`, `web-form`); a per-IP bucket on sign-in-link and reset requests; a per-IP limit on help-center feedback POSTs; `rate_limit_refusals_total` labels | ASVS 11.1.4, 2.2.1 | 1.5 | — |
| M18-12 | **Docs.** `authentication.md` (passkeys, OAuth binding, Microsoft, rate limits), `sso.md` (presets, break-glass), `staff-and-roles.md` (Security page, enrolment), a new `docs/guides/sign-in-providers.md` (Google, Microsoft, GitHub app setup, step by step), the CAPTCHA section of `channels.md`/`web-form.md`, the configuration reference, `.env.example`, the release note on GitHub re-linking and RP-ID pinning, ARCHITECTURE §1/§7, DOMAIN-RULES additions (below) | A §2 | 2.5 | all |
| M18-13 | **Security pass.** Re-walk ASVS V2/V3 rows (below) in `asvs-l2.md`; run the `security-audit` skill on the diff; negative tests listed below green; threat-model notes in the milestone doc | M9-02 | 1.5 | all |

## Data model

One migration, numbered with the next free number at implementation time
(`0054_imports` is the last shipped).

```
users
  + webauthn_user_handle  bytea  unique  null    -- 32 random bytes, drawn at first registration

webauthn_credentials                              -- install scope, GLOBAL_TABLES
  id               uuid pk (uuidv7)
  user_id          uuid not null  references users(id) on delete cascade
  credential_id    bytea not null unique          -- rawId; ≤ 1023 bytes per spec
  public_key       bytea not null                 -- COSE key
  algorithm        integer not null               -- -8 | -7 | -257
  sign_count       bigint not null default 0
  transports       text[] not null default '{}'
  aaguid           uuid null                      -- display only
  discoverable     boolean null                   -- credProps.rk
  backup_eligible  boolean not null
  backed_up        boolean not null
  name             varchar(80) not null           -- user-chosen, rendered in <bdi>
  created_at       timestamptz not null default now()
  last_used_at     timestamptz null
  index (user_id)

user_oauth_identities                             -- install scope, GLOBAL_TABLES
  id               uuid pk (uuidv7)
  user_id          uuid not null references users(id) on delete cascade
  provider         oauth_provider not null        -- google | github | microsoft
  issuer           text not null                  -- https://accounts.google.com | https://github.com | https://login.microsoftonline.com/<tid>/v2.0
  subject          text not null                  -- sub | GitHub numeric id | Entra oid+tid (see note)
  email_at_link    text not null                  -- for display and audit, never for matching
  linked_via       text not null                  -- session | invite | first-sign-in
  created_at, last_used_at
  unique (issuer, subject)
  unique (user_id, provider)                      -- one identity per provider per account (as #219)
```

**Why user-scoped and install-wide, not brand-scoped:**

- A passkey or an OAuth link belongs to a **person**, and a staff person is
  install-wide. `users` is already in `GLOBAL_TABLES` ("sign-in happens before
  any brand is known"), as are `user_sso_identities` (ADR 0026),
  `notification_prefs` and `push_subscriptions`.
- The passwordless lookup runs on `credential_id` **before** any principal or
  brand exists. A `brand_id` column would either be a lie (which brand?) or
  force one row per brand for one physical key.
- This is the reasoning ADR 0022 applied to auth audit rows.

**How the rule "a table is on one of the two lists or it is a mistake"
(`packages/db/src/rls.ts`) is honoured:**

- Both tables are added to `GLOBAL_TABLES` with their reasons, so the existing
  registry test fails if either is forgotten.
- Access goes through two paths only:
  1. the `auth` system principal on the pre-session sign-in path (lookup by
     `credential_id`, or by `(issuer, subject)`);
  2. the staff self routes under `/api/me/*`, whose repository methods take
     `principal.id` and always filter `WHERE user_id = $principalId`. No route
     accepts a user id for these tables except install-admin "reset second
     factor".
- An owner-only RLS policy (the `OWNER_SCOPED_TABLES` shape) was considered and
  rejected. The sign-in path has no `app.principal_id` yet, so the policy would
  need a system exemption that covers exactly the dangerous path, and `users`
  itself has no such policy. Integration tests carry the guarantee instead.
- Microsoft subject: use `oid` with `tid` (stable per tenant), not `sub`, which
  is pairwise per application. Either works with a pinned single tenant; `oid`
  survives an app re-registration.

## Domain rules to add or change (proposed)

These land in DOMAIN-RULES with the deliverables that implement them, not now.
Proposed as a new **§12.1 Staff authentication factors** (section number
provisional, fixed in the PR that lands it):

1. **Factors.**
   - First factors: password, sign-in link, OAuth identity, SSO assertion,
     passkey (UV).
   - Second factors: TOTP, passkey (UP or UV), recovery code (substitute only),
     trusted browser (skip only).
   - A passkey assertion with UV is both factors. Without UV it is a second
     factor only.
2. **Having a second factor** means TOTP is enabled or at least one passkey is
   registered. An account that must have one (Admin, install admin,
   `auth.require2fa`) cannot remove its last one.
3. **Passkey origin.** RP ID and origin come from `APP_URL` alone and are pinned
   at first use. A ceremony is spent when it is checked, success or failure,
   and is bound to one purpose and, where one exists, one user and one session
   family.
4. **No enumeration.**
   - Passwordless options are the same for every caller and name no
     credentials.
   - `allowCredentials` is sent only after a first factor is proven.
   - Unknown credential, bad signature, counter regression and unusable account
     all answer `invalid-credentials`.
5. **Adding or removing a credential or a linked identity** needs a step-up
   (password, TOTP or passkey) and sends the holder a `securityChange` email.
   Password reset never removes passkeys or identities.
6. **OAuth identities** bind by `(issuer, subject)`. Email is used once, for a
   first link, only when the account has no identity for that provider and the
   provider is authoritative for the address (Google: Workspace `hd` or Gmail;
   Microsoft: pinned tenant plus `xms_edov`; GitHub: never). Buttons never
   create accounts.
7. **SSO enforcement** refuses every local first factor, passkeys included,
   except break-glass: password plus a fresh TOTP code or a fresh passkey
   assertion (D-50).
8. **CAPTCHA tokens** are valid only for the brand, surface and hostname they
   were issued for. A proof-of-work challenge is spent once.

§1.6 negative tests gain:

- one account cannot list, rename or delete another's passkey or identity;
- a ceremony of one purpose cannot complete another;
- a challenge cannot be replayed;
- passwordless sign-in under enforcement fails;
- a GitHub email cannot first-link;
- a second subject for a bound provider is refused.

## Security analysis

**Phishing resistance.**

- Passkeys bind to `APP_URL`'s origin, so a lookalike domain receives nothing
  usable. This is the main gain over TOTP and links, which a real-time phishing
  proxy relays.
- The protection is lost if `APP_URL` itself is compromised (XSS in the admin
  can drive `navigator.credentials.get` for the real origin). The existing
  strict CSP and the sanitiser
  ([ADR 0007](../decisions/0007-html-sanitizer.md)) remain the control.
- OAuth and SSO phishing resistance is the provider's own.

**Account takeover through social login.**

- The current email match on every sign-in is the open risk: a stale verified
  GitHub or Google address, or a recycled address.
- M18-07 closes it with subject binding plus first-link-only, plus provider
  authority (#219's lesson applied to the buttons).
- Microsoft nOAuth is closed by pinning a single tenant and requiring
  `xms_edov` for email-based first link.
- Residual risk: a takeover of the provider account itself (a Google account
  hijack) signs in as the linked user. The local second factor still applies,
  unless the account uses only OAuth plus a trusted browser. Recommend TOTP or
  passkeys for OAuth users, which `auth.require2fa` already enforces.

**Persistence after compromise.**

- An attacker with a session could register their own passkey or link their own
  Google account.
- Mitigations:
  - a step-up for each (a session alone is not enough);
  - an email to the holder;
  - an audit row with IP and user agent;
  - the Security page lists every passkey and identity with last use;
  - the reset email names the passkey count.
- Password reset deliberately does not delete them (see [Passkeys](#passkeys-webauthn-add-in-m18)).
  "Sign out everywhere" does not either, and the docs say so.

**Enumeration.**

- Discoverable sign-in takes no username.
- `allowCredentials` is never sent before the first factor.
- Error answers and the work done are uniform: an unknown `credential_id` still
  parses the response. Signature verification is skipped for a missing key, so
  timing differs by about 1 ms. That is accepted and noted, because the
  `credential_id` is a 16–64-byte random value an attacker cannot guess.
- OAuth `oauth-link-required` is given only after the provider proved the
  identity, and it does not say whether a Helpdock account exists: the same
  code is used for "no account". It replaces `no-account` for unbound
  identities.

**Lock-out.**

- Losing every passkey falls back to recovery codes or an admin reset (ASVS
  2.5.7 stays Partial for its existing identity-proofing reason).
- RP ID drift (an `APP_URL` change) is detected and reported, not silent.

**Supply chain.**

- `@simplewebauthn/server` brings CBOR and ASN.1 parsers (`@peculiar/asn1-*`,
  `tiny-cbor`) onto an unauthenticated endpoint. Pin it, add it to the CI
  dependency audit, and fuzz `verify` with malformed `authenticatorData` and
  `clientDataJSON` in unit tests.
- `attestation: 'none'` avoids most of the attestation format parsers.

**CAPTCHA.**

- Proof-of-work is cost, not detection. The tests assert that it never replaces
  the origin check or the rate limits.
- The hostname check stops a token minted on another site that shares the same
  site key.

## ASVS 4.0.3 rows affected

In [asvs-l2.md](../completed/asvs-l2.md):

| Row | Now | After M18 |
|---|---|---|
| 2.2.1 Anti-automation | Met | Met, extended: passkey endpoints share the sign-in budgets; per-IP buckets on link and reset requests |
| 2.2.3 / 2.5.5 Notify on authenticator change | Met | Met, extended to passkey add/remove and OAuth link/unlink |
| 2.3.2 Hardware/FIDO authenticator enrolment | **Partial** | **Met** |
| 2.5.6 / 2.5.7 Recovery | Met / Partial | Met / Partial (unchanged reason). Recovery codes cover passkeys; admin reset removes passkeys |
| 2.6.1–2.6.3 Lookup secrets | Met | Met (one shared set) |
| 2.9.1 Crypto keys stored securely | N/A | Met: the private key never leaves the authenticator; only the public key is stored |
| 2.9.2 Challenge nonce ≥ 64 bits | N/A | Met: 256-bit challenge, single use |
| 2.9.3 Approved algorithms | N/A | Met: EdDSA, ES256, RS256 only |
| 3.2.1 New session on authentication | Met | Met, passkey path included |
| 3.7.1 Re-authentication before sensitive changes | Met with a note | Met: step-up for passkey add/remove and identity link/unlink |
| 4.3.1 Admin MFA | Met | Met, by TOTP or passkey |
| 7.1.3 Security events logged | Met | Met: `auth.passkey.*`, `auth.oauth.linked/.unlinked`, `method: passkey` |
| 11.1.4 Anti-automation (business) | Met | Met: `pow` provider, hostname check, feedback limit |
| 13.2.3 CSRF | Met | Met: WebAuthn and connect routes are JSON POSTs under `/api/auth` and `/api/me` with a Bearer token or a purpose-bound ceremony id; the OAuth connect callback keeps `hd_oauth` |

## Design artboards

Drawn by the orchestrating session on the design canvas before delegation; en
and ar each.

| Artboard | For | What |
|---|---|---|
| `Admin/Login-Passkey`, `-AR` | M18-06 | Amends `Admin/Login`: passkey button, autofill hint, states (cancelled, unknown, unsupported browser, RP changed); hidden under SSO enforcement (`Admin/Login-SSO`) |
| `Admin/Login-Providers`, `-AR` | M18-07, M18-08 | Google, Microsoft and GitHub buttons; the `oauth-link-required` message with its next step |
| `Admin/SecondFactor`, `-AR` | M18-03 | Amends `Admin/TOTP`: "Use your passkey" first when the account has one, then authenticator code, then recovery code; shared attempt counter |
| `Admin/Enrol2FA-Choose`, `-AR` | M18-03, M18-06 | Amends `Admin/Enrol2FA`: choose a passkey or an authenticator app; the passkey path ends on the existing recovery-codes step |
| `Admin/Profile-Security-Passkeys`, `-AR` | M18-02, M18-06 | Passkeys card: name in `bdi`, created, last used, "Synced" chip; add, rename, remove and step-up dialogs; last-factor refusal; empty state |
| `Admin/Profile-Security-SignInMethods`, `-AR` | M18-07 | Connected Google/Microsoft/GitHub rows with connect and disconnect, `email_at_link` in `bdi dir="ltr"` |
| `Admin/Settings-Authentication` (amend), `-AR` | M18-01, M18-07, M18-08 | Passkeys status and pinned RP ID with the drift Banner; Microsoft card (tenant id, client id, masked secret, redirect URL); Google allowed domains |
| `Admin/Settings-SSO-Connection` (amend) | M18-09 | Preset picker |
| `Admin/Settings-SSO` (amend) | M18-05 | Break-glass picker copy: "password and authenticator or passkey" |
| `Email/SecurityChange-EN-AR` (amend) | M18-02, M18-07 | Passkey added/removed, sign-in method connected/disconnected, reset email with passkey count |
| `Widget/PreChat-Verify-EN`, `-AR` | M18-10 | Proof-of-work "checking" and failure-with-retry states, no puzzle |
| `HelpCenter/WebForm-Verify-EN`, `-AR` | M18-10 | The same on the API-rendered web form ([ADR 0013](../decisions/0013-web-form-page-rendered-by-the-api.md)) |
| `Admin/Channels-Widget` access card (amend) | M18-10 | Provider select gains "Built-in (no third party)" and difficulty |

**Drawn on 2026-10-20** in the [design canvas](https://claude.ai/artifact/RQd32d1RXK8DST8SKC1VBQ) section “M18 Sign-in options”, en and ar panels on each board. Names that differ from the table: `Admin/Settings-SSO-Connection` and `Admin/Settings-SSO` (amendments) share `Admin/Settings-SSO-M18`; `Email/SecurityChange-EN-AR` is `Email/SecurityChange-M18`; the access-card amendment is `Admin/Channels-Widget-BotProtection`. `Admin/Settings-Authentication` adds one action the plan implies: when the pinned RP ID no longer matches `APP_URL`, an install admin can “Move passkeys to <new host>”, which re-pins `auth.webauthn.rpId` after a confirm that says every existing passkey stops working; it is audited and emails the staff who had one.

DESIGN.md changes in the same PRs:

- §5: the Microsoft provider mark, and Lucide `KeyRound` for passkeys (never the
  FIDO logo, which is a brand mark);
- §6: a `PasskeyRow` component, if the card is not built from existing rows.

## Tests

- **Unit (Vitest, colocated):**
  - `WebAuthnService` option builders: RP from `APP_URL`, algorithms,
    `excludeCredentials`, UV per purpose.
  - Ceremony store purpose binding.
  - The factor policy matrix: required, has factor, last-factor refusal,
    enforcement, break-glass.
  - Counter rule.
  - Name truncation for Arabic.
  - OAuth first-link rules per provider (Google `hd`/gmail/consumer-other,
    GitHub, Microsoft `xms_edov`/tid/issuer).
  - PoW sign, verify, expiry and replay.
  - CAPTCHA hostname check.
  - Malformed-response cases for `verify`.
- **Integration (Testcontainers Postgres + Redis):**
  - Registration then passwordless sign-in end to end, with a software
    authenticator; tests build assertions with `node:crypto` P-256 keys.
  - Second factor after password.
  - A ceremony replay is refused.
  - Cross-purpose use is refused.
  - A deactivated account is refused.
  - A passkey under SSO enforcement is refused.
  - Break-glass with a passkey.
  - Cascade delete.
  - IDOR on `/api/me/passkeys/:id` and identities.
  - `GLOBAL_TABLES` registry.
  - Bound OAuth identity with changed email still signs in.
  - Second subject refused.
  - GitHub email first-link refused.
  - Microsoft against a stand-in IdP: wrong `tid`, missing `xms_edov`.
  - PoW single spend under concurrency.
- **Browser (Playwright, `apps/admin/e2e/`, en and ar, axe):**
  - Chromium's CDP virtual authenticator (`WebAuthn.enable`,
    `WebAuthn.addVirtualAuthenticator` with `ctap2`, `internal`,
    `hasResidentKey`, `hasUserVerification`, `isUserVerified`) covers:
    - add a passkey;
    - sign in with it;
    - the second-factor choice;
    - enrolment by passkey;
    - removal refused for the last factor;
    - the cancel path.
  - Firefox and WebKit run the screens with WebAuthn stubbed as unavailable, to
    check the fallbacks.
  - OAuth link-required screen; connect and disconnect.
  - Widget and web form PoW happy path, plus failure and retry (`apps/widget/e2e/`).
- **CI:** widget size check (the PoW chunk is lazy); dependency audit including
  `@simplewebauthn/*`; coverage gate.

## Docs

- **Guides:** `authentication.md`, `sso.md`, `staff-and-roles.md`, the new
  `sign-in-providers.md`, `channels.md` / `web-form.md` (CAPTCHA), and
  `configuration.md` (generated).
- **Config files:** `.env.example` for new `HD_*` pins (`HD_OAUTH_MICROSOFT_*`,
  `HD_AUTH_WEBAUTHN_*` if any).
- **Planning docs:**
  - ARCHITECTURE §1: Auth row `+ @simplewebauthn/server`.
  - ARCHITECTURE §7.
  - DOMAIN-RULES §12.1 and the §16 change log.
  - REQUIREMENTS §5.1 sentence on auth methods.
  - PRD status board and change log.
- **Records:** `asvs-l2.md` rows; ADRs 0050–0053; release notes (GitHub users
  re-link once; `APP_URL` changes now orphan passkeys).

## ADRs

- **[0050](../decisions/0050-passkeys-for-staff-over-webauthn.md) Passkeys for staff over WebAuthn.**
  The library and its version; RP ID per install, pinned; attestation `none`;
  UV rules per purpose; install-scope table; interaction with TOTP, recovery
  and break-glass. Alternatives: hand-rolled, `@passwordless-id/webauthn`,
  per-brand RP IDs, Related Origin Requests.
- **[0051](../decisions/0051-oauth-identities-bound-by-subject.md) OAuth sign-in identities bound by subject; Microsoft as a third provider.**
  First-link authority per provider; single tenant; `openid-client` for
  Microsoft, hand-wired Google and GitHub kept. Alternatives: keep email
  matching; fold the buttons into SSO connections entirely (rejected: GitHub is
  not OIDC, and small teams would get JIT semantics they do not want);
  multi-tenant Microsoft. The binding is being implemented early as a 1.0.1
  security fix.
- **[0052](../decisions/0052-built-in-proof-of-work-captcha.md) A built-in proof-of-work CAPTCHA provider** (amends 0003).
  In-house HMAC and SHA-256 rather than `altcha-lib`; difficulty; the default
  provider question.
- **[0053](../decisions/0053-break-glass-with-a-passkey.md) Break-glass may use a passkey** (amends 0026).

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| An operator changes `APP_URL`'s host and every passkey stops working | Medium | RP ID pinned; drift detected and shown; other methods keep working; documented in install and release notes |
| A WebAuthn library parser bug on an unauthenticated endpoint | High | Pinned version, CI audit, attestation `none`, malformed-input unit tests, request body size cap on `/api/auth/passkey/*` |
| Locked-out admins after enabling passkey-only habits | Medium | Recovery codes issued with the first factor; admin reset; break-glass keeps TOTP as an option |
| Synced-passkey provider account compromise (iCloud, Google Password Manager) | Medium | Outside Helpdock's control; the "Synced" chip informs; a policy to refuse synced passkeys for admins is backlog |
| 1.0 GitHub users are surprised by `oauth-link-required` | Low | Release note; clear en/ar message with the next step; connect is one click from Security |
| Microsoft single-tenant is too narrow for some operators | Low | They use an Entra SSO connection (M11) or the preset (M18-09) |
| Proof-of-work too slow on low-end phones common among the target users | Medium | Low default difficulty measured on a real mid-range Android; "medium" opt-in; failure state offers retry |
| Turnstile false positives on VPN users in the region | Medium | The `pow` provider exists as the no-third-party alternative; the guide explains the trade-off |
| The virtual authenticator is Chromium-only in Playwright | Low | Other engines test fallbacks; manual pass on Safari and Firefox recorded in the milestone doc |

## Open questions

1. (D-50) **Break-glass:** may a fresh passkey replace fresh TOTP (amends ADR
   0026 (10) through ADR 0053)? Recommended yes.
2. (D-51) **CAPTCHA default:** should `pow` become the default when an admin
   turns CAPTCHA on, with Turnstile as the stronger option? Recommended yes, for
   new brands only.
3. (D-52) **Microsoft consumer accounts** (`allowConsumers`): allow at all?
   Recommended off by default.
4. (D-53) **GitHub organisation restriction** (`read:org` scope): wanted in M18
   or later? Recommended later.
5. (D-54) **Passkey at invitation acceptance** instead of a password (fully
   passwordless accounts from day one): include in M18-04 (+1 day)?
6. (D-55) **"Require phishing-resistant MFA for Admins"** setting: backlog or
   M18 (+1.5 days)?
7. (D-01) **Release vehicle:** does M18 ship in 1.1 or 1.2? The OAuth binding
   change (M18-07) alters behaviour for existing users and wants a minor version
   with a release note. Proposed: 1.1, with the binding itself in 1.0.1.

## Build order

1. M18-01, then M18-02, M18-03, M18-04, M18-05, then M18-06.
2. In parallel once M18-01 lands: M18-07, then M18-08; M18-09.
3. In parallel: M18-10 and M18-11.
4. M18-12 alongside each deliverable; M18-13 last.

## Exit criteria

- [ ] A staff member registers a passkey from Security, signs out and signs in
      with it alone (UV). The session is recorded as `method: passkey`, and no
      TOTP is asked.
- [ ] An Admin with no second factor is sent to enrolment, enrols a passkey,
      receives recovery codes and lands signed in. They cannot remove their last
      factor.
- [ ] After a password, a passkey answers the second factor. A recovery code
      still works. Three failures lock as before.
- [ ] With SSO enforced, passkey sign-in is refused for ordinary staff. The
      break-glass admin signs in with password plus TOTP, and with password plus
      passkey if D-50 is accepted.
- [ ] A ceremony cannot be replayed or used for another purpose. One account
      cannot read or change another's passkeys or identities. Both new tables
      are in `GLOBAL_TABLES`.
- [ ] A 1.0 user who signed in with Google by email signs in after the upgrade
      and is bound by subject. A GitHub identity whose verified email matches an
      account is answered `oauth-link-required` until the user connects it from
      Security. A second subject for a bound provider is refused.
- [ ] A Microsoft work account in the configured tenant signs in to an invited
      account. A token from another tenant, or one without `xms_edov` on first
      link, is refused.
- [ ] A widget and a web form with the `pow` provider accept a solved challenge
      once and refuse a replay. No request leaves the install. The widget stays
      under 40 KB.
- [ ] A Turnstile or hCaptcha token whose `hostname` is not the brand's is
      refused.
- [ ] ASVS 2.3.2 and 2.9.1–2.9.3 are Met in `asvs-l2.md`, with evidence.
- [ ] Every new or changed screen passes Playwright in `en` and `ar` with axe.
      The guides, `.env.example` and ADRs 0050–0053 are merged.

## Effort summary

| Track | Deliverables | Days |
|---|---|---|
| Passkeys | M18-01 to M18-06 | 16.5 |
| Social sign-in | M18-07 to M18-09 | 7.5 |
| CAPTCHA | M18-10, M18-11 | 4.5 |
| Docs and security pass | M18-12, M18-13 | 4 |
| **Total** | | **32.5 days, about 5–7 weeks** with the PRD's assumptions |

The three tracks are independent once M18-01 lands, so CAPTCHA (M18-10, M18-11)
and social sign-in (M18-07 to M18-09) can run in parallel with the passkey
screens.

## Progress

- **M18-11 CAPTCHA and abuse hardening** (#285): in review. The hostname check
  had landed in 1.0.1; this adds the Turnstile `action` per surface
  (`widget-first-message`, `web-form`, refused as `action-mismatch`) and the
  brand as `cData` (`cdata-mismatch`; hCaptcha has neither, so its tokens stay
  bound by host only), a `CaptchaSurface` type M18-10 reuses, the
  `email-dispatch-ip` bucket (30 per 15 minutes per IP on sign-in link and
  reset requests, apart from the sign-in budget), the `hc-feedback-ip` bucket
  (30 per 15 minutes per IP and brand on "Was this helpful?", answered 429),
  and the full list of `rate_limit_refusals_total` bucket labels in the
  operations guide.
- **M18-10 Proof-of-work CAPTCHA provider** (#284): in review. `pow` in
  `CAPTCHA_PROVIDERS` and `captcha.provider`; `captcha.difficulty` (`low`
  50,000 / `medium` 200,000); a per-brand HKDF key, the surface and expiry in
  the salt, single spend by `SET NX`; `GET /api/widget/:brandId/captcha/challenge`
  and `/contact[/<brandId>]/challenge`; the solver in the widget's lazy CAPTCHA
  chunk and inline in the web form; D-51 as a default for brands with no saved
  provider; ADR 0052 updated; artboards `Widget/PreChat-Verify`,
  `HelpCenter/WebForm-Verify`, `Admin/Channels-Widget-BotProtection`.
