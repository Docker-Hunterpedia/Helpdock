# 0016 Mount Bull Board as a Fastify plugin, opened with a one-use pass

Status: accepted
Date: 2026-10-05

Amends [0004](0004-bull-board-for-queues.md), which stands: Bull Board is
embedded for queue inspection, install admins only, with our own summary on the
System page. This settles how it is mounted and how a browser reaches it.

## Context

ADR 0004 chose `@bull-board/nestjs` and said the board would be "mounted as an
ordinary Nest route carrying `@Requires(...)`". Building it (M8-05) showed two
things that sentence does not survive:

- **The api runs on Fastify** ([ADR 0006](0006-fastify-adapter-for-the-api.md)).
  `@bull-board/nestjs` registers the board through the HTTP adapter as a plugin
  with its own router, static assets and views. Those routes never pass through
  Nest's guards, so `@Requires` on a controller in front of them guards nothing.
- **The board is a page of its own, opened in a new tab.** The admin's access
  token lives in the admin's memory and its refresh cookie is scoped to
  `/api/auth`. A full-page navigation to the board carries neither, so no
  bearer-token check could ever pass there.

The help center met the same problem — a page that needs the staff session but
cannot be sent it — and solved it with a one-use pass exchanged for a cookie
([ADR 0015](0015-help-center-pages-rendered-by-the-api.md)).

## Decision

- Mount the board with `@bull-board/api` and `@bull-board/fastify` (9.10.1,
  MIT, the same project and version line ADR 0004 chose) as a Fastify plugin at
  `/api/install/queues/board`, registered by boot before Nest adds its routes.
  It is handed the api's existing read handles on every queue.
- Reach it in two steps, as the help center does:
  1. `POST /api/install/system/queue-board`, an ordinary Nest route under
     `@Requires('install:admin')`, stores a random one-time pass in Redis for a
     minute, naming the admin and the refresh family of the browser session the
     bearer token came from, and answers the address that spends it.
  2. Opening that address spends the pass (`GETDEL`) and sets `hd_queue_board`,
     an opaque id of a board session kept in Redis for an hour: `HttpOnly`,
     `SameSite=Strict`, `Secure` on https, scoped to the board's path.
- A Fastify `onRequest` hook on the board's scope checks, on **every** request
  — the page, its assets and its API — that the board session exists, that the
  admin's refresh family is still alive, and that the account is still an
  active install admin. Anything else is a 401.
- The board's own pages get a Content-Security-Policy of their own: scripts
  from self only, inline styles and Google's fonts allowed, because the board's
  page uses both.

## Consequences

- Signing out of the admin, "sign out everywhere", a password reset, a
  deactivation or losing install-admin closes the board on its next request,
  not when the cookie expires.
- The board's routes are not Nest routes, so the CI check that every route
  declares a permission does not see them. The session check stands in for
  `@Requires('install:admin')`, and the observability integration suite has the
  negative cases ADR 0004 asked for: no session, a made-up session, a spent or
  unknown pass, a brand admin, and a signed-out admin are all refused.
- Two more dependencies in the api image, `@bull-board/api` and
  `@bull-board/fastify` (which brings `@fastify/view` and `ejs`), instead of
  `@bull-board/nestjs`. The stack table's rule for new dependencies is met by
  ADR 0004 and this amendment.
- The board can retry, promote and clean jobs. That is the one place the api
  acts on a job, by an install admin's hand; it still never adds one.
- The board's page loads IBM Plex from Google Fonts. An install that blocks
  outbound requests from browsers gets the system font instead; nothing else
  depends on it.

## Alternatives considered

- **`@bull-board/nestjs` as ADR 0004 named it.** Its routes bypass Nest's
  guards on Fastify, so it would need the same hook this ADR adds, with a Nest
  module in front of it doing nothing.
- **Pass the access token in the query string.** A bearer token in a URL lands
  in the browser history, the proxy's access log and any `Referer`; refused for
  the reason the help center refused it.
- **A signed JWT cookie, as the help center's staff cookie.** It would work, but
  the board is served on the install's own host, where Redis is already the
  session store, and an opaque id in Redis can be ended without a key rotation.
