# 0053 Break-glass may use a passkey

Status: accepted (owner decision D-50, 2026-10-20)
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
   password and (TOTP or a passkey that registered with user verification)".
   The flag is stored per credential (`webauthn_credentials.user_verified`);
   rows from before it existed count as unverified.
3. Recovery codes, trusted browsers and passwordless passkey sign-in stay
   excluded from break-glass, as recovery codes and trusted browsers are today.
4. A pending second-factor challenge re-checks enforcement before it completes.

The owner confirmed this as D-50 on 2026-10-20. It is implemented by M18-05:
one table, `enforcementAllows` in `apps/api/src/sso/break-glass.ts`, answers
what each first factor may finish with under enforcement, and every local path
(second-factor verify, recovery code, passkey options and verify, trusted
browser, session opening) asks it. A break-glass passkey ceremony has its own
purpose (`break-glass`), which requires user verification; the other second
factors keep user presence only.

Recovery codes stay out of break-glass in the other direction too (#373): while
enforcement is on, an account that is on the break-glass list or eligible for it
cannot use a recovery code as the step-up proof that starts replacing its
authenticator app, because that would install the next break-glass factor with a
credential that cannot open break-glass. `SsoSignInPolicy.recoveryCodeBarred`
decides it; the start answers `403 recovery-code-not-allowed`. Everyone else, and
everyone while enforcement is off, may still use one.

## Consequences

- Operators can keep a hardware key as the break-glass factor instead of, or
  beside, an authenticator app.
- The break-glass form and the SSO settings copy change ("password and
  authenticator or passkey").
- A break-glass admin who holds only a passkey cannot sign in while passkeys are
  paused after an `APP_URL` change; the guide advises keeping an app as well.
- Passwordless sign-in remains refused for everyone under enforcement, so a
  person deactivated in the IdP cannot keep signing in with a passkey.

## Alternatives considered

- **Keep TOTP as the only break-glass second factor:** simpler, and weaker than
  the hardware key many operators already own.
- **Allow passwordless passkey sign-in for break-glass:** removes the password
  from the one path meant to be deliberate and audited.
