# Widget protocol

The wire protocol the chat widget speaks. It is written for anyone building a
client other than the bundled `widget.js`, such as an iOS or Android app, a
kiosk, or a test harness. The protocol is specified by [DOMAIN-RULES
§4.1–4.2](../planning/DOMAIN-RULES.md#4-identity-and-conversation-ownership) and
[§7](../planning/DOMAIN-RULES.md#7-realtime-delivery-contract) and implemented
by M4-02, M4-03 and M4-04.

The Zod schemas in
[`packages/schemas/src/widget-protocol.ts`](../../packages/schemas/src/widget-protocol.ts)
are the contract. This page describes them and does not replace them: the api
parses every request body and every response through those schemas, so when
this page and the schemas disagree, the schemas are right and this page is a
bug.

## The one rule

> Socket.IO does not guarantee delivery. The REST API is the source of truth;
> sockets are notifications. — DOMAIN-RULES §7

These rules follow from it:

- A message counts as sent only when a REST response (or a socket
  acknowledgement, which is the same call) has given it a `seq`.
- A client keeps one cursor per conversation: the highest `seq` it holds.
- After any gap, reconnect or doubt, the client asks
  `GET …/messages?after=<cursor>`.
- Typing, presence and queue position are ephemeral. The server never
  acknowledges or replays them.

## Base URL and headers

Every route lives under `/api/widget/:brandId`, where `brandId` is the brand's
UUID. The admin shows it in the embed tag under **Channels › Widget**:

```html
<script type="module" src="https://support.example.com/widget.js" data-brand="0192c3f0-…"></script>
```

The api serves the bundled widget itself, from `WIDGET_DIST_DIR`:
`GET /widget.js`, its lazy `GET /chunks/:file` and its fonts under
`GET /widget-fonts/:file`. Those three answer any origin
(`Access-Control-Allow-Origin: *`, `Cross-Origin-Resource-Policy:
cross-origin`); the brand's allowed origins are checked by the `/api/widget`
calls the script then makes. The hashed chunks are cached for a year,
`widget.js` for five minutes, because its name survives a deploy.

| Header | When | Value |
|---|---|---|
| `Origin` | every request, including the socket handshake | one of the brand's allowed origins |
| `Authorization` | every route except `config`, `availability` and a first `session` | `Visitor <visitorSecret>` |
| `Content-Type` | on a body | `application/json` |
| `If-None-Match` | optional, on `config` | the `ETag` from the last `config` |

**Origin.** The api compares `Origin` as a string with the brand's allowed
origins, which it stores normalised as `scheme://host[:port]`. A request with no
`Origin`, or with `Origin: null`, is refused. A browser sends the header on
its own. A native app has to send one itself: pick one of the brand's allowed
origins, for example `https://app.example.com`, and send it on every request
and on the socket handshake. The check keeps the widget off other people's
websites. Against anything that is not a browser, the protection comes from
the visitor credential and the throttles, not from the origin check.

**CORS.** Widget routes answer a preflight with the request's origin, allow the
headers `authorization`, `content-type` and `if-none-match`, and never allow
credentials. The widget uses no cookies.

## Errors

A refusal uses the api's usual error body. `error.widget.reason` names the rule
that refused, and a client picks its words from that field:

```json
{
  "error": {
    "code": "forbidden",
    "message": "This page's origin is not in the brand's allowed origins",
    "requestId": "01J…",
    "widget": { "reason": "origin_not_allowed" }
  }
}
```

| `reason` | Status | Meaning |
|---|---|---|
| `origin_not_allowed` | 403 | The `Origin` is missing or is not in the brand's allowed origins. |
| `unauthenticated` | 401 | No `Authorization: Visitor` header, or a secret this brand never issued. |
| `rate_limited` | 429 | A throttle refused the request (see [Throttles](#throttles)). |
| `captcha_required` | 403 | The brand requires a CAPTCHA and `captchaToken` is missing or failed. |
| `not_found` | 404 | The conversation, attachment or help center article does not exist *for this visitor*. |
| `read_only` | 409 | The visitor may read this conversation but not write to it (another channel's ticket). |
| `content_policy` | 400 | The brand's content policy refuses this upload or attachment. |
| `unavailable` | 404 | The brand is not active, or the brand has switched the feature off (transcripts). |
| `invalid_payload` | 400 | The input did not make sense, for example a transcript address that is not an email. |
| `internal` | 500 | Anything unexpected. It carries no detail. |

A body, query or path that fails its schema is the api's ordinary
`validation_failed` (400), with `error.fields` and no `widget` field.

The api never answers "this exists but it is not yours". A guessed conversation
id and one that does not exist both get `not_found`.

## Session and identity

### A visitor

`POST /session`, body `widgetSessionRequestSchema`:

```json
{ "locale": "en" }
```

The response is `widgetSessionSchema`:

```json
{ "visitorId": "0192…", "visitorSecret": "Qm9…43 chars", "verified": false }
```

- `visitorSecret` is 256 random bits in base64url (43 characters). It is
  present **only in the response that issued it**. The api stores only a hash
  of it, so a lost secret cannot be recovered.
- Store the secret per brand. The bundled widget uses `localStorage` key
  `helpdock:<brandId>:visitor`; a native app uses its keychain. Send it on
  every later request as `Authorization: Visitor <secret>`.
- Call `session` on every launch, with the header when you hold a secret. A
  secret the brand recognises returns `visitorSecret: null`. A secret it does
  not recognise mints a new visitor and returns the new secret. Replace what
  you stored.
- Losing the secret, for example by clearing storage, makes a new anonymous
  visitor. The old conversations cannot be reached from the new one. This is
  deliberate (DOMAIN-RULES §4.1).

### The pre-chat email is a hint

A name and an email typed into the pre-chat form are saved on the visitor's
contact as **unverified**. Agents see them with an "unverified" badge. An
unverified address never opens a conversation, whichever contact it matches.
The only things that open a conversation are the visitor's own secret and a
signed identity.

### Signed identity

When a brand turns on **Signed identity**, the host site can tell Helpdock who
the signed-in user is. The host's **server** signs the user's details with the
brand's signing secret. The admin shows the secret once, when it is generated.
It starts with `hdws_`; use the whole string, prefix included, as the HMAC key.
Secrets generated before 0.3.1 start with `whsec_` and keep working.

1. Build the payload (`signedIdentityPayloadSchema`):

   | Key | Type | Notes |
   |---|---|---|
   | `user_id` | string, 1–255 | your stable user id; becomes the contact's verified `external_id` |
   | `email` | string, ≤ 320, optional | |
   | `name` | string, ≤ 200, optional | |
   | `ts` | integer | seconds since the epoch; accepted within **5 minutes** either way |

2. Serialise it canonically (`canonicalIdentityJson`). Put the keys in the
   order `user_id`, `email`, `name`, `ts`. Leave absent keys out. Use no
   whitespace, and use `JSON.stringify` escaping:

   ```json
   {"user_id":"u_42","email":"mona@example.com","ts":1790503200}
   ```

3. Compute `signature = hex(HMAC-SHA256(signingSecret, canonicalJson))`, in
   lower case, 64 characters.

4. Pass both to the client, which sends them untouched:

   ```json
   {
     "identity": {
       "payload": { "user_id": "u_42", "email": "mona@example.com", "ts": 1790503200 },
       "signature": "9f86d0…"
     },
     "locale": "en"
   }
   ```

If the signature and the time window both check out, the response has
`verified: true`. The visitor is then linked to the contact holding that
`external_id`, and the api creates the contact if none exists. The link
continues **widget conversations only**. The visitor can read and write every
`chat` conversation of that contact, from any device that presents a valid
signature.

When the brand also turns on **Show every channel**
(`signed_identity_sees_all_channels`), the verified visitor can see that
contact's email, Telegram and other tickets too. Those are **read-only** in the
widget: a send gets `read_only` (409).

An invalid or expired signature does not fail the call. The visitor stays
anonymous (`verified: false`), and the api logs and audits a security event. A
`session` call **without** an identity clears any earlier link, so a user who
signs out of the host site loses the verified history on the next load.

Never sign on the client. A signing secret that has been shipped in an app or
a page can no longer be trusted.

## Configuration

`GET /config?locale=en|ar` needs no visitor. It returns `widgetConfigSchema`,
everything the first paint needs:

| Field | What it holds |
|---|---|
| `brandName`, `defaultLocale`, `locale` | the brand, and the language the strings below are in: `?locale=`, or the brand's default |
| `mode`, `appearance` | the widget mode and the Widget tab's stored choices |
| `theme` | the brand theme, resolved on the server: `tokens.light` and `tokens.dark` (DESIGN §2.2 semantic token names to colours), `radius.md` and `radius.lg`, `fontFamily`, the self-hosted `fonts` with their URLs and unicode ranges, and the `launcher` (style, label, `end` or `start`) |
| `greeting` | the welcome line in `locale`, the Arabic falling back to the English; `null` when empty |
| `prechat` | whether the form is on and its fields; a custom field's `label` is in `locale` |
| `contactForm` | the contact form's fields beyond name, email and message: the pre-chat's custom fields |
| `showAgentIdentity`, `whenUnavailable`, `transcriptEnabled` | the conversation card's switches |
| `contentPolicy` | what the composer may send; the api enforces the same policy on upload |
| `captcha` | the provider and site key, or `null` |
| `signedIdentity` | whether the brand accepts a signed identity |
| `availability` | as below |
| `popularArticles` | up to five of the brand's public articles in `locale`, most viewed over 30 days first, then the newest (see [Help center](#help-center)) |
| `helpCenterUrl` | the help center on the brand's primary verified domain, or `null` |
| `showPoweredBy` | whether to draw "Powered by Helpdock" |

The response carries an `ETag`, which differs per locale, and
`Cache-Control: no-cache`. Send `If-None-Match` to get a `304`. A locale other
than `en` or `ar` is refused with `400`.

`GET /availability` returns `widgetAvailabilitySchema` on its own:

```json
{
  "open": true,
  "nextOpenAt": null,
  "timezone": "Asia/Riyadh",
  "agentsOnline": true,
  "agents": [{ "name": "Karim", "avatarUrl": null }, { "name": "Lina", "avatarUrl": null }]
}
```

`nextOpenAt` is `null` while the brand is open, and also when the brand has no
business hours. `agents` lists up to five of the brand's agents who are online
right now (not away), by first name and sorted, for the "Lina, Karim and Sara
are online now" line. It is empty when nobody is online, and also when the
brand turned off **Show the agent's name and photo**: `agentsOnline` still says
whether anybody is there. It never carries a staff id or a surname. Staff have
no stored photo yet, so `avatarUrl` is `null` and the widget draws initials.

## Conversations

| Method and path | Body / query | Response |
|---|---|---|
| `GET /conversations` | | `widgetConversationListSchema` |
| `POST /conversations` | `widgetStartRequestSchema` | `widgetStartResponseSchema` |
| `GET /conversations/:id` | | `widgetConversationSchema` |
| `GET /conversations/:id/messages` | `?after=<seq>&limit=<1–200>` | `widgetMessagePageSchema` |
| `POST /conversations/:id/messages` | `widgetSendRequestSchema` | `widgetSendResponseSchema` |
| `GET /conversations/:id/queue` | | `widgetQueueSchema` |
| `POST /conversations/:id/typing` | `{ "typing": true }` | `204` |
| `POST /conversations/:id/read` | `{ "seq": 12 }` | `204` |
| `POST /conversations/:id/transcript` | `{ "email": "…" }` | `202` |

The conversation list holds what this visitor may see: the conversations they
started, plus any their verified contact may see.

### Starting

A start opens the conversation, with or without its first message:

```json
{
  "clientId": "0192c3f0-…",
  "text": "My order has not arrived",
  "prechat": { "name": "Mona", "email": "mona@example.com", "custom": { "order_number": "A-1001" } },
  "captchaToken": "…"
}
```

- `text` is optional. With it, the response's `message` is that first message;
  without it, the conversation opens empty, `message` is `null`, and the
  visitor's first `POST …/messages` names the conversation for the agents. The
  bundled widget opens the conversation this way, just before the first
  message, and from the pre-chat and contact forms.
- `clientId` makes the start idempotent: a start repeated with the same
  `clientId` (a retry, or two sent together) answers the conversation the
  first one opened. Choose a new one for a new conversation.

- Send `captchaToken` when `config.captcha` is not null. Without a valid token
  the api answers `captcha_required`.
- `prechat` carries the pre-chat form's answers, or the contact form's, which
  asks the same fields. `prechat.custom` is keyed by ticket custom field keys.
  The api checks the values against the field definitions and keeps only the
  fields the brand asks for (`config.prechat.fields`). An email given here is
  unverified (DOMAIN-RULES §4.1).
- The api validates a retry's `clientId` before it verifies the CAPTCHA, so a
  retried start does not need a fresh token.
- `articleId` (optional) names the help center article the visitor pressed
  "Still need help?" on. When it is a published, public article of the brand,
  the ticket's thread tells the agents which one ("Came from the help center
  article …"); anything else is ignored without an error, so a start never
  fails over it and never reveals whether an article exists.

### Sending, and the delivery contract

```json
{ "clientId": "0192c3f0-…", "text": "Thanks", "attachmentIds": [] }
```

- `clientId` is a UUID (v7 recommended) that the client chooses **before the
  first attempt**. Every retry sends the same one. A second request with a
  `clientId` the api has already stored returns the **same** message and `seq`
  and does not create a second message. The api holds a lock on a start's
  `clientId` too, so two starts sent together create one conversation.
- The response's `message.seq` is the proof of delivery. If no response
  arrives within `WIDGET_SEND_TIMEOUT_MS` (10 s), show "not sent, retry" and
  retry with the same `clientId`.
- The response's `conversation` may differ from the conversation you
  addressed. A reply to a closed conversation either reopens it or continues
  on a new one (DOMAIN-RULES §2.3), and then `conversation.id` is the new
  conversation. The old conversation's `continuedById` points to it.
- `text` may be empty only when `attachmentIds` is not. The limit is 10,000
  characters. A message can carry up to 20 attachment ids, and each must be
  one of this visitor's own confirmed uploads.

### Catch-up

`GET …/messages?after=<cursor>` returns up to `limit` messages (default 100,
maximum 200) with `seq > after`, oldest first:

```json
{ "messages": [ … ], "lastSeq": 17, "hasMore": false }
```

Move the cursor to **`lastSeq`**, not to the `seq` of the last message returned.
Internal notes take a `seq` too, and a visitor never sees them, so the numbers
a visitor sees can skip. `lastSeq` covers the skipped numbers, so the same gap
does not trigger a catch-up again. When `hasMore` is true, ask again with
`after` set to the last returned `seq`.

A message (`widgetMessageSchema`) carries `author` (`visitor`, `agent`,
`system` or `ai`), plain `text` for every author, sanitised `html` for agent
replies and `null` for the visitor's own messages, `clientId` on the visitor's
own messages only, and `agent` (a first name and avatar) only when the brand
shows agents. It has no field that could carry an internal note.

### Typing, read, queue, transcript

- **Typing** tells the agents the visitor is typing. Repeat `typing: true`
  while the visitor types. An indicator that is not repeated within
  `WIDGET_TYPING_TTL_MS` (6 s) counts as stopped.
- **Read** tells the agents the visitor has read up to `seq`.
- **Queue** returns `position`: 1 means next in line. It is `null` once an
  agent holds the conversation, and when the conversation is closed.
- **Transcript** emails this one conversation to the address given. The
  message comes from the brand's outbound email, holds no link that grants
  access, and goes through the outbox. It works only when the brand turned
  transcripts on (`unavailable` otherwise) and only for `chat` conversations
  (`read_only` otherwise). Each conversation allows three transcripts an hour.

## Help center

The widget's help center modes read the brand's help center (M5-10). Every
route here needs the visitor's credential and answers **public** articles only:
published, public, of a help center that is not internal-only. An internal or
draft article is `not_found`, the same as one that does not exist.

| Method and path | Query | Response |
|---|---|---|
| `GET /articles` | `widgetArticleSearchQuerySchema`: `q` (1–200), `locale`, `limit` (1–20, default 10), `purpose` (`search` or `suggest`) | `widgetArticleSearchSchema` |
| `GET /articles/:articleId` | `widgetArticleQuerySchema`: `locale`, `searchId` (optional) | `widgetArticleSchema` |

```json
{
  "articles": [
    {
      "id": "0192c3f0-…",
      "title": "Refund timelines",
      "excerpt": "We issue your refund as soon as the return reaches our warehouse …",
      "section": "Refunds",
      "url": "https://help.example.com/en/articles/refund-timelines"
    }
  ],
  "searchId": "0192c3f1-…"
}
```

- **Search** matches whole words in the language's own stemming (`english` or
  `arabic`), the last word as a prefix, and article titles through typos. A
  title match ranks above a body match. An article with no version in
  `locale` is searched, and answered, in the brand's default language.
- `excerpt` is plain text: the words around the match, or the article's
  description in the config's list. Escape it before you put it in a page.
- `url` is the article on the brand's help center domain, or `null` while the
  brand has none. Offer "Open in help center" only when it is set.
- `purpose: 'search'` is a visitor's search. The api writes it to the brand's
  search log (the query, the language, how many articles it found; never who
  asked) and answers its `searchId`. `purpose: 'suggest'` is for suggestions
  while a chat message is typed: searched the same way, not logged, and
  `searchId` is `null`.
- **Opening an article** counts one view for this visitor per article per day.
  Send the `searchId` of the search it was found by, and the Insights tab
  counts that search as "opened a result".
- The article's `bodyHtml` was sanitised when it was saved. It runs on the
  customer's origin, so sanitise it again before you render it, as the bundled
  widget does. `readingMinutes` counts 200 words a minute; `updatedAt` is when
  the version was last published.

## Attachments

The widget uses the ticket attachment pipeline ([attachments.md](attachments.md)).
The brand's content policy is checked at presign, at confirm and again in the
worker.

1. `POST /conversations/:id/attachments` with `attachmentPresignRequestSchema`
   (`kind`, `mime`, `size`, `fileName`). The response has `attachmentId`, `url`,
   `headers` and `expiresAt`.
2. `PUT` the bytes to `url` with `headers` exactly as given. The headers are
   part of the signature.
3. `POST /conversations/:id/attachments/:attachmentId/confirm`. The response is
   `widgetAttachmentSchema`.
4. Send a message with the id in `attachmentIds`.

`GET /conversations/:id/attachments/:attachmentId?variant=original` returns
`{ attachment, url, expiresAt }`, a short-lived download URL. The api issues it
only for the visitor's own uploads and for files on public replies of a
conversation the visitor may read.

## Realtime: the `/widget` socket

Socket.IO v4, namespace `/widget`, path `/socket.io`, on the api's host:

```js
io('https://support.example.com/widget', {
  path: '/socket.io',
  transports: ['websocket'],
  auth: { brandId, visitorSecret },
  extraHeaders: { Origin: 'https://app.example.com' }, // native clients only
});
```

- **Handshake.** The `auth` object must match `widgetHandshakeSchema`, and the
  handshake passes the same origin, credential and address checks as REST. A
  refusal reaches `connect_error` with `err.data.code` set to one of the
  [error reasons](#errors).
- **On connect** the socket joins the brand's visitors room and receives one
  `presence` event.
- Every client event takes an **acknowledgement**, `{ ok: true, data }` or
  `{ ok: false, error: { code, message } }`. A handler never throws. Every
  event goes through the checks again, so a brand that removes an origin
  refuses the next event without waiting for a reconnect.

| Client → server | Payload | Ack `data` |
|---|---|---|
| `conversation:join` | `{ conversationId }` | `{ conversationId, lastSeq }` |
| `conversation:leave` | `{ conversationId }` | `{ conversationId }` |
| `message:send` | `{ conversationId, message: widgetSendRequestSchema }` | `widgetSendResponseSchema` |
| `typing:set` | `{ conversationId, typing }` | `{ conversationId }` |
| `message:read` | `{ conversationId, seq }` | `{ conversationId }` |

`conversation:join` runs the same ownership check as
`GET /conversations/:id`. After joining, the socket immediately receives a
`queue` event. Compare the ack's `lastSeq` with your cursor, and catch up over
REST if it is higher. `message:send` is the REST send: it uses the same
`clientId` dedupe and the same `seq`.

Every server event is wrapped in an envelope `{ seq, at, data }`. `seq` is set
on `message` events and `null` on all others.

| Server → client | `data` |
|---|---|
| `message` | `widgetMessageSchema` |
| `receipt` | `{ conversationId, kind: "delivered" \| "read", seq }` |
| `typing` | `{ conversationId, typing, agentName }` |
| `presence` | `{ agentsOnline, agents }`, as in [`GET /availability`](#configuration) |
| `queue` | `{ conversationId, position }` |
| `conversation` | `{ conversationId, state: "open" \| "closed", continuedById }` |

On a `message` event:

- If `seq` is at or below your cursor, you already hold it; ignore it.
- If `seq` is exactly `cursor + 1`, apply it and advance the cursor.
- If `seq` is higher than that, apply it, then catch up over REST from your
  old cursor.

After every reconnect, catch up over REST before you trust the socket.

The bundled widget
([`apps/widget/src/transport/remote.ts`](../../apps/widget/src/transport/remote.ts))
is a reference client for all of this. It also treats the browser's `offline`
event as a disconnect and its `online` event as a reconnect, so a dropped
network is noticed at once rather than after the socket's ping timeout, and
messages written meanwhile go out, with their `clientId`, as soon as it is
back.

## Realtime fallback: SSE

When a network will not carry a WebSocket, use
`GET /stream?conversationId=<id>&after=<cursor>`. The bundled widget switches
to it after three failed connects.

- `EventSource` cannot send an `Authorization` header, so read the stream with
  `fetch` (or your platform's streaming HTTP client) and send the usual
  headers.
- Frames are standard SSE, `event: <name>` and `data: <envelope JSON>`, with
  the same names and envelopes as the socket. The stream starts with
  `retry: 2000`, then every visible message after `after` (up to 200), then
  one `presence` event, then live events. Lines that start with `:` are
  heartbeats.
- The stream carries notifications only. Send messages, typing and read
  receipts over REST.
- The server closes the stream after `WIDGET_SSE_MAX_AGE_MS` (5 minutes).
  Reconnect with your current cursor. If the initial burst reached 200
  messages, catch up over REST, because the stream does not page.

## Throttles

| Rule | Limit | Keyed by |
|---|---|---|
| any widget request (REST, handshake) | 300 per 5 minutes | brand and client address |
| new visitors (`session` without a known secret) | 30 per 10 minutes | brand and client address |
| writes: start, send, upload, transcript | 30 per minute | visitor |
| transcripts | 3 per hour | conversation |

Events on a socket that has already passed the handshake do not count against
the per-address rule again, but writes still count against the per-visitor
rule. A throttled request gets `rate_limited` (429). Back off and retry.

## Constants

| Name | Value |
|---|---|
| `WIDGET_API_PREFIX` | `/api/widget` |
| `VISITOR_AUTH_SCHEME` | `Visitor` |
| `WIDGET_NAMESPACE` | `/widget` |
| `SIGNED_IDENTITY_WINDOW_SECONDS` | 300 |
| `WIDGET_MESSAGE_TEXT_MAX` | 10,000 |
| `WIDGET_MESSAGE_PAGE_MAX` | 200 |
| `WIDGET_PRECHAT_VALUE_MAX` | 2,000 |
| `WIDGET_SEND_TIMEOUT_MS` | 10,000 |
| `WIDGET_SSE_MAX_AGE_MS` | 300,000 |
| `WIDGET_TYPING_TTL_MS` | 6,000 |
| `WIDGET_ARTICLE_SEARCH_MAX` | 20 |
