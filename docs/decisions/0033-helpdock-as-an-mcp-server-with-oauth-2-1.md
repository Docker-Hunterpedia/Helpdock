# 0033 Helpdock is an MCP server with a hand-wired OAuth 2.1 authorization server

Status: proposed
Date: 2026-10-20

## Context

AI clients (Claude, ChatGPT, Claude Code, Cursor, VS Code and others) connect
to outside products over the Model Context Protocol. Clients with connectors
expect Streamable HTTP and OAuth 2.1 per the MCP authorization specification:
protected resource metadata, authorization server metadata, dynamic client
registration and PKCE. Helpdock already has scoped API keys (ADR 0019), and its
auth stack is hand-wired by design (M0-05, ADR 0026's reasoning). It runs
NestJS on Fastify (ADR 0006).

M13-09 to M13-11 ([plan](../in-development/M13-ai-actions-and-integrations.md))
expose Helpdock as an MCP server. This track gives Helpdock's own model no
tools: an outside client acts as the user through the API, so it fits the 1.0
rule and is proposed for 1.1, ahead of the rest of M13 (owner decisions D-01,
D-11).

## Decision

1. `/mcp` over Streamable HTTP, **stateless**, no session ids, using the
   official TypeScript SDK's server package with its Node transport inside the
   Fastify adapter. Origin validated against an allow-list (DNS rebinding);
   request bodies and tokens never logged.
2. Tools (`search_tickets`, `get_ticket`, `add_note`, `reply_to_ticket`,
   `update_ticket`, `create_ticket`, `search_contacts`, `get_contact`,
   `search_knowledge`, `propose_article`, `get_report`) are each mapped to the
   staff permission (OAuth) or API scope (key) they need and offered only when
   held. Write tools carry MCP annotations; customer-written text in results is
   marked `untrusted`. No delete tools.
3. The **authorization server is hand-wired**: `/.well-known/oauth-protected-resource/mcp`,
   `/.well-known/oauth-authorization-server`, `/oauth/register` (dynamic client
   registration, rate-limited, unused clients purged after 30 days),
   `/oauth/authorize` (a consent screen in the admin SPA), `/oauth/token`
   (authorization code with PKCE S256 only, `resource` checked, refresh
   rotation with reuse detection that kills the grant), `/oauth/revoke`. Codes
   in Redis, single use, 10 minutes. Access tokens opaque, 1 hour, stored
   hashed like API keys; refresh tokens 30 days.
4. **A grant is one user and one brand.** The principal is the user's
   **current** staff principal for that brand intersected with the granted
   scopes, re-read on every request. "Log out everywhere", password change,
   deactivation and removal from the brand revoke it.
5. API keys work on `/mcp` too, with their scopes; an API key's public reply
   sends no email (ADR 0019).
6. **Stack table.** If M13-09 to M13-11 ship before the MCP client (M13-05),
   this record carries the ARCHITECTURE §1 addition of the MCP SDK's server and
   Node packages; ADR 0034 then adds the client package.

## Consequences

- Any MCP client can work in Helpdock as the signed-in user, and never with more
  than that user's role allows; a role reduced mid-session applies to the next
  request, not the next token.
- The OAuth authorization server is new security-critical code: it gets
  negative tests (another brand, another department, a Viewer writing, a revoked
  grant), a client conformance run against the SDK's client and the MCP
  Inspector, a pentest-scope addendum for `/mcp` and `/oauth/*`, and a
  `security-audit` pass.
- Two new tables, `mcp_oauth_clients` (install scope) and
  `mcp_oauth_grants` (brand-scoped); grants are found by token hash through the audited
  all-brands path, as API keys are.
- Caddy routes `/mcp`, `/oauth/*` and `/.well-known/oauth-*` to the api.

## Alternatives considered

- **The SDK's Express auth router**: Express is not the stack; ADR 0006 chose
  Fastify.
- **An external authorization server such as Keycloak**: contradicts a
  self-hosted product with no required third party.
- **API keys only**: clients with connectors need OAuth.
