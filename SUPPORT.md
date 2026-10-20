# Getting help with Helpdock

Helpdock is a community project maintained by volunteers. There is no paid support, no support contract and no hosted service: help comes from the documentation, from other people who run Helpdock, and from the maintainer when time allows.

## Where to look first

- **The guides** in [docs/guides/](docs/guides/). Start with [install](docs/guides/install.md), [configuration](docs/guides/configuration.md) and [operations](docs/guides/operations.md) (backups, upgrades, monitoring); the [README's documentation table](README.md#documentation) points to the guide for each task.
- **The [changelog](CHANGELOG.md)**, for what changed in each release and its known limits.
- **Existing [issues](https://github.com/Docker-Hunterpedia/Helpdock/issues?q=is%3Aissue) and [discussions](https://github.com/Docker-Hunterpedia/Helpdock/discussions)**: someone may have asked already.

## Where to ask

| You want to | Go to |
|---|---|
| Ask how to install, configure or use Helpdock | [Q&A](https://github.com/Docker-Hunterpedia/Helpdock/discussions/categories/q-a) in GitHub Discussions |
| Talk through an idea that is not yet a clear proposal | [Ideas](https://github.com/Docker-Hunterpedia/Helpdock/discussions/categories/ideas) |
| Show what you built with Helpdock | [Show and tell](https://github.com/Docker-Hunterpedia/Helpdock/discussions/categories/show-and-tell) |
| Report something that does not work as documented | A [bug report](https://github.com/Docker-Hunterpedia/Helpdock/issues/new?template=bug_report.yml) |
| Propose a feature | A [feature request](https://github.com/Docker-Hunterpedia/Helpdock/issues/new?template=feature_request.yml), after checking the [1.x plan](docs/planning/PRD.md#phase-5--1x) |
| Report an accessibility barrier | An [accessibility barrier report](https://github.com/Docker-Hunterpedia/Helpdock/issues/new?template=accessibility_barrier.yml); see [ACCESSIBILITY.md](ACCESSIBILITY.md) |
| Fix or request a translation | A [translation issue](https://github.com/Docker-Hunterpedia/Helpdock/issues/new?template=translation.yml) |
| Fix a guide | A [documentation issue](https://github.com/Docker-Hunterpedia/Helpdock/issues/new?template=docs.yml), or a pull request ([CONTRIBUTING.md](CONTRIBUTING.md)) |

When you ask, say which version you run (`HELPDOCK_VERSION`, or the header of Admin → System), how it is deployed, and what you already tried. **Remove secrets and customer data** from anything you paste: `APP_MASTER_KEY`, passwords, `DATABASE_URL`, API keys and tokens, and customers' names, addresses and messages. Issues and discussions are public.

## Out of scope

- **Security vulnerabilities.** Never post them in an issue or a discussion. Report them privately, as [SECURITY.md](SECURITY.md) describes.
- **Paid or private support**, consulting, or setting up someone's install for them.
- **Problems in services you connect**, such as your SMTP provider, your LLM provider, Telegram or Meta, beyond how Helpdock uses them.
- **Deployments Helpdock does not support.** Docker Compose is the only supported runtime ([PRD non-goals for 1.x](docs/planning/PRD.md#non-goals-for-1x)). Kubernetes and Helm are on the [backlog](docs/planning/PRD.md#5-post-10-backlog-v11); Vercel and Cloudflare are non-goals.
- **Help on behalf of a Helpdock install's customers.** If you are a customer of a business that runs Helpdock, contact that business; the project has no access to its data.

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
