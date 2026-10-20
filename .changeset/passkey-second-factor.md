---
"@helpdock/api": minor
---

A passkey is now a second factor (M18-03). After a password, a sign-in link, OAuth or an SSO assertion that does not vouch for IdP MFA, `POST /api/auth/passkey/second-factor/{options,verify}` answer the challenge beside an authenticator code and a recovery code, on the same three attempts and the same 15-minute lock. The sign-in answer gains `factors`, the enrolment challenge is renamed `second-factor-enrolment-required` (the old name is still read) and takes a passkey at `POST /api/auth/enrolment/passkey/{options,confirm}`, and "has a second factor" means an app or a passkey everywhere. Recovery codes are drawn with the first second factor of either kind and can be redrawn with a passkey at `POST /api/me/passkeys/recovery-codes`. Turning the app off now takes the lock passkey add and remove take, so an Admin can never be left with no second factor. Deleting a person deletes their passkeys.

For one release the enrolment challenge still goes out as `totp-enrolment-required`, so an admin bundle cached from before this change keeps working; every reader accepts both names.
