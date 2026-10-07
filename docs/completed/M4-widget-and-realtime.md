# M4 Widget and realtime

Status: shipped
Started: 2026-09-27
Shipped: 2026-09-27
Owner: @Docker-Hunterpedia

## Scope

A brand's customers chat with its agents from a widget embedded on the
brand's own site, or write through a hosted contact form. The widget is a
Preact app in a Shadow DOM, loaded with one `<script type="module">` tag from
the api. It talks to the widget API over REST, the `/widget` Socket.IO
namespace and an SSE fallback, under the delivery contract of DOMAIN-RULES §7:
a retry never duplicates a message, and a client that was away catches up by
itself. Visitors are identified by a server-issued secret, never by an email
they type. Admins configure the widget and the form under Channels.

Full deliverable list and specs: [PRD §4 · M4 Widget and realtime](../planning/PRD.md#m4-widget-and-realtime).
Depends on M1 (shipped 2026-09-25) and M3 (shipped 2026-09-27). Ran in
parallel with [M5 Help center](M5-help-center.md), which fills the widget's
help center and "chat + articles" modes (M5-10).

Built from the design canvas artboards, under "M4 Widget and realtime":
`Widget/States-EN`, `Widget/States-AR`, `Widget/Modes-EN`, `Widget/Modes-AR`,
`Public/WebForm-EN`, `Public/WebForm-AR`, `Admin/Channels-Widget` and
`Admin/Channels-WebForm`, plus the earlier `Widget · EN` and `Widget · AR`.

## Deliverables

| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M4-01 | Widget build: Preact and Shadow DOM, one `widget.js`, size check in CI | #106 | shipped (#129, #132) |
| M4-02 | Visitor identity: server-issued id and secret, ownership by visitor, unverified pre-chat email, signed identity | #107 | shipped (#132) |
| M4-03 | Origin allow-list, per-visitor and per-address throttles, optional Turnstile or hCaptcha | #108 | shipped (#132) |
| M4-04 | Realtime delivery contract: `clientId`, per-conversation `seq`, catch-up, SSE fallback, typing, presence, queue | #109 | shipped (#132) |
| M4-05 | Four modes: chat, chat + articles, help center, contact form | #110 | shipped (#129, #132; real articles in M5-10, #135) |
| M4-06 | Theme tokens with live preview in admin; light, dark and auto; RTL by locale | #111 | shipped (#129, #132) |
| M4-07 | Rich content policy per brand: images, video, voice, files with caps | #112 | shipped (#129, #132) |
| M4-08 | Pre-chat form, business-hours awareness, transcript by email, agent name and avatar | #113 | shipped (#129, #132) |
| M4-09 | Hosted web form per brand with custom fields and CAPTCHA | #114 | shipped (#133) |
| M4-10 | Widget protocol for native apps | #115 | shipped (#132): [widget-protocol.md](../guides/widget-protocol.md) |
| M4-11 | Accessibility: keyboard, focus, contrast, ARIA live regions | #116 | shipped (#129) |

## Exit criteria

Copied from the PRD. All five are met. The browser tests in
`apps/admin/e2e/api/` run against a real api, Postgres and Redis in CI's
`browser-api` job (`pnpm --filter @helpdock/admin e2e:api`); the integration
tests use Testcontainers.

- [x] **Widget embedded on two origins under two brands, each with its own
      theme, exchanging messages with agents in the admin.**
      `apps/admin/e2e/api/widget-brands.api.spec.ts` › "the widget under two
      brands on two origins". The spec adds a second brand through
      `POST /api/install/brands`, gives each brand its own accent and a
      customer page on its own origin, and proves three things. "each brand’s
      widget runs on its own origin in its own accent": each launcher is drawn
      in its own brand's accent. "each visitor’s message becomes a ticket of
      that brand only": each message becomes a ticket with its brand's prefix,
      and the other brand's api answers 404 for it. "an agent answers each in
      the admin under its brand, and only that visitor sees it": the agent
      switches brand in the admin and answers each ticket, and each answer
      reaches its own visitor only. The theme the config resolves is
      `apps/api/src/widget/widget.integration.test.ts` › "the config the widget
      paints from (M4-06, M4-08)" › "resolves the theme, and words the greeting and the fields
      in the language asked".
- [x] **Requests from a non-allowed origin are rejected in an E2E test.**
      `apps/admin/e2e/api/widget.api.spec.ts` › "refuses a page on an origin
      the brand has not allowed, and serves it once allowed": a real page's
      `fetch` of the config and the session is refused with
      `origin_not_allowed` until an Admin adds the origin. The socket
      handshake is `widget.integration.test.ts` › "the origin allow-list
      (M4-03)" › "refuses the socket handshake from another origin".
- [x] **Dropping the network mid-send, restarting the api, and
      double-submitting each leave exactly one message, and the widget catches
      up without user action (Playwright with network interruption).**
      - Network drop and double submit:
        `apps/admin/e2e/api/widget-live.api.spec.ts` › "a send cut off
        mid-flight and submitted twice lands once, and the widget catches up by
        itself". The request reaches the api twice with one `clientId`, then
        the browser goes offline. The agent answers meanwhile. Back online, the
        widget and the ticket each hold the message once and show the answer.
      - API restart: `apps/admin/e2e/api/widget-restart.api.spec.ts` › "a send
        the api died under lands once, and the widget catches up when it is
        back". The widget talks to an api replica of its own
        (`startApiReplica` in `e2e/api/install.ts`), killed as a send reaches
        it and started again, so the api the other specs share never stops.
        The agent answers through the shared api while the replica is down.
      - At the server: `widget.integration.test.ts` › "the delivery contract
        (M4-04)" › "keeps one message for a double submit, and one
        conversation for a double start", "answers a retry after the api
        restarts with the message that exists" and "catches a client up from
        its cursor, past notes it never sees".
- [x] **A visitor with a guessed or leaked email address cannot open another
      contact's conversations.** `widget.integration.test.ts` › "visitor
      identity (M4-02)" › "never opens another contact’s conversations to a
      visitor who types their email (exit criterion)".
- [x] **Initial bundle ≤ 40 KB and lazy chunk caps pass in CI per D §14.**
      `apps/widget/scripts/size.test.ts` › "the production build" › "emits
      widget.js plus lazy chunks, and stays within DOMAIN-RULES §14" and "keeps
      socket.io-client out of widget.js", with the budget's own unit tests
      beside them. It runs in CI's `unit` job. At close-out, `widget.js` is
      25.6 KB gzipped. The transport chunk is 17.0 KB and the other four lazy
      chunks are about 1 KB each. **Deviation:** the real transport
      (socket.io-client, the SSE reader and the REST calls) is a lazy chunk,
      not part of `widget.js`, so the chat mode's first paint waits for one
      chunk as well as the config. D §14 says the initial `widget.js` holds
      everything the first paint needs. Folding the transport in would take
      the entry to about 42 KB, over the cap.
      [ADR 0012's amendment](../decisions/0012-widget-bundle-shape.md#amendment-the-transport-is-a-lazy-chunk-2026-09-27)
      records the choice and leaves a reviewer to decide whether D §14 is
      reworded or the entry is trimmed.

## Effort

| | |
|---|---|
| Estimated | 5–6 weeks (PRD status board) |
| Started | 2026-09-27 |
| Shipped | 2026-09-27 |
| Actual | 1 day, in parallel with M5 |

AI coding agents built the widget UI, the widget server and the web form in
parallel worktrees. The server branch then integrated the UI with the real
transport, and the maintainer reviewed and merged the PRs.

## Migrations

- `0031_widget`: `widget_settings` and `widget_visitors` (brand; the visitor
  secret is stored hashed), and `tickets.visitor_id` and
  `tickets.visitor_client_id` for idempotent starts.
- `0032_web_form`: `web_form_settings` (brand) and `custom_field_defs.web_form`.

Both new tables are in `TENANT_TABLES` and the RLS negative suite.

## Gaps and follow-ups

Written down and carried forward. None of them blocks M6, M7 or M8.

| Gap | Why it was accepted | Where it is written down |
|---|---|---|
| ~~`agents_online` is always empty against a real api~~ | Closed in M9: availability and the `presence` frame carry `agents` (first names, empty when the brand hides agents), and `apps/widget/src/transport/map.ts` maps them. | This doc |
| **Non-text custom fields are asked as text** in the pre-chat and contact forms | The widget draws every custom field as a text input. The api validates the answer against the field's type, so a bad value is refused, not stored. | This doc |
| **The web form's file input is worded in the browser's language**, not the page's | A native `<input type="file">` draws its own button ("Choose file"), which the page cannot translate. | This doc |
| **A form ticket from an address another contact holds gets no emailed replies until the contacts are merged** | DOMAIN-RULES §4.4 never hands a typed address another contact's history. The new contact holds no address until an agent merges it, so the acknowledgment reaches the typed address and agent replies do not. Whether a form ticket should remember its typed address for replies is an open question. | [web form guide](../guides/web-form.md#the-typed-address-is-a-claim) |
| ~~The widget's Playwright suite is not in CI~~ | Closed in #139: the `widget-e2e` job runs `pnpm --filter @helpdock/widget e2e` on Chromium. | [CI workflow](../../.github/workflows/ci.yml) |
| **The real-api suite is close to the sign-in limit** | Every spec in `apps/admin/e2e/api/` signs in from one address, and the api allows twenty sign-in attempts per address in fifteen minutes (`SIGN_IN_IP_RULE`). The widget specs share one signed-in page (the `admin` worker fixture) for this reason. A new spec that signs in on its own may push the last spec over the limit. | [admin README](../../apps/admin/README.md) |
| ~~`widget.spec.ts` › "chat: queue position, agent, typing, and the ended state with a transcript" is flaky in `en`~~ | Closed by M9-04 (#147): the theme sheet is no longer replaced on every state change, and axe waits for the widget to settle. It was not reproduced locally before or after. | [accessibility audit](accessibility-audit.md#the-flaky-contrast-failure-in-widgetspects) |
| ~~Visitors are never purged~~ | Closed by follow-up #143: `maintenance.retention` deletes inactive visitors without conversations under the saved brand window. | [data retention](../guides/data-retention.md) |
| **D §14 and the lazy transport** | See the fifth exit criterion. | [ADR 0012](../decisions/0012-widget-bundle-shape.md) |

## Decisions settled

| Decision | Where |
|---|---|
| The widget is an ES-module `widget.js` in a Shadow DOM. Its real transport, the recorder and the help center are lazy chunks. | [ADR 0012](../decisions/0012-widget-bundle-shape.md) |
| The hosted web form is rendered by the api as plain HTML, not by a separate app | [ADR 0013](../decisions/0013-web-form-page-rendered-by-the-api.md) |
| The widget and the web form share the brand's CAPTCHA keys, edited on Channels › Widget | [ADR 0003](../decisions/0003-turnstile-default-captcha.md), [web form guide](../guides/web-form.md) |
| A brand added after setup gets the six built-in statuses and the default views, as the first brand does. Found at close-out: without them no ticket could be filed in it, so the widget answered "not available". | [ticketing settings](../guides/ticketing-settings.md#adding-a-brand) |

## What an operator can do with this milestone

Embed the widget on a brand's site with the tag Channels › Widget shows, list
the origins it may run on, and choose its mode, accent, colour scheme,
position, launcher, greeting, pre-chat form, content policy, transcript option
and bot check. A brand's own site can sign its signed-in users so their
conversations follow them across devices. Turn on the hosted contact form on
Channels › Web form, with the custom fields to ask. Agents answer widget and
form tickets in the same workspace as every other ticket, and see which help
center article a customer came from. Native apps can speak the same protocol
([widget-protocol.md](../guides/widget-protocol.md)).

## Pull requests

- #129 feat(widget): the Preact widget app, modes, theming and accessibility (M4-01, M4-11, widget side of M4-05..08)
- #132 feat(widget): widget server, identity, realtime and the live transport (M4-02..08, M4-10)
- #133 feat(web-form): hosted web form per brand with custom fields and CAPTCHA (M4-09)
- #135 (M5) wired the widget's help center and "chat + articles" modes to real content (M5-10)
