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
- [ ] The four worked examples in DOMAIN-RULES §3.6 pass as unit tests to the minute.
- [ ] Deleting Redis while tickets are open and restarting the worker recreates every timer.
- [ ] Rule loop is prevented by a test.

## Open questions

- None yet.

## Pull requests

- None yet.
