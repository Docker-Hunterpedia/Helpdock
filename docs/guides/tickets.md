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
        ──> ticket_statuses          the brand's own list, mapped to four system states
```

| Table | Scope | Notes |
|---|---|---|
| `ticket_statuses` | brand | The statuses a brand offers. Brand-scoped, not department-scoped: an Agent has to read the name of the status a ticket in their own department is in. |
| `tickets` | brand **and department** | `department_id` is not null. A ticket with no department would be invisible to everyone. |
| `ticket_messages` | brand **and department** | `department_id` is denormalised from the ticket by trigger. |
| `ticket_activity` | brand **and department** | The same, and for the same reason. |
| `ticket_tags` | brand **and department** | The same again (M1-06). The primary key is `(ticket_id, tag_id)`, so adding a tag twice is one row. |
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
| any | Marked spam | Spam. M1-11 owns what else that means |
| any | Merged | Merged, with `merged_into_id` — see [Merge and split](#merge-and-split) |
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

Never by name — a brand may rename any of them (`packages/db/src/ticket-statuses.ts`).
A flag where one says what the row is; `system_key` (M1-09) where the flags
cannot tell two rows apart, which is Spam and Merged:

| Part | Found by |
|---|---|
| Where a new or reopened ticket lands | `is_default` |
| Awaiting customer | `awaiting_customer`, seeded rows first |
| No CSAT, out of reports | `excluded_from_reports` |
| The secondary of a merge | `merged_into_id` on the *ticket* |
| The status a merge closes into | `system_key = 'merged'` (seeded, backfilled by migration `0016`) |

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

`apps/api/src/tickets/lifecycle/hooks.ts` names five moments and does nothing
at any of them. They are a provider, so M3-02 and M1-12 replace one line of
`TicketsModule` rather than editing the service that calls them.

| Hook | Fires when | Filled by |
|---|---|---|
| `onResolved` | A ticket reaches a closed state, **including** spam — a clock left running on a ticket nobody will touch again is a clock that breaches. Not on a merge, which fires `onMerged` | M3-02 |
| `onClosedForCsat` | The same, **unless** the ticket is merged or the status is `excluded_from_reports` | M1-12 |
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
worker. **M1-14's retention must not delete an object while any row still names
its key.**

Both tickets' reads carry `related`: the ticket this one was split from and the
tickets split from it, so the thread can link the references its system
messages name.

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
| `PATCH /tickets/:ticketId` | `ticket:write` | Subject, priority, department, assignee, status, custom values. Setting a team answers 400 until M1-01; clearing one with `null` is allowed |
| `GET /tickets/:ticketId/messages` | `ticket:read` | The thread after a `seq` |
| `POST /tickets/:ticketId/messages` | `ticket:write` | A public reply or an internal note |
| `DELETE /tickets/:ticketId` | `brand:manage` | Soft-deletes it (§2.2). Admin only: hiding a ticket from the whole brand is not an edit |
| `GET /tickets/:ticketId/activity` | `ticket:read` | The newest 100 activity entries, oldest first. It does not page yet |
| `GET /tickets/:ticketId/tags` | `ticket:read` | The chips on one ticket (M1-06) |
| `PUT /tickets/:ticketId/tags` | `ticket:write` | Replaces the whole set (M1-06) |
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
foreign key alone would accept a stranger. Which *department* an assignee must
be in is M1-07's question.

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

### What the screen cannot do yet, and why

| Drawn | State | Owner |
|---|---|---|
| Canned response, Macro | disabled, with the reason | M3 |
| Translate | disabled, with the reason | M7 |
| Tags | not drawn at all until a ticket has any | M1-06 |
| Custom fields | read-only | M1-06 |
| Linked tickets | read-only, from `parent_id` / `merged_into_id` / `split_from_id` | M1-08, M1-09 |
| The AI bubble's confidence | not drawn: `ai_meta` is deliberately not on the wire | M7 |
| The assignee picker | the people it can name, and the current assignee as a shortened id when it cannot | M1-07 |

That last one is worth a sentence. `GET /brands/:id/staff` declares
`staff:manage`, which an Agent does not hold — so the one screen that most
needs a list of colleagues is the one least able to read it. The read is
allowed to fail and the picker degrades to the viewer plus whoever it could
name. **M1-07 should expose a read of assignable agents that `ticket:write`
reaches.**

The rows also name their contact from the first page of `GET /contacts`, which
is a page and not a map: a ticket whose contact is further down is drawn
without a name rather than with a wrong one. Embedding the contact summary in
the ticket list row would close that, and is a change to M1-02's response.

## What later milestones add

| Milestone | Adds |
|---|---|
| M1-13 | Identity rules: verified matches, automatic merge, participants (contact + CCs) |
| M1-07 | Assignment: round-robin, skill-based, load caps, auto-unassign |
| M1-09 | Shipped in branch. Merge, unmerge and split ([above](#merge-and-split)), and "is replying" on the collision indicator. Leaves `MergeParticipantsHook` for M1-13 and `onMerged` / `onUnmerged` for M3-02 |
| M1-10 | Shipped. `attachments` hangs off the ticket and, once sent, off `ticket_messages.id`; `POST …/messages` takes `attachmentIds` and every message carries its `attachments` ([guide](attachments.md)) |
| M1-11 | Spam semantics on the seeded Spam status, and the sender block list |
| M1-15 | The rest of the admin UI, as each deliverable above lands — including the tag picker and the custom field editors in the details panel |
| M2 | Inbound and outbound email on the same `ticket_messages`, keyed by `external_message_id` |
| M3 | Macros, which set a status, a priority, an assignee **and tags** in one action, and rules whose conditions read custom field keys |
| M3-02 | The SLA engine, filling `first_response_due_at`, `resolution_due_at` and `sla_breached` |
| M7 | AI that suggests tags, a priority and a department for a ticket |
| M5 | Per-locale search configuration; `tickets.search` uses `english` for every brand today |
