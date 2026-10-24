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
3. Summarise the release in the root [`CHANGELOG.md`](../../CHANGELOG.md) in a
   pull request of its own. Run the **ZAP baseline** workflow by hand on the
   version pull request's branch (`changeset-release/main`) and see it pass
   ([security scanning](security-scanning.md#zap-baseline)), then merge the
   version pull request.
4. That merge releases: `changesets.yml` tags the merge commit `v<version>` and
   calls [`release.yml`](../../.github/workflows/release.yml), which builds and
   pushes the multi-architecture image, signs its immutable digest with the
   workflow's GitHub OIDC identity, generates a CycloneDX SBOM and creates the
   GitHub Release.

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
[`CHANGELOG.md`](../../CHANGELOG.md) under the new version, in a separate pull
request. That file is the summary — a paragraph and a handful of bullets about
what the release is for. `apps/api/CHANGELOG.md` is the detail. The heading has
to read `## <version> — <date>`, because the release workflow copies the section
under it into the GitHub Release. Without one, the release body falls back to the
`## <version>` section the version pull request wrote in `apps/api/CHANGELOG.md`.

**Merging the version pull request is the release.** On that push no changesets
are left, so the `tag` job in `changesets.yml` pushes `v<version>` on the merge
commit, once: if the tag already exists it does nothing. The `release` job then
calls `release.yml` with that tag. It calls it directly because a tag pushed
with the workflow's own `GITHUB_TOKEN` starts no other workflow.

## Tagging by hand

A pushed `v*` tag still releases on its own, for a re-release or a pre-release.
Cut it from a commit on `main` whose `ci` run was green — nothing in the release
workflow re-runs the test suite, on purpose: a release ships the artefact that
was tested, not a second build of a moving branch.

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
| **Provenance** | The commit the tag points at is baked in as `HELPDOCK_GIT_SHA`, as `org.opencontainers.image.revision` and is what the System page shows next to the version. |
| **Registry** | GHCR, with the run's own `GITHUB_TOKEN` and `packages: write`. No personal access token is stored anywhere. |
| **Signature** | Cosign keyless signing over the multi-architecture image digest. GitHub OIDC issues the short-lived Fulcio certificate; no private signing key is stored. The workflow verifies the signature and its exact workflow identity before continuing. |
| **SBOM** | `anchore/sbom-action` in CycloneDX JSON, generated **from the pushed image** so it covers the base image's Debian packages and ffmpeg, not only `node_modules`. Attached to the Release as `helpdock-<version>.cdx.json`. |
| **Release** | Created from the tag. Its body is the `CHANGELOG.md` section for that version, followed by GitHub's generated list of merged pull requests. |
| **Website** | A last step dispatches the [Pages workflow](website.md#the-release-number), which stamps the new version and its links into the site. Skipped for a pre-release, and when the run only re-signs a tag that already has a Release. |

The package is public and linked to this repository. A new registry or renamed
package starts private; make it public before calling that release complete.

### Verify the image signature

Verify the immutable digest, not a mutable tag. For example, to resolve and
verify `0.4.0`:

```sh
image='ghcr.io/docker-hunterpedia/helpdock'
version='0.4.0'
digest="$(docker buildx imagetools inspect "$image:$version" --format '{{.Manifest.Digest}}')"

cosign verify \
  --certificate-identity 'https://github.com/Docker-Hunterpedia/Helpdock/.github/workflows/release.yml@refs/heads/main' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  "$image@$digest"
```

The normal Changesets release and the **Run workflow** recovery path use the
`refs/heads/main` identity above. A `v*` tag pushed by hand invokes the workflow
at that tag instead; verify it with the exact
`.../release.yml@refs/tags/v<version>` identity printed in that run.

To sign an existing release without rebuilding it, run **Release** from the
Actions tab on `main` and enter its `v<version>` tag. This resolves the registry
digest, signs and verifies it, and deliberately skips the image build. When the
tag already has a GitHub Release, that is all it does. When it has none, which
is a release that failed after its image was pushed, it goes on to generate the
SBOM from the published image and create the Release, so the manual run
finishes the release without rebuilding or moving the image.

The `v*` tag also starts [`zap.yml`](../../.github/workflows/zap.yml), the ZAP
baseline scan against the tagged commit's stack, as does any push to a
`release/**` branch. It does not hold up the image; a failure there is fixed in
the next patch ([security scanning](security-scanning.md)).

## After a release

- After the image is published, pulled anonymously and signature-verified, open
  a follow-up PR bumping **both roles** to that published tag in `render.yaml`,
  `.do/app.yaml`, `deploy/dokploy/docker-compose.yml` and
  `deploy/coolify/docker-compose.yml`. Update the pinned version in
  `docs/guides/deploy.md` and the `version` field in
  `deploy/dokploy/meta.json` too. Run
  `pnpm exec vitest run --project tooling scripts/deploy-templates.test.ts`;
  it requires all platform image pins and the Dokploy metadata version to agree.
  Do not tie this assertion to `apps/api/package.json`: Changesets bumps it before the release image exists,
  while templates must continue pointing at an already published image.

- Check that the website shows the new version (Actions › Pages). If the dispatch
  failed, run **Pages › Run workflow** by hand.
- Check `docker pull ghcr.io/docker-hunterpedia/helpdock:<version>` from a
  machine that is not signed in.
- Resolve that tag's digest and verify its Cosign signature as above.
- Check the System page of a fresh install reports that version and that commit.
- Upgrade, backup and restore procedures for operators are in
  [the operations guide](operations.md) and
  [DOMAIN-RULES §10](../planning/DOMAIN-RULES.md).

## If something goes wrong

The tag is the input, so a failed run is re-runnable from the Actions tab
without touching the repository. If the run failed after the image was pushed
(signing, the SBOM or the Release itself), use **Release → Run workflow** with
the existing tag: it signs that exact digest without rebuilding it and, because
the tag has no Release yet, generates the SBOM and creates the Release. For a
failure before the push, re-run the failed `release` job of the `Changesets`
run. A re-run uses the workflow file of the original run; a fix to the workflow
has to be merged and then exercised through **Run workflow**.

This is how `v0.5.0` was finished: the first release through the Changesets
path verified the signature against the tag's identity while the certificate
carried `refs/heads/main`, the ref the called workflow runs under. The image
was already pushed, so the identity rule was fixed and **Run workflow** signed,
verified and released it.

A tag pointing at the wrong commit is the one case that needs care: delete it
locally and on the remote, then tag again. The `protect-release-tags` ruleset
lets anyone with write access create a `v*` tag but only a repository admin move
or delete one. A version already pulled by somebody is never re-tagged — publish
the next patch instead.
