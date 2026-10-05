# 0024 Agent assist calls the model between short transactions, not inside the request's

Status: accepted
Date: 2026-10-05

## Context

Every request runs inside one transaction that the `TenantInterceptor` opens with the `app.*` settings row-level security reads ([ARCHITECTURE §6](../planning/ARCHITECTURE.md), [DOMAIN-RULES §1.3](../planning/DOMAIN-RULES.md#13-enforcement-layers)). Agent assist (M7-05) answers an agent who clicked "Suggest reply" and waits for the text: the request has to read the ticket under the agent's own department policy, call a model that takes seconds, and answer. The AI guide already says `complete()` must not run inside a request's transaction — a held connection and open snapshot for the length of a model call would drain the pool on a busy desk — and AGENTS.md routes side effects through the outbox.

Assist changes nothing a customer sees: it reads, asks a model, and returns text to the agent who asked. The outbox exists to keep a side effect from outliving a rolled-back domain change; there is no domain change here to roll back, and putting the call on a queue would turn a two-second answer into a poll or a socket round trip for no safety gained.

## Decision

**A route may declare `@StepTransactions()`.** The interceptor then resolves the same tenant context it would have used — the route's brand, the principal's departments, the principal — stores it on the request context, and opens no transaction. The handler opens one short transaction per step with `inRequestTenant(db, fn)`, each under that context and therefore under row-level security exactly as before:

1. read and authorise: the ticket (a ticket in another department is not found), the brand's assist mode, the budget;
2. no transaction: retrieval (which opens its own system transaction for the knowledge base) and `complete()`, whose ports log the call in their own short transactions;
3. only when the request stores something (suggested fields): one more transaction for the write.

Only brand-scoped routes may use it, and only the assist routes do. Proposals, dismissing a suggestion, redactions and transcripts call no model and keep the whole-request transaction.

AI work that is a side effect of a domain change — a rule's AI triage (M7-07), a voice note's transcription (M7-09) — still goes through the outbox and a BullMQ job on the `ai` queue.

## Consequences

- A model call holds no connection and no snapshot; a slow provider slows one agent, not the pool.
- The steps are not atomic with each other. The assist routes write at most once, after the model has answered, so there is nothing half-done to roll back; a route that needs several writes to agree must not use step transactions.
- The tenant guarantees are unchanged: every query still runs in a transaction carrying the request's `app.*` settings.

## Alternatives considered

- **Queue every assist call and push the answer over the ticket's socket.** Correct but slower and more moving parts for an answer only the requester reads, and the agent's click would no longer be a request that fails with a reason.
- **Commit early inside the handler.** Nest's interceptor owns the transaction; committing it from a service would hide the boundary in code nobody reads as a boundary.
- **Call the model inside the request transaction.** Simplest, and what the AI guide forbids for the reason above.
