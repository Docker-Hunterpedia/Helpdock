# Public REST API

Tickets, contacts, help center articles and webhook endpoints of one brand, for an integration: a CRM, an order system, a script (M8-01, M8-02, [REQUIREMENTS §4.11](../planning/REQUIREMENTS.md#411-public-rest-api-tenant), [ADR 0019](../decisions/0019-api-scopes-and-openapi-from-zod.md)). Outbound events are in [Webhooks](webhooks.md).

## The OpenAPI document

| Address | What |
|---|---|
| `<APP_URL>/api/docs` | Every operation, its scope and what it does, as a page |
| `<APP_URL>/api/docs/openapi.json` | The OpenAPI 3.1 document, for a client generator or a viewer of your choice |

Both are public: they describe the routes, nothing of any brand's data. The document is generated from the same Zod schemas the routes validate with, so it always describes the running code. Its `info.version` (and the page's title) is the version of the API contract, `1`, not the release of the install: both are public, and a release number would tell a stranger which known flaws to try.

## API keys

A key belongs to one brand and is made by that brand's Admin (`brand:manage`), on **Developers › API keys** in the admin (artboard `Admin/Developers-ApiKeys`):

- **The table** lists every key with its first 12 characters, scopes, rate limit, who created it and when, and when it was last used. Revoked keys stay in the list, struck through, with who revoked them; untick "Show revoked" to hide them.
- **Create API key** asks for a name, at least one scope and a rate limit (600 unless changed). The key is then shown **once**, with Copy; after "Done" the page holds only its prefix.
- **Revoke** asks first and says what stops working. A revoked key answers `401` at once.
- **API docs** in the page header opens `/api/docs`, and the "Calling the API" card has a `curl` example against this install.

The page calls these endpoints, which an Admin's own scripts may call too:

| Request | What it does |
|---|---|
| `GET /api/brands/{brandId}/api-keys` | The brand's keys: name, the first 12 characters, scopes, rate limit, created and by whom (`createdByName`), last used, `expiresAt`, revoked and by whom (`revokedByName`) |
| `POST /api/brands/{brandId}/api-keys` | `{ "name", "scopes": [...], "rateLimitPerMinute"?, "expiresAt"? }`. The answer carries `key` — **the only time it is ever shown** |
| `DELETE /api/brands/{brandId}/api-keys/{keyId}` | Revokes the key. Final: a key that should work again is a new key |

**Expiry (API only for now).** `expiresAt` is an ISO 8601 date and time (`2027-01-01T00:00:00Z`, or with an offset). It must be in the future (`400` otherwise), and leaving it out makes a key that never expires, as before. From that moment the key is refused with `401`, the same answer as a revoked one, and the refusal is logged and audited with `reason: "expired"` ([what a refused key leaves](#authentication-and-limits)). The date cannot be changed afterwards: a longer life is a new key. The expiry is stored and returned by the API, but the **Create API key** dialog (artboard `Admin/Developers-ApiKeys`) draws no field for it and the table shows no column: adding them needs the artboard updated first. Until then, set it by calling the create endpoint yourself.

A key is `hd_live_` followed by 43 characters. Helpdock stores its SHA-256 and its first 12 characters, never the key. Creating and revoking a key are written to the audit log with the prefix and the scopes. `lastUsedAt` is updated at most once a minute.

### Scopes

| Scope | Allows |
|---|---|
| `tickets:read` | List and read tickets and their messages |
| `tickets:write` | Create, update and delete tickets; add messages and notes |
| `contacts:read` | Search and read contacts; a ticket read also names its contact |
| `contacts:write` | Create and update contacts (upsert) |
| `articles:read` | Search and read **published, public** help center articles |
| `webhooks:manage` | Manage webhook endpoints, read their delivery log, replay deliveries — only for events the key could read itself (below) |

**Webhook events follow read scopes.** A delivery carries the same data a read would, so `webhooks:manage` alone cannot subscribe to it: `ticket.*` and `csat.received` need `tickets:read`, `contact.created` needs `contacts:read`, `article.published` needs `articles:read`. A key that lacks one gets `403` with `error.webhooks.reason: "webhook-event-scope"` when it creates an endpoint, when it changes one (checked against the events the endpoint would have afterwards, so a key cannot repoint an endpoint it could not have made), and when it rotates the secret of, or replays a delivery of, an endpoint whose events exceed its scopes. The Admin's Developers page is not held to scopes: it acts as a staff member with `brand:manage`.

A key reaches every department of its brand and no other brand. Its scopes are the only permissions it holds: a key cannot call the admin's routes, and a signed-in staff member cannot call `/api/v1`.

## Authentication and limits

```
Authorization: Bearer hd_live_...
```

| Answer | When |
|---|---|
| `401` | No key, an unknown key, a revoked key, or one past its `expiresAt` |
| `403` | The key does not hold the route's scope, or the route is one a person uses, such as `/api/me`: a key reaches `/api/v1` and nothing else |
| `404` | Nothing with that id in the key's brand |
| `410` (`error.code` is `gone`) | The key's brand is scheduled for deletion, after the key has spent a request from its minute's budget (so past the budget it is `429`, as for any key). The key works again if the brand is restored |
| `429` | The key made more requests in the last minute than its `rateLimitPerMinute` (600 unless set, at most 10 000) |

**What a refused key leaves behind.** Every `401` for a key is logged as a warning, `API key refused`, with the key's first 12 characters (`keyPrefix`), the caller's address (`ip`, as Fastify resolves it under `TRUST_PROXY`) and a `reason`: `unknown` for a key Helpdock never issued, `revoked` or `expired` for one it did. The key itself is never logged. A revoked or expired key that is presented also writes an `api_key.refused` row to its brand's [audit log](audit-log.md#api-keys) (the prefix, the reason and the address), at most once a minute per key, so a script that keeps retrying a revoked key shows once, not a thousand times.

Errors have the shape every Helpdock route answers with: `{ "error": { "code", "message", "requestId", "fields"? } }`.

## Endpoints

| Request | Scope |
|---|---|
| `GET /api/v1/tickets` | `tickets:read` |
| `POST /api/v1/tickets` | `tickets:write` |
| `GET /api/v1/tickets/{ticketId}` | `tickets:read` |
| `PATCH /api/v1/tickets/{ticketId}` | `tickets:write` |
| `DELETE /api/v1/tickets/{ticketId}` | `tickets:write` |
| `GET /api/v1/tickets/{ticketId}/messages` | `tickets:read` |
| `POST /api/v1/tickets/{ticketId}/messages` | `tickets:write` |
| `GET /api/v1/contacts` | `contacts:read` |
| `POST /api/v1/contacts` | `contacts:write` |
| `GET /api/v1/contacts/{contactId}` | `contacts:read` |
| `GET /api/v1/articles?q=` | `articles:read` |
| `GET /api/v1/articles/{slug}` | `articles:read` |
| `GET`, `POST /api/v1/webhooks`; `GET`, `PATCH`, `DELETE /api/v1/webhooks/{webhookId}`; `POST …/rotate-secret`; `GET …/deliveries`; `POST …/deliveries/{deliveryId}/replay` | `webhooks:manage` |

The request and answer of each are in the OpenAPI document. What is worth knowing beyond it:

- **Tickets go through the desk's own rules.** A ticket created here is on the `api` channel and gets the same routing, SLA clocks, workflow rules and events as one typed into the admin. `DELETE` is the admin's soft delete: the ticket disappears from every view and retention purges it later.
- **Tickets name their assignee.** The list and the detail read carry `assignee: { id, name } | null` (M14-20): the assignee's name, `null` for an unassigned ticket or a person who no longer holds a role in the brand. It needs no scope beyond `tickets:read`. Webhook payloads and write responses omit it.
- **Messages from a key** are recorded with `authorType: system`, and the activity log names the key, via `api`. A public message from a key is part of the thread; it is not emailed to the customer, because only an agent's public reply is.
- **Contact upsert.** `POST /api/v1/contacts` updates the contact with the same `externalId`, or else the first one holding one of the given identifiers, and adds the identifiers it lacks; otherwise it creates one. The answer is always `200` with `created: true` or `false`. An identifier that belongs to another contact is refused (`409`), never merged.
- **Articles** are read as a visitor reads them: published and public only. A key's searches are not recorded in the help center's search insights.
- **A ticket's `channel`** is one of `email`, `chat`, `telegram`, `form`, `api`, `manual`, `whatsapp`, `messenger` or `instagram`, as the schema's enum lists it. A ticket a key files is always `api`, and `GET /api/v1/tickets?channel=` takes the same values, repeatable. The three Meta values are tickets that came in through a connected WhatsApp number, Facebook Page or Instagram account ([Meta channels](meta-channels.md)). A key cannot file one. A message a key adds to such a ticket is part of the thread and is not sent to the customer, as with email.
- **`GET /api/v1/tickets?sort=slaDue`** (1.1) orders the oldest breached running clock first, then the soonest due clock, then tickets without a running clock. Paused, satisfied and stopped clocks are excluded. This urgency order is fixed: `direction` does not reverse it. Use the returned `nextCursor` with the same parameters for later pages; equal due times and the no-clock tail break ties on ticket ID. The generated OpenAPI sort enum includes `slaDue`.
- **`GET /api/v1/tickets?snoozed=`** (1.1) takes `include` (the default here), `exclude` or `only`. Snoozed tickets are listed by default so an integration that syncs by listing loses none; the admin's list defaults to `exclude`. A ticket carries `snoozedUntil` while it is snoozed, and `PATCH` accepts `snoozedUntil` (an instant 5 minutes to 90 days ahead, or `null` to wake); see [Snooze](snooze.md).
- **`GET /api/v1/tickets?fieldFilter=`** (1.1) filters by a ticket custom field. Repeat it, one URL-encoded JSON object each (the OpenAPI document describes it as a JSON-encoded parameter, `content: application/json`, so generated clients do not form-encode it) (`{"key":"severity","op":"any_of","values":["Sev 1"]}`); all must match. The operators and their field types are in [Filtering by a custom field](tickets.md#filtering-by-a-custom-field). A key that is not a ticket field, or one hidden from Agents (a key never filters by those), answers `400`. Custom field definitions carry `pinned` (the one select field a brand shows as a chip in the admin).
- **Bulk edits are not in v1** (M14-03). They are a staff-session route of the admin ([Tickets](tickets.md#bulk-edit)); an API client changes tickets one `PATCH` at a time and uses idempotency keys to retry.
- **`GET /api/v1/tickets?q=`** searches as the workspace does. A `q` that is a reference, a ticket number, or an imported ticket's original number or native ID returns that ticket first, and the request's other filters do not apply to it; words and contact names are matched inside the filters ([Tickets: listing](tickets.md#listing)).

## Pagination

Lists return a page and an opaque cursor:

```json
{ "tickets": [...], "nextCursor": "eyJ..." }
```

Pass `nextCursor` back as `?cursor=` for the next page; it is `null` on the last. `limit` sets the page size. Messages page by sequence number instead: `GET …/messages?after=<seq>`, with `nextAfter` in the answer. The webhook delivery log pages with `?cursor=<delivery id>`.

## Idempotency

Every `POST` that creates something (a ticket, a message, a contact, a webhook) accepts an `Idempotency-Key` header: 1 to 255 printable characters without spaces, chosen by you, unique per operation.

| You send | Helpdock answers |
|---|---|
| A key it has not seen in the last 24 hours | Runs the request and keeps the answer |
| The same key with the same method, path and body | The kept answer, with `Idempotent-Replayed: true`; nothing runs twice |
| The same key with a different request | `422` |
| The same key while the first request is still running | Waits for it, then answers as above |

Keys are per API key and kept for 24 hours. A request that fails keeps no key, so retrying it runs it again.

```sh
curl -X POST "$APP_URL/api/v1/tickets" \
  -H "Authorization: Bearer $HELPDOCK_KEY" \
  -H "Idempotency-Key: order-1042-late" \
  -H "Content-Type: application/json" \
  -d '{"subject":"Order 1042 is late","bodyHtml":"<p>Still not here.</p>","departmentId":"…"}'
```
