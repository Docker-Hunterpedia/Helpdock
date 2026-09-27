# M3 Automation and SLAs

Status: in progress
Started: 2026-09-27
Owner: @Docker-Hunterpedia

## Scope

[PRD, M3 Automation and SLAs](../planning/PRD.md#m3-automation-and-slas). Depends on M1; runs in parallel with M2.

## Deliverables

| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M3-01 | Business hours, holidays and time zones | #88 | done — `business_hours`, `holidays`, Ticketing › Business hours; M2-06's out-of-hours auto-reply reads it |
| M3-02 | SLA engine | #89 | done — `sla_policies`, `ticket_sla_clocks`, `sla.timer` and `sla.rebuild`; clocks start on every ticket creation path, email included |
| M3-03 | Workflow rules engine | #90 | not started |
| M3-04 | Time-based rules | #91 | not started |
| M3-05 | Rule builder UI with test-run | #92 | not started |
| M3-06 | Macros and canned responses | #93 | not started |
| M3-07 | Notifications: in-app, email and web push | #94 | not started |
| M3-08 | Admin audit log viewer | #95 | not started |

## Artboards

On the [design canvas](https://claude.ai/artifact/RQd32d1RXK8DST8SKC1VBQ), under "M3 Automation and SLAs": `Admin/Ticketing-BusinessHours`, `Admin/Ticketing-SLAs`, `Admin/Ticket-SLA`, `Admin/Automation-Rules`, `Admin/Rule-Builder`, `Admin/Automation-Macros`, `Admin/Composer-Macros`, `Admin/Notifications`, `Email/Staff-Notification`, `Admin/Audit-Log`.

## Exit criteria

- [ ] A rule "on create, if subject contains X, assign to team Y and reply with canned Z" runs and is logged.
- [ ] An SLA breach fires escalation and a notification, and pauses correctly on Awaiting customer.
- [x] The four worked examples in DOMAIN-RULES §3.6 pass as unit tests to the minute (`apps/api/src/sla/ticket-clocks.test.ts`).
- [x] Deleting Redis while tickets are open and restarting the worker recreates every timer (`apps/api/src/sla/sla.integration.test.ts`).
- [ ] Rule loop is prevented by a test.

## Notes

### M3-01 Business hours

Ticketing › Business hours (`Admin/Ticketing-BusinessHours`): brand zone and
week, holidays, per-department overrides. The calendar arithmetic is pure and
lives in `@helpdock/schemas` (`isWithinBusinessHours`, `addBusinessTime`,
`businessMsBetween`, `nextOpening`); `BusinessHoursService.calendarFor(brandId,
departmentId, tx?)` is the api seam for M2's out-of-hours notice and M3-04's
conditions. Tables `business_hours`, `holidays`. A brand that never saved hours
counts Monday–Friday 09:00–17:00. [Guide](../guides/slas.md#business-hours).

### M3-02 SLA engine

Ticketing › SLAs (`Admin/Ticketing-SLAs`), the DetailsPanel SLA card and the
list's SlaTimer (`Admin/Ticket-SLA`). Tables `sla_policies`,
`ticket_sla_clocks`; `tickets.sla_policy_id`, `tickets.sla_cycle`; migration
`0026_sla_engine`. Clocks change inside the ticket's own transaction through
the lifecycle hooks (`onCreated`, `onChanged` and `onResponded` are new);
timers are `sla.timer` jobs re-planned by the `sla.schedule` outbox handler, and
`sla.rebuild` runs on boot and hourly. Emits `sla.warning`, `sla.breached` and
`ticket.escalated` (no M1 escalation event existed). The rules agent's
`counts_as_response` hook is `SlaService.recordResponse(tx, { by: 'rule',
countsAsResponse })`. [Guide](../guides/slas.md).

Decisions the spec left open, recorded in the guide: an unmet response clock
stops without a verdict when the ticket closes; spam, soft deletion and merge
stop both clocks; a policy that starts to apply later starts clocks at that
moment; a ticket that leaves every policy keeps its elapsed time for when it
comes back.

## Open questions

- None yet.

## Pull requests

- None yet.
