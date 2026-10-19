---
'@helpdock/api': patch
---

**Mixed-direction text, dates and shortcuts in the Arabic admin.** Ticket subjects, message and note bodies, contact and account names and help center article titles take their own direction, so an English subject in the Arabic admin keeps its punctuation and truncates from its own end. Email addresses, phone numbers and visitor ids read left to right, so `+49…` keeps its plus in front. Dates on the contact, staff, security, SSO, widget, AI, macro and retention screens follow the app's language with Latin digits instead of the browser's locale. The contact timeline names each ticket's channel, status and assignee ("Unassigned") in words, and the Details card names the contact's language instead of printing `en`. The ticket shortcuts `j`, `k`, `r` and `n` work on an Arabic keyboard layout.
