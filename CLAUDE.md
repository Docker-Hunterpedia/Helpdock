@AGENTS.md

## Claude Code specifics

- Use `gh` for GitHub operations. Open pull requests against `main` and leave merging to the user.
- Before opening a PR, run the matching skill: `clean-code-guard` for production code, `test-guard` for tests, `docs-guard` for documentation.
- When adding a dependency, check current versions with Context7 rather than relying on training data. The stack table in `docs/planning/ARCHITECTURE.md` pins the intended majors.
- Keep responses concise. Lead with the outcome.
