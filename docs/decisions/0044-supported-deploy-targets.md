# 0044 Supported deploy targets: Compose through the installer, Coolify and cloud-init

Status: proposed
Date: 2026-10-20

## Context

Helpdock 1.0 supports Docker Compose only (REQUIREMENTS §5.6). The backlog listed
"Cloudflare / Vercel / Railway / Coolify deploy paths". Helpdock needs long-running
workers, IMAP pollers, Socket.IO rooms with a Redis adapter, Postgres with pgvector,
and Caddy's on-demand TLS for brand help-center domains. [M15 Self-host
operations](../in-development/M15-self-host-operations.md) adds an installer and an
external-proxy override, which change what each target costs.

## Decision

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

- Compose stays the only runtime the project tests; every supported path is Compose
  underneath.
- The backlog loses Vercel and Cloudflare for good, with the reason written down.
- The external-proxy override becomes a supported configuration, with its
  custom-domain limitation documented.

## Alternatives considered

- **Maintaining Railway or Kubernetes templates now.** A large test matrix and
  per-release upkeep for few users, with features (brand domains) that do not work on
  Railway.
- **Keeping Vercel and Cloudflare in the backlog.** Keeps a promise the architecture
  cannot keep.
