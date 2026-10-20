# M14 Inbox productivity

Status: in development since 2026-10-20 (issues #288 to #316, GitHub milestone “M14 Inbox productivity”)
Owner: @Docker-Hunterpedia
Phase: 5 — 1.x. Proposed release: 1.1 (owner decision D-01)
Depends on: M1 (tickets, views, assignment, presence), M3 (SLA engine, rules and their test run, macros, notifications), M4 (widget agent name), M5 (help center search), M7 (AI triage, for the routing trail only), M8 (webhooks, OpenAPI), M11 (imported tickets, which every new path must leave alone)
Effort: about 103.5 working days for one person (see [Deliverables](#deliverables))
PRD: [Phase 5 · M14](../planning/PRD.md#m14-inbox-productivity)
Owner decisions: D-19 to D-32 in [decisions-1-x.md](../planning/decisions-1-x.md#m14-inbox-productivity)
ADRs (proposed): [0035](../decisions/0035-snooze-as-a-system-status.md), [0036](../decisions/0036-bulk-changes-previewed-all-or-nothing-with-undo.md), [0037](../decisions/0037-paced-notification-email-and-digests.md), [0038](../decisions/0038-keyboard-registry-and-command-palette.md)

Snooze, bulk edit with undo, a keyboard registry and command palette, a routing explainer, paced notification email, a profile for customers, a setup checklist, and the agent-workspace fixes from the [1.0 UX review](../completed/ux-review-1-0.md#findings) (group B).

## Goal

An agent who lives in Helpdock for eight hours a day should be able to work the
queue at the speed of their hands: put a ticket away until it matters again,
change thirty tickets in one step and take it back, reach any ticket, contact,
article or setting from the keyboard, see why a ticket landed where it did, and
be told about their work without being buried in email. The ticket workspace
should leave the conversation room to breathe on a 1280 px laptop, and work on a
tablet. An admin setting up a new brand should see what is left to do, ticked
off as they do it.

None of this changes what Helpdock is. Every feature here goes through the same
service paths, row-level security, outbox and activity log that a single click
does today; nothing here gives the AI a new power.

Snooze, bulk edit, a command palette and a shortcut sheet are the agent
ergonomics other helpdesks ship and agents notice daily; the
[UX review](../completed/ux-review-1-0.md#findings) of 1.0 found the same gaps
(UX-09, UX-10, UX-26) and the workspace density problems this milestone also
fixes (UX-01, UX-07, UX-08, UX-11, UX-13). This milestone builds them the
Helpdock way: departments and RLS first, Arabic and RTL as first-class, nothing
hidden from the activity log.

## Scope

In scope:

1. **Snooze** with presets that follow the ticket department's business hours,
   a wake timer through the outbox, and waking on a customer reply, an SLA
   warning or any status change.
2. **Bulk edit**: select with `x`, `Shift`+`x` or Shift-click, a bulk bar, up to
   50 tickets per request in one transaction, per-ticket authorization, a
   preview before anything is written, and Undo.
3. **Keyboard**: one shortcut registry, a `?` sheet, `g`-then-letter
   navigation, ticket shortcuts, `⌘`/`Ctrl`+`Enter` to send, a switch that turns
   single-key shortcuts off (WCAG 2.1.4), and shortcuts that work on an Arabic
   keyboard layout.
4. **Command palette** (`⌘K` / `Ctrl+K`): tickets (an exact number first),
   contacts, articles, pages and settings, and actions.
5. **Routing explainer** ("How it got here" on every ticket) and a **Test
   routing** dry run.
6. **Notification pacing**: right-away emails that batch and back off, hourly
   and daily digests, pause, one-click unsubscribe, a read re-check before every
   send, nothing emailed while the person is active in the app.
7. **Profile for customers**: public name, job title, phone and photo, usable as
   placeholders in signatures, macros and canned responses.
8. **Setup checklist** that ticks itself, for Admins.
9. **Saved-reply and macro polish**: `/shortcut` insertion, `/` anywhere,
   `{{` placeholder picker in the composer, placeholder fallbacks, save-time
   checks, most-used first.
10. **Inbox ergonomics**: empty states with keyboard hints, sort by SLA due, an
    `@` mention picker, fields required to close, idle agents marked away, and
    custom-field filters in the list and views (which is how this plan answers
    Severity, below).
11. **Workspace density and structure** (UX review group B): a compact composer
    and workspace breakpoints, the ticket row and details panel to spec, one
    Settings area with grouped sub-navigation, list-first tickets on narrow
    screens, and skeletons and empty states beyond those 1.0.1 adds.
12. **Gaps from the prior-art sweep** of 2026-10-20 (the full check is in
    [decisions-1-x.md](../planning/decisions-1-x.md#prior-art-gap-check)):
    notification sounds, mailbox-aware views and rules, more custom field
    types, more webhook events, and two report breakdowns.

Non-goals (out of scope for M14):

- **Severity as a first-class field.** See [Severity: recommendation](#severity-recommendation).
- **AI in the palette.** The palette has no AI of its own: its actions are a
  person's actions only, taken from the shortcut registry. The one hook is
  M12-13's: Tab in the palette hands the typed text to the read-only staff
  assistant panel as a new question (owner decision D-03). An assistant that
  proposes ticket changes is M13.
- **Bulk reply, bulk merge, bulk delete and bulk macros with a reply.** Fifty
  customer emails or fifty irreversible deletes from one click is a blast
  radius bulk edit should not have. Action-only macros in bulk are an open
  question (D-23).
- **Selecting "all N matching tickets"** beyond the 50-ticket cap.
- **Telegram notifications to agents** (PRD §5 backlog), native desktop or
  mobile apps, desktop badges.
- **Scheduled reports** (PRD §5 backlog). A notification digest is not a report.
- **Gravatar and company-logo lookups.** They send a hash of every contact's
  email to a third party and fetch user-derived URLs; Helpdock does not do that
  by default. Agent photos are uploaded (M14-12).
- **Label groups, exclusive "one at a time" tag groups, tag merge and archive,
  ownership transfer.** Worth having, but they are ticketing-settings and
  install work, not inbox productivity. Sample data in report empty states is
  M15-11 (the sample brand) and M19-08 (the Reports empty state linking to it).
- **Team-private tickets.** Helpdock's departments already are the privacy
  boundary, enforced in the database.
- **Phone layouts below 600 px.** M14-22 makes the ticket workspace list-first
  below 1024 px; the phone agent layouts are M17-07, which builds on it.

## What exists today

Checked in the code on 2026-10-20 (main at `1d52518`), so this plan extends
rather than duplicates.

| Area | What exists | Gap this plan closes |
|---|---|---|
| Keyboard | `apps/admin/src/screens/tickets/keyboard.ts`: `j`, `k`, `r`, `n`, `Esc` in the ticket workspace, skipped while typing or with a modifier | No `?` sheet, no navigation keys, no `⌘K`, no send shortcut in the composer. **Two defects:** the letters are matched on `event.key`, so on an Arabic keyboard layout `j` arrives as `ت` and no shortcut works; and there is no way to turn single-key shortcuts off, which WCAG 2.1.4 (Level A) requires. Neither is in [the accessibility audit](../completed/accessibility-audit.md) |
| Selection | DESIGN §6.3 `TicketRow` already draws a checkbox | `ticket-row.tsx` has none; there is no bulk endpoint |
| Snooze | Nothing in apps, packages or docs | All of M14-02 |
| Search | `GET /tickets?q=` with an exact-number path (`HD-1042`, `#1042`, `1042`, imported originals) that wins past the view's filters ([ADR 0011](../decisions/0011-ticket-search-token-table.md), #221); `GET /contacts`; help-center structure | No staff article search, no single quick-search read, no palette |
| Rules | M3-05 test run on `TicketFacts` (`apps/api/src/rules/test-run.ts`): nothing changed, sent or logged; follow-on rules one level deep. Execution log | No synthetic ticket, so no routing dry run; no per-ticket "how it got here" |
| Routing | Mailbox, Telegram bot, Meta account and web form each name a department; the widget files into the brand's **first** department (`widget.repository.ts` `firstDepartment`), a form without one likewise (`web-form.repository.ts` `firstDepartmentId`); rules, AI triage and the rotation move it on, each writing activity | Arrival is not recorded as a fact, so the path cannot be explained without reading several tables |
| Notifications | M3-07: bell, matrix of kind × channel (`notification_prefs`, global per person), one email per notification from the system sender, web push | No batching, digest, pause or unsubscribe; no read re-check at send time; no mention picker (the guide says so) |
| Profile | `users.name`, `users.locale`, `signature_en`/`signature_ar` (six plain lines, no placeholders); placeholders `{{agent.first_name}}` only | No public name, title, phone, photo or time zone |
| Macros | Personal / department / shared, `en`/`ar`, `/` in an **empty** reply opens the picker, staged actions, `last_used_at` column | No shortcut keyword, no `/` mid-text, no fallback values, no usage ordering |
| Fields | `custom_field_defs.required`, enforced at **creation only** | Nothing required to close; no custom-field filter in the list or views |
| Presence | Online / away / offline from sockets plus an explicit toggle | No idle detection: a tab left open all day is "online" and keeps receiving the rotation's tickets |
| Lists | Sort by updated, created, number, priority; Overdue view; `SlaTimer` on the row | No sort by SLA due |
| Onboarding | First-run wizard (M0-08, M7-10); "Activation" product metric (D §15) on the System page | No checklist after the wizard |
| Workspace layout | Four columns 220 · 360 · flexible · 300; the details drawer breakpoint at 1280 px (`DETAILS_BREAKPOINT` in `tickets-page.tsx`); the email composer always expanded (From, To, Cc, 5-row textarea, signature, two toolbar rows) | At 1280 × 720 almost none of the thread is visible (UX-01); the row truncates titles and lacks the assignee avatar (UX-07); the details panel puts Participants above the triage fields (UX-08) |
| Admin navigation | 9 Admin sidebar entries; Ticketing has 12 tabs in a scrollable row; "Settings" holds only Authentication and SSO | The Admin group falls below the fold at 720 px tall and settings are hard to find (UX-11) |
| Narrow screens | Below 1024 px (`LIST_BREAKPOINT`) the list moves into a drawer and the main area shows "Show the ticket list" over "No ticket open" | The first tap on a tablet is wasted on every visit (UX-13) |

## Severity: recommendation

**Recommendation: do not add Severity as a field of its own** (owner decision
D-21). Close the gap it points at instead, with M14-16.

Some helpdesks carry Sev 1–4 beside priority so that their triage AI and rules
have a "business impact" value. Helpdock already has:

- four priorities with editable labels, which the SLA engine targets (D §3);
- custom select fields on tickets, which rules can already test (`is`, `is not`,
  `is set`), which the API returns, and which an import can fill;
- escalation steps that raise priority, set a tag or move the ticket.

What a team that wants severity cannot do today is **filter the list by a
custom field, save that as a view, or see the value on the row**. That gap is
not severity's alone: "Region", "Plan", "Product area" have it too. M14-16
therefore adds custom-field filters to the list and views, and lets a brand pin
one select field as a chip on the row and in the details header. The guide then
carries a recipe: a select field named Severity with Sev 1–Sev 4, pinned, a
"Sev 1 open" view, and a rule "When ticket updated, if Severity is Sev 1, set
priority Urgent and notify the on-call team".

A first-class Severity would cost a column, an enum, an SLA question (does it
target clocks or not?), report dimensions, importer mappings, API and webhook
fields, rule operators and a second badge with a second hue meaning, which
DESIGN §1 ("a hue never carries two meanings") argues against. Not worth it
until a user asks for something the recipe cannot do. AI triage choosing a
custom field value is left out for the same reason (gap below).

## Deliverables

Estimates are working days for one experienced contributor, Definition of done
included (unit, integration, Playwright `en`/`ar`, docs). Artboard work is the
orchestrating session's and is not counted. The UX review sized M14-19 to
M14-23 as S, M or L; they are converted here as S ≤ 1 d, S–M 2 d, M 3 d and
L 6 d.

| Id | Deliverable | Effort | Depends on |
|---|---|---|---|
| M14-01 | Keyboard foundation: shortcut registry, physical keys, `g` sequences, `?` sheet, ticket and list shortcuts, send shortcut, single-key switch | 4.5 d | — |
| M14-02 | Snooze: Snoozed status, presets, wake timer, wake paths, SLA rule, Snoozed view | 6 d | M14-01 (for `h`) |
| M14-03 | Bulk edit API: preview and apply, per-ticket authorization, one transaction, operation log, Undo | 6 d | M14-02 (snooze as a bulk change) |
| M14-04 | Bulk edit UI: checkboxes, `x` / `Shift`+`x` / Shift-click, bulk bar, preview dialog, Undo toast | 4 d | M14-01, M14-03 |
| M14-05 | Command palette: quick-search read, page and settings registry, actions, recents | 6 d | M14-01 |
| M14-06 | Inbox empty states with keyboard hints, and the `Kbd` component | 1.5 d | M14-01 |
| M14-07 | Sort by SLA due — implemented, pending review (#294) | 1.5 d | — |
| M14-08 | Routing trail: arrival recorded on every creation path, "How it got here" on the ticket | 4 d | — |
| M14-09 | Routing page and Test routing dry run | 6 d | M14-08 |
| M14-10 | Notification pacing engine: batching with back-off, digests, pause, read re-check, presence hold | 8 d | — |
| M14-11 | Notification settings and one-click unsubscribe | 4 d | M14-10 |
| M14-12 | Profile for customers: public name, title, phone, photo, time zone; agent placeholders | 5 d | — |
| M14-13 | Setup checklist | 3 d | M14-12 (one step reads it) |
| M14-14 | Saved-reply and macro polish | 3 d | M14-12 (placeholders) |
| M14-15 | `@` mention picker in notes | 2 d | — |
| M14-16 | Custom-field filters in the list and views, pinned field chip (the Severity answer) | 3 d | — |
| M14-17 | Fields required to close | 2.5 d | M14-03 (bulk refusals) |
| M14-18 | Idle agents marked away | 2 d | — |
| M14-19 | Compact composer and workspace breakpoints (UX-01, UX-21) | 3 d (M) | — |
| M14-20 | Ticket row and details panel density (UX-07, UX-08) | 2 d (S–M) | M14-04 (the row's checkbox) |
| M14-21 | Settings area with grouped sub-navigation (UX-11) | 6 d (L) | M14-05 (the palette registry walks `route-paths.ts`) |
| M14-22 | List-first tickets on narrow screens (UX-13) | 3 d (M) | M14-19 |
| M14-23 | Skeletons and empty states beyond 1.0.1 (UX-10c, UX-12) | 2 d (S–M) | M14-06 |
| M14-24 | Docs, ADRs, DESIGN.md and DOMAIN-RULES updates, OpenAPI, PRD | 3 d | all |
| M14-25 | Notification sounds per event, with a reminder while a live chat waits | 2 d | M14-11 (the settings page) |
| M14-26 | Mailbox-aware views and rules: filter by mailbox and by the address written to; rule conditions on both; rule actions "set reply address" and "mark as spam" | 3 d | M14-08 (arrival records the mailbox and address) |
| M14-27 | More custom field types: long text, link, email, person | 2.5 d | M14-16 (their filters) |
| M14-28 | More webhook events for tickets, messages, contacts and accounts | 3 d | M14-03 (bulk changes emit them per ticket) |
| M14-29 | Reports: volume by tag, and the current backlog by status with its unassigned share | 2 d | — |

Total: about **103.5 working days** for one person (about 21 weeks): 75 days
for M14-01 to M14-18 and M14-24, 16 for the UX additions M14-19 to M14-23, and
12.5 for the prior-art gaps M14-25 to M14-29.
Five tracks are independent after M14-01 (snooze and bulk; palette and empty
states; routing; notifications and profile; workspace layout), so two people
bring the calendar to roughly 9–10 weeks. If the owner trims, the cheapest cut
that keeps the milestone's point is M14-16, M14-17 and M14-18 (7.5 d), then
M14-13 (3 d). If only one UX item can be taken, take M14-19: it changes the
screen agents use most.

### M14-01 Keyboard foundation

**Status: built, in review** (issue #288). Built as below, with these
differences: letters follow the character a Latin layout types and fall back
to `event.code` only on a layout that types no Latin letter, which is what
1.0's keys already did since #244 (so the Arabic layout needed no failing test
first, and Dvorak and AZERTY users press the key engraved with the letter);
`Enter` on a row, `x`, `Shift`+`x`, `Esc` to clear a selection, `h` and `⌘K`
wait for the deliverables that build what they act on (M14-04, M14-02,
M14-05); `g` `n` is left out, because notifications have no page of their own;
the sheet shows the Latin letter only, as the artboard does; the switch also
travels in the session (`user.singleKeyShortcuts`), so no letter is taken
before it is known, and lives in the sheet's footer until M14-12's Profile
tab, with the sheet also in the account menu so a person who turned `?` off
can reach it; `Kbd` lands here
rather than in M14-06, because the sheet draws with it. Guide:
[Keyboard shortcuts](../guides/keyboard-shortcuts.md).

One registry (`apps/admin/src/keyboard/registry.ts`, new) names every shortcut
once: its id, keys, scope (global, list, ticket, composer), the i18n label, and
the permission it needs. The `?` sheet, the palette's action list, each button's
`aria-keyshortcuts` and the tooltips all read it, so the sheet cannot drift
from what the keys do; a unit test fails if a registered shortcut has no
handler or a handler has no entry. The `tickets:keyboard.label` and `.hint`
strings already in the catalog are used by the sheet (UX-09).

- **Physical keys.** Letters match on `event.code` (`KeyJ`), not `event.key`,
  so `j` works on an Arabic, French or Russian layout. `?` matches `?` and the
  Arabic `؟` (U+061F). A failing test for the Arabic layout comes first, per the
  bug-fix rule; the existing shortcuts move onto the registry.
- **Sequences.** `g` then a letter within 1.5 s: `g i` My open, `g u`
  Unassigned, `g o` Overdue, `g c` Contacts, `g k` Help center, `g r` Reports,
  `g s` Settings, `g n` Notifications. A caption "g …" shows while a sequence
  waits.
- **Global:** `⌘K`/`Ctrl+K` palette, `/` focus the list search, `c` new
  ticket, `?` the sheet, `b` toggle the sidebar.
- **List:** `j`/`k`, `Enter` open, `x` select (M14-04), `Shift`+`x` select
  range, `e` close the focused ticket, `h` snooze (M14-02), `Esc` clear
  selection.
- **Ticket:** `r` reply, `n` note, `a` assignee picker, `s` status, `p`
  priority, `t` tags, `m` macros, `h` snooze, `e` close, `⌘`/`Ctrl`+`Enter` send,
  `⌘`/`Ctrl`+`Shift`+`Enter` send and close. The last two work inside the
  composer, because they carry a modifier.
- **Single-key shortcuts switch** (`users.single_key_shortcuts`, default on),
  in the sheet's footer and on Your account. Off disables every shortcut
  without a modifier, including the existing ones, which satisfies WCAG 2.1.4.
  It is stored on the server because it is an accessibility setting and must
  follow the person to another browser.

### M14-02 Snooze

**Model.** Snooze is a **status**, not a hidden flag: every brand gets a seeded
system status **Snoozed** (system state `on_hold`, `is_system`, built-in key
`snoozed`), and the ticket carries `snoozed_until`, `snoozed_by`,
`snooze_resume_status_id` and `snooze_version`. Views, reports, rules,
webhooks and the importer all key on status, so a status makes snoozed tickets
countable, filterable and testable by rules with no new plumbing, and "wakes on
a customer reply" falls out of D §2.2, which already moves any open-like ticket
to open on a customer reply. The alternative is weighed in
[ADR 0035](../decisions/0035-snooze-as-a-system-status.md) (owner decision
D-20).

**Presets** in the Snooze menu (header button, `h`, palette, bulk bar): *In 1
hour*, *In 4 hours*, *Next business day* (the next opening of the ticket's
department calendar, else 09:00 tomorrow in the agent's time zone), *Next week*
(the first opening after the calendar's coming weekend, so Sunday in
Asia/Riyadh and Monday in Europe/Berlin), and *Pick a date and time*. Each item
says the absolute time ("Sunday 21 October, 09:00"); when the department's time
zone differs from the agent's, a caption gives both. The client sends an
instant; the server accepts 5 minutes to 90 days ahead.

**Waking.** A ticket wakes on whichever comes first:

| Trigger | Status after | Activity reason |
|---|---|---|
| `snoozed_until` reached | The status before the snooze, if it still exists and is open-like; else the brand's default open status | `time` |
| Customer public reply | Default open status (D §2.2, unchanged) | `customer_reply` |
| SLA warning or breach on a running response clock | The status before the snooze | `sla` |
| A person or rule sets any status, closes, merges or marks spam | That status | `status_changed` |
| *Wake now* on the ticket | The status before the snooze | `manual` |

Waking by time or SLA notifies the assignee, else the person who snoozed it,
with a new kind `snooze_ended` (in-app and push by default, email off).

**Timer.** `PATCH`ing a snooze writes `ticket.snoozed` to the outbox in the same
transaction; its consumer adds a BullMQ delayed job `ticket.unsnooze` with
`jobId = snooze.<ticketId>.<version>`. When it fires it locks the ticket and
does nothing unless the ticket is still Snoozed at that version and due.
`snooze.rebuild` runs on worker boot and hourly, as `sla.rebuild` does, and
wakes overdue snoozes at once. Redis loss loses no snooze.

**Lists.** The ticket list takes `snoozed=exclude|only|include`, default
`exclude`, so My open, Unassigned, Overdue and every saved view stop showing
snoozed tickets with no edit. An exact number or reference in `q` still finds a
snoozed ticket (#221's rule). A new built-in view **Snoozed** (`snoozed=only`,
assignee me) sits under My open. The row shows a `Clock` icon and the wake time
in place of the SLA timer; the ticket shows a `SnoozedStrip` with *Wake now*.

**Load and rotation.** Snoozed is `on_hold`, so it does not count against the
load cap and the offline timer does not unassign it, as for Awaiting customer
today.

**API.** `PATCH /tickets/:id` takes `snoozedUntil` (an instant, or `null` to
wake). Public API v1 returns `snoozedUntil` on tickets and accepts it on
`PATCH`; `ticket.updated` webhooks carry it. No new webhook event.

### M14-03 Bulk edit API

`POST /api/brands/:brandId/tickets/bulk` with `{ ticketIds (1–50, unique),
changes, mode: 'preview' | 'apply', expect? }`.

Changes allowed: status (not Snoozed directly; use snooze), close, priority,
assignee (a person, `me`, or nobody), team, department, tags to add and tags to
remove, snooze until / wake, mark spam (never "block sender" in bulk), and one
custom field value. Not allowed: replies, notes, macros with a reply, merge,
split, delete.

**Preview** reads each ticket under the caller's RLS and runs the same checks
the single-ticket path runs (`TicketsService` and the assignment, status,
department and tag rules), writing nothing, and answers per ticket:
`will_change` (with the fields), `unchanged`, `refused` (with the existing
refusal code: `not-eligible`, `assignee-above-actor`, `fields-required-to-close`
from M14-17, …) or `not_found`. A ticket in another department is `not_found`,
indistinguishable from one that does not exist, as everywhere else.

**Apply** takes `expect`, the ids the preview said would change, and runs in
**one transaction**. Each ticket goes through the very method a single edit
uses, so it writes the same activity rows (with `via: 'bulk'` and the
operation id), the same outbox events (`ticket.updated`, `ticket.assigned`,
`sla.schedule`, `assignment.requested`, `csat.requested`, webhooks) and fires
the same rules, one ticket at a time, in ticket-number order so locks are taken
in a fixed order. If any expected ticket is now refused or gone, the whole
apply rolls back with `bulk-changed` (409) and the client previews again.
All or nothing keeps "what you previewed is what happened" true (owner decision
D-22).

**Operation log and Undo.** Apply writes a `ticket_bulk_operations` row and
one `ticket_bulk_operation_items` row per changed ticket with the before and
after values (ids and enums only, never text). `POST
/tickets/bulk/:operationId/undo` within 60 s, by the same person, reverts each
field whose current value still equals what the operation set and leaves any
field someone changed since, reporting it. Undo is itself one transaction with
the same per-ticket checks, and writes activity `via: 'bulk_undo'`. It also
deletes the operation's notifications that nobody has read yet. What has already
left the install (a webhook, a push) is not recalled; the confirm copy says so.

**Surveys after a bulk close.** A close made by a bulk edit publishes its
`csat.requested` job with a 60 s delay; the consumer already skips a survey
whose close no longer stands, so an Undo inside the window sends none (owner
decision D-24).

**Notification folding.** Notifications carry `bulk_operation_id`; the bell and
the email batcher fold one actor's operation into one line ("Omar assigned you
12 tickets").

Limits: 50 tickets, 20 operations a minute per person. Permission
`ticket:write`, then per ticket. Not in the public API v1 (staff only; an API
client can loop with idempotency keys).

**M14-03 acceptance test:** A bulk status or assignee change emits one webhook event per changed ticket through the shared mutation paths, including Undo.

### M14-04 Bulk edit UI

The row checkbox DESIGN §6.3 already draws, labelled "Select HD-1042";
`x` toggles the focused row, `Shift`+`x` and Shift-click select the range from
the last toggled row; the header checkbox selects the loaded page (indeterminate
when partial), capped at 50 with a caption saying so. Selection survives `j`/`k`
and realtime refreshes, and clears on a view change or `Esc`.

The `BulkBar` replaces the list's footer while anything is selected:
"12 selected", then Status, Close, Assign, Team, Department, Tags, Priority,
Snooze, Field, More (Mark spam), and Clear. Each opens the same picker the
details panel uses. Choosing one runs a preview; if every ticket would change,
it applies at once; otherwise a dialog lists "10 will change, 2 cannot" with
each refusal in words and the ticket reference, and *Apply to 10*. After apply,
a toast "Closed 10 tickets · Undo" (DESIGN Toast, 10 s, paused on hover and
focus). *Undo last bulk change* also sits in the palette for the server's 60 s.

### M14-05 Command palette

`⌘K` / `Ctrl+K`, or the sidebar's Search (which already shows the `⌘K` hint per
DESIGN §6.1). A `role="dialog"` with an ARIA 1.2 combobox and a grouped
listbox:

- **Empty query:** recent tickets and pages, then suggested actions for the
  screen. Recents are stored client-side as ids only (no subjects in browser
  storage) and re-read through the API, so a ticket the person can no longer
  see drops out.
- **Typing:** *Tickets* (an exact reference or number first, "Open HD-1042"),
  *Contacts*, *Articles*, *Go to* (pages and every settings tab), *Actions*.
  "See all tickets matching …" opens the list with `q`.
- **Actions** are context-aware and come from the M14-01 registry: on a ticket,
  Assign to me, Snooze…, Close, Change priority, Copy link, Apply macro; anywhere,
  New ticket, Switch brand, Switch language, Theme, Keyboard shortcuts, Undo last
  bulk change. Each shows its key. Each is filtered by the person's permissions,
  so a Viewer sees only navigation.
- **The assistant hook** (owner decision D-03): when M12-13 has landed, Tab in
  the palette sends the typed text to the read-only staff assistant panel as a
  new question. It is one function, built by whichever of M12-13 and M14-05
  lands second. The palette itself calls no model.

Read: `GET /api/brands/:brandId/quick-search?q=&limit=5` answers `{ tickets,
contacts, articles }` in one request transaction under the caller's scope:
tickets through the list query's existing search and exact-number path
(ADR 0011); contacts through the contacts search (`contact:read`); articles
through `hc_search_documents` with the staff audience (published versions,
public and internal) plus draft titles for `help_center:manage`. Each section
is skipped, not failed, when the person lacks its permission. 150 ms debounce,
10 requests a second per person, 300 ms budget per section.

Pages and settings are a client registry with `en` and `ar` labels and keywords
in both languages ("SLA", "اتفاقية مستوى الخدمة", "business hours", "ساعات
العمل"). A unit test walks `apps/admin/src/app/route-paths.ts` and fails when a
route is neither in the registry nor explicitly excluded. Matching folds case,
Arabic alef and yaa forms, taa marbuta and diacritics, as the rules engine's
text matching does.

### M14-06 Inbox empty states with keyboard hints

**Status: built, in review** (issue #293). `Kbd` already landed with M14-01
(`apps/admin/src/ui/kbd.tsx`; `KeyCombo` draws a registry shortcut with it), so
this deliverable adds `ShortcutHints`
(`apps/admin/src/keyboard/shortcut-hints.tsx`: a list of hints read from the
registry, hidden while single-key shortcuts are off, per shortcut hidden when
the person lacks its permission, with "All shortcuts" a button that opens the
sheet) and a `hints` slot on `EmptyState`. Which words the list says is
`emptyKindOf` in `apps/admin/src/tickets/views.ts`: search, My open,
Unassigned, Overdue, a saved view or the desk with filters on (action *Edit
filters*), else "Nothing in this view" (Escalated and the department views,
whose filters are the view itself). The Snoozed words wait for M14-02, which
adds the view. Guide: [Keyboard shortcuts](../guides/keyboard-shortcuts.md).

Each built-in view gets its own empty state (DESIGN §6.3 EmptyState: icon, h3,
one sentence, one action) with one line of hints under it: "`c` New ticket ·
`g` `u` Unassigned · `?` All shortcuts". My open: "Nothing waiting on you".
Unassigned: "Every ticket has an owner". Overdue: "Nothing is past its SLA".
Snoozed: "Nothing snoozed". A view with filters: "No tickets match this view"
with *Clear search* when a search is active. Hints are hidden when single-key
shortcuts are off. Adds the `Kbd` component (DESIGN §6) used by the sheet,
palette, tooltips and these hints. Empty states outside the ticket views are
M14-23.

### M14-07 Sort by SLA due

Regression fix #353: the 360 px ticket-list header uses outlined square sm
Sort and Filter buttons with localized tooltips and accessible names (including
the active filter count), plus the NotificationBell count badge. Source filters
get removable chips in both languages. `Admin/Tickets-SortSla` and
`Admin/Tickets-Narrow` were redrawn under #353 (`AdminTicketsSortSla.dc.html`
and `AdminTicketsNarrow.dc.html`), replacing text Sort and Filter buttons so
New ticket fits at 360 px. Filter's badge uses a −6 px block-start and inline-end
offset with visible overhang, leaving the funnel clear. New ticket is text-only,
with no plus icon; the view title stays on one line. The `Admin/Tickets-SortSla`
menu and ordering are unchanged. The webhook endpoint test also derives its all-events count from `WEBHOOK_EVENTS.length`
after M14-28 expanded the event picker.

PR #354 follow-up: Sort and Filter tooltips are non-interactive and close when
the menu opens or the trigger loses focus. Menu-restored focus does not reopen
them over the changed-filters actions; leaving and returning by keyboard shows
them again. Regression checks cover both triggers and the en/ar header flow.

`sort=slaDue`: the nearest due time of the ticket's running, unpaused,
unsatisfied clocks, breached ones first by how long ago, then soonest due, then
tickets without a clock. A stored generated column `tickets.sla_next_due_at`
(least of the two due columns the SLA engine already maintains) with an index
`(brand_id, sla_next_due_at, id)`. Offered in the list's sort menu
and the view editor. The 50k-ticket p95 under D §14 is re-measured for this
sort.

Implementation (M14-07, #294): complete, pending PR review. The engine's
`summaryColumns` writes `first_response_due_at` and `resolution_due_at` only
for counting clocks; PostgreSQL generates `sla_next_due_at` with `least` of
those columns (one null leaves the other; both null produce null). The index
is `(brand_id, sla_next_due_at, id)`. The API, list Sort menu and
view editor accept `slaDue`. Urgency is always ascending, nulls last, with
ascending ticket ID ties, regardless of `direction` (including its default).
Nullable cursors cover both the transition into the no-clock tail and ties
within it. Existing RLS and exact-reference search precedence still apply.

Review-approved departure from the original index wording: the department RLS
predicate cannot be an index condition, so putting `department_id` before the
sort key prevents an ordered scan of the scoped list. The explicit brand
equality in `liveTicketsOf` lets `(brand_id, sla_next_due_at, id)` serve both
Admin and Agent lists, with department RLS filtering rows. The generated
column uses millisecond precision, matching the cursor timestamps. The
performance harness includes SLA due and SLA due page 2 for both roles.

Validation covers cursor encoding and predicates, saved-view schemas, clock
exclusion, generated values through real SLA transitions, department-scoped
ordering and pagination with ties, and the menu/list/view editor in `en` and
`ar`. The 50k-ticket p95 measurement in DOMAIN-RULES §14 was **not re-run
locally**; the performance gate remains to be measured on the constrained
reference host. No new configuration or ADR is needed.

### M14-08 Routing trail

Every creation path records **arrival** in the `ticket.created` activity
detail, through one helper (`arrivalOf`) so the six writers (tickets service,
email router, widget, web form, Telegram router, Meta router) cannot drift:
`{ entry: mailbox | widget | web_form | telegram_bot | meta_account | api_key |
staff | import, entryId, address?, departmentId, reason }`, where `reason` is
`entry_department`, `brand_first_department` (the widget, or a form without
one), `named_by_api`, `chosen_by_staff` or `continued_from` (a reopen-policy
continuation, D §2.3).

`GET /tickets/:id/routing` composes the trail from that row and the activity
that follows it until the first change by a person: department, team and
assignee changes with their actor, in words: "Arrived at support@acme.com →
Support (the mailbox's department) · Moved to Billing by rule *Invoices to
Billing* · Priority raised by AI triage · Assigned to Lina by round-robin".
A rule deleted since reads "a rule since deleted". The card is "How it got
here" in the details panel, collapsed by default. Tickets created before M14
show "Arrived on <channel>" and the activity that exists. Imported tickets
show "Imported from Zendesk" and nothing else (M11 sends and runs nothing).

No new table: the activity log is the source of truth, and the trail is read
under the ticket's own department policy.

**Status: done** ([#295](https://github.com/Docker-Hunterpedia/Helpdock/issues/295)).
- [x] `arrivalOf` (`apps/api/src/tickets/routing/arrival.ts`) used by the six
  writers, by a split, by a reopen-policy continuation (on its
  `ticket.continued` row, recording where the customer's reply came in) and
  by the importer (on `ticket.imported`). An email's `address` is the
  mailbox address when present among recipients; otherwise the delivery
  header (`Delivered-To`, or `X-Original-To` when absent) if nonempty and
  at most 320 characters, falling back to the mailbox address. This avoids
  recording a third party's To/Cc address for Bcc mail.
- [x] `GET /tickets/:id/routing` and its Zod schema (`ticketRoutingSchema`).
- [x] The "How it got here" card (`RoutingTrail`, DESIGN §6.3).
- [x] DOMAIN-RULES §2.8; `tickets.md`.
- Two reasons beyond the list above, because two paths fit none of them:
  `referenced_ticket` (an email naming a ticket its sender may not reply on,
  filed in that ticket's department, D §4.3) and `import_mapping` (an import).
  `entryId` is null for the widget and the web form, which have no id of
  their own until M19-02. AI triage's applied changes are now written with
  `via = ai` (still as `rule:<id>`), which is how the trail tells them apart.

### M14-09 Routing page and Test routing

A **Routing** tab under Admin › Automation (`ticketing:manage`) that explains
the pipeline as four numbered steps with links: 1 Arrival (each entry point and
its department, the widget's "first department" made visible), 2 Rules on
*Ticket created*, in order, 3 AI triage, if a rule queues it, 4 Assignment by
department mode.

**Test routing** takes a sample: channel and entry point, from address or
name, subject, message and language. It builds synthetic `TicketFacts` and
walks the real code with writes disabled:

1. entry point → department, and whether the sender is on the block list (the
   ticket would be Spam) or an auto-generated sender (no ticket at all);
2. the contact a lookup would match, by name only, or "a new contact";
3. each enabled *Ticket created* rule in order, using M3-05's evaluator: each
   condition with what it found, what each action would do, applied to the
   facts so later rules see earlier changes, and follow-on rules one level on;
4. AI triage: "would be queued", never called;
5. the SLA policy that would apply and the first-response due time;
6. the department's mode and who the rotation would pick **now**, read with no
   advisory lock and no "last picked" update.

"Nothing is created, sent or logged; no rule's counters move; the rotation's
turn does not move." The result is a live region in the existing
`TestRunPanel` anatomy.

The widget always files into the brand's first department. Whether to add a
per-brand widget department setting here (about 1 d) is owner decision D-29;
M19-02 (several widgets per brand) gives each widget a department default in
any case.

### M14-10 Notification pacing engine

**Status: built, in review** (issue #297). Built as below, with
[ADR 0037](../decisions/0037-paced-notification-email-and-digests.md) accepted
and [DOMAIN-RULES §20](../planning/DOMAIN-RULES.md#20-notification-delivery)
written, and these differences: the schedule's Right away value is
`immediate`, as the batch kind is; batches also keep `urgent`, `held_since`
and `seen_online_at`, and pacing `last_urgent_at`, which the urgent interval
and a resumable presence hold need; the hold's "away for 5 minutes" is
measured from the last time the send found the person online, re-checked every
minute; `bulk_operation_id` is left to M14-03, and the folding already groups
by it; the daily digest's hour is read in the brand's time zone until M14-12
adds `users.time_zone`; opening a ticket (`GET /tickets/:id` by a person)
marks their notifications about it read; an install without SMTP marks rows
`skipped_unconfigured` at scheduling rather than opening batches; the English
catalog says
"replied 2 times" where the artboard says "twice" (English has no dual plural
form; Arabic uses its own). For M14-11, `GET`/`PUT /api/me/notification-preferences`
already carry the schedule, digest hour and pause (`emailDelivery`); the test
email, the unsubscribe link and the `List-Unsubscribe` headers are left to it.
Guide: [Notifications › Email](../guides/notifications.md#email).

Email only; the bell is always immediate and push stays immediate (both obey
pause). A person chooses an **email schedule**:

| Schedule | Behaviour |
|---|---|
| Right away (default) | One email a short wait after the first notification, gathering what arrives meanwhile. While more keeps coming, the waits grow. |
| Hourly digest | At the top of the hour, what is still unread |
| Daily digest | Once a day at the hour chosen, in the person's time zone |
| Off | No notification emails |

Defaults for *Right away*, each an install setting (`notify.email.*`, with
`HD_NOTIFY_EMAIL_*` overrides): first wait 2 min; back-off 10, 20, 40, 60 min
while more arrives; back to 2 min after 2 quiet hours; **urgent** kinds
(mention, SLA breach, escalation) may cut the wait, no more often than every
5 min and 8 times a day; caps 6 an hour and 40 a day, digests included.
Prior art uses a 5-minute first wait and caps of 4 an hour and 24 a day; a
self-hosted desk sets its own.

**Re-checked at send time**, inside the batch job, for every row: unread;
the ticket still exists and the recipient's department scope still covers it
(the same check `apps/api/src/notifications/recipients.ts` makes at fan-out);
the recipient is active and still holds a role in the brand; not paused, not
unsubscribed, schedule not Off; the row's own `email` flag. A row that fails is
marked `skipped_*` and never sent later. Opening a ticket marks its
notifications read, so they drop out.

**Presence hold.** While the recipient is online (not away) in the brand, a
right-away email waits until they have been away or offline for 5 minutes,
or for at most 15 minutes, whichever is first; what they read meanwhile drops
out. Without the cap a tab left open all day would mean no email ever (owner
decision D-27).

**Pause** (1 hour, until tomorrow 09:00 in the person's time zone, 1 week, or
until a date) holds email and push; rows created during a pause are marked
`skipped_paused` and stay in the bell. Nothing is sent later.

**Digests are per brand.** D §1.4 runs a worker job inside one brand; a
cross-brand digest would need an audited all-brands system path for a
convenience. A person in three brands gets up to three digests; the subject
names the brand (owner decision D-26).

**Email content** keeps M3-07's rule (references, subject, who did what, a
link; no message bodies) and groups: one notification is its own email; several
are "Since 14:52: 4 assigned, 2 replies", then *Needs you now* (mentions,
breaches, escalations), then *Tickets*, folded per ticket ("Dana replied twice")
and per bulk operation. `en` and `ar`, by the recipient's language, RTL for
Arabic.

**Jobs**, on the existing `notify` queue: `notify.email_schedule` (on
`notification.created` with email on: find or open the person's pending batch,
compute its send time from the pacing state, add a delayed
`notify.email_batch` with `jobId = notify.batch.<batchId>`);
`notify.email_batch` (the re-check, render, send, mark; idempotent through
`job_receipts` and a deterministic `Message-ID` from the batch id);
`notify.digest.tick` (hourly cron, one child job per brand, D §1.4);
`notify.email_rebuild` (boot and hourly: recreate batch jobs for pending rows).
The current per-notification `notify.email` job hands off recent (at most 24
hours), email-enabled legacy rows without a transactional send receipt; the
schedule path does the same for delayed `notification.created` events. Other
legacy rows are dropped with a log. Send/render failures count only on a job's
last attempt, once per exhausted job across hourly rebuilds; database and other
infrastructure errors do not count. Five exhausted send jobs terminally mark a
batch `failed` and its rows `skipped_failed`,
freeing the pending slot and logging once at warn. Rebuild locks people in
user-id order, matching digest ticks. Ticket-read bell invalidation uses a
dedicated `notification:read` realtime event; `notification:created` remains
reserved for new notifications, including future new-notification sounds (M14-25).

The daily repeat guard uses the represented tick hour. A daily digest over a
cap at its tick waits for the next day; a missed cron hour skips that day.
Ticks run at UTC hour boundaries: in half-hour or quarter-hour zones, the
chosen hour sends at the tick within that local hour (08:30 in Asia/Kolkata
for hour 08). Updating the schedule alone preserves the stored preference
matrix, including missing keys that follow defaults.

An urgent cut that commits while the batch job is running cannot move that
job. After the job moves itself to the committed time it reads the batch's due
time again and pulls itself earlier if a cut landed meanwhile, so the urgent
email does not wait for the hourly rebuild.

M12-09's AI notification kinds (`ai_budget`, `ai_provider`, `ai_handoff`) are
rows in the same preference matrix and follow these pacing rules.

### M14-11 Notification settings and unsubscribe

Your account › Notifications gains, above the existing `PreferenceMatrix`:
the schedule as `RadioCard`s with the digest hour, the person's time zone (from
M14-12), *Pause* with its menu and the time it ends, *Send me a test email*,
and a status line when something stops emails ("Paused until 17:00 · Resume",
"You unsubscribed on 3 October · Turn email back on", "Email is off"). The
same line heads the bell's panel. Distinguish missing install SMTP
(`skipped_unconfigured`) from a person's Off choice (`skipped_off`); show
that email is not configured on this install when applicable. Urgent kinds
carry an "Urgent" caption in the matrix.

**One-click unsubscribe.** Every notification email carries
`List-Unsubscribe` (an HTTPS link with a token) and `List-Unsubscribe-Post:
List-Unsubscribe=One-Click` (RFC 8058). A mail client's POST unsubscribes at
once; a person's click (a GET) opens a confirmation page, so a link scanner
that follows URLs unsubscribes nobody. The page is a public route in the admin
bundle, as the CSAT page is
([ADR 0010](../decisions/0010-csat-page-in-the-admin-bundle.md)), in the token's
language. The token is an HMAC (key derived from `APP_MASTER_KEY` with HKDF,
purpose `notify-unsubscribe`) over the user id and issue date, valid one year;
the action is idempotent, rate-limited and audited as
`notification.email_unsubscribed`. Unsubscribing sets
`email_unsubscribed_at` and leaves the matrix as it was, so *Turn email back
on* restores the same choices. Preferences are global per person (M3-07), so
unsubscribing stops notification emails from every brand; the page says so.

### M14-12 Profile for customers

A **Profile** tab first on Your account (`/me/profile`): name (existing),
**public name** (what customers see, defaulting to the first name: some teams
use an alias), **job title** in English and Arabic, **phone** (normalised as
contacts' are, [ADR 0008](../decisions/0008-phone-normalisation.md)), **photo**,
and **time zone** (IANA; defaults to the browser's on first visit, used by
snooze presets and digests). The single-key shortcuts switch sits here under
"Working in Helpdock".

The photo is uploaded through the M1-10 pipeline (magic-byte sniff, sharp
re-encode to WebP, EXIF stripped, 256 and 64 px variants), stored under the
install prefix, served by presigned URL. Shown in the admin's `Avatar`, in
the widget's agent header (M4-08) and optionally in email signatures. No
Gravatar. Whether the photo is in M14 at all is owner decision D-28 (2 of the
5 days). M19-03's team faces on the widget home show the photos of staff who
opt in here.

**Placeholders.** The allow-list (`packages/schemas/src/placeholders.ts`) gains
`{{agent.name}}` (public name), `{{agent.full_name}}`, `{{agent.title}}` (in
the reply's language, falling back to English), `{{agent.phone}}`,
`{{department.name}}`, plus M14-14's fallbacks. **Signatures accept
placeholders** (still six lines, still plain text), so one brand-wide
instruction "sign with `{{agent.name}}`, `{{agent.title}}`" works for every
agent. For a rule's canned reply the agent is the assignee, as today. Customer
surfaces (email, widget, Telegram, Meta) show the public name instead of the
full name from M14 on.

### M14-13 Setup checklist

For Admins of a brand (`brand:manage`), a "Get set up 3 of 9" entry at the foot
of the sidebar opening a panel of steps, each with one line of why and a link
to where it is done (UX-10b). Each step is **computed on read** from real state,
never stored as ticked:

1. Connect a channel (a mailbox, Telegram bot, Meta account or widget origin)
2. Invite a teammate
3. Set business hours
4. Create an SLA policy
5. Set up assignment (any department not Manual)
6. Add a canned response or macro
7. Publish a help center article
8. Connect an AI provider (marked optional)
9. Receive your first ticket from a customer (D §15's activation, any
   non-manual channel)

`GET /api/brands/:brandId/setup-checklist`. Hiding it is per person and brand
(`setup_checklist_dismissals`); it hides itself for everyone once all required
steps are done. Imported tickets do not count as the first ticket. Audience is
owner decision D-31.

### M14-14 Saved-reply and macro polish

- **Shortcut keyword** per canned response and macro (`refund`), unique per
  owner scope; `/refund` then `Enter` or `Tab` inserts it without the picker.
- `/` opens the picker **at the start of a line or after a space**, not only in
  an empty reply; a literal `/` in a URL is left alone.
- `{{` in the composer opens the existing `PlaceholderPicker`.
- **Fallbacks:** `{{contact.first_name|there}}` renders "there" when the value
  is empty. Rendering stays one pass over a fixed list (no expressions).
- **Save-time check:** an unknown placeholder or an unclosed `{{` is refused on
  save with each one named (rendering still leaves unknown ones as written).
- **Most used first:** `use_count` beside the existing `last_used_at`; the
  picker orders by the person's recent use, then the brand's.

### M14-15 Mention picker

`@` in a note (not in a public reply) opens a listbox of the people who can see
**this** ticket's department, with presence, filtered as one types in either
script. Choosing inserts the handle the existing resolver already understands
(`@lina.haddad`), so the notification path is unchanged. Typing a handle by hand
still works. A person outside the ticket's department never appears; the
endpoint is the assignee picker's list, which already applies that rule.

### M14-16 Custom-field filters and pinned chip

The ticket list and the view editor take filters on ticket custom fields:
select and multi-select (`is any of`, `is not set`), checkbox (`is`), number
and date (`before`, `after`, `between`), text (`contains`). They reach SQL as
bound parameters against `tickets.custom` with a GIN index on the `jsonb`.
A brand may **pin one select field** (Admin › Ticketing › Custom fields): its
value shows as a `Tag`-style chip on the row's caption line and in the ticket
header, without a new hue. The guide gains the Severity recipe.

### M14-17 Fields required to close

`custom_field_defs.required_to_close` (beside `required`, which keeps meaning
"at creation"). A close by a person (UI or public API key) of a ticket with an
empty required-to-close field is refused with `fields-required-to-close` (409)
naming the fields; the Close button and `e` open the fields instead. Bulk
preview reports it per ticket. Rules, time-based rules, merge and spam are
**not** refused, and their close records "closed without <field>" in the
activity, because a rule that silently stops closing tickets is worse than a
gap the report can show. API keys are owner decision D-30.

### M14-18 Idle agents marked away

A department setting **Mark idle agents away after** (off, or 10–240 minutes).
The admin app reports activity (pointer, key, focus) at most once a minute over
the `/staff` socket; after the set time without it the presence becomes away,
and the rotation stops picking them (away is not online, unchanged). Any
activity brings them back. The person sees "You were set to away while idle".
Only "active in the last minute" is reported, never what was done.

### M14-19 Compact composer and workspace breakpoints

From [UX-01 and UX-21](../completed/ux-review-1-0.md#findings). At 1280 × 720
the workspace (220 · 360 · flexible · 300) leaves the thread about 400 px wide,
and the always-expanded email composer (From, To, Cc with an input, a 5-row
textarea, the signature block, two toolbar rows; about 460 px) covers almost
all of it. This is the screen agents use for hours.

- **Compact composer.** A single-line summary "Reply to Mona Khalil · from
  billing@ ▾" that expands To, Cc and the signature on demand; the textarea
  starts at 2 rows and grows with its content; one toolbar row; the composer is
  capped at about 45 % of the column, scrolling inside beyond that. Reply,
  note and the M14-01 send shortcuts are unchanged.
- **Breakpoints.** The details panel becomes a drawer below 1440 px instead of
  1280 px (`DETAILS_BREAKPOINT`), or the list column collapses to icons; `[`
  hides the list column. The artboard settles which.
- **Header.** The subject is an h2 clamped to one line, with the full text in
  its accessible name and a tooltip.
- **One macro entry point** (UX-21). The composer's Macros button and `/` stay;
  the header's Macro button is removed, and "Apply macro" is a palette command
  (M14-05).

Artboard: `Admin/Ticket-CompactComposer` (the compact composer collapsed and
expanded, and the 1280 × 720 layout).

### M14-20 Ticket row and details panel density

From [UX-07 and UX-08](../completed/ux-review-1-0.md#findings).

- **TicketRow to the DESIGN §6.3 anatomy:** checkbox (M14-04) · priority dot ·
  title · one meta line (status · SLA · time) · assignee Avatar 24, or the
  dashed unassigned ring. The status pill is hidden when the view already
  filters to that one state. Titles get the width the stacked inline-end
  column took.
- **Details panel order:** contact card → Assignee, Status, Priority,
  Department → SLA → Tags → custom fields → Participants, collapsed to "2
  participants · Add CC". Every select uses the label-above field DESIGN §6.1
  makes the rule, replacing the floating notched labels.

Artboards: `Admin/TicketRow-360` (the row at the 360 px list width, assigned,
unassigned, snoozed and selected) and `Admin/Ticket-Details-Order`.

### M14-21 Settings area with grouped sub-navigation

From [UX-11](../completed/ux-review-1-0.md#findings). The sidebar's Admin group
(9 entries) falls below the fold at 720 px tall, Ticketing has grown to 12 tabs
in a scrolling row, and "Settings" means install authentication only.

- **One sidebar entry, Settings**, opening a settings shell with a grouped
  secondary navigation: Your account · Brand · Inbox (statuses, priorities,
  tags, fields, views, assignment, business hours, SLAs, spam, feedback, rules,
  macros) · Channels · AI · Developers · Install (authentication, SSO, system,
  imports). Each group shows only what the person's role may open.
- **Views collapsible** in the sidebar, remembered per person.
- **Stable URLs.** Every existing admin URL redirects to its new place, so
  bookmarks, guides and the setup checklist's links keep working; a unit test
  lists every old path in `route-paths.ts` and its target.
- The palette's page registry (M14-05) follows the new structure, which is why
  this lands after it.

Artboard: `Admin/Settings-Shell` (the shell with each group, a Team Leader's
and a Viewer's variant, and RTL per DESIGN §7).

### M14-22 List-first tickets on narrow screens

From [UX-13](../completed/ux-review-1-0.md#findings). Below 1024 px
(`LIST_BREAKPOINT`) the list moves into a drawer today and the main area shows
"Show the ticket list" over "No ticket open", so every visit on a tablet
starts with a wasted tap.

- Below 1024 px the **list fills the screen**; opening a ticket pushes the
  ticket view with a back button that mirrors in RTL; the details panel is a
  drawer.
- Selection, the bulk bar and the keyboard work the same; the browser's back
  returns to the list at the same scroll position.
- Phone layouts below 600 px (bottom navigation, details as a bottom sheet) are
  M17-07, which builds on this.

Artboard: `Admin/Tickets-Narrow` (list, ticket and details drawer at 768 px,
`en` and `ar`).

### M14-23 Skeletons and empty states beyond 1.0.1

From [UX-10 (c) and UX-12](../completed/ux-review-1-0.md#findings). The 1.0.1
patch adds skeletons to the ticket list and the ticket view; M14-06 gives the
ticket views their empty states. This deliverable covers the rest:

- **Action-bearing empty states** (DESIGN §6.3 EmptyState: icon, h3, one
  sentence, one primary action) for Contacts, Help center (no categories, no
  articles), Views with nothing saved, Macros and canned responses, Rules, and
  the other first-run admin screens that today say only "Nothing here".
- **Skeletons** (DESIGN §4) wherever a screen still renders a blank
  `aria-busy` box while loading, keeping `aria-busy` on the region.

Artboards: `Admin/Empty-*` (one per screen above).

### M14-24 Docs and decisions

Guides: a new `docs/guides/keyboard-shortcuts.md`; `tickets.md` (snooze, bulk,
palette, routing trail, SLA sort, the compact composer and narrow-screen
layout, keyboard section replaced by a link); `notifications.md` (schedules,
pacing, pause, unsubscribe, mention picker); `macros.md`; `automation.md`
(Routing tab and Test routing); `ticketing-settings.md` (Snoozed status,
custom-field filters, pinned chip, required to close, idle away, Severity
recipe, the new Settings structure); `staff-and-roles.md` (profile);
`configuration.md` and `.env.example` (`HD_NOTIFY_EMAIL_*`); `api.md` and
OpenAPI (`snoozedUntil`, bulk, quick search, routing, checklist, the new
custom field types); `webhooks.md` (the new events, M14-28); `reports.md`
(M14-29); `automation.md` also gains the mailbox conditions and the two new
actions (M14-26), and `notifications.md` the sounds (M14-25). DESIGN.md §6
and §10, DOMAIN-RULES, ADRs 0035 to 0038, PRD status board and change log.
Every guide link into an admin page is checked against the M14-21 paths.

### M14-25 Notification sounds

Your account › Notifications gains a **Sounds** card: one switch per event
(a live chat waiting for an agent, a new conversation, a customer reply,
assigned to me or mentioned), each off by default, and a **Remind me every
minute while a chat waits** option for the first. Sounds play only in a tab
that holds the `/staff` socket, at most one at a time, never for the person's
own actions, and never while the tab is hidden if the browser blocks it (the
card says so). Every sound has a visible equivalent already (the bell, the
waiting-chat count), so nothing depends on hearing it (DESIGN §10). The sound
files are short, bundled, and lazy-loaded with the settings; the choice is
stored with the notification preferences (install scope, per person) so it
follows the person to another browser. Artboard `Admin/Account-Notifications-Sounds`.

### M14-26 Mailbox-aware views and rules

The arrival record of M14-08 names the entry point and the address a message
was written to. This deliverable makes both usable:

- **List and views:** filters `mailboxId` (any of) and `toAddress` (the
  address the customer wrote to, matched exactly, for mailboxes with aliases),
  in the filter popover and the view editor.
- **Rule conditions:** `mailbox` (is, is not, any of) and `to_address` (is,
  contains), evaluated on the ticket's arrival facts.
- **Rule actions:** `set_reply_mailbox` (the mailbox later public replies on
  email are sent from, among the brand's mailboxes the ticket's department may
  use) and `mark_spam` (the existing spam transition, with its no-auto-reply and
  no-CSAT semantics, D §2.2).

Tickets created before M14 have no arrival record and never match a mailbox or
address condition; the guide says so. Artboard `Admin/Ticketing-FieldFilters`
gains the two filters and `Admin/RuleBuilder` (amended) the conditions and
actions.

### M14-27 More custom field types

`customFieldTypeSchema` today holds text, number, date, select, multi-select
and checkbox. It gains **long text** (up to 5,000 characters, plain text,
shown collapsed), **link** (an `https` URL, rendered as a link with
`rel="noopener noreferrer"`, never fetched by Helpdock), **email** (validated,
rendered in `<bdi dir="ltr">`) and **person** (a staff member of the brand,
stored by id, shown with their public name; a removed person reads "former
staff member"). Each works on tickets, contacts and accounts, in the API, in
rules (`is`, `is set`, and `contains` for long text), in imports' field
mapping, and in M14-16's filters. Artboard `Admin/Ticketing-CustomFields`
(amended).

### M14-28 More webhook events

Rebase compatibility: SLA assignment notifications retain their automatic source in batched and digest emails, with English and Arabic labels. The notes opt-in migration is `0062_webhook_note_opt_in`, generated after `0061_ticket_sla_next_due`.

Status: implemented for #315; PR #335 second-review fixes applied; pending independent re-review and CI. Migration regenerated as `0062_webhook_note_opt_in` after `0061_ticket_sla_next_due` at the owner's queue signal.

- [x] Eight additional events, Zod source/output contracts, transactional producers, brand and department scope.
- [x] Per-endpoint `include_internal_notes` (default false), note-body redaction and grouped en/ar event picker from `Admin/M14-Amendments`.
- [x] Merge undo publishes profile updates for the changed survivor and restored contact; identity transfers lock contact pairs in id order; the notes hint remains an accessible description outside the checkbox label.
- [x] Focused unit, real Postgres/Redis integration and en/ar Playwright coverage; payload reference in `webhooks.md`, OpenAPI webhooks and API minor changeset.
- [ ] Deferred to M14-03: bulk apply/undo status and assignee changes emit one event per ticket through the shared ticket mutation paths; implementation and acceptance coverage belong to M14-03.

`WEBHOOK_EVENTS` today holds `ticket.created`, `ticket.updated`,
`ticket.replied`, `ticket.closed`, `contact.created`, `csat.received` and
`article.published`. It gains `ticket.assigned`, `ticket.status_changed`,
`ticket.merged`, `message.created` (public replies and notes, with `public`
and the author kind; note bodies only to endpoints that opt in to notes),
`contact.updated`, `contact.merged`, `account.created` and `account.updated`.
Each is written to the outbox in the transaction of the change, as today,
carries the brand and department, and is documented with its payload in
`webhooks.md` and the OpenAPI webhooks section. Events for configuration
objects (tags, mailboxes, staff, views, rules, SLA policies, teams, canned
responses) are not added: configuration changes are in the audit log, and
pushing them to a third party widens what leaves the install for little use.

### M14-29 Reports by tag and backlog by status

Two cards on Reports: **Volume by tag** (tickets created in the range per tag,
top 20, with CSV) and **Backlog by status** (open tickets now, by status, with
the share that is unassigned), both under the reader's department scope and
both from the existing `stats.rollup` data plus one rollup column per tag.
Artboard `Admin/Reports` (amended).

**Status: done** ([#316](https://github.com/Docker-Hunterpedia/Helpdock/issues/316)).
- [x] `volume.byTag` (top 20) and `backlogByStatus` in `reportSummarySchema`,
  and the `volume_by_tag` CSV (`tag_id,tag,tag_ar,created`, every tag).
- [x] The two ChartCards on Reports, drawn from `Admin/M14-Amendments`; the
  share-of-whole rows take a 144 px label for brand-written names (DESIGN 1.31).
- [x] `reports.md`.
- Both are read from the tickets on each request, as the existing By status
  breakdown is, rather than from a new rollup column per tag: a ticket's tags
  and status are its current state, which a daily rollup would only snapshot
  an hour late, and "open now" cannot come from a rollup at all. No migration,
  and the department scope is row-level security on `tickets` and
  `ticket_tags`. Backlog by status has no CSV, as the board draws none; its
  Table carries every figure.

## Data model

One migration, numbered with the next free number at implementation time
(`0054_imports` is the last shipped). Every new tenant table goes into
`TENANT_TABLES` with `FORCE ROW LEVEL SECURITY`, `pnpm --filter @helpdock/db
gen:rls`, and a fixture in `packages/db/src/rls.integration.test.ts`;
owner-scoped ones also into `OWNER_SCOPED_TABLES`.

New tenant tables:

| Table | Scope | Columns (beyond `id`, `brand_id`, timestamps) | Retention |
|---|---|---|---|
| `ticket_bulk_operations` | brand + owner (the actor only) | `actor_id`, `changes jsonb` (ids and enums), `ticket_count`, `undo_until`, `undone_at` | 7 days |
| `ticket_bulk_operation_items` | brand + **department** (denormalised by the same trigger as `ticket_activity`) | `operation_id`, `ticket_id`, `department_id`, `before jsonb`, `after jsonb` | 7 days, with the operation |
| `notification_email_batches` | brand + owner | `user_id`, `kind` (`immediate`, `hourly`, `daily`), `scheduled_for`, `sent_at`, `item_count`, `status` (`pending`, `sent`, `empty`, `failed`), `send_failures`, `digest_tick_at` | 30 days, as notifications |
| `notification_email_pacing` | brand + owner; PK `(brand_id, user_id)` | `step`, `next_allowed_at`, `quiet_since`, `hour_window_start`, `sent_in_hour`, `day_window_start`, `sent_in_day`, `urgent_sent_in_day` | kept while the person holds a role |
| `setup_checklist_dismissals` | brand + owner; PK `(brand_id, user_id)` | `dismissed_at` | with the role |

Changed tables:

| Table | Change |
|---|---|
| `tickets` | `snoozed_until timestamptz`, `snoozed_by uuid`, `snooze_resume_status_id uuid`, `snooze_version int not null default 0`; check: all three set or none; partial index `(brand_id, snoozed_until) where snoozed_until is not null`; generated `sla_next_due_at` with index `(brand_id, sla_next_due_at, id)`; GIN on `custom` |
| `ticket_statuses` | built-in key `snoozed`, seeded for every brand by `seedBrandStatuses` (`packages/db/src/ticket-statuses.ts`) and backfilled by the migration; its state and flags fixed like the other system statuses |
| `notifications` | `email_state` enum (`pending`, `sent`, `skipped_read`, `skipped_paused`, `skipped_off`, `skipped_scope`, `skipped_unconfigured`, `skipped_failed`, `withdrawn` (reserved for M14-03)), `email_batch_id`, `emailed_at`, `bulk_operation_id`; kind enum gains `snooze_ended` |
| `notification_prefs` (install scope, per person) | `email_schedule`, `digest_hour`, `paused_until`, `email_unsubscribed_at` |
| `users` (install scope) | `public_name`, `job_title_en`, `job_title_ar`, `public_phone`, `photo_media_id`, `time_zone`, `single_key_shortcuts boolean default true` |
| `canned_responses` (macros share it) | `shortcut text` unique per owner scope, `use_count int` |
| `custom_field_defs` | `required_to_close boolean default false`, `pinned boolean` (at most one per brand, partial unique index) |
| `departments` | `idle_away_minutes int null` |
| `ticket_activity.detail` | `ticket.created` gains `arrival` (Zod schema, no column); new kinds `ticket.snoozed`, `ticket.woke` |

M14-19 to M14-23 change no tables; the collapsed Views state of M14-21 is a
per-browser convenience in local storage.

Imported tickets (M11) are never snoozed by an import, never in a bulk
operation's CSAT path unless a person closes them, and their arrival reads
`import`.

## API

All under `/api/brands/:brandId` unless noted; Zod in and out; OpenAPI from Zod
([ADR 0019](../decisions/0019-api-scopes-and-openapi-from-zod.md)).

| Method and path | Permission | Does |
|---|---|---|
| `PATCH /tickets/:id` (`snoozedUntil`) | `ticket:write` | Snooze, re-snooze or wake |
| `GET /tickets?snoozed=&sort=slaDue&cf[<fieldId>]=…` | `ticket:read` | New filters and sort |
| `POST /tickets/bulk` | `ticket:write`, then per ticket | Preview or apply |
| `POST /tickets/bulk/:operationId/undo` | `ticket:write`, the actor only | Undo within 60 s |
| `GET /quick-search?q=&limit=` | `ticket:read` (sections by `contact:read`, `help_center:read`) | The palette |
| `GET /tickets/:id/routing` | `ticket:read` | The trail |
| `POST /routing/test` | `ticketing:manage` | Test routing; writes nothing |
| `GET /routing` | `ticketing:manage` | The pipeline's entry points and their departments |
| `GET /setup-checklist`, `POST /setup-checklist/dismiss` | `brand:manage` | The checklist |
| `GET /tickets/:id/mention-candidates?q=` | `ticket:write` | The picker's people |
| `GET`, `PUT /api/me/profile`; `POST /api/me/profile/photo` | signed in | Profile for customers |
| `GET`, `PUT /api/me/notification-preferences` (extended) | signed in | Schedule, hour, pause, unsubscribe state |
| `POST /api/me/notification-preferences/test-email` | signed in | A test notification email, 5 an hour |
| `GET`, `POST /api/notifications/unsubscribe?token=` | public, token, rate-limited | Confirm page data; RFC 8058 POST |
| `POST /api/presence/activity` (socket event `presence:active`) | signed in | Idle tracking |
| Public API v1 `tickets` | `tickets:read` / `tickets:write` | `snoozedUntil` read and `PATCH` |

M14-19 to M14-23 add no routes.

## Domain rules to add or change

Proposed here; each lands as a PR to DOMAIN-RULES.md in the deliverable named,
with its tests. Section numbers are provisional and fixed in the PR that lands
each rule.

1. **§2.1 States** (M14-02): every brand ships a third seeded custom status,
   **Snoozed** (`on_hold`, `pauses_sla`, not `awaiting_customer`), whose state
   and flags are fixed. A ticket is in Snoozed exactly when `snoozed_until` is
   set.
2. **§2.2 Transitions** (M14-02): new rows. *Agent snoozes* (open-like, not
   closed) → Snoozed, remembering the previous status. *Snooze time reached* →
   the remembered status if it exists and is open-like, else the default open
   status; actor `system:snooze`. *SLA warning or breach on a running response
   clock of a Snoozed ticket* → the remembered status. *Any other status
   change, close, merge or spam* clears the snooze. The existing customer-reply
   row applies to Snoozed unchanged and clears the snooze.
3. **§3.2 Pause and resume** (M14-02): Snoozed pauses the **resolution** clock
   only. An unsatisfied first-response or next-response clock keeps running
   while snoozed: putting a ticket away is not answering it. This is the one
   status whose `pauses_sla` applies per clock; `apps/api/src/sla/ticket-clocks.ts`
   already pauses clock by clock, so the change is a fact, not a new engine
   (owner decision D-19).
4. **§3.4 Timers** (M14-02): snooze timers are delayed jobs keyed
   `snooze.<ticket_id>.<version>`, re-planned on every snooze change, and
   `snooze.rebuild` recreates them on worker boot and hourly, waking overdue
   ones.
5. **New §2.7 Bulk changes** (M14-03): at most 50 tickets; preview writes
   nothing; apply is one transaction, all or nothing against the previewed set;
   each ticket passes the same authorization, transitions and side effects as a
   single change, with activity `via: bulk` and the operation id; Undo within
   60 s by the actor reverts only fields still holding the operation's value,
   withdraws its unread notifications and is itself a bulk change; a bulk close
   schedules its survey 60 s later. Replies, notes, merges, splits and deletes
   are never bulk.
6. **§1.2 Scope rules** (M14-03 to M14-13): the new permissions in the API table
   above; a Viewer may open the palette and the shortcut sheet but is offered
   navigation only; quick search answers each section under the reader's own
   scope and omits sections they may not read.
7. **New §2.8 Arrival and the routing trail** (M14-08): every ticket records
   how it arrived in its creation activity; the trail is derived from activity,
   read under the ticket's department policy, and names deleted rules as such.
   Test routing changes, sends and logs nothing and does not move the rotation.
8. **§12 Staff lifecycle, presence** (M14-18): a department may set agents away
   after N idle minutes; activity reports carry no content.
9. **New §20 Notification delivery** (M14-10, M14-11): the pacing schedules and
   defaults; every send re-checks read state, scope, status, pause and
   preference; online recipients are held up to 15 min; digests are per brand;
   pause drops, never delays; unsubscribe is RFC 8058 one-click by POST and
   confirmed on GET.
10. **§4.6 Tokens sent to staff** (M14-11): the unsubscribe token, its key
    derivation, lifetime and idempotency.
11. **§11 Data lifecycle** (M14-03, M14-10): bulk operations and their items
    7 days (fixed); notification batches with notifications (30 days).
12. **Placeholders** (M14-12, M14-14; the rule lives in `macros.md` and the
    D §2 reply rules): the agent fields, one-pass rendering with fallbacks,
    public name on customer surfaces, refusal of unknown placeholders at save.
13. **Closing with required fields** (M14-17, §2.2): a person's close is
    refused while a required-to-close field is empty; system closes are not,
    and say so in the activity.

## Design

### Artboards to draw

Drawn by the orchestrating session on the design canvas before any screen is
built. Admin artboards in English with an `-AR` variant where the layout is new
and flips (palette, bulk bar, sheet, snooze, profile, narrow tickets);
everything a customer sees in both languages.

| Artboard | For | Must show |
|---|---|---|
| `Admin/ShortcutSheet`, `-AR` | M14-01 | The `?` dialog: General, List, Ticket, Composer groups with `Kbd` keys; the single-key switch in the footer; how sequences read ("g then i") |
| `Admin/Ticket-Snooze`, `-AR` | M14-02 | Snooze menu with presets and both time zones, the date-time picker, the `SnoozedStrip` with Wake now, the snoozed row (clock icon, wake time), the Snoozed view |
| `Admin/Tickets-Bulk`, `-AR` | M14-04 | Rows with checkboxes, header checkbox indeterminate, `BulkBar`, preview dialog with refusals, Undo toast, the 50 cap caption |
| `Admin/CommandPalette`, `-AR` | M14-05 | Empty (recents and actions), typing with grouped results, exact ticket first, actions with keys, no results, a section failed, Viewer variant |
| `Admin/Tickets-Empty` | M14-06 | Each built-in view's empty state with the hint line; the filtered and searching variants |
| `Admin/Tickets-SortSla` | M14-07 | The sort menu with SLA due, and breached-first ordering on the rows |
| `Admin/Ticket-Routing` | M14-08 | "How it got here" in the details panel: collapsed, expanded, pre-M14 ticket, imported ticket |
| `Admin/Automation-Routing` | M14-09 | The four-step explainer; Test routing for email, chat, Telegram, Meta, form and API; a result with a matching rule, a blocked sender, and a department with nobody online |
| `Admin/Account-Notifications-Schedule`, `-AR` | M14-11 | Schedule cards, digest hour, pause menu and paused state, the reasons line, test email |
| `Email/NotificationBatch-EN`, `-AR` | M14-10 | One notification, a batch with Needs you now and folded lines, a daily digest; the unsubscribe footer |
| `Public/Unsubscribe-EN`, `-AR` | M14-11 | Confirm, done (with what still reaches them), invalid token |
| `Admin/Account-Profile`, `-AR` | M14-12 | Profile for customers fields, photo upload and crop, time zone, the shortcuts switch, a preview of the signature with placeholders filled |
| `Email/Reply-Signature-EN`, `-AR`; `Widget/Chat-AgentProfile-EN`, `-AR` | M14-12 | A reply signed with public name, title and phone; the widget header with photo and public name |
| `Admin/SetupChecklist`, `-AR` | M14-13 | The sidebar entry with progress, the open panel with done, to do and optional steps, all done |
| `Admin/Composer-Shortcuts` | M14-14 | `/refund` inline completion, `/` mid-line, `{{` picker, macro editor's shortcut field and the save-time refusal |
| `Admin/Composer-Mentions`, `-AR` | M14-15 | `@` listbox in a note with presence |
| `Admin/Ticketing-FieldFilters` | M14-16, M14-17 | Field filters in the list's filter popover and the view editor; pinned chip on the row and header; the required-to-close switch; the close refused with fields to fill |
| `Admin/Ticketing-Assignment-Idle` | M14-18 | The idle setting on the department; the "set to away while idle" notice |
| `Admin/Ticket-CompactComposer` | M14-19 | The compact composer collapsed and expanded (To, Cc, signature), auto-growing textarea, one toolbar row, the 45 % cap; the 1280 × 720 layout with the thread dominant; the one-line subject |
| `Admin/TicketRow-360` | M14-20 | The row at the 360 px list width: assigned, unassigned (dashed ring), snoozed, selected, pinned field chip, status pill hidden in a single-state view |
| `Admin/Ticket-Details-Order` | M14-20 | The details panel in the new order with label-above selects and Participants collapsed |
| `Admin/Settings-Shell`, `-AR` | M14-21 | The single Settings entry, the grouped secondary navigation with every group, Team Leader and Viewer variants, collapsible Views in the sidebar |
| `Admin/Tickets-Narrow`, `-AR` | M14-22 | At 768 px: the list filling the screen, the pushed ticket view with the mirrored back button, the details drawer |
| `Admin/Empty-*` | M14-23 | One action-bearing empty state per screen listed in M14-23, and a skeleton for each screen that gains one |
| `Admin/Account-Notifications-Sounds`, `-AR` | M14-25 | The Sounds card: a switch per event, the waiting-chat reminder, a preview button per sound, the "this browser blocks sound in background tabs" note |
| `Admin/Ticketing-FieldFilters` (amended), `Admin/RuleBuilder` (amended) | M14-26 | Mailbox and address-written-to filters; the two conditions; the "set reply address" and "mark as spam" actions |
| `Admin/Ticketing-CustomFields` (amended) | M14-27 | The four new types in the field editor and how each renders on a ticket, contact and account |
| `Admin/Developers-Webhooks` (amended) | M14-28 | The event picker grouped by tickets, messages, contacts and accounts, with the notes opt-in |
| `Admin/Reports` (amended) | M14-29 | The Volume by tag and Backlog by status cards |

**Drawn on 2026-10-20** in the [design canvas](https://claude.ai/artifact/RQd32d1RXK8DST8SKC1VBQ) section “M14 Inbox productivity”, each board with its `en` and `ar` panels and a notes column. Some rows above share one board: `Admin/Account-Notifications-Sounds` is on `Admin/Account-Notifications-Schedule`; `Email/Reply-Signature` and `Widget/Chat-AgentProfile` are on `Admin/Account-Profile`; `Admin/Composer-Mentions` is on `Admin/Composer-Shortcuts`; `Admin/Ticket-Details-Order` is on `Admin/TicketRow-360`; `Admin/Ticketing-CustomFields` (amended) is on `Admin/Ticketing-FieldFilters`; `Admin/RuleBuilder`, `Admin/Developers-Webhooks` and `Admin/Reports` (amended) are on `Admin/M14-Amendments`; `Admin/Empty-*` is `Admin/Empty-States`. The board for M14-19 settles the breakpoint: the details panel becomes a drawer below 1440 px.

### DESIGN.md changes

§6 gains, in the same PRs: `Kbd` (§6.2), `ShortcutSheet`, `CommandPalette`,
`SnoozeMenu`, `BulkBar` (§6.4), `SnoozedStrip`, `RoutingTrail`,
`SetupChecklist`, `MentionPicker` (built on `PlaceholderPicker`'s pattern)
(§6.3), and the settings shell's secondary navigation (§6.1); `TestRunPanel`
gains the routing variant; `EmptyState` gains the optional hint line;
`TicketRow` gets its checkbox's states and the snoozed variant; the composer
entry in §6.3 describes the compact form; §6.5 records the 1440 px details
breakpoint and the list-first layout below 1024 px. No new colours, sizes or
radii: Snoozed uses the `on_hold` hue it is mapped to.

## Accessibility notes

- **WCAG 2.1.4.** The single-key switch (M14-01) closes an existing gap for
  `j`/`k`/`r`/`n`. Shortcuts never fire while focus is in a field, a select or
  a rich-text editor.
- **Screen readers.** In NVDA and JAWS browse mode the reader consumes letter
  keys, so single-key shortcuts only reach the page in focus mode; that is
  intended. No container takes `role="application"` to grab them. Every
  shortcut has a visible button or menu item, and the palette (a modifier
  shortcut, so it reaches the page in browse mode) reaches every action: the
  keys are an accelerator, never the only path. Buttons carry
  `aria-keyshortcuts`.
- **Arabic layouts.** Physical key matching (M14-01); the sheet shows the Latin
  key as engraved on bilingual keyboards, with the Arabic letter beside it.
- **Palette.** ARIA 1.2 combobox with a grouped listbox, `aria-activedescendant`,
  a polite count ("8 results"), `Esc` closes and focus returns to where it was.
  Bidi isolation (`<bdi>`) for ticket references and English titles in Arabic.
- **Bulk.** Each checkbox has a name; the count is announced politely; the
  `BulkBar` is a `role="toolbar"` with roving tabindex; after apply focus stays
  on the list, and the toast is `role="status"`, pauses on hover and focus, and
  Undo stays reachable from the palette for 60 s (WCAG 2.2.1).
- **Snooze.** Preset names carry the absolute date and time; the picker is a
  native `datetime-local` input; the strip is one `role="status"`.
- **Notifications and email.** Digest emails are semantic HTML with a text
  part; Arabic emails are `dir="rtl"` with `lang`.
- **Idle away** is announced once, not repeatedly, and never interrupts typing.
- **Compact composer.** The collapsed summary is a button with
  `aria-expanded`; the expanded fields keep their labels; the auto-growing
  textarea keeps its label and never traps focus.
- **Ticket row.** The row's link is named by its content, never by an
  `aria-label` that drops status, SLA, priority and assignee (1.0.1 fixes the
  override; M14-20 keeps it fixed with the new anatomy).
- **Settings shell.** The secondary navigation is a `nav` with a name, groups
  are headings, the current page carries `aria-current="page"`.
- **Narrow screens.** The pushed ticket view moves focus to its heading; back
  returns focus to the row that opened it.
- Every UI PR ticks DESIGN §10 and runs axe in both locales.

## Tests

| Deliverable | Unit | Integration (Testcontainers) | Playwright `en` + `ar` with axe |
|---|---|---|---|
| M14-01 | Registry ↔ handler parity; `event.code` matching with an Arabic layout (failing first); sequences and timeout; switch off disables all unmodified keys | Profile switch persists | `?` sheet; `g i`; `j`/`k` with an Arabic layout fixture; switch off |
| M14-02 | Preset maths against business hours in Asia/Riyadh and Europe/Berlin; transition table rows; resume-status fallback | Snooze, timer fires and wakes; customer reply wakes and the job is a no-op; SLA warning wakes; resolution paused while response runs (a §3.6-style worked example to the minute); kill Redis and `snooze.rebuild` restores; exact number finds a snoozed ticket; RLS: Agent of another department cannot snooze | Snooze from header and `h`; Snoozed view; wake now; failure: too far ahead |
| M14-03 | Change validation; undo merge logic (field changed since is kept) | 50 tickets in one transaction; mixed departments (a hidden one is `not_found`); one refusal in preview; apply rolls back on `bulk-changed`; every per-ticket outbox event present; a bulk status or assignee change emits one webhook event per ticket; bulk close delays CSAT and Undo sends none; Undo by another person refused; RLS on both new tables | — |
| M14-04 | Range selection logic | — | Select with `x`, `Shift`+`x` and Shift-click; close 10 and Undo; preview with refusals; the 50 cap |
| M14-05 | Registry ↔ `route-paths` drift test; Arabic folding; action filtering by permission | Quick search under RLS: a ticket in another department and a contact's hidden tickets never appear; Viewer gets no actions; exact number | Open with `⌘K`/`Ctrl+K`, find by number, by Arabic setting name, run an action; failure: a section errors |
| M14-06 | Copy per view | — | Each empty state; hints hidden when the switch is off |
| M14-07 | Order of breached, due, none | Sort under RLS; 50k p95 under D §14 | Sort menu |
| M14-08 | Trail composition for each actor kind; deleted rule | Arrival recorded by all six creation paths; trail hidden for another department | The card on an email ticket and a widget ticket |
| M14-09 | Synthetic facts per entry point | Test writes nothing (row counts and outbox unchanged), rotation turn unchanged, no AI call, blocked sender shown as Spam | Test an email and a chat; failure: no rules, nobody online |
| M14-10 | Pacing state machine with a fake clock (first wait, back-off, quiet reset, urgent cut, hour and day caps); grouping and folding | Read before send drops it; scope lost before send drops it; paused drops; presence hold and its 15 min cap; digest per brand at the person's hour across a DST change; job twice sends once; `notify.email_rebuild` after Redis loss; RLS on batches and pacing | — |
| M14-11 | Token sign and verify, expiry | RFC 8058 POST unsubscribes; GET does not; replay is harmless; audit row | Settings page; unsubscribe page in both languages; failure: invalid token |
| M14-12 | Placeholder rendering with fallbacks and title language | Photo pipeline (magic bytes refused, EXIF stripped); public name on email, widget, Telegram | Profile page; signature preview |
| M14-13 | Step computation | Each step ticks from real state; imported tickets do not tick step 9; RLS on dismissals | Checklist panel, dismiss |
| M14-14 | Shortcut resolution, `/` boundary rules, save-time check | Unique shortcut per scope | `/refund`, `{{`, refused save |
| M14-15 | Candidate filtering | Candidates never include people outside the department | `@` picker in a note |
| M14-16 | Filter compilation to bound SQL | Filters under RLS; one pinned field per brand | Filter, save as view, pinned chip |
| M14-17 | Refusal codes | Person refused, rule not, activity line written | Close opens the fields; failure path |
| M14-18 | Idle timer | Away after N, rotation skips, back on activity | Notice shown |
| M14-19 | Composer height cap and expand state; breakpoint selection | — | At 1280 × 720 the thread shows its latest messages above the collapsed composer (screenshot baseline); expand To/Cc and send; header subject clamps to one line with the full name read out; failure: a send error keeps the composer expanded with the text |
| M14-20 | Row meta-line composition; status pill hidden for a single-state view | — | Row with assignee avatar and unassigned ring; details order; label-above selects; the row link's accessible name includes status, SLA and assignee |
| M14-21 | Old path → new path redirect table covers every route in `route-paths.ts` | — | Each settings group opens; an old URL redirects; a Team Leader and a Viewer see only their groups; Views collapse is remembered |
| M14-22 | Layout selection by width | — | At 768 px the list fills the screen, a ticket opens and back returns to the same row with focus on it; RTL back button mirrored |
| M14-23 | Empty-state copy per screen | — | Each new empty state and its primary action; a skeleton shown while a delayed response is pending, with `aria-busy` |
| M14-25 | Event-to-sound selection; reminder timer stops when the chat is picked up | Preference persists per person | Switches persist; a waiting chat plays and repeats until picked up (audio stubbed) |
| M14-26 | Condition and action schemas; reply mailbox limited to the department's mailboxes | Filter and conditions on arrival facts under RLS; `mark_spam` sends no auto-reply or survey; pre-M14 tickets never match | Filter by mailbox, save as a view; rule with a mailbox condition in the test run |
| M14-27 | Validation per type (https only for link, email format, person in the brand) | Values on ticket, contact and account; person removed from the brand reads as former staff | Each type in the editor and on a ticket, `en` and `ar` |
| M14-28 | Payload schemas per event | Each event written to the outbox in the change's transaction; note bodies only to opted-in endpoints | Event picker |
| M14-29 | Tag rollup arithmetic | Report figures match seeded data under department scope | The two cards and their CSV |

## Docs

As listed in M14-24, written in the same PR as each deliverable, checked with
`docs-guard`. The keyboard guide is a table generated from the registry so it
cannot drift.

## ADRs

1. **[0035 Snooze as a system status with a wake timer](../decisions/0035-snooze-as-a-system-status.md).**
   Status versus a hidden flag; the per-clock pause exception; timers through
   the outbox with a rebuild sweep.
2. **[0036 Bulk changes as previewed, all-or-nothing operations with a short undo](../decisions/0036-bulk-changes-previewed-all-or-nothing-with-undo.md).**
   Why not partial success; why replies, merges and deletes are excluded; why
   CSAT waits for the undo window.
3. **[0037 Paced notification email and digests](../decisions/0037-paced-notification-email-and-digests.md).**
   State in Postgres, not Redis (it must survive Redis loss, D §10); per-brand
   digests under D §1.4; the presence hold; RFC 8058 unsubscribe and its token.
4. **[0038 One keyboard registry, physical keys, and a command palette without a new dependency](../decisions/0038-keyboard-registry-and-command-palette.md).**
   The palette is built on MUI's existing primitives; `cmdk` or similar is not
   added (stack table, ARCHITECTURE §1).

M14-19 to M14-23 follow DESIGN.md and need no ADR.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Snooze used to hide tickets from SLA | High | Response clocks keep running while snoozed; an SLA warning wakes the ticket; time in Snoozed is visible in status reports |
| A mistaken bulk close emails fifty surveys | High | Preview first, 60 s Undo, surveys wait for the window; bulk never replies |
| Pacing bugs mean a missed SLA-breach email | High | The bell is always immediate; urgent kinds cut the wait; the state machine is unit-tested on a fake clock and integration-tested end to end; `notify.email_rebuild` |
| Shortcuts conflict with assistive technology or the browser | Medium | Off switch, physical keys, no `role="application"`, palette as the full path, a screen-reader pass on the sheet and palette before ship |
| Quick search is slow under RLS | Medium | Reuses ADR 0011's token table and the contacts index; 300 ms per-section budget; sections fail independently |
| Bulk transactions hold locks on 50 tickets | Medium | Fixed lock order, 50 cap, no network calls inside (everything is outbox) |
| Undo races a colleague's change | Low | Undo reverts only fields still holding the operation's value and reports the rest |
| Changing the default from one email per notification to batched surprises people after upgrade | Low | Release note; the first wait is 2 min; the schedule is one click |
| Scope creep toward an AI copilot in the palette | Medium | Non-goal above; palette actions come only from the registry of human actions; the one assistant hook is M12-13's read-only panel (D-03) |
| Moving every settings page breaks bookmarks and guide links (M14-21) | Medium | A redirect for every old path, a unit test over `route-paths.ts`, and M14-24 rechecks guide links |
| The compact composer hides To/Cc so an agent replies to the wrong people | Medium | The collapsed line names the recipient and sender; any change to recipients expands it; the artboard is reviewed before build |

## Open questions for the owner

Each is answered in [decisions-1-x.md](../planning/decisions-1-x.md#m14-inbox-productivity).

1. (D-19) **Snooze and SLA.** Recommended: pause resolution only; response
   clocks keep running and an SLA warning wakes the ticket. Alternatives: pause
   both clocks (what a `pauses_sla` status does today), or pause neither.
2. (D-20) **Snooze as a status.** Recommended: a seeded Snoozed status. The
   alternative is a flag that leaves the status alone (Awaiting customer stays
   Awaiting customer), which needs a new pause rule and hides snooze from
   reports.
3. (D-21) **Severity.** Recommended: no first-class field; ship M14-16 and the
   recipe. Approve, or ask for Sev 1–4 as a field (about +4 d with rules,
   views, API, importers and webhooks).
4. (D-22) **Bulk failure mode.** Recommended: all or nothing against a preview.
   Alternative: commit what can be done and report the rest.
5. (D-23) **Bulk macros.** Allow macros **without** a reply in bulk (their
   actions are all bulk-safe)? Recommended: not in M14.
6. (D-24) **Bulk close and surveys.** Recommended: surveys sent as for any
   close, after the 60 s window. Alternative: a "Don't send surveys" box on
   bulk close, which changes D §2.2.
7. (D-25) **Default email schedule after upgrade.** Recommended: *Right away*
   (batched) for everyone, replacing one email per notification.
8. (D-26) **Digests per brand.** Recommended: yes. A single cross-brand digest
   needs an audited all-brands system path.
9. (D-27) **Presence hold cap.** Recommended 15 minutes while online. Prior art
   holds indefinitely while the person is in the app.
10. (D-28) **Photo upload** in Profile for customers (2 of M14-12's 5 days).
    Include, or defer and use initials?
11. (D-29) **Widget department.** The widget always files into the brand's
    first department. Test routing will make that visible. Add a per-brand
    widget department setting (about 1 d, in M14-09), or leave it to M19-02,
    where each widget gets a department default?
12. (D-30) **Required to close for API keys.** Recommended: refused for API keys
    as for people (an integration closing tickets is acting for a person);
    rules and time-based closes go through with an activity note.
13. (D-31) **Setup checklist audience.** Recommended: Admins only. Team Leaders
    could see the steps they can do (business hours, SLAs, macros).
14. (D-32) **Single-key shortcuts default.** Recommended: on (today's
    behaviour) with the switch. Off by default would be safer for screen-reader
    users and worse for everyone else.

## Build order

1. M14-01 (everything else registers its keys).
2. Track A: M14-02 → M14-03 → M14-04 → M14-17.
3. Track B: M14-05 → M14-06; M14-07.
4. Track C: M14-08 → M14-09.
5. Track D: M14-12 → M14-10 → M14-11; M14-14; M14-15.
6. Track E (workspace): M14-19 → M14-22; M14-20 after M14-04; M14-21 after
   M14-05; M14-23 after M14-06.
7. M14-16 and M14-18 whenever a slot is free; M14-13 last, because its steps
   link to screens the others change (and M14-21 moves).
8. M14-25 to M14-29 whenever a slot is free, after the deliverable each
   depends on.
9. M14-24 runs alongside each deliverable; the final PR closes the PRD row.

Tracks A to E are independent after M14-01, apart from the dependencies named
in track E.

## Exit criteria

- [ ] An agent snoozes a ticket until the next business day; it leaves My open,
      appears in Snoozed, and returns to its previous status at the department's
      opening time; a customer reply wakes it earlier; after Redis is flushed
      and the worker restarts, the wake still happens.
- [ ] While snoozed, the resolution clock is paused and an unanswered ticket's
      first-response clock keeps running, proved by a worked example to the
      minute; an SLA warning wakes the ticket.
- [ ] An agent selects 30 tickets with `x` and Shift-click, closes them in one
      request, and undoes it within the toast: all 30 are back as they were, and
      no survey was sent.
- [ ] A bulk change over tickets in two departments, one the agent cannot see,
      changes only the visible ones and reports the other as not found; a
      refused ticket in the preview keeps the apply from writing anything
      unexpected.
- [ ] `⌘K` / `Ctrl+K` finds `HD-1042` by its number, a contact, an article and
      the SLA settings typed in Arabic, and runs "Assign to me" on the open
      ticket; a Viewer sees navigation only.
- [ ] Every shortcut on the `?` sheet works on an English and an Arabic keyboard
      layout, and none fires with the single-key switch off.
- [ ] Each ticket shows how it arrived and every automatic step after it; Test
      routing explains a sample email and a sample chat and leaves the database,
      the outbox and the rotation unchanged.
- [ ] With *Right away*, twelve notifications in an hour reach the person as no
      more than six emails; one read in the app before its email is left out; a
      daily digest arrives at the chosen hour in the person's time zone; pause
      sends nothing, later included.
- [ ] A mail client's one-click unsubscribe POST stops notification emails; a
      GET of the same link changes nothing until confirmed.
- [ ] A reply signed `{{agent.name}}, {{agent.title}}` shows the agent's public
      name and title in the customer's language, in email and in the widget.
- [ ] A new brand's Admin sees the checklist, and each step ticks itself as it
      is done.
- [ ] At 1280 × 720 the ticket view shows the thread's latest messages above the
      collapsed compact composer, as drawn in `Admin/Ticket-CompactComposer`;
      expanding it shows To, Cc and the signature, and a reply sends from either
      state.
- [ ] Ticket rows show the assignee avatar (or the unassigned ring) and one meta
      line, and the details panel shows Assignee, Status, Priority and
      Department directly under the contact.
- [ ] Every admin page is reachable from the single Settings entry's grouped
      navigation, and every pre-M14 admin URL redirects to its new place.
- [ ] Below 1024 px the Tickets screen opens on the list; opening a ticket and
      going back returns to the same row, in `en` and `ar`.
- [ ] A view filtered by mailbox and a rule conditioned on the address written
      to match a new email ticket; a rule's "set reply address" makes the next
      public reply leave from that mailbox.
- [ ] Long text, link, email and person fields work on a ticket, a contact and
      an account, in the API, in rules and in filters.
- [ ] Each new webhook event reaches a test endpoint, signed, once per change.
- [ ] Brand A cannot read brand B's rows in the five new tables, and an Agent
      cannot read bulk items of another department (DOMAIN-RULES §1.6).
- [ ] Every new or changed screen passes Playwright in `en` and `ar` with axe,
      and the sheet and palette pass a manual NVDA and VoiceOver run.

## Gaps accepted up front

| Gap | Why |
|---|---|
| No selection beyond 50 tickets, no "all matching" | One transaction must stay short; a person can repeat |
| No bulk replies, notes, merges, splits, deletes | Blast radius; each has its own careful flow |
| Undo is 60 s and cannot recall what left the install (webhooks, push) | Undo is for a slip, not a history editor; activity keeps everything |
| A person in several brands gets a digest per brand | D §1.4 |
| Unsubscribing stops notification emails from every brand | Preferences are global per person (M3-07) |
| AI triage cannot set a custom field, so the Severity recipe is set by people and rules | AI triage scope stays as M7-07 shipped it |
| No snooze "until the customer replies" | Awaiting customer already means that |
| Recents in the palette live in the browser, as ids | No server table for a convenience; nothing sensitive stored |
| No desktop app, phone app or Telegram agent notifications | Phone layouts are M17-07; native clients M20; Telegram notifications stay in the backlog |
| Phones below 600 px keep today's layout until M17-07 | M14-22 covers tablets and narrow windows; phones need the bottom navigation and sheets M17-07 designs |

## Prior art and where it lands

Agent ergonomics other helpdesks ship (OpenDesk, Apache-2.0, documents most of
these in its guides), and where each lands in Helpdock.

| Prior art | Here |
|---|---|
| Snooze with presets | M14-02, presets from the department calendar rather than a fixed 09:00 |
| `x`, bulk bar | M14-03, M14-04, with a preview and Undo |
| `⌘K` palette; an AI question from the palette | M14-05; the AI question goes to M12-13's read-only panel (D-03) |
| `?` sheet, `g` navigation, ticket letters | M14-01, plus physical keys and the off switch |
| Send and set status, `mod+Enter` | Then-set-status exists (M3-06); the keys are M14-01 |
| "Leave a note instead" while a teammate replies | Collision exists (M1-09); unchanged |
| Severity Sev 1–4 | Declined; M14-16 recipe (D-21) |
| Routing page, Test routing, "how it was routed" | M14-08, M14-09 |
| Right away / hourly / daily / off, back-off, caps, pause, unsubscribe, unread re-check, nothing while active | M14-10, M14-11, with a cap on the hold and per-brand digests |
| Profile for customers (`agent.title`, phone, pronouns, signature) | M14-12; pronouns left out (rarely used, awkward in Arabic grammar; open to adding) |
| `/` + shortcut saved replies, `{{` variables, `default:` fallbacks, refuse unknown variables at save | M14-14 |
| `@` mention list in notes | M14-15 |
| Sort by SLA due, due pills | M14-07; the pill exists (`SlaTimer`) |
| Ticket fields required to solve | M14-17 |
| Mark idle teammates away | M14-18 |
| Setup checklist that ticks itself | M14-13 |
| Empty inbox with key hints | M14-06 |
| A grouped settings shell | M14-21 |
| Team availability table | Exists (Ticketing › Assignment, M1-07) |
| Rename and recolour statuses and priorities | Exists (M1-02) |
| Label groups, one-at-a-time groups, merge, archive, who may create labels | Not here; ticketing-settings work |
| Gravatar and company logos | Declined by default (third-party lookups) |
| Sample data in report empty states | M15-11 and M19-08 |
| Ownership transfer, private teams | Not here; install work; departments cover privacy |
