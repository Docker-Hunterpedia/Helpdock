---
"@helpdock/api": patch
---

**"AI answered" on the ticket list.** A conversation handed off before the assistant ever answered, then given back with **Return to assistant**, read "AI answered" in the ticket list. The ticket's `ai` state (ticket list, ticket read, `POST …/ai/resume` and `/api/v1` tickets) now carries `answeredAt`, when the assistant first sent an answer, and the list says "AI answered" only once it is set. No migration: the time was already recorded in `tickets.ai_answered_at`.
