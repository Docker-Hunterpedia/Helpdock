# Staff single sign-on configuration

M11-01 adds install-wide configuration; M11-02 adds OIDC for already-linked
accounts; M11-03 adds SAML for the same existing bindings. Provisioning, role sync and enforcement are M11-04;
the existing password, magic-link and Google/GitHub paths remain available.

## Access and connections

The endpoints below require an authenticated install administrator. Brand
administrators, including a person administering every brand, cannot manage
the installation's identity providers without install-admin status.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/install/sso/connections` | List connections |
| POST | `/api/install/sso/connections` | Create a connection |
| GET | `/api/install/sso/connections/:id` | Read configuration and public SP URLs |
| PUT | `/api/install/sso/connections/:id` | Replace configuration; omit the secret to retain it |
| DELETE | `/api/install/sso/connections/:id` | Remove an unused connection |
| GET | `/api/install/sso/connections/:id/mappings` | Read ordered group mappings |
| PUT | `/api/install/sso/connections/:id/mappings` | Replace the complete mapping list |
| GET | `/api/install/sso/settings` | Read enforcement configuration and environment-lock flags |
| PUT | `/api/install/sso/settings` | Update both control settings atomically |

An OIDC connection body contains `name`, optional `enabled`, `emailDomains`,
`jitEnabled`, `idpEnforcesMfa`, `defaultAccess`, `groupAttribute`, and `config`:

```json
{
  "name": "Work identity provider",
  "emailDomains": ["example.com"],
  "config": {
    "protocol": "oidc",
    "issuer": "https://identity.example.com",
    "clientId": "helpdock",
    "scopes": ["openid", "email", "profile"],
    "requireEmailVerified": true
  }
}
```

Connections default to disabled. `clientSecret` is write-only for OIDC and
encrypted under `APP_MASTER_KEY`. Responses return `secretConfigured`; they
never contain the secret or its encryption envelope. Protocol is immutable.
Once an identity is linked, changing the OIDC issuer/client id or SAML entity
id/NameID format returns 409 `sso-identity-configuration-in-use`. Claim settings
and certificate rotation do not change that identity namespace.

SAML configuration contains `protocol: "saml"`, `idpEntityId`, `idpSsoUrl`,
and one to three PEM `idpCertificates`. Optional fields include
`idpMetadataUrl`, `emailAttribute` and `nameAttribute`. AuthnRequests must be
signed; IdP-initiated sign-in defaults to disabled; clock skew is bounded to
60 seconds. Certificates must contain RSA keys of at least 2048 bits before configuration is stored.

Every endpoint host passes the shared outbound destination policy. HTTPS is
required unless the resolved address is inside `OUTBOUND_ALLOW_CIDRS`, for
example an explicitly allowed local identity provider. Userinfo and URL
fragments are refused. Protocol fetches apply the same policy
again when connecting; saving a URL is not protection against DNS rebinding.

## Mappings and enforcement configuration

A mapping contains `idpGroup`, `brandId`, `role`, `departmentIds` and `position`.
Roles use `admin`, `team_leader`, `agent` or `viewer`. Agents require an explicit
department list; every named department must belong to the active target brand.
`position` orders mappings; M11-04 applies the first matching mapping per brand.
Duplicate group/brand mappings and duplicate positions within a brand are refused. Failed replacements preserve the
previous mappings.

Control settings use `{ "enforced": false, "breakGlassUserIds": [] }`.
Enforcement configuration requires at least one enabled connection and one
active install admin with a password, enabled TOTP and a stored TOTP secret.
Disabling or deleting the last enabled connection while enforced returns 409
`sso-enforced-last`, including under concurrent requests. Removing a connection
with linked identities returns 409 `sso-connection-in-use`.

`HD_SSO_ENFORCED` and `HD_SSO_BREAK_GLASS_USER_IDS` override and lock these
settings. A locked setting can be submitted unchanged; changing it returns
409 `sso-settings-locked`. Control reads bypass process caches and writes commit
with their audit record in one transaction, so replicas read the same committed
state.

## Signing material and request state

The SP RSA key and its self-signed ten-year certificate are generated on first
server-side use, stored together, and shared by all replicas. The private key is
encrypted. Concurrent initialization is serialized by PostgreSQL; the Redis
lease is released only by its owner. The stored certificate must match an RSA
private key with at least 2048 bits. Environment pins `HD_SSO_SP_PRIVATE_KEY`
and `HD_SSO_SP_CERTIFICATE` must be supplied together as a matching pair.

Protocol request records have separate OIDC/SAML/test namespaces, hashed Redis
keys and a ten-minute TTL. Consumption is atomic across replicas and records
are validated against the calling protocol's schema. No token or signing
secret appears in a configuration response or audit record.

The administrative contracts are defined in `packages/schemas/src/sso.ts` and
wrapped in Nest Zod DTOs in `apps/api/src/sso/dto.ts`. The brand-scoped public
REST API's OpenAPI document does not describe these install-admin endpoints.

Master-key rotation re-encrypts saved connection secrets and the encrypted SP
private-key setting. The signing key itself remains the same, so rotating the
installation master key does not require replacing IdP metadata.

## OIDC protocol (M11-02)

Register an authorization-code client with PKCE S256, `client_secret_post`,
scopes `openid email profile`, and the exact Redirect URI returned by the
connection details API. Discovery must expose a JWKS URI. The ID token must
contain `sub`, a valid configured email claim, and boolean `email_verified:true`.
If a group attribute is configured, its authoritative value must be a string
or an array of strings; unresolved distributed/overage claims refuse sign-in.

All provider requests use the outbound-safe client and refuse redirects. Use
HTTPS; a deliberately internal HTTP IdP must be included in
`OUTBOUND_ALLOW_CIDRS`. The normal outbound port allowlist still applies
(80, 443, 8080, 8443). Changing configuration during a round trip invalidates
that attempt. Discovery is cached for one hour per configuration revision.

`GET /api/auth/sso/:id/start` starts the browser round trip. The callback URI
remains `/api/auth/sso/:id/oidc/callback`. The browser must retain its HttpOnly
nonce cookie. Failed callbacks return to the existing sign-in completion page
with its translated generic error; valid callbacks preserve local TOTP and use
a one-time session exchange code. No ID/access token appears in a redirect URL.

At this milestone step only an existing `(connection, subject)` binding can
sign in. There is no account auto-linking/provisioning or group-role sync yet;
M11-04 adds these, and M11-05 adds the login/configuration screens. Do not
manually edit production identity bindings to bypass that rollout. `test=1`
is rejected until the protected M11-06 test flow exists.

The fake-IdP suites need no provider credentials. For a real local Keycloak
Docker/Chromium smoke test, follow the commands in
[M11-02](../in-development/M11-sso-and-migration.md#m11-02-oidc-sign-in).

## SAML protocol (M11-03)

Copy the entity ID, metadata URL and ACS URL from the connection details API
into the IdP's SAML service-provider configuration. Enable the connection to
publish its ACS in the install metadata. Import the signing certificate and
require signed AuthnRequests. Send signed assertions with RSA SHA-256/512,
Audience equal to the entity ID, Recipient/Destination equal to the ACS, and
bearer confirmation with matching InResponseTo. Supply assertion and subject
expiry, assertion NotBefore/IssueInstant, and the configured NameID format
(`persistent` by default). Encrypted assertions are optional and must use
AES-GCM with RSA-OAEP; CBC, RSA1.5 and SHA-1 signatures are refused.

Set `emailAttribute` when NameID is a stable opaque identifier. The asserted
email must belong to `emailDomains`; SAML cannot establish verified email for
an unlisted domain. Set `nameAttribute` and `groupAttribute` to the IdP's exact
attribute names. A configured but absent group attribute refuses sign-in.

The callback is a URL-encoded POST with `SAMLResponse` and opaque `RelayState`,
limited to 256 KiB. Its 303 redirect completes through a local GET so the Lax
HttpOnly nonce cookie works across sites. Cookies and unconsumed request state
must survive the round trip; assertions older than ten minutes, replayed
responses, changed/disabled connections and wrong browsers are refused.
Failures use the existing translated sign-in completion error. Local TOTP
still applies to existing subject bindings.

`allowIdpInitiated` defaults to false. When enabled, an unsolicited assertion
starts a fresh SP round trip and must return the same subject. IdP dashboards
must support that Redirect request; no session is issued from the unsolicited
POST alone. Helpdock does not offer single logout.

For certificate rotation, save up to three signing certificates. If
`idpMetadataUrl` is configured, save fetches and validates its entity ID, Redirect
SSO URL and signing certificates. The worker refreshes enabled connections at
04:45 UTC. A fetched set must overlap a current certificate; otherwise the
current set remains and the audit log records
`sso.metadata.rotation-refused` / `admin-confirmation-required`. After verifying
the new keys with your IdP, explicitly save them to confirm a complete
replacement. Metadata errors produce `sso.metadata.refused` without raw
provider errors. Unchanged sets do not rewrite the connection.
