# Automation: workflow rules and time-based rules

How a brand acts on tickets without a person doing it: rules that run when
something happens to a ticket, rules that run on a schedule over tickets that
have waited too long, the depth guard that keeps rules from looping, the
execution log, and the test run. The screen is **Admin → Automation**
(M3-03, M3-04, M3-05; [REQUIREMENTS §4.3](../planning/REQUIREMENTS.md#43-automation)).

The **Macros** tab is M3-06's and has its own guide, [macros.md](macros.md).
An Agent sees that tab alone.

## Who may do what

| | Admin | Team Leader, whole brand | Team Leader, some departments | Agent, Viewer |
|---|---|---|---|---|
| Open Automation, read the rules | yes | yes | yes | no |
| Read the execution log | yes | yes | runs on their departments' tickets | no |
| Add, edit, reorder, switch on or off, delete a rule | yes | yes | no | no |
| Test-run a draft | yes | yes | on tickets they can see | no |

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
| CSAT received | `csat.received`, once a survey answer emits it |

**If.** The ticket matches *all* or *any* of the rule's groups, and each group
*all* or *any* of its conditions. A rule with no groups runs on every ticket its
event reaches. Conditions:

| Field | Operators |
|---|---|
| Subject, Contact email, a custom field | contains, does not contain, is, is not, is set |
| Body (the newest public message from the contact) | contains, does not contain |
| Channel, Priority, Department, Status | is, is not, is any of |
| Team, Assignee, Tag, Account | is, is not, is any of, is set |
| Time in status | for more than, for less than (hours or days) |
| Business hours | is inside, is outside |

Text matching ignores case and Unicode compatibility forms, so "Refund" finds
"refund" and an Arabic word matches however it was typed. Time in status is
measured from `tickets.status_changed_at`, which a database trigger sets on
every change of status. Business hours read M3-01's calendar for the ticket's
department: its own hours and holidays if it has them, otherwise the brand's
([the SLA guide](slas.md#business-hours)).

**Then.** Actions run in order: set status, set priority, set a custom field,
assign to a team, an agent or the department's round-robin, add or remove a tag,
send a canned response, add an internal note, notify, escalate, close.

- Assigning to a team in another department **moves the ticket there**, and
  takes it off an assignee who cannot follow; a ticket left unassigned is handed
  to the department's rotation, if it has one.
- A status change goes through the same transitions as an agent's
  ([DOMAIN-RULES §2.2](../planning/DOMAIN-RULES.md#22-transitions)): a close
  schedules the survey an agent's close would, and a change of status, priority
  or department moves the [SLA clocks](slas.md) as an agent's change would.
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
