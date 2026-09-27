---
'@helpdock/api': minor
---

Business hours and SLAs (M3-01, M3-02). Ticketing › Business hours sets the brand's time zone and week, holidays, and per-department hours; Ticketing › SLAs sets policies — conditions on department and priority, business or calendar hours, first-response and resolution targets per priority, and escalation steps by percent (notify, reassign, raise priority, add tag, set Escalated). Every ticket runs two clocks counted in business hours that pause on statuses flagged to pause SLA, follow priority, department and policy changes keeping the time already counted, restart as next-response and resolution clocks on a reopen, and record a breach once per clock. Timers are BullMQ jobs rebuilt from the database when the worker starts, so losing Redis loses no timer. The ticket's details panel shows an SLA card and the list a timer in every state.
