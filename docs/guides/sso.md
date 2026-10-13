# Staff single sign-on configuration

M11-01 adds the install-wide configuration foundation. Protocol sign-in is
M11-02/M11-03 and authentication integration is M11-04: the configuration alone
does not enable SSO sign-in or enforce SSO against existing password, magic-link,
or Google/GitHub sign-in. Those authentication paths are unchanged in M11-01.

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
60 seconds. Certificate syntax is checked before configuration is stored.

Every endpoint host passes the shared outbound destination policy. HTTPS is
required unless the resolved address is inside `OUTBOUND_ALLOW_CIDRS`, for
example an explicitly allowed local identity provider. Userinfo and URL
fragments are refused. Future protocol fetches must apply the same policy
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
