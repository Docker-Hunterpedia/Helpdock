# Snooze

Put a ticket away until it matters again. A snoozed ticket leaves your queue,
wakes at the time you chose, and comes back sooner if the customer writes or an
SLA is about to run out. It is a status, so reports, views, rules and webhooks
see it with no extra setup.

Built in M14-02 ([ADR 0035](../decisions/0035-snooze-as-a-system-status.md));
the rules are in [DOMAIN-RULES §2](../planning/DOMAIN-RULES.md#2-ticket-lifecycle)
and [§3.2](../planning/DOMAIN-RULES.md#32-pause-and-resume).

## Snoozing a ticket

Open the ticket and choose **Snooze** in its header, or press `h`. The menu
offers four times, each with the exact day and time on the right:

| Item | Time |
|---|---|
| In 1 hour, In 4 hours | That long from now |
| Next business day | The next opening of the ticket's department after today ends; 09:00 tomorrow in your time zone if nobody has set business hours |
| Next week | The first opening after the calendar's coming weekend: Sunday in Asia/Riyadh, Monday in Europe/Berlin; Monday 09:00 in your zone without business hours |
| Pick a date and time… | A date and time of your own, 5 minutes to 90 days ahead |

When the department works in another time zone than yours, **Next business day**
and **Next week** say when the department opens, in its zone. The picker shows
both times under the field.

Snoozing an already snoozed ticket moves the time and keeps the status it had
before the first snooze. A closed ticket cannot be snoozed; reopen it first. A
reader with the Viewer role sees snoozed tickets and cannot snooze them.

The ticket then shows a strip above the thread: who snoozed it, until when and
what wakes it early, with **Wake now**.

## What wakes it

Whichever comes first:

| Trigger | Status after | Thread line |
|---|---|---|
| The time is reached | The status before the snooze, if it still exists and is open-like; else the brand's default open status | "The ticket woke up: its time came" |
| The customer replies publicly | The default open status | "…the customer replied" |
| A first-response or next-response clock reaches an escalation step or its target | The status before the snooze | "…an SLA was about to run out" |
| Anyone, or a rule, picks another status, closes, merges or marks spam | That status | "…its status changed" |
| **Wake now** | The status before the snooze | "<name> woke the ticket" |

When it wakes by time or by an SLA step, the assignee is told, or the person who
snoozed it if nobody holds the ticket: a **Snooze ended** notification, in-app
and push by default and email off. You can change that under Your account ›
Notifications. A customer's reply, a status change and **Wake now** tell
nobody: the person who did it already knows.

## SLA clocks

Snoozing does not hide a ticket from its response target. While a ticket is
snoozed the **resolution** clock is paused, and an unanswered **first-response**
or **next-response** clock keeps running, because putting a ticket away is not
answering it. When that clock reaches an escalation step, the ticket wakes so
somebody sees it. A ticket moved from Awaiting customer to Snoozed therefore
starts counting its response clock again. See
[Business hours and SLAs](slas.md).

## Where snoozed tickets go

- **My open, Unassigned, Overdue** and every saved view stop showing snoozed
  tickets, with no edit. The list takes `snoozed=exclude` (the default), `only`
  or `include`.
- The built-in **Snoozed** view (`snoozed=only`, assigned to me) sits under My
  open. Its rows show a clock and the wake time where the SLA timer was.
- Typing a ticket's number or reference in the search box still finds it.
- Snoozed counts as `on_hold` but not as awaiting the customer, so it does not
  count against an agent's load cap and the offline timer does not unassign it.

## The API

`PATCH /api/brands/:brandId/tickets/:ticketId` takes `snoozedUntil`: an ISO
instant 5 minutes to 90 days ahead to snooze or move the time, or `null` to
wake. It cannot be sent with `statusId`, and setting the Snoozed status alone
is refused with 409 `snooze-requires-time`; a closed ticket answers 409
`ticket-closed`. Tickets carry `snoozedUntil` and `snoozedBy` (and the status
`isSnoozed`), the public API v1 accepts and returns the same, and
`ticket.updated` webhooks carry `snoozedUntil`. There is no snooze webhook
event; consumers see a status change.

`GET /api/brands/:brandId/tickets/:ticketId/snooze-presets?timeZone=<IANA>`
answers the menu's four instants, the department's name and its zone. It needs
`ticket:read` and writes nothing.

The list filter is `snoozed=exclude|only|include` on
`GET /api/brands/:brandId/tickets` (default `exclude`) and on `GET /api/v1/tickets` (default `include`).

A rule, a macro or an import mapping cannot target the Snoozed status: the api refuses it at save, and the editors do not offer it, because it needs a wake time.

## How it works

- **Data.** `tickets.snoozed_until`, `snoozed_by`, `snooze_resume_status_id` and
  `snooze_version`. A `BEFORE UPDATE` trigger (`tickets_snooze_guard`) clears
  the three columns whenever `status_id` changes to anything but Snoozed, so a
  rule, a macro, a merge or an import cannot leave a ticket Snoozed with no
  wake time, and bumps `snooze_version` on every change of `snoozed_until`.
- **Timer.** A snooze writes `ticket.snoozed` to the outbox in the same
  transaction. Its consumer adds a delayed BullMQ job `ticket.unsnooze` on the
  `sla` queue, `jobId = snooze.<ticket id>.<version>`. The job locks the ticket
  and does nothing unless it is still Snoozed at that version and due, so an
  older job, a customer reply or a manual wake leaves nothing behind that can
  act twice.
- **Rebuild.** `snooze.rebuild` runs on worker boot and hourly, per brand: it
  wakes every snooze that is already due and re-adds the timer of the rest. Losing
  Redis loses no snooze.
- **Activity.** `ticket.snoozed` (with `to.snoozedUntil` and the remembered
  status) and `ticket.woke` (`to.reason`: `time`, `customer_reply`, `sla`,
  `status_changed`, `manual`), beside the ordinary `ticket.status.changed`.

## Known gaps

- Snoozing from the bulk bar and from the command palette arrives with M14-04
  and M14-05.
- There is no "snooze" action for rules or macros in 1.1.
- A brand with no business hours set gets 09:00 in the agent's time zone for the
  calendar presets.
