# Meta channels

How an install receives WhatsApp, Messenger and Instagram messages (M10, [ADR 0025](../decisions/0025-meta-channels-through-one-graph-adapter.md)). This page is a stub: it describes the parts that exist, the webhook Meta calls (M10-02), what a WhatsApp message becomes (M10-03) and replying (M10-06). The dashboard walk-through per platform, connecting an account, App Review and the rest of the pricing are written with the deliverables that build them and gathered here by M10-11.

An install has **one Meta developer app**. A Meta app has one callback URL and one signing secret, so every connected WhatsApp number, Facebook Page and Instagram account of every brand posts to the same route, and Helpdock finds the brand from the account the message names.

## Where Meta posts

```
GET|POST  <APP_URL>/api/meta/webhook
```

For `APP_URL=https://support.example.com` that is `https://support.example.com/api/meta/webhook`. Paste it into the **Callback URL** field of each product in the Meta dashboard (WhatsApp, Messenger, Instagram). `GET /api/meta/app` answers with it as `callbackUrl`.

The route is public (Meta has no session) and protected by the verify token and the signature below. It answers at most 3,000 requests a minute per address and accepts a body up to 3 MiB, Meta's own cap.

## The app's settings

Four install settings describe the app. Each can be set from the environment, which also locks it ([configuration](configuration.md)); the App card of Channels › Meta (M10-07) will show whether each is set:

| Setting | Environment | What it is for |
|---|---|---|
| `meta.appId` | `HD_META_APP_ID` | The app's id, to recognise Helpdock's own replies echoed back (Messenger, M10-04). |
| `meta.appSecret` | `HD_META_APP_SECRET` | Signs every webhook (`X-Hub-Signature-256`). Without it the webhook refuses everything. |
| `meta.instagramAppSecret` | `HD_META_INSTAGRAM_APP_SECRET` | The Instagram product's own secret. Optional: leave it empty when Meta signs Instagram webhooks with the app secret. |
| `meta.webhookVerifyToken` | `HD_META_WEBHOOK_VERIFY_TOKEN` | The token Meta sends with its handshake. |

Which of the two secrets signs an Instagram webhook under Instagram Login is not settled by Meta's documentation ([open questions](../in-development/M10-meta-channels.md#open-questions)). Helpdock accepts a webhook signed with either one that is set.

## The handshake

When you save the callback URL, Meta sends

```
GET /api/meta/webhook?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<number>
```

Helpdock answers `200` with the challenge as `text/plain` when `hub.mode` is `subscribe` and the token equals `meta.webhookVerifyToken` (compared in constant time), and `403` for anything else, including every request while no token has been made. The challenge must be 1 to 256 printable characters.

The token is made the first time an install admin reads the App card (`GET /api/meta/app`); a request to the public handshake never writes a setting. `POST /api/meta/app/verify-token` makes a new one and returns it once as `{ verifyToken }`; the old one stops working at once, and the change is recorded in the audit log by key, never by value. Both routes need `install:admin`. A token set by `HD_META_WEBHOOK_VERIFY_TOKEN` cannot be replaced from the screen (`409`).

`GET /api/meta/app` answers `{ appIdSet, callbackUrl, verifyTokenHint, secretsLockedByEnv }`: whether an app id is saved, where Meta posts, the last four characters of the verify token and which of the four settings an environment variable has taken over. No secret is ever returned.

## Deliveries

Every `POST` is checked in this order:

1. **Signature.** `X-Hub-Signature-256: sha256=<hex>` must be the HMAC-SHA256 of the **raw bytes** of the body under the app secret or, when set, the Instagram app secret. The check is constant-time and tries every secret. A missing, malformed or wrong signature, and an install with no app secret, are the same `401`, and nothing else is read or filed.
2. **Envelope.** `{ object, entry[] }` with `object` one of `whatsapp_business_account`, `page`, `instagram`. A signed body that is not one is `400`.
3. **Account.** Each entry is routed to a connected account across all brands: WhatsApp by `value.metadata.phone_number_id` (one business account can hold several numbers, possibly of different brands), Messenger and Instagram by the entry's `id`. The account is unique on `(platform, external id)` across the install. An unknown account is counted and passed over.
4. **Brand.** An account whose brand is being deleted (its 30-day grace, [DOMAIN-RULES §11](../planning/DOMAIN-RULES.md#11-data-lifecycle)) is passed over and counted. It is still answered `200`: the URL is the install's, not the brand's, so a `410` could only make Meta redeliver that brand's events for days or unsubscribe the app for every brand ([ADR 0025](../decisions/0025-meta-channels-through-one-graph-adapter.md), decision 4).
5. **Filing.** The remaining accounts' events are filed, in the order Meta sent them, in **one transaction of the account's brand** (system context, `app.principal_id = meta.webhook`), each event in a savepoint. A customer's message is skipped as a duplicate when `ticket_messages.external_message_id` already holds its `wamid.…` or `mid` for that platform, so Meta's redeliveries and two simultaneous deliveries of one batch file one message. A message from a sender on the brand's block list is dropped and counted. An account whose transaction fails is logged and recorded on the account (`last_error`, never a message or a token); the others in the batch are still filed.

The webhook never calls Graph. Whatever an event causes outside the database is an outbox row written in the same transaction ([DOMAIN-RULES §6](../planning/DOMAIN-RULES.md#6-transactional-outbox)).

### What the answer means to Meta

Meta treats anything other than `200` as the webhook being down: WhatsApp redelivers for seven days, and Messenger and Instagram unsubscribe the app after an hour of failures. So everything after a valid signature is `200`: filed, duplicate, ignored, an unknown account, a brand in its deletion grace, an event Helpdock does not file. The exceptions:

| Status | When |
|---|---|
| `500` | Nothing in the batch was filed and at least one account's transaction failed (the database was down). Meta redelivers and the dedupe key makes that safe. A batch in which something was filed is `200`, so an account that always fails cannot keep the other brands in Meta's retry loop. |
| `400` | The signed body is not a Meta envelope. |
| `401` | The signature. |
| `413` | A body over 3 MiB. |
| `429` | More than 3,000 requests a minute from one address. |

## Inbound services

Each platform's events go to its inbound service: WhatsApp (M10-03, below), Messenger (M10-04), Instagram (M10-05). Until a platform's is installed, the webhook logs that an event arrived (platform and kind only, never the customer or the words) and files nothing.

## WhatsApp: what a customer's message becomes

A message to a connected number opens a ticket in the number's department, or, when the customer already has a conversation with that number, continues its ticket: the same rules as email, the widget and Telegram, including [the reopen policy](tickets.md) for a closed one.

| The customer sends | The ticket gets |
|---|---|
| Text | A message. The ticket's subject is its first line |
| An image, video, document, voice note, audio file or sticker | A message with the caption as its words (it may be empty) and the file as an attachment. A sticker is an image, and a photo sent as a document is an image |
| A location | `Location: 52.52, 13.405`, the place's name and a map link, with "Location" in the customer's language |
| Shared contacts | `Contact: <name>`, then their company, numbers and addresses |
| A reply to an earlier message | The reply, with the earlier message's words quoted above it when that message is on the same ticket, whether the customer or an agent wrote it |
| A reaction | A line in the thread, "The customer reacted <the emoji> to a message.", on the ticket of the message reacted to; taking the reaction back is a line too. Never a message, and it does not open the reply window |
| Something Helpdock cannot show (a poll, an order) | A line, "The customer sent something that cannot be shown here.". It does open the reply window, because the customer did write |
| A new number (WhatsApp reports the change) | The new number becomes the contact's verified phone, the old one is taken off, and a line names both |

**The customer is the business-scoped user id Meta sends**, and the number it sends beside it (`wa_id`) is recorded as the contact's phone, **verified**: WhatsApp checked the SIM and Meta signed the webhook. A customer who has adopted a WhatsApp username may withhold the number; the contact then has no phone. A phone an agent typed earlier moves to the contact WhatsApp proved it for, and the two are suggested as duplicates ([Contacts](contacts.md)).

**Files are fetched after the webhook answers.** The message is filed at once with each file `pending`; a job asks Graph for the file with the account's token, checks it against the SHA-256 Meta sent, applies the brand's content policy and hands it to the same pipeline as any upload (re-encoded images, Opus voice notes). A file that cannot be had ends `rejected` and the message stays: `unreadable` (the bytes are not the ones Meta described, or Meta reported an error for the file), `too_large`, `mime_not_allowed` or `kind_disabled` (the brand's content policy), `object_missing` (Meta no longer has it: its ids live seven days and the job tries five times over about eight minutes), `processing_failed` (anything else, such as a token Meta no longer accepts, which also marks the account `token_expired`).

**Reports on replies** (`delivered`, `read`, `failed`) move the reply's delivery forward and never back; a `failed` report carries Meta's code and words, and one that says the 24-hour window had closed (`131047`) ends the delivery `refused`, which no retry fixes. Meta's billing category for the message is kept with the delivery.

**A sender on the block list is dropped** before any contact exists, whether the entry is the user id, or the phone number typed by hand; the block row counts the drops.

## Replying

An agent's public reply on a WhatsApp, Messenger or Instagram ticket is delivered to the customer on the same platform (M10-06, [ADR 0025](../decisions/0025-meta-channels-through-one-graph-adapter.md), 7 and 8). It goes through the outbox like every message to a customer ([DOMAIN-RULES §6](../planning/DOMAIN-RULES.md#6-transactional-outbox)): the reply, its `meta_deliveries` row and a `meta.reply` outbox row commit together, and the worker's `meta.send` job sends it. The request never calls Graph.

**The reply window comes first.** Meta lets a business write only for a time after the customer's last message, and Helpdock refuses a reply outside it when it is composed and again when the job runs. The rules, the `409 reply-window-closed` answer and the routes the ticket view reads are in the [tickets guide](tickets.md#reply-windows).

### What is sent

A reply is **parts**: its text cut at the platform's limit, then each attachment as a message of its own. Every accepted part is recorded at once, so a retry starts after the last one that landed and the customer never reads a part twice.

| | WhatsApp | Messenger | Instagram |
|---|---|---|---|
| Text per message | 4096 characters | 2000 characters | 1000 **bytes** (about 500 Arabic letters) |
| Sent to | the customer's number when Meta sent one, else their business-scoped user id (`recipient`) | the page-scoped id | the Instagram-scoped id |
| Endpoint | `POST /{phone-number-id}/messages` | `POST /{page-id}/messages` | `POST /{instagram-id}/messages` on `graph.instagram.com` |
| A file | uploaded to `/{phone-number-id}/media`, then sent by its id; the file name is the caption of an image or a video and the `filename` of a document | a five-minute presigned link, `is_reusable: false` | a five-minute presigned link |
| Pacing | one message per six seconds to one customer | none | none |

Text is plain: nothing an agent typed can be read as markup. The first message of a reply opens with one line, the author's first name and the brand, "Lina · Helpdock" (the brand alone for a reply nobody wrote), and that line counts toward the platform's limit; a reply that is only files sends it as a message of its own. The message of a Messenger or Instagram reply carries the delivery's id as `metadata`, so the echo of Helpdock's own send can be told from a message typed in the Page inbox.

**Files.** What is sent is what the media pipeline made of the upload: an image's kept original or its WebP, a voice note's Opus, a file's original. The limits are Meta's, and the types are the worse case its pages allow:

| | WhatsApp | Messenger | Instagram |
|---|---|---|---|
| Image | JPEG, PNG, 5 MiB | any, 25 MiB | JPEG, PNG, 8 MiB |
| Audio | AAC, AMR, MP3, M4A, Ogg Opus, 16 MiB | any, 25 MiB | AAC, M4A, WAV, 25 MiB |
| Video | MP4, 3GP, 16 MiB | any, 25 MiB | MP4, Ogg, AVI, MOV, WebM, 25 MiB |
| Any other file | a document, 100 MiB | 25 MiB | **PDF only**, 25 MiB |

A file that is not a native type of its kind, or is over its limit, goes as a document where the platform takes documents: the WebP of an image on WhatsApp, a 6 MiB JPEG, an MP4 over 16 MiB. Where it cannot go at all, it is **left out and the customer is told** in their language, in its place: "One file could not be sent here: warranty-terms.docx. Instagram only takes PDF files, so we will send it another way." The agent reads which file and why under the reply (`leftOut` in the delivery). A file the media pipeline refused is left out without a word, because the composer showed that when it was added.

An image is the pipeline's WebP unless the brand keeps originals (`keepOriginals` in the [content policy](attachments.md#the-content-policy), off by default), and Instagram takes no WebP: on a brand that does not keep originals, an image sent on Instagram is left out. Turn `keepOriginals` on for a brand that answers on Instagram.

**Messenger and Instagram fetch a file from a link.** The presigned link points at the bucket (`S3_ENDPOINT`), and Meta's servers must be able to reach that host. A bucket reachable only inside your network (MinIO at `http://minio:9000`) works for everything but files on these two platforms: use a public endpoint, or a reverse proxy in front of the bucket. WhatsApp is not affected: Helpdock uploads the bytes itself.

### Pacing

WhatsApp refuses more than one message every six seconds to one user (`131056`). A reply of three parts to one customer therefore takes about twelve seconds, and two replies to the same customer are spaced the same way. The job holds a Redis key per account and customer (`meta.pace:<account>:<customer>`, six seconds from the end of the last send); a part that finds it held moves its own job to **delayed** for the remainder and ends with BullMQ's `DelayedError`, which spends no attempt and frees the worker. Messenger and Instagram are not paced.

### WhatsApp replies cost money

Meta charges per delivered service message since 2026-10-01 ([open questions](../in-development/M10-meta-channels.md#open-questions)). A reply cut into parts, and every attachment, is one delivered message each. The delivery's `partsTotal` is that count, and the composer will say it before Send (M10-08).

### What a refusal does

What Graph answers decides what the job does (`meta.send`: five attempts, exponential from ten seconds):

| Graph said | The delivery | The account |
|---|---|---|
| A fault of Graph or the network (`1`, `2`, `131000`, `131016`, HTTP 5xx) | tried again; **failed** after the fifth | `last_error` |
| A rate limit (`4`, `17`, `32`, `613`, `130429`, `131056`, `80007`, `131057`) | tried again, and for `131056` the customer's slot is held first | `last_error` |
| The window is closed (`131047`, or `10` with sub-code `2018278`) | **refused**, never retried | nothing |
| A refusal that retrying cannot change (`551`, `100`, `131026`, `131049` to `131053`, `132000` to `132016`) | **failed** at once | `last_error` |
| A dead token (`190`, `102`, `463`, `467`, `0`) | **failed** at once | `status = token_expired`, `last_error`: an Admin pastes a new token |
| A missing permission (`3`, `10`, `200` to `299`) or a restricted account (`368`, `131031`, `133010`, `131042`, `130497`) | **failed** at once | `last_error` |

Retry puts a **failed** delivery back and sends only the parts that are left. The token never appears in `last_error`, in a log or in a response.

Until M10-09, a person's reply in the extended Human Agent days goes out as an ordinary response, which Meta refuses with the closed-window error; the delivery ends `refused` with Meta's words.

### Messenger

A message to a connected Page opens a ticket in the Page's department, or continues the customer's open ticket, as email, the widget and Telegram do. The customer is a **page-scoped id**, stored as `<Page id>:<id>` and always verified, so the same person writing to two Pages is two contacts until an agent merges them.

| Messenger sends | Helpdock does |
|---|---|
| Text, an image, a video, an audio file or a file | Files the message. Each file becomes an attachment that is *pending* until a job has fetched it from Meta's CDN; the webhook never downloads anything. A sticker is filed as an image. |
| A shared link Messenger could not render | The title and the URL as text. Without a URL, a line in the customer's ticket says they sent something Helpdock cannot show (nothing is filed when they have no ticket yet). |
| The customer's name | Not in the webhook. The first message of a conversation asks for it with a job that reads it from Meta once; until it has, and for good when Meta refuses the read (as it can for an app without its profile-access feature), the contact is named by its id. The message is filed as usual. |
| A reaction, or an edit of a message | A line in the thread of the message's ticket ("The customer reacted ❤️ to a message", "The customer edited a message. It now reads: …"); none when that ticket is closed. The message keeps what it said. |
| An echo of a message the Page sent | Dropped. Helpdock recognises its own sends by the app id (`meta.appId`, set by `HD_META_APP_ID`) and by the delivery id a reply is sent with; a reply typed in Meta Business Suite is dropped too, not imported. |
| A delivery or read report | Moves every reply of that conversation sent before it to delivered or read, and never back. |
| A postback, a referral, an event of another app that holds the thread | Counted and dropped. |
| A messaging policy notice (Meta warned or blocked the Page) | Recorded as the account's last error, which reads as failing until the next event arrives. |

Set the app id so Helpdock can tell its own replies from the ones typed in the Page inbox.

## Developing without Meta

No suite reaches Meta. The stand-in for Graph and the driver that posts signed webhooks are described under [Standing in for a vendor](development.md#standing-in-for-a-vendor).
