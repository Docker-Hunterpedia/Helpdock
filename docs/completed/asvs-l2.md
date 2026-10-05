# OWASP ASVS 4.0.3 Level 2 walk-through

M9-02 ([PRD §4 · M9](../planning/PRD.md#m9-hardening-and-10),
[REQUIREMENTS §5.1](../planning/REQUIREMENTS.md)). Every Level 2 requirement of
the [Application Security Verification Standard
4.0.3](https://github.com/OWASP/ASVS/tree/v4.0.3/4.0), with what Helpdock does
about it and where the proof is.

Walked on 2026-10-05 against the integration branch after M0–M5 and the first
M9 work (Semgrep, ZAP, per-browser revocation, socket budgets). M6 Telegram, M7
AI and M8 API keys and webhooks were still being built; requirements they touch
are marked so and must be walked again when they land. This is a desk review
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
| V1 Architecture, design and threat modeling | 30 | 7 | 0 | 1 | 0 |
| V2 Authentication | 36 | 3 | 0 | 11 | 0 |
| V3 Session management | 14 | 3 | 0 | 1 | 0 |
| V4 Access control | 9 | 0 | 0 | 0 | 0 |
| V5 Validation, sanitisation and encoding | 25 | 0 | 0 | 5 | 0 |
| V6 Stored cryptography | 9 | 2 | 0 | 2 | 0 |
| V7 Error handling and logging | 9 | 2 | 0 | 0 | 1 |
| V8 Data protection | 9 | 6 | 0 | 0 | 0 |
| V9 Communications | 6 | 2 | 0 | 0 | 0 |
| V10 Malicious code | 5 | 0 | 0 | 0 | 0 |
| V11 Business logic | 6 | 2 | 0 | 0 | 0 |
| V12 Files and resources | 12 | 2 | 0 | 1 | 0 |
| V13 API and web services | 8 | 1 | 0 | 4 | 0 |
| V14 Configuration | 20 | 3 | 0 | 1 | 0 |
| **All** | **198** | **33** | **0** | **26** | **1** |

### Gaps and partials closed before 1.0

The walk-through found eleven; all were closed in M9-02's follow-up, each with
the evidence in its row below. One closes with a recorded deviation (3.4.4).

| Requirement | What was missing | What closed it |
|---|---|---|
| 2.2.3, 2.5.5 | No email when a password, second factor or recovery codes change | A `securityChange` auth email through the outbox, `en` and `ar` (`api/auth/auth.service.ts` `#notifySecurityChange`) |
| 2.1.7 | No breached-password check | A bundled list, checked at every place a password is set ([ADR 0019](../decisions/0019-bundled-breached-password-list.md)) |
| 2.8.4, 2.8.5 | A TOTP code could open a second challenge within its 30 s | The last accepted step is kept per account and only later ones pass (`api/auth/totp/used-steps.ts`) |
| 2.1.8, 2.1.12 | No strength meter and no show-password toggle on every password field | `Admin/PasswordField` on the four screens that choose a password (`apps/admin/src/ui/password-field.tsx`) |
| 3.3.2 | A refresh family lived 30 days, renewed by use | Idle and absolute limits, `AUTH_SESSION_IDLE_MINUTES` (240) and `AUTH_SESSION_MAX_HOURS` (12) |
| 3.4.4 | No cookie prefix | `__Secure-` over https; `__Host-` declined to keep `Path=/api/auth` (deviation, see the row) |
| 4.3.1 | A second factor for administrators was a setting | Required for Admins and install admins whatever the setting; enrolment by challenge at the next sign-in |
| 7.1.3, 7.2.1 | Sign-in failures only in the process log | An `auth.*` trail in install scope ([ADR 0020](../decisions/0020-auth-audit-trail-in-install-scope.md)) |
| 8.1.4 | Nothing alerted on rate-limit refusals | `rate_limit_refusals_total{bucket}` and an alert in the operations guide |
| 8.3.2 | No contact export | `GET /api/brands/:brandId/contacts/:contactId/export`, Admin only, audited |
| 14.4.2 | No `Content-Disposition` on JSON | `attachment; filename="api.json"` on every JSON answer (`api/http/json-disposition.ts`) |

## V1 Architecture, design and threat modeling

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1.1.1 | Secure software development lifecycle | Met | Planning documents per milestone (`docs/planning/`), deliverable ids, review skills under `.agents/skills/` (`security-audit`, `clean-code-guard`), a Definition of done in `AGENTS.md` |
| 1.1.2 | Threat modeling for every design change | Partial | Threats are reasoned per feature in `docs/planning/DOMAIN-RULES.md` (tenancy §1, SSRF §13, outbox §6) and in ADRs; there is no standing threat model document |
| 1.1.3 | User stories carry security constraints | Met | `docs/planning/REQUIREMENTS.md` §5.1 and the "Engineering rules" of `AGENTS.md` apply to every story |
| 1.1.4 | Trust boundaries, components and data flows documented | Met | `docs/planning/ARCHITECTURE.md` §3, §6, §7; `docs/guides/widget-protocol.md` |
| 1.1.5 | High-level architecture and remote services defined | Met | `ARCHITECTURE.md` §1–§3, §17 |
| 1.1.6 | Centralised, vetted security controls | Met | One permission guard (`api/auth/permission.guard.ts`), one tenant transaction (`packages/db` `withTenant`), one SSRF client (`packages/net`), one sanitiser (ADR 0007) |
| 1.1.7 | Secure coding checklist available to developers | Met | `AGENTS.md` "Engineering rules"; `docs/guides/security-scanning.md` |
| 1.2.1 | Unique, low-privilege OS accounts per component | Partial | The image runs as the non-root `helpdock` user (`docker/Dockerfile`); api and worker share that image and user |
| 1.2.2 | Communications between components authenticated | Partial | Postgres with a runtime role and an owner role (`packages/db` migrations), Redis on the Compose network without a password by default (`docker/docker-compose.yml`) |
| 1.2.3 | One vetted authentication mechanism | Met | `docs/guides/authentication.md`: every way in ends in the same `SessionService.open` |
| 1.2.4 | Every authentication pathway equally strong | Met | Password, magic link and OAuth all pass the same second-factor check (`api/auth/auth.service.ts`, `#openSession`) |
| 1.4.1 | Access control enforced at trusted points | Met | Server side only: `PermissionGuard`, row-level security on every tenant table (`packages/db/src/rls`), the gate on every socket event (`api/realtime/staff.gateway.ts`) |
| 1.4.4 | Single, vetted access control mechanism | Met | `@Requires(permission)` on every route and event, checked in CI (`pnpm check:routes`, Semgrep `helpdock-route-without-declaration`) |
| 1.4.5 | Attribute- or feature-based access control | Met | Permission per route plus department scope per row (DOMAIN-RULES §1.1–§1.3) |
| 1.5.1 | Input and output requirements defined | Met | Zod schemas in `packages/schemas` for every request, response, job and socket message |
| 1.5.2 | No serialisation of untrusted objects | Met | JSON only, parsed by Fastify and validated by Zod |
| 1.5.3 | Input validated on a trusted service layer | Met | `nestjs-zod` pipes on every `@Param`, `@Query`, `@Body` (`pnpm check:validation`) |
| 1.5.4 | Output encoding close to the interpreter | Met | React/Preact escape at render; server HTML through `api/help-center/site/render` escaping helpers |
| 1.6.1 | Explicit key management policy | Met | `docs/guides/operations.md` "The master key"; DOMAIN-RULES §10 |
| 1.6.2 | Consumers of crypto protect key material | Met | One keyring (`packages/config/src/crypto.ts`) holds `APP_MASTER_KEY`; nothing else sees it |
| 1.6.3 | Keys and passwords replaceable | Partial | Each ciphertext records its key id, so two keys can coexist; the rotation command (`helpdock keys rotate`) is M9-06 and not built yet |
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
| 1.14.2 | Binary signatures and trusted connections | Met | Actions pinned by commit sha; image built in CI from the tag (`release.yml`) |
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
| 2.1.7 | Checked against breached passwords | Met | The 46 146 entries of 12+ characters among SecLists' million most common, case-insensitive, checked by the wizard, invitation acceptance, reset and change (`api/auth/breached/breached-passwords.ts`, ADR 0019); `password-breached` drawn on the field; `breached-passwords.test.ts`, `auth.service.test.ts` › breached passwords |
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
| 2.10.1 | Intra-service secrets are not static credentials | Met | Services authenticate with per-install generated secrets (`APP_MASTER_KEY`, database role passwords); no shared human account |
| 2.10.2 | No default service passwords | Met | `.env.example` ships no passwords; the install guide generates each one (`docs/guides/install.md`) |
| 2.10.3 | Service passwords stored protected | Met | In `.env` (operator-held) or encrypted settings |
| 2.10.4 | No secrets in source code | Met | Secrets come from `.env` (ignored by `.gitignore`) or encrypted settings; none in the tree |

OAuth sign-in (Google, GitHub) uses PKCE and a single-use, hashed `state`
(`api/auth/oauth/oauth.service.ts`), and only signs in an address the install
already knows.

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
| 3.5.1 | Users can revoke OAuth tokens of linked apps | N/A | Helpdock keeps no provider tokens after sign-in |
| 3.5.2 | Session tokens, not static API secrets | Met | Staff sessions only; API keys are M8 and must be walked again then |
| 3.5.3 | Stateless tokens signed, short-lived, replay-resistant | Met | ES256, 10 minutes, revocation marker checked on every request and socket event |
| 3.7.1 | Full session or re-auth before sensitive actions | Partial | Password change, second-factor removal and recovery code regeneration re-prove a credential; other administrative changes do not |

## V4 Access control

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 4.1.1 | Enforced on a trusted service layer | Met | Guards and RLS; nothing trusts the client |
| 4.1.2 | Access attributes cannot be manipulated by users | Met | Claims come from the signed token; `app.*` session settings set by the server (`packages/db` `withTenant`) |
| 4.1.3 | Least privilege | Met | Permission matrix (DOMAIN-RULES §1.2), department scope, Viewer role |
| 4.1.5 | Fails securely | Met | Undeclared route refused (`PermissionGuard`), no tenant context means no rows (`FORCE ROW LEVEL SECURITY`) |
| 4.2.1 | Protected against IDOR | Met | RLS by brand and department; the RLS isolation suite (`packages/db/src/rls.integration.test.ts`) and DOMAIN-RULES §1.6 negative tests |
| 4.2.2 | Anti-CSRF | Met | API authenticated by bearer header, not cookies; the refresh cookie is `SameSite=Lax` on `/api/auth` only; the setup wizard checks `Sec-Fetch-Site` (`api/install/same-site.ts`) |
| 4.3.1 | Admin interfaces use MFA | Met | Required for every Admin and install admin whatever `auth.require2fa` says; one without is sent to enrolment at sign-in and cannot turn it off (`auth.service.ts` `isSecondFactorRequired`) |
| 4.3.2 | Directory browsing disabled, no metadata exposed | Met | `@fastify/static` without listing; no `.git` in the image (`.dockerignore`) |
| 4.3.3 | Step-up or segregation for high-value actions | Met | Step-up for credential changes; destructive brand actions need `brand:manage` (Admin) and are audited |

## V5 Validation, sanitisation and encoding

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 5.1.1 | HTTP parameter pollution | Met | Query schemas declare which keys may repeat (arrays) and coerce the rest |
| 5.1.2 | Mass assignment | Met | Zod objects strip unknown keys; repositories write named columns |
| 5.1.3 | Positive input validation | Met | Zod everywhere (`pnpm check:validation`) |
| 5.1.4 | Structured data strongly typed | Met | Same |
| 5.1.5 | Redirects only to allowed destinations | Met | Auth redirects go to fixed admin paths (`api/auth/auth.controller.ts` `#redirect`); help center redirects stay on its own host |
| 5.2.1 | Untrusted HTML sanitised | Met | Allow-list sanitiser for message and article HTML (ADR 0007) |
| 5.2.2 | Unstructured data sanitised | Met | Text fields length-capped and rendered escaped |
| 5.2.3 | Input to mail systems sanitised | Met | Addresses validated as email; Nodemailer builds headers |
| 5.2.4 | No `eval` or dynamic code | Met | None in the codebase; CSP without `unsafe-eval` |
| 5.2.5 | Template injection | Met | No user-controlled templates; macro placeholders are a fixed list (`docs/guides/macros.md`) |
| 5.2.6 | SSRF | Met | `packages/net` `safeFetch` refuses private ranges, re-resolves and re-checks redirects; Semgrep `helpdock-fetch-non-constant-url` |
| 5.2.7 | SVG scriptable content | Met | SVG is not an accepted upload kind (`api/media/magic-bytes.ts`) |
| 5.2.8 | Markdown, CSS and similar sanitised | Met | Markdown through TipTap and the sanitiser (ADR 0014); help center custom CSS sanitised (`api/help-center/site/custom-css.ts`) |
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
| 6.1.1 | Regulated private data encrypted at rest | Partial | Secrets are encrypted (AES-256-GCM); personal data in tickets relies on disk encryption by the operator |
| 6.1.2 | Regulated health data | N/A | Not collected by design |
| 6.1.3 | Regulated financial data | N/A | Not collected by design |
| 6.2.1 | Crypto failures handled, no padding oracle | Met | GCM authentication failure throws and is mapped to a generic error (`packages/config/src/crypto.ts`) |
| 6.2.2 | Proven algorithms | Met | Node `crypto`, `jose`, argon2 |
| 6.2.3 | IV and mode configured securely | Met | 96-bit random IV per encryption, key id as associated data |
| 6.2.4 | Algorithms upgradable | Met | Versioned ciphertext prefix `v1.<keyId>.…` |
| 6.2.5 | No insecure modes or hashes | Partial | TOTP uses HMAC-SHA-1, as RFC 6238 and every authenticator app require; nothing else uses SHA-1 or ECB |
| 6.2.6 | Nonces not reused | Met | Random IV per call |
| 6.3.1 | CSPRNG for security values | Met | `randomBytes` for tokens, `crypto.randomUUID`/UUIDv7 for ids |
| 6.3.2 | Random GUIDs | Met | UUIDv7 ids carry 74 random bits; no security decision rests on an id being unguessable |
| 6.4.1 | Secrets management solution | Met | One keyring, secrets encrypted in `settings`, `.env` held by the operator (no external vault in v1) |
| 6.4.2 | Key material not exposed to the application at large | Met | Only `packages/config` reads the key; decrypted values are never returned to a client after save |

## V7 Error handling and logging

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 7.1.1 | No credentials or session tokens logged | Met | pino `redact` with `remove: true` (`api/logging/logger.ts`), token paths scrubbed, Semgrep `helpdock-secret-in-log` |
| 7.1.2 | No other sensitive data logged | Met | `operations.md` "What a line never carries" |
| 7.1.3 | Security-relevant events logged | Met | Every sign-in success and failure, lock, refused step-up, replayed code, reused refresh token and credential change is an `auth.*` row in install scope with address and user agent (`api/auth/auth-audit.ts`, ADR 0020); rate-limit refusals are counted in `rate_limit_refusals_total` |
| 7.1.4 | Enough detail for an investigation | Met | Request id, role, user id, brand id on every line |
| 7.2.1 | Authentication decisions logged | Met | As 7.1.3 |
| 7.2.2 | Access control decisions logged | Partial | Refusals logged at `debug` by the exception filter; not audited |
| 7.3.1 | Log injection prevented | Met | Structured JSON lines |
| 7.3.3 | Logs protected from tampering | Partial | Audit log is append-only to the runtime role (RLS, no update policy); process logs are the operator's |
| 7.3.4 | Time synchronised | Operator | Host NTP; timestamps in UTC ISO 8601 |
| 7.4.1 | Generic message with an id on unexpected errors | Met | `api/http/exception.filter.ts` answers `{ error: { code, message, requestId } }` (`api/http/error-response.ts`) |
| 7.4.2 | Exceptions handled across the codebase | Met | One global filter; socket ack filter (`api/realtime/ack-exception.filter.ts`) |
| 7.4.3 | Last-resort handler | Met | Same filter catches everything (`@Catch()`) |

## V8 Data protection

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 8.1.1 | Sensitive data not cached by intermediaries | Met | API responses `no-store`; only public help center pages are `public` (`docs/guides/help-center.md` "Caching") |
| 8.1.2 | Cached and temporary copies protected | Met | Redis page cache holds public pages only; staff pages never cached |
| 8.1.3 | Few parameters in requests | Met | Ids in paths, bodies in JSON |
| 8.1.4 | Abnormal request volumes detected and alerted | Met | `rate_limit_refusals_total{bucket}` on every limit, and an alert on it in the operations guide's first alert set |
| 8.2.1 | Anti-caching headers for sensitive data | Met | As 8.1.1 |
| 8.2.2 | No sensitive data in browser storage | Partial | The admin stores nothing; the widget keeps the visitor secret in `localStorage` by design (widget protocol "A visitor") |
| 8.2.3 | Client storage cleared at session end | Partial | Admin memory cleared on sign-out; the widget visitor secret persists until the visitor clears it |
| 8.3.1 | Sensitive data in bodies or headers, not the URL | Partial | Email links carry their token in the path (scrubbed from logs); everything else in bodies |
| 8.3.2 | Users can export or delete their data | Met | Erasure ("Anonymise contact") and export (`GET …/contacts/:contactId/export`: contact, tickets, conversation, attachment paths; Admin only, audited) |
| 8.3.3 | Users told what is collected | Partial | Operator's privacy notice; the help center footer links are configurable but nothing ships a notice |
| 8.3.4 | Sensitive data identified with a policy | Met | DOMAIN-RULES §11 |
| 8.3.5 | Access to sensitive data audited | Partial | Changes are audited (`audit_log`); reads are not |
| 8.3.6 | Sensitive data in memory overwritten | Partial | Not possible in a garbage-collected runtime beyond dropping references |
| 8.3.7 | Encryption with confidentiality and integrity | Met | AES-256-GCM |
| 8.3.8 | Retention classification | Met | Per-brand retention windows and the nightly purge (`docs/guides/data-retention.md`) |

## V9 Communications

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 9.1.1 | TLS for all client traffic, no fallback | Met | Caddy terminates TLS for the admin, api and help center hosts and redirects http (`docker/caddy/Caddyfile`); HSTS on owned hosts |
| 9.1.2 | Strong cipher suites | Met | Caddy's defaults (TLS 1.2 AEAD suites and TLS 1.3) |
| 9.1.3 | Only TLS 1.2 and 1.3 | Met | Caddy's default minimum is TLS 1.2 |
| 9.2.1 | Trusted certificates | Met | ACME certificates; on-demand only for verified domains |
| 9.2.2 | Encrypted connections for all inbound and outbound connections | Partial | Outbound SMTP, IMAP, OAuth and push use TLS; Postgres and Redis on the internal network do not |
| 9.2.3 | External connections authenticated | Met | Certificate verification left on in every client; `safeFetch` validates TLS |
| 9.2.4 | Revocation checking (OCSP stapling) | Met | Caddy staples OCSP by default |
| 9.2.5 | Backend TLS failures logged | Partial | SMTP and IMAP failures logged with their code (`docs/guides/email.md`); not every client distinguishes TLS errors |

## V10 Malicious code

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 10.2.1 | No unauthorised phone-home | Met | No telemetry; outbound calls are the operator's channels only |
| 10.2.2 | No unnecessary permissions | Met | Web push asks for notification permission only when a person turns it on |
| 10.3.1 | Updates over secure channels, signed | Met | Images from GHCR by tag over TLS; no auto-update |
| 10.3.2 | Integrity protection (SRI, signing) | Met | No third-party scripts or CDNs; fonts self-hosted; SBOM per release |
| 10.3.3 | Subdomain takeover protection | Met | Help center domains need a TXT verification before Caddy will issue (`api/domains`, M5-07) |

## V11 Business logic

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 11.1.1 | Flows processed in order | Met | Ticket transitions validated against DOMAIN-RULES §2; wizard steps need the setup token |
| 11.1.2 | Realistic human timing | Partial | Rate limits cap speed; there is no minimum-time check |
| 11.1.3 | Limits per business action | Met | Widget per-visitor write budget, sign-in budgets, transcript cap (`widget-protocol.md` "Throttles"), socket event budgets (`realtime.md` "Event budgets") |
| 11.1.4 | Anti-automation against excessive calls | Met | Same, plus CAPTCHA on the widget and web form (ADR 0003) |
| 11.1.5 | Business logic limits against likely risks | Met | Load caps on assignment, depth guard on rules (`automation.md`), attachment caps |
| 11.1.6 | No TOCTOU on sensitive operations | Met | Advisory locks (wizard step 1, assignment, outbox), unique constraints with `clientId` |
| 11.1.7 | Unusual activity monitored | Partial | Metrics and logs exist; no anomaly alerting |
| 11.1.8 | Alerts on automated attacks | Met | As 8.1.4 |

## V12 Files and resources

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 12.1.1 | Large files cannot exhaust storage | Met | Per-kind size caps in the brand's content policy, enforced at presign and confirm (`docs/guides/attachments.md`) |
| 12.1.2 | Compressed files checked | N/A | Archives are stored, never unpacked |
| 12.1.3 | Size quota per user | Partial | Per file and per message caps; no per-visitor total quota |
| 12.2.1 | Type checked by content | Met | Magic-byte sniffing (ADR 0009), images re-encoded with sharp |
| 12.3.1 | Filenames not used by the file system | Met | Objects keyed by generated ids; the name is metadata only |
| 12.3.2 | Filename metadata cannot cause LFI | Met | Same |
| 12.3.3 | Filename metadata cannot cause RFI/SSRF | Met | Same |
| 12.3.4 | Reflected file download | Met | `Content-Disposition` set by the presign; JSON never served as a download |
| 12.3.5 | Metadata not passed to system commands | Met | ffmpeg reads a temp path the worker chose |
| 12.3.6 | No code from untrusted sources | Met | No CDN or remote includes |
| 12.4.1 | Uploads stored outside the web root | Met | S3 bucket, private, presigned reads after authorisation on the parent ticket |
| 12.4.2 | Uploads scanned by antivirus | Partial | ClamAV is optional (`CLAMAV_HOST`); off by default |
| 12.5.1 | Only expected file types served | Met | The api serves fixed static roots; uploads come from S3 |
| 12.5.2 | Uploads never executed as HTML/JS | Met | Non-image kinds served as attachments; images re-encoded to WebP |
| 12.6.1 | Server-side request allow list | Met | `safeFetch` policies per caller (`packages/net/src/policy.ts`), `OUTBOUND_ALLOW_CIDRS` for exceptions |

## V13 API and web services

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 13.1.1 | Same encoders and parsers everywhere | Met | One Fastify JSON parser; Zod shared between api and clients (`packages/schemas`) |
| 13.1.3 | No secrets in URLs | Partial | Email-link tokens and the staff pass are in URLs, single-use and short-lived |
| 13.1.4 | Authorisation at controller and resource level | Met | `@Requires` plus RLS |
| 13.1.5 | Unexpected content types refused | Met | Fastify answers 415 for unsupported content types |
| 13.2.1 | Methods valid for the action | Met | Each route declares one method; Fastify answers 404/405 otherwise |
| 13.2.2 | JSON schema validation | Met | Zod |
| 13.2.3 | Cookie-authenticated REST protected from CSRF | Met | Only `/api/auth` reads the session cookie, `SameSite=Lax`; the help center's staff cookie is `SameSite=Lax` too (`api/help-center/site/site.controller.ts`) |
| 13.2.5 | Content-Type checked | Met | As 13.1.5 |
| 13.2.6 | Message integrity in transit | Met | TLS (V9) |
| 13.3.1 | SOAP schema validation | N/A | No SOAP |
| 13.3.2 | WS-Security signing | N/A | No SOAP |
| 13.4.1 | GraphQL query allow list or depth limiting | N/A | No GraphQL |
| 13.4.2 | GraphQL authorisation in the business layer | N/A | No GraphQL |

## V14 Configuration

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 14.1.1 | Secure, repeatable build and deploy | Met | `ci.yml`, `release.yml`, pinned actions, frozen lockfile |
| 14.1.2 | Compiler hardening flags | N/A | No native code of our own |
| 14.1.3 | Server configuration hardened | Met | `docker/caddy/Caddyfile` refuses `/internal/*`; api headers (`api/http/security-headers.ts`) |
| 14.1.4 | Redeployable from scripts | Met | Compose files, `docs/guides/install.md` |
| 14.1.5 | Integrity of security configuration verifiable | Partial | Env-pinned settings shown as locked in the admin; no checksum of the running configuration |
| 14.2.1 | Components up to date, checked in the build | Met | Renovate, `pnpm audit` in CI, CodeQL |
| 14.2.2 | Unneeded features removed | Met | Production image has no dev dependencies; the dev principal header refuses to start outside development (`api/auth/principal-resolver.ts`) |
| 14.2.3 | SRI for externally hosted assets | Met | None are external |
| 14.2.4 | Components from trusted repositories | Met | npm through the frozen lockfile; the base image from Docker Hub's official `node` image by tag (`docker/Dockerfile`) |
| 14.2.5 | Inventory of third-party libraries (SBOM) | Met | CycloneDX SBOM attached to every release (`release.yml`) |
| 14.2.6 | Third-party libraries sandboxed | Partial | sharp and ffmpeg run in the worker, not the api; not further isolated |
| 14.3.2 | Debug modes off in production | Met | `NODE_ENV=production` in the image; pretty logging and the dev principal header refuse production |
| 14.3.3 | No version details in headers | Met | No `X-Powered-By`; the version is on the System page only, for admins |
| 14.4.1 | `Content-Type` with charset on every response | Met | Fastify sets it for JSON and HTML |
| 14.4.2 | `Content-Disposition` on API responses | Met | `attachment; filename="api.json"` on every JSON answer unless a route chose its own (`api/http/json-disposition.ts`) |
| 14.4.3 | Content Security Policy | Met | `default-src 'none'` on the api; hashed scripts on the admin; nonces on the help center and web form |
| 14.4.4 | `X-Content-Type-Options: nosniff` | Met | helmet |
| 14.4.5 | HSTS | Met | On https installs, api and Caddy |
| 14.4.6 | Referrer-Policy | Met | `no-referrer` |
| 14.4.7 | Not embeddable by default | Met | `frame-ancestors 'none'` |
| 14.5.1 | Only used methods accepted | Met | Fastify routes per method |
| 14.5.2 | Origin not used for authentication | Met | Origin only narrows the widget (an allow list on top of the visitor credential) and the staff socket |
| 14.5.3 | CORS with a strict allow list | Partial | Widget routes echo the origin on preflight and refuse a disallowed one at the gate, without credentials; staff API has no CORS |
| 14.5.4 | Proxy-added headers authenticated | Met | `X-Forwarded-*` believed only with `TRUST_PROXY=true`; Caddy overwrites `X-Request-Id` |

## How to keep this current

Walk the chapters a milestone touches when it ships: M6 (V5 inbound
validation, V12 media from Telegram), M7 (V5 prompt inputs, V8 data sent to a
provider, V6 provider keys) and M8 (V2.10 and V3.5 API keys, V13 public API
and webhooks, V12.6 webhook destinations). Update the summary counts with the
rows.
