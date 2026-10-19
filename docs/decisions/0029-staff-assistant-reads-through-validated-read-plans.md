# 0029 The staff assistant panel reads through validated read plans, not tool calls

Status: proposed
Date: 2026-10-20

## Context

M12-13 ([plan](../in-development/M12-ai-workspace.md)) adds a staff assistant
panel that answers questions about the queue ("Which tickets breach SLA in the
next hour?"), explains a ticket and pulls report figures. To answer, it has to
read tickets, knowledge and figures the asking user may see, and nothing else.

1.0's rule is "No tool calls or actions in v1. The model reads knowledge and
writes text" (REQUIREMENTS §4.7, AGENTS.md), enforced by `assertNoTools` in
`complete()`. M13 lifts the rule with a written contract (ADR 0032), but M12
must ship without it. M7-07 triage already shows the pattern that fits: the
model answers JSON, and Helpdock's own code validates it and acts on it.

## Decision

1. A panel turn is two model calls through `complete()`, with no tools:
   - **plan**: the model returns a read plan, JSON validated by Zod against a
     closed list of reads (tickets by filters and text, at most 50; one
     ticket's thread and fields; the ticket's summary; SLA due within N hours;
     unassigned older than N; team workload; knowledge with the staff audience;
     report figures), each with bounded arguments;
   - **answer**: Helpdock runs the reads, and the model answers over what was
     read, citing tickets as `#HD-1042` links and articles.
2. Each read runs in a transaction carrying the asking user's own `app.*`
   settings, after a permission check for that read (`report:read` for figures,
   `ticket:read` for tickets, staff audience for knowledge). A read the user may
   not make is dropped, and the answer says it could not look.
3. The model never names a table, a SQL fragment or a URL, and never receives a
   row the user could not open in the admin. Read results are redacted before
   the answering call.
4. The panel writes nothing but its own turns (`assistant_threads`,
   `assistant_turns`, owner-scoped so no one else, an Admin included, reads
   them) and `ai_calls`. `assertNoTools` stays.

## Consequences

- One extra model call per turn; its cost is shown per turn.
- No multi-step exploration: a question that needs a second round of reads gets
  the best answer one plan allows.
- M13 replaces the planner with a tool loop over the same reads, so the read
  catalogue and its permission checks carry over.
- Isolation is provable: the department negative tests extend to the panel, and
  an integration test asserts on the logged, redacted prompt that an Agent's
  panel never received another department's ticket. The eval adds a "panel
  answers citing a ticket outside the reader's scope" measure with a threshold
  of 0.

## Alternatives considered

- **Read-only tool calls now**: would break the 1.0 rule before the M13
  contract (ADR 0032, DOMAIN-RULES §19) exists.
- **Search only, no model**: answers "find tickets" but loses "explain this
  queue" and "explain this ticket".
