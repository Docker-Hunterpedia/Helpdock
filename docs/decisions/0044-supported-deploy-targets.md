# 0044 Supported deploy targets: Compose and platform templates

Status: accepted for #337 platform templates; remaining installer/cloud-init scope proposed
Date: 2026-10-20

## Context

Helpdock 1.0 supports Docker Compose only (REQUIREMENTS §5.6). The backlog listed
"Cloudflare / Vercel / Railway / Coolify deploy paths". Helpdock needs long-running
workers, IMAP pollers, Socket.IO rooms with a Redis adapter, Postgres with pgvector,
and Caddy's on-demand TLS for brand help-center domains. [M15 Self-host
operations](../in-development/M15-self-host-operations.md) adds an installer and an
external-proxy override, which change what each target costs.

## Original decision (amended below)

1. **Supported:** Docker Compose on any Linux VPS through the installer, with a
   cloud-init recipe (`deploy/cloud-init/helpdock.yaml`) that installs Docker from
   the distribution and runs the verified installer, with notes for Hetzner,
   DigitalOcean, Akamai/Linode and Lightsail.
2. **Supported:** a Coolify service template on the external-proxy override, kept in
   `deploy/coolify/` and submitted upstream. Help-center custom domains are added in
   Coolify by hand, because the external proxy has no on-demand certificates.
3. **Community:** Dokploy and CapRover templates are accepted under
   `deploy/community/`, labelled unmaintained.
4. **Later:** a DigitalOcean Marketplace 1-Click image, once the installer has been
   stable for two releases.
5. **Spike only:** Railway, a one-day spike written up without a maintained template.
   It needs a custom Postgres image with pgvector, external S3 and four services, and
   its edge terminates TLS, so on-demand certificates for brand domains do not work.
6. **Backlog:** Kubernetes and Helm, until a community maintainer appears.
7. **Dropped:** Vercel and Cloudflare. Neither runs long-lived workers, IMAP pollers,
   Socket.IO rooms or Caddy on-demand TLS; they would need a different architecture.

## Consequences

- Compose stays the locally exercised reference runtime; managed-platform templates
  have configuration checks and require live operator validation.
- The backlog loses Vercel and Cloudflare for good, with the reason written down.
- The external-proxy override becomes a supported configuration, with its
  custom-domain limitation documented.

## Alternatives considered

- **Maintaining Railway or Kubernetes templates now.** A large test matrix and
  per-release upkeep for few users, with features (brand domains) that do not work on
  Railway.
- **Keeping Vercel and Cloudflare in the backlog.** Keeps a promise the architecture
  cannot keep.

## Amendment: owner request, 2026-10-20 (#337)

Dokploy moves from community to **maintained**, in `deploy/dokploy/`. Render
and DigitalOcean App Platform move from not listed to **template-supported**.
Coolify stays supported, kept in-repo; upstream listing waits. Cloud-init and
Railway's spike remain separate M15 work, outside #337.

Platform templates use an external proxy, with no Caddy and no on-demand TLS.
Operators add each verified brand help-center domain to their platform by hand.
Cloudflare **Workers and Pages stay dropped**: the existing Node container,
continuous BullMQ/IMAP workers and Socket.IO server cannot run there without a
runtime redesign. Cloudflare **R2 is supported as S3-compatible storage**.

Compose remains the locally exercised reference runtime. Managed platform
support means maintained configuration and configuration checks, not proof of a
live deployment on each platform. Platform restrictions and manual provisioning
steps are recorded in [the deploy guide](../guides/deploy.md).

The deployment contract tests add root **development-only** dependencies `yaml`
(2.x) and `smol-toml` (1.x), to parse the actual platform formats rather than
matching YAML/TOML with regular expressions. No runtime dependency changes.
