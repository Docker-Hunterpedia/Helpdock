---
"@helpdock/api": minor
---

Passkey foundation (M18-01, ADR 0050): the `webauthn_credentials` table and `users.webauthn_user_handle` (migration 0058), the passkey relying party taken from `APP_URL` and pinned in `auth.webauthn.rpId` by the first successful registration, single-use purpose-bound ceremonies in Redis (every purpose but passwordless names its person), attestation limited to `none` or a packed self-attestation, framed answers refused, and `@simplewebauthn/server` 14.0.3. `GET /api/auth/methods` now also reports `passkey` and `passkeysPaused`. No route registers or accepts a passkey yet; that comes with the rest of M18. **Note for operators:** once passkeys are in use, moving `APP_URL` to another host pauses every passkey, because each is bound to the host it was made on; staff then add theirs again.
