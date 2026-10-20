---
"@helpdock/api": patch
---

Fix paced notification emails: an urgent cut that lands while the batch job is running now pulls the delayed job earlier instead of waiting for the hourly rebuild.
