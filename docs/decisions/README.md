# Architecture decision records

One file per decision, named `NNNN-short-slug.md`, numbered in order of creation. Accepted ADRs are never edited; a change of mind gets a new ADR that supersedes the old one.

The decisions listed as open in [ARCHITECTURE.md §19](../planning/ARCHITECTURE.md#19-open-decisions-small-can-settle-during-m0) — article editor library, web push, CAPTCHA default, queue dashboard and embedding model scope — were settled in M0-12 and are recorded below.

## Index

| Number | Title | Status |
|---|---|---|
| [0001](0001-tiptap-for-rich-text.md) | Use TipTap for article and reply editing | accepted |
| [0002](0002-web-push-via-vapid.md) | Use web push with VAPID for agent notifications | accepted |
| [0003](0003-turnstile-default-captcha.md) | Use Cloudflare Turnstile as the default CAPTCHA, hCaptcha as the alternative | accepted |
| [0004](0004-bull-board-for-queues.md) | Embed Bull Board for queue inspection, with a custom summary on the System page | accepted |
| [0005](0005-single-embedding-model-per-install.md) | One embedding model per install, with no per-brand override in v1 | accepted |
| [0006](0006-fastify-adapter-for-the-api.md) | Run NestJS on the Fastify adapter | accepted |
| [0008](0008-phone-normalisation.md) | Normalise phone numbers in-house, international format only in v1 | accepted |

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
