---
"@helpdock/api": minor
---

Fields required to close (M14-17): a ticket custom field can be marked required to close in Ticketing › Custom fields. A close by a person or an API key is then refused with 409 `fields-required-to-close` and a list of the keys that are still empty, in the ticket workspace, the public API and bulk edits; rules, time-based rules, merges and spam still close, and their activity row records the fields they went without. The error body's `lifecycle` object gains optional `fields`.
