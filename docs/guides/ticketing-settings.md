# Ticketing settings

How a brand's tickets are shaped and routed: departments, the teams inside
them, and the brand-level behaviour that later deliverables read. The screen is
**Admin → Ticketing**, and this guide follows its tab row.

Eight tabs are built: **Departments** (M1-01), **Statuses** (M1-08), **Tags**,
**Custom fields** and **Templates** (M1-06), **Assignment** (M1-07), **Spam**
(M1-11) and **Feedback** (M1-12). The other two exist so the row is whole and
each says which deliverable fills it: Priorities with M1-02, Views with M1-05.

Who may do what comes from
[DOMAIN-RULES §1.2](../planning/DOMAIN-RULES.md#12-scope-rules). The short
version:

| | Admin | Team Leader | Agent, Viewer |
|---|---|---|---|
| Read the department list | yes | yes | yes |
| Add, delete or reorder departments | yes | no | no |
| Rename a department, set its default team | yes | in the departments they lead | no |
| Add, rename or delete a team | yes | in the departments they lead | no |
| Put somebody on a team, or take them off | anybody | Agents and Viewers only | no |
| Add, edit, reorder or delete a status | yes | yes | no |
| Change the reply behaviour and the reopen policy | yes | yes | no |
| Change the brand's name, language, time zone or settings | yes | no | no |
| Read the tags, custom fields and templates | yes | yes | yes |
| Add, edit, reorder or delete tags, custom fields and templates | yes | yes | no |
| Put tags on a ticket | yes | yes | Agent yes, Viewer no |
| Read, add or remove blocked senders; change the Spam setting | yes | yes | no |
| Mark a ticket as spam, and block its sender from the dialog | yes | yes | Agent yes, Viewer no |
| Change a department's assignment settings | yes | in the departments they lead | no |
| Put somebody in or out of rotation, change their skills | anybody | Agents only, in the departments they lead | no |
| Assign a ticket by hand | to anybody who can work its department | the same, never to an Admin | Agent the same, never to an Admin; Viewer no |

"Which departments a brand has" is the brand's shape, so it stays with the
Admin. "What is inside one" is the Team Leader's, which is what §1.2 means by
"departments they lead".

Tags, custom fields and templates are `ticketing:manage`, which the Admin and
the Team Leader hold: they are the M1 half of "macros, canned responses…" in
§1.2's last column. They are deliberately **not** `brand:manage` — adding a tag
does not change how the brand routes work, and adding a department does. A
template that names a department is narrowed further, to the departments a Team
Leader leads.

---

## Departments

A department decides where a ticket is filed and who can see it. An Agent sees
tickets in their departments and nowhere else, so a brand's departments are the
first thing to get right.

Every brand starts with one, called **General**, created by the first-run
wizard (and by `pnpm --filter @helpdock/api seed:dev` on a development
install).

### The list

Each row shows the department's name, its Arabic name underneath when it has
one, how many teams it holds, how many distinct people are on those teams, and
its default team. The row menu offers **Edit**, **Move up**, **Move down** and
**Delete**.

The order is the brand's own and is what every picker draws. Reordering has
three ways in and one path out: drag the handle, focus it and press `↑`/`↓`, or
use **Move up** / **Move down** in the row menu. All three send the whole list,
so a stale client cannot half-reorder the brand.

### The editor

Selecting a row fills the card in the side column:

| Field | Notes |
|---|---|
| Name | Required, up to 120 characters, unique inside the brand whatever its case. |
| Name (Arabic) | Optional. M1-01 prints it under the Latin name on the department list, in both locales. Customers see it once the help center and the widget render a department. |
| Default team | One of *this* department's teams, or none. Where a ticket lands when no rule picks a team; nothing routes by team yet (M1-07's rotation is per department, and team actions are M3's rules). Deleting that team leaves the department with no default rather than a dangling one. |

### Deleting one

Two things refuse a delete:

- **It is the brand's last department.** A brand with none has nowhere to file a
  ticket, and nothing in the product would create one back.
- **Tickets still belong to it.** Move them first. The count runs in the
  request's own transaction, so the department-scoped policies of DOMAIN-RULES
  §1.3 apply to it — which is safe because deleting a department is
  `brand:manage`, and an Admin's department scope is always "all"
  (`apps/api/src/brands/department-deletion.ts`). Soft-deleted tickets count
  too: they are hidden from views until retention purges them, and a department
  deleted underneath one would leave a row that cannot be restored anywhere.

Deleting a department takes its teams and their memberships with it. It does not
touch anybody's role in the brand.

## Teams

A team is a group inside one department that work can be routed to. Selecting a
department opens its teams under the list.

- A team's name is unique inside its department. The same name in another
  department is fine.
- Members come from a picker that only offers people whose own department scope
  reaches this department — an Agent assigned to Billing is not offered for a
  Technical team, because they could not see the tickets it would be given.
  Deactivated accounts are not offered either.
- **A Team Leader's picker is narrower still.** DOMAIN-RULES §1.2 holds team
  membership to the same ceiling as a role change: a Team Leader adds and
  removes Agents and Viewers, and nobody else. An Admin, another Team Leader —
  and the Team Leader themselves — go on a team only when an Admin puts them
  there. That is what stops M1-07 from letting a Team Leader route work to an
  Admin. The picker is filtered by who is asking, so it never offers a person
  the save would refuse.
- Removing somebody from a team does not change their role in the brand.
- Losing the role does remove them from the lists: the query joins
  `user_brand_roles`, so somebody whose membership was revoked stops appearing
  without the row having to be deleted. Giving the role back brings them back.

Teams are stored and served now. **Assignment** is per department — see
[Assignment](#assignment) — and does not read teams; routing to a team is an
action of M3's rules. **Business hours per department are M3.**

## Statuses

A status is what an agent picks from and what a badge is drawn from. Every one
maps to one of the four **system states** of
[DOMAIN-RULES §2.1](../planning/DOMAIN-RULES.md#21-states) — `open`, `on_hold`,
`escalated`, `closed` — so SLA maths and reports stay the same however a brand
names its own.

Every brand starts with six, written by `seedBrandStatuses` when the brand is
created:

| Name | System state | Flags | Why it exists |
|---|---|---|---|
| Open | `open` | default | Where a new or reopened ticket lands |
| Awaiting customer | `on_hold` | pauses SLA, awaiting customer | §2.1 ships it with every brand |
| Escalated | `escalated` | — | So the fourth state is reachable without adding a status |
| Closed | `closed` | — | §2.2 |
| Spam | `closed` | excluded from reports | §2.1: no auto-responder, no CSAT, out of reports |
| Merged | `closed` | excluded from reports | §2.4: what the secondary of a merge closes into |

### The two flags, and the third

| Flag | Meaning |
|---|---|
| **Pauses SLA clocks** | Both clocks stop while the ticket is in this status (§3.2) |
| **Counts as awaiting customer** | The ball is with the customer; time-based rules and reports read it |
| Excluded from reports | Not editable. Seeded on Spam and Merged; it is why a close into one schedules no survey |

### What a seeded status accepts

A seeded row may be **renamed, given an Arabic name, and recoloured**. Its
system state and its two behaviour flags are fixed, because code refers to the
row by them rather than by its name: the reopen path wants "the default open
status", an agent reply wants "the awaiting-customer status". Changing them
would rename the concept rather than the label, so the api answers
`status-state-fixed`.

Nothing deletes a seeded row (`status-is-system`), and nothing deletes the
brand's default (`status-is-default`) — another status has to be made the
default first, which is a deliberate second step rather than a silent
reassignment.

### The default status

One per brand, and it has to be **open-like**: it is where a new ticket lands
and where a reopen returns a ticket to, so a closed or on-hold default would
mean a ticket created already finished, or a reopen that closes. The api answers
`default-must-be-open` to either way of getting there.

Move it with **Make default** in the row menu. The old default is cleared and
the new one set in one transaction, so there is never a moment with two.

### Deleting one

Only a custom status, and only when it is not the default. Its tickets are
**moved to the brand's default open status** rather than the delete being
refused: a desk that cannot remove "Waiting on supplier" until it has hand-moved
forty tickets will keep the status forever. Each moved ticket gets an activity
row naming the change and an outbox event, so a queue somebody is watching sees
it move.

The screen asks the server for the count **before** it asks the person —
"Delete · 12 tickets move to Open" — because that is a promise about other
people's work and a number guessed in the browser is a promise the browser
cannot keep.

`closed_at` is left alone by the move. The fallback is an *open* status, so a
closed ticket landing on it looks like a reopen — but a status being deleted is
a configuration change, not a customer coming back, and §3.5's clocks are not
restarted for it.

### The order

The brand's own, and what every picker draws. Reordering has three ways in and
one path out: drag the handle, focus it and press `↑`/`↓`, or use **Move up** /
**Move down** in the row menu. All three send the whole list.

## Reply behaviour

The card under the statuses table. It is the two settings
[DOMAIN-RULES §2.3](../planning/DOMAIN-RULES.md#23-reopen-policy) lets a **Team
Leader** change, and it is a route of its own for exactly that reason: `PATCH
/api/brands/:brandId` carries the brand's time zone, which SLA clocks run on and
which §1.2 keeps with the Admin.

| Setting | Default | What it does |
|---|---|---|
| Move to Awaiting customer when an agent sends a public reply | on | §2.2: an agent's public reply on an `open` ticket moves it. A customer reply moves it back |
| When a customer replies to a closed ticket | Reopen if closed within 7 days | §2.3; see [the ticket lifecycle](tickets.md#the-lifecycle) |

The auto-await rule applies to `open` tickets only. A ticket on hold or
escalated is somewhere deliberate, and §2.2 gives the row to `open` alone.

The reopen policy's day count is shown only for "Reopen if closed within…": a
number beside "Always reopen" is a control that does nothing, and a control that
does nothing is one somebody will set and then be surprised by.

Both are stored in `brands.settings`, and this route **merges** rather than
replacing — a key a later milestone adds is not reset by a screen that predates
it. `PATCH /api/brands/:brandId` still writes the object whole, because the
screen there holds the whole object.

## Feedback

The last tab of `Admin/Ticketing` (`AdminTicketingFeedback`, M1-12): customer
ratings and agent time for the brand. One form and one save, because the three
settings are one decision about how the desk works. Like the reply behaviour, it
is `ticketing:manage` — a Team Leader shapes how their desk works — and the route
merges into `brands.settings` rather than replacing it.

| Setting | Default | What it does |
|---|---|---|
| Ask for a rating when a ticket closes (`csatEnabled`) | on | Every close that is not spam or a merge gets a survey (DOMAIN-RULES §2.2). The setting is read in the closing transaction, so a survey follows the setting at the moment of the close. See [satisfaction surveys](tickets.md#satisfaction-surveys) |
| Track time on tickets (`timeTrackingEnabled`) | off | The Time card, the Log time dialog and the "Log time…" menu item. While it is off, a manual entry is refused and a reply's timer is dropped. See [time tracking](tickets.md#time-tracking) |
| Start the timer when an agent opens the composer (`timerStartsWithComposer`) | off | The timer starts when the caret enters the reply box and is logged with the reply. Disabled on the screen while time tracking is off |

The aside says how the link reaches a customer: with the closing message on the
ticket's channel, once those channels exist (M8-06). Until then the agent copies
it from the ticket.

The artboard's "Open the rating page as a customer sees it" preview link is not
drawn: there is no survey to open until a ticket closes, and a preview needs a
page of its own.

## Tags

A tag is a label an agent puts on a ticket to find it again. The list is the
brand's own and is the same list in every department; which *tickets* carry
which tag is department-scoped, so an Agent sees the chips on their own tickets
and on nobody else's.

### The list

Each row shows the chip as it will be drawn, the name, the Arabic name and how
many tickets carry it. The row menu offers **Edit**, **Move up**, **Move down**
and **Delete**, and reordering works exactly as it does for departments: drag
the handle, focus it and press `↑`/`↓`, or use the menu. All three send the
whole list.

The ticket count is "tickets you can see with this tag". For an Admin that is
every ticket in the brand; for a Team Leader restricted to two departments it is
the tickets in those two. Reaching past the department policy to count rows the
reader may not know exist would not be an improvement.

### The editor

| Field | Notes |
|---|---|
| Name | Required, up to 60 characters, unique inside the brand **whatever its case**. "Refund" and "refund" are one label to whoever reads a ticket. |
| Name (Arabic) | Optional. Drawn on the chip while the desk is in Arabic; the Latin name is the fallback. |
| Colour | One of the eight tints in [DESIGN §6.2](../../DESIGN.md#62-indicators): `info`, `success`, `warning`, `escalated` and four warm neutrals — `sand`, `stone`, `clay`, `bark`. **Never the danger tint**: red means "breached" or "destructive" on this desk. The picker is eight radio buttons, each named by its colour, so the choice is never carried by colour alone. |

### Deleting one

Nothing refuses it. Deleting a tag **detaches** it: the tickets stay and lose
one chip. That is why the confirmation reads the live count first and says how
many tickets keep no tag — the decision is the person's, and they cannot make it
blind. The count is written into the audit row, because afterwards it is the
only record of how much was taken off.

Deleting a tag also drops it from any template that listed it as a default.

## Custom fields

A custom field keeps something a brand needs that Helpdock does not ship. Three
targets — **Ticket**, **Contact**, **Account** — each with its own list and its
own order, which is why the tab draws three tables.

The *definitions* are rows. The *values* live in one `custom jsonb` column on
the row they describe, so reading a ticket is one row rather than eleven. What
jsonb gives up is the database enforcing the shape, so every write goes through
a Zod schema built from the brand's own definitions
(`packages/schemas/src/custom-fields.ts`). A value that does not fit never
reaches a column.

### The types

| Type | Accepts | Stored as |
|---|---|---|
| Text | a non-empty string | the trimmed string |
| Number | a finite number, or a string holding one | a number |
| Date | an ISO date or date-time | `YYYY-MM-DD` |
| Select | one of the field's options | that option |
| Multi-select | a set of the field's options, no duplicates | an array |
| Checkbox | a boolean | a boolean |

`true`, `[]` and `null` are **not** coerced into numbers. A checkbox ticked in
the wrong field must not become the number one.

### The editor

| Field | Notes |
|---|---|
| Label, Label (Arabic) | What a person reads. Correctable at any time. |
| Key | snake_case, suggested from the label while the field is new, and **fixed once the field exists**. It is written into every stored value, every template default and (from M3) every rule condition; renaming it would orphan all of them silently. |
| Type | Fixed while rows carry a value — see below. |
| Options | Only for Select and Multi-select. One choice per row, reordered with the arrow buttons or with `↑`/`↓` inside the row. The order is the order the menu offers. |
| Required | Enforced when a ticket is **created**, not when one is patched: a `PATCH` that names two fields says nothing about the other eight. |
| Placement | Which target the field hangs off. Fixed after creation. |
| Visible to agents | Off keeps the field for administrators and rules. It **hides** the field; it does not protect it — the value sits in the same jsonb column either way. |

### The two rules that exist because values are already stored

- **A type cannot change while rows carry a value.** "Yes" is not a number and
  `2026-01-02` is not one of three options; changing the type underneath would
  leave rows that no longer validate and that nobody can save again. The
  refusal is `field-in-use` and carries a count.
- **An option in use is not removed by accident.** The api refuses with
  `option-in-use` and answers with how many rows carry each option; the editor
  asks, and the same request sent again with `force` removes the option *and*
  clears it from those rows. A `select` loses the key; a `multi_select` keeps
  its other choices, and loses the key too when that was the last one.
- **Neither change is offered to somebody who cannot see every department.** A
  usage count is of rows the actor can read, and tickets are department-scoped,
  so a Team Leader restricted to two departments would be deciding on a number
  that leaves out the rest — and the rows left behind would carry an option
  that no longer exists and would fail validation the next time anybody saved
  them. Changing a type or forcing an option removal therefore answers
  `out-of-scope` for a restricted actor. Renaming, reordering and changing the
  flags are unaffected, because nothing stored changes. An Admin always reaches
  every department, and so does an unrestricted Team Leader.

A template's `customDefaults` are validated the same way when the **template**
is saved, not only when a ticket is filed from it: a default that no field
accepts would otherwise turn every ticket created from that template into a
400, and the person who can fix it is the one saving the template. The values
are stored coerced, so `"12"` for a number field is kept as `12`.

Deleting a definition leaves the stored values where they are. Rewriting every
ticket, contact and account of a brand to strip one key is a migration run
inside a request, for a change somebody may undo in a minute; reads filter by
the definitions instead, so an orphaned key is invisible everywhere and a
definition re-created with the same key brings its values back. The confirmation
says how many rows are affected.

## Ticket templates

A template is a starting point for a ticket an agent files by hand: a subject, a
body, a priority, a department, some tags and some custom values.

`POST /api/brands/:brandId/tickets` takes a `templateId` and applies it
**server-side**. The browser never sends a copy of the template, so a template
edited between the picker rendering and the ticket being filed is applied as it
now is, and an API client gets the same behaviour without reimplementing it.
Anything the request names beside `templateId` wins over what the template says.

| Field | Notes |
|---|---|
| Name | Unique inside the brand whatever its case. |
| Department | Where a ticket made from it is filed. "Chosen when filing" means the creating request has to name one, and a request that names neither is a 400. |
| Priority | Applied unless the request names one. |
| Subject, Body | May carry placeholders; see below. The body is plain text in this release — the rich composer is M5's TipTap. It is escaped, wrapped into paragraphs and put through the same sanitiser as any other message, so a template containing `<script>` becomes that *text* in the thread. |
| Default tags | Applied on creation. A tag the brand has since deleted is dropped rather than refused: a template is not broken by somebody tidying the tag list. |
| Custom field defaults | Values for the brand's *ticket* fields, written under the request's own values. |

`usageCount` counts tickets created from the template. It is incremented in the
same transaction that writes the ticket, so a creation that rolls back takes the
count with it.

### Placeholders

Six names, and only these six:

```
{{contact.first_name}}   {{contact.last_name}}   {{contact.name}}
{{contact.email}}        {{ticket.number}}       {{brand.name}}
```

The renderer resolves a **fixed list of names, not a path into an object**. That
is the whole design: a renderer that walked properties would answer
`{{constructor.constructor}}` with a function and `{{__proto__}}` with an
object. A name it does not know — including a typo such as `{{contcat.name}}` —
is left exactly as it was written and reported by the preview, because an author
has to see their typo rather than find a hole in a sentence a customer read.

`{{ticket.number}}` has no value in the preview: the ticket does not exist yet.
It is filled when a ticket is actually created from the template.

**Preview** asks the api to render the template and shows what comes back. The
admin never fills placeholders itself, because the renderer is what decides
which names a placeholder may reach and a second implementation would be a
second answer to that.

## Spam

The **Spam** tab (M1-11, the `Admin/Ticketing › Spam` artboard) is the brand's
sender block list and the one setting that goes with it. What marking a ticket
as spam does to the ticket is in [Tickets › Spam](tickets.md#spam).

### The block list

"Senders whose messages never become tickets in this brand." One row per
sender, newest first, with who added it, when, and **Dropped** — how many
inbound messages it has stopped. The counter is the only thing a match writes,
so it is how an Admin tells a block that is doing something from a stale one.
The search box matches any part of the value.

| Kind | Stored as | Matches |
|---|---|---|
| Email address | lower-cased, as `contact_identities` stores it | that address |
| Email domain | lower-cased punycode, no leading `@` or trailing dot | every address at that domain **or below it**: blocking `promo-deals.biz` also drops `news.promo-deals.biz` |
| Phone | E.164 by [ADR 0008](../decisions/0008-phone-normalisation.md): `+` and digits; a national number takes the install's `contacts.defaultCallingCode` | that number |
| Telegram | the chat id the Bot API gives, digits only | that chat |

Every value goes through the same `@helpdock/schemas` normaliser a contact
identifier does, so a spelling the list stores is the spelling a channel
compares. An address blocked **and** its domain blocked is one drop, charged to
the address — the most specific row.

**"Block a sender"** opens the card in the end column. Three refusals are drawn
under the field, where they are fixed, rather than as a toast:

| Refusal | When |
|---|---|
| `sender-invalid` | The value is not an address, a domain, a phone number or a chat id |
| `sender-is-own` | "A domain your brand sends from cannot be blocked": the install's `smtp.from` address or its domain, a hostname in `brand_domains`, a parent of either, or anything below either |
| `sender-already-blocked` | The row exists already |

**Unblock** is the bin on each row, behind a confirmation. The counter is
written to the audit row, because afterwards it is the only record of what the
block had been doing. The audit log names the kind, never the value: an address
is personal data and the audit log outlives the block.

> **What a brand "sends from" today** is the install-wide `smtp.from` and the
> brand's `brand_domains` hostnames. Per-brand mailboxes arrive with M2-08; the
> check reads them from then on. `smtp.from` is read install-wide until
> per-brand settings resolve, as `contacts.defaultCallingCode` already is.

### The Spam status card

"A ticket marked as spam is closed, sends no auto-reply and no CSAT, and is left
out of reports." Its one control is **Offer "Block sender" when marking as
spam** (`offerBlockSender`, on by default), saved as soon as it is toggled
through `PATCH …/ticketing/spam-settings`. With it off, the "Mark as spam"
dialog has no checkbox and a request that asks to block anyway is refused.

### The inbound gate

The list does nothing until a channel asks it. `isSenderBlocked(tx, brandId,
{ kind, value })` in `apps/api/src/ticketing/sender-gate.ts` is what every
channel that turns a customer's message into a ticket calls **before** it
creates the contact or the ticket — M2's email poller and inbound-parse
endpoint, M4's widget and web form, M6's Telegram bot. It normalises the value,
finds the most specific matching row in one statement, increments its counter in
the caller's transaction (so a drop that rolls back is not counted), and answers
`{ blocked: true, blockedSenderId }` or `{ blocked: false }`. A value that does
not normalise is answered "not blocked"; the channel's own contact path refuses
it next.

A staff member filing a ticket by hand is never gated: the block list is about
who may reach the desk, not about whom the desk may write down. M1 has no
customer-facing path that creates a ticket, so nothing calls the gate yet.

## Assignment

How a department hands its tickets to agents (M1-07, REQUIREMENTS §4.1,
DOMAIN-RULES §12). The tab lists every department the viewer leads — an Admin
sees them all — with its mode, load cap, auto-unassign timer and how many of its
agents in rotation are online. The pencil on a row opens its settings in the
side card; the first department is open on arrival. Under the list, **Agents in
<department>** lists everybody who can work it.

### The settings

| Setting | Values | Meaning |
|---|---|---|
| Mode | **Manual** (default), **Round-robin**, **Skill-based** | Manual leaves new tickets unassigned. Round-robin gives each to the next eligible agent. Skill-based does the same among the eligible agents whose skills match one of the ticket's tags, and among all of them when none match. |
| Load cap per agent | empty (no cap) or 1–500 | Open and escalated tickets an agent may hold **in this department** before the rotation skips them. On-hold, closed, spam and merged tickets do not count. |
| Unassign when the agent is offline for | off (default), or 1–1440 minutes (default 15) | When the agent's last socket in the brand goes, their open tickets here are unassigned after this long unless they came back. |
| When an agent loses access | **Leave them unassigned** (default) or **Round-robin the tickets** | What happens to a ticket whose assignee can no longer work it — deactivated, removed from the brand, or their departments narrowed. |

### Who the rotation picks

The next ticket goes to the **eligible** agent who has **waited longest** —
the oldest "last picked here", with somebody never picked first and ties broken
by id so every replica agrees. Eligible means all of:

- their role in the brand reaches the department, they are not a Viewer, and
  their account is not deactivated;
- they are **in rotation** here. With no choice stored, Agents are in and Team
  Leaders and Admins are out — an Admin reaches every department and should not
  find tickets they never asked for. The checkbox on their row stores a choice;
- they are **online**. Away is not online;
- they are **under the cap**. An agent at their cap is skipped, never queued:
  the ticket goes to the next eligible agent, or stays unassigned.

Nobody eligible means the ticket stays unassigned; nothing retries it later.
Spam, merged, closed and deleted tickets are never handed out, and neither is a
ticket somebody assigned in the meantime.

### When it runs

The rotation runs in the worker, never in a request (DOMAIN-RULES §6). The
request writes an `assignment.requested` outbox row in its own transaction:

- when a ticket is **created unassigned** in a department whose mode is not
  Manual;
- when a ticket **moves** into such a department and arrives unassigned —
  including when the move clears an assignee who cannot follow it;
- when a ticket's assignee **loses access** and the department says **Round-robin
  the tickets**; this runs even in a Manual department, in skill-based order if
  its mode is Skill-based;
- after the **offline timer** unassigns a ticket, in a department whose mode is
  not Manual.

Picks in one brand are serialised by a transaction-scoped advisory lock, so two
tickets created at the same moment cannot both hand an agent at `cap − 1` a
ticket. Every pick writes a `ticket.updated` activity row (actor `system`,
`assignment`, with `assignedBy: round_robin | skill_based`) and a
`ticket.updated` outbox row, so open screens hear about it.

### The offline timer

When presence (M0-13) sees somebody's last socket in a brand go, the api writes
`assignment.staff_offline` if any department of the brand has the timer on. The
worker then adds one delayed `assignment.offline_unassign` job per such
department where they hold open tickets, due the department's minutes after
they went. When it fires it does nothing if they are online or away again, if
they left again later (the later timer is the one that counts), or if the
department has turned the timer off since. Otherwise it unassigns their open
tickets there and routes each again.

DOMAIN-RULES §12 says the timer never fires "during business hours closed
periods". Departments have no business hours until M3, so every period is open;
M3 adds the check to the job and reschedules it to the next opening.

### Agents in a department

Each row shows presence, open tickets against the cap — in danger with "at
cap" once they reach it, which a manual assignment may push past — their
**skills** (tags; the dashed **+ skill** button adds one, the × on a chip
removes it) and **In rotation**. Skills are per department, so a Team Leader
edits the skills that matter where they lead. A Team Leader changes Agents'
rows only; an Admin's or another Team Leader's row is shown with its controls
disabled.

### Assigning by hand

The **Assignee** picker in a ticket's details panel lists everybody who can work
the ticket's department, with their presence and open tickets against the cap.
An agent at cap can still be picked. The api refuses somebody who cannot work
the department the ticket is (or is moving) in with `not-eligible` (409), and a
non-Admin assigning an Admin with `assignee-above-actor` (403) — DOMAIN-RULES
§1.2's ceiling on who a Team Leader may act on. A move into a department the
assignee cannot work clears the assignee rather than leaving the ticket with
somebody who cannot open it. See [Tickets](tickets.md).

## Brand settings

Each brand carries a small JSON object of ticketing behaviour. M1-01 stores and
serves it; the deliverables below act on it.

| Key | Default | Meaning | Acted on by |
|---|---|---|---|
| `autoAwaitOnAgentReply` | `true` | Move a ticket to "Awaiting customer" when an agent sends a public reply (DOMAIN-RULES §2.1). | M1-08 ✓ |
| `reopenPolicy` | `{ "kind": "within_days", "days": 7 }` | What a customer reply to a closed ticket does: `within_days` (1–365), `always`, or `never` (DOMAIN-RULES §2.3). | M1-08 ✓ |
| `offerBlockSender` | `true` | Whether the "Mark as spam" dialog offers "Block sender". | M1-11 ✓ |

Every key has a default, so a brand created before a key existed reads as the
current shape rather than failing. A column somebody edited by hand into
something the schema refuses falls back to the defaults rather than answering
500 — these settings describe behaviour, and behaviour has to have an answer.

`PATCH /api/brands/:brandId` is what writes them, together with the brand's
name, default locale and time zone. **The prefix is not editable**: it is
printed in every ticket number the brand has ever issued, so REQUIREMENTS §3
fixes it at creation.

> The screen for the brand's own fields belongs on **Admin → Settings**, as a
> "Brand" tab, rather than in the Ticketing tab row. That page is still the
> milestone placeholder and has no artboard yet, so M1-01 ships the endpoint and
> leaves the tab to the deliverable that designs that screen.

DOMAIN-RULES §2.3 lets a Team Leader set the reopen policy. `PATCH
/api/brands/:brandId` is `brand:manage`, which only an Admin holds, because the
same body carries the time zone, so M1-08 added the narrower route a Team Leader
reaches: `PATCH /api/brands/:brandId/ticketing/reply-behaviour`. See
[Reply behaviour](#reply-behaviour) above.

## Adding a brand

An install admin adds a brand with `POST /api/install/brands`. It is the
first-run wizard's brand step minus the parts that only make sense once, and it
does four things in one transaction:

1. creates the brand, whose insert trigger creates its ticket sequence;
2. gives whoever asked an `admin` role in it, so it is reachable;
3. creates one department, `General` unless the request names another;
4. writes a `brand.created` audit row under the install scope, and a second
   inside the new brand, so its own log is not empty at birth.

The prefix is unique across the install and is refused as a rejected field
(`400`, `fields: [{ path: "prefix" }]`) when it is taken.

The new role reaches the caller's access token on their next sign-in or refresh,
which DOMAIN-RULES §1.6 caps at ten minutes. Until then the api answers 403 for
the new brand — the same lag every role change has.

## Endpoints

Every brand-scoped route below runs inside that brand's own transaction and
writes an audit row for every change. `POST /api/install/brands` is the
exception: it has no brand in its path, runs in install scope, and is audited
there as well as in the brand it creates.

| Route | Declaration | Answers |
|---|---|---|
| `GET /api/brands/:brandId/departments` | `@Requires('brand:read')` | The list with team and people counts. |
| `POST /api/brands/:brandId/departments` | `@Requires('brand:manage')` | Creates one at the end of the list. |
| `POST /api/brands/:brandId/departments/reorder` | `@Requires('brand:manage')` | The whole order; a partial list is a 400. |
| `PATCH /api/brands/:brandId/departments/:departmentId` | `@Requires('staff:manage')` | Name, Arabic name, default team. Team Leaders inside their scope. |
| `DELETE /api/brands/:brandId/departments/:departmentId` | `@Requires('brand:manage')` | 409 for the last one, or while tickets reference it. |
| `GET /api/brands/:brandId/departments/:departmentId/teams` | `@Requires('brand:read')` | The department's teams with their members. |
| `POST/PATCH/DELETE …/departments/:departmentId/teams[/:teamId]` | `@Requires('staff:manage')` | Create, rename, delete. Team Leaders inside their scope. |
| `GET …/departments/:departmentId/eligible-members` | `@Requires('staff:manage')` | Who the people picker may offer. |
| `POST …/teams/:teamId/members` | `@Requires('staff:manage')` | Adds somebody eligible. 409 otherwise. |
| `DELETE …/teams/:teamId/members/:userId` | `@Requires('staff:manage')` | Takes them off the team, not out of the brand. |
| `GET /api/brands/:brandId/ticket-statuses` | `@Requires('ticket:read')` | The brand's statuses. Every agent draws a badge from it. |
| `POST /api/brands/:brandId/ticket-statuses` | `@Requires('ticketing:manage')` | Creates a custom status at the end of the list. |
| `POST …/ticket-statuses/reorder` | `@Requires('ticketing:manage')` | The whole order; a partial list is a 400. |
| `GET …/ticket-statuses/:statusId/usage` | `@Requires('ticketing:manage')` | The count and the fallback the delete confirmation prints. |
| `PATCH …/ticket-statuses/:statusId` | `@Requires('ticketing:manage')` | Name, Arabic name, colour, and — on a custom row — state, flags and default. |
| `DELETE …/ticket-statuses/:statusId` | `@Requires('ticketing:manage')` | Custom rows only. Moves their tickets to the default open status. |
| `PATCH …/ticketing/reply-behaviour` | `@Requires('ticketing:manage')` | The two settings of §2.3. Team Leaders included. |
| `PATCH …/ticketing/feedback` | `@Requires('ticketing:manage')` | CSAT, time tracking and the composer timer (M1-12). Team Leaders included. |
| `PATCH /api/brands/:brandId` | `@Requires('brand:manage')` | Name, default locale, time zone, settings. Never the prefix. |
| `POST /api/install/brands` | `@Requires('install:admin')` | An additional brand. Audited. |
| `GET /api/brands/:brandId/tags` | `@Requires('ticket:read')` | The brand's tags with their ticket counts. |
| `POST /api/brands/:brandId/tags` | `@Requires('ticketing:manage')` | Creates one at the end of the list. |
| `POST /api/brands/:brandId/tags/reorder` | `@Requires('ticketing:manage')` | The whole order; a partial list is a 400. |
| `GET /api/brands/:brandId/tags/:tagId/usage` | `@Requires('ticketing:manage')` | How many tickets carry it, for the confirmation. |
| `PATCH/DELETE /api/brands/:brandId/tags/:tagId` | `@Requires('ticketing:manage')` | Name, Arabic name, colour. Delete detaches. |
| `GET /api/brands/:brandId/tickets/:ticketId/tags` | `@Requires('ticket:read')` | The chips on one ticket. |
| `PUT /api/brands/:brandId/tickets/:ticketId/tags` | `@Requires('ticket:write')` | Replaces the whole set. Writes `ticket.tags.changed` and one outbox row. |
| `GET /api/brands/:brandId/custom-fields` | `@Requires('ticket:read')` | Every definition, or one target's with `?target=`. |
| `POST /api/brands/:brandId/custom-fields` | `@Requires('ticketing:manage')` | Creates one. The key is refused if the target has it. |
| `POST /api/brands/:brandId/custom-fields/reorder` | `@Requires('ticketing:manage')` | One target's whole order. |
| `GET /api/brands/:brandId/custom-fields/:fieldId/usage` | `@Requires('ticketing:manage')` | Rows carrying a value, and rows per option. |
| `PATCH/DELETE /api/brands/:brandId/custom-fields/:fieldId` | `@Requires('ticketing:manage')` | Never the key. `force` clears an option in use. |
| `GET /api/brands/:brandId/ticket-templates` | `@Requires('ticket:write')` | The picker's list. |
| `GET …/ticket-templates/:templateId/preview` | `@Requires('ticket:write')` | The template rendered, with `?contactId=` optional. |
| `POST/PATCH/DELETE …/ticket-templates[/:templateId]` | `@Requires('ticketing:manage')` | A Team Leader only inside the departments they lead. |
| `GET /api/brands/:brandId/blocked-senders` | `@Requires('ticketing:manage')` | The block list with its counters. |
| `POST /api/brands/:brandId/blocked-senders` | `@Requires('ticketing:manage')` | Blocks `{ kind, value }`; the value is normalised. |
| `DELETE /api/brands/:brandId/blocked-senders/:blockedSenderId` | `@Requires('ticketing:manage')` | Unblocks. |
| `PATCH …/ticketing/spam-settings` | `@Requires('ticketing:manage')` | `{ offerBlockSender }`. Team Leaders included. |
| `GET /api/brands/:brandId/assignment` | `@Requires('ticketing:manage')` | Every department the actor leads, with its assignment settings and online/in-rotation counts. |
| `PATCH /api/brands/:brandId/assignment/:departmentId` | `@Requires('ticketing:manage')` | Mode, load cap, auto-unassign and minutes, `onUnassign`. A Team Leader only inside the departments they lead. |
| `GET …/assignment/:departmentId/agents` | `@Requires('ticketing:manage')` | Who can work the department: presence, open count, rotation, skills, and whether the actor may edit the row. |
| `PATCH …/assignment/:departmentId/agents/:userId` | `@Requires('ticketing:manage')` | `inRotation` and/or the whole `skillTagIds` set. A Team Leader only for Agents. |
| `GET …/assignment/:departmentId/assignable` | `@Requires('ticket:write')` | The assignee picker: id, name, presence and open count, plus the cap. 404 for a department outside the actor's scope. |

### Refusals

A refused action answers with a code rather than a sentence, so the screen picks
the translated copy:

| `error.ticketing.reason` | Status | Means |
|---|---|---|
| `out-of-scope` | 403 | The department is outside the ones the actor leads; or they are not an Admin and the action changes the brand's list; or a Team Leader tried to put somebody above their ceiling on a team, or take them off one. |
| `last-department` | 409 | A brand keeps at least one department. |
| `department-in-use` | 409 | Tickets still belong to it (from M1-02). |
| `name-taken` | 409 | Another department of the brand, or another team of the department, has that name. |
| `not-eligible` | 409 | That person holds no role in this brand that reaches this department. |
| `status-is-system` | 409 | A seeded status can be renamed and recoloured, never deleted. |
| `status-is-default` | 409 | Make another status the default before deleting this one. |
| `status-state-fixed` | 409 | A seeded status's system state and flags are what code refers to it by. |
| `default-must-be-open` | 409 | The default is where a new or reopened ticket lands, so it has to be open-like. |
| `field-in-use` | 409 | Rows already carry values for this custom field, so its type cannot change. |
| `option-in-use` | 409 | Rows still carry an option the request removes. Send it again with `force` to clear them. |
| `sender-invalid` | 400 | Not a valid sender of the kind named. |
| `sender-is-own` | 409 | The brand sends from that address or domain. Also answered by "Mark as spam" with `blockSender`, which then rolls back. |
| `sender-already-blocked` | 409 | That sender is on the list already. |
| `assignee-above-actor` | 403 | Only an Admin assigns a ticket to an Admin (M1-07). |
| `time-tracking-off` | 409 | A time entry was logged while the brand has time tracking off (M1-12). |

A department of another brand is invisible to the request's transaction, so it
answers **404**, not 403: "there is no such id" and "it is not yours" are the
same answer. The same holds for a tag, a custom field and a template — and, for
`ticket_tags`, for a ticket in another department.

## Data model

Eleven tenant tables, all under a `FORCE`d row-level security policy on
`brand_id` (DOMAIN-RULES §1.3):

| Table | Columns that matter | Notes |
|---|---|---|
| `departments` | `name`, `name_ar`, `default_team_id`, `sort_order`, `assignment_mode`, `load_cap`, `auto_unassign_offline`, `auto_unassign_after_minutes`, `on_unassign` | Unique on `(brand_id, name)`. `default_team_id` is `ON DELETE SET NULL`. `load_cap` is null or positive, the minutes 1–1440 (check constraints). |
| `assignment_agents` | `department_id`, `user_id`, `in_rotation`, `last_assigned_at` | One person's place in one department's rotation. A row exists only once somebody stored a choice or the rotation picked them. |
| `assignment_skills` | `department_id`, `user_id`, `tag_id` | An agent's skills in one department. Deleting the tag deletes the skill. |
| `ticket_statuses` | `system_state`, `pauses_sla`, `awaiting_customer`, `is_default`, `is_system`, `system_key`, `excluded_from_reports`, `is_spam`, `sort_order`, `color` | Unique on `(brand_id, name)`, and on `(brand_id, system_key)` where set — one Spam, one Merged per brand. `is_spam` is generated from `system_key = 'spam'` ([Tickets](tickets.md#which-status-plays-which-part)). Brand-scoped, never department-scoped: an Agent reads the name of the status their own ticket is in. |
| `teams` | `department_id`, `name`, `sort_order` | Unique on `(department_id, name)`. Cascades from its department. |
| `team_members` | `team_id`, `user_id` | Unique on `(team_id, user_id)`. Cascades from its team and from the account. |
| `tags` | `name`, `name_ar`, `color`, `sort_order` | Unique on `(brand_id, lower(name))`, so two spellings of one label cannot both exist. |
| `ticket_tags` | `ticket_id`, `tag_id`, `department_id` | Primary key is the pair, so "add this tag" is idempotent in the database. **Department-scoped.** |
| `custom_field_defs` | `target`, `key`, `label`, `type`, `options`, `required`, `agent_visible` | Unique on `(brand_id, target, key)`. |
| `ticket_templates` | `name`, `department_id`, `priority`, `subject`, `body_text`, `default_tag_ids`, `custom_defaults`, `usage_count` | Unique on `(brand_id, lower(name))`. `department_id` is `ON DELETE SET NULL`. |
| `blocked_senders` | `kind`, `value`, `created_by`, `source_ticket_id`, `dropped_count`, `last_dropped_at` | Unique on `(brand_id, kind, value)`. `created_by` is `ON DELETE SET NULL`; `source_ticket_id` has no foreign key, because spam tickets are purged and the block outlives them. Brand-scoped, never department-scoped. |

Neither `teams` nor `team_members` is department-scoped in the row-level
security sense: §1.3 lists the six ticket-scoped tables and neither is one. A
Team Leader's scope is a service-layer rule
(`apps/api/src/brands/department-scope.ts`), exactly as it already is for
`departments` itself.

`ticket_tags` **is** one of them. Its `department_id` is denormalised from the
parent ticket by the shared `helpdock_ticket_child_department` trigger, so the
policy is a predicate on the table and never a join back to `tickets`, and a
ticket that moves department takes its tags with it through the same
`tickets_department_moved` trigger that moves its messages, its activity and its
attachments. An agent tagging a ticket they cannot read finds no parent to copy
from, and the insert never happens.

`tags`, `custom_field_defs` and `ticket_templates` are brand-scoped and not
department-scoped: they are the same list in every department, an Agent has to
read the name of a tag on a ticket of their own, and a template's department is
where its tickets are filed rather than who may read it.

`brands.settings` is a `jsonb` column rather than rows in `settings`: these are
the brand's own fields, read with the brand in one row, and `settings` is
install-wide configuration an operator may pin with an environment variable —
which none of these may ever be.

## See also

- [Tickets](tickets.md) — what a tag and a custom value look like on a ticket,
  and how a template is applied.
- [Staff and roles](staff-and-roles.md) — who holds which role, and how
  department scope is set per person.
- [DOMAIN-RULES §1.2](../planning/DOMAIN-RULES.md#12-scope-rules) — the
  authorization matrix this guide transcribes.
- [DOMAIN-RULES §2.3](../planning/DOMAIN-RULES.md#23-reopen-policy) — the reopen
  policy in full.
