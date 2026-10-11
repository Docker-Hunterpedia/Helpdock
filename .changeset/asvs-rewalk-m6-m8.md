---
'@helpdock/api': patch
---

Close the gaps the ASVS L2 re-walk of the Telegram, AI and API chapters found (M9-02). What an operator will notice:

- **API keys can expire.** `POST /api/brands/:brandId/api-keys` takes an optional `expiresAt` (ISO 8601, in the future); a key past it is refused with 401 like a revoked one. Keys already issued never expire, and the Create dialog has no field for it yet, so set it through the API. A migration adds `api_keys.expires_at` and runs when the api starts.
- **A refused API key leaves a trace.** The api logs a warning with the key's prefix and the caller's address, and a revoked or expired key writes an `api_key.refused` row to its brand's audit log, at most once a minute per key.
- **`webhooks:manage` no longer reads data on its own.** A key can create, change, rotate or replay a webhook endpoint only when it also holds the read scope of the endpoint's events: `tickets:read` for ticket and survey events, `contacts:read` for `contact.created`, `articles:read` for `article.published`. Otherwise it gets 403 `webhook-event-scope`. Endpoints that already exist keep delivering; a key that manages them needs the extra scope from now on.
- **An API key gets 403 on routes that act for a person**, such as `/api/me`, instead of a 500.
- **Model addresses are checked when saved.** An AI provider's base URL, the embeddings URL and the transcription endpoint must be https and must not resolve to a private, loopback or metadata address, unless the range is in `OUTBOUND_ALLOW_CIDRS`; a local Ollama or whisper.cpp in an allowed range still works over http. Values already saved are checked only when they change, and settings pinned with `HD_*` variables are not checked.
- **Delivery logs are purged.** The nightly retention run now deletes webhook deliveries that finished, and Telegram replies that were sent or failed, after 30 days, and stored `Idempotency-Key` answers after 24 hours. The windows are fixed.
- **"Anonymise contact" erases more.** It also deletes the contact's Telegram chats, clears the redaction maps of AI calls on their tickets and deletes the webhook deliveries that carry their data.
- **Uploaded and Google Drive DOCX files are refused** past 1,000 entries or 100 MiB unpacked. An upload's sync logs `file.rejected`; a Drive file is skipped and logged as `document.skipped`, with the reason.
- **JSON answers carry `Cache-Control: no-store`** unless the route sets its own. The public OpenAPI document and `/api/docs` show the API version, `1`, instead of the release.
- **A Notion or Google Drive connection callback works once**: a replayed callback URL answers 400.
