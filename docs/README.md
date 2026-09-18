# Helpdock documentation

Project documents are organised by lifecycle stage. A document moves between folders as the work it describes progresses.

| Folder | What lives here | Moves on when |
|---|---|---|
| [`planning/`](planning/) | [PRD](planning/PRD.md) with phases, milestones and status board; [requirements](planning/REQUIREMENTS.md); [architecture](planning/ARCHITECTURE.md); [domain rules](planning/DOMAIN-RULES.md) with the behavioural contracts. Agreed scope that is not yet being built. | A milestone starts: its spec is copied or split into `in-development/`. |
| [`in-development/`](in-development/) | One document per milestone or feature currently being built: scope, task checklist, open questions, links to PRs. | The feature ships and is verified. |
| [`completed/`](completed/) | Specs for shipped features, updated to describe what was actually built. Reference for maintainers. | Never. Superseded docs get a note pointing to the replacement. |
| [`decisions/`](decisions/) | Architecture Decision Records (ADRs). One file per decision, numbered, never edited after acceptance. | Never. A reversed decision gets a new ADR that supersedes it. |

Guides live under [`guides/`](guides/), starting with [development.md](guides/development.md) on installing, building and testing the monorepo. Install, configuration, channel and API guides are added as the features they describe ship.

## Conventions

- Markdown only. Headings in sentence case. Wrap lines naturally, no hard limit.
- Link between documents with relative paths so links survive folder moves.
- Every document starts with a title and a one-line summary. Milestone docs also carry a status line: `Status: planned | in progress | shipped`.
- Dates are absolute (`2026-09-16`), never relative.
