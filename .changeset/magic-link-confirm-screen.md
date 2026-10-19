---
"@helpdock/api": patch
---

Stop mail scanners from spending staff sign-in links (M9-01 F6). The email now links to the admin page `/sign-in/magic#token=…`, which shows whose account the link opens through `POST /api/auth/magic-link/preview` and spends the link only when the person clicks Continue, through `POST /api/auth/magic-link/consume`. The old `GET /api/auth/magic-link/:token` link only redirects to the page and no longer spends anything.
