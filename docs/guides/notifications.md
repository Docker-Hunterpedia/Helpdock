# Notifications

How staff are told about their work: the bell in the sidebar, the email from
the install, and browser push (M3-07,
[REQUIREMENTS §4.9](../planning/REQUIREMENTS.md#49-notifications),
[ADR 0002](../decisions/0002-web-push-via-vapid.md)). Every send goes through the
transactional outbox of [DOMAIN-RULES §6](../planning/DOMAIN-RULES.md#6-transactional-outbox).

## What people are told about

| Event | Who is told | Default channels |
|---|---|---|
| **Assigned to me** | The new assignee, whoever chose them: a person (a macro's assign action included), a workflow rule, round-robin or skill-based routing. A pick the rotation makes because a rule asked for it counts as the rule's. Assigning a ticket to yourself tells nobody. | in-app, email, push |
| **Reply on my tickets** | The assignee, when the *contact* answers. A colleague's reply is not this. | in-app, push |
| **Mentioned in a note** | Everyone an internal note `@`-mentions (below). | in-app, email, push |
| **SLA warning** | The people, team members and department Team Leaders the warning step names; if it names none, the assignee. | in-app |
| **SLA breach** | The assignee; on a ticket nobody holds, the members of its team. | in-app, email, push |
| **Escalation** | The people, team members and department Team Leaders an SLA escalation step names; if it names none, the assignee and the ticket's team. Also the recipients of a workflow rule's *Notify* action, with the rule's message quoted. | in-app, email |

Three rules hold for all six:

- **Only about tickets they can see.** A recipient must hold a role in the brand
  whose department scope covers the ticket's department — the same scope the
  ticket's row policy applies ([DOMAIN-RULES §1.2](../planning/DOMAIN-RULES.md#12-scope-rules)).
  An Agent of Billing mentioned on a Support ticket is told nothing.
- **Deactivated staff get nothing.**
- **Nobody is told about what they did themselves.**

A team reaches each member by that member's own settings.

### Mentions

There is no mention picker in the composer; a mention is `@` followed by a
handle, in any script. A handle names somebody in the brand by, in this order:

1. the part of their email address before the `@` — `@lina.haddad`;
2. their whole name without spaces — `@LinaHaddad`;
3. their first name — `@Lina` — **only when exactly one person in the brand has
   it**. `@Omar` in a brand with two Omars tells neither of them.

An `@` straight after a letter or digit is part of an email address, not a
mention.

## The bell

The bell sits at the inline end of the sidebar's brand row. Its accessible name
carries the count ("Notifications, 3 unread"), and the badge shows it. The panel
lists the **last 30 days** of the brand on screen, grouped by day, with an
**Unread** filter and **Mark all read**. Opening a row marks it read and opens
its ticket.

A row holds ids, never content: the subject and names are read when the panel
is, under the reader's own department scope, so a ticket they can no longer see
drops out of their panel. The nightly retention job deletes rows older than 30
days in bounded batches for each brand.

New rows arrive as a `notification:created` frame on the person's own
`user:<id>` room (see [realtime](realtime.md)). The frame carries ids only; the
bell re-reads its list over REST.

## Your account › Notifications

Your account (`/me`) is one page with three tabs, each a URL of its own:
Security (`/me/security`, where `/me` lands), Notifications
(`/me/notifications`) and Email signature (`/me/signature`, see
[outbound email](outbound-email.md)).

The Notifications tab is reached from the account menu or the panel's
"Notification settings" link. One checkbox per event and channel; nothing is saved until
**Save changes**, and **Discard** puts the saved state back. Preferences belong
to the person, not the brand: they are the same in every brand they work in.

The caption says where email goes and in which language: the person's app
language, set on the Security tab.

## Email

Notification emails go from the install's **system sender** — the SMTP settings
the first-run wizard saves (`smtp.*`, or `HD_SMTP_*`), the same one sign-in links
use — never from a brand's support mailbox, so a reply to one cannot land in a
ticket. They are written in the recipient's app language (English or Arabic),
link to the ticket and to the settings page, and carry no remote images.

An install without SMTP settings sends none: each job logs "Notification email
not sent: this install has no SMTP settings." and finishes, rather than retrying.

## Browser push

Push needs a VAPID key pair on the install, as settings `push.vapidPublicKey` and
`push.vapidPrivateKey` (the private key is a secret setting, encrypted at rest
and never returned to a browser). The first-run wizard generates the pair when
it finishes, if the install has none, and records `install.setup.push` in the
install's audit log without either key (`apps/api/src/install/vapid-keys.ts`).
An install set up before that, or an operator who wants the pair in `.env`,
pins it from the environment instead, and the wizard then leaves it alone:

```sh
npx web-push generate-vapid-keys
# then, in .env:
HD_PUSH_VAPID_PUBLIC_KEY=B…
HD_PUSH_VAPID_PRIVATE_KEY=…
```

Without them the push column of the settings page is disabled and the card says
"Not set up on this install"; no push job is queued. Rotating the pair
invalidates every browser's subscription (ADR 0002); each person turns push on
again.

Push also needs HTTPS (or `localhost`) and a browser with a service worker and
the Push API. On iOS and iPadOS it works only for Helpdock added to the Home
Screen. Each person turns it on per browser, on the card beside the settings:
the browser asks once; **Send a test** pushes one notification to that browser
through the same path a real one takes; **Turn off** removes it. A browser that
answered "block" has to be allowed again in its own site settings.

The admin serves its service worker at `/sw.js`. It caches nothing; it shows
what is pushed and, on a click, opens the ticket.

The worker sends each push through the SSRF-safe client
([DOMAIN-RULES §13](../planning/DOMAIN-RULES.md#13-outbound-network-safety)),
because a push endpoint is a URL a browser handed the api. A push service that
answers `404` or `410`, or an endpoint the policy refuses, deletes the
subscription.

## How a notification travels

```
ticket change, SLA step, rule   →  outbox: ticket.assigned, sla.breached, …   (same transaction)
worker: fan-out                 →  notifications rows + outbox: notification.created
worker: notification.created    →  socket frame; notify.email and notify.push jobs
worker: notify queue            →  one email; one push per browser
```

| Event consumed | Written by |
|---|---|
| `ticket.assigned` | `TicketsService` (a person), `autoAssign` (the rotation), a workflow rule (M3-03) |
| `ticket.replied`, `ticket.note_added` | `TicketsService.addMessage` (M1-03) |
| `sla.warning`, `sla.breached` | the SLA engine (M3-02); a warning may name `userIds`, `teamIds` and `departmentLeads` |
| `ticket.escalated` | an SLA escalation step (M3-02); may name `userIds`, `teamIds` and `departmentLeads` |
| `rule.notify` | a workflow rule's *Notify* action (M3-03): `{ ticketId, recipients, message, ruleId }`, delivered as an escalation |

A redelivered event writes nothing new: a notification is unique per source
event and recipient, and the email and push jobs are keyed by what they send.
The consumers subscribe to these events as `notifications`, beside whichever
module owns each event ([`packages/jobs`](../../packages/jobs/README.md#handling-an-event)).

## API

| Route | Permission | Does |
|---|---|---|
| `GET /api/brands/:brandId/notifications?filter=all\|unread` | `ticket:read` | The panel: `{ items, unreadCount }` |
| `POST /api/brands/:brandId/notifications/:id/read` | `ticket:read` | Marks one of the caller's own read; `404` for anyone else's |
| `POST /api/brands/:brandId/notifications/read-all` | `ticket:read` | Marks all of the caller's read in the brand |
| `POST /api/brands/:brandId/notifications/test-push` | `ticket:read` | `{ subscriptionId }`; `409` without VAPID keys |
| `GET`, `PUT /api/me/notification-preferences` | signed in | The matrix, the email address and language, and push status |
| `POST /api/me/push-subscriptions` | signed in | `PushSubscription.toJSON()` plus a label; `https` endpoints only |
| `DELETE /api/me/push-subscriptions/:id` | signed in | Removes one of the caller's browsers |

## Known gaps

- None open. The VAPID pair is generated by the wizard since M9.
