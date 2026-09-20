# Install

How to run Helpdock on your own server with Docker Compose. Developers building
the project instead want [the development guide](development.md).

Helpdock is pre-alpha. The stack described here comes up, takes you through the
first-run wizard and signs you in; ticketing, the help center, the widget and the
AI are still being built ([PRD §4](../planning/PRD.md)).

## What you need

| | |
|---|---|
| A Linux server | 2 vCPU and 4 GB of memory is enough to start. ClamAV, if you enable it, wants another 2 GB. |
| Docker Engine with the Compose v2 plugin | `docker compose version` must print v2; the stack uses service profiles and `depends_on` health conditions. |
| Two DNS records | See below. |
| Ports 80 and 443 | Open to the internet, so Caddy can get certificates. |

## DNS

Point both hostnames at the server's public address:

| Record | Name | Value |
|---|---|---|
| `A` (and `AAAA`) | `admin.example.com` | the server's IP |
| `A` (and `AAAA`) | `api.example.com` | the server's IP |

`admin.example.com` serves the admin app; `api.example.com` serves the REST API,
the chat widget and its WebSocket endpoint. They can be any two names you
control — they are what you put in `ADMIN_HOST` and `API_HOST` below.

A brand's help center gets its own domain later, in admin, and needs no
configuration here: Caddy issues a certificate for it the first time a browser
asks, after the api has confirmed the domain was verified (see
[Custom domains](#custom-domains)).

## Install

```bash
git clone https://github.com/Docker-Hunterpedia/Helpdock.git
cd Helpdock/docker
cp ../.env.example .env
```

Everything you have to fill in is in `.env`. Generate the master key first:

```bash
openssl rand -base64 32
```

Then set, at least:

```bash
APP_URL=https://admin.example.com
APP_MASTER_KEY=<the key you just generated>
NODE_ENV=production

# Same password in both places: the runtime role is created with
# HELPDOCK_APP_PASSWORD and connected to with DATABASE_URL.
HELPDOCK_APP_PASSWORD=<a long random password>
DATABASE_URL=postgres://helpdock_app:<that same password>@postgres:5432/helpdock

POSTGRES_PASSWORD=<another long random password>
DATABASE_MIGRATION_URL=postgres://helpdock_owner:<that password>@postgres:5432/helpdock

REDIS_URL=redis://redis:6379

ADMIN_HOST=admin.example.com
API_HOST=api.example.com
ACME_EMAIL=you@example.com
```

`APP_MASTER_KEY` encrypts every secret Helpdock stores. **Back it up with the
database.** Without it, every stored secret is unrecoverable
([DOMAIN-RULES §10](../planning/DOMAIN-RULES.md#10-operations-and-recovery)).

The `S3_*` keys point at object storage for attachments and article images.
Every attachment lives there, and **the bucket must be private**: Helpdock
serves each object through a presigned URL that lives five minutes and is issued
only after the caller has been authorised on the parent ticket. Give the
credentials read, write and delete on that one bucket and nothing else.

Set `S3_FORCE_PATH_STYLE=true` for MinIO, Ceph and most other self-hosted
gateways, which address a bucket as a path; Amazon S3 does not want it. For a
local MinIO, `docker compose --profile dev up -d minio minio-bucket` starts one
and creates the bucket — MinIO has no "create on first write", so the `mc`
sidecar is what makes it.

Two optional keys belong to the same pipeline
([the attachments guide](attachments.md#configuration)):

- `FFMPEG_PATH` and `FFPROBE_PATH` say where the worker finds ffmpeg, which it
  spawns to normalise voice notes to Opus and to take a video's poster frame.
  The image installs both, so a Compose deployment needs neither key. Without
  them, images and files still work and audio and video are rejected.
- `CLAMAV_HOST` turns on antivirus scanning of uploaded files. The stack ships a
  profile for it — `docker compose --profile clamav up -d`, then
  `CLAMAV_HOST=clamav` — and it wants about 2 GB of memory, which is why it is
  off by default. A host that is set and unreachable **rejects** uploads rather
  than passing them: an install that asked for scanning and quietly got none is
  worse than one that never asked.

Then:

```bash
docker compose up -d
docker compose ps
```

The api runs the migrations at boot, provisions the runtime database role,
refuses to serve if that role could bypass row-level security, and starts
listening. The worker waits for it and then starts the outbox relay.

## First run

Open `https://admin.example.com`. An install with no accounts in it has exactly
one screen — the setup wizard — and every other path goes there.

> **Finish the wizard before anyone else can reach the host.** Until it is
> finished there is nobody to check a visitor against, so whoever completes the
> first step becomes the install administrator. That is true of every
> self-hosted first-run wizard; what makes it small is doing it straight away.
> If the DNS records are already public, bring the stack up with the firewall
> closed, or run `docker compose up -d` and open the wizard through an SSH
> tunnel first. The api counts setup attempts per source address, and refuses a
> setup request a browser made from another site, which together slow a stranger
> down but do not replace being quick.

Four steps, none of which can be got wrong permanently except one:

| Step | What it asks for |
|---|---|
| **1 Admin account** | Your name, email, a password of at least twelve characters, and your language. This account is the *install administrator*: the only one that reaches every brand and every setting. The language you pick here is the one the rest of the wizard, and your admin, are shown in — pick العربية and the whole thing turns around. |
| **2 First brand** | The brand's name, a **ticket prefix**, its default language, its timezone, and optionally the hostname its help center will answer on. The brand is created with one department, **General**; rename it or add more in admin. |
| **3 Outgoing email** | Your SMTP server, port, encryption, credentials and the address mail comes from. **Send a test email** delivers one to the address from step 1 and shows you what the server said. You may skip this and set it up later in admin. |
| **4 Done** | What was created, and the way in. |

**The ticket prefix cannot be changed.** It is printed in every ticket number,
every subject line and every email reference for the life of the brand, so
`ACME-1042` is `ACME-1042` forever. Two to six characters, `A-Z` and `0-9`. The
field previews a ticket number as you type.

**The help center domain is stored unverified.** Nothing happens to it until you
publish the DNS records and verify it in admin (see
[Custom domains](#custom-domains)); Caddy issues no certificate for an
unverified hostname.

Step 2 is where you are signed in, because that is the first moment there is a
brand for a session to land in. If the install requires two-factor
authentication (`HD_AUTH_REQUIRE2FA=true`, or the `auth.require2fa` setting),
step 4 says so and sends you to enrol an authenticator before anything else.

### Testing outgoing email

The test sends one real message through the server you typed, with a ten-second
deadline, and reports one of:

| What you see | What it usually means |
|---|---|
| The server's reply, such as `250 2.0.0 Ok` | It worked. Check the inbox. |
| The server refused those credentials | Wrong username or password, or the relay wants an app password rather than your account password. |
| Could not reach that server | Wrong hostname or port, or a firewall between this machine and the relay. |
| The encrypted connection failed | The port and the encryption setting disagree — 587 is STARTTLS, 465 is TLS — or the relay's certificate cannot be verified. |
| The server did not answer within ten seconds | Usually a port that is filtered rather than closed. |
| The server refused the message | The From address is not one this relay will send as. |

The password is encrypted with `APP_MASTER_KEY` before it is stored and is never
shown again, in admin or anywhere else.

If you set any `HD_SMTP_*` variable in `.env`, that key wins over whatever the
wizard saves ([ARCHITECTURE §4](../planning/ARCHITECTURE.md#4-configuration-model)),
and the wizard leaves it alone rather than storing a value nothing reads.

### Once it is finished

The wizard is closed for good. `/setup` is no longer a route, and every setup
endpoint answers `409 Conflict` — including to whoever finds the URL later.
There is no way to reopen it: the install is "set up" exactly while the `users`
table has a row in it, and the only way back is to restore a database that had
none.

## Custom domains

A brand's help center runs on the brand's own hostname, and Caddy gets a
certificate for it without you editing anything:

1. In admin, add the domain to the brand. Helpdock shows a `CNAME` and a `TXT`
   record to publish.
2. Publish them. Helpdock verifies the `TXT` record and marks the domain
   verified. (Adding and verifying domains is M5; the table that holds them
   ships now.)
3. The first browser to open the domain makes Caddy ask the api
   `GET /internal/domain-check?domain=…`. The api answers 200 only for a
   verified help-center domain, and Caddy issues a certificate.

An unverified hostname gets a 403 and no certificate, which is what keeps a
stranger pointing DNS at your server from spending your certificate authority's
rate limits. `/internal/*` is not reachable from outside: Caddy answers 404 for
it, and the check travels over the Compose network.

## Behind Cloudflare

If your hostnames are proxied by Cloudflare (the orange cloud), Cloudflare
terminates TLS and Caddy must not try to issue certificates on demand. Switch
the Caddy configuration in `.env`:

```bash
CADDYFILE=./caddy/Caddyfile.cloudflare
```

then `docker compose up -d caddy`. That configuration serves `ADMIN_HOST` and
`API_HOST` and has no catch-all site; each verified brand domain is added to it
by hand, as the comment in the file shows. Set Cloudflare's SSL mode to **Full
(strict)** with an origin certificate, or the hop between Cloudflare and your
server is unauthenticated.

## Upgrading

Migrations are forward-only and run on api boot, so an upgrade is a pull and a
restart. Take a dump first: a failed migration is recovered by restoring it and
going back to the previous tag
([DOMAIN-RULES §10](../planning/DOMAIN-RULES.md#10-operations-and-recovery)).

```bash
cd Helpdock/docker
docker compose exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > ../helpdock-$(date +%F).dump

# Pin the new release in .env, rather than tracking `latest`.
sed -i 's/^HELPDOCK_VERSION=.*/HELPDOCK_VERSION=1.2.3/' .env

docker compose pull
docker compose up -d
docker compose logs -f api
```

Check the release notes before every upgrade; they flag any migration a restore
cannot roll back.

## Backups

What to back up, in full, is
[DOMAIN-RULES §10](../planning/DOMAIN-RULES.md#10-operations-and-recovery). The
short version:

- **Postgres**, with `pg_dump -Fc` (the command above).
- **The object storage bucket.** It is the only copy of attachments and article
  images.
- **`.env`.** It holds `APP_MASTER_KEY`, and without that key every stored
  secret is lost — the SMTP password the wizard saved, the OAuth secrets, all of
  it. Keep it somewhere other than the server; [the operations
  guide](operations.md#the-master-key) says how to check the copy you have is
  the right one.

Redis is not backed up. Losing it logs everyone out and drops queued jobs; the
outbox relay republishes anything that had not been published, which is why
nothing durable lives only in Redis.

## Troubleshooting

```bash
docker compose ps                 # who is up, and who is healthy
docker compose logs -f api        # JSON lines, one per request, with a request id
docker compose logs -f worker
docker compose exec api node -e "fetch('http://127.0.0.1:3000/ready').then(r=>r.text()).then(console.log)"
```

- **`/ready` answers 503.** The body names the dependency that is down —
  `database`, `redis` or `settings`. `/health` stays 200 while the process is
  alive, so a 503 here is a dependency and not a crash.
- **The api exits at boot with a list of keys.** `.env` is incomplete or wrong;
  the message names every key and what it expects, and never the value.
- **`The database role … must not serve traffic`.** `DATABASE_URL` names the
  migration owner instead of `helpdock_app`. The two roles are separate on
  purpose ([DOMAIN-RULES §1.5](../planning/DOMAIN-RULES.md#1-authorization)).
- **The api cannot authenticate to Postgres.** `HELPDOCK_APP_PASSWORD` and the
  password inside `DATABASE_URL` have drifted apart. The role is created once,
  on the first boot, and is left alone afterwards; change the password with
  `ALTER ROLE helpdock_app PASSWORD …` and update both.
- **No certificate for a brand domain.** Ask the api directly:
  `docker compose exec caddy wget -qSO- 'http://api:3000/internal/domain-check?domain=help.brand.example'`.
  A 403 means the domain is not verified; a 200 means Caddy should be able to
  issue, so look at `docker compose logs caddy` for the issuance attempt.
- **Two api containers.** That is the default (`deploy.replicas: 2`). They
  serialise on the migration advisory lock at boot. Run
  `docker compose up -d --scale api=1` for one.
- **The wizard says the install has already been set up.** Somebody finished it,
  or a tab was left open for more than thirty minutes and its setup token
  expired. If the account is yours, sign in; if it is not, the install was
  claimed and the only honest recovery is to restore or recreate the database.
- **The browser shows the sign-in screen on a brand-new install.** The api could
  not read the database when it served the page, so it reported the install as
  configured rather than offering it to a stranger. `docker compose logs api`
  says what was wrong; the wizard appears on the next reload once it is fixed.
