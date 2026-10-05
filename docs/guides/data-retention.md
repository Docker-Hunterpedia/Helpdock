# Data retention

How long a brand keeps its data, how the nightly purge removes the rest, what
erasing one person does (M1-14), and how a whole brand is deleted (M8-07,
[DOMAIN-RULES §11](../planning/DOMAIN-RULES.md#11-data-lifecycle)).

## The windows

Each brand sets its own windows on **Admin → Brand → Danger zone**, in the Data
retention card. Only an Admin sees the page and only an Admin may change it
(`brand:manage`).

| Data | Default | Range | What the purge does |
|---|---|---|---|
| Closed tickets and their messages | **Forever** | Forever, or 1 to 3650 days after close | Hard-deletes the ticket, its messages, activity, tags and attachments, and queues the attachments' objects for deletion from the bucket |
| Spam tickets | **30 days** | 1 to 3650 | The same hard delete, on its own clock |
| AI call logs | **90 days** | 1 to 3650 | Nulls the prompt, response, redaction map and sources of older `ai_calls` rows and stamps `bodies_purged_at`. The row stays with its tokens, cost, latency and prompt hash, for reports and the budget meter (M7) |
| Help center search log | **180 days** | 1 to 3650 | Hard-deletes the search log (M5-05) and, in the same window, the article view rows that dedupe view counts (M5-08). The count is the search log's |
| Audit log | **730 days** | **90** to 3650 | Hard delete |
| Visitor sessions with no conversation | **30 days** inactive | 1 to 3650 | Hard-deletes inactive `widget_visitors` only when no ticket references them; a visitor with a conversation keeps its session |
| Notification rows | **30 days** | fixed | Hard-deletes rows older than the bell's display window |
| Outbox rows and job receipts | 7 days | fixed | Hard delete, 7 days after publish or completion |

A brand that never saves the form is kept under the defaults. The form sends
every window at once (`PUT`), and the api refuses a body that leaves one out,
so a screen that predates a field can never reset it by omission.

Every save writes a `retention.updated` audit row with the windows before and
after, in days.

### "Next purge"

The third column is how many rows the next run would remove under the **saved**
windows. It is counted with the same conditions the job deletes by, so it is
the number that goes. "—" means there is nothing to count: closed tickets kept
forever, or a table that does not exist yet. For AI call logs it is the number
of rows whose bodies would be nulled.

### What counts as closed, and as spam

- A **closed ticket** is one with `closed_at` older than the window: `closed_at`
  is set the first time a ticket enters a closed state and cleared on reopen.
  Merged tickets are closed tickets.
- A **spam ticket** is one in the brand's Spam status, found by
  `ticket_statuses.is_spam` (generated from `system_key = 'spam'`) rather than by name, because a brand may rename it.
  Spam is never purged by the closed-ticket window, only by its own.

## The nightly run

```
03:00 UTC  maintenance.retention.schedule   one job per brand, then job_receipts
           maintenance.retention (brand)    closed, spam, AI call bodies, search log and views,
                                            audit log, idle visitors, notifications, outbox → audit row
```

The worker registers the schedule on every boot, so a Redis that lost it gets
it back. Each brand's run is a job of its own, with the id
`maintenance.retention.<brandId>.<YYYY-MM-DD>`, so a tick that fires twice in
one night adds nothing the second time.

- **One brand at a time, one brand per transaction.** Every statement runs as
  the system principal of that brand alone, so row-level security keeps a run
  inside its brand.
- **Bounded batches.** Each batch is at most 500 rows in a short transaction of
  its own. A brand with a year of backlog is many short purges, never one long
  lock on `tickets`.
- **Idempotent.** Every purge is "delete what is older than the cutoff". A
  retried or repeated run finds fewer rows and removes nothing twice.
- **Objects follow their rows.** A batch reads its attachments' keys, deletes
  the tickets, and writes a `media.objects.purge` outbox row with the keys in
  the same transaction. The worker then deletes each object. A purge that rolls
  back deletes no bytes, and an object whose delete failed is retried with the
  outbox job.
- **Counts only.** Each run ends with a `retention.purged` audit row naming the
  job and carrying how many rows went per category, never an id or a value. The
  same counts are shown in the card's footer as the last run.

Anything that hangs off a ticket goes with it by `ON DELETE CASCADE`. A new
table with a foreign key to `tickets` must cascade (or set null); the retention
integration suite fails otherwise.

## Erasing one person

Erasure is immediate and not subject to these windows. It is "Anonymise" on the
contact page, and [the contacts guide](contacts.md#erasure) describes it in
full. What it removes from tickets:

- **Attachments they sent**, both the ones they uploaded and any attachment on a
  message they wrote. Rows are deleted in the erasure's transaction and the
  objects are queued the same way as a purge.
- **Channel ids of their messages** (`external_message_id`: an email
  `Message-ID` names the sender's mail host). The message bodies stay, under the
  brand's retention.

## Deleting a brand

An install admin deletes a brand; a brand's own Admin cannot, because a brand
is the tenant boundary and deleting one removes everybody's work in it.

In the admin it is **Brand › Danger zone › Delete this brand**: type the
brand's ticket prefix (`HD` for `HD-1042`) and "Delete brand". The page then
shows "Scheduled for deletion on …" with **Restore** on every tab, and every
tab is read-only until the brand is restored. The brands in their grace are
also listed on **System › Brands pending deletion**, with the days left and
Restore ([operations](operations.md#the-system-page)).

1. **Asking.** `POST /api/install/brands/:id/deletion` with the brand's prefix
   typed out (`{ "confirmPrefix": "ACME" }`) sets the brand to `deleting` and
   starts a **30-day grace**. From that moment:
   - every public route of the brand answers **410 Gone** — the widget, the
     help center (on its own domain and under `/hc/<brandId>/`), its images and
     the web form — through one guard on every `@Public()` route, so a public
     route added later is covered too;
   - inbound mail stops: IMAP mailboxes are no longer polled, and the
     inbound-parse endpoint answers 410 once the shared secret checks out;
   - staff sessions stop naming the brand at their next refresh (at most ten
     minutes), as for any brand that is not active;
   - nothing is deleted yet, which is what makes a restore whole.
2. **Restoring.** `DELETE /api/install/brands/:id/deletion`, any time before the
   grace ends, sets it back to `active`. After the grace it answers 409.
3. **Purging.** At 04:00 UTC every night `brand.purge.schedule` adds a
   `brand.purge` job for each brand whose grace is over. The job removes:
   - **every row the brand owns**, in every table with a `brand_id` column —
     read from the database, not from a list, so a table a later migration adds
     is purged without anybody remembering it — in foreign-key order, in
     batches, as the system principal of that brand alone. Personal rows (a
     saved view, a personal canned response) are deleted in their owner's name,
     since row-level security shows them to nobody else;
   - **every object under `brands/<id>/`** in the bucket: ticket attachments
     and their variants, and the help center's article images, logo and favicon
     (`hc_media`);
   - **every Redis key with the brand's id in its name** — cached help center
     pages, rate-limit counters — except BullMQ's own, which age out on their
     queues' schedules and would corrupt a queue if pulled from under it;
   - **its custom domains**: the `brand_domains` rows Caddy's on-demand TLS
     asks about, so no new certificate is issued for them;
   - its IMAP pollers and its storage reading on the System page.

   The `brands` row stays, as `deleted`, so the **ticket prefix stays taken**:
   a new brand cannot reuse it, and an old ticket number can never name a new
   brand's ticket. Its public routes keep answering 410.

Every step is audited in install scope, where the record outlives the brand:
`brand.deletion_requested` and `brand.deletion_cancelled` name the admin, the
brand's name and prefix; `brand.purged` names the job and carries counts only —
rows per table, objects and Redis keys. A purge that dies halfway is retried and
finishes, since every step deletes what is left.

## API

| Route | Permission | |
|---|---|---|
| `GET /api/brands/:brandId/retention` | `brand:manage` | The windows, the "next purge" counts and the last run |
| `PUT /api/brands/:brandId/retention` | `brand:manage` | The whole form. 400 for a missing field, a window outside its range or an audit log under 90 days |
| `GET /api/install/brands/:id/deletion` | `install:admin` | Where the brand is in its deletion |
| `POST /api/install/brands/:id/deletion` | `install:admin` | Starts the grace. 400 unless `confirmPrefix` is the brand's prefix, 409 if it is already being deleted |
| `DELETE /api/install/brands/:id/deletion` | `install:admin` | Restores the brand. 409 once the grace is over |

The retention routes answer `{ settings, preview, lastRun }`, as
`retentionOverviewSchema` in `@helpdock/schemas` declares; the deletion routes
answer `{ brandId, status, requestedAt, purgeAfter }` (`brandDeletionSchema`).

## Known gaps

- Composer uploads that were never sent (`message_id` still null) are not swept.
  They are deleted with their ticket.
- Brand deletion has its api and its job; the Danger zone's "Delete brand"
  button waits for its artboard.
- A CSAT rating link mailed before the deletion still opens during the grace.
  It names no brand in its address, so the 410 guard cannot see one; the purge
  removes the survey it points at.
