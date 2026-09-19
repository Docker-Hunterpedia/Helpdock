# Changelog

What changed in each release of Helpdock, written for the person deciding
whether to upgrade — one section per release. The per-change list, with a link
to the pull request that carried each one, is `apps/api/CHANGELOG.md`, which
Changesets writes from the entries in `.changeset/` when it opens the version
pull request.

A section's heading is `## <version> — <date>`, and
[the release workflow](.github/workflows/release.yml) copies it into the GitHub
Release for the matching `v<version>` tag. [`docs/guides/release.md`](docs/guides/release.md)
is the procedure.

Versions follow [semantic versioning](https://semver.org). Before 1.0 a minor
bump may change behaviour; upgrade notes call it out when it does.

## Unreleased

**M0 Skeleton.** The first milestone: a running, empty, secure skeleton that
every later milestone builds on. There is no ticketing yet — what works is an
install you can stand up, sign in to and watch.

- **One deploy, many brands, enforced in Postgres.** Every tenant table carries
  `brand_id` under a `FORCE`d row-level-security policy, every request runs
  inside a transaction that sets the `app.*` session settings, and every route
  declares the permission it needs. A negative test suite proves brand A cannot
  read brand B.
- **Install and run with Docker Compose.** One image with `APP_ROLE=api|worker`,
  a Compose stack with Caddy, Postgres 17 with pgvector, Redis and MinIO, and
  on-demand TLS that only answers for a verified help-center domain.
- **A first-run wizard.** A brand-new install lands on four steps: the admin
  account, the first brand, outgoing email, done.
- **Four ways to sign in.** Password (argon2id), sign-in link, Google and
  GitHub, each with TOTP and recovery codes, rotating refresh tokens in Redis
  and "sign out everywhere".
- **Staff and roles.** Admin, Team Leader, Agent and the Viewer toggle, with
  invite, activate, role change, deactivate, reactivate, delete and per-brand
  removal.
- **An admin shell in English and Arabic**, right-to-left included, with the
  System page reporting version, commit, queues and dependency health.
- **The plumbing later milestones need**: a Socket.IO `/staff` namespace with
  presence, a transactional outbox with a crash-safe relay, an SSRF-safe
  outbound HTTP client, pino logs with request and brand ids, OpenTelemetry and
  `/metrics`.

Not in this release: tickets, email ingestion, the help center, the widget, the
Telegram channel, AI and the public API. They are M1 to M8 in
[the PRD](docs/planning/PRD.md).
