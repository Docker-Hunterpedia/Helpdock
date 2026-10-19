# 0050 Passkeys for staff over WebAuthn

Status: proposed
Date: 2026-10-20

## Context

Staff sign in with a password, a sign-in link, Google or GitHub OAuth, or SSO,
with TOTP and recovery codes as the second factor (M0-05, M11). TOTP and email
links can be relayed by a real-time phishing proxy, and support staff click
customer links all day. ASVS 2.3.2 is Partial ("TOTP only; no WebAuthn/FIDO")
and 2.9.1–2.9.3 are N/A for that reason ([asvs-l2](../completed/asvs-l2.md)).
WebAuthn needs no external service, no network egress and no vendor account,
so it works on air-gapped installs and in regions where provider sign-in is
unreliable. Staff accounts are install-wide (`users` is in `GLOBAL_TABLES`) and
the admin is served from `APP_URL` alone; brand help-center domains are separate
registrable domains where staff never sign in.

Planned in [M18 Sign-in options](../in-development/M18-sign-in-options.md)
(M18-01 to M18-06).

## Decision

1. **Library:** `@simplewebauthn/server` 14.x on the api and
   `@simplewebauthn/browser` 14.x in the admin bundle only, never in the widget
   (14.0.3 and 14.0.0 on 2026-10-20; rechecked when the work starts).
   `supportedAlgorithmIDs` is pinned to `[-8, -7, -257]` (EdDSA, ES256, RS256).
   ARCHITECTURE §1's Auth row gains the library.
2. **RP ID per install, pinned.** The RP ID is the hostname of `APP_URL` and the
   one expected origin is `APP_URL`'s origin, never taken from `Host` or
   `Origin` headers. It is stored in `auth.webauthn.rpId` at first use; if
   `APP_URL`'s host later differs, passkey ceremonies are refused with
   `passkeys-rp-changed`, a warning is shown, and the other methods keep
   working. Passkeys need a secure context (https, or `http://localhost`).
3. **Attestation `none`.** No AAGUID allow-list and no metadata service; the
   AAGUID is stored for display only.
4. **User verification per purpose.** As a second factor, user presence is
   enough, so a key without a PIN works. As passwordless primary sign-in
   (discoverable credentials, conditional mediation), user verification is
   required and the assertion counts as both factors; an assertion without UV
   is refused on that path, not downgraded.
5. **Install-scope table.** `webauthn_credentials` is in `GLOBAL_TABLES`, reached
   only by the `auth` system principal before a session and by `/api/me/*`
   routes filtered to the principal's own id. `users.webauthn_user_handle` holds
   32 random bytes, not the UUIDv7 id. At most 10 passkeys per account.
6. **Interaction with other factors.** "Has a second factor" means TOTP enabled
   or at least one passkey; mandatory MFA (Admins, install admins,
   `auth.require2fa`) is met by either. One set of recovery codes is drawn at the
   first second factor of either kind. Password reset keeps passkeys. Admin
   "reset second factor" removes them. Under SSO enforcement passwordless
   passkey sign-in is a local method and is refused; break-glass with a passkey
   is [ADR 0053](0053-break-glass-with-a-passkey.md).
7. **Ceremony state** lives in Redis (`GETDEL`, 5 minutes, 256-bit id, 32-byte
   challenge), bound to one purpose and, where there is one, one user and one
   session family.

## Consequences

- ASVS 2.3.2 becomes Met, and 2.9.1–2.9.3 move from N/A to Met.
- A new runtime dependency brings CBOR and ASN.1 parsers onto an
  unauthenticated endpoint: pinned, in the CI dependency audit, fuzzed with
  malformed responses, behind a request size cap.
- Changing `APP_URL`'s host orphans every passkey; this is detected, reported
  and documented rather than silent.
- Synced passkeys are accepted; their backup flags are shown, not used for
  policy.

## Alternatives considered

- **Hand-rolled CBOR and COSE parsing:** not acceptable for an authenticator.
- **`@passwordless-id/webauthn`:** smaller, less deployed.
- **Per-brand RP IDs:** staff are install-wide and never sign in on brand
  domains.
- **Related Origin Requests:** capped at five registrable-domain labels and not
  needed for staff.
