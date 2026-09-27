---
'@helpdock/api': minor
---

Inbound email (M2-01 to M2-04, M2-07, and the inbound half of M2-08). Mailboxes receive mail by IMAP polling or by inbound-parse webhooks from Postmark, SendGrid, Mailgun, Resend or any JSON sender, protected by a per-brand shared secret. Each message becomes a ticket or threads onto one only when the sender is a participant; a stranger quoting a ticket number gets a ticket of their own with a note. Bodies are sanitised, quoted history is folded away, remote images are blocked or loaded through a re-encoding proxy, automated senders are dropped unless allow-listed, and SPF or DKIM failures can file mail as spam. Admins manage it all on the new Channels › Mailboxes page, with Test IMAP and per-mailbox health.
