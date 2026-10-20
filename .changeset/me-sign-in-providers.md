---
"@helpdock/api": patch
---

Security page: a Sign-in providers card lists Google and GitHub with their link state and connects or disconnects them behind the password or a live code, so nobody has to call the API to reconnect a provider after 1.0.1. `GET /api/auth/oauth/identities` now also answers `passwordSet`, and disconnecting an account's last way in (no password and no other provider) is refused with `oauth-last-sign-in` (409).
