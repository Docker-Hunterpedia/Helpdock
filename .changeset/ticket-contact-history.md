---
"@helpdock/api": patch
---

**Previous tickets on the ticket's contact card.** The details panel lists the contact's three most recent other tickets, each a link with its subject, reference, date and status, counts all of them, says how many sit in departments the viewer is not in, and links to the contact page; a first ticket says so (#237). The contact timeline (`GET /api/brands/:brandId/contacts/:contactId/timeline`) now answers `visibleCount`, every ticket the caller may see however many of the newest 50 `items` it lists, and each item's `statusId`. The contact page's "N tickets you can see" reads `visibleCount` too, so it no longer stops at 50.
