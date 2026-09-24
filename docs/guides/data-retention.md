# Data retention

How long a brand keeps its data, how the nightly purge removes the rest, and
what erasing one person does (M1-14,
[DOMAIN-RULES §11](../planning/DOMAIN-RULES.md#11-data-lifecycle)).

## The windows

Each brand sets its own windows on **Admin → Brand → Danger zone**, in the Data
retention card. Only an Admin sees the page and only an Admin may change it
(`brand:manage`).

| Data | Default | Range | What the purge does |
|---|---|---|---|
| Closed tickets and their messages | **Forever** | Forever, or 1 to 3650 days after close | Hard-deletes the ticket, its messages, activity, tags and attachments, and queues the attachments' objects for deletion from the bucket |
| Spam tickets | **30 days** | 1 to 3650 | The same hard delete, on its own clock |
| AI call logs | **90 days** | 1 to 3650 | Stored only. `ai_calls` arrives with M7, which adds the purge |
| Help center search log | **180 days** | 1 to 3650 | Stored only. The search log arrives with M5 |
| Audit log | **730 days** | **90** to 3650 | Hard delete |
| Visitor sessions with no conversation | **30 days** inactive | 1 to 3650 | Stored only. Visitor sessions arrive with M4 |
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
forever, or a table that does not exist yet.

### What counts as closed, and as spam

- A **closed ticket** is one with `closed_at` older than the window: `closed_at`
  is set the first time a ticket enters a closed state and cleared on reopen.
  Merged tickets are closed tickets.
- A **spam ticket** is one in the brand's Spam status, found by
  `ticket_statuses.is_spam` rather than by name, because a brand may rename it.
  Spam is never purged by the closed-ticket window, only by its own.

## The nightly run

```
03:00 UTC  maintenance.retention.schedule   one job per brand, then job_receipts
           maintenance.retention (brand)    closed, spam, audit log, outbox → audit row
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

## API

| Route | Permission | |
|---|---|---|
| `GET /api/brands/:brandId/retention` | `brand:manage` | The windows, the "next purge" counts and the last run |
| `PUT /api/brands/:brandId/retention` | `brand:manage` | The whole form. 400 for a missing field, a window outside its range or an audit log under 90 days |

Both answer `{ settings, preview, lastRun }`, as `retentionOverviewSchema` in
`@helpdock/schemas` declares.

## Known gaps

- AI call logs, the help center search log and visitor sessions are stored but
  not purged: their tables do not exist yet. The milestone that creates each one
  adds its cutoff to `apps/api/src/retention/retention-rules.ts` and its purge to
  `retention.job.ts`.
- Composer uploads that were never sent (`message_id` still null) are not swept.
  They are deleted with their ticket.
- Brand deletion (the other half of the Danger zone) is its own deliverable.
