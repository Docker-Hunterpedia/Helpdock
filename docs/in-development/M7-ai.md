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
| M7-10 | Admin | | in progress: [Admin, part 1](#m7-10-admin-part-1) — Providers, Assistant and the wizard step; the Knowledge tab waits for M7-03 |
| M7-11 | Evaluation harness | | planned |

## Exit criteria

Copied from the PRD, ticked as they are met.

- [ ] Auto-reply answers a question from an uploaded PDF with a citation, and hands off when confidence is below threshold, in an E2E test with a mocked provider.
- [ ] The evaluation run meets every threshold in DOMAIN-RULES §9 for both English and Arabic.
- [ ] After a handoff, no auto-reply is sent for the rest of the conversation even if a queued job fires late.
- [ ] A visitor-audience query never retrieves an internal chunk (SQL-level test), and a fabricated citation is dropped.
- [ ] Budget hard stop disables auto-reply and is visible in admin. The stop is in (`complete()` refuses with `BudgetExceededError`, logged as `refused`; proved in `apps/api/src/ai/ai.integration.test.ts`), the API reports the `exceeded` window, and AI › Assistant draws it as a danger Banner with the channels "Paused · budget" (M7-10, `apps/admin/e2e/ai.spec.ts`); auto-reply honouring it (M7-06) remains.
- [x] PII redaction is covered by unit tests for emails, phones, cards (Luhn), IBANs. `packages/ai/src/guardrails/pii.test.ts`, including Arabic-Indic digits, Luhn and mod-97 failures left alone, and reversibility.

## Migrations

| File | What |
|---|---|
| `0039_ai_assistant_modes.sql` | `ai_settings.system_prompt_ar` and `ai_settings.modes` (jsonb, null = every mode off) for M7-10 |
| `0038_ai_and_knowledge.sql` | `vector` extension; `ai_settings`, `ai_calls`, `ai_budget_alerts`; `knowledge_sources`, `knowledge_documents`, `knowledge_chunks` (with the generated `search` tsvector, no vector column); the global `embedding_space` row; the owner-rights functions `helpdock_set_embedding_dims(int)` and `helpdock_build_embedding_index()`; RLS on the six tenant tables |

## Deliverable notes

### M7-01 Provider layer

- `packages/ai` is the facade: `createAi({ ports, http, transport })` returns `complete()` and `embed()`, the only way a feature reaches a model ([ADR 0018](../decisions/0018-pi-ai-provider-layer.md)). It holds the rules and no database; `apps/api/src/ai/db-ai-ports.ts` implements its ports, and `createAiRuntime({ db, settings, http })` is what features call.
- Providers are the secret setting `ai.providers` (API key, OAuth credentials or none), env-lockable as `HD_AI_PROVIDERS`; `ai.defaultProvider` and `ai.defaultModel` are the install default; a brand overrides in `ai_settings`. The settings layer now reads a list or object `HD_*` override as JSON.
- OAuth credentials come from `npx @mariozechner/pi-ai login` and are refreshed through `getOAuthApiKey`; refreshed tokens are written back. A key is always passed explicitly, so pi-ai never reads `OPENAI_API_KEY` and the like from the container.
- Model discovery: pi-ai's registry for built-in kinds, `GET /models` for `openai-compatible`, through the SSRF-safe client (`apps/api/src/ai/ai-http.ts`).
- Every call is an `ai_calls` row (tenant table, brand-scoped, RLS and in the isolation suite): feature, provider, model, status, tokens, cost from pi-ai's registry price of the configured model, latency, redaction count, prompt hash, the redacted prompt, the answer, the redaction map, sources, error.
- Install routes under `/api/install/ai` (install admin), brand routes under `/api/brands/:brandId/ai` and the ticket's AI log; new permission `ai:manage` (Admin, Team Leader). Refusals carry `error.ai.reason`. See [the AI guide](../guides/ai.md#api).
- `DbAiUsage` (`apps/api/src/ai/db-ai-usage.ts`) binds the AI seam M8 left (`reports/ai-usage.ts`): Reports' AI cost per range and department, and the System page's install spend for the UTC month against the sum of brands' monthly budgets. Deflection stays null until auto-reply (M7-06) records it.
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

### M7-10 Admin, part 1

Built from `Admin/AI-Providers`, `Admin/AI-Assistant` and `Admin/Wizard-AI`; the Knowledge tab (`Admin/AI-Knowledge`) draws the placeholder until M7-03's api lands.

- **Nav and page.** "AI" (Lucide `Sparkles`) joins the Admin group after Channels for Admins and Team Leaders. `/admin/ai/:tab` has Providers (install admins only), Knowledge and Assistant (`apps/admin/src/screens/admin/ai/tabs.ts`).
- **Providers tab.** The providers table (credential type, never the credential; the env chip when `HD_AI_PROVIDERS` pins the list), the provider form (kind, base URL, credential type as radio cards, the key as a SecretField, `auth.json` for subscriptions, Discover models with the registry's prices, Remove), the chat model card (install default and each brand's override, from the discovered models), voice transcription (EnvLockedField for pinned keys) and the embeddings card (status, the re-embed progress across every brand, more than 2000 dimensions refused under the field, and the change-model → re-embed confirmation dialog). A warning Banner lists every pinned key.
- **Assistant tab.** Budget Banner (warning at 80 %, danger with "Raise limit" at the hard stop), Modes (agent assist, auto-reply per channel with a SliderField threshold and its paused state, AI reply satisfies first-response SLA, handoff message EN/AR), Guardrails (PII, no tools and the log fixed; the injection filter a Switch), Budget (two UsageMeters, the limits, keep assist after the hard stop), System prompt in EN and AR, and AI activity a page at a time. Modes, guardrails and budget are read-only for a Team Leader; the prompt is theirs too.
- **Wizard.** An optional "AI provider" step between Outgoing email and Done: provider, API key or subscription, "Test and find models" (saves the provider and lists its models), default chat model, Skip. It uses the ordinary install AI routes with the session step 2 opened (`screens/setup/setup-ai.ts`), so it adds no wizard endpoint.
- **API added.** `PUT /api/brands/:brandId/ai/modes` (`brand:manage`; writes `ai_settings.modes` and `brands.settings.aiCountsAsFirstResponse`, the one Ticketing › SLAs edits), `GET /api/brands/:brandId/ai/calls` (`ai:manage`; keyset-paged, no bodies, the ticket reference only when the reader may see it), `GET`/`PUT /api/install/ai/transcription` (install admin; settings `transcription.endpoint`, `transcription.model`, `transcription.apiKey`, env `HD_TRANSCRIPTION_*`). `GET …/ai/settings` now also answers `systemPromptAr`, `modes` and `aiCountsAsFirstResponse`; `PUT …/ai/prompt` takes an optional `systemPromptAr`.
- **For M7-05 and M7-06.** Read the modes with `parseAiAssistantModes(row.modes)` from `@helpdock/schemas` (`AiAssistantModes`: `agentAssist`, `keepAssistAfterHardStop`, `autoReply.{widget,email,telegram}.{enabled,threshold}`, `handoffMessage.{en,ar}`, empty meaning the built-in wording). `db-ai-ports.ts` still sends `systemPrompt` alone; choosing `systemPromptAr` for an Arabic conversation belongs to the feature that knows the conversation's language.
- **Components.** SliderField, EnvLockedField (with the env chip), UsageMeter and SecretField are in `apps/admin/src/ui/` as DESIGN §6 describes them.
- **Tests.** Unit: `apps/admin/src/screens/admin/ai/**/*.test.ts(x)`, `apps/admin/src/ai/http-api.test.ts`, the wizard's `setup-*.test.ts(x)`, `apps/api/src/ai/transcription-settings.service.test.ts`, `packages/schemas/src/ai.test.ts`. Integration: `apps/api/src/ai/ai.integration.test.ts` (modes, Arabic prompt, activity paging and isolation, transcription). Browser: `apps/admin/e2e/ai.spec.ts` and the wizard in `apps/admin/e2e/setup.spec.ts`, both languages, with axe.

## Gaps and follow-ups

- A budget alert lands in the audit log and the settings response only. Staff notifications are ticket-shaped (`notifications.ticket_id` is required and the panel draws a ticket); an email or bell entry for budgets needs its own artboard and subscribes to `ai.budget_alert`.
- OAuth login is not run inside admin; credentials are pasted (ADR 0018).
- Streaming completions arrive with the features that stream (M7-05, M7-06).
- M7-10 part 1 does not draw: the providers table's model count and health column (no health check exists; discovery is per provider on demand), the ticked-model list of "Discover models" (every discovered model is offered), "saved … by" lines (the api does not return who saved a provider), and the re-embed progress per source (the api counts chunks across every brand). The budget's "Alert at 80 %" is not a toggle: the alert is always recorded (M7-08).
- The Knowledge tab and `Admin/AI-Knowledge` are M7-10 part 2, after M7-03.

## Open questions

- None yet.

## Pull requests

- None yet.
