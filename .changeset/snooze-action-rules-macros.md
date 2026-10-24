---
"@helpdock/api": minor
---

A **Snooze** action for workflow rules and macros (#368): it names one of the Snooze menu's four times — in 1 hour, in 4 hours, next business day, next week — and the server resolves it to an instant against the ticket's department calendar when the rule runs or the macro is applied. The wake timer, activity and outbox event are a manual snooze's. The builders offer it in place of the Snoozed status, which no editor offers as a set-status target.
