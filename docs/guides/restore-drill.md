# Restore drill

How to prove a backup restores, before you need it. It runs the
[backup](operations.md#backups) and [restore](operations.md#restoring)
procedures end to end and checks the result: the M9-10 exit criterion
([PRD M9](../planning/PRD.md#m9-hardening-and-10),
[DOMAIN-RULES §10](../planning/DOMAIN-RULES.md#10-operations-and-recovery)).
Run it on a schedule, and after any change to how you back up.

`scripts/restore-drill.sh` does each step. It needs Docker with Compose v2,
`curl` and `jq` on the host, and nothing else: TOTP codes are computed by Node
inside the api container, and the bucket is copied by MinIO's client (`mc`)
from the image the Compose file already pins.

## The drill for the record

On two machines: the install, and a clean VM with Docker that has never run
Helpdock.

1. **On the install**, take a backup:

   ```bash
   cd Helpdock
   DRILL_EMAIL=you@example.com DRILL_PASSWORD='…' DRILL_TOTP_SECRET='…' \
     scripts/restore-drill.sh backup ~/drill
   ```

   `~/drill` then holds `helpdock.dump` (`pg_dump -Fc`), `bucket/` (every
   object), `env` (a copy of `.env`, mode 600), `counts.tsv` (row counts of the
   tables a person would miss), `bucket.sha256` (a hash per object) and, with a
   staff account given, `attachment.tsv`: the newest ready attachment and the
   hash of the bytes the api served for it.

   `DRILL_TOTP_SECRET` is the base32 secret of that account's authenticator,
   the one enrolment showed. Use an account made for the drill rather than a
   person's.
2. **Copy `~/drill` to the clean VM** the way your real backups travel, and
   check out the same release there (`HELPDOCK_VERSION` in `drill/env`), as
   [install](install.md#install) does. Start the clock.
3. **Restore**:

   ```bash
   cd Helpdock
   scripts/restore-drill.sh restore ~/drill
   ```

   It puts `env` back as `docker/.env` (and refuses if a different one is
   there), starts Postgres and Redis alone, refuses a database that already has
   tables, restores the dump with the owner role, creates the bucket if needed
   and mirrors the objects into it, then starts the whole stack and waits for
   the api to be healthy and the worker to be ready.
4. **Verify**:

   ```bash
   DRILL_EMAIL=… DRILL_PASSWORD=… DRILL_TOTP_SECRET=… \
     scripts/restore-drill.sh verify ~/drill
   ```

   It compares the row counts and every object's hash with the backup, signs
   the drill account in with its second factor, and downloads the recorded
   attachment through the api, which must return the same bytes. Stop the
   clock: the time from step 2 is your recovery time, against the one-hour
   target.
5. **Rotate the master key** on the restored stack
   ([operations › Rotating the master key](operations.md#rotating-the-master-key)),
   and sign in again. This rehearses the other half of DOMAIN-RULES §10.
6. **Record it** in [`docs/completed/restore-drill.md`](../completed/restore-drill.md):
   the date, the release, the machines, the size of the backup and each
   timing.

With a bucket outside the stack (S3, R2), step 3's mirror writes into whatever
`S3_*` in `env` names. Point those keys at a scratch bucket for a drill, or the
restore writes into production's bucket.

### Settings

| Variable | Default | Meaning |
|---|---|---|
| `HELPDOCK_PROJECT` | `helpdock` | Compose project name of the stack |
| `HELPDOCK_COMPOSE` | `docker/docker-compose.yml` | Compose files, separated by `:`. `.env` is read from beside the first. |
| `HELPDOCK_PROFILES` | none | Compose profiles, separated by `:`; `dev` brings up the bundled MinIO |
| `API_URL` | `http://127.0.0.1:3000` | Where the api answers from the host running the script |
| `DRILL_EMAIL`, `DRILL_PASSWORD`, `DRILL_TOTP_SECRET` | none | The staff account for the sign-in and attachment checks. Without them those two checks are skipped, and the output says so. |

With the production Compose file the api has no published port; run the
script with `API_URL=https://<API_HOST>` instead.

## A local rehearsal

```bash
HELPDOCK_VERSION=<tag of an image you have> scripts/restore-drill.sh rehearse
```

Everything above on one machine, with throwaway stacks: a source stack
(project `helpdock-drill-source`, the dev Compose override, MinIO) gets an
admin, a brand, a ticket and an image through the first-run wizard and the
api; it is backed up and destroyed; the backup is restored into a second
project, `helpdock-drill-target`, and verified; then the master key is rotated
there, the admin signs in under both keys and under the new key alone, and
`keys rotate` confirms nothing still needs the old one. It prints a timing per
phase and removes both stacks and `docker/.env` at the end, or leaves them for
inspection with `DRILL_KEEP=1`. It refuses to run if `docker/.env` exists.

A rehearsal checks the scripts and the procedure. It is not the drill for the
record, which needs the clean VM.
