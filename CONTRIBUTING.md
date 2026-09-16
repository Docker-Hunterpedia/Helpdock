# Contributing to Helpdock

Thanks for your interest. Helpdock is early and moving fast, so please read this before opening a pull request.

## Before you start

- Read [REQUIREMENTS.md](docs/planning/REQUIREMENTS.md) and [ARCHITECTURE.md](docs/planning/ARCHITECTURE.md). They are the source of truth for scope and stack.
- For anything larger than a small fix, open an issue first so we can agree on the approach.
- Features listed under v1.1 or non-goals will not be merged into v1.

## Workflow

1. Fork the repository and create a branch from `main`. Use a descriptive name such as `feat/email-threading` or `fix/sla-timer-pause`.
2. Make your change with tests.
3. Open a pull request against `main`. Fill in the description: what changed, why, and how it was tested.
4. A code owner reviews. Address review threads; every thread must be resolved before merge.
5. Pull requests are squash-merged. Direct pushes to `main` are not allowed for anyone.

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
