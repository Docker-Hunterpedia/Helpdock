# Contributing to Helpdock

Thanks for your interest. Helpdock 1.0.0 was released on 2026-10-20, and the work after it is planned in the open as the 1.x releases: [Phase 5 of the PRD](docs/planning/PRD.md#phase-5--1x) lists the milestones and their deliverables, and [the 1.x decisions](docs/planning/decisions-1-x.md) record what the owner has decided. Please read this before opening a pull request.

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). For help using Helpdock rather than changing it, see [SUPPORT.md](SUPPORT.md).

## Before you start

- Read [REQUIREMENTS.md](docs/planning/REQUIREMENTS.md) and [ARCHITECTURE.md](docs/planning/ARCHITECTURE.md). They are the source of truth for scope and stack.
- For anything larger than a small fix, open an issue first so we can agree on the approach. Use the [issue forms](https://github.com/Docker-Hunterpedia/Helpdock/issues/new/choose): bug report, feature request, accessibility barrier, translation or documentation. Questions and early ideas go to [GitHub Discussions](https://github.com/Docker-Hunterpedia/Helpdock/discussions).
- Work maps to a deliverable in the PRD. An item on the [post-1.0 backlog](docs/planning/PRD.md#5-post-10-backlog-v11) is not scheduled and needs its own PRD section before it is built, and the [non-goals for 1.x](docs/planning/PRD.md#non-goals-for-1x) will not be merged.
- Translations are pull requests to `packages/i18n/locales/` for now; Hosted Weblate is planned ([D-47](docs/planning/decisions-1-x.md#m17-apps-and-languages)).

## Workflow

1. Fork the repository and create a branch from `main`. Use a descriptive name such as `feat/email-threading` or `fix/sla-timer-pause`.
2. Pick or open an issue tied to a deliverable id from the [PRD](docs/planning/PRD.md).
3. Make your change. Every PR must include unit tests, integration tests where infrastructure is touched, Playwright tests for any user-facing change, and updated docs. See the Definition of done in [AGENTS.md](AGENTS.md); it applies to humans too.
4. Open a pull request against `main` that links the issue with `Closes #n`. Fill in the description: deliverable id, what changed, why, and how it was tested.
5. A code owner reviews. Address review threads; every thread must be resolved before merge.
6. Pull requests are squash-merged. Direct pushes to `main` are not allowed for anyone.

## Commit and PR style

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
- The PR title becomes the squash commit message, so keep it in the same format.

## Code standards

- TypeScript strict mode. Lint and format with Biome.
- Validate every boundary with Zod. Never trust input from channels, widgets or API keys.
- Every tenant table carries `brand_id` and is covered by a row-level security policy. Tests must prove cross-brand reads are impossible.
- Side effects (email, Telegram, AI calls, webhooks, indexing) go through BullMQ, never inline in a request.
- Secrets are encrypted at rest and never returned to the client after save.
- User-facing strings go through i18n catalogs with English and Arabic entries.
- Screens are built from an artboard and [DESIGN.md](DESIGN.md). [docs/design/](docs/design/README.md) shows every artboard as an image with its source; a screen with no artboard needs one before it is built.

## Security issues

Do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the [AGPL-3.0](LICENSE).
