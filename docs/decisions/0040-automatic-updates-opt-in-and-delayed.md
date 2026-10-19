# 0040 Automatic updates are opt-in, patch-only and delayed

Status: proposed
Date: 2026-10-20

## Context

[M15 Self-host operations](../in-development/M15-self-host-operations.md) adds
`helpdock-ctl upgrade`, which verifies a release, checks or rehearses its
migrations, takes a pre-upgrade backup and rolls back when the new version does not
become healthy. Operators want to run it on a schedule. Some self-hosted products
turn automatic minor and patch updates on by default.

A self-hosted support desk is business-critical: a bad update stops a team from
answering customers. The worst case is a release that is validly signed but harmful,
from a compromised maintainer account or a malicious merge
([ADR 0039](0039-signed-release-bundle-and-installer.md) proves origin, not
quality). An update that starts but behaves wrongly is not caught by a health check.

## Decision

1. Automatic updates are **off by default**. An operator turns them on with
   `helpdock-ctl auto-update on`, which installs a systemd timer, or a cron entry
   where there is no systemd. The installer's wizard asks, defaulting to off, and
   shows the risks in plain words.
2. The level is **patch** by default; `--level minor` is available. A new major is
   never installed automatically.
3. A run upgrades through `helpdock-ctl upgrade`, never skipping the backup, inside
   an operator-chosen window.
4. A run skips, and reports why: a pre-release; a manifest with `autoUpdate: false`
   (the per-release veto maintainers set through Changesets front-matter); a release
   **younger than 72 hours** (`--min-age`); a release that failed on this install
   before; an `HELPDOCK_IMAGE` that is not a release digest; free disk below twice
   the last dump; a failed last `verify`.
5. Rollback contract: if the new version is not ready within 5 minutes, the previous
   files and digest come back, the pre-upgrade backup is restored when the schema
   changed, and the previous version starts. A release that starts but misbehaves is
   not rolled back.
6. The newest three automatic backups are kept. Every run is reported to the instance
   (`install_ops_events`) and shown on the System page; a failed run emails install
   admins.

The rule lands as a new DOMAIN-RULES §10.1 (number provisional) with M15-10.

## Consequences

- No install changes under an operator who did not ask for it.
- The 72-hour cool-down gives the community and transparency-log monitors time to
  catch a bad release before it spreads; the veto lets maintainers hold back a
  release that needs a manual step.
- Operators who turn it on accept a few minutes of downtime per update and trust
  every future release signed by the release workflow; the wizard says so.
- Security fixes reach opted-in installs no sooner than 72 hours after release.
  Install admins are emailed about security releases by the update check
  ([ADR 0042](0042-update-checks-send-nothing-about-the-install.md)) and can upgrade
  at once by hand.

## Alternatives considered

- **On by default, minor and patch.** Keeps more installs current, but turns one bad
  or compromised release into an outage or a breach on every install at once, on a
  system that teams depend on to answer customers.
- **No automatic updates, notices only.** Safest, but leaves small teams without an
  operator on old versions.
- **Install immediately on release.** Removes the window in which a bad release can
  be caught and vetoed.
