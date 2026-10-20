---
"@helpdock/api": patch
---

SLA: saving, reordering or deleting a policy, or saving business hours or a holiday, no longer fails with a 500 when an SLA timer fires on one of the open tickets at the same moment. The recompute now locks the tickets it visits, in a fixed order, before it touches their clocks, and waits for the timer instead of deadlocking with it.
