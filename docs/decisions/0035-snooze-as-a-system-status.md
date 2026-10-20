# 0035 Snooze as a system status with a wake timer

Status: accepted
Date: 2026-10-20

## Context

Agents need to put a ticket away until it matters again ("remind me on Sunday")
without losing it and without it sitting in My open all day. Helpdock 1.0 has
no snooze. It does have custom statuses mapped to four system states with
`pauses_sla` and `awaiting_customer` flags (D §2.1), a transition table in which
any open-like ticket goes back to open on a customer reply (D §2.2), and an SLA
engine whose timers are delayed jobs rebuilt by `sla.rebuild` after Redis loss
(D §3.4). Views, reports, rules, webhooks and the importer all key on status.

The risk with snooze is that it becomes a way to hide a ticket from its SLA.

The plan is [M14-02 in M14 Inbox productivity](../in-development/M14-inbox-productivity.md#m14-02-snooze);
owner decisions D-19 and D-20.

## Decision

1. **Snooze is a status.** Every brand gets a seeded system status **Snoozed**
   (system state `on_hold`, `is_system`, built-in key `snoozed`, `pauses_sla`,
   not `awaiting_customer`), with fixed state and flags. The ticket carries
   `snoozed_until`, `snoozed_by`, `snooze_resume_status_id` and
   `snooze_version`; a ticket is in Snoozed exactly when `snoozed_until` is set.
2. **Waking.** Whichever comes first: the time is reached (back to the
   remembered status if it still exists and is open-like, else the default open
   status); a customer public reply (the existing D §2.2 row, unchanged); an SLA
   warning or breach on a running response clock (back to the remembered
   status); any other status change, close, merge or spam by a person or rule;
   *Wake now*. Waking by time or SLA notifies the assignee, else the person who
   snoozed it.
3. **The per-clock pause exception.** Snoozed pauses the **resolution** clock
   only. An unsatisfied first-response or next-response clock keeps running:
   putting a ticket away is not answering it. Snoozed is the one status whose
   `pauses_sla` applies per clock; the clock code already pauses clock by clock.
4. **Timers through the outbox.** Setting a snooze writes `ticket.snoozed` to
   the outbox in the same transaction; its consumer adds a delayed
   `ticket.unsnooze` job with `jobId = snooze.<ticketId>.<version>`. When it
   fires it locks the ticket and does nothing unless the ticket is still Snoozed
   at that version and due. `snooze.rebuild` runs on worker boot and hourly, as
   `sla.rebuild` does, and wakes overdue snoozes, so Redis loss loses no snooze.
5. **Lists exclude snoozed tickets by default** (`snoozed=exclude`), with a new
   built-in Snoozed view; an exact ticket number still finds a snoozed ticket.

## Consequences

- Snoozed tickets are countable in reports, filterable in views and testable by
  rules with no new plumbing; a webhook consumer sees a status change and the
  new `snoozedUntil` field, and no new webhook event.
- Snooze cannot be used to dodge a response target, and an SLA warning brings
  the ticket back.
- DOMAIN-RULES §2.1, §2.2, §3.2 and §3.4 change when M14-02 lands, with a worked
  example to the minute.
- A brand cannot rename Snoozed's state or flags, only its label.
- There is no "snooze until the customer replies": Awaiting customer already
  means that.

## Alternatives considered

- **A flag beside the status** (Awaiting customer stays Awaiting customer while
  snoozed): needs a new pause rule in the SLA engine, hides snooze from reports
  and views that key on status, and makes "what state is this ticket in" a
  two-column question.
- **Pause both clocks** (what a `pauses_sla` status does today): lets snooze
  hide an unanswered ticket from its first-response target.
- **Pause neither clock**: snoozing a ticket waiting on a third party would
  count against resolution time the team cannot influence.
- **A Redis-only timer**: lost with Redis, against D §10's recovery rules.
