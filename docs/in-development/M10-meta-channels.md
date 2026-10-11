# M10 Meta channels

Status: in progress
Started: 2026-10-11
Owner: @Docker-Hunterpedia

## Scope

A brand connects a WhatsApp business number, a Facebook Page or an Instagram
professional account. A customer's message to any of them becomes a ticket,
or continues the conversation's open one, through the same lifecycle calls
email, the widget and Telegram make; the agent's public reply, text and files,
is delivered back on the same platform through the outbox. Images, video,
documents, voice notes and stickers go through the M1 media pipeline, fetched
by a job rather than in the webhook request; locations and shared contacts are
filed as text. Every reply is subject to Meta's reply window, which the api
refuses at compose time and checks again when it sends. Admins connect an
account per platform on Channels › Meta by pasting the dashboard's token,
subscribe it to the install's webhook, and read its health; the ticket view
shows which number, Page or account a ticket is with, how long the reply
window stays open, and what happened to each reply. WhatsApp templates and the
Human Agent tag, which reach a customer after the window, are a deliverable of
their own and may ship after the rest.

This is a scope change: until 2026-10-11 the Meta channels were a v1 non-goal
(REQUIREMENTS §1, PRD §1) and a v1.1 backlog item (REQUIREMENTS §6, PRD §5).
The decision is the owner's and is recorded in the PRD's change log; the
design is [ADR 0025](../decisions/0025-meta-channels-through-one-graph-adapter.md).

Full deliverable list and specs: [PRD §4 · M10 Meta channels](../planning/PRD.md#m10-meta-channels).
Depends on M6 (the channel pattern this milestone copies: `apps/api/src/telegram/`)
and on M9's code side, both shipped or merged; M9's remaining items need
people, not code, so M10 runs beside them. Stacked after the 1.0 hardening
pull request (#167).

Built from the artboards listed under [Artboards to draw](#artboards-to-draw)
once the design step has drawn them; nothing with a screen starts before its
artboard exists (AGENTS.md, design first).

## Deliverables

Estimates are for one maintainer working with AI coding agents, including the
tests and docs of the Definition of done, in working days; the PRD's status
board carries the sum as 5–6 weeks. Every deliverable needs the unit tests of
its functions and schemas (Vitest, colocated); the column names what else the
Definition of done asks for.

| Id | Deliverable | Spec | Tests beyond unit | Estimate | Issue | Status |
|---|---|---|---|---|---|---|
| M10-01 | Schema, config and the shared Graph adapter: migration `0050_meta_channels` (`meta_accounts`, `meta_conversations`, `meta_deliveries`, the three channel and identity enum values), the `meta.*` settings and `META_*` keys, `packages/channels/src/meta/` (Graph client over `safeFetch` with the host allow-list, `X-Hub-Signature-256`, envelope schemas, error classifier, splitter), and the stand-in for Graph with the signed-webhook driver | A §5, §8, §13; D §13; ADR 0025 (1, 2, 5) | Integration: the three tables in the RLS negative suite (D §1.6), the migration round-trip; the stand-in's own suite | 3 d | | built, awaiting review: [notes](#m10-01-schema-config-and-the-shared-adapter) |
| M10-02 | The webhook: `GET\|POST /api/meta/webhook`, the handshake, the raw body kept for the signature, constant-time checks against both app secrets, routing by `object` and `entry[].id` to the account across brands, a transaction per entry, dedupe on `wamid`/`mid`, 200 for everything after a valid signature, a brand in its deletion grace passed over and counted | ADR 0025 (4, 6); D §6 | Integration: a signed batch with entries of two brands files two tickets, each in its brand; a redelivered batch files nothing twice; a wrong signature is 401 and files nothing; the race of two deliveries ends with one message | 2 d | | built, awaiting review: [notes](#m10-02-the-webhook-routing-dedupe-and-the-module-skeleton) |
| M10-03 | WhatsApp inbound → tickets: identity on the business-scoped user id with `wa_id` as a verified phone; profile name; text, media (image, video, document, audio and voice, sticker) through `meta.media_fetch` and the pipeline with the `sha256` check; captions, quoted context, locations and shared contacts as text; `user_changed_number`; `unsupported` as a system line; `statuses[]` onto deliveries; the sender gate | R §4.4; D §4.4, §4.7, §4.8; ADR 0025 (6) | Integration: each message type from the fixtures lands as the mapping in D §4.8 says; a 20 MB media id is fetched by the job, verified and processed; a phone typed by an agent before the WhatsApp message becomes a duplicate suggestion and the verified claim takes it | 3 d | | built, awaiting review: [notes](#m10-03-whatsapp-inbound-and-the-shared-conversation-router) |
| M10-04 | Messenger inbound → tickets: identity on the page-scoped id, "Messenger user" without profile access; text, attachments from the CDN URL through the fetch job, stickers, `fallback` links as text; echoes of Helpdock's own sends dropped by `app_id` and `metadata`; `delivery` and `read` watermarks onto deliveries; reactions and edits as system lines; postbacks counted and dropped | R §4.4; D §4.7, §4.8; ADR 0025 (6) | Integration: the fixtures' events; an echo of a Helpdock send files nothing; a watermark marks every earlier delivery of that conversation and none later | 2 d | | built, awaiting review: [notes](#m10-04-messenger-inbound) |
| M10-05 | Instagram inbound → tickets: identity on the Instagram-scoped id with `@username`; text, attachments, story replies and mentions as text with the media; `is_echo` dropped; `is_deleted` marks the message unsent rather than deleting it; `messaging_seen` onto deliveries | R §4.4; D §4.7, §4.8; ADR 0025 (3, 6) | Integration: the fixtures' events; a deleted message keeps its row and gains the mark | 2 d | | planned |
| M10-06 | Agent replies on all three: `MetaReplyHook` behind `ChannelReplyDeliveryHooks`, `assertCanDeliver` at compose time with `reply-window-closed` (409), `meta.send` with the window checked again, the splitter per platform (4096 chars, 2000 chars, 1000 bytes), attachments as messages of their own (WhatsApp by upload, Messenger and Instagram by URL, Instagram files PDF only), per-recipient pacing, deliveries with `delivered` and `read`, `refused` for a closed window, `failed` with Retry, the ticket's `GET …/meta` and `POST …/meta/deliveries/:id/retry` | A §8, §13; D §2.6, §6; ADR 0025 (7, 8) | Integration: a reply reaches the stand-in once when the job runs twice; a 1000-byte Arabic reply is split at a letter boundary; a reply after 24 h is refused at compose time with `reply-window-closed`, and one queued before the window closed is `refused` by the job; two replies to one WhatsApp user six seconds apart; a permanent refusal fails at once | 4 d | | built, awaiting review: [notes](#m10-06-replies-the-window-metasend-deliveries-and-pacing) |
| M10-07 | Admin: Channels › Meta — the App card (callback URL, verify token shown once, the settings the secrets live in), the account table per platform with health, Connect account (platform, id, token, department; Test before Connect), an account's page (connection, subscription with Subscribe now, routing, Human Agent switch, activity, Disconnect), `brand:manage` routes under `/api/brands/:brandId/meta/accounts`, the System page's Channels card | R §4.10; ADR 0025 (5, 10) | Integration: connect refuses a token Graph does not know, stores the token encrypted and shows only its hint, audits every change; Playwright in `en` and `ar` with axe (mock api) and against the real api with the stand-in (`apps/admin/e2e/api/`) | 4 d | | admin side built, API next: [notes](#m10-07-admin-api-and-the-channels--meta-screens) |
| M10-08 | Ticket thread: the channel chip ("WhatsApp · +1 555 …", "Messenger · Page", "Instagram · @handle"), "via" and "to" lines, delivery states including Delivered and Read, the ReplyWindowStrip between the thread and the composer with Send disabled when closed, the composer's recipient caption and "sent as N messages" count, the ChannelIdentityCard rows per platform | DESIGN §6.3; D §2.6 | Playwright in `en` and `ar`: an open window, a human-agent window, a closed window with the refusal, a refused delivery with its reason, Retry on a failed one | 2 d | | planned |
| M10-09 | Templates and the Human Agent tag: `meta.templates.sync` per WhatsApp account, the template picker with parameter mapping when a WhatsApp window is closed, `template` sends through `meta.send`, `HUMAN_AGENT` on Messenger and Instagram replies between 24 h and 7 d when the account's switch is on and the author is a person, the delivery's `tag` and `template_name` | ADR 0025 (9); D §2.6 | Integration: a template send after the window; `HUMAN_AGENT` on a person's reply at day 3 and never on an AI or rule reply; Playwright for the picker in `en` and `ar`. **May ship after M10-01 to M10-08 and M10-10** | 4 d | | later |
| M10-10 | Health jobs: `meta.health` hourly per account and its scheduler, token check, `subscribed_apps` check with re-subscribe, Instagram refresh after seven days, `token_expired` and `unsubscribed` on the row, Reconnect on the admin page | ADR 0025 (10) | Integration against the stand-in: a dropped subscription is restored; an Instagram token is refreshed once it is old enough and the expiry moves; a refused refresh marks the account and the page says so | 2 d | | built, awaiting review: [notes](#m10-10-health-jobs) |
| M10-11 | Docs and the guide: `docs/guides/meta-channels.md` (the Meta dashboard walk-through per platform, App Review, pricing, limits), `channels.md`, `configuration.md` and `.env.example` for the `META_*` keys, `contacts.md` for the new identifiers, `tickets.md` for the reply window, `data-retention.md` for the deliveries, the OpenAPI changes, this document and the PRD | AGENTS.md, Definition of done 1 | `docs-guard` before the PR | 2 d | | planned |

## Exit criteria

Copied from the PRD, ticked as they are met. Each is proved against the local
stand-in for Graph and the signed-webhook driver, on real Postgres and Redis
(Testcontainers), as M6's was against the Bot API stand-in.

- [ ] A message on each platform opens a ticket with the right contact: a
      WhatsApp message keyed on its business-scoped user id with the phone
      recorded as a verified identifier; a Messenger message on its
      page-scoped id; an Instagram message on its Instagram-scoped id with the
      `@username`. Two accounts of two brands in one webhook batch file two
      tickets, each in its brand.
- [ ] A reply from the ticket arrives on the same platform: the stand-in
      receives `POST /{id}/messages` for the text and each attachment, once,
      when the job runs twice; the delivery shows Sent, then Delivered and
      Read from the status webhook.
- [ ] A reply after the window is refused with the right message: at compose
      time with `reply-window-closed` and the composer's strip, and in the
      job with the delivery `refused` and the platform's code when the window
      closed while it waited. On Messenger and Instagram with the Human Agent
      switch on, a person's reply at day 3 goes out tagged and an AI or rule
      reply does not (M10-09).
- [ ] Brand A cannot read brand B's `meta_accounts`, `meta_conversations` or
      `meta_deliveries` rows, by the negative suite of DOMAIN-RULES §1.6.
- [ ] The stand-in suites pass in CI's `integration` job: webhook, inbound per
      platform, replies, health.
- [ ] The Channels › Meta screens and the Meta ticket pass their Playwright
      suites in `en` and `ar` with axe.

## Migrations

- `0050_meta_channels` (M10-01): `meta_accounts` and `meta_conversations` (brand) and
  `meta_deliveries` (department, moved with its ticket by a trigger of its own, as
  `telegram_deliveries` is), the enums `meta_platform`, `meta_account_status`,
  `meta_token_kind` and `meta_delivery_status`, and `whatsapp`, `messenger` and
  `instagram` added to `ticket_channel`, `contact_identity_kind`,
  `contact_duplicate_reason` and `blocked_sender_kind`. The three tables are in
  `TENANT_TABLES`, with their `FORCE`d policies in the migration, and in the RLS
  negative suite, where `meta_deliveries` also has the same-brand, other-department
  case. `meta_accounts.access_token` is in `ENVELOPE_COLUMNS`, so a master key
  rotation re-encrypts it. Nothing in the migration uses one of the new enum values,
  so it runs inside the migration's transaction.

## Open questions

Carried from the research brief of 2026-10-11, where Meta's own pages
disagree or say nothing. Each is settled by a run against the real platform
on the staging accounts listed under external dependencies, and the answer is
written here.

- **Which secret signs `object: instagram` webhooks** under Instagram Login:
  the Meta app secret or the Instagram app secret. The webhook verifies
  against both (ADR 0025, 4); confirm with a real delivery and drop the one
  that never matches.
- **How long Meta waits for the webhook's answer** (5 s on the webhooks page,
  20 s in the App Review checklist) and **how long Messenger and Instagram
  retry** (one hour, then unsubscribed, on the Messenger page; 36 hours on
  the Instagram page). The design assumes the worse case of each.
- **The closed-window error on Messenger and Instagram** (`10` with subcode
  `2018278`) is widely documented but was not readable on Meta's reference;
  the stand-in uses it, and a real refusal confirms the code the classifier
  keys on.
- **Whether Business Verification is required** for the Advanced Access
  Messenger and Instagram need; the guide says "expect it" until an install
  has been through App Review.
- **The test number's allow-list size** (commonly five recipients) and
  **Instagram's automated-DM cap** (200 an hour, from third parties only) are
  unconfirmed and only affect the guide's wording.
- **WhatsApp's free service-message allowance.** Meta's page lists none;
  one third party claims 1000 a month. The guide says every delivered reply
  may be charged.
- **Profile names on Messenger** need the Business Asset User Profile Access
  feature. Until an install has it the contact is "Messenger user"; whether
  the name arrives without it on a Page the operator administers is to be
  tried.
- **The satisfaction survey on these channels.** M8-06 sends it by email for
  any channel it does not know, and these contacts have no email: `CsatDelivery`
  answers `unreachable` for them in M10. A WhatsApp survey needs a template
  and a Messenger one the `customer_feedback` template; both wait on M10-09
  or later.

## Artboards to draw

Named in the canvas convention of DESIGN.md. The five boards below are drawn
on the canvas (2026-10-11), and the components they need are specified in
DESIGN §6.3. `Admin/Composer-Template` is still to draw, so its TemplatePicker
stays a proposal there. No brand marks: DESIGN §5 allows Lucide only, so the
three platforms take the Lucide icons named there.

| Artboard | For | Must show | Status |
|---|---|---|---|
| `Admin/Channels-Meta` | M10-07 | The Channels tab for the three platforms: the App card (the install's callback URL with Copy, the verify token revealed once with SecretReveal, app id, a line saying the secrets are set on Settings or by the environment with an EnvLockedField), one table of connected accounts with a platform column (number, Page or account; routes to; subscription state; last event; health with Fix), the empty state, "How messages arrive" with the health legend; the **Connect account** dialog with RadioCards for the platform, the id field named per platform (phone number id, Page id, Instagram account id), the token field, the department, **Test** before **Connect** with Graph's refusal under the field, and a note on App Review for Messenger and Instagram | Drawn 2026-10-11, as on the canvas |
| `Admin/Channels-Meta-Account` | M10-07, M10-10 | An account's page: Connection (masked token with Replace, token kind, expires in N days or never, Test connection, Reconnect when `token_expired`), Subscription (subscribed fields, last checked, Subscribe now, Meta's last error), Routing, **Human Agent** (a switch with the caption that the operator asserts Meta approved the feature; Messenger and Instagram only), the Activity card (last reply delivered, failed and refused sends in 24 h, open tickets), the WhatsApp-only quality and pricing notes, Disconnect asking for the id typed | Drawn 2026-10-11, as on the canvas |
| `Admin/Ticket-Meta` | M10-06, M10-08 | The ticket view for each platform in one board: the header's channel chip per platform; a customer message "via +1 555 …" / "via Page" / "via @handle" with a quoted context line, a sticker, a story reply; a reply "to WhatsApp · Sent · Delivered · Read" with each state; a `refused` reply with the danger strip in Meta's words and no Retry; a `failed` one with Retry; the **ReplyWindowStrip** in its three states (open with the time left, human-agent with the days left, closed with what the agent can do); the composer with the recipient caption, "Sent as 3 messages" and Send disabled when closed; the ChannelIdentityCard rows per platform (WhatsApp: user id, phone verified, profile name, number; Messenger: page-scoped id, name or "Messenger user", Page; Instagram: Instagram-scoped id, `@username`, account) with the footer saying which value is verified and which can change | Drawn 2026-10-11, as on the canvas |
| `Meta/Chat-EN`, `Meta/Chat-AR` | M10-06 | Content contracts, as `Telegram/Chat-EN` and `-AR` are, since the platforms draw the chat: an agent reply as the customer sees it on each platform, with its first line "First name · Brand" and a reply split into parts, each attachment as its own message with the caption, a voice note as audio, a WhatsApp document with its filename, an Instagram file refused with the line the agent sees instead; Arabic text within Instagram's 1000-byte parts | Drawn 2026-10-11, as on the canvas |
| `Admin/Composer-Template` | M10-09 | The template picker over the composer when a WhatsApp window is closed: the approved templates with language and category, the parameter fields mapped from the ticket, the preview, the pricing category, Send template | To draw |

## Gaps accepted up front

Written down before the work starts, so nobody discovers them in review.

| Gap | Why |
|---|---|
| **Messenger contacts have no name without App Review.** The sender's name needs the Business Asset User Profile Access feature; until an install has it, the contact is "Messenger user" with its page-scoped id. | Meta's feature review, per install; nothing Helpdock can do on the operator's behalf. |
| **No phone and no email for Messenger and Instagram users.** The ids are scoped to the Page or account and reveal nothing; nothing auto-merges them with a contact from another channel. An agent merges by hand (M1-13). | The platforms do not expose either. |
| **WhatsApp replies are charged per delivered message** by Meta since 2026-10-01, and a reply is one message per 4096-character part and one per attachment. The composer counts them; the guide says what Meta charges. | Meta's pricing. Helpdock does not batch parts into fewer messages, because the text limit is Meta's. |
| **Connecting is pasting a token.** No "Connect with Facebook" or "Log in with Instagram" flow, and no Embedded Signup. | An OAuth flow works for nobody but the operator before App Review; the token from the dashboard works at once. |
| **One Meta app per install.** Brands cannot bring their own app; a brand that is a different legal business shares the operator's business portfolio. | One signature check before the body is read (ADR 0025). |
| **No replay after an outage** on Messenger and Instagram, whose subscription is dropped after an hour of failures. `meta.health` re-subscribes; the messages of the gap are not fetched. | Backfill through the Conversations API is its own deliverable, not planned. |
| **Echoes of replies typed in Meta Business Suite are dropped**, not imported as agent messages. | Importing them means a second author path; only Helpdock's own echoes are recognised, to avoid filing them as customer messages. |
| **No auto-reply (M7-06) on these channels** in M10. `AI_AUTO_REPLY_CHANNELS` stays `widget`, `email`, `telegram`. | Meta requires automated experiences to say so, and the window rules differ for a bot; a later milestone adds the disclosure line and the channel. |
| **No satisfaction survey on these channels** in M10; `CsatDelivery` answers `unreachable`. | The survey after a close is usually outside the window; it needs a WhatsApp template or Messenger's `customer_feedback` template (M10-09 or later). |
| **Instagram sends PDFs only as files**, images up to 8 MB; a Word or Excel attachment is left out and the agent is told. | Instagram's send limits. |
| **Reactions, edits, postbacks and referrals** are system lines or counted and dropped, never messages. | They carry no text to answer. |
| **Story-mention media expires with the story**; a fetch after 24 h leaves the attachment `rejected`. | Meta's lifetime. |
| **No test against the real platform in CI.** Every suite runs against the stand-in; the staging accounts under external dependencies are for the maintainer's own run. | As M6: no vendor credential in CI. |

## External dependencies

| Dependency | Status | What waits on it |
|---|---|---|
| A Meta developer account and a Business-type app with the WhatsApp, Messenger and Instagram products, its app secret and Instagram app secret, in Live mode | `needed` ([PRD](../planning/PRD.md#external-dependencies)) | Any run against Meta itself; the open questions above |
| A WhatsApp Business account with the auto-created test number and a payment method for a real number | `needed` | The WhatsApp exit-criterion run; pricing wording in the guide |
| A Facebook Page and an Instagram professional account for staging, with the maintainer in an app role | `needed` | The Messenger and Instagram runs under Standard Access |
| App Review for `pages_messaging`, `instagram_business_manage_messages` and the Human Agent feature on the staging app | `not started` | Messages from anyone outside the app's roles; M10-09's tag |

## M10-01 Schema, config and the shared adapter

The contract names (platforms, statuses, jobs, events, limits, error classes) are the ones
fixed before the work started, and none changed.

**Database.** `packages/db/src/schema/meta.ts` and migration `0050_meta_channels` as
[Migrations](#migrations) lists. `(platform, external_id)` is unique across the install;
`(account_id, customer_id)` is unique per conversation; a delivery has one row per ticket
message.

**Schemas.** `packages/schemas/src/meta.ts` holds the vocabulary (`metaPlatformSchema`,
`metaAccountStatusSchema`, `metaTokenKindSchema`, `metaDeliveryStatusSchema`), the account
input and output (`metaAccountSchema` carries `tokenHint` and no field that could hold the
token), `metaRefusalSchema`, the test, subscribe and status results, the App card, the
delivery and ticket-context views, `replyWindowSchema`, `metaFileRefSchema` (the reference
the `meta.media` outbox event carries), the route parameters and the constants
(`META_TEXT_LIMITS`, `META_ATTACHMENT_LIMITS`, `META_SUBSCRIBED_FIELDS`, the windows, the
pacing). `contactIdentityKindSchema`, `ticketChannelSchema`, `blockedSenderKindSchema`,
the widget protocol's conversation channel and the System page's channel kind gain the
three platforms; `normaliseMeta` spells their ids (`invalid-meta` is the new refusal);
`IDENTITY_SOURCE_RULES` gains `whatsapp.cloud` (kinds `whatsapp` and `phone`),
`messenger.page` and `instagram.account`, all verified, and `VERIFIABLE_IDENTITY_KINDS.phone`
is `true`: only `whatsapp.cloud` produces a verified phone, and a phone an agent types is
still unverified. `AI_AUTO_REPLY_CHANNELS` is unchanged, and a test says so.

**Configuration.** `META_GRAPH_VERSION`, `META_GRAPH_API_ROOT`, `META_INSTAGRAM_API_ROOT`
in the bootstrap schema (defaults live in `graph-client.ts`), and the install settings
`meta.appId`, `meta.appSecret`, `meta.instagramAppSecret`, `meta.webhookVerifyToken`
(overridable as `HD_META_*`). The [configuration guide](../guides/configuration.md) is
regenerated from them.

**The shared adapter**, `packages/channels/src/meta/` (all exported from `@helpdock/channels`):

| File | What it holds |
|---|---|
| `graph-client.ts` | `GraphClient` (`get`, `post`, `delete`, `postMultipart`, `download`) over `safeFetch` with `policies.graph`; `isAllowedGraphHost`; `multipartBody`; the defaults |
| `errors.ts` | `classifyGraphError`, `classifyGraphCode`, `GraphApiFailure` (`kind`, `code`, `subcode`, `status`, `detail`, `permanent`, `reason`), `redactToken` |
| `signature.ts` | `verifyHubSignature` (any of several secrets, constant time, an empty secret never matches), `hubChallenge`, `hubSignature` |
| `envelope.ts` | `metaEnvelopeSchema`, `classifyWhatsAppValue`, `classifyMessagingEvent`, `routeEnvelope` (events cut by account), the `MetaEvent` union, `metaExternalId`, `metaIdentityValue` |
| `text.ts` | `splitMetaText`, `metaLocationText`, `contactsText`, `storyText` |
| `reply-window.ts` | `replyWindow` (the one pure function every window check uses), `replyWindowView` |
| `graph-responses.ts`, `send-payloads.ts` | Zod for what Graph answers and for what Helpdock sends |
| `inbound-message.ts`, `whatsapp/`, `messenger/`, `instagram/` | `MetaInboundMessage`, `MetaChannelAdapter`, `toWhatsAppInboundMessage`, `toMessengerInboundMessage`, `toInstagramInboundMessage` and the three adapter classes |
| `fixtures.ts`, `testing/` | the webhook bodies and Graph answers; `FakeGraph` and `MetaWebhookDriver` |

Decisions taken inside the plan, each with its reason in a comment where it is made:

- **Where things live.** The reply-window function, the stand-in and the driver are in
  `packages/channels/src/meta/` rather than `apps/api/src/`, because the first is pure and the
  other two are shared by every suite, including the admin's browser suites, which cannot
  import an app. M10-06 may re-export the function from `apps/api/src/meta/meta-window.ts`. The envelope and send-payload schemas are in the channels
  package beside the code that reads and builds them, as Telegram's `Update` is; only the
  shapes the screens and the outbox events share are in `packages/schemas`.
- **The window closes at its instant.** Open while `now` is before the customer's last message
  plus 24 hours, closed from that instant on; the extended 7 days work the same way.
- **Counting characters.** WhatsApp and Messenger limits are counted in UTF-16 code units, never
  fewer than code points, because Meta does not say how it counts beyond the Basic Multilingual
  Plane; a part may be shorter than the limit for emoji-heavy text, never longer. Instagram
  counts UTF-8 bytes. A cut never splits a code point.
- **No redirect is followed**, for any Graph call or download, because the host a redirect names
  was never checked against the allow-list. If Meta's media hosts redirect in practice, the
  staging run will show it as a `blocked` failure and this is the line to revisit.
- **The token goes only to Meta hosts.** `download` sends it to a Graph root and to
  `lookaside.fbsbx.com`, and never to `*.fbcdn.net`, whatever the caller passed.
- **Stand-in strictness.** A token is good on the root of its own platform only; every send body
  is checked against `send-payloads.ts`; text over the platform's limit is refused. A Meta call
  that these let through is a call Meta would have accepted.
- **Ids that JSON cannot hold exactly** (a number past 2^53) are refused rather than rounded;
  Meta writes such ids as strings.

Knock-on changes the wider enums needed so the repository still compiles, none of them a
feature: the admin's channel icon maps and catalogs (`en` and `ar`) name the three platforms
(the icons are stand-ins until the M10 artboards pick theirs), the api's own-sender rule treats
them like a phone or a chat, and "Block sender" on a Meta ticket blocks the customer's id on that
platform. The block list's kind picker therefore offers the three kinds from now on; nothing
consults them until the inbound services of M10-03 to M10-05.

Not in this deliverable, by design: the api module, the webhook route, the admin screens and
their browser stand-in (`apps/admin/e2e/api/fake-graph.ts`, M10-07), and the guide pages that
describe behaviour no one can reach yet (`contacts.md` still says a phone is never verified;
M10-03 changes that behaviour and its guide).

## M10-02 The webhook, routing, dedupe and the module skeleton

`GET|POST /api/meta/webhook` and `MetaModule` (`apps/api/src/meta/`), wired into `AppModule` and
`createApiApp`. The guide is [Meta channels](../guides/meta-channels.md).

| File | What it holds |
|---|---|
| `meta-webhook-body.ts` | `registerMetaWebhookBody(adapter)`: the JSON parser that keeps the signed bytes on `request.rawBody` for this route only, and the 3 MiB body limit for it |
| `meta-webhook.controller.ts` | `@Public()` `GET` (the handshake, `text/plain`) and `POST`, 3,000 requests a minute per address |
| `meta-webhook.service.ts` | `verify`, `receive`, and `metaWebhookVerdict` (the status a batch is answered with) |
| `meta-inbound.service.ts` | `MetaInboundService.receive`: one account's events in one brand transaction; `PlatformInboundService`, `MetaInboundHandlers`, `unhandledInbound` |
| `meta-inbound-gate.ts` | `metaMessageSeen` (the dedupe key) and `metaSenderBlocked` (the block list), for all three platforms |
| `meta-app.service.ts`, `meta-app.controller.ts` | the install's Meta app: `secrets()`, the verify token, `GET /api/meta/app`, `POST /api/meta/app/verify-token` (`install:admin`) |
| `meta.repository.ts` | accounts (`list`, `find`, `account`, `insert`, `update`, `delete`, `departmentExists`, `markEvent`, `markError`), install scope (`locate`, `listAll`), conversations (`conversation`, `upsertConversation`, `setConversationTicket`, `conversationForTicket`), deliveries (`insertDelivery`, `delivery`, `deliveriesForTicket`, `recordPart`, `markSent`, `markRefused`, `recordFailure`, `requeue`, `advanceStatus`, `advanceByWatermark`) and `activity` |
| `meta-failure.ts` | `MetaFailure(reason, details?)`, mapped in `http/error-response.ts` to a `meta: { reason, details? }` field of the error body (`packages/schemas/src/error.ts`) |
| `meta-events.ts` | `META_EVENTS` (`meta.reply`, `meta.media`, `meta_account.changed`), their enqueue helpers and event handlers, `metaSendJobId`, `metaMediaFetchJobId`, `registerMetaEventHandlers` |
| `graph-client-factory.ts`, `meta.module.ts` | `MetaModule.forRoot({ env, db, logger, overrides? })`; `MetaModuleOverrides { graph?, inbound? }`; the `META_GRAPH` token |

**The seam the inbound services fill.** `PlatformInboundService.handle({ tx, account, now }, event)`
in `meta-inbound.service.ts`, one per platform, called once per event of the platform's accounts in
the order Meta sent them, with the `MetaEvent` that `routeEnvelope` made. `tx` is a savepoint of the
account's brand transaction (system context, `app.principal_id = meta.webhook`). It returns a
`MetaEventOutcome` (`handled`, `duplicate`, `ignored` with a reason) and throws to refuse the whole
route. A handler registers by replacing its platform's entry in the `handlers` map of
`MetaModule.forRoot` (the default is `unhandledInbound`, which logs the platform and the kind and
answers `unhandled`); a suite passes `overrides.inbound` instead. M10-03 to M10-05 therefore do **not**
repeat two checks: before a customer's `message` reaches `handle`, the service has already answered
`duplicate` for a `messageId` that `ticket_messages.external_message_id` holds for the platform, and
`ignored: blocked-sender` for a sender on the block list (counted on the block row).

Decisions taken inside the plan, each with its reason where it is made:

- **A brand in its deletion grace is answered 200, never 410.** The sources disagreed: this row's
  first draft and DOMAIN-RULES §11 ("channels answer 410") said 410, ADR 0025 (4) and the
  implementation brief said 200. The orchestrating session settled it on 200 and amended §11: the
  webhook URL is the install's, not the brand's, so a non-200 cannot be scoped to one brand. Meta
  reads it as the webhook being down, redelivers the deleted brand's events for days, and after an
  hour of failures unsubscribes the app for every brand. The brand's part of a batch is passed over,
  counted (`brand-gone` in the route report) and logged; a batch that also holds a live brand's
  events files them. The ADR carries the amendment.
- **500 only when nothing was filed.** A batch is answered 500, so Meta redelivers, when no account in
  it was filed and at least one failed. A batch in which something was filed is 200 even if another
  account failed (logged, and on `meta_accounts.last_error`), so an account that always throws cannot
  keep every brand in the batch in Meta's retry loop. Redelivery is safe either way: the dedupe key.
- **One transaction per account, a savepoint per event.** The unique index on
  `ticket_messages (brand_id, channel, external_message_id)` decides the race of two concurrent
  deliveries: the loser's insert fails inside its savepoint, and the event is answered `duplicate` only
  if the message is now there. Any other unique violation is the handler's bug and fails the route.
- **The dedupe check and the sender gate are the service's**, not each platform's, so the three cannot
  come to ask them three ways. The brief's M10-03 text has the WhatsApp service do them in an early
  transaction; that is no longer needed (nothing is downloaded in the request).
- **`rawBody` through the adapter.** Nest registers its JSON parser when the app initialises and a
  second one for the type is refused, so `registerMetaWebhookBody` asks the adapter to register its
  parsers first (it skips them at init) and replaces the JSON one with a parser that calls Fastify's
  own default parser, with the same prototype-poisoning actions, so `__proto__` is refused here as
  everywhere. `createApiApp` keeps the `FastifyAdapter` it builds, because `app.getHttpAdapter()` is typed as the framework-neutral server, which has no parser registration.
- **The handshake sets its content type after the token is accepted.** Nest applies `@Header` before the
  handler runs, which made the 403's JSON body unsendable (Fastify refuses an object under
  `text/plain`).
- **The verify token is made on the App card, never by the public route.** `GET /api/meta/app` makes and
  stores one when none exists; the handshake only reads. A stranger's request cannot write a setting.
  `meta.webhookVerifyToken` is audited as `settings.updated` by key.
- **`last_error` names the innermost cause**, because the outer error of a failed query quotes the
  statement and its parameters, which are a customer's words.
- **Job payload types are local.** `meta.send` and `meta.media_fetch` do not exist in `@helpdock/jobs`
  until M10-06 and M10-03, so `meta-events.ts` declares the producer-side shapes (`MetaSendJobPayload`,
  `MetaMediaFetchJobPayload`) and the queue interfaces; those deliverables replace them with the
  schemas' inferred types. `registerMetaEventHandlers` takes each consumer as optional and is **not
  called by `start-worker.ts` yet**: the dispatcher refuses a second handler for an event, and no
  consumer exists, so each owner adds its own queue to the one call when its job lands. Nothing
  enqueues a `meta.*` event until then.
- **`MetaModule.forRoot` has no `storage`.** Nothing in M10-02 stores a file; M10-03 adds it with its
  media sink. `overrides.graph` and the `META_GRAPH` token are in because three later deliverables read
  the client through them; nothing in M10-02 calls Graph, and a suite asserts it.
- **`InboundSender.kind`** (`ticketing/sender-gate.ts`) accepts the three platforms, which M10-03 was
  going to do.
- **No i18n catalogs.** The brief names none for this deliverable.

Not in this deliverable, by design: any inbound service, the accounts' routes, the deliveries' routes
and the reply hook, the worker's registration, the admin screens.

Tests: unit for the body parser, the verdict, the signature path, the router's decisions, the dedupe
and the gate, the App service and the events; `meta-webhook.integration.test.ts` against real Postgres
and Redis with `FakeGraph` and `MetaWebhookDriver` (the handshake with the right and wrong token; a
batch of two brands reaching the service once per entry inside its brand; a redelivered batch deduped;
a wrong, missing and tampered signature; the Instagram secret; a brand in its grace answered 200 with nothing filed; two concurrent deliveries; a failing
route rolled back and redelivered; the App card) and the repository's queries.

## M10-07 Admin API and the Channels › Meta screens

Artboards: `Admin/Channels-Meta` and `Admin/Channels-Meta-Account`. The admin side is built; the api
routes follow it (see [What is left](#m10-07-what-is-left)).

**The admin client** (`apps/admin/src/meta/`, mirroring `apps/admin/src/telegram/`): `MetaApi`
(`app`, `rotateVerifyToken`, `accounts`, `account`, `createAccount`, `updateAccount`,
`deleteAccount`, `testToken`, `testAccount`, `subscribe`, `status`), `HttpMetaApi`, `metaKeys`,
`MetaError` and `isMetaError`, `MetaApiProvider` and `useMetaApi`, and `MockMetaApi` with the
fixture of the artboard (two WhatsApp numbers, a Messenger Page, an Instagram account whose token
Meta invalidated) and the `MOCK_*` ids and tokens the unit and browser suites paste. A refusal
crosses as `error.meta.reason` in the error body (`errorResponseSchema` gained `meta`) and becomes
a `MetaError`, which the dialogs turn into a sentence. The ticket view's half of the interface
(`ticketContext`, `retryDelivery`) is M10-08's.

**The screens** (`apps/admin/src/screens/admin/channels/meta/`):

| File | What it draws |
|---|---|
| `meta-tab.tsx` | the tab: the App card, the accounts table or the empty state, "How messages arrive" and the health legend, and the two dialogs; "Connect account" sits in the page header, which owns the dialog |
| `app-card.tsx` | MetaAppCard, install admins only: the callback URL with Copy, the verify token (made here, replaced after a confirmation, shown once in a SecretReveal), what the app id and the two secrets are |
| `account-table.tsx`, `account-health.tsx` | MetaAccountTable and its HealthIndicator, with Expiring read from the token's date (under a week left means the weekly renewal did not run) and the failure named ("Token expired") |
| `connect-account-dialog.tsx`, `token-test.tsx` | ConnectAccountDialog: platform RadioCards, the id named per platform, the token, the department, Test before Connect; a refusal sits under the field it concerns |
| `account-page.tsx`, `account-draft.ts` | MetaAccountPage: the form saved together, the Activity card and the Disconnect card |
| `connection-section.tsx`, `reconnect-dialog.tsx` | Connection (masked token, kind, expiry, Test connection) and, once Meta has invalidated the token, what Meta said and Reconnect |
| `subscription-section.tsx` | Subscription: state, fields as tags, last checked, Meta's last problem, Subscribe now |
| `number-section.tsx`, `routing-section.tsx`, `human-agent-section.tsx` | Number (WhatsApp only, with the charge and no-Human-Agent notes), Routing, Human Agent (Messenger and Instagram only) |
| `disconnect-dialog.tsx` | the typed-id confirmation, from the table's menu and from the page |
| `platforms-card.tsx`, `platforms.ts`, `code-text.tsx` | "What each platform asks for" beside the empty state; the platform icons (DESIGN §5: WhatsApp `phone`, Messenger `messages-square`, Instagram `camera`) and labels; backticked names in catalog sentences drawn as mono code |

The System page's Channels card lists the three kinds, the Meta tab has the `network` icon, and the
stand-in icons of M10-01 (contact identities, ticket channel badge) now are the three DESIGN §5 picks.
`Field` takes a node as its hint so a sentence can hold a code span.

**Where the artboard asked for more than the schemas carry**, the screen shows what they carry and
says nothing it cannot know:

- The App card cannot show the app id or the Graph version, nor whether a secret is set unless the
  environment holds it: `metaAppSchema` is `appIdSet`, `callbackUrl`, `verifyTokenHint` and
  `secretsLockedByEnv`. The app id reads "Set" or "Not set", a locked secret is an EnvLockedField with
  the "Set by environment" chip, and an unlocked one says it is not set by the environment. There is no
  Meta section on Settings, so the card names the `HD_META_*` variables instead of "Change it on
  Settings". Connect is held off in the empty state only when an install admin sees no app id or no
  verify token; any other missing secret is the api's `app-not-configured`.
- Messages delivered in 24 hours and the WhatsApp quality rating are not in the status response, so
  the Activity card and the Number section leave them out. "Renewed by Helpdock" needs a field the
  account row does not have; the table says Subscribed, Not subscribed, or Not checked since the time
  of the last subscription.
- Test names what Meta returned as `name`, `username` and the token's expiry; the number itself is the
  row's `displayPhone` once connected.

**Tests.** Unit: the api client and fixture, every screen (`meta-tab.test.tsx`,
`account-page.test.tsx`, the health, draft and platform helpers) and the System card. Playwright
`apps/admin/e2e/meta.spec.ts` against the fixture, in `en` and `ar` with axe: the list and the app
card, the verify token, Connect with a refused token and then a good one for each platform, a Page's
page (Test connection, Human Agent, Save, Disconnect by id), a WhatsApp number's page, and Reconnect.

### M10-07 What is left

The api side of the deliverable: `meta-accounts.service.ts`, `meta-accounts.controller.ts`,
`graph-factory.ts`, the `channel-status` rows, the integration suite, and
`apps/admin/e2e/api/meta.api.spec.ts` with its own stand-in. They wait for `MetaModule`,
`meta.repository.ts` and `meta-app.service.ts` of M10-02.

## M10-03 WhatsApp inbound and the shared conversation router

A WhatsApp message becomes a ticket, or a reply on the conversation's open one, through the same lifecycle
calls email, the widget and Telegram make. This deliverable also writes what Messenger (M10-04) and
Instagram (M10-05) import: the router, the attachment sink that defers the bytes, the `meta.media_fetch`
job, the thread's wording, the factory, the erasure and the retention purge. The guides are
[Meta channels](../guides/meta-channels.md), [Contacts](../guides/contacts.md) and
[Data retention](../guides/data-retention.md).

| File | What it holds |
|---|---|
| `apps/api/src/meta/meta-router.ts` | `MetaConversationRouter`: `route(context, message, sink, options?)` (the contact, `upsertConversation`, follow merges, `onCustomerReply` or a new ticket with `channel: platform` in the account's department, the same activity, outbox and auto-assign calls as Telegram's), `contactFor`, `followMerge`, `openTicket`, `writeSystemLine`; the `MetaAttachmentSink` and `MetaSinkInput` it calls |
| `apps/api/src/meta/deferred-sink.ts` | `DeferredAttachmentSink.store`: each file `pending` with no object and a `meta.media` outbox row; `declaredFile`, `metaFileName` |
| `apps/api/src/meta/meta-media.job.ts` | the `meta.media_fetch` consumer: `createMetaMediaFetchHandler`, `createMetaMediaFetchProcessor`, `accountFailureRecorder`, `matchesDigest`, `sizeCap`, `actionFor`, `accountFailureOf` |
| `apps/api/src/meta/meta-text.ts`, `packages/i18n/locales/*/meta.json` | the `meta` namespace: `metaText`, `metaInboundLabels`, `metaSystemLine` |
| `apps/api/src/meta/factory.ts` | `createMetaInboundService({ db, storage, log, keyring, graph })` → `{ router, sink, whatsapp, mediaFetch }`; `MetaModule` takes `whatsapp` for its handler map and the worker takes `mediaFetch` for the `inbound` queue |
| `apps/api/src/meta/whatsapp-inbound.service.ts` | `WhatsAppInboundService`, the `PlatformInboundService` for `whatsapp`, registered by `MetaModule` |
| `apps/api/src/contacts/identity.ts` | `attachVerifiedIdentity`, `planVerifiedAttach`, `removeIdentity` |
| `apps/api/src/meta/meta.repository.ts` | `messageByPlatformId`, `failByReport`, `recordPricing` |
| `packages/jobs/src/jobs.ts` | `metaMediaFetchJob`, `metaMediaFetchPayloadSchema`, `META_MEDIA_FETCH_ATTEMPTS` |
| `apps/api/src/retention/*` | `eraseMetaConversations`, `purgeMetaDeliveriesBatch`, `counts.metaDeliveries` |

### What each WhatsApp event becomes

The webhook has already answered `duplicate` for a `wamid` that `ticket_messages.external_message_id` holds
and `ignored: blocked-sender` for a sender on the block list; the service repeats neither.

| `MetaEvent` | What is filed | Outcome |
|---|---|---|
| `message`, text | a public message from the contact; the ticket's subject is its first line | `handled` |
| `message`, image, video, document, audio, voice note, sticker | the caption as the body (empty allowed) and each file as an attachment, `pending`, with a `meta.media` outbox row; a sticker is an image, a photo sent as a document is an image | `handled` |
| `message`, location | `Location: lat, long`, the venue and a map link, the label in the contact's language (`meta:thread.location`) | `handled` |
| `message`, shared contacts | `Contact: <name>`, then the company, numbers and addresses | `handled` |
| `message` with `context` | a leading quote of the quoted message's words when that message is on the ticket the message lands on, whether the customer or an agent wrote it (agent replies are found by the ids on their delivery) | `handled` |
| `message` with `errors[]` and files | the files `rejected: unreadable`, nothing fetched; the message is filed | `handled` |
| `message` with `errors[]` and no files | filed; the error is logged | `handled` |
| `message` from a number on the block list by hand | dropped, counted on the block row, no contact | `ignored: blocked-sender` |
| `message` whose customer id is not a valid identifier | dropped and logged | `ignored: invalid-customer-id` |
| `status` `delivered` or `read` | the reply's delivery moves forward, `delivered_at` and `read_at` coalesced; never back | `handled`, or `ignored: no-delivery-to-advance` |
| `status` `sent` | nothing: the send job recorded the acceptance | `ignored: status-sent` |
| `status` `failed` | the delivery `failed` with Meta's code and words; `refused` when the code says the window had closed (`131047`) | `handled`, or `ignored: no-delivery-to-fail` |
| any `status` with `pricing.category` | `meta_deliveries.pricing_category` | |
| `system` `user_changed_number` | the new `wa_id` is the contact's verified phone, the old phone identity is removed, `meta_conversations.wa_id` follows, and a system line names both numbers on the open ticket | `handled`, or `ignored: unknown-conversation` |
| `unsupported` | a system line on the open ticket (none when there is no ticket), deduped on the `wamid`; the message still opens the reply window | `handled`, `duplicate`, or `ignored: no-conversation` / `no-open-ticket` |
| `reaction` | a system line on the ticket of the message reacted to (a customer's message, or an agent's reply by its delivery's ids); none when the ticket is closed; never a message, never a window | `handled`, or `ignored: unknown-message` / `no-open-ticket` |
| `error` (about the account) | logged and written to `meta_accounts.last_error` | `handled` |
| `ignored` and the Messenger and Instagram kinds | counted and dropped | `ignored` |

### What the media job does

```
pending attachment + meta.media outbox row                      (the webhook's transaction)
meta.media_fetch  whatsapp_media: GET /{media-id}, then the URL it names with the token
                  cdn_url:        the link, no token, host checked against Meta's
                  size against the brand's cap (Graph's file_size first), sha256 against the bytes
                  the type against the content policy, the object put at the attachment's key
                  status = processing, outbox(attachment.uploaded)
media.process     sniff, re-encode, scan, ffmpeg  →  ready | rejected
```

| What happened | Attachment | Account |
|---|---|---|
| the digest differs | `rejected: unreadable` | |
| over the cap | `rejected: too_large` | |
| the policy refuses the type or the kind | `rejected: mime_not_allowed` / `kind_disabled` | |
| 404 (or `100/33`) on the id or the link | retried; the last attempt `rejected: object_missing` | |
| `190` | retried; the last attempt `rejected: processing_failed` | `token_expired`, `last_error` |
| a permission or a restriction | `rejected: processing_failed` | `last_error` |
| Graph, the network or the bucket failing | retried; the last attempt `rejected: processing_failed` | |
| a host that is not Meta's | `rejected: processing_failed` | |

### Decisions taken inside the plan

- **No early transaction.** The brief had the service check `seen` and `blocked` in a transaction of its own
  before one that files. M10-02's seam does both before `handle`, and nothing is downloaded in the request,
  so there is one transaction and the service asks neither.
- **The job moves the row to `processing` itself.** `media.process` takes a row only when it is `processing`
  (`process.job.ts`), which the confirm endpoint sets for an agent's upload. A Meta file is never confirmed, so
  the fetch sets it, with the size, the type and the name the bytes turned out to have, in the same write.
  (By reading `StorageAttachmentSink`, the files of an inbound email or Telegram message are left `pending` and
  skipped by `media.process` in the same way; that is M2's and M6's to confirm and is not changed here.)
- **The last attempt settles instead of throwing.** The job's transaction rolls back when it throws, so a file
  that cannot be had would stay `pending` for good. The account's `token_expired` is written outside that
  transaction for the same reason, so the operator sees it at the first attempt.
- **A story's kind is the server's to say.** A link declares no type; a story is filed as an image and takes
  the kind of the type the CDN answers with, under the larger of the image and video caps.
- **Deleting a conversation takes its deliveries.** `meta_deliveries.conversation_id` cascades, so erasing a
  contact deletes the replies delivered through their conversation instead of rewriting `customer_id` as
  `eraseTelegramChats` does for `telegram_deliveries`, which has no such foreign key. A reply still queued
  finds no delivery and sends nothing. The thread keeps the reply.
- **`failed` can follow `sent`.** `recordFailure` only moves `queued` and `failed` deliveries, and Meta reports
  a failure after it accepted the message, so `failByReport` ends a `queued` or `sent` delivery by the id Meta
  gave the part. `delivered` and `read` are not moved back.
- **An unsupported message opens the window.** The customer wrote, and Meta will accept an answer; refusing it
  at compose time would be stricter than Meta. A reaction does not, as DOMAIN-RULES §2.6 says.
- **A phone on the block list stops WhatsApp too.** The webhook asks about the user id; an admin who blocked a
  number by hand meant the person.
- **Two proofs of one number are suggested, not merged.** DOMAIN-RULES §4.4 lists a phone as auto-merging
  "between two verified phones". The contact of a WhatsApp message is settled by its user id before the
  number is looked at, so merging two contacts there would be a decision made in the middle of a webhook;
  `attachVerifiedIdentity` leaves the number where it is, suggests the pair and logs it. The table's row is
  for a caller that finds a contact by a verified phone, and none does yet.
- **A number that is not a phone number never costs the message.** `attachVerifiedIdentity` refusing it, or
  two contacts proving the same one, is logged and the message is filed: Meta redelivers a failed batch for
  seven days.
- **`@helpdock/jobs` depends on `@helpdock/schemas`** so `metaMediaFetchPayloadSchema` uses
  `metaFileRefSchema` instead of copying it.
- **What a reaction carries is escaped.** Its emoji is the customer's text and the system line is HTML.

Tests: unit for the sink, the media job (every row of the table above), the wording, `planVerifiedAttach`
and the job definition; `apps/api/src/meta/meta.integration.test.ts` › "WhatsApp (M10-03)" against real
Postgres and Redis with `FakeGraph` and `MetaWebhookDriver`, and the erasure and purge cases of
`apps/api/src/retention/retention.integration.test.ts`.

## M10-04 Messenger inbound

`MessengerInboundService` (`apps/api/src/meta/messenger-inbound.service.ts`) is the Messenger entry of the
seam M10-02 built: `PlatformInboundService.handle({ tx, account, now }, event)`, called once per event of a
Page, inside the route's brand transaction, after the seam has already answered `duplicate` for a `mid` that
`ticket_messages.external_message_id` holds and `ignored: blocked-sender` for a sender on the block list.
It calls Graph for one thing only, the customer's name (below), and writes every other side effect as an outbox row.

| File | What it holds |
|---|---|
| `messenger-inbound.service.ts` | the service; `PROFILE_TIMEOUT_MS` |
| `meta-thread.ts` | `ticketOfMessage` (the ticket a platform message is on: a customer's message by `external_message_id`, one of Helpdock's replies by `meta_deliveries.platform_message_ids`) and `writeSystemLine`; M10-03 and M10-05 write the same lines and use the same two |
| `meta-app.service.ts` | `MetaAppService.appId()`: the install's `meta.appId`, for the echo rule |
| `packages/i18n/locales/{en,ar}/meta.json` | the `meta` namespace: `thread.reaction`, `reactionPlain`, `reactionRemoved`, `edited`, `unsupported` (and the words a location, a contact and a story are filed under) |
| `meta-router.ts`, `deferred-sink.ts`, `meta-text.ts`, `factory.ts` | **stand-ins for M10-03's files** of the same names (brief §4.1), marked as such in a leading comment, so this branch runs before M10-03 lands. `meta.module.ts` builds the inbound pipeline through `createMetaInboundService` in `factory.ts`, which is where M10-03 and M10-05 register their platform's service |

**What each event becomes**

| Event | What happens | Outcome the route reports |
|---|---|---|
| `message` (text, `image`, `video`, `audio`, `file`, `sticker`, `fallback`) | `router.route` under the identity `<page id>:<psid>` (`messenger.page`, verified); the name is `null` unless the profile read below succeeds; each `image`, `video`, `audio`, `file` attachment is a `cdn_url` ref with the declared `type`, a `sticker` the same ref filed as an image, written `pending` with a `meta.media` outbox row (nothing is fetched in the request); a `fallback` with a URL is a text line (`title`, then the URL); one without, and any attachment of a type Helpdock cannot show, adds a system line "The customer sent something Helpdock cannot show." beside the rest of the message | `handled` |
| `unsupported` (`is_unsupported`, or a message with nothing to file) | the same system line on the conversation's ticket; none when the customer has no conversation or ticket | `handled`, or `ignored: no-ticket` / `no-customer` |
| `echo` | `app_id` equal to `meta.appId`, or `metadata` naming a `meta_deliveries` row of this account: Helpdock's own send, dropped silently. Any other echo (typed in the Page inbox, another app): dropped, logged at `info` without a word of it | `ignored: echo`, `ignored: echo-not-ours` |
| `delivery` | `advanceByWatermark(conversation, 'delivered', watermark)`: every delivery of the conversation sent at or before the watermark; and `advanceStatus(mid, 'delivered', …)` for each `mid` the report names, which a watermark earlier than the message does not reach. Both only move a delivery forward | `handled`; `ignored: no-conversation` / `empty-receipt` |
| `read` | `advanceByWatermark(conversation, 'read', watermark)` | the same |
| `reaction` | a system line on the ticket of the message reacted to, a customer's or one of Helpdock's replies: "The customer reacted ❤️ to a message.", or "…removed their reaction…". Never a window anchor | `handled`; `duplicate`; `ignored: unknown-message` |
| `edit` | a system line with the new words, on the message's ticket; the message keeps what it said | the same, and `ignored: empty-edit` |
| `postback`, `referral`, `standby` (and any other `ignored` event) | counted, dropped | `ignored: postback` / `referral` / `standby` / the classifier's reason |
| `policy_enforcement` | counted, dropped, and recorded as the account's `last_error` (`messaging_policy_enforcement block: <Meta's reason>`) | `ignored: policy-enforcement` |
| an event of another platform (`status`, `seen`, `deleted`, `user_changed_number`, `error`) | dropped with a warning; a Page's webhook never carries them | `ignored: unexpected-<kind>` |

Decisions taken inside the plan, each with its reason where it is made:

- **The customer's name is read in the request, once, with a deadline.** Brief §4.3 asks for `GET /{psid}?fields=first_name,last_name`
  once per conversation and the checklist says the webhook never calls Graph; the brief is the more specific, so the
  read is made, but only when the conversation row does not exist yet, with the Page's token, and the wait is cut at
  `PROFILE_TIMEOUT_MS` (3 s). A refusal (a Page without the reviewed feature answers 400 or 403), a Graph that is down,
  a slow one and a reply in a shape Helpdock does not know all leave the name `null` and file the message. A name that
  is not read is **never stored**: the contact is named by its identity value, `meta_conversations.profile_name` stays
  null, and the thread draws "Messenger user" (M10-08). Accepted gap: a *transient* failure on the first message
  costs the conversation its name for good, because asking again on every message would cost every Page without the
  feature a failing call per message. A failure that is not Graph's (a decryption error) fails the route.
- **Two tests recognise Helpdock's own echo, and only two.** `app_id` equal to `meta.appId` (set it, or this test never
  matches) and `metadata` naming a delivery of *this* account (a delivery id of another account is not ours). The echo of
  a part sent with neither is counted as foreign, `echo-not-ours`, and dropped all the same.
- **A watermark is compared with `sent_at`**, when Helpdock recorded Meta's acceptance, which trails the message's own
  time by the length of the call; `delivered_at` and `read_at` take the watermark. A report that names its `mid`s is
  exact and goes through `advanceStatus`. A `read` that arrives before the `delivery` it implies leaves the delivery
  `read`: the later report matches nothing.
- **Lines are idempotent.** A reaction, an edit or an unsupported message has no `mid` of its own, so the system line's
  `external_message_id` is `reaction:<mid>:<psid>:<react|unreact>:<ms>`, `edit:<mid>:<n>` or `unsupported:<mid>`; the
  unique index on `(brand, channel, external_message_id)` then keeps a redelivery to one line. The prefix keeps the keys
  from ever being a platform `mid`. A line is written in the contact's language, its HTML escaped, its text as typed.
- **`unblock` is not an error.** Only a notice that warns or blocks goes on `last_error`; `lastErrorAt` is set one
  millisecond after the event because the route stamps `last_event_at` with the same instant once the handlers have run,
  and health reads an error as current only when it is later. The next event of any kind makes the account healthy again.
- **The customer's time, never later than ours.** A message is filed at the time Meta gave it (the anchor of the reply
  window) unless that is in the future.
- **A customer id the contact layer cannot spell** (anything but letters, digits and `._:-`) is dropped as
  `ignored: invalid-customer-id` instead of failing the batch, which Meta would redeliver for ever. Meta's ids are never such a thing.

Not in this deliverable, by design: the `meta.media_fetch` job and the end-to-end "photo reaches `ready`" test (M10-03 owns
the job; this branch proves the `pending` attachment and the `meta.media` row), the thread's rendering of the lines
(M10-08), the reply path (M10-06), the Instagram twin (M10-05).

Tests: `messenger-inbound.service.test.ts` (each event kind with the database and Graph faked),
`meta-thread.test.ts`, `deferred-sink.test.ts`, the `appId` cases of `meta-app.service.test.ts`, and
`meta-messenger.integration.test.ts` against real Postgres and Redis through the signed-webhook driver and the stand-in for
Graph: a message opens a ticket under the contact keyed on `<page id>:<psid>`, named by the profile; a second continues
it without a second read; a redelivery files nothing; a Page without profile access still gets the message; a blocked
sender is dropped before a contact exists and counted; the reopen policy (inside the window the ticket comes back, past
it a new one continues it); an image, a video, an audio file and a file become `pending` attachments with a `meta.media`
row and nothing is fetched; a sticker is an image; a `fallback` is a text line; two Pages of two brands in one batch file
into their brands; the echo of a Helpdock send (by delivery id and by app id) files nothing, nor does any other; a
watermark marks the two earlier deliveries and not the later one, a late `delivery` leaves `read` alone, a named `mid`
moves past an earlier watermark; a reaction on a reply is a system line, once however often it arrives, in the contact's
language; an edit; unsupported content; postbacks, referrals and standby are dropped; policy enforcement is on the
account and reads `failing` until the next event.

## M10-06 Replies, the window, `meta.send`, deliveries and pacing

Artboards: `Admin/Ticket-Meta` (the reads behind it; the screens are M10-08's) and `Meta/Chat-EN`,
`Meta/Chat-AR` (what the customer receives). The guide is [Replying](../guides/meta-channels.md#replying)
and [Reply windows](../guides/tickets.md#reply-windows).

| File | What it holds |
|---|---|
| `tickets/reply-delivery.hook.ts` | `assertCanDeliver(tx, { brandId, ticket, personAuthored })` on `ReplyDeliveryHook` (default: allow) and on `ChannelReplyDeliveryHooks` (each hook in turn); `personAuthored` on `StaffPublicReplyEvent` |
| `tickets/tickets.service.ts` | `addMessage` asks `assertCanDeliver` for a staff public reply **before** `nextSeq`, so a refusal takes no lock and writes nothing; its `onStaffPublicReply` says `personAuthored: true` |
| `meta/meta-window.ts` | a re-export of `replyWindow` and `replyWindowView` from `@helpdock/channels`, and `conversationWindow` (a conversation row and an account row to the function's input), `windowClosedCode`, `closedWindowDetails`. There is no second window function |
| `meta/meta-reply.hook.ts`, `meta/outbound-meta.service.ts` | `MetaReplyHook` (wired in `tickets.module.ts` and `ai/auto-reply/auto-reply-deps.ts`); `OutboundMetaService` (`targetFor`, `queueReply`, `retry`) |
| `meta/meta-attachments.ts` | `planOutgoingFile(row, platform)`: `wait`, `skip` with a reason, or `send { method, variant, size, mime }`; `readOutgoingBytes` |
| `meta/meta-pacing.ts` | `withRecipientPace`, `RecipientPaceHeld`, `holdRecipientPace`, `paceKey` |
| `meta/meta-send.job.ts` | `createMetaSendHandler`, `createMetaSendProcessor`, `recordSendFailure`, the errors the handler throws |
| `meta/meta-text.ts` | `fileLeftOutText`: the line a customer gets in place of a file the platform will not take (`meta` catalog, `en` and `ar`) |
| `meta/meta-deliveries.service.ts`, `meta/meta-view.ts`, `meta/ticket-meta.controller.ts`, `meta/dto.ts` | `list`, `ticketContext`, `retry`; the delivery and context views; the three ticket-half routes |
| `packages/jobs` | `metaSendJob`, `metaSendPayloadSchema` (`kind: 'reply' \| 'template'`); `JobContext.token` |
| `worker/start-worker.ts` | the `meta.send` processor on the `outbound` worker; the one `registerMetaEventHandlers` call, with the send queue only |
| `csat/csat-delivery.ts` | `whatsapp`, `messenger` and `instagram` are `unreachable` |

**Routes** (`ticket-meta.controller.ts`): `GET /api/brands/:brandId/tickets/:ticketId/meta` and
`GET …/meta/deliveries` (`ticket:read`), `POST …/meta/deliveries/:deliveryId/retry` (`ticket:write`, `204`;
`409 reply-window-closed` for a `refused` delivery). **For M10-08**: `MetaTicketContextResponse`
(`{ context: MetaTicketContext | null, deliveries: MetaDeliveryView[] }`), `MetaDeliveryView` (now with
`partsTotal` and `leftOut`), `ReplyWindowView`, `MetaLeftOut` and `MetaRefusalDetails` from `@helpdock/schemas`;
the refusal is `error.meta` of the 409 body.

Decisions taken inside the plan, each with its reason where it is made:

- **Pacing goes through `moveToDelayed`, not an in-process wait.** `JobContext` carries the lock token BullMQ
  gives its processor (`createJobProcessor` and `createWorker` forward it; optional, so no existing handler
  changes), a held slot calls `job.moveToDelayed(Date.now() + remaining, token)` and throws `DelayedError`.
  `packages/jobs/src/consumer.integration.test.ts` proves it against a real BullMQ: started twice, one attempt
  spent, the first run's write and receipt rolled back. The preferred route of the brief therefore stands, no
  ADR amendment is needed for it, and `meta-replies.integration.test.ts` runs a real worker through six real
  seconds. The key is claimed with `SET NX PX 6000` before a part and set again for a whole pace after it, because
  Meta counts the gap between messages it received; a part that fails leaves the claim as made, and `131056` sets it.
- **The window is read again only before the first part** (`parts_sent = 0`). A window that closes between two parts
  of a reply is Meta's to refuse (the job maps it to `refused` all the same); a clock is not allowed to turn a
  half-sent reply into a refused one. `personAuthored` there is the message's author being staff.
- **`StaffPublicReplyEvent.personAuthored`** (optional, additive) is how `onStaffPublicReply` knows which window to
  ask about: `addMessage` says `true`, the assistant's `auto-reply.job.ts` says nothing and gets the 24 hours. A
  message that arrives there with the window closed is written `refused` with the platform's code and **no outbox
  row**: the message stands, the thread shows why. The same happens to a person's reply the clock moved past the
  window between `assertCanDeliver` and the write.
- **`assertCanDeliver` runs before the `clientId` lookup**, as the brief orders it. A retried send of a reply that
  was stored just before the window closed therefore gets the `409` rather than the stored message. The composer
  already disables Send first, so this is the race of a race, and moving the check inside the lock would give up
  the "takes no lock" property.
- **WhatsApp is written to by number when Meta sent one** (`to: wa_id`), else by the business-scoped user id
  (`recipient`, July 2026). Meta says the phone takes precedence when both are given, so sending both would
  only hide which one the account relies on.
- **File types are the worse case Meta's pages allow** (`meta-attachments.ts`). WhatsApp takes JPEG and PNG as an
  image, MP4 and 3GP as a video and five audio types; Instagram JPEG and PNG, its video and audio lists and PDF as the
  only file; Messenger names no list. A file that is not a native type of its kind, or is over its limit, goes as a
  **document** where the platform takes documents. This matters because the pipeline's output for an image is a WebP
  and for a voice note an Opus unless the brand keeps originals (off by default): without the fallback every image
  would fail on WhatsApp. Instagram has no document fallback (PDF only) and takes no WebP, so on a brand that keeps no
  originals an image sent on Instagram is left out. That is a gap accepted here, not a decision: it is the worse case
  of an unconfirmed fact (Meta lists JPEG and PNG for Instagram images and says nothing of WebP), and a run against the
  staging accounts settles it.
- **A file left out is not silent.** `DESIGN.md` MetaMessages says the customer gets "One file could not be sent
  here: warranty-terms.docx. Instagram only takes PDF files, so we will send it another way." in its place, and the
  thread tells the agent. The brief named one key, `meta:reply.fileLeftOut`; three exist, because that sentence is
  only true of a file on Instagram: `fileLeftOut` (a file on a platform that takes PDF only), `fileUnsupported` (a
  type the platform does not list) and `fileTooLarge`. The name is wrapped in Unicode isolates, which is what `<bdi>`
  stands for in plain text. The language is the contact's, else the brand's. A file the **pipeline** refused is left
  out without a notice: the composer showed that when it was added.
- **`leftOut` and `partsTotal` on the delivery view**, and `displayPhone` on the context's account, are additive to
  the M10-01 schemas. M10-08 draws "warranty-terms.docx left out", "Sending · part 2 of 3" and "WhatsApp · +1 555 0142"
  from them, and none can be derived on the client: `leftOut` is the planner's answer, which the client must not
  re-implement.
- **The first message of a reply opens with "First name · Brand"** (settled with the owner; `MetaMessages` in
  DESIGN §6.3 and the `Meta/Chat` boards): the author's first name (the display name up to its first space), a middle
  dot and the brand's name, "Lina · Helpdock", then a newline and the agent's text. A reply nobody wrote (the
  assistant's, a rule's) carries the brand's name alone. Only the first message has it, and it counts toward the
  platform's limit, so the text is cut after the line is put in front (`meta-reply-text.ts`). A reply that is only files
  sends the line as a message of its own, so the customer still sees who wrote. The rule is the pure
  `metaOpeningLine({ firstName, brand })` in `@helpdock/schemas` (with `firstWordOf`), so M10-08's composer counts "Sent
  as N messages" the same way. The name comes from the message's staff author row and the brand from the brand row.
- **The Human Agent tag is M10-09's.** A person's reply in the extended days is composed and queued, goes out as
  `RESPONSE`, and Meta refuses it with the closed-window error, so the delivery ends `refused` with Meta's code.
  `MESSAGE_TAG` with `HUMAN_AGENT` is two lines in `messagingCourier`, with the delivery's `tag`, the day-3 case and
  the proof it is never sent for an AI or rule reply.
- **Failure is recorded outside the job's transaction**, as `telegram.send` does (`createMetaSendProcessor`): a throw
  rolls the transaction back, and the failure has to survive it. `refused` is recorded the same way. `token_dead` also
  sets the account `token_expired` (no `meta_account.changed` event: the health job needs none for a flip it caused).
  A delay is not a failure and records nothing.
- **The ticket context is null for a ticket whose channel is not a Meta platform**, even when its contact has a Meta
  conversation: `conversationForTicket` falls back to the contact's latest conversation for a ticket filed by hand, and
  a reply on such a ticket goes by the ticket's own channel (email), so the view must not draw a WhatsApp strip on it.
- **The `meta` i18n namespace is created here** with `reply.*`; M10-03 adds `thread.*` (the location label and the
  rest) to the same files.
- **The presigned link comes from `ObjectStorage.presignDownload`** (`media/storage.ts`, five minutes): the brief
  named `media/link.ts`, which links attachments to messages and signs nothing.
- **`meta-events.ts`** drops its local `MetaSendJobPayload` for `@helpdock/jobs`'s `MetaSendPayload`;
  `WorkerEnv` gains the three `META_*` keys the Graph client reads.

Tests. Unit: the window adapter, `OutboundMetaService`, `MetaReplyHook`, `ChannelReplyDeliveryHooks`, the attachment
planner for every platform and type, the pacing against a fake Redis and clock, the failure table of `recordSendFailure`,
the customer's notice in both languages, the views, the `meta.send` job definition, the jobs schema additions, the CSAT
`unreachable` answers. Integration (`meta-replies.integration.test.ts`, Testcontainers, `FakeGraph`, `MetaWebhookDriver`):
the exit criterion on each platform (the stand-in receives `/messages` once when the job runs twice; the reports move the
delivery to `delivered` and `read`), two files on WhatsApp as three messages with `parts_sent` resuming after a failure on
the third, a 1000-byte Arabic reply on Instagram split at a letter, a reply at 24 h 01 m refused at compose time with no
row, one queued at 23 h 59 m and refused by the job at 24 h 01 m, the assistant's message past the window refused with no
job, two replies to one customer six seconds apart through a real BullMQ worker, `551` failing at once, `190` marking
`token_expired`, `131056` retrying, Retry refused for a `refused` delivery, a file Instagram will not take, the ticket
routes' shapes and scope. `tickets.integration.test.ts` gains the compose-time refusal on a real Meta ticket. The reports
in the replies suite are applied by a double standing in for M10-03 to M10-05's inbound services.

Not in this deliverable, by design: the thread's screens (M10-08), templates and the Human Agent tag (M10-09), the
inbound `statuses[]`, watermarks and `messaging_seen` handling (M10-03 to M10-05; the repository's `advanceStatus` and
`advanceByWatermark` they call are M10-02's), and the guide's walk-through of the Meta dashboard (M10-11).

## M10-10 Health jobs

`meta.health` checks each connected account hourly: its token, its webhook subscription (subscribing
the app again when Meta dropped it) and, for Instagram, the weekly renewal of the 60-day token. What
it finds goes on the `meta_accounts` row. The operator's view is
[Operating Helpdock › Meta account health](../guides/operations.md#meta-account-health).

| File | What it holds |
|---|---|
| `meta-token-refresh.ts` | `refreshInstagramToken({ db, repository, keyring, graph }, account)` → `{ outcome: 'refreshed' \| 'refused' \| 'not-due', expiresAt? }`, a plain function the job and M10-07's `POST :accountId/refresh` share; `instagramRefreshDue`, `INSTAGRAM_REFRESH_AFTER_MS` |
| `meta-health.ts` | `checkMetaAccount(checks, account, token, now)`: the four steps as a decision from what Graph says to the update the row should get. Reads Graph, writes nothing |
| `meta-health.job.ts` | `runMetaHealth` (one account in its brand's transaction with the hour's receipt), `createMetaHealthProcessor` (the `maintenance` worker's processor for both jobs), `queueMetaHealthScheduler`, `scheduleAllMetaHealth`, `createMetaAccountChangedHandler` |
| `packages/jobs/src/jobs.ts` | `metaHealthJob` (`meta.health`), `metaHealthScheduleJob` (`meta.health.schedule`), `metaHealthPayloadSchema`, `META_HEALTH_CRON`, `META_HEALTH_SCHEDULE_CRON`, `metaHealthSchedulerId`, `metaHealthReceiptKey` |
| `worker/start-worker.ts` | the `meta.health` processor and `scheduleAllMetaHealth` on the `maintenance` worker, `meta.health.schedule` in its cron loop, `META_*` keys in `WorkerEnv`, and the one `registerMetaEventHandlers` call (`accountChanged`) |

**What each step does.** The decision table is in the header comment of `meta-health.ts` and proved
in `meta-health.test.ts`.

1. *The token.* WhatsApp and Messenger: `GET /debug_token?input_token=<the token>` with the token
   itself; Instagram, which has no `debug_token`: `GET /me` on the Instagram root. A 190-class
   refusal, or a 200 with `is_valid: false`, sets `status = token_expired` and `last_error`, and
   ends the run.
2. *The subscription.* `GET /{id}/subscribed_apps` (`id` is the business account's `waba_id` for
   WhatsApp, the `external_id` for the others); the install's app (`meta.appId`, any
   app while it is unset) missing → `POST` it with the platform's fields (`META_SUBSCRIBED_FIELDS`;
   none for WhatsApp) and read it back. Still missing, or the `POST` refused → `unsubscribed`.
3. *The renewal.* Instagram only, via `refreshInstagramToken`. Refused → `last_error`; and
   `token_expired` when the row's expiry has passed or Meta calls the token dead.
4. *All well.* `connected`, `subscription_checked_at`, `subscribed_fields` as Graph listed them,
   `subscribed_at` when the job subscribed the app itself.

Decisions taken inside the plan, each with its reason where it is made:

- **The payload carries `brandId`.** The brief had `{ accountId }`; DOMAIN-RULES §1.4 says every job
  payload carries the brand, the worker opens that brand's transaction before any query, and
  `telegram.poll` does the same. The scheduler's template data is `{ brandId, accountId }`.
- **`meta.health.schedule` is a daily re-registration, not a second hourly tick.** The brief named the
  job without saying what it does. The checks come from one scheduler per account
  (`meta.health.<account id>`, `0 * * * *` UTC), as `telegram.poll` has; the schedule job, `30 5 * * *`,
  runs `scheduleAllMetaHealth` again so a scheduler lost while the worker kept running (a Redis flush,
  a `meta_account.changed` that failed for good) is back within a day. It is off the hour on purpose:
  upserting a scheduler at the instant it fires is a race. A scheduler whose account is gone
  removes itself on its next run, which is how a brand's purge (rows deleted, no event) leaves nothing
  behind.
- **The receipt is claimed in the check's transaction, before Graph is asked.** `job_receipts` is
  keyed `meta.health:<account>:<UTC hour>`; the second worker blocks on the primary key until the
  first commits, then stands down, and a check that throws rolls its receipt back so the retry runs.
  The check holds one connection for its Graph calls, as `telegram.send` does, and the renewal uses
  a second for its own short write.
- **A refused renewal does not make the account unhealthy by itself.** The brief said `connected`
  when "all three pass". A token Meta would not renew still works until its date, so status stays
  `connected` and the reason is the account's `last_error` (which turns the health word red until a
  message is filed after it); only a passed expiry, or Meta calling the token dead, is
  `token_expired`.
- **A token is due for renewal a week after the last renewal, or after it was pasted, whatever the
  row's expiry says.** The brief's condition "`token_expires_at` in the future" would never renew a
  token whose expiry the row does not know (null) and would leave a stale past date in place for good;
  asking Meta is how the row gets a true one. Meta's refusal of a token that is really expired is
  then recorded as above.
- **`last_error` is cleared only on recovery.** A clean run clears the error of an account that was
  `token_expired` or `unsubscribed`, because the error described that state. On a `connected` account
  it is left, since it may be the inbound pipeline's (M10-02) and not Meta's.
- **A refusal that gives no verdict is not a status.** Permission, restricted-account and
  malformed-request answers to a health read are recorded in `last_error` and leave `status`
  alone; a `retry` or `rate_limited` failure is thrown so BullMQ asks again (three attempts, one
  and two minutes apart) with nothing written.
- **An operator's new token wins.** The check re-reads `token_updated_at` before it writes, and
  the renewal re-reads the stored token inside its own transaction; either finding a different
  token discards what Meta said about the old one.
- **The Instagram token is sent as a bearer header** to `/refresh_access_token`, as every Graph call
  here sends it (M10-01); Meta's page writes it as the `access_token` query parameter. The stand-in
  takes both. If the staging run shows the bearer form refused, the line to change is in
  `meta-token-refresh.ts`.
- **WhatsApp's subscription is on the business account.** Meta keeps it at
  `GET|POST|DELETE /{waba_id}/subscribed_apps`, shared by every number under the business
  account; the same path on a phone number's id answers an unsupported-edge error. The check
  reads and re-subscribes on `meta_accounts.waba_id` for WhatsApp and on `external_id` for a
  Page and an Instagram account (`subscriptionNode` in `meta-health.ts`). A WhatsApp row whose
  `waba_id` is null cannot be checked: the run records "The business account id is not known;
  reconnect the number" as `last_error`, leaves `status` as it is and asks Meta nothing. M10-07's
  connect and Subscribe now must use the same id. `FakeGraph` (M10-01) changed to match: `connect`
  requires a WhatsApp number's `wabaId` and opens the business account with the number's token;
  `subscribed_apps` is served on the business account and answers Graph's unsupported-edge error
  on a number's id; `subscribe`, `dropSubscription` and `subscriptionOf` take the `wabaId` for
  WhatsApp; `debug_token` names the business accounts a WhatsApp token opens in `granular_scopes`
  and `GET /{waba}/phone_numbers` lists the numbers under one, so a connect flow can trace a
  number to its business account ([development guide](../guides/development.md#standing-in-for-a-vendor)).

Not in this deliverable: the Reconnect form and the captions on the account page (M10-07, already
drawn: it reads `status`, `last_error`, `token_expires_at` and `subscription_checked_at`), the
`POST :accountId/refresh` route (M10-07; it calls `refreshInstagramToken`), a backfill of the
messages missed while unsubscribed, and a System page row for accounts that need attention.

Tests: unit for the decision table (`meta-health.test.ts`, each answer of each step against a Graph
double), the renewal (`meta-token-refresh.test.ts`), the scheduler, the changed handler, the
processor, and the two things only a double can stage in `runMetaHealth`: a token replaced while
Graph was being asked, and a log with no token in it (`meta-health.job.test.ts`), and the job
definitions (`packages/jobs`);
`meta-health.integration.test.ts` against real Postgres and Redis with `FakeGraph`: a dropped
subscription restored on each platform and a present one left alone; an Instagram token eight days
old renewed once, the expiry moved and the renewed token used a week later; a refused renewal
recorded without the token; a dead token marked and the account brought back an hour after a good
one; the job twice in one hour, and in two workers at once, checking once; a brand in its grace
skipped; and the BullMQ schedulers registered for the accounts of two brands and followed through
`meta_account.changed`.

## Interfaces for other milestones

Planned; the implementation brief names the files. Corrected here as they land.

| Kind | Name |
|---|---|
| Outbox events | `meta.reply` `{ deliveryId }`, `meta.media` `{ attachmentId, accountId, ref }`, `meta_account.changed` `{ accountId }`; M10-09 adds `meta.template`. Declared in `apps/api/src/meta/meta-events.ts` (M10-02) |
| Seams | `PlatformInboundService` and `MetaInboundHandlers` in `apps/api/src/meta/meta-inbound.service.ts` (M10-02): the WhatsApp, Messenger and Instagram inbound services implement one and replace their platform's entry in `MetaModule.forRoot`; `MetaModuleOverrides { graph?, inbound? }` for suites |
| Jobs | `meta.send` (`outbound`, `kind: 'reply' \| 'template'`), `meta.media_fetch` (`inbound`), `meta.health` and `meta.health.schedule` (`maintenance`), `meta.templates.sync` (`maintenance`, M10-09) |
| Config | `META_GRAPH_VERSION`, `META_GRAPH_API_ROOT`, `META_INSTAGRAM_API_ROOT`; settings `meta.appId`, `meta.appSecret`, `meta.instagramAppSecret`, `meta.webhookVerifyToken` (overridable as `HD_META_*`) |
| i18n | namespace `meta` (what the api sends to customers: the location label, the refused-file line), `channels:meta.*`, `tickets:meta.*` |
| Permissions | none new: `brand:manage` for accounts, `install:admin` for the App card's secrets through Settings, `ticket:read` / `ticket:write` for the ticket's context and deliveries |
| Routes | `GET\|POST /api/meta/webhook` (built, M10-02); `GET /api/meta/app` and `POST /api/meta/app/verify-token` (built, M10-02); `/api/brands/:brandId/meta/accounts` (list, create, `test`, `:id`, `:id/test`, `:id/subscribe`, `:id/status`, `:id/refresh`); `GET /api/brands/:brandId/tickets/:ticketId/meta`, `POST …/meta/deliveries/:deliveryId/retry` |
| Packages | `@helpdock/channels` exports `GraphClient`, `classifyGraphError`, `verifyHubSignature`, `hubChallenge`, `metaEnvelopeSchema`, `routeEnvelope`, `splitMetaText`, `replyWindow`, the three adapters and, for tests, `FakeGraph`, `MetaWebhookDriver` and the fixtures; `@helpdock/net` gains `policies.graph`; `@helpdock/schemas` exports `meta.ts` |
| Channel kinds | `ticket_channel` gains `whatsapp`, `messenger`, `instagram`; `contact_identity_kind`, `contact_duplicate_reason` and `blocked_sender_kind` gain the same three |

## Pull requests

- none yet
