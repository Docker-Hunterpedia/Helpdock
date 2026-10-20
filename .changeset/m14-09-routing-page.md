---
"@helpdock/api": minor
---

Routing tab and Test routing (M14-09): Admin > Automation > Routing explains the four steps a new ticket goes through (arrival, rules on Ticket created, AI triage, assignment) with links to where each is edited, and Test routing walks a sample message through them without creating, sending or logging anything. It shows the department, a blocked or automated sender, the matching contact, each rule's conditions and actions, whether AI triage would be queued, the SLA first-response due time and who the rotation would pick right now. New routes: `GET /api/brands/:brandId/routing` and `POST /api/brands/:brandId/routing/test`, both `ticketing:manage` and limited to the reader's departments.
