# M2 Email channel

Status: in progress
Started: 2026-09-27
Owner: @Docker-Hunterpedia

## Scope

[PRD, M2 Email channel](../planning/PRD.md#m2-email-channel). Depends on M1; runs in parallel with M3.

## Deliverables

| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M2-01 | `ChannelAdapter` interface and `ConversationRouter` | #80 | done — `packages/channels/src/adapter.ts`, `EmailChannelAdapter`, `apps/api/src/channels/inbound/conversation-router.ts` |
| M2-02 | Inbound IMAP polling | #81 | done — `email.poll` job scheduler per mailbox (`apps/api/src/channels/email-poll.job.ts`), imapflow + mailparser, dedupe by `Message-ID`, attachments into the M1-10 pipeline |
| M2-03 | Inbound parse webhooks | #82 | done — `POST /internal/inbound-parse/{postmark,sendgrid,mailgun,resend,generic}` with a per-brand shared secret; Resend only with the body included (see gaps) |
| M2-04 | Threading and the participant check | #83 | done — DOMAIN-RULES §4.3 in the router, quoted-reply stripping, inline images, automated senders dropped unless allow-listed |
| M2-05 | Outbound SMTP through the outbox | #84 | not started |
| M2-06 | Auto-responders and loop protection | #85 | not started |
| M2-07 | Email security: sanitised HTML and remote images | #86 | done — allowlist sanitiser on every body, remote images removed from `body_html` and served only through the SSRF-safe, re-encoding proxy; optional SPF/DKIM-failure-as-spam per mailbox |
| M2-08 | Admin: mailboxes, inbound parse and email health | #87 | inbound half done — Channels page shell, Mailboxes tab, mailbox form with Test IMAP, health; the Outgoing email tab is M2-05's |

## Artboards

On the [design canvas](https://claude.ai/artifact/RQd32d1RXK8DST8SKC1VBQ), under "M2 Email channel": `AdminEmail` (Channels › Mailboxes), `AdminEmailMailbox` (mailbox form), `AdminTicketEmail` (email card and threading-mismatch line), `AdminEmailOutgoing`, `AdminSignature`, `EmailCustomer`.

## How the inbound half works

- **Data.** `mailboxes` (tenant, address unique across the install, IMAP password encrypted under `APP_MASTER_KEY`), `inbound_parse_settings` (tenant, one row per brand: the encrypted shared secret and the last request), and `ticket_messages.email` (jsonb: header strip, quoted text, remote images, inline attachment ids, SPF/DKIM result, threading mismatch). Migration `0024_email_inbound`. Both tables are in `TENANT_TABLES` and the negative suite.
- **One pipeline.** IMAP and every provider produce an `InboundEnvelope`; `toEmailInboundMessage` turns it into the channel-neutral `InboundMessage`; `InboundEmailService` dedupes, drops automated and blocked senders, and hands the rest to the `ConversationRouter` in one system transaction for the brand.
- **Threading.** A `Message-ID` in `In-Reply-To`/`References` that matches any `ticket_messages.external_message_id` of the brand, or the brand's `[PREFIX-N]`, names a candidate (a merged ticket stands for its primary). The sender must be the contact (any email identity), a CC recorded under that address, or a staff member who is the assignee or wrote on the ticket; otherwise a new ticket is filed in the candidate's department with the system note "Referenced HD-1042 but sender is not a participant".
- **Events.** Written: `ticket.created`, `ticket.replied`, `ticket.spam` (via the lifecycle), `assignment.requested`, `attachment.uploaded`, the CC participants service's own, and `mailbox.changed` (consumed in the worker to upsert or remove the mailbox's `email.poll` job scheduler).
- **Security.** Inbound-parse requests answer the same 401 for an unknown recipient and a wrong secret. IMAP hosts and remote images are resolved through `@helpdock/net` (`resolvePublicHost`, `safeFetch`), so neither reaches the install's own network unless `OUTBOUND_ALLOW_CIDRS` allows it. Proxied images are re-encoded to WebP by sharp.

## Seams for the rest of M2

- **Outbound `Message-ID`s.** Threading matches `ticket_messages.external_message_id` without angle brackets. M2-05 should store the `Message-ID` of every message it sends there (bare, `id@host`), so a customer's reply to an agent's email threads by header and not only by subject token.
- **Staff participants** are read from `users.email`; an agent replying from a personal address threads only if that address is their account's.
- **Channels page.** `apps/admin/src/screens/admin/channels/tabs.ts` already lists the `outgoing` tab (drawn as "not built yet"); M2-05 replaces that case in `channels-page.tsx`. The `channels` i18n namespace and `ChannelsApi` are shared.

## Gaps accepted

- **Resend's metadata-only webhook** is refused with 422: fetching the body needs a Resend API key and the Receiving API, which this build does not hold. A relay that includes `html`/`text`, or the generic endpoint, works.
- **"Allowed senders in Ticketing › Spam are never marked"** (the mailbox form's SPF note) needs the Spam tab's allow-list, which does not exist yet; the heuristic applies to every sender.
- **Remote images are drawn below the body**, not where they stood in it, because the stored body contains no remote URL at all.

## Exit criteria

- [ ] Email to a mailbox creates a ticket; agent reply arrives in the customer's inbox; customer reply threads onto the same ticket. Verified with Mailpit in CI. *(Inbound half: GreenMail in `apps/api/src/channels/channels.integration.test.ts`.)*
- [x] A reply quoting a valid ticket number from a non-participant address creates a separate ticket and never attaches to the original. (`channels.integration.test.ts`)
- [ ] Delivering the same outbox job twice sends one email.
- [ ] Sending fails gracefully into the DLQ, visible in admin.

## Open questions

- None yet.

## Pull requests

- None yet.
