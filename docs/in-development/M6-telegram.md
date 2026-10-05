# M6 Telegram

Status: in progress
Started: 2026-10-05
Owner: @Docker-Hunterpedia

## Scope

Full deliverable list and specs: [PRD §4 · M6 Telegram](../planning/PRD.md#m6-telegram).
Depends on M2 and M1, both shipped.

Operator guide: [Telegram](../guides/telegram.md).

## Deliverables

| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M6-01 | grammY adapter | | built, in review |
| M6-02 | Identity | | built, in review; the ticket view's Telegram half (`Admin/Ticket-Telegram`) built |
| M6-03 | Media | | built, in review; agent-reply attachments sent |
| M6-04 | `/start` welcome and language pick | | built, in review |
| M6-05 | Admin | | built, in review: API and the `Admin/Channels-Telegram` screen |

## Exit criteria

Copied from the PRD, ticked as they are met.

- [x] **A Telegram message creates a ticket and the agent reply arrives in the chat, tested against a mocked Bot API.**
      `apps/api/src/telegram/telegram.integration.test.ts` › "a conversation (M6-02)" ›
      "files a message as a ticket and delivers the agent’s reply to the chat (M6 exit
      criterion)". A local HTTP server (`apps/api/src/testing/fake-telegram.ts`) stands in for
      api.telegram.org; the update arrives through the real webhook route with the secret
      "Set webhook" registered, the agent replies through the tickets API, the outbox row is
      handed to the `telegram.send` job, and the stand-in receives `sendMessage` to that chat —
      once, when the job runs a second time.
      The same suite's "sends a reply’s attachments after its text, each once, and waits for
      one still processing" covers the reply's files (`sendPhoto`, `sendDocument`), and the
      admin browser suites drive the screens: `apps/admin/e2e/telegram.spec.ts` (mock api,
      `en` and `ar`, with axe) and `apps/admin/e2e/api/telegram.api.spec.ts` (real api, a
      local stand-in for Telegram).

## Migrations

- `0036_telegram`: `telegram_bots` and `telegram_chats` (brand), `telegram_deliveries`
  (department, moved with its ticket by a trigger of its own), the
  `telegram_delivery_status` enum. All three are in `TENANT_TABLES` and the RLS negative
  suite.
- `0040_telegram_chat_identity`: `telegram_chats.username` (the customer's `@username` as
  of their last message) and `telegram_chats.language_chosen_at` (set when they press a
  language button), for the ticket view's identity card. No new table.

## M6-01 grammY adapter

- `packages/channels/src/telegram/`: `TelegramBotApi` over grammY's `Api` (`getMe`,
  `setWebhook`, `getWebhookInfo`, `getUpdates`, `sendMessage`, `answerCallbackQuery`,
  `getFile` plus a capped download), `classifyUpdate` (a Zod schema of the update subset
  Helpdock reads), `TelegramChannelAdapter` / `toTelegramInboundMessage`, and the text
  helpers (`splitTelegramText`, `locationText`, `languageKeyboard`).
- The Bot API host is fixed; `TELEGRAM_API_ROOT` (default `https://api.telegram.org`) exists
  for a self-hosted Bot API server and the tests. It is operator configuration, never input,
  so the calls do not go through the SSRF-safe client.
- **Webhook:** `POST /api/telegram/:botId/webhook`, `@Public()`, rate-limited per IP. The
  bot is found by an install-scope read of `telegram_bots` (`TelegramRepository.locate`), and
  `X-Telegram-Bot-Api-Secret-Token` is compared with the bot's encrypted secret through
  SHA-256 digests and `timingSafeEqual`. Unknown bot, missing and wrong secret: the same 401.
  A body that is not an update: 400. Anything filed, dropped or duplicate: 200.
- **Polling (development):** `TELEGRAM_POLLING=true` makes the worker schedule a
  `telegram.poll` job per bot every 3 s on the `inbound` queue, re-registered on boot and on
  `telegram_bot.changed`. The offset is stored on the bot row and moved past each update after
  it is filed.
- The webhook is processed in the request, as inbound parse is (M2-03): the media download
  happens before the transaction, the database work in one system transaction per update.
- `withAllBrands` moved from `MailboxesRepository` to `apps/api/src/tenant/all-brands.ts`, so
  the mailbox and bot install-scope reads share one helper.

## M6-02 Identity and replies

- The chat id is a `telegram` contact identity from source `telegram.bot` (verified,
  DOMAIN-RULES §4.4). `telegram_chats` maps bot + chat to the contact and to the ticket the
  chat continues.
- `TelegramConversationRouter`: the chat's ticket (following merges) gets the message as a
  customer reply through `TicketLifecycleService.onCustomerReply` — the same call email and
  the widget make, so the reopen policy applies unchanged; no ticket, or a deleted one, means
  a new `telegram` ticket in the bot's department, with SLA clocks, `ticket.created` and
  auto-assignment as for any channel. The landing ticket becomes the chat's.
- Inbound dedupe key: `<bot telegram id>:<chat id>:<message id>` in
  `ticket_messages.external_message_id`. The sender gate (`isSenderBlocked`, kind `telegram`)
  runs before any contact is written.
- Replies: `TelegramReplyHook` joins `EmailReplyHook` behind `ChannelReplyDeliveryHooks` in
  `TicketsModule`. A public reply on a `telegram` ticket writes a `telegram_deliveries` row
  and a `telegram.reply` outbox row in the reply's transaction. The worker's handler adds a
  `telegram.send` job (`jobId = telegram.send.<outbox id>`, receipt
  `telegram.send:<delivery id>`). Long replies are split at 4096 characters; each part sent is
  recorded at once (`parts_sent`), so a retry resumes after it.
- Failures are recorded on the delivery (`attempts`, `last_error`, `failed`) outside the job's
  transaction, as `email.send` records them. A permanent refusal (Telegram 400/403: blocked,
  chat gone) fails the job at once instead of five times.
- `GET /api/brands/:brandId/tickets/:ticketId/telegram/deliveries` (`ticket:read`) and
  `POST …/deliveries/:deliveryId/retry` (`ticket:write`).

## M6-03 Media

Photos (largest size), documents, voice notes, audio and video are fetched with `getFile`
and handed to M2's `StorageAttachmentSink`: content policy first, then the object, a `pending`
row and `attachment.uploaded`, so `media.process` sniffs, re-encodes images and normalises
voice with ffmpeg as for any upload. Files over the Bot API's 20 MB limit, or that Telegram
refuses to serve, are left out and logged; Telegram being unreachable fails the update so it
is redelivered. Locations and venues are filed as `Location: lat, long` (label in the
contact's language, `telegram:thread.location`) with an OpenStreetMap link.

## M6-04 `/start` and the language pick

`/start` records the contact and chat, opens no ticket, and writes a `telegram.notice`
outbox row; the job sends the bot's own welcome for the language (or
`telegram:bot.welcome`), followed by the prompt and English / العربية buttons when
`language_pick` is on. The welcome's language is the contact's, else the Telegram app's
`language_code` when it is `en` or `ar`, else the brand default. A button press
(`callback_data` `lang:en` / `lang:ar`) sets `contacts.locale`, and the job answers the
callback query and confirms in the chosen language.

## M6-03 Agent-reply attachments

`telegram.send` sends each file of an agent's reply after its text, in the order the agent
added them (`telegram-attachments.ts`): an image with `sendPhoto` (the kept original, else
the WebP; past 10 MB with `sendDocument`), a voice note's Opus and any other file's
original with `sendDocument`, read from the bucket through a temporary file. Every
attachment is a part of the delivery, as a piece of split text is, so `parts_sent` resumes a
retry after the last file Telegram accepted; a file left out still counts as a part, so
indices never move between attempts. A file the pipeline is still processing fails the
attempt (`AttachmentNotReadyError`, recorded on the delivery) and BullMQ tries again; a
refused file, or one past Telegram's 50 MB, is left out and logged. The worker hands the job
its bucket (`storage`).

## M6-05 Admin (API half)

Under `/api/brands/:brandId/telegram/bots`, all `brand:manage`: list, create (token checked
with `getMe`; refusals `token-invalid`, `telegram-unreachable`, `bot-taken`,
`department-not-found`), get, `PUT` (token optional; `token-other-bot`), delete, `POST
:botId/test`, `POST :botId/webhook` (registers `APP_URL/api/telegram/:botId/webhook` with the
secret and `allowed_updates: [message, callback_query]`), `GET :botId/status` (row health plus
`getWebhookInfo`). Zod schemas in `packages/schemas/src/telegram.ts`; refusals reach the client
as `error.telegram.reason`. Token and webhook secret are encrypted with AES-256-GCM under
`APP_MASTER_KEY` and never returned. Every change is audited (`telegram_bot.*`).

The System page's Channels card now lists every mailbox and bot of every brand
(`apps/api/src/channels/channel-status.ts`), closing the M2 gap.

Added with the screen:

- `POST …/telegram/bots/test` `{ token }`: "Test" in the Add bot dialog, `getMe` with a
  token that is not stored yet. Never repeats the token.
- `TelegramBot.tokenHint`: the token's last four characters (decrypted on read, never
  stored in the clear), for `•••• 4f2a`. `TelegramTestResult` carries the bot's `name`.
- `GET …/bots/:botId/status` carries `activity` (last reply delivered, failed sends in 24 h,
  open tickets of the bot's chats) for the Activity card.
- Deleting a bot calls `deleteWebhook` first, best effort.
- `GET /api/brands/:brandId/tickets/:ticketId/telegram` (`ticket:read`): the chat a ticket
  is with (bot, chat id, username, name, language and whether it was chosen) and the
  replies' deliveries, in one read.

## M6-05 Admin screen

Built from `Admin/Channels-Telegram` (`docs/design/screens/m6/Admin-Channels-Telegram.png`)
under `apps/admin/src/screens/admin/channels/telegram/`, with the adapter pair in
`apps/admin/src/telegram/` (`HttpTelegramApi`, `MockTelegramApi`, behind
`TelegramApiProvider`):

- **Channels › Telegram** tab (`/admin/channels/telegram`, Admin only): the bot table
  (bot, routes to, webhook, last update, health with Fix), "How updates arrive" and the
  health legend, and the empty state. **Add bot** in the page header opens the dialog:
  token and department, **Test** first (Add stays off until it passes for the token as
  typed), Telegram's refusal under the field, and in production the webhook is set right
  after the bot is added.
- **A bot's page** (`/admin/channels/telegram/:botId`): Connection (masked token,
  Replace, Test connection), Webhook (address with Copy, state, pending updates, last
  error, Set webhook, the polling note), Routing, Welcome and language, saved together;
  the Activity card and the Delete card beside it.
- **Delete** asks for `@username` typed exactly before the button turns on.
- Strings in `channels:telegram.*` (`en`, `ar`).

## M6-02, M6-03 The Telegram ticket

Built from `Admin/Ticket-Telegram` with DESIGN §6.3's VoiceNote, LocationLine and
ChannelIdentityCard (`apps/admin/src/screens/tickets/telegram/`), behind
`useTicketTelegram`, which reads the ticket's chat only for a `telegram` ticket:

- The header's channel chip reads "Telegram · @username".
- Customer messages say "via @bot"; replies say "to the Telegram chat" and, once Telegram
  has them, "Sent". A refused reply has the danger strip with Telegram's words, the tries
  and **Retry**.
- An audio attachment is a VoiceNote; its five-minute URL is asked for on the first press
  (`AttachmentUploader.downloadUrl`). The admin CSP allows `media-src` from the bucket's
  origin (`storageOrigin`) for it. No transcript is drawn: attachments carry none until
  M7-09.
- A location paragraph is lifted out of the body into a LocationLine with an "Open map"
  link; nothing loads from a map service until it is followed.
- The composer says which chat a reply goes to and that the bot sends plain text with no
  signature.
- The details panel shows the ChannelIdentityCard under the contact.
- Strings in `tickets:telegram.*` (`en`, `ar`).

## Interfaces for other milestones

| Kind | Name |
|---|---|
| Outbox events | `telegram.reply` `{ deliveryId }`, `telegram.notice` `{ botId, chatId, notice, locale, callbackQueryId? }`, `telegram_bot.changed` `{ botId }` |
| Jobs | `telegram.send` (`outbound`, payload `kind: 'reply' \| 'notice'`), `telegram.poll` (`inbound`, development) |
| Config | `TELEGRAM_POLLING`, `TELEGRAM_API_ROOT` |
| i18n | namespace `telegram` (`bot.welcome`, `bot.languagePrompt`, `bot.languageSet`, `thread.location`) |
| Permissions | none new: `brand:manage` for bots, `ticket:read` / `ticket:write` for deliveries and the ticket's chat |
| Routes added with the screen | `POST …/telegram/bots/test`, `GET …/tickets/:ticketId/telegram` |

## Gaps and follow-ups

| Gap | Why it was accepted | Where it is written down |
|---|---|---|
| The language prompt is the catalog's, not a per-bot field | The artboard draws an editable "Language prompt" sent before the welcome; M6-04 sends the catalog's question under the welcome in the contact's language. The screen shows that text read-only in both languages. Making it editable needs a column and a change to the `/start` flow. | This doc |
| No "Behind" health for a bot | Mailboxes have four states; a bot has `healthy`, `failing` and `waiting`. Telegram's pending-update count shows on the bot's page, not as a state on the list. | This doc |
| A file still processing holds a reply's later files back | The text and earlier files are sent; the rest go on BullMQ's next attempt (five, backing off from 10 s). A video that takes longer than that ends `failed`, and Retry sends what is left. | [Telegram guide](../guides/telegram.md#agent-replies) |
| Voice notes play only in a Telegram thread | VoiceNote replaces the chip for audio on a Telegram ticket; a widget voice note is still a chip. | This doc |
| Files over 20 MB are dropped | The Bot API's `getFile` serves 20 MB at most; a local Bot API server would lift it. | [Telegram guide](../guides/telegram.md#what-customers-can-send) |
| No test against the real Bot API | CI uses a local stand-in. The PRD's external dependency on a staging bot token stays `needed`. | [PRD, external dependencies](../planning/PRD.md#external-dependencies) |
| Deleting a bot deletes its deliveries | They cascade with the bot; the replies themselves stay on the ticket. | [Telegram guide](../guides/telegram.md#removing-a-bot) |
| Two GreenMail suites failed under load with an IMAP auth refusal | GreenMail creates its users only after every server starts within 2 s; on a busy host one misses it, the users are never created and every login is refused. Fixed in the suites (`greenmail.startup.timeout`, and waiting for the line GreenMail logs after the users exist); not a product bug. | `channels.integration.test.ts`, `imap-client.integration.test.ts` |

## Open questions

- None yet.

## Pull requests

- None yet.
