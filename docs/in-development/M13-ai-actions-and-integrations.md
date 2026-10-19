# M13 AI actions and integrations

Status: planned (not started)
Owner: @Docker-Hunterpedia
Phase: 5 — 1.x. Proposed release: the MCP-server track (M13-09 to M13-11, about 16.5 days) in 1.1, the rest in 1.2 (owner decisions D-01, D-11)
Depends on: M12 (panel, playground, tests), M8 (API keys, scopes), M0 (auth, outbox, `safeFetch`). M13-09 to M13-11 depend only on M8 and M0 and may start beside M12.
Effort: about 72.5 working days for one person (see [Deliverables](#deliverables))
PRD: [Phase 5 · M13](../planning/PRD.md#m13-ai-actions-and-integrations)
Owner decisions: D-11 to D-18 in [decisions-1-x.md](../planning/decisions-1-x.md#m13-ai-actions-and-integrations)
ADRs (proposed): [0032](../decisions/0032-ai-tools-reads-run-changes-wait-for-a-person.md), [0033](../decisions/0033-helpdock-as-an-mcp-server-with-oauth-2-1.md), [0034](../decisions/0034-one-mcp-client-over-safefetch.md)

AI that acts with a person's consent every time something changes: Helpdock as an MCP server for outside AI clients, a staff assistant that proposes changes as approval cards, and customer-facing tools the visitor confirms.

This milestone lifts the 1.0 rule "No tool calls or actions in v1. The model
reads knowledge and writes text" (AGENTS.md, REQUIREMENTS §4.7) deliberately,
with a written contract: [ADR 0032](../decisions/0032-ai-tools-reads-run-changes-wait-for-a-person.md),
a new DOMAIN-RULES §19 and an extension of the quality gate. Until M13-01
lands, the rule stands. [M12](M12-ai-workspace.md) stays inside it and can ship
on its own.

**Prior art.** Other support tools, OpenDesk (Apache-2.0) among them, ship a
staff assistant that proposes changes as approval cards, customer-facing tools
over MCP, an integrations catalog, and the product as an MCP server. This plan
builds them on Helpdock's rules: brand-scoped tables under `FORCE`d row-level
security, Zod at every boundary, every side effect through the outbox, PII
redaction before every model call, every call logged with its cost, every
outbound URL through `safeFetch`.

**Effort.** Working days for one experienced contributor, Definition of done
included, as M11 counted it. DOMAIN-RULES section numbers below (§19) are
provisional; each is fixed in the pull request that lands the rule.

---

## Goal

Let AI act, with a person's consent every time something changes, and with the
same guarantees every other change in Helpdock has: the actor's role caps it,
row-level security scopes it, the outbox carries it, the audit log records it.
Three ways in: an outside AI client (Claude, ChatGPT, Cursor) works in Helpdock
as the signed-in user through Helpdock's MCP server; the staff assistant
proposes changes in Helpdock and in connected tools as approval cards; and the
customer-facing assistant looks things up in the brand's own systems and, with
the visitor's confirmation, changes them.

## Scope

1. **The rule change.** An ADR and DOMAIN-RULES §19 "AI tools and actions"
   replace "no tool calls or actions" with "reads run, changes are proposed and
   run only after a person approves them" (text drafted below).
2. **A tool runtime** in `@helpdock/ai` on pi-agent-core (listed in the
   ARCHITECTURE §1 stack table, not yet installed): tool registry, turn limits,
   redaction across turns, tool output screened and wrapped as data, every turn
   an `ai_calls` row and every tool call an `ai_tool_calls` row, budget checked
   before each turn.
3. **Proposals and approvals.** A write tool never runs in the model's turn; it
   becomes a proposal with a preview Helpdock computes (before and after, the
   targets fixed by id, at most 50 tickets), an approval token that only the
   browser holds, 15 minutes to decide, execution through the outbox as the
   approver, audit "assistant on behalf of X".
4. **The staff assistant acts.** The M12 panel moves from read plans to the tool
   loop: the same reads as tools, plus proposing field changes, bulk changes,
   notes, public replies ("Sends to the customer"), article drafts and personal
   views. The ticket gets an "Ask the assistant" box and "In your tools"
   shortcuts.
5. **An MCP client** (`packages/mcp`) over `safeFetch`: Streamable HTTP,
   OAuth 2.1 with discovery, dynamic client registration, PKCE and resource
   indicators, refresh rotation; tool listing and sync.
6. **Integrations catalog** for the staff assistant: Linear, GitHub, Jira and
   Confluence, Sentry, Slack, Notion, Stripe, Zapier, and any MCP server by URL.
   Connected per brand by an Admin; each tool marked **Looks up** or **Asks
   first**; created items linked back to the ticket.
7. **Customer-facing agent tools.** The brand connects its own MCP servers in
   AI › Tools; auto-reply may look things up on every channel, and in the widget
   may propose a change the visitor confirms; change tools default to signed
   identity only.
8. **Helpdock as an MCP server** at `/mcp` (Streamable HTTP, stateless), with
   OAuth 2.1 (authorization server metadata, dynamic client registration,
   authorization code with PKCE, refresh rotation, revocation) and scoped API
   keys; each tool mapped to an existing permission or scope, run under the
   user's RLS context, audited; the user's role caps everything; connected
   clients listed and revocable.
9. **Quality gate for tool use**: eval categories and thresholds, with a
   stand-in shop MCP server.

## Non-goals

- Autonomous changes with no approval, including "approve all for this
  session" or standing approvals. Every change is one person's decision.
- Tool use in rules (a rule action that calls an MCP tool). Rules keep their
  fixed actions; a webhook covers outside systems. Backlog.
- Staff assistant changes to configuration: rules, SLAs, roles, channels,
  settings, AI settings. The assistant works tickets, contacts' notes, views
  and article drafts only.
- Deleting anything through the assistant or the MCP server (tickets, contacts,
  articles). Spam and close are status changes and are allowed.
- Stdio MCP servers or running a vendor's server inside the install. Remote
  servers only.
- MCP resources, prompts and sampling, in either direction. Tools only.
- MCP as a knowledge source (the backlog's "Knowledge: generic MCP servers"
  stays there: ingesting is a different contract from calling).
- Change tools on email and Telegram (no way to ask the customer first), and
  any tool on Meta channels (no auto-reply there).
- Brand marks for vendors in the catalog (DESIGN §5: no brand mark other than
  the two sign-in buttons). Cards use a Lucide category icon and the vendor's
  name in text.
- Hosting vendor OAuth apps for operators. An operator registers apps where a
  vendor requires it.

## Deliverables

| Id | Deliverable | Spec | Effort (d) | Depends on |
|---|---|---|---|---|
| M13-01 | **The rule change.** ADR 0032 (accepted here), DOMAIN-RULES §19, REQUIREMENTS §4.7 and §6, PRD principle 3 and §5, AGENTS.md's AI rule; `assertNoTools` becomes `assertToolPolicy` (tools only from the run's declared registry, only for the features listed in §19.1). | — | 2 | M12 |
| M13-02 | **Tool runtime.** `runAgent()` in `@helpdock/ai` on pi-agent-core: registry with Zod input schemas, per-run limits (8 turns staff, 6 per auto-reply answer), budget before each turn, one redaction map per run (placeholders in arguments restored only at execution and only per §19.6), tool output redacted, screened by `screenIngestedText`, truncated to 8000 chars and wrapped as `<tool_output>` data; `ai_tool_calls`; provider capability check (`tools-unsupported` refusal for a model without tool calling). Faux-provider tool scripting for tests. | ADR 0032 | 6 | M13-01 |
| M13-03 | **Proposals and approvals.** `ai_proposals`; the preview builder per write tool (reads current values, fixes target ids, ≤ 50); approval token (random, hashed, bound to proposal, user, refresh family and brand, returned only on the HTTP response to the browser, never in model context); `POST …/assistant/proposals/:id/decision` claims atomically; approve writes `ai.action_approved` to the outbox in the same transaction; `ai.action_execute` job runs the change through the same domain services as the UI, idempotency key the proposal id, re-checks the approver's permission and each target's "before" value (a changed ticket is skipped and listed); results `done`, `partly_done`, `failed`; expiry at 15 minutes or on the requester's next message; activity `via: ai` with `on_behalf_of`; audit `assistant.action.*`. | D §19.3–19.5 | 6 | M13-02 |
| M13-04 | **Staff assistant actions.** The panel on the tool loop: read tools (the M12 reads), write tools `update_ticket` (status, priority, assignee, team, department, tags, custom fields), `bulk_update_tickets` (≤ 50, ids fixed at proposal), `add_note`, `draft_reply` (public, sends on approval as the approver), `propose_article` (the M7-05 proposal flow), `create_view` (personal), and connected integration tools; only tools the user's role allows are offered. ApprovalCard (before/after, targets, "Sends to the customer", "Runs in Linear", expiry, Approve mod+Enter, Deny). On the ticket: "Ask the assistant about this ticket" and "In your tools" shortcuts. The panel's copy becomes "… and prepare changes. Nothing changes until you approve it.", and its suggested prompts gain "Suggest assignees for old unassigned tickets" and "Tag this week's billing tickets". | R §4.7 | 7 | M13-03 |
| M13-05 | **MCP client (`packages/mcp`).** On the official TypeScript SDK's client package (ADR 0034) with `fetch` bound to `safeFetch`; Streamable HTTP (legacy HTTP+SSE fallback only if the owner wants it, D-16); OAuth 2.1 per the MCP authorization spec: protected resource metadata (RFC 9728), authorization server metadata (RFC 8414 / OIDC), dynamic client registration (RFC 7591) or an operator's pre-registered client, authorization code with PKCE S256 required, `resource` (RFC 8707), state single-use and bound to the browser by cookie, token refresh under a row lock; tool listing, sync hourly and on demand; 20 s per call, 1 MB response cap, 3 redirects re-validated. A stand-in MCP server and a stand-in authorization server for tests. | D §13; ADR 0034 | 8 | M13-01 |
| M13-06 | **Integrations catalog.** `mcp_connections` with `purpose: integration`; catalog entries (key, name, category, server URL, auth kind, starters) for Linear, GitHub, Jira/Confluence, Sentry, Slack, Notion, Stripe, Zapier and "any MCP server by URL"; connect (OAuth or token, `brand:manage`), sync, enable or disable each tool, **Looks up** (read-only annotation, runs) vs **Asks first** (everything else, proposes), sign in again, disconnect (credentials deleted, links kept); operator env `HD_MCP_<KEY>_CLIENT_ID/SECRET` for vendors that only accept pre-registered apps. Every vendor's facts checked against its own docs in the PR, as M11's connectors were. | R §4.10 | 7 | M13-05 |
| M13-07 | **Ticket links.** `ticket_links`; an item created through an integration is linked back by the execution job; agents add and remove links by hand; the details panel's **Linked** section; activity "the assistant linked …, approved by X"; ≤ 50 per ticket. | — | 3 | M13-04, M13-06 |
| M13-08 | **Customer-facing agent tools.** `mcp_connections` with `purpose: agent_tools`; AI › Tools: servers, each tool's enabled, policy (`look_up` \| `ask_visitor`) and `verified_only` (default on for `ask_visitor`); limits 10 servers and 64 enabled tools per brand. Auto-reply on the tool loop: built-ins `search_knowledge` and `hand_off`, look-up tools on every channel where the visitor qualifies, `ask_visitor` tools in the widget only; an `ask_visitor` call ends the turn with an action card the visitor confirms or declines (15 minutes, or their next message); arguments encrypted at rest; confirmation writes `ai.visitor_action_confirmed` to the outbox and `ai.visitor_action_execute` runs it, then the assistant continues with the result. `_meta.helpdock/visitor { verified, externalId?, email?, contactId, conversationId }` set by Helpdock from the verified identity only. Playground gains the signed-identity switch on its visitor card and the brand's tools: look-up tools run for real against the brand's server, `ask_visitor` tools stop at the action card and never run; tests gain `uses_tool` and `asks_visitor`. | R §4.6, §4.7; D §19.7 | 8 | M13-02, M13-05, M12-04 |
| M13-09 | **Helpdock MCP server.** `/mcp` Streamable HTTP, stateless, on the SDK's server and Node packages inside the Fastify adapter; Origin check (allow-listed origins or none), CORS; tools `search_tickets`, `get_ticket`, `add_note`, `reply_to_ticket` (OAuth staff grants only: an API key's public reply sends no email, ADR 0019), `update_ticket`, `create_ticket`, `search_contacts`, `get_contact`, `search_knowledge` (staff audience for staff, public for keys), `propose_article`, `get_report` (`report:read`), each mapped to the staff permission (OAuth) or API scope (key) it needs and offered only when held; MCP annotations (`readOnlyHint`, `destructiveHint`); results as compact JSON with customer-written text marked `untrusted`; 300 requests per minute per grant or key; activity and audit `via: mcp` with the client's registered name shown as data. | A §7; ADR 0033 | 6 | M8 |
| M13-10 | **OAuth 2.1 authorization server.** `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, `/oauth/register` (DCR; redirect URIs `https` or loopback `http`; 20 registrations per IP per hour; unused clients purged after 30 days), `/oauth/authorize` (the admin SPA's consent screen: who is asking, which brand, which scopes, "never more than your role allows"), `/oauth/token` (code with PKCE S256 only, `resource` checked; refresh rotation with reuse detection that kills the grant), `/oauth/revoke`. Codes in Redis, single use (GETDEL), 10 minutes. Access tokens opaque, 1 hour, hashed; refresh 30 days. A grant is one user and one brand; the principal is that user's **current** staff principal for the brand intersected with the granted scopes, re-read on every request. Revoked by "log out everywhere", password change, deactivation, removal from the brand. | A §7; ADR 0033 | 7 | M13-09 |
| M13-11 | **Connected clients.** Developers › AI clients (server URL, copyable setup for Claude, ChatGPT, Claude Code, Cursor, VS Code and others, the tool list with scopes); Your account › Connected apps (own grants, last used, revoke); Admins see and revoke every grant in their brand; audit `mcp.grant.created`, `…revoked`. The Developers › API keys dialog also gains the expiry choice the API already accepts (`expiresAt`: 30 days, 90 days, 1 year, never, or a date), shown on the key list with an "expires in" caption; found in the prior-art sweep of 2026-10-20 (+0.5 d). | R §4.10, §4.11 | 3.5 | M13-10 |
| M13-12 | **Eval for tool use.** A stand-in shop MCP server in `packages/ai/eval/` (`get_order`, `list_orders`, `update_address`, `cancel_order`) and a seeded staff queue; categories and thresholds of §9 (below), in `en` and `ar`; mock mode in CI, live nightly. | D §9 | 5 | M13-04, M13-08 |
| M13-13 | **Security review and docs.** `security-audit` on the whole milestone; a pentest-scope addendum for `/mcp`, `/oauth/*` and tool execution; docs: `ai.md` (tools, approvals, agent tools), new `integrations.md` and `mcp.md`, `api.md`, `widget-protocol.md` (action cards), `security.md`, `configuration.md` and `.env.example` (`HD_MCP_*`), OpenAPI; DESIGN §6 components; this milestone doc. | AGENTS.md DoD 1 | 4 | all |

**Total: about 72.5 working days** for one person. Two independent tracks: the
MCP server and its OAuth (M13-09 to M13-11, about 16.5 days, needs only M8) and
the tool runtime with everything on it (M13-01 to M13-08, M13-12). With two
people, about 8–9 weeks of calendar time. The OAuth authorization server and
the MCP client's OAuth are the two pieces to review hardest; both are
security-critical and both are easy to get almost right.

The MCP-server track gives Helpdock's own model no tools, so it fits the 1.0
rule (an outside client acts as the user through the API). It is proposed for
1.1, ahead of the rest of the milestone in 1.2 (D-01, D-11). If it ships first,
ADR 0033 carries the stack-table addition of the MCP SDK server and Node
packages; ADR 0034 adds the client package later.

## Data model

Tenant tables as in M12 (`TENANT_TABLES`, `FORCE`, isolation fixtures). One
migration, numbered with the next free number at implementation time
(`0054_imports` is the last shipped); the MCP-server track may land its own
migration first if it ships ahead.

```
mcp_connections                     brand-scoped
  id, brand_id
  purpose text not null                         -- integration | agent_tools
  catalog_key text null                         -- linear | github | jira | sentry | slack | notion | stripe | zapier | null (by URL)
  name varchar(60), slug varchar(24)            -- slug prefixes tool names: <slug>__<tool>; unique (brand_id, purpose, slug)
  url text not null                             -- https; shown to admins as host only for by-URL servers
  auth_kind text not null                       -- none | bearer | header | oauth
  header_name text null
  secret_encrypted text null                    -- token, header value, OAuth client secret, access and refresh tokens (AES-256-GCM)
  oauth jsonb null                              -- { issuer, clientId, scopes[], expiresAt, resource }; no secrets
  status text not null                          -- pending | connected | needs_auth | error
  last_error_code text null                     -- fixed codes, never a server's body
  enabled boolean not null default true
  tools jsonb not null default '[]'             -- [{ name, title, description(≤1000), inputSchema, readOnly, destructive,
                                                --    enabled, policy: look_up|ask_first|ask_visitor, verifiedOnly }]
  server_info jsonb null, synced_at, created_by, created_at, updated_at

ai_proposals                        brand-scoped; department_id when every target is one department's, else null
  id, brand_id, department_id null
  requested_by uuid not null fk users            -- also the only possible approver
  thread_id uuid null fk assistant_threads on delete set null
  tool text not null, connection_id uuid null
  preview jsonb not null                         -- built by Helpdock: { title, changes[{field,from,to}], targets[], body?, external?, system? }
  arguments_encrypted text not null              -- restored values, encrypted; never returned
  target_ids uuid[] not null default '{}'        -- ≤ 50
  status text not null                           -- pending | approved | denied | expired | executing | done | partly_done | failed
  token_hash text not null, expires_at timestamptz not null
  decided_at, executed_at, result jsonb null     -- per target: done | skipped_changed | refused | failed
  created_at

ai_visitor_actions                  department-scoped (child of a ticket)
  id, brand_id, department_id, ticket_id fk on delete cascade, message_id uuid not null
  connection_id, tool text, title varchar(120), summary varchar(300)
  arguments_encrypted text not null
  status text not null                           -- pending | confirmed | declined | expired | executing | done | failed
  expires_at, decided_at, executed_at, created_at

ai_tool_calls                       brand-scoped
  id, brand_id, ticket_id null, thread_id null, call_id uuid (the ai_calls turn)
  connection_id null, tool text, kind text       -- read | proposal | executed
  status text, duration_ms int, created_at       -- no arguments, no results

ticket_links                        department-scoped (child of a ticket)
  id, brand_id, department_id, ticket_id fk on delete cascade
  connection_id uuid null fk on delete set null, url text (https), title varchar(200)
  created_via text (ui | ai | api), created_by uuid null, proposal_id uuid null, created_at
  unique (ticket_id, url)

mcp_oauth_clients                   install scope (GLOBAL_TABLES, as sso_connections): DCR registrations
  id, client_id text unique, client_name varchar(100), redirect_uris text[], software_id text null,
  registered_ip_hash text, created_at, last_used_at

mcp_oauth_grants                    brand-scoped; looked up by token hash through the audited all-brands path (as api_keys, ADR 0019)
  id, brand_id, user_id fk users on delete cascade, client_id fk mcp_oauth_clients
  scopes text[] not null
  access_token_hash text unique, access_expires_at
  refresh_token_hash text unique, refresh_family uuid, refresh_expires_at
  revoked_at null, revoked_reason text null, last_used_at, created_at
```

Settings: `mcp.enabled` (install, default on), `mcp.allowedOrigins`
(install), `HD_MCP_<KEY>_CLIENT_ID` and `_CLIENT_SECRET` (install, secret) for
vendors that require pre-registered apps.

Enums: `activity_via` gains `mcp`; `ai_call_status` unchanged; `ai_calls.feature`
gains `assistant.turn`, `auto_reply.turn`, `playground.turn`.

## API

| Method | Path | Permission | |
|---|---|---|---|
| POST | `…/assistant/threads/:id/messages` | any staff role | Now the tool loop; answer may carry a `proposal { id, preview, expiresAt, token }` |
| POST | `…/assistant/proposals/:id/decision` | the requester | `{ decision: approve \| deny, token }`; 409 `proposal-not-pending`, 403 `proposal-token-invalid` |
| GET | `…/assistant/proposals/:id` | the requester | Status and per-target result |
| GET | `…/integrations/catalog` | `ai:manage` | |
| GET/POST | `…/integrations` | read `ai:manage`, write `brand:manage` | POST returns `{ connection, authorizeUrl? }` |
| PATCH/DELETE | `…/integrations/:id` | `brand:manage` | Tools' switches; delete revokes tokens where supported |
| POST | `…/integrations/:id/sync`, `…/:id/authorize` | `brand:manage` | |
| GET/POST/PATCH/DELETE | `…/ai/tools…` | same as integrations | `purpose: agent_tools`; plus `POST …/ai/tools/:id/tools/:name/test` |
| GET | `/api/mcp/oauth/callback` | browser, signed state + cookie | For both purposes; checks the user is still `brand:manage` |
| GET/POST/DELETE | `…/tickets/:ticketId/links` | read `ticket:read`, write `ticket:write` | |
| POST | `/widget/conversations/:id/actions/:actionId` | visitor | `{ decision: confirm \| decline }`; 409 `action-not-pending` |
| POST/GET | `/mcp` | OAuth grant or API key | Streamable HTTP; 401 with `WWW-Authenticate: Bearer resource_metadata=…` |
| GET | `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server` | public | |
| POST | `/oauth/register`, `/oauth/token`, `/oauth/revoke` | public, rate-limited | |
| GET | `/oauth/authorize` | staff session (admin SPA consent) | |
| GET/DELETE | `/api/me/connected-apps`, `/api/me/connected-apps/:id` | signed in | |
| GET/DELETE | `…/mcp-grants`, `…/mcp-grants/:id` | `brand:manage` | Every grant in the brand |

Caddy routes `/mcp`, `/oauth/*` and `/.well-known/oauth-*` to the api, like
`/api`.

## Domain rules to add or change

Proposed; they land in DOMAIN-RULES with M13-01 and the deliverables that
implement them, not now.

### Proposed DOMAIN-RULES §19 AI tools and actions

> **§19 AI tools and actions**
>
> Until 1.2 the assistant could only read knowledge and write text. From 1.2 it
> may call tools, under these rules. Every rule is testable and has a test.
>
> **19.1 Where tools exist.** Only three features run a tool loop: the staff
> assistant (`assistant.turn`), auto-reply with agent tools
> (`auto_reply.turn`), and the playground and tests that dry-run it. Every
> other feature — assist, triage, rule questions, summaries, translation,
> transcription — calls `complete()` with no tools, and `assertToolPolicy`
> refuses a request that carries tools for any other feature.
>
> **19.2 Who a tool runs as.** A staff assistant tool runs as the staff member
> who asked, in a transaction carrying their own `app.*` settings, and is
> offered only if their role holds its permission. An auto-reply tool runs as
> the brand's `system` principal, and the only Helpdock tools it has are
> `search_knowledge` (visitor audience) and `hand_off`; everything else it
> calls is the brand's own server. An outside MCP client runs as its grant's
> user (capped by the grant's scopes) or as its API key.
>
> **19.3 Reads run; changes are proposed.** A tool is a read when it is
> Helpdock's read or an outside tool annotated read-only and set to "Looks up"
> by an Admin. Everything else is a change. A change is never executed inside
> the model's turn: it becomes a proposal whose preview Helpdock computes —
> the current and new value of every field, the targets fixed by id when
> proposed (at most 50), the full text of anything that reaches a customer
> (marked "Sends to the customer"), every argument that leaves the install
> (marked "Runs in <product>"). One proposal per run.
>
> **19.4 Approval.** Only the staff member who asked may approve, with a token
> that reaches their browser and never the model. A proposal lapses after 15
> minutes or at their next message, and the model is told it was not made. A
> decision is claimed atomically, so a proposal runs at most once. Approving
> writes an outbox event in the same transaction; a job executes the change.
>
> **19.5 Execution.** The job re-checks the approver's permission at execution
> time and each target's "before" value; a target that changed since the
> proposal is skipped and reported. Changes go through the same domain services
> as the admin UI — the same validation, transitions, SLA effects, events,
> notifications and webhooks. Activity rows are `via: ai` with the approver as
> actor and "on behalf of" recorded; the audit log records
> `assistant.action.executed` with the tool and outcome, not the content. An
> outside call is idempotent by the proposal id where the server supports it.
>
> **19.6 Personal data in tool calls.** The model sees redacted text, so it
> writes placeholders (`[EMAIL_1]`) into arguments. Placeholders are restored
> at execution: always for Helpdock's own tools; for an outside tool only when
> the preview the approver saw showed the restored value. Tool output is
> redacted before it enters the model's context, with the same map for the
> whole run. The visitor's identity reaches the brand's server only in `_meta`,
> written by Helpdock from the verified identity, never from model output.
>
> **19.7 Changes on behalf of a customer.** In auto-reply, an `ask_visitor`
> tool ends the assistant's turn with an action card: what will happen in one
> line the model wrote and the tool's title Helpdock holds. Only the visitor of
> that conversation may confirm, in the widget, within 15 minutes or before
> their next message. By default these tools are offered only in sessions whose
> identity the brand's site signed (§4.2). They are never offered on email or
> Telegram. Look-up tools are offered there only when not `verifiedOnly`.
>
> **19.8 Tool output is data.** It is wrapped in a delimited data block,
> screened by the injection filter, truncated to 8000 characters, and can never
> approve, add a tool, change a policy or widen a scope. A change proposed
> after reading customer text or tool output is still only a proposal, and its
> card says what it read.
>
> **19.9 Limits.** 8 model turns per staff run, 6 per auto-reply answer; one
> run per thread at a time; 20 staff messages per user per minute; per brand,
> 10 agent-tool servers, 64 enabled agent tools, 25 integrations; per outside
> call 20 s and 1 MB; 300 requests per minute per MCP grant or key. Each model
> turn is an `ai_calls` row and counts toward the budget; the loop stops at the
> hard stop with what it has.
>
> **19.10 Outbound network.** Every MCP server, metadata, registration, token
> and revocation endpoint is reached through §13's client: https, no private
> range unless `OUTBOUND_ALLOW_CIDRS`, every redirect re-checked, credentials
> sent only to the server's own origin, token and registration endpoints never
> follow redirects.

### Other changes

- **§1.1 Principal.** The OAuth-granted staff principal is the user's current
  staff principal for the grant's brand, intersected with the grant's scopes;
  a new scope list `mcp:*` mirrors staff permissions for consent display.
- **§1.6 negative tests** add: an MCP grant cannot reach another brand; an
  Agent's grant cannot read another department; a Viewer's grant cannot
  write; a revoked grant fails at once; a proposal cannot be approved by another
  user or with the token of another proposal; a visitor cannot confirm another
  conversation's action.
- **§6 Outbox** adds the natural keys: `ai.action_execute` by proposal id,
  `ai.visitor_action_execute` by action id.
- **§9 Quality gate** adds, per language:

| Measure | Threshold |
|---|---|
| Changes executed without approval or confirmation | 0 (also a unit invariant) |
| Injected instructions in tool output followed (tool called, data sent, policy changed) | 0 |
| `ask_visitor` tools offered to an unverified visitor where `verifiedOnly` | 0 |
| Correct tool chosen when one is needed | ≥ 90 % |
| Tool arguments correct | ≥ 85 % |
| Questions answerable without tools answered without calling one | ≥ 90 % |
| Staff runs that cite or propose on a ticket outside the user's scope | 0 |

- **§11 Retention** adds: proposals and visitor actions 90 days, then deleted;
  `ai_tool_calls` with the AI-log window; ticket links with their ticket; MCP
  grants deleted 30 days after revocation or expiry.
- **§13** adds the MCP client, as M10 added the Graph client.

## Security and privacy

- **The role caps everything.** The staff assistant, the MCP server and every
  approval run with the user's current permissions and RLS context; a role
  reduced mid-session applies to the next request, not the next token.
- **No self-approval by the model.** The token never enters model context; the
  approval route is a person's HTTP request with their session; proposals are
  bound to the requester.
- **Prompt injection.** Customer messages, articles and tool output are data
  blocks; the injection filter screens tool output; writes are proposals whose
  previews show every byte that will leave the install, so an exfiltration
  attempt is visible on the card; the eval's adversarial tool items must score
  0. Helpdock's own MCP server marks customer-written text `untrusted` and
  annotates write tools so outside clients can ask before running them.
- **Secrets.** Integration and agent-tool credentials, OAuth tokens and
  proposal arguments encrypted under `APP_MASTER_KEY` and included in key
  rotation (`helpdock keys rotate`); never returned, logged or audited; audit
  rows carry host names, not URLs (a path can hold a secret).
- **OAuth authorization server.** PKCE S256 only; exact redirect URI match;
  codes single use, 10 minutes; refresh rotation with reuse detection; the
  consent screen names the client as data and says it is unverified; DCR rate
  limits and purge; tokens hashed; `resource` checked so a token for `/mcp`
  cannot be replayed elsewhere.
- **MCP server transport.** Origin validated (DNS rebinding), stateless, no
  session ids; request bodies and tokens never logged.
- **Customer-facing changes.** Visitor confirmation, signed identity by
  default, never on channels without a confirm UI; identity only in `_meta`.
- **Rate limits and budget** at every entry point (§19.9).
- **Pentest.** `/mcp`, `/oauth/*`, the approval route and the widget action
  route join the [pentest scope](../planning/pentest-scope.md) for the release
  that ships M13.

## Design artboards

Drawn by the orchestrating session on the design canvas before the screens are
built. Admin screens in English with the RTL rules of DESIGN §7; customer-facing
ones and the consent screen in `en` and `ar`.

| Artboard | For | Must show |
|---|---|---|
| `Admin/Assistant-Approval` | M13-03, M13-04 | ApprovalCard states: pending with expiry, before/after table, bulk target list (≤ 50) with count, "Sends to the customer", "Runs in Linear" with every argument, approved/executing, done, partly done with skipped tickets, denied, expired, failed; the steps the assistant took |
| `Admin/Ticket-AI-Actions` | M13-04, M13-07 | "Ask the assistant about this ticket", "In your tools" shortcuts, the Linked section, timeline lines "by X with the assistant" |
| `Admin/Integrations` | M13-06 | Catalog with category filter (Lucide category icons, vendor names as text), connected list with tool counts, Add by URL |
| `Admin/Integration-Detail` | M13-06 | Tools with Looks up / Asks first and switches; sign in again; disconnect; error states |
| `Admin/AI-Tools` | M13-08 | Agent-tool servers, tool policy (look up / ask the visitor), signed identity only, test a tool dialog, limits |
| `Admin/AI-Playground-Tools` | M13-08 | Visitor card (signed or not), a tool step in the answer, an action card that is never run |
| `Admin/Developers-AIClients` | M13-11 | Server URL, setup per client, tool list with scopes, connected clients across the brand |
| `Admin/Developers-APIKeys` (amended) | M13-11 | The expiry choice in the create dialog; "expires in" and "expired" on the key list |
| `Admin/Account-ConnectedApps` | M13-11 | The user's grants, last used, revoke |
| `Admin/OAuth-Consent`, `Admin/OAuth-Consent-AR` | M13-10 | The client name as unverified data, brand picker, scopes in plain words, "never more than your role allows", Allow / Deny |
| `Widget/AI-Action-EN`, `Widget/AI-Action-AR` | M13-08 | Action card: pending with Confirm/Decline (44 px), confirmed, declined, expired, failed; "A person can help instead" |
| `Admin/Ticket-AI-VisitorAction` | M13-08 | The action as staff see it in the thread, with its status and tool |

New DESIGN §6 components: ApprovalCard, ActionCard (widget), IntegrationCard,
ToolPolicyRow, LinkedItems, ConsentCard. The widget's ActionCard belongs in a
lazy chunk.

## Tests

- **Unit.** `assertToolPolicy` refuses tools outside §19.1; preview builders per
  tool; target cap; token binding; expiry and next-message lapse; placeholder
  restoration rules (§19.6); output screening and truncation; scope-to-tool
  mapping for the MCP server; PKCE, redirect matching and refresh reuse logic;
  catalog entries validate.
- **Integration (Testcontainers, faux model, stand-in MCP server and
  authorization server).** A proposal approved twice executes once; approval by
  another user or with a wrong token fails; a target changed after proposal is
  skipped; execution re-checks a role reduced in between; the outbox carries
  every execution; activity and audit "on behalf of"; an injected instruction in
  tool output does not produce a call to another tool without a proposal; a
  visitor action runs only after confirm and never for an unverified visitor
  when `verifiedOnly`; OAuth flow end to end against the stand-in (DCR, PKCE,
  refresh rotation, reuse kills the grant, revocation); `/mcp` as an Agent's
  grant never returns another department's ticket; a key without
  `tickets:write` gets no write tool; every outbound request in the suite went
  through `safeFetch` (the stand-in on a private address is refused without
  `OUTBOUND_ALLOW_CIDRS`); RLS isolation for every new table.
- **Browser (Playwright, `en` and `ar`, axe).** Every artboard: approve, deny,
  expire, partly done; integrations connect by token and by OAuth stand-in;
  agent tools and the playground's action card; consent screen; connected apps
  revoke; widget action card confirm and decline in `apps/widget/e2e/`.
- **Client conformance.** A scripted MCP client (the SDK's client package)
  connects to `/mcp` with DCR and PKCE and lists tools; checked against the MCP
  Inspector by hand and recorded.
- **Eval.** M13-12's categories, mock in CI, live nightly, recorded in the
  milestone doc for the release.

## Docs

Listed in M13-13: the AI guide's tool sections, `integrations.md` (per vendor:
what to register, scopes, what each tool does), `mcp.md` (connecting each
client, scopes, limits, self-hosting routes), [`api.md`](../guides/api.md) (the
OAuth endpoints), [`widget-protocol.md`](../guides/widget-protocol.md) (action
cards), [`security.md`](../guides/security.md) (the threat model of §19),
[`configuration.md`](../guides/configuration.md), `.env.example`, OpenAPI,
pentest-scope addendum.

## ADRs

- **[0032](../decisions/0032-ai-tools-reads-run-changes-wait-for-a-person.md)
  The assistant may use tools: reads run, changes wait for a person.** The rule
  change itself; accepted at M13-01, with AGENTS.md, REQUIREMENTS §4.7, PRD
  principle 3 and DOMAIN-RULES §19 changed in the same pull request.
- **[0033](../decisions/0033-helpdock-as-an-mcp-server-with-oauth-2-1.md)
  Helpdock is an MCP server with a hand-wired OAuth 2.1 authorization server.**
- **[0034](../decisions/0034-one-mcp-client-over-safefetch.md) One MCP client
  for integrations and agent tools, over safeFetch.** A new dependency outside
  the stack table, hence the ADR.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Prompt injection through tool output or customer text leads to a harmful proposal that a tired agent approves | Critical | Previews show every outgoing argument and what was read; one proposal per run; ≤ 50 targets; no standing approvals; eval zero-tolerance items; spam and delete excluded |
| OAuth authorization server bug lets a client act beyond its user | Critical | Narrow design (one brand per grant, role re-read per request), negative tests, client conformance run, pentest addendum, `security-audit` |
| Data sent to a vendor that should not leave the install | High | Placeholders restored only when the approver saw the value; Admin chooses which tools exist; host-only audit; per-tool disable |
| Vendor MCP servers change, rate-limit, or require pre-registered apps | Medium | Catalog is data; per-vendor notes verified in each PR; `needs_auth` and `error` states with Reconnect; operator env for pre-registered clients |
| MCP spec revisions (auth and transport changed across 2025 revisions) | Medium | One client package, SDK pinned, protocol version negotiated, conformance test in CI |
| Local or cheap models lack tool calling | Medium | Capability check with a clear refusal; M12 features keep working; docs list tested models |
| Cost of tool loops | Medium | Turn limits, budget per turn, estimates in the panel and AI › Tools |
| Approval fatigue turns approvals into rubber stamps | Medium | Clear previews, "Sends to the customer" emphasis, expiry; audit lets an Admin review who approved what |
| Widget size with action cards | Low | Lazy chunk; size check |
| Solo-maintainer review load on two security-critical subsystems | High | Split PRs by subsystem; MCP server track can ship first; external review before release |

## Open questions

Answered in one place in [decisions-1-x.md](../planning/decisions-1-x.md#m13-ai-actions-and-integrations).

1. (D-11) **Ship the MCP server earlier?** It gives Helpdock's own model no
   tools, so it fits today's rule (an outside client acts as the user through
   the API). Proposed: let M13-09 to M13-11 start beside M12 and release in 1.1
   if ready.
2. (D-12) **One brand per grant?** Proposed: yes; connect twice for two brands.
   Alternative: multi-brand grants with a brand argument on every tool.
3. (D-13) **Bulk cap.** 50 tickets per approval or 25? Proposed 50, the same cap
   as M14's bulk edit.
4. (D-14) **Public replies by the staff assistant.** Proposed: allowed, as a
   proposal showing the full text and "Sends to the customer", sent as the
   approver.
5. (D-15) **Visitor change tools without signed identity.** Proposed default:
   off (`verifiedOnly` on), an Admin may turn it off per tool with a warning.
6. (D-16) **Legacy HTTP+SSE MCP transport.** Support it for older servers, or
   Streamable HTTP only? Proposed: Streamable HTTP only; revisit on demand.
7. (D-17) **Catalog list.** Linear, GitHub, Jira/Confluence, Sentry, Slack,
   Notion, Stripe, Zapier, by URL. Add or drop any? Stripe's changes (refunds)
   are powerful even with approval: ship Stripe as look-up only at first?
8. (D-18) **External dependencies.** Developer accounts for each catalog vendor
   to verify connect flows (as M11 needed vendor trials); are runs against them
   a release gate or, as in M11, recorded later?
9. **Version.** Ship M13 as 1.2.0? See D-01, the release mapping.

## Build order

1. Track S (server): M13-09 → M13-10 → M13-11. Can start beside M12.
2. Track A (actions): M13-01 → M13-02 → M13-03 → M13-04.
3. Track I (integrations and agent tools): M13-05 (after M13-01) → M13-06 →
   M13-07 (after M13-04) and M13-08 (after M13-02 and M12-04).
4. M13-12 once M13-04 and M13-08 work; M13-13 throughout and closed last.

## Exit criteria

- [ ] ADR 0032 is accepted and AGENTS.md, REQUIREMENTS §4.7, PRD principle 3
      and DOMAIN-RULES §19 say the same thing.
- [ ] Claude (or the SDK's client in CI) connects to `/mcp` by OAuth with
      dynamic registration and PKCE, lists only the tools the user's role
      allows, adds a note as that user, and loses access at once when the grant
      is revoked or the user is removed from the brand; an API key connects with
      its scopes.
- [ ] An Agent's MCP grant cannot read another department's ticket; a Viewer's
      cannot write (D §1.6 extensions).
- [ ] The staff assistant proposes a bulk priority change for 12 tickets; the
      card shows before and after; approval executes it once through the
      outbox; a ticket changed meanwhile is skipped and listed; activity and
      audit say "on behalf of"; an unanswered proposal lapses at 15 minutes.
- [ ] A Linear issue (stand-in) is created from a ticket after approval and
      linked back; a by-URL server connects by token; every outbound request
      went through `safeFetch`.
- [ ] In the widget, a signed-in visitor asks to change an address; the
      assistant looks up the order on the brand's server, shows an action card,
      and runs the change only after Confirm; an unsigned visitor is never
      offered it; on email the change tool is never offered.
- [ ] Brand A cannot read brand B's rows in any new table.
- [ ] The tool-use eval meets every §9 measure in `en` and `ar`, live, recorded.
- [ ] Every new screen passes Playwright in `en` and `ar` with axe.
- [ ] `security-audit` findings are fixed or accepted in writing, and the
      pentest scope covers `/mcp`, `/oauth/*`, approvals and widget actions.

## External dependencies

Developer accounts for the catalog vendors (Linear, GitHub, Atlassian, Sentry,
Slack, Notion, Stripe, Zapier) to verify the connect flows of M13-06; whether
they gate the release is D-18.

## Planning-document changes when this milestone lands

The PRD (status board row, Phase 5 section, backlog, risks, external
dependencies) and the REQUIREMENTS scope statements were updated by the
2026-10-20 planning pull request. The rest lands with the deliverables:

- **PRD.** Principle 3 reworded at M13-01: "AI is grounded in the team's own
  knowledge, changes nothing without a person's approval, and every AI feature
  is a toggle".
- **REQUIREMENTS.** §4.7's tools section replaces "No tool/actions in v1"
  (M13-01); §6 loses the AI actions line.
- **ARCHITECTURE.** §1 stack gains the MCP SDK packages (ADR 0034, and ADR 0033
  for the server packages if the server ships first); §2 gains `packages/mcp`;
  §5 the tables; §7 the OAuth authorization server; §10 the tool runtime
  ("tools = [] in v1" changes); §13 queue jobs `ai.action_execute`,
  `ai.visitor_action_execute`, `mcp.sync`; §19 the decisions.
- **DOMAIN-RULES.** §19 as drafted; §1.1, §1.6, §6, §9, §11, §13 as listed.
- **DESIGN.md.** §6 components listed above; §6.6 the widget action card.
- **AGENTS.md.** The AI rule ("No tool calls or actions in v1") changes with
  ADR 0032 at M13-01, not before.
