# Telegram

How a brand answers customers on Telegram (M6-01 to M6-05). A customer writes to the brand's bot, the conversation becomes a ticket, and the agent's replies arrive in the same chat.

Bots are managed on **Admin › Channels › Telegram**, which only an Admin of the brand can open (`brand:manage`). Each section below says what the screen does and which REST route it calls, for anyone automating the same steps.

## Create a bot with BotFather

1. In Telegram, open a chat with [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Give it a display name ("Acme Support") and a username ending in `bot` (`acme_support_bot`).
3. BotFather answers with a **token** such as `7000001:AAE…`. Treat it like a password: anyone who has it can read and send as your bot.
4. Optional: `/setdescription` and `/setuserpic` make the bot look like your brand. Leave privacy mode on; Helpdock only answers private chats.

A brand can have several bots, for example one per language or product. One bot can belong to only one brand on the install.

## Add the bot to Helpdock

On **Channels › Telegram**, press **Add bot**:

1. Paste BotFather's token into **Bot token** and pick the **Department** new conversations go to.
2. Press **Test**. Helpdock asks Telegram who the token belongs to (`getMe`) without storing anything. A token Telegram does not know is refused under the field in Telegram's own words, for example "Telegram refused this token (401: Unauthorized)": copy it again from BotFather. A working token shows "Token works · @acme_support_bot".
3. **Add bot** stays off until Test has succeeded for the token as typed. Pressing it saves the bot under the name Telegram gave it and, in production, sets the webhook straight away (see below). A bot already connected to any brand is refused here.

The list then shows every bot of the brand with the department it routes to, its webhook ("Set · with secret token", "Not set", "Polling", or Telegram's last refusal), when its last update arrived, and its health. **Fix** on a failing bot opens its page.

The routes behind the dialog:

`POST /api/brands/:brandId/telegram/bots/test` with `{ token }` answers `{ ok: true, username, name, telegramId }` or `{ ok: false, kind: 'token' | 'connect', detail }` and writes nothing.

`POST /api/brands/:brandId/telegram/bots`

| Field | Notes |
|---|---|
| `displayName` | What the Channels list calls it. |
| `token` | BotFather's token. Helpdock calls `getMe` with it before saving: a token Telegram does not know is refused (`token-invalid`), and a bot already connected to any brand is refused (`bot-taken`). |
| `departmentId` | Where a new conversation from this bot is filed. A reply stays in its ticket's department. |
| `welcomeEn`, `welcomeAr` | The welcome, per language, sent in the contact's language: after the contact picks one when the bot asks for a language, at once when it does not. Leave one empty for the default text in that language. |
| `languagePrompt` | The question `/start` asks first when `languagePick` is on: one text for both languages, up to 200 characters. Empty or `null` sends the default, "Choose your language · اختر لغتك". |
| `languagePick` | Whether `/start` asks for a language, with **English** / **العربية** buttons, before the welcome. Defaults to on. |

The token is encrypted with `APP_MASTER_KEY` and never returned; a read says only `tokenSet: true`, the bot's username, and the token's last four characters (`tokenHint`) so two tokens can be told apart. To replace it (after `/revoke` in BotFather), open the bot's page, press **Replace** next to the masked token, paste the new one and **Save** (`PUT …/bots/:botId` with `token`). A token for a *different* bot is refused (`token-other-bot`): that is a new bot, so add it as one.

## The bot's page

Open a bot from the list. One form, saved with **Save** at its foot (Discard puts back what is saved):

| Section | What it holds |
|---|---|
| Connection | The token as `•••• 4f2a` with **Replace**, and **Test connection**: `getMe` with the saved token, answered in place ("Connected · 14:36 — getMe returned @acme_support_bot · “Acme Support” · id 7310042215", or Telegram's refusal). Nothing is sent to any chat. |
| Webhook | The address Telegram should post to, with Copy; whether Telegram has it ("Set", "Not set", "Telegram posts to another address" or "Polling"); the pending updates and Telegram's last delivery error from `getWebhookInfo`; and **Set webhook**, which is off on an install that polls. |
| Routing | The department new conversations from this bot open tickets in. |
| Welcome and language | Whether `/start` asks for a language, the **Language prompt** it asks with (one text for both languages, shown as the contact will see it), and the welcome per language. Clear the prompt, or leave the default in it, to send the default; leave a welcome empty to send the default welcome. Changes apply to the next `/start`. |

Beside the form, **Activity** shows when the last update arrived and the last reply was delivered, the replies that failed in the last 24 hours, and the open tickets of the bot's chats, with a link to the failed jobs on the System page. **Delete bot…** is under it (see [Removing a bot](#removing-a-bot)).

Every create, update, delete and "Set webhook" is written to the audit log, without the token.

## Set the webhook

Adding a bot sets its webhook. Press **Set webhook** on the bot's page to set it again (`POST /api/brands/:brandId/telegram/bots/:botId/webhook`).

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
| `POST …/bots/:botId/test` | **Test connection**: `getMe` with the stored token. Answers `{ ok: true, username, name, telegramId }` or `{ ok: false, kind: 'token' \| 'connect', detail }`. Writes nothing. |
| `GET …/bots/:botId/status` | The Webhook section and the Activity card: the bot's state, when the last update arrived, the last error, Telegram's own `getWebhookInfo` (registered URL, pending updates, Telegram's last delivery error), and `activity` (last reply delivered, failed sends in 24 hours, open tickets). |

A bot is **waiting** until its first update arrives, **healthy** after that, and **failing** when the newest thing that happened is an error: a refused token, Telegram unreachable, or an update the pipeline could not file. The list's legend says the same, and the System page lists every bot with the same word.

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

Internal notes never leave Helpdock. Files attached to a reply follow its text, one message each, in the order they were added: an image as a photo (the kept original, else its WebP; over 10 MB it goes as a document), a voice note as its Opus file, anything else as a document. Each file is a part of the delivery like a piece of long text, so a retry never sends one twice. A file still being processed holds the rest back until the next attempt; a file the media pipeline refused, or one over Telegram's 50 MB, is left out.

### In the ticket

A Telegram ticket says who it is with: the header reads "Telegram · @username", each customer message says "via @bot", and the details panel has a **Telegram identity** card under the contact with the chat id (verified by Telegram; Copy puts it on the clipboard), the username and name (which can change), the language and whether the customer chose it with the buttons at `/start`, and the bot. Voice notes play in the thread (the file is fetched when you press play), and a shared location is a line with the coordinates and an **Open map** link to OpenStreetMap; nothing is loaded from a map service until you follow it.

Under each reply: "to the Telegram chat · 14:24 · Sent" once Telegram has it. A reply Telegram refused shows **Not delivered** with Telegram's words and the number of tries, and **Retry**. The composer says "To the Telegram chat @username" and that the bot sends the reply as plain text with no signature.

`GET /api/brands/:brandId/tickets/:ticketId/telegram` (`ticket:read`) is what the ticket view reads: the chat (`bot`, `chatId`, `username`, `name`, `locale`, `languageChosenAt`, or `context: null` for a ticket no chat belongs to) and every reply's delivery. `GET …/telegram/deliveries` lists the deliveries alone: `queued`, `sent` or `failed`, with Telegram's refusal. A reply is retried five times; one Telegram refuses for good (the customer blocked the bot, the chat no longer exists) fails at once. `POST …/deliveries/:deliveryId/retry` (`ticket:write`) puts a failed one back in the queue.

## The satisfaction survey

When a Telegram ticket closes and the brand asks for ratings, the bot sends the survey in the contact's language: "Your request HD-1042 is closed. How was our help? Tap a number: 1 is very bad, 5 is excellent.", five buttons 1 to 5, and **Add a comment**, a link to the rating page (M8-06, `Telegram/Chat-EN` panel 5). It is a `telegram.notice` of kind `csat_survey`, sent by `telegram.send` like the welcome.

A tap records the score at once. The bot then removes the score buttons, keeps **Add a comment**, and thanks the contact with the score and the date the link expires. A second tap, a tap after 30 days, or a tap from a chat that is not the ticket's contact's records nothing and gets "This survey has closed." The answer reaches the ticket's Satisfaction card and fires `csat.received`. See [satisfaction surveys](tickets.md#satisfaction-surveys).

## `/start` and the language pick

When a customer opens the bot, Telegram sends `/start`. Helpdock records the contact and the chat and opens no ticket. What the bot says next depends on **Ask for a language, then send a welcome** (`languagePick`, on by default):

- **On.** The bot first sends the language prompt: one line that names both languages, with two buttons that name each language in its own script, **English** and **العربية**. The welcome waits for the answer. The prompt is "Choose your language · اختر لغتك" unless the bot has its own in **Language prompt**.
- **Off.** The bot sends the welcome at once, in the contact's language: the one they chose before, else the language of their Telegram app if it is English or Arabic, else the brand's default language.

Pressing a button sets the contact's language, which is also the language of their email and survey texts. The bot then rewrites the prompt to "Language: English" (or "اللغة: العربية"), which takes its buttons away so it cannot be pressed twice, and sends the welcome in the language chosen: the bot's own text for that language, or the default if it has none. If Telegram refuses the rewrite, the welcome is still sent.

The prompt is one text for both languages because the contact's language is not known yet. Write your own in **Language prompt** on the bot's page (up to 200 characters, plain text). The field starts with the default; clear it, or leave the default in it, and the bot keeps sending the default, which is built from the two catalogs and follows them. The field is off while the bot does not ask for a language. A change applies to the next `/start`; chats that already picked a language keep it. The default texts are in the `telegram` namespace of `packages/i18n`.

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

On the bot's page press **Delete bot…** (or **Delete** in the row's menu on the list), type `@username` exactly and confirm. Helpdock removes the webhook from Telegram (as far as Telegram lets it: a revoked token or an unreachable Telegram does not stop the delete) and then the bot, its chats and its pending deliveries (`DELETE …/bots/:botId`, audited). Tickets and messages stay, but replies to them can no longer reach Telegram. The bot itself stays in Telegram; delete it there with BotFather.
