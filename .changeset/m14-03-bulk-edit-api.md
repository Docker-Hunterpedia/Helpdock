---
"@helpdock/api": minor
---

Change many tickets at once (M14-03). `POST /tickets/bulk` previews or applies one set of changes to up to 50 tickets, each through the same code as a single edit, so its rules, activity, events, wakes and SLA effects are the same. An apply is one transaction against the ids the preview named, `POST /tickets/bulk/:operationId/undo` puts it back within 60 seconds, and a bulk close asks for its survey after that window. Staff only; not part of the public API v1.
