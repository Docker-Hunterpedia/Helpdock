---
"@helpdock/api": minor
---

Break-glass install admins can sign in under SSO enforcement with a password and a fresh authenticator code or a user-verified passkey (ADR 0053). A passkey is also a valid second factor after an SSO assertion; recovery codes, trusted browsers and passwordless passkey sign-in stay refused under enforcement.

Upgrade note: passkeys added before this release count as unverified for break-glass. An admin who relied on one should re-register it with a PIN or biometric, or keep an authenticator app.
