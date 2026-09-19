# @helpdock/jobs

Queue names, job schemas, the transactional outbox relay and idempotent
consumers. Framework-free: it takes a Drizzle client, a Redis connection and a
logger, and knows nothing about NestJS. `apps/api` hosts it when it runs with
`APP_ROLE=worker`.

The contract comes from
[DOMAIN-RULES §6](../../docs/planning/DOMAIN-RULES.md#6-transactional-outbox);
the queues come from
[ARCHITECTURE §13](../../docs/planning/ARCHITECTURE.md#13-background-jobs-bullmq-queues).

**A side effect is enqueued in the same transaction as the change that causes
it, and executed at least once, idempotently.** Everything below follows from
that one sentence.

## The rule

Never call `queue.add` from a request handler, a service or an event listener. A
job added that way exists whether or not the transaction committed, which is
exactly the drift the outbox prevents. Domain code calls `enqueueOutbox` with
the transaction it is already in; the relay does the rest.

```ts
import { enqueueOutbox } from '@helpdock/jobs';

await withTenant(db, context, async (tx) => {
  const ticket = await tx.insert(tickets).values(…).returning();
  await tx.insert(ticketMessages).values(…);

  // Commits with the rows above, or not at all.
  await enqueueOutbox(tx, {
    brandId: context.brandIds[0],
    event: 'ticket.replied',
    payload: { ticketId: ticket.id },
  });
});
```

`enqueueOutbox` returns the row id. That id becomes the BullMQ job id and the
consumer's idempotency key, so it is the one handle that identifies the side
effect everywhere.

## Defining a job

Every job is declared in `src/jobs.ts`, with that module's `defineJob` helper: a
name, a queue, a Zod schema and a retry profile. The schema is the boundary — the
payload is parsed on enqueue and again on consume, and the two can never disagree
because they are the same schema.

```ts
// in packages/jobs/src/jobs.ts
export const emailSendJob = defineJob({
  name: 'email.send',
  queue: QUEUE_NAMES.outbound,
  schema: z.object({ brandId: z.uuid(), messageId: z.uuid() }),
  options: { attempts: 5, backoff: { type: 'exponential', delay: 1_000 } },
  idempotencyKey: (payload) => `email.send:${payload.messageId}`,
});
```

Every payload carries `brandId`: the worker opens its transaction for exactly
that brand (DOMAIN-RULES §1.4), and a job that needs several brands enqueues one
child job per brand rather than widening its context.

`idempotencyKey` is the natural key the consumer dedupes on — the
`ticket_message_id` for a send, `(webhook_id, event_id)` for a delivery. Leave it
out only when the job has none; the BullMQ job id then stands in, which is enough
for a redelivery of the same job but not for the same work arriving under a new
id.

M0 defines three jobs:

| Job | Queue | Notes |
|---|---|---|
| `outbox.relay` | `outbox` | The relay's identity and its 500 ms cadence. The loop runs in process — see below. |
| `outbox.event` | `outbox` | The fan-out job the relay publishes, one per outbox row. |
| `maintenance.retention` | `maintenance` | Nightly purge for one brand (DOMAIN-RULES §11). Defined here; the per-brand fan-out lands with M9. |

## Handling an event

`outbox.event` carries `{ outboxId, brandId, event, payload }`, and the
dispatcher resolves `event` to a handler. Adding a side effect is a handler,
never a new queue.

```ts
import { registerEventHandler } from '@helpdock/jobs';

registerEventHandler('ticket.replied', async ({ brandId, payload, tx, log }) => {
  // `tx` already carries the brand's tenant context. Whatever this writes
  // commits together with the job's receipt.
  await tx.insert(notifications).values({ brandId, … });
});
```

An event with no registered handler fails with a message naming the events that
are registered, retries, and ends in the failed set. `settings.changed` ships
registered, with a handler that only logs, so a fresh install has one working
path through the whole chain.

## Writing an idempotent consumer

`createWorker` validates the payload, opens `withSystem(db, brandId, …)` and
claims a `job_receipts` key before the handler runs:

```ts
import { createOutboxEventHandler, createWorker, outboxEventJob } from '@helpdock/jobs';

const worker = createWorker(outboxEventJob, createOutboxEventHandler(), {
  redis: connection,
  db,
  log,
  concurrency: 4,
});
```

What that buys:

- **The effect and the receipt commit together.** A handler that throws rolls
  back its writes *and* its receipt, so the next attempt starts from nothing. A
  handler that returns leaves both, so every later delivery of the same key stops
  at the receipt and is logged at `info` as a duplicate.
- **Throwing asks for a retry.** After `attempts` the job stays in the failed
  set, where the DLQ view will find it. The failure reason is the error message.
- **A payload that fails its schema is not retried.** It becomes a BullMQ
  `UnrecoverableError` carrying the Zod issues, so the job goes straight to the
  failed set and `job.failedReason` names the field that was wrong. A payload
  that is wrong now will still be wrong on the next attempt.

One worker serves one job name. BullMQ routes by queue rather than by name, so a
queue that carries several consumed job names needs a processor that dispatches
on `job.name`; a job of the wrong name fails unrecoverably rather than being
handled by the wrong code.

## The relay

`startOutboxRelay` runs a loop, not a BullMQ job: `LISTEN outbox` needs a
connection it can hold, which a job that starts and ends cannot. Each cycle:

1. Read every brand id from `brands`. That table is global (DOMAIN-RULES §1.3),
   so the read needs no tenant context — which is what breaks the circle, since
   a tenant context cannot be built without knowing the brands and the brands
   cannot be read from a tenant table without one.
2. In batches of 50 brands, ask which of them have unpublished rows. This is the
   relay's one multi-brand statement: a system path that reads `brand_id` from
   `outbox` and nothing else, so that the publishing below can run one brand at a
   time.
3. Per brand with work, in a single transaction: take
   `pg_try_advisory_xact_lock` on the brand (a second replica stands down rather
   than waits), select up to `batchSize` unpublished rows in id order, `add` one
   BullMQ job per row with `jobId = outbox.id`, and stamp `published_at`.

Then, if a `status` store was given, write the cycle to Redis under
`hd:relay:last` — when it ran, how long it took, how many rows were waiting and
how many were published. That key is what `/metrics` and the admin System page
read: the relay is the one component that may look at every brand's `outbox` at
once (its discovery statement above), so it reports rather than being asked, and
an api replica never has to widen its tenant context to answer "how big is the
backlog?". A failed write is logged and dropped; publishing a heartbeat must
never be able to stop the relay.

Then wait for a `LISTEN outbox` notification or `pollIntervalMs`, whichever comes
first. The notification is latency; the poll is the guarantee, so a lost
subscription makes the relay slower and never wrong. A brand that fills its batch
makes the relay cycle again at once instead of sleeping.

### What it guarantees

| Case | Outcome |
|---|---|
| The transaction rolls back | The row was never committed, so nothing is ever published. |
| The relay dies after the `add`, before the commit | The row stays unpublished. The next cycle adds the same `jobId`, which BullMQ ignores. One job. |
| The relay dies after the commit | The row is published, the job is in Redis. Nothing to do. |
| Two replicas relay the same brand | The advisory lock lets one through; the other publishes nothing. |
| Redis is lost | Every unpublished row is republished; anything already published and lost is why consumers are idempotent (DOMAIN-RULES §10). |
| A job is delivered twice | The receipt stops the second one. |

`jobId` deduplication only holds while the job is still in Redis, so it covers
the crash window and no more. `job_receipts` is what makes the guarantee hold
beyond it.

Because the `add` happens inside the transaction, a job can be added twice and a
row can never be lost. That is the trade the outbox is built on, and it is why
every consumer must be idempotent.

## What the worker host wires at boot

With `APP_ROLE=worker`, after migrations have run:

```ts
const connection = createQueueConnection(env.REDIS_URL);

// 1. Register a handler for every event this deployment consumes.
registerEventHandler('ticket.replied', …);

// 2. Consume the fan-out job.
const worker = createWorker(outboxEventJob, createOutboxEventHandler(), {
  redis: connection,
  db,
  log,
});

// 3. Run the relay. `status` is the same connection: BullMQ owns its own client
//    and does not lend it out, so the heartbeat needs one it can use.
const relay = startOutboxRelay({
  db,
  redis: connection,
  status: connection,
  log,
  listenUrl: env.DATABASE_URL,
});

// On shutdown, in this order:
await relay.stop();
await worker.close();
await connection.quit();
```

`createQueueConnection` sets `maxRetriesPerRequest: null`, which BullMQ requires
of a connection a worker blocks on.

Leaving `status` out is allowed: the relay runs exactly as before and the System
page says the worker has not reported.

Registering handlers before starting the worker matters: a job that arrives
before its handler is registered fails as an unknown event and burns attempts.

## Retention

DOMAIN-RULES §11 keeps outbox rows and receipts for seven days:

```ts
await withSystem(db, brandId, (tx) => purgePublishedOutbox(tx, olderThanDays));
await purgeReceipts(db, olderThanDays);
```

`purgePublishedOutbox` takes a transaction because `outbox` is a tenant table and
row-level security is what keeps it to one brand; `purgeReceipts` takes either,
because `job_receipts` is global. Keep the receipt window comfortably longer than
the longest retry schedule: deleting a receipt while a delivery of its job can
still arrive would let that delivery run a second time.

## Tests

Unit tests cover the definitions, payload validation, key derivation, the
dispatcher and the pure parts of the relay. The guarantees in the table above are
proved in `src/*.integration.test.ts` against a real Postgres and a real Redis
through Testcontainers, including a relay killed between the `add` and the
commit, two relays racing on one brand, and a brand that cannot see another
brand's rows.

```bash
pnpm --filter @helpdock/jobs test
pnpm test:integration packages/jobs     # needs Docker
```
