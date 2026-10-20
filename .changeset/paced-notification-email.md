---
"@helpdock/api": minor
---

Notification email is paced (M14-10): Right away email waits two minutes and gathers what arrives, backs off while more keeps coming, and is capped at six an hour and forty a day per person and brand; mentions, SLA breaches and escalations may cut the wait. People can choose an hourly or a daily digest per brand, or Off, and pause email and push. Every row is checked again before its email goes (unread, still in the person's departments, not paused or off), nothing is emailed while the person is online for up to fifteen minutes, and opening a ticket reads its notifications. Existing accounts move from one email per notification to Right away (batched) on upgrade. Pacing is tunable with `HD_NOTIFY_EMAIL_*`.
