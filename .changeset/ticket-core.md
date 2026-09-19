---
'@helpdock/api': minor
---

Tickets and messages (M1-02, M1-03). `tickets`, `ticket_messages`,
`ticket_activity` and `ticket_statuses` arrive under department-scoped
row-level security, with `/api/brands/:brandId/tickets` for the list, the
thread and the activity log. Message bodies are sanitised on the way in, `seq`
is monotonic per ticket under contention, `client_id` dedupes a retried send,
and every mutation enqueues an outbox event that ends as a `ticket:<id>` and
`department:<id>` socket frame.
