# Completed

Milestones and features that have shipped and been verified. Each document
describes what was actually built, including what was left out and why.

| Document | Shipped | What it is |
|---|---|---|
| [M0-skeleton.md](M0-skeleton.md) | 2026-09-19 | **M0 Skeleton** — the monorepo, config, Postgres with row-level security, tenancy plumbing, auth, roles, the admin shell, the first-run wizard, Docker Compose, observability, CI, the realtime gateway, the transactional outbox and the SSRF-safe HTTP client. |
| [M1-ticketing-core.md](M1-ticketing-core.md) | 2026-09-25 | **M1 Ticketing core** — brands, departments and teams, tickets and threads, contacts and identity rules, views, tags, custom fields and templates, assignment, the state machine, merge and split, attachments, spam, time tracking and CSAT, data retention, and the admin ticket workspace. All five exit criteria met. |
| [M2-email-channel.md](M2-email-channel.md) | 2026-09-27 | **M2 Email channel** — IMAP and inbound-parse mail into tickets with the participant check, sanitised bodies and proxied images, SMTP replies through the outbox, auto-replies with loop protection, and the Channels admin pages. All four exit criteria met. |
| [M3-automation-and-slas.md](M3-automation-and-slas.md) | 2026-09-27 | **M3 Automation and SLAs** — business hours and holidays, the SLA engine, workflow and time-based rules with the rule builder, macros and canned responses, staff notifications in the app, by email and by web push, and the audit log viewer. All five exit criteria met. |
| [M4-widget-and-realtime.md](M4-widget-and-realtime.md) | 2026-09-27 | **M4 Widget and realtime** — the embeddable Preact widget in four modes with brand theming and RTL, visitor identity and signed identity, the origin allow-list and throttles, the realtime delivery contract over the `/widget` socket and SSE, rich content and voice, the pre-chat form and transcripts, the hosted web form, and the widget protocol for native apps. All five exit criteria met. |
| [M5-help-center.md](M5-help-center.md) | 2026-09-27 | **M5 Help center** — categories, sections and bilingual articles with the TipTap editor, public and internal visibility, pages rendered by the api on each brand's domain with a page cache and SEO, English and Arabic search, feedback, views and Insights, site theming, custom domains with on-demand TLS, and the widget's help center modes. All four exit criteria met; the first short of a real TLS certificate, which waits on a registered domain. |
| [asvs-l2.md](asvs-l2.md) | 2026-10-05 | **M9-02 OWASP ASVS 4.0.3 Level 2 walk-through** — every Level 2 requirement with its status and evidence, and the gaps to close before 1.0. Walk again as M6, M7 and M8 land. |

When a milestone or feature is verified and merged, move its document here from
`in-development/`, set `Status: shipped`, add a `Shipped:` date, and edit the
body so it describes what was actually built rather than what was planned. Add a
row above, and tick or explain every exit criterion — an unmet one is written
down, not dropped.
