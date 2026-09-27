# 0013 Render the hosted web form as plain HTML from the api until the help center exists

Status: accepted
Date: 2026-09-27

## Context

M4-09 ships the hosted web form per brand ([REQUIREMENTS §4.4](../planning/REQUIREMENTS.md#44-channels)): a public page at `/contact` on the brand's help center host, drawn on the `WebFormEN` and `WebFormAR` artboards, whose submission opens a `form`-channel ticket. It needs its fields (built-in and the brand's custom ones), attachments, an optional CAPTCHA, an error summary and a thank-you page with the ticket reference, in both languages.

By [ARCHITECTURE §11](../planning/ARCHITECTURE.md#11-help-center-ssr--custom-domains) a customer-facing page on a brand domain belongs to `apps/helpcenter`, the Vite SSR app the api hosts. That app is M5 wave 2 and does not exist yet. [ADR 0010](0010-csat-page-in-the-admin-bundle.md) solved the same problem for the rating page by mounting it from the admin bundle, and rejected plain server-rendered HTML there because the page needed client script for its toggle buttons and would have duplicated the design system.

The web form is different in the two ways that decided 0010:

- **It needs no client script.** A form that posts, and a server that answers with the page again — its errors, or the reference — is the whole interaction. The error summary takes focus with `autofocus`, and nothing else moves.
- **It is on the brand's host, not the install's.** The admin bundle is the install's admin SPA; serving it from `support.brand.com` would put the whole admin's JavaScript and routes on a customer domain for one form.

## Decision

The api renders the page itself, as HTML, from `apps/api/src/web-form/`:

1. `WebFormPageController` answers `GET` and `POST` on `/contact` (the brand is the verified help center host's, through `BrandResolver`) and on `/contact/<brandId>` (for a brand with no help center host yet, the same fallback 0010 made with `APP_URL`). They are static routes, so Fastify prefers them to the admin SPA's catch-all.
2. `renderWebFormPage` is one function from a view model to a string. It escapes everything that came from outside with the same `escapeHtml` the customer emails use, and draws only DESIGN §6 components from the `--hd-*` tokens `@helpdock/ui` already emits for the widget and the help center (`@helpdock/ui/css`).
3. The page ships **no script of its own**. Its CSP is `default-src 'none'` with a per-response nonce for its one inline `<style>`, `font-src 'self'`, `form-action 'self'` and `frame-ancestors 'none'`; the CAPTCHA provider's script, frame and connect sources are added only while that brand has CAPTCHA on ([ADR 0003](0003-turnstile-default-captcha.md)).
4. Fonts are the self-hosted woff2 of DESIGN §3, served by the api at `/_hd/fonts/*` from `packages/ui/fonts` — the route M5's server-rendered pages will use too.
5. `multipart/form-data` is decoded with the platform's `FormData`, through the same raw-body hook the inbound-parse routes use, with a 30 MB body cap on `/contact` alone.
6. The page's own Playwright project lives in `apps/api` (`playwright.config.ts`, `e2e/`) and drives the built handler over a small in-memory server, in English and Arabic with axe.

## Consequences

- One more place renders customer HTML: a component change in DESIGN §6 that the form uses has to be made here as well as in `packages/ui`. The page uses few of them — Input, Select, Checkbox, Button, Banner — which keeps that cost small.
- No client script means the attachment control is the browser's own file input, styled; the artboard's file chips with a remove button need script and are not drawn. The file names chosen are the browser's to show.
- A double submit is harmless without script: the form carries a random submission id, the first message stores it as its external id, and a second post of the same id answers the ticket the first one filed.
- When M5 builds the help center, the page can move into `apps/helpcenter` or stay: the controller, the service and the submission rules do not change, and `renderWebFormPage` is the only part an SSR app would replace. This ADR should then be revisited.

## Alternatives considered

- **The admin bundle, as ADR 0010.** Rejected: it serves the install's admin SPA on a brand's customer domain for one form, and needs client script for what a form post already does.
- **A client-only page in `apps/helpcenter` now.** Rejected for 0010's reasons: it would stand up a second front-end build ahead of M5's SSR design.
- **A small script for file chips and inline validation.** Deferred: the form works and passes axe without it, and a script adds a second CSP source and a build to keep, for a nicety.
