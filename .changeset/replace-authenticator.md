---
"@helpdock/api": minor
---

The security page can now replace an authenticator app in one step (#373). An account that must have a second factor and holds only the app could neither turn it off nor enrol over it, so a lost phone left only recovery codes. *Replace app* proves a step-up — a code from the current app, a recovery code, a passkey, or the password with a recovery code — stages a fresh secret, and swaps it only after a code from the new app verifies, in one transaction under the account-row lock. The holder is emailed and the api writes `auth.second_factor.rotated`.
