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

### 2.2 Transitions

| Current state | Event | Result |
|---|---|---|
| any open-like (`open`, `on_hold`, `escalated`) | Customer public reply | `open` (status = brand's default open status). Clears `awaiting_customer`. |
| `open` | Agent public reply, toggle on | Awaiting customer |
| any | Agent sets status | That status. Activity log records actor. |
| any open-like | Agent closes | `closed`, `closed_at` set, resolution clock stops, CSAT scheduled (if enabled, not spam, not merged) |
| `closed` | Customer reply | Governed by reopen policy, §2.3 |
| `closed` | Agent reopens | `open`; new response clock and resolution clock start from reopen time (§3.5) |
| any | Marked spam | Spam status; no auto-responder, no CSAT, sender added to block list if the agent ticks "block sender", excluded from reports and round-robin counts |
| any | Merged into another ticket | `closed` with `merged_into_id`; see §2.4 |
| any | Soft-deleted by Admin | Hidden from all views; purged by retention (§11) |

Time-based rules and workflow actions use the same transitions and are logged with actor `rule:<id>`.

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

While the ticket is in a status with `pauses_sla`, clocks do not advance. On resume, `due_at` is recomputed as `now + remaining`, where `remaining = target − elapsed_in_business_hours`. Pauses are recorded so reports can show "time waiting on customer" separately.

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

### 3.5 Reopen

On reopen (by policy or by agent), the first-response clock is replaced by a **next-response clock** with the same target, starting at reopen time. The resolution clock restarts from reopen time with the full target. The original satisfied/breached values are preserved for reporting under "initial response". Compliance reports use the initial clocks unless the brand chooses "count reopens".

### 3.6 Worked examples

Policy: High priority, first response 2 h, resolution 8 h. Business hours 09:00–17:00 Sunday–Thursday, Asia/Riyadh.

1. Ticket created Thursday 16:00. First response due Sunday 10:00 (1 h Thursday + 1 h Sunday). Agent replies Sunday 09:30 → satisfied, 1.5 h elapsed.
2. Same ticket moved to Awaiting customer at Sunday 09:30 (agent reply, toggle on). Resolution clock: elapsed 1.5 h, remaining 6.5 h, paused. Customer replies Tuesday 12:00 → resumes, due Wednesday 10:30 (5 h Tuesday + 1.5 h Wednesday).
3. Priority raised to Urgent (resolution 4 h) Tuesday 13:00. Elapsed = 1.5 h + 1 h = 2.5 h. Remaining = 4 − 2.5 = 1.5 h. New due Tuesday 14:30.
4. Ticket closed Tuesday 14:00 → satisfied. Customer replies the following Monday (6 days later, policy `within_days: 7`) → reopened. Next-response clock due 2 business hours after the reply; resolution due 8 business hours after the reply. Initial clocks remain "met" in reports.

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
- Consumers are idempotent by natural key: email send keyed by `ticket_message_id` (and the SMTP `Message-ID` is deterministic from it), Telegram and Meta sends keyed by `ticket_message_id`, the Meta media fetch by the attachment id, webhook delivery keyed by `(webhook_id, event_id)`, indexing keyed by `(source_id, content_hash)`. A `job_receipts(key, completed_at)` table backs consumers that have no natural key.
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
- **Redis**: named volume `redis_data:/data` with AOF. Losing Redis logs everyone out, drops rate-limit counters, and loses queued jobs; the outbox relay republishes anything unpublished, `sla.rebuild` recreates timers, and repeatable pollers are re-registered on worker boot. Nothing durable lives only in Redis.

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
| Activate | Sets password or OAuth link; TOTP enrolment forced if install requires 2FA, and always for an Admin or install admin (ASVS 4.3.1) |
| Role or department change | Refresh token family revoked so the next access token carries new claims (≤ 10 min lag); sockets disconnected (§1.4); tickets they can no longer see are unassigned per department setting `on_unassign: round_robin \| leave_unassigned` |
| Deactivate | Sessions and API keys they created revoked, sockets disconnected, removed from round-robin and presence, open tickets handled per `on_unassign`, notifications stop. Reversible. |
| Delete | Only after deactivation; personal data replaced, content kept as "Former staff" |
| Removal from one brand | Same as deactivation scoped to that brand |

Presence (`online`, `away`, `offline`) is derived from `/staff` socket connections and an explicit toggle. Auto-unassign on offline (R §4.1) runs after 15 minutes offline, configurable per department, and never during business hours closed periods.

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

## 16. Change log

| Date | Change |
|---|---|
| 2026-09-16 | Initial version, written to close the review findings on PRD 1.0. |
| 2026-09-27 | §3.4: the timer key is spelled with dots, as BullMQ requires (M3-02). |
| 2026-10-11 | The Meta channels (M10, [ADR 0025](../decisions/0025-meta-channels-through-one-graph-adapter.md)): §2.5 and the new §2.6 reply-window rule; §4.4's three scoped ids and the first verified phone, a WhatsApp `wa_id`; the new §4.7 identities and §4.8 message kinds; §6's keys; §11's delivery logs and erasure; §13's Graph client. |
| 2026-10-18 | §7: imported tickets join the widget queue only when their customer continues them live (M11-17). |
