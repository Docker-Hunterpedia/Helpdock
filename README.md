# Helpdock

Open-source customer support platform: ticketing, help center, live chat widget and grounded AI, in one deploy that serves many brands. A self-hosted alternative to Zoho Desk, Zendesk and Freshdesk.

> **Status:** pre-alpha. **M0 Skeleton shipped** on 2026-09-19; **M1 Ticketing core** is next. What works today: `docker compose up`, the first-run wizard, sign-in with a password and a second factor, staff and roles, and the System page — in English and Arabic. There is no ticketing yet. See the [PRD](docs/planning/PRD.md) for phases, milestones and current status, [what M0 actually built](docs/completed/M0-skeleton.md), plus [REQUIREMENTS.md](docs/planning/REQUIREMENTS.md) and [ARCHITECTURE.md](docs/planning/ARCHITECTURE.md).

## Why Helpdock

- **One deploy, many brands.** A single installation hosts any number of brands, each with its own inboxes, help center on its own domain, widget theme, channels and AI knowledge. Brand isolation is enforced with Postgres row-level security.
- **Zoho-style ticketing discipline.** Departments, teams, SLAs with business hours, workflow rules, time-based rules, macros, canned responses, saved views, agent collision detection, merge/split and CSAT.
- **AI that is grounded and controlled.** Answers come only from your knowledge: help center articles, uploaded files, crawled sites, Notion and Google Drive. Any LLM provider by API key or subscription. Every AI feature is a toggle, with PII redaction, prompt-injection filtering and per-brand token budgets.
- **Security and speed as requirements.** Row-level tenant isolation, encrypted secrets, signed widget identities, rate limits everywhere, and a widget under 40 KB.

## Channels (v1)

Email (IMAP and inbound-parse webhooks, SMTP out), Telegram bots, web chat widget, hosted web form, and a scoped REST API. WhatsApp, Messenger, Instagram, Slack and Discord are planned for v1.1.

## Stack

Node.js 24, TypeScript, NestJS, Drizzle ORM, PostgreSQL 17 with pgvector, Redis with BullMQ, Socket.IO, React with MUI for the admin app, Vite SSR for the help center, Preact for the widget. English and Arabic (RTL) UI in v1. Deployed with Docker Compose.

## Roadmap

| Milestone | Scope | Status |
|---|---|---|
| M0 | Monorepo skeleton, config, database and RLS, auth, admin shell, Compose, CI | [shipped](docs/completed/M0-skeleton.md) |
| M1 | Ticketing core | next |
| M2 | Email channel | planned |
| M3 | Automation and SLAs | planned |
| M4 | Widget and realtime | planned |
| M5 | Help center | planned |
| M6 | Telegram | planned |
| M7 | AI | planned |
| M8 | API, webhooks, reports | planned |
| M9 | Hardening and 1.0 release | planned |

Milestones are grouped into five phases with deliverables and exit criteria in the [PRD](docs/planning/PRD.md). All project documents live under [docs/](docs/), organised by lifecycle stage.

## Development

Node.js 24 and pnpm 12, then `pnpm install`. The root scripts are `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm format`. See [docs/guides/development.md](docs/guides/development.md) for the workspace layout, how to add a package and how CI runs, and [docs/guides/release.md](docs/guides/release.md) for how a commit becomes a published image.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). All changes go through pull requests and require a code-owner review.

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[AGPL-3.0](LICENSE).
