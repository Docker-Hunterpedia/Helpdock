# AI

How Helpdock talks to language models: the providers an install is configured
with and their credentials, the model each brand uses, the one embedding model
of the install and what changing it does, the guardrails every call passes
through, and the per-brand budget (M7-01, M7-02, M7-08;
[REQUIREMENTS §4.7](../planning/REQUIREMENTS.md#47-ai),
[ARCHITECTURE §10](../planning/ARCHITECTURE.md#10-ai-subsystem),
[ADR 0005](../decisions/0005-single-embedding-model-per-install.md),
[ADR 0016](../decisions/0016-pi-ai-provider-layer.md)).

This is the foundation the AI features build on. Agent assist, auto-reply,
triage and knowledge ingest arrive with their own deliverables; the admin
screens (`Admin/AI-Providers`, `Admin/AI-Assistant`) arrive with M7-10. Until
then everything below is configured through the API or the environment.

## Providers

A provider is one account with one model vendor. Providers are install-wide:
an install admin configures them once and every brand uses them.

| Field | Meaning |
|---|---|
| `id` | A lower-case slug you choose, such as `openai` or `local-llm`. Brands name a provider by it |
| `kind` | One of pi-ai's built-in providers (`openai`, `anthropic`, `google`, `openrouter`, `groq`, `mistral`, `xai`, `deepseek`, …), or `openai-compatible` for any server that speaks the OpenAI chat API (Ollama, vLLM, LM Studio, LiteLLM) |
| `baseUrl` | Required for `openai-compatible`. For a built-in kind, overrides its endpoint (a regional endpoint, a gateway) |
| `auth` | An API key, OAuth (subscription) credentials, or none for a local server |

`GET /api/install/ai/providers` also lists every kind and whether it accepts
subscription credentials.

### Credentials

Credentials are write-only. The api stores them in the `ai.providers` setting,
encrypted under `APP_MASTER_KEY` like every secret setting, and never returns
them: a provider in a response says which kind of credential it holds and, for
OAuth, when the tokens expire. Editing a provider without sending a credential
keeps the stored one. Audit rows record that a credential was replaced, never
its value.

**API keys** are the supported path. Paste the key the vendor gives you.

**Subscriptions (OAuth)** are accepted for the kinds pi-ai has a login flow for
(Anthropic Claude Pro/Max, OpenAI Codex, GitHub Copilot). The login opens a
browser, so it runs on your machine, not on the server:

```bash
npx @mariozechner/pi-ai login anthropic
```

It writes `auth.json`; send its `access`, `refresh` and `expires` (and any
other field it wrote) as `auth.credentials`. Helpdock refreshes the tokens
when they expire and stores the refreshed set. Using a personal subscription
for a support desk may be against the vendor's terms; check them first.

**Local servers** (`auth: { type: "none" }`) need no key. The api reaches every
admin-supplied URL through the SSRF-safe client (DOMAIN-RULES §13), which
refuses private addresses: to reach Ollama inside the Compose network, add its
range to `OUTBOUND_ALLOW_CIDRS`, for example `172.16.0.0/12`. The URL's own
port (Ollama's 11434) is allowed.

### Models

`GET /api/install/ai/providers/:providerId/models` lists what a provider
offers, with context window and price per million tokens. A built-in kind's
list comes from pi-ai's model registry without a request; an
`openai-compatible` server is asked `GET {baseUrl}/models`.

The **default model** (`PUT /api/install/ai/default-model`) is what every brand
uses until it chooses its own. A model a built-in provider does not offer is
refused; a model on an `openai-compatible` server is taken on trust, and a
wrong id fails the first call, which is logged.

A provider that is the default, or that a brand overrides to, cannot be
deleted.

### From the environment

Every setting above can be pinned with an `HD_*` variable, which locks it in
admin (ARCHITECTURE §4). `HD_AI_PROVIDERS` is the whole list as JSON, so
pinning it locks every provider:

```bash
HD_AI_PROVIDERS='[{"id":"openai","kind":"openai","label":"OpenAI","baseUrl":null,"auth":{"type":"apiKey","apiKey":"sk-..."}}]'
HD_AI_DEFAULT_PROVIDER=openai
HD_AI_DEFAULT_MODEL=gpt-4o-mini
```

A pinned list cannot store refreshed OAuth tokens. Such an install refreshes
from the pinned tokens on every call until the refresh token itself expires;
pin API keys instead.

## Per brand

`GET /api/brands/:brandId/ai/settings` answers the brand's AI settings and how
much it has spent today and this month.

| Setting | Who may change it | Default |
|---|---|---|
| Model (`providerId` + `modelId`) | Admin (`brand:manage`) | The install default |
| PII redaction | Admin | On |
| Injection filter on ingested content | Admin | On |
| Daily and monthly budget, US dollars | Admin | No limit |
| System prompt — tone, language policy, forbidden topics | Admin and Team Leader (`ai:manage`) | Empty |

Admins change the first four with `PUT …/ai/settings` (the whole form); Team
Leaders and Admins change the prompt with `PUT …/ai/prompt`. Both are audited
with the values before and after.

## Every call

Every AI feature calls one of two functions of `@helpdock/ai`, and nothing
else in the codebase calls a model:

- `complete()` for text. In order, it resolves the brand's model, redacts PII
  from the system prompt and every message, refuses if the budget is spent,
  sends the request through pi-ai with an explicit key and **no tools**, and
  logs the call.
- `embed()` for vectors, from the install's embedding model. It redacts PII
  and logs the call.

Each call is a row in `ai_calls`: the brand, the ticket when there is one, the
feature (`assist.suggest_reply`, `knowledge.reembed`, …), provider, model,
status (`ok`, `error`, `refused`), input and output tokens, cost, latency, the
number of redactions, a SHA-256 of the prompt, and the bodies: the redacted
prompt, the answer as the model wrote it, the redaction map and the sources.
Embedding calls log counts and cost but not the texts.

Cost is computed from the configured model's price in pi-ai's registry, which
follows the pi-ai version the install runs; treat it as an estimate. A model on
an `openai-compatible` server costs 0. Embeddings are priced by
`embedding.pricePerMillionTokens`.

The calls on a ticket are listed by
`GET /api/brands/:brandId/tickets/:ticketId/ai-calls` (`ticket:read`), which
reads the ticket under the reader's own department scope first.

### PII redaction

Before any text reaches a model, these are replaced with numbered
placeholders — `[EMAIL_1]`, `[PHONE_1]`, `[CARD_1]`, `[IBAN_1]` — and the same
value gets the same placeholder throughout a call:

| Kind | Detected as | Checked by |
|---|---|---|
| Email | `local@domain.tld` | — |
| Phone | `+` or `00` then 8–15 digits, or a leading `0` then 9–11 digits; spaces, dots, hyphens and brackets allowed | digit count |
| Card | 13–19 digits, single spaces or hyphens between them | Luhn checksum |
| IBAN | two capitals, two digits, then groups of four, spaced or not | ISO 13616 mod-97 |

Digits may be Western, Arabic-Indic (٠–٩) or Extended Arabic-Indic (۰–۹). A
number that fails its check is left alone, so an order number or a tracking
code stays readable to the model.

Redaction is reversible for agents: the map of placeholder to original is
stored with the call, the ticket's AI log shows it, and `complete()` puts the
originals back into the answer it returns.

### Injection filter

Content ingested from outside — crawled pages, uploads, Notion, Drive — is
meant to pass through `screenIngestedText` from `@helpdock/ai` before it is
stored as knowledge, while the brand's injection filter is on; the ingest of
M7-03 is what calls it. A line that reads like an instruction to the model is
removed and the chunk is flagged `suspicious`:

- override phrasing: "ignore / disregard / forget previous instructions", and
  the Arabic "تجاهل التعليمات السابقة";
- role reassignment: "you are now", "act as", "pretend to be", "أنت الآن";
- prompt exfiltration: "reveal / repeat your system prompt";
- chat-template tokens: `<|im_start|>`, `[INST]`, `<<SYS>>`, and lines that open
  with `system:` or `assistant:`;
- concealment: "do not tell the user".

Zero-width and bidirectional-control characters and HTML comments are removed
from every text, flagged or not. These are heuristics; the adversarial items of
the evaluation set (DOMAIN-RULES §9) are what measures them.

### No tools

The model reads and writes text. `complete()` never builds a request with
tools and checks the request it is about to send, so a change that adds one
fails instead of giving a model an action. A tool call a model returns anyway
is ignored.

### Budget

Each brand may set a daily and a monthly limit in US dollars. Days and months
are UTC. The spend is the sum of the brand's logged cost, embeddings included.

- At **80 %** of either window, the first call that crosses it records an
  `ai_budget_alerts` row and writes an `ai.budget_alert` outbox event, once per
  window. Its handler writes an `ai.budget_alert` row to the brand's audit log,
  and the settings response reports the window as `warning`.
- At **100 %**, `complete()` refuses with `BudgetExceededError` before calling
  any model, and logs the refusal. Auto-reply stops; a feature may catch the
  error and fall back to a human.

Embedding is not stopped by the budget: a brand over budget loses its answers,
not its index.

## Embeddings

One embedding model serves every brand (ADR 0005). It is configured with
`PUT /api/install/ai/embedding` or the `HD_EMBEDDING_*` variables:

| Setting | Example |
|---|---|
| `embedding.provider` | `openai`, a label for the log |
| `embedding.baseUrl` | `https://api.openai.com/v1`, `http://ollama:11434/v1` |
| `embedding.apiKey` | Write-only, like provider keys |
| `embedding.model` | `text-embedding-3-small` |
| `embedding.dims` | `1536`. At most **2000**, the most a pgvector HNSW index covers; a larger model is refused with that reason. Use a model, or a reduced-dimension variant, at or under it |
| `embedding.pricePerMillionTokens` | `0.02` |

The endpoint must speak the OpenAI `POST /embeddings` API. The dimension must
be the one the model returns; a mismatch fails the re-embed, which says so in
`lastError`.

### Changing the model

Changing the model or the dimension re-embeds every chunk of every brand, at
the provider's price, and for its duration retrieval is full text only. The api
refuses the change unless the request says `confirmReembed: true`.

What happens next runs in the worker:

```
every minute   knowledge.configure   settings differ from the space?
                                     drop the vector index, resize the column,
                                     status = reindexing, add knowledge.reembed
               knowledge.reembed     brand by brand, embed every chunk not yet in the new model
                                     then build the HNSW index, status = ready
```

The change takes effect within a minute of saving, or at the next worker start
after changing `HD_EMBEDDING_MODEL`. `GET /api/install/ai/embedding` shows the
status, the active and target models, and progress as chunks embedded out of
all chunks.

Two models are never served together. Retrieval ranks by vector only while the
status is `ready`, and only chunks whose `embedding_model` is the active model
(`activeEmbeddingSpace()` in `@helpdock/db`). A re-embed that fails stays
`reindexing` with `lastError` set, retrieval stays on full text, and the next
minute's tick resumes from the chunks still left.

## API

| Route | Permission | |
|---|---|---|
| `GET /api/install/ai/providers` | install admin | Providers (without credentials), kinds, default model, what the environment locks |
| `PUT /api/install/ai/providers/:providerId` | install admin | Create or replace a provider. 400 `credential-required`, `unknown-kind`, `oauth-unsupported`; 409 `locked-by-environment` |
| `DELETE /api/install/ai/providers/:providerId` | install admin | 409 `provider-in-use` while it is the default or a brand's |
| `GET /api/install/ai/providers/:providerId/models` | install admin | 409 `discovery-failed` when the server cannot be asked |
| `PUT /api/install/ai/default-model` | install admin | 400 `unknown-model` |
| `GET /api/install/ai/embedding` | install admin | Settings (without the key), status and progress |
| `PUT /api/install/ai/embedding` | install admin | 400 above 2000 dimensions; 409 `reembed-not-confirmed` |
| `GET /api/brands/:brandId/ai/settings` | `ai:manage` | Model, guardrails, budget, prompt, spend |
| `PUT /api/brands/:brandId/ai/settings` | `brand:manage` | Model, guardrails and budget |
| `PUT /api/brands/:brandId/ai/prompt` | `ai:manage` | The system prompt, up to 8000 characters |
| `GET /api/brands/:brandId/tickets/:ticketId/ai-calls` | `ticket:read` | The ticket's AI log, with the redaction map |

A refusal carries `error.ai.reason`, as `aiRefusalSchema` in `@helpdock/schemas`
declares. Request and response shapes are the `ai*` schemas there.

## For developers

```ts
import { safeAiTransport } from '../ai/ai-http.js';
import { createAiRuntime } from '../ai/db-ai-ports.js';

const ai = createAiRuntime({ db, settings, http: safeAiTransport(env.OUTBOUND_ALLOW_CIDRS) });
const { text } = await ai.complete({
  brandId,
  feature: 'assist.summarize',
  ticketId,
  instructions: 'Summarise the conversation in three sentences.',
  messages: [{ role: 'user', text: thread }],
});
```

Do not call `complete()` inside a request's transaction: a model call takes
seconds, and every port opens its own short transaction for the brand. Tests
use `createFakeModel()`, `fakeEmbeddingsServer()` and `InMemoryAiPorts` from
`@helpdock/ai`, so nothing reaches a provider.

## Known gaps

- A budget alert reaches the audit log and the settings response; an email or
  a bell entry for it waits for a design of its own (notifications are about a
  ticket today).
- OAuth login runs on your machine, not in admin.
- The admin screens are M7-10.
