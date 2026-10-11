# @helpdock/widget

The chat widget customers put on their own sites: a Preact app in a Shadow DOM,
built by Vite in library mode into one `widget.js` plus lazy chunks
([ARCHITECTURE §12](../../docs/planning/ARCHITECTURE.md#12-widget),
[ADR 0012](../../docs/decisions/0012-widget-bundle-shape.md)). It is drawn from
the canvas artboards `Widget/States-EN`, `Widget/States-AR`, `Widget/Modes-EN`,
`Widget/Modes-AR` and the earlier `Widget · EN` / `Widget · AR`, and from
[DESIGN §6.6](../../DESIGN.md#66-widget).

## Embedding it

```html
<script type="module" src="https://support.example.com/widget.js" data-brand="0192c3f0-…"></script>
```

Channels › Widget in the admin shows this tag with the brand's id filled in.
The page's origin must be one of the brand's allowed origins on that tab.

- `type="module"` is required: the build is an ES module so it can load its
  lazy chunks.
- `data-brand` is the brand's id. The script adds one
  `<helpdock-widget>` to the page when the page has none.
- `data-locale="ar"` or `data-locale="en"` forces a language. Without it the
  widget uses the page's `<html lang>`, then the browser's language, when either
  is English or Arabic, and English otherwise. Arabic lays out right to left.

To choose where the element sits in the DOM, place it yourself and leave
`data-brand` off the script:

```html
<helpdock-widget brand="0192c3f0-…" locale="ar"></helpdock-widget>
<script type="module" src="https://support.example.com/widget.js"></script>
```

### Commands

Module scripts run after the page has parsed, so commands go through a queue
the page defines first. The widget replays it in order when it loads:

```html
<script>
  window.Helpdock = window.Helpdock || function () { (Helpdock.q = Helpdock.q || []).push(arguments); };
  Helpdock('identify', { user_id: '42', email: 'omar@example.com', name: 'Omar', ts: 1790000000, signature: '…' });
</script>
```

| Command | Effect |
|---|---|
| `Helpdock('identify', payload)` | Signed identity (M4-02, [DOMAIN-RULES §4.2](../../docs/planning/DOMAIN-RULES.md#42-signed-identity)). `payload` is `{ user_id, email?, name?, ts, signature }`, where `signature` is `HMAC-SHA256(brand_widget_secret, canonical_json)` computed **on your server**; never put the secret in the page. The widget forwards the payload untouched and restarts its session under it. An invalid signature leaves the visitor anonymous. |
| `Helpdock('open')` | Opens the window. |
| `Helpdock('open', { article: '<article id>' })` | Opens it from a help center article's "Still need help?" (M5-08). The next conversation or contact form the visitor sends names that article, and the agents see it in the ticket's thread. The api records it only for a published public article of the brand. |
| `Helpdock('close')` | Minimises it. |

### Content security policy

The host page needs `script-src` (and `connect-src`) for the Helpdock origin.
Styles are applied through constructable stylesheets inside the shadow root, so
`style-src` needs nothing. A brand with CAPTCHA on also needs the provider's
hosts ([ADR 0003](../../docs/decisions/0003-turnstile-default-captcha.md)).

## How it is built

| Path | What |
|---|---|
| `src/main.ts` | The `widget.js` entry: finds its own `<script>` tag, defines `<helpdock-widget>`, installs `Helpdock()`. |
| `src/embed.ts` | The custom element, the command queue and auto-placement. |
| `src/mount.tsx` | Shadow root, stylesheet, theme (`--hd-*` from the config, light/dark/auto), fonts, and the Preact render. |
| `src/transport/types.ts` | **`WidgetTransport`**, the only seam between the UI and the server. |
| `src/transport/create.ts` | The production transport's shell in `widget.js`: the first call fetches `remote.ts` (its own lazy chunk) and hands every call to it. |
| `src/transport/remote.ts` | The real transport (M4-04): REST under `/api/widget/:brandId`, the `/widget` socket, the SSE fallback, the visitor secret in `localStorage`, idempotent starts, uploads held until their message is sent. |
| `src/transport/map.ts` | The api's camelCase wire ([widget protocol](../../docs/guides/widget-protocol.md)) as the UI's types. |
| `src/transport/http.ts`, `sse.ts`, `protocol.ts` | The REST client and its refusals, the SSE reader, the protocol's constants. |
| `src/transport/mock.ts`, `fixtures.ts` | An in-memory server for tests and the harness, with levers to play the agent and the network. |
| `src/state/thread.ts` | The delivery contract of [DOMAIN-RULES §7](../../docs/planning/DOMAIN-RULES.md#7-realtime-delivery-contract) as a pure reducer: dedupe by `seq` and `client_id`, the `lastSeq` cursor, gap detection, catch-up, read receipts. |
| `src/state/send.ts` | Retries within the 10 s window with the same `client_id`; UUIDv7. |
| `src/state/controller.ts` | The one module that talks to the transport: session, conversation, sends, events, reconnect catch-up, typing, uploads. |
| `src/state/policy.ts` | The client half of the brand's content policy (M4-07). |
| `src/ui/` | The screens: launcher, window, header, strips, thread, composer, pre-chat form, ended state, contact form. |
| `src/help/`, `src/voice/`, `src/captcha/` | Lazy chunks: help center browser and article view, the MediaRecorder recorder, the CAPTCHA loader. |
| `src/i18n/` | A translator over the `widget` namespace of `@helpdock/i18n` (ADR 0012). |

### The transport seam

`WidgetTransport` follows DOMAIN-RULES §7: REST is the source of truth and
sockets are notifications. `sendMessage` resolves only once the server has
assigned a `seq`; a retry reuses the same `client_id` and the server answers
with the original message. `subscribe` delivers `message` and `receipt` events
(durable: a `seq` gap or a reconnect makes the controller call
`listMessages(after = lastSeq)`) and `typing`, `presence` and `queue` events
(ephemeral, never replayed). The visitor credential of DOMAIN-RULES §4.1 is the
transport's own business and never reaches the UI.

The help center modes (M5-10) list the brand's popular public articles from
the config, search with `searchArticles` (logged for Help center › Insights)
and open an article with `getArticle` (which counts a view, and names the
search it came from). The chat composer's "Articles that might help" strip in
`chat_articles` mode calls `suggestArticles`, the same search unlogged, 400 ms
after the visitor stops typing. An article with no help center address
(`url: null`, a brand with no help center domain yet) opens in the window only.

### Size budget

DOMAIN-RULES §14: `widget.js` ≤ 40 KB gzipped; each lazy chunk ≤ 20 KB and all
of them ≤ 100 KB. The transport must be a lazy chunk of its own
(`chunks/remote-*.js`, ADR 0012's amendment); today the entry is about 30 KB
and the transport about 17.5 KB.

```bash
pnpm --filter @helpdock/widget size    # build, then print every file's gzipped size
```

CI enforces it through `scripts/size.test.ts`, which builds the widget and
fails when a cap is exceeded. It runs in the `unit` job with the rest of the
widget's tests.

## Running it

```bash
pnpm --filter @helpdock/widget dev     # the harness page on http://localhost:5275
pnpm --filter @helpdock/widget test    # unit and component tests (Vitest, happy-dom)
pnpm --filter @helpdock/widget e2e     # Playwright on the harness, en and ar, with axe
```

The api serves the build at `/widget.js`, `/chunks/:file` and
`/widget-fonts/:file` from `WIDGET_DIST_DIR` (the image puts it at
`/app/widget`). The end-to-end test against a real api, with a customer page
on its own origin, is `apps/admin/e2e/api/widget-live.api.spec.ts`, with
`widget-brands` (two brands on two origins), `widget-restart` (an api restart
mid-send) and `widget` (a non-allowed origin) beside it
(`pnpm --filter @helpdock/admin e2e:api`, after `pnpm build`).

The harness (`harness/`) is an empty host page with the widget on the mock
transport, configured from the query string: `?locale=ar`,
`mode=chat|chat_articles|helpcenter|form`,
`availability=online|open_offline|closed`, `hours=never|absent` (the hours a
conversation carries: a calendar that never opens, or none, as an older server
sends), `prechat=1`, `transcript=0`, `scheme=light|dark|auto`.
`window.helpdock.mock` plays the server:

```js
const { mock, agent } = window.helpdock;
mock.assign(agent, 'Billing');
mock.agentReply(agent, 'Hi Omar');
mock.emit({ type: 'typing', typing: true, agent });
mock.dropConnection(); mock.storeSilently(agent, 'missed'); mock.restoreConnection();
mock.end();
```
