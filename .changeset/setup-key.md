---
'@helpdock/api': minor
---

Optional `HD_SETUP_TOKEN` (at least 32 characters). When set, the first-run wizard's first step asks for it as a "Setup key" and refuses a missing or wrong key with a 403, so nobody who cannot read the server's `.env` can claim a fresh install (#43).
