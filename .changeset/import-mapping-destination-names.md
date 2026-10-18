---
"@helpdock/api": patch
---

Show each destination's name on the import Map step. Rows with a saved or suggested mapping no longer read "Selected destination" until the picker is opened: `mapping-values` now returns `confirmedChoice` and `proposedChoice` with the destination's label and Arabic name, resolved in one query per page.
