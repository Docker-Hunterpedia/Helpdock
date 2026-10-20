# Deploy paths

These templates pin `ghcr.io/docker-hunterpedia/helpdock:1.0.3`. They run the
existing image without rebuilding it: `APP_ROLE=api` serves HTTP, the admin,
help center, widget and Socket.IO; `APP_ROLE=worker` runs queues and channel
pollers. The api runs migrations at boot under a PostgreSQL advisory lock. The
worker does not migrate. `/health` checks the process; `/ready` checks database,
Redis and settings. Use `/ready` for the proxy's health check.

| Path | Files | Operator work before first use |
|---|---|---|
| Existing host proxy | `docker/docker-compose.external-proxy.yml` | Configure nginx or Traefik and TLS |
| Dokploy | `deploy/dokploy/` | Import template, supply private S3 bucket, check domain |
| Coolify | `deploy/coolify/docker-compose.yml` | Paste Compose, supply private S3 bucket, check domain |
| Render | `render.yaml` | Blueprint provisioning, then runtime database URL and redeploy |
| DigitalOcean App Platform | `.do/app.yaml` | Create managed databases, fill secrets, import spec |

Template-supported means maintained configuration. It does not mean a live
platform deployment has been certified. Review the platform's resource charges
before creating it. The manual [Compose install](install.md) remains the
reference path.

## Required configuration

The api **and** worker require these keys from `packages/config/src/env.ts`:

| Keys | Value |
|---|---|
| `APP_URL` | Public HTTPS URL, used for links and the install's hostname |
| `APP_ROLE`, `NODE_ENV` | `api` or `worker`; `production` |
| `APP_MASTER_KEY` | Exactly 32 random bytes encoded as standard base64; shared by both roles |
| `DATABASE_URL` | Connection as **helpdock_app**, with password; never the owner |
| `DATABASE_MIGRATION_URL` | Same database, as its migration owner with role/extension creation privileges |
| `REDIS_URL` | `redis://` or `rediss://` URL; `noeviction` policy for BullMQ |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET` | Private S3-compatible bucket, endpoint and region |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Credentials limited to that bucket |

Set `HD_SETUP_TOKEN` before exposing a fresh install. The templates either
generate it or require it. Generate manual values with `openssl rand -base64 32`
(for `APP_MASTER_KEY` and the setup token). DigitalOcean does not generate these
application secrets from the app spec: fill its empty `SECRET` fields yourself.
Do not regenerate the master key during a redeploy or upgrade.

**Recommended storage: Cloudflare R2.** Create a private bucket and bucket-scoped
S3 credentials. Use `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` for
`S3_ENDPOINT`, `auto` for `S3_REGION`, the bucket name, and its access key pair.
Do not use a public `r2.dev` URL as the endpoint. See Cloudflare's
[S3 SDK example](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/).
For DigitalOcean Spaces, use the regional S3 API endpoint and region from your
[Spaces connection details](https://docs.digitalocean.com/products/spaces/how-to/use-aws-sdks/).
`S3_FORCE_PATH_STYLE` defaults to `false`; enable it if your S3 provider requires
`endpoint/bucket/key` addressing. CORS and presigned access are covered in
[attachments](attachments.md).

## External proxy

From `docker/`, keep the completed `.env` from the manual install. Change its
`TRUST_PROXY=false` entry to `TRUST_PROXY=uniquelocal` (or the exact proxy
peer/CIDR) before starting: an explicit `false` overrides the override
file's fallback. Then run:

```sh
docker compose -f docker-compose.yml -f docker-compose.external-proxy.yml config
docker compose -f docker-compose.yml -f docker-compose.external-proxy.yml up -d
```

Use Docker Compose **2.24.4 or later**. The override removes Caddy with `!reset`,
runs one api replica (a fixed host port cannot be shared by two), and publishes
only `127.0.0.1:3000`. It fixes `PORT=3000`. No database or Redis port is published.
The platform files flatten this topology so imports need no sibling files,
`.env` mounts or custom YAML tags; contract tests check both roles against the
same application config schema.

`TRUST_PROXY=uniquelocal` trusts Docker's private network addresses. A proxy on
the host reaches the container through the Docker bridge, not as loopback.
Prefer the proxy's exact peer IP/CIDR on shared networks. Never publish the api
on `0.0.0.0` with broad proxy trust. A container proxy must join the api's private
network and route to `api:3000`, rather than its own `127.0.0.1`.

For nginx running on the host, configure certificates for your hostname, then
use this inside its HTTPS `server` block (the `map` belongs in `http`). See
[nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html):

```nginx
map $http_upgrade $helpdock_connection {
    default upgrade;
    '' close;
}

# Inside the HTTPS server block:
location ^~ /internal/ { return 404; }
location = /metrics { return 404; }
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Request-Id $request_id;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $helpdock_connection;
    proxy_read_timeout 3600s;
}
```

For Traefik running on the host, add this file-provider configuration and your
normal HTTPS entrypoint/certificate resolver. Traefik handles WebSocket upgrades:

```yaml
http:
  routers:
    helpdock:
      rule: 'Host(`support.example.com`) && !PathPrefix(`/internal/`) && !Path(`/metrics`)'
      entryPoints: [websecure]
      tls:
        certResolver: letsencrypt
      service: helpdock
  services:
    helpdock:
      loadBalancer:
        servers:
          - url: http://127.0.0.1:3000
```

The proxy must set trusted forwarding headers, preserve the original Host, and
support WebSocket upgrades on the existing Socket.IO path. Keep Traefik's
insecure forwarded-header trust off. See
[Traefik forwarding](https://doc.traefik.io/traefik/reference/install-configuration/entrypoints/)
and [WebSockets](https://doc.traefik.io/traefik/expose/overview/#exposing-websocket-services).
On managed edges, start with private-peer trust (`uniquelocal`), verify visitor
addresses in the audit log, and explicitly add any documented extra proxy hops.
Do not use `true` to fix an address mismatch: an appended client header can then
forge the address used by rate limits. Restrict `/internal/*` and `/metrics` at
the edge before public use. The domain-check route relies on this proxy block;
these managed templates do not themselves install an edge firewall rule.

## Dokploy

`deploy/dokploy/` is a self-contained upstream template bundle: Compose,
`template.toml`, `meta.json` and the existing Helpdock logo. Import the template
using Dokploy's template import, review the generated values, then fill the five
S3 fields in Environment before deploying. `base64:32` generates the master key;
the setup token and two database passwords are generated separately. Database
passwords use `hash:32` (random hexadecimal), so they are safe inside URLs;
Dokploy's general `password` helper can contain URL delimiters.

The template domain maps service `api`, port `3000`, through Dokploy's **Domains**
configuration. Dokploy injects Traefik routing; do not add a Caddy service or host
port mappings. Enable HTTPS for your final hostname and update `APP_URL` if you
replace the generated domain. Preserve the generated secrets when importing
again. Restrict the paths listed above in the proxy configuration. Official
[template conventions](https://github.com/Dokploy/templates) and
[Compose domains](https://docs.dokploy.com/docs/core/docker-compose/domains).
Upstream submission is a separate maintainer action, after testing in Dokploy.

## Coolify

Create a **Docker Compose Empty** service and paste
`deploy/coolify/docker-compose.yml`. Set the required S3 variables. The template
uses `SERVICE_URL_API_3000` for the public URL, `SERVICE_REALBASE64_32_MASTERKEY`
for the 32-byte master key and shared generated password variables for setup and
Postgres. `SERVICE_BASE64` is **not** a base64-encoded byte sequence in Coolify and
is unsuitable for this key. Check that the api domain uses HTTPS and internal
port 3000, then deploy. Add the proxy path restrictions above. Keep generated
values on redeploy. The template stays in-repo; upstream listing waits.
See [Coolify Compose configuration](https://coolify.io/docs/applications/builds/docker-compose).

## Render

The Blueprint provisions paid api and worker services, Postgres 17 and Key Value
with `noeviction`. It shares the api's secrets with the worker through service
references. `APP_MASTER_KEY`, `HD_SETUP_TOKEN`, `METRICS_TOKEN` and a runtime-role
password (`HELPDOCK_APP_PASSWORD`) are generated. Bring the S3 values and your
intended public `APP_URL`.

**This is a two-step setup.** Render's Blueprint cannot interpolate a runtime
connection string from the owner URL and the generated app password. Do not put
the owner connection in `DATABASE_URL`: Helpdock refuses it.

1. Start the Blueprint. For the initial `DATABASE_URL` prompt, use
   `postgres://provisioning_pending:pending@localhost/helpdock`. The deliberately
   wrong role makes the api stop before creating `helpdock_app`; do not use
   `helpdock_app` with a temporary password, because migrations would create it
   with that password and leave it unchanged later. The api/worker's first deploy
   will fail until step 2; the database and Key Value are provisioned independently.
2. Read Postgres's **internal** connection details and the api's generated
   `HELPDOCK_APP_PASSWORD`. Assemble a URL with username `helpdock_app`, that
   password **percent-encoded**, the same host, port and database. Replace
   `DATABASE_URL` on the api and worker with it. Keep the owner URL in
   `DATABASE_MIGRATION_URL`. Set `APP_URL` to the actual HTTPS service/domain URL.
3. Deploy the api first. Migration `0001` creates the restricted role from the
   runtime URL; `0038` runs `CREATE EXTENSION IF NOT EXISTS vector` (and `0008`
   enables `pg_trgm`). No separate extension startup command is needed. Start or
   redeploy the worker once `/ready` is 200. Both roles use the image entrypoint.
4. Add path restrictions at your edge before public use, and finish setup below.

Changes to `sync: false` inputs are not applied by subsequent Blueprint syncs;
edit the service environment and keep worker references/values consistent.
A failed deployment saying permission denied for role or extension creation
requires investigating the managed owner permissions; never relax runtime RLS
or use owner credentials to bypass it. Live managed-role provisioning has not
been verified by the local Compose tests.

Sources: [Blueprint reference](https://render.com/docs/blueprint-spec),
[Postgres credentials](https://render.com/docs/postgresql-credentials),
[extensions](https://render.com/docs/postgresql-extensions),
[database connections](https://render.com/docs/postgresql-creating-connecting),
[WebSockets](https://render.com/docs/websocket).

## DigitalOcean

**Manual spec import is required.** The documented Deploy to DigitalOcean button
supports one service with an optional dev database, and cannot attach managed
databases. Helpdock requires a worker and managed Valkey too. The website's
DigitalOcean link therefore opens this guide. `.do/deploy.template.yaml` retains
the complete spec under `spec:` for reference; it is not advertised as a working
one-click button. Use `.do/app.yaml` for import.

1. Create managed PostgreSQL 17 and Valkey clusters in your chosen region.
   Create a `helpdock` database owned by `doadmin`. Retain Valkey's `noeviction`
   policy. Add the app as a trusted source for both databases.
2. Replace both `cluster_name` placeholders in `.do/app.yaml` and set the matching
   app region. The Postgres binding selects `doadmin` for migrations. Fill
   `DATABASE_URL` with the same database endpoint as `helpdock_app` and a new,
   percent-encoded password. Migrations create that role; do not provision it as
   a privileged default user in the dashboard. Use `sslmode=require` in both
   Postgres URLs, and `rediss://` for Valkey. Current Valkey connections use
   publicly trusted certificates; no TLS-verification bypass is needed.
3. Fill `APP_MASTER_KEY`, `HD_SETUP_TOKEN`, and all S3 values. The app-level env
   values are shared by api and worker. `APP_URL` uses the platform's bindable
   public app URL. For Spaces or R2 use the storage configuration above.
4. Import the app spec in App Platform, or use
   `doctl apps create --spec .do/app.yaml`. This creates billable resources.
   Keep one api instance: Socket.IO's polling transport requires affinity when
   scaling, which these templates do not configure. HTTP and WebSockets share
   port 3000, with `/` routed to the api without a prefix rewrite. Restart the
   worker after the api's first successful migration if it started too early.
5. Configure the edge path restrictions above and finish setup below. Test a
   real browser's WebSocket upgrade before accepting traffic.

Sources: [button restrictions](https://docs.digitalocean.com/products/app-platform/how-to/add-deploy-do-button/),
[app spec](https://docs.digitalocean.com/products/app-platform/reference/app-spec/),
[managed database attachment](https://docs.digitalocean.com/products/app-platform/how-to/manage-databases/),
[GHCR images](https://docs.digitalocean.com/products/app-platform/how-to/deploy-from-container-images/),
[pgvector](https://docs.digitalocean.com/products/vector-databases/postgresql/how-to/enable-pgvector/),
[Valkey TLS](https://docs.digitalocean.com/products/databases/valkey/how-to/connect/),
[eviction policies](https://docs.digitalocean.com/products/databases/valkey/how-to/choose-eviction-policies/),
and DigitalOcean's [WebSocket example](https://github.com/digitalocean/sample-websocket)
(archived; live WebSocket verification remains an operator check).

## First run and custom domains

Wait for `GET /ready` to return 200, then open `APP_URL` and complete the existing
[first-run wizard](install.md#first-run): retrieve the setup key from your
platform's secret environment, create the install administrator, enrol TOTP,
configure email and create your first brand. Test sign-in and attachment upload
and download, and send a test ticket before inviting staff. A failed `/ready`
response names the failing dependency; inspect api/worker logs and connection
settings rather than replacing the readiness check with `/health`.

Every path here uses platform TLS rather than Caddy's on-demand certificates.
For **each brand help-center hostname**, add DNS verification records in Helpdock
and add the hostname to the platform/proxy **by hand**, mapped to the api with
its original Host intact. Wait for the platform certificate before verifying TLS
in Helpdock. `/internal/domain-check` cannot provision a platform certificate.
Keep that endpoint private. See [custom domains](install.md#custom-domains).

## Backups and upgrades

Back up Postgres with `pg_dump -Fc`, the entire private S3 bucket and the secret
environment including `APP_MASTER_KEY`. Store them together in a restricted,
independent backup location. Provider snapshots do not include the bucket or
master key. Rehearse restoration as in [operations](operations.md#backups) and
[the restore drill](restore-drill.md); container volumes are not backups.

Before upgrading, read release notes, take a fresh backup, then change **both**
api and worker image tags to the same published release. Stop the worker while
the api applies migrations; wait for `/ready`, then start the matching worker.
Keep credentials and persistent volumes. Do not downgrade an image over a changed
schema: restore the matching pre-upgrade database, bucket and environment if a
rollback is needed. Follow [operations › upgrading](operations.md#upgrading).

## Excluded targets

Cloudflare Workers/Pages cannot run this Node container and its continuous
worker, IMAP and Socket.IO processes without changing the architecture. R2
storage is supported independently of Workers. Railway and cloud-init remain
separate M15 work; this change does not ship either path. See
[ADR 0044](../decisions/0044-supported-deploy-targets.md).
