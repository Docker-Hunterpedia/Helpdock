---
"@helpdock/api": minor
---

Find a ticket by its exact number from any view. A search for a reference (`ACME-573`), a ticket number (`573`, `#573`), or an imported ticket's original number or native ID (`580`, `#580`) now lists that ticket first, even when the view's filters would hide it, such as a closed imported ticket in "My open". Words and contact names are still matched inside the view. Row-level security, department scope and soft deletion still apply, and the same rule holds for `q` on `GET /api/v1/tickets`.
