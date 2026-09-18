# 0004 Embed Bull Board for queue inspection, with a custom summary on the System page

Status: accepted
Date: 2026-09-18

## Context

Every side effect in Helpdock is a job. Email, Telegram, AI calls, webhooks, indexing and media processing are written to the transactional outbox inside the domain transaction and then run as idempotent BullMQ jobs ([DOMAIN-RULES §6](../planning/DOMAIN-RULES.md#6-transactional-outbox)). There are eleven queues — `inbound`, `outbound`, `sla`, `rules`, `ai`, `knowledge`, `media`, `notify`, `webhooks`, `outbox` and `maintenance` ([ARCHITECTURE §13](../planning/ARCHITECTURE.md#13-background-jobs-bullmq-queues)). "Is this install healthy" is, to a first approximation, "are the queues moving".

That makes queue visibility an operations requirement, not a nicety. The most common support question a self-hoster will ever ask is "why did this email never arrive", and answering it means seeing the failed job, its error and its payload, and being able to retry it. Without a UI, the answer requires shell access to Redis, which is an unreasonable thing to ask of the audience that chose a Docker Compose product.

The admin System page ([ARCHITECTURE §14](../planning/ARCHITECTURE.md#14-observability), deliverable M8-05) already carries version and git sha, pending migrations, channel status, storage usage and LLM spend. Queue health belongs beside them.

The security shape matters. Job payloads contain ticket content and recipient addresses, and BullMQ queues are install-wide rather than brand-scoped, so a queue dashboard is install-admin data. It cannot sit behind ordinary agent authorization.

## Decision

Embed Bull Board — `@bull-board/api` with `@bull-board/nestjs` (9.10.1, MIT; its peer dependencies cover NestJS 12 and BullMQ 6, which is our stack) — on an API route guarded by the install-admin permission, and link to it from the admin System page.

Alongside it, the System page renders a small summary we write and own: per queue, the depth, active count, failed count and DLQ count, read from BullMQ's counts and exposed on `/metrics` as well. The summary is what an admin looks at every day. Bull Board is what they open when the summary is red.

## Consequences

- Retry, promote, clean and payload inspection arrive for free, in a UI maintained by someone else that already understands BullMQ's job states. For M0 that is weeks we do not spend.
- Bull Board serves its own React UI from the API. It is not part of the admin bundle and it does not follow our MUI theme, our i18next catalogs or our RTL provider — it will be English and left-to-right. That is acceptable for an install-admin debugging tool and would be unacceptable for anything an agent touches daily, which is precisely why the daily view is our own summary and not this.
- The route is guarded by us, not by the library. It is mounted as an ordinary Nest route carrying `@Requires(...)` so it passes through the same permission check as every other route and is caught by the CI check that every route declares one. Because a missed guard here would expose job payloads across every brand on the install, this route gets an explicit case in the negative test suite in [DOMAIN-RULES §1.6](../planning/DOMAIN-RULES.md#16-required-negative-tests).
- The dashboard is install-wide by construction: queues are not brand-scoped, so it shows jobs belonging to every brand. This is the one place in the product where brand isolation does not apply to what is displayed, and it is the reason the permission is install-admin rather than brand-admin. It needs to be stated plainly in the operations guide.
- One more dependency in the API image, and one more thing for Renovate to keep current. It is small, MIT, and removable: if it were ever abandoned, the custom summary already covers the everyday case and we would only need to rebuild retry and payload inspection.

## Alternatives considered

- **A fully custom queue UI in admin.** The nicest outcome on paper: themed, translated, RTL-correct and consistent with the rest of the product. Rejected for v1 because it means rebuilding job listing, filtering, pagination, payload inspection and retry across eleven queues and every job state, which is weeks that M0 does not have, in exchange for something a self-hoster can already get. The custom summary is the useful fraction of that work, and we are building it.
- **Arena (`bull-arena`, 4.10.0, MIT).** Actively released and a reasonable tool, but it ships its own Express and Handlebars application rather than integrating with NestJS, so mounting it means standing up a second server-rendered app inside our process and wiring our authorization around it by hand. `@bull-board/nestjs` is a first-class Nest module and puts the route under our existing guard with no bridging code.
- **No UI at all — logs and `/metrics` only.** Rejected. Metrics tell an operator that the `outbound` queue has failures; they do not tell them which message failed or let them retry it. For a product whose users are self-hosters rather than platform operators, that turns the most common failure into an unanswerable question.
