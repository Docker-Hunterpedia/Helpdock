# Meta channels

How a brand answers customers on WhatsApp, Messenger and Instagram (M10, [ADR 0025](../decisions/0025-meta-channels-through-one-graph-adapter.md)). A customer's message to a connected WhatsApp number, Facebook Page or Instagram professional account opens a ticket, or continues the customer's open one. The agent's public reply goes back on the same platform, inside Meta's reply window.

Accounts are managed on **Channels › Meta**, which only an Admin of the brand can open (`brand:manage`). The install's Meta app is set up once, by an install admin, from the environment.

> **Status.** This guide describes the M10 branch: the webhook and the App card (M10-02, M10-07), inbound on the three platforms (M10-03 to M10-05), replies and the reply window (M10-06), the Connect, Test and Reconnect flows and the health check (M10-07, M10-10). WhatsApp templates and the Human Agent tag are not built yet (M10-09); each place they matter says so.

## What each platform needs

| | WhatsApp | Messenger | Instagram |
|---|---|---|---|
| What the customer writes to | A business number on the WhatsApp Cloud API | A Facebook Page | An Instagram professional account (business or creator) |
| The id Helpdock asks for | The phone number id, not the number | The Page id | The Instagram account id |
| The token | A system-user token, with the WhatsApp business account assigned to that system user | A Page access token | An Instagram user token, from **Generate token** |
| How long the token lasts | Never, when generated with expiry set to Never | No expiry date. It stops working if the password changes, the person who made it loses the Page role, or the app is de-authorised | 60 days. Helpdock renews it once it is a week old |
| Reply window | 24 hours | 24 hours; 7 days for a person's reply when the Human Agent switch is on | 24 hours; 7 days for a person's reply when the Human Agent switch is on |
| Customers outside your roles | Works for your own business portfolio. Other businesses' use needs Advanced Access | Needs App Review for `pages_messaging` | Needs App Review and Business Verification for accounts you do not manage |

Per Meta's documentation as of October 2026, which Meta can change, these are the token lifetimes.

## The Meta app

An install has **one** Meta developer app. A Meta app has one callback URL and one signing secret, so every connected number, Page and account of every brand posts to the same address, and Helpdock finds the brand from the account a message names. A brand that is a different legal business from the others shares the operator's business portfolio; it cannot bring its own app.

### The four settings

These are install settings. Each can be set from the environment, which also locks it ([configuration](configuration.md)). There is no Meta section on the Settings screen in this release, so set them in `.env` and restart the `api` and the `worker`:

| Setting | Environment | What it is for |
|---|---|---|
| `meta.appId` | `HD_META_APP_ID` | The app's id. Helpdock recognises its own Messenger replies echoed back by it. |
| `meta.appSecret` | `HD_META_APP_SECRET` | Signs every webhook (`X-Hub-Signature-256`). Without it every webhook is refused, and Connect answers `app-not-configured`. |
| `meta.instagramAppSecret` | `HD_META_INSTAGRAM_APP_SECRET` | The Instagram product's own secret. Optional. A webhook is accepted when either secret matches. |
| `meta.webhookVerifyToken` | `HD_META_WEBHOOK_VERIFY_TOKEN` | The token Meta sends with its handshake. Helpdock makes one when it is empty. |

Which secret signs Instagram webhooks under Instagram Login is not settled by Meta's documentation. Helpdock checks both, so set the Instagram secret only if you need it. The open question is in the [milestone document](../in-development/M10-meta-channels.md#open-questions).

### The App card

Channels › Meta opens with the **App card**, which only an install admin sees:

- **Callback URL**: `<APP_URL>/api/meta/webhook`, with Copy. Paste it under the webhook settings of each product in the Meta dashboard. One address serves every brand on the install.
- **Verify token**: made by Helpdock the first time the card is opened (`GET /api/meta/app`). **Replace** makes a new one and shows it once. The token is stored encrypted; the card shows its last four characters. Meta uses the token only when you save the callback URL, so paste a new one there next time you save it. A token set by `HD_META_WEBHOOK_VERIFY_TOKEN` cannot be replaced on the screen.
- **App id**, **Graph API version** (`META_GRAPH_VERSION`, `v25.0` by default), and whether each secret is set. No secret is ever shown.

## Setting up in Meta's dashboard

Meta's dashboard moves its menus. The steps below follow Meta's documentation as it stood in October 2026, as summarised in Helpdock's research note; check the names against the dashboard you see.

### Every platform

1. Create a Meta developer account and a **Business**-type app. Attach it to a business portfolio.
2. Copy the app's id and app secret. The App card's hint says the id is under App settings › Basic. Put them in `HD_META_APP_ID` and `HD_META_APP_SECRET`.
3. Add the product for each platform you serve (the sections below).
4. For each product, set the **Callback URL** and the **Verify token** from the App card, press **Verify and save**, and subscribe to the fields listed for that product. Meta sends the handshake when you save.
5. Switch the app to **Live mode**. Meta's documentation says some webhooks are not sent while the app is in Development mode.

### WhatsApp

1. Add the WhatsApp use case, **Connect with customers through WhatsApp**. New apps are created with it; older ones keep the configuration under WhatsApp › Configuration.
2. Meta creates a test WhatsApp Business account and a test number with relaxed messaging limits and no payment method. The test number sends only to recipients on its allow list. The size of that list is not stated on the pages the research checked; look for it in API Setup.
3. For a real number, add it to a WhatsApp Business account in your portfolio. It must not be registered on the consumer WhatsApp app. Verify it by SMS or voice, register it with its six-digit PIN, and add a payment method. Error `133010` means the number is not registered on the WhatsApp Business Platform.
4. In Business settings › System users, create a system user and assign the WhatsApp business account to it. Generate a token for the app with **Never** as its expiry, with `whatsapp_business_messaging`, `whatsapp_business_management` and `business_management`. Paste the token into Helpdock.
5. Subscribe to the **messages** field. Helpdock subscribes the business account itself when you connect a number, so you do not do that step by hand.

### Messenger

1. Add the Messenger product to the app and connect the Facebook Page. The person who connects it must be able to do the messaging task on the Page.
2. Generate a **Page access token** for the Page in Messenger › Messenger API settings, as the Connection section names it. A system user in your portfolio with the Page assigned gives a token that is not tied to one person.
3. The permissions are `pages_messaging` and `pages_manage_metadata`. `pages_show_list` lists the Page. Customer names need the **Business Asset User Profile Access** feature.
4. Subscribe the **page** object to the fields Helpdock subscribes each Page to: `messages`, `message_echoes`, `message_deliveries`, `message_reads`, `message_reactions`, `message_edits`, `messaging_postbacks`, `messaging_referrals` and `messaging_policy_enforcement`.

### Instagram

1. Add the Instagram product, **API setup with Instagram business login**, and note the Instagram app id and the Instagram app secret.
2. The account must be a professional account, business or creator. In the Instagram app, allow messages from connected tools (Settings › Messages and story replies › Message controls). This step is not re-checked against Meta's pages for this guide.
3. For your own account, press **Generate token** for it in the API setup and paste the Instagram user token into Helpdock. Meta's documentation says an operator's own accounts need no login flow. Until App Review, testers need a role on the app and on the account.
4. Subscribe the **instagram** object to `messages`, `message_reactions`, `messaging_seen`, `messaging_postbacks` and `messaging_referral`.
5. The token lasts 60 days and can be refreshed only while it has not expired. Helpdock renews it once it is a week old. A token that is not refreshed within 60 days expires and cannot be refreshed; then Reconnect with a new one.

## Connecting an account

On **Channels › Meta**, press **Connect account**. The dialog takes:

1. **Platform**: WhatsApp, Messenger or Instagram. Changing it clears the id and the token.
2. **The id**: the phone number id, the Page id, or the Instagram account id. Digits only. The hint under each field says where it is in the dashboard.
3. **Access token**: encrypted on save and never shown again.
4. **Department**: where new conversations open tickets. A customer's next message continues their open ticket.

Press **Test** first. Helpdock asks Meta who the token belongs to, without storing anything, and shows what Meta returned: the name, the Instagram `@handle` and the token's expiry. **Connect** stays off until Test has succeeded for the values as typed.

**Connect** saves the account, encrypts the token and subscribes the app to the account's messages, so they start arriving at once. It is recorded in the audit log.

Meta's answers and what the dialog says back:

| Meta said | The dialog says |
|---|---|
| The token is not one Meta knows | Meta refused this token. Generate a new one for this account in the dashboard. |
| The token belongs to another account, or cannot reach this one | That token belongs to a different account, or does not reach this one. For WhatsApp, check that the business account is assigned to the system user. |
| The token is for another platform | That token is for a different Meta product than the platform you chose. |
| The account is already connected, to any brand | This account is already connected on this install. An account answers for one brand only. |
| Meta could not be reached | Meta could not be reached. Try again in a moment. |
| Meta refused to subscribe the app | Meta refused to subscribe the app to this account. Check the token's permissions and the app's webhook settings. |
| The install has no app secret | This install has no Meta app set up yet. An install admin sets the app id and secrets first. |

**WhatsApp finds its business account from the token.** The dialog asks for the number only. Meta subscribes the app to the business account, so Helpdock reads the business accounts the token was granted on and keeps the one that lists the number. If the token can read the number but no granted business account lists it, Connect refuses; assign the business account to the system user and generate the token again.

**Instagram** checks the id the token opens. If the token opens a different account from the id typed, Connect refuses.

The routes behind the dialog are under `/api/brands/:brandId/meta/accounts` and need `brand:manage`:

| Request | What it does |
|---|---|
| `GET` | The brand's accounts, each with its token's last four characters |
| `POST /test` | Test, with a typed token. Writes nothing |
| `POST` | Connect. Answers `201` with the account |
| `GET /:accountId` | One account |
| `PUT /:accountId` | Save the form, or Replace the token (the new one must belong to the same account) |
| `DELETE /:accountId` | Disconnect |

## Health, Subscribe now and Reconnect

Once an hour, for every connected account except those in a brand being deleted, the health job checks four things (`meta.health`, UTC):

1. **The token.** WhatsApp and Messenger ask Meta about the token. Instagram asks for its own account.
2. **The subscription.** Helpdock's app must still be subscribed to the account. If it is not, Helpdock subscribes it again and reads it back.
3. **The renewal.** Instagram only: a token a week old is renewed.
4. **All well.** The account is `connected` and the subscription's last check is recorded.

The account's state, as the list and its page show it:

| State | Meaning | What to do |
|---|---|---|
| **Healthy** | Connected and a message has arrived | Nothing |
| **Waiting** | Connected, no message yet | Wait, or send a test message from an allowed account |
| **Failing** | The last thing that happened was an error, or the account is not connected | Read the account's last error and fix it |
| **Expiring** | A token with less than a week left, which in practice is an Instagram token whose renewal has not worked | Reconnect |
| **Token expired** | Meta no longer accepts the token. Nothing is sent or fetched for the account | **Reconnect** with a new token |
| **Not subscribed** | Meta no longer sends the account's messages to Helpdock, and the check could not restore it | Fix what Meta's last problem names, then **Subscribe now** |

On the account's page:

- **Connection** shows the masked token, its kind and expiry, and **Test connection**, which asks Meta with the saved token and sends nothing. **Reconnect** appears once Meta has invalidated the token; it keeps the account's tickets, contacts and settings.
- **Subscription** shows the fields the app is subscribed to, when Meta last answered, Meta's last problem and **Subscribe now**. Subscribing again is also what the hourly check does.

Two limits the check cannot remove. Messenger and Instagram do not replay what Meta could not deliver: when Meta drops a subscription after an hour of failed deliveries, the messages of that gap are not filed. WhatsApp redelivers for seven days, and Helpdock files each message once. And the check is hourly: a subscription dropped at 10:05 is restored at 11:00.

Routes: `POST /:accountId/test`, `POST /:accountId/subscribe` (Subscribe now), `GET /:accountId/status` (the live view of subscriptions and the Activity card) and `POST /:accountId/refresh` (renew an Instagram token that is due). All are under `/api/brands/:brandId/meta/accounts` with `brand:manage`.

## How Meta's posts are checked

Meta posts to `<APP_URL>/api/meta/webhook`. The route is public, because Meta has no session. Every `POST` is checked in this order:

1. **Signature.** `X-Hub-Signature-256: sha256=<hex>` must be the HMAC-SHA256 of the raw bytes of the body under the app secret or, when set, the Instagram secret. The comparison is constant-time and tries each secret. A missing, malformed or wrong signature, and an install with no secret, get `401`, and nothing is read or filed.
2. **Envelope.** The body must be a Meta envelope with `object` of `whatsapp_business_account`, `page` or `instagram`. A signed body that is not one gets `400`.
3. **Account.** WhatsApp entries are routed by the phone number id, Messenger and Instagram entries by the entry's id. An account is unique on its platform and id across the install. An unknown account is counted and passed over.
4. **Brand.** An account whose brand is in its deletion grace is passed over and counted. It still gets `200`.
5. **Filing.** The events are filed in the order Meta sent them, in one transaction per account, with a savepoint per event. A customer's message that is already filed, by its `wamid` or `mid`, is skipped, so a redelivery files nothing twice. A sender on the block list is dropped and counted.

The webhook never calls Meta. Whatever an event causes outside the database, such as fetching a file or reading a customer's name, is queued in the same transaction and done by a job.

Meta treats any answer other than `200` as the webhook being down, so everything after a valid signature is `200`: filed, duplicate, ignored, an unknown account, a brand in its grace, an event Helpdock does not file. The exceptions:

| Status | When |
|---|---|
| `500` | Nothing in the batch was filed, and an account failed. Meta redelivers and the dedupe key makes that safe. A batch in which something was filed is `200`, so one failing account cannot keep every brand in Meta's retry loop. |
| `400` | The signed body is not a Meta envelope |
| `401` | The signature is missing, malformed or wrong, or the install has no app secret |
| `413` | The body is over 3 MiB, Meta's own cap |
| `429` | More than 3,000 requests a minute from one address |

The handshake (`GET`) echoes `hub.challenge` as plain text when `hub.mode` is `subscribe` and `hub.verify_token` matches the install's token, compared in constant time. Anything else is `403`.

## What customers can send

**WhatsApp**

| The customer sends | The ticket gets |
|---|---|
| Text | A message. The ticket's subject is its first line |
| An image, video, document, audio, voice note or sticker | A message with the caption as its text (it may be empty) and the file as an attachment. A sticker is an image, and a photo sent as a document is an image |
| A location | `Location: 52.52, 13.405`, the place's name and address, and a map link, with "Location" in the customer's language |
| Shared contacts | `Contact: <name>`, then the company, numbers and addresses |
| A reply to an earlier message | The reply, with the earlier message's words quoted above it when that message is on the same ticket |
| A reaction | A line in the thread on the ticket of the message reacted to. Taking the reaction back is a line too. Never a message, and it does not open the window |
| Something Helpdock cannot show, such as a poll or an order | A line: "The customer sent something that cannot be shown here." It does open the reply window |
| A new number (WhatsApp reports the change) | The new number becomes the contact's verified phone, the old one is removed, and a line names both |

**Messenger**

| The customer sends | The ticket gets |
|---|---|
| Text, an image, a video, an audio file or a file | A message. Each file is an attachment, pending until a job fetches it from Meta's CDN. A sticker is an image |
| A shared link Messenger could not render | The title and the URL, as text. Without a URL, a line that the customer sent something that cannot be shown |
| A reaction | A line: "The customer reacted <the emoji> to a message.", or without the emoji, or "removed their reaction" |
| An edit of a message | A line with the new words: "The customer edited a message. It now reads: …". The message keeps what it said |
| A postback, a referral, a policy notice | Counted and dropped. A messaging policy notice from Meta is recorded as the account's last error, and the account reads failing until the next event |

**Instagram**

| The customer sends | The ticket gets |
|---|---|
| Text | A message |
| An image, video, audio, file or sticker | The caption as the text and the file as an attachment. A kind the brand's content policy switches off is rejected at once |
| A reply to one of your stories | The reply, a line "Replied to your story" with the story's link, and the story's media |
| A story mention | A line "Mentioned you in their story" with the link, and the media |
| A shared post, reel or link | A line with its URL, and its title first when Meta gives one. No attachment |
| An unsent message | The message stays. A line "The customer unsent this message." is added once |
| A reaction | A line on the ticket, as on Messenger |
| Something Helpdock cannot show | A line, and it opens the window |

Helpdock's own replies echoed back by Meta are dropped. Replies typed in Meta Business Suite or the Instagram app are dropped too, not imported as agent messages.

## Conversations and identities

- **A customer is one identity per platform.** WhatsApp keys the customer on the business-scoped user id Meta sends (`US.…`), which is unique per business portfolio. Messenger keys them on `<Page id>:<page-scoped id>`, and Instagram on `<account id>:<Instagram-scoped id>`. These are verified identifiers: Meta signed the webhook that carries them.
- **The phone number is verified only on WhatsApp.** When Meta sends the customer's number, it is recorded as a verified phone. A customer who has adopted a WhatsApp username may withhold it, and the contact then has no phone. A phone an agent typed earlier is moved to the contact that WhatsApp proved it for, and the two are suggested as duplicates ([contacts](contacts.md#identities)).
- **Names.** WhatsApp's profile name comes with each message. Messenger names are read once per conversation by a job, and Meta gives them only with the Business Asset User Profile Access feature; without it the contact keeps the id as its name. Instagram's name and `@username` are read once the customer has written. An agent's rename of the contact is never overwritten.
- **One open ticket per conversation.** A new message continues it. If it is closed, the brand's reopen policy decides, as for email and Telegram: within the policy's days it reopens, otherwise a new ticket continues the conversation ([tickets](tickets.md)).
- **No merging across platforms or brands.** The same person on WhatsApp and Instagram, or on two Pages, is two contacts. An agent merges them by hand from the contact screen.
- **Blocking.** **Block sender** on a Meta ticket blocks the customer's id on that platform, and a customer's message from a blocked id is dropped before any contact is written. The block row counts the drops.
- **Lines, not messages.** Reactions, edits, unsent messages and postbacks never open or move the reply window. Unsupported messages do open it, because the customer did write.

## Replying

A public reply on a WhatsApp, Messenger or Instagram ticket is queued in the same transaction as the reply. A job sends it, and the request never calls Meta. Internal notes never leave Helpdock.

- **Parts.** The text is cut at the platform's limit, at a paragraph, a line or a space, never inside a character. Each attachment then goes as a message of its own, in the order it was added. Text is plain: nothing an agent types is read as markup.
- **The opening line.** The first message of a reply begins with the author's first name and the brand: "Lina · Helpdock". A reply nobody wrote carries the brand's name alone. The line counts toward the platform's limit. A reply that is only files sends it as a message of its own.
- **Recording each part.** Every part Meta accepts is recorded at once. A retry resumes after the last part that was sent, so the customer never reads a part twice.
- **Pacing.** WhatsApp refuses a second message to one customer within six seconds (`131056`), so the parts of a reply, and two replies to one customer, are spaced six seconds apart. A part that finds the slot taken waits; it does not spend an attempt. Messenger and Instagram are not paced.
- **Files Meta will not take.** A file that the platform cannot take is left out, and the customer is told in their language, in its place: "One file could not be sent here: warranty-terms.docx. Instagram only takes PDF files, so we will send it another way." The agent sees which file and why under the reply. A file the media pipeline refused is left out without a notice, because the composer showed it when it was added.
- **States.** A delivery is `queued`, then `sent`, then `delivered` and `read` as Meta reports them. Those states only move forward. `failed` means the last attempt could not deliver it, and **Retry** puts it back. `refused` means the reply window had closed, which no retry fixes.

What Meta's answer does to a reply (the send job makes five attempts, backing off from 10 seconds):

| Meta said | The reply | The account |
|---|---|---|
| A fault of Meta or the network (`1`, `2`, `131000`, `131016`, HTTP 5xx) | Tried again; `failed` after the fifth | `last_error` |
| A rate limit (`4`, `17`, `32`, `613`, `130429`, `131056`, `80007`, `131057`) | Tried again. For `131056` the customer's slot is held first | `last_error` |
| The window is closed (`131047`, or `10` with subcode `2018278`) | `refused`, never retried | Nothing |
| A refusal that retrying cannot change (`551`, `100`, `131026`, `131049` to `131053`, `132000` to `132016`) | `failed` at once | `last_error` |
| A dead token (`190`, `102`, `463`, `467`, `0`) | `failed` at once | `token_expired`. Paste a new token with Reconnect |
| A missing permission (`3`, `10`, `200` to `299`) or a restricted account (`368`, `131031`, `133010`, `131042`, `130497`) | `failed` at once | `last_error` |

Retry sends only the parts that are left. A `refused` reply cannot be retried: the customer has to write first, and the agent writes a new reply. The token never appears in `last_error`, in a log or in a response.

## The reply window

Meta lets a business write to a customer only for a time after the customer's last message. Helpdock enforces the window itself, so a reply that cannot leave is never written as if it could.

| Platform | The window | For a person's reply |
|---|---|---|
| WhatsApp | 24 hours from the customer's last message | The same. Free text cannot extend it |
| Messenger | 24 hours | 7 days, when the account's Human Agent switch is on |
| Instagram | 24 hours | 7 days, when the account's Human Agent switch is on |

- The window is open while the time is before the customer's last message plus 24 hours, and closed from that instant on. A reply at 23 h 59 m goes out; one at 24 h 00 m does not.
- The 7 days belong to a person. An assistant's message, a rule's canned reply and a survey get the 24 hours whatever the switch says.
- A customer who has never written has no window, so a reply to them is refused.
- **Compose time.** A public reply on a Meta ticket whose window is closed is refused with `409` and writes nothing. The body carries `error.meta.reason` `reply-window-closed`, the platform, and `anchorAt` and `closedAt`: the customer's last message and the instant the window closed.
- **Send time.** The send job checks again before the first part, because the window can close while the job waits. A reply past it is recorded `refused` with the platform's code, and is not retried. The window is not read again between parts: if it closes while a reply is being sent, Meta decides what happens to the parts that are left.
- **WhatsApp after 24 hours.** Free text cannot reach the customer. Only an approved template can, and templates are M10-09, not built yet. Until then such a reply is refused.
- **Messenger and Instagram after 24 hours.** The server accepts a person's reply in the extended days, but the tag that Meta requires is M10-09's, not built yet. Until then the reply goes out untagged, Meta refuses it with the closed-window error, and the delivery ends `refused` with Meta's words. Read [The Human Agent feature](#the-human-agent-feature) before you turn the switch on.

The rules are also in the [tickets guide](tickets.md#reply-windows), with the routes the ticket view reads.

## Limits

Text is counted in the platform's units. WhatsApp and Messenger count UTF-16 code units, so an emoji takes two. Instagram counts UTF-8 bytes, so an Arabic letter takes two.

| | WhatsApp | Messenger | Instagram |
|---|---|---|---|
| Text per message | 4,096 characters | 2,000 characters | 1,000 bytes (about 500 Arabic letters) |
| Image | JPEG or PNG, 5 MiB | Any type, 25 MiB | JPEG or PNG, 8 MiB |
| Audio | AAC, AMR, MP3, M4A or Ogg Opus, 16 MiB | Any type, 25 MiB | AAC, M4A or WAV, 25 MiB |
| Video | MP4 or 3GP, 16 MiB | Any type, 25 MiB | MP4, Ogg, AVI, MOV or WebM, 25 MiB |
| Any other file | A document, 100 MiB | Any type, 25 MiB | **PDF only**, 25 MiB |

How a file goes:

- **What is sent** is what the media pipeline made of the upload: an image's kept original or its WebP, a voice note's Opus, a file's original ([attachments](attachments.md#the-content-policy)).
- **A file that is not one of a platform's own types, or is over its limit,** goes as a document where the platform takes documents. An image's WebP therefore reaches a WhatsApp customer as a document, because WhatsApp takes only JPEG and PNG as images.
- **Instagram takes no document but a PDF.** Its images are JPEG or PNG only. So on a brand that does not keep originals, an image sent on Instagram is left out and the customer is told. Turn `keepOriginals` on in the brand's content policy for a brand that answers on Instagram.
- **On WhatsApp**, an image or a video carries its file name as its caption, and a document carries it as its file name.
- **Messenger and Instagram fetch the file from a link.** Helpdock gives Meta a five-minute link to the bucket, so Meta's servers must be able to reach `S3_ENDPOINT`. A bucket reachable only inside your network works for everything except files on these two platforms. WhatsApp is not affected, because Helpdock uploads the bytes itself.
- **Customers' files** are fetched by a job from Meta and passed through the brand's content policy and the media pipeline. WhatsApp files are also checked against the SHA-256 Meta sent. A file that cannot be had ends `rejected` and the message stays. The reasons are `unreadable`, `too_large`, `mime_not_allowed` or `kind_disabled`, `object_missing` (Meta no longer has it: a WhatsApp media id lasts seven days, per Meta's documentation), and `processing_failed`. The job tries five times, backing off from 30 seconds.
- **Story media expires with the story.** A story's media fetched after 24 hours is `rejected`.

## App Review

Messenger and Instagram deliver messages from anyone only after Meta approves the app's permissions. Until then, only people with a role on the app can message the Page or account, and for them everything works as it will for customers. You can test with your own accounts under Standard Access.

- **Standard Access** works for people with a role on the app (admins, developers and testers), and for accounts you own or manage.
- **Advanced Access** is what serves the public. For Messenger it is needed to receive messages from customers. For Instagram it is needed for accounts you do not manage, and the research note found that messaging features may not work well without it. For WhatsApp, business apps are approved for Standard Access for their own business; Meta's documentation says an app other businesses use needs Advanced Access.
- **What to submit.** The research note summarises Meta's checklist for Messenger as a screencast of the flow, a privacy policy URL, a published Page, and a working webhook. Submit the permissions the app asks for (`pages_messaging`, `instagram_business_manage_messages`, and the Human Agent feature if you use it). Check Meta's current checklist before you submit.
- **Business Verification.** Meta generally asks for it on a Business app that seeks Advanced Access. The pages the research checked did not say which permissions it gates, so expect it.
- **Helpdock cannot approve anything for you.** Your install must be reachable at its `APP_URL`, over HTTPS, for the reviewer's test.

## The Human Agent feature

Meta lets a business answer a customer up to seven days after the customer's last message, when the issue cannot be settled in 24 hours. On Messenger the feature is the Human Agent tag (`HUMAN_AGENT`); on Instagram it is the `human_agent` tag. Meta's documentation says that a person must send the reply, not a bot, and that the feature is a separate permission that needs its own review.

In Helpdock, the switch is on the account's page under **Human Agent**, for Messenger and Instagram only, and it is off by default:

- Turning it on says that Meta approved the feature for your app. Helpdock cannot check that. Meta may restrict a Page that uses the tag without approval.
- A person's reply in the extended days is allowed. An assistant's, a rule's and a survey's replies keep the 24 hours.
- **Not built yet (M10-09).** The switch is stored and the composer allows the extended days, but the tag is not sent in this release. Until M10-09 lands, such a reply goes out untagged and Meta refuses it (see [The reply window](#the-reply-window)). Do not rely on the seven days until the tag ships.

## Pricing

As of October 2026, per Meta's documentation (the research note reads the WhatsApp pricing pages):

- **WhatsApp.** From 1 October 2026, Meta charges for service messages, the replies a business sends in the 24-hour window, which were free until then. Meta also charges for utility messages sent in response to a customer inside the window. Rates depend on the customer's country.
- **Every delivered message is charged.** A reply cut into parts is one message per part, and each attachment is one more. A reply of two parts with an image is three messages. Helpdock does not join parts into fewer messages, because the text limit is Meta's.
- **The count is shown before Send** in the composer (M10-08, not built yet). The delivery records how many messages it became.
- **No free allowance is listed.** Meta's pricing pages, as the research read them, list no monthly free allowance for service messages. One third-party source claims 1,000 a month; that is not confirmed. Check the rates for your countries on Meta's pricing page before you plan a budget.
- **Messenger and Instagram.** No per-message charge is documented for replies. Sponsored messages are not something Helpdock sends.
- **Templates** (M10-09, not built yet) are charged by their category.

## The AI-provider terms

Helpdock's AI does not reply to customers on WhatsApp, Messenger or Instagram in this release. Auto-reply is enabled only for the widget, email and Telegram (`AI_AUTO_REPLY_CHANNELS`). Every reply on these channels is written and sent by an agent.

Meta's WhatsApp Business Solution Terms, updated on 15 January 2026, restrict **AI Providers**, which means general-purpose AI assistants, on the platform. The terms state that this does not change how Meta charges other businesses. Read the [WhatsApp Business Solution Terms](https://www.whatsapp.com/legal/business-solution-terms/) and Meta's [AI providers page](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/ai-providers) before you use any AI on WhatsApp. The research note reads a brand answering its own customers with grounded support as outside what the terms describe; that reading is not Meta's ruling.

## Removing an account

On the account's page, press **Disconnect…** (or the row's menu), type the account's id (the phone number id, the Page id or the Instagram account id), and confirm. Helpdock:

- sends Meta a request to unsubscribe the app from the account, as far as Meta allows, and carries on if Meta refuses, so a revoked token does not keep an account the admin is removing;
- for WhatsApp, unsubscribes the business account only when no other number on it is connected in any brand, because Meta subscribes the app to the whole business account;
- erases the token, and the account's conversations and their replies, and stops sending replies.

Tickets and contacts stay. Replies to the old tickets can no longer reach the platform. **Remove the app from the number, Page or account in Meta** as well; until you do, Meta keeps sending its messages and Helpdock drops them.

## Developing without Meta

Nothing in the test suites reaches Meta. There are two stand-ins:

- **`FakeGraph`** (`packages/channels/src/meta/testing/fake-graph.ts`) is a local server that answers the Graph calls on two roots, WhatsApp and Messenger on one and Instagram on the other, and refuses a customer the way Meta does. **`MetaWebhookDriver`** (`webhook-driver.ts`) posts signed fixtures to the webhook, with a wrong, missing or tampered signature when a test asks for one. The [development guide](development.md#standing-in-for-a-vendor) shows how a test uses them.
- **The admin's browser stand-in** (`apps/admin/e2e/api/fake-graph.ts`) is a copy that answers the calls the Channels › Meta screens make, so the Playwright suite can drive them against the seeded api.

There is no standalone stand-in to run from a shell, and Meta cannot reach a laptop. To receive real messages in development, the install needs a public HTTPS address that Meta can reach, as in production. In the admin app's development mode, Channels › Meta shows the in-memory fixture: two WhatsApp numbers, a Facebook Page, and an Instagram account whose token Meta has invalidated.
