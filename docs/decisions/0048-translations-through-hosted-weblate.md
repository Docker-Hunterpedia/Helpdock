# 0048 Translations through Hosted Weblate

Status: proposed
Date: 2026-10-20

## Context

M17 adds customer-facing locales (about 450 strings each) and later admin
locales (about 5,800 strings across 29 namespaces). The maintainer cannot write
or review every language, so contributors need to translate without touching
code, and the result must stay safe: catalogs reach the widget, the help center
and customer emails. The AGENTS.md rule that every user-facing string goes
through i18next catalogs is unchanged.

Planned in [M17 Apps and languages](../in-development/M17-apps-and-languages.md)
(M17-02).

## Decision

1. Translations are made in **Hosted Weblate** on its free plan for libre
   projects: one component per namespace, in i18next JSON v4 format.
2. Weblate opens pull requests to a `translations` branch and never pushes to
   `main`. A maintainer approves each one.
3. CI checks every catalog change: valid JSON, `{{placeholder}}` parity with
   `en`, CLDR plural keys, no markup (catalog strings are text), a length budget
   for widget keys, and no keys that are not in `en`.
4. A glossary of Helpdock terms and artboard snapshots from
   `docs/design/screens/` give translators context. Each language has a
   CODEOWNERS reviewer; `ar` stays maintainer-reviewed.
5. Machine suggestions may be used in the editor, but a string ships only once
   a reviewer approves it.

## Consequences

- Weblate is a contributor service, not a runtime dependency, but it gains pull
  request access to the repository, which is why this is recorded.
- Translator time is outside the project's effort estimates; wave 1 may need
  paid translation (owner decision D-48).
- `CONTRIBUTING.md` gains a translation section.

## Alternatives considered

- **Crowdin:** proprietary, though free for open source. Weblate is itself open
  source and self-hostable, which fits an AGPL project.
- **Self-hosted Weblate:** possible later; adds a service for the maintainer to
  run.
- **Pull-request-only translation:** no tooling, but contributors edit JSON by
  hand without a glossary or screenshot context.
