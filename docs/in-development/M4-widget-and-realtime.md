# M4 Widget and realtime

Status: in progress
Started: 2026-09-27
Owner: @Docker-Hunterpedia

## Scope

[PRD, M4 Widget and realtime](../planning/PRD.md#m4-widget-and-realtime). Depends on M1 and M3; runs in parallel with M5.

## Deliverables

| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M4-01 | Widget build: Preact + Shadow DOM, Vite lib mode, single `widget.js`, size check in CI… | #106 | in review: Preact widget in a Shadow DOM, ES-module `widget.js` about 25 KB gzipped, served by the api at `/widget.js` with its lazy chunks and fonts (`WIDGET_DIST_DIR`); the real transport is a lazy chunk of about 17 KB (ADR 0012 and its amendment); size gate in the unit job |
| M4-02 | Visitor identity per D §4.1–4.2: server-issued `visitor_id` + `visitor_secret` (hashed… | #107 | in review: `widget_visitors` (secret hashed), ownership by visitor id, unverified pre-chat identity, signed identity (HMAC, 5-minute window) and `signed_identity_sees_all_channels`; an integration test proves a typed or leaked email opens nothing |
| M4-03 | Origin allow-list on config, token and Socket.IO handshake; per-visitor and per-IP… | #108 | in review: allow-list on every widget route and the `/widget` handshake, per-address, per-new-visitor and per-visitor-write throttles, optional Turnstile or hCaptcha (ADR 0003); an api-level Playwright test (`apps/admin/e2e/api/widget.api.spec.ts`) rejects a non-allowed origin |
| M4-04 | Realtime delivery contract per D §7: `client_id` + per-conversation `seq`, dedupe on… | #109 | in review: `clientId` dedupe, per-conversation `seq`, `?after=` catch-up, SSE fallback, typing, presence and queue position, agent replies relayed live; idempotent starts without text (`tickets.visitor_client_id`); the widget's real transport; integration tests for a network drop, an api restart and a double submit, and a browser test against the real api (`apps/admin/e2e/api/widget-live.api.spec.ts`) for a send cut off mid-flight and submitted twice |
| M4-05 | Four modes: chat, chat + suggested articles (stub until M7), help center only (stub… | #110 | in review: the four modes; `popularArticles` is empty until the help center has content (M5-10 fills it and swaps in search) |
| M4-06 | Theme tokens with live preview in admin; dark/light/auto; RTL by locale | #111 | in review: the widget's theming from the config's resolved tokens (`@helpdock/ui/resolve`), and the Channels › Widget appearance card with a live preview; accent contrast enforced server-side |
| M4-07 | Rich content policy per brand: text, emoji, images, video, voice, files with size and… | #112 | in review: the widget's composer, attachments and voice messages, and the per-brand content policy enforced at presign, at confirm and in the worker |
| M4-08 | Pre-chat form, business-hours awareness, transcript by email, agent avatar/name | #113 | in review: pre-chat form, `availability` with the next opening, transcript by email through the outbox from the brand's sender, agent name and avatar toggle |
| M4-09 | Hosted web form per brand with custom fields and CAPTCHA toggle | #114 | in review: `/contact` rendered by the api (ADR 0013), Channels › Web form, `form` tickets through the inbound pipeline, CAPTCHA with the brand's keys from Channels › Widget (the widget's verifier and key reader), per-IP and per-address limits, honeypot. [Guide](../guides/web-form.md) |
| M4-10 | Widget protocol documented in `docs/guides/widget-protocol.md` for native apps | #115 | in review: [widget-protocol.md](../guides/widget-protocol.md) |
| M4-11 | Accessibility: keyboard, focus, contrast, ARIA live regions | #116 | in review: keyboard, focus return, polite `role="log"`, 44 px targets; axe clean in en and ar |

## Artboards

On the [design canvas](https://claude.ai/artifact/RQd32d1RXK8DST8SKC1VBQ), under "M4 Widget and realtime": `Widget/States-EN`, `Widget/States-AR`, `Widget/Modes-EN`, `Widget/Modes-AR`, `Public/WebForm-EN`, `Public/WebForm-AR`, `Admin/Channels-Widget`, `Admin/Channels-WebForm` (plus the earlier `Widget · EN` and `Widget · AR`). The canvas note beside them records the decisions they settle.

## Exit criteria

- [ ] Widget embedded on two origins under two brands, each with its own theme, exchanging messages with agents in the admin. One origin and one brand are proved in a browser (`widget-live.api.spec.ts`); the second brand's theme is proved by the config's integration test, not yet in a browser.
- [x] Requests from a non-allowed origin are rejected in an E2E test (`widget.api.spec.ts`, and the handshake in `widget.integration.test.ts`).
- [ ] Dropping the network mid-send, restarting the api, and double-submitting each leave exactly one message and the widget catches up without user action (Playwright with network interruption). The drop and the double submit are proved in a browser against the real api (`widget-live.api.spec.ts`); the api restart is proved at the server (`widget.integration.test.ts`) but not yet with a browser attached.
- [x] A visitor with a guessed or leaked email address cannot open another contact's conversations (`widget.integration.test.ts`).
- [x] Initial bundle ≤ 40 KB and lazy chunk caps pass in CI per D §14 (`apps/widget/scripts/size.test.ts`, in the unit job). The widget's own Playwright suite does not run in CI yet; that needs a workflow change.

## Open questions

- M4-09: a form submission from an address another contact already holds makes a second contact and a duplicate suggestion (DOMAIN-RULES §4.4). Until an agent merges them, agent replies on that ticket are not emailed, because the new contact holds no address. Should a form ticket remember its typed address for replies?

## Pull requests

- Widget UI (M4-01, M4-11 and the widget side of M4-05 to M4-08): #129.
- Widget server, protocol guide and Channels › Widget, integrated with the UI and the real transport (M4-02, M4-03, M4-04, M4-10, the server side of M4-05 to M4-08): this branch.
