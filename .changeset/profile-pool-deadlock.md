---
"@helpdock/api": patch
---

Fix requests hanging when as many arrive together as the database pool has connections: the profile, authenticator-app replacement, OAuth connect and passkey routes took a second pooled connection for install-wide settings while holding one.
