# @helpdock/admin

The admin SPA: Vite 8, React 19, MUI 9, TanStack Query 5, React Router 8 and
i18next, built from [`@helpdock/ui`](../../packages/ui/README.md) and
[`@helpdock/i18n`](../../packages/i18n/README.md). The api serves the build from
`dist/` on the admin host (ARCHITECTURE §3).

M0-07 shipped the chrome: the sign-in screens, the shell, and one empty page per
nav destination. M0-05 connected them to the real auth service; the in-memory
fixture stays as the adapter the unit and browser suites run against. M0-06
replaced three of those empty pages with real ones — staff and roles, two-factor
enrolment and the account's own security page — and added the public invite
screen.

M0-10 adds the first real screen, **System**, built from the design canvas
artboard `Admin/System`. It reads a real endpoint
(`GET /api/install/system`), so it is the one page that needs the api running.

M0-08 adds the **first-run wizard**, from the artboard `Admin/Wizard`. It is
the screen an install has before it has anything else, and it replaces every
other route while the install is fresh.

In production the api serves `dist/` at `/` on the admin host, with `no-store`
on `index.html` and a year of `immutable` on everything Vite content-hashed into
`assets/`; `apps/api/README.md` has the rules.

## Running it

```bash
pnpm build                       # once, so @helpdock/ui and @helpdock/i18n have a dist/
pnpm --filter @helpdock/admin dev
```

The dev server proxies `/api` and `/ready` to `http://localhost:3000`, so the
browser sees one origin and the `SameSite=Lax`, host-only refresh cookie the api
sets is sent back to it. `VITE_API_ORIGIN` points the proxy elsewhere. With
`VITE_AUTH_API=mock`, which is the default in dev, nothing under `/api` is
proxied because nothing is called.

`index.html` carries the development fixture for the four `helpdock:*` meta
tags, including `helpdock:install-state=configured`. The dev server serves that
file as it is, so `pnpm dev` always shows the sign-in screen rather than the
first-run wizard; in production the api rewrites the tags per install.

Open http://localhost:5273 and sign in with the fixture:

| | |
|---|---|
| Email | `lina@helpdock.com` |
| Password | `correct horse` |
| Authenticator code | `482913` |
| Recovery code | `RC-1234-5678` |
| A live invitation | `/invite/mock-invite-token` |
| One that has run out | `/invite/expired-invite-token` |

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
                    the redirect hand-off, staff and roles, two-factor
                    enrolment, the invite screen, the security page
src/realtime/       the socket client, presence and the away timer
src/staff/          the StaffApi boundary and its two adapters
src/shell/          sidebar, brand switcher, user menu, page header, empty state
src/ui/             the small pieces DESIGN §6 has no component for yet: the
                    toast stack, the confirmation dialog, the password-strength
                    bar, and the QR encoder the enrolment screen draws with
src/install/        what the app may know before anyone signs in
src/screens/setup/  the first-run wizard (M0-08): four steps, its api client
src/screens/admin/system/   the System page (M0-10), its api client and formatters
e2e/                Playwright, one project per locale
e2e/api/            Playwright against a real api, its own config
```

Imports reach `@helpdock/ui`, `@helpdock/i18n` and `@helpdock/schemas` only
through their package entry points, and no app imports another app
(`pnpm check:boundaries`).

### The first-run wizard

`src/screens/setup/` is M0-08: admin account, first brand, outgoing email, done.

**Which app this build is** is decided before the first route renders.
`readPublicInstallInfo()` reads the `helpdock:install-state` meta tag the api
rewrites into `index.html`; `fresh` mounts the wizard and sends every other path
to it, and `configured` does not mount `/setup` at all, so it falls to the
catch-all like any other unknown path. Anything missing or unreadable is treated
as `configured`: a build served from somewhere else must land on sign-in rather
than offer to create an owner.

Three rules it follows:

- **Nothing is persisted.** Step data lives in a reducer (`setup-state.ts`) and
  nowhere else — not in storage, not in the URL. A wizard takes minutes, the
  password on step 1 has no business surviving a reload, and a half-finished one
  is finished by starting it again.
- **The language picker changes the app as it is chosen**, not on submit, so an
  operator who picks Arabic reads the next three steps right to left (DESIGN §7).
  The same value becomes the new account's `locale`.
- **Finishing navigates the browser, not the router.** The install state is a
  meta tag in a document that is already loaded, so only a fresh document knows
  the wizard is over; the reload also picks the session up from the refresh
  cookie step 2 set.

Because the state arrives in the served HTML, the wizard cannot be exercised
through the Vite dev server, which serves its own copy of `index.html` with the
development fixture in it. `e2e/api/` therefore runs the wizard against a second
api that serves `dist/` itself, which is the production topology.

### The System page

`src/screens/admin/system/` is M0-10's half of the milestone: four health cards,
the queue table, and the channels / usage / audit column of the artboard. It
polls `GET /api/install/system` every ten seconds with TanStack Query and parses
the response through `systemStatusSchema` from `@helpdock/schemas`, so a field
that quietly went missing is an error the page shows rather than a card drawn as
healthy.

Three rules it follows, which later screens should too:

- **A subsystem that is not measured says "Not configured".** Storage and AI
  spend have no numbers until M1 and M7, and a zero would read as a
  measurement.
- **A state is a word as well as a hue.** "Degraded" is written beside the dot
  (DESIGN §10).
- **Numerals are Latin in both locales and end-aligned in the table**
  (DESIGN §6.5, §7).

Only an install admin is offered the nav item, because everything on the page is
install-wide. The route is not hidden: a brand admin who types the path gets the
api's 403 drawn as "Not allowed", so the answer comes from one place.

"All queues" fetches the rest from `GET /api/install/system/queues` rather than
expanding what is already on screen — the status read carries only the first
few, so expanding would move a label and nothing else. "Open queue dashboard"
opens the same table on its own screen; Bull Board is M8-05
([ADR 0004](../../docs/decisions/0004-bull-board-for-queues.md)), and the
button's tooltip says so.

What the page's numbers mean is in the
[operations guide](../../docs/guides/operations.md#the-system-page).

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

### The screens M0-06 added

| Route | Artboard | |
|---|---|---|
| `/admin/staff` | `Admin/Staff` | The table, the invite dialog with its role cards and department chips, and every row action of DOMAIN-RULES §12. Visible to an Admin and a Team Leader; the sidebar hides it from everybody else, and the api refuses it whatever the sidebar draws. |
| `/sign-in/enrol` | `Admin/Enrol2FA` | Two steps: scan, then save the recovery codes behind a checkbox. |
| `/invite/:token` | `Admin/AcceptInvite` | Public, outside the shell: the only screen somebody without an account ever sees. |
| `/me/security` | the `Admin/Settings` card and field patterns | Details, password, second factor, signed-in browsers. |

The QR code is encoded in the browser by `src/ui/qr-encode.ts` — byte mode,
error-correction level M, versions 1 to 10, which is what an `otpauth://` URI
needs and nothing more. It is not a dependency: `qrcode` brings `pngjs`, `yargs`
and `dijkstrajs` for a page that needs none of them, and a package outside the
stack table in ARCHITECTURE §1 needs an ADR. The encoder is checked against the
tables in ISO/IEC 18004 — the format strings, the version strings, the
Reed-Solomon example in annex I — and then read back out of the matrix the way a
scanner reads it.

### The auth and staff boundaries

Everything the screens need is `AuthApi` in `src/auth/api.ts` and `StaffApi` in
`src/staff/api.ts`. Its DTOs are Zod
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

The two http adapters share one `HttpTransport`, so there is one access token
and one refresh in the app; the two fixtures share one `MockStaffApi`, so an
invitation sent on the staff screen is the one the accept screen reads.
`createApis()` builds each pair together for that reason.

A staff refusal crosses as a `StaffError` carrying the rule that refused —
`self`, `out-of-scope`, `viewer-disabled` or `last-install-admin` — which the
screen turns into a toast.

**`HttpTransport` holds the access token in a field and nowhere else** — not in
`localStorage`, not in `sessionStorage`, not in a cookie a script can read. A
reload starts with none and refreshes from the `httpOnly` cookie the api set. A
401 is retried once, after a refresh, and only when a token was actually sent:
without one the 401 *is* the answer — a wrong password, a wrong code — and it
has to reach the screen unchanged.

The endpoints behind it are in [the authentication
guide](../../docs/guides/authentication.md#endpoints).

`accessToken()` is the one method that hands the token out, and its one caller
is the realtime client: a browser cannot set headers on a WebSocket handshake,
so the token goes in `auth.token` instead. It stays in memory either way.

Two things the fixture does that the real service owns: `navCounts` on the
session is optional and the sidebar renders a count only for the keys it
receives, and switching brand is a client-side change to the cached session
until a milestone gives it somewhere to persist.

### The socket

`src/realtime/` is the same shape as the auth boundary: one interface
(`RealtimeClient`), two adapters chosen by the same `VITE_AUTH_API` switch, and
no component that ever sees a socket. `SocketRealtimeClient` connects to the
`/staff` namespace with the access token, reconnects itself with backoff so
every attempt carries a *fresh* one, heartbeats, and stops for good when the
server says the session was revoked. `MockRealtimeClient` is what `pnpm dev` and
the browser tests run against.

`RealtimeProvider` sits below `RequireSession`, reads the presence map over REST
and applies `presence:changed` events to it, and sets the person away after five
minutes without a pointer, key, wheel or touch event and without the tab
becoming visible again. `useRealtime()` gives their own
status and the toggle the user menu uses; `usePresence(brandId)` gives the map.

The contract is in [the realtime guide](../../docs/guides/realtime.md).

## Tests

```bash
pnpm --filter @helpdock/admin test            # Vitest, happy-dom
pnpm --filter @helpdock/admin test:coverage   # the same, with the 85 % line gate
pnpm --filter @helpdock/admin e2e             # Playwright, en and ar, the fixture
pnpm --filter @helpdock/admin e2e:api         # Playwright against a real api
```

The unit suite renders through the real provider stack with `MemoryRouter`, so a
test exercises the same theme, catalogs and query client the browser gets. It
covers the fixture's behaviour, form validation, locale and direction, the
protected-route redirect and each screen's states.

`e2e:api` is a second Playwright config with two projects. It starts Postgres
and Redis with Testcontainers and runs the built api as its own process — twice,
over two databases:

- **`api`** drives the seeded install through the Vite dev server, which proxies
  `/api` so the two share an origin: sign in → code → shell → sign out, and
  invitation → acceptance → two-factor enrolment → signing in with both, with
  `VITE_AUTH_API=http`.
- **`setup`** drives the first-run wizard against a second install that nobody
  has set up, straight at an api that serves `dist/` itself. It has to be a
  second install, because "fresh" means the `users` table is empty and the
  seeded account makes that impossible; and it has to skip Vite, because the
  install state arrives as a meta tag the api rewrites into `index.html`.

Both need Docker and a `pnpm build`; without Docker they skip themselves and say
so. It is a separate config because a `webServer` and a `globalSetup` belong to
a whole run, and putting it in the main one would start containers for the
fixture suite too.

The fixture suite has one project per locale and runs every spec twice, which
is what catches a layout that only works in one direction. `@axe-core/playwright`
scans sign in, the code screen, the shell, the System page and every step of the
first-run wizard — including their error banners, open menus and degraded
states — against WCAG 2.1 A and AA, and the suite fails on any violation.

`e2e/system.spec.ts` stubs `GET /api/install/system` with Playwright's own
`route`, using the same fixture as the unit tests
(`src/screens/admin/system/fixtures.ts`), so the two cannot drift and no mock
server is needed.

`e2e/setup.spec.ts` does the same for the wizard (`e2e/setup-install.ts`), and
rewrites the `helpdock:install-state` meta tag in the document the dev server
serves rather than reaching into the app — so the page really does arrive saying
`fresh`, which is the mechanism under test.

### Screenshots

`e2e/screenshots.spec.ts` keeps one baseline per screen per locale under
`e2e/__screenshots__/<locale>/`. The assertions are strict — not soft — with a
2 % pixel-ratio tolerance for sub-pixel text rendering.

**The baselines are Linux**, because the comparison runs on `ubuntu-latest`, and
a comparison against macOS pixels fails on every run. So the spec is tagged
`@screenshot`, `pnpm e2e` leaves it out, and CI runs it as a step of its own:
`pnpm e2e` has to be a command any contributor can run on any machine, and a
pixel comparison is not that.

**The baselines are generated by CI** (M0-11, issue #32).
[`.github/workflows/screenshots.yml`](../../.github/workflows/screenshots.yml)
renders them on the same runner image, with the same
`playwright install --with-deps chromium`, as the step that compares them — which
is the only way two sets of pixels are comparable at all — and uploads them as
the `screenshot-baselines` artifact. It runs on demand and on any pull request
that touches `apps/admin/src/**`, `packages/ui/src/**` or the spec, so a
deliberate layout change arrives with its new baselines attached to the run:

```bash
gh workflow run screenshots.yml --ref <your-branch>
gh run download <run-id> --name screenshot-baselines --dir apps/admin/e2e/__screenshots__
```

Commit the images and say in the pull request why a baseline moved.

`gh workflow run` dispatches a workflow from the branch you name, but only if
the file exists on the **default** branch — that is GitHub's rule, not ours.
The very first baselines were produced by a temporary `push:` trigger on the
branch that added the workflow, and that trigger was removed in the same pull
request. A workflow added on a branch needs the same trick until it has merged.

To check them, or to regenerate them without CI:

```bash
pnpm --filter @helpdock/admin e2e:screenshots  # compare
pnpm --filter @helpdock/admin e2e:baselines    # regenerate, needs Docker
```

`e2e:baselines` starts the Vite dev server on the host — `node_modules` here is
built for this machine and would not load inside the container — and runs
Playwright from `mcr.microsoft.com/playwright:v1.63.0-noble` against it with
`--update-snapshots`. It is the fallback: the image is a 2 GB pull, and the
pixels it renders are not guaranteed to be the runner's. On a Linux host,
`e2e:screenshots --update-snapshots` does the same without Docker.
