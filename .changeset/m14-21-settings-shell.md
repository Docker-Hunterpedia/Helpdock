---
"@helpdock/api": minor
---

Settings area with grouped navigation (M14-21): the sidebar's Admin group is one Settings entry opening Your account, Brand, Inbox, Channels, AI, Developers and Install, each showing only what the person's role may open. Every old `/admin/…` and `/me/…` address redirects to its new place, keeping its query string; the Views group in the sidebar folds, remembered per person. Links the api writes into emails and OAuth returns point at the new addresses.
