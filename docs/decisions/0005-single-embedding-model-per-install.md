# 0005 One embedding model per install, with no per-brand override in v1

Status: accepted
Date: 2026-09-18

## Context

Helpdock stores knowledge as chunks with vector embeddings in PostgreSQL with pgvector, and merges semantic results with full-text and trigram search ([ARCHITECTURE §1](../planning/ARCHITECTURE.md#1-stack-at-a-glance), [REQUIREMENTS §4.5](../planning/REQUIREMENTS.md#45-help-center)). One deploy serves many brands. The open question was whether each brand chooses its own embedding provider and model, or the install chooses one for all of them.

Three facts decide it.

A `vector` column has exactly one dimension. `knowledge_chunks.embedding` is `vector(<dims>)`, so a single table cannot hold 768-dimension and 3072-dimension vectors at once. pgvector's HNSW and IVFFlat indexes additionally cover vectors up to 2,000 dimensions; the `vector` type itself goes to 16,000, but an unindexed column is not a search index.

Vectors from two different models are not comparable even when their dimensions happen to match. Ranking a chunk embedded by model A against a query embedded by model B does not produce a worse result — it produces a meaningless one. Anything that lets two models coexist in one ranked result set is a correctness bug.

And the operator we are designing for configures one LLM provider in the first-run wizard. Asking them to configure embeddings again per brand multiplies the setting most likely to be misconfigured, on the feature where misconfiguration is hardest to notice — bad retrieval looks like a merely unhelpful answer.

This ADR records the policy already stated in [DOMAIN-RULES §8](../planning/DOMAIN-RULES.md#8-embeddings-policy), which noted that it was pending an ADR.

## Decision

One embedding provider, model and dimension per install, held in `settings` as `embedding.provider`, `embedding.model` and `embedding.dims`. There is no per-brand override in v1.

The `knowledge_chunks.embedding` column and its HNSW index are created by the `knowledge.configure` job when the model is first saved, not by a static migration, so the dimension follows the chosen model instead of being guessed at schema-design time.

Every chunk stores the `embedding_model` it was produced by, and every retrieval filters `embedding_model = <current>`. Vectors from two models are therefore never ranked together, even in the window where both exist and even if their dimensions agree.

Changing the model is an explicit admin action that enqueues `knowledge.reembed`. It sets `ai.retrieval_status = reindexing` — auto-reply and suggestions fall back to full-text only, with a banner in admin — drops the index, alters the column to the new dimension, re-embeds every source in order, rebuilds the index, and flips the status back. A failed re-embed leaves the status at `reindexing` and never serves mixed results.

Models above 2,000 dimensions are rejected at configuration time with an explanation, rather than accepted and then failing at index build.

## Consequences

- One column, one index, one retrieval code path. Ranking does not branch on brand, and the tenancy predicate stays the plain `brand_id` filter that row-level security already enforces. Fewer moving parts in the code path where a mistake leaks one brand's internal knowledge into another brand's answer.
- Brands cannot tune retrieval quality independently. An install serving one Arabic brand and one English brand picks a single multilingual model for both. This is a real limitation and we accept it for v1: the alternatives cost more, in schema and in operational risk, than the quality they would buy.
- Changing the model is expensive and deliberately visible. It re-embeds every chunk of every source of every brand, it costs provider tokens, and for its duration AI answers and suggestions are full-text only. Per-source progress makes the wait legible, but this is not an operation to perform casually and the documentation says so.
- Storing `embedding_model` on every chunk costs a little space and buys the guarantee outright. It also makes a partial or interrupted re-embed inspectable: you can see exactly which sources have moved and which have not.
- The 2,000-dimension index ceiling rules out some larger models. pgvector offers half-precision vectors (indexable to 4,000 dimensions) and binary quantisation (to 64,000) as ways past it. We are not using either in v1, so the ceiling is a hard validation error at configuration time rather than a surprise later.

## Alternatives considered

- **Per-brand model, with per-brand chunk tables or a partitioned table per dimension.** Rejected. It multiplies schema by tenant, so the RLS policy, the migration story and the negative test suite in [DOMAIN-RULES §1.6](../planning/DOMAIN-RULES.md#16-required-negative-tests) all get harder at exactly the point where they must stay simple. HNSW indexes are memory-hungry, and one per brand on the modest hardware a self-hoster runs is the wrong trade. Worst of all it makes "add a brand" a DDL operation, which the tenancy model exists to avoid.
- **Several embedding columns on one table, one per supported dimension, chosen by brand at query time.** Rejected. Every row pays storage for the columns it does not use, every index is maintained whether or not anything uses it, and the ranking code gains a branch that is only ever exercised on the minority of installs that configured two models — which is the worst kind of code to keep correct, because it is rarely run and silently wrong when it breaks.
- **Fix the dimension at 1536 and accept only models that match.** Rejected. It writes one vendor's current shape into our schema, and it already excludes reasonable models in both directions — smaller multilingual models and larger ones alike. Deriving the dimension from the configured model costs one job at configuration time and keeps the choice open, including for models that do not exist yet.
