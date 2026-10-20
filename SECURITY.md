# Security Policy

Helpdock handles customer conversations, contact data and third-party credentials. Security issues are treated as the highest priority.

## Supported versions

Helpdock 1.0.0 was released on 2026-10-20. The latest minor release line receives security fixes, published as patch releases; older lines do not.

| Version | Security fixes |
|---|---|
| 1.0.x | Yes |
| Before 1.0.0 | No |

Upgrade to the newest patch of the latest minor release to receive fixes. [Upgrading](docs/guides/operations.md#upgrading) explains how, and every release image's signature can be verified as the [release guide](docs/guides/release.md#verify-the-image-signature) describes.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report privately through [GitHub private vulnerability reporting](https://github.com/Docker-Hunterpedia/Helpdock/security/advisories/new), or by email to the security contact, [contact@oday-bakkour.com](mailto:contact@oday-bakkour.com).

Please include:

- A description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- The affected version or commit.

## What to expect

- Acknowledgement within 3 business days.
- An assessment and expected fix timeline within 10 business days.
- Credit in the release notes once a fix is published, unless you prefer to stay anonymous.

## Scope

In scope: the Helpdock codebase, the widget, the tenant REST API, the help center, and the Docker Compose deployment as shipped.

Out of scope: vulnerabilities in third-party services you connect (LLM providers, SMTP providers, Telegram), denial-of-service by resource exhaustion, and issues that require a compromised host or admin account.

## Baseline

1.0 was walked against OWASP ASVS 4.0.3 Level 2, requirement by requirement ([record](docs/completed/asvs-l2.md)). Dependencies are monitored with Renovate and `pnpm audit` in CI.
