# Tickets

The ticket, its thread and its activity log: what the tables hold, who may see
what, and the endpoints a client calls. Specified by
[REQUIREMENTS §4.1](../planning/REQUIREMENTS.md#41-ticketing-zoho-style),
[ARCHITECTURE §5](../planning/ARCHITECTURE.md#5-data-model-core-tables) and
[DOMAIN-RULES §2](../planning/DOMAIN-RULES.md#2-ticket-lifecycle) and
[§7](../planning/DOMAIN-RULES.md#7-realtime-delivery-contract). Implemented by
M1-02 (tickets), M1-03 (messages) and M1-08 (the state machine).

There is no ticket screen yet. The admin UI is M1-15; this describes the api it
will be built on.

## The model

```
tickets ──< ticket_messages          one thread per ticket, ordered by `seq`
        ──< ticket_activity          who changed what, and how
        ──> ticket_statuses          the brand's own list, mapped to four system states
```

| Table | Scope | Notes |
|---|---|---|
| `ticket_statuses` | brand | The statuses a brand offers. Brand-scoped, not department-scoped: an Agent has to read the name of the status a ticket in their own department is in. |
| `tickets` | brand **and department** | `department_id` is not null. A ticket with no department would be invisible to everyone. |
| `ticket_messages` | brand **and department** | `department_id` is denormalised from the ticket by trigger. |
| `ticket_activity` | brand **and department** | The same, and for the same reason. |

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
| any | Marked spam | Spam. M1-11 owns what else that means |
| any | Merged | Merged. M1-09 owns the rest |
| any | Soft-deleted by Admin | Hidden from every view; purged by retention (§11) |

Two facts are checked **before** the table and refuse every event, because they
answer all of them the same way: a ticket with `merged_into_id` belongs to the
one it was merged into (§2.4), and a soft-deleted ticket is not acted on at all.
Both answer **409** with `error.lifecycle.reason` — `ticket-merged`,
`ticket-deleted`, or `ticket-not-closed` for a reopen of something that was
never closed — so the screen picks a sentence rather than printing the api's.

An agent "closing" a ticket *is* an agent setting a status whose system state is
`closed`: there is one control on the screen and it is a status picker. Which of
the three rows happened is read off the states afterwards, which is what decides
whether `closed_at` moves and which hook fires.

### Which status plays which part

Never by name — a brand may rename any of them (`packages/db/src/ticket-statuses.ts`):

| Part | Found by |
|---|---|
| Where a new or reopened ticket lands | `is_default` |
| Awaiting customer | `awaiting_customer`, seeded rows first |
| No CSAT, out of reports | `excluded_from_reports` |
| The secondary of a merge | `merged_into_id` on the *ticket* |

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

`apps/api/src/tickets/lifecycle/hooks.ts` names three moments and does nothing
at any of them. They are a provider, so M3-02 and M1-12 replace one line of
`TicketsModule` rather than editing the service that calls them.

| Hook | Fires when | Filled by |
|---|---|---|
| `onResolved` | A ticket reaches a closed state, **including** spam and merge — a clock left running on a ticket nobody will touch again is a clock that breaches | M3-02 |
| `onClosedForCsat` | The same, **unless** the ticket is merged or the status is `excluded_from_reports` | M1-12 |
| `onReopened` | A closed ticket comes back, by policy or by an agent (§3.5) | M3-02 |

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

## Side effects and realtime

Every mutation writes its outbox row in the same transaction as the change
([DOMAIN-RULES §6](../planning/DOMAIN-RULES.md#6-transactional-outbox)). Six
events: `ticket.created`, `ticket.updated`, `ticket.replied`,
`ticket.note_added`, and — from M1-08 — `ticket.closed` and `ticket.reopened`.

The last two carry the same payload as `ticket.updated` and reach the same
rooms. What they add is a name, so M1-12's survey and M3's clocks can consume
one event instead of diffing two reads of the ticket.

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
| `PATCH /tickets/:ticketId` | `ticket:write` | Subject, priority, department, assignee, status. Setting a team answers 400 until M1-01; clearing one with `null` is allowed |
| `GET /tickets/:ticketId/messages` | `ticket:read` | The thread after a `seq` |
| `POST /tickets/:ticketId/messages` | `ticket:write` | A public reply or an internal note |
| `DELETE /tickets/:ticketId` | `brand:manage` | Soft-deletes it (§2.2). Admin only: hiding a ticket from the whole brand is not an edit |
| `GET /tickets/:ticketId/activity` | `ticket:read` | The newest 100 activity entries, oldest first. It does not page yet |

### Listing

```
GET /api/brands/:brandId/tickets
  ?statusId=<uuid>            repeatable
  &systemState=open           repeatable: open | on_hold | escalated | closed
  &priority=urgent            repeatable: low | medium | high | urgent
  &departmentId=<uuid>        repeatable
  &channel=email              repeatable: email | chat | telegram | form | api | manual
  &assigneeId=<uuid>          repeatable; the value `unassigned` is a chip of its own
  &q=printer                  free text over the subject
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
      "slaBreached": false,
      "closedAt": null,
      "updatedAt": "2026-09-19T12:00:00.000Z"
    }
  ],
  "nextCursor": "eyJzIjoidXBkYXRlZEF0Iiw…"
}
```

**Paging is keyset, not offset.** `OFFSET 10000` makes Postgres walk ten
thousand rows it throws away, and it *skips* rows: a ticket updated between page
2 and page 3 moves to the front of an `updated_at` ordering and is never seen.
The cursor says "the row after this one", which is stable under writes and is an
index seek (REQUIREMENTS §5.2: p95 under 150 ms at 50k tickets per brand).

The cursor is opaque and is **not a token**: it carries nothing secret and grants
nothing, because every row it can reach is a row the policies would have shown
anyway. It is validated all the same, and a cursor issued under a different sort
is refused with 400 rather than reinterpreted.

**Search** is full text *and* trigram. `q` goes to `websearch_to_tsquery` against
the generated `tickets.search` column — which understands quoted phrases and
`-excluded`, and never raises on nonsense — *or* to the `<%` word-similarity
operator against the subject, through `tickets_subject_trgm_idx`. Full text will
not match `renewa` against "renewal"; the trigram half will. Both bind the term
as a parameter.

`tagId` is declared and **refused with 400** until M1-06 exists. A filter that is
accepted and not applied would quietly show rows the reader asked to exclude.

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
  "clientId": "0199f4b2-…"
}
```

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

`teamId` is refused with 400 until M1-01 creates `teams`, for the reason `tagId`
is: `tickets.team_id` has no foreign key yet, so any uuid would be stored
permanently. An `assigneeId` must belong to somebody who holds a role in the
brand — `tickets.assignee_id` references the *global* `users` table, so the
foreign key alone would accept a stranger. Which *department* an assignee must
be in is M1-07's question.

### Replying

```http
POST /api/brands/:brandId/tickets/:ticketId/messages

{ "kind": "public", "bodyHtml": "<p>On its way.</p>", "clientId": "0199f4b2-…" }
```

`kind` is `public` or `note` and is **required** — a note posted as a public
reply by an omitted default is the worst bug this endpoint could have. `system`
and `ai` are the server's to write.

The response carries the `seq`. Posting the same `clientId` twice returns the
first message. A reply also bumps the ticket's `updated_at`, so it rises to the
front of the queue it just became urgent in, even though none of the ticket's
own columns moved.

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

## What later milestones add

| Milestone | Adds |
|---|---|
| M1-13 | Identity rules: verified matches, automatic merge, participants (contact + CCs) |
| M1-06 | `tags`, `ticket_tags` and custom field definitions — the `tagId` filter starts working |
| M1-07 | Assignment: round-robin, skill-based, load caps, auto-unassign |
| M1-09 | Merge and split (`merged_into_id`, `split_from_id`), and the collision indicator on `ticket:<id>` rooms |
| M1-10 | `attachments`, keyed to `ticket_messages.id`, and presigned URLs issued after authorization on the parent ticket |
| M1-11 | Spam semantics on the seeded Spam status, and the sender block list |
| M1-15 | The admin UI, from the `Admin · ticket view` artboard |
| M2 | Inbound and outbound email on the same `ticket_messages`, keyed by `external_message_id` |
| M3-02 | The SLA engine, filling `first_response_due_at`, `resolution_due_at` and `sla_breached` |
| M5 | Per-locale search configuration; `tickets.search` uses `english` for every brand today |
