---
'@helpdock/api': patch
---

Sign-in links, password resets and staff invitations are now delivered (#104). Until now they were only written to the log. Each one is queued through the outbox and sent by the worker from the install's system sender (the SMTP settings the first-run wizard saves), in the recipient's language, once per request even when a job is delivered twice. The link is encrypted under `APP_MASTER_KEY` in the outbox and in the queue, and never logged. An install without SMTP logs that the email would have been sent, and sends nothing.
