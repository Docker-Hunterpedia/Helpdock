---
'@helpdock/api': minor
---

Outbound email (M2-05, M2-06). Public replies on email, web-form and agent-created tickets are emailed to the contact with the ticket's CCs copied, through the brand's own SMTP server or the install's, as the department's sender, with the agent's signature in the customer's language. Sends go through the outbox as `email.send` jobs with a deterministic `Message-ID`, so a redelivered job sends one email; five failed attempts land in **Channels › Outgoing email › Failed sends**, where an Admin can retry or discard them, and the ticket shows the reply as "Not delivered". New: acknowledgment and out-of-hours auto-replies with English and Arabic templates, loop protection (`Auto-Submitted`, `Precedence: bulk`, a per-sender hourly cap), and the Email signature tab of Your account.
