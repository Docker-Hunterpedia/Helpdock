# 0036 Bulk changes as previewed, all-or-nothing operations with a short undo

Status: accepted
Date: 2026-10-20

## Context

Agents need to change many tickets at once: close thirty, assign twelve, tag a
week's billing tickets. Helpdock 1.0 has no bulk endpoint. Every single-ticket
change goes through `TicketsService` with its authorization, transition, SLA
and assignment rules, writes activity and outbox events, and fires rules.
Department scope is enforced by row-level security, so a ticket in another
department is `not_found`.

A bulk change multiplies the cost of a mistake: fifty surveys, fifty customer
emails, fifty irreversible deletes.

The plan is [M14-03 and M14-04 in M14 Inbox productivity](../in-development/M14-inbox-productivity.md#m14-03-bulk-edit-api);
owner decisions D-22, D-23 and D-24.

## Decision

1. **Preview, then apply.** `POST /tickets/bulk` takes 1–50 ticket ids,
   the changes and a mode. Preview reads each ticket under the caller's RLS,
   runs the same checks as a single edit and writes nothing, answering per
   ticket `will_change`, `unchanged`, `refused` (with the existing refusal code)
   or `not_found`.
2. **All or nothing.** Apply takes `expect`, the ids the preview said would
   change, and runs in one transaction. Each ticket goes through the method a
   single edit uses, in ticket-number order so locks are taken in a fixed order,
   writing the same activity (`via: 'bulk'` with the operation id), outbox
   events and rule runs. If any expected ticket is now refused or gone, the
   whole apply rolls back with `bulk-changed` (409) and the client previews
   again.
3. **What bulk may change:** status (not Snoozed directly; snooze is its own
   change), close, priority, assignee, team, department, tags added and removed,
   snooze and wake, mark spam (never block sender), one custom field value.
   **Never:** replies, notes, macros with a reply, merge, split, delete.
4. **Undo within 60 seconds, by the actor.** Apply writes an operation row and
   one item per changed ticket with before and after values (ids and enums,
   never text). Undo reverts each field whose current value still equals what
   the operation set, leaves and reports any field changed since, withdraws the
   operation's unread notifications, and is itself one transaction with the same
   checks (`via: 'bulk_undo'`). What has left the install is not recalled.
5. **Surveys wait for the undo window.** A bulk close publishes its
   `csat.requested` job with a 60 s delay; the consumer already skips a survey
   whose close no longer stands, so an undone close sends none.
6. Limits: 50 tickets, 20 operations a minute per person; staff only, not in
   public API v1. Operations and items are kept 7 days.

## Consequences

- "What you previewed is what happened" holds, and a slip can be taken back.
- Every bulk change has exactly the side effects of the same changes made one
  by one; there is no second code path to keep in sync.
- A transaction holds row locks on up to 50 tickets; the fixed lock order and
  the absence of network calls inside (everything goes through the outbox)
  bound that.
- A colleague's change in between survives an Undo.
- Two new tenant tables, one department-scoped, join the RLS negative suite.
- DOMAIN-RULES gains §2.7 Bulk changes (number provisional).

## Alternatives considered

- **Partial success** (commit what can be done, report the rest): the result no
  longer matches what the person approved, and retrying the rest is error-prone.
- **Bulk replies, merges and deletes:** blast radius too large for one click;
  each keeps its own careful flow.
- **A longer undo or a full history editor:** undo is for a slip; the activity
  log keeps everything.
- **Surveys sent at once, or a "don't send surveys" box:** the first makes undo
  unable to take back fifty emails; the second changes D §2.2's close rule.
