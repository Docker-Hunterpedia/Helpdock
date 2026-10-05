# M3 Automation and SLAs

Status: shipped
Started: 2026-09-27
Shipped: 2026-09-27
Owner: @Docker-Hunterpedia

## Scope

The desk keeps its promises without a person watching the clock. Brands and
departments get business hours and holidays. Every ticket runs a
first-response clock and a resolution clock under an SLA policy, with warnings,
breaches and escalation steps. Workflow rules act on ticket, SLA and CSAT
events, and time-based rules act on tickets that have waited too long. Rules
are built and test-run in the admin, and a depth guard stops loops. Agents
answer with macros and canned responses in English and Arabic. Staff are told
what concerns them in the app, by email and by web push. Install admins read
the audit log.

Full deliverable list and specs: [PRD §4 · M3 Automation and SLAs](../planning/PRD.md#m3-automation-and-slas).
Depends on M1 (shipped 2026-09-25). Ran in parallel with
[M2](M2-email-channel.md): M2's out-of-hours reply reads M3-01's calendar, and
emailed tickets start M3-02's clocks.

Built from the design canvas artboards, under "M3 Automation and SLAs":
`Admin/Ticketing-BusinessHours`, `Admin/Ticketing-SLAs`, `Admin/Ticket-SLA`,
`Admin/Automation-Rules`, `Admin/Rule-Builder`, `Admin/Automation-Macros`,
`Admin/Composer-Macros`, `Admin/Notifications`, `Email/Staff-Notification` and
`Admin/Audit-Log`.

## Deliverables

| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M3-01 | Business hours, holidays and time zones | #88 | shipped (#100) |
| M3-02 | SLA engine | #89 | shipped (#100) |
| M3-03 | Workflow rules engine | #90 | shipped (#101) |
| M3-04 | Time-based rules | #91 | shipped (#101) |
| M3-05 | Rule builder UI with test run | #92 | shipped (#101) |
| M3-06 | Macros and canned responses | #93 | shipped (#102) |
| M3-07 | Notifications: in-app, email and web push | #94 | shipped (#103) |
| M3-08 | Admin audit log viewer | #95 | shipped (#102) |

## Exit criteria

Copied from the PRD. All five are met. The integration suites run against real
Postgres and Redis (Testcontainers). The last full run is the one reported in
#103: 1122 integration tests and 3614 unit tests outside the admin.

- [x] **A rule "on create, if subject contains X, assign to team Y and reply
      with canned Z" runs and is logged.**
      `apps/api/src/rules/rules.integration.test.ts` › "workflow rules" › "runs
      and logs "on create, if subject contains refund, assign to a team and
      reply with a canned response" (M3 exit criterion)". The canned response
      is a real shared M3-06 item, and the rendered reply carries the ticket
      number.
- [x] **An SLA breach fires escalation and a notification, and pauses correctly
      on Awaiting customer.** `apps/api/src/sla/sla.integration.test.ts` › "SLA
      engine" › "a breach, its escalation and the notification (M3 exit
      criterion)":
      - "breaches the first response, escalates to the person the step names,
        and tells them": `sla.breached` and `ticket.escalated` fire, and the
        worker's dispatcher writes one `notifications` row for the named person
        and a `notification.created` frame;
      - "pauses a ticket set to Awaiting customer, so its timer breaches
        nothing".
- [x] **The four worked examples in DOMAIN-RULES §3.6 pass as unit tests to the
      minute.** `apps/api/src/sla/ticket-clocks.test.ts` › "DOMAIN-RULES §3.6",
      one test per example: "1. created Thursday 16:00…", "2. Awaiting customer
      from Sunday 09:30…", "3. Urgent at Tuesday 13:00…", "4. closed Tuesday
      14:00 is met…". The calendar arithmetic under them is
      `packages/schemas/src/business-hours.test.ts` (examples 1 and 2).
- [x] **Deleting Redis while tickets are open and restarting the worker
      recreates every timer.** `sla.integration.test.ts` › "timers" ›
      "recreates every timer after Redis is wiped and the worker restarts (M3
      exit criterion)".
- [x] **Rule loop is prevented by a test.** `rules.integration.test.ts` › "stops
      two rules that reassign each other at the cycle, and the loop ends (M3
      exit criterion)". The guard itself: `apps/api/src/rules/triggers.test.ts`
      › "guardRun" › "stops a rule that would run a second time in one chain,
      before it acts" and "stops a fourth rule even when it is not a cycle".

## Effort

| | |
|---|---|
| Estimated | 4–5 weeks (PRD status board) |
| Started | 2026-09-27 |
| Shipped | 2026-09-27 |
| Actual | 1 day, in parallel with M2 |

AI coding agents built business hours and SLAs, rules, macros and the audit
log, and notifications in parallel worktrees. Each was merged onto the one
before it, and the maintainer reviewed and merged the PRs.

## Migrations

- `0026_sla_engine`: `business_hours`, `holidays`, `sla_policies`,
  `ticket_sla_clocks` (department, moved with its ticket),
  `tickets.sla_policy_id` and `sla_cycle` (M3-01, M3-02).
- `0027_workflow_rules`: `workflow_rules` (brand), `workflow_runs`
  (department), `tickets.status_changed_at` with its trigger and backfill
  (M3-03, M3-04).
- `0028_macros_and_audit_context`: `canned_responses` (brand, with the owner
  policy for personal items), `audit_log.ip`, `request_id`, `user_agent` and
  `audit_log_created_at_id_idx` (M3-06, M3-08).
- `0029_notifications`: `notifications` (brand, owner policy with system
  writes), `notification_prefs` and `push_subscriptions` (global), the
  `notification_kind` enum (M3-07).

Every tenant table is in `TENANT_TABLES` and the RLS negative suite.

## Gaps and follow-ups

Written down and carried forward. None of them blocks M4, M5, M6 or M8.

| Gap | Why it was accepted | Where it is written down |
|---|---|---|
| ~~The first-run wizard does not generate the VAPID pair~~ | Closed in M9: finishing the wizard generates the pair when the install has none. | [notifications](../guides/notifications.md#known-gaps) |
| ~~Notification rows are not purged by retention~~ | Closed by follow-up #144: the nightly job deletes rows older than the panel's 30-day window. | [notifications](../guides/notifications.md#the-bell) |
| **A rule's Notify shares the Escalation preference** | A preference row of its own would need an artboard. | [M3-07 notes](#m3-07-notifications) |
| **Compliance reports for `slaCountReopens` wait for M8** | The setting is stored and served. Time waiting on the customer (`paused_total_ms`) is stored too, and nothing reports it yet. | [SLA guide](../guides/slas.md#known-gaps) |
| **The escalation action picker does not check reach** | It lists every team and active person of the brand. An action that cannot be carried out is skipped when the step runs. | [SLA guide](../guides/slas.md#known-gaps) |
| **`workflow_runs` keep the department the ticket had when the rule ran** | A run is a record of that moment, so a moved ticket's earlier runs stay readable to the old department's readers. | This doc |
| **A Team Leader narrower than the brand cannot change a rule** | A rule acts on every department of the brand. They can read rules and their departments' log. | [automation](../guides/automation.md#who-may-do-what) |
| **Nothing emits `csat.received` yet** | Rules can name the event. It fires once survey delivery (M8-06) emits it. | [automation](../guides/automation.md#a-rule) |
| ~~Auto-unassign still ignores business hours~~ | Closed in M9: `assignment.offline_unassign` reads the department's calendar and puts itself off to the next opening. | [ticketing settings](../guides/ticketing-settings.md#assignment) |
| **No screenshot baselines for the M3 screens** | The screenshots spec covers M0 and M1 screens; the shell baselines predate the Automation link and the bell. | [development guide](../guides/development.md#browser-tests) |

## What an operator can do with this milestone

Set a brand's time zone, week and holidays, and department overrides. Write SLA
policies with targets per priority and escalation steps. Build workflow and
time-based rules, test-run them against a real ticket, and read the execution
log. Share macros and canned responses in English and Arabic. Each staff
member chooses which events reach them in the app, by email or by browser push.
Install admins filter the audit log.

## Deliverable notes

### M3-01 Business hours

The calendar arithmetic is pure and lives in `@helpdock/schemas`
(`isWithinBusinessHours`, `addBusinessTime`, `businessMsBetween`,
`nextOpening`). `BusinessHoursService.calendarFor(brandId, departmentId, tx?)`
is the api seam for M2's out-of-hours notice and the rules' business-hours
condition. A brand that never saved hours counts Monday–Friday 09:00–17:00.
[Guide](../guides/slas.md#business-hours).

### M3-02 SLA engine

Clocks change inside the ticket's own transaction through the lifecycle hooks
(`onCreated`, `onChanged` and `onResponded` are new). Timers are `sla.timer`
jobs keyed `sla.<ticket>.<clock>.<step>` (BullMQ refuses colons, so
DOMAIN-RULES §3.4 was updated), re-planned by the `sla.schedule` outbox
handler. `sla.rebuild` runs on boot and hourly. The engine emits `sla.warning`,
`sla.breached` and `ticket.escalated`. [Guide](../guides/slas.md).

Decisions the spec left open, recorded in the guide:

- an unmet response clock stops without a verdict when the ticket closes;
- spam, soft deletion and merge stop both clocks;
- a policy that starts to apply later starts clocks at that moment;
- a ticket that leaves every policy keeps its elapsed time for when it comes
  back.

### M3-03 to M3-05 Workflow rules

- **Seams** (`apps/api/src/rules/ports.ts`). `BusinessHoursProbe` is M3-01's
  calendar through `sla/business-hours-probe.ts`. `CannedResponseRenderer` and
  `CannedResponseCatalog` are M3-06's `CannedResponsesService` through
  `macros/canned-response-port.ts`. Both are wired in `RulesModule.forRoot` and
  `createRulesEngineDeps`. A rule reads shared canned responses only, because
  a rule runs as nobody. A personal one is logged as not carried out.
- **Clocks.** A rule's status, priority or team move calls `onChanged`, as an
  agent's would. A canned reply calls `onResponded` with `by: 'rule'` and the
  action's `counts_as_response`, which is what meets a response clock
  (DOMAIN-RULES §3.1).
- **Events.** Rules consume `ticket.created`, `ticket.updated`,
  `ticket.replied`, `ticket.closed`, `ticket.reopened`, `sla.warning`,
  `sla.breached` and `csat.received`. They emit `rule.notify` and ticket events
  that carry `ruleChain`, which is what the depth guard reads.
  [Guide](../guides/automation.md).

### M3-06 Macros and canned responses

- One table, `canned_responses`, told apart by `kind` (`canned` | `macro`): a
  macro is a canned response plus actions. Bodies are `{ en, ar }`.
- Placeholders are M1-06's list plus `{{agent.first_name}}`. The renderer lives
  in `packages/schemas/src/placeholders.ts`, shared by the admin preview, the
  api and the email auto-replies.
- Applying a macro sends the reply and the kept actions in one transaction and
  writes one `ticket.macro_applied` activity row. [Guide](../guides/macros.md).

### M3-07 Notifications

- **Channels:** the bell and its panel in the sidebar's brand row; the staff
  email (en, ar) from the install's system sender; web push (VAPID, ADR 0002)
  with a service worker at `/sw.js`. Your account (`/me`) is one page with
  Security, Notifications and M2-05's Email signature tabs.
  [Guide](../guides/notifications.md).
- **Events consumed:** `ticket.assigned` (new), `ticket.replied`,
  `ticket.note_added`, `sla.warning`, `sla.breached`, `ticket.escalated` and
  `rule.notify`. A rule's Notify is delivered as an `escalated` notification
  carrying the rule and its message.
- **The outbox dispatcher (`packages/jobs`).** An event has one handler per
  named subscriber. The module that owns the event takes the default slot, and
  the others name themselves (`rules`, `notifications`). They run in the
  worker's start-up order; the same subscriber twice, or one function twice
  for an event, is refused.

### M3-08 Admin audit log viewer

`GET /api/install/audit-log` (`install:admin`) with filters, a `(created_at,
id)` keyset cursor, and a before/after diff with secrets redacted by name and
by the settings registry. Rows record the request's IP, id and user agent from
the `app.request_*` settings the tenant interceptor sets. The page is
`/admin/system/audit-log`. [Guide](../guides/audit-log.md).

## Pull requests

- #100 feat(sla): business hours, holidays and the SLA engine (M3-01, M3-02)
- #101 feat(rules): workflow rules engine, time-based rules and the rule builder (M3-03, M3-04, M3-05)
- #102 feat: macros and canned responses, and the admin audit log viewer (M3-06, M3-08)
- #103 feat(notifications): in-app, email and web push notifications with per-user preferences (M3-07)
