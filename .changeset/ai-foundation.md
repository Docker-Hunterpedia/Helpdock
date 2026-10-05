---
'@helpdock/api': minor
---

AI foundation (M7-01, M7-02, M7-08), API only. Install admins configure AI providers through `/api/install/ai`: an API key, subscription (OAuth) credentials or none for a local OpenAI-compatible server, stored encrypted and never returned; model discovery; the default model; and the one embedding model of the install, whose change re-embeds every knowledge chunk in the worker without ever serving two models at once. Brands set a model override, PII redaction, the injection filter, a daily and monthly budget and a system prompt through `/api/brands/:brandId/ai`. Every model call is logged to `ai_calls` with its tokens and cost, and a ticket's calls are readable at `/api/brands/:brandId/tickets/:ticketId/ai-calls`. Data retention now nulls AI call bodies after the brand's AI-log window and keeps their counts and cost. See `docs/guides/ai.md`.
