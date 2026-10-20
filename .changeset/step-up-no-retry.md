---
"@helpdock/api": patch
---

Security page: a wrong current password or authenticator code is sent once. The admin used to take every 401 for an expired session, refresh it and send the same wrong credential again, which spent two of the five step-up attempts allowed in fifteen minutes for one click. It now refreshes only for the 401 that refuses the access token, and passes a refused password or code (a 401 carrying `error.auth`) straight to the screen.
