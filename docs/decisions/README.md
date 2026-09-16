# Architecture decision records

One file per decision, named `NNNN-short-slug.md`, numbered in order of creation. Accepted ADRs are never edited; a change of mind gets a new ADR that supersedes the old one.

Pending decisions listed in [ARCHITECTURE.md §19](../planning/ARCHITECTURE.md#19-open-decisions-small-can-settle-during-m0) should each get an ADR when settled during M0: article editor library, web push, CAPTCHA default, queue dashboard.

## Template

```markdown
# 0001 Use TipTap for rich-text editing

Status: proposed | accepted | superseded by 0007
Date: 2026-09-16

## Context
What situation forces this decision. Constraints, requirements, prior art.

## Decision
What we are doing, stated plainly.

## Consequences
What becomes easier, what becomes harder, what we give up.

## Alternatives considered
- Option B: why not.
```
