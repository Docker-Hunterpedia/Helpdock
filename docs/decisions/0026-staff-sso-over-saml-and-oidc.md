# 0026 Staff single sign-on over SAML 2.0 and OpenID Connect, with JIT provisioning and group-to-role sync

Status: accepted
Date: 2026-10-13

## Context

Teams moving from Zendesk, Freshdesk or Zoho Desk sign in through an identity
provider (Okta, Entra ID, Google Workspace, Keycloak). Helpdock has password,
magic link, TOTP and Google/GitHub OAuth (M0-05), hand-wired with `jose` rather
than passport, mapping an OAuth identity to an existing user by verified email
and never creating one. The owner moved SAML/OIDC SSO from the v1.1 backlog into
1.0 as M11 (PRD change log, 2026-10-13), without SCIM.

Constraints: no tenant data is reachable from the sign-in path; every
user-supplied URL is fetched through `safeFetch` (DOMAIN-RULES §13); secrets are
encrypted under `APP_MASTER_KEY`; one install serves many brands while staff
accounts (`users`) are install-wide.

## Decision

1. **SSO is install-wide.** Connections live in install-scope tables
   (`sso_connections`, `sso_role_mappings`, `user_sso_identities`), managed with
   `install:admin`, like the OAuth settings and like `users` itself. A mapping
   names the brand it grants access to.
2. **Both protocols, one model.** A connection is `oidc` or `saml`; both produce
   one `SsoAssertion { connectionId, subject, email, emailVerified, name, groups }`
   that a single `AuthService.completeSso` consumes. Everything after the protocol
   is shared.
3. **Request state in Redis.** OIDC `state`/PKCE/`nonce` and SAML `InResponseTo`
   are single-use records (`GETDEL`), TTL 10 minutes, bound to the browser by a
   nonce cookie `hd_sso` as `hd_oauth` is.
4. **One SP key per install**, RSA-2048, generated on first use under a Redis
   lock, stored as the secret setting `sso.spPrivateKey`, with a self-signed
   certificate in `sso.spCertificate`.
5. **OIDC through `openid-client` 6.x** (panva; 6.8.8 at the time of writing):
   discovery, authorization code with PKCE S256, `state` and `nonce`, ID token
   validation. Every HTTP call goes through `safeFetch` via openid-client's
   `customFetch`, so an admin-entered issuer cannot reach a private address.
6. **SAML through `@node-saml/node-saml` 5.x** (5.1.0): signed assertions
   required, signed AuthnRequests (SHA-256), audience and recipient checked,
   `validateInResponseTo: 'always'` unless the connection allows IdP-initiated
   sign-in, the published Redis `CacheProvider` interface plus an application-level
   atomic replay claim, several IdP certificates
   for rotation. `@peculiar/x509` 2.x issues the SP's self-signed certificate,
   which `node:crypto` cannot.
7. **Linking**: by `(connection, subject)`; the first time, by email only when the
   email is verified (OIDC `email_verified`, SAML: domain listed on the
   connection) and its domain is in the connection's `email_domains`.
8. **JIT provisioning** creates an active user with no password and memberships
   from the mappings; a person who matches no mapping and no default is refused,
   not created.
9. **Group sync at every sign-in** adds, changes and removes only memberships with
   `source = 'sso'`; memberships an admin made by hand (`manual`) are never
   touched. A removed role revokes the user's sessions, as a role edit does.
10. **Enforcement** refuses password, magic link and OAuth for everyone except up
    to three break-glass install admins who must have TOTP. `idp_enforces_mfa`
    per connection lets the IdP's MFA satisfy `auth.require2fa` and the admin rule.

## Consequences

- Three new runtime dependencies (`openid-client`, `@node-saml/node-saml`,
  `@peculiar/x509`) and their transitive `xml-crypto` and `@xmldom/xmldom`, the
  usual source of SAML vulnerabilities: they are pinned, covered by the
  dependency audit in CI, and the SAML test suite includes the signature-wrapping
  and replay cases.
- ARCHITECTURE §1's Auth row changes to `argon2 + jose + otplib + openid-client +
  @node-saml/node-saml`, and drops "passport", which was never installed.
- Deactivation in the IdP takes effect at the next sign-in, not at once (no SCIM);
  the configured absolute session lifetime bounds the exposure (12 hours by
  default, configurable up to 30 days before M11 enforcement integration). Single logout is not offered.
- `user_brand_roles` gains a `source` column, and the Staff screen shows SSO-managed
  memberships as read-only.

## Alternatives considered

- **Passport strategies** (`passport-saml`, `openid-client/passport`): the auth
  stack is deliberately hand-wired (M0-05) and passport would be the only
  middleware-shaped piece.
- **`samlify`**: capable, but `@node-saml/node-saml` is the more widely deployed SP
  implementation, has a narrower API for an SP-only use, and documents its
  security options (InResponseTo, signature requirements) explicitly.
- **A hosted broker (Auth0, WorkOS, Keycloak in front)**: contradicts a
  self-hosted product with no required third party.
- **Per-brand SSO**: staff accounts are install-wide and a person often works in
  several brands; per-brand IdPs can still be modelled as several connections with
  mappings to one brand each.
- **SCIM now**: a second protocol and test matrix; it stays in the backlog.

## Amendments

### 2026-10-13 — M11-01 foundation

- SSO memberships also carry `sso_connection_id`. A check constraint makes it
  non-null exactly when `source = 'sso'`. M11-04 must synchronize only grants
  owned by its connection, preserve manual grants, and refuse a conflicting
  connection taking over the same user/brand membership. Separate connections
  can own different brands; there is still one effective role per user/brand.
- A linked connection cannot change its identity authority: OIDC issuer/client
  id, or SAML entity id/NameID format. Claim names, certificates and endpoints
  can change without reassigning subjects. Deleting a linked connection is
  refused; explicit unlinking and session revocation belong to M11-04.
- Control settings and SP keys are read directly from the scoped database
  transaction, with environment overrides still honored. This avoids stale
  enforcement decisions across replicas and does not require a cache
  invalidation outbox event. The existing outbox belongs to real brands and
  cannot accept the install sentinel. No customer side effect is introduced.
- Both control settings are written together with their audit row, serialized
  against connection deletion/disabling by a PostgreSQL transaction advisory
  lock. Enforcement requires at least one enabled connection and one active
  install admin with a password and enabled TOTP backed by a stored secret.
- SP key and certificate generation uses asynchronous WebCrypto RSA-2048 and
  `@peculiar/x509` 2.1.0 (verified against npm on 2026-10-13). The Redis lease
  has ownership-safe release; a PostgreSQL transaction lock remains the
  authority if that lease expires. The key/certificate pair and audit record
  commit atomically. Existing keys must match and be RSA with at least 2048 bits.
- The public configuration contains a protocol discriminator and requires
  verified OIDC email. Only OIDC accepts a client secret. HTTP identity endpoints
  are allowed only when DNS resolves into explicitly configured outbound CIDRs;
  HTTPS endpoints still pass the shared outbound destination checks.
- The protocol start/callback and connection-test routes are implemented in
  M11-02/M11-03, not as inert routes in the configuration foundation. The
  enforcement configuration does not alter sign-in until M11-04 integrates it.

The SAML `consumeAsync` statement in decision 6 describes the intended atomic
replay guarantee, not a published 5.1.0 library method. M11-03 must implement
an atomic post-validation replay claim using the supported library interface,
validate signed assertion issuer/recipient, and bind a cross-site POST without
relying on a Lax cookie. The configured session lifetime, rather than an
unconditional 12-hour ceiling, is the pre-M11 exposure; M11-04 must document or
bound that lifetime when integrating enforcement.

### 2026-10-13 — M11-02 protocol validation

- `openid-client` 6.8.8 uses TLS as the default trust mechanism for ID tokens
  obtained directly from the token endpoint. Helpdock explicitly enables
  `enableNonRepudiationChecks` to verify JWS signatures through safe JWKS fetches.
- All OIDC server requests refuse redirects. Forwarding a 307/308 token POST
  could expose a client secret in its body even when cross-origin auth headers
  are stripped; discovery redirects are refused as well for a consistent policy.
- HTTP endpoints require explicit outbound CIDR exceptions on every request.
  Library-level insecure-request support exists only behind this transport.
  The socket-pinning DNS resolver checks every HTTP address against these CIDRs,
  including a changed or mixed private/public answer; a separate preflight
  check alone would leave a DNS-rebinding window.
- Configured group overage or a missing/malformed authoritative group list fails
  sign-in. It is never represented as an empty list that could revoke grants.
- Browser cookies are named per connection; the request binds the
  current configuration revision so disabling or changing a provider during
  a flow cannot complete against stale cached settings.
- M11-02 completes existing subject bindings through local MFA and the existing
  exchange flow. M11-04 owns JIT, email linking, group sync, and IdP MFA policy;
  protocol acceptance alone never creates or grants an account.

HTTPS OIDC nonce cookies use the `__Host-` prefix with Path=/ and no Domain.
This deliberately prefers host binding over a narrow path, because a sibling
domain must not plant a matching login nonce. Local HTTP retains an unprefixed,
connection-scoped cookie. See the [browser prefix requirements](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#cookie_prefixes).
Provider requests advertise `Accept-Encoding: identity` because safeFetch
returns bounded raw bytes rather than automatically decompressing responses.

### 2026-10-13 — M11-03 SAML protocol and metadata

- The published node-saml 5.1.0 cache has get/remove, not atomic consume. An
  application Lua claim reserves assertion/request IDs together after signature
  validation; pending handoff and browser request state use GETDEL. Replay
  claims last twelve minutes, exceeding the ten-minute assertion age plus skew.
- Issuer, recipient, mandatory validity windows, NameID format and signed
  request correlation are checked from authenticated assertion XML. Duplicate
  attributes and unavailable configured groups fail closed. No unsigned
  envelope field establishes identity.
- Cross-site POSTs use a local GET completion bridge, preserving the Lax cookie
  policy instead of requiring SameSite=None. ACS issues no session. Optional
  IdP initiation requires a fresh SP round trip naming the same subject; an
  unsolicited assertion cannot silently sign a browser into an attacker's
  account. This adds a protocol round trip without a new screen.
- Strong signatures use RSA SHA-256/512 and encrypted assertions use AES-GCM
  with RSA-OAEP. Legacy SHA-1 signatures, CBC and RSA1.5 are refused before
  library processing. Explicit xml-encryption 3.1.0 owns decryption with the
  approved library family; boundary xmldom 0.9.12 avoids global DOM types while
  node-saml's own parser remains lockfile-pinned 0.8.15.
- Public SP metadata adds every enabled connection's indexed ACS to the
  library-generated install entity. It advertises only supported GCM encryption
  and no single logout. IdP metadata fetches refuse redirects and use the same
  socket-pinned outbound transport as OIDC. Saving or daily refreshing validates
  entity/SSO endpoint and signing certificates. Refreshes cannot replace all
  trusted certificates without explicit admin confirmation, or overwrite a
  concurrent configuration change. The install-global maintenance schedule
  runs at 04:45 UTC and is registered again on worker boot; it creates no
  customer side effect or tenant-scoped outbox event.

### 2026-10-13 — M11-04–06 sign-in policy and administration

- Email linking and JIT run under configuration/email locks; stable subject links
  remain authoritative. Role sync preserves manual/foreign ownership and refuses
  conflicting provider grants. An explicit staff API role edit takes manual ownership.
- Session minting takes a per-user shared PostgreSQL advisory lock; authority
  changes hold its exclusive counterpart through commit and Redis revocation.
  Atomic Redis registration refuses minting against a revoked family. SSO has a
  twelve-hour family ceiling regardless of longer local-session configuration.
- Break-glass means password followed by fresh TOTP. Magic links, OAuth, trusted
  browsers and recovery codes cannot replace that second factor under enforcement.
  IdP MFA remains an administrator-vouched policy, rather than inference from `amr`.
- Invitation activation/audit and pending-token cleanup happen after required
  factors. Pending local challenges recheck enforcement and linked connection status.
- Protected install-admin test routes mint an actor-owned ten-minute preview.
  The existing protocol round trip returns to the connection page; the callback
  writes no identity, role or session and results are actor-bound and single-use.
  The public `test=1` toggle stays refused.
- The settings form saves connection and mappings in one transaction through
  additional configuration routes, avoiding partial saves or duplicate retry creates.

### 2026-10-18 — Linking, domain and metadata hardening (#219)

Review of the merged SSO work found that the email fallback in decision 7 could
hand an already-linked account to another identity. The rules are now:

- **Email linking is a first link only.** An unseen `(connection, subject)` links
  by email only when the matched account has no `user_sso_identities` row at
  all. A second subject on the same connection (a recycled or edited address)
  or a subject on another connection is refused with the new auth code
  `sso-identity-conflict`; nothing is linked or changed. Migration `0053_sso`
  (not yet in a release) also declares `UNIQUE (user_id, connection_id)`, and
  the identity insert tolerates only a repeat of its own `(connection_id, subject)`.
- **One enabled connection per email domain.** Create, update and enable refuse
  a domain another enabled connection lists, under the configuration lock, with
  the refusal `sso-email-domain-taken` and the overlapping domains in
  `error.sso`, which the connection form shows on its domains field.
- **`email_verified` vouches only for `email`.** `SsoAssertion.emailVerified` is
  now a boolean: for OIDC it is true only when the configured email claim is
  `email` and `email_verified === true`; SAML keeps its domain rule. Email
  linking and JIT require it. Existing subject links sign in either way, so an
  unverified address or an administrator-chosen claim (such as `upn`) no longer
  blocks people already linked, but can never introduce an account.
- **A metadata refresh never adds trust.** The daily refresh applies a fetched
  set only when every certificate in it is already trusted, so removals stay
  automatic. Any added certificate, beside the current ones or replacing them,
  is refused with `sso.metadata.rotation-refused` / `admin-confirmation-required`.
  A save confirms only the certificates the administrator submitted: one that
  omits a certificate the metadata lists is refused with
  `sso-metadata-confirm-certificates`.

### 2026-10-20 — M18-09 Entra ID email verification

- **Entra's `xms_edov` can stand in for `email_verified`, for members of one
  tenant only.** Entra ID never sends `email_verified`, so under the rule above
  an Entra OIDC connection could link or create nobody. For OIDC,
  `SsoAssertion.emailVerified` is now also true when every one of these holds:
  the configured email claim is `email`; the connection's issuer is exactly
  `https://login.microsoftonline.com/<tenant GUID>/v2.0` (global cloud only;
  government and China cloud issuers fail closed), which leaves out `common`,
  `organizations`, `consumers` and the personal-account tenant
  `9188040d-6c67-4c5b-b112-36a304b66dad`; the ID token's `iss` is that issuer
  and its `tid` is that GUID; `acct` is `0`, a member of the tenant; and
  `xms_edov` is the boolean `true`. Nothing else counts: a string, a missing
  claim, a guest (`acct` 1) or any other issuer leaves the address unverified.
  `xms_edov` says the domain is verified by the tenant that holds the account.
  For a guest that is the guest's home tenant or a personal Microsoft, Google
  or one-time-passcode account, so guests are excluded and the pinned tenant
  vouches. One residue stays with the operator: a B2B user turned member (for
  example by cross-tenant synchronisation) has `acct` 0 while its `xms_edov`
  speaks for its home tenant, so the connection's email domains must list only
  domains verified in the pinned tenant, as the guide says. Guests cannot make a first link through an Entra OIDC
  connection; Helpdock has no manual SSO link. Recorded in DOMAIN-RULES §12.
  The Entra preset tells admins to add the `email`, `xms_edov` and `acct`
  optional claims. An existing Entra OIDC connection whose tokens already carry
  them starts linking by email, and creating accounts when JIT is on, at the
  next sign-in after the upgrade.
- **The OIDC issuer refuses `{` and `}`.** The Entra preset's `{tenant-id}`
  template parses as a URL, so the connection schema refuses braces in the
  issuer as well as the form.
