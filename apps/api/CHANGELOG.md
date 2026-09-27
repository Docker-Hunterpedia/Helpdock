# @helpdock/api

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
