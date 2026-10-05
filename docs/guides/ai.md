# AI

How Helpdock talks to language models: the providers an install is configured
with and their credentials, the model each brand uses, the one embedding model
of the install and what changing it does, the guardrails every call passes
through, the per-brand budget, and the knowledge the assistant reads and how
it is retrieved (M7-01, M7-02, M7-03, M7-04, M7-08;
[REQUIREMENTS §4.7](../planning/REQUIREMENTS.md#47-ai),
[ARCHITECTURE §10](../planning/ARCHITECTURE.md#10-ai-subsystem),
[ADR 0005](../decisions/0005-single-embedding-model-per-install.md),
[ADR 0018](../decisions/0018-pi-ai-provider-layer.md),
[ADR 0020](../decisions/0020-knowledge-chunking-and-fusion.md)).

This is the foundation the AI features build on. Agent assist, auto-reply,
triage and knowledge ingest arrive with their own deliverables. Everything
below is configured in admin under **AI** (M7-10, see [The screens](#the-screens)),
through the API, or pinned in the environment.

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

## Voice transcription

Voice notes from the widget and Telegram can be transcribed for agents
(M7-09) by any Whisper-compatible `POST …/audio/transcriptions` endpoint:

| Setting | Environment | Example |
|---|---|---|
| `transcription.endpoint` | `HD_TRANSCRIPTION_ENDPOINT` | `https://api.openai.com/v1/audio/transcriptions`. Empty turns transcription off |
| `transcription.model` | `HD_TRANSCRIPTION_MODEL` | `whisper-1` (the default) |
| `transcription.apiKey` | `HD_TRANSCRIPTION_API_KEY` | Write-only, like provider keys |

## Per brand

`GET /api/brands/:brandId/ai/settings` answers the brand's AI settings and how
much it has spent today and this month.

| Setting | Who may change it | Default |
|---|---|---|
| Model (`providerId` + `modelId`) | Admin (`brand:manage`) | The install default |
| PII redaction | Admin | On |
| Injection filter on ingested content | Admin | On |
| Daily and monthly budget, US dollars | Admin | No limit |
| System prompt — tone, language policy, forbidden topics — for English and for Arabic conversations | Admin and Team Leader (`ai:manage`) | Empty; an empty Arabic prompt means the English one serves both |
| Modes: agent assist, auto-reply per channel (widget, email, Telegram) with a confidence threshold 0–1, the handoff message in English and Arabic, keep agent assist on after the hard stop | Admin | Every mode off; threshold 0.70; built-in handoff wording; keep assist on |
| AI reply satisfies the first-response SLA | Admin | On. The same `aiCountsAsFirstResponse` Ticketing › SLAs edits |

Admins change the model, guardrails and budget with `PUT …/ai/settings` (the
whole form) and the modes with `PUT …/ai/modes`; Team Leaders and Admins
change the prompts with `PUT …/ai/prompt`. Each is audited with the values
before and after (`ai.settings.updated`, `ai.modes.updated`,
`ai.prompt.updated`).

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
reads the ticket under the reader's own department scope first. The brand's
calls, newest first and without bodies, are listed by
`GET /api/brands/:brandId/ai/calls?cursor=…&limit=…` (`ai:manage`, 20 a page,
at most 100); a call's ticket is named only when the reader may open it.

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

Every knowledge chunk — crawled pages, uploads, Notion, Drive, and help center
articles too — passes through `screenIngestedText` from `@helpdock/ai` before
it is stored, while the brand's injection filter is on. A line that reads like an instruction to the model is
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

## Knowledge

What the assistant may read and cite, per brand. A brand's knowledge is a
list of **sources**; each source holds documents (an article, a file, a page),
and each document is cut into **chunks** that are embedded and searched.

### Sources

| Source | How it gets in | Sync | Visibility |
|---|---|---|---|
| Help center articles | Automatic: every published article, in each language | On publish, unpublish, archive and visibility change | Each article's own |
| Files | Upload a PDF, DOCX, Markdown or text file, up to 25 MB | On upload | `internal` unless you choose `public` |
| Website crawl | A sitemap URL, or a seed URL whose links are followed | Daily, weekly or manual | `internal` unless you choose `public` |
| Notion | OAuth through the install's Notion integration, or an internal integration token; pick pages and databases | Daily, weekly or manual | `internal` unless you choose `public` |
| Google Drive | OAuth through the install's Google Cloud app; pick folders | Daily, weekly or manual | `internal` unless you choose `public` |

Daily and weekly syncs run at 03:00 in the brand's time zone, weekly on
Sunday. "Sync now" runs any source at once; for the help center source it
re-reads every published article, which is also how articles published before
the install had M7 get in.

**Files.** The upload works like an attachment: the api presigns a PUT, the
browser uploads straight to the bucket, then confirms. The worker checks the
first bytes against the declared type ([ADR 0009](../decisions/0009-magic-byte-sniffing.md))
before any parser sees them — a "PDF" that is not one fails the sync with the
reason — then reads PDFs page by page (unpdf; a citation names the page), DOCX
through mammoth (headings kept), and Markdown and text as they are.

**Notion.** A page is read as Markdown with its headings; a database
contributes every page of each of its data sources. At most 2,000 pages a
source.

**Google Drive.** Each picked folder and its subfolders, five levels deep:
Google Docs are exported as HTML, Sheets as CSV, and PDF, DOCX, Markdown and
text files are read like uploads. Anything else, and any file over 25 MB, is
skipped and logged. At most 2,000 files a source.

Credentials — a Notion token, a Google refresh token — are encrypted under
`APP_MASTER_KEY` and never returned. When a service refuses them (revoked,
expired), the source fails with `status.code: "auth"`, which the admin shows
as "Reconnect".

### Website crawl

| Option | |
|---|---|
| `mode` | `sitemap` reads the sitemap (and nested sitemap indexes); `seed` starts at a page and follows its links |
| `url` | The sitemap or the seed page, `http` or `https` |
| `maxPages` | Pages indexed, 1 to 5,000; 100 by default |
| `include`, `exclude` | Patterns on the path and query, `*` for any run of characters: `/docs/*`, `*/changelog`. Empty `include` includes everything; `exclude` wins |
| `render` | Render pages in a headless Chromium, for sites that build their pages in the browser. Refused unless the install sets `KNOWLEDGE_CRAWL_RENDER=true` |

The rules a crawl keeps:

- **Every request goes through the SSRF-safe client** (DOMAIN-RULES §13):
  `robots.txt`, sitemaps, pages, and with `render` every request the browser
  makes, which is intercepted and answered by the same client. A private,
  loopback or metadata address is refused unless `OUTBOUND_ALLOW_CIDRS`
  allows it, and the sync fails with the reason. WebSockets and service
  workers are refused in the browser; images, media and fonts are not fetched.
- **`robots.txt` is respected**, for `HelpdockBot` or else `*`. A missing one
  allows everything; one that answers 5xx allows nothing. `Crawl-delay` is
  honoured up to 10 seconds; otherwise requests are a second apart.
- **Same origin only**: links and sitemap entries to other hosts are ignored.
  The seed page is always read for its links, and indexed only when the
  patterns include it.
- **HTML only**, 10 MB a page. A page that answers anything but 2xx is skipped
  and logged.

For a crawl with `render`, the worker needs Chromium (`npx playwright install
chromium`).

### Chunks

Each document is cut at its headings into chunks of about 500 tokens with 60
tokens of overlap, each opening with its heading path
([ADR 0020](../decisions/0020-knowledge-chunking-and-fusion.md)). Every chunk is
screened by the injection filter, labelled Arabic or English, and embedded in
the install's embedding model. A document whose content has not changed since
the last sync is skipped; documents a finished sync no longer found are
removed.

### Visibility

Only **public** knowledge answers visitors — the widget, Telegram, email
auto-reply and help center search. **Internal** knowledge helps agents only,
and agent assist marks its citations as internal. An article follows its own
visibility, and a help center in internal-only mode makes every article
internal.

Changing a source's visibility re-labels its chunks in the same request. An
article that is unpublished, archived or made internal stops answering
visitors the moment the change commits: retrieval checks the live article, not
the chunk's copy; the chunks themselves are rewritten within seconds.

### Removing a source

Removing a source deletes its documents and chunks in the same request
(DOMAIN-RULES §11: "immediate"); the assistant stops citing it at once. Its
uploaded file and its schedule are removed right after. Replies already sent
keep their text. The help center source cannot be removed; unpublish articles
instead.

### The sync log

Each sync writes lines to the source's log, newest first, as codes the admin
translates: `sync.started`, `robots.read`, `robots.unreadable`,
`sitemap.read`, `page.indexed`, `document.indexed`, `page.skipped`,
`document.skipped`, `injection.stripped`, `documents.removed`,
`embedding.deferred`, `file.rejected`, `sync.failed`, `sync.finished`.
`?level=warn` returns warnings and errors only. While a sync runs, the source
reports its progress (`260 / 520` pages).

### Retrieval

Features ask with an audience — `visitor` or `staff` (DOMAIN-RULES §5) — and
the reader's language:

```ts
import { createQueryEmbedder, createRetriever } from '../knowledge/retrieval/retrieve.js';

const retriever = createRetriever({ db, embedQuery: createQueryEmbedder(db, ai) });
const { chunks, mode } = await retriever.retrieve({
  brandId,
  query: 'how long do refunds take',
  audience: 'visitor',
  locale: 'ar',
  k: 6,
});
```

Two rankers — vector by cosine distance, and full text in the chunk's
language — each filter by the audience in SQL before they rank, and their
lists are merged by reciprocal rank fusion with a boost for the reader's
language. Vectors are used only while the embedding space is `ready`;
otherwise `mode` is `lexical`. Each chunk carries its 1-based `index`, which
is how the model cites it, and its `visibility`, so assist can mark internal
citations.

After the model answers, `validateCitations(answer, retrieved)` from
`@helpdock/ai` drops every `[n]` that was not in the retrieved set and sets
`handoff` when it dropped one: the reply must then be replaced by the handoff
message.

Help center search and the widget's suggestions gain the same semantic search
for articles beside their full-text search, filtered by the reader's audience
the same way; without an embedding model they stay full text only.

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
| `GET /api/install/ai/transcription` | install admin | Endpoint, model, whether a key is stored, what the environment locks |
| `PUT /api/install/ai/transcription` | install admin | 409 `locked-by-environment` |
| `GET /api/brands/:brandId/ai/settings` | `ai:manage` | Model, guardrails, budget, prompt, spend |
| `PUT /api/brands/:brandId/ai/settings` | `brand:manage` | Model, guardrails and budget |
| `PUT /api/brands/:brandId/ai/modes` | `brand:manage` | Agent assist, auto-reply per channel, handoff message, keep assist after the hard stop, AI reply counts as first response |
| `PUT /api/brands/:brandId/ai/prompt` | `ai:manage` | The system prompts (`systemPrompt`, optional `systemPromptAr`), up to 8000 characters each |
| `GET /api/brands/:brandId/ai/calls` | `ai:manage` | The brand's AI activity, keyset-paged |
| `GET /api/brands/:brandId/tickets/:ticketId/ai-calls` | `ticket:read` | The ticket's AI log, with the redaction map |
| `GET /api/brands/:brandId/knowledge/sources` | `ai:manage` | Sources with visibility, schedule, next sync, status and progress, counts; the embedding model; whether rendering and each OAuth app are available |
| `POST /api/brands/:brandId/knowledge/sources` | `ai:manage` | Add a crawl, Notion or Drive source. 400 `rendering-disabled` |
| `GET`, `PATCH`, `DELETE /api/brands/:brandId/knowledge/sources/:sourceId` | `ai:manage` | Read, edit (name, visibility, schedule, config, Notion token), remove. 409 `article-source-fixed` |
| `POST …/knowledge/sources/:sourceId/sync` | `ai:manage` | Sync now. 409 `not-connected`, `upload-missing` |
| `GET …/knowledge/sources/:sourceId/log` | `ai:manage` | The sync log; `?level=warn&limit=` |
| `GET …/knowledge/sources/:sourceId/browse` | `ai:manage` | Notion pages and databases (`?q=`) or Drive folders (`?parentId=`) for the picker. 409 `connection-refused` |
| `POST /api/brands/:brandId/knowledge/files` | `ai:manage` | Presign a file upload; creates the source |
| `POST …/knowledge/sources/:sourceId/confirm` | `ai:manage` | The upload is done; the sync starts. 409 `upload-missing` |
| `POST …/knowledge/sources/:sourceId/oauth/:provider` | `ai:manage` | The Notion or Google consent URL. 409 `oauth-not-configured` |
| `GET /api/knowledge/oauth/callback` | public, signed state | Where the provider returns; redirects to `/admin/ai/knowledge?source=…&oauth=connected` |

A refusal carries `error.ai.reason`, as `aiRefusalSchema` in `@helpdock/schemas`
declares, or for knowledge `error.knowledge.reason` (`knowledgeRefusalSchema`). Request and response shapes are the `ai*` schemas there.

## The screens

**AI** sits in the Admin group of the sidebar for Admins and Team Leaders.

- **Providers** (install admins only, `Admin/AI-Providers`): the providers
  table, the open provider's form — kind, base URL, credential type, the key
  (shown masked; "Replace" to change it), **Discover models** with each
  model's context and price — the install's default chat model and each
  brand's override, voice transcription, and the embedding model with its
  status and re-embed progress. Saving a different embedding model or
  dimension asks first and says what happens; more than 2000 dimensions is
  refused under the field. Anything an `HD_*` variable pins is drawn locked,
  with the variable named, and listed in a banner at the top.
- **Knowledge** (Admins and Team Leaders, `Admin/AI-Knowledge`): the brand's
  sources — the help center (automatic, each article keeps its own
  visibility), files, website crawls, Notion and Google Drive — with
  visibility, chunks, last sync, schedule and state, **Sync now** per source,
  and a search. **Add source** uploads files (one source per file, through a
  presigned upload), starts a crawl from a sitemap or a seed URL with its page
  cap, schedule, include and exclude patterns, or creates a Notion or Drive
  source and sends you to the service to connect it (Notion also takes an
  internal integration token). New sources are internal unless you choose
  public. Opening a source shows its facts — visibility and schedule are
  changed there — the Notion pages or Drive folders it reads, and its sync log
  in your language, with a Warnings filter. Removing a source deletes its
  chunks at once.
- **Assistant** (`Admin/AI-Assistant`): the modes, guardrails, budget (today
  and this month against the limits, and what happens at the hard stop),
  the system prompt in English and Arabic, and the brand's recent AI calls.
  At 80 % of a limit a warning banner says so; at 100 % a danger banner says
  auto-reply is off until the window resets, with **Raise limit**. A Team
  Leader reads the modes, guardrails and budget and edits the prompt.

The first-run wizard has an optional **AI provider** step after Outgoing
email: choose a provider, paste an API key (or subscription credentials),
**Test and find models**, and pick the default chat model — or skip it and do
the same in AI › Providers later.

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
- Connecting Notion or Drive with OAuth needs the install's OAuth app
  (`HD_KNOWLEDGE_NOTION_*`, `HD_KNOWLEDGE_GOOGLE_*`; redirect URI
  `APP_URL/api/knowledge/oauth/callback`). Notion also takes an internal
  integration token instead; Drive has no token alternative.
- A Drive or Notion item deleted at the service disappears at the next sync,
  not at once.
