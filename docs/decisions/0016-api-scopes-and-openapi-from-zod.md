# 0016 API keys act brand-wide through their own permissions, and OpenAPI is generated from Zod

Status: accepted
Date: 2026-10-05

## Context

M8-01 and M8-02 add the public REST API ([REQUIREMENTS §4.11](../planning/REQUIREMENTS.md#411-public-rest-api-tenant)): `hd_live_` keys with scopes, routes under `/api/v1`, and an OpenAPI 3.1 document at `/api/docs` generated from the Zod schemas. Three things had to be settled that the planning documents leave open.

1. **What a key may reach.** DOMAIN-RULES §1.1 gives the `apikey` principal a brand and scopes but no department list, and the department-scoped tables' policies (§1.3) see an empty list as "no department". A key with `tickets:read` would then read no ticket at all.
2. **How scopes meet `@Requires`.** `principalHasPermission` already treated a key's scopes as permission names. The staff permissions are singular (`ticket:read`); REQUIREMENTS names the scopes plural (`tickets:read`). If a scope were mapped onto the staff permission, every staff route would accept API keys, and several of them assume a staff member (contact notes have a user as author, the time tracker is a person's).
3. **How the document is generated.** `nestjs-zod` 5 generates OpenAPI only through `@nestjs/swagger`, which is not in the stack table (ARCHITECTURE §1).

## Decision

1. **A key acts for its whole brand.** The tenant context of an `apikey` principal is its one brand with every department (`app.all_departments = true`), as a worker's is (`tenant/tenant-scope.ts`). A key is issued by an Admin, who sees the whole brand; its scopes, not a department, are what narrow it. The brand stays the key's alone: `app.brand_ids` is never wider than the key's brand.
2. **The scopes are permissions of their own, and no role holds one.** `tickets:read`, `tickets:write`, `contacts:read`, `contacts:write`, `articles:read` and `webhooks:manage` are added to `PERMISSIONS` and required by the `/api/v1` routes. A staff session gets 403 on `/api/v1`, and a key gets 403 on every staff route, without either side checking the principal type by hand. Managing keys and the Admin's webhook settings are `brand:manage`.
3. **The document is built with Zod 4's own `z.toJSONSchema`** (`target: 'draft-2020-12'`), which is the dialect OpenAPI 3.1 uses, from a list of operations in `apps/api/src/api-v1/openapi.ts` that names the same schemas the routes validate and serialise with. A unit test compares that list with the routes the v1 controllers declare, method, path and scope, so the document cannot drift from the code. `/api/docs` is a server-rendered page with no script, in keeping with the install's CSP; `/api/docs/openapi.json` is the document.

Looking a key up happens before any brand is known, so the resolver reads `api_keys` by its unique hash in a transaction over every brand as the system principal `api-key.resolve`, the same explicit install-scope read `MailboxesRepository.findByAddresses` makes for inbound parse (now shared as `tenant/all-brands.ts`). It reads one table by one indexed column and returns the key's id, brand, scopes and rate limit.

## Consequences

- An integration sees tickets in every department of its brand, which is what an Admin who issues a key expects; a narrower key needs a department scope on the key, which is not in v1.
- A route that should accept both a person and a key (the webhook settings) is two thin controllers over one service, rather than one route with two permissions.
- Messages an API key posts have `author_type = system` and are recorded in the activity log as `apikey` via `api`; a public reply from a key does not send email, because only a staff member's public reply does (M2-05). Integrations that need to speak as an agent are a later decision.
- The OpenAPI document is generated at boot from code, never committed; a client generator points at `/api/docs/openapi.json`.

## Alternatives considered

- **Map scopes onto the staff permissions** (`tickets:read` → `ticket:read`). Rejected: every staff route would accept keys, including ones that assume a staff principal.
- **Give a key an empty department list and widen it per route.** Rejected: it would make the department policy the place a key's reach is decided, route by route.
- **`@nestjs/swagger` with `nestjs-zod`'s `cleanupOpenApiDoc`.** Rejected: a dependency outside the stack table, and decorators beside the Zod schemas that would have to be kept in step with them by hand.
- **A third-party viewer (Swagger UI, Redoc) at `/api/docs`.** Rejected: it needs script from a CDN or a bundle the api would have to serve, and the install's CSP is `default-src 'none'`. The JSON loads into any of them.
