# 0015 Render the help center as plain HTML from the api, and carry the staff session to its host with a one-use pass

Status: accepted
Date: 2026-09-27

## Context

M5-03 puts the published help center on each brand's own host (`support.brand.com`, verified by M5-07), with a fallback on the install's host for a brand that has no domain yet. [ARCHITECTURE §11](../planning/ARCHITECTURE.md#11-help-center-ssr--custom-domains) sketched it as `apps/helpcenter`, a Vite SSR React app the api hosts with a streaming render.

By the time it was built, three things were known that the sketch was not:

- **The pages need almost no script.** The artboards (`HelpCenter/*`) are documents: navigation, lists, an article, a search form that is a GET, and "Was this helpful?", which is two submit buttons. The one interactive piece, "Chat with us", opens the widget, which is its own bundle (ADR 0012). DESIGN §6.7 already says "no component depends on JavaScript to be readable".
- **[ADR 0013](0013-web-form-page-rendered-by-the-api.md) set the pattern** for a customer page on a brand's host: one function from a view model to a string, the DESIGN tokens from `@helpdock/ui/css`, the fonts at `/_hd/fonts/*`, a nonce'd CSP, framework-free request handling that Playwright drives over a small server. It works, and the form lives on the same hosts.
- **Staff read internal articles on the brand's host,** where the admin's session does not reach: its access token lives in the admin's memory and its refresh cookie is host-only on the install's host, path `/api/auth`. DOMAIN-RULES §5 says the internal audience applies only to a request with a staff session of that brand.

## Decision

1. **The api renders the pages as HTML strings,** from `apps/api/src/help-center/site/`, the way ADR 0013 renders the form. `HelpCenterSite` (request handling, HTTP semantics, caching headers, CSP) is apart from Nest; `views.ts` turns content into view models and `render/*` turns those into markup, escaping everything from outside with the same `escapeHtml`. There is no client bundle; the only inline script is the one line that opens the widget, on pages where the brand's widget may run.
2. **`apps/helpcenter` stays an empty package.** The render code belongs to the api that serves it; `apps/*` never import each other, and nothing outside the api renders these pages. The package is kept as the named home ARCHITECTURE gives the help center, should a client app ever be needed, and says so in its description.
3. **Routing by host.** A request whose `Host` is a verified help center domain is handed to the pages by the admin SPA's catch-all (`HOST_PAGES`): the pages sit at the root and have no prefix to route on. The install's own host serves a brand under `/hc/<brandId>`, as the form is served under `/contact/<brandId>`. One brand's domain never serves another brand's pages.
4. **Caching.** Public pages are stored in Redis per brand, host, path, locale and audience, under a per-brand generation that every `help_center.*` event bumps (one `INCR` drops a whole help center). A page is stored with a placeholder where the nonce goes, so a cached page still gets a fresh nonce per response and a stable ETag. Only the public audience is ever stored.
5. **The staff pass.** The admin asks `POST /api/brands/:brandId/help-center/staff-pass` with its bearer token and gets a one-minute, one-use address on the help center (`/_hd/staff?pass=…`). Spending the pass sets `hd_hc_staff` on the help center's host: an ES256 JWS signed with the install's session key, audience `helpdock:help-center`, naming the person, the brand and the **refresh family** of the admin session. Every page checks that family is still alive, so signing out of the admin, "sign out everywhere", a password reset and a role change end the help center session on its next page. "View help center", "Preview" and the internal-only wall's "Sign in" all go through `/help-center/open` in the admin, which signs in first when it has to.

## Consequences

- A third place draws DESIGN §6 components as strings (the widget, the form, and now the help center). The help center's are few and its own (§6.7), so the cost is in keeping `render/styles.ts` on the tokens, not in duplicating the admin's React components.
- No streaming render and no hydration: a page is rendered whole, which is what a cached page is anyway. A future interactive piece has to be written as plain script under the nonce, or justify a bundle.
- Staff sessions on a help center host last at most eight hours before the pass has to be fetched again, and end sooner with the admin session. The cookie is host-only, `HttpOnly`, `Secure` on https and `SameSite=Lax`.
- A CDN in front of a help center can serve a public page for up to `s-maxage=300`; a view is then not counted, because the api never sees the request.

## Alternatives considered

- **The Vite SSR React app of ARCHITECTURE §11.** Rejected for v1: a second front-end build, a React runtime on the server and a hydration bundle, for pages that need neither, and a render path the form would not share.
- **Reusing the admin's session on the help center host.** Impossible without a cookie shared across the two hosts, which a customer's own domain cannot have.
- **A signed preview token in the preview URL.** It would carry staff access in an address that ends up in history and in Referer headers; the pass is spent on first use and the address it lands on carries nothing.
