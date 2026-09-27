# 0012 Ship the widget as an ES module with lazy chunks and a catalog-compatible translator

Status: accepted
Date: 2026-09-27

## Context

M4-01 builds `apps/widget`: Preact in a Shadow DOM, built with Vite library mode into `widget.js` ([ARCHITECTURE §12](../planning/ARCHITECTURE.md#12-widget)). [DOMAIN-RULES §14](../planning/DOMAIN-RULES.md#14-performance-test-conditions) caps the initial `widget.js` at 40 KB gzipped, with everything the chat mode needs for first paint, and allows lazy chunks of at most 20 KB each and 100 KB together. The real transport still has to fit in the same 40 KB: M4-04 adds a Socket.IO client and the SSE fallback to the entry.

Three choices follow from that budget and were not settled anywhere:

1. **Bundle format.** An IIFE runs from a classic `<script src>`, but Rollup and Rolldown cannot split an IIFE, so every lazy chunk would be inlined into the entry.
2. **Translations.** AGENTS.md says every user-facing string goes through i18next with `en` and `ar` catalogs. i18next alone is about 13 KB gzipped, a third of the budget, before Preact, the UI and the transport.
3. **Styles under a strict host CSP.** A `<style>` element inside the shadow root is still subject to the host page's `style-src`; a customer with a strict CSP would get an unstyled widget.

## Decision

- `widget.js` is an **ES module** (`build.lib.formats: ['es']`) with its lazy chunks under `chunks/`, embedded with `<script type="module" src=".../widget.js" data-brand="…">`. The module finds its own tag by `import.meta.url`, because module scripts have no `document.currentScript`. `preserveEntrySignatures: 'allow-extension'` lets Rolldown fold shared modules into the entry instead of a common chunk the entry would fetch before first paint. The voice recorder, the help center browser, the article view and the CAPTCHA loader are lazy.
- The widget's strings live in the **`widget` namespace of `@helpdock/i18n`**, in i18next's own JSON format and under the same parity, plural and placeholder tests as every other namespace. At runtime the widget reads them with a **30-line translator** that implements the subset of i18next the catalogs use: nested keys, `{{name}}` interpolation, and plural suffixes chosen by `Intl.PluralRules`. Both catalogs are bundled, so first paint in Arabic needs no second request.
- Styles are one stylesheet imported as a string and applied with **constructable stylesheets** (`adoptedStyleSheets`), which a host CSP does not block; a `<style>` element is the fallback for engines without them. Fonts cannot be declared inside a shadow root, so the brand's self-hosted files are registered with the FontFace API.
- The brand theme reaches the widget **already resolved**: the config carries the DESIGN §2.2 semantic tokens for light and dark, computed on the server with `@helpdock/ui`, so the widget ships no colour maths and no Zod.

## Consequences

- The initial `widget.js` is about 25 KB gzipped without the real transport, leaving about 15 KB for it. `scripts/size.test.ts` builds the widget and fails the `unit` CI job when any cap in D §14 is exceeded; `pnpm --filter @helpdock/widget size` prints the same numbers.
- The embed tag must carry `type="module"`. Every browser that runs ES2022 (the build target) runs modules, so no visitor loses the widget over it.
- A catalog feature the translator does not implement (context, nesting with `$t()`, formatting functions) silently falls back to the key. The widget's own unit tests exercise every rule it does implement, and the catalog test keeps the files i18next-valid, so switching the widget to i18next later is a change of one import.
- The host page's CSP needs `script-src` for the Helpdock origin only; `style-src` needs nothing. A brand with CAPTCHA on adds the provider's hosts, as [ADR 0003](0003-turnstile-default-captcha.md) already says.

## Alternatives considered

- **IIFE with everything inlined.** Rejected: no lazy chunks, so the recorder, help center browser and CAPTCHA loader all count against the 40 KB entry.
- **A classic loader script that imports the module.** Rejected: two requests before first paint for no gain, since the loader could do nothing the module cannot.
- **i18next in the widget.** Rejected on size alone; it would be the largest dependency in the bundle while the widget uses none of what distinguishes it.
- **Inline `style` attributes or a `<style>` element.** Rejected: both are subject to the host page's CSP, and the widget must work on a page that forbids inline styles.
