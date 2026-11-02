---
"@helpdock/api": patch
---

Fix the admin UX findings of the 2026-11 review (#451). The sidebar is one tree for Tickets, Contacts, Help center, Reports and Settings, with an icon on every entry and a flyout on the collapsed rail. New pages open at the top, `#fragment` links reach their section, and unknown addresses get a "Page not found" inside the shell. The Statuses table shows the reader's language first, and the widget preview draws the selected mode and colour scheme. Brand gains a Data retention page, Profile takes your email and language from Security, and System's card is called System email. Save and Discard stay disabled until a form changes, labels sit above their fields, and the empty lists show one button. The audit log hides the page-view rows unless asked (`includePageViews`), and System's audit preview leaves them out too.
