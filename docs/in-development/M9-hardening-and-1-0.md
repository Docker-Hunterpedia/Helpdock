# M9 Hardening and 1.0

Status: in progress
Started: 2026-10-05
Owner: @Docker-Hunterpedia

## Scope

Full deliverable list and specs: [PRD §4 · M9 Hardening and 1.0](../planning/PRD.md#m9-hardening-and-10).
Depends on everything above. Code-side deliverables (security scanning, load tests, docs, release pipeline, accessibility audit) start in parallel; the external pentest, outside usability testers, clean-VM onboarding and restore drill need people and hardware and are tracked as external dependencies.

## Deliverables

| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M9-01 | External pentest of widget + API; fix all High and Medium findings | | planned |
| M9-02 | OWASP ASVS L2 checklist walk-through with evidence recorded in `docs/completed/` | | built in branch: walked, and all 11 gaps closed ([notes](#m9-02-closing-the-gaps)); 3.4.4 closes with a recorded deviation |
| M9-03 | Load tests | | in progress: suites built and smoke-run; outbox concurrency raised ([notes](#m9-03-outbox-concurrency)); the §14 host run is outstanding |
| M9-04 | Accessibility audit (axe + manual keyboard) on widget and help center | | built in branch (M9-04): [notes](#m9-04-accessibility-audit); results in [accessibility-audit.md](../completed/accessibility-audit.md); screen-reader pass outstanding |
| M9-05 | Semgrep rules for Nest, ZAP baseline scan on release branches, SBOM on release | | in review |
| M9-06 | User docs under `docs/guides/` | | built in branch: every guide on the PRD's list exists and is checked against the code ([notes](#m9-06-user-docs)); README install path tried against the published image and a local build |
| M9-07 | Onboarding test on a clean VM against the 30-minute target; usability pass with three outs | | tooling built and run locally ([notes](#m9-07-onboarding-test)); **the clean-VM run and the three outside testers need people** and are recorded in [onboarding-test.md](../completed/onboarding-test.md) when done |
| M9-08 | Release pipeline | | verified; external dependency (GHCR visibility, signing key) open |
| M9-09 | Tag `1.0.0` | | planned |
| M9-10 | Restore drill | | tooling built and rehearsed locally, master key rotation included ([notes](#m9-10-restore-drill)); **the drill for the record on a clean VM needs a person** and is recorded in [restore-drill.md](../completed/restore-drill.md) when done |

## M9-04 Accessibility audit

- **Automated.** `apps/widget/e2e/a11y-audit.spec.ts` runs axe (WCAG 2.1 A and AA)
  on every widget mode and state, and `apps/api/e2e/help-center-a11y.spec.ts`
  on every help center page type, including the 404, 410 and internal-only
  wall. Both run in `en` and `ar`, light and dark, and both are in the CI jobs
  that already run those Playwright projects.
- **Keyboard.** Tab order and a visible ring on every stop, the skip link,
  Escape, and the widget's focus trap at phone width.
- **Fixed.**
  - The help center has a skip link, and every `<main>` can take focus.
  - Article body links are underlined. Axe found them told apart by colour
    alone in dark mode.
  - At phone width the widget is a modal dialog that keeps Tab inside it, and
    the launcher no longer covers Send.
  - The widget's theme sheet is replaced only when it changes, and the e2e axe
    helper waits for the widget to settle. This addresses the M4 flake.
- **Closed M5 gaps** with existing artboards:
  - "What was missing?" after a "No" (`HelpCenter/Article-AR` panels 2 and 3).
    The form takes an optional `comment` (`hcFeedbackFormSchema`), and the
    step travels in `?feedback=no`.
  - The CSAT page's "Browse the help center" (`CsatEN`).
    `csatBrandSchema.helpCenterUrl` comes from `publicHelpCenterUrl`
    (`apps/api/src/help-center/site/site-url.ts`).
- **Outstanding:** the screen-reader, zoom and forced-colours pass listed in
  the [audit](../completed/accessibility-audit.md#still-to-do-by-a-person).

## Exit criteria

Copied from the PRD, ticked as they are met.

- [ ] All success metrics in §2 are met and recorded, including the AI evaluation thresholds and the restore drill.
- [ ] `ghcr.io/docker-hunterpedia/helpdock:1.0.0` is published and the README install instructions work against it.

## Open questions

- ~~**Outbox event concurrency.**~~ Settled: events run eight at a time,
  ordered per ticket ([M9-03 outbox concurrency](#m9-03-outbox-concurrency),
  ADR 0023).
- **ZAP's first release run** will tell which passive alerts need a line in
  `.zap/rules.tsv`. The image could not be built in the development sandbox
  (Docker Hub rate limit), so the stack script has not run end to end yet.

## M9-02 ASVS Level 2

[`docs/completed/asvs-l2.md`](../completed/asvs-l2.md): 258 requirements, each
Met, Partial, Gap, N/A or Operator with the code, test or configuration that
answers it. The gaps to file as issues before 1.0, in the order an attacker
would meet them: no email on a credential change (2.2.3, 2.5.5), no
breached-password check (2.1.7), TOTP codes not remembered as used (2.8.4),
no strength meter or show-password toggle (2.1.8, 2.1.12; needs an artboard),
no idle expiry on a session (3.3.2), no `__Host-` cookie prefix (3.4.4), a
second factor for admins that is a setting rather than a rule (4.3.1), sign-in
failures not audited (7.1.3, 7.2.1), no alert on rate-limit refusals (8.1.4),
no contact export (8.3.2) and no `Content-Disposition` on JSON (14.4.2). M6,
M7 and M8 each re-walk the chapters they touch.

## M9-02 Closing the gaps

Every gap and partial the walk-through listed is closed, each with tests and
its row in [asvs-l2](../completed/asvs-l2.md) updated (198 Met, 33 Partial,
0 Gap).

- **Credential-change email (2.2.3, 2.5.5).** A `securityChange` auth email —
  password changed or reset, second factor on or off, recovery codes redrawn —
  through the `auth.email_requested` outbox path, in the change's own
  transaction from inside a session, `en` and `ar`.
- **Breached passwords (2.1.7).** A bundled list (46 146 entries, SecLists,
  MIT) checked in process wherever a password is set; `password-breached`
  drawn on the field ([ADR 0021](../decisions/0021-bundled-breached-password-list.md)).
- **Show-password toggle and strength meter (2.1.8, 2.1.12).**
  `Admin/PasswordField` (`apps/admin/src/ui/password-field.tsx`) on accept
  invitation, reset, Account › Security and the wizard's admin step; errors
  shown after the api answers, `en` and `ar`.
- **TOTP replay (2.8.4, 2.8.5).** The last accepted step per account is kept
  in Redis (`auth:totp-step:<user>`), compare-and-set; a replay is refused,
  logged and audited.
- **Session limits (3.3.2).** `AUTH_SESSION_IDLE_MINUTES` (240) and
  `AUTH_SESSION_MAX_HOURS` (12) in `.env.example`.
- **Cookie prefix (3.4.4).** `__Secure-hd_refresh` / `__Secure-hd_trust` over
  https; `__Host-` declined to keep `Path=/api/auth`, recorded as a deviation.
  Upgrading renames the cookies, so every browser signs in once more.
- **2FA for Admins (4.3.1).** Required for every Admin and install admin
  whatever `auth.require2fa` says. An existing one without a factor keeps their
  session until it ends and is sent to enrolment at the next sign-in, which now
  works without a session: `POST /api/auth/enrolment/start` and `/confirm`
  spend the `totp-enrolment-required` challenge, and the enrolment screen
  takes it from sign-in, the sign-in link, OAuth and invitation acceptance.
  Before this, that path needed a session it did not have.
- **Auth audit trail (7.1.3, 7.2.1).** `auth.*` rows in install scope, written
  by the `auth` system principal in transactions of their own, with address
  and user agent from the request context
  ([ADR 0022](../decisions/0022-auth-audit-trail-in-install-scope.md)). Closes
  M0's "own-account actions write no audit_log row".
- **Rate-limit alerting (8.1.4, 11.1.8).** `rate_limit_refusals_total{bucket}`
  on every limit, and an alert in the operations guide.
- **Contact export (8.3.2).** `GET /api/brands/:brandId/contacts/:contactId/export`,
  Admin only, audited as `contact.exported`. API only: the contact artboards
  have no button for it.
- **`Content-Disposition` on JSON (14.4.2).** `attachment; filename="api.json"`
  on every JSON answer that did not choose its own.

The integration suites now sign in through `apps/api/src/testing/staff-sign-in.ts`,
which enrols the seeded Admin's authenticator on first use and trusts the
browser after, and `e2e:api` takes a fresh authenticator step per sign-in
(`apps/admin/e2e/api/totp.ts`).

## M9-03 Outbox concurrency

`outbox.event` ran one job at a time, so every side effect queued behind every
other. Reviewing the subscribers (SLA, rules, notifications, email, Telegram,
widget relay, assignment, CSAT, help center, attachments) showed they assume
one ticket's events run one at a time and in order, and nothing across
tickets. So the worker now runs `OUTBOX_CONCURRENCY` (8) at once with
per-ticket ordering keys: chained in process in relay order, and an advisory
lock per key across replicas
([ADR 0023](../decisions/0023-outbox-events-ordered-per-ticket.md)).
`consumer.integration.test.ts` proves one ticket's events run in written order
without overlapping while tickets overlap each other, and fails with the
serializer off.

`perf:realtime` was rerun on the shared sandbox (20 visitors, 2 agents, five
replies a second, 30 s), interleaving `OUTBOX_CONCURRENCY=1` and `8` so both
saw the same machine. The sandbox was shared with other builds at a load
average of 13 to 47 on 4 vCPU, and the spread between consecutive runs of the
same setting was larger than the effect: at a load near 30, one at a time
gave p95 6.7–7.6 s in all three runs, eight at a time 0.8 s in one and 6.6 s in
another; at a load near 15–20 both stayed under 1.1 s. The numbers are in
[performance](../guides/performance.md#results). The sandbox cannot settle
whether the gate holds; the §14 host run can, and is still to do.

## M9-03 Load tests

`apps/api/src/testing/perf/`, explained in
[performance](../guides/performance.md). The stack table has no load tool and
none was added: the M1-15 harness (`fetch`, Testcontainers, the api from
`dist/`) already drives real HTTP, so it was extended rather than replaced.

- `stack.ts`: the containers, migrations, seed and api processes every suite
  shares, now with an optional worker. `perf:tickets` moved onto it unchanged.
- `load.ts`: visitors without a token, TTFB (`until: 'headers'`), and
  scenarios that share a name reported as one. Unit-tested against a local
  server (`load.test.ts`).
- `perf:help-center`: 2 000 articles in `en` and `ar` (`help-center-dataset.ts`),
  cold render gated at 800 ms p95, cached TTFB at 200 ms p95 per page kind.
- `perf:realtime`: api replicas and a worker, 200 widget visitors each sending
  a message a minute, agents replying; agent reply → widget socket gated at
  500 ms p95, any lost reply fails.

Smoke runs on the shared sandbox passed the help center gates with a wide
margin and the realtime gate at one reply a second; no index or cache change
was made. Still to do: the full run on the §14 host for all three suites,
recorded in the guide's Results table.

## M9-05 Semgrep, ZAP, SBOM

- **Semgrep**: `.semgrep/helpdock.yml`, six rules for the engineering rules a
  type checker cannot see — undeclared route, `fetch` on a non-constant URL
  outside `packages/net`, BullMQ in a request-path module, a job added in a
  handler or listener, `any` without a reason, a secret-looking key in a log
  call. Fixtures in `.semgrep/helpdock.ts`; the `semgrep` job in `ci.yml` runs
  them, then the scan, and is part of the required `ci` check. The two OAuth
  provider calls carry a `nosemgrep` with their reason. Renovate tracks the
  pinned CLI.
- **ZAP**: `.github/workflows/zap.yml` on `release/**`, `v*` tags and by hand —
  the image from the commit, `scripts/zap-stack.sh` (the smoke test's stack,
  sharing `scripts/compose-env.sh`), past the first-run wizard, ZAP's baseline
  scan with `.zap/rules.tsv`. The release procedure runs it on the version pull
  request's branch before merging ([release](../guides/release.md#the-short-version)).
- **SBOM**: already in `release.yml` (`anchore/sbom-action`, CycloneDX, from the
  pushed image, attached to the Release).
- **Dependency audit**: `pnpm audit --audit-level high` added to `ci.yml`'s
  `checks`, which ARCHITECTURE §15 lists and CI did not run.
- Guide: [security scanning](../guides/security-scanning.md).

## M9-08 Release pipeline

Verified against ARCHITECTURE §16; nothing was missing in the workflows.
`changesets.yml` keeps the version pull request open and, once it merges, tags
`v<version>` and calls `release.yml`, which builds `linux/amd64` and
`linux/arm64` with QEMU and Buildx, pushes `:<version>` and `:latest` (not for
pre-releases) to GHCR with the run's own token, generates the CycloneDX SBOM
from the pushed image and creates the Release from the `CHANGELOG.md` section
plus GitHub's generated notes. What remains is the external dependency in the
PRD: making the GHCR package public and the image signing key.

## M9-06 User docs

The PRD's list, each page checked against the code it names (every command,
env key, route and file):

- **Install** ([install](../guides/install.md)): the README's install section
  and the guide pull `ghcr.io/docker-hunterpedia/helpdock:<version>` with the
  release's own Compose file; upgrades and backups now point at operations.
- **Configuration** ([configuration](../guides/configuration.md)) is
  generated: `renderConfigurationReference` (`packages/config/src/reference.ts`)
  renders the bootstrap keys from `envSchema` and the comments in
  `.env.example`, the Compose-only keys from `docker/docker-compose.yml`
  (`${KEY:?}` required, `${KEY:-x}` defaulted), and every `HD_*` setting from
  the registry. `reference.test.ts` snapshots the page, so a key added to the
  schema, the registry or `.env.example` without regenerating the page fails
  the unit tests, as does a key in `.env.example` that nothing reads.
- **Channels** ([channels](../guides/channels.md)): one page over email,
  Telegram, the widget, the web form and the API, and what they share.
- **Security** ([security](../guides/security.md)): the threat model in brief,
  tenancy, secrets, outbound requests, uploads, sessions, headers and the
  operator's list, each pointing at the ASVS evidence.
- **Operations** ([operations](../guides/operations.md)): backups, restoring,
  upgrading, rotating the master key, and losing Redis.
- Help center, AI, API and widget protocol already existed and were checked
  for drift; only links changed.

Master key rotation, which the operations page needed to describe, is
`rotateMasterKey` (`packages/db/src/master-key-rotation.ts`): one transaction
over every envelope column (`ENVELOPE_COLUMNS`), the secret rows of
`settings`, and sign-in links still unpublished in the outbox, under the
runtime role with every brand in scope, audited as
`install.master_key_rotated`. A value neither key opens rolls the run back and
names the place. `master-key-rotation.test.ts` fails when the schema gains a
secret-looking column that is on neither list; the integration test proves
every brand's secrets open under the new key alone, published outbox rows and
plain settings are untouched, a second run changes nothing, and the rollback.
`node dist/cli.js keys rotate` (`apps/api/src/cli.ts`) runs it from the image.
Found on the way: a rotation would have locked every staff member out, because
password hashes are peppered from the master key; `PasswordHasher` now
verifies under `APP_MASTER_KEY_PREVIOUS` too and re-hashes at that sign-in.

## M9-07 Onboarding test

`scripts/onboarding-run.sh` is the machine half of REQUIREMENTS §7: a
throwaway stack from the image, the first-run wizard, the admin's first
sign-in with the second factor enrolled, a second brand, each brand's widget
allowed on its own site with a visitor starting a conversation from each, the
web form switched on and sent, and the agent finding and answering a ticket,
each step timed through the same HTTP calls the admin, the widget and the form
make. Local runs are in [onboarding-test.md](../completed/onboarding-test.md).
**Still to do by people:** the clean-VM run with a stopwatch (Telegram
included, which needs a bot and a reachable host) and the usability pass with
three outside testers on the three-click reply task; the document has the
tables to fill in.

## M9-10 Restore drill

`scripts/restore-drill.sh` (`backup`, `restore`, `verify`, and `rehearse` for
a local run on two throwaway stacks) with [restore drill](../guides/restore-drill.md)
as the runbook. Backup is `pg_dump -Fc`, the bucket through `mc` from the
image the Compose file pins, and `.env`, with row counts, an object hash list
and the hash of an attachment as the api serves it; verify compares all of
them and signs in with the second factor; rehearse then rotates the master
key on the restored stack and signs in under both keys and the new one alone.
Local rehearsals are in [restore-drill.md](../completed/restore-drill.md).
**Still to do by a person:** the drill for the record on a clean VM against
the one-hour target.

## Gaps carried from earlier milestones

Closed on this branch, each with unit and integration tests and its guide
updated:

| Gap | From | Now |
|---|---|---|
| Auto-unassign ignored business hours | M1, M3 | `assignment.offline_unassign` reads the department's calendar and, while it is closed, puts itself off to the next opening (`deferredTo` in the payload) |
| The first-run wizard did not generate the VAPID pair | M3, ADR 0002 | Finishing the wizard generates it when the install has none and nothing is pinned in `.env`; audited as `install.setup.push` |
| `agents_online` was always empty against a real api | M4 | Availability and the `presence` frame carry `agents` (first names, up to five, empty when the brand hides agents); `apps/widget/src/transport/map.ts` maps them |
| Socket events were not rate-limited | M0 | `room:join` 120, `presence:set` 30, `presence:heartbeat` 60 per person per minute in Redis; over budget answers `rate_limited` |
| Revocation was per person, not per browser | M0 | `principal.revoked` carries `familyIds`; only those browsers' sockets close |

## Pull requests

- None yet.
