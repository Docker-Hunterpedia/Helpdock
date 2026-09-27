# M2 Email channel

Status: shipped
Started: 2026-09-27
Shipped: 2026-09-27
Owner: @Docker-Hunterpedia

## Scope

Customers reach a brand by email and agents answer them from the ticket. Mail
arrives by IMAP polling or by inbound-parse webhooks. It is routed onto a
ticket only when the sender is a participant, sanitised, and stored with its
remote images blocked or proxied. Agents' public replies leave through the
outbox as SMTP mail with a deterministic `Message-ID`, the department's sender
and the agent's signature. Acknowledgment and out-of-hours auto-replies are
protected against mail loops. Admins manage mailboxes, inbound parse, outgoing
mail and failed sends on the Channels page.

Full deliverable list and specs: [PRD §4 · M2 Email channel](../planning/PRD.md#m2-email-channel).
Depends on M1 (shipped 2026-09-25). Ran in parallel with
[M3](M3-automation-and-slas.md), which supplies the business hours the
out-of-hours reply reads and the SLA clocks that emailed tickets start.

Built from the design canvas artboards, under "M2 Email channel": `AdminEmail`
(Channels › Mailboxes), `AdminEmailMailbox` (the mailbox form),
`AdminEmailOutgoing` (Channels › Outgoing email), `AdminTicketEmail` (the email
card, the threading-mismatch line, the composer's email mode),
`AdminSignature` and `EmailCustomer`.

## Deliverables

| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M2-01 | `ChannelAdapter` interface and `ConversationRouter` | #80 | shipped (#99) |
| M2-02 | Inbound IMAP polling | #81 | shipped (#99) |
| M2-03 | Inbound parse webhooks | #82 | shipped (#99) |
| M2-04 | Threading and the participant check | #83 | shipped (#99) |
| M2-05 | Outbound SMTP through the outbox | #84 | shipped (#97) |
| M2-06 | Auto-responders and loop protection | #85 | shipped (#97) |
| M2-07 | Email security: sanitised HTML and remote images | #86 | shipped (#99) |
| M2-08 | Admin: mailboxes, inbound parse and email health | #87 | shipped (#97 outbound half, #99 inbound half) |

## Exit criteria

Copied from the PRD. All four are met. The integration suites run against
real Postgres and Redis (Testcontainers), with Mailpit as the SMTP server and
GreenMail as the IMAP server. The last full runs are the ones reported in #102
and #103.

- [x] **Email to a mailbox creates a ticket; agent reply arrives in the
      customer's inbox; customer reply threads onto the same ticket. Verified
      with Mailpit in CI.**
      `apps/api/src/channels/email-roundtrip.integration.test.ts` › "inbound and
      outbound email together" › "threads the customer’s reply to the agent’s
      email onto the same ticket (M2 exit criterion 1)". The agent's reply is
      read back from Mailpit with our `Message-ID` and `In-Reply-To`. The
      customer's answer carries no ticket number, so only the headers thread
      it. IMAP delivery itself is `channels.integration.test.ts` › "IMAP
      polling (M2-02)" › "polls new mail into tickets and records the mailbox
      healthy", against GreenMail.
- [x] **A reply quoting a valid ticket number from a non-participant address
      creates a separate ticket and never attaches to the original.**
      `apps/api/src/channels/channels.integration.test.ts` › "the inbound email
      channel" › "inbound parse (M2-03)" › "threads a participant’s reply, and
      gives a stranger quoting the number a ticket of their own (§4.3)". The
      round-trip test above ends with the same check for a stranger who holds
      our `Message-ID`.
- [x] **Delivering the same outbox job twice sends one email.**
      `apps/api/src/email/email.integration.test.ts` › "outbound email" ›
      "delivers a reply to the contact with the CC, once, however often the job
      arrives", against Mailpit.
- [x] **Sending fails gracefully into the DLQ, visible in admin.** The same
      suite › "dead-letters a send the relay keeps refusing, shows it, and puts
      it back on retry". In the browser, in `en` and `ar`:
      `apps/admin/e2e/email.spec.ts` › "Channels › Outgoing email" › "retries
      and discards failed sends until none is left", and › "the ticket view by
      email" › "shows From, To and the signature, and retries a reply that was
      not delivered".

## Effort

| | |
|---|---|
| Estimated | 3–4 weeks (PRD status board) |
| Started | 2026-09-27 |
| Shipped | 2026-09-27 |
| Actual | 1 day, in parallel with M3 |

AI coding agents built the outbound and inbound halves in parallel worktrees,
and the maintainer reviewed and merged them. The halves meet in the places
described under [How the two halves meet](#how-the-two-halves-meet).

## Migrations

- `0024_email_outbound`: `email_outbound_settings` (brand), `email_deliveries`
  (department, moved with its ticket), `users.signature_en` and `signature_ar`.
- `0025_email_inbound`: `mailboxes` and `inbound_parse_settings` (brand),
  `ticket_messages.email`, three enums.

All four tables are in `TENANT_TABLES` and the RLS negative suite.

## Gaps and follow-ups

Written down and carried forward. None of them blocks M4, M5, M6 or M8.

| Gap | Why it was accepted | Where it is written down |
|---|---|---|
| **Resend's metadata-only webhook is refused with 422** | Fetching the body needs a Resend API key and its Receiving API. A relay that includes `html` or `text`, or the generic endpoint, works. | [email guide](../guides/email.md#inbound-parse-webhooks) |
| **The SPF/DKIM spam rule has no sender allow-list** | The mailbox form's note promises that senders allowed in Ticketing › Spam are never marked, but the Spam tab has no allow-list yet, so the rule applies to every sender. | This doc |
| **Proxied remote images are drawn below the body**, not where they stood | The stored body holds no remote URL at all, which is the point of blocking them. | This doc |
| **Sign-in links, password resets and invitations are still only logged** | M2 built SMTP for ticket mail and M3-07 reuses the install's sender for notifications, but auth's `EmailSender` is still `LoggingEmailSender`: nothing passes a real one to `createApiApp`. | [authentication](../guides/authentication.md#sending) |
| **The System page's Channels card is empty** | Mailbox health is on Channels › Mailboxes. `system.service.ts` still returns `channels: []`. | [operations](../guides/operations.md#the-system-page) |
| **The block list's "own address" check ignores mailboxes and department senders** | It reads `smtp.from` and `brand_domains` only, so an admin can block a brand's own mailbox address. | [ticketing settings](../guides/ticketing-settings.md#spam) |
| **No test against a real SMTP provider and IMAP mailbox** | CI uses Mailpit and GreenMail. The external dependency in the PRD stays `needed`. | [PRD, external dependencies](../planning/PRD.md#external-dependencies) |
| **Two admin clients serve one Channels page** | `ChannelsApi` (Mailboxes, the email card) and `EmailApi` (Outgoing email, the signature, the composer) came from the two halves. They share one `channels` i18n namespace; merging them is a tidy-up. | [How the two halves meet](#how-the-two-halves-meet) |
| **No screenshot baselines for the M2 screens** | The screenshots spec covers M0 and M1 screens. The English ticket view was re-rendered for the email composer in #97. The sidebar has since gained Channels, Automation and the bell, so the shell baselines may need a fresh render from the screenshots workflow. | [development guide](../guides/development.md#browser-tests) |

## Decisions settled

| Decision | Where |
|---|---|
| The SMTP test is per brand on Channels › Outgoing email, not per mailbox. A mailbox receives; the brand's server sends for all of them. | [outbound email](../guides/outbound-email.md#the-server-channels--outgoing-email) |
| Auto-replies go only to mail that opened a ticket. Machine mail, including allow-listed machines, and mail filed as spam never get one. | [outbound email](../guides/outbound-email.md#auto-replies-m2-06) |
| Our own `Message-ID`s live in `email_deliveries.message_id`; `ticket_messages.external_message_id` stays the inbound dedupe key and never holds them | [How the two halves meet](#how-the-two-halves-meet) |
| An inbound-parse request answers the same 401 for an unknown recipient and a wrong secret | [How the inbound half works](#how-the-inbound-half-works) |

## What an operator can do with this milestone

Connect a brand's mailboxes by IMAP or an inbound-parse provider, set the
brand's SMTP server and each department's sender, and switch on the
acknowledgment and out-of-hours replies in English and Arabic. Customers'
mail becomes tickets, their replies thread onto them, and strangers never
reach someone else's ticket. Agents answer in the email composer with their
signature. Admins see each mailbox's health and retry or discard failed sends.

## How the inbound half works

- **One pipeline.** IMAP and every provider produce an `InboundEnvelope`;
  `toEmailInboundMessage` turns it into the channel-neutral `InboundMessage`;
  `InboundEmailService` dedupes, drops automated and blocked senders, and hands
  the rest to the `ConversationRouter` in one system transaction for the brand.
- **Threading.** A `Message-ID` in `In-Reply-To`/`References` that matches a
  `ticket_messages.external_message_id` of the brand, or the brand's
  `[PREFIX-N]`, names a candidate (a merged ticket stands for its primary). The
  sender must be the contact (any email identity), a CC recorded under that
  address, or a staff member who is the assignee or wrote on the ticket.
  Otherwise a new ticket is filed in the candidate's department with the note
  "Referenced HD-1042 but sender is not a participant".
- **Events written:** `email.received` (not for mail filed as spam),
  `ticket.created`, `ticket.replied`, `ticket.spam`, `assignment.requested`,
  `attachment.uploaded`, the CC participants service's own, and
  `mailbox.changed`, which the worker consumes to upsert or remove the
  mailbox's `email.poll` job scheduler.
- **Security.** IMAP hosts and remote images are resolved through
  `@helpdock/net` (`resolvePublicHost`, `safeFetch`), so neither reaches the
  install's own network unless `OUTBOUND_ALLOW_CIDRS` allows it. Proxied images
  are re-encoded to WebP by sharp and served only after `ticket:read`.

## How the two halves meet

- **Auto-replies.** `InboundEmailService` writes `email.received` beside the
  filed message with `autoGenerated` from `isAutoGeneratedEmail`, so an
  allow-listed automated sender files a ticket but is never answered.
- **Replies to our own mail.** Outbound mail carries
  `Message-ID: <hd.m.<ticketMessageId>@domain>` (auto-replies `hd.a.` /
  `hd.o.` with the ticket id), stored in `email_deliveries.message_id`. The
  router looks a customer's `In-Reply-To` / `References` up there as well, so a
  reply to an agent's email or an acknowledgment threads onto its ticket,
  still subject to the participant check.
- **Staff participants** are read from `users.email`; an agent replying from a
  personal address threads only if that address is their account's.
- **Channels page.** One tab row (`apps/admin/src/screens/admin/channels/tabs.ts`):
  Mailboxes first, so `/admin/channels` lands there, then Outgoing email.
- **With M3.** The out-of-hours reply reads M3-01's calendar through
  `businessHoursProbe`, and the router calls `lifecycle.onCreated`, so an
  emailed ticket starts its SLA clocks and a customer's emailed reply resumes
  them (`email-roundtrip.integration.test.ts` › "with M3 business hours and
  SLAs").

## Pull requests

- #97 feat(email): outbound SMTP through the outbox, auto-replies and Outgoing email admin (M2-05, M2-06, M2-08 part)
- #99 feat(channels): inbound email, threading and mailboxes (M2-01, M2-02, M2-03, M2-04, M2-07, M2-08)
