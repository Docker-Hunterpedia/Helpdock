# 0020 Knowledge ingest and retrieval: heading-bounded chunks, a visibility filter before both rankers, reciprocal rank fusion with a locale boost

Status: accepted
Date: 2026-10-05

## Context

M7-03 reads a brand's knowledge — help center articles, uploaded files, crawled sites, Notion, Google Drive — into `knowledge_chunks`, and M7-04 retrieves from it for assist, auto-reply and help center search ([ARCHITECTURE §10](../planning/ARCHITECTURE.md#10-ai-subsystem), [DOMAIN-RULES §5](../planning/DOMAIN-RULES.md#5-knowledge-visibility)). ARCHITECTURE fixes the outline ("by headings, ~500 tokens, overlap 60", "pgvector + tsvector with reciprocal rank fusion and locale boost") but not:

- how tokens are counted when every model family tokenises differently;
- whether a chunk may span headings or pages;
- where the audience filter sits, given two rankers;
- how two rankings with incomparable scores become one, and how strongly the reader's language counts;
- how a sync that takes minutes relates to transactions, and when it may delete what it did not see.

## Decision

**Chunks never cross a heading or a part.** Every loader hands the chunker a title and parts (a PDF page, or the whole text) in a light Markdown. Each part is split at its headings; a section is cut into paragraphs, a paragraph too long into sentences, a sentence too long into runs of words; units are packed greedily up to 500 tokens, and each chunk after the first of a section opens with the last 60 tokens of the one before (whole units when they fit, otherwise the last words). Every chunk opens with its heading path (`Billing › Refunds`). A heading changes the subject and a page number is a citation, so a chunk that straddled either would cite badly.

**Tokens are estimated:** one per four characters of each word, at least one. No tokenizer dependency, the same answer in every process, and the budget only has to keep a chunk well inside any embedding model's input.

**Locale per chunk:** Arabic when at least 30 % of its letters are Arabic, since Arabic support text quotes Latin product names and codes. The locale picks the `arabic` or `english` full-text configuration of the generated `search` column, and drives the boost below.

**The audience filter is in both rankers' `WHERE`.** `visibleChunks(audience)` is the first condition of the vector query and of the full-text query, before either orders, and again when the top chunks are read back. For visitors an article chunk takes part only by joining its live article version (published, public, help center not internal-only), and any other chunk needs its own label and its source's live visibility to be `public`. A test asserts the clause in the generated SQL; an integration test asserts the best-matching internal chunk never reaches a visitor.

**Reciprocal rank fusion, k = 60, then a locale boost of × 1.25.** Each ranker returns its best 50; a chunk scores `1 / (60 + rank)` per list, summed, which needs no calibration between a cosine distance and a `ts_rank`. A chunk in the reader's language is multiplied by 1.25: enough to put the Arabic version of an article above the English one at neighbouring ranks, not enough to lift a weak Arabic match over a strong English one. The help center search keeps its own RRF (k = 60) and gains a semantic source beside its lexical one, which joins the readable article versions the same way and counts only chunks within cosine distance 0.6.

**Vector only from the active model, full text always.** Vector ranking runs only while the embedding space is `ready` and only over rows in its active model (ADR 0005); otherwise, or when the embeddings endpoint fails, retrieval is full text alone and says so.

**A sync is many short transactions.** `knowledge.sync` claims the source (a claim older than two hours is a dead worker's and may be taken over), writes each document in its own transaction — unchanged content is skipped by hash — and embeds new chunks outside any transaction. Documents the run did not see are removed only when the loader finished; a crawl cut short by an error never empties the source. A failure is recorded on the source and in its log, and the job completes, so BullMQ does not retry a revoked token or a blocked address.

**Articles sync in the event's transaction.** The `knowledge` subscriber of the `help_center.*` events rewrites the article's chunks in the outbox handler's transaction, like the search index, and adds `knowledge.embed`.

## Consequences

- The estimate overshoots English slightly and undershoots dense scripts; chunks stay well inside every embedding model's window either way. A real tokenizer can replace `estimateTokens` without touching anything else.
- Short sections make short chunks. Retrieval does not mind; a document of many one-line headings costs more rows.
- The 1.25 boost and the 0.6 distance cut-off are tuned by the evaluation set of DOMAIN-RULES §9 (M7-11), not by this ADR.
- A source's chunks hold its visibility as a copy, re-labelled in the same transaction as the change, and the retrieval SQL checks the live source and article too, so a stale copy cannot leak.
