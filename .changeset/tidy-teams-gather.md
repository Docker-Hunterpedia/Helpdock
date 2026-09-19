---
'@helpdock/api': minor
---

Brands, departments, teams and team members (M1-01). A brand now carries
ticketing settings (`autoAwaitOnAgentReply`, `reopenPolicy`) and can be renamed,
relocated and retimed through `PATCH /api/brands/:brandId`; an install admin can
add a brand with `POST /api/install/brands`, which gives it an administrator, a
department and a working ticket sequence. Departments gain an Arabic name, an
order and a default team, and hold teams whose members must already reach the
department: which departments a brand *has* is `brand:manage`, what is inside
one is `staff:manage` narrowed to the departments a Team Leader leads. The admin
app gains **Admin → Ticketing** with the whole M1 tab row and a built
Departments tab.
