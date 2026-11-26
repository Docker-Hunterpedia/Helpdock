---
'@helpdock/api': minor
---

Groundwork for the customer portal: no visible change (M21-01). A new `customer` principal, the portal's session and sign-in-link tables, and row-level-security policies that give it only the tickets, public messages and files it may read.

Upgrade note: this release's `0079_customer_portal` migration rewrites every ticket, public message and attachment once under exclusive locks. Expect downtime proportional to their size, take a dump first, and see the operations guide.
