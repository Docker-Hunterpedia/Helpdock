@AGENTS.md

## Claude Code specifics

- Use `gh` for GitHub operations. Open pull requests against `main` and leave merging to the user.
- You (the orchestrating session) own the design canvas. Before delegating any deliverable with a UI, add its artboard(s) to the canvas with the Artifact tool, following DESIGN.md, and reference the artboard names in the agent's prompt.
- Before opening a PR, run the matching skill: `clean-code-guard` for production code, `test-guard` for tests, `docs-guard` for documentation.
- When adding a dependency, check current versions with Context7 rather than relying on training data. The stack table in `docs/planning/ARCHITECTURE.md` pins the intended majors.
- Follow the Definition of done in AGENTS.md without being asked: when you add or change something, write the unit test, the integration test if it touches infrastructure, the Playwright test if it has a screen, and update the docs, all in the same branch. Treat a task as incomplete until those exist.
- Keep responses concise. Lead with the outcome.

## Navigating the code

Pick the tool by the question, and put the same rules in every subagent prompt that explores code. Each tool is optional; when one is not installed, fall back to the next.

- **How does X behave?** Read the planning docs first (DOMAIN-RULES, ARCHITECTURE). They state the intended behaviour, which the code must match.
- **Where is X defined, who calls or implements it?** Use the `LSP` tool (`goToDefinition`, `findReferences`, `incomingCalls`, `goToImplementation`). It answers from the TypeScript compiler, so results are exact. The tsconfigs of `apps/api`, `apps/helpcenter` and every package exclude `*.test.ts`, so LSP misses test usages there. The first call after start-up can return partial results while the project loads; repeat it once.
- **What breaks if I change X, and which tests cover it?** Use graphify: `graphify affected "<symbol>"` before editing shared code, `graphify path "<A>" "<B>"` for how two pieces connect, `graphify god-nodes` for the architectural hubs. Seed it with an exact symbol name; free-text `graphify query` matches keywords, not meaning, and returns noise on a repository this size.
- **Text, config, SQL, strings?** Use Grep.
- Read raw files only for lines one of the above has located.

Setup, once per machine:

- LSP: `npm i -g typescript-language-server typescript@6`. The repository's TypeScript 7 is the native compiler and ships no `tsserver`, so the language server needs TypeScript 6 installed globally.
- graphify: `uv tool install 'graphifyy[sql]'`, then `graphify extract . --code-only --no-viz` to build the graph (local, no API key) and `graphify hook install` to rebuild it after every commit, checkout and merge. The hook install also writes a merge-driver line to a root `.gitattributes`; move it to `.git/info/attributes` rather than committing it. Without the git hooks, run `graphify update .` after changing code. `graphify-out/` is local; never commit it.
