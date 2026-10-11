# Meta channels

How an install receives WhatsApp, Messenger and Instagram messages (M10, [ADR 0025](../decisions/0025-meta-channels-through-one-graph-adapter.md)). This page is a stub: it describes the part that exists, the webhook Meta calls (M10-02). The dashboard walk-through per platform, connecting an account, replying, the reply window, App Review and pricing are written with the deliverables that build them and gathered here by M10-11.

An install has **one Meta developer app**. A Meta app has one callback URL and one signing secret, so every connected WhatsApp number, Facebook Page and Instagram account of every brand posts to the same route, and Helpdock finds the brand from the account the message names.

## Where Meta posts

```
GET|POST  <APP_URL>/api/meta/webhook
```

For `APP_URL=https://support.example.com` that is `https://support.example.com/api/meta/webhook`. Paste it into the **Callback URL** field of each product in the Meta dashboard (WhatsApp, Messenger, Instagram). `GET /api/meta/app` answers with it as `callbackUrl`.

The route is public (Meta has no session) and protected by the verify token and the signature below. It answers at most 3,000 requests a minute per address and accepts a body up to 3 MiB, Meta's own cap.

## The app's settings

Four install settings describe the app. Each can be set from the environment, which also locks it ([configuration](configuration.md)); the App card of Channels › Meta shows whether each is set and which an environment variable has locked:

| Setting | Environment | What it is for |
|---|---|---|
| `meta.appId` | `HD_META_APP_ID` | The app's id, to recognise Helpdock's own replies echoed back (Messenger, M10-04). |
| `meta.appSecret` | `HD_META_APP_SECRET` | Signs every webhook (`X-Hub-Signature-256`). Without it the webhook refuses everything. |
| `meta.instagramAppSecret` | `HD_META_INSTAGRAM_APP_SECRET` | The Instagram product's own secret. Optional: leave it empty when Meta signs Instagram webhooks with the app secret. |
| `meta.webhookVerifyToken` | `HD_META_WEBHOOK_VERIFY_TOKEN` | The token Meta sends with its handshake. |

Which of the two secrets signs an Instagram webhook under Instagram Login is not settled by Meta's documentation ([open questions](../in-development/M10-meta-channels.md#open-questions)). Helpdock accepts a webhook signed with either one that is set.

## Connecting a WhatsApp number

Channels › Meta › Connect asks for the **phone number id** and a **system user token**. Meta keeps a number's webhook subscription on the WhatsApp Business Account (WABA) that owns it, not on the number, so Helpdock finds the business account from the token: it reads the business accounts the token was granted on (`debug_token`, `granular_scopes`) and keeps the one that lists the number.

If the dialog says the token belongs to a different account, the token can read the number but no business account it was granted on lists it. In Meta Business Settings, assign the WhatsApp account to the system user with the app's `whatsapp_business_management` and `whatsapp_business_messaging` permissions, generate the token again and paste that one. The business account is stored with the connection; a number connected before this was recorded shows "Disconnect it and connect it again" on Subscribe now.

## The handshake

When you save the callback URL, Meta sends

```
GET /api/meta/webhook?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<number>
```

Helpdock answers `200` with the challenge as `text/plain` when `hub.mode` is `subscribe` and the token equals `meta.webhookVerifyToken` (compared in constant time), and `403` for anything else, including every request while no token has been made. The challenge must be 1 to 256 printable characters.

The token is made the first time an install admin reads the App card (`GET /api/meta/app`); a request to the public handshake never writes a setting. `POST /api/meta/app/verify-token` makes a new one and returns it once as `{ verifyToken }`; the old one stops working at once, and the change is recorded in the audit log by key, never by value. Both routes need `install:admin`. A token set by `HD_META_WEBHOOK_VERIFY_TOKEN` cannot be replaced from the screen (`409`).

`GET /api/meta/app` answers `{ appIdSet, appId, appSecretSet, instagramAppSecretSet, graphVersion, callbackUrl, verifyTokenHint, secretsLockedByEnv }`: the app id (it is not a secret), whether each of the two secrets is set, the Graph version every call names (`META_GRAPH_VERSION`), where Meta posts, the last four characters of the verify token and which of the four settings an environment variable has taken over. No secret is ever returned.

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

Each platform's events go to its inbound service: WhatsApp (M10-03), Messenger (M10-04), Instagram (M10-05). Until a platform's is installed, the webhook logs that an event arrived (platform and kind only, never the customer or the words) and files nothing.

## Developing without Meta

No suite reaches Meta. The stand-in for Graph and the driver that posts signed webhooks are described under [Standing in for a vendor](development.md#standing-in-for-a-vendor).
