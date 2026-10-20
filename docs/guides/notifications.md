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
its ticket. Opening a ticket any other way marks every notification about it
read too (M14-10), so an email still waiting to go leaves it out.

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
ticket. They are written in the recipient's app language (English or Arabic,
right to left), link to the tickets and to the settings page, and carry no
remote images and no message bodies beyond a single notification's excerpt.

Since M14-10 email is **paced** ([ADR 0037](../decisions/0037-paced-notification-email-and-digests.md),
[DOMAIN-RULES §20](../planning/DOMAIN-RULES.md#20-notification-delivery)). The
bell is always immediate, and push stays immediate.

### Email schedule

Each person chooses one schedule, the same in every brand:

| Schedule | What arrives |
|---|---|
| **Right away** (default) | One email a short wait after the first notification, gathering what arrives meanwhile. While more keeps coming, the waits grow. |
| **Hourly digest** | At the top of each hour, what is still unread. |
| **Daily digest** | Once a day, at the hour they choose (08:00 unless changed), in their time zone. |
| **Off** | No notification email. |

Right away is the default for everyone, existing accounts included: an upgrade
from 1.0 replaces one email per notification with batched email (owner
decision D-25).

**Right away pacing.** The first email goes 2 minutes after the first
notification. While more arrives, each next email waits a back-off step after
the last one went: 10, 20, 40, then 60 minutes, and 60 after that. After 2 quiet
hours with nothing new, the next one waits 2 minutes again. A **mention**, an
**SLA breach** or an **escalation** may cut the wait and go at once, but no more
often than every 5 minutes and no more than 8 times a day. However they come,
one person gets at most **6** notification emails an hour and **40** a day from
one brand, digests included. Twelve notifications in an hour reach the person
as no more than six emails.

**Nothing while they are working.** While the person is online (not away) in
the brand, a Right away email waits until they have been away or offline for 5
minutes, and never more than 15 minutes in all (owner decision D-27); what they
read meanwhile drops out.

**Digests are per brand.** A person in three brands gets up to three digests,
each naming its brand in the subject (owner decision D-26). The daily digest's
hour is read in the person's time zone; until M14-12 gives each person their
own, it is the brand's time zone. On the day summer time ends, an hour that
happens twice sends one digest; on the day it starts, an hour that does not
exist sends none, and its rows wait for the next day's.

### What an email says

Following the `Email/NotificationBatch` artboard:

- **One notification** is its own email, as in 1.0.
- **Several** are one email, "[Acme] 6 updates since 14:52", headed by what
  happened ("4 assigned, 2 replies"), then **Needs you now** (mentions,
  breaches, escalations), then **Tickets**, folded per ticket ("Mona replied 2
  times"). Each reference links to its ticket.
- **A digest** says how many things happened since when and how many need the
  person now, and folds a kind that touched several tickets into one line ("7
  tickets assigned to you, by Omar and round-robin").

Every notification email ends "You get these because of your notification
settings. Change them", with a link to the settings page; M14-11 adds the
one-click unsubscribe beside it. Each email's `Message-ID` is derived from its
batch, so a batch that is retried is the same message.

### Checked again before it goes

A notification can wait minutes or a day for its email, so every row is checked
again when the email is sent. It is left out, for good, when:

| Check | Marked |
|---|---|
| The ticket is gone, or the person can no longer see its department, or no longer holds a role in the brand, or was deactivated | `skipped_scope` |
| They read it, in the bell or by opening the ticket | `skipped_read` |
| Their schedule is Off, they unsubscribed (M14-11), or the row was made with email off | `skipped_off` |
| They are paused | `skipped_paused` |

A batch whose every row is left out sends nothing. An install without SMTP
settings sends nothing either: the job logs "Notification email not sent: this
install has no SMTP settings.", marks the rows `skipped_off` and finishes rather
than retrying.

### Pause

A pause (until a time, at most a year ahead) holds email **and** push. It drops
rather than delays: what arrives during it is marked `skipped_paused` and stays
in the bell, and nothing is sent when it ends.

### Settings for an install

Each pacing number is an install setting, pinned from the environment like any
other ([configuration](configuration.md#settings-you-can-pin-with-hd_)):

| Setting | Environment | Default |
|---|---|---|
| `notify.email.firstWaitMinutes` | `HD_NOTIFY_EMAIL_FIRST_WAIT_MINUTES` | `2` |
| `notify.email.backoffMinutes` | `HD_NOTIFY_EMAIL_BACKOFF_MINUTES` | `[10,20,40,60]` |
| `notify.email.quietResetMinutes` | `HD_NOTIFY_EMAIL_QUIET_RESET_MINUTES` | `120` |
| `notify.email.urgentIntervalMinutes` | `HD_NOTIFY_EMAIL_URGENT_INTERVAL_MINUTES` | `5` |
| `notify.email.urgentPerDay` | `HD_NOTIFY_EMAIL_URGENT_PER_DAY` | `8` |
| `notify.email.perHour` | `HD_NOTIFY_EMAIL_PER_HOUR` | `6` |
| `notify.email.perDay` | `HD_NOTIFY_EMAIL_PER_DAY` | `40` |

The presence hold (5 minutes away, 15 at most) is fixed.

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
"Not set up on this install"; no push job is queued. While the person is
paused, no push job is queued either. Rotating the pair
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
worker: notification.created    →  socket frame; notify.email_schedule and notify.push jobs
worker: notify.email_schedule   →  the row joins the person's pending batch, or waits for a digest
worker: notify.email_batch      →  at the batch's time: re-check, one email; one push per browser
worker: notify.digest.tick      →  hourly, per brand: a digest batch for whoever's hour it is
worker: notify.email_rebuild    →  on boot and hourly: every pending batch's job placed again
```

Pacing lives in Postgres (`notification_email_batches` and
`notification_email_pacing`, both owner-scoped like `notifications`), not in
Redis, so losing Redis loses no email: `notify.email_rebuild` puts every
pending batch's delayed job back and schedules any row whose schedule job was
lost. A `notify.email` job left in Redis from 1.0 is let go with a log line.

| Event consumed | Written by |
|---|---|
| `ticket.assigned` | `TicketsService` (a person), `autoAssign` (the rotation), a workflow rule (M3-03) |
| `ticket.replied`, `ticket.note_added` | `TicketsService.addMessage` (M1-03) |
| `sla.warning`, `sla.breached` | the SLA engine (M3-02); a warning may name `userIds`, `teamIds` and `departmentLeads` |
| `ticket.escalated` | an SLA escalation step (M3-02); may name `userIds`, `teamIds` and `departmentLeads` |
| `rule.notify` | a workflow rule's *Notify* action (M3-03): `{ ticketId, recipients, message, ruleId }`, delivered as an escalation |

A redelivered event writes nothing new: a notification is unique per source
event and recipient, a row joins one batch at most, a batch sends once (its
`job_receipts` key is `notify.email_batch:<batchId>`), and push jobs are keyed
by what they send.
The consumers subscribe to these events as `notifications`, beside whichever
module owns each event ([`packages/jobs`](../../packages/jobs/README.md#handling-an-event)).

## API

| Route | Permission | Does |
|---|---|---|
| `GET /api/brands/:brandId/notifications?filter=all\|unread` | `ticket:read` | The panel: `{ items, unreadCount }` |
| `POST /api/brands/:brandId/notifications/:id/read` | `ticket:read` | Marks one of the caller's own read; `404` for anyone else's |
| `POST /api/brands/:brandId/notifications/read-all` | `ticket:read` | Marks all of the caller's read in the brand |
| `POST /api/brands/:brandId/notifications/test-push` | `ticket:read` | `{ subscriptionId }`; `409` without VAPID keys |
| `GET`, `PUT /api/me/notification-preferences` | signed in | The matrix, the email address and language, push status, and `emailDelivery`: `schedule` (`immediate`, `hourly`, `daily`, `off`), `digestHour` (0–23), `pausedUntil` and `unsubscribedAt`. A `PUT` takes any of `preferences`, `emailSchedule`, `digestHour` and `pausedUntil` (an ISO time within a year, or `null` to resume; `400` otherwise) and keeps the rest |
| `POST /api/me/push-subscriptions` | signed in | `PushSubscription.toJSON()` plus a label; `https` endpoints only |
| `DELETE /api/me/push-subscriptions/:id` | signed in | Removes one of the caller's browsers |

## Known gaps

- The schedule, digest hour and pause have an API but no screen until M14-11,
  which also adds one-click unsubscribe and *Send me a test email*.
- The daily digest uses the brand's time zone until M14-12 gives each person
  their own.
- A batch folds per bulk operation only once M14-03 records the operation on
  each notification; until then a bulk change folds per ticket.
