# 0006 Run NestJS on the Fastify adapter

Status: accepted
Date: 2026-09-19

## Context

[ARCHITECTURE §1](../planning/ARCHITECTURE.md#1-stack-at-a-glance) pins NestJS 12 but not the HTTP adapter underneath it. NestJS ships two: `@nestjs/platform-express`, which it uses by default, and `@nestjs/platform-fastify`. The choice has to be made once, at the bootstrap in M0-04, because every later milestone builds on the request object, the reply object, the middleware form and the plugin ecosystem that follows from it.

One process carries a lot in this product ([ARCHITECTURE §3](../planning/ARCHITECTURE.md#3-runtime-topology-docker-compose)): the REST API for admin and the tenant API, the Socket.IO gateway for staff and widget traffic, and the server-rendered help center for every brand domain. It is also the process a self-hoster runs on the smallest machine they can get away with, because the deployment target is Docker Compose on one host, not a fleet.

Three properties of the product bear on the decision:

- **Host-based routing is resolved by us, not by the router.** Help-center and widget requests arrive on brand domains that are rows in `brand_domains`, added by an admin at runtime ([ARCHITECTURE §11](../planning/ARCHITECTURE.md#11-help-center-ssr--custom-domains)). No static `@Controller({ host })` can express that, so `RequestContextMiddleware` resolves the brand from the `Host` header through a `BrandResolver`, whichever adapter is underneath.
- **The api never parses a file upload.** Attachments are uploaded straight to S3 through a presigned PUT and confirmed afterwards ([ARCHITECTURE §9](../planning/ARCHITECTURE.md#9-media-pipeline)), so nothing in the api needs `multipart/form-data`.
- **Nothing in the stack table is Express middleware.** Sessions, throttling and CSRF are ours or Redis-backed; the only third-party middleware M0 needs is a security-header plugin, which exists for both.

## Decision

Create the application with `FastifyAdapter` from `@nestjs/platform-fastify`, and take `@fastify/helmet` rather than `helmet` for the security headers of [REQUIREMENTS §5.1](../planning/REQUIREMENTS.md#51-security-non-negotiable).

## Consequences

- Nest's own performance chapter puts Fastify at roughly twice Express's throughput. For a process that is simultaneously an API, a socket gateway and an SSR host on a single self-hosted box, that headroom is spent on all three.
- Nest middleware runs through `@fastify/middie`, which hands the middleware the **raw** Node `req`/`res` and rewrites `req.url` to the part after the mount prefix, keeping the whole path in `req.originalUrl`. `RequestContextMiddleware` reads `originalUrl`; anything mounted later has to do the same or it will log `/` for every request.
- Route parameters are not available in middleware, only from the guards onwards. That is why the target brand is resolved in `PermissionGuard` and only the host-derived brand is settled in the middleware.
- Recipes written for Express do not transfer. `FileInterceptor`, `multer`, `express-session` and Express-shaped middleware have to be replaced by their Fastify equivalents. The media pipeline never needed the first two, and sessions are Redis-backed in M0-05.
- Sub-domain routing with `@Controller({ host })` is unavailable — Fastify has no nested routers, and Nest's documentation says to prefer Express when that decorator is the routing mechanism. It is not ours: brand domains are data, so `BrandResolver` is the mechanism, and it works the same on either adapter.
- `fastify` itself is a direct dependency of `apps/api` even though `@nestjs/platform-fastify` bundles it, because `FastifyReply` and `FastifyRequest` are named in our own signatures. It is pinned to the exact version the adapter depends on, and Renovate has to move the two together.
- Socket.IO attaches to the underlying Node HTTP server, so M0-13 is unaffected by the choice.

## Alternatives considered

- **`@nestjs/platform-express`.** Nest's default, the widest ecosystem, and the adapter its documentation recommends when sub-domain routing goes through `@Controller({ host })`. Rejected because that recommendation does not apply here — brand domains are rows, not decorators — and because none of the Express-only middleware is in our stack table, so the ecosystem advantage buys nothing while the throughput difference is real on a single-host deployment.
- **Express now, Fastify later.** Rejected as the worst of both: the adapter leaks into every request and reply signature, into the middleware form and into the plugin choices, so "later" means rewriting the seams M0-04 exists to establish, in a milestone that has features to ship instead.
