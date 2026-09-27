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
| M3-07 | Notifications: in-app, email and web push | #94 | built in branch |
| M3-08 | Admin audit log viewer | #95 | not started |

## Artboards

On the [design canvas](https://claude.ai/artifact/RQd32d1RXK8DST8SKC1VBQ), under "M3 Automation and SLAs": ARTBOARDS_M3.

## Exit criteria

- [ ] A rule "on create, if subject contains X, assign to team Y and reply with canned Z" runs and is logged.
- [ ] An SLA breach fires escalation and a notification, and pauses correctly on Awaiting customer.
- [ ] The four worked examples in DOMAIN-RULES §3.6 pass as unit tests to the minute.
- [ ] Deleting Redis while tickets are open and restarting the worker recreates every timer.
- [ ] Rule loop is prevented by a test.

## M3-07 notes

- **Built:** the bell and its panel in the sidebar's brand row; Your account (`/me`)
  with Security moved under it, the Notifications tab, and a stub Email signature
  tab for M2's outbound email to replace; the staff notification email (en, ar)
  from the install's system sender; web push (VAPID) with a service worker at
  `/sw.js`. Guide: [notifications](../guides/notifications.md).
- **Tables (migration `0029_notifications`):** `notifications` (tenant, brand
  policy plus a restrictive owner policy that lets the `system` principal write),
  `notification_prefs` and `push_subscriptions` (global, like `users`).
- **Events consumed:** `ticket.assigned` (new, written by `TicketsService` and
  `autoAssign`), `ticket.replied`, `ticket.note_added`, and the SLA seam's
  `sla.warning`, `sla.breached`, `ticket.escalated`. Emitted:
  `notification.created`, `notification.push_test`. Jobs: `notify.email`,
  `notify.push` on the `notify` queue.
- **`packages/jobs`:** the outbox dispatcher now takes several handlers per
  event, one per named subscriber, so notifications subscribe beside the event's
  owner.
- **Seams to wire:** the rules engine's "assign" action writes
  `ticket.assigned` with `assignedBy: 'rule'` (`enqueueTicketAssigned`); the SLA
  engine's escalation may name `userIds` and `teamIds` on `ticket.escalated`.
- **Left open:** the first-run wizard does not generate the VAPID pair (ADR 0002
  foresees it); keys come from `HD_PUSH_VAPID_*` or the settings table.
  Notification rows are not purged by retention.

## Open questions

- None yet.

## Pull requests

- None yet.
