---
"@helpdock/api": minor
---

Staff can add, rename and remove passkeys from Security, `/api/me/passkeys` (M18-02). Each change asks for the password, a live code or an existing passkey first, an account holds at most ten, and the last second factor of an Admin cannot be removed. Additions and removals are audited and emailed, and a password reset now says how many passkeys it kept.
