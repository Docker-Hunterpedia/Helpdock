# Channels

The ways customers reach a brand. Every channel files into the same ticket
workspace: the same statuses, SLAs, rules, assignment and agent replies,
whichever way the customer wrote
([REQUIREMENTS §4.4](../planning/REQUIREMENTS.md#44-channels)).

Each channel is configured per brand under **Admin › Channels**, which only an
Admin of the brand can open (`brand:manage`).

| Channel | Customer writes by | Agent's reply reaches them by | Set up on | Guide |
|---|---|---|---|---|
| Email | Mail to a mailbox address, fetched over IMAP or posted by the provider's inbound-parse webhook | Email from the brand's sender | Channels › Mailboxes, Channels › Outbound email | [Receiving mail](email.md), [Outbound email](outbound-email.md) |
| Telegram | A message to the brand's bot | The same chat | Channels › Telegram | [Telegram](telegram.md) |
| Chat widget | The widget on the brand's site, or a native app speaking its protocol | The widget, live | Channels › Widget | [Widget protocol](widget-protocol.md) |
| Web form | The hosted contact page, `/contact` on the help center domain | Email | Channels › Web form | [Web form](web-form.md) |
| REST API | `POST /api/v1/tickets` with an API key | Your integration, which reads the thread with `GET /api/v1/tickets/{ticketId}/messages` | Developers › API keys | [API](api.md) |

Agents can also open a ticket by hand from the ticket list
([tickets](tickets.md)).

## What every channel shares

- **One contact per person.** An address or chat id seen before finds its
  contact; one never seen makes a new one. An address a customer typed is a
  claim, not proof, so it never joins someone else's history on its own
  ([contacts](contacts.md), [DOMAIN-RULES §4](../planning/DOMAIN-RULES.md#4-identity-and-conversation-ownership)).
- **No duplicates.** An inbound message carries its channel's own id, which is
  unique per channel, so a redelivered email, Telegram update or webhook files
  nothing twice ([DOMAIN-RULES §6](../planning/DOMAIN-RULES.md#6-transactional-outbox)).
- **Replies go through the outbox.** An agent's reply is committed with an
  outbox row in the same transaction, and the worker sends it
  ([DOMAIN-RULES §6](../planning/DOMAIN-RULES.md#6-transactional-outbox),
  [operations](operations.md#scaling-the-worker)).
- **Attachments** pass the brand's content policy and the media pipeline
  whichever channel brought them ([attachments](attachments.md)).
- **Outbound connections** to a host a brand configured (an IMAP server, a
  webhook endpoint) go through the SSRF-safe client
  ([security](security.md#outbound-requests)).

## Not in v1

WhatsApp, Messenger, Instagram, Slack and Discord are on the v1.1 backlog
([REQUIREMENTS §6](../planning/REQUIREMENTS.md#6-add-on-features-v11-backlog)).
