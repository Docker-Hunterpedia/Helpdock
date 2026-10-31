# M12 AI workspace

Status: planned (not started)
Owner: @Docker-Hunterpedia
Phase: 5 — 1.x. Proposed release: 1.1 (owner decision D-01)
Depends on: M7 (shipped), M3 (rules), M4 (widget), M8 (reports, API keys)
Effort: about 72 working days for one person (see [Deliverables](#deliverables))
PRD: [Phase 5 · M12](../planning/PRD.md#m12-ai-workspace)
Owner decisions: D-04 to D-10 in [decisions-1-x.md](../planning/decisions-1-x.md#m12-ai-workspace)
ADRs (proposed): [0028](../decisions/0028-ai-workspace-runs-the-production-path-dry.md), [0029](../decisions/0029-staff-assistant-reads-through-validated-read-plans.md), [0030](../decisions/0030-ai-decisions-in-automation-are-confidence-gated.md), [0031](../decisions/0031-personas-change-the-voice-never-the-rules.md)

Tools for the people who run a brand's assistant to try it, test it, review it, cost it and give it a voice, plus a read-only staff assistant, all inside the 1.0 rule that the model reads knowledge and writes text.

**Prior art.** Other support tools, OpenDesk (Apache-2.0) among them, ship an
admin playground, saved tests, a review queue that turns a bad answer into a
Q&A snippet, bot personas, cost shown beside each toggle, confidence-gated
triage, an LLM yes/no rule condition and a staff assistant. This plan builds
each of those on Helpdock's rules: brand-scoped tables under `FORCE`d row-level
security, Zod at every boundary, every side effect through the outbox, PII
redaction before every model call, every call logged with its cost, every
outbound URL through `safeFetch`, design first, `en` and `ar`. Visitor-facing
change tools default to signed-identity visitors only (M13), and persona
avatars are uploaded images, never emoji.

**Two milestones, one boundary.** M12 stays inside today's rule "No tool calls
or actions in v1. The model reads knowledge and writes text" (AGENTS.md,
REQUIREMENTS §4.7). Everything in it either produces text, produces a decision
that Helpdock's own code applies under a rule an admin wrote (as M7-07 triage
already does), or reads under the asking user's own row-level security.
[M13](M13-ai-actions-and-integrations.md) lifts the rule, deliberately and with
a written contract: an ADR, a new DOMAIN-RULES section, and an extension of the
quality gate. M12 can ship and be used by teams that never want M13.

**Effort.** Working days for one experienced contributor, Definition of done
included (unit, integration, Playwright in `en` and `ar`, docs), as M11 counted
it. Recent milestones were built far faster with AI coding agents (M7: 2 days
against 7–9 weeks); review, the owner's verification and live-provider runs do
not shrink the same way, so these figures are the planning number, not a
forecast.

DOMAIN-RULES section numbers below (§17, §18) are provisional; each is fixed
in the pull request that lands the rule.

---

## What exists today (M7) and what this plan changes

Read before planning, so nothing is built twice.

| Area | Shipped in M7 (1.0) | This plan |
|---|---|---|
| Budget | Daily and monthly USD limits per brand in `ai_settings`; spend summed from `ai_calls`; at 80 % an `ai_budget_alerts` row and an `ai.budget_alert` outbox event whose handler writes an audit row; at 100 % `complete()` throws `BudgetExceededError`, auto-reply goes silent, assist may continue ("keep assist after the hard stop"). The alert reaches only the audit log and the settings response (M7 gap). | **Extend, not duplicate** (M12-09): staff notifications at 80 % and 100 % (closes the M7 gap), a quiet handoff line for conversations the assistant is already in, a headroom check on the estimated cost before a call, cap presets in the UI. No second budget. |
| Cost | `ai_calls.cost_usd` from pi-ai's registry price; Reports' AI cost; System page spend. | Estimates before a call, per feature (M12-08); usage by feature, day, staff member and model (M12-08, adds `ai_calls.actor_user_id`). |
| System prompt | Per brand, `system_prompt` and `system_prompt_ar`, 8000 chars, Team Leaders may edit. | Becomes **Instructions** under a Writing card with tone and reply language (M12-02). Same columns; no second prompt. |
| Handoff message | Per brand in `ai_settings.modes.handoffMessage.{en,ar}`. | Moves to the brand's default persona (M12-03), migrated in place. |
| Triage | Rule action `ai_triage` `{ mode: suggest \| apply, fields: tags \| priority \| department }`; suggestions in `ticket_field_suggestions` drawn by the SuggestedFields card with accept and dismiss. | Adds mode `auto` with per-field confidence and a threshold, raise-only priority, add-only tags, guarded department moves, a brand-wide "triage new tickets" switch, confidence in the timeline (M12-10). Reuses the card and the job. |
| Feedback | Widget "Was this helpful?" stored in the AI message's `ai_meta.feedback`. | Feeds the Needs review queue (M12-06). |
| Summaries | Assist "Summarize ticket", on demand, not stored. | Stored, kept fresh in the background (M12-12). |
| Eval | The eval set in `packages/ai/eval/`, the harness and judge in `packages/ai/src/eval/`, nightly CI, release gate DOMAIN-RULES §9. | Brand-level saved tests in the admin (M12-05) reuse its judge; the CI set grows new categories (M12-14, M13-12). The CI gate stays the release gate. |
| No tools | `complete()` never sends tools; `assertNoTools` checks it. | Unchanged in M12. Replaced by `assertToolPolicy` in M13 (M13-01). |

---

## Goal

Give the people who run a brand's assistant the tools to make it good and keep
it good, without reading logs or waiting for the nightly eval: try it before a
customer does, save what it must get right and re-check it after every change,
see what it got wrong and fix it in one step, know what it costs before and
after, set its voice and its limits, and let it sort and summarise tickets with
its confidence shown. Give staff an assistant that answers questions about the
queue. All of it inside the v1 rule: the model reads and writes text; it never
calls a tool.

## Scope

1. **Playground.** Chat with the brand's auto-reply as a visitor would, on a
   chosen channel, language and persona, with unsaved settings overlaid. It runs
   the production generation path (`generateAutoReply`, as the eval harness
   does) and shows the answer, its citations, the confidence against the
   threshold, what the assistant decided (answer, hand off, decline) and what it
   cost. Nothing is written to a ticket and nothing reaches the outbox.
2. **Saved tests.** A test is one to six messages and one to ten expectations
   (mentions, does not mention, hands off, does not hand off, cites a given
   source, cites anything, answers in a language, declines). **Run all** runs
   them as a job; results show pass, fail or error with the reason and what
   changed since the last run. Saving Instructions, Writing, Guardrails or a
   persona offers **Run tests with these changes first**.
3. **Needs review and Improve answer.** A queue of the assistant's answers
   rated unhelpful, its handoffs, and the questions it could not answer, from
   the last 30 days, scoped by the reviewer's departments. **Improve answer**
   writes the better answer as a brand **Q&A snippet**, a new knowledge source
   kind, used by the next answer; optionally saved as a test too.
4. **Overview.** A readiness checklist that ticks itself and date-ranged
   figures: conversations the assistant took part in, answered without a person
   (DOMAIN-RULES §15 deflection), handed off by reason, could not answer,
   ratings, spend, by day; the top unanswered questions.
5. **Cost transparency.** An estimate per action next to each toggle ("about
   $0.0011 a reply"), from the configured model's price and the brand's own
   token history; a Usage tab by feature, day, staff member and model with a
   CSV; owner notifications, a quiet handoff and a headroom check on the
   existing budget, plus notifications when the provider fails and when the
   assistant hands a conversation over.
6. **Guardrails.** Topics to decline (up to 20), a maximum number of assistant
   replies per conversation before it hands off, and ask for an email before
   handing off in the widget.
7. **Writing.** Tone (friendly, professional, concise, custom), reply length
   (short, medium, detailed), reply language
   (the customer's, or the brand's default), and Instructions (today's system
   prompt, English and Arabic).
8. **Personas.** Up to 10 per brand: name, an uploaded avatar, tone, greeting,
   handoff line and decline line, in `en` and `ar`; one is the brand default;
   each widget, mailbox and Telegram bot may name its own. A persona changes the
   voice only, never the rules, the guardrails or the knowledge. Every answer
   still carries the AI badge in words.
9. **Confidence-gated triage.** Each field the assistant decides comes with its
   confidence. At or above the brand's threshold it is applied; below, it waits
   on the ticket as a suggestion with **Apply** and **Skip**. Triage only raises
   priority, only adds tags, and moves a department only while no person has
   moved it. Every change is in the timeline as "by the assistant" with how
   sure it was.
10. **An AI yes/no rule condition.** "Ask the assistant: *Is the customer
    asking to cancel?* — probability above 70 %". Up to 3 per rule, every
    question of one event's rule run in one redacted, logged, budgeted call,
    answers cached per ticket until the conversation changes. Event rules only.
11. **Ticket summaries that stay current.** On tickets with at least N messages
    (default 5), a summary in the details panel, refreshed in the background a
    short while after the conversation changes; **Refresh** by hand.
12. **A staff assistant panel, read-only.** Opened with mod+J, aware of the page
    and ticket in view. It answers questions about the queue, finds tickets,
    explains a ticket, pulls report figures the user may read, and links what it
    cites. It changes nothing. It reads through a validated read plan executed
    under the user's own permissions, not through tool calls (ADR 0029).
13. **Draft articles from solved tickets.** One draft from several closed
    tickets on one topic, from public messages and public knowledge, into the
    existing Proposals approval.

## Non-goals

- Anything that changes data on the model's initiative, outside a rule an admin
  wrote: that is M13.
- Tool calls of any kind, MCP, integrations, the product as an MCP server: M13.
- AI auto-reply on WhatsApp, Messenger or Instagram (REQUIREMENTS §4.4 keeps it
  in the backlog). Personas are not assignable to Meta accounts.
- A face builder, emoji faces or animated avatars (DESIGN.md §5: no emoji
  anywhere; DESIGN §1: no decoration that carries no information). A persona's
  avatar is an uploaded image or the default Sparkles tile.
- Hiding that an answer is from AI. A persona name never replaces the AI badge.
- Streaming answers (an M7 gap); the playground and the panel answer whole.
- A second budget or a metered "AI balance". The brand budget is the only cap.
- Per-brand embedding models (ADR 0005 holds).
- Calibrated confidence from a third-party decision model. Confidence is the
  model's own estimate; the eval measures how well it is calibrated.
- AI questions in time-based rules (cost would scale with every matching ticket
  on every tick); a gap, not a promise.
- AI of its own in the command palette (M14-05). The one hook is M12-13's: Tab
  in the palette hands the typed text to this read-only panel (D-03).

## Deliverables

| Id | Deliverable | Spec | Effort (d) | Depends on |
|---|---|---|---|---|
| M12-01 | **Schema, settings and permissions.** Tables `ai_personas`, `ai_persona_assignments`, `ai_test_cases`, `ai_test_runs`, `ai_test_results`, `knowledge_snippets`, `ai_review_items`, `ticket_summaries`, `ai_rule_answers`, `assistant_threads`, `assistant_turns` (below), each in `TENANT_TABLES` with `FORCE`d RLS and an isolation fixture; `knowledge_source_kind` gains `snippet`; `ai_settings` gains `writing`, `guardrails`, `triage`, `summaries` (jsonb, Zod-parsed); `ai_calls` gains `actor_user_id`; `tickets` gains `department_changed_by_staff_at` (set when a person moves the department); `notifications.ticket_id` becomes nullable with a kind check; the `ai.workspace` feature names; no new permission (M12 uses `ai:manage`, `brand:manage`, `ticket:read`, `report:read`). | A §5; D §1.6 | 3 | — |
| M12-02 | **Writing and guardrails.** The Writing card (tone preset or custom text up to 300 chars, reply length `short` \| `medium` \| `detailed`, reply language `customer` \| `brand`, Instructions = the existing prompts) and the Guardrails card (topics to decline, max replies per conversation 1–50 default 20, ask for email before handoff). Prompt assembly order fixed and documented. Auto-reply learns `DECLINE <n>`: Helpdock sends the persona's decline line, does not pause, and logs `declined`. The reply cap hands off with reason `reply_limit`. In the widget, a handoff with no email on the conversation shows an email field in the handoff line; the address is stored unverified (D §4.1). This also covers the handoff email ask in [UX-15](../completed/ux-review-1-0.md#findings). Reply length was added after the prior-art sweep of 2026-10-20 (+0.5 d). | R §4.7; D §9, §17.2 | 4.5 | M12-01 |
| M12-03 | **Personas.** CRUD (`ai:manage`), up to 10 per brand, one default; avatar upload through the media pipeline (magic bytes, sharp re-encode to 256 px WebP, EXIF stripped) into the public prefix; assignment to the brand default, the widget, each mailbox and each Telegram bot; the handoff message migrated from `modes` into the default persona. Auto-reply picks the persona from the channel; the widget config carries name, avatar URL, greeting and handoff line; email AI replies sign with the persona name; Telegram uses its tone and lines (the bot's name stays Telegram's). Assignment is keyed by widget id: today a brand has one widget (`widget_settings` by brand); once [M19-02](M19-customer-surfaces-polish.md) allows several widgets per brand, each picks its persona. | R §4.6, §4.7; DESIGN §6.6 | 5 | M12-01, M12-02 |
| M12-04 | **Playground.** `POST …/ai/playground` with `@StepTransactions()`: the conversation so far, channel, locale, persona, a visitor card (name, email; the "signed identity" switch arrives with M13-08), and a drafts overlay (Writing, Guardrails, Instructions, persona fields, threshold, and **another model** from the install's discovered models, so an Admin can compare before switching). Runs `generateAutoReply` with `audience: 'visitor'` and returns answer, citations (Public/Internal), confidence and threshold, decision and reason, persona, model, cost and the call id. Writes nothing but `ai_calls` rows (`feature: playground.reply`, no ticket, `actor_user_id` set). 30 requests per user per minute. **Start over**; "Save as test" from any exchange. Screen AI › Playground. Covers the playground half of [UX-28](../completed/ux-review-1-0.md#findings). | ADR 0028 | 4 | M12-02, M12-03 |
| M12-05 | **Saved tests.** CRUD (`ai:manage`; 200 per brand), the expectation kinds of [§17.5](#domain-rules-to-add-or-change), `POST …/ai/test-runs` (all or a list, optional drafts overlay) as an `ai.test_run` job on the `ai` queue through the outbox, 3 tests at a time, 2 minutes each, 20 runs per brand per hour; mechanical checks from the decision; `mentions` and `not_mentions` graded together by the eval judge (`packages/ai/src/eval/judge.ts`) in one call per test; results with the previous status; cancel. "Run tests with these changes first" on every save that changes the answer. Screen AI › Tests. | ADR 0028; D §9 | 6 | M12-04 |
| M12-06 | **Needs review, Improve answer, Q&A snippets.** `ai_review_items` written in the same transaction as the event that causes it (a thumbs-down, a handoff with reason `low_confidence`, `invalid_citation`, `no_answer` or `reply_limit`; never `customer_request`), department-scoped like its ticket. List (30 days, keyset), dismiss, improve. Improve writes a `knowledge_snippets` row and its document and chunk in the brand's snippet source, screened by the injection filter, full-text searchable at once, embedded by `knowledge.embed` within a minute; visibility chosen (default public); optionally a test. Snippet management under AI › Knowledge › Snippets. Snippet citations: title = the question, no link, in the widget's CitationList. | D §5, §17.4 | 5 | M12-01, M12-05 |
| M12-07 | **Overview.** AI › Overview: the readiness checklist (computed on read: provider and model, knowledge with something public and ready, a persona named, the playground tried, at least one test and its last run green, auto-reply on for a channel, the widget seen) and figures for a date range from `tickets.ai_*`, `ai_review_items`, `ai_calls` and `ai_meta.feedback`, with a by-day chart and the 20 latest unanswered questions the reader may see. | D §15 | 3 | M12-06 |
| M12-08 | **Cost estimates and usage.** `estimateCost(brand, feature)` in `@helpdock/ai`: the model's registry price × the brand's median tokens for that feature over 30 days, else a fixed profile per feature; `null` when the price is unknown, `0` for a model with no price (a local server), and an optional per-model price override setting for self-hosted models. Estimates shown next to every AI toggle and in the playground. Usage tab: spend and calls by feature, day, staff member and model, range up to 400 days, CSV; `ai_calls.actor_user_id` filled by assist, playground, tests, the panel and rule test runs. Covers the cost half of [UX-28](../completed/ux-review-1-0.md#findings). | ADR 0018 | 4 | M12-01 |
| M12-09 | **Budget, extended, and AI notifications.** Notifications of kind `ai_budget` (no ticket) at 80 % and 100 % of either window to the brand's Admins, in-app and by email, once per window, through the existing `ai.budget_alert` outbox event; kind `ai_provider` (no ticket) to install admins and the brand's Admins when the brand's provider refuses its key, is out of quota, or fails 5 calls in a row within 10 minutes (once per hour per provider, from `ai_calls` status `error` with a classified reason); kind `ai_handoff` (ticket-shaped, the existing model) to the assignee, else the ticket's team, else the department's agents, when the assistant hands a conversation over. All three are rows in the per-user preference matrix (M3-07) and go through the outbox; once [M14-10 and M14-11](../completed/M14-inbox-productivity.md) add paced email, digests and pausing, they follow those rules. A bell entry and an email template for the two non-ticket kinds. At the hard stop, a conversation the assistant has already answered gets the persona's handoff line with no model call and is paused with reason `budget`. A headroom check refuses a call whose estimate would take spend past the limit. Presets in the Budget card (no limit, $5, $20, $50, $100, custom). | R §4.7; D §17.3 | 5 | M12-03, M12-08 |
| M12-10 | **Confidence-gated triage.** `ai_triage` gains mode `auto` with a threshold (0.5–0.99, default the brand's, 0.7); the classifier answers a confidence per field; apply at or above, suggest below. Raise-only priority, add-only tags, department only while `department_changed_by_staff_at` is null. AI › Triage card: "Triage new tickets" (the same job on `ticket.created`, no rule needed), which fields, the threshold. SuggestedFields shows each suggestion's confidence with **Apply** and **Skip**; activity rows via `ai` with actor "the assistant", the rule if any, and the confidence. | R §4.7; D §18.1; ADR 0030 | 5 | M12-01 |
| M12-11 | **AI yes/no rule condition.** Condition field `ai_question` `{ question (3–300 chars), op: above \| below, threshold 0.01–0.99 }`, at most 3 per rule, event rules only (the schema refuses it in time-based rules). Two-phase evaluation in `rules.evaluate`: other conditions first; questions collected only from rules still matching; one `complete()` outside any transaction (`feature: rules.ai_question`, the ticket, redacted, logged, budgeted); answers cached in `ai_rule_answers` by question hash and the ticket's latest message seq; a refused or failed call makes the condition false and says so in the run log. Builder row and TestRunPanel with the estimate ("asks the model, about $0.0004"). | R §4.3; D §18.2; ADR 0030 | 5 | M12-08 |
| M12-12 | **Ticket summaries.** AI › Assistant switch "Keep ticket summaries up to date" with the minimum message count; on `ticket.created`/`ticket.replied` the subscriber marks the summary stale and schedules `ai.summary_refresh` (delayed 2 minutes, job id per ticket and message seq so a burst collapses to one); written in the brand's default staff language; Summary card in the DetailsPanel with "updated 3 min ago", **Refresh**, and Translate. Automation, so the hard stop applies. | R §4.7 | 3 | M12-01 |
| M12-13 | **Staff assistant panel (read-only).** Panel opened from the top bar or mod+J, Esc closes; threads private to their author (`OWNER_SCOPED_TABLES`). A turn: (1) `complete()` returns a **read plan**, JSON validated by Zod against a closed list of reads; (2) Helpdock runs the reads under the user's own tenant context (department RLS, permission checks per read: `report:read` for figures, `ticket:read` for tickets, staff audience for knowledge); (3) `complete()` answers over what was read, citing tickets as `#HD-1042` links and articles. Context: the page, the ticket or view in view. Reads: tickets by filters and text (≤ 50), one ticket's thread and fields, the ticket's summary, SLA due within N hours, unassigned older than N, team workload, knowledge (staff audience), report figures. Copy says what it can do: "I can read your queue, explain a ticket and pull numbers. I change nothing." Suggested prompts on an empty thread, chosen by page and role: "What needs attention now?", "What's waiting on me?", "Which tickets breach SLA in the next hour?", "Explain this ticket" (on a ticket), "How did we do this week?" (`report:read` only). History, new chat, expand. Once the command palette ([M14-05](../completed/M14-inbox-productivity.md)) lands, **Tab in the palette sends the typed text to the panel** as a new question: a hook of one function, built by whichever lands second (D-03). 20 messages per user per minute; budget as assist. | ADR 0029; D §17.6 | 8 | M12-08, M12-12 |
| M12-16 | **Draft articles from solved tickets.** Extends M7-05's one-ticket draft: on Help center › Proposals and from the Overview's unanswered questions, "Draft from tickets" takes a topic (typed, or one unanswered question) and up to 10 closed tickets the assistant found for it by full text over subjects and first messages, writes one draft from their **public** messages and **public** knowledge only, and files it as an article proposal for a Team Leader to approve, listing the source tickets. Each source ticket is read under the requester's RLS. Logged as `assist.draft_article_multi`. | R §4.5, §4.7 | 3 | M12-07 |
| M12-14 | **Eval extension.** New categories in `packages/ai/eval/`: declined topics, reply limit, persona (the same answerable items with a persona; grounding thresholds hold), triage (a labelled set of 40 tickets per language; field accuracy and precision above the threshold), AI questions (40 yes/no items per language), panel reads (questions over a seeded queue; every cited ticket is in scope). Thresholds in the [§9 additions](#domain-rules-to-add-or-change). Mock mode in CI, live nightly. | D §9 | 4 | M12-02, M12-10, M12-11, M12-13 |
| M12-17 | **More assist rewrites and draft with instructions.** Agent assist's Rewrite (M7-05: friendlier, more formal, shorter) gains **longer**, **fix spelling and grammar** and **simpler**, each with its cost estimate (M12-08); and **Draft with instructions**: the agent types a one-line instruction ("apologise and offer a refund") and Suggest reply drafts with it, grounded and cited as today. Same `assist.rewrite` and `assist.suggest_reply` features, same redaction and budget, never sent without the agent. Found in the prior-art sweep of 2026-10-20 ([decisions-1-x.md](../planning/decisions-1-x.md#prior-art-gap-check)). | R §4.7 | 1.5 | M12-08 |
| M12-15 | **Docs.** `docs/guides/ai.md` (Playground, Tests, Review, Overview, Usage, Writing, Guardrails, Personas, Summaries, the assistant panel, cost), `automation.md` (confidence-gated triage, AI questions), `reports.md`, `widget-protocol.md` (persona, email before handoff, snippet citations, decline), `notifications.md`, `data-retention.md`, `configuration.md` (price override), `.env.example`, OpenAPI; ADRs 0028–0031; PRD, REQUIREMENTS, DOMAIN-RULES, DESIGN §6 components; this milestone doc. | AGENTS.md DoD 1 | 2.5 | all |

**Total: about 72 working days** for one person (70 for the draft's deliverables, 2 for the prior-art additions to M12-02 and M12-17). Three tracks can run in
parallel after M12-01: (a) playground, tests, review, overview, drafts from
tickets (M12-04 to M12-07, M12-16), (b) writing, personas, cost, budget
(M12-02, M12-03, M12-08, M12-09), (c) triage, rule questions, summaries, panel
(M12-10 to M12-13). With two people, about 7–8 weeks of calendar time.

## Data model

Every table below is a tenant table: `brand_id uuid not null`, the brand
policy, `ENABLE` and `FORCE ROW LEVEL SECURITY`, an entry in `TENANT_TABLES`,
`pnpm --filter @helpdock/db gen:rls`, and a fixture in
`packages/db/src/rls.integration.test.ts`. Department-scoped tables carry a
denormalised `department_id` kept by the shared insert trigger and the
follow-on-move trigger M7 gave `ticket_field_suggestions`. One migration,
numbered with the next free number at implementation time (`0054_imports` is
the last shipped).

```
ai_personas                         brand-scoped
  id uuid pk (v7), brand_id
  name varchar(60) not null                    -- shown to customers next to the AI badge
  avatar_key text null                         -- public prefix object, 256 px WebP; null = Sparkles tile
  tone text not null default 'friendly'        -- friendly | professional | concise | custom
  tone_custom varchar(300) null
  greeting_en, greeting_ar varchar(300) null   -- widget only; null = no greeting
  handoff_en, handoff_ar varchar(500) null     -- null = built-in wording (M7-06)
  decline_en, decline_ar varchar(500) null     -- null = built-in wording
  is_default boolean not null default false    -- partial unique index (brand_id) where is_default
  position int not null
  created_by uuid, created_at, updated_at
  unique (brand_id, lower(name))

ai_persona_assignments              brand-scoped
  brand_id, persona_id fk on delete restrict   -- a persona in use cannot be deleted
  channel_kind text not null                   -- widget | mailbox | telegram_bot
  channel_id uuid not null                     -- widget_settings.brand_id, mailboxes.id, telegram_bots.id
  primary key (brand_id, channel_kind, channel_id)

ai_settings  (+ columns, each Zod-parsed, null = defaults)
  writing jsonb       -- { tone, toneCustom, replyLanguage: customer|brand }
  guardrails jsonb    -- { declinedTopics: string[≤20, 2..100], maxReplies: 1..50, askEmailBeforeHandoff: bool }
  triage jsonb        -- { onCreate: bool, fields: (tags|priority|department)[], threshold: 0.5..0.99 }
  summaries jsonb     -- { enabled: bool, minMessages: 3..50 }

ai_calls  (+ column)
  actor_user_id uuid null fk users on delete set null   -- the staff member who asked; null for automation

tickets  (+ column)
  department_changed_by_staff_at timestamptz null       -- set when a person moves the department; guards triage

ai_test_cases                       brand-scoped
  id, brand_id, name varchar(100)
  channel text not null                        -- widget | email | telegram
  locale text not null                         -- en | ar
  persona_id uuid null fk ai_personas on delete set null
  messages jsonb not null                      -- 1..6 { role: visitor|assistant, text ≤ 4000 }, last is visitor
  expectations jsonb not null                  -- 1..10, see D §17.5
  visitor jsonb null                           -- M13: { verified, externalId?, email?, name? }
  created_by, created_at, updated_at

ai_test_runs                        brand-scoped
  id, brand_id, status text                    -- queued | running | passed | failed | cancelled | error
  test_ids uuid[] not null, drafts jsonb null  -- the overlay; never a secret
  started_by uuid, totals jsonb, cost_usd numeric(14,6), started_at, finished_at

ai_test_results                     brand-scoped
  run_id fk on delete cascade, test_id fk on delete cascade, brand_id
  status text                                  -- pending | passed | failed | error
  decision text, confidence numeric, answer text, citations jsonb, checks jsonb, error text,
  cost_usd numeric(14,6), call_ids uuid[], previous_status text null
  primary key (run_id, test_id)

knowledge_snippets                  brand-scoped
  id, brand_id, source_id fk knowledge_sources  -- the brand's one `snippet` source (partial unique index)
  question varchar(500) not null, answer text not null (≤ 2000)
  locale text not null, visibility knowledge_visibility not null default 'public'
  from_message_id uuid null                    -- the AI answer it improved
  created_by, updated_by, created_at, updated_at
  -- each row is one knowledge_documents row `<snippetId>`; its chunks carry meta.snippetId

ai_review_items                     department-scoped (child of a ticket)
  id, brand_id, department_id, ticket_id fk on delete cascade, message_id uuid null
  reason text not null                         -- rated_down | low_confidence | invalid_citation | no_answer | reply_limit
  question text not null                       -- the customer's message, first 500 chars
  answer text null                             -- the assistant's reply, first 1000 chars
  status text not null default 'open'          -- open | dismissed | improved
  decided_by uuid null, decided_at, snippet_id uuid null, created_at
  unique (message_id, reason)

ticket_summaries                    department-scoped
  ticket_id pk fk on delete cascade, brand_id, department_id
  locale text, points jsonb (2..6 strings), through_seq int, call_id uuid,
  stale boolean not null default false, generated_at

ai_rule_answers                     department-scoped (cache)
  brand_id, department_id, ticket_id fk on delete cascade
  question_hash text, through_seq int, probability numeric(4,3), call_id uuid, created_at
  primary key (ticket_id, question_hash, through_seq)

assistant_threads                   brand-scoped, OWNER_SCOPED (user_id)
  id, brand_id, user_id fk users on delete cascade, title varchar(120), created_at, updated_at

assistant_turns                     brand-scoped, OWNER_SCOPED (user_id)
  id, brand_id, thread_id fk on delete cascade, user_id
  role text (user | assistant), text text, context jsonb, plan jsonb null,
  refs jsonb (tickets, articles cited), call_ids uuid[], created_at

notifications  (changed)
  ticket_id becomes nullable; check (ticket_id is not null or kind in ('ai_budget', 'ai_provider'))
```

`assistant_threads` and `assistant_turns` join `OWNER_SCOPED_TABLES` without
`systemWrites`: no one else reads a person's conversation with the assistant,
an Admin included, as with personal views. Retention: `maintenance.retention`
deletes turns older than the brand's AI-log window (D §11), and the panel says
so.

Tables M12 does **not** add: a review queue computed on read (it would scan
`ticket_messages.ai_meta` across a brand under RLS on every load), a separate
"AI balance", a per-feature budget.

## API

Brand routes under `/api/brands/:brandId`. Every route declares `@Requires`,
validates with Zod and serialises through an output schema. Routes that call a
model declare `@StepTransactions()` (ADR 0024). Refusals carry `error.ai.reason`.

| Method | Path | Permission | |
|---|---|---|---|
| GET/PUT | `…/ai/writing` | `ai:manage` | Tone, reply language; the prompts stay on `PUT …/ai/prompt` |
| GET/PUT | `…/ai/guardrails` | read `ai:manage`, write `brand:manage` | Topics, reply cap, ask for email |
| GET/POST | `…/ai/personas` | `ai:manage` | List, create (409 `persona-limit`) |
| GET/PATCH/DELETE | `…/ai/personas/:id` | `ai:manage` | 409 `persona-in-use`, `persona-default` |
| POST | `…/ai/personas/:id/avatar` | `ai:manage` | Presign; `…/avatar/confirm` runs the pipeline |
| PUT | `…/ai/persona-assignments` | `brand:manage` | The whole list, replaced |
| POST | `…/ai/playground` | `ai:manage` | 429 `rate-limited`; refusals as auto-reply's |
| GET/POST | `…/ai/tests` | `ai:manage` | 409 `test-limit` |
| GET/PATCH/DELETE | `…/ai/tests/:id` | `ai:manage` | |
| POST | `…/ai/test-runs` | `ai:manage` | `{ testIds?, drafts? }` → 202; 409 `no-tests`, 429 `run-limit` |
| GET | `…/ai/test-runs`, `…/ai/test-runs/:id` | `ai:manage` | The 20 latest; one with results |
| POST | `…/ai/test-runs/:id/cancel` | `ai:manage` | |
| GET | `…/ai/review?reason=&cursor=` | `ai:manage` | Under the reader's department RLS |
| POST | `…/ai/review/:id/dismiss` | `ai:manage` | |
| POST | `…/ai/review/:id/improve` | `ai:manage` | `{ question, answer, locale, visibility, saveTest }` → snippet (+ test) |
| GET/POST | `…/knowledge/snippets` | `ai:manage` | |
| PATCH/DELETE | `…/knowledge/snippets/:id` | `ai:manage` | |
| GET | `…/ai/overview?from=&to=` | `ai:manage` | Checklist and figures |
| GET | `…/ai/estimates` | `ai:manage` | Per feature: estimate, basis (`history` \| `profile`), price source |
| GET | `…/ai/usage?from=&to=&by=feature\|day\|member\|model` | `ai:manage` | `…/usage.csv` too |
| GET/PUT | `…/ai/triage` | read `ai:manage`, write `brand:manage` | |
| GET | `…/tickets/:ticketId/summary` | `ticket:read` | Under the ticket's department policy |
| POST | `…/tickets/:ticketId/summary/refresh` | `ticket:write` | Enqueues through the outbox; 202 |
| GET/POST | `…/assistant/threads` | any staff role | Own threads only (RLS owner policy) |
| GET/PATCH/DELETE | `…/assistant/threads/:id` | any staff role | |
| POST | `…/assistant/threads/:id/messages` | any staff role | `{ text ≤ 4000, context? }`; 429; 409 `assistant-busy` |
| GET/PUT | `/api/install/ai/prices` | install admin | Per-model price override for models the registry does not price |

Widget protocol additions: `config.assistant.persona { name, avatarUrl, greeting }`,
`message.ai.persona`, `message.ai.decision: 'declined'`, citation `kind: 'snippet'`
with no URL, and `POST /widget/conversations/:id/handoff-email { email }`
(visitor auth; stored unverified). Each documented in `widget-protocol.md`.

## Domain rules to add or change

Proposed; each lands in DOMAIN-RULES with the deliverable that implements it,
not now. New section **§17 The AI workspace** and additions to §5, §9, §11 and
§15. New section **§18 AI decisions in automation**. Section numbers are
provisional.

**§17.1 What a persona may change.** A persona sets the name and avatar the
customer sees, the tone, the greeting, and the handoff and decline lines. It
never changes the knowledge, the audience, the threshold, the guardrails, the
budget or the channel's mode. Every message it sends carries the AI badge in
words; no setting hides it. A sent message keeps the persona it was sent as.
Persona avatars are public objects in the public prefix beside help center
images (§4.5 amended), and nothing else of a persona is secret.

**§17.2 Prompt assembly.** Auto-reply sends, in order: the auto-reply rules
(Helpdock's, fixed), the guardrails (declined topics as a numbered list, the
reply language rule), the persona's tone, the brand's Instructions (the Arabic
ones for an Arabic message when written), then the numbered sources and the
conversation as data blocks. The brand's text never comes before Helpdock's
rules, so Instructions cannot switch a rule off. Everything goes through
`complete()`: redacted, budgeted, logged, no tools.

**§17.3 Guardrails at reply time.**
1. *Declined topic*: the model answers `DECLINE <n>`; Helpdock sends the
   persona's decline line in the conversation's language, logs the call as
   `declined`, does not pause, and does not count it as an answer for
   deflection.
2. *Reply cap*: before generating, a conversation with `maxReplies` assistant
   answers hands off with reason `reply_limit` and no model call.
3. *Email before handoff* (widget only): when a handoff happens and the
   conversation has no email, the handoff line asks for one; the address is
   stored unverified (§4.1) and grants nothing.
4. *Hard stop with a conversation in progress*: if the assistant has already
   answered in it (`ai_answered_at` set), the handoff line is sent with no model
   call and the conversation pauses with reason `budget`; otherwise the job ends
   silently as in M7.
5. *Headroom*: a call whose estimated cost would take the window's spend past
   its limit is refused as `budget-exceeded` before it is sent.

**§17.4 Snippets.** A snippet is a knowledge document of the brand's `snippet`
source: one per brand, created on first use, never deletable. Its visibility
follows §5: an internal snippet never reaches a visitor-facing answer. It is
screened by the injection filter like any chunk. Its chunk is written in the
request's transaction (full text at once), and embedded by `knowledge.embed`.
Cited to a visitor, it is listed by its question with no link.

**§17.5 Tests.** Expectation kinds: `mentions` (value ≤ 1000), `not_mentions`,
`hands_off`, `no_hand_off`, `cites_source` (a knowledge source or article id),
`cites_any`, `language` (`en` \| `ar`), `declines`. A test may not hold both
`hands_off` and `no_hand_off`. A run answers each test through the playground
engine with the saved settings plus the run's drafts, no ticket, nothing
written but `ai_calls` (feature `tests.reply`, `tests.grade`) and the results.
A test passes when every check passes; it errors when it could not be answered
or graded (budget, provider). Test runs count toward the brand budget and are
refused at the hard stop.

**§17.6 The staff panel reads as the user.** A read plan is data: a list of
reads from a closed set, each with Zod-validated arguments. Helpdock runs each
read in a transaction carrying the asking user's own `app.*` settings, checks
the read's permission first, and drops a read the user may not make (the answer
says it could not look). The model never names a table, a SQL fragment or a
URL, and never receives a row the user could not open in the admin. The panel
writes nothing but its own turns and `ai_calls`. Ticket text read for the panel
is redacted before it reaches the model, as everywhere.

**§18.1 Confidence-gated triage.** Each field the classifier decides has a
confidence 0–1, the model's own estimate. Mode `auto` applies a field at or
above the threshold and stores it as a suggestion below. Whatever the mode:
priority only rises; tags are only added; a department moves only while no
staff member has changed it on this ticket; spam is never applied. An applied
change is an activity row with `via: ai`, actor "the assistant", the rule id
when a rule asked, and the confidence; it can be undone like any change.
Setting the field by hand clears its suggestion.

**§18.2 AI questions in rules.** A rule holds at most 3 `ai_question`
conditions; event rules only. In one event's run, questions are asked only for
rules whose other conditions already hold, all of them in one call. An answer
is cached per ticket, question and latest message seq; a later event with no
new message reuses it. A refused or failed call makes the condition false and
is recorded in the run log, never retried within the run. The depth guard and
cycle detection of M3-03 are unchanged. The rule test run asks the model too,
logs the call as `rules.test`, and shows the estimate before it runs.

**§5 addition.** Snippets are a knowledge source like any other; §17.4.

**§9 additions.** Eval categories and thresholds per language, gating the
release that ships M12:

| Measure | Threshold |
|---|---|
| Declined-topic items declined | ≥ 95 % |
| Answerable items answered correctly with a persona set | ≥ 85 % (same as without) |
| Triage fields applied in `auto` that are correct | ≥ 90 % precision at the default threshold |
| AI-question items answered correctly at threshold 0.5 | ≥ 90 % |
| Panel answers citing a ticket outside the reader's scope | 0 |

**§11 additions.** Assistant turns, test results and review items follow the
brand's AI-log window; ticket summaries and rule answers go with their ticket;
snippets live until deleted.

**§15 addition.** "Could not answer": conversations handed off with reason
`no_answer` or nothing retrieved, divided by conversations auto-reply was
eligible for. Reported on the Overview beside deflection.

## Security and privacy

- **Redaction everywhere.** Playground, tests, rule questions, summaries and the
  panel all go through `complete()`. The panel's read plan is produced from the
  user's question and page context after redaction; the reads' results are
  redacted before the answering call.
- **No new reach.** The panel reads only through the user's tenant context;
  isolation is proved by the department negative tests extended to the panel
  (an Agent asking about another department's ticket gets nothing and the call's
  prompt holds no row from it). Thread rows are owner-scoped in the database.
- **Review queue scope.** `ai_review_items` is department-scoped; a Team Leader
  sees only their departments' items.
- **Snippets are knowledge.** Visibility filtered in SQL before ranking (§5);
  injection-screened; an Admin writes them; audited (`ai.snippet.created`,
  `…updated`, `…deleted`, `ai.answer_improved`).
- **Persona avatars** go through magic-byte sniffing (ADR 0009) and sharp; they
  are the only new public objects, in the public prefix, and contain nothing
  personal.
- **Email before handoff** is an unverified identifier (§4.1); it never grants
  access to other conversations; rate-limited per visitor.
- **Cost is a security property here.** Rule questions are event-only and
  capped at 3 per rule; summaries debounce; tests and the playground are
  rate-limited; the headroom check refuses before spending.
- **Audit.** Writing, guardrails, persona, assignment, triage and summary
  settings changes are audited with keys before and after (`ai.writing.updated`,
  `ai.guardrails.updated`, `ai.persona.*`, `ai.triage.updated`, …); test runs
  started; review items dismissed and improved.
- **AI disclosure.** The badge is not optional. This is also what EU AI Act
  Article 50 transparency asks of systems that talk to people (an owner check,
  not legal advice).

## Design artboards

Drawn by the orchestrating session on the design canvas before the screens are
built. Admin screens in English with the RTL rules of DESIGN §7 (as M11 did);
customer-facing ones in `en` and `ar`.

| Artboard | For | Must show |
|---|---|---|
| `Admin/AI-Overview` | M12-07 | Tabs AI › Overview, Playground, Tests, Review, Personas, Knowledge, Assistant, Triage, Usage (Providers for install admins); readiness checklist (done, to do, optional) collapsing when done; MetricTiles; by-day chart; unanswered questions; date range |
| `Admin/AI-Playground` | M12-04 | Chat as visitor; side card with channel, language, persona, "Try different settings" (drafts); each answer with decision, confidence vs threshold, citations Public/Internal, cost, AI log; Save as test; empty, refused (budget, no model) |
| `Admin/AI-Tests` | M12-05 | Tests list with last result; test editor dialog (messages, expectations); run in progress; results with checks and "newly failing"; cancel |
| `Admin/AI-Tests-RunBeforeSave` | M12-05 | The save dialog's "Run tests with these changes first", the comparison, Save anyway |
| `Admin/AI-Review` | M12-06 | Needs review list by reason, question and answer, ticket link; Improve answer dialog (answer, language, visibility, also save a test); dismiss; empty |
| `Admin/AI-Knowledge-Snippets` | M12-06 | Snippets list and editor inside AI › Knowledge |
| `Admin/AI-Personas`, `Admin/AI-Persona-Editor` | M12-03 | List with default and where each answers; editor: name, avatar upload or Sparkles tile, tone cards with a sample line, greeting, handoff and decline lines in en/ar, assignment |
| `Admin/AI-Assistant-1.1` | M12-02, M12-08, M12-09, M12-12 | Writing card, Guardrails card, cost estimate next to each toggle, Budget presets, summaries switch |
| `Admin/AI-Triage` | M12-10 | Triage new tickets, fields, threshold slider with "applies at or above", preview line |
| `Admin/Ticket-AI-Triage` | M12-10 | SuggestedFields with confidence chips, Apply and Skip; timeline lines "by the assistant · 82 %" |
| `Admin/RuleBuilder-AIQuestion` | M12-11 | The condition row (question, above/below, threshold), the limit of 3, TestRunPanel with estimate and answer |
| `Admin/AI-Usage` | M12-08 | Spend by feature/day/member/model, range, CSV |
| `Admin/Ticket-Summary` | M12-12 | DetailsPanel Summary card: points, "updated … ago", stale state, Refresh, Translate |
| `Admin/Assistant-Panel` | M12-13 | Docked panel, thread list, new chat, context chip (this ticket / this view), answer with ticket links and article citations, "could not look" line, cost per turn, empty, rate-limited, budget stop |
| `Admin/Notifications-AI`, `Email/AI-Budget-EN`, `Email/AI-Budget-AR`, `Email/AI-Provider-EN`, `Email/AI-Provider-AR` | M12-09 | Bell entries with no ticket (budget at 80 % and 100 %, provider failing) and the handoff entry; the three rows in the preference matrix; staff emails |
| `Admin/Ticket-Assist` (amended) | M12-17 | The Rewrite menu with the six options and their estimates; the "Draft with instructions" field, drafting and result states |
| `Admin/HelpCenter-DraftFromTickets` | M12-16 | Topic field or an unanswered question, the found tickets to untick, drafting state, the proposal with its source tickets |
| `Widget/AI-Persona-EN`, `Widget/AI-Persona-AR` | M12-03 | Header and answer row with persona avatar and name plus the AI badge; greeting; decline line; snippet citation without link |
| `Widget/AI-Handoff-Email-EN`, `Widget/AI-Handoff-Email-AR` | M12-02 | Handoff line asking for an email: field, send, sent, invalid |

New DESIGN §6 components, added in the PRs that build them: ReadinessChecklist,
CostEstimate (caption beside a toggle), ConfidenceChip, TestResultRow,
ReviewItem, PersonaAvatar (widget and admin), SummaryCard, AssistantPanel. The
widget work goes in a lazy chunk if it pushes `widget.js` towards 40 KB; the
persona header and the email field are small, but each PR records the size.

## Tests

- **Unit.** Prompt assembly order and that Instructions follow Helpdock's rules;
  `DECLINE` parsing; reply cap; estimate arithmetic (history vs profile, unknown
  price, override); expectation checks and judge parsing; read-plan schema
  (unknown read refused, argument bounds); triage gating (raise-only, add-only,
  department guard, threshold boundary at exactly the threshold); AI-question
  schema (refused in time-based rules, 3 max); summary debounce key; persona
  selection by channel.
- **Integration (Testcontainers, faux model).** RLS isolation for every new
  table, including owner-scoped threads (an Admin cannot read another user's
  thread); review items appear in the same transaction as a thumbs-down and a
  low-confidence handoff, never for "talk to a human"; improve → snippet → the
  next playground answer cites it, by full text before embedding; an internal
  snippet never reaches a visitor answer; playground and test runs write no
  `tickets`, `ticket_messages` or `outbox` rows; a test run job twice records one
  result per test; budget notifications once per window to Admins only; the
  quiet handoff at the hard stop sends no model call; the headroom check
  refuses; triage `auto` applies above and suggests below, never lowers
  priority, logs `via: ai`; rule questions batched into one call for three rules,
  cached on a second event with no new message, false on a refused call; summary
  refresh collapses a burst into one call; the panel run by an Agent never reads
  another department's ticket (asserted on the logged redacted prompt).
- **Browser (Playwright, `en` and `ar`, axe).** Every artboard above: AI ›
  Overview, Playground, Tests (run, fail, run-before-save), Review (improve,
  dismiss), Personas, Assistant cards, Triage, Usage, the ticket Summary card and
  triage suggestions, the rule builder condition, the panel; widget persona,
  decline and handoff email in `apps/widget/e2e/`.
- **Eval.** M12-14's categories in mock mode in CI and live nightly.

## Docs

Listed in M12-15. Also a short "Running your assistant" walk-through at the top
of [`docs/guides/ai.md`](../guides/ai.md): build knowledge, set a persona, try
it in the playground, save tests, turn it on, review weekly.

## ADRs

- **[0028](../decisions/0028-ai-workspace-runs-the-production-path-dry.md) The
  AI workspace runs the production path dry.** Playground and tests call
  `generateAutoReply` with an in-memory settings overlay and a synthetic
  conversation, and write nothing but `ai_calls` and their own rows. Brand tests
  are regression checks for a brand's own setup; the CI eval stays the release
  gate. Snippets are a knowledge source kind, not a second retrieval path.
- **[0029](../decisions/0029-staff-assistant-reads-through-validated-read-plans.md)
  The staff panel reads through validated read plans, not tool calls.** Two
  model calls per turn: plan, then answer. `assertNoTools` stays.
- **[0030](../decisions/0030-ai-decisions-in-automation-are-confidence-gated.md)
  AI decisions in automation are confidence-gated and one-directional.**
- **[0031](../decisions/0031-personas-change-the-voice-never-the-rules.md)
  Personas change the voice, never the rules; avatars are public uploads.**

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| AI questions or summaries multiply cost on a busy brand | High | Event rules only; questions only after other conditions hold; one call per event; cache per message seq; summaries debounced and only above N messages; estimates shown; headroom check; budget hard stop applies to automation |
| Self-reported confidence is poorly calibrated, so `auto` triage applies wrong fields | Medium | Default threshold 0.7 tuned by the eval's precision measure; raise-only and add-only limit the damage; every change in the timeline and reversible; M7-07 `suggest` stays |
| Personas or Instructions weaken grounding ("be playful", "always answer") | Medium | Helpdock's rules come first in the prompt; the eval runs the answerable set with a persona; tests let a brand catch it |
| The panel leaks a ticket from another department | Critical | Reads run under the user's RLS; plan arguments validated; a negative test asserts on the logged prompt; eval measure of 0 |
| Brand tests give false confidence ("all green") on a weak model | Medium | Tests are labelled as the brand's own checks; the Overview links the CI eval report and says which model it measured |
| Widget grows past 40 KB | Medium | Persona header and email field measured per PR; lazy chunk if needed |
| Non-ticket notifications ripple through the notification UI | Low | One new kind; the bell entry has its own artboard; covered by tests |

## Open questions

Answered in one place in [decisions-1-x.md](../planning/decisions-1-x.md#m12-ai-workspace).

1. (D-04) **Panel conversation retention.** Proposed: the brand's AI-log window
   (default 90 days), deletable by their author at any time. Keep?
2. (D-05) **Summary language.** Proposed: the brand's default staff language,
   with Translate on the card. Alternative: one per viewer language (double
   cost).
3. (D-06) **Snippet default visibility.** Proposed: public, because Improve
   answer fixes visitor answers; the dialog shows the choice. Keep?
4. (D-07) **Do playground and test runs count toward the brand budget?**
   Proposed: yes (it is real spend) and they stop at the hard stop.
   Alternative: exempt up to a small allowance.
5. (D-08) **Price override.** Add an install setting for per-model prices so
   local or unlisted models show estimates? Proposed: yes, install admin only.
6. (D-09) **Max replies default.** Proposed 20 per conversation. OK?
7. (D-10) **Persona on email.** Proposed: the AI reply's sign-off is the persona
   name; the `From` name stays the department's, to keep threading and DMARC
   simple.
8. **Version.** Ship M12 as 1.1.0? See D-01, the release mapping.

## Build order

1. M12-01.
2. Track A: M12-04 → M12-05 → M12-06 → M12-07 → M12-16.
   Track B: M12-02 → M12-03 → M12-08 → M12-09 → M12-17.
   Track C: M12-10 → M12-11 → M12-12 → M12-13.
3. M12-14 once A, B and C have their behaviour in; M12-15 alongside each PR and
   closed last.

## Exit criteria

- [ ] An Admin asks a question in the playground with an unsaved Instructions
      change and gets the answer, citations, confidence, decision and cost;
      afterwards no `tickets`, `ticket_messages` or `outbox` row exists for it.
- [ ] Saving Instructions with "Run tests with these changes first" runs every
      test with the draft, shows a newly failing test, and saves only on
      confirmation.
- [ ] A thumbs-down on an AI answer puts it in Needs review; Improve answer
      creates a public snippet, and the next playground answer to the same
      question cites it before the embedding job has run; an internal snippet
      never reaches a visitor answer (SQL-level test).
- [ ] A declined topic gets the persona's decline line; the reply cap hands off
      with `reply_limit`; a widget handoff with no email asks for one.
- [ ] A widget, a mailbox and a Telegram bot of one brand answer with three
      different personas; each answer carries the AI badge; `en` and `ar`.
- [ ] At 80 % and 100 % of the monthly budget the brand's Admins get one bell
      entry and one email; at 100 % a conversation the assistant was in gets the
      handoff line with no model call.
- [ ] A provider refusing the brand's key notifies the install admins and the
      brand's Admins once within the hour; an assistant handoff notifies the
      assignee, else the team, else the department, per their preferences.
- [ ] Usage by feature, day, member and model matches seeded `ai_calls` in an
      integration test, and every AI toggle shows an estimate.
- [ ] Triage in `auto` applies a field above the threshold and leaves a
      suggestion below; it never lowers a priority; each change is in the
      timeline as by the assistant with its confidence.
- [ ] A rule with an AI question runs on a matching ticket with one model call
      for all questions of the event, and does not run when the budget is spent.
- [ ] The panel answers "which of my tickets breach SLA in the next hour" with
      links, and an Agent's panel never reads a ticket outside their
      departments (negative test on the logged prompt).
- [ ] An agent rewrites a draft longer, simpler and with spelling fixed, and
      drafts a reply from a one-line instruction, each showing its estimate and
      changing the draft only on "Replace text".
- [ ] Brand A cannot read brand B's rows in any new table; another user's
      assistant threads are invisible to an Admin (D §1.6 suite).
- [ ] The eval meets M12's §9 additions in both languages, live, with the run
      recorded.
- [ ] Every new screen passes Playwright in `en` and `ar` with axe.

## Planning-document changes when this milestone lands

The PRD (status board row, Phase 5 section, risks) and the REQUIREMENTS scope
statements were updated by the 2026-10-20 planning pull request. The rest lands
with the deliverables:

- **REQUIREMENTS.** §4.7 gains the M12 features (modes, guardrails, personas,
  workspace); §4.3 gains the AI condition.
- **ARCHITECTURE.** §5 the tables; §13 queue jobs `ai.test_run` and
  `ai.summary_refresh`; §19 the decisions.
- **DOMAIN-RULES.** §17 and §18 as drafted above; §4.5, §5, §9, §11, §15 as
  listed.
- **DESIGN.md.** §6 components listed above; §6.6 widget persona.
- **AGENTS.md.** Unchanged: M12 keeps the rule that the model reads knowledge
  and writes text.
