# 0010 Host the CSAT rating page in the admin bundle until the help center exists

Status: accepted
Date: 2026-09-24

## Context

M1-12 ships the customer's rating page: a public page reached by a single-use link (DOMAIN-RULES §4.6), drawn on the `CsatEN` and `CsatAR` artboards, in both languages and themed with the brand accent where the brand has one (DESIGN §8).

A customer-facing page belongs, by [ARCHITECTURE §11](../planning/ARCHITECTURE.md#11-help-center-ssr--custom-domains), in `apps/helpcenter`: a Vite SSR React app the api renders on brand domains under a `HelpCenterController` that resolves the brand from `Host`. In this tree `apps/helpcenter` is one line (`PACKAGE_NAME`) — no React, no Vite, no build, no SSR host, no Playwright project, no brand-domain resolution. Those are M5's deliverables, and the choices they involve (streaming render, the Redis render cache, the per-brand CSS, the custom-domain host) are M5's to make.

Building a client-only page there now would either pre-empt those choices or be thrown away by them, and it would add a second front-end build, a second static route in the api and a second Playwright setup for one screen.

The admin bundle already has everything the page needs: React, MUI built from `@helpdock/ui`'s tokens and brand theme, the i18n catalogs, a public route precedent (`/invite/:token`), the api's SPA fallback that serves `index.html` for any non-`/api` path, and a Playwright suite that runs every spec in `en` and `ar` with axe.

## Decision

Serve the rating page from the admin bundle at `/csat/<token>`, and keep it **outside the admin app**:

1. `apps/admin/src/main.tsx` mounts `CsatApp` instead of the admin app when the path starts with `/csat/`. No staff provider is built: no session, no refresh cookie, no staff member's saved language or theme. A customer on a shared computer is never treated as whoever signed in there last.
2. The page builds its own language (`?lang=` when it names a shipped locale, otherwise the brand's default), direction, Emotion cache and theme (the brand accent through `resolveBrandTheme`, nothing else — DESIGN §8).
3. It calls the public routes `GET` and `POST /api/public/csat/:token` with `credentials: 'omit'`.
4. The link is built from `APP_URL` (`/csat/<token>`), so it works on every install today without a verified help-center domain.
5. The request-context middleware collapses `/csat/<token>` and `/api/public/csat/<token>` to `:token` before the request line is logged, as it already does for invitations.

## Consequences

- One build, one static route and one Playwright suite, as today. The page is not split out of the admin bundle, so a customer downloads the admin's JavaScript on one visit; acceptable for a page opened once per closed ticket, and gone when the page moves.
- The link's host is the install's `APP_URL`, not the brand's help-center domain. Brands on one install share it until M5.
- When M5 builds the help center, the page moves there: the components are self-contained (`apps/admin/src/screens/csat/`), the api routes do not change, and the link builder (`CsatService` in `apps/api/src/csat/csat.service.ts`) becomes a brand-domain lookup. This ADR should then be superseded.

## Alternatives considered

- **A client-only page in `apps/helpcenter` now.** Rejected for the reasons above: it would stand up a second front-end stack for one screen and pre-empt M5's SSR design.
- **Render it server-side from the api as plain HTML.** Rejected: it would duplicate the design system in templates, lose the Arabic layout and axe coverage the React stack already gives, and still need client script for the toggle buttons.
- **A route inside the admin router, under the staff providers.** Rejected: the staff app's providers read and write the staff member's language and theme, and set the document's language after the page had set its own; a customer page must not depend on any of that.
