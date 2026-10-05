# Telegram

How a brand answers customers on Telegram (M6-01 to M6-05). A customer writes to the brand's bot, the conversation becomes a ticket, and the agent's replies arrive in the same chat.

Bots are managed on **Admin › Channels › Telegram**, which only an Admin of the brand can open (`brand:manage`). The screen is built in a later task; everything below is available through the REST API now, and the screen calls the same routes.

## Create a bot with BotFather

1. In Telegram, open a chat with [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Give it a display name ("Acme Support") and a username ending in `bot` (`acme_support_bot`).
3. BotFather answers with a **token** such as `7000001:AAE…`. Treat it like a password: anyone who has it can read and send as your bot.
4. Optional: `/setdescription` and `/setuserpic` make the bot look like your brand. Leave privacy mode on; Helpdock only answers private chats.

A brand can have several bots, for example one per language or product. One bot can belong to only one brand on the install.

## Add the bot to Helpdock

`POST /api/brands/:brandId/telegram/bots`

| Field | Notes |
|---|---|
| `displayName` | What the Channels list calls it. |
| `token` | BotFather's token. Helpdock calls `getMe` with it before saving: a token Telegram does not know is refused (`token-invalid`), and a bot already connected to any brand is refused (`bot-taken`). |
| `departmentId` | Where a new conversation from this bot is filed. A reply stays in its ticket's department. |
| `welcomeEn`, `welcomeAr` | What the bot answers to `/start`, per language. Leave them empty for the default text. |
| `languagePick` | Whether `/start` also offers **English** / **العربية** buttons. Defaults to on. |

The token is encrypted with `APP_MASTER_KEY` and never returned; a read says only `tokenSet: true` and the bot's username. To replace it (after `/revoke` in BotFather), send the new `token` with `PUT …/bots/:botId`. A token for a *different* bot is refused (`token-other-bot`): that is a new bot, so add it as one.

Every create, update, delete and "Set webhook" is written to the audit log, without the token.

## Set the webhook

`POST /api/brands/:brandId/telegram/bots/:botId/webhook`

This tells Telegram to post the bot's updates to

```
https://<APP_URL>/api/telegram/<botId>/webhook
```

with a secret Helpdock generated for the bot. Telegram sends the secret back in the `X-Telegram-Bot-Api-Secret-Token` header of every update, and Helpdock compares it in constant time. A wrong secret, no secret and an unknown bot id all get the same `401`.

Requirements:

- `APP_URL` must be the public HTTPS address of the install. Telegram only delivers to HTTPS on ports 443, 80, 88 or 8443, so the Caddy setup in `docker/` works as it is.
- Press **Set webhook** again after changing `APP_URL`.

The bot's `webhook.expectedUrl` shows where it should point, and `webhook.url` what was last registered.

## Test and health

| Route | What it does |
|---|---|
| `POST …/bots/:botId/test` | **Test connection**: `getMe` with the stored token. Answers `{ ok: true, username }` or `{ ok: false, kind: 'token' \| 'connect', detail }`. Writes nothing. |
| `GET …/bots/:botId/status` | The health panel: the bot's state, when the last update arrived, the last error, and Telegram's own `getWebhookInfo` (registered URL, pending updates, Telegram's last delivery error). |

A bot is **waiting** until its first update arrives, **healthy** after that, and **failing** when the newest thing that happened is an error: a refused token, Telegram unreachable, or an update the pipeline could not file. The System page lists every bot with the same word.

## What customers can send

| They send | The ticket gets |
|---|---|
| Text | The text, escaped: nothing a customer types is read as markup. |
| A photo | The largest size Telegram offers, through the media pipeline (magic bytes checked, re-encoded to WebP). The caption is the message text. |
| A document | The file, through the media pipeline and the brand's content policy (type, size, ClamAV when enabled). |
| A voice note | The `audio/ogg` file, normalised by ffmpeg like a voice note recorded in the widget. |
| A location or venue | `Location: 52.52, 13.405`, the venue's name and address if any, and an OpenStreetMap link. "Location" is written in the contact's language. |

Files are fetched with the Bot API's `getFile`. Telegram serves files up to 20 MB this way; a larger file is left out of the message and logged. A file the content policy refuses is recorded as rejected, so the agent sees it was sent. Stickers, contacts and polls are ignored, as are group chats and other bots.

## Conversations

- **A chat is a contact.** The chat id is stored as a verified `telegram` identity (DOMAIN-RULES §4.4: it comes from the Bot API), so the same contact is found again on every message. The contact's name is the customer's Telegram name.
- **One open ticket per chat.** A new message continues the chat's ticket. If that ticket is closed, the brand's reopen policy decides, exactly as for email: within the policy's days it reopens, otherwise a new ticket continues it. A ticket marked spam is left as it is. A merged ticket's messages go to the ticket it was merged into.
- **Blocked senders** (Ticketing › Spam, kind `telegram` with the chat id) are dropped before any contact or ticket is written.
- **Redelivery is harmless.** Every message is keyed by bot, chat and message id, so a webhook Telegram retries, or a poll that sees an update again, files nothing twice.

## Agent replies

A public reply on a Telegram ticket is queued in the same transaction as the reply and sent by the worker's `telegram.send` job (DOMAIN-RULES §6). It goes to the chat the ticket belongs to through the bot that chat was with. Replies longer than 4096 characters are sent in several messages, cut at paragraphs; a retry continues after the last part that arrived.

Internal notes never leave Helpdock. Attachments on an agent's reply are not sent to Telegram in this version: send the text, and share files as links.

`GET /api/brands/:brandId/tickets/:ticketId/telegram/deliveries` (`ticket:read`) lists each reply's delivery: `queued`, `sent` or `failed`, with Telegram's refusal. A reply is retried five times; one Telegram refuses for good (the customer blocked the bot, the chat no longer exists) fails at once. `POST …/deliveries/:deliveryId/retry` (`ticket:write`) puts a failed one back in the queue.

## The satisfaction survey

When a Telegram ticket closes and the brand asks for ratings, the bot sends the survey in the contact's language: "Your request HD-1042 is closed. How was our help? Tap a number: 1 is very bad, 5 is excellent.", five buttons 1 to 5, and **Add a comment**, a link to the rating page (M8-06, `Telegram/Chat-EN` panel 5). It is a `telegram.notice` of kind `csat_survey`, sent by `telegram.send` like the welcome.

A tap records the score at once. The bot then removes the score buttons, keeps **Add a comment**, and thanks the contact with the score and the date the link expires. A second tap, a tap after 30 days, or a tap from a chat that is not the ticket's contact's records nothing and gets "This survey has closed." The answer reaches the ticket's Satisfaction card and fires `csat.received`. See [satisfaction surveys](tickets.md#satisfaction-surveys).

## `/start` and the language pick

When a customer opens the bot, Telegram sends `/start`. Helpdock records the contact and the chat, opens no ticket, and the bot answers with the welcome in the contact's language — the one they chose before, else the language of their Telegram app if it is English or Arabic, else the brand's default language. With `languagePick` on, the welcome ends with "Which language should we answer in?" and two buttons.

Pressing a button sets the contact's language, which is also the language of their email and survey texts, and the bot confirms in that language. The default texts are in the `telegram` namespace of `packages/i18n`.

## Development: long polling

Telegram cannot reach a laptop. Set

```
TELEGRAM_POLLING=true
```

in `.env` and the worker polls every bot every three seconds with `getUpdates` instead. Updates go through the same pipeline as the webhook. Telegram refuses `getUpdates` while a webhook is set; the refusal shows as the bot's last error. Clear a webhook with BotFather's bot settings, or call `deleteWebhook` once:

```
curl https://api.telegram.org/bot<token>/deleteWebhook
```

Leave `TELEGRAM_POLLING` off in production. `TELEGRAM_API_ROOT` points Helpdock at a self-hosted Bot API server; the default is `https://api.telegram.org`.

## Removing a bot

`DELETE …/bots/:botId` removes the bot, its chats and its pending deliveries. Tickets and messages stay. The webhook stays registered with Telegram, which then gets `401`s; delete the bot in BotFather or point the webhook elsewhere.
