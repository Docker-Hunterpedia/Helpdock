# Security Policy

Helpdock handles customer conversations, contact data and third-party credentials. Security issues are treated as the highest priority.

## Supported versions

Helpdock is pre-release. Once 1.0 ships, the latest minor release receives security fixes.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report privately through [GitHub private vulnerability reporting](https://github.com/Docker-Hunterpedia/Helpdock/security/advisories/new).

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

v1 targets OWASP ASVS Level 2. Dependencies are monitored with Renovate and `pnpm audit` in CI.
