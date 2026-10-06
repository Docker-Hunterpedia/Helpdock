# Restore drill (M9-10)

Status: local rehearsal done; **the drill for the record on a clean VM is still
to do, by a person.**

The record of each restore drill run against
[DOMAIN-RULES §10](../planning/DOMAIN-RULES.md#10-operations-and-recovery): a
Postgres dump, the bucket and `.env`, restored into a stack that has never run
Helpdock, within the one-hour recovery time, with the master key rotation
rehearsed on the result. The procedure is the
[restore drill guide](../guides/restore-drill.md); the steps it scripts are
[operations › Backups](../guides/operations.md#backups) and
[Restoring](../guides/operations.md#restoring).

## Runs

| Date | Kind | Release | Backup | Restore | Verify | Key rotation | Result |
|---|---|---|---|---|---|---|---|
| 2026-10-05 | Local rehearsal (`restore-drill.sh rehearse`) | image built from the M9-06 branch | 8.5 s, 556 KB | 35.0 s | 5.5 s | 68.3 s | Passed |
| 2026-10-06 | Local rehearsal (`restore-drill.sh rehearse`) | image built from the branch after merging M6–M8 work | 3.6 s, 580 KB | 19.9 s | 9.2 s | 58.9 s | Passed |
| | **Clean VM, for the record** | `1.0.0` release candidate | | | | | To do |

## 2026-10-06, local rehearsal

Same machine and procedure as the day before, after merging the integration
branch (migrations up to 0046), with the image built from the merged branch;
the sandbox needed a base image carrying its proxy certificate (`NODE_IMAGE`
build argument), which a real build does not. Restore 19.9 s (database 7.9 s
in, bucket 8.5 s in), verify 9.2 s: row counts 1 1 1 0 1 1 1 0 3 5, three
objects, the drill admin signed in with the second factor, the attachment's
bytes matched. `keys rotate` re-encrypted 3 values (the authenticator secret
and two secret settings), listing every envelope place with 0 for the rest,
then 0 under the new key alone; the rotation phase took 58.9 s, most of it
waiting for fresh TOTP steps.

## 2026-10-05, local rehearsal

**Machine.** The shared development sandbox: 4 vCPU, 15 GB of memory, Docker
29.6.2 with Compose 5.3.1, load average about 5 while it ran. Source and target
were two Compose projects on the same daemon, so the backup never crossed a
network; this measures the procedure and the scripts, not a recovery.

**Image.** `ghcr.io/docker-hunterpedia/helpdock:local`, built from this
branch's `docker/Dockerfile` (the base image pulled from `mirror.gcr.io`
because Docker Hub rate-limited the sandbox). The published `0.3.1` image
predates `keys rotate`, so it could not be used for the rotation half.

**Data.** What the rehearsal seeds: one brand, one admin with an enrolled
authenticator, one ticket, one PNG attachment processed into its WebP and two
thumbnails. Row counts restored: brands 1, users 1, departments 1, contacts 0,
tickets 1, ticket_messages 1, attachments 1, hc_articles 0, settings 3,
audit_log 5. Three objects in the bucket.

**Timings**, as the script printed them:

| Phase | Time | Includes |
|---|---|---|
| backup | 8.5 s | `pg_dump -Fc`, `mc mirror` of the bucket, row counts and hashes, a staff sign-in and the attachment's hash through the api |
| restore | 35.0 s | Postgres and Redis up and healthy, the restore (12.8 s in), the bucket mirrored (14.2 s in), then the api healthy and the worker ready |
| verify | 5.5 s | Row counts, every object's hash, sign-in with the second factor, the attachment's bytes through the api |
| key rotation | 68.3 s | Two restarts of the api and the worker, `keys rotate` with both keys (3 values re-encrypted: the authenticator secret and two secret settings), sign-in under both keys, `keys rotate` with the new key alone (0 re-encrypted), sign-in again. Most of it is waiting for a fresh 30-second TOTP step, which the api requires for each sign-in. |

**Found and fixed on the way:**

- Rotating the master key would have locked every staff member out: password
  hashes are peppered with a key derived from `APP_MASTER_KEY`, and nothing
  read the previous key's pepper. `PasswordHasher` now verifies under the
  previous key too and re-hashes on success, and the
  [operations guide](../guides/operations.md#rotating-the-master-key) says to
  keep `APP_MASTER_KEY_PREVIOUS` until staff have signed in.
- `scripts/compose-env.sh` ran a word of its own comment as a command
  (`helpdock.minio: command not found`): a backquoted name inside an unquoted
  heredoc.

## What the clean-VM run must record

Fill in a row above and a section like the one before, with:

- The date, the release tag, and the two machines (provider, size, region).
- How the backup travelled to the new machine, and its size.
- The time from starting the copy to `verify` passing, against the one-hour
  target, and each script phase.
- The key rotation, with its output.
- Anything that did not go as the guide says, with the fix or the issue filed.
