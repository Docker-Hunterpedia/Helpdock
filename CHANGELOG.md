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

## 0.2.0 — 2026-09-27

**M2 Email channel** and **M3 Automation and SLAs**. Helpdock now talks to
customers by email and runs the desk on its own: business hours and SLA clocks,
workflow and time-based rules, macros and canned responses, and staff
notifications in the admin, by email and by browser push.

### M2 Email channel

- **Inbound email** from IMAP mailboxes or inbound-parse webhooks (Postmark,
  SendGrid, Mailgun, Resend, generic JSON). Replies thread onto their ticket by
  `Message-ID`, `References` or the ticket number, and only when the sender is a
  participant — anyone else quoting a ticket gets a new ticket.
- **Outbound email** through each brand's SMTP server, from the department's
  address, in English or Arabic with the agent's signature. Every send goes
  through the outbox with a fixed `Message-ID`, retries five times, and lands in
  **Failed sends** in the admin when it cannot be delivered.
- **Auto-replies** (acknowledgment and out-of-hours) with loop protection.
- **Email security**: sanitised HTML, remote images blocked or proxied, an
  optional SPF/DKIM spam rule.

### M3 Automation and SLAs

- **Business hours and holidays** per brand, with department overrides.
- **SLA engine**: first-response and resolution clocks in business time, pause
  on "awaiting customer", escalation steps, and timers rebuilt after a Redis loss.
- **Workflow rules** on events and on a schedule, with a test run and a loop
  guard; **macros and canned responses** in English and Arabic.
- **Notifications** in the admin, by email and by web push, with per-person
  preferences; an **audit log** viewer for install admins.

### Upgrade notes

- Run the migrations (`0024`–`0029`); the worker needs a restart to pick up the
  new queues.
- **Sign-in links, password resets and invitations are now emailed** through the
  install's SMTP server (the wizard's outgoing email step). Before this release
  they were only logged. Without SMTP they are still not delivered; the install
  guide says how to use Mailpit in development.
- Optional: `HD_PUSH_VAPID_PUBLIC_KEY` and `HD_PUSH_VAPID_PRIVATE_KEY` turn on
  browser push notifications.

### Known gaps

Listed in [M2](docs/completed/M2-email-channel.md) and
[M3](docs/completed/M3-automation-and-slas.md); none blocks upgrading.

## 0.1.0 — 2026-09-27

The first release: **M0 Skeleton** and **M1 Ticketing core**. Helpdock is now a
working staff ticket desk — brands, departments and teams, tickets with a full
workspace, contacts, views and search — behind the tenancy, auth and install
foundations of M0. Customers cannot reach it yet: there is no email channel,
help center or widget. Pre-alpha: expect breaking changes before 1.0.

### M1 Ticketing core

- **Brands, departments and teams.** Ticketing settings per brand, departments
  with an Arabic name and a default team, and team members scoped to the
  departments they can reach.
- **Tickets under department scope.** Tickets, messages, internal notes and an
  activity log under row-level security that hides a department's tickets from
  anybody outside it. Every change reaches open screens in real time.
- **One state machine** for every status change, with a per-brand reopen policy,
  "awaiting customer" on an agent reply, and escalation.
- **The ticket workspace.** List, thread, composer, details panel and new-ticket
  dialog, in English and Arabic, with a collision indicator when two agents are
  on the same ticket.
- **Saved views and search.** Personal and shared views with sidebar counts, and
  ticket search through a token table (ADR 0011), so a search that finds nothing
  stays fast under row-level security.
- **Contacts and accounts**, with verified-only automatic merging, duplicate
  suggestions and a 24-hour undo.
- **Desk tools.** Tags, custom fields and templates; round-robin and skill-based
  assignment; merge (with a 24-hour unmerge) and split; spam and a sender block
  list; time tracking; CSAT rating links; attachments with a media pipeline that
  re-encodes images, voice notes and video posters.
- **Retention.** Per-brand retention with a nightly purge and contact
  anonymisation.

### Upgrade notes

- **New, optional: `HD_SETUP_TOKEN`.** When set (at least 32 characters), the
  first-run wizard asks for it as a "Setup key" before it creates the admin
  account, so nobody who cannot read the server's `.env` can claim a fresh
  install. Set it before the host is reachable from the internet. Unset, the
  wizard behaves as before. See [the install guide](docs/guides/install.md).
- Development MinIO now comes from Chainguard's public image.

### Security

- The first-run wizard can be gated by `HD_SETUP_TOKEN` (above).
- Fixes for the first CodeQL findings: remote response headers can no longer
  write to an object prototype, the SMTP deadline is capped at ten seconds, and
  an admin asset path is proven to be inside the build before the file system is
  touched.

### M0 Skeleton

The foundation every later milestone builds on: an install you can stand up,
sign in to and watch.

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

### Not in this release

Email, automation and SLAs, the help center, the widget, the Telegram channel,
AI and the public API. They are M2 to M8 in [the PRD](docs/planning/PRD.md).
