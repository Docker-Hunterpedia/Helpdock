# Security scanning

What runs against Helpdock's code and image before a stranger does, and what to
do when one of them fails. ARCHITECTURE §15's security line and §16's SBOM,
delivered by M9-05. For maintainers; the external pentest (M9-01) and the ASVS
walk-through ([`docs/completed/asvs-l2.md`](../completed/asvs-l2.md)) are the
other half.

| Scan | Where | When | Fails the run on |
|---|---|---|---|
| Biome | `ci.yml` › `checks` | every pull request and push to `main` | any lint error |
| `pnpm audit` | `ci.yml` › `checks` | every pull request and push to `main` | a high or critical advisory |
| Route, validation and boundary checks | `ci.yml` › `checks` (`pnpm check:*`) | every pull request and push to `main` | an undeclared route, an unvalidated input, an app importing another |
| Semgrep, Helpdock's rules | `ci.yml` › `semgrep` | every pull request and push to `main` | any finding |
| CodeQL `security-extended` | `codeql.yml` | pull requests, `main`, and Mondays | any open alert on the pull request; findings go to the Security tab |
| ZAP baseline | `zap.yml` | pushes to `release/**`, `v*` tags, or by hand | any alert `.zap/rules.tsv` does not lower |
| SBOM (CycloneDX) | `release.yml` | every `v*` tag | — (it is an inventory, attached to the Release) |

## Semgrep

The rules are in [`.semgrep/helpdock.yml`](../../.semgrep/helpdock.yml). Each one
is an engineering rule from [AGENTS.md](../../AGENTS.md) that the type checker
cannot see:

| Rule | Catches | The rule it enforces |
|---|---|---|
| `helpdock-route-without-declaration` | A `@Get`/`@Post`/…/`@SubscribeMessage` handler with no `@Requires`, `@Authenticated` or `@Public` on it or its class | DOMAIN-RULES §1.3. `pnpm check:routes` checks the same thing with the TypeScript compiler; the two disagree only if one of them is wrong. |
| `helpdock-fetch-non-constant-url` | `fetch(url)` in the api or a package where `url` is not a string literal, outside `packages/net` | DOMAIN-RULES §13: user-supplied URLs go through `safeFetch` |
| `helpdock-enqueue-from-request-path` | `bullmq` imported by a `*.controller.ts`, `*.gateway.ts`, `*.service.ts` or `*.listener.ts` | DOMAIN-RULES §6: side effects go through the outbox |
| `helpdock-enqueue-in-handler` | `new Queue(…)` or `queue.add(job.name, …)` inside a controller, a gateway or an `@OnEvent` listener | The same rule, for a queue that arrives some other way |
| `helpdock-any-without-comment` | `as any`, `: any`, `<any>` or `any[]` with no comment on the line or the line above | AGENTS.md "Style" |
| `helpdock-secret-in-log` | A log call whose object has a key such as `password`, `token`, `secret`, `apiKey`, `privateKey`, `authorization` or `cookie` | REQUIREMENTS §5.1: secrets are never logged |

Run them locally with the CLI ([install it](https://semgrep.dev/docs/getting-started/cli)
with `pipx install semgrep`; CI pins the version in `ci.yml`):

```sh
semgrep scan --test --metrics=off .semgrep                       # the fixtures
semgrep scan --config .semgrep/helpdock.yml --error --metrics=off apps packages scripts
```

[`.semgrep/helpdock.ts`](../../.semgrep/helpdock.ts) holds the fixtures: a line
under `// ruleid: <id>` must be reported and a line under `// ok: <id>` must not.
A new rule comes with both. Biome and the TypeScript compiler skip `.semgrep/`.

**A finding that is deliberate** is silenced on its own line, with the reason
above it:

```ts
// The providers' fixed token endpoints, never a URL a user supplied.
// nosemgrep: helpdock-fetch-non-constant-url
const response = await fetch(url, {
```

The reviewer reads the reason. "The linter was wrong" is a reason to fix the
rule, in the same pull request, with a fixture that proves it.

## CodeQL

[`codeql.yml`](../../.github/workflows/codeql.yml) runs the
`security-extended` JavaScript/TypeScript queries on every pull request, on
`main` and on Mondays, and writes the findings to the repository's Security
tab and as review comments on the pull request. **When it finds something**,
fix the code: rewrite a regex with overlapping quantifiers as string
operations or a linear one, compare a parsed URL's `hostname` instead of
searching for a substring, use `crypto.getRandomValues` where a value stands
in for a secret, and strip a multi-character pattern until a pass changes
nothing. Dismissing an alert is not available on a pull request.

A query that is wrong for this codebase is taken away in
[`.github/codeql/codeql-config.yml`](../../.github/codeql/codeql-config.yml)
with the reason beside it. There is one: `js/insufficient-password-hash`,
which reads the SHA-256 of a 256-bit API key
(`apps/api/src/api-keys/api-key-credential.ts`) and the HMAC over an OAuth
`state` (`apps/api/src/knowledge/oauth-state.ts`) as password hashing. A query
filter applies to the whole repository, so a fast hash of an actual password
is for review to catch; passwords are argon2id (DOMAIN-RULES §2).

## Dependency audit

`pnpm audit --audit-level high` runs in `ci.yml` › `checks`. **When it
fails**, bump the direct dependency when a patched release exists. When the
advisory is in a transitive dependency whose dependant has not released a bump,
add an `overrides` entry to [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml)
(pnpm 11+ reads them from there, not from `package.json`), scoped to the
vulnerable range (`'shell-quote@<1.11.0': '>=1.11.0'`) with the path it came
through on the line above, and remove it once the dependant pins the patched
version. Regenerate the lockfile with `pnpm install` and confirm with
`pnpm install --frozen-lockfile` and `pnpm audit --audit-level high`.

## ZAP baseline

[`zap.yml`](../../.github/workflows/zap.yml) builds the image from the commit,
starts the Compose stack with [`scripts/zap-stack.sh`](../../scripts/zap-stack.sh)
(the same stack the smoke test uses, through `scripts/compose-env.sh`),
finishes the first-run wizard, and runs ZAP's
[baseline scan](https://www.zaproxy.org/docs/docker/baseline-scan/) against
`http://127.0.0.1:3000` with the alpha passive rules and the AJAX spider. It is
passive: ZAP reads responses — headers, cookies, caching, information leaks —
and attacks nothing.

To run it on demand, use **Run workflow** on the *ZAP baseline* workflow, or
locally:

```sh
docker build -f docker/Dockerfile -t ghcr.io/docker-hunterpedia/helpdock:zap .
HELPDOCK_VERSION=zap ./scripts/zap-stack.sh up
docker run --rm --network host -v "$PWD/.zap:/zap/wrk:rw" ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py -t http://127.0.0.1:3000 -c rules.tsv -a -j
./scripts/zap-stack.sh down
```

The report is the run's `zap-baseline` artifact. **When it fails**, read the
alert. If it is a real problem, fix it. If it has been read and accepted — a
header that does not apply to that response, a false positive — add its plugin
id to [`.zap/rules.tsv`](../../.zap/rules.tsv) as `IGNORE` (or `WARN` to keep
seeing it) with the reason on the line above. The run never opens issues.

The scan is not wired into `release.yml`, so a scanner outage never holds up an
image. Instead the release procedure runs it by hand on the version pull
request's branch before that pull request merges
([release](release.md#the-short-version)); the run on the tag is the record.

## SBOM

Every `v*` tag's Release carries `helpdock-<version>.cdx.json`, a CycloneDX
SBOM of the **pushed image** — the base image's Debian packages and ffmpeg as
well as `node_modules` ([release](release.md#what-the-tag-produces)). Feed it to
any CycloneDX-aware scanner, for example:

```sh
gh release download v1.0.0 --pattern '*.cdx.json'
grype sbom:helpdock-1.0.0.cdx.json
```
