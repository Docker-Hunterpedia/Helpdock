# Completed

Milestones and features that have shipped and been verified. Each document
describes what was actually built, including what was left out and why.

| Document | Shipped | What it is |
|---|---|---|
| [M0-skeleton.md](M0-skeleton.md) | 2026-09-19 | **M0 Skeleton** — the monorepo, config, Postgres with row-level security, tenancy plumbing, auth, roles, the admin shell, the first-run wizard, Docker Compose, observability, CI, the realtime gateway, the transactional outbox and the SSRF-safe HTTP client. |
| [M1-ticketing-core.md](M1-ticketing-core.md) | 2026-09-25 | **M1 Ticketing core** — brands, departments and teams, tickets and threads, contacts and identity rules, views, tags, custom fields and templates, assignment, the state machine, merge and split, attachments, spam, time tracking and CSAT, data retention, and the admin ticket workspace. All five exit criteria met. |
| [M2-email-channel.md](M2-email-channel.md) | 2026-09-27 | **M2 Email channel** — IMAP and inbound-parse mail into tickets with the participant check, sanitised bodies and proxied images, SMTP replies through the outbox, auto-replies with loop protection, and the Channels admin pages. All four exit criteria met. |
| [M3-automation-and-slas.md](M3-automation-and-slas.md) | 2026-09-27 | **M3 Automation and SLAs** — business hours and holidays, the SLA engine, workflow and time-based rules with the rule builder, macros and canned responses, staff notifications in the app, by email and by web push, and the audit log viewer. All five exit criteria met. |

When a milestone or feature is verified and merged, move its document here from
`in-development/`, set `Status: shipped`, add a `Shipped:` date, and edit the
body so it describes what was actually built rather than what was planned. Add a
row above, and tick or explain every exit criterion — an unmet one is written
down, not dropped.
