---
"@helpdock/api": minor
---

Add SLA due sorting to ticket lists and saved views, with oldest breaches first, then soonest running due times, then tickets without a running clock. Add the indexed generated next-due column and the admin Sort menu and view editor option in English and Arabic.

Upgrade note: adding the generated STORED column rewrites `tickets` under an exclusive lock, and the index is built without CONCURRENTLY. Large installations should expect a pause during the upgrade and schedule a maintenance window.
