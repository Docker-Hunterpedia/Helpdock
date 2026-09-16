# Contributing to Helpdock

Thanks for your interest. Helpdock is early and moving fast, so please read this before opening a pull request.

## Before you start

- Read [REQUIREMENTS.md](docs/planning/REQUIREMENTS.md) and [ARCHITECTURE.md](docs/planning/ARCHITECTURE.md). They are the source of truth for scope and stack.
- For anything larger than a small fix, open an issue first so we can agree on the approach.
- Features listed under v1.1 or non-goals will not be merged into v1.

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

## Security issues

Do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the [AGPL-3.0](LICENSE).
