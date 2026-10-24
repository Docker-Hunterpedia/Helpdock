---
"@helpdock/api": minor
---

Filter the ticket list and saved views by custom fields, and pin one select field as a chip (M14-16). `GET /tickets` and the public `GET /api/v1/tickets` take repeatable `fieldFilter` parameters, one JSON object each (`any_of`, `not_set`, `is`, `before`, `after`, `between`, `contains`); the api checks them against the brand's field definitions and answers 400 for a key that is not a ticket field or an operator its type cannot answer. A field hidden from Agents can be filtered only by Admins and Team Leaders. Views keep the filters. `PATCH` and `POST /custom-fields` take `pinned` (one ticket select field per brand), and every definition now carries it. Migration `0070` adds `custom_field_defs.pinned` and its partial unique index.
