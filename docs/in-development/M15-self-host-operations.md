# M15 Self-host operations

Status: in progress — #337 pulls forward M15-08 and the platform-template portion of M15-13
Owner: @Docker-Hunterpedia
Phase: 5 — 1.x. Proposed release: 1.2 (owner decision D-01)
Depends on: M9 (release pipeline, restore drill, `keys rotate`), M11 (the import writer, for sample data)
Effort: about 67 working days for one person (see Deliverables)
PRD: [Phase 5 · M15](../planning/PRD.md#m15-self-host-operations)
Owner decisions: D-33 to D-39 in [decisions-1-x.md](../planning/decisions-1-x.md#m15-self-host-operations)
ADRs (proposed): [0039](../decisions/0039-signed-release-bundle-and-installer.md), [0040](../decisions/0040-automatic-updates-opt-in-and-delayed.md), [0041](../decisions/0041-helpdock-ctl-in-posix-sh.md), [0042](../decisions/0042-update-checks-send-nothing-about-the-install.md), [0043](../decisions/0043-sample-brand-through-the-import-engine.md), [0044](../decisions/0044-supported-deploy-targets.md)

One signed command from a bare Linux VM to a healthy Helpdock, one verb for every later chore, update and backup state on the System page, and a removable bilingual sample brand.

**Effort convention.** Working days for one experienced contributor working with
AI agents, with the Definition of done included: tests, docs and review fixes.
M11's 1.0 scope was estimated at 63 days and merged in about five calendar days;
it then needed several review-fix PRs, and its connectors grew far past their
3-day estimates. These are therefore honest person-days. Calendar time with agents
will be shorter, but review, real-environment verification and signing set-up take
human time that agents do not shorten.

## Goal

An operator gets from a bare Linux VM to a signed, pinned, healthy Helpdock with one
command. Each later chore — backing up, restoring, upgrading, rotating the master
key, checking health — is one verb that cannot silently lose data. The System page
says when a new release is out and when the last backup was taken. Someone
evaluating Helpdock can fill a brand with realistic bilingual sample data and remove
it with one click.

Success measure: the PRD §2 "30-minute first ticket" onboarding target drops to
**10 minutes** from a fresh VM with DNS already in place. `scripts/onboarding-run.sh`
times it through the installer.

## Prior art and how Helpdock does it

Prior art: OpenDesk (Apache-2.0) ships an install script, an operations CLI,
automatic updates, update notices and test workspaces with sample data. This
milestone covers the same operator needs on Helpdock's own rules: opt-in, signed,
quiet, bilingual from the first artboard, and with no service the project would
have to host.

| Area | How Helpdock does it | Why |
|---|---|---|
| Installer | `curl \| sh`. The `SHA256SUMS` file is **Cosign-signed keylessly by `release.yml`** and checked against the workflow identity; Cosign runs from a digest-pinned container, because Docker is already required. | A checksum fetched from the same place as the file only protects against corruption, not against a compromised release. Helpdock already signs its images this way. |
| Ops CLI | `helpdock-ctl` with backup, restore, upgrade, status and logs, plus `verify` (built on the restore drill), `rotate-key` and an upgrade that **checks or rehearses migrations** first | Helpdock already has the drill tooling and the `keys rotate` CLI. |
| Automatic updates | **Off by default.** Opt-in, patch-only by default, never installs a release younger than 72 hours, and maintainers can veto one release | A self-hosted support desk is business-critical, and a signed but malicious release is the worst case. See [ADR 0040](../decisions/0040-automatic-updates-opt-in-and-delayed.md). |
| Update notices | A check every 6 hours, off with `HD_UPDATE_CHECK=false`, through `safeFetch` with a host allow-list, sending no instance data. Release notes are linked, never rendered. | DOMAIN-RULES §13 |
| Trying it out | A **sample brand**, loaded through the M11 import writer from a bilingual bundle shipped in the image. It never sends, and one click removes it at once. | Reuses the quiet import engine instead of a second seeding path. |

## Scope

In scope:
- the signed release bundle;
- `install.sh` with `--dry-run` and a wizard;
- `helpdock-ctl` with `status`, `logs`, `backup`, `restore`, `verify`, `upgrade`,
  `rotate-key` and `auto-update`;
- opt-in automatic patch updates;
- update notices and Updates and Backups cards on the System page;
- a production object-storage profile;
- an external-proxy Compose override;
- the sample brand;
- a cloud-init recipe and a Coolify template.

## Non-goals

- Kubernetes or Helm (backlog; community).
- Vercel and Cloudflare (architecturally incompatible: long-lived workers,
  Socket.IO and Caddy on-demand TLS).
- A hosted Helpdock.
- Windows or macOS **servers**: the installer supports Linux, and macOS only for
  trying it out with `localhost`.
- Installing Docker for the operator: the installer prints Docker's official
  instructions and stops, because running a third-party script is not Helpdock's
  call.
- Point-in-time recovery or WAL archiving (still linked, not shipped).
- Encrypted backups (open question D-35).
- A separate instance-admin sign-in: Helpdock's install admin already requires TOTP
  (DOMAIN-RULES §12).
- Workspace "suspend" and limit overrides (no billing in Helpdock).

## Deliverables

| Id | Deliverable | Spec | Effort (d) | Depends on |
|---|---|---|---|---|
| M15-01 | **Signed release bundle.** `release.yml` adds four release assets:<br>• `helpdock-deploy-<v>.tar.gz`: `docker-compose.yml`, the overrides, both Caddyfiles, `postgres/init.sql`, `env.template` and `helpdock-ctl`.<br>• `install.sh`.<br>• `release-manifest.json` (below).<br>• `SHA256SUMS` with a Cosign keyless bundle `SHA256SUMS.sigstore.json` (`cosign sign-blob --bundle … --yes`).<br>A release-time step rewrites the bundle's Compose file so every third-party image (`caddy`, `redis`, `pgvector`, `minio`, `clamav`) is pinned by **digest**. `HELPDOCK_IMAGE` carries the Helpdock image as `ghcr.io/…@sha256:…`. The manifest names the digest the workflow signed. | A §16, ADR 0039 | 4 | — |
| M15-02 | **`helpdock-ctl` core:** `status`, `logs [service]`, `backup [dir] [--keep N] [--with-bucket]`, `restore <dir>` (asks you to type `restore`; `-y` skips), `verify <dir>`. The `backup`, `restore` and `verify` functions of `scripts/restore-drill.sh` and `scripts/drill-lib.sh` move into `deploy/lib/ops.sh`. `restore-drill.sh rehearse` becomes a wrapper over them, so the drill and the tool cannot drift. POSIX `sh` plus `docker compose` and `curl`; **no `jq` on the host** (JSON is parsed inside the api container). One lock directory per install. Backup directories are `0700` and hold the dump, `env` (`0600`), `VERSION`, `manifest.json` (row counts and attachment hashes from the drill) and the bucket mirror when the storage is bundled or `--with-bucket` is passed. | D §10, ADR 0041 | 6 | M15-01 |
| M15-03 | **`helpdock-ctl upgrade [vX.Y.Z] [--rehearse]`.** Steps:<br>1. Resolve the target's manifest and verify `SHA256SUMS` with Cosign, then verify the target image's digest signature (`cosign verify` against the release workflow identity).<br>2. Refuse a target below `min_upgrade_from`.<br>3. **Migration check**: run the target image's `node dist/cli.js migrations plan` against the live database read-only, which lists the pending migrations and flags any marked irreversible.<br>4. `--rehearse` restores a fresh dump into a throwaway `pgvector` container and applies the target's migrations there first, with timing.<br>5. Pull while the old version serves.<br>6. Stop api and worker, take a **pre-upgrade backup**, switch the bundle files and `HELPDOCK_IMAGE`, start, and wait up to 5 minutes for `/ready` **and** the new version.<br>7. On failure, put back the previous files and digest, **restore the pre-upgrade backup when the schema changed**, start the previous version, and report.<br>Every outcome is reported to the instance (M15-05). | D §10 | 7 | M15-01, M15-02, M15-05 |
| M15-04 | **`helpdock-ctl rotate-key start\|finish`**: the operations-guide procedure as two verbs. `start` checks that a backup less than an hour old exists (or takes one), moves the key to `APP_MASTER_KEY_PREVIOUS`, writes a new one, restarts and runs `keys rotate`. `finish` removes the previous key, restarts and runs `keys rotate` again, which must change nothing. Never prints a key. | D §10 | 2 | M15-02 |
| M15-05 | **api CLI additions** (`apps/api/src/cli.ts`, which today has `keys rotate`):<br>• `migrations plan --json`: owner role, read-only, compares the image's journal with `drizzle.__drizzle_migrations`.<br>• `ops report --kind backup\|upgrade\|auto-update --result … --detail …`: writes one `install_ops_events` row and an install-scope audit entry.<br>• `version --json`.<br>Plus the `install_ops_events` table and its retention. | A §14 | 3 | — |
| M15-06 | **`install.sh`.** The script, its checks and the wizard are specified in [The installer, the wizard and the checks](#the-installer-the-wizard-and-the-checks). Main function on the last line, so a cut-off download runs nothing. Flags (each also an environment variable):<br>• `--version`, `--dir` (default `/opt/helpdock`), `--admin-host` and `--api-host`, `--email`;<br>• `--storage bundled\|s3`, `--proxy caddy\|external`;<br>• `--wizard`, `-y`, `--no-start`;<br>• `--dry-run` (prints the `.env` it would write with secrets masked, and the files and checks), `--print-env` (unmasked, to stdout, refused when stdout is a terminal);<br>• `--offline <dir>` for a pre-downloaded bundle (still verified).<br>Running it again reconfigures in place and **never regenerates a secret**. | R §5.6, ADR 0039 | 7 | M15-01, M15-07, M15-08 |
| M15-07 | **Bundled object storage for production**: a `storage` Compose profile running MinIO (digest-pinned, the same image as the `dev` profile uses today) with health check, bucket initialisation, a non-root credential and a named volume. `helpdock-ctl backup` mirrors the bucket when this profile is on. The S3 contract is unchanged. | A §17 | 2 | — |
| M15-08 | **Implemented in #337; review pending.** **External-proxy override** `docker-compose.external-proxy.yml`: no Caddy, and the api published on `127.0.0.1:3000`. The guide covers nginx and Traefik site blocks and the **custom-domain limitation**: each verified help-center domain must be added to the proxy by hand, and `/internal/domain-check` has no on-demand certificate counterpart. Needed for Coolify and for operators with an existing proxy. | A §3 | 2 | — |
| M15-09 | **Update notices.** A worker job `system.update_check` runs every 6 hours (jittered) and on demand ("Check now"). It goes through `safeFetch` with the allow-list `api.github.com`, `github.com`, `objects.githubusercontent.com` and `release-assets.githubusercontent.com`, a 30 s limit and a 1 MiB cap. It reads the releases list and the newest stable `release-manifest.json`. It stores `{latest, publishedAt, security, url, minUpgradeFrom}` in install settings. It sends a constant user agent (`Helpdock-update-check`) with **no version, host or instance id**. It is off with `HD_UPDATE_CHECK=false` or the `system.updateCheck` setting. A new release produces one in-app notification to install admins, and an **email only when the manifest marks it `security: true`** (sent through the outbox). Release text is never rendered: the card shows the version, date and security flag and links to the GitHub release. | D §13, R §4.10, ADR 0042 | 4 | M15-01 |
| M15-10 | **Automatic updates (opt-in).**<br>• Commands: `helpdock-ctl auto-update on [--level patch\|minor] [--window 03:00-05:00]`, `off`, `status`, `run`; a systemd timer, or cron where there is no systemd.<br>• A run upgrades through M15-03, never with `--skip-backup`.<br>• Skips: a new major; a pre-release; a manifest with `auto_update: false`; a release **younger than 72 hours** (`--min-age`, default 72 h); a release that failed here before; `HELPDOCK_IMAGE` not a release digest; free disk below twice the last dump size; a failed last `verify`.<br>• Keeps the newest 3 automatic backups.<br>• Reports each run, and emails install admins when one fails. | new D §10.1, ADR 0040 | 4 | M15-03, M15-05 |
| M15-11 | **Sample brand ("Try with sample data").**<br>• A bilingual Helpdock import bundle (`apps/api/sample-data/<v>/{en,ar}.zip`) ships in the image. It holds about 40 tickets across email, widget, Telegram, WhatsApp, form and API with threads, notes and attachments; 25 contacts on reserved domains (`example.com`, `.test`); 12 articles in each language; macros, rules, an SLA policy, business hours and views.<br>• It is loaded **through the M11 `ImportWriter`**, so nothing is sent, nothing is triggered and the original dates are kept. Dates are shifted relative to "now" so reports look alive.<br>• The brand has `brands.is_sample = true` and prefix `SAMPLE`, exempt from prefix reservation.<br>• While the flag is set: a **persistent banner** on every screen of that brand ("Sample data — nothing here is real · Remove sample brand"); a badge in the brand switcher; **every outbound path refuses** at the delivery hooks (email, Telegram, Meta, webhooks, AI calls), and connecting channels is disabled; product metrics, activation and install LLM totals skip it.<br>• **Remove** purges at once (the existing purge, without the 30-day grace), after a confirmation dialog.<br>• Offered on the wizard's last step and in Brand › Brands › "Add sample brand" (install admin). One sample brand at a time.<br>• The **Reports empty state** in a brand with no tickets offers "See reports with sample data", which opens the sample brand's Reports (built as [M19-08](M19-customer-surfaces-polish.md)). Sample numbers are never mixed into a real brand's charts. | D §11, §15, ADR 0043 | 8 (incl. 2 for writing and reviewing the en/ar content) | M11 |
| M15-12 | **System page additions.**<br>• An **Updates** card: current version and digest, latest version, security badge, the upgrade command, auto-update state and last run, "Check now", and "Update checks are off" when disabled.<br>• A **Backups** card: the last backup's age, size and verify result from `install_ops_events`, amber after 26 h and red after 7 days. It says "No backup reported — helpdock-ctl reports here" when there is none.<br>• An **Operations log** row in the audit card.<br>Queues, failed jobs, Bull Board, channels, storage, imports and brands pending deletion already exist (operations guide, "The System page"); updates, backups and sample data are the gaps this closes. | R §4.10 | 4 | M15-05, M15-09 |
| M15-13 | **Platform templates implemented in #337; review/live validation pending. Cloud-init, upstream submission and Railway spike remain pending.** **Deploy paths** (recommendation in [Deploy paths](#deploy-paths-recommendation)):<br>• `deploy/cloud-init/helpdock.yaml`, a recipe that installs Docker from the distribution and runs the verified installer, with notes for Hetzner, DigitalOcean, Akamai/Linode and Lightsail.<br>• A **Coolify** service template on the external-proxy override, submitted upstream to Coolify's templates and kept in `deploy/coolify/`.<br>• A one-day **Railway spike** whose result is written up, without a template commitment. | ADR 0044 | 5 | M15-06, M15-08 |
| M15-14 | **CI for operations tooling.**<br>• `shellcheck` on `deploy/` and `scripts/`.<br>• A Vitest harness (like `scripts/*.test.ts`) that runs `install.sh --dry-run` across a flag matrix and snapshots the masked `.env`.<br>• **Install e2e**: build a local bundle, serve it over loopback, install offline, and reach `/ready`.<br>• **Upgrade e2e**: install the previous **published** release, upgrade to the locally built image, verify.<br>• **Rollback e2e**: an image with a deliberately failing migration rolls back and restores, with row counts unchanged.<br>• **Tamper tests**: a changed file or a changed `SHA256SUMS` is refused.<br>• A **nightly job** verifies the real latest release's Cosign bundle and image signature. | A §15 | 6 | M15-01–M15-10 |
| M15-15 | **Docs:**<br>• install (the one-command path first, the manual path kept as the reference);<br>• operations (each verb, plus cron and systemd);<br>• a new `self-hosting-supply-chain.md` (what is signed, how to verify by hand, the identities);<br>• release (new assets, `release-manifest.json` fields, how to veto auto-update for a release);<br>• configuration (`HD_UPDATE_CHECK`, `HELPDOCK_IMAGE`, `AUTO_UPDATE*`);<br>• a sample-data guide; the Coolify and cloud-init pages;<br>• PRD, REQUIREMENTS and DOMAIN-RULES amendments; `.env.example`. | AGENTS DoD 1 | 4 | all |

**Total: about 67 days** (13–14 weeks). Three people in parallel tracks (tooling
M15-01–08, M15-10, M15-14; product M15-05, M15-09, M15-11, M15-12; docs and deploy
M15-13, M15-15) bring it to about 6 weeks of calendar time.

### `release-manifest.json`

Signed indirectly, because it is listed in `SHA256SUMS`:

```json
{ "version": "1.2.3", "publishedAt": "…", "image": "ghcr.io/docker-hunterpedia/helpdock@sha256:…",
  "signer": "https://github.com/Docker-Hunterpedia/Helpdock/.github/workflows/release.yml@refs/heads/main",
  "minUpgradeFrom": "1.0.0", "migrations": { "count": 3, "irreversible": false },
  "security": false, "autoUpdate": true,
  "thirdPartyImages": { "caddy": "caddy@sha256:…", "redis": "…", "postgres": "…", "minio": "…" } }
```

`security` and `autoUpdate` come from Changesets front-matter
(`helpdock-release: security` / `no-auto-update`). This is checked in
`changesets.yml`, so a maintainer sets them in the PR that needs them.

## Data model

- `install_ops_events`, install scope (not a tenant table, and so documented in its
  table comment; reached only through `install:admin` routes and the CLI): `id uuidv7`,
  `kind` (`backup | verify | upgrade | auto_update | rotate_key | restore`),
  `result` (`ok | skipped | failed | rolled_back`), `from_version`, `to_version`,
  `detail varchar(500)` (no paths with secrets, no values), `size_bytes null`,
  `duration_ms`, `at`. Retention is 400 days, through `maintenance.retention`'s
  install pass.
- Install settings: `system.updateCheck` (bool, default true), `system.updates.latest`
  (jsonb, written by the worker), `system.autoUpdate` (mirror of the host state, read
  only; the host `.env` is the truth).
- `brands.is_sample boolean not null default false`, with a partial unique index
  `WHERE is_sample` so only one exists. Prefix reservation skips sample brands.
  `brandStatusEnum` is unchanged: removal uses the existing purge path with
  `grace = 0` when `is_sample`.
- No new tenant tables, so the RLS negative suite only gains the sample brand's "no
  outbound" checks.
- One migration, numbered with the next free number at implementation time
  (`0054_imports` is the last shipped).

## Security and privacy

1. **Supply chain**, end to end:
   - `install.sh` is published as a release asset and fetched from
     `https://github.com/Docker-Hunterpedia/Helpdock/releases/latest/download/install.sh`.
     Its SHA-256 sits in `SHA256SUMS` beside it and in the README. The verify-first
     path (download, `cosign verify-blob`, read, run) is documented. Release tags
     are protected (`protect-release-tags` ruleset).
   - The installer resolves one version and downloads the bundle, `SHA256SUMS` and
     `SHA256SUMS.sigstore.json`. It verifies the bundle with **Cosign**: the host's
     `cosign` when present, otherwise
     `docker run --rm ghcr.io/sigstore/cosign/cosign:<pinned>@sha256:<pinned> verify-blob …`.
     The pinned Cosign digest is inside the already-verified `install.sh`, so trust
     chains from the first script. The certificate identity must equal
     `…/release.yml@refs/heads/main`, with the issuer
     `https://token.actions.githubusercontent.com`. Releases tagged by hand (identity
     `@refs/tags/v…`, release guide) are accepted only through an explicit
     `--allow-tag-identity`.
   - The image is verified with `cosign verify` by **digest**, and `.env` pins the
     digest, not the tag, so a moved tag cannot change what runs.
   - Third-party images are pinned by digest in each release bundle, which removes
     the drift of today's `caddy:2`, `redis:7-alpine`, `pgvector/pgvector:pg17` and
     `clamav/clamav` tags in `docker/docker-compose.yml` (MinIO is already pinned by
     digest).
   - Air-gapped installs: `--offline <dir>` with a `trusted_root.json` exported by
     `cosign trusted-root create --with-default-services` on a connected machine
     (D-36).
2. **Residual risk, stated plainly.** A compromised maintainer account, or a
   malicious merge to `main`, produces a validly signed release. The mitigations
   are:
   - automatic updates are off by default and patch-only when on;
   - the **72-hour cool-down**, so the community and Rekor monitors can catch a bad
     release;
   - the per-release `autoUpdate: false` veto;
   - branch protection, and a required review for `.github/workflows/*` and
     `deploy/*` via CODEOWNERS.
3. **Installer hygiene:**
   - Never `curl | sudo sh`; `sudo` is asked for only to create `/opt/helpdock` and
     to install the systemd timer, and the script says which step needs it.
   - `.env` is `0600` and owned by the invoking user; secrets come from
     `openssl rand` or `/dev/urandom`; `--dry-run` masks them.
   - **The installer always generates `HD_SETUP_TOKEN`** and prints it once with
     the admin URL, which closes the first-run claim race the install guide warns
     about.
4. **Backups contain `.env`**, and therefore the master key. Directories are
   `0700`, the CLI says so after each backup, and `restore` warns when the backup's
   key id differs from the running `.env`'s (it compares a hash, never the value).
5. **Upgrade safety:**
   - one lock;
   - the pre-upgrade backup is taken with api and worker stopped, so it holds every
     write;
   - rollback restores only when the migration count changed;
   - the outbox and `sla.rebuild` cover the stopped minutes;
   - downtime must stay well under Meta's one-hour unsubscribe window (PRD §6 risk).
     The upgrade aborts and starts the old version again if the backup takes more
     than 20 minutes (configurable).
6. **The update check sends nothing about the install.** It goes through `safeFetch`
   and treats the response as untrusted data: Zod-validated, never rendered as HTML.
   The GitHub API's unauthenticated limit (60 requests an hour per address) is far
   above 4 a day.
7. **Sample brand:**
   - Outbound refusal sits at the delivery hooks and the AI gateway, not in the UI,
     and is covered by tests.
   - The widget for the sample brand has no allowed origins.
   - Removal is `install:admin` or brand admin, and is audited.
   - Sample contacts use reserved domains and invented names; no real personal data
     ships in the image.
8. Supply-chain ASVS rows (V10, V14.2) are updated in
   [`asvs-l2.md`](../completed/asvs-l2.md) during the milestone.

## The installer, the wizard and the checks

The order of operations:

1. Check the platform: Linux on amd64 or arm64; macOS only with
   `--admin-host localhost`.
2. Check prerequisites: `docker compose version` v2, `curl`, `openssl` or
   `/dev/urandom`, free ports 80 and 443 (unless `--proxy external`), at least 4 GB
   RAM (warn), and at least 10 GB of free disk.
3. Resolve the version through the GitHub API, or use `--version`.
4. Download and verify ([Security and privacy](#security-and-privacy), item 1).
5. Extract into `--dir`, refusing a non-empty directory it did not create unless
   `--force`.
6. Run the wizard, or the flags with `-y`:
   - admin and API hosts, with a DNS check that resolves both names and shows the
     addresses (no third-party "what is my IP" call);
   - ACME email;
   - storage: bundled MinIO, or S3 with endpoint, bucket and keys, then a test that
     PUTs and DELETEs one object through a short-lived container;
   - proxy: Caddy or external;
   - Cloudflare-proxied or not;
   - optional SMTP (otherwise the web wizard's step 3 asks);
   - update notices on or off;
   - automatic patch updates on or off (default off, with the risk text below).
7. Write `.env`: master key, both database passwords, setup token, `HELPDOCK_IMAGE`
   digest.
8. `docker compose pull` and `docker compose up -d`, then wait for `/ready`.
9. Print the admin URL, the setup key and the three files to back up.

The risk text the wizard shows before automatic updates:

> Automatic updates install new patch releases of Helpdock at night, after a backup. If
> a release fails to start, Helpdock goes back to the previous version and restores the
> backup. The risks: a few minutes of downtime each time; a release that starts but
> behaves wrongly is **not** rolled back; and you trust every future release signed by
> the Helpdock release workflow. Releases are installed only after they have been public
> for 72 hours. Off by default.

## Design artboards

Drawn by the orchestrating session on the design canvas before the screens are
built.

| Artboard | For | Must show |
|---|---|---|
| `Admin/System-Updates` | M15-09, M15-12 | Up to date; update available; **security update** (danger tone); auto-update on with last run ok, failed or rolled back; checks off; "Check now" loading and error |
| `Admin/System-Backups` | M15-12 | Fresh, stale (amber), very stale (red), never reported, verify failed |
| `Admin/Wizard-SampleData` and `-AR` | M15-11 | The wizard's last step offering "Explore with a sample brand", with what it contains and that it can be removed |
| `Admin/SampleBrand-Banner` and `-AR` | M15-11 | The persistent banner across the shell, the switcher badge, disabled channel connect with its reason, and the Remove confirmation dialog |
| `Admin/Brands-AddSample` | M15-11 | Entry point, "already exists" state, removal in progress |

The installer's and the CLI's terminal copy is not an artboard. It follows the
documentation style (plain words, no emoji, no Unicode check marks), and its
transcript goes into `docs/guides/install.md` and is reviewed there.

## Tests

- **Unit:**
  - manifest parsing and the semver gate (major, pre-release, failed, cool-down,
    veto);
  - the update-check Zod schema and the notice de-duplication;
  - `migrations plan` diffing;
  - the sample-bundle validator;
  - the outbound refusal for `is_sample` in each delivery hook.
- **Integration (Testcontainers):**
  - `install_ops_events` writes and reads;
  - `system.update_check` against a stand-in GitHub API (redirect to a private
    address refused, oversized body refused, malformed JSON ignored);
  - sample-brand load, where the outbox holds only import-allowed events and
    `email_deliveries`, `webhook_deliveries` and `ai_calls` stay empty;
  - a rule firing in the sample brand that tries to email is refused and logged;
  - removal purges everything and leaves other brands untouched;
  - RLS: the sample brand cannot be read from another brand.
- **Shell and e2e:** as in M15-14, plus a `restore-drill.sh rehearse` run in CI
  after the refactor, to prove parity.
- **Playwright (`en` and `ar`, with axe):** the Updates and Backups cards in every
  state; the wizard sample step; the sample banner; the Remove flow; a brand admin
  who cannot see the System cards.

## Docs

Listed in M15-15. Also update the README's "Install" section to the one-command
form, keeping the manual path, and
[`onboarding-test.md`](../completed/onboarding-test.md) with the new timing.

## ADRs

- [**0039**](../decisions/0039-signed-release-bundle-and-installer.md) A signed
  release bundle, verified by the installer: Cosign `sign-blob` over `SHA256SUMS`,
  Cosign run from a pinned container, digest-pinned images, the identity rule.
- [**0040**](../decisions/0040-automatic-updates-opt-in-and-delayed.md) Automatic
  updates: opt-in, patch-only default, 72-hour cool-down, veto, rollback contract,
  and why on-by-default updates were not chosen.
- [**0041**](../decisions/0041-helpdock-ctl-in-posix-sh.md) `helpdock-ctl` as
  host-side POSIX `sh`: it must run when the stack is down, so it cannot live only
  in the Node image. JSON parsing is delegated to the container.
- [**0042**](../decisions/0042-update-checks-send-nothing-about-the-install.md)
  Update checks against GitHub: privacy, allow-list, opt-out.
- [**0043**](../decisions/0043-sample-brand-through-the-import-engine.md) Sample
  data through the import engine and the `is_sample` brand.
- [**0044**](../decisions/0044-supported-deploy-targets.md) Supported deploy
  targets: Compose via the installer, Coolify template, cloud-init; Railway not
  maintained; Vercel and Cloudflare dropped.

None of these adds a runtime npm dependency. Cosign is a release-time and host-side
tool already used by `release.yml`.

## Deploy paths: recommendation

Owner amendment (2026-10-20, #337): M15-08 is implemented in the external-proxy
override. M15-13 platform templates are implemented for Dokploy, Coolify, Render
and DigitalOcean, pending review and live platform validation. Render needs a
second database-URL setup step; DigitalOcean requires manual spec import because
its button cannot deploy this topology. Cloud-init, upstream submissions and
the Railway spike remain pending. See [deploy guide](../guides/deploy.md).

| Target | Verdict | Why |
|---|---|---|
| Any Linux VPS with the installer and cloud-init (Hetzner, DigitalOcean, Akamai/Linode, Lightsail, OVH) | **Do (M15-13)** | Covers most self-hosters for nearly no extra cost once the installer exists |
| **Coolify** template | **Do (M15-13)** | Compose-native self-hosted PaaS, popular with exactly this audience. Needs the external-proxy override. Limitation: help-center custom domains are added in Coolify by hand. |
| DigitalOcean Marketplace 1-Click | Later (1.x+) | A vendor listing plus a Packer image to refresh each release. Worth it once the installer has been stable for two releases. |
| Dokploy | **Maintained (#337)** | Self-contained template in `deploy/dokploy/`; upstream submission is separate. |
| Render | **Template-supported (#337)** | Blueprint with managed Postgres and Key Value; two-step runtime URL provisioning. |
| DigitalOcean App Platform | **Template-supported (#337)** | Full import spec; managed Postgres and Valkey created beforehand. The one-click button cannot deploy this topology. |
| CapRover | Community | Accept community templates under `deploy/community/`, labelled unmaintained. |
| Railway | Spike only; do not maintain | Needs a custom Postgres image with pgvector, external S3 and four services. Its edge terminates TLS, so on-demand certificates for brand domains do not work. Cost per install is high. |
| Kubernetes / Helm | Backlog | A large test matrix; wait for a community maintainer. |
| Vercel, Cloudflare | **Dropped from the backlog** | No long-running workers, IMAP pollers, Socket.IO rooms or Caddy on-demand TLS. They would need a different architecture. |

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| A bad release auto-installs on many servers | High | Off by default, patch-only, 72-hour cool-down, veto flag, health-gated rollback |
| The installer breaks on a distribution that was not tested | Medium | Only Docker v2 and POSIX tools are required; the e2e matrix covers Ubuntu 24.04 and Debian 12 on amd64 and arm64; refuses clearly elsewhere |
| A rollback restores over writes made after the failed start | Medium | Restore only when the schema changed; api and worker stay stopped until health is confirmed; the window is minutes |
| Sigstore outage blocks installs | Low | `--offline` with a trusted root; the error message names the cause and the manual verify path |
| The sample brand leaks into metrics or sends something | Medium | One flag checked at every delivery hook, with a test per hook |
| A long migration exceeds Meta's one-hour webhook window | Medium | `--rehearse` reports duration; `migrations.irreversible` and a long-migration note in the manifest; abort past the backup timeout |
| Shell code is hard to test and review | Medium | Shared library with the restore drill, shellcheck, an e2e matrix, small functions |

## Open questions

1. (D-33) Host `install.sh` only on GitHub releases, or also on a project domain
   (for example `get.helpdock.dev`)? A domain is shorter to type but adds DNS and TLS
   to trust. Recommendation: GitHub releases only for now.
2. (D-34) Is the automatic-update default "off", with "patch" as the only level
   offered at first? Recommended. "minor" would follow after two clean releases.
3. (D-35) Encrypted backups: add `age` as an optional host tool, or document
   "encrypt the directory with your own tool"? Recommendation: document it now and
   revisit later.
4. (D-36) Is air-gapped install a 1.x requirement? It adds the trusted-root export
   step and tests.
5. (D-37) Sample data content: should it be written by the maintainer or
   contributed? It must be reviewed in both languages either way.
6. (D-38) Should a brand admin be allowed to add or remove the sample brand, or only
   an install admin? Recommendation: an install admin adds it, and its own admin may
   remove it.
7. (D-39) Which release introduces the Changesets front-matter keys for `security`
   and `autoUpdate`? The release guide changes either way.

## Build order

1. M15-05 (CLI and table) and M15-01 (bundle and signing), in parallel with M15-07
   and M15-08.
2. M15-02, then M15-04, then M15-03.
3. M15-06 (installer), then M15-10 (automatic updates).
4. M15-09, then M15-12 (System cards); M15-11 (sample brand) in parallel.
5. M15-13, M15-14 (CI gates throughout; the e2e jobs land with step 3), then M15-15.

## Exit criteria

- [ ] On a clean Ubuntu 24.04 VM with DNS in place,
  `curl -fsSL …/install.sh | sh -s -- --admin-host … --api-host … --email … -y`
  reaches the web wizard, which asks for the printed setup key, within 10 minutes.
  A tampered bundle, `SHA256SUMS` or image digest stops it with a clear message
  (CI tamper tests).
- [ ] `helpdock-ctl backup`, then `restore` onto a fresh VM, then `verify` match row
  counts and attachment hashes. The drill (`restore-drill.sh rehearse`) still passes
  and uses the same library.
- [ ] `helpdock-ctl upgrade` from the previous published release to the new one
  succeeds. An image with a failing migration rolls back and restores, leaving the
  previous version healthy with unchanged row counts (CI).
- [ ] With automatic updates on, a newer patch release older than 72 hours installs
  overnight and is reported on the System page. A major, a pre-release, a vetoed or a
  previously failed release is skipped and reported.
- [ ] The System page shows an available update within 6 hours of a release (or at
  once with "Check now"), sends no instance data (stand-in test), and shows the last
  backup's age.
- [ ] The sample brand loads in both languages, sends nothing on any channel,
  triggers no AI call or webhook (integration test per hook), is excluded from
  product metrics, and is purged at once by Remove.
- [ ] `rotate-key start` and `finish` complete on a restored stack, and `keys rotate`
  afterwards reports nothing to do.
- [ ] Every new screen passes Playwright in `en` and `ar` with axe. The docs and the
  PRD, REQUIREMENTS and DOMAIN-RULES amendments are merged.

## External dependencies

| Needed for | Dependency | Status |
|---|---|---|
| M15-13 | A Coolify instance to validate the template | needed |

## Planning-document changes when this milestone lands

The 2026-10-20 planning PR already moved backup tooling and the deploy paths out of
the PRD §1 non-goals and the §5 backlog, and updated the REQUIREMENTS scope
statements (§1, §5.5, §5.6, §6). The rest lands with the deliverables:

- **REQUIREMENTS §5.5:** `helpdock-ctl` replaces the manual-only procedures as the
  documented path. **§5.6:** Compose stays the only supported runtime; the
  installer, the external-proxy override and the bundled object-storage profile are
  described.
- **DOMAIN-RULES:**
  - §10: the backup, restore, upgrade and rotation procedures become `helpdock-ctl`
    verbs, and the manual commands stay as the reference.
  - New §10.1 Automatic updates: the auto-update contract (number provisional).
  - §11: retention for `install_ops_events`.
  - §13: the GitHub API and release hosts as allow-listed clients.
- **ARCHITECTURE:**
  - §2: `deploy/` (installer, ctl, Coolify template, cloud-init).
  - §13: the `system.update_check` job.
  - §16: the new release assets.
