---
"@helpdock/api": minor
---

Command palette (M14-05). `Ctrl`/`⌘` + `K`, or the sidebar Search, opens a dialog that finds tickets (an exact reference or number first), contacts, articles, every page and settings tab, in English or Arabic, and the actions of the screen. `GET /api/brands/:brandId/quick-search?q=&limit=&locale=` answers `{ tickets, contacts, articles }` under the caller's own scope: a ticket in a department they cannot reach is never offered, and a section they may not read is `skipped`, one that errors or runs past 300 ms is `failed`, and the others still answer. Ten requests a second for one person.
