# In development

No milestone is in progress. 1.0.0 was released on 2026-10-20, when M9
Hardening and 1.0 shipped.

The 1.x milestones of [PRD Phase 5](../planning/PRD.md#phase-5--1x) are
planned, and their plan documents are here with `Status: planned (not
started)`. A milestone starts when its status changes to `in progress` and its
issues are created (PRD §3). The open questions of all of them are in
[decisions-1-x.md](../planning/decisions-1-x.md).

| Plan | Milestone | Proposed release | Effort (person-days) |
|---|---|---|---|
| [M12-ai-workspace.md](M12-ai-workspace.md) | M12 AI workspace | 1.1 | about 72 |
| [M13-ai-actions-and-integrations.md](M13-ai-actions-and-integrations.md) | M13 AI actions and integrations | 1.1 (M13-09 to M13-11), 1.2 (the rest) | about 72.5 |
| [M15-self-host-operations.md](M15-self-host-operations.md) | M15 Self-host operations | 1.2 | about 67 |
| [M16-more-importers-and-undo.md](M16-more-importers-and-undo.md) | M16 More importers and undo | 1.2 | about 79 |
| [M17-apps-and-languages.md](M17-apps-and-languages.md) | M17 Apps and languages | 1.3 | about 59 |
| [M18-sign-in-options.md](M18-sign-in-options.md) | M18 Sign-in options | 1.1 | about 32.5 |
| [M19-customer-surfaces-polish.md](M19-customer-surfaces-polish.md) | M19 Customer surfaces polish | 1.2 | about 47 |
| [M20-native-clients-and-sdks.md](M20-native-clients-and-sdks.md) | M20 Native clients and SDKs | later 1.x | 45–57 |

M0 Skeleton shipped on 2026-09-19, M1 Ticketing core on 2026-09-25, M2
Email channel, M3 Automation and SLAs, M4 Widget and realtime and M5 Help
center on 2026-09-27, M6 Telegram, M7 AI and M8 API, webhooks, reports
on 2026-10-07, M10 Meta channels on 2026-10-13, M11 SSO and migration on
2026-10-18, M9 Hardening and 1.0 on 2026-10-20, and M14 Inbox productivity on 2026-11-01; their documents are in
[`../completed/`](../completed/README.md).

When a milestone starts, add a file here named `M<n>-<slug>.md` using this template:

```markdown
# M0 Skeleton

Status: in progress
Started: 2026-09-16
Owner: @Docker-Hunterpedia

## Scope
Link to the milestone section in the PRD.

## Deliverables
| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M0-01 | Monorepo | #3 | in progress |

## Exit criteria
Copied from the PRD, ticked as they are met.
- [ ] ...

## Open questions
- ...

## Pull requests
- #12 ...
```
