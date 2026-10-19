# 0042 Update checks against GitHub send nothing about the install

Status: proposed
Date: 2026-10-20

## Context

Operators learn about new releases only by watching GitHub. [M15 Self-host
operations](../in-development/M15-self-host-operations.md) adds an Updates card on
the System page and a notice to install admins. Any call home from a self-hosted
product raises two concerns: what it reveals about the install, and whether the
response can be used against it. DOMAIN-RULES §13 requires every outbound fetch to go
through the SSRF-safe client.

## Decision

1. A worker job, `system.update_check`, runs every 6 hours with jitter and on demand
   ("Check now").
2. It goes through `safeFetch` with a host allow-list of `api.github.com`,
   `github.com`, `objects.githubusercontent.com` and
   `release-assets.githubusercontent.com`, a 30 s limit and a 1 MiB cap.
3. It sends a constant user agent, `Helpdock-update-check`, and **no version, host
   name or instance id**. It reads the public releases list and the newest stable
   `release-manifest.json`.
4. The response is untrusted data: Zod-validated, and release text is never
   rendered; the card shows version, date and the security flag and links to the
   GitHub release.
5. It stores `{latest, publishedAt, security, url, minUpgradeFrom}` in install
   settings. A new release gives install admins one in-app notification; an email is
   sent, through the outbox, only when the manifest marks the release `security`.
6. It is off with `HD_UPDATE_CHECK=false` or the `system.updateCheck` setting, and
   the installer's wizard asks.

## Consequences

- GitHub sees an address fetching public release metadata four times a day, and
  nothing else; the unauthenticated limit (60 requests an hour per address) is far
  above that.
- A tampered or hostile response cannot inject markup or reach a private address.
- Operators who want no outbound traffic turn it off in one place.

## Alternatives considered

- **A project-run update server.** Would let the project count installs, but it is a
  hosted service the project would have to run and secure, against the self-hosted
  principle.
- **Sending the running version to get a tailored answer.** Comparing locally gives
  the same result without revealing anything.
- **Rendering release notes in the admin.** Untrusted Markdown in a privileged page;
  a link is enough.
