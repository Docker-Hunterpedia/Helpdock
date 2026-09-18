@AGENTS.md

## Claude Code specifics

- Use `gh` for GitHub operations. Open pull requests against `main` and leave merging to the user.
- You (the orchestrating session) own the design canvas. Before delegating any deliverable with a UI, add its artboard(s) to the canvas with the Artifact tool, following DESIGN.md, and reference the artboard names in the agent's prompt.
- Before opening a PR, run the matching skill: `clean-code-guard` for production code, `test-guard` for tests, `docs-guard` for documentation.
- When adding a dependency, check current versions with Context7 rather than relying on training data. The stack table in `docs/planning/ARCHITECTURE.md` pins the intended majors.
- Follow the Definition of done in AGENTS.md without being asked: when you add or change something, write the unit test, the integration test if it touches infrastructure, the Playwright test if it has a screen, and update the docs, all in the same branch. Treat a task as incomplete until those exist.
- Keep responses concise. Lead with the outcome.
