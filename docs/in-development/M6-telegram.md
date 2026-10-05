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
| M6-02 | Identity | | built, in review |
| M6-03 | Media | | built, in review |
| M6-04 | `/start` welcome and language pick | | built, in review |
| M6-05 | Admin | | API built, in review; the `Admin/Channels-Telegram` screen is a separate task |

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

## Migrations

- `0036_telegram`: `telegram_bots` and `telegram_chats` (brand), `telegram_deliveries`
  (department, moved with its ticket by a trigger of its own), the
  `telegram_delivery_status` enum. All three are in `TENANT_TABLES` and the RLS negative
  suite.

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

## Interfaces for other milestones

| Kind | Name |
|---|---|
| Outbox events | `telegram.reply` `{ deliveryId }`, `telegram.notice` `{ botId, chatId, notice, locale, callbackQueryId? }`, `telegram_bot.changed` `{ botId }` |
| Jobs | `telegram.send` (`outbound`, payload `kind: 'reply' \| 'notice'`), `telegram.poll` (`inbound`, development) |
| Config | `TELEGRAM_POLLING`, `TELEGRAM_API_ROOT` |
| i18n | namespace `telegram` (`bot.welcome`, `bot.languagePrompt`, `bot.languageSet`, `thread.location`) |
| Permissions | none new: `brand:manage` for bots, `ticket:read` / `ticket:write` for deliveries |

## Gaps and follow-ups

| Gap | Why it was accepted | Where it is written down |
|---|---|---|
| Attachments on an agent's reply are not sent to Telegram | The reply's files may still be processing when the send runs; sending them needs `sendPhoto` / `sendDocument` from the bucket and a per-part retry. The text is delivered. | [Telegram guide](../guides/telegram.md#agent-replies) |
| No admin screen yet | M6-05's screen is built from the `Admin/Channels-Telegram` artboard in a separate task; the thread's delivery status needs the same. | This doc |
| Files over 20 MB are dropped | The Bot API's `getFile` serves 20 MB at most; a local Bot API server would lift it. | [Telegram guide](../guides/telegram.md#what-customers-can-send) |
| No test against the real Bot API | CI uses a local stand-in. The PRD's external dependency on a staging bot token stays `needed`. | [PRD, external dependencies](../planning/PRD.md#external-dependencies) |
| Deleting a bot deletes its deliveries | They cascade with the bot; the replies themselves stay on the ticket. | [Telegram guide](../guides/telegram.md#removing-a-bot) |

## Open questions

- None yet.

## Pull requests

- None yet.
