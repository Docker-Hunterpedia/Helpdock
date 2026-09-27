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
| M3-03 | Workflow rules engine | #90 | in review: engine, depth guard, execution log, `rule.notify`; [guide](../guides/automation.md) |
| M3-04 | Time-based rules | #91 | in review: five-minute tick on the `rules` queue, once per match |
| M3-05 | Rule builder UI with test-run | #92 | in review: `Admin/Automation` Rules and Time-based tabs, builder, test run |
| M3-06 | Macros and canned responses | #93 | not started |
| M3-07 | Notifications: in-app, email and web push | #94 | not started |
| M3-08 | Admin audit log viewer | #95 | not started |

## Artboards

On the [design canvas](https://claude.ai/artifact/RQd32d1RXK8DST8SKC1VBQ), under "M3 Automation and SLAs": `Admin/Ticketing-BusinessHours`, `Admin/Ticketing-SLAs`, `Admin/Ticket-SLA`, `Admin/Automation-Rules`, `Admin/Rule-Builder`, `Admin/Automation-Macros`, `Admin/Composer-Macros`, `Admin/Notifications`, `Email/Staff-Notification`, `Admin/Audit-Log`.

## Exit criteria

- [x] A rule "on create, if subject contains X, assign to team Y and reply with canned Z" runs and is logged (`apps/api/src/rules/rules.integration.test.ts`, with a test double for M3-06's canned responses).
- [ ] An SLA breach fires escalation and a notification, and pauses correctly on Awaiting customer.
- [x] The four worked examples in DOMAIN-RULES §3.6 pass as unit tests to the minute (`apps/api/src/sla/ticket-clocks.test.ts`).
- [x] Deleting Redis while tickets are open and restarting the worker recreates every timer (`apps/api/src/sla/sla.integration.test.ts`).
- [x] Rule loop is prevented by a test (`rules.integration.test.ts`: two rules that reassign each other are stopped at the cycle; `triggers.test.ts` for the guard itself).

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

### M3-03 to M3-05 Workflow rules

Admin › Automation (`Admin/Automation-Rules`, `Admin/Rule-Builder`): the Rules
and Time-based tabs, the builder and its test run; the Macros tab is M3-06's
placeholder. Tables `workflow_rules`, `workflow_runs`; `tickets.status_changed_at`
and its trigger; migration `0027_workflow_rules`. [Guide](../guides/automation.md).

- **Seams.** `apps/api/src/rules/ports.ts`. `BusinessHoursProbe` is M3-01's
  calendar through `businessHoursProbe` (`apps/api/src/sla/business-hours-probe.ts`),
  wired in `RulesModule.forRoot` and `createRulesEngineDeps`.
  `CannedResponseRenderer` and `CannedResponseCatalog` stay on their
  stand-ins until M3-06: a canned reply is recorded as not carried out and the
  builder lists no canned responses.
- **Clocks.** The engine's lifecycle is the SLA hooks, so a rule's status,
  priority or team move calls `onChanged` and its close and reopen move the
  clocks as an agent's would. A canned reply calls `onResponded` with
  `by: 'rule'` and the action's `counts_as_response`, which is what meets the
  first- or next-response clock (DOMAIN-RULES §3.1).
- **Events.** Rules consume `ticket.created`, `ticket.updated`, `ticket.replied`,
  `ticket.closed`, `ticket.reopened`, `sla.warning`, `sla.breached`,
  `csat.received` (nothing emits the last yet). Rules emit `rule.notify`
  (`{ ticketId, recipients, message, ruleId }`) for M3-07, and ticket events
  with `ruleChain`. The outbox dispatcher runs every handler registered for an
  event, in registration order; the worker registers the rules handlers before
  the SLA ones, so M3-02's log-only fallback now covers `ticket.escalated` only.
- **Gap:** a Team Leader whose scope is narrower than the brand may read rules
  and the log but not change a rule, because a rule acts on every department.

## Open questions

- None yet.

## Pull requests

- None yet.

## Migrations

- `0026_sla_engine`: business hours, holidays, SLA policies and clocks (M3-01, M3-02).
- `0027_workflow_rules`: `workflow_rules`, `workflow_runs`, `tickets.status_changed_at` and its trigger (M3-03, M3-04).
