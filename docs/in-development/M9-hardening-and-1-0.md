# M9 Hardening and 1.0

Status: in progress
Started: 2026-10-05
Owner: @Docker-Hunterpedia

## Scope

Full deliverable list and specs: [PRD §4 · M9 Hardening and 1.0](../planning/PRD.md#m9-hardening-and-10).
Depends on everything above. Code-side deliverables (security scanning, load tests, docs, release pipeline, accessibility audit) start in parallel; the external pentest, outside usability testers, clean-VM onboarding and restore drill need people and hardware and are tracked as external dependencies.

## Deliverables

| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M9-01 | External pentest of widget + API; fix all High and Medium findings | | planned |
| M9-02 | OWASP ASVS L2 checklist walk-through with evidence recorded in `docs/completed/` | | planned |
| M9-03 | Load tests | | planned |
| M9-04 | Accessibility audit (axe + manual keyboard) on widget and help center | | planned |
| M9-05 | Semgrep rules for Nest, ZAP baseline scan on release branches, SBOM on release | | planned |
| M9-06 | User docs under `docs/guides/` | | planned |
| M9-07 | Onboarding test on a clean VM against the 30-minute target; usability pass with three outs | | planned |
| M9-08 | Release pipeline | | planned |
| M9-09 | Tag `1.0.0` | | planned |
| M9-10 | Restore drill | | planned |

## Exit criteria

Copied from the PRD, ticked as they are met.

- [ ] All success metrics in §2 are met and recorded, including the AI evaluation thresholds and the restore drill.
- [ ] `ghcr.io/docker-hunterpedia/helpdock:1.0.0` is published and the README install instructions work against it.

## Open questions

- None yet.

## Pull requests

- None yet.
