# Releasing Helpdock

How a commit on `main` becomes an image an operator can run. For maintainers;
[the install guide](install.md) is the other side of the same story.

Helpdock ships as **one artefact**: the container image
`ghcr.io/docker-hunterpedia/helpdock`. Everything here exists to make that image
traceable — which commit it was built from, what changed since the last one, and
what is inside it.

## The short version

1. Every pull request that changes behaviour adds a changeset: `pnpm changeset`.
2. Merging to `main` opens or updates a **"chore: version packages"** pull
   request. It bumps the version and writes the changelog.
3. Merge that pull request, then summarise the release in the root
   [`CHANGELOG.md`](../../CHANGELOG.md).
4. Tag the merge commit `v<version>` and push the tag.
5. [`release.yml`](../../.github/workflows/release.yml) builds and pushes the
   multi-architecture image, generates a CycloneDX SBOM and creates the GitHub
   Release.

Nothing is published to npm. Every workspace is `"private": true`.

## Where the version lives

In `apps/api/package.json`. Not by accident:

- `apps/api/src/observability/build-info.ts` reads it, so it is the version the
  **System page** shows and `/api/install/system` returns.
- `release.yml` passes it as the `HELPDOCK_VERSION` build argument, which becomes
  the image's `org.opencontainers.image.version` label and its tag.

So there is one version for the product, and Changesets manages it. Every other
workspace is listed in `ignore` in
[`.changeset/config.json`](../../.changeset/config.json), which is why
`pnpm changeset` only ever offers `@helpdock/api`. **A new workspace package is
added to that list** — unless it is meant to carry the product version instead,
which it is not.

Versions are [semantic](https://semver.org). Before 1.0, a minor bump may change
behaviour; say so in the changeset when it does.

## Writing a changeset

In the same pull request as the change:

```bash
pnpm changeset
```

It asks for a bump and a sentence, and writes `.changeset/<some-name>.md`. Commit
it. The sentence is read by somebody deciding whether to upgrade, so write it
for them:

```markdown
---
'@helpdock/api': minor
---

Every `@Param`, `@Query` and `@Body` on a controller handler now names its Zod
schema, and `pnpm check:validation` fails the build for one that does not.
```

A change with nothing to say in a release note — a test, a comment, a CI tweak —
needs no changeset. `pnpm changeset --empty` records that decision explicitly if
you want it on the record.

## The version pull request

[`changesets.yml`](../../.github/workflows/changesets.yml) runs on every push to
`main` and keeps one pull request open from `changeset-release/main`. It:

- deletes the `.changeset/*.md` files it consumed,
- bumps `apps/api/package.json`,
- writes `apps/api/CHANGELOG.md` from the changeset entries, with links to the
  pull requests that carried them.

It force-pushes that branch, so it is always the accumulation of everything
merged since the last release. Do not commit to it by hand.

> **For the repository owner.** The action opens a pull request as
> `github-actions[bot]`, which needs **Settings → Actions → General → Workflow
> permissions → "Allow GitHub Actions to create and approve pull requests"**.
> Without it the job fails with a 403 that says exactly that.

Before merging it, add a section to the root
[`CHANGELOG.md`](../../CHANGELOG.md) under the new version. That file is the
summary — a paragraph and a handful of bullets about what the release is for.
`apps/api/CHANGELOG.md` is the detail. The heading has to read
`## <version> — <date>`, because the release workflow copies the section under it
into the GitHub Release.

## Tagging

A tag is the only trigger. Cut it from a commit on `main` whose `ci` run was
green — nothing in the release workflow re-runs the test suite, on purpose: a
release ships the artefact that was tested, not a second build of a moving
branch.

```bash
git switch main && git pull
git tag -a v0.1.0 -m 'Helpdock 0.1.0'
git push origin v0.1.0
```

A pre-release carries a hyphen — `v0.2.0-rc.1`. The workflow marks the GitHub
Release as a pre-release and does **not** move `:latest`.

## What the tag produces

[`release.yml`](../../.github/workflows/release.yml), in one job:

| | |
|---|---|
| **Image** | `docker/build-push-action` with QEMU and Buildx for `linux/amd64` and `linux/arm64`. The Dockerfile downloads no architecture-specific binary, so one recipe produces both. |
| **Tags** | `ghcr.io/docker-hunterpedia/helpdock:<version>`, plus `:latest` when it is not a pre-release. |
| **Provenance** | `HELPDOCK_GIT_SHA=${{ github.sha }}` is baked in as `org.opencontainers.image.revision` and is what the System page shows next to the version. |
| **Registry** | GHCR, with the run's own `GITHUB_TOKEN` and `packages: write`. No personal access token is stored anywhere. |
| **SBOM** | `anchore/sbom-action` in CycloneDX JSON, generated **from the pushed image** so it covers the base image's Debian packages and ffmpeg, not only `node_modules`. Attached to the Release as `helpdock-<version>.cdx.json`. |
| **Release** | Created from the tag. Its body is the `CHANGELOG.md` section for that version, followed by GitHub's generated list of merged pull requests. |

> **For the repository owner, once.** The first push creates the package as
> **private**. Make it public at
> `https://github.com/orgs/Docker-Hunterpedia/packages` → helpdock → Package
> settings → Change visibility, and link it to the repository so the Packages
> sidebar shows it. Until then `docker pull` fails for everybody but you, and
> [the install guide](install.md) does not work as written.

## After a release

- Check `docker pull ghcr.io/docker-hunterpedia/helpdock:<version>` from a
  machine that is not signed in.
- Check the System page of a fresh install reports that version and that commit.
- Upgrade, backup and restore procedures for operators are in
  [the operations guide](operations.md) and
  [DOMAIN-RULES §10](../planning/DOMAIN-RULES.md).

## If something goes wrong

The tag is the input, so a failed run is re-runnable from the Actions tab
without touching the repository. A tag pointing at the wrong commit is the one
case that needs care: delete it locally and on the remote, then tag again. A
version already pulled by somebody is never re-tagged — publish the next patch
instead.
