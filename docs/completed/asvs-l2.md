# OWASP ASVS 4.0.3 Level 2 walk-through

M9-02 ([PRD §4 · M9](../planning/PRD.md#m9-hardening-and-10),
[REQUIREMENTS §5.1](../planning/REQUIREMENTS.md)). Every Level 2 requirement of
the [Application Security Verification Standard
4.0.3](https://github.com/OWASP/ASVS/tree/v4.0.3/4.0), with what Helpdock does
about it and where the proof is.

Walked on 2026-10-05 against the integration branch after M0–M5 and the first
M9 work (Semgrep, ZAP, per-browser revocation, socket budgets), while M6
Telegram, M7 AI and M8 API keys and webhooks were still being built. The
chapters those three touched were walked again on 2026-10-09 against `main` at
`3579972`, after they shipped in #147 and keyless image signing in #162; the
rows whose status changed are listed under
[Found in the M6–M8 re-walk](#found-in-the-m6m8-re-walk). This is a desk review
of code, tests and configuration: 258 requirements, each against the code
that answers it. It does not replace the external pentest
(M9-01), and nothing here was attacked.

**Status.** **Met** — the requirement holds, with the evidence named. **Partial** —
it holds for most of the surface, or by a weaker means; the gap is named.
**Gap** — it does not hold. **N/A** — Helpdock has nothing the requirement is
about. **Operator** — it depends on how the install is run, and the guide says
what to do. Paths are relative to the repository root; `api` is `apps/api/src`.

## Summary

| Chapter | Met | Partial | Gap | N/A | Operator |
|---|---|---|---|---|---|
| V1 Architecture, design and threat modeling | 31 | 6 | 0 | 1 | 0 |
| V2 Authentication | 35 | 4 | 0 | 11 | 0 |
| V3 Session management | 14 | 4 | 0 | 0 | 0 |
| V4 Access control | 8 | 1 | 0 | 0 | 0 |
| V5 Validation, sanitisation and encoding | 25 | 0 | 0 | 5 | 0 |
| V6 Stored cryptography | 9 | 2 | 0 | 2 | 0 |
| V7 Error handling and logging | 8 | 3 | 0 | 0 | 1 |
| V8 Data protection | 6 | 9 | 0 | 0 | 0 |
| V9 Communications | 6 | 2 | 0 | 0 | 0 |
| V10 Malicious code | 5 | 0 | 0 | 0 | 0 |
| V11 Business logic | 6 | 2 | 0 | 0 | 0 |
| V12 Files and resources | 11 | 3 | 1 | 0 | 0 |
| V13 API and web services | 8 | 1 | 0 | 4 | 0 |
| V14 Configuration | 19 | 4 | 0 | 1 | 0 |
| **All** | **191** | **41** | **1** | **24** | **1** |

### Gaps and partials closed before 1.0

The 2026-10-05 walk-through found eleven; all were closed in M9-02's
follow-up, each with the evidence in its row below. One closes with a recorded
deviation (3.4.4). 7.2.1 is open again for a different reason, found in the
re-walk.

| Requirement | What was missing | What closed it |
|---|---|---|
| 2.2.3, 2.5.5 | No email when a password, second factor or recovery codes change | A `securityChange` auth email through the outbox, `en` and `ar` (`api/auth/auth.service.ts` `#notifySecurityChange`) |
| 2.1.7 | No breached-password check | A bundled list, checked at every place a password is set ([ADR 0021](../decisions/0021-bundled-breached-password-list.md)) |
| 2.8.4, 2.8.5 | A TOTP code could open a second challenge within its 30 s | The last accepted step is kept per account and only later ones pass (`api/auth/totp/used-steps.ts`) |
| 2.1.8, 2.1.12 | No strength meter and no show-password toggle on every password field | `Admin/PasswordField` on the four screens that choose a password (`apps/admin/src/ui/password-field.tsx`) |
| 3.3.2 | A refresh family lived 30 days, renewed by use | Idle and absolute limits, `AUTH_SESSION_IDLE_MINUTES` (240) and `AUTH_SESSION_MAX_HOURS` (12) |
| 3.4.4 | No cookie prefix | `__Secure-` over https; `__Host-` declined to keep `Path=/api/auth` (deviation, see the row) |
| 4.3.1 | A second factor for administrators was a setting | Required for Admins and install admins whatever the setting; enrolment by challenge at the next sign-in |
| 7.1.3, 7.2.1 | Sign-in failures only in the process log | An `auth.*` trail in install scope ([ADR 0022](../decisions/0022-auth-audit-trail-in-install-scope.md)) |
| 8.1.4 | Nothing alerted on rate-limit refusals | `rate_limit_refusals_total{bucket}` and an alert in the operations guide |
| 8.3.2 | No contact export | `GET /api/brands/:brandId/contacts/:contactId/export`, Admin only, audited |
| 14.4.2 | No `Content-Disposition` on JSON | `attachment; filename="api.json"` on every JSON answer (`api/http/json-disposition.ts`) |

### Found in the M6–M8 re-walk

Twelve rows changed status on 2026-10-09. Two improved: 1.6.3, because the
master key now rotates (M9-06), and 3.5.1, because the keys integrations hold
can be revoked. Ten are open, each to be closed or accepted before 1.0:

| Requirement | Was | Now | What is missing |
|---|---|---|---|
| 4.1.3 | Met | Partial | A key with `webhooks:manage` alone receives tickets, messages and contacts through the events its endpoint subscribes to |
| 12.1.2 | N/A | Gap | A DOCX is unpacked with no limit on its uncompressed size or number of entries |
| 8.3.2 | Met | Partial | Erasure leaves Telegram chat ids and usernames, AI redaction maps and webhook payloads |
| 8.3.8 | Met | Partial | Webhook and Telegram delivery rows are never purged |
| 12.6.1 | Met | Partial | Chat completions and a provider's base URL are outside the outbound policy |
| 7.2.1 | Met | Partial | A refused API key is not audited and names neither the key nor the caller |
| 8.2.1 | Met | Partial | No `Cache-Control` on JSON answers |
| 14.3.3 | Met | Partial | The public OpenAPI document names the release |
| 2.10.1, 3.5.2 | Met | Partial | API keys never expire |

Gaps named without a change of status: 9.2.2 (plain `http` to a model
provider, embeddings or transcription endpoint), 3.7.1 (no re-authentication
to create an API key), and the knowledge connectors' OAuth `state` (the
paragraph under the V2 table).

## V1 Architecture, design and threat modeling

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1.1.1 | Secure software development lifecycle | Met | Planning documents per milestone (`docs/planning/`), deliverable ids, review skills under `.agents/skills/` (`security-audit`, `clean-code-guard`), a Definition of done in `AGENTS.md` |
| 1.1.2 | Threat modeling for every design change | Partial | Threats are reasoned per feature in `docs/planning/DOMAIN-RULES.md` (tenancy §1, outbox §6, AI §9, SSRF §13) and in ADRs; the security guide's "Threat model in brief" (`docs/guides/security.md`) names visitors, staff, the internet, a stolen dump, an Admin's URL and uploads, but not an API key holder, a Telegram update, a webhook receiver or text a model reads or writes. There is no standing threat model document |
| 1.1.3 | User stories carry security constraints | Met | `docs/planning/REQUIREMENTS.md` §5.1 and the "Engineering rules" of `AGENTS.md` apply to every story |
| 1.1.4 | Trust boundaries, components and data flows documented | Met | `docs/planning/ARCHITECTURE.md` §3, §6, §7, §8 (Telegram), §10 (AI); `docs/guides/widget-protocol.md`, `docs/guides/api.md`, `docs/guides/webhooks.md`, `docs/guides/telegram.md` |
| 1.1.5 | High-level architecture and remote services defined | Met | `ARCHITECTURE.md` §1–§3, §8, §10, §17. The remote services M6–M8 added: the Bot API (`TELEGRAM_API_ROOT`), model providers through pi-ai ([ADR 0018](../decisions/0018-pi-ai-provider-layer.md)), Notion and Google Drive (`docs/guides/ai.md` "Knowledge"), webhook receivers (`docs/guides/webhooks.md`) |
| 1.1.6 | Centralised, vetted security controls | Met | One permission guard (`api/auth/permission.guard.ts`), one tenant transaction (`packages/db` `withTenant`), one SSRF client (`packages/net`), one sanitiser (ADR 0007), one way to a model (`packages/ai` `complete()` and `embed()`, ADR 0018), one API key resolver (`api/api-keys/api-key-principal-resolver.ts`) |
| 1.1.7 | Secure coding checklist available to developers | Met | `AGENTS.md` "Engineering rules"; `docs/guides/security-scanning.md` |
| 1.2.1 | Unique, low-privilege OS accounts per component | Partial | The image runs as the non-root `helpdock` user (`docker/Dockerfile`); api and worker share that image and user |
| 1.2.2 | Communications between components authenticated | Partial | Postgres with a runtime role and an owner role (`packages/db` migrations), Redis on the Compose network without a password by default (`docker/docker-compose.yml`) |
| 1.2.3 | One vetted authentication mechanism | Met | `docs/guides/authentication.md`: every way in ends in the same `SessionService.open` |
| 1.2.4 | Every authentication pathway equally strong | Met | Password, magic link and OAuth all pass the same second-factor check (`api/auth/auth.service.ts`, `#openSession`) |
| 1.4.1 | Access control enforced at trusted points | Met | Server side only: `PermissionGuard`, row-level security on every tenant table (`packages/db/src/rls`), the gate on every socket event (`api/realtime/staff.gateway.ts`) |
| 1.4.4 | Single, vetted access control mechanism | Met | `@Requires(permission)` on every route and event, checked in CI (`pnpm check:routes`, Semgrep `helpdock-route-without-declaration`); on `/api/v1` the permission is an API scope that no role holds ([ADR 0019](../decisions/0019-api-scopes-and-openapi-from-zod.md), `api/auth/permissions.ts` `principalHasPermission`) |
| 1.4.5 | Attribute- or feature-based access control | Met | Permission per route plus department scope per row (DOMAIN-RULES §1.1–§1.3) |
| 1.5.1 | Input and output requirements defined | Met | Zod schemas in `packages/schemas` for every request, response, job and socket message; a Telegram update is read through `telegramUpdateSchema` (`packages/channels/src/telegram/update.ts`), a webhook body is described by `webhookEnvelopeSchema` (`packages/schemas/src/api.ts`) |
| 1.5.2 | No serialisation of untrusted objects | Met | JSON only, parsed by Fastify and validated by Zod |
| 1.5.3 | Input validated on a trusted service layer | Met | `nestjs-zod` pipes on every `@Param`, `@Query`, `@Body` (`pnpm check:validation`) |
| 1.5.4 | Output encoding close to the interpreter | Met | React/Preact escape at render; server HTML through `api/help-center/site/render` escaping helpers; a model's answer is escaped as plain text and sanitised before it is stored (`api/ai/auto-reply/answer-body.ts`), and a draft article's Markdown is escaped before any markup is added (`packages/ai/src/assist/markdown.ts`) |
| 1.6.1 | Explicit key management policy | Met | `docs/guides/operations.md` "The master key"; DOMAIN-RULES §10 |
| 1.6.2 | Consumers of crypto protect key material | Met | One keyring (`packages/config/src/crypto.ts`) holds `APP_MASTER_KEY`; nothing else sees it |
| 1.6.3 | Keys and passwords replaceable | Met | `rotateMasterKey` re-encrypts every envelope column (`ENVELOPE_COLUMNS`), the secret settings and unpublished sign-in links under `APP_MASTER_KEY`, reading with `APP_MASTER_KEY_PREVIOUS`, in one audited transaction (`packages/db/src/master-key-rotation.ts`; `node dist/cli.js keys rotate`, `api/cli.ts`); `master-key-rotation.integration.test.ts`, and `master-key-rotation.test.ts` fails on a secret-looking column on neither list. Password hashes verify under the previous key and are re-hashed at sign-in. API keys, webhook signing secrets and bot tokens are replaced from admin (revoke and reissue, Rotate, Replace) |
| 1.6.4 | No symmetric keys or passwords client side | Met | The browser holds only a 10-minute access token in memory and an httpOnly refresh cookie |
| 1.7.1 | Common logging format | Met | pino JSON lines with request id and role (`api/logging/logger.ts`) |
| 1.7.2 | Logs shipped securely to a remote system | Partial | Logs go to stdout for the operator's collector; nothing ships them (`docs/guides/operations.md` "Logs") |
| 1.8.1 | Sensitive data identified and classified | Met | `ARCHITECTURE.md` §5, DOMAIN-RULES §11 retention table |
| 1.8.2 | Protection levels per class | Met | Secrets encrypted (`settings` with `secret: true`), personal data retention per brand, erasure (`docs/guides/data-retention.md`) |
| 1.9.1 | Encrypted communication between components | Partial | All components share one host and one Compose network; Postgres and Redis traffic is not encrypted (§14's deployment shape) |
| 1.9.2 | Each side of a connection authenticated | Partial | Postgres by password; Redis unauthenticated on the private network |
| 1.10.1 | Source control with check-in procedures | Met | Protected `main`, pull requests, required `ci` check (`.github/workflows/ci.yml`) |
| 1.11.1 | Components and their business functions documented | Met | `ARCHITECTURE.md` §2 repository layout, one guide per module under `docs/guides/` |
| 1.11.2 | High-value flows share no unsynchronised state | Met | Per-brand advisory locks on assignment and the outbox relay; `clientId` dedupe on sends (DOMAIN-RULES §7) |
| 1.12.2 | Uploaded files served as attachment or from another domain | Met | Presigned S3 URLs with `Content-Disposition: attachment` for non-image kinds (`api/media/storage.ts`) |
| 1.14.1 | Components of different trust levels segregated | Met | Caddy refuses `/internal/*` from outside (`docker/caddy/Caddyfile`); `/metrics` is never routed publicly |
| 1.14.2 | Binary signatures and trusted connections | Met | Actions pinned by commit sha; the image is built in CI from the tag and its digest signed keylessly with Cosign through GitHub OIDC, the signature verified against the workflow identity in the same job (`release.yml`, #162; `v0.4.0` signed on 2026-10-09); `docs/guides/release.md` "Verify the image signature" |
| 1.14.3 | Build pipeline warns about outdated or insecure components | Met | Renovate with vulnerability alerts (`renovate.json`), `pnpm audit --audit-level high` in `ci.yml` |
| 1.14.4 | Build and deploy automated | Met | `changesets.yml` → `release.yml` |
| 1.14.5 | Deployments sandboxed or containerised | Met | Docker Compose, one container per role (`docker/docker-compose.yml`) |
| 1.14.6 | No unsupported client-side technology | N/A | No plugins, applets or Flash |

## V2 Authentication

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 2.1.1 | Passwords at least 12 characters | Met | `PASSWORD_MIN_LENGTH = 12` (`packages/schemas/src/auth.ts`), test `auth.test.ts` |
| 2.1.2 | 64+ characters allowed, over 128 refused | Partial | `PASSWORD_MAX_LENGTH = 200`: 64 are allowed, but up to 200 are accepted |
| 2.1.3 | No truncation | Met | argon2 hashes the whole string (`api/auth/password.ts`) |
| 2.1.4 | Any printable Unicode allowed | Met | No character class rules in the schema |
| 2.1.5 | Users can change their password | Met | `POST /api/me/password` |
| 2.1.6 | Change requires current and new password | Met | Same route, step-up budget (`STEP_UP_RULE`) |
| 2.1.7 | Checked against breached passwords | Met | The 46 146 entries of 12+ characters among SecLists' million most common, case-insensitive, checked by the wizard, invitation acceptance, reset and change (`api/auth/breached/breached-passwords.ts`, ADR 0021); `password-breached` drawn on the field; `breached-passwords.test.ts`, `auth.service.test.ts` › breached passwords |
| 2.1.8 | Password strength meter | Met | `PasswordStrengthBar` with its reading in the hint, on every field that chooses a password (`apps/admin/src/ui/password-field.tsx`, artboard `Admin/PasswordField`) |
| 2.1.9 | No composition rules | Met | `docs/guides/authentication.md` "Passwords" |
| 2.1.10 | No periodic rotation | Met | None exists |
| 2.1.11 | Paste and password managers allowed | Met | Plain `type="password"` inputs with `autocomplete="current-password"` (`apps/admin/src/screens/sign-in.tsx`, `security.tsx`) |
| 2.1.12 | Show the masked password on request | Met | A show/hide toggle with `aria-pressed` on every field that chooses a password, hidden again on submit (`password-field.tsx`, `password-field.test.tsx`, `e2e/password-field.spec.ts`). The sign-in field has none: it chooses nothing |
| 2.2.1 | Anti-automation | Met | Sliding-window limits per address and per IP (`api/auth/rate-limit.ts`), challenge lock after three second-factor failures |
| 2.2.2 | Weak authenticators limited | Met | Email links are single-use and short-lived; SMS is not offered |
| 2.2.3 | Notification after authentication details change | Met | A `securityChange` email on password change and reset, second factor on and off, recovery codes redrawn, through the outbox in the change's transaction, `en` and `ar` (`auth.service.ts` `#notifySecurityChange`, `email-templates.test.ts`) |
| 2.3.1 | Initial secrets random, expire, not long-term | Met | Invitation tokens 256 bits, 7 days, single use (`api/auth/email-token.store.ts`) |
| 2.3.2 | Hardware authenticator enrolment supported | Partial | TOTP only; no WebAuthn/FIDO |
| 2.3.3 | Renewal instructions for time-bound authenticators | N/A | No time-bound authenticators issued |
| 2.4.1 | Passwords stored with an approved one-way function | Met | Argon2id (`api/auth/password.ts`) |
| 2.4.2 | Salt at least 32 bits, unique | Met | argon2's per-hash random salt |
| 2.4.3 | PBKDF2 iterations | N/A | Argon2id |
| 2.4.4 | bcrypt work factor | N/A | Argon2id |
| 2.4.5 | Additional secret salt (pepper) | Met | HKDF pepper from `APP_MASTER_KEY` passed as argon2's secret |
| 2.5.1 | Recovery secret not sent in clear | Met | Reset sends a single-use link over the install's SMTP; no password is ever emailed |
| 2.5.2 | No hints or knowledge-based answers | Met | None exist |
| 2.5.3 | Recovery does not reveal the current password | Met | Hashes only |
| 2.5.4 | No shared or default accounts | Met | The first admin is created by the wizard; no seeded credentials in production |
| 2.5.5 | Notification when an authentication factor changes | Met | As 2.2.3 |
| 2.5.6 | Forgotten password uses a secure recovery mechanism | Met | 10-minute single-use reset link; the second factor is still asked afterwards |
| 2.5.7 | Lost second factor re-proven at enrolment strength | Partial | Recovery codes, or an Admin resets the factor (`staff` lifecycle); no identity proofing beyond the Admin's judgement |
| 2.6.1 | Lookup secrets used once | Met | Recovery codes consumed on use (`replaceRecoveryCodes`) |
| 2.6.2 | Lookup secrets have enough randomness | Met | Ten codes from `randomBytes`, argon2-hashed (`authentication.md` "Recovery codes") |
| 2.6.3 | Lookup secrets resist offline attack | Met | Argon2id with the pepper |
| 2.7.1 | Cleartext OOB (SMS, PSTN) not offered by default | N/A | Not offered at all |
| 2.7.2 | OOB authenticators expire after 10 minutes | N/A | No OOB authenticator; the magic link is a primary authenticator with a configurable lifetime (`auth.magicLinkTtlMinutes`) |
| 2.7.3 | OOB tokens used once | N/A | As above; magic links are single-use |
| 2.7.4 | OOB over a secure independent channel | N/A | As above |
| 2.8.1 | Time-based OTP has a defined lifetime | Met | 30-second step, one step of drift (`authentication.md` "Two-factor") |
| 2.8.2 | OTP seeds protected | Met | Encrypted with the keyring (`totpSecretEncrypted`) |
| 2.8.3 | Approved algorithms for OTP | Met | RFC 6238 via `otplib` |
| 2.8.4 | A TOTP code used only once in its window | Met | The last accepted step per account is kept in Redis for as long as it can match, and only later steps pass, by compare-and-set (`api/auth/totp/used-steps.ts`); proved against Redis in `auth.integration.test.ts` |
| 2.8.5 | Reuse of a TOTP code logged and refused | Met | A replayed code is refused as a wrong one, logged at `warn` and audited as `auth.second_factor.replayed` |
| 2.8.6 | Physical OTP generators revocable | N/A | None issued |
| 2.9.1 | Crypto device keys stored securely | N/A | No cryptographic authenticators |
| 2.9.2 | Challenge nonce at least 64 bits | N/A | As above |
| 2.9.3 | Approved algorithms for crypto authenticators | N/A | As above |
| 2.10.1 | Intra-service secrets are not static credentials | Partial | Services authenticate with per-install generated secrets (`APP_MASTER_KEY`, database role passwords); no shared human account. Integrations calling `/api/v1` hold `hd_live_` keys that live until an Admin revokes them: `api_keys` has no expiry and nothing prompts a rotation (`packages/db/src/schema/api-keys.ts`). Webhook signing secrets have Rotate; each bot's webhook secret is drawn once, when the bot is added |
| 2.10.2 | No default service passwords | Met | `.env.example` ships no passwords; the install guide generates each one (`docs/guides/install.md`). What Helpdock issues is random per object: API keys (`randomBytes(32)`, `api/api-keys/api-key-credential.ts`), webhook signing secrets (`issueWebhookSecret`, `api/webhooks/webhook-signature.ts`), each bot's webhook secret (`api/telegram/telegram-bots.service.ts`) |
| 2.10.3 | Service passwords stored protected | Met | In `.env` (operator-held) or encrypted settings. Bot tokens, bot webhook secrets, webhook signing secrets and connector credentials are AES-256-GCM envelopes (`ENVELOPE_COLUMNS`, `packages/db/src/master-key-rotation.ts`); provider keys and OAuth app secrets are secret settings (`ai.providers`, `embedding.apiKey`, `transcription.apiKey`, `knowledge.*.clientSecret` in `packages/config/src/registry.ts`); API keys are kept as their SHA-256 only |
| 2.10.4 | No secrets in source code | Met | Secrets come from `.env` (ignored by `.gitignore`) or encrypted settings; none in the tree. The nightly evaluation reads `AI_EVAL_API_KEY` from the repository's secrets (`.github/workflows/ai-eval.yml`); the AI facade always passes a provider key explicitly, so pi-ai never falls back to `OPENAI_API_KEY` and the like in the container ([ADR 0018](../decisions/0018-pi-ai-provider-layer.md)) |

OAuth sign-in (Google, GitHub) uses PKCE and a single-use, hashed `state`
(`api/auth/oauth/oauth.service.ts`), and only signs in an address the install
already knows. The knowledge connectors' OAuth (Notion, Google Drive, M7-03)
is weaker: its `state` is HMAC-signed with a key derived from
`APP_MASTER_KEY`, names the brand, source and person, and lasts ten minutes,
but it is not single-use and the code exchange carries no PKCE verifier
(`api/knowledge/oauth-state.ts`, `sources.service.ts` `oauthCallback`). A
`state` replayed within those ten minutes with another account's code
connects that account to the source.

## V3 Session management

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 3.1.1 | Session tokens never in URLs | Met | Bearer header and httpOnly cookie only; email tokens in a path are scrubbed from logs (`authentication.md` "A token in a path never reaches the log") |
| 3.2.1 | New session token on authentication | Met | Each sign-in opens a new refresh family (`SessionService.open`) |
| 3.2.2 | At least 64 bits of entropy | Met | Refresh token 256 bits |
| 3.2.3 | Tokens stored securely in the browser | Met | Access token in memory, refresh token in an httpOnly cookie |
| 3.2.4 | Approved algorithms for tokens | Met | ES256 JWT (`jose`), SHA-256 of the refresh token at rest |
| 3.3.1 | Logout and expiry invalidate the session | Met | Family revoked, access tokens of the family marked revoked (`refresh-store.ts`), sockets of that browser closed (`realtime/revocation.subscriber.ts`) |
| 3.3.2 | Re-authentication after 12 h or 30 min idle (L2) | Met | A family ends 12 hours after sign-in and after 4 hours unused by default (`AUTH_SESSION_MAX_HOURS`, `AUTH_SESSION_IDLE_MINUTES`; `api/auth/session/refresh-store.ts`, `refresh-store.test.ts`) |
| 3.3.3 | Option to end other sessions after a password change | Met | Password change revokes every other family (`revokeEverythingExcept`) |
| 3.3.4 | Users can see and end their active sessions | Met | Security page lists every browser and signs one out (`GET /api/me/sessions`, `api/staff/account.controller.ts`) |
| 3.4.1 | Cookies `Secure` | Partial | Set when `APP_URL` is https, deliberately not on a plain-http local install |
| 3.4.2 | Cookies `HttpOnly` | Met | `api/auth/session/cookies.ts` |
| 3.4.3 | Cookies `SameSite` | Met | `Lax` |
| 3.4.4 | `__Host-` prefix | Partial | `__Secure-hd_refresh` and `__Secure-hd_trust` over https, host-only (no `Domain`). `__Host-` would need `Path=/` and send the refresh token to every route rather than `/api/auth`; that narrower path is kept as a recorded deviation (`api/auth/session/cookies.ts`, authentication guide › Cookies) |
| 3.4.5 | Path attribute when sharing a domain | Met | `Path=/api/auth` |
| 3.5.1 | Users can revoke OAuth tokens of linked apps | Met | An Admin revokes an integration's API key on Developers › API keys and its next call is refused (`DELETE /api/brands/:brandId/api-keys/:keyId`; `api-v1.integration.test.ts` › "answers 401 once a key is revoked, and audits the revocation"). A Notion or Drive connection is deleted with its source (`api/knowledge/knowledge.repository.ts` `remove`), a provider's credentials with the provider; Helpdock does not call the service's own revoke endpoint |
| 3.5.2 | Session tokens, not static API secrets | Partial | People use sessions only. Integrations on `/api/v1` use static `hd_live_` keys, as REQUIREMENTS §4.11 specifies ([ADR 0019](../decisions/0019-api-scopes-and-openapi-from-zod.md)): 256 random bits kept as SHA-256, held to their scopes and their one brand, throttled per key, refused at once when revoked, refused on every `@Requires` staff route and on the staff socket (`api/api-keys/`, `api/realtime/handshake.ts`; `api-v1.integration.test.ts` › "API keys (M8-01)"). A key does not expire |
| 3.5.3 | Stateless tokens signed, short-lived, replay-resistant | Met | ES256, 10 minutes, revocation marker checked on every request and socket event |
| 3.7.1 | Full session or re-auth before sensitive actions | Partial | Password change, second-factor removal and recovery code regeneration re-prove a credential; other administrative changes do not, among them creating an API key, adding a webhook endpoint or rotating its secret, adding a bot and saving a provider key (each `brand:manage` or install admin, each audited) |

## V4 Access control

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 4.1.1 | Enforced on a trusted service layer | Met | Guards and RLS; nothing trusts the client. An API key's brand and scopes come from its row, never from the request (`api/api-keys/api-key-principal-resolver.ts`) |
| 4.1.2 | Access attributes cannot be manipulated by users | Met | Claims come from the signed token; `app.*` session settings set by the server (`packages/db` `withTenant`) |
| 4.1.3 | Least privilege | Partial | Permission matrix (DOMAIN-RULES §1.2), department scope, Viewer role, scopes per API key. A key holding `webhooks:manage` alone can subscribe an endpoint to `ticket.*` and `contact.created` and so receive tickets, their messages and contacts without `tickets:read` or `contacts:read`: the events are not checked against the key's scopes (`api/webhooks/webhooks.service.ts` `create` and `update`, reached from `api/api-v1/v1-webhooks.controller.ts`). A key reaches every department of its brand by design (`api/tenant/tenant-scope.ts`) |
| 4.1.5 | Fails securely | Met | Undeclared route refused (`PermissionGuard`), no tenant context means no rows (`FORCE ROW LEVEL SECURITY`) |
| 4.2.1 | Protected against IDOR | Met | RLS by brand and department; the RLS isolation suite (`packages/db/src/rls.integration.test.ts`) covers M6–M8's tenant tables too (`telegram_*`, `ai_calls`, `knowledge_*`, `api_keys`, `webhooks`, `webhook_deliveries` among them, `TENANT_TABLES` in `packages/db/src/rls.ts`), and DOMAIN-RULES §1.6 negative tests |
| 4.2.2 | Anti-CSRF | Met | API authenticated by bearer header, not cookies, `/api/v1` included; the refresh cookie is `SameSite=Lax` on `/api/auth` only; the setup wizard checks `Sec-Fetch-Site` (`api/install/same-site.ts`); the Telegram webhook needs the bot's secret header and the knowledge OAuth callback a signed `state` |
| 4.3.1 | Admin interfaces use MFA | Met | Required for every Admin and install admin whatever `auth.require2fa` says; one without is sent to enrolment at sign-in and cannot turn it off (`auth.service.ts` `isSecondFactorRequired`) |
| 4.3.2 | Directory browsing disabled, no metadata exposed | Met | `@fastify/static` without listing; no `.git` in the image (`.dockerignore`) |
| 4.3.3 | Step-up or segregation for high-value actions | Met | Step-up for credential changes; destructive brand actions need `brand:manage` (Admin) and are audited |

## V5 Validation, sanitisation and encoding

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 5.1.1 | HTTP parameter pollution | Met | Query schemas declare which keys may repeat (arrays) and coerce the rest |
| 5.1.2 | Mass assignment | Met | Zod objects strip unknown keys; repositories write named columns |
| 5.1.3 | Positive input validation | Met | Zod everywhere (`pnpm check:validation`); a Telegram update through `telegramUpdateSchema`, anything else answered 400 (`api/telegram/telegram-webhook.service.ts`); a model's JSON answer is parsed against the task's schema and keeps only the brand's own tag and department ids (`packages/ai/src/assist/answers.ts`) |
| 5.1.4 | Structured data strongly typed | Met | Same |
| 5.1.5 | Redirects only to allowed destinations | Met | Auth redirects go to fixed admin paths (`api/auth/auth.controller.ts` `#redirect`); help center redirects stay on its own host |
| 5.2.1 | Untrusted HTML sanitised | Met | Allow-list sanitiser for message and article HTML (ADR 0007); a model's answer is escaped and sanitised before it is stored (`api/ai/auto-reply/answer-body.ts`), a proposed article goes through `sanitizeArticleHtml` (`api/assist/proposals.service.ts`) |
| 5.2.2 | Unstructured data sanitised | Met | Text fields length-capped and rendered escaped; a Telegram customer's text is escaped before it becomes a message body (`packages/channels/src/telegram/telegram-adapter.ts`, `paragraphsToHtml`) |
| 5.2.3 | Input to mail systems sanitised | Met | Addresses validated as email; Nodemailer builds headers |
| 5.2.4 | No `eval` or dynamic code | Met | None in the codebase; CSP without `unsafe-eval` |
| 5.2.5 | Template injection | Met | No user-controlled templates; macro placeholders are a fixed list (`docs/guides/macros.md`) |
| 5.2.6 | SSRF | Met | `packages/net` `safeFetch` refuses private ranges, re-resolves and re-checks redirects; Semgrep `helpdock-fetch-non-constant-url`. M6–M8 reach out through it for webhook deliveries (`api/webhooks/webhook-deliver.job.ts`, no redirects), the crawler and the Notion and Drive connectors (`api/knowledge/safe-transports.ts`), embeddings, model discovery and transcription (`api/ai/ai-http.ts`). Two exceptions by decision, both set by the operator or an install admin: the Bot API host (`TELEGRAM_API_ROOT`, M6-01) and chat completions to a provider's base URL ([ADR 0018](../decisions/0018-pi-ai-provider-layer.md)); see 12.6.1 |
| 5.2.7 | SVG scriptable content | Met | SVG is not an accepted upload kind (`api/media/magic-bytes.ts`) |
| 5.2.8 | Markdown, CSS and similar sanitised | Met | Markdown through TipTap and the sanitiser (ADR 0014); help center custom CSS sanitised (`api/help-center/site/custom-css.ts`); a model's Markdown draft is escaped and limited to headings, lists and bold (`packages/ai/src/assist/markdown.ts`); Telegram is sent plain text, no `parse_mode` (`packages/channels/src/telegram/render.ts`) |
| 5.3.1 | Output encoding per context | Met | React escaping; server-rendered pages escape per attribute and text |
| 5.3.2 | Character set preserved | Met | UTF-8 throughout; `charset=utf-8` on HTML responses |
| 5.3.3 | Context-aware XSS escaping | Met | As 5.3.1, plus a strict CSP with hashed inline scripts (`api/static/content-security-policy.ts`) |
| 5.3.4 | Parameterised queries | Met | Drizzle and the `sql` tag; Semgrep and CodeQL `security-extended` in CI |
| 5.3.5 | Context-specific encoding where not parameterised | Met | Search terms passed as parameters to `to_tsquery` builders (ADR 0011) |
| 5.3.6 | JSON injection | Met | `JSON.stringify` only |
| 5.3.7 | LDAP injection | N/A | No LDAP |
| 5.3.8 | OS command injection | Met | `execFile` with an argument array for ffmpeg (`api/media/ffmpeg.ts`) |
| 5.3.9 | LFI/RFI | Met | Static files served from fixed roots; uploads in S3 under generated keys |
| 5.3.10 | XPath and XML injection | N/A | No XML queries; the sitemap is generated, not parsed |
| 5.4.1 | Memory-safe strings | N/A | Managed runtime |
| 5.4.2 | Format strings | N/A | Managed runtime |
| 5.4.3 | Integer overflow | N/A | Managed runtime; sizes capped by schema |
| 5.5.1 | Serialised objects integrity-protected | Met | Signed JWTs and staff-pass cookies; job payloads re-validated on consume (`packages/jobs` `parseJobPayload`) |
| 5.5.2 | XML parsers restrictive | Met | `mailparser` for MIME; no XML parser on input |
| 5.5.3 | No deserialisation of untrusted data | Met | JSON plus Zod only |
| 5.5.4 | Browser JSON parsed safely | Met | `JSON.parse` / `fetch().json()` only |

## V6 Stored cryptography

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 6.1.1 | Regulated private data encrypted at rest | Partial | Secrets are encrypted (AES-256-GCM); personal data in tickets relies on disk encryption by the operator, and so do the copies M6–M8 keep: each AI call's redaction map (the original emails, phones, cards and IBANs, until the AI-log window nulls it), webhook payloads, Telegram chat ids and usernames |
| 6.1.2 | Regulated health data | N/A | Not collected by design |
| 6.1.3 | Regulated financial data | N/A | Not collected by design |
| 6.2.1 | Crypto failures handled, no padding oracle | Met | GCM authentication failure throws and is mapped to a generic error (`packages/config/src/crypto.ts`) |
| 6.2.2 | Proven algorithms | Met | Node `crypto`, `jose`, argon2 |
| 6.2.3 | IV and mode configured securely | Met | 96-bit random IV per encryption, key id as associated data |
| 6.2.4 | Algorithms upgradable | Met | Versioned ciphertext prefix `v1.<keyId>.…` |
| 6.2.5 | No insecure modes or hashes | Partial | TOTP uses HMAC-SHA-1, as RFC 6238 and every authenticator app require; nothing else uses SHA-1 or ECB |
| 6.2.6 | Nonces not reused | Met | Random IV per call |
| 6.3.1 | CSPRNG for security values | Met | `randomBytes` for tokens, API keys, webhook signing secrets and bot webhook secrets (32 bytes each), `crypto.randomUUID`/UUIDv7 for ids |
| 6.3.2 | Random GUIDs | Met | UUIDv7 ids carry 74 random bits; no security decision rests on an id being unguessable |
| 6.4.1 | Secrets management solution | Met | One keyring, secrets encrypted in `settings` and in envelope columns, `.env` held by the operator (no external vault in v1); the master key is rotated with `node dist/cli.js keys rotate` (`docs/guides/operations.md` "Rotating the master key") |
| 6.4.2 | Key material not exposed to the application at large | Met | Only `packages/config` reads the key; decrypted values are never returned to a client after save (a bot shows the last four characters of its token, `tokenHint`; a webhook secret and an API key are shown once, on create or rotate) |

## V7 Error handling and logging

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 7.1.1 | No credentials or session tokens logged | Met | pino `redact` with `remove: true` (`api/logging/logger.ts`), token paths scrubbed, Semgrep `helpdock-secret-in-log`. The access line carries no header, query or body (`api/context/request-context.middleware.ts`), so neither an API key nor `X-Telegram-Bot-Api-Secret-Token` reaches it; the bot token is cut out of every Bot API error (`toTelegramFailure`, `packages/channels/src/telegram/bot-api.ts`; `bot-api.test.ts` › "never repeats the token from a transport error") |
| 7.1.2 | No other sensitive data logged | Met | `operations.md` "What a line never carries"; a webhook attempt logs ids and status, never the URL or the body (`api/webhooks/webhook-deliver.job.ts`), a blocked destination its host only (`api/worker/start-worker.ts`); prompts and answers go to `ai_calls`, not the log |
| 7.1.3 | Security-relevant events logged | Met | Every sign-in success and failure, lock, refused step-up, replayed code, reused refresh token and credential change is an `auth.*` row in install scope with address and user agent (`api/auth/auth-audit.ts`, ADR 0022); rate-limit refusals are counted in `rate_limit_refusals_total`. M6–M8 audit API keys issued and revoked (`api_key.*`), bots (`telegram_bot.*`), webhook endpoints and their secrets (`webhook.*`), AI settings, modes and prompts (`ai.*.updated`), the budget alert (`ai.budget_alert`) and master key rotation (`install.master_key_rotated`) |
| 7.1.4 | Enough detail for an investigation | Met | Request id, role, user id, brand id on every line |
| 7.2.1 | Authentication decisions logged | Partial | Sign-in decisions as 7.1.3. An API key refused, unknown or revoked, is only the access line's 401, without the key's prefix or the caller's address, and is not audited (`api/api-keys/api-key-principal-resolver.ts` `resolve`, `api/auth/auth.guard.ts`); a Telegram update refused for its secret is the same (`api/telegram/telegram-webhook.service.ts`) |
| 7.2.2 | Access control decisions logged | Partial | Refusals logged at `debug` by the exception filter, a key's missing scope included; not audited |
| 7.3.1 | Log injection prevented | Met | Structured JSON lines |
| 7.3.3 | Logs protected from tampering | Partial | Audit log is append-only to the runtime role (RLS, no update policy); process logs are the operator's |
| 7.3.4 | Time synchronised | Operator | Host NTP; timestamps in UTC ISO 8601 |
| 7.4.1 | Generic message with an id on unexpected errors | Met | `api/http/exception.filter.ts` answers `{ error: { code, message, requestId } }` (`api/http/error-response.ts`), on `/api/v1` too (`docs/guides/api.md` "Authentication and limits") |
| 7.4.2 | Exceptions handled across the codebase | Met | One global filter; socket ack filter (`api/realtime/ack-exception.filter.ts`) |
| 7.4.3 | Last-resort handler | Met | Same filter catches everything (`@Catch()`) |

## V8 Data protection

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 8.1.1 | Sensitive data not cached by intermediaries | Met | Answers that carry personal data are to requests with an `Authorization` header (staff bearer, API key, widget visitor), which a shared cache may not store (RFC 9111 §3.5); only public help center pages are `public` (`docs/guides/help-center.md` "Caching"). The JSON answers set no `Cache-Control` of their own (8.2.1) |
| 8.1.2 | Cached and temporary copies protected | Met | Redis page cache holds public pages only; staff pages never cached |
| 8.1.3 | Few parameters in requests | Met | Ids in paths, bodies in JSON |
| 8.1.4 | Abnormal request volumes detected and alerted | Met | `rate_limit_refusals_total{bucket}` on every limit, and an alert on it in the operations guide's first alert set |
| 8.2.1 | Anti-caching headers for sensitive data | Partial | No JSON answer sets `Cache-Control`: `api/http/security-headers.ts` and `api/http/json-disposition.ts` add none, so nothing tells a browser not to keep an API answer, an `/api/v1` read of tickets or contacts included. The admin's `index.html`, the help center's private pages, the web form, `/metrics` and the queue board say `no-store` |
| 8.2.2 | No sensitive data in browser storage | Partial | The admin stores nothing; the widget keeps the visitor secret in `localStorage` by design (widget protocol "A visitor") |
| 8.2.3 | Client storage cleared at session end | Partial | Admin memory cleared on sign-out; the widget visitor secret persists until the visitor clears it |
| 8.3.1 | Sensitive data in bodies or headers, not the URL | Partial | Email links carry their token in the path (scrubbed from logs), and the knowledge OAuth `state` rides the provider's redirect; everything else is in bodies or headers, an API key in `Authorization` only |
| 8.3.2 | Users can export or delete their data | Partial | Erasure ("Anonymise contact") and export (`GET …/contacts/:contactId/export`: contact, tickets, conversation, attachment paths; Admin only, audited). Erasure leaves what M6–M8 copied: the chat id and `@username` in `telegram_chats` (and the chat id on `telegram_deliveries`), which DOMAIN-RULES §11 says are replaced with hashes; the original emails and phones in the redaction map of `ai_calls` until the AI-log window; contact and message copies frozen in `webhook_deliveries.payload`. `api/retention/contact-erasure.ts` touches none of them |
| 8.3.3 | Users told what is collected | Partial | Operator's privacy notice; the help center footer links are configurable but nothing ships a notice. The widget marks the assistant's answers with the AIBadge, but nothing tells a visitor that their messages, with emails, phones, cards and IBANs replaced, are sent to a model provider |
| 8.3.4 | Sensitive data identified with a policy | Met | DOMAIN-RULES §11. Before any text reaches a model, emails, phones, Luhn-valid cards and mod-97-valid IBANs are replaced with placeholders, whatever the brand's settings (`packages/ai/src/guardrails/pii.ts`, `pii.test.ts`); names and postal addresses are not |
| 8.3.5 | Access to sensitive data audited | Partial | Changes are audited (`audit_log`); reads are not, an API key's reads of tickets and contacts included |
| 8.3.6 | Sensitive data in memory overwritten | Partial | Not possible in a garbage-collected runtime beyond dropping references |
| 8.3.7 | Encryption with confidentiality and integrity | Met | AES-256-GCM |
| 8.3.8 | Retention classification | Partial | Per-brand retention windows and the nightly purge (`docs/guides/data-retention.md`); AI call bodies are nulled after the AI-log window (`api/retention/retention.repository.ts` `purgeAiCallBodiesBatch`). Nothing purges `webhook_deliveries` (frozen ticket, message and contact payloads) or `telegram_deliveries` while their endpoint or bot exists, so a purged ticket's copies outlive it; `api_idempotency_keys` (stored answers) are cleared only when the brand's next idempotent request arrives. DOMAIN-RULES §11 has no line for any of them |

## V9 Communications

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 9.1.1 | TLS for all client traffic, no fallback | Met | Caddy terminates TLS for the admin, api and help center hosts and redirects http (`docker/caddy/Caddyfile`); HSTS on owned hosts |
| 9.1.2 | Strong cipher suites | Met | Caddy's defaults (TLS 1.2 AEAD suites and TLS 1.3) |
| 9.1.3 | Only TLS 1.2 and 1.3 | Met | Caddy's default minimum is TLS 1.2 |
| 9.2.1 | Trusted certificates | Met | ACME certificates; on-demand only for verified domains |
| 9.2.2 | Encrypted connections for all inbound and outbound connections | Partial | Outbound SMTP, IMAP, OAuth and push use TLS; Postgres and Redis on the internal network do not. Of M6–M8's: the Bot API is `https://api.telegram.org` unless `TELEGRAM_API_ROOT` says otherwise; a webhook endpoint must be https unless it resolves inside `OUTBOUND_ALLOW_CIDRS` (`api/webhooks/webhook-destination.ts`); a provider's base URL, the embeddings URL and the transcription endpoint accept plain `http` to any public host, so a key and redacted prompts can cross the internet in clear (`packages/schemas/src/ai.ts` `aiProviderUpsertSchema`, `embeddingSettingsUpdateSchema`, `transcriptionSettingsUpdateSchema`) |
| 9.2.3 | External connections authenticated | Met | Certificate verification left on in every client (nothing outside tests sets `rejectUnauthorized: false`); `safeFetch` validates TLS; grammY and pi-ai's provider clients keep Node's defaults |
| 9.2.4 | Revocation checking (OCSP stapling) | Met | Caddy staples OCSP by default |
| 9.2.5 | Backend TLS failures logged | Partial | SMTP and IMAP failures logged with their code (`docs/guides/email.md`); a webhook attempt records the client's error code and message on the delivery (`describeFailure`, `api/webhooks/webhook-deliver.job.ts`), a Bot API failure its kind and message on the bot; not every client distinguishes TLS errors |

## V10 Malicious code

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 10.2.1 | No unauthorised phone-home | Met | No telemetry; outbound calls go only to what an install configures: since M6–M8 also the Bot API, model providers, the embeddings and transcription endpoints, Notion, Google Drive and webhook endpoints. Model lists and prices for built-in providers come from pi-ai's bundled registry, without a request (`docs/guides/ai.md` "Models") |
| 10.2.2 | No unnecessary permissions | Met | Web push asks for notification permission only when a person turns it on |
| 10.3.1 | Updates over secure channels, signed | Met | Images from GHCR by tag over TLS, each release's digest signed keylessly with Cosign from `v0.4.0` on (`release.yml`; `docs/guides/release.md` "Verify the image signature"); no auto-update |
| 10.3.2 | Integrity protection (SRI, signing) | Met | No third-party scripts or CDNs, the `/api/docs` page included (`api/api-v1/api-docs.controller.ts`); fonts self-hosted; an SBOM and a Cosign signature per release |
| 10.3.3 | Subdomain takeover protection | Met | Help center domains need a TXT verification before Caddy will issue (`api/domains`, M5-07) |

## V11 Business logic

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 11.1.1 | Flows processed in order | Met | Ticket transitions validated against DOMAIN-RULES §2; wizard steps need the setup token |
| 11.1.2 | Realistic human timing | Partial | Rate limits cap speed; there is no minimum-time check |
| 11.1.3 | Limits per business action | Met | Widget per-visitor write budget, sign-in budgets, transcript cap (`widget-protocol.md` "Throttles"), socket event budgets (`realtime.md` "Event budgets"); a per-minute budget per API key (600 by default, `api/api-keys/api-key-principal-resolver.ts`); a daily and monthly AI budget per brand with a hard stop (`BudgetExceededError`, `packages/ai/src/complete.ts`) |
| 11.1.4 | Anti-automation against excessive calls | Met | Same, plus CAPTCHA on the widget and web form (ADR 0003); the Telegram webhook is limited per address before its secret is checked (`api/telegram/telegram-webhook.controller.ts`) |
| 11.1.5 | Business logic limits against likely risks | Met | Load caps on assignment, depth guard on rules (`automation.md`), attachment caps; a webhook delivery stops after eight attempts and an endpoint is switched off after 10 failed deliveries in a row (`api/webhooks/webhook-deliver.job.ts`); a crawl stops at its page cap; an auto-reply never follows a handoff (`api/ai/auto-reply/ai-pause.ts`) |
| 11.1.6 | No TOCTOU on sensitive operations | Met | Advisory locks (wizard step 1, assignment, outbox), unique constraints with `clientId`; an `Idempotency-Key` is claimed on a unique index and a concurrent request waits for the first (`api/api-v1/idempotency.repository.ts` `claim`); a Telegram message is filed once (`ticket_messages_external_key`); an auto-reply re-reads the pause and newer messages under the ticket's row lock before it writes (`auto-reply.integration.test.ts`) |
| 11.1.7 | Unusual activity monitored | Partial | Metrics and logs exist; no anomaly alerting. An AI budget crossing 80 % reaches the audit log and the settings answer only (`api/ai/budget-alert.handler.ts`) |
| 11.1.8 | Alerts on automated attacks | Met | As 8.1.4; the `api-key` and `telegram-webhook` buckets are counted too (`api/auth/rate-limit.ts`, `api/routes/ip-rate-limit.ts`) |

## V12 Files and resources

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 12.1.1 | Large files cannot exhaust storage | Met | Per-kind size caps in the brand's content policy, enforced at presign and confirm (`docs/guides/attachments.md`); a Telegram file is read only up to the Bot API's 20 MB, by its declared size and again while streaming (`downloadFile`, `packages/channels/src/telegram/bot-api.ts`), then meets the same content policy; knowledge files 25 MB (`KNOWLEDGE_FILE_MAX_BYTES`), connector answers 26 MB (`api/knowledge/safe-transports.ts`), audio for transcription 25 MB (`api/transcription/transcribe.job.ts`) |
| 12.1.2 | Compressed files checked | Gap | A DOCX upload, or a Word file from Drive, is a ZIP that mammoth unpacks in the worker with only the 25 MB cap on the compressed bytes: nothing checks the uncompressed size or the number of entries before it is opened (`packages/ai/src/knowledge/files.ts` `extractDocx`). Attachments and other archives are stored, never unpacked |
| 12.1.3 | Size quota per user | Partial | Per file and per message caps; no per-visitor total quota |
| 12.2.1 | Type checked by content | Met | Magic-byte sniffing (ADR 0009), images re-encoded with sharp; Telegram files take the same path (`StorageAttachmentSink`, `api/telegram/telegram-inbound.service.ts`); a knowledge file's bytes must match its declared family before any parser sees them (`api/knowledge/load-source.ts`) |
| 12.3.1 | Filenames not used by the file system | Met | Objects keyed by generated ids; the name is metadata only |
| 12.3.2 | Filename metadata cannot cause LFI | Met | Same |
| 12.3.3 | Filename metadata cannot cause RFI/SSRF | Met | Same |
| 12.3.4 | Reflected file download | Met | `Content-Disposition` set by the presign; JSON never served as a download |
| 12.3.5 | Metadata not passed to system commands | Met | ffmpeg reads a temp path the worker chose |
| 12.3.6 | No code from untrusted sources | Met | No CDN or remote includes |
| 12.4.1 | Uploads stored outside the web root | Met | S3 bucket, private, presigned reads after authorisation on the parent ticket |
| 12.4.2 | Uploads scanned by antivirus | Partial | ClamAV is optional (`CLAMAV_HOST`); off by default. Telegram files are scanned with the other attachments when it is on; knowledge files are parsed, never scanned |
| 12.5.1 | Only expected file types served | Met | The api serves fixed static roots; uploads come from S3 |
| 12.5.2 | Uploads never executed as HTML/JS | Met | Non-image kinds served as attachments; images re-encoded to WebP |
| 12.6.1 | Server-side request allow list | Partial | `safeFetch` policies per caller (`packages/net/src/policy.ts`), `OUTBOUND_ALLOW_CIDRS` for exceptions; a webhook endpoint is resolved and checked when it is saved as well as on every attempt (`api/webhooks/webhook-destination.ts`). Chat completions go through pi-ai's own clients to the provider's base URL, outside any policy ([ADR 0018](../decisions/0018-pi-ai-provider-layer.md)), and that URL is not resolved or checked when an install admin saves it (`api/ai/install-ai.service.ts`) |

## V13 API and web services

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 13.1.1 | Same encoders and parsers everywhere | Met | One Fastify JSON parser; Zod shared between api and clients (`packages/schemas`); a webhook body is `JSON.stringify` of the frozen payload, the same string signed and sent (`api/webhooks/webhook-request.ts`) |
| 13.1.3 | No secrets in URLs | Partial | Email-link tokens and the staff pass are in URLs, single-use and short-lived; the knowledge OAuth `state` is too (signed, ten minutes, not single-use). Outbound, the Bot API takes the bot token in its path by Telegram's design; it is kept out of errors and logs (`toTelegramFailure`). API keys travel in `Authorization` only |
| 13.1.4 | Authorisation at controller and resource level | Met | `@Requires` plus RLS; on `/api/v1` the key's scope and its one brand (`api-v1.integration.test.ts` › "holds a key to its scopes: a tickets:read key cannot write, and no key reaches a staff route") |
| 13.1.5 | Unexpected content types refused | Met | Fastify answers 415 for unsupported content types |
| 13.2.1 | Methods valid for the action | Met | Each route declares one method; Fastify answers 404/405 otherwise; `/api/v1` lists each method with its scope (`API_OPERATIONS`, `api/api-v1/openapi.ts`) |
| 13.2.2 | JSON schema validation | Met | Zod; the OpenAPI 3.1 document at `/api/docs/openapi.json` is generated from the same route schemas, and `openapi.test.ts` fails when a v1 route is missing from it ([ADR 0019](../decisions/0019-api-scopes-and-openapi-from-zod.md)); a Telegram update is read through `telegramUpdateSchema` |
| 13.2.3 | Cookie-authenticated REST protected from CSRF | Met | Only `/api/auth` reads the session cookie, `SameSite=Lax`; the help center's staff cookie is `SameSite=Lax` too (`api/help-center/site/site.controller.ts`); `/api/v1` reads only `Authorization` and sends no CORS headers |
| 13.2.5 | Content-Type checked | Met | As 13.1.5 |
| 13.2.6 | Message integrity in transit | Met | TLS (V9). Outbound webhooks carry `X-Helpdock-Signature: t=…,v1=…`, an HMAC-SHA256 of the timestamp and the body under the endpoint's secret, so a receiver can refuse an altered or replayed request (`api/webhooks/webhook-signature.ts`, `webhook-signature.test.ts`; `api-v1.integration.test.ts` verifies one end to end); a Telegram update must carry the bot's secret token, compared in constant time (`sameSecret`, `api/telegram/telegram-webhook.service.ts`) |
| 13.3.1 | SOAP schema validation | N/A | No SOAP |
| 13.3.2 | WS-Security signing | N/A | No SOAP |
| 13.4.1 | GraphQL query allow list or depth limiting | N/A | No GraphQL |
| 13.4.2 | GraphQL authorisation in the business layer | N/A | No GraphQL |

## V14 Configuration

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 14.1.1 | Secure, repeatable build and deploy | Met | `ci.yml`, `release.yml`, pinned actions, frozen lockfile; the released image's digest is signed with Cosign and the signature verified against the workflow identity before the Release is made (`release.yml`, #162) |
| 14.1.2 | Compiler hardening flags | N/A | No native code of our own |
| 14.1.3 | Server configuration hardened | Met | `docker/caddy/Caddyfile` refuses `/internal/*`; api headers (`api/http/security-headers.ts`) |
| 14.1.4 | Redeployable from scripts | Met | Compose files, `docs/guides/install.md` |
| 14.1.5 | Integrity of security configuration verifiable | Partial | Env-pinned settings shown as locked in the admin; no checksum of the running configuration |
| 14.2.1 | Components up to date, checked in the build | Met | Renovate, `pnpm audit --audit-level high` in CI, CodeQL `security-extended` (`.github/workflows/codeql.yml`; `.github/codeql/codeql-config.yml` turns off `js/insufficient-password-hash`, which reads an API key's SHA-256 as a password hash, with the reason), Semgrep (`.semgrep/helpdock.yml`), and a ZAP baseline on release branches and tags (`zap.yml`), unauthenticated, so `/api/v1` is not exercised with a key |
| 14.2.2 | Unneeded features removed | Met | Production image has no dev dependencies; the dev principal header refuses to start outside development (`api/auth/principal-resolver.ts`) |
| 14.2.3 | SRI for externally hosted assets | Met | None are external |
| 14.2.4 | Components from trusted repositories | Met | npm through the frozen lockfile; the base image from Docker Hub's official `node` image by tag (`docker/Dockerfile`) |
| 14.2.5 | Inventory of third-party libraries (SBOM) | Met | CycloneDX SBOM attached to every release (`release.yml`) |
| 14.2.6 | Third-party libraries sandboxed | Partial | sharp and ffmpeg run in the worker, not the api; so do unpdf and mammoth on knowledge files and, with `KNOWLEDGE_CRAWL_RENDER`, a headless Chromium on crawled pages (its requests answered by the safe client, `api/knowledge/crawl-renderer.ts`); none is further isolated |
| 14.3.2 | Debug modes off in production | Met | `NODE_ENV=production` in the image; pretty logging and the dev principal header refuse production |
| 14.3.3 | No version details in headers | Partial | No `X-Powered-By`; the System page shows the version to admins. The public `/api/docs` page and `/api/docs/openapi.json` carry the release version in `info.version` and the page title (`api/api-v1/api-docs.controller.ts`, `buildOpenApiDocument(buildInfo().version)`) |
| 14.4.1 | `Content-Type` with charset on every response | Met | Fastify sets it for JSON and HTML |
| 14.4.2 | `Content-Disposition` on API responses | Met | `attachment; filename="api.json"` on every JSON answer unless a route chose its own (`api/http/json-disposition.ts`) |
| 14.4.3 | Content Security Policy | Met | `default-src 'none'` on the api; hashed scripts and per-response style nonces on the admin; nonces on the help center and web form; the `/api/docs` page sends its own `default-src 'none'` policy with inline style only (`DOCS_PAGE_CSP`) |
| 14.4.4 | `X-Content-Type-Options: nosniff` | Met | helmet |
| 14.4.5 | HSTS | Met | On https installs, api and Caddy |
| 14.4.6 | Referrer-Policy | Met | `no-referrer` |
| 14.4.7 | Not embeddable by default | Met | `frame-ancestors 'none'` |
| 14.5.1 | Only used methods accepted | Met | Fastify routes per method |
| 14.5.2 | Origin not used for authentication | Met | Origin only narrows the widget (an allow list on top of the visitor credential) and the staff socket |
| 14.5.3 | CORS with a strict allow list | Partial | Widget routes echo the origin on preflight and refuse a disallowed one at the gate, without credentials; the staff API and `/api/v1` send no CORS headers |
| 14.5.4 | Proxy-added headers authenticated | Met | `X-Forwarded-*` believed only with `TRUST_PROXY=true`; Caddy overwrites `X-Request-Id` |

## How to keep this current

Walk the chapters a change touches when it ships, as M6, M7 and M8 were on
2026-10-09: a new channel (V5 inbound validation, V12 its media), a new outside
service (V9, V12.6), new credentials (V2.10, V3.5, V6), new copies of personal
data (V8). Update the summary counts with the rows, and list each row whose
status changed in a table like the re-walk's.
