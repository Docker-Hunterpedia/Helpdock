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
| M7-03 | Ingest | | in review: [Ingest](#m7-03-ingest); the screen is M7-10 (`Admin/AI-Knowledge`) |
| M7-04 | Hybrid retrieval with `audience` | | in review: [Retrieval](#m7-04-retrieval) |
| M7-05 | Agent assist | | in review: [Agent assist](#m7-05-agent-assist) — the Assist menu, Suggested fields, translate, Show redacted, Help center › Proposals |
| M7-06 | Auto-reply on widget, Telegram and email with confidence threshold, transparent handoff, " | | planned |
| M7-07 | Auto-triage as a workflow action | | in review: [AI triage](#m7-07-ai-triage) |
| M7-08 | Guardrails | | in review: [Guardrails](#m7-08-guardrails); output on the ticket is the API, the panel is M7-10 |
| M7-09 | Voice transcription job (Whisper-compatible endpoint) shown to agents | | in review: [Transcription](#m7-09-transcription) |
| M7-10 | Admin | | in review: [Admin](#m7-10-admin) — Providers, Knowledge, Assistant and the wizard step |
| M7-11 | Evaluation harness | | planned |

## Exit criteria

Copied from the PRD, ticked as they are met.

- [ ] Auto-reply answers a question from an uploaded PDF with a citation, and hands off when confidence is below threshold, in an E2E test with a mocked provider.
- [ ] The evaluation run meets every threshold in DOMAIN-RULES §9 for both English and Arabic.
- [ ] After a handoff, no auto-reply is sent for the rest of the conversation even if a queued job fires late.
- [x] A visitor-audience query never retrieves an internal chunk (SQL-level test), and a fabricated citation is dropped. `apps/api/src/knowledge/retrieval/retrieval-sql.test.ts` asserts the filter in both rankers' SQL before they order; `knowledge.integration.test.ts` retrieves the best-matching internal chunk for staff and never for a visitor, by vector and by full text; `packages/ai/src/knowledge/citations.test.ts` drops a fabricated `[7]` and asks for the handoff.
- [ ] Budget hard stop disables auto-reply and is visible in admin. The stop is in (`complete()` refuses with `BudgetExceededError`, logged as `refused`; proved in `apps/api/src/ai/ai.integration.test.ts`), the API reports the `exceeded` window, and AI › Assistant draws it as a danger Banner with the channels "Paused · budget" (M7-10, `apps/admin/e2e/ai.spec.ts`); auto-reply honouring it (M7-06) remains.
- [x] PII redaction is covered by unit tests for emails, phones, cards (Luhn), IBANs. `packages/ai/src/guardrails/pii.test.ts`, including Arabic-Indic digits, Luhn and mod-97 failures left alone, and reversibility.

## Migrations

| File | What |
|---|---|
| `0038_ai_and_knowledge.sql` | `vector` extension; `ai_settings`, `ai_calls`, `ai_budget_alerts`; `knowledge_sources`, `knowledge_documents`, `knowledge_chunks` (with the generated `search` tsvector, no vector column); the global `embedding_space` row; the owner-rights functions `helpdock_set_embedding_dims(int)` and `helpdock_build_embedding_index()`; RLS on the six tenant tables |
| `0041_knowledge_ingest.sql` | `knowledge_sources.schedule`, `sync_started_at`, `progress_done`, `progress_total`, `last_error_code`, `created_by`; one help center source per brand (partial unique index); the `knowledge_sync_log` tenant table with RLS |
| `0042_ai_assistant_modes.sql` | `ai_settings.system_prompt_ar` and `ai_settings.modes` (jsonb, null = every mode off) for M7-10 |
| `0043_ai_assist_and_transcripts.sql` | `article_proposals` and `ticket_field_suggestions` (department-scoped children of a ticket: the shared insert trigger, a follow trigger of their own on a move, RLS, in the isolation suite); `attachments.transcript_status`, `transcript_text`, `transcript_language`, `transcribed_at` |

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

### M7-03 Ingest

- Loaders, the chunker and the connectors are in `packages/ai/src/knowledge/` (pure, every request through an injected `fetch`); the api binds them to the bucket and the SSRF-safe client (`apps/api/src/knowledge/`). [ADR 0020](../decisions/0020-knowledge-chunking-and-fusion.md) records the chunking and fusion choices.
- **Articles**: automatic. The `knowledge` subscriber of `help_center.article_changed`, `structure_changed` and `access_changed` rewrites the article's documents (one per published language, `<articleId>:<locale>`) in the event's transaction and adds `knowledge.embed`; "Sync now" on the help center source re-reads every article. A chunk records `meta.articleLocale`, which retrieval joins to the live version.
- **Files**: `POST …/knowledge/files` presigns (PDF, DOCX, MD, TXT, 25 MB), `…/confirm` checks the object and writes `knowledge.sync_requested`; the sync checks the magic bytes (ADR 0009 families) before unpdf (per page) or mammoth (headings kept).
- **Crawl**: sitemap or seed, same origin, include/exclude patterns, `robots.txt` and `Crawl-delay`, max pages, HTML only; every request through `safeFetch` (`policies.crawl`). `render` uses Playwright behind `KNOWLEDGE_CRAWL_RENDER`, with every browser request answered by the safe client and WebSockets and service workers refused.
- **Notion** (`@notionhq/client`, page Markdown, databases' data sources) and **Google Drive** (`googleapis` Drive module only; Docs as HTML, Sheets as CSV, files like uploads): OAuth through install apps (`knowledge.notion.*`, `knowledge.google.*` secret settings) with a signed `state`, or a Notion integration token. Credentials sealed with `APP_MASTER_KEY` in `config_encrypted`; a refused credential fails the source with `code: auth` ("Reconnect"). Both tested against `fakeService` from `@helpdock/ai`, no network.
- **Sync** (`knowledge.sync`, `knowledge` queue, concurrency 4): claim, load, one short transaction per document (skipped when its hash is unchanged), `screenIngestedText` on every chunk, prune what a finished run did not see, embed via `embeddingTarget`, log. Failures are recorded on the source and do not retry. `knowledge.embed` embeds a brand's chunks not yet in the target model.
- **Schedule**: `automatic` (articles, files), daily or weekly at 03:00 in the brand's zone (Sunday for weekly), or manual — one BullMQ job scheduler per source (`knowledge.sync.schedule.<sourceId>`), upserted by `knowledge.source_changed` and re-registered on worker boot.
- **Visibility** defaults to `internal`; a re-scope re-labels the chunks in the same transaction. **Removal** deletes documents and chunks in the request; `knowledge.source_removed` removes the scheduler and the file.
- API: `/api/brands/:brandId/knowledge/…` under `ai:manage`, shaped for the artboard (status with reason and progress, next sync, counts, sync log with a warnings filter, browse for the picker); refusals in `error.knowledge.reason`. See [the AI guide](../guides/ai.md#knowledge).

### M7-04 Retrieval

- `createRetriever({ db, embedQuery }).retrieve({ brandId, query, audience: 'visitor' | 'staff', locale, k })` in `apps/api/src/knowledge/retrieval/retrieve.ts`. The audience names follow DOMAIN-RULES §5 (`staff` is agent assist).
- `visibleChunks(audience)` is in both rankers' `WHERE` before they order, and again when the chosen chunks are read back: a visitor gets only chunks of public sources, and article chunks only by joining the live published, public version of a help center that is not internal-only.
- pgvector cosine over the active model only while the space is `ready`, plus full text in `arabic`/`english`; reciprocal rank fusion (k = 60) and a × 1.25 locale boost (`fuseRankings` in `@helpdock/ai`). `mode: 'lexical'` when there is no vector.
- `validateCitations(answer, retrieved)` in `@helpdock/ai`: drops `[n]` markers outside the retrieved set and reports `handoff`.
- Help center search and the widget's suggestions (M5-05, M5-10) gain `semantic.ts` beside the lexical source, joined to `readableVersions(audience)` and cut at cosine distance 0.6; without an embedding model search is lexical as before.

### M7-08 Guardrails

- PII redaction (`packages/ai/src/guardrails/pii.ts`) on every `complete()` and `embed()`, per the brand's toggle: emails, phones (Western and both Arabic digit sets), Luhn-valid cards, mod-97-valid IBANs, as numbered placeholders that are restored in the answer and stored as a map for agents.
- Injection filter (`screenIngestedText`) with documented heuristics in English and Arabic, called by M7-03's ingest on every chunk; the brand toggle is stored in `ai_settings.injection_filter`.
- No tools: `complete()` never builds a context with tools and `assertNoTools` checks the one it sends.
- Budget: daily and monthly US-dollar limits in `ai_settings`; spend is summed from `ai_calls`. The first call past 80 % of a window records `ai_budget_alerts` and writes an `ai.budget_alert` outbox event, whose handler writes an audit row; at 100 % `complete()` throws `BudgetExceededError` and logs a `refused` call.
- Per-brand system prompt, editable by Team Leaders (`ai:manage`), prepended after the feature's own instructions.
- Retention: the nightly run nulls AI call bodies past the brand's AI-log window and keeps counts and cost; the Data retention card's "next purge" now counts them.

### M7-05 Agent assist

Built from `Admin/Ticket-AI` and `Admin/HelpCenter-ArticleApproval`; see [the AI guide](../guides/ai.md#agent-assist) and [Help center](../guides/help-center.md#article-proposals).

- **Tasks** in `packages/ai/src/assist/`: the instructions per task (`prompts.ts`), lenient JSON readers that keep only the brand's own tag and department ids (`answers.ts`), and the Markdown subset an article draft is written in, rendered to escaped HTML (`markdown.ts`). `complete()` takes `allowOverBudget` for a brand that keeps assist on past the hard stop.
- **API** in `apps/api/src/assist/`: the assist routes (`ticket:write`) call the model with no transaction open — `@StepTransactions()` and `inRequestTenant` ([ADR 0021](../decisions/0021-step-transactions-for-model-calls.md)) — after reading the ticket under the agent's own department policy, the brand's mode (`parseAiAssistantModes`) and its budget. Suggest reply retrieves with the `staff` audience and validates citations; draft article reads public messages and `visitor` knowledge only. Suggested fields are stored in `ticket_field_suggestions` (one row per ticket); accepting uses the ticket's own endpoints. "Show redacted" runs the same `PiiRedactor` per customer message. Refusals are `error.assist.reason`.
- **Proposals.** `article_proposals`; `POST …/assist/proposals` (closed ticket, one waiting at a time, audited, a `ticket.article_proposed` activity row the thread draws); Help center › Proposals under `help_center:manage` lists, approves into a draft article through `HelpCenterArticlesService` (create, save, visibility) and rejects with a reason, each audited.
- **Admin** in `apps/admin/src/screens/tickets/assist/`: AssistMenu (budget banner, disabled items with their reasons, the tone submenu), AISuggestionCard for the suggested reply (CitationList with Internal / "removed on Insert"; Insert strips internal markers and lists public sources), Rewritten (ToneChips, Keep mine / Replace text) and Translated, SummaryCard, SuggestedFieldsCard in the details panel, per-message Translate / Show original and Show redacted (RedactionToken), AILogDisclosure, DraftArticleDialog, AIBadge, and AIPausedStrip (display only, for M7-06). `apps/admin/src/screens/help-center/proposals-tab.tsx` is the Proposals tab. The composer's disabled "Translate" placeholder is gone; Assist replaces it.
- **Tests.** Unit: `packages/ai/src/assist/*.test.ts`, `packages/ai/src/complete.test.ts` (over budget), `packages/schemas/src/assist.test.ts`, `apps/api/src/assist/assist-units.test.ts`, `apps/admin/src/screens/tickets/assist/*.test.ts(x)`, `apps/admin/src/screens/help-center/proposals-tab.test.tsx`, `thread-events.test.ts`. Integration: `apps/api/src/assist/assist.integration.test.ts` (faux model: citations and redaction, the agent of another department, mode off and the hard stop with and without keep-assist, provider failure, summary, fields, translate, rewrite, redactions, draft → propose → approve/reject with audit). Browser: `apps/admin/e2e/assist.spec.ts`, en and ar, with axe.

### M7-07 AI triage

- Rule action `ai_triage` `{ mode: 'suggest' | 'apply', fields: ('tags' | 'priority' | 'department')[] }` in `@helpdock/schemas`; the builder offers it with a mode select and three checkboxes; the run log reads it as "AI triage suggests tags, priority (suggested)".
- The action writes `ai.triage_requested` to the outbox with the run's id — the engine now chooses a run's id before its actions run — and the handler adds `ai.classify` on the `ai` queue (job id = outbox row). `apps/api/src/triage/triage.job.ts` calls `complete()` as `triage.classify` outside any transaction, then in one system transaction claims `ai.classify:<run>:<action>`, suggests (Suggested fields, source `rule:<id>`) or applies through `applyTriageActions` (the rule actions' own code, plus a department move that drops a team and an assignee who cannot follow), and writes the outcome into the run's `details.actions[i].triage`. Refusals are recorded as `failed` and not retried; provider failures retry.
- Tests: `apps/api/src/triage/triage-units.test.ts`; the integration suite runs a rule through `evaluateEventRules`, reads the outbox row and runs the job twice (applied once), in both modes; `automation-page.test.tsx` saves a rule with the action.

### M7-09 Transcription

- `transcribe()` in `@helpdock/ai` (`transcribe.ts`): multipart `POST` to the configured Whisper-compatible endpoint with `response_format=verbose_json`, logged as `transcribe` (cost 0). The api reads `transcription.*` from M7-10's settings (`transcription-config.ts`).
- The `transcription` subscriber of `attachment.ready` marks a ready audio attachment `pending` and adds `ai.transcribe` (job id `ai.transcribe:<attachmentId>`); the job downloads the Opus variant, stores the text and language on the attachment, and marks a 4xx refusal or a last failed attempt `failed`.
- `GET …/tickets/:ticketId/transcripts` (`ticket:read`); the VoiceNote draws "Transcript", "Transcribing…" while pending, the language, and Translate. Voice notes from any channel now play in the thread, not only Telegram's.
- Tests: `packages/ai/src/transcribe.test.ts`, the integration suite with a fake Whisper server (done, refused), the handler's no-endpoint case, the admin transcript test and e2e.

### M7-10 Admin

Built from `Admin/AI-Providers`, `Admin/AI-Knowledge`, `Admin/AI-Assistant` and `Admin/Wizard-AI`.

- **Nav and page.** "AI" (Lucide `Sparkles`) joins the Admin group after Channels for Admins and Team Leaders. `/admin/ai/:tab` has Providers (install admins only), Knowledge and Assistant (`apps/admin/src/screens/admin/ai/tabs.ts`).
- **Providers tab.** The providers table (credential type, never the credential; the env chip when `HD_AI_PROVIDERS` pins the list), the provider form (kind, base URL, credential type as radio cards, the key as a SecretField, `auth.json` for subscriptions, Discover models with the registry's prices, Remove), the chat model card (install default and each brand's override, from the discovered models), voice transcription (EnvLockedField for pinned keys) and the embeddings card (status, the re-embed progress across every brand, more than 2000 dimensions refused under the field, and the change-model → re-embed confirmation dialog). A warning Banner lists every pinned key.
- **Knowledge tab** (on M7-03's `/api/brands/:brandId/knowledge/*`). The sources table as SourceRows (kind tile, name into the drawer, visibility, chunks, last sync, schedule, state with the sync's progress bar or the failure's reason and "Reconnect", "Sync now" named after its source, the row menu) and a search; "Add source" in the page header opens the dialog — files through presign → PUT → confirm (`apps/admin/src/knowledge/http-api.ts`), the crawl form, Notion (OAuth or an internal token) and Drive, both sent to the provider with `POST …/oauth/:provider`; the drawer with facts, visibility and schedule changes, the Notion/Drive picker (`…/browse`, saved as the source's config), and the SyncLog with its Warnings filter; the remove dialog. `?oauth=connected|failed` from the callback is said in a banner. Every log code is translated in `screens/admin/ai/knowledge/log-format.ts` from the `aiSettings:knowledge.logLines` strings, en and ar.
- **Assistant tab.** Budget Banner (warning at 80 %, danger with "Raise limit" at the hard stop), Modes (agent assist, auto-reply per channel with a SliderField threshold and its paused state, AI reply satisfies first-response SLA, handoff message EN/AR), Guardrails (PII, no tools and the log fixed; the injection filter a Switch), Budget (two UsageMeters, the limits, keep assist after the hard stop), System prompt in EN and AR, and AI activity a page at a time. Modes, guardrails and budget are read-only for a Team Leader; the prompt is theirs too.
- **Wizard.** An optional "AI provider" step between Outgoing email and Done: provider, API key or subscription, "Test and find models" (saves the provider and lists its models), default chat model, Skip. It uses the ordinary install AI routes with the session step 2 opened (`screens/setup/setup-ai.ts`), so it adds no wizard endpoint.
- **API added.** `PUT /api/brands/:brandId/ai/modes` (`brand:manage`; writes `ai_settings.modes` and `brands.settings.aiCountsAsFirstResponse`, the one Ticketing › SLAs edits), `GET /api/brands/:brandId/ai/calls` (`ai:manage`; keyset-paged, no bodies, the ticket reference only when the reader may see it), `GET`/`PUT /api/install/ai/transcription` (install admin; settings `transcription.endpoint`, `transcription.model`, `transcription.apiKey`, env `HD_TRANSCRIPTION_*`). `GET …/ai/settings` now also answers `systemPromptAr`, `modes` and `aiCountsAsFirstResponse`; `PUT …/ai/prompt` takes an optional `systemPromptAr`.
- **For M7-05 and M7-06.** Read the modes with `parseAiAssistantModes(row.modes)` from `@helpdock/schemas` (`AiAssistantModes`: `agentAssist`, `keepAssistAfterHardStop`, `autoReply.{widget,email,telegram}.{enabled,threshold}`, `handoffMessage.{en,ar}`, empty meaning the built-in wording). `db-ai-ports.ts` still sends `systemPrompt` alone; choosing `systemPromptAr` for an Arabic conversation belongs to the feature that knows the conversation's language.
- **Components.** SliderField, EnvLockedField (with the env chip), UsageMeter and SecretField are in `apps/admin/src/ui/` as DESIGN §6 describes them.
- **Tests.** Unit: `apps/admin/src/screens/admin/ai/**/*.test.ts(x)` (the Knowledge tab and its log, draft and format helpers included), `apps/admin/src/ai/http-api.test.ts`, `apps/admin/src/knowledge/http-api.test.ts`, the wizard's `setup-*.test.ts(x)`, `apps/api/src/ai/transcription-settings.service.test.ts`, `packages/schemas/src/ai.test.ts`. Integration: `apps/api/src/ai/ai.integration.test.ts` (modes, Arabic prompt, activity paging and isolation, transcription). Browser: `apps/admin/e2e/ai.spec.ts` (Providers, Knowledge, Assistant) and the wizard in `apps/admin/e2e/setup.spec.ts`, both languages, with axe.

## Gaps and follow-ups

- A budget alert lands in the audit log and the settings response only. Staff notifications are ticket-shaped (`notifications.ticket_id` is required and the panel draws a ticket); an email or bell entry for budgets needs its own artboard and subscribes to `ai.budget_alert`.
- OAuth login is not run inside admin; credentials are pasted (ADR 0018).
- Streaming completions arrive with auto-reply (M7-06); assist answers arrive whole.
- Assist sends the brand's main system prompt; choosing `systemPromptAr` for an Arabic ticket is not done yet.
- Transcription has no per-minute price, so its calls cost 0 in the log; voice notes received before an endpoint was configured are not transcribed later.
- The rule builder's AI triage row has no artboard of its own; it reuses the builder's select and checkbox row pattern from `AdminRuleBuilder`.
- AIPausedStrip is built and unused until auto-reply (M7-06) supplies the pause.
- M7-10 does not draw: the providers table's model count and health column (no health check exists; discovery is per provider on demand), the ticked-model list of "Discover models" (every discovered model is offered), "saved … by" lines (the api does not return who saved a provider), and the re-embed progress per source (the api counts chunks across every brand). The budget's "Alert at 80 %" is not a toggle: the alert is always recorded (M7-08). On Knowledge, the drawer's "Edit" of a crawl's address, page cap and patterns is not built (visibility and schedule are changed in the drawer; a different crawl is a new source).
- A Notion or Drive item deleted at the service leaves at the next sync, not at once; there are no webhooks from either.
- Drive has no token alternative to OAuth; Notion takes an internal integration token.
- The production image does not ship Chromium; `KNOWLEDGE_CRAWL_RENDER=true` needs it installed in the worker.

## Open questions

- None yet.

## Pull requests

- None yet.
