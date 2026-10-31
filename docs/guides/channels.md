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
| WhatsApp, Messenger, Instagram | A message to the brand's WhatsApp number, Facebook Page or Instagram professional account | The same platform and conversation, inside Meta's reply window | Channels › Meta | [Meta channels](meta-channels.md) |
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
- **Reply windows.** WhatsApp, Messenger and Instagram accept a business's
  reply only for a time after the customer's last message. Helpdock refuses a
  reply outside that time when the agent writes it, and checks again when it
  sends ([reply windows](tickets.md#reply-windows)).
- **Bot check.** The widget's first message and the web form can ask a visitor
  to pass a check first, chosen once per brand on Channels › Widget: the
  built-in proof-of-work check (`pow`, nothing sent to a third party),
  Cloudflare Turnstile or hCaptcha. See [Bot check](#bot-check).
- **Outbound connections** to a host a brand configured (an IMAP server, a
  webhook endpoint) go through the SSRF-safe client
  ([security](security.md#outbound-requests)).

## Bot check

A brand can ask visitors to pass a check before the widget accepts a first
message or the web form accepts a submission. It is off by default, and
the one setting serves both surfaces. An Admin of the brand sets it on
**Channels › Widget** under "Where the widget may run": switch on **Check for
bots before the first message**, then pick a **Provider**
([configuration](configuration.md): `captcha.provider`).

| Provider | What it is | Keys |
|---|---|---|
| **Built-in (no third party)**, `pow` | A signed proof-of-work challenge the visitor's browser solves, using ALTCHA's wire protocol ([ADR 0052](../decisions/0052-built-in-proof-of-work-captcha.md)). It slows simple floods; it does not stop a determined attacker. | None. **Difficulty**: Low (about half a second on a mid-range phone) or Medium (about two seconds), `captcha.difficulty`. |
| **Cloudflare Turnstile** | Stronger bot detection, at the cost of sending visitor signals to Cloudflare. | Site key and secret key. |
| **hCaptcha** | The same trade, with hCaptcha. | Site key and secret key. |

- The check is per conversation in the widget and per submission on the form.
- A Turnstile or hCaptcha pass must report one of the surface's own hosts, and
  Turnstile is rendered with the `widget-first-message` or `web-form` action
  and the brand id, so a pass earned on another surface or brand fails.
  Details: [widget protocol](widget-protocol.md#the-built-in-check),
  [web form](web-form.md#what-a-submission-does).
- A built-in solution is good once, for one brand and one surface, for
  15 minutes.
- There is no check on the staff sign-in link and reset forms, which email only
  an existing account and are limited per address and per IP
  ([authentication](authentication.md#rate-limits)), nor on the help center's
  "Was this helpful?" card ([help center](help-center.md)).

## Not in v1

Slack and Discord are on the v1.1 backlog
([REQUIREMENTS §6](../planning/REQUIREMENTS.md#6-add-on-features-v11-backlog)).
