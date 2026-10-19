# M9 Hardening and 1.0

Status: in progress
Started: 2026-10-05
Owner: @Docker-Hunterpedia

## Scope

Full deliverable list and specs: [PRD §4 · M9 Hardening and 1.0](../planning/PRD.md#m9-hardening-and-10).
Depends on everything above; M6, M7 and M8 shipped on 2026-10-07 (#147), which also carried M9's code-side work. What remains needs people and hardware: the external pentest, the §14 host run, the outside usability testers, the clean-VM onboarding run and restore drill, and the 1.0.0 tag; they are tracked as external dependencies.

## Deliverables

| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M9-01 | External pentest of widget + API; fix all High and Medium findings | #153 | the internal pre-pentest review is done and F1 to F6 and N1 are fixed (F3 for sockets only) ([record](../completed/internal-security-review.md), [notes](#m9-01-internal-pre-pentest-review)). The external pentest ([statement of work](../planning/pentest-scope.md)): **owner confirmed complete on 2026-10-19; the results are held by the owner and are not recorded in this repository.** |
| M9-02 | OWASP ASVS L2 checklist walk-through with evidence recorded in `docs/completed/` | | shipped (#147): walked, and all 11 gaps closed ([notes](#m9-02-closing-the-gaps)); 3.4.4 closes with a recorded deviation. The re-walk of M6, M7 and M8 (2026-10-09) found more; its gaps were closed in #167 on 2026-10-11 ([record](../completed/asvs-l2.md), [notes](#m9-02-re-walk-of-m6-m7-and-m8)): 198 Met, 35 Partial, 0 Gap, 24 N/A, 1 Operator. 7.2.1, 2.10.1 and 3.5.2 stay Partial |
| M9-03 | Load tests | #154 | suites shipped (#147) and smoke-run; outbox concurrency raised ([notes](#m9-03-outbox-concurrency)); the §14 host run: **owner confirmed complete on 2026-10-19; the results are held by the owner and are not recorded in this repository.** |
| M9-04 | Accessibility audit (axe + manual keyboard) on widget and help center | #155 | the automated checks landed: axe (#147), and since 2026-10-09 zoom, forced colours, screen-reader markup and mixed direction as Playwright specs ([notes](#m9-04-accessibility-audit); results in [accessibility-audit.md](../completed/accessibility-audit.md)); the screen-reader pass ([runbook](../guides/screen-reader-pass.md)): **owner confirmed complete on 2026-10-19; the results are held by the owner and are not recorded in this repository.** |
| M9-05 | Semgrep rules for Nest, ZAP baseline scan on release branches, SBOM on release | #152, #156 | shipped (#147): [notes](#m9-05-semgrep-zap-sbom); #152 patches the open Fastify advisory; the first release-tag ZAP run passed and #156 is closed |
| M9-06 | User docs under `docs/guides/` | | shipped (#147): every guide on the PRD's list exists and is checked against the code ([notes](#m9-06-user-docs)); README install path tried against the published image and a local build |
| M9-07 | Onboarding test on a clean VM against the 30-minute target; usability pass with three outside testers | #150, #157 | tooling shipped (#147) and run locally ([notes](#m9-07-onboarding-test)); internal usability fixes are in #150; the clean-VM run and the three outside testers (#157): **owner confirmed complete on 2026-10-19; the results are held by the owner and are not recorded in this repository.** The record would go in [onboarding-test.md](../completed/onboarding-test.md). |
| M9-08 | Release pipeline | #158 | public multi-architecture image and SBOM verified on `v0.4.0`; keyless Cosign signing implemented, and `v0.4.0` signed under it on 2026-10-09 by the Release workflow's manual mode (run 37928180052); #158 closed that day ([notes](#m9-08-release-pipeline)) |
| M9-09 | Tag `1.0.0` | #159 | planned after every release gate passes |
| M9-10 | Restore drill | #160 | tooling shipped (#147) and rehearsed locally, master key rotation included ([notes](#m9-10-restore-drill)); the drill on a clean VM: **owner confirmed complete on 2026-10-19; the results are held by the owner and are not recorded in this repository.** The record would go in [restore-drill.md](../completed/restore-drill.md). |

## M9-01 Internal pre-pentest review

An internal review of the widget and API surface found no High finding, two
Medium and four Low, and N1 was found while fixing F1. This is what became of
them; the [record](../completed/internal-security-review.md) keeps the traces. The
external test is still to be booked and run; its findings are fixed under this
deliverable too.

| Id | Finding | Outcome |
|---|---|---|
| F1 (Medium) | `/widget` socket events bypassed every throttle | Fixed. Every event spends a 120-a-minute per-visitor budget in Redis before it is parsed or reaches Postgres ([widget protocol](../guides/widget-protocol.md#throttles)). No per-address socket budget: see the note below. |
| F2 (Medium) | `TRUST_PROXY=true` with `Caddyfile.cloudflare` keyed every per-address limit on Cloudflare's edge | Fixed. `TRUST_PROXY` takes an address list; Compose sets `uniquelocal`; the Cloudflare Caddyfile trusts Cloudflare's ranges and forwards `CF-Connecting-IP` ([install](../guides/install.md#behind-cloudflare)). The review proposed a hop count, which Fastify 5 answers by trusting nothing, so none is offered. |
| F3 (Low) | A widget socket outlived the identity link that granted its rooms | Fixed: sockets are disconnected and SSE streams are ended, on every replica, when the link is withdrawn or changed. A removed origin or rotated signing secret does not disconnect sockets either. |
| F4 (Low) | OAuth callback not bound to the browser that started it | Fixed with the `hd_oauth` cookie ([authentication](../guides/authentication.md#oauth)). |
| F5 (Low) | API keys and webhook deliveries ignored a brand's deletion grace | Fixed: `410` for the key, `skipped` for the delivery. |
| F6 (Low) | The magic link is spent by a `GET` | Fixed. The email links to the admin's confirm screen `/sign-in/magic#token=…` (`Admin/SignIn-MagicLink`, `-AR`). It shows the account from `POST /api/auth/magic-link/preview`, which spends nothing, and spends the link only on Continue with `POST /api/auth/magic-link/consume`; the old `GET` link only redirects there ([authentication](../guides/authentication.md#the-sign-in-link-and-the-password-reset)). |
| N1 (not rated) | The `/widget` handshake keyed its `widget-ip` budget on Caddy's address, so every visitor of a brand shared one | Fixed. The handshake resolves the client address the way Fastify resolves `request.ip`, under the same `TRUST_PROXY`, so a socket and a REST call from one visitor spend one budget and two visitors behind Caddy spend two ([widget protocol](../guides/widget-protocol.md#throttles)). |

**Outstanding from this review**

- **Live checks for the vendor** (the proxy half of F2 was checked against
  Caddy 2.10 here, not on a Cloudflare zone): the real `request.ip` through
  Cloudflare, and the cluster-wide disconnect of F3 across two replicas.

## M9-04 Accessibility audit

- **Automated.** `apps/widget/e2e/a11y-audit.spec.ts` runs axe (WCAG 2.1 A and AA)
  on every widget mode and state, and `apps/api/e2e/help-center-a11y.spec.ts`
  on every help center page type, including the 404, 410 and internal-only
  wall. Both run in `en` and `ar`, light and dark, and both are in the CI jobs
  that already run those Playwright projects.
- **Keyboard.** Tab order and a visible ring on every stop, the skip link,
  Escape, and the widget's focus trap at phone width.
- **Zoom, forced colours, screen-reader markup, mixed direction** (2026-10-09).
  `a11y-reflow`, `a11y-forced-colors`, `a11y-semantics` and `a11y-bidi` in
  `apps/widget/e2e/`, and `help-center-a11y-reflow`, `-forced-colors`,
  `-semantics` and `-bidi` in `apps/api/e2e/`, in `en` and `ar`; what each
  proves is in the [audit](../completed/accessibility-audit.md#beyond-axe-zoom-forced-colours-screen-reader-markup-mixed-direction).
- **Fixed.**
  - The help center has a skip link, and every `<main>` can take focus.
  - Article body links are underlined. Axe found them told apart by colour
    alone in dark mode.
  - At phone width the widget is a modal dialog that keeps Tab inside it, and
    the launcher no longer covers Send.
  - The widget's theme sheet is replaced only when it changes, and the e2e axe
    helper waits for the widget to settle. This addresses the M4 flake.
  - The help center's search field shrinks at 320 px; its pressed "No" has a 2 px
    edge that survives forced colours; a search result in the other language
    carries `dir` as well as `lang`.
  - The widget's thread is the only live region of a conversation (the thanks,
    the rated card and its "not sent" line lost their `status` and `alert`
    roles), and emails and references in Arabic sentences are `<bdi>`.
- **Closed M5 gaps** with existing artboards:
  - "What was missing?" after a "No" (`HelpCenter/Article-AR` panels 2 and 3).
    The form takes an optional `comment` (`hcFeedbackFormSchema`), and the
    step travels in `?feedback=no`.
  - The CSAT page's "Browse the help center" (`CsatEN`).
    `csatBrandSchema.helpCenterUrl` comes from `publicHelpCenterUrl`
    (`apps/api/src/help-center/site/site-url.ts`).
- **Outstanding:** only what needs a person, listed in the
  [audit](../completed/accessibility-audit.md#still-to-do-by-a-person): the
  screen-reader pass, the embedded video player, and brand custom CSS.

## Exit criteria

Copied from the PRD, ticked as they are met.

- [ ] All success metrics in §2 are met and recorded, including the AI evaluation thresholds and the restore drill.
- [ ] `ghcr.io/docker-hunterpedia/helpdock:1.0.0` is published and the README install instructions work against it.

## Open questions

- ~~**Outbox event concurrency.**~~ Settled: events run eight at a time,
  ordered per ticket ([M9-03 outbox concurrency](#m9-03-outbox-concurrency),
  ADR 0023).
- ~~**ZAP's first release run.**~~ Settled on `v0.4.0`: the release-tag run
  passed 62 checks across 16 URLs with 0 failures and 0 warnings. No new
  `.zap/rules.tsv` exception was needed.
- ~~**Magic link spent by a `GET` (M9-01 F6).**~~ Fixed: the confirm screen at
  `/sign-in/magic` spends the link only on a click
  ([internal review](../completed/internal-security-review.md)).
- ~~**Handshake address budget (M9-01 N1).**~~ Fixed: the `/widget` handshake's
  address is resolved under `TRUST_PROXY`, with a test through a trusted proxy
  ([review](#m9-01-internal-pre-pentest-review)).
- ~~**Telegram empty welcome (M6 gaps).**~~ Settled: an empty welcome sends
  the default welcome in that language, as the code and the guide do; a bot
  that says nothing after `/start` looks broken. `Admin/Channels-Telegram`'s
  hint now says so.
- ~~**"AI answered" on the ticket list (M7 gaps).**~~ Settled: the ticket's `ai`
  state carries `answeredAt` from `tickets.ai_answered_at`, which the auto-reply
  job sets with its first answer, and the list says "AI answered" only once it is
  set ([gaps table](#gaps-carried-from-earlier-milestones)).

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
its row in [asvs-l2](../completed/asvs-l2.md) updated (the summary now
reads 198 Met, 35 Partial, 0 Gap, 24 N/A, 1 Operator).

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
browser after. `e2e:api` signs the seeded account in once per worker, in a
browser context every spec gets a page of (`apps/admin/e2e/api/admin-session.ts`),
taking a fresh authenticator step when it does (`apps/admin/e2e/api/totp.ts`):
signing in per test ran past the twenty attempts an address gets in fifteen
minutes and waited for the clock before each code. The Compose smoke test
(`scripts/compose-smoke.sh`) walks the wizard's administrator through the
enrolment the first sign-in now demands, computing the code from the secret
the api hands back.

## M9-02 Re-walk of M6, M7 and M8

The re-walk of 2026-10-09 found a second set of gaps in the chapters M6, M7 and
M8 touched. The ones fixable in code are closed, each with tests and its guide
updated; the rows of [asvs-l2](../completed/asvs-l2.md) changed on 2026-10-11 in
#167:

- **Webhook events and scopes (4.1.3).** `webhooks:manage` alone cannot
  subscribe to events whose data needs `tickets:read`, `contacts:read` or
  `articles:read`: create, update, rotate and replay answer 403
  `webhook-event-scope`.
- **DOCX unpacking (12.1.2).** At most 1,000 entries and 100 MiB declared, and
  each entry is inflated once up to its declared size, before mammoth runs.
- **Erasure (8.3.2).** "Anonymise contact" also deletes the contact's Telegram
  chats, clears the redaction maps of AI calls on their tickets and deletes the
  webhook deliveries that carry their data.
- **Delivery logs (8.3.8).** The nightly run deletes webhook and Telegram
  deliveries after 30 days and idempotency keys after 24 hours.
- **Model endpoints (12.6.1, 9.2.2).** A provider, embeddings or transcription
  URL is checked when saved, by the check webhook endpoints pass.
- **Refused keys (7.2.1).** A warning with the key prefix and address, and an
  `api_key.refused` audit row for a revoked or expired key. The Telegram secret
  refusal is not logged yet, so 7.2.1 stays Partial.
- **Cache-Control (8.2.1).** `no-store` on every JSON answer that did not choose
  its own.
- **OpenAPI version (14.3.3).** The public document shows the API version, `1`.
- **Key expiry (2.10.1, 3.5.2).** Optional `expiresAt` on a key (migration
  0049). API only: the Create dialog draws no field, so the screen waits for an
  artboard.
- **Also fixed:** the connector OAuth `state` is single-use; an API key gets 403
  on `@Authenticated` staff routes instead of a 500.

Not done, and why: re-authentication before creating a key (3.7.1) and a field
and column for the key's expiry need the Create dialog changed, so an artboard
first; PKCE for Google Drive; running the DOCX read in a worker with a memory
limit; checking a provider's base URL again before each chat completion (chat
completions go through the vendors' clients, so the save-time check is the only
one, [ADR 0018](../decisions/0018-pi-ai-provider-layer.md)).

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
  The first release-tag run, on `v0.4.0`, passed with 0 failures, 0 warnings,
  7 informational alerts, 1 ignored rule and 62 passes across 16 URLs (#156).
- **SBOM**: already in `release.yml` (`anchore/sbom-action`, CycloneDX, from the
  pushed image, attached to the Release).
- **Dependency audit**: `pnpm audit --audit-level high` added to `ci.yml`'s
  `checks`, which ARCHITECTURE §15 lists and CI did not run. Transitive
  advisories whose dependants have not bumped are pinned past the vulnerable
  range in `pnpm-workspace.yaml` › `overrides`, one reason each.
- **CodeQL**: the first full run's nineteen alerts were fixed in code
  (polynomial regexes rewritten as string scans, URL hosts compared parsed,
  `crypto.getRandomValues` for the mock webhook secret, comment and script
  stripping run until stable, backslashes escaped in the eval report).
  `.github/codeql/codeql-config.yml` turns off `js/insufficient-password-hash`,
  which reads the SHA-256 of a 256-bit API key and the HMAC over an OAuth
  state as password hashing, with the reason beside it.
- Guide: [security scanning](../guides/security-scanning.md).

## M9-08 Release pipeline

Verified against ARCHITECTURE §16 and exercised on `v0.4.0`.
`changesets.yml` keeps the version pull request open and, once it merges, tags
`v<version>` and calls `release.yml`, which builds `linux/amd64` and
`linux/arm64` with QEMU and Buildx, pushes `:<version>` and `:latest` (not for
pre-releases) to GHCR with the run's own token, generates the CycloneDX SBOM
from the pushed image and creates the Release from the `CHANGELOG.md` section
plus GitHub's generated notes. The public `v0.4.0` image was pulled without
registry credentials and its index contains both architectures; its SBOM is
attached to the GitHub Release.

The workflow now keylessly signs that immutable index digest with Cosign and a
short-lived GitHub OIDC/Fulcio certificate, then verifies the exact workflow
identity and issuer. No signing key or secret is stored. A manual mode signs an
existing tag without rebuilding or moving it. It signed `v0.4.0` on 2026-10-09
(run 37928180052, success), and #158 was closed that day. Signing and the check
against the workflow identity run in the same job; checking the signature from
outside is the procedure in the [release guide](../guides/release.md#verify-the-image-signature).

`v0.5.0` (2026-10-13) was the first release to go through the Changesets path
with signing on, and it failed its own verification after the image was pushed
(run 38387367580): the workflow expected the certificate to name the tag
because the event was `push`, but a reusable workflow called from a push to
`main` runs under `refs/heads/main`, which is what the certificate carried. The
identity is now `GITHUB_REF` in every mode, and the manual **Run workflow**
mode finishes a release whose tag has no GitHub Release yet (SBOM and Release
from the published image), which is how `v0.5.0` was completed. The procedure
is in the release guide's
[If something goes wrong](../guides/release.md#if-something-goes-wrong).

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
The 2026-10-08 internal usability pass also corrected the shared field layout
on TOTP enrolment, staff invitation and new-ticket forms (external labels and
hints no longer collide with their controls), and keeps a long active-session
user agent beside a one-line Sign out action. EN and AR browser regressions
cover all four layouts. It also closed the stale M0 install-Settings placeholder
with the approved Authentication artboard and its real install-admin API.
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

Closed, each with unit and integration tests and its guide updated (the last row after #147; the #174 and #179 rows are admin-only and have unit and component tests):

| Gap | From | Now |
|---|---|---|
| Auto-unassign ignored business hours | M1, M3 | `assignment.offline_unassign` reads the department's calendar and, while it is closed, puts itself off to the next opening (`deferredTo` in the payload) |
| The first-run wizard did not generate the VAPID pair | M3, ADR 0002 | Finishing the wizard generates it when the install has none and nothing is pinned in `.env`; audited as `install.setup.push` |
| `agents_online` was always empty against a real api | M4 | Availability and the `presence` frame carry `agents` (first names, up to five, empty when the brand hides agents); `apps/widget/src/transport/map.ts` maps them |
| Socket events were not rate-limited | M0 | `room:join` 120, `presence:set` 30, `presence:heartbeat` 60 per person per minute in Redis; over budget answers `rate_limited` |
| Revocation was per person, not per browser | M0 | `principal.revoked` carries `familyIds`; only those browsers' sockets close |
| The widget's out-of-hours handoff line was the ordinary one | M7 | A conversation and its `conversation` frame carry `hours` (its department's calendar, else the brand's); after a handoff the line takes the `moon` and says when the team opens in its zone and that the message is saved (`Widget/AI-EN`, `-AR` panel 6). The header and strip read the same hours; `widget.js` is 30.27 KB gzipped |
| The Telegram language prompt was the catalog's, not the bot's | M6 | Each bot has its own `language_prompt` (migration `0048`), edited on the bot's page under Channels › Telegram; `/start` asks with it first ([M6-04](../completed/M6-telegram.md#m6-04-start-and-the-language-pick)) |
| The ticket list drew no AI state, and "AI paused" was not drawn | M7 | A row's caption line ends with "AI paused" while the conversation is handed off, or "AI answered" once the assistant has sent an answer and is not paused (`Admin/Ticket-AI`, `apps/admin/src/screens/tickets/ai/ticket-ai-mark.tsx`). The answer is read from the ticket's `ai.answeredAt` (`tickets.ai_answered_at`), so a conversation handed back to the assistant before it ever answered says nothing |
| Agent assist sent the brand's main system prompt for an Arabic ticket | M7 | Every assist call passes the ticket's language to `complete()`, which sends `systemPromptAr` for an Arabic ticket, as auto-reply does ([M7 gaps](../completed/M7-ai.md#gaps-and-follow-ups)) |
| Agent assist never appeared in a production build | M7 | `HttpAssistApi` built `/api/brands/…` paths on top of the transport's own `/api`, so every call went to `/api/api/…` and 404ed and the composer read assist as off. The paths now start at `/brands/`, and `apps/admin/src/assist/http-api.test.ts` drives every method through the real `HttpTransport` (#174) |
| The collision indicator named a colleague by id for an Agent | M1 | Viewers were named from `GET /staff` alone, which an Agent cannot read. `staffName` (`apps/admin/src/screens/tickets/directory.ts`) names them as the assignee picker does: the department's `assignable` read, then the staff read, then a shortened id (#174) |
| The SLA card said "No SLA policy applies" after a note arrived over the socket | M1, M4 | The ticket view's realtime catch-up rebuilt the cached ticket field by field and left out `sla` and `csat`, so the card lost its policy until a reload. `detailAfterCatchUp` (`apps/admin/src/screens/tickets/use-ticket-realtime.ts`) keeps everything the fresh read carries and replaces only the thread and the activity (#179) |
| The ticket's contact card did not show the contact's other tickets | M1 (M1-04) | The details panel's Previous tickets (`Admin/Ticket-ContactHistory`, `apps/admin/src/screens/tickets/previous-tickets.tsx`) lists the three most recent other tickets the viewer may open, as links with their status, counts all of them, keeps the hidden count under them and links to the contact page; a first ticket says so. The count is the timeline's new `visibleCount`, since its `items` stop at 50, and the badge reads each item's new `statusId` ([tickets guide](../guides/tickets.md#previous-tickets-on-the-contact-card), #237) |

## Pull requests

- #147 feat: M6 Telegram, M7 AI, M8 API/webhooks/reports and M9 hardening towards 1.0 (M9-02, M9-04, M9-05, M9-06; the M9-03 suites and the M9-07 and M9-10 tooling; the carried gaps above)
- #167 feat: M9 hardening towards 1.0: the pre-pentest fixes (M9-01 F1 to F5), the ASVS re-walk's gaps (M9-02), the automated zoom, forced-colours, semantics and bidi specs (M9-04), the signing of `v0.4.0` (M9-08) and the M6 and M7 gaps carried above. Open when this record was written.
- #175 fix: agent assist reaches the api in production builds, and the collision indicator names colleagues for Agents (the two #174 rows in the gaps table above)
- #239 feat: previous tickets on the ticket's contact card (the #237 row in the gaps table above)
