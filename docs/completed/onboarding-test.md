# Onboarding test (M9-07)

Status: machine runs done locally; **the clean-VM run by a person and the
usability pass with three outside testers are still to do.**

Two targets from [REQUIREMENTS §7](../planning/REQUIREMENTS.md#7-success-criteria-for-v1)
and [DOMAIN-RULES §15](../planning/DOMAIN-RULES.md#15-product-metrics):

- **30 minutes** from `docker compose up` on a clean VM to the first ticket
  replied, following only the [README](../../README.md#install) and the
  [install guide](../guides/install.md).
- **Three clicks** from the ticket list to a sent reply, measured with three
  outside testers.

## Machine runs

`scripts/onboarding-run.sh` times the steps an operator takes through the same
HTTP calls the admin, the widget and the web form make, on a throwaway local
stack: the stack coming up, the first-run wizard, the admin's first sign-in
with a second factor, a second brand, each brand's widget allowed on its own
site with a visitor starting a conversation from each, Channels › Web form
switched on, a customer sending the form, and the agent replying. It is the
floor under the human run: what the software itself costs. The Telegram
ticket of REQUIREMENTS §7 is left to the clean-VM run (it needs a bot and a
host Telegram can reach).

| Date | Image | Up to healthy | Wizard | First sign-in | Second brand | Two widgets | Web form | Agent replies | Total |
|---|---|---|---|---|---|---|---|---|---|
| 2026-10-06 | `local` (this branch, merged) | 25.6 s | 0.2 s | 0.5 s | 0.1 s | 0.3 s | 0.2 s | 0.1 s | 27.0 s |
| 2026-10-06 | `0.3.1` (published, GHCR, already pulled) | 30.4 s | 0.3 s | 0.1 s | 0.1 s | 0.4 s | 0.4 s | 0.1 s | 32.1 s |
| 2026-10-05 | `0.3.1` (published, GHCR), earlier script without the second brand and the widgets | 18.0 s | 0.3 s | 0.1 s | — | — | 0.2 s | 0.1 s | 35.6 s, with a 16.6 s pull |

All on the shared development sandbox (4 vCPU, 15 GB), with the dev Compose
override and its MinIO. `0.3.1` predates the mandatory second factor for
Admins, so its first sign-in opened a session at once. The `local` image was
built from this branch's `docker/Dockerfile` on a base image that carries the
sandbox's proxy certificate (`NODE_IMAGE` build argument), which the sandbox
needs to reach the npm registry and a real build does not.

### The README against the published image

On the same day the [install section of the README](../../README.md#install)
was followed against `ghcr.io/docker-hunterpedia/helpdock:0.3.1`: the `v0.3.1`
Compose files, `.env` copied from `.env.example` and filled in as the
[install guide](../guides/install.md#install) says, `ADMIN_HOST=admin.localhost`
and `API_HOST=api.localhost` so Caddy issued local certificates, and the
bundled MinIO (`docker compose --profile dev up -d minio minio-bucket`) for
object storage. `docker compose up -d` brought up Caddy, two api replicas, the
worker, Postgres and Redis in 25 s; both hosts answered `/health` and `/` with
200 over https, the admin page reported a fresh install, and `/metrics` was
refused through Caddy. The Compose files have not changed since `v0.3.1`.

## The clean-VM run (to do)

One person who has not installed Helpdock before, on a VM that has never run
it, with a stopwatch and a screen recording.

**Setup:** a fresh Linux VM (2 vCPU, 4 GB) with Docker Engine and Compose v2, a
domain with two DNS names pointing at it, an SMTP account, an S3 bucket.

**Task:** "Install Helpdock from the README, finish the setup, put the contact
form live, send yourself a ticket through it from another browser, and reply to
it."

| Step | Started | Finished | Minutes | Where they hesitated, or what they asked |
|---|---|---|---|---|
| Read the README and the install guide | | | | |
| `.env` filled in | | | | |
| `docker compose up -d` to the wizard on screen | | | | |
| First-run wizard, SMTP test included | | | | |
| First sign-in and second factor enrolled | | | | |
| Channels › Web form switched on | | | | |
| Ticket sent from the form | | | | |
| Ticket found and replied to | | | | |
| **Total** (target: 30 min from `docker compose up`) | | | | |

Record the date, the release, the VM, the tester (initials), each friction
point with the issue filed for it, and whether the target was met.

## The usability pass (to do)

Three outside testers, each on a seeded install with at least twenty open
tickets, given one task: "Reply to the oldest ticket waiting on us." Count
clicks from the ticket list to the reply being sent. A tester who needs more
than three clicks, or asks for help, is a finding.

| Tester | Date | Clicks | Time | Notes, and the issue filed for each friction point |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |

Fixes for the friction they find are part of M9-07.
