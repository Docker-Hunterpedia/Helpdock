# Automation: workflow rules and time-based rules

How a brand acts on tickets without a person doing it: rules that run when
something happens to a ticket, rules that run on a schedule over tickets that
have waited too long, the depth guard that keeps rules from looping, the
execution log, the test run, and the Routing tab that explains how a new ticket
is routed and tests it. The screens are **Settings → Inbox → Rules, Time-based, Routing and Macros**
(M3-03, M3-04, M3-05, M14-09; [REQUIREMENTS §4.3](../planning/REQUIREMENTS.md#43-automation)).

The **Macros** tab is M3-06's and has its own guide, [macros.md](macros.md).
An Agent sees that tab alone.

## Who may do what

| | Admin | Team Leader, whole brand | Team Leader, some departments | Agent, Viewer |
|---|---|---|---|---|
| Open Automation, read the rules | yes | yes | yes | no |
| Read the execution log | yes | yes | runs on their departments' tickets | no |
| Add, edit, reorder, switch on or off, delete a rule | yes | yes | no | no |
| Test-run a draft | yes | yes | on tickets they can see | no |
| Read the Routing tab and run Test routing | yes | yes | only the entry points and departments in their scope | no |

Every route is `ticketing:manage`. A rule is **brand-wide** — a rule saved by
the lead of Billing would act on Returns' tickets as well — so changing one is
refused (403) to a Team Leader whose scope is narrower than the brand. The log
is department-scoped like every other child of a ticket (DOMAIN-RULES §1.3).

## A rule

`WHEN <event> IF <conditions> THEN <actions>`, in one form.

**When.** An *event rule* names one of these events; a *time-based rule* names
an interval instead (every 15 or 30 minutes, every hour, every 6 hours, every
day).

| Event | Started by |
|---|---|
| Ticket created | A new ticket, whatever the channel |
| Ticket updated | Any change to the ticket |
| Customer replied, Agent replied | A public reply, by its author. A rule's own canned reply starts nothing, so a reply rule cannot answer itself |
| Status changed | A move to another status, including a close and a reopen |
| Assigned | The assignee or the team changed |
| Tag added | A tag was put on the ticket |
| SLA warning, SLA breach | M3-02's `sla.warning` and `sla.breached` events |
| CSAT received | `csat.received`: a customer answered a survey on the rating page, in the widget or with a Telegram button (M8-06) |

**If.** The ticket matches *all* or *any* of the rule's groups, and each group
*all* or *any* of its conditions. A rule with no groups runs on every ticket its
event reaches. Conditions:

| Field | Operators |
|---|---|
| Subject, Contact email, a custom field | contains, does not contain, is, is not, is set |
| A **person** custom field (M14-27) | is, is not, is set; the builder shows a picker of staff by name, and a person who is not staff of the brand is refused when the rule is saved. A *Set a field* action on a person field picks the person the same way. Long text, link and email fields use the text operators, long text starting on *contains*. |
| Body (the newest public message from the contact) | contains, does not contain |
| Channel, Priority, Department, Status | is, is not, is any of |
| Team, Assignee, Tag, Account | is, is not, is any of, is set |
| Time in status | for more than, for less than (hours or days) |
| Business hours | is inside, is outside |
| Mailbox (the one the ticket arrived at) | is, is not, is any of |
| Written to (the address the customer wrote to) | is, contains |

Text matching ignores case and Unicode compatibility forms, so "Refund" finds
"refund" and an Arabic word matches however it was typed. Time in status is
measured from `tickets.status_changed_at`, which a database trigger sets on
every change of status. Business hours read M3-01's calendar for the ticket's
department: its own hours and holidays if it has them, otherwise the brand's
([the SLA guide](slas.md#business-hours)).

**Then.** Actions run in order: set status, set priority, set a custom field,
assign to a team, an agent or the department's round-robin, add or remove a tag,
send a canned response, add an internal note, notify, escalate, close, snooze,
set the reply address, mark as spam, and AI triage.

- Assigning to a team in another department **moves the ticket there**, and
  takes it off an assignee who cannot follow; a ticket left unassigned is handed
  to the department's rotation, if it has one.
- A status change goes through the same transitions as an agent's
  ([DOMAIN-RULES §2.2](../planning/DOMAIN-RULES.md#22-transitions)): a close
  schedules the survey an agent's close would, and a change of status, priority
  or department moves the [SLA clocks](slas.md) as an agent's change would.
- **Snooze** (#368) picks one of the [Snooze menu's](snooze.md) four times —
  in 1 hour, in 4 hours, next business day, next week — and the **server**
  resolves it to an instant against the ticket's department calendar when the
  rule runs, so a rule and the menu offer the same wake time. Everything the
  wake needs is a person's snooze's: the same activity, the same `ticket.snoozed`
  outbox event and wake timer, the same clocks. A closed ticket is recorded as
  *not carried out*, as a person's is refused. Setting the Snoozed status with
  *Set status* is still refused at save, because a bare status carries no wake
  time; the snooze action is the way to put a ticket away. The action goes
  through the same planner as the menu, so the bounds are the menu's too: a time
  under 5 minutes or over 90 days ahead is recorded as *not carried out*.
  **It never runs on a wake.** A run started by a snooze ending by itself (its
  time came, an SLA step fired, or the customer replied) and every run that
  chain sets off record the action as *not carried out* with the reason *the
  ticket was just woken*, so a `ticket_updated` rule cannot put the ticket back
  to sleep for ever and a customer's reply is never hidden
  ([DOMAIN-RULES §2.2](../planning/DOMAIN-RULES.md#22-transitions)).
- **Mailbox and Written to** (M14-26) are judged on the ticket's *arrival
  record* ([DOMAIN-RULES §2.8](../planning/DOMAIN-RULES.md#28-arrival-and-the-routing-trail)):
  the mailbox it came in at, and the address the customer wrote to, which is
  how an alias that forwards into one mailbox is told apart. **A ticket that did
  not arrive at a mailbox never matches either condition, whatever the
  operator**, so *is not* cannot claim a ticket with no mailbox. That covers
  every ticket filed before 1.1 (they have no arrival record) and every ticket
  from the widget, a form, Telegram or Meta. The address is withheld from the
  stored run log, like the subject.
- **Set reply address** (M14-26) makes later public replies on email leave from
  one of the brand's mailboxes, in place of the department's sender. It is
  accepted only for a mailbox *of the ticket's department*, checked when the rule
  runs: another department's, or a deleted one, is logged as *not carried out*.
  The composer's From select lists it first and preselects it, and an agent who picks another From wins for that reply. It only counts while the mailbox still belongs to the ticket's department: after a transfer, replies go back to the department's sender.
  Auto-replies, surveys and transcripts keep the department's sender. Deleting
  the mailbox puts the department's sender back.
- **Mark as spam** (M14-26) is the same transition as a person's *Mark as spam*:
  the Spam status, no auto-reply, no survey, left out of reports
  ([DOMAIN-RULES §2.2](../planning/DOMAIN-RULES.md#22-transitions)). An
  acknowledgment, out-of-hours reply or survey that was already queued when the
  rule ran is discarded unsent, not delivered. A merged or deleted ticket is
  recorded as *not carried out*. It does not block the sender; do that from the
  ticket.
- A canned reply is a public message written by the system. It **does not stop
  the first-response clock** unless the action's *Counts as first response* box
  is ticked (`counts_as_response`, DOMAIN-RULES §3.1). The builder offers the
  brand's **shared** canned responses ([macros.md](macros.md)); the reply is
  written in the contact's language, else the brand's, with the assignee as
  `{{agent.first_name}}`. A canned response deleted since the rule was saved,
  or a personal one, is recorded as not carried out and the rest of the rule
  still runs.
- *Notify* resolves who — the department's team leads, the assignee, a team, a
  person — and writes a `rule.notify` outbox event; M3-07 delivers it as an
  escalation notification, under the same scope and deactivation rules as
  every other ([the notifications guide](notifications.md)), with the rule's
  message quoted.
- *Assign* to an agent tells them as a person's choice would, with
  `ticket.assigned` naming a rule; assigning to a team or to round-robin tells
  whoever the rotation then picks.
- An action that cannot be done — a team that was deleted since the rule was
  saved, an agent who cannot work the department — is logged as *not carried
  out* and the others still run. An action that would change nothing writes
  nothing, so it cannot set off another rule.

Every change a rule makes is in the ticket's activity log with actor
`rule:<id>` and *via* `rule`.

### AI triage

*AI triage* (M7-07) has the assistant decide the ticket's **tags**,
**priority** and **department** — any of the three, at least one — choosing
only among the brand's existing tags and departments:

| Mode | What happens |
|---|---|
| Suggest for an agent to accept | The ticket's Suggested fields card shows the choice; nothing changes until an agent accepts a field |
| Apply to the ticket | The rule makes the changes itself, as its other actions would: activity with actor `rule:<id>`, the SLA clocks, the rotation when the department moves |

The model is not called while the rule runs: the action queues the work
through the outbox, and the `ai.classify` job does it seconds later, outside
any transaction, logging the call as `triage.classify` against the brand's AI
budget. The run's execution log shows the action as *queued*, then what the
job made of it — *suggested*, *applied*, *nothing to change* or *failed* —
because the job writes its outcome back into the run. A retry never applies
twice. The test run says the triage would be queued and calls no model. See
[the AI guide](ai.md#ai-triage).

## Order

Rules for one event run in list order. Each is judged against the ticket as the
event left it; the ones that match act in order, each on the ticket as the one
before left it, so where two rules set the same field the later one wins. Drag a
rule's handle, press ArrowUp or ArrowDown on it, or use *Move up* / *Move down*
in its menu.

## The depth guard

A rule's actions can set off other rules: assigning a team is an *Assigned*
event. The chain of rules that led to a change travels with its outbox event,
and a run is stopped before it acts when

- the rule is **already in the chain** — a *cycle*, whatever the depth; or
- it would be the **fourth** rule in the chain — *depth*, even without a cycle.

What the rules before it did is kept. The stopped run is logged, the list
tints the rule that was stopped, and a banner names the rules in the loop for a
day, so the person who can fix it sees where. Changing one rule's conditions so
they do not all match is the fix.

## Time-based rules

Every five minutes a tick on the `rules` queue adds one job per brand. Each job
runs the brand's time-based rules whose interval has passed, over the tickets
they match — narrowed in SQL by the statuses and the "for more than" the rule
requires, at most 200 tickets per rule per tick, oldest in their status first.

A ticket is acted on **once per match**: once per stay in the status it matched
in. Closing it ends the match; a customer reply, which moves it out of Awaiting
customer, starts a new one. Only applied and failed runs are logged, because a
tick that finds nothing to do would otherwise log the same skips every five
minutes. What a time-based rule changes is rule 1 of a chain, so event rules can
follow it.

A rule that names no status looks at open tickets only.

## The execution log

Every run of an event rule — applied, skipped, stopped by the depth guard,
failed — and every applied or failed run of a time-based rule, newest first.
Filter by result, or by a rule's name or a ticket reference such as `HD-1042`.
A skipped run says which condition did not match; a stored run never holds the
ticket's text, because the log outlives the reader's view of the ticket. A
stopped run opens out into the chain that led to it.

A rule that fails — a bug, a constraint it trips — is rolled back on its own and
logged `failed`; the rules after it still run.

## The test run

The panel beside the builder tries the **draft on the form** against a real
ticket, by reference. **Nothing is changed, sent or logged.** It says whether the
rule would run and why — each condition with what it found, text included,
because the reader can see the ticket — what each action would do, and which
rules its changes could set off one level on, with whether they would run.

A reference that names no ticket the reader can see answers "no such ticket, or
you cannot see it", without saying which.

## Routing

The **Routing** tab explains, in four numbered steps, what happens to a new ticket,
and each step links to where it is edited:

1. **Arrival.** Every entry point and the department it files into: each mailbox,
   the chat widget, each Telegram bot and Meta account, the web form, and API
   requests (which name their own department). The widget has no department of its
   own and files into the brand's first department; a web form without one does the
   same. The tab says so in words. A per-widget department comes with several
   widgets per brand (M19-02).
2. **Rules on “Ticket created”**, in the order they run, with what each does; a
   switched-off rule reads “Off”.
3. **AI triage**, which runs only when a rule queues it. The tab names the rules that do.
4. **Assignment**, by each department's mode, with the people in its rotation and its cap.

### Test routing

**Test routing** takes a sample (channel and entry point, from, name, subject,
message, language) and shows what a real message would do: the department; whether
the sender is blocked or automated, in which case no ticket would be created; the
contact it would match (the name only) or “a new contact”; each *Ticket created*
rule with its conditions and actions; whether AI triage would be queued; the SLA
policy and the first-response due time; and who the rotation would pick right now,
or that nobody is online or eligible.

**Nothing is created, sent or logged.** No ticket, contact, message, notification,
audit row or rule run is written; no block-list counter, rule counter or rotation
turn moves; AI is never called. Asking twice gives the same pick. See
[DOMAIN-RULES §2.9](../planning/DOMAIN-RULES.md#29-test-routing) for the exact
steps.

Three things the sample cannot show: the rules a rule's changes could set off are listed with whether they would run, but their actions are not applied to the SLA and assignment shown; only the sender's address is judged for
automated mail, so a real message can also be stopped by its headers
(`Auto-Submitted`, `Precedence`); and a rule's conditions are judged on the ticket as
it arrives, as the engine does, so a later rule's *conditions* do not see an earlier
rule's changes (its *actions* do).

A Team Leader whose scope is some departments sees and tests only the entry points
that file into those departments. If a rule moves the sample to a department outside
their scope, the result says so and does not show that department's rotation.

## API

All under `/api/brands/:brandId/rules`, all `ticketing:manage`. Schemas are in
`packages/schemas/src/workflow-rules.ts`.

| Route | Does |
|---|---|
| `GET /rules?kind=event\|scheduled` | The rules, in order, with when each last acted and how often in 30 days |
| `POST /rules` | Create. 400 when it names a status, department, team, tag or person that is not the brand's; 409 past 200 rules |
| `PUT /rules/:ruleId` | Replace the whole rule |
| `PATCH /rules/:ruleId` | `{ enabled }` only: the list's switch |
| `DELETE /rules/:ruleId` | Delete; its runs go with it |
| `POST /rules/reorder` | `{ kind, ruleIds }`: every rule of that kind, in its new order |
| `GET /rules/runs?result=&q=&ruleId=` | The newest 100 runs |
| `GET /rules/options` | What the builder's selects are filled from |
| `POST /rules/test-run` | `{ rule, ticket, ruleId? }`. `{ outcome: null }` when the ticket is not found |

Creating, changing, reordering and deleting a rule is written to `audit_log` as
`workflow_rule.*`.

The Routing tab uses two routes under `/api/brands/:brandId/routing`, both
`ticketing:manage`; their schemas are in `packages/schemas/src/automation-routing.ts`.
Like the other staff-session routes they are not part of the public `/api/v1`
OpenAPI document, which describes the API-key surface only.

| Route | Does |
|---|---|
| `GET /routing` | The entry points with their departments, the *Ticket created* rules in order, the rules that queue AI triage, and each department's assignment mode, in the reader's scope |
| `POST /routing/test` | A sample: `{ entry, entryId, departmentId?, from, fromName, subject, message, language }`. `verdict` is `ticket`, `blocked` or `automated`; 404 for an entry point that does not exist or is outside the reader's scope. Writes nothing |
