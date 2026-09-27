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
| M3-06 | Macros and canned responses | #93 | in review |
| M3-07 | Notifications: in-app, email and web push | #94 | not started |
| M3-08 | Admin audit log viewer | #95 | in review |

## Artboards

On the [design canvas](https://claude.ai/artifact/RQd32d1RXK8DST8SKC1VBQ), under "M3 Automation and SLAs": ARTBOARDS_M3.

## Notes

### M3-06 Macros and canned responses

- One table, `canned_responses`, told apart by `kind` (`canned` | `macro`): a macro is a canned response plus actions, and the artboard lists, searches and scopes them together. Bodies are `{ en, ar }` jsonb; actions are `macroActionSchema[]`. Personal items use the restrictive owner policy `views` has (`OWNER_SCOPED_TABLES`); shared items carry `department_id` (null is every department), a service rule (`macros/macro-rules.ts`).
- Placeholders: M1-06's list plus `{{agent.first_name}}`. The renderer moved to `packages/schemas/src/placeholders.ts` so the admin preview and the api share it.
- Applying a macro (`POST …/tickets/:ticketId/macro-runs`) sends the reply and the kept actions in one transaction and writes one `ticket.macro_applied` activity row. `TicketsService.update` takes an optional activity bundle for that; lifecycle rows (close, reopen) are still their own.
- Seam for M3-03: `CannedResponsesService.render(id, { locale, ticket, agent?, tx? })`, exported from `MacrosModule`.
- Screens: Automation shell with Rules / Time-based as "not built yet" (the rules agent replaces them), the Macros tab, the composer picker (toolbar button, header Macro button, `/`), staged action chips.

### M3-08 Admin audit log viewer

- `GET /api/install/audit-log` (install:admin): filters, `(created_at, id)` keyset cursor, before/after diff with secrets redacted by name and by the settings registry.
- Migration 0028 adds `audit_log.ip`, `request_id`, `user_agent`, defaulting to `app.request_*` settings the tenant interceptor sets on every request transaction, and `audit_log_created_at_id_idx`.
- Page at `/admin/system/audit-log`; the System page's Audit card "Open" links to it.

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
