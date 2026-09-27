---
'@helpdock/api': minor
---

The ticket state machine (M1-08, #69). Every transition in DOMAIN-RULES §2.2 goes through one table, with `auto_await_on_agent_reply`, the per-brand reopen policy (`within_days`, `always`, `never`), parent–child linking for continued tickets, escalation, and the Statuses tab.
