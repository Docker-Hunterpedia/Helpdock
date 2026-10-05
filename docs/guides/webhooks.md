# Outbound webhooks

Helpdock POSTs an event to your endpoint when something happens in a brand: a ticket is created or answered, a contact appears, a customer rates a conversation (M8-03, [REQUIREMENTS §4.12](../planning/REQUIREMENTS.md#412-outbound-webhooks)).

## Managing endpoints

The Admin manages a brand's endpoints (`brand:manage`) at `/api/brands/{brandId}/webhooks`; an API key with `webhooks:manage` manages them at `/api/v1/webhooks` (see [the API guide](api.md)). The screen is a later task. Both take the same requests:

| Request | What it does |
|---|---|
| `POST …/webhooks` | `{ "url", "events": [...], "description"? }`. The answer carries `secret` — **the only time it is shown** |
| `PATCH …/webhooks/{webhookId}` | Change the URL, events or description; `{ "enabled": true }` switches an endpoint back on |
| `DELETE …/webhooks/{webhookId}` | Removes the endpoint and its delivery log |
| `POST …/webhooks/{webhookId}/rotate-secret` | A new secret, shown once; deliveries from now on are signed with it |
| `GET …/webhooks/{webhookId}/deliveries` | The delivery log, newest first |
| `POST …/webhooks/{webhookId}/deliveries/{deliveryId}/replay` | Sends that delivery's body again |

The secret is stored encrypted under `APP_MASTER_KEY`. Every change is in the audit log, naming the staff member or the API key that made it.

## Events

| Event | When | `data` |
|---|---|---|
| `ticket.created` | A ticket is created, by any channel | `ticket` |
| `ticket.updated` | A ticket's fields or status change, or it is reopened | `ticket` |
| `ticket.replied` | A message is added to the thread — the customer's, an agent's or the system's. Internal notes are never sent | `ticket`, `message` |
| `ticket.closed` | A ticket is closed (not marked spam) | `ticket` |
| `contact.created` | A contact is created: by an agent, the API, or a channel recognising somebody new | `contact` |
| `csat.received` | A customer rates a closed conversation | `survey`: `id`, `ticketId`, `rating`, `comment`, `ratedAt` |
| `article.published` | A help center article is published, in one language | `article`: `id`, `slug`, `locale`, `title`, `visibility`, `publishedAt` |

`ticket`, `message` and `contact` have the shapes the API answers with (`/api/docs`).

## The request

```
POST <your url>
Content-Type: application/json
User-Agent: Helpdock-Webhooks/1
X-Helpdock-Event: ticket.created
X-Helpdock-Event-Id: 0192a3f4-…
X-Helpdock-Delivery: 0192a3f5-…
X-Helpdock-Signature: t=1790000000,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
```

```json
{
  "id": "0192a3f4-…",
  "event": "ticket.created",
  "createdAt": "2026-10-05T10:00:00.000Z",
  "brandId": "0192a000-…",
  "data": { "ticket": { "id": "…", "number": 1042, "subject": "…" } }
}
```

`id` is the event's. It is the same on every retry and on a replay, so **dedupe on it**: a delivery is at least once. The body is frozen when the event happens; a retry sends the same bytes.

## Verifying the signature

`v1` is the hex HMAC-SHA256, keyed with the endpoint's secret, of the timestamp, a dot, and the raw body. Check it against the raw bytes before parsing them, and refuse a timestamp more than five minutes old.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyHelpdock(secret, header, rawBody, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(',').map((part) => part.split('=', 2)));
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1 ?? '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

With Express, read the body raw: `app.post('/hooks/helpdock', express.raw({ type: 'application/json' }), (req, res) => { if (!verifyHelpdock(secret, req.get('x-helpdock-signature'), req.body.toString('utf8'))) return res.sendStatus(401); … })`.

## Retries and switching off

- Any `2xx` within 15 seconds is a success. Anything else — another status, a timeout, a refused connection — is a failed attempt.
- **Redirects are not followed.** A `3xx` is a failed attempt; register the final URL.
- A failed delivery is retried with exponential backoff, eight attempts in all, starting 30 seconds after the first and doubling each time: the last is 32 minutes after the one before it, a little over an hour after the event.
- After the eighth, the delivery is `failed`. After **10 failed deliveries in a row** the endpoint is switched off (`enabled: false`, `disabledReason: "failures"`) and receives nothing until it is switched back on. A successful delivery resets the count.

## The delivery log

Each delivery records its status (`pending`, `succeeded`, `failed`, or `skipped` when the endpoint was switched off before it was sent), the number of attempts, the last answer's status code, its first 1 KB as text, how long it took, and the error if there was no answer. Nothing else of your response is kept, followed or displayed. **Replay** sends a delivery's body again as a new delivery, with the same event id and `replayOf` naming the original.

## Network safety

Every delivery goes through Helpdock's outbound client ([DOMAIN-RULES §13](../planning/DOMAIN-RULES.md#13-outbound-network-safety)): `http` and `https` only, ports 80, 443, 8080 and 8443, no credentials in the URL, and never a private, loopback, link-local or cloud-metadata address — checked on the address the name resolves to, at delivery time. Blocked attempts are logged with the destination. To deliver to an internal service on purpose, an operator adds its range to `OUTBOUND_ALLOW_CIDRS`.
