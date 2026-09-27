# M3 Automation and SLAs

Status: in progress
Started: 2026-09-27
Owner: @Docker-Hunterpedia

## Scope

[PRD, M3 Automation and SLAs](../planning/PRD.md#m3-automation-and-slas). Depends on M1; runs in parallel with M2.

## Deliverables

| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M3-01 | Business hours, holidays and time zones | #88 | not started |
| M3-02 | SLA engine | #89 | not started |
| M3-03 | Workflow rules engine | #90 | in review: engine, depth guard, execution log, `rule.notify`; [guide](../guides/automation.md) |
| M3-04 | Time-based rules | #91 | in review: five-minute tick on the `rules` queue, once per match |
| M3-05 | Rule builder UI with test-run | #92 | in review: `Admin/Automation` Rules and Time-based tabs, builder, test run |
| M3-06 | Macros and canned responses | #93 | not started |
| M3-07 | Notifications: in-app, email and web push | #94 | not started |
| M3-08 | Admin audit log viewer | #95 | not started |

## Artboards

On the [design canvas](https://claude.ai/artifact/RQd32d1RXK8DST8SKC1VBQ), under "M3 Automation and SLAs": ARTBOARDS_M3.

## Exit criteria

- [x] A rule "on create, if subject contains X, assign to team Y and reply with canned Z" runs and is logged (`apps/api/src/rules/rules.integration.test.ts`, with a test double for M3-06's canned responses).
- [ ] An SLA breach fires escalation and a notification, and pauses correctly on Awaiting customer.
- [ ] The four worked examples in DOMAIN-RULES §3.6 pass as unit tests to the minute.
- [ ] Deleting Redis while tickets are open and restarting the worker recreates every timer.
- [x] Rule loop is prevented by a test (`rules.integration.test.ts`: two rules that reassign each other are stopped at the cycle; `triggers.test.ts` for the guard itself).

## Notes

- **M3-03/04/05 seams to wire at integration.** `apps/api/src/rules/ports.ts`:
  `CannedResponseRenderer` (M3-06's `CannedResponsesService.render(id, { locale, ticket })`,
  with `tx` in the options because the engine runs in the worker) and
  `CannedResponseCatalog` for the builder's select, both passed to
  `createRulesEngineDeps` and `RulesModule.forRoot`; `BusinessHoursProbe`
  (M3-01). Until wired: a canned reply is recorded as not carried out, the
  builder lists no canned responses, and every department is open.
- **Events.** Rules consume `ticket.created`, `ticket.updated`, `ticket.replied`,
  `ticket.closed`, `ticket.reopened`, `sla.warning`, `sla.breached`,
  `csat.received` (nothing emits the last yet). Rules emit `rule.notify`
  (`{ ticketId, recipients, message, ruleId }`) for M3-07, and ticket events
  with `ruleChain`; a canned reply's `ticket.replied` carries
  `countsAsResponse` for M3-02. The outbox dispatcher now runs every handler
  registered for an event, so M3-02 and M3-07 register beside M1's.
- **Macros tab** is M3-06's: `/admin/automation/macros` draws a placeholder
  that names the deliverable.
- **Gap:** a Team Leader whose scope is narrower than the brand may read rules
  and the log but not change a rule, because a rule acts on every department.

## Open questions

- None yet.

## Pull requests

- None yet.

## Migrations

- `0027_workflow_rules`: `workflow_rules`, `workflow_runs`, `tickets.status_changed_at` and its trigger (M3-03, M3-04). Number reserved for this wave; the orchestrator renumbers.
