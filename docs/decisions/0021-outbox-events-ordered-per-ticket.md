# 0021 Run outbox events concurrently, ordered per ticket

Status: accepted
Date: 2026-10-05

## Context

`outbox.event` is one queue for every side effect, and the worker consumed it
with BullMQ's default concurrency of one. `perf:realtime` (M9-03) showed what
that costs: at five agent replies a second the queue backed up and an agent's
reply took 4.9 s at p95 to reach the visitor
([performance](../guides/performance.md#what-the-realtime-runs-showed)).

Raising the concurrency was held back because nobody had checked what the
handlers assume. Reviewing them (SLA, rules, notifications, email, Telegram,
widget relay, assignment, CSAT, help center, attachments):

- They assume **two events of one ticket never run at once and run in the order
  they were written**: the widget relay sends a ticket's frames in `seq` order,
  `sla.schedule` re-plans one ticket's timers from its clocks, the rules
  subscriber hands one ticket's changes to `rules.evaluate` in turn.
- They do **not** assume a global order. Events of different tickets share
  nothing a handler does not lock for itself: assignment takes a brand-level
  advisory lock, merges lock both tickets' rows, email and Telegram sends are
  already their own queues with concurrency above one.

BullMQ's group keys, which would express exactly this, are a BullMQ Pro feature
and outside the stack table.

## Decision

Give each event **ordering keys** — every ticket its payload names
(`ticketId`, `…TicketId`, `…ticketIds`), or its brand when it names none — and:

1. **In the process**, chain each job behind the last one that shares a key,
   in the order the worker took them, which is relay order
   (`createKeyedSerializer`, `createWorker`'s `serialize` option). Different
   tickets run side by side up to `OUTBOX_CONCURRENCY` (default 8).
2. **Across worker processes**, take a transaction-level advisory lock per key,
   sorted, before any subscriber runs (`lockOrderingKeys` in
   `createOutboxEventHandler`), so two replicas never run events of one ticket
   at the same moment.

A job waiting on its key holds a concurrency slot but no database connection:
the wait is before the transaction opens.

## Consequences

- Per-ticket order within one worker is what it was with one consumer, and is
  proved by `packages/jobs/src/consumer.integration.test.ts`, which fails with
  the serializer turned off. Between replicas the guarantee is mutual
  exclusion; order is BullMQ's fetch order, as it always was.
- A retried event still goes back with a delay while later events of its ticket
  run, as before. Handlers read current state rather than the event's, which is
  what makes that harmless.
- Events that name no ticket keep their old brand-wide order among themselves.
- One hot ticket can occupy every slot with events waiting on each other; the
  install is then as fast as it was before, not slower.

## Alternatives considered

- BullMQ Pro groups: the right primitive, but a commercial edition outside the
  stack table.
- One queue per shard of tickets, each with concurrency one: the same ordering,
  but N queues for the System page, Bull Board and the relay to know about.
- A separate fast path for socket frames only: it fixes the realtime number and
  leaves SLA, rules and notifications as slow as before.
