---
"@helpdock/api": minor
---

A passkey can be the whole sign-in (M18-04). `POST /api/auth/passkey/options` mints options that are the same for every caller (a discoverable credential, user verification required, no `allowCredentials`), and `POST /api/auth/passkey/verify` opens the session a password and a second factor would, with no second step and `method: passkey, secondFactor: passkey-uv` in the audit trail. Every refusal that could reveal an account (unknown credential, bad signature, missing user verification, replay, regressed counter, deactivated person, no active brand) answers `invalid-credentials`, failures spend the same per-IP budget as the password form, and both routes answer `sso-required` under SSO enforcement. The sign-in page gains the "Sign in with a passkey" button and the browser's autofill on the email field. The security emails and the Passkeys card say again that a passkey can sign you in.
