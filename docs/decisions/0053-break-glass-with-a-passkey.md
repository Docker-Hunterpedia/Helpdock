# 0053 Break-glass may use a passkey

Status: proposed
Date: 2026-10-20

Amends [0026](0026-staff-sso-over-saml-and-oidc.md), decision 10.

## Context

ADR 0026 lets an install enforce SSO and keeps up to three break-glass install
admins who sign in with a password and must have TOTP. M18 adds passkeys for
staff ([ADR 0050](0050-passkeys-for-staff-over-webauthn.md)). A FIDO key kept
in a safe is the textbook break-glass credential, and an origin-bound passkey
assertion with user verification is stronger than a TOTP code.

Planned in [M18 Sign-in options](../in-development/M18-sign-in-options.md)
(M18-05).

## Decision

1. Under SSO enforcement, a break-glass admin signs in with a **password, then a
   fresh TOTP code or a fresh passkey assertion with user verification**.
2. The enforcement precondition becomes "an active install admin with a
   password and (TOTP or a passkey)".
3. Recovery codes, trusted browsers and passwordless passkey sign-in stay
   excluded from break-glass, as recovery codes and trusted browsers are today.
4. A pending second-factor challenge re-checks enforcement before it completes.

Waits for the owner's confirmation (D-50); until then break-glass stays as ADR
0026 describes it.

## Consequences

- Operators can keep a hardware key as the break-glass factor instead of, or
  beside, an authenticator app.
- The break-glass form and the SSO settings copy change ("password and
  authenticator or passkey").
- Passwordless sign-in remains refused for everyone under enforcement, so a
  person deactivated in the IdP cannot keep signing in with a passkey.

## Alternatives considered

- **Keep TOTP as the only break-glass second factor:** simpler, and weaker than
  the hardware key many operators already own.
- **Allow passwordless passkey sign-in for break-glass:** removes the password
  from the one path meant to be deliberate and audited.
