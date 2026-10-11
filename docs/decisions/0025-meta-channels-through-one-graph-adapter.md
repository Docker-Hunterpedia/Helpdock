# 0025 Meta channels through one Graph adapter

Status: accepted
Date: 2026-10-11

## Context

The owner has brought the Meta channels — WhatsApp Cloud API, Facebook
Messenger and Instagram direct messages — into scope as
[M10 Meta channels](../planning/PRD.md#m10-meta-channels). Until 2026-10-11
[REQUIREMENTS §1](../planning/REQUIREMENTS.md#non-goals-v1) and §4.4 and the
PRD's backlog listed them as v1.1; `packages/channels/src/adapter.ts` reserved
the kinds `whatsapp`, `messenger` and `instagram` from M2. This record
settles how they are built, not whether.

The three are products of one platform. All of them use the Graph API
(`graph.facebook.com`; `graph.instagram.com` for Instagram with Instagram
Login), one webhook callback URL per Meta developer app, a signature
`X-Hub-Signature-256` (HMAC-SHA256 of the raw body under the app secret), an
envelope `{ object, entry[] }` routed by `entry[].id`, and one error family.
What differs: the customer id (a business-scoped user id, a page-scoped id, an
Instagram-scoped id, none of them portable), the media model (WhatsApp: media
id, then a five-minute URL fetched with the token; Messenger and Instagram: a
CDN URL inside the payload), the text limit (4096 characters, 2000 characters,
1000 bytes), the reply window (24 hours; 24 hours or 7 days with the Human
Agent feature), the token (a non-expiring system-user token, a non-expiring
Page token, a 60-day Instagram user token that has to be refreshed) and what
a failed delivery costs (WhatsApp retries for seven days; Messenger and
Instagram unsubscribe the app after an hour of failures). The research brief
of 2026-10-11 found several of these facts stated inconsistently across
Meta's pages; the milestone doc carries them as risks.

M6 set the pattern a channel follows here: one row per connected account
with its credential encrypted under the master key
(`packages/db/src/schema/telegram.ts`), the update filed inside the webhook
request with a dedupe key ([ADR 0016](0016-telegram-updates-filed-in-the-webhook-request.md)),
replies through the outbox and a send job with a deliveries table
(`apps/api/src/telegram/telegram-send.job.ts`), per-ticket ordering of the
events ([ADR 0023](0023-outbox-events-ordered-per-ticket.md)), and a local
stand-in for the vendor in every test (`apps/api/src/testing/fake-telegram.ts`).

## Decision

1. **One module, three thin adapters.** `packages/channels/src/meta/` holds
   what the three share: the Graph client, the signature check, the envelope
   schemas (a Zod discriminated union on `object`), the error classifier
   (`retry | rate_limited | window_closed | token_dead | permanent`) and the
   text splitter with per-platform limits. `whatsapp/`, `messenger/` and
   `instagram/` under it each implement `ChannelAdapter` for their own
   envelope and identity and nothing else. In the api, one `MetaModule`
   (`apps/api/src/meta/`) with one inbound service per platform behind one
   webhook, one reply hook and one send job. Messenger and Instagram share the
   `messaging[]` event shape, sender actions, tags and errors; WhatsApp shares
   the envelope, the signature and the client.

2. **The Graph client goes through `packages/net`.** Every call is
   `safeFetch` with an allow-list of hosts: `graph.facebook.com`,
   `graph.instagram.com`, `lookaside.fbsbx.com` and `*.fbcdn.net`, or the
   roots `META_GRAPH_API_ROOT` and `META_INSTAGRAM_API_ROOT` point at.
   Telegram's client skips the SSRF-safe client because its host is operator
   configuration (M6-01); here a Messenger or Instagram attachment is a URL
   *inside the webhook payload*, and a WhatsApp media URL comes back from
   Graph, so these fetches of a user-triggered URL must pass
   [DOMAIN-RULES §13](../planning/DOMAIN-RULES.md#13-outbound-network-safety),
   and one client for every call keeps one policy. Every call names
   `META_GRAPH_VERSION` (default `v25.0`, which Meta retires on 2028-07-29) in
   the path; nothing is called unversioned; the stand-in's fixtures are pinned
   to the same version.

3. **Instagram through the Instagram API with Instagram Login.**
   `graph.instagram.com`, an Instagram user token (60 days, refreshed by a
   job), the permissions `instagram_business_basic` and
   `instagram_business_manage_messages`, and no Facebook Page required. The
   Facebook-Login path (Messenger API for Instagram, a Page token) is not
   built.

4. **One webhook route per install: `GET|POST /api/meta/webhook`.**
   `@Public()` and rate-limited per address as `TelegramWebhookController`
   is. `GET` answers Meta's handshake: `hub.verify_token` compared in constant
   time with the install's verify token, `hub.challenge` echoed. `POST` keeps
   the raw body (a JSON parser for this route alone that stores the buffer
   beside the parsed body, registered in `apps/api/src/bootstrap.ts` beside
   `registerFormBodies`), checks `X-Hub-Signature-256` against the install's
   Meta app secret and, when one is set, its Instagram app secret, both in
   constant time and before the body is read, then routes by `object` and
   each `entry[].id` (`whatsapp_business_account` → the WABA id and
   `value.metadata.phone_number_id`; `page` → the Page id; `instagram` → the
   account id) to the `meta_accounts` row through an install-scope read like
   `TelegramRepository.locate`. A bad signature is 401. After a valid
   signature, an unknown or deleted account, a brand in its deletion grace,
   a duplicate and an event Helpdock does not file all answer **200**, because
   a non-200 makes WhatsApp retry for seven days and Messenger and Instagram
   unsubscribe the app after an hour.

5. **App credentials per install, account credentials per row.** A
   self-hosted install has one Meta developer app, and a Meta app has one
   callback URL and one secret, so the app id, the app secret, the Instagram
   app secret and the webhook verify token are install-scope settings in
   `packages/config/src/registry.ts` (`meta.appId`, `meta.appSecret`,
   `meta.instagramAppSecret`, `meta.webhookVerifyToken`; the last three
   `secret: true`; each overridable from the environment as `HD_META_*`, the
   mapping the registry already applies). Each connected number, Page or
   account is a `meta_accounts` row, brand-scoped, holding its platform, its
   external ids, its department and its **`access_token` encrypted with
   AES-256-GCM under `APP_MASTER_KEY`** through the same `encryptSecret` the
   Telegram token uses, beside `token_kind`, `token_expires_at` and
   `token_refreshed_at`, never returned after save. `(platform, external_id)`
   is unique across the install, as `telegram_bots.telegram_id` is: the
   webhook names an account, and one account answering for two brands would
   make the brand a guess. Connecting is pasting a token and an id from the
   Meta dashboard, as adding a bot is pasting BotFather's; there is no OAuth
   connect flow in M10.

6. **Inbound is filed in the webhook request** ([ADR 0016](0016-telegram-updates-filed-in-the-webhook-request.md)).
   For each entry, one system transaction for the account's brand
   (`withSystemJob`) runs the dedupe check on the platform's message id
   (`wamid.…` or `mid`, kept in `ticket_messages.external_message_id` under
   the ticket's channel, the unique violation caught as
   `TelegramInboundService` catches it), the sender gate, the contact and the
   router, and writes every outbox row the event causes. One `POST` may carry
   entries for several accounts and brands; each gets its own transaction,
   and a failure in one does not refuse the others. **Media is not fetched in
   the request.** Meta expects the answer within seconds (its pages say 5 and
   20), and a 25 MB download does not fit, so the attachment row is written
   `pending` with its reference (a WhatsApp media id and `sha256`, or a CDN
   URL) and a `meta.media` outbox row in the same transaction; the
   `meta.media_fetch` job fetches the bytes through the Graph client, checks
   the WhatsApp digest, puts the object and asks for `attachment.uploaded`,
   from where `media.process` takes over as for any upload. WhatsApp ids live
   seven days and the job retries inside that.

7. **Outbound through the outbox and `meta.send`.** A public reply on a
   `whatsapp`, `messenger` or `instagram` ticket writes a `meta_deliveries`
   row and a `meta.reply` outbox row in the reply's transaction: `MetaReplyHook`
   joins `EmailReplyHook` and `TelegramReplyHook` in `ChannelReplyDeliveryHooks`
   (`apps/api/src/tickets/reply-delivery.hook.ts`). The worker's handler adds
   `meta.send` on the `outbound` queue with `jobId = meta.send.<outbox id>`
   and the receipt `meta.send:<delivery id>`, five attempts. A reply is parts:
   the text cut at the platform's limit, then each attachment as a message of
   its own, on WhatsApp uploaded first (`POST /{phone_number_id}/media`) rather
   than handing Meta a presigned URL; each accepted part is recorded at once so
   a retry resumes after it, as `parts_sent` does for Telegram.
   **Per-recipient pacing:** WhatsApp refuses more than one message every six
   seconds to one user (`131056`), so the job holds a Redis key per account
   and recipient and, when it is held, moves itself to delayed for the
   remainder, which costs no attempt. A permanent refusal (`190`, `10`, `551`,
   `131026` and their kin) fails the delivery at once, as Telegram's 400 and
   403 do. Delivery and read reports from the webhook (`statuses[]`,
   `delivery.watermark`, `read.watermark`, `messaging_seen`) move the row
   forward and never back.

8. **The reply window is enforced twice.** The window anchors on the
   conversation's last inbound message (`meta_conversations.last_inbound_at`):
   24 hours on every platform; seven days on Messenger and Instagram when the
   account's `human_agent_enabled` flag is on and the reply is a person's.
   `ReplyDeliveryHook` gains `assertCanDeliver(tx, { ticket })`, called by
   `TicketsService.addMessage` before the reply is written; the Meta hook
   throws `MetaFailure('reply-window-closed')` (409, carrying the platform,
   the anchor and when the window closed), which the composer shows, and the
   ticket view reads the window from
   `GET /api/brands/:brandId/tickets/:ticketId/meta` to draw the strip and
   disable Send first. The send job checks again before its first part,
   because the window can close while the job waits, and records `refused`
   with the platform's code (`131047`; Messenger and Instagram `10` with
   subcode `2018278`) without retrying. AI replies, rule actions and surveys
   never get the seven days. Nothing but a new customer message opens a
   window; WhatsApp templates are the one exception and a deliverable of
   their own.

9. **Templates and the Human Agent tag are a second deliverable** (M10-09):
   template sync (`meta.templates.sync`), a template picker in the composer
   when a WhatsApp window is closed, and `messaging_type: MESSAGE_TAG` with
   `tag: HUMAN_AGENT` on Messenger and Instagram replies between 24 hours and
   seven days, only when the operator has turned `human_agent_enabled` on,
   which asserts that Meta approved the feature for their app.

10. **Health is a job.** `meta.health` runs hourly per account: a cheap read
    with the token (`GET /{id}` or `GET /me`), `GET /{id}/subscribed_apps`
    with a re-subscribe when the app is missing, and for Instagram
    `GET /refresh_access_token` once the token is older than seven days. What
    it finds goes on the row (`status`, `last_error`, `token_expires_at`) and
    on Channels › Meta with a Reconnect action; a token that expired is
    `token_expired`, and the operator pastes a new one.

## Consequences

- One pipeline for three channels. A fourth Graph product would add an
  adapter folder and a case in the router.
- Operators carry Meta's process. Messenger and Instagram deliver messages
  from the public only after **App Review** of the messaging permissions, and
  Business Verification, per install; the guide walks through the dashboard,
  and everything works in Standard Access with the operator's own accounts
  for testing. Profile names on Messenger need a further reviewed feature;
  until then a Messenger contact is "Messenger user" and a page-scoped id.
- **WhatsApp replies cost money.** Meta charges per delivered service message
  since 2026-10-01; a reply the splitter cuts into parts, and every
  attachment, is one delivered message each. The composer says how many
  messages a reply becomes, and the guide says what Meta charges.
- A contact on Messenger or Instagram has no phone and no email, so nothing
  auto-merges them with anyone. A WhatsApp `wa_id` is a verified phone, the
  first verified phone Helpdock records
  ([DOMAIN-RULES §4.4](../planning/DOMAIN-RULES.md#44-contact-merge)).
- Identity is scoped per Page, per Instagram account and per business
  portfolio, so one person on two brands is two contacts, which is how
  contacts already work.
- A media fetch that fails for good leaves the attachment `rejected`; the
  message itself was filed.
- Missed webhooks are not replayed: WhatsApp redelivers for seven days,
  Messenger and Instagram do not. Backfill through the Conversations API is
  not built.
- The compose-time refusal is a new seam in the reply path: the first channel
  rule that stops a reply being written rather than failing its delivery.
- Instagram's limit is 1000 *bytes*, about 500 Arabic letters per part.
- The Graph version expires. Bumping `META_GRAPH_VERSION` and the fixtures is
  an operations note, like a dependency update.

## Alternatives considered

- **One package per platform.** Rejected: Messenger and Instagram share most
  of their shape, and the signature, the envelope and the client would be one
  thing three times.
- **A vendor SDK** (`facebook-nodejs-business-sdk`). Rejected: outside the
  stack table, built for Ads, and it would bypass `safeFetch`. Helpdock uses
  six Graph endpoints.
- **Instagram through Facebook Login**, one Page token for Messenger and
  Instagram. Rejected for now: it needs a Facebook Page, and the IGSIDs it
  hands out may differ from Instagram Login's, so supporting both would risk
  orphaning contacts. It can be added for brands that already connect a Page.
- **One webhook route per account.** WhatsApp allows a per-number callback
  (`override_callback_uri`); Messenger and Instagram do not. Rejected: one
  URL keeps one code path, and Meta's dashboard has one field.
- **A Meta app per brand**, app secret per account. Rejected: the signature
  would have to be checked after reading the body, to find the account, or
  against every secret. One app per install is the self-hosted case; an
  operator whose brands are different legal businesses shares a business
  portfolio or waits.
- **Persist the raw batch and file it from a job**, as Meta's guides suggest.
  Rejected for text, for ADR 0016's reasons: a second copy of every event and
  a second place to dedupe. Taken for media alone, where the deadline forces
  it.
- **Fetch media before the transaction, as Telegram does.** Rejected: Meta's
  deadline and the unsubscribe rule.
- **Enforce the window only in the send job.** Rejected: the agent would
  write a reply that cannot leave and learn it from a failed delivery.
- **Tag every outbound Messenger message `HUMAN_AGENT`.** Rejected: Meta's
  policy reserves it for a person answering, and a fork of Chatwoot that did
  this is the cautionary tale.
- **An OAuth "Connect" flow** (Facebook Login for Business, Business Login
  for Instagram). Deferred: it works for nobody but the operator before App
  Review, and pasting the dashboard's token mirrors Telegram.
- **Embedded Signup and Tech Provider onboarding.** Rejected: a hosted-SaaS
  pattern.

## Amendments

- **2026-10-11, M10-02.** Decision 4 stands against the older wording of DOMAIN-RULES §11, which
  had every channel of a brand in its deletion grace answer 410. The Meta webhook is the install's
  one URL for every brand, so a non-200 cannot be scoped to a brand: Meta reads it as the webhook
  being down, redelivers the brand's events for up to seven days, and after an hour of failures
  unsubscribes the app for every brand. The webhook therefore answers 200, passes the brand's
  entries over and counts them. §11 now says so; a brand's own endpoints (widget, help center, its
  Telegram bot's URL) still answer 410.
- **2026-10-11, M10-06.** Decision 8's `assertCanDeliver(tx, { ticket })` is `assertCanDeliver(tx, { brandId,
  ticket, personAuthored })`, because the window a reply gets depends on who wrote it. A message that reaches the
  hook only after it is written (the assistant's) and finds the window closed is recorded as a `refused`
  delivery with no outbox row, so it stands in the thread without a job. Decision 7's pacing is built as written:
  `moveToDelayed` and `DelayedError`, with no in-process wait to amend.
