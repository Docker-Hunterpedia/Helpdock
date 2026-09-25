# Tickets

The ticket, its thread and its activity log: what the tables hold, who may see
what, and the endpoints a client calls. Specified by
[REQUIREMENTS §4.1](../planning/REQUIREMENTS.md#41-ticketing-zoho-style),
[ARCHITECTURE §5](../planning/ARCHITECTURE.md#5-data-model-core-tables) and
[DOMAIN-RULES §2](../planning/DOMAIN-RULES.md#2-ticket-lifecycle) and
[§7](../planning/DOMAIN-RULES.md#7-realtime-delivery-contract). Implemented by
M1-02 (tickets), M1-03 (messages) and M1-08 (the state machine).

The admin screen built on it is the [ticket workspace](#the-admin-workspace)
(M1-15, first part).

## The model

```
tickets ──< ticket_messages          one thread per ticket, ordered by `seq`
        ──< ticket_activity          who changed what, and how
        ──< ticket_tags ──> tags     the chips, the brand's own list
        ──< ticket_participants      the CCs (M1-13)
        ──> ticket_statuses          the brand's own list, mapped to four system states
```

| Table | Scope | Notes |
|---|---|---|
| `ticket_statuses` | brand | The statuses a brand offers. Brand-scoped, not department-scoped: an Agent has to read the name of the status a ticket in their own department is in. |
| `tickets` | brand **and department** | `department_id` is not null. A ticket with no department would be invisible to everyone. |
| `ticket_messages` | brand **and department** | `department_id` is denormalised from the ticket by trigger. |
| `ticket_activity` | brand **and department** | The same, and for the same reason. |
| `ticket_tags` | brand **and department** | The same again (M1-06). The primary key is `(ticket_id, tag_id)`, so adding a tag twice is one row. |
| `ticket_participants` | brand **and department** | The CCs (M1-13). Unique on `(ticket_id, contact_id)`, so copying somebody in twice is one row. |
| `tags`, `custom_field_defs`, `ticket_templates` | brand | Configuration, not tickets: the same list in every department. [Ticketing settings](ticketing-settings.md) covers them. |

### Department scope

[DOMAIN-RULES §1.3](../planning/DOMAIN-RULES.md#13-enforcement-layers) layer 3:
the three ticket tables carry the department predicate on top of the brand one.

```sql
brand_id = ANY(app.brand_ids)
  AND (app.all_departments OR department_id = ANY(app.department_ids))
```

The child tables carry a **denormalised** `department_id` so the policy never
needs a join. Three triggers, built from two functions, keep it true, and
nothing else writes it:

| Trigger | When | What |
|---|---|---|
| `ticket_messages_department`, `ticket_activity_department` | before insert | Reads the parent ticket's department and overwrites whatever was passed. The read is subject to the caller's own policies, so a ticket the caller cannot see raises `insufficient_privilege` naming the ticket. |
| `tickets_department_moved` | after a department change | Rewrites every message **and** activity row of that ticket. A ticket escalated from Support to Billing takes its thread with it, or Support would keep reading it. |

What this means in practice: an Agent of Support asking for a Billing ticket of
the same brand gets **404** by id, by message cursor and by activity, a list
that simply does not contain it, and a `forbidden` acknowledgement on a
`ticket:<id>` socket join. Never 403 over HTTP — the transaction cannot see the
row, so the api genuinely does not know whether it exists, and "forbidden" would
confirm that it does. No answer distinguishes "not found" from "not yours".

**Escalation into a department you cannot see** is allowed — §1.2: "it is how
escalation works" — and M1-08 is what made it work. The `WITH CHECK` half of the
department policy would refuse the write, and the policy shape is deliberately
the same on every tenant table, so the move runs inside a **briefly widened
department scope** rather than under a second policy or a `SECURITY DEFINER`
function (`packages/db/src/tenant.ts`, `withWidenedDepartments`).

Three statements need that window and all three are inside it: the `UPDATE`,
the `tickets_department_moved` trigger that follows the thread, and the activity
row whose own department the trigger then overwrites. The brand is never
widened, the previous scope is restored in a `finally`, and the audit row is
written *outside* the window — `audit_log` is brand-scoped, so it does not need
it, and writing it outside is the proof.

Afterwards the ticket is gone from the actor's view: the `PATCH` answers 200,
and the next `GET` answers 404. See [the lifecycle](#the-lifecycle) below.

### Statuses

Four system states — `open`, `on_hold`, `escalated`, `closed` — and a row per
status mapped to one of them, with two flags (§2.1):

| Flag | Meaning |
|---|---|
| `pauses_sla` | SLA clocks are paused while the ticket is in this status |
| `awaiting_customer` | The ball is with the customer; time-based rules and reports read it |

Every brand is seeded with six when it is created, by `seedBrandStatuses`:

| Name | System state | Flags | Why it exists |
|---|---|---|---|
| Open | `open` | default | Where a new or reopened ticket lands |
| Awaiting customer | `on_hold` | `pauses_sla`, `awaiting_customer` | §2.1 ships it with every brand |
| Escalated | `escalated` | — | So the fourth state is reachable without adding a status |
| Closed | `closed` | — | §2.2 |
| Spam | `closed` | — | §2.1: no auto-responder, no CSAT, excluded from reports |
| Merged | `closed` | — | §2.4: what the secondary of a merge closes into |

Spam and Merged additionally carry `excluded_from_reports`: §2.1 words Spam as
"closed, excluded from reports" and §2.4 says the same of Merged, and §2.2 makes
it the reason a close into one of them schedules no CSAT. It is a flag rather
than a name, because a brand may rename Spam.

They are marked `is_system`. A brand may rename and recolour them; nothing
deletes them, because code refers to what they are rather than what they are
called. Their **system state and their two behaviour flags are fixed** for the
same reason — the api answers `status-state-fixed` to a request that would move
one. `color` is one of the five status hues of
[DESIGN §2.1](../../DESIGN.md#21-palettes) — a brand tints, it never adds a hue.

A brand created before M1-02 has no statuses and cannot hold a ticket; the api
answers 409 and says so. `seedBrandStatuses` is exported from `@helpdock/db` for
whatever creates a brand.

### Numbers

A ticket's display number comes from that brand's own sequence, created with the
brand — `brand_ticket_seq_<the brand's uuid with its hyphens removed>` — and
`prefix` is **copied** onto the row rather than joined: `HD-1042` is printed in
emails that outlive a rename.

Numbers are not dense. `nextval` is non-transactional by design — that is what
lets two requests draw two numbers without waiting for each other — so a
rolled-back creation burns its number. A gap is not a defect; a duplicate would
be, and `tickets_brand_number_key` is what would catch one.

## Tags and custom values

A ticket carries two things a brand defines for itself (M1-06). Both are
described in [Ticketing settings](ticketing-settings.md); what follows is what
they look like on a ticket.

### Tags

The chips are **embedded in the ticket**, exactly as the status is, because
every list row draws them and a row that had to resolve its own tag ids would
render before it knew what it was showing:

```json
{
  "id": "0199f4b2-…",
  "subject": "Refund for order 42",
  "tags": [{ "id": "0199f4b2-…", "name": "Refund", "nameAr": "استرداد", "color": "info" }]
}
```

`tags` is **optional on the wire** and the api always fills it: it arrived after
the ticket did, so a client built against the M1-02 shape and a fixture written
against it stay valid, and a renderer that has not learned about tags draws
nothing rather than crashing on `undefined`.

They are replaced as a **set**, never added and removed one at a time:

```http
PUT /api/brands/:brandId/tickets/:ticketId/tags

{ "tagIds": ["0199f4b2-…", "0199f4b3-…"] }
```

That makes it idempotent, it is one activity row instead of four when an agent
changes three chips at once, and two agents editing the same ticket end at one
of the two sets rather than at a mixture of both. A replace that changes nothing
writes nothing — no `ticket.tags.changed` row, no outbox event — for the same
reason a `PATCH` that changes nothing does not.

A change bumps `updated_at`, because the list orders by it and a ticket that has
just become urgent must not sit at the bottom of the queue.

An id that is not this brand's answers **404**. A ticket in another department
answers 404 too, from the policy: the `ticket_tags_department` trigger looks the
parent up under the caller's own row-level security, finds nothing, and the
insert never happens — the same shape `ticket_messages` and `attachments` use.

## Participants (M1-13)

A ticket's participants are its **contact**, its **CCs** and its **staff**
(DOMAIN-RULES §2.5). They decide who may thread into the ticket by email (§4.3)
and who receives public replies — both M2's to act on. Only the CCs are stored:
the contact is `tickets.contact_id`, and the staff are the assignee and every
staff member who wrote on the ticket.

A CC is a **contact** with the normalised address it was added under. Typing an
address links the contact that already holds it, or creates one holding it
unverified (`email.cc`): copying somebody in grants that contact nothing, so
there is no history to protect and no reason for a second contact. The address
stays on the row, so a later merge of the CC's contact never changes who may
thread in; the list shows the surviving contact's name.

```http
GET    /api/brands/:brandId/tickets/:ticketId/participants
POST   /api/brands/:brandId/tickets/:ticketId/participants     { "email": "finance@acme.de" }
DELETE /api/brands/:brandId/tickets/:ticketId/participants/:participantId
```

All three answer `{ contact, ccs, staff }`. Adding is idempotent, and copying in
the ticket's own contact changes nothing. An address that is not one answers
400 with `contact.reason = identity-invalid` and a `problem`. Each change writes
`ticket.participants.changed` to the activity log — naming the contact id,
never the address — bumps `updated_at` and enqueues `ticket.updated`.

`ticket_participants` is department-scoped like every child of a ticket: its
`department_id` is filled by the shared trigger, follows the ticket through a
department move, and a ticket in another department answers 404.

Another module copies a contact in by id through
`TicketParticipantsService.addCcParticipant(context, ticketId, contactId)`,
exported by `ParticipantsModule`. M1-09's ticket merge uses it to add the
secondary's contact as a CC (§2.4); M2 will use it for an inbound `Cc:` line.

### Custom values

`tickets.custom` is a jsonb object keyed by `custom_field_defs.key`. Every write
is validated against the brand's own *ticket* definitions before it reaches the
column, so a value that does not fit its type, or a key nobody defined, is a
**400** rather than a row somebody believes they saved.

```http
POST /api/brands/:brandId/tickets
{ …, "custom": { "tier": "gold", "renews_on": "2026-03-01" } }

PATCH /api/brands/:brandId/tickets/:ticketId
{ "custom": { "tier": "silver", "renews_on": null } }
```

A `POST` is a **create**: every required field has to arrive. A `PATCH` is a
**patch**: a key it omits is left alone, and a key set to `null` is cleared. The
stored object never holds a null, so "unset" has one representation.

A key whose definition has since been deleted is filtered out on the way to a
screen rather than rewritten out of the row, so deleting a definition is not a
migration over the whole brand and re-creating it brings its values back.

## Messages and `seq`

[DOMAIN-RULES §7](../planning/DOMAIN-RULES.md#7-realtime-delivery-contract):
"Every message has a client-generated `client_id` (UUIDv7) and a server-assigned
`seq`, monotonic per conversation."

- **`seq`** is assigned inside the request's transaction. `nextMessageSeq` takes
  a `SELECT … FOR UPDATE` lock on the *ticket row* first, then reads
  `max(seq) + 1`. Twenty simultaneous replies queue on that lock, so no two read
  the same maximum; `ticket_messages_ticket_seq_key` is the backstop. The ticket
  row is locked rather than the messages because the first message of a ticket
  has no message row to lock.
- **`client_id`** is looked up *inside* that lock, so a retry that arrives while
  the first attempt is still committing finds the row rather than writing a
  second one. A retried send returns the stored message, with the same id and
  the same `seq`.
- **A message is "sent"** when the client holds a `seq`. Until then the composer
  shows "sending"; the socket frame is a notification, never the receipt.
- **`external_message_id`** is unique per `(brand, channel)`, which is what stops
  a redelivered IMAP message or Telegram update becoming a second row (§6).

Bodies are **sanitised on the way in** and stored sanitised
([ADR 0007](../decisions/0007-html-sanitizer.md)). `body_text` is extracted from
the sanitised html by the same call, so the text can never come from a body the
sanitiser has not seen. Remote `<img src>` is blocked by default and `cid:`
references are kept for M1-10 to resolve; M2-07 adds the per-brand toggle.

Two things about the sanitiser are worth knowing before rendering a body:

- **A URL survives only if it is absolute.** A scheme allowlist is applied only
  to a URL that has a scheme, so `src="/pixel.gif"` and `href="/settings"` are
  dropped outright: a relative URL in a message from a stranger resolves against
  whatever page renders it, which makes it a read receipt fired by the reader's
  own browser, or a link that looks like a genuine in-app one.
- **`body_text` is text, and only text.** Entities are decoded, so a message
  that literally reads `<script>alert(1)</script>` comes back as those
  characters. That is right for the email text part, the list preview and AI
  retrieval — and it must never be interpolated into HTML. `body_html` is the
  field that is safe to render.

Two more things the sanitiser does to a body, which change what is stored:

- every surviving `<a>` leaves with `rel="noopener noreferrer nofollow"`,
  whatever it arrived with, and a `target` is normalised to `_blank`;
- a body carrying more than 6,000 opening tags is refused with **400**. The
  sanitiser's cost is super-linear in nesting depth rather than in size, and it
  runs synchronously inside the request's open transaction, so a body built to
  be expensive would stall every other request on the replica. The count is
  taken on the raw input, before the parser sees it, and is deliberately a
  conservative over-count.

## Activity

`ticket_activity` is part of the ticket, not the brand's administrative trail:
it is rendered in the thread, it is department-scoped like the ticket, and
retention purges it with the ticket. `audit_log` stays what an admin reads.

| Action | Written when |
|---|---|
| `ticket.created` | A ticket is created |
| `ticket.updated` | Subject, priority, department, team or assignee moved — one row, with `from` and `to` naming every field that moved |
| `ticket.status.changed` | The status moved, through the transition hook |
| `ticket.replied` | A public reply was added |
| `ticket.note_added` | An internal note was added |
| `ticket.closed` | The status change took the ticket **into** a closed state (M1-08) |
| `ticket.reopened` | It took the ticket **out of** one (M1-08) |
| `ticket.continued` | A customer reply past the reopen window started a new ticket; written on both (M1-08) |
| `ticket.deleted` | An Admin soft-deleted it (M1-08) |
| `ticket.escalated` | Recorded in `audit_log`, not here: the activity row moves with the ticket |

`ticket.status.changed` is written for **every** status move. A close or a
reopen writes it *and* the more specific verb beside it, because a reader of the
thread wants the second word.

`via` is *how*: `ui` for the admin, `api` for an api key, `rule` for M3-03's
rules, `ai` for M7, `system` for a worker. A field set to the value it already
holds is not a change and is not logged.

## The lifecycle

[DOMAIN-RULES §2.2](../planning/DOMAIN-RULES.md#22-transitions) is the whole of
it, and M1-08 implements it as **one constant**,
`apps/api/src/tickets/lifecycle/transitions.ts`, rather than as rules spread
across the handlers that cause each event. `transitions.test.ts` holds a second
copy typed out from the document and asserts the two agree cell by cell, so a
change to one without the other fails.

| Current state | Event | Result |
|---|---|---|
| open, on hold, escalated | Customer public reply | The brand's **default open status**. `awaiting_customer` is cleared with it, because the flag lives on the status |
| `open` | Agent public reply, toggle on | Awaiting customer |
| any | Agent sets status | That status |
| open-like | Agent closes | `closed_at` set, `onResolved`, and `onClosedForCsat` unless excluded |
| `closed` | Customer reply | The reopen policy, below |
| `closed` | Agent reopens | Default open status, `closed_at` cleared, `onReopened` |
| any | Marked spam | Spam: `closed_at` kept or set, `onResolved`, **no** `onClosedForCsat`, `ticket.spam` rather than `ticket.closed`; see [Spam](#spam) |
| any | Merged | Merged, with `merged_into_id` — see [Merge and split](#merge-and-split) |
| any | Soft-deleted by Admin | Hidden from every view; purged by retention (§11) |

Two facts are checked **before** the table and refuse every event, because they
answer all of them the same way: a ticket with `merged_into_id` belongs to the
one it was merged into (§2.4), and a soft-deleted ticket is not acted on at all.
Both answer **409** with `error.lifecycle.reason` — `ticket-merged`,
`ticket-deleted`, `ticket-not-closed` for a reopen of something that was
never closed, or `ticket-not-spam` for "Not spam" on a ticket that is not — so
the screen picks a sentence rather than printing the api's.

An agent "closing" a ticket *is* an agent setting a status whose system state is
`closed`: there is one control on the screen and it is a status picker. Which of
the three rows happened is read off the states afterwards, which is what decides
whether `closed_at` moves and which hook fires.

### Which status plays which part

Never by name — a brand may rename any of them (`packages/db/src/ticket-statuses.ts`).
A flag where one says what the row is; `system_key` (M1-09) where the flags
cannot tell two rows apart, which is Spam and Merged:

| Part | Found by |
|---|---|
| Where a new or reopened ticket lands | `is_default` |
| Awaiting customer | `awaiting_customer`, seeded rows first |
| Out of reports and round-robin counts | `excluded_from_reports` (Spam and Merged) |
| Spam — no CSAT, no auto-reply, the 30-day purge | `system_key = 'spam'`, read as `is_spam` (below) |
| The secondary of a merge — no CSAT | `merged_into_id` on the *ticket* |
| The status a merge closes into | `system_key = 'merged'` (seeded, backfilled by migration `0016`) |

**One answer to "which row is Spam?".** `system_key` is the source: seeded as
`spam` on every brand, backfilled by migrations `0016` and `0017`, and unique per
brand. `ticket_statuses.is_spam` is a **generated** column,
`coalesce(system_key = 'spam', false)`, kept because everything that treats
spam differently reads a boolean through `isSpamStatus` (`@helpdock/schemas`):
the lifecycle's "Mark as spam" and CSAT exclusion (M1-11, M1-12), and the spam
purge (M1-14). Nothing writes it, so it cannot disagree with the key.
`excluded_from_reports` is wider — Merged carries it too — and is only ever
read as "leave it out of a count".

### The reopen policy

[§2.3](../planning/DOMAIN-RULES.md#23-reopen-policy), per brand:

| `reopenPolicy` | A customer reply to a closed ticket |
|---|---|
| `{ "kind": "within_days", "days": 7 }` | Reopens if `closed_at` is **less than** N days ago, otherwise a new ticket |
| `{ "kind": "always" }` | Always reopens |
| `{ "kind": "never" }` | Always a new ticket |

"Less than N days ago" is taken literally: a reply at **exactly** N days creates
a new ticket. The window is wall-clock time, not business hours — §3.1 says
"business hours" where it means them, and a customer's week does not pause for a
brand's holidays. A closed ticket with no `closed_at` reopens: of the two wrong
answers, "the thread stayed together" is the one a customer can live with.

**A reopen** returns the ticket to the default open status, clears `closed_at`,
writes `ticket.reopened` to the activity log, fires `onReopened` and enqueues
`ticket.reopened`.

**A new ticket** gets `parent_id` = the closed ticket, the same department,
contact, priority and channel, and a fresh number. Both tickets get a `system`
message — "Continued from HD-1042" on the new one, "Continued in HD-1101" on the
old — written in the **contact's** language, falling back to the brand's default
locale. A desk that reads Arabic must not decide what an English-speaking
customer is sent. Auto-responders treat it as a new ticket, which is M2's to
honour: it is an ordinary ticket with a `parent_id`, and nothing suppresses
anything.

Retries are covered on both branches. The reply path looks for the `client_id`
on the ticket that was written to **and** on any ticket continuing it, so a
retried send never creates a second continuation (§7).

### The hooks later milestones fill

`apps/api/src/tickets/lifecycle/hooks.ts` names five moments. They are a
provider, so M3-02 and M1-12 replace one line of `TicketsModule` rather than
editing the service that calls them. M1-12's line is in: `CsatLifecycleHooks`
(`apps/api/src/csat/csat-hooks.ts`) fills `onClosedForCsat` and inherits the
others, which M3-02 fills.

| Hook | Fires when | Filled by |
|---|---|---|
| `onResolved` | A ticket reaches a closed state, **including** spam — a clock left running on a ticket nobody will touch again is a clock that breaches. Not on a merge, which fires `onMerged` | M3-02 |
| `onClosedForCsat` | The same, **unless** the ticket is merged or the status is Spam (`is_spam`) | M1-12: writes `csat.requested` to the outbox when the brand has CSAT on |
| `onReopened` | A closed ticket comes back, by policy or by an agent (§3.5) | M3-02 |
| `onMerged` | A ticket was merged into another (§2.4): stop both clocks without recording them as met, and keep the ticket out of compliance | M3-02 |
| `onUnmerged` | A merge was undone; `mergedMs` is how long it lasted, to leave out of the clocks | M3-02 |

Every hook runs inside the caller's transaction, after the ticket row has moved
and before the outbox row is written, so whatever it writes commits with the
transition or rolls back with it. A hook that needs a job enqueues it through
the outbox like everything else; it must not enqueue directly and must not open
a transaction of its own.

### Soft deletion

`DELETE /api/brands/:brandId/tickets/:ticketId`, `brand:manage`. It stamps
`deleted_at` and nothing else: the ticket keeps the status it was in, because
restoring one and reporting on what was deleted both need it.

Every read narrows on `deleted_at IS NULL` from there — the list, the ticket's
own URL, the thread, the activity — and all of them answer **404**, the same
answer a ticket in another department gives. A 410 would confirm it had existed.
The department-delete guard still counts it, which is what stops a department
being removed out from under a ticket that could be restored.

### Spam

[DOMAIN-RULES §2.2](../planning/DOMAIN-RULES.md#22-transitions): "Marked spam —
Spam status; no auto-responder, no CSAT, sender added to block list if the agent
ticks 'block sender', excluded from reports and round-robin counts." M1-11.

**Marking** is `POST /tickets/:ticketId/spam` with `{ "blockSender": true|false }`.
The ticket moves to the brand's Spam status — the row with `is_spam`, never
found by name — and in the same transaction:

- `ticket.status.changed` and `ticket.marked_spam` go to the activity log;
- a ticket that was open-like gets `closed_at` and fires `onResolved`, so M3's
  clock stops; one that was already closed keeps its `closed_at`;
- `onClosedForCsat` does **not** fire, because the status is Spam (`isSpamStatus`);
- the outbox gets **`ticket.spam`**, not `ticket.closed`, so nothing that acts
  on a close — a survey, an auto-responder — can mistake spam for one;
- with `blockSender`, the ticket's sender goes on the block list
  ([ticketing settings](ticketing-settings.md#spam)). Which identifier is the
  sender follows the channel: a Telegram ticket blocks the chat, anything else
  the contact's address, then phone, then chat. A visitor id or an external id
  is never blocked. The brand's own address or domain is refused
  (`sender-is-own`) and the whole request rolls back with it.

Picking Spam from the status picker is the same move without the block, and it
sends `ticket.spam` too. `GET /tickets/:ticketId/spam-sender` is what the dialog
reads first: the sender, whether the brand offers the checkbox
(`offerBlockSender`), whether it may be blocked, and whether it already is.

**"Not spam"** is `DELETE /tickets/:ticketId/spam`. It is an agent reopen: the
default open status, `closed_at` cleared, `onReopened`, `ticket.reopened` — a
ticket wrongly marked as spam is a ticket somebody is still waiting on. On a
ticket that is not spam it answers 409 `ticket-not-spam` (or `ticket-not-closed`
when it is not closed at all). A block made with it stays; undoing that is the
Spam tab's.

**What being spam means to everybody else** is one predicate, read off the
status and never off its name, exported from `@helpdock/schemas`:

| Consumer | Asks | And then |
|---|---|---|
| Auto-responders (M2) | `isSpamStatus(status)` | send nothing |
| CSAT (M1-12) | nothing: the lifecycle already withholds `onClosedForCsat` | — |
| Round-robin and load caps (M1-07) | `countsInReports(status)` | a spam or merged ticket counts against nobody |
| Reports (M3) | `countsInReports(status)`, or `ticket_statuses.excluded_from_reports = false` in SQL | left out |
| Retention (M1-14) | `ticket_statuses.is_spam` | purged after the brand's spam retention (§11, 30 days by default) |

The default views already leave spam out: every one of them asks only for
open-like system states, and Spam is `closed`. "All tickets" shows it, with its
danger badge, because that view is the desk's whole history. M1 has no report
or count query yet, so there is nothing else to exclude it from today.

## Merge and split

[DOMAIN-RULES §2.4](../planning/DOMAIN-RULES.md#24-merge-and-split), built by
M1-09 in `apps/api/src/tickets/merge/`. The rules are pure functions in
`merge-rules.ts`; `merge.service.ts` writes the rows. All three routes are
`ticket:write`, and every path names the ticket the agent has open.

| Route | Answers |
|---|---|
| `POST /tickets/:ticketId/merge` `{ "primaryTicketId": "…" }` | `{ primary, secondary }` — `:ticketId` is the **secondary**, which closes |
| `POST /tickets/:ticketId/unmerge` | `{ primary, secondary }` — inside 24 hours of the merge |
| `POST /tickets/:ticketId/split` `{ messageIds, subject, departmentId, priority? }` | **201** and the new ticket's detail |

A ticket the actor cannot read — the primary in another department, or in
another brand — answers **404**, exactly like one that does not exist
(§1.2). A rule that refuses answers **409** with `error.lifecycle.reason`:

| Reason | When |
|---|---|
| `merge-into-self` | The primary is the secondary |
| `ticket-merged` | The secondary is already merged — unmerge is the only way back. Also a split of a merged ticket, and a `PATCH` that would move a merged ticket's department |
| `merge-into-merged` | The primary is itself merged; merge into the ticket it went to. This is also what makes a cycle impossible |
| `ticket-not-merged` | Unmerging a ticket that is not merged |
| `merge-window-closed` | Unmerging 24 hours or more after the merge |
| `attachments-in-flight` | A message to split has an attachment the pipeline has not finished with |

### Merge

In one transaction:

1. both tickets are locked, in id order, so two merges of the same pair queue
   rather than deadlock;
2. the primary gets a `system` message "HD-1042 was merged into this ticket",
   in its contact's language, as §2.3's "Continued in" is;
3. the secondary moves to the **Merged** status with `merged_into_id`,
   `merged_at`, `merged_by_id`, `closed_at` (kept if it was already closed) and
   what an unmerge needs: `pre_merge_status_id`, `pre_merge_department_id` and
   `merge_message_id`;
4. the secondary **moves into the primary's department**;
5. the primary's tags become the union of both (`ticket.tags.changed`);
6. `onMerged` fires, and `MergeParticipantsHook.onContactMerged` when the two
   contacts differ;
7. `ticket.merged` is written to both activity logs, and `ticket.updated` to
   the outbox for both, which is `ticket:changed` in both rooms.

**Messages are not moved.** `GET /tickets/:primaryId` answers with `merged`:
every ticket merged into it — a chain is flattened, and `mergedIntoId` says
which ticket each went into — with the oldest 100 of its messages, read-only,
each keeping its own `ticketId`. The secondary's read answers with `mergedInto`.
Both carry `unmergeableUntil`, null once the 24 hours have passed.

**Access follows the primary** because of step 4. §2.4 allows a merge across
departments; the secondary's thread, activity, tags and attachments follow it
through `helpdock_ticket_department_moved`, and the `tickets_merged_follow_primary`
trigger (migration `0016`) keeps every merged ticket in its primary's department
when the primary moves later, down a chain. So whoever may read the primary may
read the messages shown inline in it and open their attachments — at
`/tickets/:secondaryId/attachments/:id`, under the ordinary department policy,
with no second authorisation path — and nobody else may. A merged ticket's
department cannot be changed on its own: `PATCH` refuses it with
`ticket-merged`.

**Clocks.** A merge stops the secondary's clocks and keeps it out of
compliance: the Merged status is `excluded_from_reports` and the ticket has
`merged_into_id`. It does not fire `onResolved` — the ticket was folded into
another, not resolved. The primary's clocks are untouched.

**The contact.** §2.4 makes the secondary's contact a CC of the primary when
the two differ. Participants are M1-13's (§2.5), so the merge calls
`MergeParticipantsHook.onContactMerged` — a provider in `TicketsModule` that
does nothing today and that M1-13 replaces.

### Unmerge

Inside 24 hours of `merged_at`, and refused at exactly 24 hours. The secondary
goes back to the status it was in (or the default open status if that one has
been deleted since), gets `closed_at` back only if that status is a closed one,
and returns to the department it was merged from — which, when that department
is outside the actor's scope, is the escalation §1.2 already allows, made in the
same widened window `PATCH` uses. `merged_ms` accumulates how long the merge
lasted and `onUnmerged` passes it on, which is how "clocks resume with the time
paused during the merge excluded" reaches M3-02. The primary gets "HD-1042 was
unmerged from this ticket" and keeps the tags the merge gave it: §2.4 does not
say they go, and nothing records which ones it would not otherwise have by now.

### Split

The named messages are **copied** onto a new ticket: `split_from_id`, the same
contact and channel, the department and subject the agent chose, the priority
chosen or the original's, a fresh number, and the default open status. Each copy
has `copied_from_message_id`, keeps its original `created_at`, and takes the new
ticket's own `seq` from 1; a `system` message "Split from HD-1042" follows them,
and the original gets "Messages split to HD-1043". The new ticket is announced
with `ticket.created`, which is where M3-02's fresh clocks start; the original's
are not touched.

The department is one the actor may file a ticket in, as for creation — a
split is filing a ticket, not escalating one. An id that is not a message of the
ticket answers 404; a `system` message answers 400.

**Attachments are copied as rows, not bytes.** A copy of a `ready` attachment
points at the **same object** with the new ticket's `ticket_id`, `message_id`
and — through the trigger — `department_id`, which is what authorises a
download through it; `copied_from_attachment_id` names the original.
`attachments.s3_key` is therefore unique among originals only
(`attachments_s3_key_original_key`). Rejected and infected rows are not copied,
and a message whose attachment is still `pending` or `processing` is refused
with `attachments-in-flight`, because its copy would never hear from the
worker. Every read and purge of the bytes goes by the row's `s3_key`, never its
ids (`media/keys.ts` `objectKeyBeside`), so a copy downloads the original's
objects; and a purge — retention's or a contact's erasure (M1-14) — leaves an
object alone while any row it is not removing still names the key
(`media/object-purge.ts`). The last row to go takes the bytes with it.

Both tickets' reads carry `related`: the ticket this one was split from and the
tickets split from it, so the thread can link the references its system
messages name.

## Side effects and realtime

Every mutation writes its outbox row in the same transaction as the change
([DOMAIN-RULES §6](../planning/DOMAIN-RULES.md#6-transactional-outbox)). Seven
events: `ticket.created`, `ticket.updated`, `ticket.replied`,
`ticket.note_added`, from M1-08 `ticket.closed` and `ticket.reopened`, and from
M1-11 `ticket.spam`.

The last three carry the same payload as `ticket.updated` and reach the same
rooms. What they add is a name, so M1-12's survey and M3's clocks can consume
one event instead of diffing two reads of the ticket — and so a move into Spam
is never heard as a close.

```
request  →  tickets + ticket_activity + outbox   (one transaction)
relay    →  BullMQ outbox.event                  (after commit, jobId = outbox.id)
worker   →  Redis pub/sub                        (the api process runs no queue)
api      →  RealtimePublisher → sockets          (every replica, its own sockets)
```

The third hop exists because `APP_ROLE=worker` runs no Nest application and holds
no Socket.IO namespace, while `APP_ROLE=api` runs no queue. It is the same Redis
pub/sub shape `principal.revoked` already uses.

Each event reaches `ticket:<id>` (whoever has the ticket open) and
`department:<id>` (whoever has a queue open, because a new ticket has to appear
in a list nobody was looking at). A move reaches the *old* department's room as
well, or the ticket would sit in a queue it has left until somebody reloaded,
and it turns the ticket room out: everyone in it joined under the old
department's scope, so they re-join through the same check they passed once.

The payloads carry **ids only** — no body — so an internal note cannot leak over
a socket, and a screen re-reads over REST. See
[the realtime guide](realtime.md#rooms).

## Endpoints

All under `/api/brands/:brandId`, and every one declares a permission. What a
role may ask for is [DOMAIN-RULES §1.2](../planning/DOMAIN-RULES.md#12-scope-rules);
which departments it reaches is the policies'.

| Route | Declares | Answers |
|---|---|---|
| `GET /ticket-statuses` | `ticket:read` | The brand's statuses, for the picker and the badge |
| `GET /tickets` | `ticket:read` | A filtered, sorted, cursor-paged list |
| `POST /tickets` | `ticket:write` | A ticket and its first message |
| `GET /tickets/:ticketId` | `ticket:read` | The ticket, the first page of its thread and its activity |
| `PATCH /tickets/:ticketId` | `ticket:write` | Subject, priority, department, assignee, status, custom values. Setting a team answers 400 until M1-01; clearing one with `null` is allowed |
| `GET /tickets/:ticketId/messages` | `ticket:read` | The thread after a `seq` |
| `POST /tickets/:ticketId/messages` | `ticket:write` | A public reply or an internal note |
| `DELETE /tickets/:ticketId` | `brand:manage` | Soft-deletes it (§2.2). Admin only: hiding a ticket from the whole brand is not an edit |
| `GET /tickets/:ticketId/activity` | `ticket:read` | The newest 100 activity entries, oldest first. It does not page yet |
| `GET /tickets/:ticketId/tags` | `ticket:read` | The chips on one ticket (M1-06) |
| `PUT /tickets/:ticketId/tags` | `ticket:write` | Replaces the whole set (M1-06) |
| `GET /tickets/:ticketId/spam-sender` | `ticket:read` | Who "Block sender" would block, and whether the dialog offers it (M1-11) |
| `POST /tickets/:ticketId/spam` | `ticket:write` | Marks it as spam, and blocks the sender when `blockSender` is true (M1-11) |
| `DELETE /tickets/:ticketId/spam` | `ticket:write` | "Not spam": back to the default open status (M1-11) |
| `GET /tickets/:ticketId/participants` | `ticket:read` | The contact, the CCs and the staff (M1-13) |
| `POST /tickets/:ticketId/participants` | `ticket:write` | Copies an address in as a CC (M1-13) |
| `DELETE /tickets/:ticketId/participants/:participantId` | `ticket:write` | Takes a CC off (M1-13) |
| `GET /tickets/:ticketId/time-entries` | `ticket:read` | The ticket's time, newest first, with the total (M1-12) |
| `POST /tickets/:ticketId/time-entries` | `ticket:write` | A manual entry: `{ seconds, note? }`. 409 `time-tracking-off` while the brand has it off |
| `DELETE /tickets/:ticketId/time-entries/:entryId` | `ticket:write` | Your own entry; anybody's with `ticketing:manage` (Team Leader, Admin), otherwise 403 |

Two routes live outside the brand, because the person calling them has no
session — see [satisfaction surveys](#satisfaction-surveys):

| Route | Declares | Answers |
|---|---|---|
| `GET /api/public/csat/:token` | `@Public()` | The rating page's state: `open` with the brand, reference and subject; or `used` / `expired` with the brand alone |
| `POST /api/public/csat/:token` | `@Public()` | `{ rating: 1–5, comment? }`. Answers `rated` once, then `used`; `expired` after 30 days |
| `POST /tickets/:ticketId/merge` | `ticket:write` | Closes it into another ticket (M1-09, [below](#merge-and-split)) |
| `POST /tickets/:ticketId/unmerge` | `ticket:write` | Undoes a merge inside 24 hours (M1-09) |
| `POST /tickets/:ticketId/split` | `ticket:write` | Copies messages onto a new ticket (M1-09) |

### Listing

```
GET /api/brands/:brandId/tickets
  ?statusId=<uuid>            repeatable
  &systemState=open           repeatable: open | on_hold | escalated | closed
  &priority=urgent            repeatable: low | medium | high | urgent
  &departmentId=<uuid>        repeatable
  &channel=email              repeatable: email | chat | telegram | form | api | manual
  &assigneeId=<uuid>          repeatable; the value `unassigned` is a chip of its own
  &tagId=<uuid>               repeatable; `tagIds` is the same filter under another name
  &q=printer                  the subject, the contact's name, or a reference
  &sort=updatedAt             updatedAt | createdAt | number | priority
  &direction=desc             asc | desc
  &limit=25                   1–100
  &cursor=<opaque>            from the previous page's `nextCursor`
```

```json
{
  "tickets": [
    {
      "id": "0199f4b2-…",
      "number": 1042,
      "prefix": "HD",
      "subject": "Refund for order 42",
      "status": { "id": "0199f4b2-…", "name": "Open", "systemState": "open", "color": "info", "…": "…" },
      "priority": "medium",
      "channel": "manual",
      "departmentId": "0199f4b2-…",
      "assigneeId": null,
      "contactId": "0199f4b2-…",
      "contact": { "id": "0199f4b2-…", "name": "Nadia Karim" },
      "slaBreached": false,
      "closedAt": null,
      "updatedAt": "2026-09-19T12:00:00.000Z"
    }
  ],
  "nextCursor": "eyJzIjoidXBkYXRlZEF0Iiw…"
}
```

**Each row names its contact** (M1-15): `contact` is `{ id, name }`, read for
the whole page in one primary-key lookup, or `null` when the ticket names
nobody. It is the name and nothing else, because an address on every row of a
list is fifty addresses nobody asked to see. `GET /tickets/:ticketId` embeds the
same thing. The field is **left off** for a caller without `contact:read`
(every staff role holds it; an api key scoped to tickets alone would not), who
still has `contactId`, and the write routes leave it off too. Absent means "not
said", which a client must not read as "nobody".

**Paging is keyset, not offset.** `OFFSET 10000` makes Postgres walk ten
thousand rows it throws away, and it *skips* rows: a ticket updated between page
2 and page 3 moves to the front of an `updated_at` ordering and is never seen.
The cursor says "the row after this one", which is stable under writes and is an
index seek (REQUIREMENTS §5.2: p95 under 150 ms at 50k tickets per brand).

The cursor is opaque and is **not a token**: it carries nothing secret and grants
nothing, because every row it can reach is a row the policies would have shown
anyway. It is validated all the same, and a cursor issued under a different sort
is refused with 400 rather than reinterpreted.

**Search** reads the words of each ticket's **subject and first message**
(M1-15 part 2, [ADR 0011](../decisions/0011-ticket-search-token-table.md)).
`q` is turned into lexemes by the same `english` text-search configuration
`tickets.search` uses, so `refunds` finds "refund" and stop words such as `the`
are dropped. A ticket matches when it carries **every** word, in any order. A
word typed as `-word` rules out the tickets that carry it. Quotes are not a
phrase operator (the words must all appear, anywhere), `or` is a stop word
rather than an operator, and replies after the first message are not searched.

When the exact words fill less than a page and the words are at least three
characters long, the list **falls back** to a fuzzy reading: each word also
matches a stored word that starts with the same three characters and is
word-similar to it (`<%`, pg_trgm's 0.6 threshold). `renewa` finds "renewal";
`rfund` does not find "refund", because the first three letters differ. The
fallback is decided on the first page and the cursor carries it, so every page
of one search is answered the same way. The term is always bound as a
parameter. Why the search works this way, and what it costs, is under
[Search under row-level security](#search-under-row-level-security).

From M1-09 the same `q` also matches the **contact's name** (`ILIKE`, with `%`
and `_` escaped, through `contacts`, which is brand-scoped) and a **reference**:
`HD-1042`, `#1042` or `1042` match ticket number 1042 whatever the prefix,
because a brand has one sequence. The merge dialog's search is this list read.

`tagId` has **all-of** semantics (M1-06): a ticket matches when it carries every
tag named, not any of them. Two chips in a filter are how somebody narrows a
queue, and "any" would widen it — the reading that is wrong in the direction
that shows rows the reader asked to exclude. `tagIds` is the same filter under
another name, and naming both is naming their union.

### Creating

```http
POST /api/brands/:brandId/tickets
Content-Type: application/json

{
  "subject": "Refund for order 42",
  "bodyHtml": "<p>Where is my refund?</p>",
  "departmentId": "0199f4b2-…",
  "priority": "medium",
  "channel": "manual",
  "contactId": "0199f4b2-…",
  "tagIds": ["0199f4b2-…"],
  "custom": { "tier": "gold" },
  "clientId": "0199f4b2-…"
}
```

Or from a template, which fills whatever the request leaves out:

```http
POST /api/brands/:brandId/tickets

{ "templateId": "0199f4b2-…", "contactId": "0199f4b2-…" }
```

`subject`, `bodyHtml` and `departmentId` are required **unless** the request
names a `templateId`; a request with neither is a 400 naming the three fields.
A template that itself names no department leaves the request to name one, and a
request that names neither is refused. Everything the request does name wins
over what the template says.

`contactId` is optional: a ticket typed into the admin may have nobody attached
yet, and M1-13's identity rules are what attach one later. It is a foreign key
to `contacts` with `on delete set null`, so erasing a contact
(DOMAIN-RULES §11) does not take their tickets with them — the work and the SLA
history outlive the person's record.

Answers `201` with the ticket, its first message and its activity. The body is
the first message: a ticket with no message is a row nobody can answer, so the
two are never written apart.

**Creating a ticket is not idempotent, and `clientId` does not make it so.** The
uniqueness D §7 defines is `(conversation_id, client_id)`, and a conversation
does not exist until the ticket does — so a retried `POST /tickets` writes a
*second* ticket. What `clientId` does here is give the first message the same
dedupe key a reply gets. Idempotent creation needs a key that outlives the
request: M2-04's email threading key, M4's conversation id.

A department outside the actor's own scope answers `403` with a sentence rather
than letting the policy answer `500`.

A `PATCH` whose fields all already hold the values it names answers **200** and
writes nothing — no activity row, no outbox event — because "priority: medium →
medium" is an entry nobody reads and a phantom `ticket.updated` makes every
screen re-read for nothing. An *empty* body is a 400, so a caller retrying a
failed write can still tell the two apart.

`teamId` is refused with 400 until M1-01 creates `teams`: `tickets.team_id` has
no foreign key yet, so any uuid would be stored permanently. An `assigneeId` must belong to somebody who holds a role in the
brand — `tickets.assignee_id` references the *global* `users` table, so the
foreign key alone would accept a stranger (400). M1-07 adds the department:
the assignee must be able to work the department the ticket is in — or is
moving to — and not be a Viewer or deactivated (`not-eligible`, 409), and only
an Admin assigns a ticket to an Admin (`assignee-above-actor`, 403). The load
cap is not checked: a person may give an agent at cap another ticket. A move
into a department the current assignee cannot work clears the assignee, and a
ticket that is created or moved **unassigned** into a department that routes by
itself is handed to the rotation through the outbox — see
[Assignment](ticketing-settings.md#assignment).

### Replying

```http
POST /api/brands/:brandId/tickets/:ticketId/messages

{
  "kind": "public",
  "bodyHtml": "<p>On its way.</p>",
  "clientId": "0199f4b2-…",
  "attachmentIds": ["0199f4c1-…"]
}
```

`kind` is `public` or `note` and is **required** — a note posted as a public
reply by an omitted default is the worst bug this endpoint could have. `system`
and `ai` are the server's to write.

The response carries the `seq`. Posting the same `clientId` twice returns the
first message. A reply also bumps the ticket's `updated_at`, so it rises to the
front of the queue it just became urgent in, even though none of the ticket's
own columns moved.

`attachmentIds` is optional and names uploads already presigned, uploaded and
confirmed against **this** ticket by **this** principal (M1-10). They are linked
in the same transaction as the message, so a message never commits without the
files somebody believes they sent with it — and the whole send is refused rather
than shortened if any one of them cannot be linked. Every message carries its
`attachments` on the way back out, and on every later read of the thread. [The
attachments guide](attachments.md#sending-attachments-with-a-message) has the
rules.

A message on the wire carries neither `external_message_id` nor `ai_meta` nor
its denormalised `department_id`: the first is a channel's threading handle, the
second is cost accounting, and the ticket already says which department it is
in. M8 decides separately what the public API exposes.

### Catching up

```http
GET /api/brands/:brandId/tickets/:ticketId/messages?after=12&limit=25
```

```json
{ "messages": [{ "seq": 13, "…": "…" }], "nextAfter": null }
```

`nextAfter` is null on the last page, which is how a client knows it has caught
up rather than guessing from a short page. A client that receives a socket frame
with `seq > last_seq + 1`, or that reconnects, calls this.

## The admin workspace

`apps/admin/src/screens/tickets/` is the `Admin · ticket view` artboard: the
list, the thread and the details panel, on one route. The boundary it reads
through is `apps/admin/src/tickets/` — `TicketsApi`, an http adapter and a
fixture — the same shape the contact screens use.

It covers what the api can answer today. Views (M1-05), tags and custom-field
editing (M1-06), the state machine's transitions (M1-08), merge and split
(M1-09) and attachments (M1-10) add to it rather than change it; what each one
needs is at the end of this section.

### One screen, one route

`/tickets` is the list with nothing open and `/tickets/<id>` is that ticket
beside it, and **both are one `<Route>`** — `/tickets/*`, with the id read from
the path. Two routes rendering the same component would unmount and remount it
every time a ticket was opened or closed, throwing away the composer's draft
and whichever sends were still in flight.

**The URL is the state**, as it is on the contact screens: the view, the search
term and every filter live in the query string, so a filtered queue is a link
an agent can send a colleague and the back button steps through what they
looked at rather than out of the screen.

| Parameter | |
|---|---|
| `view` | `all`, `myOpen`, `unassigned`, `overdue` or `escalated`. Absent means `myOpen`. |
| `q` | Free text, debounced 250 ms, passed to the api's own search |
| `status`, `priority`, `assignee`, `department` | Repeatable, one per chip in the filter popover |

### The four views

Three of them are filters `GET /tickets` already understands, so the server
narrows them: `myOpen` is `assigneeId=<me>` plus the three live system states,
`unassigned` is `assigneeId=unassigned`, `escalated` is
`systemState=escalated`. **`overdue` is not** — the list has no filter on
`first_response_due_at` or `resolution_due_at` — so it asks for everything
still open and decides in the browser: a clock that has run out, or
`sla_breached`, on a ticket that is neither closed nor in a status that pauses
the clock. M1-05 replaces all four with saved views; that predicate is the one
thing it has to move to the server.

The counts beside them are what one page of each view holds, not a `COUNT(*)`:
the list is keyset paged and the api offers no total, so a brand with more than
a page reads `25+`. That is the honest answer and means the same thing.

### Sending, sent, not sent

The composer implements [§7](../planning/DOMAIN-RULES.md#7-realtime-delivery-contract)
exactly. A send draws its bubble at once with a client-generated `clientId`; the
bubble says **sending** until the response carries a `seq`, and **not sent,
retry** when ten seconds pass without one. Retrying posts the *same* `clientId`,
which the api de-duplicates on `(conversation_id, client_id)`, so retrying a
request that actually succeeded returns the original message rather than
posting a second one.

"Then set status" is applied **after** the send, never with it: a status moved
by a reply that never left would be a lie about what happened.

### Realtime

The workspace joins `ticket:<id>` while a ticket is open and
`department:<id>` for every department on the list. No frame is ever applied to
the cache — sockets are notifications and REST is the truth — so
`ticket:changed` re-reads the ticket and `ticket:message` reads
`?after=<the highest seq held>`. A reconnection does exactly the same thing,
which is why a missed frame and a dropped connection have one recovery between
them.

### The collision indicator

"Somebody else has this ticket open" is derived from a new
`ticket:viewing` event rather than from room membership, because a Socket.IO
room is not a membership list: a replica can enumerate the sockets it is
holding and no more, and the answer has to be true across every replica. So
each client says so every 30 s, the gateway authorises the announcement exactly
as it authorises the join and relays it to the rest of the room, and every
client drops a name nobody has repeated for 90 s. Nothing is stored, and
"closed the tab", "lost the network" and "went to lunch with it open" are one
answer.

M1-09 added `activity`: `replying` while the composer holds something unsent,
`viewing` otherwise. A change is announced at once rather than at the next
interval, the pill says "Mona is replying" and puts whoever is replying first,
and the same authorisation covers both words. It stays stateless on purpose: "is
replying" is not a lock, so a browser that crashes mid-reply cannot leave a
ticket claimed.

### Merge and split in the workspace

The ⋯ menu in the header (`ticket-actions-menu.tsx`) draws the entries it is
handed, in order; M1-09 passes Merge and Split, and M1-12's Log time and
M1-11's Mark as spam are added to the same array. A merged ticket offers
neither. The merge dialog searches with the list read and never offers the
ticket itself or a merged one; the split dialog lists the ticket's own
messages, oldest first. After either, the workspace opens the ticket the work
continues on. On the primary, each merged ticket is drawn where its
announcement was: a banner with Unmerge while its 24 hours last, a divider, and
its messages read-only on `bg.canvas`, each marked with its origin. The
secondary shows the banner the other way round above the thread, and no
composer. Built from `AdminTicketDialogs` panels 1, 2, 4 and 7.

### Attachments

Attach is real from M1-10. A file goes up as soon as it is chosen: the brand's
content policy is checked in the browser first, so a file the brand would
refuse costs no bytes, and the api applies the same rules to the presign
request and again to the stored object — a client's opinion is not an
authorisation.

**A message may be sent while the pipeline is still working.** `upload`
resolves at `processing`, the ids travel with the send as `attachmentIds`, and
the api links them in the message's own transaction; it refuses the *whole*
send if any one of them cannot be linked, so a failure is a message that was
not sent rather than one that quietly lost a file. A retry carries the same ids
for the same reason it carries the same `clientId`.

A chip has three states, because the pipeline has three answers: working on it,
done, and refused. A refusal is drawn rather than hidden — the file is not
coming, and a chip that quietly disappeared would leave somebody believing they
had sent it. No thumbnails: a render URL is presigned, lives five minutes and
has to be asked for per attachment, so a thread of them would be a burst of
requests for pictures nobody has opened.

### Keyboard

`j` and `k` move through the list and open what they land on, `r` puts the
caret in the composer, `n` does the same in note mode, and `Esc` closes a
drawer or a dialog. A single letter is only a shortcut while nobody is writing:
anything typed into a field is left alone, as is anything carrying a modifier.

### The ⋯ menu

The button beside Macro in the header opens the ticket's actions menu
(`Admin · ticket dialogs`, panel 2). Its items are an array each deliverable
contributes to — `ticket-actions-menu.tsx` draws whatever it is handed — so
merge and split (M1-09) and log time (M1-12) add entries rather than markup.
M1-11's is the last: **Mark as spam**, in danger text behind a separator, which
opens the confirmation of panel 5 with a ticked "Block <sender>" card when the
api says the sender may be blocked; or **Not spam** on a ticket already in
Spam, which reopens it at once. A merged secondary offers neither.

### What the screen cannot do yet, and why

| Drawn | State | Owner |
|---|---|---|
| Canned response, Macro | disabled, with the reason | M3 |
| Translate | disabled, with the reason | M7 |
| Tags | not drawn at all until a ticket has any | M1-06 |
| Custom fields | read-only | M1-06 |
| Linked tickets | read-only, from `parent_id` / `merged_into_id` / `split_from_id` | M1-08, M1-09 |
| The AI bubble's confidence | not drawn: `ai_meta` is deliberately not on the wire | M7 |
The **assignee picker** (M1-07, `AdminTicketDialogs` panel 3) reads
`GET /brands/:id/assignment/:departmentId/assignable`, which `ticket:write`
reaches, rather than the staff roster, which is `staff:manage` and which an
Agent does not hold. It lists everybody who can work the ticket's department —
minus Admins, for anybody who is not one — with a presence dot and their open
tickets against the department's cap ("8/8 at cap" in danger, "offline" instead
of a count). The button names the current assignee even when they are outside
the list, from the staff read when it has them and as a shortened id when not.

The rows name their contact from the ticket itself: the list embeds
`contact: { id, name }` ([Listing](#listing)), so a row no longer depends on its
contact being on the first page of `GET /contacts`, and the workspace no longer
reads that page at all. The open ticket reads its one contact in full, for the
details card and the thread's address line.

## Performance

The M1 exit criterion is "ticket list of 50k seeded tickets loads under 150 ms
p95 under the D §14 conditions" ([DOMAIN-RULES §14](../planning/DOMAIN-RULES.md#14-performance-test-conditions),
REQUIREMENTS §5.2). What makes that true, how it is measured, and what it
measured last.

### The index set

Every list is ordered by the keyset `(updated_at, id)`, so every index a list
reads *in order* ends in exactly those two columns
(`0021_ticket_list_indexes.sql`):

| Index | Serves |
|---|---|
| `tickets_brand_updated_idx (brand_id, updated_at, id)` | The default list; every view that filters rather than narrows (the live states, Escalated, Unassigned); search; page 2 onwards |
| `tickets_brand_assignee_updated_idx (brand_id, assignee_id, updated_at, id)` | "My open": one person's tickets, already in list order. Replaces the PRD's `(brand_id, assignee_id)`, which is its prefix |
| `tickets_brand_department_status_updated_idx (brand_id, department_id, status_id, updated_at, id)` | The filter popover's department and status chips. `id` was added so one department in one status is in keyset order too |
| `tickets_brand_number_key (brand_id, number)` | `sort=number` |
| `ticket_tags_brand_tag_idx (brand_id, tag_id)` | The all-of tag filter, one scan however many tags are named (M1-06) |
| `ticket_search_tokens_brand_token_idx (brand_id, token, ticket_id, department_id)` | Search: every word of `q` is an index lookup, and the fuzzy fallback a prefix range (M1-15 part 2) |
| `tickets_brand_contact_idx (brand_id, contact_id)` | Search by the contact's name: the tickets of the contacts whose name matched (M1-15 part 2) |
| `tickets_search_idx` (tsvector GIN), `tickets_subject_trgm_idx` (trigram GIN) | Not the list: see [Search under row-level security](#search-under-row-level-security) |

`sort=createdAt` and `sort=priority` have no index of their own. The workspace
never asks for them, and at 50k tickets they are a top-N sort of the visible
rows, which is what the default list was before its index (27 ms of database
time); an index per sort key would be paid on every write for a
sort nobody uses yet.

### The brand equality

The list's `WHERE` carries `tickets.brand_id = <the brand in the path>`
(`ticket-query.ts`). It is **not isolation**: the policy's
`brand_id = ANY(app.brand_ids)` already decides that, and the equality cannot
widen it. It is for the planner. Against an array it cannot know that one brand
is involved, so it cannot read `(brand_id, updated_at, id)` in order, and it
fetched every visible ticket and sorted them. With the equality, a page is a
backward index scan that stops after `limit + 1` rows. The key lines, before
and after, as the runtime role under an Admin's context at 50k tickets:

```text
-- before: every visible ticket, then a sort
Sort  Sort Key: tickets.updated_at DESC, tickets.id DESC  Sort Method: top-N heapsort
  ->  Parallel Bitmap Heap Scan on tickets  (rows=16591 loops=3)
        ->  Bitmap Index Scan on tickets_brand_assignee_idx  (rows=50000)
Execution Time: 27.248 ms

-- after: one page, in index order
Limit
  ->  Index Scan Backward using tickets_brand_updated_idx on tickets  (rows=26 loops=1)
        Index Cond: ((brand_id = ANY (…app.brand_ids…)) AND (brand_id = '…'::uuid))
Execution Time: 0.210 ms
```

Every list query of the benchmark, as Admin and as Agent (key lines; every run
prints the full plans):

| Query | Admin | Agent (2 of 5 departments) |
|---|---|---|
| All tickets | `Index Scan Backward using tickets_brand_updated_idx`, 26 rows read, 0.21 ms | same index, 129 read (103 removed by the department policy), 0.33 ms |
| My open | `Index Scan Backward using tickets_brand_assignee_updated_idx`, 0.05 ms | same index, 3.9 ms |
| Unassigned (live states) | `tickets_brand_updated_idx`, 750 read, 2.7 ms | same, 1.6 ms |
| Live states (Overdue) | `tickets_brand_updated_idx`, 413 read, 0.85 ms | same, 1.9 ms |
| Escalated | `tickets_brand_updated_idx`, 1 350 read, 3.1 ms | same, 6.0 ms |
| Search `refund` | `Index Only Scan using ticket_search_tokens_brand_token_idx`, `Index Cond: … token = ANY('{refund}')`, 3 191 ids, then `tickets_pkey` and a top-N sort, 37 ms | same, 17 ms |
| Search `renewa` (half-typed) | exact half: token index, 0 ids, 9.1 ms; fuzzy fallback: prefix range of the token index, 53 ms | 8.7 ms; 30 ms |
| Search matching nothing | exact half: token index, **0 ids, 8.8 ms**; fuzzy fallback: prefix range, 0 candidates, 9.5 ms | 8.2 ms; 8.2 ms |
| Two tags, all-of | `Bitmap Index Scan on ticket_tags_brand_tag_idx`, then `Index Scan using tickets_pkey`, 22.6 ms | same, 15.5 ms |
| Page 2 | `Index Scan Backward using tickets_brand_updated_idx`, `Index Cond: … ROW(updated_at, id) < ROW(…)`, 0.15 ms | same, 0.42 ms |

"Unassigned" reads the brand-wide index rather than the assignee one: `IS NULL`
is an index condition but not an equality, so Postgres cannot treat the
assignee index as ordered past it, and walking the newest tickets is cheaper
than sorting all 4 800 unassigned ones.

### Search under row-level security

Postgres will not use a condition as an index condition ahead of a row-level
security policy unless the condition's operator is `LEAKPROOF`: a function that
is not could raise an error that reveals a row the policy was about to hide.
`@@` (`ts_match_vq`) and `<%` (`word_similarity_op`) are not leakproof (nor is
`=` on an enum, which is why the priority and channel filters are filters too).
Until M1-15 part 2 the list evaluated a search on each visible ticket, newest
first, until it had a page, and **a term that matched nothing read every visible
ticket**: 257 ms for an Admin at 50k tickets.

[ADR 0011](../decisions/0011-ticket-search-token-table.md) moved search onto
`ticket_search_tokens`, one row per lexeme of a ticket's subject and first
message, under the same `FORCE`d brand and department policies as every ticket
child table. `=` and the range comparisons on `text` are leakproof, so the
token lookup is an **index condition ahead of the policy**, and the policy's
department check runs on the index entry (`department_id` is in the index, so
no heap is read). The key lines, as the runtime role under an Admin's context at
50k tickets, for a term nothing matches:

```text
-- exact half
Index Only Scan using ticket_search_tokens_brand_token_idx on ticket_search_tokens tokens  (rows=0 loops=1)
  Index Cond: ((brand_id = ANY (…app.brand_ids…)) AND (brand_id = '…'::uuid) AND (token = ANY ('{zebra}'::text[])))
  Filter: (COALESCE(…app.all_departments…) OR (department_id = ANY (…app.department_ids…)))
Execution Time: 8.798 ms

-- fuzzy fallback: the words sharing the first three letters, then <%
Index Only Scan using ticket_search_tokens_brand_token_idx on ticket_search_tokens near  (rows=0 loops=1)
  Index Cond: ((brand_id = ANY (…)) AND (brand_id = '…'::uuid) AND (token >= "left"(wanted.lexeme, 3)) AND (token < ("left"(wanted.lexeme, 3) || '…'::text)))
Execution Time: 9.487 ms
```

Most of those 9 ms is the contact-name half (`ILIKE` over the brand's 20 000
contacts); the token lookups themselves take well under a millisecond. The
fuzzy half's candidates are read in a `LATERAL` subquery kept apart with
`OFFSET 0`: flattened, the planner read every token of the brand and applied the
range as a join filter (151 ms). An integration test (`tickets.integration.test.ts`,
"looks the … words up in the token index ahead of the policy") `EXPLAIN`s both
halves as the runtime role and fails if the token condition leaves `Index Cond`.

What it costs: a common word is no longer "stop after a page". Every ticket
carrying `refund` (3 191 of 50 000) is found, joined and top-N sorted, so that
search went from p95 47 ms to 86 ms under load. That is inside the gate and
grows with how many tickets share a word, not with the brand's size.

The two GIN indexes stay: the PRD names the tsvector one, and both serve paths
that run as the owner. `LEAKPROOF` wrappers were rejected: the operators can
raise, so the promise would be false.

### How it is measured

```bash
pnpm --filter @helpdock/api build
pnpm --filter @helpdock/api perf:tickets
```

`apps/api/src/testing/perf/`, run by `apps/api/vitest.perf.config.ts`:

1. **Dataset** (`dataset.ts`): five brands. The measured one has 50 000
   tickets, about 200 000 messages and 20 000 contacts, the other four 10 000
   tickets each. The rows are written by `INSERT … SELECT generate_series(…)` as
   the runtime role inside each brand's system transaction, so every one passes
   the same policies and department triggers as the api's own writes, and each
   ticket is numbered from the brand's own sequence. The shape is a desk two
   years in: 70 % Closed, 3 % Spam, 2 % Merged, and the live queues (Open 14 %,
   Awaiting customer 8 %, Escalated 3 %) recent; five departments at
   45/20/15/12/8 %; twenty assignees, a quarter of the live queue unassigned;
   0–3 tags per ticket on a power law; 0.5 % soft-deleted. Every random choice
   is seeded, so a run is repeatable. Articles and knowledge chunks have no
   tables until M5.
2. **Stack**: `pgvector/pgvector:pg17` and `redis:7-alpine` in containers, and
   **two api replicas** started from `dist/` as separate processes with
   `NODE_ENV=production`.
3. **Load** (`load.ts`): 50 concurrent staff sessions, closed loop, each
   waiting 1 s between a response and its next request, spread over the two
   replicas. Each session cycles through every scenario, once as an Admin and
   once as an Agent confined to the two smallest departments (20 % of the
   tickets): All tickets, My open, Unassigned, the live states of Overdue,
   Escalated, search `refund`, search `renewa`, a search nothing matches (`zebra`), two tags, page 2, and opening a
   ticket. Two minutes of warm-up, ten measured, p50/p95/p99 by nearest rank.
4. **Zero-match search**: a search nothing matches is in the mix like every
   other scenario, gated by its own budget, `PERF_NO_MATCH_P95_MS` (ADR 0011).
   Until M1-15 part 2 it was measured alone and reported, not gated.
5. **Plans**: `EXPLAIN (ANALYZE, BUFFERS)` of every list query, built by the
   repository's own `listTicketsStatement`, run as the runtime role inside the
   tenant context the request would carry.

| Variable | Default | |
|---|---|---|
| `PERF_CONCURRENCY` | 50 | staff sessions |
| `PERF_THINK_MS` | 1000 | pause between one session's requests |
| `PERF_WARMUP_S` / `PERF_DURATION_S` | 120 / 600 | |
| `PERF_REPLICAS` | 2 | api processes |
| `PERF_P95_MS` | 150 | the gate |
| `PERF_NO_MATCH_P95_MS` | 150 | the zero-match search's own gate |
| `PERF_SCALE` | 1 | multiplies the dataset; `0.1` for a smoke run |
| `PERF_REPORT` | none | also write the results and plans as JSON |

**What differs from §14**, so the numbers are read for what they are: the host
is whatever runs the command, not a dedicated 2 vCPU / 4 GB machine; the load
generator shares it; there is no worker and no widget traffic (the widget is
M4); and there are no articles or chunks. On a shared or busy machine the tail
measures the machine, so run it on an idle one.

### What it measured last (2026-09-25)

**The gate passes, zero-match search included** (M1-15 part 2, after ADR 0011).
The full §14 run: 50 sessions, 1 s think time, 2 min warm-up, 10 min measured,
two replicas; 48.6 req/s, overall p95 70 ms, **no errors**. The slowest list
scenario is 110 ms against the 150 ms gate. This run was **not pinned**: the
container was shared with other build jobs and the load average stayed above
the threshold for a pinned run (mean 3.1, range 1.3–8.9 over the run), so read
the tail as an upper bound. The previous column is the pinned, idle run of the
index set before the token table.

| Scenario | Admin p50 / p95 / p99 ms | Agent p50 / p95 / p99 ms | Before, p95 Admin / Agent |
|---|---|---|---|
| All tickets | 13 / 29 / 45 | 14 / 27 / 41 | 32 / 32 |
| My open | 8 / 19 / 32 | 13 / 28 / 41 | 21 / 28 |
| Unassigned | 15 / 29 / 45 | 16 / 31 / 41 | 31 / 33 |
| Live states (Overdue) | 14 / 28 / 43 | 16 / 33 / 51 | 29 / 34 |
| Escalated | 16 / 32 / 46 | 21 / 38 / 48 | 36 / 39 |
| Search `refund` | 54 / 86 / 110 | 35 / 60 / 82 | 47 / 51 |
| Search `renewa` (fuzzy fallback) | 74 / 110 / 129 | 58 / 91 / 114 | 46 / 48 |
| **Search matching nothing** | **31 / 51 / 70** | **31 / 51 / 65** | 284 / 186 (alone, not gated) |
| Two tags, all-of | 27 / 48 / 66 | 32 / 54 / 77 | 50 / 53 |
| Page 2 | 13 / 27 / 40 | 14 / 27 / 42 | 28 / 29 |
| Open a ticket | 20 / 39 / 56 | 20 / 40 / 58 | 46 / 41 |

The zero-match search went from reading every visible ticket to two index
probes: p95 284 ms measured alone to 51 ms inside the full load. A word many
tickets share costs more than before, and a half-typed word pays for two
statements (the exact half, then the fallback); both are explained under
[Search under row-level security](#search-under-row-level-security).

An earlier run (2026-09-24) on the same container while six other build jobs
shared it (load average 27–64) put list p95 at 0.8–2.1 s: that measured the
machine's queue, not the api, which is why a run belongs on an idle host.

Before the index set and the brand equality, the same quieter-machine
comparison could not be made, but the plans could: the default list read and
sorted every visible ticket (27 ms of database time on its own, before load),
and a first full-scale run on the same shared machine put the default list's
p50 at 114 ms against 20 ms after the change.

## Time tracking

M1-12, and optional per brand (REQUIREMENTS §4.1): **Ticketing › Feedback ›
Track time on tickets**, off by default.

`ticket_time_entries` holds one row per entry: who, how long in whole seconds
(1 to 24 h 59 m, the Log time dialog's bounds), an optional staff-only note,
and the reply it was logged with when it came from the per-reply timer. It is a
child of the ticket and **department-scoped** like the thread: the shared
triggers copy the ticket's department on insert and move it with the ticket, so
an agent who cannot read a ticket cannot read or log its time, and the RLS
negative suite covers the table.

There are three ways time gets logged:

| From | How | Row |
|---|---|---|
| The Log time dialog (header ⋯ → "Log time…", or "Add time manually") | `POST …/time-entries` | `message_id` null, with the note |
| The Time card's timer, **Log** | `POST …/time-entries` with what the timer counted | `message_id` null |
| The per-reply timer | `timeSpentSeconds` on `POST …/messages`, written in the **same transaction** as the reply | `message_id` = the reply |

The timer lives in the browser (`apps/admin/src/screens/tickets/use-ticket-timer.ts`):
nothing reaches the server until a reply is sent or Log is pressed, so an
abandoned timer costs nothing. With **Start the timer when an agent opens the
composer** on, it starts when the caret enters the reply box; sending a reply
or a note stops it and sends its time with the message. A timer left running
for longer than one entry allows is capped rather than refused, because the
reply must not fail over it. A reply's timer is dropped, never refused, while
the brand has tracking off.

Anybody who can write to the ticket may log time; an entry is deleted by
whoever logged it, or by a Team Leader or an Admin. A Viewer reads the card and
has none of its controls. Entries are not realtime yet: another agent's Time
card updates on its next read.

## Satisfaction surveys

M1-12 (REQUIREMENTS §4.1, DOMAIN-RULES §2.2 and §4.6). **Ticketing › Feedback ›
Ask for a rating when a ticket closes**, on by default.

**One survey per close.** A close that is not spam or a merge (read off the
status's `is_spam` through `isSpamStatus` and the ticket's `merged_into_id`,
never off a name) runs `onClosedForCsat`, which — when the brand has CSAT on — writes
`csat.requested { ticketId, closedAt }` to the outbox in the closing
transaction. The worker's handler (`apps/api/src/csat/csat-events.ts`) re-reads
the ticket and creates the row in `csat_responses` only if that close still
stands: a ticket reopened, merged, marked as spam or deleted before the job ran
gets none. `(ticket_id, closed_at)` is unique, so a redelivered job is a no-op,
and a ticket reopened and closed again gets a second survey. `csat_responses`
is department-scoped like the other children of a ticket.

**The link.** `APP_URL/csat/<token>`. The token is `<ids>.<mac>`: the brand and
survey ids, and an HMAC-SHA256 over them under a key derived from
`APP_MASTER_KEY` with HKDF (`apps/api/src/csat/tokens.ts`). Only a SHA-256 of it
is stored. It is:

- **signed** — an altered or guessed token is refused before any query runs;
- **bound to one ticket** — it names one survey, and the survey one ticket;
- **single-use** — the rating is written by an `UPDATE … WHERE rated_at IS NULL
  AND expires_at > now()`, so two submissions cannot both win; the second
  answers `used`;
- **expiring** — 30 days after the survey is created, it answers `expired`.

A token signed under `APP_MASTER_KEY_PREVIOUS` still verifies, so a key
rotation does not strand the surveys already out; a key older than that does
not.

**The public routes are an explicit system path.** The token names the brand, so
the api opens a transaction scoped to exactly that brand as the system principal
`csat:<surveyId>`, reads one survey and its ticket's reference and subject, and
writes an `audit_log` row (`csat.viewed`, `csat.rated`) for every use of a valid
link. Both routes share a per-address budget of 30 requests in 15 minutes
(`CSAT_PUBLIC_RULE`), and both collapse the token to `:token` before the request
line is logged. A spent link answers with the brand alone — never the subject.

**The agent's view.** `GET /tickets/:ticketId` carries `csat` for the latest
close: `pending` (created, not delivered), `sent` (a channel delivered it —
M8-06), `rated` (with the rating and comment) or `expired`, and the link while
it can still be used. The details panel draws it on a Satisfaction card with
**Copy survey link**, because channels do not deliver it yet.

**The contact card.** A contact's `stats.csat` is the share of their answered
surveys rated 4 or 5, as a percentage, over the tickets the viewer can see; null
when they have answered none.

**The rating page** is served by the admin bundle at `/csat/<token>` but
mounted without any of the staff app (ADR
[0010](../decisions/0010-csat-page-in-the-admin-bundle.md)). Its language is
`?lang=` when it names `en` or `ar`, otherwise the brand's default; it is themed
with the brand accent when the brand has one (none do until M5/M6's themes).

## What later milestones add

| Milestone | Adds |
|---|---|
| M1-13 | Shipped. Identity rules, contact merge with undo ([guide](contacts.md#identity-rules-and-merging-m1-13)), and the [participants](#participants-m1-13) card in the details panel |
| M1-09 | Shipped in branch. Merge, unmerge and split ([above](#merge-and-split)), and "is replying" on the collision indicator. Leaves `MergeParticipantsHook` for M1-13 and `onMerged` / `onUnmerged` for M3-02 |
| M1-10 | Shipped. `attachments` hangs off the ticket and, once sent, off `ticket_messages.id`; `POST …/messages` takes `attachmentIds` and every message carries its `attachments` ([guide](attachments.md)) |
| M1-11 | Shipped in branch. `is_spam` on the Spam status, `POST`/`DELETE …/spam`, `ticket.spam`, the sender block list and its inbound gate ([Spam](#spam)) |
| M1-12 | Shipped. Time tracking and satisfaction surveys ([above](#time-tracking)) |
| M8-06 | Delivering the survey link with the closing message on email, widget and Telegram; sets `csat_responses.sent_at` |
| M1-15 | The rest of the admin UI, as each deliverable above lands — including the tag picker and the custom field editors in the details panel |
| M2 | Inbound and outbound email on the same `ticket_messages`, keyed by `external_message_id` |
| M3 | Macros, which set a status, a priority, an assignee **and tags** in one action, and rules whose conditions read custom field keys |
| M3-02 | The SLA engine, filling `first_response_due_at`, `resolution_due_at` and `sla_breached` |
| M7 | AI that suggests tags, a priority and a department for a ticket |
| M5 | Per-locale search configuration; `tickets.search` uses `english` for every brand today |
