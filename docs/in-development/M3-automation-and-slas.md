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
| M3-06 | Macros and canned responses | #93 | in review: `canned_responses`, Automation › Macros, the composer's macro picker; [guide](../guides/macros.md) |
| M3-07 | Notifications: in-app, email and web push | #94 | in review: `notifications`, `notification_prefs`, `push_subscriptions`, the bell, Your account › Notifications, the staff email, web push; [guide](../guides/notifications.md) |
| M3-08 | Admin audit log viewer | #95 | in review: `GET /api/install/audit-log`, System › Audit log; [guide](../guides/audit-log.md) |

## Artboards

On the [design canvas](https://claude.ai/artifact/RQd32d1RXK8DST8SKC1VBQ), under "M3 Automation and SLAs": `Admin/Ticketing-BusinessHours`, `Admin/Ticketing-SLAs`, `Admin/Ticket-SLA`, `Admin/Automation-Rules`, `Admin/Rule-Builder`, `Admin/Automation-Macros`, `Admin/Composer-Macros`, `Admin/Notifications`, `Email/Staff-Notification`, `Admin/Audit-Log`.

## Exit criteria

- [x] A rule "on create, if subject contains X, assign to team Y and reply with canned Z" runs and is logged (`apps/api/src/rules/rules.integration.test.ts`, with a real M3-06 canned response).
- [x] An SLA breach fires escalation and a notification, and pauses correctly on Awaiting customer (`apps/api/src/sla/sla.integration.test.ts`, "a breach, its escalation and the notification": a first response passes its target, `sla.breached` and `ticket.escalated` fire, the step's named person gets a `notifications` row and `notification.created` through the worker's dispatcher, and a ticket on Awaiting customer pauses and its timer breaches nothing).
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
and Time-based tabs, the builder and its test run; the Macros tab is M3-06's.
Tables `workflow_rules`, `workflow_runs`; `tickets.status_changed_at` and its
trigger; migration `0027_workflow_rules`. [Guide](../guides/automation.md).

- **Seams.** `apps/api/src/rules/ports.ts`. `BusinessHoursProbe` is M3-01's
  calendar through `businessHoursProbe` (`apps/api/src/sla/business-hours-probe.ts`),
  wired in `RulesModule.forRoot` and `createRulesEngineDeps`.
  `CannedResponseRenderer` and `CannedResponseCatalog` are M3-06's
  `CannedResponsesService` through `cannedResponsePort`
  (`apps/api/src/macros/canned-response-port.ts`), in both places: a rule
  reads shared canned responses only, renders in the contact's language with
  the assignee as `{{agent.first_name}}`, and a missing one is recorded as not
  carried out.
- **Clocks.** The engine's lifecycle is the SLA hooks, so a rule's status,
  priority or team move calls `onChanged` and its close and reopen move the
  clocks as an agent's would. A canned reply calls `onResponded` with
  `by: 'rule'` and the action's `counts_as_response`, which is what meets the
  first- or next-response clock (DOMAIN-RULES §3.1).
- **Events.** Rules consume `ticket.created`, `ticket.updated`, `ticket.replied`,
  `ticket.closed`, `ticket.reopened`, `sla.warning`, `sla.breached`,
  `csat.received` (nothing emits the last yet). Rules emit `rule.notify`
  (`{ ticketId, recipients, message, ruleId }`) for M3-07, and ticket events
  with `ruleChain`. The rules subscribe to those events as `rules`, beside
  each event's owner (see M3-07 below for the dispatcher).
- **Gap:** a Team Leader whose scope is narrower than the brand may read rules
  and the log but not change a rule, because a rule acts on every department.

### M3-06 Macros and canned responses

- One table, `canned_responses`, told apart by `kind` (`canned` | `macro`): a macro is a canned response plus actions, and the artboard lists, searches and scopes them together. Bodies are `{ en, ar }` jsonb; actions are `macroActionSchema[]`. Personal items use the restrictive owner policy `views` has (`OWNER_SCOPED_TABLES`); shared items carry `department_id` (null is every department), a service rule (`macros/macro-rules.ts`).
- Placeholders: M1-06's list plus `{{agent.first_name}}`. The renderer moved to `packages/schemas/src/placeholders.ts` so the admin preview and the api share it.
- Applying a macro (`POST …/tickets/:ticketId/macro-runs`) sends the reply and the kept actions in one transaction and writes one `ticket.macro_applied` activity row. `TicketsService.update` takes an optional activity bundle for that; lifecycle rows (close, reopen) are still their own.
- Seam for M3-03: `CannedResponsesService.render(id, { locale, ticket, agent?, tx? })` and `listShared(tx)`, exported from `MacrosModule` and wired into the rules engine (see M3-03 to M3-05 above).
- Screens: the Macros tab of the rules' Automation page (an Agent sees that tab alone), the composer picker (toolbar button, header Macro button, `/`), staged action chips.

### M3-07 Notifications

- **Built:** the bell and its panel in the sidebar's brand row; Your account
  (`/me`) as one page with Security, Notifications and M2-05's Email signature
  tabs (`apps/admin/src/screens/account/`); the staff notification email (en,
  ar) from the install's system sender; web push (VAPID, ADR 0002) with a
  service worker at `/sw.js`. [Guide](../guides/notifications.md).
- **Tables (migration `0029_notifications`):** `notifications` (tenant, brand
  policy plus a restrictive owner policy that lets the `system` principal write
  — `OWNER_SCOPED_TABLES` with `systemWrites`), `notification_prefs` and
  `push_subscriptions` (global, like `users`).
- **Events consumed:** `ticket.assigned` (new), `ticket.replied`,
  `ticket.note_added`, `sla.warning`, `sla.breached`, `ticket.escalated` and
  `rule.notify`. Emitted: `notification.created`, `notification.push_test`.
  Jobs: `notify.email`, `notify.push` on the `notify` queue.
- **Dispatcher (`packages/jobs`).** One design for both branches: an event has
  several handlers, one per named subscriber; the module that owns the event
  takes the default slot, and the others name themselves (`rules`,
  `notifications`). They run in registration order, which is the worker's
  start-up order (tickets, CSAT, media, assignment, email, mailboxes, rules,
  SLA, notifications). The same subscriber twice for an event, or the same
  function twice under two names, is refused. M3-02's log-only stand-in for
  the SLA events and M3-03's for `rule.notify` are gone: notifications consume
  them.
- **Seams wired:** `ticket.assigned` is written by `TicketsService` (a person;
  a macro's assign action goes through it, so it carries the person who ran
  the macro), `autoAssign` (the rotation, or `'rule'` when a rule asked for the
  pick) and the rules engine's assign-agent action (`assignedBy: 'rule'`).
  `rule.notify` is delivered to the resolved recipients as an `escalated`
  notification whose detail carries the rule and its message. An SLA step's
  notify actions travel flat on `sla.warning` and `ticket.escalated` as
  `userIds`, `teamIds` and `departmentLeads` (was a nested `notify`), and reach
  those people, team members and Team Leaders.
- **Left open:** the first-run wizard does not generate the VAPID pair (ADR
  0002 foresees it); keys come from `HD_PUSH_VAPID_*` or the settings table.
  Notification rows are not purged by retention. A rule's *Notify* shares the
  Escalation preference row rather than having its own kind: a row of its own
  would need an artboard.

### M3-08 Admin audit log viewer

- `GET /api/install/audit-log` (install:admin): filters, `(created_at, id)` keyset cursor, before/after diff with secrets redacted by name and by the settings registry.
- Migration 0028 adds `audit_log.ip`, `request_id`, `user_agent`, defaulting to `app.request_*` settings the tenant interceptor sets on every request transaction, and `audit_log_created_at_id_idx`.
- Page at `/admin/system/audit-log`; the System page's Audit card "Open" links to it.

## Open questions

- None yet.

## Pull requests

- None yet.

## Migrations

- `0026_sla_engine`: business hours, holidays, SLA policies and clocks (M3-01, M3-02).
- `0027_workflow_rules`: `workflow_rules`, `workflow_runs`, `tickets.status_changed_at` and its trigger (M3-03, M3-04).
- `0028_macros_and_audit_context`: `canned_responses`, `audit_log.ip`, `request_id` and `user_agent`, and `audit_log_created_at_id_idx` (M3-06, M3-08).
- `0029_notifications`: `notifications`, `notification_prefs`, `push_subscriptions` and the `notification_kind` enum (M3-07).
