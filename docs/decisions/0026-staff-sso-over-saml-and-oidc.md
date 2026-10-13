# 0026 Staff single sign-on over SAML 2.0 and OpenID Connect, with JIT provisioning and group-to-role sync

Status: proposed
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
   sign-in, a Redis `CacheProvider` with `consumeAsync`, several IdP certificates
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
  the 12-hour session ceiling bounds the exposure. Single logout is not offered.
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
