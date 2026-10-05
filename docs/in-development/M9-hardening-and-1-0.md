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
| M9-04 | Accessibility audit (axe + manual keyboard) on widget and help center | | built in branch (M9-04): [notes](#m9-04-accessibility-audit); results in [accessibility-audit.md](../completed/accessibility-audit.md); screen-reader pass outstanding |
| M9-05 | Semgrep rules for Nest, ZAP baseline scan on release branches, SBOM on release | | planned |
| M9-06 | User docs under `docs/guides/` | | planned |
| M9-07 | Onboarding test on a clean VM against the 30-minute target; usability pass with three outs | | planned |
| M9-08 | Release pipeline | | planned |
| M9-09 | Tag `1.0.0` | | planned |
| M9-10 | Restore drill | | planned |

## M9-04 Accessibility audit

- **Automated.** `apps/widget/e2e/a11y-audit.spec.ts` runs axe (WCAG 2.1 A and AA)
  on every widget mode and state, and `apps/api/e2e/help-center-a11y.spec.ts`
  on every help center page type, including the 404, 410 and internal-only
  wall. Both run in `en` and `ar`, light and dark, and both are in the CI jobs
  that already run those Playwright projects.
- **Keyboard.** Tab order and a visible ring on every stop, the skip link,
  Escape, and the widget's focus trap at phone width.
- **Fixed.**
  - The help center has a skip link, and every `<main>` can take focus.
  - Article body links are underlined. Axe found them told apart by colour
    alone in dark mode.
  - At phone width the widget is a modal dialog that keeps Tab inside it, and
    the launcher no longer covers Send.
  - The widget's theme sheet is replaced only when it changes, and the e2e axe
    helper waits for the widget to settle. This addresses the M4 flake.
- **Closed M5 gaps** with existing artboards:
  - "What was missing?" after a "No" (`HelpCenter/Article-AR` panels 2 and 3).
    The form takes an optional `comment` (`hcFeedbackFormSchema`), and the
    step travels in `?feedback=no`.
  - The CSAT page's "Browse the help center" (`CsatEN`).
    `csatBrandSchema.helpCenterUrl` comes from `publicHelpCenterUrl`
    (`apps/api/src/help-center/site/site-url.ts`).
- **Outstanding:** the screen-reader, zoom and forced-colours pass listed in
  the [audit](../completed/accessibility-audit.md#still-to-do-by-a-person).

## Exit criteria

Copied from the PRD, ticked as they are met.

- [ ] All success metrics in §2 are met and recorded, including the AI evaluation thresholds and the restore drill.
- [ ] `ghcr.io/docker-hunterpedia/helpdock:1.0.0` is published and the README install instructions work against it.

## Open questions

- None yet.

## Pull requests

- None yet.
