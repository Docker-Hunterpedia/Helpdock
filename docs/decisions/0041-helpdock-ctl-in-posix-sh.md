# 0041 helpdock-ctl is host-side POSIX sh

Status: proposed
Date: 2026-10-20

## Context

[M15 Self-host operations](../in-development/M15-self-host-operations.md) turns the
documented backup, restore, upgrade and key-rotation procedures into one operator
tool, `helpdock-ctl`. Several of its verbs run when the stack is down or about to be
replaced: `restore` onto a fresh host, `upgrade` with api and worker stopped, the
rollback after a failed start. The restore drill (`scripts/restore-drill.sh` and
`scripts/drill-lib.sh`) already implements backup, restore and verify in shell.

## Decision

1. `helpdock-ctl` is a POSIX `sh` script on the host, shipped in the signed deploy
   bundle ([ADR 0039](0039-signed-release-bundle-and-installer.md)). It needs only
   `sh`, `docker compose` and `curl`; there is **no `jq`** on the host.
2. JSON (manifests, migration plans, reports) is parsed inside the api container
   through new commands in `apps/api/src/cli.ts`: `migrations plan --json`,
   `ops report` and `version --json`, beside today's `keys rotate`.
3. The backup, restore and verify functions of the restore drill move into one
   library, `deploy/lib/ops.sh`. `restore-drill.sh rehearse` becomes a wrapper over
   it, so the drill and the tool cannot drift.
4. One lock directory per install serialises verbs.
5. Outcomes are reported to the instance through the api CLI and recorded in the
   install-scope `install_ops_events` table.

## Consequences

- The tool works when the Node image is broken, missing or the wrong version, which
  is exactly when it is needed.
- Shell is harder to test and review. CI runs `shellcheck` on `deploy/` and
  `scripts/`, a Vitest harness over `install.sh --dry-run`, and install, upgrade,
  rollback and tamper end-to-end jobs.
- The drill that proved the restore procedure for 1.0 becomes the tested core of the
  everyday tool.

## Alternatives considered

- **A Node CLI inside the image only.** Cannot run when the image is the problem, and
  cannot install or replace the image it lives in.
- **A compiled binary (Go or Rust).** A second toolchain and a second signing and
  distribution path for a solo maintainer.
- **Bash with `jq`.** More convenient, but adds host prerequisites that minimal
  distributions do not ship.
