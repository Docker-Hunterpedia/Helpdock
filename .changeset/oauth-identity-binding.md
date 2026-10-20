---
"@helpdock/api": patch
---

Security: Google and GitHub sign-in now bind to the provider account rather than matching its email address on every sign-in. The address makes the first link only where the provider controls it: a Google Workspace account on its own domain, or a Gmail address. Anything else answers `oauth-link-required` until the person connects the account from a signed-in session (`POST /api/auth/oauth/:provider/connect`, behind the current password or an authentication code). Connecting and disconnecting are audited (`auth.oauth.linked` / `.unlinked`) and email the account holder. **Action needed after upgrading:** everyone who signs in with GitHub, and anyone who signs in with a consumer Google account on a company address, must sign in once with their password or a sign-in link and then connect the provider again. The security page control for this is still to come, so until then connecting goes through the API.
