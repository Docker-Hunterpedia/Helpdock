---
"@helpdock/api": patch
---

Changing a status's system state across the closed boundary is no longer a silent relabel. Moving it into a closed state needs the live-ticket count confirmed (`confirmCount`, else `409 status-change-needs-confirmation`) and then closes those tickets in batches through the lifecycle: `closed_at`, the resolution clock met, and a `ticket.closed` event and webhook per ticket, with no satisfaction survey. Moving it out of a closed state is refused with `409 status-has-closed-tickets` while the status holds tickets. A ticket in a closed status that the batch has not reached yet behaves as open, and on worker boot tickets an earlier edit left in a closed status without a `closed_at` are closed through the lifecycle, without surveys.

Upgrade note: on the first worker boot after upgrading, tickets an earlier status edit left in a closed status without a `closed_at` are closed. Their `closed_at` is the boot time, their resolution clock is met, no satisfaction survey is sent, and each fires one `ticket.closed` webhook or rule run.
