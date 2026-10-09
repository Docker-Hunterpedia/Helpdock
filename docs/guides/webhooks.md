# Outbound webhooks

Helpdock POSTs an event to your endpoint when something happens in a brand: a ticket is created or answered, a contact appears, a customer rates a conversation (M8-03, [REQUIREMENTS §4.12](../planning/REQUIREMENTS.md#412-outbound-webhooks)).

## Managing endpoints

The Admin manages a brand's endpoints (`brand:manage`) on **Developers › Webhooks** in the admin (artboard `Admin/Developers-Webhooks`), which calls `/api/brands/{brandId}/webhooks`; an API key with `webhooks:manage` manages them at `/api/v1/webhooks` (see [the API guide](api.md)).

### The Developers › Webhooks page

- **A red banner** names each endpoint Helpdock switched off after failed deliveries, with the last answer and when, and offers **Open log** and **Turn back on**.
- **The Endpoints table** shows each URL, its events, Active or Turned off, the share of the last 24 hours' finished deliveries that succeeded, and the newest delivery's answer (or which attempt is next). Its row menu sends a test event, edits, turns the endpoint off or on, and deletes it.
- **Add endpoint** takes an `https://` URL and the events. Helpdock resolves the name before saving it: a private, loopback or link-local address is refused with the address it found, and plain `http://` is refused (see [Network safety](#network-safety)). The signing secret is then shown **once**, with **Send test event** beside it.
- **The open endpoint** shows its events and its signing secret as a masked field with **Rotate**, which asks first and then shows the new secret once.
- **The delivery log** lists the endpoint's deliveries, newest first, filterable to failed or delivered ones, with the status code (or Timeout, Refused, Redirect, No answer), the attempt, the duration and when the next retry runs. A row opens **the delivery detail**: the attempts so far, the request headers exactly as the last attempt sent them (the `X-Helpdock-Signature` line marked), the body, and the first 1 KB of the answer. **Replay** sends it again.

### The routes

Both take the same requests, except the two the page alone uses:

| Request | What it does |
|---|---|
| `POST …/webhooks` | `{ "url", "events": [...], "description"? }`. The answer carries `secret` — **the only time it is shown**. A refused URL answers `400` with `error.webhooks.reason` (`webhook-destination-blocked`, with `address`, or `webhook-https-required`) |
| `PATCH …/webhooks/{webhookId}` | Change the URL, events or description; `{ "enabled": true }` switches an endpoint back on |
| `DELETE …/webhooks/{webhookId}` | Removes the endpoint and its delivery log |
| `POST …/webhooks/{webhookId}/rotate-secret` | A new secret, shown once; deliveries from now on are signed with it |
| `GET …/webhooks/{webhookId}/deliveries` | The delivery log, newest first |
| `GET /api/brands/{brandId}/webhooks/{webhookId}/deliveries/{deliveryId}` | Admin only. One delivery with `request`: the URL, the body, and the headers its last attempt sent, signature included (none before the first attempt) |
| `POST /api/brands/{brandId}/webhooks/{webhookId}/test` | Admin only. Sends a `ping` event to this endpoint alone, through the same queue and job as any delivery; answers `202` with the delivery to watch |
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

**`ping`** is not an event an endpoint subscribes to: it is what "Send test event" sends, to that endpoint alone, whatever its events. Its `data` is `webhook`: the endpoint's `id` and `url`. A receiver should answer it `2xx` and otherwise ignore it.

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

Each delivery records its status (`pending`, `succeeded`, `failed`, or `skipped` when the endpoint was switched off, or the brand scheduled for deletion, before it was sent), the number of attempts, the last answer's status code, its first 1 KB as text, how long it took, and the error if there was no answer. Nothing else of your response is kept, followed or displayed. **Replay** sends a delivery's body again as a new delivery, with the same event id and `replayOf` naming the original.

## Network safety

Every delivery goes through Helpdock's outbound client ([DOMAIN-RULES §13](../planning/DOMAIN-RULES.md#13-outbound-network-safety)): ports 80, 443, 8080 and 8443, no credentials in the URL, and never a private, loopback, link-local or cloud-metadata address — checked on the address the name resolves to, at delivery time. Blocked attempts are logged with the destination, and show as **Refused** in the delivery log. To deliver to an internal service on purpose, an operator adds its range to `OUTBOUND_ALLOW_CIDRS`.

The same check runs when an endpoint is added or its URL is changed, so a private address is refused in the form rather than an hour later in the log. Two rules apply there:

- **HTTPS only.** Plain `http://` is refused (`webhook-https-required`) unless the name resolves inside `OUTBOUND_ALLOW_CIDRS`: an operator's own service may not speak TLS, somebody else's endpoint must.
- A name that does not resolve yet is accepted over `https`; its deliveries fail, and say so, until it does.
