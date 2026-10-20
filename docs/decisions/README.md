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
| [0007](0007-html-sanitizer.md) | Use sanitize-html for message bodies | accepted |
| [0008](0008-phone-normalisation.md) | Normalise phone numbers in-house, international format only in v1 | accepted |
| [0009](0009-magic-byte-sniffing.md) | Sniff upload MIME types with a table in-house, not with `file-type` | accepted |
| [0010](0010-csat-page-in-the-admin-bundle.md) | Host the CSAT rating page in the admin bundle until the help center exists | accepted |
| [0011](0011-ticket-search-token-table.md) | Search tickets through a token table, not through `LEAKPROOF` wrappers | accepted |
| [0012](0012-widget-bundle-shape.md) | Ship the widget as an ES module with lazy chunks and a catalog-compatible translator | accepted |
| [0013](0013-web-form-page-rendered-by-the-api.md) | Render the hosted web form as plain HTML from the api until the help center exists | accepted |
| [0014](0014-markdown-through-tiptap.md) | Markdown import and export through `@tiptap/markdown`, in the browser | accepted |
| [0015](0015-help-center-pages-rendered-by-the-api.md) | Render the help center as plain HTML from the api, and carry the staff session to its host with a one-use pass | accepted |
| [0016](0016-telegram-updates-filed-in-the-webhook-request.md) | File Telegram updates in the webhook request, and poll only in development | accepted |
| [0017](0017-bull-board-behind-a-one-use-pass.md) | Mount Bull Board as a Fastify plugin, opened with a one-use pass (amends 0004) | accepted |
| [0018](0018-pi-ai-provider-layer.md) | The AI provider layer: pi-ai behind one facade, credentials in one secret setting, cost from pi-ai's model registry | accepted |
| [0019](0019-api-scopes-and-openapi-from-zod.md) | API keys act brand-wide through their own permissions, and OpenAPI is generated from Zod | accepted |
| [0020](0020-knowledge-chunking-and-fusion.md) | Knowledge ingest and retrieval: heading-bounded chunks, a visibility filter before both rankers, reciprocal rank fusion with a locale boost | accepted |
| [0021](0021-bundled-breached-password-list.md) | Check new passwords against a bundled breached-password list | accepted |
| [0022](0022-auth-audit-trail-in-install-scope.md) | Record authentication events in install scope, as the `auth` system principal | accepted |
| [0023](0023-outbox-events-ordered-per-ticket.md) | Run outbox events concurrently, ordered per ticket | accepted |
| [0024](0024-step-transactions-for-model-calls.md) | Agent assist calls the model between short transactions, not inside the request's | accepted |
| [0025](0025-meta-channels-through-one-graph-adapter.md) | Meta channels through one Graph adapter: one module, Instagram Login, one webhook per install, the reply window enforced at compose time and at send time | accepted |
| [0026](0026-staff-sso-over-saml-and-oidc.md) | Staff single sign-on over SAML 2.0 and OpenID Connect, with JIT provisioning and group-to-role sync | accepted |
| [0027](0027-imports-through-one-normalised-record-engine.md) | Imports through one engine of normalised records, written without side effects | proposed |
| [0028](0028-ai-workspace-runs-the-production-path-dry.md) | The AI workspace runs the production path dry | proposed |
| [0029](0029-staff-assistant-reads-through-validated-read-plans.md) | The staff assistant panel reads through validated read plans, not tool calls | proposed |
| [0030](0030-ai-decisions-in-automation-are-confidence-gated.md) | AI decisions in automation are confidence-gated and one-directional | proposed |
| [0031](0031-personas-change-the-voice-never-the-rules.md) | Personas change the voice, never the rules; avatars are public uploads | proposed |
| [0032](0032-ai-tools-reads-run-changes-wait-for-a-person.md) | The assistant may use tools: reads run, changes wait for a person | accepted |
| [0033](0033-helpdock-as-an-mcp-server-with-oauth-2-1.md) | Helpdock is an MCP server with a hand-wired OAuth 2.1 authorization server | accepted |
| [0034](0034-one-mcp-client-over-safefetch.md) | One MCP client for integrations and agent tools, over safeFetch | proposed |
| [0035](0035-snooze-as-a-system-status.md) | Snooze as a system status with a wake timer | proposed |
| [0036](0036-bulk-changes-previewed-all-or-nothing-with-undo.md) | Bulk changes as previewed, all-or-nothing operations with a short undo | proposed |
| [0037](0037-paced-notification-email-and-digests.md) | Paced notification email and digests | accepted |
| [0038](0038-keyboard-registry-and-command-palette.md) | One keyboard registry, physical keys, and a command palette without a new dependency | proposed |
| [0039](0039-signed-release-bundle-and-installer.md) | A signed release bundle, verified by the installer | proposed |
| [0040](0040-automatic-updates-opt-in-and-delayed.md) | Automatic updates are opt-in, patch-only and delayed | accepted |
| [0041](0041-helpdock-ctl-in-posix-sh.md) | helpdock-ctl is host-side POSIX sh | proposed |
| [0042](0042-update-checks-send-nothing-about-the-install.md) | Update checks against GitHub send nothing about the install | proposed |
| [0043](0043-sample-brand-through-the-import-engine.md) | Sample data through the import engine, in a flagged sample brand | proposed |
| [0044](0044-supported-deploy-targets.md) | Supported deploy targets: Compose through the installer, Coolify and cloud-init | proposed |
| [0045](0045-import-provenance-ledger-and-undo.md) | Import provenance ledger and undo (amends 0027) | proposed |
| [0046](0046-imported-configuration-as-disabled-drafts.md) | Imported macros, SLA policies and automations as disabled drafts | proposed |
| [0047](0047-locale-registry-and-lazy-widget-locales.md) | A locale registry, UI and content locales, and lazy widget locale chunks | proposed |
| [0048](0048-translations-through-hosted-weblate.md) | Translations through Hosted Weblate | accepted |
| [0049](0049-installable-admin-before-native-agent-apps.md) | An installable admin (PWA) before native agent apps, and no push relay | proposed |
| [0050](0050-passkeys-for-staff-over-webauthn.md) | Passkeys for staff over WebAuthn | accepted |
| [0051](0051-oauth-identities-bound-by-subject.md) | OAuth sign-in identities bound by subject, and Microsoft as a third provider | accepted |
| [0052](0052-built-in-proof-of-work-captcha.md) | A built-in proof-of-work CAPTCHA provider (amends 0003) | accepted |
| [0053](0053-break-glass-with-a-passkey.md) | Break-glass may use a passkey (amends 0026) | accepted |
| [0054](0054-several-widgets-per-brand.md) | Several widgets per brand, with an optional widget id in the protocol | accepted |
| [0055](0055-custom-html-email-layout.md) | A custom HTML email layout behind the existing sanitiser | accepted |
| [0056](0056-public-npm-packages-for-client-sdks.md) | Public npm packages for the widget client and the React Native SDK | accepted |
| [0057](0057-desktop-shell-on-electron.md) | The desktop shell on Electron | proposed |

ADRs 0028 to 0057 were written on 2026-10-20 with the plans of [PRD Phase 5](../planning/PRD.md#phase-5--1x), one milestone after another (M12: 0028–0031, M13: 0032–0034, M14: 0035–0038, M15: 0039–0044, M16: 0045–0046, M17: 0047–0049, M18: 0050–0053, M19: 0054–0055, M20: 0056–0057). Each stays proposed until its milestone builds it (0037 was accepted with M14-10), except 0032, 0033, 0040, 0048, 0052, 0053, 0054, 0055 and 0056, which the owner accepted on 2026-10-20 ([decisions](../planning/decisions-1-x.md)). 0051 was accepted and its OAuth binding built ahead of M18, as a 1.0.1 security fix; Microsoft remains M18 work. 0050 was accepted with M18-01, the WebAuthn foundation. 0045, 0052 and 0053 amend accepted or earlier records (0027, 0003, 0026) without editing them.

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
