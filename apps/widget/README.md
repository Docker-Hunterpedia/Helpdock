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
<script type="module" src="https://support.example.com/widget.js" data-brand="acme"></script>
```

- `type="module"` is required: the build is an ES module so it can load its
  lazy chunks.
- `data-brand` is the brand's public widget key. The script adds one
  `<helpdock-widget>` to the page when the page has none.
- `data-locale="ar"` or `data-locale="en"` forces a language. Without it the
  widget uses the page's `<html lang>`, then the browser's language, when either
  is English or Arabic, and English otherwise. Arabic lays out right to left.

To choose where the element sits in the DOM, place it yourself and leave
`data-brand` off the script:

```html
<helpdock-widget brand="acme" locale="ar"></helpdock-widget>
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
| `src/transport/create.ts` | The production transport. M4-04 fills it in; until then every call reports `unavailable` and the widget stays hidden. |
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

Until M5-10 the help center modes list the brand's popular articles from the
config and `searchArticles` filters them; M5-10 swaps in help center search
behind the same method.

### Size budget

DOMAIN-RULES §14: `widget.js` ≤ 40 KB gzipped; each lazy chunk ≤ 20 KB and all
of them ≤ 100 KB.

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

The harness (`harness/`) is an empty host page with the widget on the mock
transport, configured from the query string: `?locale=ar`,
`mode=chat|chat_articles|helpcenter|form`,
`availability=online|open_offline|closed`, `prechat=1`, `transcript=0`,
`scheme=light|dark|auto`. `window.helpdock.mock` plays the server:

```js
const { mock, agent } = window.helpdock;
mock.assign(agent, 'Billing');
mock.agentReply(agent, 'Hi Omar');
mock.emit({ type: 'typing', typing: true, agent });
mock.dropConnection(); mock.storeSilently(agent, 'missed'); mock.restoreConnection();
mock.end();
```
