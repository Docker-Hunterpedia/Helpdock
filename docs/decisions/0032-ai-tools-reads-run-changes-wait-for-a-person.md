# 0032 The assistant may use tools: reads run, changes wait for a person

Status: accepted (owner decision D-01, 2026-10-20)
Date: 2026-10-20

## Context

Helpdock 1.0 shipped with "No tool calls or actions in v1. The model reads
knowledge and writes text" (REQUIREMENTS §4.7, AGENTS.md), and `complete()`
enforced it with `assertNoTools`. That rule made 1.0 safe to ship and easy to
reason about. It also leaves out what teams now expect: an assistant that finds
the tickets and does the tedious change once someone says yes, an answer that
can look up an order, and AI clients outside the product working inside it.
Other support tools ship these with approval flows. The backlog already listed
"AI actions via MCP tools with approval flow".

M13 AI actions and integrations
([plan](../in-development/M13-ai-actions-and-integrations.md)) builds them.
This record is the rule change; it is accepted at M13-01, together with the
matching changes to AGENTS.md, REQUIREMENTS §4.7, PRD principle 3 and a new
DOMAIN-RULES §19 "AI tools and actions" (proposed text in the plan).

## Decision

1. Three features may run a tool loop: the staff assistant, auto-reply with
   the brand's agent tools, and the playground and tests that dry-run them.
   Every other feature keeps calling `complete()` with no tools;
   `assertToolPolicy` replaces `assertNoTools` and enforces the list.
2. Reads run; changes are proposals. A change never executes inside a model
   turn. Helpdock, not the model, computes the preview, fixes the targets by
   id (at most 50), and shows every argument that leaves the install.
3. Only the person who asked approves, with a token the model never sees,
   within 15 minutes. In the widget, only the visitor of the conversation
   confirms, and by default only a visitor whose identity the brand's site
   signed.
4. Approved changes are executed by an outbox job through the same domain
   services as the UI, as the approver, idempotently, re-checking permission
   and preconditions; activity is `via: ai` "on behalf of" the approver.
5. Tool output is data: screened, truncated, delimited; it can never approve
   or widen anything. Redaction covers arguments and output, with
   placeholders restored only at execution.
6. Tools come from MCP servers (the brand's or a vendor's) and from
   Helpdock's own registry; no model gets a tool its user's role could not
   use.

## Consequences

- AGENTS.md, REQUIREMENTS §4.7, PRD principle 3 and the pentest scope change.
- Tool use needs a model that supports it; a brand on a model without tool
  calling keeps every 1.0 feature and gets a clear refusal (`tools-unsupported`)
  for the rest.
- Every proposal is a click; there is no standing approval, by design.
- The eval gains tool-use items with zero-tolerance measures: changes executed
  without approval, injected instructions followed, `ask_visitor` tools offered
  to unverified visitors, and staff runs touching a ticket outside the user's
  scope must all be 0.

## Alternatives considered

- **Keep the rule and expose only Helpdock as an MCP server**: safe, but leaves
  the assistant unable to help with work.
- **Let reads and writes run, with an undo instead of an approval**: undo does
  not unsend an email or a refund.
- **Per-session or per-tool standing approvals**: approval fatigue becomes
  silent automation; can come later with evidence.
