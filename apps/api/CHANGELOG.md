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
