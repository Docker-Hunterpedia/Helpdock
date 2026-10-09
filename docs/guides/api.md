# Public REST API

Tickets, contacts, help center articles and webhook endpoints of one brand, for an integration: a CRM, an order system, a script (M8-01, M8-02, [REQUIREMENTS §4.11](../planning/REQUIREMENTS.md#411-public-rest-api-tenant), [ADR 0019](../decisions/0019-api-scopes-and-openapi-from-zod.md)). Outbound events are in [Webhooks](webhooks.md).

## The OpenAPI document

| Address | What |
|---|---|
| `<APP_URL>/api/docs` | Every operation, its scope and what it does, as a page |
| `<APP_URL>/api/docs/openapi.json` | The OpenAPI 3.1 document, for a client generator or a viewer of your choice |

Both are public: they describe the routes, nothing of any brand's data. The document is generated from the same Zod schemas the routes validate with, so it is always the running version's.

## API keys

A key belongs to one brand and is made by that brand's Admin (`brand:manage`), on **Developers › API keys** in the admin (artboard `Admin/Developers-ApiKeys`):

- **The table** lists every key with its first 12 characters, scopes, rate limit, who created it and when, and when it was last used. Revoked keys stay in the list, struck through, with who revoked them; untick "Show revoked" to hide them.
- **Create API key** asks for a name, at least one scope and a rate limit (600 unless changed). The key is then shown **once**, with Copy; after "Done" the page holds only its prefix.
- **Revoke** asks first and says what stops working. A revoked key answers `401` at once.
- **API docs** in the page header opens `/api/docs`, and the "Calling the API" card has a `curl` example against this install.

The page calls these endpoints, which an Admin's own scripts may call too:

| Request | What it does |
|---|---|
| `GET /api/brands/{brandId}/api-keys` | The brand's keys: name, the first 12 characters, scopes, rate limit, created and by whom (`createdByName`), last used, revoked and by whom (`revokedByName`) |
| `POST /api/brands/{brandId}/api-keys` | `{ "name", "scopes": [...], "rateLimitPerMinute"? }`. The answer carries `key` — **the only time it is ever shown** |
| `DELETE /api/brands/{brandId}/api-keys/{keyId}` | Revokes the key. Final: a key that should work again is a new key |

A key is `hd_live_` followed by 43 characters. Helpdock stores its SHA-256 and its first 12 characters, never the key. Creating and revoking a key are written to the audit log with the prefix and the scopes. `lastUsedAt` is updated at most once a minute.

### Scopes

| Scope | Allows |
|---|---|
| `tickets:read` | List and read tickets and their messages |
| `tickets:write` | Create, update and delete tickets; add messages and notes |
| `contacts:read` | Search and read contacts; a ticket read also names its contact |
| `contacts:write` | Create and update contacts (upsert) |
| `articles:read` | Search and read **published, public** help center articles |
| `webhooks:manage` | Manage webhook endpoints, read their delivery log, replay deliveries |

A key reaches every department of its brand and no other brand. Its scopes are the only permissions it holds: a key cannot call the admin's routes, and a signed-in staff member cannot call `/api/v1`.

## Authentication and limits

```
Authorization: Bearer hd_live_...
```

| Answer | When |
|---|---|
| `401` | No key, an unknown key, or a revoked key |
| `403` | The key does not hold the route's scope |
| `404` | Nothing with that id in the key's brand |
| `410` | The key's brand is scheduled for deletion. The key works again if the brand is restored |
| `429` | The key made more requests in the last minute than its `rateLimitPerMinute` (600 unless set, at most 10 000) |

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
- **Messages from a key** are recorded with `authorType: system`, and the activity log names the key, via `api`. A public message from a key is part of the thread; it is not emailed to the customer, because only an agent's public reply is.
- **Contact upsert.** `POST /api/v1/contacts` updates the contact with the same `externalId`, or else the first one holding one of the given identifiers, and adds the identifiers it lacks; otherwise it creates one. The answer is always `200` with `created: true` or `false`. An identifier that belongs to another contact is refused (`409`), never merged.
- **Articles** are read as a visitor reads them: published and public only. A key's searches are not recorded in the help center's search insights.

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
