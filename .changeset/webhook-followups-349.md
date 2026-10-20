---
"@helpdock/api": patch
---

Stop sending a redundant `contact.updated` for a contact created in the same transaction, and take contact locks in id order when a verified identity changes hands during `attachVerifiedIdentity`.
