---
'@helpdock/api': minor
---

Staff notifications (M3-07). Agents are told about assignment, replies on their tickets, `@`-mentions in internal notes, SLA warnings and breaches, and escalations: in the app through a bell with an unread count in the sidebar, by email from the install's own sender in their language, and by browser push once an install sets a VAPID key pair (`HD_PUSH_VAPID_PUBLIC_KEY`, `HD_PUSH_VAPID_PRIVATE_KEY`). Each person chooses the channels per event on the new Notifications tab of Your account, where Security now lives too. Every send goes through the outbox, so one event is one email and one push per browser.
