---
"@helpdock/api": minor
---

Snooze a ticket until a time you choose (M14-02). A seeded Snoozed status, a wake timer through the outbox, wake paths for time, a customer reply, an SLA step and Wake now, and a Snoozed view; the resolution clock pauses while a response clock keeps running. `PATCH /tickets/:id` takes `snoozedUntil`, `GET /tickets/:id/snooze-presets` answers the menu, and `GET /tickets` takes `snoozed=exclude|only|include`.
