---
"@helpdock/api": patch
---

Fix the profile endpoints hanging when as many requests as the database pool has connections arrive together: the "hide the recovery code option" check took a second connection while the request held one.
