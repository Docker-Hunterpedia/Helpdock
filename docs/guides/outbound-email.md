# Outbound email

How Helpdock sends a reply to a customer by email, what an auto-reply is, and
what happens when a mail server says no (M2-05, M2-06, the outbound half of
M2-08; [REQUIREMENTS §4.4](../planning/REQUIREMENTS.md#44-channels),
[DOMAIN-RULES §6](../planning/DOMAIN-RULES.md#6-transactional-outbox)).

Inbound mail — mailboxes, IMAP polling, parse webhooks and threading — is a
separate guide.

## Which replies are emailed

A **public reply by a staff member** on a ticket whose channel is `email`,
`form` or `manual` is emailed. A chat or Telegram ticket answers on its own
channel; an internal note never leaves the desk.

The reply goes **to** the ticket's contact (their email identity, verified ones
first) and is **copied** to every CC participant with an address
([DOMAIN-RULES §2.5](../planning/DOMAIN-RULES.md#25-participants)). A contact
with no email address gets nothing, and the composer says so; the reply stays
on the ticket.

## The server: Channels › Outgoing email

**Admin → Channels → Outgoing email** (Admin only, `brand:manage`).

| Section | What it sets |
|---|---|
| Outgoing mail (SMTP) | The brand's own server: host, port, `TLS` / `STARTTLS` / none, username and password. **Test SMTP** sends one message to you through the server on screen and shows the relay's answer. A brand with no server of its own sends through the install's (`smtp.*`, set by the first-run wizard). |
| From and Reply-To per department | The default sender, and a `Name <address>` plus an optional Reply-To for each department that sends as someone else. A reply goes out as its ticket's department, then the default, then the install's `smtp.from`. |
| Auto-replies | See below. |
| Failed sends | The dead-letter queue. See below. |

The SMTP password is encrypted with AES-256-GCM under `APP_MASTER_KEY` and is
never sent back to the browser: the field shows that one is stored and is
read-only until **Replace** is pressed. Every save writes an audit row
(`email.smtp.updated`, `email.senders.updated`, `email.auto_replies.updated`)
that says whether the password changed, never what it is.

The SMTP host is operator configuration, so it is not run through the
SSRF-safe client; a relay on the private network (`mailpit:1025` in
development) is the ordinary case. Every SMTP timer is capped at ten seconds.

## Signatures

**Your account → Email signature**: up to six lines of plain text in English
and in Arabic. The reply carries the one in the customer's language (the
contact's, else the brand's default); an empty Arabic signature falls back to
the English one. Links become clickable. The composer shows the signature under
the reply before it is sent.

## The message

Every customer email is one 600 px column with a plain-text part carrying the
same words (artboard `EmailCustomer`): the reply marker, the brand, the body,
the signature, and a reference box with `[HD-1042]` so the customer's answer
threads. It is written in the customer's language and mirrored for Arabic. An
agent's reply goes out as "Lina Haddad via Helpdock Billing".

Headers:

- `Message-ID` is deterministic: `<hd.m.<ticket message id>@<from domain>>` for
  a reply, `<hd.a.<ticket id>@…>` and `<hd.o.<ticket id>@…>` for the two
  auto-replies. It is fixed when the send is queued, with the sender and the
  recipients, so every retry is the same message.
- `In-Reply-To` is the customer's last message on the ticket; `References`
  lists the thread's ids.
- Auto-replies carry `Auto-Submitted: auto-replied`, `Precedence: bulk` and
  `X-Auto-Response-Suppress: All`.

## How a send runs

```
reply (request)  → ticket_messages + email_deliveries + outbox(email.send)   one transaction
relay            → BullMQ outbox.event
worker           → email.send job on the outbound queue (jobId = outbox id)
email.send       → SMTP, then the delivery row is `sent`                      with its receipt
```

A reply that rolls back sends nothing. The consumer claims the receipt
`email.send:<delivery id>` in the transaction that marks the row sent, and
skips a row that is not `queued`, so **delivering the same job twice sends one
email**.

A send is tried five times over about eight minutes (exponential backoff from
30 seconds). Each failure keeps the relay's last words on the row. After the
fifth, the row is `failed` and the job stays in BullMQ's failed set.

## Failed sends

The **Failed sends** panel lists every `failed` send with its recipient,
ticket, last error and attempts. Nothing is retried until an Admin chooses:

- **Retry** (or **Retry all**) puts the send back in the queue for five more
  attempts, with the same `Message-ID`, so a customer whose server did take an
  earlier attempt sees one message.
- **Discard** gives up. The reply stays on the ticket, marked **Not
  delivered**.

On the ticket, a reply that was not delivered shows "Not delivered" with the
error and a **Retry** any agent who can work the ticket may press
(`ticket:write`).

## Auto-replies (M2-06)

Both are off until turned on, for the whole brand, with an English and an
Arabic template each (subject and plain-text body). The placeholders are
`{{ticket.number}}`, `{{contact.first_name}}`, `{{department.name}}` and
`{{brand.name}}`; anything else in braces is sent as typed. A template left as
shipped follows the catalog wording as it improves.

- **Acknowledge new tickets**: sent once when an email opens a new ticket.
- **Out-of-hours reply**: sent *instead of* the acknowledgment when the email
  arrives outside the department's business hours. Until business hours are
  set (M3), every hour counts as open and it is never sent.

Loop protection, in order:

1. Never to a message marked `Auto-Submitted` (other than `no`) or
   `Precedence: bulk / list / junk`, or from `noreply@`, `no-reply@`,
   `mailer-daemon@` or `postmaster@` (`isAutoGeneratedEmail` in
   `@helpdock/channels`).
2. At most **N** auto-replies to one address per rolling hour (default 3,
   1 to 50). Mail past the cap still opens or updates tickets.
3. At most one of each kind per ticket.

The inbound adapters ask for the decision by writing an `email.received`
outbox event in the transaction that files an email:
`{ ticketId, ticketMessageId, createdTicket, from, fromName?, autoGenerated }`
(`enqueueEmailReceived` in `apps/api/src/email/email-events.ts`).

## API

| Route | Permission |
|---|---|
| `GET /api/brands/:brandId/email/outgoing` | `brand:manage` |
| `PUT …/email/outgoing/smtp`, `POST …/email/outgoing/smtp/test` | `brand:manage` |
| `PUT …/email/outgoing/senders`, `PUT …/email/outgoing/auto-replies` | `brand:manage` |
| `GET …/email/failed-sends`, `POST …/failed-sends/retry-all`, `POST …/failed-sends/:deliveryId/retry`, `POST …/failed-sends/:deliveryId/discard` | `brand:manage` |
| `GET /api/brands/:brandId/tickets/:ticketId/email` | `ticket:read` |
| `POST …/tickets/:ticketId/email/messages/:messageId/retry` | `ticket:write` |
| `GET`, `PUT /api/me/signature` | signed in |

`POST …/tickets/:ticketId/messages` takes an optional `emailFrom`: `default` or
a department id, the composer's From choice.

## Data

- `email_outbound_settings`: one row per brand (tenant table, not
  department-scoped). No row means the defaults.
- `email_deliveries`: one row per outbound email (tenant table,
  **department-scoped**, follows its ticket to another department).
- `users.signature_en`, `users.signature_ar`.
