# Staff single sign-on

Install admins configure identity providers under **Settings → Single sign-on**.
SSO is for staff; widget and help-center customer authentication stays separate.
OIDC uses authorization code, PKCE S256, a confidential client secret, and signed
ID tokens. SAML requires signed assertions and stable NameIDs. Both protocols
use browser-bound requests; open Helpdock's sign-in button to begin.

## Configure a connection

Set `APP_URL` to the canonical HTTPS origin before copying callback URLs. Add a
connection, choose its protocol and button label, and save the provider fields.
The protocol cannot change afterwards. Once identities are linked, issuer/client
ID (OIDC) or entity ID/NameID format (SAML) cannot change; create a different
connection when changing identity authority.

The OIDC client secret is write-only. A save that leaves it out keeps the stored
one only while the issuer is unchanged (scheme, host, port and path, ignoring
case and a trailing slash). Change the issuer and the secret must be typed again:
the save is refused with 400 `sso-client-secret-required` (field
`body.clientSecret`) and nothing is stored, so a changed issuer cannot receive
the old secret.

| Value | Where to copy it |
|---|---|
| OIDC redirect URI | The saved connection's service provider details |
| SAML reply URL / ACS | The saved connection's service provider details |
| SAML entity ID and metadata URL | Service provider details; shared across the install |
| SAML signing/encryption certificates | The public SP metadata XML |

A new OpenID Connect connection has a **Start from** select: Custom OpenID
Connect, Google Workspace (OIDC) or Microsoft Entra ID (OIDC). A preset fills
the issuer (or its template), the email, name and groups claims, and hints for
the email domains, and links to its section below. Change any field afterwards;
the preset stays chosen and does not overwrite the edit. Picking another preset
replaces only those preset fields, never the label, client ID, secret, scopes,
domains or access rules. The preset is a form shortcut only: nothing about it is
saved, and the connection behaves as any OIDC connection. There are no SAML
presets, and GitHub is not an OIDC provider, so it stays a sign-in button.

The first save gives a new connection its callback URL. Enable it after the IdP
has registered that exact URL. A SAML metadata URL is optional: supply entity ID,
SSO URL and trusted PEM certificates explicitly. A metadata refresh may drop a
certificate the provider no longer lists, but never adds one: a new signing
certificate is trusted only after an administrator saves it (see
[SAML protocol](#saml-protocol-m11-03)).

Add exact email domains, without wildcards. New links require an email in an
allowed domain. Each domain belongs to at most one enabled connection: saving,
creating or enabling a connection that lists a domain another enabled connection
already lists is refused, and the form names the domain. Disable the old
connection first when moving a domain to a new provider. OIDC additionally
requires signed `email_verified: true` on the standard `email` claim, or, for a
single Entra ID tenant, a signed `xms_edov: true` from a member of that tenant (see
[Microsoft Entra ID (OIDC preset)](#microsoft-entra-id-oidc-preset)); SAML
trusts the configured IdP's signed email attribute. Only use domains the IdP
administrator controls, with verified or centrally managed email attributes.
A provider that lets people choose an unverified coworker's email is unsafe for
email-based linking, even if its tokens are signed.

Existing `(connection, subject)` links remain authoritative when an email changes.
Otherwise a matching email links an existing active or invited account only if
that account has no SSO identity yet, on this connection or any other. An account
already linked to a subject is never handed to a different subject by email: a
second subject on the same connection (for example a recycled address) or a
subject on another connection is refused with `sso-identity-conflict`, and the
database allows one identity per account and connection. Helpdock never moves an
existing link to a new subject by email. With
**Create accounts on first sign-in**, an unknown email gets a passwordless active
account only if mappings/default access grant an active brand. SSO never grants
install-admin access. Completing the required factors accepts invitations,
records acceptance and invalidates their pending links.

## Roles, MFA and enforcement

Group values match exactly. The first matching mapping **for each brand** wins;
reorder rows to set precedence. A default applies to its brand only when no row
matches that brand. Agents need an explicit department list. A mapping naming a
removed department refuses sign-in rather than widening access. Disabled Viewer
access never provisions a new account whose only role would be Viewer.

Each successful assertion adds/updates/removes only roles owned by that SSO
connection. Manual grants survive. A matching role owned by another connection
refuses sign-in. Role removal or replacement revokes existing sessions before the
change commits. Staff shows an SSO badge for linked identities and names the
provider managing a membership. An explicit administrative role edit through the
staff API converts the grant to manual ownership.

**The provider enforces multi-factor sign-in** is an administrator's policy
assertion: enable it only if every assigned staff sign-in requires IdP MFA.
Helpdock then skips local TOTP. Otherwise enrolled TOTP and mandatory enrolment
apply as for local authentication. Pending SSO challenges stop working if their
connection is disabled. SSO refresh families expire within 12 hours even if
`AUTH_SESSION_MAX_HOURS` is longer; access tokens cannot outlive that ceiling.

Enforcement requires an enabled connection and one to three active install
admins with a password and an authenticator app **or** a passkey for emergency
access. Existing sessions remain open. At the
next sign-in, password, magic links, Google/Microsoft/GitHub OAuth, passwordless
passkey sign-in and password invitation
acceptance are blocked. The explicit break-glass form permits only configured
admins using **a password, then a fresh authenticator code or a fresh passkey
assertion with user verification** (a PIN or a biometric on the key); recovery
codes, trusted browsers and passwordless passkey sign-in cannot bypass this
requirement ([ADR 0053](../decisions/0053-break-glass-with-a-passkey.md)). A
security key with no PIN or biometric set cannot give user verification and is
refused for break-glass. A break-glass admin who holds only a passkey is locked out if the install's
address (`APP_URL`) changes and pauses passkeys, so keep an authenticator app on
the account too, or set `HD_SSO_ENFORCED=false` in the environment to turn enforcement off
(unsetting the variable does nothing when enforcement was switched on in Settings).
Settings › Authentication › Passkeys refuses "Move passkeys" while enforcement is on
and a break-glass admin relies on a passkey, since the move removes every passkey:
add an authenticator app to that account first.
Someone who signed in through SSO may finish with an authenticator code, a
passkey or a single-use recovery code as the second factor, but never a trusted
browser. A recovery code still never finishes break-glass, which stays a fresh
authenticator code or a user-verified passkey: it is the way back in for a
person whose IdP does not vouch for MFA and who lost the phone their
authenticator was on (#387).
A passkey counts for break-glass only if it registered with user verification
(a PIN or a biometric); Helpdock records this when the key is added, and keys
added before this release count as unverified, so an admin who relied on one
must re-register it with a PIN or biometric, or keep an authenticator app. The
Settings picker says so beside an admin whose only keys are unverified.
The Settings picker lists an install admin as ineligible until they have a
password and an app or a passkey. Discovery matches domains, never account existence.
Settings pinned by `HD_SSO_ENFORCED` or `HD_SSO_BREAK_GLASS_USER_IDS` are read-only.
See the generated [configuration reference](configuration.md).

## Test before enforcing

Save and enable the connection, then choose **Test connection**. Allow the popup.
An install-admin route creates a short-lived test owned by that administrator.
The IdP callback previews claims, matched/new account and roles without creating
accounts, linking identities, changing roles or opening a staff session. The
result is single-use and expires after ten minutes. An unsaved draft cannot be
tested; save it first. Direct public `test=1` requests are refused.

Then perform a normal sign-in with a test person. Confirm mappings and local/IdP
MFA before enabling enforcement. Keep the emergency admin's password and
accessible authenticator available, and verify its fresh-TOTP sign-in separately.

## Google Workspace (OIDC preset)

Official documentation checked **2026-10-20**:
[OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect).

The preset sets the issuer to `https://accounts.google.com`, the email claim to
`email`, the name claim to `name` and leaves the groups claim empty.

1. In the Google Cloud console, use a project that belongs to your Workspace
   organisation. Under **Google Auth Platform → Audience**, set the user type to
   **Internal**. This is a security requirement, not only a convenience (see
   below); it also spares the app Google's verification.
2. Under **Clients**, create an OAuth client of type **Web application**. Add
   the connection's redirect URI (shown after the first save) as an authorised
   redirect URI, exactly.
3. In Helpdock, choose **Start from → Google Workspace (OIDC)**, then paste the
   client ID and client secret. Keep the scopes `openid email profile`.
4. Under **Email domains**, enter your Workspace domain, for example
   `example.com`. Only addresses in these domains can link.
5. Save, enable, and run **Test connection**.

Google signs `email_verified` for the `email` claim, so first sign-in links by
email as described above. Google puts no groups in the ID token: leave the
groups claim empty and give access with **Grant default access**, or invite
people and set their roles on Staff. Use Entra ID or a SAML app when roles must
follow groups.

**Why Internal is required.** Helpdock checks no `hd` claim for SSO and sends no
`hd` parameter. Under the External user type any Google account can sign in,
including a personal Google account that uses an address in your Workspace
domain (for example one created on that address before the domain joined
Workspace). Google signs `email_verified` for it, so it could make the first
link to, or be created as, that address. Internal limits sign-in to accounts
your organisation manages.

## Microsoft Entra ID (OIDC preset)

Official documentation checked **2026-10-20**:
[optional claims](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference),
[group claims and limits](https://learn.microsoft.com/en-us/entra/identity/hybrid/connect/how-to-connect-fed-group-claims).

The preset sets the issuer to
`https://login.microsoftonline.com/{tenant-id}/v2.0`, the email claim to
`email`, the name claim to `name` and the groups claim to `groups`. The form
refuses to save while the issuer still contains `{tenant-id}`.

1. In the Microsoft Entra admin center, open **App registrations → New
   registration**. Choose **Accounts in this organizational directory only**
   (single tenant) and add a **Web** redirect URI: the connection's redirect URI.
2. Under **Certificates & secrets**, add a client secret. Note its expiry (24
   months at most) in your calendar: Helpdock cannot see it.
3. Under **Token configuration**, choose **Add optional claim → ID** and add
   `email`, `xms_edov` and `acct`, then **Add groups claim**. Prefer **Groups assigned to the application**, so a
   member of many groups stays under the 200-group limit; Helpdock refuses an
   overage rather than treat it as no groups.
4. In Helpdock, choose **Start from → Microsoft Entra ID (OIDC)**, replace
   `{tenant-id}` with the **Directory (tenant) ID** from the app's overview, and
   paste the **Application (client) ID** and the secret value.
5. Under **Email domains**, enter only domains verified in **this** tenant
   (**Domain names** in the admin center), never a partner's. Helpdock trusts
   `xms_edov` only from members (`acct` 0), but a B2B user made a member, for
   example by cross-tenant synchronisation, also has `acct` 0 while its
   `xms_edov` speaks for its home tenant. Listing only this tenant's domains
   keeps such addresses out. Map group **object IDs**, not display names, in
   the role mappings.
6. Under **Enterprise applications**, set **Assignment required** and assign
   only the intended staff or groups. An assigned guest still cannot make a
   first link or get an account through this connection (see below), and
   Helpdock has no way to link an SSO identity by hand; give guests a local
   account instead, which works only while SSO is not enforced. Save, enable,
   and run **Test connection**.

**Email verification.** Entra ID tokens carry no `email_verified`. Instead,
`xms_edov: true` says the domain of the `email` is verified by the tenant that
holds the account. For a guest that is the guest's home tenant, or a personal
Microsoft, Google or one-time-passcode account, not yours. So Helpdock accepts
it in place of `email_verified` only for a member of the connection's tenant,
when all of these hold; otherwise the first sign-in is refused with
`sso-email-unverified`:

- the email claim is `email`;
- the connection's issuer is exactly
  `https://login.microsoftonline.com/<tenant GUID>/v2.0`, never `common`,
  `organizations`, `consumers` or the personal-account tenant. Only the global
  cloud qualifies: government and China cloud issuers fail closed;
- the token's `iss` is that issuer and its `tid` is that tenant GUID;
- `acct` is `0`, a member of the tenant (a guest is `1`);
- `xms_edov` is the boolean `true`.

Then the pinned tenant is the one vouching for the address. Without the
`xms_edov` and `acct` optional claims nobody new can link or be created; people
already linked still sign in.

**Upgrading with an existing Entra OIDC connection.** If its tokens already
carry `xms_edov` and `acct`, it starts linking by email, and creating accounts
when **Create accounts on first sign-in** is on, at the next sign-in after the
upgrade. Before upgrading, review its **Email domains**, its account-creation
setting and **Assignment required** in Entra.

## Okta (OIDC)

Official documentation checked **2026-10-13**:
[OIDC app creation](https://help.okta.com/en-us/Content/topics/apps/apps_app_integration_wizard_oidc.htm),
[group claims](https://developer.okta.com/docs/guides/customize-tokens-groups-claim/),
[email claim semantics](https://help.okta.com/en-us/content/topics/apps/oiw/sso-settings.htm).

Create an OIDC **Web Application**, enable authorization code and PKCE, and
register the exact Helpdock redirect URI. Use client-secret authentication
compatible with `client_secret_post`. Copy its client ID, secret and issuer into
Helpdock; retain `openid email profile`. Assign only intended staff/groups.
Configure an ID-token groups claim and use its name in Helpdock's Groups field.
Use the issuer belonging to that authorization server, not an unrelated console URL.

Okta documents `email_verified` as scope-dependent, rather than proof of mailbox
ownership. Restrict assignment to centrally managed enterprise identities whose
email attributes are controlled by your administrators; test the actual signed
claim and email policy before permitting email links. Do not hardcode verification
to true to make an unmanaged/self-service identity pass.

## Microsoft Entra ID (SAML)

Official documentation checked **2026-10-13**:
[SAML setup](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/add-application-portal-setup-sso),
[group claims and limits](https://learn.microsoft.com/en-us/entra/identity/hybrid/connect/how-to-connect-fed-group-claims).

Configure an enterprise application's SAML sign-on. Set Identifier to Helpdock's
entity ID and Reply URL to its ACS. Copy the Entra Identifier, Login URL and
signing certificate into Helpdock. Configure a stable NameID, a controlled email
attribute, and optional name/groups attributes; enter their **full emitted claim
names** in Helpdock. Require assertion signing. Assign the application to the
intended staff. Map emitted group object IDs rather than display names when using
the default group-ID representation.

Entra limits group claims to 150 groups for SAML and 200 for JWT. Prefer groups
assigned to the application to avoid overage. Helpdock refuses overage/distributed
group claims; it does not treat missing group data as an authoritative empty list
or fetch distributed claim URLs.

## Google Workspace (SAML)

Official documentation checked **2026-10-13**:
[custom SAML application setup](https://knowledge.workspace.google.com/admin/apps/set-up-your-own-custom-saml-app).

In Admin console, add a custom SAML app. Copy Google's entity ID, SSO URL and
certificate into Helpdock. Set the app ACS URL and entity ID to Helpdock's values.
Choose emailAddress NameID only with a centrally controlled primary email, or a
stable persistent identifier where available. Map controlled email/name
attributes and any required group memberships; match their names in Helpdock.
Turn the app on only for intended organizational units/groups.

Google's default signs the assertion; the Signed response option adds response
signing. Helpdock requires the assertion signature in either case. Group
membership mapping has provider selection limits; explicitly select the relevant
groups and use the test preview to confirm the emitted values.

## Keycloak (OIDC)

Official documentation checked **2026-10-13**:
[server administration guide](https://www.keycloak.org/docs/latest/server_admin/index.html).

Create an OpenID Connect client in the staff realm. Enable client authentication
and Standard flow; require PKCE S256 and register the exact Helpdock redirect URI.
Copy the Credentials secret and set issuer to `https://<host>/realms/<realm>`.
Keep `openid email profile`; add a Group Membership mapper to the ID token using
the claim name configured in Helpdock. Decide whether full group paths are emitted
and map those exact strings. Assign the client only to intended staff.

Configure realm SMTP and require **Verify Email**, then complete email verification
for the test person. Do not mark an arbitrary user-supplied address verified just
to pass a test. If enabling Helpdock's IdP-MFA flag, bind a Keycloak flow that
requires MFA for every assigned staff member and verify that policy independently.

## Rotation and troubleshooting

Add the next SAML signing certificate while retaining the current certificate,
switch signing at the provider, test, then remove the old certificate after old
assertions have expired. Keep the metadata endpoint and configured authority
consistent. Failed metadata refreshes keep the current trust and record a
sanitized warning. Disabling a connection blocks new sign-ins; linked connections
cannot be deleted. There is no SCIM or single logout in v1: IdP offboarding does
not immediately revoke Helpdock sessions. Deactivate the person in Helpdock when
immediate revocation is required.

| Error | Check |
|---|---|
| `sso-email-unverified` | Allowed domain; for OIDC, the standard `email` claim with `email_verified: true`, or for Entra ID the `xms_edov` optional claim |
| `sso-identity-conflict` | The account is already linked to another subject or connection; sign in through that identity |
| `sso-no-access` | Active brands, group values/order, default access, departments and conflicting provider ownership |
| `sso-connection-disabled` | Connection enabled; restart any pending MFA flow |
| `sso-required` | Use SSO, or the configured emergency password + fresh TOTP path |
| `sso-invalid-response` | Restart from Helpdock; compare issuer, audience, callback, certificates, time and group overage |
| `unavailable` | Provider/network availability and sanitized server logs |

All provider discovery, tokens, JWKS, metadata and user-info requests use the
SSRF-safe client. Private IdPs require a narrowly scoped operator
`OUTBOUND_ALLOW_CIDRS` exception; never broadly allow all private networks.
Callback failures do not expose assertions, secrets or untrusted provider errors.
Real Okta/Entra/Workspace acceptance needs your own test accounts; automated tests
use local stand-ins. A local Keycloak smoke test does not establish those other
providers' compatibility.

## Administrative API

Every `/api/install/sso` route requires `install:admin`; brand admin is insufficient.
Responses are Zod-serialized and contain no stored secrets.

| Method | Path under `/api/install/sso` | Purpose |
|---|---|---|
| GET / POST | `/connections` | List / create a connection |
| GET / PUT / DELETE | `/connections/:id` | Read / replace / delete unused connection |
| GET / PUT | `/connections/:id/mappings` | Read / replace mappings |
| POST | `/certificates/inspect` | Validate PEM and read public subject, SHA-256 fingerprint and expiry |
| POST | `/configurations` | Atomically create `{ connection, mappings }` |
| PUT | `/connections/:id/configuration` | Atomically replace `{ connection, mappings }` |
| GET / PUT | `/settings` | Read / atomically save enforcement and break-glass selection |
| GET | `/targets` | Active brands/departments, eligible emergency admins and public SP URLs |
| POST | `/connections/:id/test` | Start an administrator-owned preview |
| GET | `/connections/:id/test?key=…` | Consume that administrator's preview result |

The public `POST /api/auth/sso/discover { email }` returns matching enabled
connection IDs and labels, under sign-in rate limits. `GET /api/auth/methods`
includes enabled connections and `ssoEnforced`. The existing brand-scoped public
REST OpenAPI document excludes these authentication and install-admin routes.

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
contain `sub` and a valid configured email claim. Boolean `email_verified: true`
vouches only for the standard `email` claim: email linking and account creation
need the configured claim to be `email` and verified. With another claim (for
example `upn`) or an unverified address, people who are already linked by
subject still sign in, but nobody new is linked or created by email.
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
with a safe translated error; valid callbacks apply the configured MFA policy and use
a one-time session exchange code. No ID/access token appears in a redirect URL.

The fake-IdP suites need no provider credentials. For a real local Keycloak
Docker/Chromium smoke test, follow the commands in
[M11-02](../completed/M11-sso-and-migration.md#m11-02-oidc-sign-in).

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
Failures use the existing translated sign-in completion error. Local TOTP applies unless the administrator has vouched for IdP MFA.

`allowIdpInitiated` defaults to false. When enabled, an unsolicited assertion
starts a fresh SP round trip and must return the same subject. IdP dashboards
must support that Redirect request; no session is issued from the unsolicited
POST alone. Helpdock does not offer single logout.

For certificate rotation, save up to three signing certificates. If
`idpMetadataUrl` is configured, save fetches and validates its entity ID, Redirect
SSO URL and signing certificates. The worker refreshes enabled connections at
04:45 UTC. A refresh that only removes certificates is applied and recorded as
`sso.metadata.refreshed` / `signing-certificates-removed`. A refresh that lists
any certificate not already trusted, whether added beside the current ones or
replacing them all, keeps the current set and records
`sso.metadata.rotation-refused` / `admin-confirmation-required`. After verifying
the new certificate with your IdP, add it under **Signing certificates** and save:
saving is the confirmation. A save is refused with "The provider metadata lists a
signing certificate that is not saved here" until every certificate the metadata
lists has been added; certificates the metadata no longer lists are dropped on
save. Metadata errors produce `sso.metadata.refused` without raw provider errors.
Unchanged sets do not rewrite the connection.
