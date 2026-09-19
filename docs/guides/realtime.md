# Realtime

How the admin and the api talk over a socket: what a connection has to prove,
which rooms exist and who may join them, how presence is derived, and what
happens when a session is revoked. Specified by [ARCHITECTURE
§8](../planning/ARCHITECTURE.md#8-channel-adapters) and
[§12](../planning/ARCHITECTURE.md#12-widget), and by [DOMAIN-RULES
§1.4](../planning/DOMAIN-RULES.md#14-workers-and-websockets),
[§7](../planning/DOMAIN-RULES.md#7-realtime-delivery-contract) and
[§12](../planning/DOMAIN-RULES.md#12-staff-lifecycle). Implemented by M0-13.

The widget's own namespace is M4 and is not covered here.

## The one rule

> Socket.IO does not guarantee delivery. The REST API is the source of truth;
> sockets are notifications. — DOMAIN-RULES §7

Nothing in Helpdock may depend on a socket frame arriving. A screen reads its
state over REST and applies events to it; a send is a `POST` whose response
carries the `seq`. A socket that never connects makes the admin slower to
notice things, never wrong about them.

## The server

One Socket.IO server, attached to the same HTTP server Fastify listens on, with
four settings that are not the defaults:

| Setting | Value | Why |
|---|---|---|
| `path` | `/socket.io` | What Caddy proxies and what the client asks for. |
| `transports` | `['websocket']` | No long-polling (ARCHITECTURE §12). Polling would also make sticky sessions a deployment requirement. |
| `allowRequest` | `Origin` is `APP_URL`, or absent | A WebSocket handshake is not covered by the same-origin policy, so a page anywhere could otherwise open one. Defence in depth rather than the control: the credential is the bearer token in `auth.token` and never a cookie, so a cross-origin page has nothing to present. A request with no `Origin` is a server-to-server client, not a page, and is allowed. |
| `adapter` | Redis, two connections | A room has to mean "everyone, on every replica". A subscribed ioredis client accepts no other command, so the publisher cannot be the subscriber. |

It lives in `apps/api/src/realtime/redis-io.adapter.ts` and is installed on the
application before `init()`, because that is when Nest binds gateways to
whatever adapter is in force.

## Namespaces

| Namespace | Principal | Milestone |
|---|---|---|
| `/staff` | `staff` | M0-13 |
| `/widget` | `visitor` | M4-04 |

`/staff` refuses anything but a staff principal. M4 adds `/widget` as its own
gateway with its own credential (the visitor secret of ARCHITECTURE §7) and its
own origin allow-list; the server, the adapter and the publisher below are
shared.

## The handshake

A socket authenticates exactly as a request does (DOMAIN-RULES §1.4). The
credential is the same ten-minute access token, presented in `auth.token`
because a browser cannot set headers on a WebSocket handshake:

```ts
io('/staff', { path: '/socket.io', transports: ['websocket'], auth: { token } });
```

The server verifies it with `SessionPrincipalResolver` — the same signature
check, the same claim schema, the same Redis revocation lookup as HTTP. There is
no second way in.

A refusal is a `connect_error` carrying `{ code, message }`, never a silent
hang:

| `code` | Meaning |
|---|---|
| `unauthenticated` | No `auth.token`, or one this install did not sign, or a session that has been revoked. |
| `forbidden` | A valid token for a principal that does not belong on this namespace. |
| `internal` | The handshake could not be checked at all. |

The accepted socket carries the `Principal`, the session id (`sid`) and the
family id (`fam`).

## Rooms

A room is `<kind>:<uuid>`. Joining one "runs the same permission check as the
corresponding REST read" (DOMAIN-RULES §1.4), which here means two checks, in
this order:

1. **The permission**, by the global `PermissionGuard`. `@SubscribeMessage`
   handlers declare `@Requires(...)` or `@Authenticated()` exactly as routes do,
   and `pnpm check:routes` fails on one that declares neither. The brand comes
   from the message rather than from a path, so every brand-scoped event names
   a `brandId`.
2. **The scope**, by `authorizeRoom`. This is the part Postgres does for HTTP
   (DOMAIN-RULES §1.3 layer 3) and that no row-level security policy can do for
   a room name.

| Room | Rule |
|---|---|
| `brand:<id>` | The principal holds a role in that brand, and the room is the brand the message named. |
| `department:<id>` | An explicit department list containing the id needs no query: the list is itself per-brand, so membership proves both the brand and the scope. An *unrestricted* scope (`all`) does need one — a room name carries no brand, and `all` means "every department *of that brand*" — so `departments` is read inside a transaction scoped to the brand the join named. |
| `ticket:<id>` | The ticket exists inside the principal's own scope. The check is the *same* question `GET /api/brands/:brandId/tickets/:ticketId` asks, asked the same way: a transaction carrying the principal's brand and departments, and the policies answering. "No such ticket" and "not in your departments" are therefore one answer, and neither confirms the other. |

The two that need a read go through `RoomScopeReader`
(`apps/api/src/realtime/room-reader.ts`). It is the only place in the app that
opens a tenant transaction outside the request lifecycle for a staff principal,
which is why it is one file with two reads in it.

Every event — not only a join — re-asks two things first, because a socket
outlives the token it was opened with:

1. **Has that token expired?** A socket's authority *is* its access token, and
   DOMAIN-RULES §1.6 caps that at ten minutes. Past `exp` the socket is closed
   and the client reconnects with a fresh one, which nobody sees.
2. **Has the session been revoked?** The revocation marker itself lives only as
   long as an access token can, which is why the expiry check comes first.

## Events

Client to server, all acknowledged:

| Event | Payload | Declares | Acknowledges |
|---|---|---|---|
| `room:join` | `{ brandId, room }` | `@Requires('brand:read')` | `{ ok: true, data: { room } }` |
| `room:leave` | `{ room }` | `@Authenticated()` | `{ ok: true, data: { room } }` |
| `presence:set` | `{ brandId, status: 'online' \| 'away' }` | `@Requires('brand:read')` | `{ ok: true, data: { status } }` |
| `presence:heartbeat` | `{}` | `@Authenticated()` | `{ ok: true, data: { at } }` |

A refusal is `{ ok: false, error: { code, message } }` on the same
acknowledgement, with the codes above plus `invalid_payload` and
`session_revoked`.

Server to client:

| Event | Payload | Envelope `seq` |
|---|---|---|
| `presence:changed` | `{ userId, brandId, status }` | `null` |
| `ticket:changed` | `{ brandId, ticketId, departmentId, event }` where `event` is `ticket.created` or `ticket.updated` | `null` |
| `ticket:message` | `{ brandId, ticketId, departmentId, messageId, seq, kind, event }` where `event` is `ticket.replied` or `ticket.note_added` | the message's `seq` |
| `revoked` | `{ code: 'session_revoked', message }`, immediately before the socket is closed | — |

The two ticket events carry **ids and no content**. That is what "the REST API
is the source of truth; sockets are notifications" means in practice: a screen
re-reads the ticket rather than patching it from a frame, and an internal note
has no body in the payload to leak. `departmentId` is the department the ticket
is in *now*, so a client holding a `department:` room can tell whether the
ticket has just arrived in it or just left it.

Each one reaches two rooms: `ticket:<id>` — whoever has the ticket open — and
`department:<id>`, because a new ticket has to appear in a list nobody was
looking at.

Every event emitted through `RealtimePublisher` travels in an envelope.
`revoked` is the exception: the revocation subscriber sends it bare, because it
is the last thing a socket ever hears and there is nothing to catch up on.

```ts
{ seq: number | null, at: string, data: T }
```

`seq` is the per-conversation cursor of DOMAIN-RULES §7. A client that receives
`seq > last_seq + 1` has missed something and catches up over REST. Ephemeral
events — presence, typing, queue position — are never replayed and carry
`null`, which is how a client tells the two apart without a table of event
names. `at` is when the server emitted it.

The names, the payload schemas and the envelope are declared once in
`packages/schemas/src/realtime.ts` and used by both sides. Every payload is
parsed on the way out, so a field nobody meant to send cannot leak.

## Presence

`online | away | offline`, derived rather than stored (DOMAIN-RULES §12). The
sockets decide whether a person is reachable at all; the explicit toggle only
chooses between the two reachable states.

Redis holds it, because it is spread over every replica:

| Key | Holds | Expiry |
|---|---|---|
| `presence:brands` | Brands anyone is present in, so the reaper has a work list | with its last member |
| `presence:<brandId>` | User ids present in that brand | with its last member |
| `presence:sockets:<brandId>:<userId>` | That person's socket ids there | with its last member |
| `presence:sock:<socketId>` | Nothing; its existence *is* the liveness | 60 s |
| `presence:status:<brandId>` | The explicit `away` toggles | with its last member |

The liveness key is the only one with a TTL, and that is the point: a replica
that dies without running a single disconnect handler leaves its sockets'
keys behind, they expire within a minute, and the reaper turns the people they
belonged to offline. The client refreshes it every 25 s with
`presence:heartbeat`, so two heartbeats may be lost before anyone is called
offline.

A reaper runs in every api process every 30 s. Every replica sweeps, but taking
a person out of `presence:<brandId>` answers "removed" on exactly one of them,
so `presence:changed` is emitted once however many replicas are running.

`GET /api/brands/:brandId/presence` (`@Requires('staff:read')`) answers the map
a screen renders before any event arrives. Nobody is listed as `offline`:
absence is what offline means, so the map grows with who is working rather than
with the brand's roster.

`staff:read` is the one permission every role holds. DOMAIN-RULES §1.2
restricts *tickets* by department, never colleagues: an Agent has to see who is
online before taking a ticket. Changing who may work in a brand stays
`staff:manage`.

### The away timer

The server cannot tell the difference between reading a ticket and going to
lunch — the socket stays open either way — so the browser says. After five
minutes with no pointer, key, wheel or touch event and no tab becoming visible,
the admin sends `presence:set` with `away`; the next sign of life sends
`online`. The user menu has the same toggle for saying so deliberately.

Either path is a no-op for a status the person is already in, so the two cannot
double up: a toggle to `away` a moment after the timer reached the same
conclusion costs nothing.

### The hook M1 needs

`StaffOfflineHook.onStaffOffline(userId, brandId, since)` fires when the last of
someone's sockets in a brand goes. It does nothing today. M1-07 provides its own
implementation under the `STAFF_OFFLINE_HOOK` token and gets the
fifteen-minute auto-unassign of DOMAIN-RULES §12 without the gateway changing.

## Revocation

> On role change, deactivation, or "log out everywhere", the server publishes
> `principal.revoked` over Redis and every replica disconnects that principal's
> sockets within 5 seconds. — DOMAIN-RULES §1.4

M0-05 publishes. `RevocationSubscriber` subscribes on a dedicated connection —
a subscribed ioredis client may run no other command, and the Socket.IO adapter
has subscriptions of its own — parses the message, and closes every socket of
that person that this replica is holding. It emits `revoked` first, so the
client shows "signed out" instead of reconnecting in a loop.

That is the push half. The pull half is the revocation check on every room join,
for the window before the message arrives and for a replica that missed it.

## The admin client

`apps/admin/src/realtime/` holds one client behind one interface
(`RealtimeClient`), with two implementations:

- `SocketRealtimeClient` — the real connection. Socket.IO's own reconnection is
  off, because each attempt has to carry a *fresh* access token: the one this
  tab held ten minutes ago has expired and re-presenting it would fail forever.
  It reconnects itself with exponential backoff and full jitter (500 ms
  doubling to 30 s), heartbeats while connected, and stops for good on
  `revoked`.
- `MockRealtimeClient` — the fixture `pnpm dev` and the browser tests run
  against, chosen by the same `VITE_AUTH_API` switch as `MockAuthApi`. The two
  cannot disagree: a real socket against a mocked session would have no token to
  present.

`RealtimeProvider` sits below `RequireSession`, because a connection needs a
principal, a brand and a token. It reads the REST map, applies
`presence:changed` to it, joins `brand:<currentBrandId>`, and re-targets the
same client when the brand switcher is used. `useRealtime()` gives the current
person's own status and the toggle; `usePresence(brandId)` gives the map.

The sidebar footer shows the status as a `PresenceDot` (DESIGN §6.2: 8 px,
success, warning, n400) *and* in words, because colour is never the only carrier
of meaning (DESIGN §10).

## What later milestones add

| Milestone | Adds |
|---|---|
| M1-07 | The auto-unassign timer behind `STAFF_OFFLINE_HOOK`. |
| M1-09 | The collision indicator, on top of the `ticket:<id>` rooms M1-02 opened. |
| M3-07 | In-app notifications, as new server events through `RealtimePublisher`. |
| M4-03 | The widget handshake's origin allow-list and its per-visitor and per-IP throttles. |
| M4-04 | The `/widget` namespace and the full delivery contract for conversations: `client_id`, real `seq` values, cursor catch-up and the SSE fallback. |

Adding an event is three steps: a schema and a name in
`packages/schemas/src/realtime.ts`, an `emitToRoom` call through
`RealtimePublisher`, and — if clients send it — a `@SubscribeMessage` handler
with its `@Requires(...)`.

## Emitting from a worker

`APP_ROLE=worker` drains the queues and runs no Nest application, so it holds no
Socket.IO namespace and cannot emit. `APP_ROLE=api` holds the sockets and runs no
queue. A side effect that ends in a socket frame therefore crosses one process
boundary, over the same Redis pub/sub shape `principal.revoked` already uses
(`apps/api/src/realtime/broadcast.ts`):

```
worker   →  PUBLISH helpdock:realtime:emit   { rooms, event, data, seq }
api      →  RealtimeEmitSubscriber → RealtimePublisher.emitToRoom(…, { local: true })
```

`local: true` is not an optimisation. Every replica subscribes and every replica
receives the message, and the Socket.IO Redis adapter would fan a normal emit out
again — so a room would hear the same frame once per replica. The fan-out has
already happened by the time the subscriber runs, so each replica does the last
hop to its own sockets alone.

The payload is parsed on arrival: it crosses a process boundary, and anything
with `PUBLISH` on that Redis can write to the channel. An event a replica does
not know — which is what a rolling deploy looks like — is dropped with a warning,
because the screen re-reads over REST anyway.

## Known gaps

- **Revocation is per person, not per browser.** `principal.revoked` carries
  only the user id (M0-05), so signing out of one browser closes that person's
  sockets in all of them. It fails closed, which is the right direction, but
  the other browser's realtime stops until the page is reloaded. Narrowing it
  means adding the family id to the published payload, which is M0-05's
  contract to change.
- **Socket events are not rate-limited.** HTTP is; `room:join`, `presence:set`
  and `presence:heartbeat` are not. Only an authenticated staff principal can
  send them, and each costs a small number of Redis commands.

## Operating it

- **Behind a proxy.** `/socket.io` is served by the api like any other path, so
  `docker/caddy/Caddyfile` needs nothing for it: Caddy's `reverse_proxy` passes
  a WebSocket upgrade through on its own. A proxy that does not must be
  configured to.
- **Replicas.** No sticky sessions are needed, because there is no polling and
  the Redis adapter makes rooms replica-independent. A socket does pin to the
  replica it connected to for its lifetime, which is what a WebSocket is.
- **Metrics.** The gateway sets `socket_connections`, labelled by `namespace`,
  on every connect and disconnect. The gauge belongs to M0-10's registry and is
  scraped from `/metrics` like everything else
  ([operations](operations.md#metrics)); `realtime/` writes to it through a
  one-method `SocketConnectionsGauge` so it needs to know nothing else about
  Prometheus.
- **Configuration.** None. `APP_URL` decides the allowed origin and `REDIS_URL`
  the adapter's connections; both already exist.
