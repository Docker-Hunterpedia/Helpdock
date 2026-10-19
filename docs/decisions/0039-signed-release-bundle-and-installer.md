# 0039 A signed release bundle, verified by the installer

Status: proposed
Date: 2026-10-20

## Context

Installing Helpdock today means following the install guide by hand: copy the
Compose file, the Caddyfiles and `postgres/init.sql`, write `.env`, pull the image.
[M15 Self-host operations](../in-development/M15-self-host-operations.md) adds a
one-command installer (`curl … | sh`) and an upgrade verb. A script fetched over the
network that then fetches and runs containers is the most attractive target in the
project: whoever controls what it downloads controls every install.

The Helpdock image is already signed keylessly with Cosign by `release.yml` and
verified against the workflow identity (M9-08). A `SHA256SUMS` file fetched from the
same release as the files it describes only protects against corruption, not against
a compromised release. Third-party images in `docker/docker-compose.yml` are pulled
by moving tags (`caddy:2`, `redis:7-alpine`, `pgvector/pgvector:pg17`,
`clamav/clamav`), so what runs can change without a Helpdock release.

## Decision

1. Each release publishes four more assets: `helpdock-deploy-<v>.tar.gz` (Compose
   file, overrides, both Caddyfiles, `postgres/init.sql`, `env.template`,
   `helpdock-ctl`), `install.sh`, `release-manifest.json` and `SHA256SUMS`, with a
   Cosign keyless bundle `SHA256SUMS.sigstore.json` produced by
   `cosign sign-blob --bundle`.
2. A release-time step pins every third-party image in the bundle's Compose file by
   digest. `HELPDOCK_IMAGE` carries the Helpdock image by digest, and `.env` pins the
   digest, never a tag.
3. The installer and `helpdock-ctl upgrade` verify `SHA256SUMS` with Cosign before
   using anything in the bundle: the host's `cosign` when present, otherwise Cosign
   run from a container whose digest is pinned inside the already-verified
   `install.sh`. The certificate identity must be
   `…/.github/workflows/release.yml@refs/heads/main` with the issuer
   `https://token.actions.githubusercontent.com`. Releases tagged by hand
   (`@refs/tags/v…`) are accepted only with an explicit `--allow-tag-identity`.
4. The Helpdock image is verified with `cosign verify` by digest against the same
   identity.
5. `release-manifest.json` is listed in `SHA256SUMS`, so it is signed indirectly. It
   names the signed image digest, the minimum version an upgrade may start from, the
   migration count and whether any is irreversible, the third-party digests, and the
   `security` and `autoUpdate` flags set from Changesets front-matter.
6. Air-gapped installs use `--offline <dir>` with a `trusted_root.json` exported on a
   connected machine; the bundle is still verified.

## Consequences

- Trust chains from one script whose own hash is published beside it and in the
  README; the verify-first path (download, `cosign verify-blob`, read, run) is
  documented for operators who will not pipe to a shell.
- A moved tag can no longer change what an install runs; image updates arrive only
  through a release.
- Sigstore becomes a dependency of installing and upgrading. An outage blocks both;
  `--offline` with a trusted root and a clear error naming the manual verify path
  are the fallback.
- No runtime npm dependency is added. Cosign is a release-time and host-side tool
  `release.yml` already uses.
- A compromised maintainer account or a malicious merge to `main` still produces a
  validly signed release. Signing proves where a release came from, not that it is
  good; [ADR 0040](0040-automatic-updates-opt-in-and-delayed.md) limits the blast
  radius for automatic updates.

## Alternatives considered

- **`SHA256SUMS` alone, fetched from the same release.** Catches corruption only.
- **A GPG key held by the maintainer.** A long-lived secret to guard and rotate,
  where keyless signing through GitHub OIDC already works for the image.
- **Requiring `cosign` on the host.** One more install step before the installer;
  running it from a pinned container needs only Docker, which is required anyway.
- **Tags for third-party images, as today.** Simpler, but lets upstream changes reach
  installs without a Helpdock release.
