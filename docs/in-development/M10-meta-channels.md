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
| M10-03 | WhatsApp inbound → tickets: identity on the business-scoped user id with `wa_id` as a verified phone; profile name; text, media (image, video, document, audio and voice, sticker) through `meta.media_fetch` and the pipeline with the `sha256` check; captions, quoted context, locations and shared contacts as text; `user_changed_number`; `unsupported` as a system line; `statuses[]` onto deliveries; the sender gate | R §4.4; D §4.4, §4.7, §4.8; ADR 0025 (6) | Integration: each message type from the fixtures lands as the mapping in D §4.8 says; a 20 MB media id is fetched by the job, verified and processed; a phone typed by an agent before the WhatsApp message becomes a duplicate suggestion and the verified claim takes it | 3 d | | planned |
| M10-04 | Messenger inbound → tickets: identity on the page-scoped id, "Messenger user" without profile access; text, attachments from the CDN URL through the fetch job, stickers, `fallback` links as text; echoes of Helpdock's own sends dropped by `app_id` and `metadata`; `delivery` and `read` watermarks onto deliveries; reactions and edits as system lines; postbacks counted and dropped | R §4.4; D §4.7, §4.8; ADR 0025 (6) | Integration: the fixtures' events; an echo of a Helpdock send files nothing; a watermark marks every earlier delivery of that conversation and none later | 2 d | | planned |
| M10-05 | Instagram inbound → tickets: identity on the Instagram-scoped id with `@username`; text, attachments, story replies and mentions as text with the media; `is_echo` dropped; `is_deleted` marks the message unsent rather than deleting it; `messaging_seen` onto deliveries | R §4.4; D §4.7, §4.8; ADR 0025 (3, 6) | Integration: the fixtures' events; a deleted message keeps its row and gains the mark | 2 d | | planned |
| M10-06 | Agent replies on all three: `MetaReplyHook` behind `ChannelReplyDeliveryHooks`, `assertCanDeliver` at compose time with `reply-window-closed` (409), `meta.send` with the window checked again, the splitter per platform (4096 chars, 2000 chars, 1000 bytes), attachments as messages of their own (WhatsApp by upload, Messenger and Instagram by URL, Instagram files PDF only), per-recipient pacing, deliveries with `delivered` and `read`, `refused` for a closed window, `failed` with Retry, the ticket's `GET …/meta` and `POST …/meta/deliveries/:id/retry` | A §8, §13; D §2.6, §6; ADR 0025 (7, 8) | Integration: a reply reaches the stand-in once when the job runs twice; a 1000-byte Arabic reply is split at a letter boundary; a reply after 24 h is refused at compose time with `reply-window-closed`, and one queued before the window closed is `refused` by the job; two replies to one WhatsApp user six seconds apart; a permanent refusal fails at once | 4 d | | planned |
| M10-07 | Admin: Channels › Meta — the App card (callback URL, verify token shown once, the settings the secrets live in), the account table per platform with health, Connect account (platform, id, token, department; Test before Connect), an account's page (connection, subscription with Subscribe now, routing, Human Agent switch, activity, Disconnect), `brand:manage` routes under `/api/brands/:brandId/meta/accounts`, the System page's Channels card | R §4.10; ADR 0025 (5, 10) | Integration: connect refuses a token Graph does not know, stores the token encrypted and shows only its hint, audits every change; Playwright in `en` and `ar` with axe (mock api) and against the real api with the stand-in (`apps/admin/e2e/api/`) | 4 d | | built, awaiting review: [notes](#m10-07-admin-api-and-the-channels--meta-screens) |
| M10-08 | Ticket thread: the channel chip ("WhatsApp · +1 555 …", "Messenger · Page", "Instagram · @handle"), "via" and "to" lines, delivery states including Delivered and Read, the ReplyWindowStrip between the thread and the composer with Send disabled when closed, the composer's recipient caption and "sent as N messages" count, the ChannelIdentityCard rows per platform | DESIGN §6.3; D §2.6 | Playwright in `en` and `ar`: an open window, a human-agent window, a closed window with the refusal, a refused delivery with its reason, Retry on a failed one | 2 d | | planned |
| M10-09 | Templates and the Human Agent tag: `meta.templates.sync` per WhatsApp account, the template picker with parameter mapping when a WhatsApp window is closed, `template` sends through `meta.send`, `HUMAN_AGENT` on Messenger and Instagram replies between 24 h and 7 d when the account's switch is on and the author is a person, the delivery's `tag` and `template_name` | ADR 0025 (9); D §2.6 | Integration: a template send after the window; `HUMAN_AGENT` on a person's reply at day 3 and never on an AI or rule reply; Playwright for the picker in `en` and `ar`. **May ship after M10-01 to M10-08 and M10-10** | 4 d | | later |
| M10-10 | Health jobs: `meta.health` hourly per account and its scheduler, token check, `subscribed_apps` check with re-subscribe, Instagram refresh after seven days, `token_expired` and `unsubscribed` on the row, Reconnect on the admin page | ADR 0025 (10) | Integration against the stand-in: a dropped subscription is restored; an Instagram token is refreshed once it is old enough and the expiry moves; a refused refresh marks the account and the page says so | 2 d | | planned |
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

Artboards: `Admin/Channels-Meta` and `Admin/Channels-Meta-Account`. Both halves are built: the
admin screens below, and [the api](#m10-07-the-api) they call.

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

- The App card shows what the install can know and no more. `metaAppSchema` carries the app id (not
  a secret, so it is shown), whether each of the two secrets is set, the Graph version
  (`META_GRAPH_VERSION`), the callback URL, the verify token's last four characters and which settings
  an `HD_META_*` variable has locked; a locked one is an EnvLockedField with the "Set by environment"
  chip, an unlocked one reads "Set" or "Not set". The artboard's "Meta retires it on 29 Jul 2028" is
  left out: it would be a date to keep current in the code. There is no Meta section on Settings, so the
  card names the `HD_META_*` variables instead of "Change it on Settings". Connect is held off in the
  empty state when an install admin sees no app secret or no verify token; for anyone else the api's
  `app-not-configured` says it.
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

### M10-07 The api

`apps/api/src/meta/`, mirroring `apps/api/src/telegram/telegram-bots.*`. Every route is
`@Requires('brand:manage')`, reading included, under `/api/brands/:brandId/meta/accounts`:

| Route | What it does | Answers |
|---|---|---|
| `GET` | the brand's accounts | `{ accounts }`, the token as its last four characters |
| `POST` | connect: read the id and token against Graph, subscribe the app, store | `201` the account |
| `POST test` | "Test" in the dialog: the same read with a typed token, nothing stored | `{ ok: true, … }` or `{ ok: false, kind, detail }` |
| `GET :accountId` | one account | the account |
| `PUT :accountId` | save the form: department, Human Agent, and a new token when Replace was pressed | the account |
| `DELETE :accountId` | unsubscribe the app as far as Meta allows, delete the row | `204` |
| `POST :accountId/test` | "Test connection": the same read with the stored token | the result, a refusal answered rather than thrown |
| `POST :accountId/subscribe` | "Subscribe now" | `{ ok: true, subscribedFields, subscribedAt }` or `{ ok: false, detail }` |
| `GET :accountId/status` | the row, `GET /{id}/subscribed_apps` and `debug_token` now, and the Activity card | `metaAccountStatusResponseSchema`; what Graph could not say is `null` with `liveError` |
| `POST :accountId/refresh` | renew an Instagram token that is due | the account; `400` for another platform |

`GET /api/meta/app` (`install:admin`, M10-02) now also answers `appId`, `appSecretSet`,
`instagramAppSecretSet` and `graphVersion`.

**Connecting** (`MetaAccountsService.create`): the install must have an app secret
(`app-not-configured`); the department must be the brand's (`department-not-found`); the
`(platform, id)` must not be connected anywhere, which is looked up across brands before Graph is asked
anything (`account-taken`, also what "Test" answers). Then one read says what the account is: a
WhatsApp number or a Page is `GET /{id}?fields=…` on Graph with `debug_token` beside it for the
token's expiry, an Instagram account is `GET /me` on the Instagram host, compared with the id typed.
What Graph says maps to a refusal:

| Graph said | Refusal |
|---|---|
| the token is dead (`190` and kin) and is alive on the other host | `platform-mismatch` |
| the token is dead | `token-invalid` |
| the token is good but cannot read this id, or `/me` is another account | `token-other-account` |
| `5xx`, a rate limit, a timeout, a blocked destination, an answer in a shape Helpdock does not know | `graph-unreachable` |
| the app cannot be subscribed to the account, for good | `subscribe-failed` |

"Test" answers the first two and the unreachable case as `{ ok: false, kind: 'token' | 'connect' }`
in Meta's words, and throws the rest, because those are about the id rather than the token. After the
read the app is subscribed with `POST /{id}/subscribed_apps?subscribed_fields=…`, the lists of
`META_SUBSCRIBED_FIELDS`. A refusal for good aborts the connection with nothing stored; a failure for a
moment (a 5xx, a limit) stores the account as `unsubscribed` with the reason in `last_error`, and the
hourly health check or Subscribe now makes it good. The row is stored with the token encrypted under
`APP_MASTER_KEY`, the token's expiry (an Instagram token's is estimated as 60 days from now until the
first renewal says a real one), `token_updated_by`, and the account's name, handle or number.

**Saving** keeps `human_agent_enabled` false on WhatsApp whatever is sent. A new token must open the
same account (`token-other-account` otherwise), brings the account back to `connected`, clears the last
error and subscribes the app again. **Disconnecting** sends `DELETE /{id}/subscribed_apps` and ignores
its failure, so a revoked token does not keep an account the Admin is removing; conversations and
deliveries go with the row, tickets and contacts stay.

**Audit** (`target_type = meta_account`, never a token): `meta_account.created` `{ platform, externalId }`,
`.updated` `{ tokenReplaced, departmentChanged, humanAgentEnabled? }` (the switch only when it changed),
`.deleted` `{ platform, externalId }`, `.subscribed` `{ fields }` and `.refreshed` `{ expiresAt }`. Create,
update and delete also write `meta_account.changed` on the outbox for the health job (M10-10) to follow.

**The token stays where nothing logs it**: `graph-factory.ts`'s `AccountGraph` holds it in a private
field and serialises to its platform; the only calls that carry it as a parameter are
`debug_token` and the Instagram renewal, which are its methods rather than a query a caller builds, and
`redactToken` has been over every `detail` that reaches `last_error` or a response.

`refreshInstagramToken({ db, repository, keyring, graph }, account)` in `meta-token-refresh.ts` returns
`{ outcome: 'refreshed' | 'refused' | 'not-due', expiresAt? }`: a token is due a week after it was
saved or last renewed; renewal stores the answered token encrypted with its expiry and
`token_refreshed_at`; a refusal puts Graph's words on the row and, for a dead token or one past its
expiry, marks the account `token_expired`; a Graph failure for a moment is thrown for a job to retry.
It runs in a transaction of its own for the account's brand, so the route and the worker call it alike.
The route answers `400 token-invalid` for a refusal and `409 graph-unreachable` for the thrown case.

`channel-status.ts` lists the accounts of every brand on the System page, named by number, Page name or
`@handle`, with their health word (or `token expired` / `unsubscribed`) and no token.

**Decisions taken inside the plan**, with the reason where the code makes them:

- **The subscribed fields are `META_SUBSCRIBED_FIELDS`**, which is the brief's lists (WhatsApp
  `messages`; Messenger `messages` through `messaging_postbacks`; Instagram `messages`,
  `message_reactions`, `messaging_seen`, `messaging_postbacks`) plus `messaging_referrals` and
  `messaging_policy_enforcement` (Messenger) and `messaging_referral` (Instagram). The schema is
  unchanged: M10-04 reads policy enforcement into the account's `last_error`, which needs the field,
  and the referrals are the events the envelope classifier already counts and drops.
- **`platform-mismatch` is read from the host the token opens**, not from the shape of the id: Meta
  promises no shape, and the brief's "the id's shape" would refuse a real account the day Meta changed
  one. One extra `GET /me` on the other host, only after a token was refused.
- **`subscribe-failed` refuses the connection** when Meta refuses for good, instead of storing an
  account that can never receive anything; the brief's "best effort" stays for failures that are not
  for good.
- **The business account id is not resolved.** `meta_accounts.waba_id` stays null: the number's node
  does not carry it and the create request has no field for it, so M10-09 resolves it when it first
  syncs templates.

**Unconfirmed against Meta**, for the staging run (open questions above): WhatsApp subscribes an app per
business account on Meta (`POST /{waba-id}/subscribed_apps`); the brief and the stand-in subscribe on the
number's id, and that is what is built. If Meta refuses it, Connect will say `subscribe-failed` for a WhatsApp number and
the fix is the business account id above.

**Tests.** Unit: the Graph reads and every refusal they can cause, the status panel, the account view,
the bound Graph calls, the refresh rule (`meta-accounts.service.test.ts` and its neighbours).
Integration against Postgres, Redis and the stand-in (`meta-accounts.integration.test.ts`): who may,
every refusal over HTTP, the token stored encrypted and read back as its last four characters, the audit
trail and the outbox event of each change, saving, testing, subscribing, renewing, disconnecting,
isolation between brands and the System card. Playwright against the real api
(`apps/admin/e2e/api/meta.api.spec.ts`, with `fake-graph.ts` started beside the install): the app card
and a verify token shown once, a refused token and each platform connected, an account that is taken,
a Page tested, saved, subscribed again and disconnected by its id.

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
| Routes | `GET\|POST /api/meta/webhook` (built, M10-02); `GET /api/meta/app` and `POST /api/meta/app/verify-token` (built, M10-02); `/api/brands/:brandId/meta/accounts` (built, M10-07: list, create, `test`, `:id`, `:id/test`, `:id/subscribe`, `:id/status`, `:id/refresh`); `GET /api/brands/:brandId/tickets/:ticketId/meta`, `POST …/meta/deliveries/:deliveryId/retry` |
| Packages | `@helpdock/channels` exports `GraphClient`, `classifyGraphError`, `verifyHubSignature`, `hubChallenge`, `metaEnvelopeSchema`, `routeEnvelope`, `splitMetaText`, `replyWindow`, the three adapters and, for tests, `FakeGraph`, `MetaWebhookDriver` and the fixtures; `@helpdock/net` gains `policies.graph`; `@helpdock/schemas` exports `meta.ts` |
| Channel kinds | `ticket_channel` gains `whatsapp`, `messenger`, `instagram`; `contact_identity_kind`, `contact_duplicate_reason` and `blocked_sender_kind` gain the same three |

## Pull requests

- none yet
