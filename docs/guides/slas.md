# Business hours and SLAs

M3-01 (business hours, holidays, time zones) and M3-02 (the SLA engine). The
rules are [DOMAIN-RULES §3](../planning/DOMAIN-RULES.md#3-sla-calculation);
this guide says how they are carried out, where the code is, and what the two
Ticketing tabs do. The screens are the artboards `Admin/Ticketing-BusinessHours`,
`Admin/Ticketing-SLAs` and `Admin/Ticket-SLA`.

## Business hours

**Ticketing › Business hours.** One save for the brand's zone, its week and
every department override, because a save recomputes every open ticket's due
times. Holidays are saved as they are added or deleted.

| Part | What it holds |
|---|---|
| Brand time zone | `brands.timezone`, the zone SLA time is counted in, and the default for departments without their own hours |
| Weekly hours | Seven days, Sunday first, each with up to four `HH:MM–HH:MM` ranges (`24:00` is midnight). A day with none is closed. A range that ends before it starts, or overlaps another, stops the save and says which day and where |
| Holidays | Whole days, `startsOn`–`endsOn` inclusive, for every department or for one. A holiday closes the day in the zone of the hours it applies to |
| Department hours | A department follows the brand until overridden. An override has its own zone and week; brand holidays still apply to it |

A brand nobody has saved hours for counts Monday to Friday, 09:00–17:00, in
its zone (`defaultWeeklyHours`).

Who may change what (`apps/api/src/sla/sla-scope.ts`, DOMAIN-RULES §1.2): the
tab needs `ticketing:manage`. The brand's own hours, zone and brand-wide
holidays are the Admin's; a Team Leader changes the overrides and holidays of
the departments they lead. A refusal is `403 out-of-scope`.

### The calendar functions

`@helpdock/schemas` exports the arithmetic, pure and dependency-free
(`Intl.DateTimeFormat` knows every zone and its daylight saving):

```ts
import { addBusinessTime, isWithinBusinessHours, type BusinessCalendar } from '@helpdock/schemas';

isWithinBusinessHours(calendar, new Date());          // is the desk open now?
addBusinessTime(calendar, from, 120);                 // 2 business hours after `from`, or null
businessMsBetween(calendar, from, to);                // business time between two instants
nextOpening(calendar, at);                            // the first open instant at or after `at`
```

The api builds a calendar with `BusinessHoursService.calendarFor(brandId,
departmentId, tx?)` (`apps/api/src/sla/business-hours.service.ts`): the
department's own hours if it has them, otherwise the brand's, with the holidays
that apply to it; `departmentId = null` is the brand's own. The transaction
defaults to the request's; a worker passes its own. It is the seam M3-04's
"business hours" rule condition reads, and M2-06's out-of-hours auto-reply
reads it through `businessHoursProbe` (`apps/api/src/sla/business-hours-probe.ts`):
an email that opens a ticket while its department is closed gets the
out-of-hours reply instead of the acknowledgment.

## SLA policies

**Ticketing › SLAs.** Policies are tried top to bottom and the first whose
conditions all match applies. A ticket no policy matches has no clocks; the
list says which department and priority pairs are uncovered.

| Part | What it holds |
|---|---|
| Conditions | At most one per field: department and priority, each "is any of" or "is none of". None matches every ticket |
| How time is counted | `business` (the calendar above) or `calendar` (every minute, 24/7) |
| Targets | First response and resolution, per priority, in minutes (the editor takes minutes or hours) |
| Escalation steps | `{ atPercent, actions[] }`, up to ten, one per percent; above 100 % runs after the breach. Actions: notify the department's Team Leaders, a team or a person; reassign; raise priority one step; add a tag; set status Escalated |

"For every policy" holds two brand settings: `aiCountsAsFirstResponse` (on) and
`slaCountReopens` (off, so compliance reports use the initial clocks). Which
statuses pause the clocks is the Statuses tab's `pauses_sla` flag.

Who may change what: a Team Leader creates, edits and deletes a policy that
applies only to departments they lead ("Department is any of", every value
theirs); anything wider, and the order, is the Admin's.

Saving a policy, reordering, deleting, or saving hours recomputes every open
ticket the saver can see ("time already counted is kept"). The recompute runs
in the request's transaction; a brand with tens of thousands of open tickets
will make that save slow, which is accepted for v1.

## The clocks

`apps/api/src/sla/`:

| File | What it decides |
|---|---|
| `clock.ts` | One clock: start, pause, resume, retarget, satisfy, stop, restart, breach, and when it reaches a percent. Pure |
| `ticket-clocks.ts` | One ticket's clocks against its current facts — the decision table below. Pure |
| `policy-match.ts` | Which policy applies. Pure |
| `calendars.ts` | Which calendar a clock counts in |
| `sla.service.ts` | Reads the facts, calls the above, writes what changed, and the outbox rows |
| `sla-hooks.ts` | The lifecycle hooks M1-08 left, filled |
| `escalation.ts`, `sla-timers.ts`, `sla-worker.ts` | The worker: firing a step, keeping BullMQ's timers in line, `sla.rebuild` |

**Elapsed is accumulated, not recomputed.** A clock stores `elapsed_ms` up to
`checkpoint_at`; what runs after is counted in the calendar in force now. Any
change moves the checkpoint to its own moment first, under the calendar the
clock was counting in, so a change of department, policy or hours only ever
affects time not yet counted (§3.3). That is also how a save on the Business
hours tab keeps the time already counted.

| The ticket | The clocks |
|---|---|
| created, continued (§2.3) or split (§2.4) | first-response and resolution clocks start at that moment; outside the hours they start counting at the next opening |
| moved to a status with `pauses_sla` | pause; `due_at` is null. On resume `due_at = now + remaining` (§3.2) |
| priority, department or policy changed | retargeted; a target already used up is a breach recorded at the change, attributed in the activity log (`ticket.sla.breached`, `cause: change`) |
| a public reply by staff | the response clock is met |
| closed | the resolution clock is met; an unmet response clock stops without a verdict |
| closed as spam, soft-deleted, or merged | both clocks stop without a verdict; an unmerge restarts them, leaving the merged time out |
| reopened | the old clocks are kept for reports; a next-response clock (the first-response target) and a resolution clock (the full target) start at the reopen, `tickets.sla_cycle + 1` |
| moves out of every policy | clocks stop (`no_policy`); moving back in restarts them with the time already counted |

A policy that starts to apply to a ticket later (its priority was raised into
it) starts clocks at that moment; no first-response clock is owed once staff
have replied.

`tickets.first_response_due_at`, `resolution_due_at`, `sla_breached`,
`sla_policy_id` and `sla_cycle` are the clocks' summary, for lists and views.
Writing them leaves `updated_at` alone: a clock moving is not somebody working
the ticket.

### What counts as a response

`SlaService.recordResponse(tx, { brandId, ticketId, at, by, countsAsResponse })`
— or the `onResponded` lifecycle hook, which calls it:

| `by` | Counts |
|---|---|
| `staff` | always (a public reply from `TicketsService.addMessage`) |
| `ai` | when the brand's `aiCountsAsFirstResponse` is on (M7's auto-reply) |
| `rule` | only when the rule action sets `countsAsResponse: true` (M3-03's "send canned response") |

Auto-acknowledgments, out-of-hours notices, notes and CSAT messages never call
it.

### The lifecycle hooks

M3-02 fills every moment of `apps/api/src/tickets/lifecycle/hooks.ts` and adds
three: `onCreated` (every path that inserts a ticket calls it, M2's inbound
email included: `ConversationRouter` calls it when a mail opens a ticket, and
a customer's mailed reply goes through `onCustomerReply` like one typed in the
portal, so it resumes a paused clock or reopens the ticket), `onChanged` (after any status, priority or department write)
and `onResponded`. `SlaLifecycleHooks` extends M1-12's survey hooks, so
`TicketsModule` provides it in one line.

## Timers

A timer is a BullMQ delayed job on the `sla` queue, `sla.timer`, one per clock
and step, keyed `sla.<ticket_id>.<clock>.<step>` — DOMAIN-RULES §3.4's
`sla:<ticket_id>:<clock>:<step>` with dots, because BullMQ refuses a colon in a
custom id. The breach is the step at 100 %.

No request adds one. Any change to a ticket's clocks writes an `sla.schedule`
outbox row in the same transaction; its handler removes the timers the clocks
no longer want (a paused clock wants none) and adds or moves the rest.

When a timer fires, it reads the clock under a lock on its ticket. A clock that
stopped counting, or a step already fired, ends the job. A timer that is early
— the clock was paused or retargeted after it was added — moves itself to the
right moment. Otherwise the step is marked fired (`fired_steps`, never to run
again), the breach recorded at 100 % (once per clock, at the due time rather
than the job's lateness), the step's actions run, and the outbox rows below go
out. A skipped action — a deleted tag, somebody who can no longer work the
department — does not stop the rest.

`sla.rebuild` runs when the worker boots and hourly after. With no brand it
adds one per brand; with a brand it re-plans the timers of every ticket with a
running clock. That is what makes Redis disposable (DOMAIN-RULES §10): the
integration suite wipes Redis with tickets open, restarts the SLA worker, and
finds every timer back at its time.

## Events

| Outbox event | Payload | Written when |
|---|---|---|
| `sla.schedule` | `{ ticketIds }` | any clock of these tickets changed |
| `sla.warning` | `{ ticketId, departmentId, clock, stepPercent, notify? }` | a step below 100 % ran |
| `sla.breached` | `{ ticketId, departmentId, clock, cause: 'timer' \| 'change' }` | a clock breached |
| `ticket.escalated` | as `sla.warning` | a step at or past 100 % ran, or a step set status Escalated |

`notify` is `{ userIds, teamIds, departmentLeads }`, from the step's notify
actions. M3-07's notifications consume the last three. Workflow rules consume
`sla.warning` and `sla.breached` as their SLA warning and SLA breach triggers
([the automation guide](automation.md)); for an event nobody else has claimed —
today `ticket.escalated` — the worker registers a handler that logs it. A step also writes `ticket.sla.step` to the activity
log and `ticket.updated` to the outbox, so open screens refresh.

## What a ticket read carries

`GET …/tickets/:ticketId` adds `sla` (`ticketSlaSchema`): the state, the policy,
the current clocks with business time elapsed at the read, the step that ran
last with its actions, the reopen time and how the initial response ended. The
list adds `ticket.sla` (`ticketSlaSummarySchema`): the state and the business
time left on the clock due first. The screens draw both as the artboard
`Admin/Ticket-SLA` does; neither ticks, and the `/staff` socket refreshes them
when a clock moves.

## Endpoints

| Route | Declaration | Answers |
|---|---|---|
| `GET /api/brands/:brandId/business-hours` | `@Requires('ticketing:manage')` | The brand's zone and week, each department's override, the holidays, and how many tickets have running clocks |
| `PUT /api/brands/:brandId/business-hours` | `@Requires('ticketing:manage')` | The brand's hours and every override together. Recomputes |
| `POST /api/brands/:brandId/holidays` | `@Requires('ticketing:manage')` | `{ name, startsOn, endsOn?, departmentId }`. Recomputes |
| `DELETE /api/brands/:brandId/holidays/:holidayId` | `@Requires('ticketing:manage')` | Recomputes |
| `GET /api/brands/:brandId/sla-policies` | `@Requires('ticketing:manage')` | The policies in order, each with its running ticket count and who changed it last |
| `POST /api/brands/:brandId/sla-policies` | `@Requires('ticketing:manage')` | Creates one at the end. Recomputes |
| `POST …/sla-policies/reorder` | `@Requires('ticketing:manage')` | The whole order. Admin only. Recomputes |
| `PUT …/sla-policies/:policyId` | `@Requires('ticketing:manage')` | The whole policy. Recomputes |
| `DELETE …/sla-policies/:policyId` | `@Requires('ticketing:manage')` | Its tickets fall to the next policy that matches. Recomputes |
| `PATCH …/ticketing/sla-settings` | `@Requires('ticketing:manage')` | `aiCountsAsFirstResponse`, `slaCountReopens` |

Every change writes an audit row (`business_hours.updated`, `holiday.*`,
`sla_policy.*`, `brand.sla_settings.updated`).

## Data model

| Table | Scope | Notes |
|---|---|---|
| `business_hours` | tenant | One brand row (`department_id` null, `timezone` null: the brand's zone is `brands.timezone`) and one per overridden department. `weekly` is validated by `weeklyHoursSchema` |
| `holidays` | tenant | `department_id` null closes every department |
| `sla_policies` | tenant | `conditions`, `targets` and `escalation` are JSON validated by the policy schemas; a row whose JSON no longer parses applies to no ticket |
| `ticket_sla_clocks` | tenant, **department** | One row per clock per cycle; `is_current` marks the cycle in force. Department copied from the ticket and moved with it by the triggers of `0008` |

`tickets` gains `sla_policy_id` and `sla_cycle`. Migration
`0026_sla_engine.sql`.

## Known gaps

- Compliance reports are M8; `slaCountReopens` is stored and served for them.
- "Time waiting on the customer" is `paused_total_ms` per clock; nothing
  reports it yet.
- The escalation action picker lists every team of the brand and every active
  person; it does not check that they can reach the policy's departments. An
  action that cannot be carried out is skipped when the step runs.
