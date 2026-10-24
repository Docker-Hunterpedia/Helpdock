---
"@helpdock/api": minor
---

Install admins see passkeys on Settings › Authentication: whether they work, the RP ID they were made for, and how many exist. When the install's address changes, a warning (also on the System page) offers "Move passkeys", which removes every passkey, pins the new host, records `auth.passkey.rp_moved` and emails each holder, all in one transaction, and refuses while it would lock out a break-glass admin or an account that must have a second factor. `GET /api/install/passkeys` and `POST /api/install/passkeys/move` are new. The Security page can redraw recovery codes with a passkey.
