# 0011 Search tickets through a token table, not through `LEAKPROOF` wrappers

Status: accepted
Date: 2026-09-25

## Context

The ticket list's free-text search (`q`) cannot use its GIN indexes under `FORCE ROW LEVEL SECURITY`. Postgres only uses a condition as an index condition ahead of a row-level security policy when the condition's operator is `LEAKPROOF`, and neither `@@` (`ts_match_vq`) nor `<%` (`word_similarity_op`) is. So a search is evaluated row by row over the visible tickets until a page is full. A common term is cheap; a term that matches nothing reads every visible ticket — about 257 ms for an Admin at 50k tickets, measured by M1-15's benchmark ([tickets guide, Search under row-level security](../guides/tickets.md#search-under-row-level-security)). The 150 ms exit criterion covers the list, not search, so this does not block M1, but it will get worse as brands grow.

There are three ways out:

1. **Wrap the operators in functions marked `LEAKPROOF`.** Needs a superuser at migration time, and `LEAKPROOF` is a promise that the function can never raise an error or otherwise signal anything about its arguments. `ts_match_vq` and the trigram code can raise (malformed queries, memory limits), so the promise would be false. A false `LEAKPROOF` is a hole in the tenancy model, not an optimisation.
2. **A `SECURITY DEFINER` search function that bypasses RLS** and re-applies brand and department scope itself. It works, but it moves isolation for the busiest read in the product from the policy, which every table shares and the negative suite proves, into hand-written SQL that only this function has.
3. **A token table.** `ticket_search_tokens (brand_id, department_id, ticket_id, token)`, one row per distinct lexeme of a ticket's subject and first message, under the same `FORCE`d brand and department policies as every ticket child table and moved by `helpdock_ticket_department_moved`. A search becomes `token = ANY($lexemes)` on a btree index. `=` on `text` (`texteq`) is `LEAKPROOF`, so the index is used ahead of the policy, and isolation stays in the policy.

## Decision

Option 3. The lexemes come from `to_tsvector(<brand language config>, …)` so stemming matches today's full-text search; the table is maintained by a trigger on `tickets` and on the first `ticket_messages` row, in the same transaction as the write. All-of semantics (every lexeme of the query must match) are a `GROUP BY ticket_id HAVING count(*) = n` over the index, then the usual keyset order. The fuzzy (trigram) half stays as a fallback that runs only when the exact half returns fewer than a page, and only for terms of three or more characters, so its row-by-row cost is paid for misspellings rather than for every search.

The table joins `TENANT_TABLES` and the negative suite of DOMAIN-RULES §1.6. The two existing GIN indexes stay: owner-role paths (install-admin tools, the benchmark's `EXPLAIN`) still use them.

Implementation is scheduled with M1-15 part 2, which also owns the list's search box, and the benchmark gains a zero-match search row with its own budget.

## Consequences

- A zero-match search becomes an index lookup that returns nothing, instead of a scan of every visible ticket.
- Isolation for search stays where it is for everything else: in the `FORCE`d policies, covered by the negative suite.
- Write cost grows by one insert per distinct lexeme on ticket creation and on subject edits. At M1's volumes this is small; it is measured by the same benchmark.
- Phrase search and prefix search are not supported by the token table. Neither is supported today either.
- Contact search (`docs/guides/contacts.md` promised trigram indexing "in M1-15") has the same limit and should follow the same pattern when it needs to; the guide is corrected to say so.

## Alternatives considered

- **`LEAKPROOF` wrappers.** Rejected: the promise would be false, and it needs a superuser at migration time, which the install does not otherwise require.
- **`SECURITY DEFINER` search function.** Rejected: a second, hand-maintained isolation path for the most-used query.
- **An external search engine.** Out of the stack table (ARCHITECTURE §1) and out of scope for a self-hosted single-Postgres install.

## Implementation note (M1-15 part 2, 2026-09-25)

Built as decided, with one refinement the decision did not spell out. Run as
written, the trigram fallback would have read every visible ticket whenever the
exact half came back short, which is every search that matches nothing: the
zero-match case this ADR set out to remove would have come back through the
fallback. So the fuzzy half also reads the token table. For each word it takes
the tokens that share the word's first three characters, a range of the same
btree index (`>=` and `<` on `text` are leakproof; the column is
`COLLATE "C"` so a prefix is a contiguous range), and keeps those that are
word-similar to it (`<%`, pg_trgm's 0.6 threshold). The similarity is computed
on a few candidate words rather than on every ticket. What it gives up: a typo
in the first three letters is no longer caught. The subject trigram index stays
for owner-role paths, as the decision says.

The fallback is decided on the first page and carried by the cursor, so one
search never switches halves between pages. `-word` exclusions keep working;
quoted phrases are read as their words, in any order. Plans and numbers are in
the [tickets guide](../guides/tickets.md#search-under-row-level-security).
