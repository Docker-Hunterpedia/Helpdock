# 0016 File Telegram updates in the webhook request, and poll only in development

Status: accepted
Date: 2026-10-05

## Context

M6-01 receives Telegram updates by webhook in production and by long polling in development ([REQUIREMENTS §4.4](../planning/REQUIREMENTS.md#44-channels)). [ARCHITECTURE §13](../planning/ARCHITECTURE.md#13-background-jobs-bullmq-queues) listed a `telegram.update` job on the `inbound` queue, which suggests the webhook would only enqueue the update and a worker would file it.

AGENTS.md forbids enqueueing from a request handler: a job is asked for through the transactional outbox, in the same transaction as the change that causes it. An update that is merely received has no change to commit with it, so "enqueue the update" would mean writing the raw update into the outbox as its own row, then filing it from a worker job.

M2-03's inbound-parse endpoints faced the same choice and file each message in the request: parse, check the secret, run the pipeline in one system transaction, answer.

## Decision

1. The webhook files the update in the request, through `TelegramInboundService`, as inbound parse does. Files are fetched with `getFile` before the transaction opens; the dedupe check, the sender gate, the contact, the ticket and every outbox row the update causes are one system transaction for the bot's brand.
2. Everything the update causes *outside* the database — the `/start` welcome, the language confirmation, and later the agent's reply — is an outbox row and a `telegram.send` job. The request never calls Telegram.
3. Development polling is a `telegram.poll` job per bot on the `inbound` queue, scheduled only when `TELEGRAM_POLLING=true`, and hands each update to the same service. There is no `telegram.update` job.

## Consequences

- One pipeline, used by both transports, with the dedupe key `<bot>:<chat>:<message>` making Telegram's redeliveries and a re-polled update harmless.
- Telegram waits for the request to finish, including the file download. Telegram allows up to 60 seconds and the download is capped at the Bot API's 20 MB, so this stays well inside it. A failure (Telegram's file server unreachable, the database down) answers 500 and Telegram redelivers.
- If filing ever has to be decoupled from the request — a very busy bot, slow storage — the update can be written to the outbox as its own row and filed by a `telegram.update` job without changing the service; this ADR would then be superseded.

## Alternatives considered

- **Outbox row per raw update, filed by a worker job.** Rejected for now: a second copy of every update in the outbox, a second place to dedupe, and nothing gained while one request comfortably files one message.
- **grammY's `Bot` with `webhookCallback` and `bot.start()`.** Rejected: its middleware model would own the routing, and the polling loop would run inside a process rather than as a job the worker schedules, restarts and reports on like `email.poll`. Helpdock uses grammY's typed `Api` client and validates updates with its own Zod schema.
