# 0016 The AI provider layer: pi-ai behind one facade, credentials in one secret setting, cost from pi-ai's model registry

Status: accepted
Date: 2026-10-05

## Context

M7-01 needs a provider layer that every AI feature of M7 — agent assist, auto-reply, triage, transcription — goes through ([REQUIREMENTS §4.7](../planning/REQUIREMENTS.md#47-ai), [ARCHITECTURE §10](../planning/ARCHITECTURE.md#10-ai-subsystem)). The stack table already names `@mariozechner/pi-ai` for it: one API over OpenAI, Anthropic, Google, OpenRouter, Groq, Mistral, any OpenAI-compatible server and more, with API-key and OAuth (subscription) credentials and token and cost accounting. What the stack table does not settle is how Helpdock holds it:

- where the credentials live, given that settings are env-lockable and secrets are encrypted under `APP_MASTER_KEY` ([ARCHITECTURE §4](../planning/ARCHITECTURE.md#4-configuration-model));
- how an OAuth subscription gets its tokens on a server with no browser;
- what the guardrails of M7-08 hang off, so no feature can skip them;
- where embeddings come from, since pi-ai does chat and not embeddings;
- where a call's cost comes from, for `ai_calls` and the per-brand budget;
- how tests run without a provider.

## Decision

**One facade.** `@helpdock/ai` exports `createAi({ ports, http, transport })` with two methods, `complete()` and `embed()`. Every AI feature calls one of them; nothing else in the codebase imports pi-ai. `complete()` resolves the brand's model, redacts PII, checks the budget, calls pi-ai with no tools, and logs the call; `embed()` redacts and logs. The package holds the rules and knows nothing about Postgres: what it needs from the install — the model, the guardrails, the budget, where to log — comes through an `AiPorts` interface that `apps/api` implements against `settings`, `ai_settings` and `ai_calls`.

**Credentials in one secret setting.** Providers are the install-wide setting `ai.providers`: a JSON array of `{ id, kind, label, baseUrl, auth }`, where `auth` is an API key, OAuth credentials, or none. The whole array is one secret setting, so it is encrypted at rest with the key id, invalidated across replicas, and pinnable as `HD_AI_PROVIDERS`, all by the settings machinery that already exists. The api accepts a credential and never returns one. A brand names a provider by id in `ai_settings`; it never holds a credential of its own.

**OAuth by pasting pi-ai's credentials.** pi-ai's login flows open a browser and some run a local callback server, which a headless container cannot host for an admin on another machine. The admin runs `npx @mariozechner/pi-ai login <provider>` on their own machine and pastes the resulting credentials (access, refresh, expiry). The facade turns them into a key with `getOAuthApiKey`, which refreshes them when they expire, and stores the refreshed set back into `ai.providers`. API keys remain the supported path; subscriptions are documented as "check your provider's terms".

**Always an explicit key.** pi-ai falls back to environment variables such as `OPENAI_API_KEY` when no key is passed. The facade always passes one — a placeholder for a server that needs none — so the configured provider, not whatever the container exports, decides which account is billed.

**Embeddings over plain HTTP.** One OpenAI-compatible `POST /embeddings` endpoint (OpenAI, Voyage, Ollama) configured in the `embedding.*` settings, as ADR 0005 and ARCHITECTURE §10 already say. That request, and `GET /models` on an OpenAI-compatible chat server, go through an injected HTTP transport; the api passes the SSRF-safe client of DOMAIN-RULES §13, with the URL's own port allowed and private addresses refused unless the operator allows them in `OUTBOUND_ALLOW_CIDRS`.

**Cost from pi-ai's model registry.** The cost of a completion is `calculateCost(model, usage)` against the configured model's entry in pi-ai's generated registry, in US dollars per million tokens. A model on an OpenAI-compatible server has no entry and costs zero, which is right for a self-hosted model. Embeddings are priced by the `embedding.pricePerMillionTokens` setting. Budgets are therefore in US dollars too.

**Tests use pi-ai's faux provider.** `@helpdock/ai` exports `createFakeModel()` (pi-ai's `registerFauxProvider` behind the facade's transport), `fakeEmbeddingsServer()` and `InMemoryAiPorts`, so every suite — this package's, the api's, and the features that come after — runs with scripted answers and no network.

## Consequences

- One place to read to know what reaches a model. A feature cannot forget redaction, the budget or the log, because it never holds a pi-ai handle.
- The provider list is all-or-nothing in the environment: pinning `HD_AI_PROVIDERS` locks every provider in admin. That matches how the other settings lock, and an install that configures from the environment configures all of it there.
- Refreshed OAuth tokens are written back to the setting, which an environment-pinned list cannot take. Such an install refreshes from its pinned tokens on every call until the refresh token itself expires; the guide says so.
- Two replicas refreshing the same OAuth credentials at once may each write their own set; the later write wins and both sets were valid when issued.
- Prices follow the pi-ai version pinned in the lockfile. A provider price change reaches the cost log when Renovate bumps pi-ai, not on the day it happens; the cost log is an estimate, and the guide says so.
- Chat completions go through pi-ai's own provider SDK clients, not through the SSRF-safe client. Their endpoints are the providers' public APIs, or a base URL an install admin typed; the risk DOMAIN-RULES §13 guards against — a URL a *user* supplied — does not reach them.

## Alternatives considered

- **A table of providers, with an encrypted credential column.** Rejected: it would duplicate encryption, key rotation, env locking and cross-replica invalidation that the settings layer already does, for a list an install keeps to a handful of rows.
- **Running pi-ai's OAuth login inside the api.** Rejected for v1: the flows assume a local browser or a local callback port, and proxying them through the admin is a feature of its own. Pasting credentials gets the same tokens.
- **Our own price table.** Rejected: pi-ai already maintains one per model and computes it for every provider it supports; a second table would drift from the models pi-ai can call.
- **Calling pi-ai directly from each feature.** Rejected: the guardrails of M7-08 would then be a convention instead of a code path.
