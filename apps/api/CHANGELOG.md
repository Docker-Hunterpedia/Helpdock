# @helpdock/api

## 0.2.0

### Minor Changes

- [#99](https://github.com/Docker-Hunterpedia/Helpdock/pull/99) [`e4e7b7a`](https://github.com/Docker-Hunterpedia/Helpdock/commit/e4e7b7a1de8912c59c42a48a6eac4038c478ed45) Thanks [@Docker-Hunterpedia](https://github.com/Docker-Hunterpedia)! - Inbound email (M2-01 to M2-04, M2-07, and the inbound half of M2-08). Mailboxes receive mail by IMAP polling or by inbound-parse webhooks from Postmark, SendGrid, Mailgun, Resend or any JSON sender, protected by a per-brand shared secret. Each message becomes a ticket or threads onto one only when the sender is a participant; a stranger quoting a ticket number gets a ticket of their own with a note. Bodies are sanitised, quoted history is folded away, remote images are blocked or loaded through a re-encoding proxy, automated senders are dropped unless allow-listed, and SPF or DKIM failures can file mail as spam. Admins manage it all on the new Channels › Mailboxes page, with Test IMAP and per-mailbox health.

- [#105](https://github.com/Docker-Hunterpedia/Helpdock/pull/105) [`ecdd682`](https://github.com/Docker-Hunterpedia/Helpdock/commit/ecdd68225e78d79d8abbc449bcb4e154f0106df8) Thanks [@Docker-Hunterpedia](https://github.com/Docker-Hunterpedia)! - M2 Email channel and M3 Automation and SLAs are complete.
  What each built, and the gaps each left open, are in `docs/completed/`.

- [#97](https://github.com/Docker-Hunterpedia/Helpdock/pull/97) [`774034b`](https://github.com/Docker-Hunterpedia/Helpdock/commit/774034bc32982517c7ee33d0965c25ede5bcfce1) Thanks [@Docker-Hunterpedia](https://github.com/Docker-Hunterpedia)! - Outbound email (M2-05, M2-06). Public replies on email, web-form and agent-created tickets are emailed to the contact with the ticket's CCs copied, through the brand's own SMTP server or the install's, as the department's sender, with the agent's signature in the customer's language. Sends go through the outbox as `email.send` jobs with a deterministic `Message-ID`, so a redelivered job sends one email; five failed attempts land in **Channels › Outgoing email › Failed sends**, where an Admin can retry or discard them, and the ticket shows the reply as "Not delivered". New: acknowledgment and out-of-hours auto-replies with English and Arabic templates, loop protection (`Auto-Submitted`, `Precedence: bulk`, a per-sender hourly cap), and the Email signature tab of Your account.

- [#100](https://github.com/Docker-Hunterpedia/Helpdock/pull/100) [`12e68c6`](https://github.com/Docker-Hunterpedia/Helpdock/commit/12e68c63dc73cab1976e255d39f6186e286a9829) Thanks [@Docker-Hunterpedia](https://github.com/Docker-Hunterpedia)! - Business hours and SLAs (M3-01, M3-02). Ticketing › Business hours sets the brand's time zone and week, holidays, and per-department hours; Ticketing › SLAs sets policies — conditions on department and priority, business or calendar hours, first-response and resolution targets per priority, and escalation steps by percent (notify, reassign, raise priority, add tag, set Escalated). Every ticket runs two clocks counted in business hours that pause on statuses flagged to pause SLA, follow priority, department and policy changes keeping the time already counted, restart as next-response and resolution clocks on a reopen, and record a breach once per clock. Timers are BullMQ jobs rebuilt from the database when the worker starts, so losing Redis loses no timer. The ticket's details panel shows an SLA card and the list a timer in every state.

- [#102](https://github.com/Docker-Hunterpedia/Helpdock/pull/102) [`3167b40`](https://github.com/Docker-Hunterpedia/Helpdock/commit/3167b40cd44a34c19c1c6dbc12b3aea3747f5b1f) Thanks [@Docker-Hunterpedia](https://github.com/Docker-Hunterpedia)! - Macros and canned responses (M3-06): shared and personal items with `{{placeholders}}` and English and Arabic variants, the Macros tab of Automation, and a composer picker that fills the reply and runs a macro's status, priority, tag and assignee actions with it as one activity entry. The admin audit log viewer (M3-08): an install-wide, filterable, paged log under System with before/after diffs and secrets redacted; audit rows now record the request's IP, id and user agent.

- [#103](https://github.com/Docker-Hunterpedia/Helpdock/pull/103) [`216cd76`](https://github.com/Docker-Hunterpedia/Helpdock/commit/216cd76b6a5d3872a454ae301e24f54a94c71038) Thanks [@Docker-Hunterpedia](https://github.com/Docker-Hunterpedia)! - Staff notifications (M3-07). Agents are told about assignment, replies on their tickets, `@`-mentions in internal notes, SLA warnings and breaches, and escalations: in the app through a bell with an unread count in the sidebar, by email from the install's own sender in their language, and by browser push once an install sets a VAPID key pair (`HD_PUSH_VAPID_PUBLIC_KEY`, `HD_PUSH_VAPID_PRIVATE_KEY`). Each person chooses the channels per event on the new Notifications tab of Your account, one page with Security, Notifications and Email signature. A workflow rule's Notify action and an SLA step that names people, teams or department leads now reach them as escalation notifications. Every send goes through the outbox, so one event is one email and one push per browser.

- [#101](https://github.com/Docker-Hunterpedia/Helpdock/pull/101) [`d545065`](https://github.com/Docker-Hunterpedia/Helpdock/commit/d54506555a993980b942ee0a6cfff54d561de408) Thanks [@Docker-Hunterpedia](https://github.com/Docker-Hunterpedia)! - Workflow rules (M3-03, M3-04, M3-05). Admin → Automation lists a brand's rules in the order they run: `WHEN <event> IF <conditions> THEN <actions>` for ticket, SLA and CSAT events, and time-based rules checked every five minutes over tickets that have waited too long, such as awaiting customer for more than 3 days. Rules assign, set status and priority, tag, reply with a canned response (which does not count as the first response unless the rule says so), add notes and notify. A depth guard stops rule loops at a cycle or past three rules, every run is in an execution log, and a test run tries a draft on a real ticket without changing anything.

### Patch Changes

- [#128](https://github.com/Docker-Hunterpedia/Helpdock/pull/128) [`0eb9adb`](https://github.com/Docker-Hunterpedia/Helpdock/commit/0eb9adb88df5d931235dac8a98a10aaf8c62e5d4) Thanks [@Docker-Hunterpedia](https://github.com/Docker-Hunterpedia)! - Sign-in links, password resets and staff invitations are now delivered ([#104](https://github.com/Docker-Hunterpedia/Helpdock/issues/104)). Until now they were only written to the log. Each one is queued through the outbox and sent by the worker from the install's system sender (the SMTP settings the first-run wizard saves), in the recipient's language, once per request even when a job is delivered twice. The link is encrypted under `APP_MASTER_KEY` in the outbox and in the queue, and never logged. An install without SMTP logs that the email would have been sent, and sends nothing.

## 0.1.0

### Minor Changes

- [#71](https://github.com/Docker-Hunterpedia/Helpdock/pull/71) [`35e70e0`](https://github.com/Docker-Hunterpedia/Helpdock/commit/35e70e079802816709d5bfaca79551b667df4332) Thanks [@Docker-Hunterpedia](https://github.com/Docker-Hunterpedia)! - Attachments and the media pipeline (M1-10). A ticket can now carry files:
  `POST …/attachments/presign` issues a five-minute upload URL bound to one
  object, one content type and one exact length; `confirm` checks the object
  against the brand's content policy and enqueues `media.process` through the
  outbox; the worker sniffs the magic bytes, re-encodes images to WebP with two
  thumbnails and no EXIF, normalises voice notes to Opus, takes a video poster,
  optionally scans files with ClamAV, and marks the row `ready`. Downloads are
  presigned for five minutes and issued only from a row the caller's transaction
  can see, so authorisation is the parent ticket's. `POST …/messages` accepts
  `attachmentIds` and links them in the same transaction as the message. The admin
  app gains the client helper the M1-15 composer will use; there is no screen yet.

- [#78](https://github.com/Docker-Hunterpedia/Helpdock/pull/78) [`00beb26`](https://github.com/Docker-Hunterpedia/Helpdock/commit/00beb261bf02fab4a244ab5236726ef4980c1370) Thanks [@Docker-Hunterpedia](https://github.com/Docker-Hunterpedia)! - Contacts and accounts (M1-04, [#64](https://github.com/Docker-Hunterpedia/Helpdock/issues/64)). `contacts`, `contact_identities` and `accounts` arrive under brand row-level security, with normalised email and phone identities, a contact timeline that counts tickets in departments the viewer cannot open without naming them, and the Contacts and Contact screens.

- [#78](https://github.com/Docker-Hunterpedia/Helpdock/pull/78) [`00beb26`](https://github.com/Docker-Hunterpedia/Helpdock/commit/00beb261bf02fab4a244ab5236726ef4980c1370) Thanks [@Docker-Hunterpedia](https://github.com/Docker-Hunterpedia)! - Assignment, merge and split, spam, time tracking and CSAT, contact identity and retention (M1-07, M1-09, M1-11, M1-12, M1-13, M1-14, [#73](https://github.com/Docker-Hunterpedia/Helpdock/issues/73)). Round-robin and skill-based assignment with load caps and auto-unassign; merge with a 24-hour unmerge, and split; spam with a sender block list; time entries and single-use CSAT rating links; verified-only contact auto-merge with duplicate suggestions and a 24-hour undo; per-brand retention with a nightly purge and contact anonymisation. MinIO for development now comes from Chainguard's public image.

- [#78](https://github.com/Docker-Hunterpedia/Helpdock/pull/78) [`00beb26`](https://github.com/Docker-Hunterpedia/Helpdock/commit/00beb261bf02fab4a244ab5236726ef4980c1370) Thanks [@Docker-Hunterpedia](https://github.com/Docker-Hunterpedia)! - The ticket state machine (M1-08, [#69](https://github.com/Docker-Hunterpedia/Helpdock/issues/69)). Every transition in DOMAIN-RULES §2.2 goes through one table, with `auto_await_on_agent_reply`, the per-brand reopen policy (`within_days`, `always`, `never`), parent–child linking for continued tickets, escalation, and the Statuses tab.

- [#78](https://github.com/Docker-Hunterpedia/Helpdock/pull/78) [`00beb26`](https://github.com/Docker-Hunterpedia/Helpdock/commit/00beb261bf02fab4a244ab5236726ef4980c1370) Thanks [@Docker-Hunterpedia](https://github.com/Docker-Hunterpedia)! - Tags, custom fields and ticket templates (M1-06, [#72](https://github.com/Docker-Hunterpedia/Helpdock/issues/72)). Brand tags in eight tints with all-of filtering; custom fields (text, number, date, select, multi-select, checkbox) on tickets, contacts and accounts, validated against each brand's own definitions; and ticket templates applied server-side with a fixed set of placeholders.

- [#78](https://github.com/Docker-Hunterpedia/Helpdock/pull/78) [`00beb26`](https://github.com/Docker-Hunterpedia/Helpdock/commit/00beb261bf02fab4a244ab5236726ef4980c1370) Thanks [@Docker-Hunterpedia](https://github.com/Docker-Hunterpedia)! - Saved views and search (M1-05, M1-15, [#74](https://github.com/Docker-Hunterpedia/Helpdock/issues/74)). Personal and shared views with the five default views and sidebar counts; ticket search through a token table (ADR 0011), so a search that matches nothing no longer reads every ticket.

- [#78](https://github.com/Docker-Hunterpedia/Helpdock/pull/78) [`00beb26`](https://github.com/Docker-Hunterpedia/Helpdock/commit/00beb261bf02fab4a244ab5236726ef4980c1370) Thanks [@Docker-Hunterpedia](https://github.com/Docker-Hunterpedia)! - The ticket workspace (M1-15, [#70](https://github.com/Docker-Hunterpedia/Helpdock/issues/70), [#74](https://github.com/Docker-Hunterpedia/Helpdock/issues/74), [#75](https://github.com/Docker-Hunterpedia/Helpdock/issues/75)). List, thread, composer, details panel, new-ticket dialog and realtime updates, with the collision indicator. Agents can tag tickets and edit custom fields from the details panel; linked tickets show by reference without revealing ones the viewer cannot open; the ticket list's index set holds 50k tickets under a 150 ms p95.

- [#78](https://github.com/Docker-Hunterpedia/Helpdock/pull/78) [`00beb26`](https://github.com/Docker-Hunterpedia/Helpdock/commit/00beb261bf02fab4a244ab5236726ef4980c1370) Thanks [@Docker-Hunterpedia](https://github.com/Docker-Hunterpedia)! - Optional `HD_SETUP_TOKEN` (at least 32 characters). When set, the first-run wizard's first step asks for it as a "Setup key" and refuses a missing or wrong key with a 403, so nobody who cannot read the server's `.env` can claim a fresh install ([#43](https://github.com/Docker-Hunterpedia/Helpdock/issues/43)).

- [#63](https://github.com/Docker-Hunterpedia/Helpdock/pull/63) [`e841ed6`](https://github.com/Docker-Hunterpedia/Helpdock/commit/e841ed6a644afebc76e0b0415b45c938672707e9) Thanks [@Docker-Hunterpedia](https://github.com/Docker-Hunterpedia)! - Tickets and messages (M1-02, M1-03). `tickets`, `ticket_messages`,
  `ticket_activity` and `ticket_statuses` arrive under department-scoped
  row-level security, with `/api/brands/:brandId/tickets` for the list, the
  thread and the activity log. Message bodies are sanitised on the way in, `seq`
  is monotonic per ticket under contention, `client_id` dedupes a retried send,
  and every mutation enqueues an outbox event that ends as a `ticket:<id>` and
  `department:<id>` socket frame.

- [#66](https://github.com/Docker-Hunterpedia/Helpdock/pull/66) [`650e6ee`](https://github.com/Docker-Hunterpedia/Helpdock/commit/650e6ee9cde600ecf451be02e58c91a78b41e177) Thanks [@Docker-Hunterpedia](https://github.com/Docker-Hunterpedia)! - Brands, departments, teams and team members (M1-01). A brand now carries
  ticketing settings (`autoAwaitOnAgentReply`, `reopenPolicy`) and can be renamed,
  relocated and retimed through `PATCH /api/brands/:brandId`; an install admin can
  add a brand with `POST /api/install/brands`, which gives it an administrator, a
  department and a working ticket sequence. Departments gain an Arabic name, an
  order and a default team, and hold teams whose members must already reach the
  department: which departments a brand *has* is `brand:manage`, what is inside
  one is `staff:manage` narrowed to the departments a Team Leader leads. The admin
  app gains **Admin → Ticketing** with the whole M1 tab row and a built
  Departments tab.

- [#60](https://github.com/Docker-Hunterpedia/Helpdock/pull/60) [`23bab64`](https://github.com/Docker-Hunterpedia/Helpdock/commit/23bab64001d0fd84860f5ed22f2108c60d45120e) Thanks [@Docker-Hunterpedia](https://github.com/Docker-Hunterpedia)! - Every `@Param`, `@Query` and `@Body` on a controller handler now names its Zod
  schema, and `pnpm check:validation` fails the build for one that does not. A
  malformed `:brandId` is refused by `brandIdParamSchema` and the response names
  the field.

### Patch Changes

- [#78](https://github.com/Docker-Hunterpedia/Helpdock/pull/78) [`00beb26`](https://github.com/Docker-Hunterpedia/Helpdock/commit/00beb261bf02fab4a244ab5236726ef4980c1370) Thanks [@Docker-Hunterpedia](https://github.com/Docker-Hunterpedia)! - Security hardening from CodeQL: remote response headers can no longer write to an object prototype, the SMTP deadline is capped at 10 seconds whatever a caller passes, and an admin asset path is proven to be inside the build before the file system is touched.
