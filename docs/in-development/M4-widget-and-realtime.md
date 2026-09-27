# M4 Widget and realtime

Status: in progress
Started: 2026-09-27
Owner: @Docker-Hunterpedia

## Scope

[PRD, M4 Widget and realtime](../planning/PRD.md#m4-widget-and-realtime). Depends on M1 and M3; runs in parallel with M5.

## Deliverables

| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M4-01 | Widget build: Preact + Shadow DOM, Vite lib mode, single `widget.js`, size check in CI… | #106 | not started |
| M4-02 | Visitor identity per D §4.1–4.2: server-issued `visitor_id` + `visitor_secret` (hashed… | #107 | built in branch: `widget_visitors` (secret hashed), ownership by visitor id, unverified pre-chat identity, signed identity (HMAC, 5-minute window) and `signed_identity_sees_all_channels`; an integration test proves a typed or leaked email opens nothing |
| M4-03 | Origin allow-list on config, token and Socket.IO handshake; per-visitor and per-IP… | #108 | built in branch: allow-list on every widget route and the `/widget` handshake, per-address, per-new-visitor and per-visitor-write throttles, optional Turnstile or hCaptcha (ADR 0003); an API-level Playwright test (`apps/admin/e2e/api/widget.api.spec.ts`) rejects a non-allowed origin |
| M4-04 | Realtime delivery contract per D §7: `client_id` + per-conversation `seq`, dedupe on… | #109 | server and transport built in branch: `clientId` dedupe, per-conversation `seq`, `?after=` catch-up with `lastSeq`, SSE fallback, typing, presence and queue position, the `/widget` namespace, agent replies relayed live; integration tests for a network drop, an api restart and a double submit. The browser-level network-interruption test waits for the widget UI (M4-01) |
| M4-05 | Four modes: chat, chat + suggested articles (stub until M7), help center only (stub… | #110 | not started |
| M4-06 | Theme tokens with live preview in admin; dark/light/auto; RTL by locale | #111 | admin half built in branch: the Channels › Widget appearance card with a live preview (light and dark, en and ar); accent contrast enforced server-side. The widget's own theming is M4-01's |
| M4-07 | Rich content policy per brand: text, emoji, images, video, voice, files with size and… | #112 | server half built in branch: per-brand content policy caps enforced at presign, at confirm and in the worker, and the admin card |
| M4-08 | Pre-chat form, business-hours awareness, transcript by email, agent avatar/name | #113 | server half built in branch: pre-chat fields, `GET availability` with the next opening, transcript by email through the outbox from the brand's sender, the agent name and avatar toggle. The widget screens are M4-01 and M4-05's |
| M4-09 | Hosted web form per brand with custom fields and CAPTCHA toggle | #114 | not started |
| M4-10 | Widget protocol documented in `docs/guides/widget-protocol.md` for native apps | #115 | built in branch: [widget-protocol.md](../guides/widget-protocol.md) |
| M4-11 | Accessibility: keyboard, focus, contrast, ARIA live regions | #116 | not started |

## Artboards

On the [design canvas](https://claude.ai/artifact/RQd32d1RXK8DST8SKC1VBQ), under "M4 Widget and realtime": `Widget/States-EN`, `Widget/States-AR`, `Widget/Modes-EN`, `Widget/Modes-AR`, `Public/WebForm-EN`, `Public/WebForm-AR`, `Admin/Channels-Widget`, `Admin/Channels-WebForm` (plus the earlier `Widget · EN` and `Widget · AR`). The canvas note beside them records the decisions they settle.

## Exit criteria

- [ ] Widget embedded on two origins under two brands, each with its own theme, exchanging messages with agents in the admin.
- [ ] Requests from a non-allowed origin are rejected in an E2E test.
- [ ] Dropping the network mid-send, restarting the api, and double-submitting each leave exactly one message and the widget catches up without user action (Playwright with network interruption).
- [ ] A visitor with a guessed or leaked email address cannot open another contact's conversations.
- [ ] Initial bundle ≤ 40 KB and lazy chunk caps pass in CI per D §14.

## Open questions

- None yet.

## Pull requests

- None yet.
