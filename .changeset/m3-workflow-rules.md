---
'@helpdock/api': minor
---

Workflow rules (M3-03, M3-04, M3-05). Admin → Automation lists a brand's rules in the order they run: `WHEN <event> IF <conditions> THEN <actions>` for ticket, SLA and CSAT events, and time-based rules checked every five minutes over tickets that have waited too long, such as awaiting customer for more than 3 days. Rules assign, set status and priority, tag, reply with a canned response (which does not count as the first response unless the rule says so), add notes and notify. A depth guard stops rule loops at a cycle or past three rules, every run is in an execution log, and a test run tries a draft on a real ticket without changing anything.
