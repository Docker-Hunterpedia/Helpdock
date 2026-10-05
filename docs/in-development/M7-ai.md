# M7 AI

Status: in progress
Started: 2026-10-05
Owner: @Docker-Hunterpedia

## Scope

Full deliverable list and specs: [PRD §4 · M7 AI](../planning/PRD.md#m7-ai).
Depends on M3, M4, M5 (shipped) and M6 (in progress in parallel; M7-06 Telegram auto-reply lands after M6).

## Deliverables

| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M7-01 | Provider layer on pi-ai | | in review: [Provider layer](#m7-01-provider-layer) |
| M7-02 | Embeddings per D §8 | | in review: [Embeddings](#m7-02-embeddings) |
| M7-03 | Ingest | | planned |
| M7-04 | Hybrid retrieval with `audience` | | planned |
| M7-05 | Agent assist | | planned |
| M7-06 | Auto-reply on widget, Telegram and email with confidence threshold, transparent handoff, " | | planned |
| M7-07 | Auto-triage as a workflow action | | planned |
| M7-08 | Guardrails | | in review: [Guardrails](#m7-08-guardrails); output on the ticket is the API, the panel is M7-10 |
| M7-09 | Voice transcription job (Whisper-compatible endpoint) shown to agents | | planned |
| M7-10 | Admin | | planned |
| M7-11 | Evaluation harness | | planned |

## Exit criteria

Copied from the PRD, ticked as they are met.

- [ ] Auto-reply answers a question from an uploaded PDF with a citation, and hands off when confidence is below threshold, in an E2E test with a mocked provider.
- [ ] The evaluation run meets every threshold in DOMAIN-RULES §9 for both English and Arabic.
- [ ] After a handoff, no auto-reply is sent for the rest of the conversation even if a queued job fires late.
- [ ] A visitor-audience query never retrieves an internal chunk (SQL-level test), and a fabricated citation is dropped.
- [ ] Budget hard stop disables auto-reply and is visible in admin. The stop is in (`complete()` refuses with `BudgetExceededError`, logged as `refused`; proved in `apps/api/src/ai/ai.integration.test.ts`) and the API reports the `exceeded` window; auto-reply (M7-06) and the admin screen (M7-10) remain.
- [x] PII redaction is covered by unit tests for emails, phones, cards (Luhn), IBANs. `packages/ai/src/guardrails/pii.test.ts`, including Arabic-Indic digits, Luhn and mod-97 failures left alone, and reversibility.

## Migrations

| File | What |
|---|---|
| `0038_ai_and_knowledge.sql` | `vector` extension; `ai_settings`, `ai_calls`, `ai_budget_alerts`; `knowledge_sources`, `knowledge_documents`, `knowledge_chunks` (with the generated `search` tsvector, no vector column); the global `embedding_space` row; the owner-rights functions `helpdock_set_embedding_dims(int)` and `helpdock_build_embedding_index()`; RLS on the six tenant tables |

## Deliverable notes

### M7-01 Provider layer

- `packages/ai` is the facade: `createAi({ ports, http, transport })` returns `complete()` and `embed()`, the only way a feature reaches a model ([ADR 0018](../decisions/0018-pi-ai-provider-layer.md)). It holds the rules and no database; `apps/api/src/ai/db-ai-ports.ts` implements its ports, and `createAiRuntime({ db, settings, http })` is what features call.
- Providers are the secret setting `ai.providers` (API key, OAuth credentials or none), env-lockable as `HD_AI_PROVIDERS`; `ai.defaultProvider` and `ai.defaultModel` are the install default; a brand overrides in `ai_settings`. The settings layer now reads a list or object `HD_*` override as JSON.
- OAuth credentials come from `npx @mariozechner/pi-ai login` and are refreshed through `getOAuthApiKey`; refreshed tokens are written back. A key is always passed explicitly, so pi-ai never reads `OPENAI_API_KEY` and the like from the container.
- Model discovery: pi-ai's registry for built-in kinds, `GET /models` for `openai-compatible`, through the SSRF-safe client (`apps/api/src/ai/ai-http.ts`).
- Every call is an `ai_calls` row (tenant table, brand-scoped, RLS and in the isolation suite): feature, provider, model, status, tokens, cost from pi-ai's registry price of the configured model, latency, redaction count, prompt hash, the redacted prompt, the answer, the redaction map, sources, error.
- Install routes under `/api/install/ai` (install admin), brand routes under `/api/brands/:brandId/ai` and the ticket's AI log; new permission `ai:manage` (Admin, Team Leader). Refusals carry `error.ai.reason`. See [the AI guide](../guides/ai.md#api).
- Tests run against pi-ai's faux provider (`createFakeModel()`), `fakeEmbeddingsServer()` and `InMemoryAiPorts`, all exported for the features that follow.

### M7-02 Embeddings

- `knowledge_sources`, `knowledge_documents`, `knowledge_chunks` are laid out for M7-03 and M7-04: a chunk has its source, document, optional article, locale, visibility, content, content hash, token count, `suspicious` flag, generated `search` tsvector (`arabic` for `ar`, `english` otherwise), `embedding_model` and `embedded_at`. `embedding vector(<dims>)` is added and resized only by `helpdock_set_embedding_dims`, never by a migration.
- `ai.retrieval_status` of DOMAIN-RULES §8 is `embedding_space.status` (`unconfigured`, `reindexing`, `ready`), a single global row with the active and target model and dimension, because it is install state written by the worker rather than a setting an admin edits.
- `knowledge.configure` (every minute, `knowledge` queue) compares the `embedding.*` settings with the space; a change drops the index, resizes the column, sets `reindexing` and adds `knowledge.reembed` (fixed job id). The re-embed walks every brand in its own system transactions, embeds what is not in the target model, then builds the HNSW cosine index and flips to `ready`. A failure keeps `reindexing` with `last_error`; the next tick resumes. A target that changes mid-run is never opened.
- Retrieval helpers in `@helpdock/db`: `activeEmbeddingSpace(db)` (null unless `ready`), `embeddingTarget(db)` for ingest to embed new chunks with, `toVectorLiteral()`.
- `PUT /api/install/ai/embedding` refuses more than 2000 dimensions with the reason, and a model or dimension change without `confirmReembed: true`.

### M7-08 Guardrails

- PII redaction (`packages/ai/src/guardrails/pii.ts`) on every `complete()` and `embed()`, per the brand's toggle: emails, phones (Western and both Arabic digit sets), Luhn-valid cards, mod-97-valid IBANs, as numbered placeholders that are restored in the answer and stored as a map for agents.
- Injection filter (`screenIngestedText`) with documented heuristics in English and Arabic, ready for M7-03's ingest to call; the brand toggle is stored in `ai_settings.injection_filter`.
- No tools: `complete()` never builds a context with tools and `assertNoTools` checks the one it sends.
- Budget: daily and monthly US-dollar limits in `ai_settings`; spend is summed from `ai_calls`. The first call past 80 % of a window records `ai_budget_alerts` and writes an `ai.budget_alert` outbox event, whose handler writes an audit row; at 100 % `complete()` throws `BudgetExceededError` and logs a `refused` call.
- Per-brand system prompt, editable by Team Leaders (`ai:manage`), prepended after the feature's own instructions.
- Retention: the nightly run nulls AI call bodies past the brand's AI-log window and keeps counts and cost; the Data retention card's "next purge" now counts them.

## Gaps and follow-ups

- A budget alert lands in the audit log and the settings response only. Staff notifications are ticket-shaped (`notifications.ticket_id` is required and the panel draws a ticket); an email or bell entry for budgets needs its own artboard and subscribes to `ai.budget_alert`.
- OAuth login is not run inside admin; credentials are pasted (ADR 0018).
- Streaming completions arrive with the features that stream (M7-05, M7-06).
- The admin screens for all of this are M7-10.

## Open questions

- None yet.

## Pull requests

- None yet.
