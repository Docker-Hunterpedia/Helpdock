# Completed

Milestones and features that have shipped and been verified. Each document
describes what was actually built, including what was left out and why.

| Document | Shipped | What it is |
|---|---|---|
| [M0-skeleton.md](M0-skeleton.md) | 2026-09-19 | **M0 Skeleton** — the monorepo, config, Postgres with row-level security, tenancy plumbing, auth, roles, the admin shell, the first-run wizard, Docker Compose, observability, CI, the realtime gateway, the transactional outbox and the SSRF-safe HTTP client. |
| [M1-ticketing-core.md](M1-ticketing-core.md) | 2026-09-25 | **M1 Ticketing core** — brands, departments and teams, tickets and threads, contacts and identity rules, views, tags, custom fields and templates, assignment, the state machine, merge and split, attachments, spam, time tracking and CSAT, data retention, and the admin ticket workspace. Four of five exit criteria met; tagging a ticket in the workspace is the open one. |

When a milestone or feature is verified and merged, move its document here from
`in-development/`, set `Status: shipped`, add a `Shipped:` date, and edit the
body so it describes what was actually built rather than what was planned. Add a
row above, and tick or explain every exit criterion — an unmet one is written
down, not dropped.
