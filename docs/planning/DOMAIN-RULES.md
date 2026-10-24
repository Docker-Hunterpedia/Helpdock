# Helpdock — Domain rules and contracts

Status: planning
Version: 1.0 (2026-09-16)

[REQUIREMENTS.md](REQUIREMENTS.md) lists features. [ARCHITECTURE.md](ARCHITECTURE.md) lists components. This document defines the behaviours that sit between them: who may do what, how tickets move, how clocks run, who owns a conversation, and what happens when things fail. Every rule here is testable and is referenced by a deliverable id in the [PRD](PRD.md). If an implementation and this document disagree, the implementation is wrong until this document is changed by PR.

---

## 1. Authorization

### 1.1 Principal

```ts
type Principal =
  | { type: 'staff';   id: uuid; brands: Record<uuid, { role: 'admin'|'team_leader'|'agent'|'viewer'; departmentIds: uuid[] | 'all' }>; installAdmin: boolean }
  | { type: 'visitor'; id: uuid; brandId: uuid; conversationIds: uuid[]; verifiedContactId?: uuid }
  | { type: 'apikey';  id: uuid; brandId: uuid; scopes: string[] }
  | { type: 'system';  brandId: uuid; jobId: string }   // workers only
```

A staff member has one role per brand. `departmentIds` is `'all'` for Admin, and for a Team Leader or Viewer with no department restriction. `installAdmin` is the only principal that may run "all brands" paths.

### 1.2 Scope rules

| Role | Sees tickets | Edits tickets | Manages config |
|---|---|---|---|
| Admin | Whole brand, every brand they are admin of | Yes | Everything in the brand; install admin also global settings |
| Team Leader | Their departments (or all if unrestricted) | Yes | Departments they lead: agents, SLAs, rules, macros, canned responses, help center, widget theme, content policy, reopen policy |
| Agent | **Their departments only.** Unassigned tickets in those departments are visible. A ticket in another department is invisible even if it mentions them. | Tickets in their departments | Nothing |
| Viewer | Their departments (or all if unrestricted) | No | Nothing; may read reports and help center content |

Contacts and accounts are brand-scoped, not department-scoped. An agent viewing a contact timeline sees only the tickets they are allowed to see; the timeline shows a count of hidden tickets so the agent knows history exists.

Reading them (`contact:read`) comes with every role, including Viewer. Editing them, adding or removing an identifier, writing a note and dismissing a duplicate suggestion (`contact:write`) follow the "Edits tickets" column: Admin, Team Leader and Agent, never Viewer. **Erasing** a contact (§11) is Admin only, in the brand the contact belongs to, because it destroys history that no permission can give back.

Team membership follows the same ceiling as role changes: a Team Leader may add only Agents and Viewers whose department scope covers the team's department; Admins and other Team Leaders can be added to a team only by an Admin. Assignment (M1-07) therefore never lets a Team Leader route work to an Admin.

Moving a ticket to a department the actor cannot see is allowed (it is how escalation works); the ticket disappears from their view afterwards and the activity log records it.

### 1.3 Enforcement layers

Every request goes through all four. Any one of them failing closed is enough to block; none may be skipped.

1. **HTTP/WebSocket guard**: role and scope check per route or event, declared with a decorator such as `@Requires('ticket:write')`. Missing decorator fails the request in development and in CI.
2. **Postgres RLS on `brand_id`**: every tenant table. Session settings `app.brand_ids`, `app.department_ids`, `app.all_departments`, `app.principal_type`, `app.principal_id` are set with `SET LOCAL` inside the request transaction.
3. **Postgres RLS on department** for `tickets`, `ticket_messages`, `attachments`, `ticket_tags`, `csat_responses`, `ai_calls`:
   `brand_id = ANY(app.brand_ids) AND (app.all_departments OR department_id = ANY(app.department_ids))`. Child tables carry a denormalised `department_id` kept in sync by trigger, so policies never need joins.
4. **Output DTOs**: Zod output schemas strip fields the role may not see (for example, internal notes for a visitor principal are impossible by construction because visitor DTOs have no note field).

### 1.4 Workers and WebSockets

- Every job payload carries `brandId`. The worker opens a transaction and sets `app.brand_ids = {brandId}`, `app.all_departments = true`, `app.principal_type = system` before any query. A job that needs several brands enqueues one child job per brand.
- A socket authenticates on handshake exactly like HTTP. Joining a room (`ticket:<id>`, `conversation:<id>`, `department:<id>`) runs the same permission check as the corresponding REST read. On role change, deactivation, or "log out everywhere", the server publishes `principal.revoked` over Redis and every replica disconnects that principal's sockets within 5 seconds.

### 1.5 Database roles

| Role | Used by | Privileges |
|---|---|---|
| `helpdock_owner` | Migrations only (`APP_ROLE=api` boot, before serving) | Owns all tables; `BYPASSRLS` implicitly as owner |
| `helpdock_app` | Runtime queries | `NOSUPERUSER NOBYPASSRLS`; `SELECT/INSERT/UPDATE/DELETE` on tenant tables; no DDL |

Every tenant table has `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`. `DATABASE_URL` is the app role; `DATABASE_MIGRATION_URL` is the owner. A startup check refuses to serve if the runtime connection can bypass RLS.

### 1.6 Required negative tests

Each is an integration test against real Postgres, required in CI, and extended whenever a tenant table is added.

- Cross-brand read, insert, update, delete: all fail, including via `IN` subqueries and joins.
- Same-brand, other-department read and update by an Agent: fail. Same for Viewer.
- Agent reading a ticket assigned to them in a department they are not in: fails (by product decision, see §1.2).
- Revoked role: existing access token keeps working for at most 10 minutes; refresh fails; open sockets are disconnected.
- API key with `tickets:read` attempting a write: fails. API key of brand A reading brand B: fails.
- Worker job for brand A cannot touch brand B rows.
- Runtime role cannot bypass RLS (`SET row_security = off` is rejected).

---

## 2. Ticket lifecycle

### 2.1 States

Four system states: `open`, `on_hold`, `escalated`, `closed`. Custom statuses map to one system state and carry two flags:

| Flag | Meaning |
|---|---|
| `pauses_sla` | While the ticket is in this status, SLA clocks are paused |
| `awaiting_customer` | The ball is with the customer; used by time-based rules ("awaiting customer > 72 h") and reports |

Two custom statuses ship with every brand: **Awaiting customer** (`on_hold`, `pauses_sla`, `awaiting_customer`) and **Spam** (`closed`, excluded from reports). A brand toggle `auto_await_on_agent_reply` (default on) moves a ticket to Awaiting customer when an agent sends a public reply.

A third seeded custom status, **Snoozed** (`on_hold`, `pauses_sla`, not `awaiting_customer`; system key `snoozed`, M14-02, [ADR 0035](../decisions/0035-snooze-as-a-system-status.md)), has a fixed state and fixed flags: a brand may rename and recolour it, never remap it or delete it. A ticket is in Snoozed exactly when `tickets.snoozed_until` is set. The ticket remembers the status before the snooze (`snooze_resume_status_id`) and who snoozed it (`snoozed_by`), and `snooze_version` counts every change of `snoozed_until`. Snoozed is entered only with a wake time (5 minutes to 90 days ahead, from the server's clock); setting it as a bare status, by a person or a rule, is refused (`snooze-requires-time`). A rule or a macro enters it through the **snooze action** (#368) instead, which names one of the Snooze menu's presets and is resolved to an instant by the server, against the ticket's department calendar, when the rule runs or the macro is applied — never a timestamp the client computed. A `BEFORE UPDATE` trigger on `tickets` clears the three snooze columns on any change of `status_id` to another status, whichever code path made it.

### 2.2 Transitions

| Current state | Event | Result |
|---|---|---|
| any open-like (`open`, `on_hold`, `escalated`) | Customer public reply | `open` (status = brand's default open status). Clears `awaiting_customer`. |
| `open` | Agent public reply, toggle on | Awaiting customer |
| any | Agent sets status | That status. Activity log records actor. |
| any open-like | Agent closes | `closed`, `closed_at` set, resolution clock stops, CSAT scheduled (if enabled, not spam, not merged). Refused with `fields-required-to-close` (409) while a ticket custom field marked *required to close* is empty; the refusal names the keys. An API key is refused the same way (owner decision D-30). Filling the field and closing in one request goes through. A rule, a time-based rule, a merge and a mark as spam close anyway, and their close activity records `closedWithout` with the keys it went without. |
| `closed` | Customer reply | Governed by reopen policy, §2.3 |
| `closed` | Agent reopens | `open`; new response clock and resolution clock start from reopen time (§3.5) |
| any | Marked spam | Spam status; no auto-responder, no CSAT, sender added to block list if the agent ticks "block sender", excluded from reports and round-robin counts |
| any | Merged into another ticket | `closed` with `merged_into_id`; see §2.4 |
| any | Soft-deleted by Admin | Hidden from all views; purged by retention (§11) |
| any open-like (not closed, not merged) | Agent snoozes, with a wake time | Snoozed, remembering the previous status; a ticket that is already Snoozed keeps the status before the first snooze. A closed ticket is refused (`ticket-closed`). Activity `ticket.snoozed`. |
| Snoozed | Snooze time reached | The remembered status if it still exists and is open-like, else the brand's default open status. Actor `system:snooze`; activity `ticket.woke`, reason `time`; the assignee, else the person who snoozed it, is notified (`snooze_ended`). |
| Snoozed | SLA warning or breach on a running first-response or next-response clock | The remembered status (as above). Actor `system:sla`; reason `sla`; same notification. |
| Snoozed | Customer public reply | The first row of this table, unchanged: the brand's default open status. Reason `customer_reply`; nobody is notified. |
| Snoozed | Agent sets another status, closes, marks spam, or the ticket is merged (a person or a rule) | That status; the snooze is cleared. Reason `status_changed`. |
| Snoozed | *Wake now* (`snoozedUntil: null`) | The remembered status (as above). Reason `manual`. |

Time-based rules and workflow actions use the same transitions and are logged with actor `rule:<id>`. A rule snoozes only through the snooze action (#368): its preset is resolved with the Snooze menu's own maths, the activity, `ticket.snoozed` outbox event and wake timer are a person's snooze's, and `snoozed_by` is null — a rule is nobody, so a wake tells the assignee. It is one planner with the menu's and `PATCH`'s (bounds, transition, columns, activity, outbox), and it **never runs on a wake**: a run answering a time, SLA or customer-reply wake, and every run that chain sets off, refuses the action as *unavailable* with the reason `woken` in the run log, because a wake that a rule undoes would loop and would hide the customer's reply (the customer reply always wakes). A macro snoozes through the same update a person's `PATCH` takes, and the person who applied it is `snoozed_by`.

**A status whose system state changes** crosses the closed boundary for the live tickets (not soft-deleted, not merged) already in it (#361), and one dropdown change must not become an unbounded mass action:

- **Out of `closed`** is refused while the status holds any live ticket: `409 status-has-closed-tickets` with the count. The admin moves or merges them first; an empty status may change. Nothing is reopened in bulk.
- **Into `closed`** needs `confirmCount` equal to the live tickets that are not yet closed, else `409 status-change-needs-confirmation` with the count (none needed for an empty status). The `ticket.status_state_resync` outbox event then closes them in batches of 200, counted from the moment of the save: `closed_at` set, the resolution clock met (row 4), an activity row, and a `ticket.closed` event **per ticket**, so webhooks and rules fire per ticket. **No CSAT is scheduled**: a configuration change is not a resolution.
- The worker reads status and tickets as they are now: a status no longer closed closes nothing more, and a ticket that moved out, closed or was deleted since is skipped (batch rows are locked and the update re-checks status and `closed_at`).
- While a batch runs, a ticket in a closed-state status that has no `closed_at` (not reached yet) is read as open for a reply or a status change. The converse is not read: an open-status ticket that carries a `closed_at` (deleting a status moves its tickets to the default open status and leaves it) is an open ticket.
- On worker boot, every closed-state status still holding a live ticket with no `closed_at` (left by the edit before #361) gets the same event, so those tickets are closed once, without surveys.
- Known race: a ticket moved into the status by an agent between the count check and the worker is closed with the rest if the status is closed by then, and a ticket moved in after the batches finished is caught by the boot repair. Status changes of tickets do not take the status-row lock.
- Between the open-like states nothing is owed, and a change of `pauses_sla` re-syncs on its own (§3.2).

### 2.3 Reopen policy

Per brand, editable by Team Leaders and Admins. Setting `reopen_policy`:

| Value | Customer reply to a closed ticket |
|---|---|
| `within_days: N` (default `7`) | Reopens the ticket if `closed_at` is less than N days ago, otherwise creates a new ticket |
| `always` | Always reopens |
| `never` | Always creates a new ticket |

A new ticket created by this rule gets `parent_id` = the closed ticket, a system message "Continued from HD-1042", and appears next to it on the contact timeline. The closed ticket gets a system message "Continued in HD-1101". Auto-responders treat it as a new ticket. Reopening restarts clocks as in §3.5.

### 2.4 Merge and split

**Merge** (secondary → primary, same brand, any department):

- Secondary becomes `closed` with `merged_into_id`. Its status is the brand's "Merged" system status (hidden from reports, no CSAT).
- Messages are **not moved**. Primary gets a system message linking the secondary; the primary's thread shows the secondary's messages inline, read-only, marked with their origin. This keeps message ids and channel threading stable.
- Tags: union. Contact: primary's contact; if different, the secondary's contact is added as a CC participant (§4.4).
- SLA: secondary's clocks stop and are excluded from compliance reports. Primary's clocks are untouched.
- Attachments remain on their original messages; access follows the primary ticket after merge.
- Merge is reversible for 24 hours (unmerge restores the secondary to its previous status; clocks resume with time paused during the merge excluded).

**Split** (selected messages → new ticket):

- New ticket with `split_from_id`, same contact, department chosen by the agent, fresh ticket number.
- Selected messages are **copied** (not moved) with `copied_from_message_id`; the original ticket shows a system message "Messages split to HD-1103".
- New clocks start at split time under the new ticket's policy. Original ticket's clocks are untouched.
- CSAT is sent per ticket on its own close.

Imported history bypasses live ticket lifecycle hooks. Scheduled rules use the
later of `status_changed_at` and `imported_at` for both candidate selection and
condition evaluation. A content-only delta that retains the same mapped status
must retain `status_changed_at`, so it cannot manufacture another scheduled-rule
match. Actual status transitions keep the database trigger's arrival baseline.

### 2.5 Participants

A ticket's participants are: the contact, CC addresses added by agents or present on inbound email, and staff. Participants define who may thread into the ticket by email (§4.3) and who receives public replies. Visitors, Telegram chats and Meta conversations (WhatsApp, Messenger, Instagram) are participants through their identity mapping, never by email address.

Imported CCs can reference a same-brand contact without a source email; their
address remains null and their provenance is `import`. Never invent an address.
A delta reconciles only import-owned membership and preserves manually added
participants. A known source email may fill an import-owned null address, but
must not replace a manually chosen address. Importing a participant sends nothing.

Imported satisfaction answers are historical rows with expired random tokens;
native delivery and survey selection never select them. A response whose source
scale cannot be established keeps a null comparable rating, its original date
and answers, and an explicit `ratingUnmapped: true` provenance marker. It never
counts as a zero or enters score averages. Staff may read it as
`imported_unscored`, with no share link. Each changed imported answer writes an
inert dated history event; repeats change neither row. Importing an answer emits
no native `csat.received` action, workflow, notification or vendor send.

### 2.6 Reply windows on the Meta channels

WhatsApp, Messenger and Instagram let a business write to a customer only for a time after the customer's last message; outside it the platform refuses the send. Helpdock enforces the window itself, before the reply is written and again when it is sent, because a reply that cannot leave the desk must not be written as if it had (M10-06, [ADR 0025](../decisions/0025-meta-channels-through-one-graph-adapter.md)).

| Platform | Window | Extension |
|---|---|---|
| WhatsApp | 24 hours from the customer's last message | None in free text. An approved template may be sent at any time (M10-09); Meta charges for it |
| Messenger | 24 hours | 7 days for a reply written by a person, when the connected Page's Human Agent feature is on (the operator asserts Meta approved it) |
| Instagram | 24 hours | 7 days, as Messenger; nothing after |

- The anchor is `meta_conversations.last_inbound_at`: the time of the customer's last message on that platform, set by the webhook. A delivery or read report, a reaction or an echo does not move it.
- **At compose time**, a staff public reply on a `whatsapp`, `messenger` or `instagram` ticket whose window is closed is refused with `reply-window-closed` (409) before anything is written. Internal notes are never refused. The ticket view reads the window and disables Send first; the refusal is for the race.
- **At send time**, `meta.send` checks the window again before its first part. A window that closed while the job waited records the delivery `refused` with the platform's code and is never retried, and Retry is not offered for it. The customer's next message opens a new window and the agent writes a new reply.
- The 7-day extension belongs to a person. An AI reply, a rule's canned reply, an auto-responder and the satisfaction survey use the 24-hour window only, whatever the account's switch says.
- Tests: a reply at 23 h 59 m is queued and sent; at 24 h 01 m it is refused at compose time; one queued at 23 h 59 m whose job runs at 24 h 01 m is `refused` by the job and the stand-in receives nothing; on Messenger at day 3 with the switch on, a person's reply goes out tagged `HUMAN_AGENT` and an AI reply does not go out.

### 2.7 Bulk changes

A bulk edit (M14-03, [ADR 0036](../decisions/0036-bulk-changes-previewed-all-or-nothing-with-undo.md)) changes up to 50 tickets with one set of changes. It is staff only and not part of the public API v1.

- **What it may change:** status (never Snoozed directly), close, priority, assignee (a person, `me`, or nobody), team, department, tags to add and tags to remove, snooze until a time or wake, mark spam, and one custom field value. **Never:** replies, notes, macros with a reply, merge, split, delete, or "block sender". Status, close, snooze and mark spam are one at a time in a request, so the order a person previewed is the only one.
- **No second write path.** Each ticket goes through the method a single edit uses: the ticket update (columns, status, snooze, custom value) for the first six, the spam service for mark spam and the tag service for tags. Authorization (`ticket:write` for the route, then the department policy per ticket), the transitions of §2.2, the assignment ceiling (`assignee-above-actor`), activity, outbox events, wakes, SLA effects, rules and webhooks are therefore the single edit's, once per ticket. Activity is recorded `via: bulk` (`bulk_undo` for an Undo).
- **Scope.** A ticket the caller cannot see (another department, deleted, or not there) is `not_found`, indistinguishable from a missing one. Moving tickets into a department the caller cannot see is the escalation of §1.2; the operation's item for that ticket then follows it out of sight, and an Undo reports it as not found.
- **Preview** does the same work per ticket inside a savepoint and rolls it back, so it answers `will_change` (with the fields), `unchanged`, `refused` (with the single edit's code) or `not_found` without writing anything.
- **Apply** takes `expect`, the ids the preview said would change, and runs in one transaction. The tickets that would change must be exactly `expect`; if one the preview named is now refused, gone or unchanged, or one it did not name would now change, the whole apply rolls back with `bulk-changed` (409). All or nothing keeps "what you previewed is what happened" true (owner decision D-22).
- **Lock order.** The batch locks its visible tickets `FOR UPDATE` in id order before changing any, and changes them in that order. Two overlapping batches therefore queue behind each other, the handlers that unassign several tickets lock in the same order, and a single edit, which holds one ticket, cannot close a cycle with them. A deadlock that still happens answers 409 `bulk-changed`, not 500.
- **Operation log and Undo.** A changed apply writes `ticket_bulk_operations` and one `ticket_bulk_operation_items` row per changed ticket with the before and after values of the fields that moved (ids, enums and instants, never text). `POST /tickets/bulk/:operationId/undo` within 60 s, by the same person, puts back each field whose current value still equals what the operation set, leaves any field someone changed since and reports it, and puts tags back as a set. A step the rules refuse is reported with its code and left. Undo is one transaction that writes the single edit's activity and events, and it can be made once. An Undo that closes a ticket again restores the close time it had and asks for no survey. It withdraws the notifications of the assignments it actually put back, ticket by ticket, that nobody has read (`ticket.bulk_undone`); a ticket it could not reach or had to keep keeps its notification; what already left the install (a webhook, a push, an email sent) is not recalled.
- **Surveys.** A close made by a bulk edit publishes its `csat.requested` job 60 s later (the relay's delay), and the consumer already skips a survey whose close no longer stands, so an Undo inside the window sends none.
- **Limits.** 50 tickets; 20 applies and undos a minute per person, 60 previews a minute.
- **Retention.** Operations and their items are kept 7 days (§11).

### 2.8 Arrival and the routing trail

Every ticket records how it arrived, once, in the activity row that filed it (M14-08): `to.arrival` on `ticket.created`, on the new ticket's `ticket.continued` for a continuation (§2.3) — the entry point the customer's reply came in through, in the closed ticket's department — and on `ticket.imported` for an import. The record is `{ entry, entryId, address?, departmentId, reason }`, where `address` is the address an email was written to as the message names it, written through one helper by every creation path, so no path can file a ticket without saying how. For email, prefer the mailbox address among recipients, otherwise a nonempty `Delivered-To` (or `X-Original-To` when absent) of at most 320 characters, otherwise the mailbox address; never fall back to an unrelated To/Cc recipient. `reason` is why the ticket took its department: the entry point's own, the brand's first (the widget, or a form without one), named by an API key, chosen by a person, continued from a closed ticket, the department of a ticket an email named but its sender may not reply on (§4.3), or an importer's mapping.

- **No new table.** The trail is derived from the activity log: the arrival, then every department, team, priority and assignee change the system made after it, until the first change by a person (staff or an API key; a reply or a note is not a change).
- **Read under the ticket's own department policy.** The trail is read in the reader's transaction, so a ticket in another department answers 404 and its activity is invisible, as for every other read of it (§1.2).
- **Deleted rules are named as such.** A step a rule made names the rule by its current name, and "a rule since deleted" when the rule is gone; nothing about a rule is copied into the activity row. AI triage's changes are the rule's, written with `via = ai`, and read as "by AI triage".
- A ticket filed before M14 has no arrival and reads "Arrived on <channel>" with the activity that exists. An imported ticket reads "Imported from <source>" and nothing else: an import sends and runs nothing (M11).
- Tests: the trail's composition for each actor kind and for a deleted rule (unit); the arrival written by each of the six creation paths, and a ticket in another department answering 404 (integration).

### 2.9 Test routing

Test routing (M14-09, `POST /api/brands/:id/routing/test`, `ticketing:manage`) answers "where would this message go?" by walking a sample through the code a real arrival takes, with every write left out. The Routing tab's explainer (`GET /api/brands/:id/routing`) reads the same configuration.

1. **The door.** One of the brand's mailboxes, Telegram bots or Meta accounts, the widget, the web form, or an API request that names a department. The department is the door's own, the brand's first department (the widget, and a form without one) or the one the request names (§2.8's reasons).
2. **The sender.** A mailbox sender who looks automated (`noreply@` and the like, §4.3) and is not on the mailbox's allow-list files no ticket. A sender on the block list (M1-11) is dropped and counted by a real message; the test reports it and counts nothing. A WhatsApp number is checked as a phone (`+waId`) first, then as a WhatsApp identity, as the inbound path does. The widget and the API do not consult the block list, as they do not for a real arrival. Only the address is judged from a sample, so a real message can be stopped by a header (`Auto-Submitted`, `Precedence`) the sample does not carry.
3. **The contact.** The contact holding the sender's identifier, by name only, or "a new contact".
4. **The rules.** Every enabled *Ticket created* rule, in order. As in the engine, each rule's conditions are judged on the ticket as it arrived; the actions of the rules that match are applied in order to a copy, so a later rule's actions see an earlier one's changes. The ticket's subject is derived by the door's own function (an email's, with its "(no subject)" fallback; a web form's first message line when it asks for none; the first line of a chat, Telegram or Meta message; an API request's as given). Each condition shows what it found, each action what it would do, and the rules a rule's changes could set off one level on show whether they would run (M3-05). The preview follows the engine's assignment semantics (moving a ticket takes off an assignee who cannot work the new department; "assign by rotation" clears the assignee). The actions of the follow-on rules are listed but **not applied**, so the SLA and the assignment shown are those the first level of rules leaves. AI triage is never called: it is reported as queued when a matching rule would queue it.
5. **The SLA.** The policy that would apply to the ticket as the rules leave it, and the first-response due time, from the real clock.
6. **The assignment.** A rule that names an assignee wins; otherwise the department's mode. The rotation's pick is the worker's `pickAssignee` over the same reads (members, rotation, presence, load), read **now**, with no advisory lock and no "last picked" stamp, so asking twice answers the same and the turn does not move. Nobody online, and nobody eligible (not in rotation, or at the cap), are told apart.

- **Nothing is written.** The walk runs in a savepoint that is `SET LOCAL transaction_read_only` and always rolled back: no ticket, contact, activity, message, outbox row, audit row, notification, SLA clock or rule-run row is written; no block-list counter, rule counter or rotation stamp moves. The database refuses a write made inside it.
- **Department scope (§1.2).** A reader whose scope is some departments sees and tests only the doors that file into them; any other door answers 404 as an unknown one does. If the rules move the sample into a department outside the reader's scope, the result says so and does not show that department's rotation.
- Tests: the row counts of every table a real arrival writes, the block-list counters and the rotation stamps unchanged after a run, and a second run picking the same person; a write made inside a dry run refused by the database; each verdict (ticket, blocked, automated); the scope and permission rules (integration).

### 2.10 How an agent appears to a customer

What a customer is told about the person who answered them is one decision, made in one place (`publicNameOf`, `packages/schemas/src/placeholders.ts`), not a field each channel reads for itself (M14-12).

1. **The public name.** A person's `public_name` when set; otherwise the first word of `users.name`. Before the field existed most surfaces showed that first word, but the email `From` header carried the full name — the public name is the one rule for all of them now. The full name reaches a customer only through `{{agent.full_name}}`, which an author has to write. The email address, the role, the department scope and the presence state never reach one.
2. **Where it applies.** The widget (an agent's message, the online line), the `From` display name of an email reply ("Lina via Support"), the widget transcript email, the CSAT page and email ("closed by"), and the opening line on the Meta channels ("Lina · Helpdock"). The assistant and rules carry the brand's name alone, as before. Telegram shows no agent name.
3. **Title and phone.** `job_title_en` and `job_title_ar`; a reply in Arabic with no Arabic title says the English one, and never the other way round. The phone is shown only where a signature or a reply uses `{{agent.phone}}`.
4. **The photo** is a customer-visible file only through a presigned URL that lives five minutes (§4.5), issued for the author of a message in the visitor's own conversation, after that conversation has been read under row-level security. The online line and its presence frames name the agents and carry no photo: they reach every visitor of the brand, including those nobody has answered, so the widget draws initials there. There is no public photo route. What is stored is the sharp re-encode (§4.5's rules for images), never the upload.
5. **Placeholders.** `{{agent.name}}`, `{{agent.full_name}}`, `{{agent.title}}`, `{{agent.phone}}` and `{{department.name}}` render from the sender (for a rule, the assignee). A value the person left unset renders as nothing, so a customer never reads a placeholder; one the renderer does not know stays as written (§2.2's reply rules). A signature takes the same names plus `{{brand.name}}`; a signature line whose placeholder came out empty is dropped.
6. **The time zone** (`users.time_zone`, IANA) is the person's own: the daily digest's hour (§20) and the snooze menu's presets read it, then the brand's.
- Tests: the public name falling back to the first name and never the surname; the Arabic-to-English title fallback; empty placeholders rendering as nothing; no email address in any customer-facing payload; a presigned photo URL only for a message's author (unit and integration), and never in the online line an anonymous visitor is sent; the upload's refusals (unit, integration) and its per-account rate limit.

---

## 3. SLA calculation

### 3.1 Clocks

Imported tickets are exempt from automatic clock creation until an administrator
explicitly activates them. `tickets.import_sla_started_at` records that opt-in;
sync, reopen and policy/calendar recomputation leave unactivated imported tickets
without clocks. Activation is idempotent and starts applicable clocks at the
activation time, preserving the original ticket creation date. Deleted, merged
or closed tickets and tickets without a matching policy are not activated.
Bulk activation requires `brand:manage` and explicit acknowledgment. It covers
the completed run's verified source account within that brand, using durable
receipts; only tickets imported by the request time qualify. Revision/cursor
fences and atomic clock/progress/outbox commits make replay and resume safe.

A vendor delta reconciles clocks that an administrator already activated, using
the pure clock/calendar functions and database writes only. Public agent replies
satisfy the appropriate response clock; paused/closed/excluded status changes
reconcile resolution clocks and ticket summaries. A reply older than a staff
reopen cannot satisfy its next-response clock. This path emits no live ticket,
SLA timer or notification events and does not start clocks on unactivated imports.

Every ticket has at most two running clocks, each with `target_minutes`, `started_at`, `paused_total_ms`, `due_at`, `satisfied_at`, `breached_at`:

| Clock | Starts | Satisfied by |
|---|---|---|
| First response | Ticket creation, or reopen (§3.5) | First **public** reply by a staff member, or by AI auto-reply when the brand toggle `ai_counts_as_first_response` is on (default on). **Never** by: auto-acknowledgment, out-of-hours notice, internal note, workflow canned reply unless the rule action sets `counts_as_response: true` (default false), CSAT message. |
| Resolution | Ticket creation, or reopen | Transition to `closed` |

Elapsed time is counted only inside the business hours of the ticket's department (falling back to the brand's), skipping holidays. A ticket created outside business hours starts its clocks at the next opening.

### 3.2 Pause and resume

While the ticket is in a status with `pauses_sla`, clocks do not advance. On resume, `due_at` is recomputed as `now + remaining`, where `remaining = target − elapsed_in_business_hours`. Pauses are recorded so reports can show "time waiting on customer" separately. Changing a status's `pauses_sla` applies the same rule to the open tickets already in it, through the `sla.status_resync` outbox event in batches, counted from the time of the change.

**Snoozed is the one status whose `pauses_sla` applies per clock** (M14-02, owner decision D-19): it pauses the **resolution** clock only. An unsatisfied first-response or next-response clock keeps running while the ticket is snoozed, because putting a ticket away is not answering it; a response clock that reaches an escalation step wakes the ticket (§2.2). A ticket moved from Awaiting customer to Snoozed therefore starts counting its response clock again.

### 3.3 Changes to priority, department, or policy

When any of these changes, both unsatisfied clocks are recomputed:

```
elapsed   = business-hours time already consumed under the old calendar (unchanged)
remaining = new_target − elapsed         (may be negative → immediate breach)
due_at    = advance(now, remaining, new_calendar)
```

Escalation steps already fired are not re-fired. Steps not yet fired are re-scheduled against the new `due_at`. A change that makes `remaining` negative records a breach at the moment of change, attributed to the change in the activity log.

### 3.4 Breach and escalation

- Breach is recorded once per clock. Reports count a ticket as "first-response breached" or "resolution breached" independently.
- Escalation steps are defined per policy as `{ at_percent, actions[] }`, `at_percent` may exceed 100 for post-breach steps. Actions: notify users/teams, reassign, raise priority, add tag, set status `escalated`.
- Timers are BullMQ delayed jobs keyed `sla:<ticket_id>:<clock>:<step>` (written with dots, `sla.<ticket_id>.<clock>.<step>`, because BullMQ refuses a colon in a custom job id). Any status, priority, department, or policy change removes and re-adds them. On worker boot, `sla.rebuild` scans open tickets and re-creates missing timers (protects against Redis loss).
- Snooze timers (M14-02) are delayed jobs `ticket.unsnooze` keyed `snooze.<ticket_id>.<snooze_version>`, added by the consumer of the `ticket.snoozed` outbox event written in the same transaction as the snooze, on the same queue as the SLA timers. A job does nothing unless the ticket is still Snoozed at that version and due, so a newer snooze, a customer reply or a manual wake leaves an old job harmless. `snooze.rebuild` runs on worker boot and hourly: it wakes every snooze that is already due and re-adds the timer of every other, so losing Redis loses no snooze.

### 3.5 Reopen

On reopen (by policy or by agent), the first-response clock is replaced by a **next-response clock** with the same target, starting at reopen time. The resolution clock restarts from reopen time with the full target. The original satisfied/breached values are preserved for reporting under "initial response". Compliance reports use the initial clocks unless the brand chooses "count reopens".

### 3.6 Worked examples

Policy: High priority, first response 2 h, resolution 8 h. Business hours 09:00–17:00 Sunday–Thursday, Asia/Riyadh.

1. Ticket created Thursday 16:00. First response due Sunday 10:00 (1 h Thursday + 1 h Sunday). Agent replies Sunday 09:30 → satisfied, 1.5 h elapsed.
2. Same ticket moved to Awaiting customer at Sunday 09:30 (agent reply, toggle on). Resolution clock: elapsed 1.5 h, remaining 6.5 h, paused. Customer replies Tuesday 12:00 → resumes, due Wednesday 10:30 (5 h Tuesday + 1.5 h Wednesday).
3. Priority raised to Urgent (resolution 4 h) Tuesday 13:00. Elapsed = 1.5 h + 1 h = 2.5 h. Remaining = 4 − 2.5 = 1.5 h. New due Tuesday 14:30.
4. Ticket closed Tuesday 14:00 → satisfied. Customer replies the following Monday (6 days later, policy `within_days: 7`) → reopened. Next-response clock due 2 business hours after the reply; resolution due 8 business hours after the reply. Initial clocks remain "met" in reports.
5. Snooze (M14-02). The ticket of example 1 is snoozed Sunday 09:30 until Monday 12:00, unanswered. Resolution: elapsed 1.5 h, paused. First response: 1.5 h of 2 h used and still running, so its step at 100 % runs Sunday 10:00 and wakes the ticket into the status it had; the resolution clock resumes with 6.5 h remaining and is due Sunday 16:30. If an agent had answered at 09:45 instead, the first-response clock would be met, nothing would wake the ticket early, and at Monday 12:00 it wakes and the resolution clock resumes with 6.5 h remaining, due Tuesday 10:30 (5 h Monday + 1.5 h Tuesday).
6. The ticket of example 1, not answered, is set to Awaiting customer by an agent at Sunday 09:30, then snoozed Sunday 11:00 (M14-02). Awaiting customer paused both clocks at 09:30: first response 1.5 h used of 2 h, resolution 1.5 h. Snoozed pauses only the resolution clock, so at 11:00 the first-response clock resumes with 0.5 h remaining and is due Sunday 11:30 (the 1.5 h shown at the snooze is 09:30 to 11:00 paused, not counted); the resolution clock stays paused. When that step runs the ticket wakes into Awaiting customer, which pauses both clocks again.

---

## 4. Identity and conversation ownership

The principle: **an identifier someone types is a hint, not proof.** Access to history requires a credential the server issued or a signature the brand's site produced.

### 4.1 Visitors

- First widget load issues `{ visitor_id, visitor_secret }`. The secret is a 256-bit random value stored in `localStorage` for the brand and sent as `Authorization: Visitor <secret>` on REST and in the socket handshake. Server stores `sha256(secret)`. Clearing storage means a new anonymous visitor; the old conversations are not reachable.
- A visitor may read and write only conversations created with their `visitor_id`. A conversation is the widget-side view of a ticket; a visitor never sees internal notes, other tickets of the same contact, or email/Telegram tickets.
- An email address entered in the pre-chat form creates or links a contact with `email_verified = false`. It does **not** grant the visitor access to that contact's other conversations. Agents see an "unverified" badge next to it.
- Transcript-by-email sends only that conversation, to the address the visitor entered, and the email contains no links that grant access.

### 4.2 Signed identity

- The host site sends `{ user_id, email?, name?, ts }` plus `HMAC-SHA256(brand_widget_secret, canonical_json)`. Valid if the signature matches and `|now − ts| ≤ 5 min`. Replays inside the window are harmless because the identity is a claim about who the visitor is, not a session credential.
- A valid signature marks the contact's `external_id` as verified and links the visitor to that contact. The visitor may then see that contact's **widget** conversations from any device (continuity). Email and Telegram tickets stay hidden unless the brand enables `signed_identity_sees_all_channels` (default off).
- If a signature is present but invalid, the widget behaves as anonymous and logs a security event.

### 4.3 Email threading

An inbound email is attached to an existing ticket only if **both** hold:

1. A thread hint matches: `In-Reply-To` or any `References` id equals a message id Helpdock sent or received on that ticket, **or** the subject contains the brand's `[PREFIX-N]` token.
   For imported history, duplicate RFC IDs can name multiple tickets. Real Helpdock
   deliveries take precedence, followed by live received email. A historical ID
   threads only when it names one ticket. If no ID resolves and a known historical
   ID is ambiguous, create a new ticket rather than falling back to a subject
   token that may reuse an old vendor number. Unknown IDs still permit subject
   token fallback. Imported RFC IDs are retained as history and do not participate
   in live delivery deduplication.

2. The sender address is a participant of that ticket (§2.5), compared case-insensitively on the normalised address.

If the hint matches but the sender is not a participant, a new ticket is created in the same department with a system note "Referenced HD-1042 but sender is not a participant", and the agent may merge manually. A subject token with no other hint is treated the same way. This prevents anyone who learns a ticket number from injecting into or reading that thread.

Auto-generated addresses (`Auto-Submitted`, `Precedence: bulk/list`, `noreply@`, `mailer-daemon@`) never create tickets unless the brand allow-lists them; they are logged.

### 4.4 Contact merge

| Identifier | Verified when | Auto-merge |
|---|---|---|
| Email | An inbound email arrived from it, or a magic link sent to it was clicked | Yes |
| Telegram `chat_id` | Always (comes from the Bot API) | Yes |
| WhatsApp business-scoped user id | Always (comes in a webhook Meta signed) | Yes |
| Messenger page-scoped id | Always (signed webhook) | Yes |
| Instagram-scoped id | Always (signed webhook) | Yes |
| Signed `external_id` | Always (HMAC) | Yes |
| Phone | Only as the `wa_id` of a WhatsApp message (M10); never when typed | Yes, between two verified phones |
| Email typed in a form | Never | No; suggests a merge to agents |

Auto-merge happens only when both sides of the match are verified. Unverified matches produce a "possible duplicate" suggestion on the contact page. Agents can merge manually; a merge is recorded in the audit log and can be undone for 24 hours. Merging contacts never merges tickets.

### 4.5 Attachments

Presigned GET URLs are issued only by an endpoint that first authorises the caller on the parent ticket or conversation (§1). URLs live 5 minutes and are bound to the object key. Inline images in help center articles are the only public objects and live in a separate prefix.

### 4.6 Tokens sent to customers

CSAT links, transcript links, and magic links are single-use, signed, bound to one ticket or one address, and expire (CSAT 30 days, transcript 24 hours, magic link 10 minutes). None of them grant access to anything beyond their purpose.

A staff sign-in link is spent by an explicit `POST` from the page it opens, never by the `GET` that opens it: mail scanners and link previews follow every link in a message, and opening the page only reads the token (M9-01 F6).

The notification email unsubscribe token (M14-11, [ADR 0037](../decisions/0037-paced-notification-email-and-digests.md)) is the one token a staff member receives that is not a sign-in link. It is `<payload>.<mac>`: the user id and the issue time (seconds, 4 bytes), and an HMAC-SHA256 over them under a key derived from `APP_MASTER_KEY` with HKDF for the purpose `notify-unsubscribe` alone, so no other token (CSAT, trusted browser) verifies as it and it verifies as none of them. It is valid for 365 days from issue and refused for an issue time more than 5 minutes ahead; the previous master key still verifies, so a rotation strands nothing in inboxes. It authorises exactly one thing, turning that user's notification email off (`email_unsubscribed_at`, matrix untouched), and it is idempotent: a repeat changes nothing and writes no second audit row. Following the link (`GET`) only reads, so scanners unsubscribe nobody; the `POST` of RFC 8058 (body `List-Unsubscribe=One-Click`) or the page's button is the action. A malformed, forged, altered, expired, future-dated or deactivated-account token is one and the same `404`, so the route is no oracle for whether an address has an account. The route is limited per IP, and the first unsubscribe is audited as `notification.email_unsubscribed` at install scope by the system principal `unsubscribe:<userId>`.

### 4.7 Meta identities

- Each platform scopes its customer id (M10). A WhatsApp business-scoped user id is the same for every number in one business portfolio and different in another; a Messenger id is per Page; an Instagram id is per professional account. The stored value is the WhatsApp user id alone, and for Messenger and Instagram `<account external id>:<customer id>`, so the same person writing to two Pages of one brand is two identifiers until an agent merges them.
- The kinds are `whatsapp`, `messenger` and `instagram` in `contact_identities`, from the sources `whatsapp.cloud`, `messenger.page` and `instagram.account`, all verified. `whatsapp.cloud` is also the one source that verifies a `phone`, with the `wa_id` Meta sends when the customer has not withheld their number; a phone an agent typed earlier becomes a duplicate suggestion and the verified claim takes the identifier (§4.4). A customer who has adopted a WhatsApp username may arrive with no `wa_id` at all, and is keyed on the user id alone.
- A `user_changed_number` system message re-links the conversation: the new `wa_id` becomes the contact's verified phone and the old one is removed.
- Names: WhatsApp sends a profile name with every message; Instagram's `@username` and name arrive once the customer has written; Messenger's name needs a reviewed feature, and without it the contact is "Messenger user". A name can change and never identifies.
- Nothing a Messenger or Instagram user sends proves a phone or an email. An address they type in the chat is text in a message, not an identifier.
- `meta_conversations` maps `(account, customer id)` to the contact and to the ticket the next message continues, as `telegram_chats` does: one open ticket per conversation, following a merge to its primary.

### 4.8 Meta message kinds

What the webhook files for each thing a platform sends (M10-03 to M10-05).

| The platform sends | Helpdock files |
|---|---|
| Text, with `context` or `reply_to` quoting an earlier message | A public message; the quoted message's text as a leading quote line when it is on the ticket |
| Image, video, document, audio, voice note, sticker | A public message with the caption as its body (empty allowed) and the file as an attachment, `pending` until `meta.media_fetch` has the bytes; a sticker is an image |
| Location, shared contacts | A public message in text form: the location line with a map link, as Telegram's; each contact's name and numbers |
| Story reply, story mention (Instagram) | A public message with the story's media as an attachment and a line naming it |
| Unsupported, `is_unsupported`, a `fallback` without a URL | A system line saying the customer sent something Helpdock cannot show; counted |
| `is_deleted` (Instagram unsend) | The message is kept and marked unsent by the customer; never deleted |
| `is_echo`, the business's own messages | Dropped. Helpdock's own are recognised by `app_id` or by the delivery id in `metadata`; others are dropped too in M10 |
| Reactions, edits, postbacks, referrals | A system line for a reaction or an edit; otherwise counted and dropped. Never a ticket message, never a window anchor |
| `statuses[]` (WhatsApp), `delivery` and `read` watermarks (Messenger), `messaging_seen` (Instagram) | The reply's delivery moves forward, `sent` → `delivered` → `read`, never back; a watermark marks every delivery of the conversation sent at or before it; `failed` carries the code |
| `user_changed_number` | The re-link of §4.7 and a system line |
| Inbound `errors[]` (media Meta could not serve) | The attachment `rejected` with the reason; the message is filed |

---

## 5. Knowledge visibility

- Every article version and every knowledge source has `visibility: 'public' | 'internal'`. A help center in internal-only mode forces all its articles to `internal`. Uploaded files, crawls, Notion and Drive sources default to `internal` and must be explicitly marked `public` to be used for visitor-facing answers.
- Retrieval takes an `audience`: `visitor` or `staff`. For `visitor`, the SQL for both vector and full-text search filters `visibility = 'public' AND status = 'published'` **before** ranking. There is no post-filter path; a test asserts the filter is present in the generated SQL.
- After generation, citations are validated: any citation whose chunk id was not in the retrieved set is dropped. If the answer depended on a dropped citation (the model cited it), the reply is replaced by the handoff message. This defends against the model echoing training data as a citation.
- When an article is unpublished, deleted, or switched to `internal`, or a source is removed or re-scoped, the `knowledge.sync` job removes or re-labels its chunks within 60 seconds, invalidates the help center cache for affected pages, and removes them from the sitemap and search index. Auto-reply may not use stale chunks in the meantime because the visibility filter joins the live article row, not the chunk's copy of the flag.
- Help center HTTP caching: public pages `Cache-Control: public, s-maxage=300, stale-while-revalidate=60`; internal pages and any page rendered for a logged-in staff member `Cache-Control: private, no-store`. The Redis render cache key includes `audience`; internal pages are never stored in it.
- Agent assist (audience `staff`) may use internal sources, and its suggested replies show which citations are internal so the agent does not paste internal content to a customer without noticing. The "insert into reply" action strips internal citations.

---

## 6. Transactional outbox

Domain changes and their side effects must not drift apart. Rule: **a side effect is enqueued in the same transaction as the change that causes it, and executed at least once, idempotently.**

- Table `outbox(id uuid, brand_id, event text, payload jsonb, created_at, published_at null)`. Services write the domain rows and the outbox row in one transaction. `@nestjs/event-emitter` is used only for in-process, non-critical effects such as cache invalidation; it never enqueues jobs.
- A relay in the worker (`outbox.relay`, wakes on `LISTEN outbox` and every 500 ms) reads unpublished rows in id order, adds a BullMQ job with `jobId = outbox.id` (so re-publishing after a crash is a no-op), and sets `published_at`. Rows are purged 7 days after publishing.
- Consumers are idempotent by natural key: email send keyed by `ticket_message_id` (and the SMTP `Message-ID` is deterministic from it), Telegram and Meta sends keyed by `ticket_message_id`, the Meta media fetch by the attachment id, webhook delivery keyed by `(webhook_id, event_id)`, indexing keyed by `(source_id, content_hash)`, staff notification email keyed by its batch (and its `Message-ID` is deterministic from the batch id, §20). A `job_receipts(key, completed_at)` table backs consumers that have no natural key.
- **M14-28 outbound events (1.1):** assignment, status and ticket merge events carry the department at the change. `message.created` covers newly stored public replies and notes, with `public` and `authorType`; copied split messages, historical imports and system announcements do not emit it. Contacts and customer accounts are brand-scoped (`departmentId: null`). References are validated and written in the mutation transaction; bodies never enter the outbox. Note bodies are omitted from each endpoint's delivery unless its `includeInternalNotes` is true (default false); revocation also redacts queued sends and replays. `ticket.replied` continues to exclude notes. Configuration-object events remain outside the contract.
- Inbound dedupe: `ticket_messages.external_message_id` is unique per channel, so re-delivered IMAP messages, Telegram updates, Meta webhook batches (`wamid`, `mid`), or inbound-parse webhooks do not create duplicates.
- Tests: crash the process between commit and publish (kill the relay) and assert the job is published on restart; roll back a transaction and assert no job appears; deliver the same job twice and assert one email.

---

## 7. Realtime delivery contract

Socket.IO does not guarantee delivery. The REST API is the source of truth; sockets are notifications.

- Every message has a client-generated `client_id` (UUIDv7) and a server-assigned `seq`, monotonic per conversation. `(conversation_id, client_id)` is unique, so retries are deduplicated.
- **Send**: `POST /widget/conversations/:id/messages` (or the staff equivalent) with `client_id`. The response carries `seq`. Socket emit with acknowledgement is allowed for the same call, but the UI treats a message as **sent** only when it holds a `seq`. Until then it shows "sending"; after a timeout of 10 seconds with retries it shows "not sent, retry".
- **Receive**: the server emits `message` events with `seq` to the room. The client tracks `last_seq`. Any gap (received `seq > last_seq + 1`) or any reconnect triggers `GET …/messages?after=<last_seq>` to catch up. Delivered and read receipts are separate events carrying the `seq` they refer to.
- **SSE fallback**: identical event payloads over `GET /widget/stream?after=<last_seq>`; sends go over REST. The server closes SSE connections after 5 minutes and the client reconnects with its cursor.
- Typing indicators, presence, and queue position are ephemeral, unacknowledged, and never replayed.
- Queue position counts the unassigned, open `chat` tickets of the department that joined the queue before this one. A live conversation joins when it is created. An imported ticket is history: it joins only at its customer's first public message written in Helpdock, never at its historical creation date, and has no position until then.
- Staff side is the same contract on the `/staff` namespace with rooms per ticket and per department.
- Tests (Playwright + toxiproxy or a network-throttling fixture): drop the connection mid-send and assert exactly one message exists; restart the api and assert the client catches up; submit the same message twice and assert one row.

---

## 8. Embeddings policy

- One embedding model per install: settings `embedding.provider`, `embedding.model`, `embedding.dims`. Per-brand override is not supported in v1 (ADR to be recorded).
- `knowledge_chunks.embedding` is `vector(<dims>)`; the column and its HNSW index are created by `knowledge.configure` when the model is first saved, not by a static migration. Every chunk stores `embedding_model`; retrieval filters `embedding_model = current` so vectors from two models are never ranked together even if their dimensions match.
- Changing the model: admin action → `knowledge.reembed` job. It sets `ai.retrieval_status = reindexing` (auto-reply and suggestions fall back to full-text only, with a banner in admin), drops the index, alters the column to the new dimension, re-embeds every source in order, rebuilds the index, and flips the status back. Progress is visible per source. A failed re-embed leaves the status at `reindexing` and never serves mixed results.
- Dimension limit: 2000 (pgvector HNSW). Models above that are rejected at configuration time with an explanation.
- Imported article language versions set `hc_article_versions.import_embedding_deferred`. Import completion may index and re-chunk them locally, but never schedules embeddings. Pending and full-reembedding workers exclude deferred versions before provider calls, even for previously queued work. Full-text retrieval remains available. Staff publication, including an explicitly scheduled publication, clears that language's deferral; changed source imports defer their replacement again. See ADR 0027.

---

## 9. AI quality gate

A mocked provider proves orchestration; it cannot prove grounding. Release also requires an evaluation run.

- Evaluation set in `packages/ai/eval/`: at least 40 English and 40 Arabic items over a fixed fixture knowledge base (one help center, one PDF, one crawled site). Categories: answerable with expected source; unanswerable (must hand off); adversarial (source contains injected instructions; answer must ignore them); multi-source; ambiguous (should ask a clarifying question or hand off).
- Runs: on demand and nightly in CI against a real provider configured by secret; never on every PR.
- Thresholds to ship 1.0 (per language):

| Measure | Threshold |
|---|---|
| Answerable answered correctly (LLM judge + expected source cited) | ≥ 85 % |
| Unanswerable handed off | ≥ 95 % |
| Adversarial items where the injected instruction was followed | 0 |
| Citations that resolve to a retrieved chunk | 100 % |
| Arabic answers written in Arabic when asked in Arabic | ≥ 98 % |

- Handoff persistence: `conversations.ai_paused_until` is set (null = forever) when the model hands off, the visitor asks for a human, or a staff member replies. Auto-reply jobs check the flag immediately before sending and abort if set. It clears only when a staff member clicks "return to assistant" or the ticket closes and a new conversation starts.

---

## 10. Operations and recovery

Backup tooling is out of scope for v1, but the procedure is not. `docs/guides/operations.md` (deliverable M9-06) documents and M9-10 rehearses:

- **What to back up**: Postgres (`pg_dump -Fc`), the S3 bucket (attachments and article images; the bucket is the only copy), and `.env` (contains `APP_MASTER_KEY`; without it every stored secret is unrecoverable). Redis is not backed up.
- **Targets** documented as operator guidance: RPO 24 hours with a daily dump, RTO 1 hour following the restore steps. Operators wanting less data loss run WAL archiving; the guide links to it without shipping it.
- **Restore**: fresh Compose stack → restore dump with the owner role → point at the bucket → same `.env` → start; migrations bring an older dump forward. A restore drill on a clean VM is an M9 exit criterion.
- **Upgrades**: pin the image tag; take a dump first; migrations are forward-only. A failed migration leaves the lock held and the api refuses to serve; recovery is restore + previous tag. Release notes flag migrations that cannot be rolled back by restore (none planned for 1.x).
- **Master key rotation**: `helpdock keys rotate` reads `APP_MASTER_KEY_PREVIOUS` and `APP_MASTER_KEY`, re-encrypts every secret row to the new key id, and reports. Each secret row stores its key id, so the two keys can coexist during rotation. Loss of both keys is unrecoverable and the wizard says so.
- **Redis**: named volume `redis_data:/data` with AOF. Losing Redis logs everyone out, drops rate-limit counters, and loses queued jobs; the outbox relay republishes anything unpublished, `sla.rebuild` recreates timers, `snooze.rebuild` wakes every snooze already due and recreates the `ticket.unsnooze` timer of the rest (M14-02), `notify.email_rebuild` places every pending notification email batch again (§20), and repeatable pollers are re-registered on worker boot. Nothing durable lives only in Redis.

---

## 11. Data lifecycle

Per brand, set by Admin (defaults in bold):

| Data | Retention | Purge behaviour |
|---|---|---|
| Closed tickets and their messages | **never** or N days after close | Hard delete ticket, messages, attachments (S3 objects included), AI call rows, CSAT |
| Spam tickets | **30 days** | Hard delete |
| AI call logs (prompt, response, sources) | **90 days**; aggregates for reports kept | Bodies nulled, counts kept |
| Help center search log | **180 days** | Hard delete |
| Audit log | **2 years**, minimum 90 days | Hard delete |
| Visitor sessions with no conversation | **30 days** inactive | Hard delete |
| Webhook, Telegram and Meta delivery logs | 30 days (fixed) | Hard delete of finished deliveries (sent, delivered, read, failed, refused); pending ones are kept |
| API idempotency keys | 24 hours (fixed) | Hard delete |
| Outbox, job receipts | 7 days after publish/complete | Hard delete |
| Staff notifications and their email batches | 30 days (fixed) | Hard delete; a batch still pending is kept |
| Bulk operations and their items | 7 days (fixed) | Hard delete (M14-03); the Undo they serve lasts 60 seconds |
| Knowledge chunks of a removed source | immediate | Hard delete |

- `maintenance.retention` runs nightly per brand and logs counts to the audit log.
- **Brand deletion**: Admin soft-deletes → 30-day grace with the brand disabled (widget, help center and the brand's own channel endpoints answer 410; an endpoint the install shares across brands, the Meta webhook, answers 200 and drops the brand's entries, because a non-200 there is Meta's cue to redeliver or unsubscribe for every brand, ADR 0025 (4)) → hard purge of every row, S3 prefix, Redis key, and Caddy domain. Ticket numbers of a deleted brand are never reused because the prefix is reserved.
- **Contact erasure** (privacy request): agent action "Anonymise contact" replaces name, emails, phone, Telegram id and visitor ids with hashes, deletes attachments they sent, rewrites message author fields, deletes their Telegram chat rows and Meta conversation rows and replaces the customer ids on their Meta deliveries, clears the AI redaction maps of calls on their tickets and deletes the webhook deliveries that carry their data, and keeps ticket bodies unless the brand's ticket retention says otherwise. Recorded in the audit log without the erased values.
- **Staff deletion**: see §12; authored content is kept with the author shown as "Former staff".

---

## 12. Staff lifecycle

| Event | Effect |
|---|---|
| Invite | Email with single-use 7-day token; role and departments set on invite; pending invites listed in admin and revocable |
| Activate | Sets password or OAuth link (M18-07: a provider account whose verified address is the invited one, else nothing is spent; the account then has no password); second-factor enrolment (an authenticator app or a passkey) forced if install requires 2FA, and always for an Admin or install admin (ASVS 4.3.1) |
| Sign in with Google, Microsoft or GitHub | Resolved by the provider account's subject in `user_oauth_identities`, never by address once bound. An address makes the first link only where the provider controls it (Google: Workspace `hd` equal to the address's domain, or Gmail; Microsoft: a member (`acct` 0, never a guest) of the one tenant `oauth.microsoft.tenantId` whose `email` carries `xms_edov: true`, with `iss` exactly `https://login.microsoftonline.com/<tenant GUID>/v2.0` and `tid` equal to it, else `oauth-tenant-mismatch`; with `oauth.microsoft.allowConsumers` on the consumers tenant is also accepted, connect-only and never linked by address; identities of a tenant no longer accepted cannot sign in and are replaced when their holder links again (M18-08); GitHub: never); otherwise `oauth-link-required`, the same whether or not an account holds the address. A non-empty `oauth.google.allowedDomains` admits only Workspace accounts whose `hd` is listed, on every Google sign-in and connect, bound accounts included; anything else is `oauth-domain-not-allowed` (M18-07). Connecting or disconnecting from a session needs the password or a live code, is audited and emails the holder. One identity per provider per account; buttons never create accounts ([ADR 0051](../decisions/0051-oauth-identities-bound-by-subject.md)) |
| Sign in with SSO | Resolved by `(connection, subject)`. An email makes the first link, or a JIT account, only in one of the connection's email domains and only when the identity provider vouched for it: SAML by the configured IdP's signed email attribute; OIDC by a signed `email_verified: true` on the `email` claim, or for Entra ID a signed `xms_edov: true` on `email` from a member (`acct` 0, never a guest) when the connection's issuer is `https://login.microsoftonline.com/<tenant GUID>/v2.0` (global cloud only; never `common`, `organizations`, `consumers` or the personal-account tenant) and the token's `iss` and `tid` match it. Otherwise `sso-email-unverified`. An account already linked to a subject is never handed to another by email (`sso-identity-conflict`) ([ADR 0026](../decisions/0026-staff-sso-over-saml-and-oidc.md)) |
| Role or department change | Refresh token family revoked so the next access token carries new claims (≤ 10 min lag); sockets disconnected (§1.4); tickets they can no longer see are unassigned per department setting `on_unassign: round_robin \| leave_unassigned` |
| Deactivate | Sessions and API keys they created revoked, sockets disconnected, removed from round-robin and presence, open tickets handled per `on_unassign`, notifications stop. Reversible. |
| Delete | Only after deactivation; personal data replaced, content kept as "Former staff" |
| Removal from one brand | Same as deactivation scoped to that brand |

Presence (`online`, `away`, `offline`) is derived from `/staff` socket connections, an explicit toggle and, for a department that asks for it, idle time. Auto-unassign on offline (R §4.1) runs after 15 minutes offline, configurable per department, and never during business hours closed periods.

**Email sign-in without a sender (#369).** A magic link or a password reset is only asked for when the install can actually send one. When the system sender (`smtp.*`) is missing, the request is refused with `email-unavailable` **before** any address is looked up and before any rate-limit budget is spent, so the answer is a fact about the install's configuration and is the same for every address: it never says, or makes more or less likely, that an address belongs to an account. Under SSO enforcement the magic-link request answers `sso-required` first, whatever the sender. The screen says no link was sent and names an administrator as the way in, rather than sending the person to an inbox nothing will ever reach. The worker's own guard stays: a job already queued when the sender disappears logs that the email would have been sent and finishes.

**A stored SMTP password stays with its server (#369).** The install's `smtp.password` and a brand's own SMTP password are write-only. A save that keeps the stored password, and a test that falls back to it, are honoured only while host, port and username equal what is stored; changing any of them needs the password typed again, otherwise the call is refused with 400 `smtp-password-required` and a field error on `password`, and no connection is opened. Otherwise a stolen admin session could mail the credential to a host of its choosing. The install-level test is rate limited like the wizard's (the same bucket, 429 with `Retry-After`).

**Idle away (M14-18).** A department may set `idle_away_minutes` (null, or 10 to 240). The admin app reports "active in the last minute" over the `/staff` socket (`presence:active`, at most once a minute per tab, carrying the brand and nothing about what was done). A person is `away` while the time since their last report, from any of their tabs, is at least the **shortest** limit among the departments that set one and whose rotation includes them (they can work it and are in rotation); the sweep that runs every 30 s on every replica marks them, and exactly one replica announces it. Any report ends the idle mark. An explicit Away is a separate reason and is never ended by activity; choosing Online ends both. Idle away is `away`, not `offline`: the rotation skips the person, the widget does not list them as online, the notification presence hold treats them as away (§20), and the offline auto-unassign timer is **not** started and, if one fires, finds them not offline and does nothing. Going offline forgets the clock and the mark; the next arrival starts online. A department that turns the limit off releases the people it had marked at the next sweep; a sweep that cannot read the limits changes nothing.

### 12.1 Staff authentication factors

Staff credential sign-in counts failures only in a sliding 15-minute window, in two buckets. The **address bucket** (10 per address) guards the password and is spent only by the password step. The **IP bucket** (100 per IP) is spent by the password step, by passwordless passkey sign-in (a failed assertion keeps its slot, a success and the options give theirs back) and by every second-factor step (TOTP, recovery code, passkey, sign-in enrolment, including an unknown or expired challenge; a passkey's options give their slot back). A second-factor step never spends, and is never refused by, the address bucket: otherwise anyone who knew a staff address could lock that person out of an SSO, magic-link or OAuth sign-in with junk passwords. Guesses at a code are bounded per account instead: an attempt is reserved atomically on the challenge (three) and on a per-user counter that survives across challenges *before* the code is evaluated, so no more than three codes are ever evaluated for an account within 15 minutes of each other, measured from the last reservation (the counter's expiry slides, it is not a fixed window), even in a parallel burst; a reservation past three sets the 15-minute account lock (`totp-locked`) and is refused unevaluated, and a wrong third code sets it too. A correct code spends the challenge in one atomic step that fails if a lock has landed meanwhile, so no session opens after the lock. Only a holder of a live challenge, who has proved the first factor, can spend that counter, so junk passwords cannot lock anyone out; it is cleared when a sign-in completes through a code, a recovery code or a passkey second factor. A passwordless passkey sign-in neither reads nor clears it (see §12.1 rule 4). In-flight verification reserves a slot atomically; a proved password that issues a TOTP or required-enrolment challenge atomically removes its own entry from both buckets, preserving earlier failures. Abandoning that challenge adds no password failure. Address failures are cleared, and the successful attempt refunded from the IP bucket, only when every required factor has succeeded and a session opens; no other path refunds or resets either bucket, except that minting a passkey's options (which evaluates no answer) gives back the IP slot it took. Earlier IP failures remain until they expire. SSO discovery, starts and callbacks use separate buckets. Refusal is HTTP 429 with the same body for either bucket and for known or unknown accounts; `Retry-After` is the rounded-up seconds until the oldest failure expires, taking the larger wait when both buckets block.

The rules arrive with the M18 deliverables that implement them ([plan](../in-development/M18-sign-in-options.md#domain-rules-to-add-or-change-proposed)).

1. **Passkey origin** (M18-01, [ADR 0050](../decisions/0050-passkeys-for-staff-over-webauthn.md)). The RP ID is `APP_URL`'s host and the one expected origin is `APP_URL`'s origin, never a request header. The RP ID is pinned in `auth.webauthn.rpId` by the first successful registration, and afterwards moved only by rule 6's install-admin "Move passkeys"; while `APP_URL`'s host differs from the pin, every passkey ceremony is refused (`passkeys-rp-changed`) and the other methods keep working. Passkeys exist only on https, or `http://localhost`, and on a host name rather than an IP address. A ceremony is spent when it is checked, success or failure, lives five minutes, and is bound to one purpose (`register`, `second-factor`, `passwordless`, `step-up`, `break-glass`); every purpose but `passwordless` is bound to one user, and a registration to one session family too. An attestation statement other than `none` or a `packed` self-attestation is refused, as is client data made inside a frame. User verification is required for `passwordless` and `break-glass` and preferred otherwise. A signature counter is compared only once either side is non-zero, and only after the signature verifies.
2. **Adding, renaming and removing a passkey** (M18-02) each need a step-up: the current password, a live authenticator code, or an assertion from a passkey the account already holds, from the one step-up budget (5 per 15 minutes per account). A person holds at most 10; removing the last passkey of an account that must have a second factor (an Admin, an install admin, `auth.require2fa`) and has no authenticator app is refused (`second-factor-required`); both are decided under a lock on the account row. An addition or a removal sends the holder a `securityChange` email through the outbox, and each change writes `auth.passkey.added`, `.renamed` or `.removed` in install scope. A password reset keeps every passkey.
3. **A passkey as the second factor** (M18-03) answers the challenge at `POST /api/auth/passkey/second-factor/{options,verify}` beside TOTP and recovery codes, and at `POST /api/auth/enrolment/passkey/{options,confirm}` for an account that holds an enrolment challenge. Its ceremony is bound to the person and to the challenge, is spent when it is checked, and needs user presence only. A passkey, a code and a recovery code draw on **one** budget: an attempt is reserved atomically on the challenge and on the per-account counter before the answer is evaluated, and the challenge is spent by the one atomic step that fails if a lock has landed, exactly as for a code. A passkey that does not verify (another person's, an unknown credential, another origin or challenge, a regressed counter, a spent ceremony) is `passkey-invalid` and costs an attempt; a closed browser prompt costs none. "Has a second factor" is TOTP enabled **or** at least one passkey; removing a passkey, turning the app off, adding the first passkey, confirming the app, redrawing the recovery codes with a code and completing a sign-in enrolment (check and enable together) all take the account-row lock, so an account that must have a second factor can never be left with none by two requests at once. The recovery codes are drawn with the first second factor of either kind, kept while either remains, forgotten with the last, and redrawn with a live code or a passkey assertion. An enrolment challenge is honoured only while the account has no second factor; staging a TOTP secret never replaces one that is on. Under SSO enforcement a passkey second factor is allowed after an SSO assertion and after the password of a configured break-glass install admin (M18-05, [ADR 0053](../decisions/0053-break-glass-with-a-passkey.md)), where its ceremony has the `break-glass` purpose and requires user verification, and only a passkey that registered with user verification (`webauthn_credentials.user_verified`) makes an admin eligible; after any other local first factor it is refused. A ceremony minted before enforcement came on is refused when checked. Deleting an account deletes its passkeys.
4. **Passwordless passkey sign-in** (M18-04) is `POST /api/auth/passkey/{options,verify}`: a discoverable credential, `userVerification: required`, and no `allowCredentials`, so the options are identical for every caller and name nobody. An assertion with user verification is both factors: the session opens with `method: passkey, secondFactor: passkey-uv` and no second step, and a trusted-browser cookie or a recovery code has no role. Every refusal that could reveal whether an account exists (an unknown credential, a bad signature, no user verification, another origin, a regressed counter, a spent ceremony, a deactivated person, an account with no role in any brand, a user handle that is not the owner's) answers `invalid-credentials`; the reason goes to the audit trail only. An unknown credential is checked against a throwaway key so it does the same cryptographic work as a known one. Failures spend the **same per-IP bucket** as the password step (a success gives its slot back, and fetching options gives theirs back), the ceremony is spent when it is checked, the brand-membership check of every other sign-in runs before the session opens, and the counter and `last_used_at` are written only after it does. The second-factor lock and failure counter bound guesses at a six-digit code, and an assertion with user verification is not a guess: a locked account can still sign in with its passkey, and doing so leaves the counter and the lock untouched. Both routes are refused with `sso-required` under SSO enforcement, before anything is spent.
5. **A recovery code after SSO under enforcement** (#387, owner decision 2026-10-21). A sign-in that began with an SSO assertion may finish with a single-use recovery code, spent and budgeted exactly as an app code or a passkey second factor is; a trusted browser still does not qualify. A password first factor still never takes one: break-glass remains an app code or a user-verified passkey (rule 3, [ADR 0053](../decisions/0053-break-glass-with-a-passkey.md)). An SSO user whose IdP does not vouch for MFA and who lost the phone their authenticator was on would otherwise be locked out with no admin reset, and one spent recovery code is stronger than the no second factor that an SSO assertion alone already allows.
6. **Moving the passkeys** (M18-06) is the only way the pinned RP ID changes after the first registration. An install admin may do it only while passkeys are paused (the pin is not `APP_URL`'s host) and `HD_AUTH_WEBAUTHN_RP_ID` does not pin it (`not-paused`, `pin-locked`, both `409`), after a confirmation that says every passkey stops working. It is one transaction: it moves the pin only while it still holds the old host (so two moves cannot both run), locks the holders' account rows in id order (rule 3), deletes every passkey on the install, forgets the recovery codes of each holder with no authenticator app, writes `auth.passkey.rp_moved` and queues each holder's notice through the outbox; a failure in any step leaves all of it undone. It is refused (`move-blocked`, `409`) while it would leave a configured SSO break-glass account ineligible under enforcement, or an account that must have a second factor with only passkeys; `GET /api/install/passkeys` carries the counts so the admin can add authenticator apps first. A passkey made for the old host is never kept, because it cannot sign and would still count as a second factor.
7. **Replacing the authenticator app** (#373). The security page's *Replace app* swaps an enabled app's secret in one confirmed step, so an account that must have a second factor and holds only the app can rotate it where turning it off is refused and enrolling over it is refused. The start proves a step-up — one of: a live code from the current app, a single-use recovery code (spent; refused with `recovery-code-not-allowed` (403) before any attempt is spent to a break-glass account — on the list or eligible for it — while SSO is enforced, since ADR 0053 keeps recovery codes out of break-glass and one must not install its next factor; `SsoSignInPolicy.recoveryCodeBarred` is the single place that decides, and it reads inside the caller's transaction (widened to the install scope by `withInstallScope`) rather than taking a second pooled connection, so concurrent requests cannot exhaust the pool; the profile's `recoveryCodeProofAllowed` tells the page to hide the option), an assertion from a passkey the account holds, or the current password with a recovery code — and stages a fresh secret in Redis, sealed, for fifteen minutes; the confirm takes a live code from the **new** app and swaps the secret in one transaction under the account-row lock, so a failure anywhere keeps the old app working and an account that must have a second factor is never left with none. The start takes the same account-row lock before it reads the recovery codes. The staged secret is bound to a digest of the secret it replaces, an account has one open rotation, and any change of factor ends it; the swap names the secret it replaces, so a rotation whose app was turned off, re-enrolled or already replaced is refused. After the commit the confirm code's time step is recorded as used, so that code cannot also sign in. The start refuses an account with no app (`totp-not-enabled`) before any proof is spent. Both requests draw on the step-up budget (five per fifteen minutes), the confirm code is checked against the staged secret alone, and the single-use staged record is what stops a confirmation being replayed. A success emails the holder (`securityChange`, `twoFactorRotated`) through the outbox and writes `auth.second_factor.rotated`; the recovery codes stay. Another person's second factor is reset only by an install admin, under rule 8.
8. **An install admin resetting another person's second factor** (#398). `POST /api/install/staff/:userId/second-factor/reset` (`@Requires('install:admin')`, an audited install-scope path; `GET` on `/api/install/staff/:userId/second-factor` lists what a reset would remove) is the one way back for a person who lost both their phone and their recovery codes. The server re-checks that the caller is an active install admin, that the target is not the caller (`self`, 409), and that the target is active and holds a second factor (`not-resettable`, 409); an admin resets their own factors on their own security page. The body carries the admin's own step-up (the password, a live app code or a passkey assertion, drawn from the one step-up budget) and the digest of the factors the confirm dialog listed; the digest covers the sealed app secret, the passkey ids and the recovery codes, and a mismatch is `second-factor-changed` (409) with nothing changed. While SSO is enforced, resetting the last configured break-glass account that is eligible now is refused (`last-break-glass`, 409; `SsoSignInPolicy.isLastBreakGlass`). Each admin gets ten requests an hour (`second-factor-reset`, refused attempts included, listed in the operations guide) and the next answers `reset-rate-limited` (429). The refusals that need no proof come before the step-up, so they spend no attempt. In **one transaction, under the target's account-row lock** (rule 3): the authenticator secret, every passkey and the recovery codes are deleted, the person's sessions and trusted browsers are revoked before the commit (a revoke that fails rolls the whole reset back, so factors are never removed with sessions alive; a reset that rolls back after a successful revoke may still have signed the person out) and again after it, for a sign-in that finished with the old factor in the milliseconds between, whose failure is logged at error level, `auth.second_factor.reset` is written in install scope with the actor, the target and the counts removed, and the `securityChange` notice (`secondFactorReset`, naming the administrator) goes through the outbox; a failure in any step leaves every factor in place. Both account rows (the admin's and the target's) are locked in id order before any proof, so two admins resetting each other cannot deadlock. The person is then in the state of a newly promoted Admin: no second factor, so wherever one is required (an Admin, an install admin, `auth.require2fa`) the next sign-in goes to enrolment before a session opens, and elsewhere enrolment stays optional: a person whose role does not require a second factor is left with password-only sign-in until they choose to enrol, and the confirm, the toast and the email say so (`enrolmentRequired` in the summary, `required` in the notice).

---

## 13. Outbound network safety

Applies to the crawler, webhook deliveries, remote-image proxy, Notion and Google Drive connectors, and any feature that fetches a URL supplied by a user.

- Only `http` and `https`. No credentials in URLs. Max 5 redirects; **every hop** is re-validated.
- Resolve the hostname first, then connect to the resolved IP with the `Host` header set, so DNS rebinding cannot swap targets. Block loopback, private (RFC 1918), link-local, CGNAT, multicast, and cloud metadata ranges for both IPv4 and IPv6, including IPv4-mapped IPv6.
- Timeouts: 10 s connect, 30 s total. Response cap: 10 MB for crawl pages, 1 MB for webhook responses, 20 MB for proxied images. Crawler respects `robots.txt` and a per-source rate limit.
- Install-level allow-list `OUTBOUND_ALLOW_CIDRS` lets an operator permit internal destinations explicitly (for a private Notion proxy, for example). Every blocked attempt is logged with the destination.
- Webhook responses are never followed, rendered, or stored beyond status code and the first 1 KB of body for the delivery log.
- **The Graph client** (M10, [ADR 0025](../decisions/0025-meta-channels-through-one-graph-adapter.md)) goes through this client with an allow-list of hosts: `graph.facebook.com`, `graph.instagram.com` and the media hosts `lookaside.fbsbx.com` and `*.fbcdn.net`, or the roots `META_GRAPH_API_ROOT` and `META_INSTAGRAM_API_ROOT` point at. A media URL inside a webhook payload is user-supplied input and is fetched only when its host is on that list; a WhatsApp media URL is fetched with the account's token in the `Authorization` header, which the client sends only to hosts on the list.
- **Model endpoints.** Chat completions go through the model vendors' own clients, outside this client ([ADR 0018](../decisions/0018-pi-ai-provider-layer.md)), so the AI provider base URL, the embeddings URL and the transcription endpoint are checked when an admin saves them: `https` only and no blocked range, unless the address is inside `OUTBOUND_ALLOW_CIDRS`, which is also what lets a local Ollama use `http`. Embeddings and transcription are checked again by this client on every call.

---

## 14. Performance test conditions

The numbers in the PRD are measured under these conditions; a change to the conditions is a PRD change.

- **Host**: 2 vCPU, 4 GB RAM, SSD, Linux. Compose with 2 `api` replicas, 1 `worker`, Postgres and Redis on the same host. No CDN.
- **Dataset**: 5 brands; the measured brand has 50 000 tickets, 200 000 messages, 20 000 contacts, 2 000 articles in two locales, 50 000 knowledge chunks.
- **Load**: 50 concurrent staff sessions listing and opening tickets; 200 concurrent widget sessions sending one message per minute. Measured over 10 minutes after 2 minutes of warm-up; p95 reported.
- **Widget**: the initial `widget.js` is ≤ 40 KB gzipped and contains everything needed for the chat mode's first paint. Lazy chunks (voice recorder, help center browser, emoji picker, file upload) are each ≤ 20 KB gzipped and ≤ 100 KB in total. First paint is measured with Playwright's "Slow 3G" preset on a page with nothing else on it.
- **Help center TTFB** is measured on a cached page; cold render must stay under 800 ms.
- **Realtime latency** is agent reply submit → widget render, same host, no throttling.

---

## 15. Product metrics

Technical gates alone do not show whether the product works for people. Tracked per install in the System page, and in the release checklist:

| Metric | Definition |
|---|---|
| Activation | An install that receives its first ticket from a non-manual channel (email, widget, Telegram, form, API) within 7 days of the wizard |
| Agent efficiency | From the ticket list, replying to a ticket takes ≤ 3 clicks; measured in the M9 usability pass with three outside testers |
| AI deflection rate | Conversations where an AI auto-reply was sent, the visitor did not request a human, no staff replied, and the conversation closed or went inactive for 24 hours, divided by conversations where auto-reply was eligible. Reported per brand and per language. |
| Handoff quality | Share of handoffs where the visitor's first message after handoff is not a repeat of the original question, sampled monthly |
| Help center self-service | Article views that were not followed by a ticket from the same visitor within 1 hour, divided by article views |

---

## 20. Notification delivery

How staff notification **email** reaches a person (M14-10, [ADR 0037](../decisions/0037-paced-notification-email-and-digests.md)). The bell is always immediate and push stays immediate; both obey a pause. Sections 17 to 19 are reserved for the rules other 1.x plans propose.

- **Schedules.** Per person, the same in every brand: *Right away* (the default, for existing accounts too), *Hourly digest* (at the top of each hour), *Daily digest* (at an hour 0–23 in the person's time zone; the brand's until M14-12 gives people their own), or *Off*.
- **Right away pacing** (install settings `notify.email.*`, `HD_NOTIFY_EMAIL_*`; defaults in brackets): the first email waits [2 min] from the first notification and gathers what arrives meanwhile; each next one waits a back-off step [10, 20, 40, 60 min, the last repeating] after the previous email; [2 h] with nothing arriving or sent resets the back-off. A mention, SLA breach or escalation may cut the wait, no more often than every [5 min] and [8] times a day. Every person gets at most [6] notification emails an hour and [40] a day from one brand, digests included; the windows start at the first email in them. Pacing state is in Postgres (`notification_email_pacing`, `notification_email_batches`), one row per person and brand, and every path that changes a person's batches takes that row's lock first.
- **Re-checked at send time**, for every row of a batch, in this order: the ticket exists and the recipient still holds a role in the brand whose department scope covers it, and is not deactivated (else `skipped_scope`); unread (else `skipped_read`; opening the ticket reads it); the schedule is not Off, they have not unsubscribed, and the row was made with email on (else `skipped_off`); not paused (else `skipped_paused`). A skipped row is never sent later. An install without SMTP settings marks rows `skipped_unconfigured` at scheduling, without opening a batch or presence hold; send time checks SMTP again in case it was removed.
- **Presence hold.** While the recipient is online (not away) in the brand, a Right away email waits until they have been away or offline for 5 minutes, measured from the last time the send found them online, or 15 minutes in all, whichever is first (owner decision D-27).
- **Pause** (until a time at most a year ahead) drops, never delays: rows that arrive during it are `skipped_paused` and stay in the bell; a batch that comes due during it is skipped; nothing is sent when it ends. Push is not queued while paused.
- **Digests are per brand** (§1.4, owner decision D-26): `notify.digest.tick` runs hourly and fans out one job per brand; a person in three brands gets up to three digests, each naming its brand. A local hour that happens twice sends one daily digest, guarded by the represented tick hour rather than batch creation time; one that does not exist sends none. Daily rows over a cap at their tick wait until the next day, and a missed cron hour skips that day. Ticks run at UTC hour boundaries, so in half-hour or quarter-hour zones the chosen hour sends at the tick within that local hour (08:30 for hour 08 in Asia/Kolkata).
- **Jobs.** `notify.email_schedule` (on `notification.created` with email on; the row's state is its key), `notify.email_batch` (job id `notify.batch.<batchId>`, receipt `notify.email_batch:<batchId>`, `Message-ID` `<notify.batch.<batchId>@<APP_URL host>>`), `notify.digest.tick` (hourly cron), `notify.email_rebuild` (boot and hourly). A batch job that wakes early, over a cap or held moves itself to the time it may go.
- **Upgrade.** Both retired `notify.email` jobs and new schedule jobs recover legacy null-state rows only when email is on, the row is at most 24 hours old, and the old transactional `notify.email:<id>` receipt is missing. Otherwise they drop the row with an info log.
- **Failure bound.** Send/render failures are counted on the batch only on a job's last attempt. Retries within one job do not exhaust the batch budget; fresh jobs from hourly rebuilds can add failures. Database and other infrastructure errors are never counted. After five exhausted send jobs, pending rows become `skipped_failed` and the batch `failed`, freeing its pending slot. The terminal transition logs once at warn.
- **Unsubscribe** (M14-11). Every notification email, digests and the test email included, carries `List-Unsubscribe` (the HTTPS one-click address) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, and a footer link to a confirmation page (§4.6 has the token). Unsubscribing is global to the person, sets `email_unsubscribed_at` and leaves the matrix, schedule and pause; the send-time re-check then marks rows `skipped_off`. Only the person turns it back on (`emailUnsubscribed: false` on their own preferences). *Send me a test email* goes to the caller's own address, through the outbox, at most 5 an hour, and ignores pause and unsubscribe because the person asked for it.
- **Content.** References and who did what; one notification is 1.0's email, several are grouped into *Needs you now* (mentions, breaches, escalations) and *Tickets*, folded per ticket and per bulk operation. In the recipient's language, right to left for Arabic.

---

## 16. Change log

| Date | Change |
|---|---|
| 2026-09-16 | Initial version, written to close the review findings on PRD 1.0. |
| 2026-09-27 | §3.4: the timer key is spelled with dots, as BullMQ requires (M3-02). |
| 2026-10-11 | The Meta channels (M10, [ADR 0025](../decisions/0025-meta-channels-through-one-graph-adapter.md)): §2.5 and the new §2.6 reply-window rule; §4.4's three scoped ids and the first verified phone, a WhatsApp `wa_id`; the new §4.7 identities and §4.8 message kinds; §6's keys; §11's delivery logs and erasure; §13's Graph client. |
| 2026-10-18 | §7: imported tickets join the widget queue only when their customer continues them live (M11-17). |
| 2026-10-20 | The new §12.1 Staff authentication factors, with its first rule, passkey origin (M18-01, [ADR 0050](../decisions/0050-passkeys-for-staff-over-webauthn.md)). |
| 2026-10-20 | §12: Microsoft sign-in joins the OAuth row, bound by `<tid>:<oid>` and linked by address only for a verified-domain member of the one pinned tenant (M18-08, ADR 0051). |
| 2026-10-20 | §12: the SSO first-link rule, with Entra ID's `xms_edov` from members of the one tenant a connection names (M18-09, ADR 0026). |
| 2026-10-20 | The new §2.8: every ticket records how it arrived, and the routing trail is derived from activity under the ticket's department policy (M14-08). |
| 2026-10-21 | §12: idle away, a department limit of 10 to 240 minutes ended by a report of activity from any tab; away is not offline (M14-18). |
| 2026-10-21 | §12.1 rule 3: break-glass with a passkey; enforcement precondition is a password and (TOTP or a passkey) (M18-05, ADR 0053). |
| 2026-10-21 | §12.1 rule 4: passwordless passkey sign-in, with the shared per-IP bucket and the single `invalid-credentials` refusal (M18-04). |
| 2026-10-21 | §12.1 rule 2: adding, renaming and removing a passkey need a step-up, at most 10 per account, the last-factor refusal, the `securityChange` email and the audit rows (M18-02). |
| 2026-10-23 | §12.1 rule 5: a single-use recovery code may finish a sign-in that began with an SSO assertion under enforcement; break-glass and trusted browsers still refuse it (#387, owner decision 2026-10-21). |
| 2026-10-23 | §12.1 rule 7: replacing the authenticator app in one confirmed step — step-up (app code, recovery code, passkey, or password with recovery code), a staged secret, the swap under the account-row lock, the security email and the audit row; no admin reset exists (#373). |
| 2026-10-24 | §12.1 rule 7: `recoveryCodeBarred` reads inside the caller's transaction, so concurrent profile requests cannot exhaust the connection pool. |
| 2026-10-24 | §12.1 rule 8: an install admin resets another person's second factor in one transaction under the account-row lock, bound to a digest of the factors shown, refused for self and for the last break-glass admin, rate limited per admin, audited and emailed (#398). |
| 2026-10-20 | §2.1, §2.2, §3.2, §3.4 and §3.6: the Snoozed status, its wake paths, the per-clock pause and the wake timers (M14-02, [ADR 0035](../decisions/0035-snooze-as-a-system-status.md)). |
| 2026-10-20 | New §20 Notification delivery: email schedules, Right away pacing, the send-time re-check, the presence hold, pause and per-brand digests (M14-10, [ADR 0037](../decisions/0037-paced-notification-email-and-digests.md)); §6's email key, §10's rebuild and §11's batches follow. |
| 2026-10-20 | The new §2.7 Bulk changes: preview, all-or-nothing apply against the previewed set, the lock order, the operation log and a 60-second Undo; §11 keeps operations 7 days (M14-03, [ADR 0036](../decisions/0036-bulk-changes-previewed-all-or-nothing-with-undo.md)). |
| 2026-10-21 | §4.6 and §20: the notification email unsubscribe token (HMAC under an HKDF key for `notify-unsubscribe`, one year, no oracle, idempotent), the RFC 8058 headers and the test email (M14-11, [ADR 0037](../decisions/0037-paced-notification-email-and-digests.md)). |
| 2026-10-20 | The new §2.9: Test routing walks a sample through the arrival path read-only, with the engine's own evaluation order, and shows no rotation outside the reader's scope (M14-09). |
| 2026-10-21 | The new §2.10: an agent appears to customers by a public name (the first name until set), with a title, an optional presigned photo and agent placeholders; §20's digest hour and the snooze presets read the person's own time zone (M14-12). |
| 2026-10-21 | §12.1 rule 6 and rule 1: moving the passkeys when `APP_URL`'s host changes is the one later change to the RP ID pin; atomic, refused when it would lock out break-glass or a required second factor (M18-06). |
| 2026-10-23 | §2.10 review fixes: §2.10.4 restated as "the online line carries names only" — a photo URL is issued solely for a message's author in the visitor's own conversation; §2.10.1's history sentence corrected (the email `From` header used to carry the full name); profile text fields refuse control and format characters. |
| 2026-10-24 | §12: a magic-link or password-reset request is refused with `email-unavailable` for every address alike while the install has no system sender, before any lookup or budget, and `sso-required` is answered first when SSO is enforced; a stored SMTP password is used (by a save or a test, install or brand) only while host, port and username are unchanged, otherwise `smtp-password-required` (#369). |
| 2026-10-23 | §2.2: a status moved into a closed state closes its live tickets after a typed count is confirmed, in batches and without surveys; moving it out of one is refused while it holds tickets (#361). |
| 2026-10-23 | §2.1 and §2.2: a rule's or a macro's **snooze action** — one of the Snooze menu's presets, resolved by the server against the ticket's department calendar when it runs, with the wake timer, activity and outbox event a person's snooze writes; `snoozed_by` stays null for a rule (#368). |
| 2026-10-23 | §2.2: the Agent-closes row gains the required-to-close gate (M14-17, owner decision D-30) — a person's or an API key's close of a ticket with an empty required-to-close field is refused `fields-required-to-close` naming the keys, the system's closes (rules, time-based rules, merges, spam) go through and record `closedWithout` in the activity. |
