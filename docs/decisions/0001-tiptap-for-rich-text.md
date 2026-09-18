# 0001 Use TipTap for article and reply editing

Status: accepted
Date: 2026-09-18

## Context

Two surfaces need a rich-text editor in the admin app: help center articles ([REQUIREMENTS §4.5](../planning/REQUIREMENTS.md#45-help-center) — images with automatic WebP conversion, code blocks, callouts, tables, embedded video by URL, anchors, Markdown import/export) and agent replies. Both live in the admin SPA (Vite + React 19 + MUI, [ARCHITECTURE §1](../planning/ARCHITECTURE.md#1-stack-at-a-glance)). The widget does not ship an editor, so the < 40 KB widget budget does not constrain this choice; the admin bundle does, but only to the extent that we should not carry two editor frameworks.

The hard constraint is bidirectional text. The product UI is English and Arabic with full RTL in v1, and a single Arabic article routinely contains LTR runs — product names, URLs, code. Direction therefore has to be settable per block and detectable per paragraph, not applied once as a page-level `dir`. An editor that only reverses the toolbar is not enough.

The second constraint is the output. What the editor produces is stored, re-rendered by the help center SSR app, indexed into a tsvector, and in the reply case turned into an email body. That means the output has to be a small, known set of nodes rather than arbitrary contenteditable HTML.

The third is licensing. Helpdock is AGPL-3.0 and self-hosted. A dependency that needs a licence key, a hosted service or a paid registry account to function is not acceptable, because it would make an install depend on a vendor relationship the operator never entered into.

## Decision

Use TipTap, the ProseMirror-based editor, for both article and reply editing: `@tiptap/core`, `@tiptap/react` and `@tiptap/starter-kit`, plus the MIT extensions for tables, images and syntax-highlighted code blocks, and a callout node we define ourselves. The current release is 3.31.3, published to the public npm registry under MIT, and `@tiptap/react` declares React 19 in its peer dependencies.

We use only MIT packages from the public registry. TipTap's paid tier exists — the Pro and Cloud extensions are tied to hosted services such as collaboration, comments and document conversion — and we use none of it. Adopting any non-MIT TipTap package would need its own ADR.

Direction is handled by the editor's own support for it: the editor is configured with `textDirection: 'auto'` so mixed content resolves per block, and the `setTextDirection` / `unsetTextDirection` commands give authors an explicit override.

The editor's HTML is the stored format. The server sanitises it against an allow-list that mirrors the editor schema before writing, and the same sanitiser runs on Markdown import and on content that arrives through the API.

## Consequences

- Bidi is a configuration, not a project. `textDirection: 'auto'` plus per-node overrides is the behaviour Arabic authors need, and we do not have to write or maintain it.
- TipTap is headless. It imposes no CSS, so the toolbar is ours, built from MUI components, inheriting our theme and our RTL provider. The cost is real: we build every toolbar control, each one needs an i18n key in `en` and `ar`, and each one needs Playwright coverage in both locales.
- ProseMirror parses input into a schema, so tags and attributes the schema does not know are dropped on the way in. This is a useful property but **not** a security boundary — content also arrives by Markdown import and by API, neither of which passes through the browser editor — so server-side sanitisation stays mandatory.
- ProseMirror is a substantial dependency. The admin bundle grows, which is acceptable for a staff application but not free, so the editor is loaded on a split route: login, the ticket list and the brand switcher must not pay for it.
- The upstream is a company with a commercial cloud, which creates a standing risk that features drift behind the paid tier. Two things bound it: the core is MIT and forkable, and the drift has so far gone the other way — in 2025 ten formerly-Pro extensions were relicensed MIT.
- Real-time collaborative editing is not in v1 scope. TipTap leaves the door open through Y.js without us paying anything for it now.

## Alternatives considered

- **Lexical (0.51.0, MIT).** Meta's editor, with solid IME and accessibility work and genuine RTL handling. Rejected because it is still pre-1.0, and because the surrounding ecosystem for the nodes we actually need — tables, images, syntax-highlighted code, callouts — is thinner, so we would be writing and maintaining more of them ourselves. Its HTML import/export story is also less settled than ProseMirror's, and we depend on HTML round-tripping for Markdown import and server-side rendering.
- **Slate (slate 0.126.2 / slate-react 0.126.4, MIT).** A framework for building editors rather than an editor. Rejected because everything above the document model — nodes, toolbar, paste handling, and the bidi behaviour TipTap ships — would be ours to write, and it remains pre-1.0 with a history of breaking changes in minor releases. The flexibility is real but we do not need a custom document model; we need tables and callouts that work in Arabic.
- **A plain Markdown textarea.** The cheapest and safest option, and it deserves serious consideration for an AGPL project that values small surface area. Rejected because the requirements ask for tables, callouts, images auto-converted to WebP on paste, embedded video and anchors, and because agents writing customer replies under time pressure should not have to know Markdown syntax. It also does not remove the sanitisation problem, it only moves it to the renderer.
