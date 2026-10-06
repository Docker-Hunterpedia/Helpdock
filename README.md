# Helpdock

Open-source customer support platform: ticketing, help center, live chat widget and grounded AI, in one deploy that serves many brands. A self-hosted alternative to Zoho Desk, Zendesk and Freshdesk.

> **Status:** pre-1.0. M0 to M5 have shipped: the first-run wizard, sign-in with a second factor, staff, roles and brands, the ticket workspace, email in and out, business hours and SLAs, workflow rules and macros, notifications, the chat widget and the help center, in English and Arabic. Telegram, AI, the public API and the 1.0 hardening are being built. See the [PRD](docs/planning/PRD.md) for phases, milestones and current status, and [docs/completed/](docs/completed/README.md) for what each milestone built, plus [REQUIREMENTS.md](docs/planning/REQUIREMENTS.md) and [ARCHITECTURE.md](docs/planning/ARCHITECTURE.md).

## Install

Docker Engine with Compose v2, a Linux server with 2 vCPU and 4 GB of memory, two DNS names pointing at it, and ports 80 and 443 open. Each release is published as `ghcr.io/docker-hunterpedia/helpdock:<version>` ([releases](https://github.com/Docker-Hunterpedia/Helpdock/releases)).

```bash
git clone --depth 1 --branch v<version> https://github.com/Docker-Hunterpedia/Helpdock.git
cd Helpdock/docker
cp ../.env.example .env
# Fill in .env: HELPDOCK_VERSION=<version>, APP_URL, APP_MASTER_KEY (openssl rand -base64 32),
# the database passwords, the S3 bucket, ADMIN_HOST and API_HOST.
docker compose up -d
```

Then open `https://<ADMIN_HOST>` and finish the first-run wizard. [docs/guides/install.md](docs/guides/install.md) walks through every step, [configuration.md](docs/guides/configuration.md) lists every key, and [operations.md](docs/guides/operations.md) covers backups, upgrades and master key rotation. **Back up `.env` with the database**: without `APP_MASTER_KEY` nothing encrypted can be read back.

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
| M1 | Ticketing core | [shipped](docs/completed/M1-ticketing-core.md) |
| M2 | Email channel | [shipped](docs/completed/M2-email-channel.md) |
| M3 | Automation and SLAs | [shipped](docs/completed/M3-automation-and-slas.md) |
| M4 | Widget and realtime | [shipped](docs/completed/M4-widget-and-realtime.md) |
| M5 | Help center | [shipped](docs/completed/M5-help-center.md) |
| M6 | Telegram | [in development](docs/in-development/M6-telegram.md) |
| M7 | AI | [in development](docs/in-development/M7-ai.md) |
| M8 | API, webhooks, reports | [in development](docs/in-development/M8-api-webhooks-reports.md) |
| M9 | Hardening and 1.0 release | [in development](docs/in-development/M9-hardening-and-1-0.md) |

Milestones are grouped into five phases with deliverables and exit criteria in the [PRD](docs/planning/PRD.md). All project documents live under [docs/](docs/), organised by lifecycle stage.

## Design

The design system is [DESIGN.md](DESIGN.md). Every screen, from the admin app to the widget, help center and emails, is drawn before it is built; [docs/design/](docs/design/README.md) shows each one as a rendered image, grouped by milestone, with its artboard source.

## Development

Node.js 24 and pnpm 12, then `pnpm install`. The root scripts are `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm format`. See [docs/guides/development.md](docs/guides/development.md) for the workspace layout, how to add a package and how CI runs, and [docs/guides/release.md](docs/guides/release.md) for how a commit becomes a published image.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). All changes go through pull requests and require a code-owner review.

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[AGPL-3.0](LICENSE).
