# 0034 One MCP client for integrations and agent tools, over safeFetch

Status: proposed
Date: 2026-10-20

## Context

M13 ([plan](../in-development/M13-ai-actions-and-integrations.md)) connects
Helpdock to remote MCP servers for two purposes: an integrations catalog for
the staff assistant (Linear, GitHub, Jira and Confluence, Sentry, Slack,
Notion, Stripe, Zapier, any server by URL; M13-06) and the brand's own agent
tools for auto-reply (M13-08). Every outbound request to a user-supplied URL
must go through the SSRF-safe client (`safeFetch`, DOMAIN-RULES §13). Remote
MCP servers authenticate with OAuth 2.1 per the MCP authorization
specification. The MCP SDK is a new dependency outside the ARCHITECTURE §1
stack table, hence this record.

## Decision

1. `packages/mcp` wraps the official TypeScript SDK's client package, with its
   `fetch` bound to `safeFetch`. Context7 on 2026-10-20 lists
   `@modelcontextprotocol/typescript-sdk` v2.3.1, split into
   `@modelcontextprotocol/client`, `/server` and `/node`, beside v1.29.0; the
   version is pinned and rechecked at the pull request, per CLAUDE.md.
2. One table, `mcp_connections`, with a `purpose` (`integration` or
   `agent_tools`); tool policies (`look_up`, `ask_first`, `ask_visitor`,
   `verifiedOnly`) are stored per connection and tool. Credentials are
   encrypted under `APP_MASTER_KEY` and included in key rotation.
3. Transport: Streamable HTTP only (legacy HTTP+SSE only if the owner asks,
   D-16). Remote servers only; no stdio, no running a vendor's server inside the
   install. Tools only; no MCP resources, prompts or sampling.
4. OAuth client per the MCP authorization specification: protected resource
   metadata (RFC 9728), authorization server metadata (RFC 8414 / OIDC),
   dynamic client registration (RFC 7591) or an operator's pre-registered client
   (`HD_MCP_<KEY>_CLIENT_ID` and `_CLIENT_SECRET`), authorization code with PKCE
   S256, `resource` (RFC 8707), single-use state bound to the browser by cookie,
   token refresh under a row lock.
5. Limits per call: 20 s, 1 MB response, 3 redirects, each re-validated; token
   and registration endpoints never follow redirects; credentials are sent only
   to the server's own origin.
6. The vendor catalog is data. There are no vendor-specific code paths beyond
   auth quirks.

## Consequences

- One SSRF surface for every MCP server, vendor or brand-owned, tested once
  (a stand-in on a private address is refused without `OUTBOUND_ALLOW_CIDRS`).
- MCP spec revisions are tracked in one pinned package, with the protocol
  version negotiated and a conformance test in CI.
- ARCHITECTURE §1 gains the SDK client package and §2 gains `packages/mcp`.
- Each vendor's connect flow is checked against its own documentation in the
  pull request that adds it, as M11's connectors were.

## Alternatives considered

- **A hand-written JSON-RPC client**: spec churn, and two protocol versions to
  track by hand.
- **Vendor SDKs per integration**: eight clients and eight SSRF surfaces.
