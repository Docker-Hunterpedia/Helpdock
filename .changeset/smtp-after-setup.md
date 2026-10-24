---
"@helpdock/api": minor
---

Outgoing email can now be set up, changed and tested after first-run setup (#369): **Admin › System › Outgoing email**, for install admins, holds the same fields the wizard's step 3 does — server, port, TLS mode, credentials, From address and name — with a **Send a test email** that shows the server's answer. The password is write-only and stays encrypted at rest; fields pinned by `HD_SMTP_*` variables are drawn locked. The System page warns on a banner and on its health card while no sender exists, and while it is missing, forgot-password and magic-link say so — `email-unavailable`, the same for every address — and point to an admin instead of claiming an email was sent. A stored password is reused only while server, port and username are unchanged (otherwise `smtp-password-required`), and a rate-limited test answers 429 with `Retry-After`.
