# 0028 The AI workspace runs the production path dry

Status: proposed
Date: 2026-10-20

## Context

M12 AI workspace ([plan](../in-development/M12-ai-workspace.md)) gives the
people who run a brand's assistant a playground to try it, saved tests that
re-check it after every settings change, and a review queue that turns a bad
answer into a Q&A snippet. In 1.0 the only way to see how auto-reply answers is
to wait for a customer, read the AI log, or read the nightly eval report, which
measures Helpdock's fixture knowledge base, not the brand's own.

A playground or a test is only worth trusting if it measures what customers
get. It must also never send anything, touch a ticket or enqueue an outbox
event, and it must stay inside the 1.0 rule that the model reads knowledge and
writes text (REQUIREMENTS §4.7). The eval harness already calls the production
generation path, `generateAutoReply`, with a synthetic conversation.

## Decision

1. The playground (M12-04) and saved tests (M12-05) call `generateAutoReply`,
   the same function auto-reply uses, with `audience: 'visitor'`, a synthetic
   conversation and an in-memory **settings overlay** (unsaved Writing,
   Guardrails, Instructions, persona fields, threshold, another discovered
   model). There is no second "simulate" pipeline.
2. They write nothing but `ai_calls` rows (features `playground.reply`,
   `tests.reply`, `tests.grade`, no ticket, `actor_user_id` set) and their own
   rows (`ai_test_runs`, `ai_test_results`). No `tickets`, `ticket_messages` or
   `outbox` row is written; an integration test asserts it.
3. Test runs are an `ai.test_run` job on the `ai` queue, enqueued through the
   outbox. `mentions` and `not_mentions` expectations are graded by the eval
   judge (`packages/ai/src/eval/judge.ts`) in one call per test; the other
   expectations are mechanical checks on the decision.
4. Brand tests are regression checks for a brand's own setup. The CI eval
   (DOMAIN-RULES §9) stays the release gate.
5. Q&A snippets written by "Improve answer" are a knowledge source kind
   (`snippet`), one source per brand, not a second retrieval path. Their
   visibility follows DOMAIN-RULES §5, filtered in SQL before ranking.
6. Playground and test runs count toward the brand budget and are refused at
   the hard stop (owner decision D-07).

## Consequences

- What a brand sees in the playground is what a customer would get with those
  settings, model and knowledge, including handoff and decline decisions.
- Playground and tests spend real money; estimates are shown (M12-08) and both
  are rate-limited (30 playground requests per user per minute; 20 test runs
  per brand per hour).
- A green test list says the brand's own checks pass on the configured model.
  The Overview links the CI eval report and names the model it measured, so the
  two are not confused.
- `generateAutoReply` must accept an overlay without reading it back from the
  database, which shapes its signature.

## Alternatives considered

- **A sandbox brand** that copies the brand's knowledge and settings: copies
  drift, double the storage, and a second brand complicates RLS for no gain.
- **A separate "simulate" pipeline**: would measure something other than what
  customers get, and would drift from production with every auto-reply change.
