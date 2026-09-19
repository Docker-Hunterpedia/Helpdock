# Changesets

This folder holds one Markdown file per change that will appear in a release.
[`docs/guides/release.md`](../docs/guides/release.md) is the full procedure; this
is the short version.

Add one with `pnpm changeset` in the same pull request as the change:

```bash
pnpm changeset
```

It asks for a bump — `patch`, `minor` or `major` — and a sentence. Helpdock ships
as one artefact, so there is one version for the whole product and the prompt
only ever offers `@helpdock/api`: `apps/api/package.json` is where that version
lives, because it is what the System page reports and what the image is tagged
with. Every other workspace is in `ignore` in `config.json`.

A change with nothing to say in a release note — a test, a comment, a CI tweak —
needs no changeset.

Pushing to `main` opens or updates a "chore: version packages" pull request that
consumes these files, bumps the version and writes `apps/api/CHANGELOG.md`.
Merging it is what makes a release possible; pushing the `v<version>` tag is what
makes it happen.
