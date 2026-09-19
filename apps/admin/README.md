# @helpdock/admin

The admin SPA: Vite 8, React 19, MUI 9, TanStack Query 5, React Router 8 and
i18next, built from [`@helpdock/ui`](../../packages/ui/README.md) and
[`@helpdock/i18n`](../../packages/i18n/README.md). The api serves the build from
`dist/` on the admin host (ARCHITECTURE §3).

M0-07 shipped the chrome: the sign-in screens, the shell, and one empty page per
nav destination. M0-05 connected them to the real auth service; the in-memory
fixture stays as the adapter the unit and browser suites run against.

In production the api serves `dist/` at `/` on the admin host, with `no-store`
on `index.html` and a year of `immutable` on everything Vite content-hashed into
`assets/`; `apps/api/README.md` has the rules.

## Running it

```bash
pnpm build                       # once, so @helpdock/ui and @helpdock/i18n have a dist/
pnpm --filter @helpdock/admin dev
```

The dev server proxies `/api` to `http://localhost:3000`, so the browser sees one
origin and the `SameSite=Lax`, host-only refresh cookie the api sets is sent back
to it. `VITE_API_ORIGIN` points the proxy elsewhere. With `VITE_AUTH_API=mock`,
which is the default in dev, nothing is proxied because nothing is called.

Open http://localhost:5273 and sign in with the fixture:

| | |
|---|---|
| Email | `lina@helpdock.com` |
| Password | `correct horse` |
| Authenticator code | `482913` |
| Recovery code | `RC-1234-5678` |

Three wrong codes lock the challenge for the rest of the session, "Trust this
browser" makes the next sign-in skip the second factor, and the sign-in link
resolves after 300 ms onto the confirmation screen. Nothing is persisted: the
session lives in memory, so a reload signs you out again.

To run against the real api instead, start it and use the http adapter:

```bash
pnpm --filter @helpdock/api seed:dev      # one brand, one install admin
VITE_AUTH_API=http pnpm --filter @helpdock/admin dev
```

The seeded credentials are in [the authentication
guide](../../docs/guides/authentication.md#the-development-install).

## Structure

```
index.html          sets lang/dir/color-scheme before the bundle runs
src/app/            providers, routes, preferences, the typed t()
src/auth/           the AuthApi boundary, its two adapters, session state
src/screens/        sign in, the code screen, the link and reset confirmations,
                    the redirect hand-off, pages
src/shell/          sidebar, brand switcher, user menu, page header, empty state
src/ui/             the small pieces DESIGN §6 has no component for yet
src/install/        what the sign-in screen may know before anyone signs in
e2e/                Playwright, one project per locale
e2e/api/            Playwright against a real api, its own config
```

Imports reach `@helpdock/ui` and `@helpdock/i18n` only through their package
entry points, and no app imports another app (`pnpm check:boundaries`).

### Providers

`src/app/providers.tsx` is the whole stack, in one place:

- **Locale** — from `localStorage`, else `navigator.language` (`ar*` → Arabic,
  everything else English). `dir(locale)` from `@helpdock/i18n` chooses the
  Emotion cache (`createRtlCache` / `createLtrCache`) and the theme's
  `direction`, and sets `lang` and `dir` on `<html>`.
- **Theme** — `createHelpdockTheme({ mode, direction })`. The mode is the stored
  choice, or `prefers-color-scheme` when it is `auto`. Under
  `prefers-reduced-motion: reduce` every transition duration becomes 0 ms
  (DESIGN §4).
- **i18next** — one instance from `createI18n`, handed to `I18nextProvider`.
  Screens call `useT()` from `src/app/i18n.ts` rather than `useTranslation()`,
  because that is what makes `t('auth:signIn.title')` type-check across
  namespaces.
- **TanStack Query** — one client; the session is a query, not a context value.
- **Router** — `BrowserRouter`, swapped for `MemoryRouter` by the tests.

`index.html` carries a small inline script that sets `lang`, `dir` and
`color-scheme` from the same two `localStorage` keys before React mounts, so an
Arabic install never paints a left-to-right frame first. A unit test asserts the
script and `src/app/preferences.ts` still agree on those keys.

`index.html` also carries two meta tags — `helpdock:primary-domain` and
`helpdock:brand-count` — that the sign-in caption reads. The api rewrites them
per install when it serves the file (`apps/api/src/static/`), from the install's
brands and their verified help-center domains; the checked-in values are the dev
fixture, and they are what a `vite preview` or a build served by anything else
shows.

### The auth boundary

Everything the screens need is `AuthApi` in `src/auth/api.ts`. Its DTOs are Zod
schemas in [`@helpdock/schemas`](../../packages/schemas/src/auth.ts), so the api
declares its responses against the same shapes the app parses them with. Two
adapters implement it:

| `VITE_AUTH_API` | Adapter | |
|---|---|---|
| `mock` | `MockAuthApi` | the in-memory fixture; the default in dev and test |
| `http` | `HttpAuthApi` | the real service; the default in a production build |

Failures cross the boundary as an `AuthError` carrying a `code`, never a
message: the screen turns the code into a catalog key, so no user-facing English
is written outside `packages/i18n`. The codes are `invalid-credentials`,
`totp-mismatch` (with `attemptsLeft`), `totp-locked`, `challenge-expired`,
`recovery-invalid`, `no-account` and `unavailable`.

**`HttpAuthApi` holds the access token in a field and nowhere else** — not in
`localStorage`, not in `sessionStorage`, not in a cookie a script can read. A
reload starts with none and refreshes from the `httpOnly` cookie the api set. A
401 is retried once, after a refresh, and only when a token was actually sent:
without one the 401 *is* the answer — a wrong password, a wrong code — and it
has to reach the screen unchanged.

The endpoints behind it are in [the authentication
guide](../../docs/guides/authentication.md#endpoints).

Two things the fixture does that the real service owns: `navCounts` on the
session is optional and the sidebar renders a count only for the keys it
receives, and switching brand is a client-side change to the cached session
until a milestone gives it somewhere to persist.

## Tests

```bash
pnpm --filter @helpdock/admin test            # Vitest, happy-dom
pnpm --filter @helpdock/admin test:coverage   # the same, with the number
pnpm --filter @helpdock/admin e2e             # Playwright, en and ar, the fixture
pnpm --filter @helpdock/admin e2e:api         # Playwright against a real api
```

The unit suite renders through the real provider stack with `MemoryRouter`, so a
test exercises the same theme, catalogs and query client the browser gets. It
covers the fixture's behaviour, form validation, locale and direction, the
protected-route redirect and each screen's states.

`e2e:api` is a second Playwright config with one project, `api`: it starts
Postgres and Redis with Testcontainers, runs the built api as its own process,
seeds an account with a known password and authenticator secret, and drives sign
in → code → shell → sign out in a browser with `VITE_AUTH_API=http`. It needs
Docker and a `pnpm build`; without Docker it skips itself and says so. It is a
separate config because a `webServer` and a `globalSetup` belong to a whole run,
and putting it in the main one would start containers for the fixture suite too.

The fixture suite has one project per locale and runs every spec twice, which
is what catches a layout that only works in one direction. `@axe-core/playwright`
scans sign in, the code screen and the shell — including their error banners and
open menus — against WCAG 2.1 A and AA, and the suite fails on any violation.

### Screenshots

`e2e/screenshots.spec.ts` keeps one baseline per screen per locale under
`e2e/__screenshots__/<locale>/`. The assertions are strict — not soft — with a
2 % pixel-ratio tolerance for sub-pixel text rendering.

**The baselines are Linux**, because CI runs on `ubuntu-latest`, and a
comparison against macOS pixels would fail on every run. The spec is therefore
tagged `@screenshot` and left out of `pnpm e2e` until the baselines exist:
Playwright *fails* a comparison whose baseline is missing rather than skipping
it, so a tagged-off suite is the only way to keep the rest of the suite
meaningful in the meantime. **No baselines are committed yet** (M0-07 was built
on a macOS host with no way to produce Linux pixels).

To generate them and turn the tag back on:

```bash
pnpm --filter @helpdock/admin e2e:baselines   # writes the baselines
pnpm --filter @helpdock/admin e2e:screenshots # checks them
```

`e2e:baselines` starts the Vite dev server on the host — `node_modules` here is
built for this machine and would not load inside the container — and runs
Playwright from `mcr.microsoft.com/playwright:v1.63.0-noble` against it with
`--update-snapshots`. On a Linux host, `e2e:screenshots --update-snapshots`
does the same without Docker. Commit the images, drop `--grep-invert @screenshot`
from the `e2e` script, and say in the pull request why a baseline moved.
