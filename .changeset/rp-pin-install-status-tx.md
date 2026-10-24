---
"@helpdock/api": patch
---

The passkey status and move routes read the RP ID pin on the install-admin request's own connection instead of a second pooled one. Two reads there still use their own connection (a paused install's second-factor check per holder, and the move itself); both are install-admin only.
