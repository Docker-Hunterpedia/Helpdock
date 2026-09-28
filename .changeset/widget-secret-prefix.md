---
'@helpdock/api': patch
---

New widget signing secrets start with `hdws_` instead of `whsec_`, the prefix Stripe uses for its webhook secrets, so secret scanners no longer report a Helpdock secret as a Stripe key. Secrets generated earlier keep working; replace one only if you want the new prefix.
