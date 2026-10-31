# Sign-in providers

Step-by-step setup of the three "Sign in with" buttons staff see on the login screen: Google, Microsoft and GitHub. Every self-hosted install needs its own OAuth app at each provider, because the app's redirect URL is your address. For what the buttons do once they work (which account a provider signs in as, first links, connecting and disconnecting) read [authentication](authentication.md#oauth); for an organisation's whole directory over OIDC or SAML, with groups and enforcement, use [single sign-on](sso.md) instead.

## Before you start

- You are an install admin. The fields live under **Settings → Install → Authentication** (`/settings/install/authentication`), and every value can instead be pinned with an `HD_*` environment variable, which the page then marks **Set by environment**.
- `APP_URL` is final. The redirect URL you give a provider is built from the origin of it (any path in `APP_URL` is dropped), and a provider refuses a callback whose address it was not told. The page shows the exact URLs in its **Redirect URLs** aside, each with a **Copy** button.
- A button never creates an account. People are invited first ([staff and roles](staff-and-roles.md#inviting-somebody)); a provider only signs in somebody who already has an account here.
- A provider with no client id is reported as disabled and its button is not drawn. Microsoft also needs its tenant id and client secret. For Google and GitHub the button is drawn on the client id alone, so a missing or wrong secret shows only after the consent screen (see [When it does not work](#when-it-does-not-work); [#428](https://github.com/Docker-Hunterpedia/Helpdock/issues/428) tracks drawing the button only with a secret). The buttons are also not drawn while SSO is enforced.
- Client secrets are write-only: after saving, the page shows only that one is saved, and **Replace** opens an empty field.

The redirect URL for each provider is `<APP_URL>/api/auth/oauth/<provider>/callback`:

| Provider | Redirect URL |
|---|---|
| Google | `https://support.example.com/api/auth/oauth/google/callback` |
| Microsoft | `https://support.example.com/api/auth/oauth/microsoft/callback` |
| GitHub | `https://support.example.com/api/auth/oauth/github/callback` |

| Setting | Environment variable | Secret |
|---|---|---|
| `oauth.google.clientId` / `clientSecret` | `HD_OAUTH_GOOGLE_CLIENT_ID` / `HD_OAUTH_GOOGLE_CLIENT_SECRET` | secret |
| `oauth.google.allowedDomains` | `HD_OAUTH_GOOGLE_ALLOWED_DOMAINS` (JSON array) | |
| `oauth.microsoft.tenantId` | `HD_OAUTH_MICROSOFT_TENANT_ID` | |
| `oauth.microsoft.allowConsumers` | `HD_OAUTH_MICROSOFT_ALLOW_CONSUMERS` | |
| `oauth.microsoft.clientId` / `clientSecret` | `HD_OAUTH_MICROSOFT_CLIENT_ID` / `HD_OAUTH_MICROSOFT_CLIENT_SECRET` | secret |
| `oauth.github.clientId` / `clientSecret` | `HD_OAUTH_GITHUB_CLIENT_ID` / `HD_OAUTH_GITHUB_CLIENT_SECRET` | secret |

The full reference, with defaults, is [configuration](configuration.md).

## Google

1. In the [Google Cloud console](https://console.cloud.google.com/), pick or create a project, then open **Google Auth Platform**.
2. Under **Audience**, choose the user type:
   - **Internal** for an install that only Google Workspace staff of one organisation use. It needs no verification, and Google refuses everyone outside the organisation.
   - **External** when staff use addresses from several organisations or `@gmail.com`. Press **Publish app**: while the app is in *Testing*, only the listed test users can sign in.
3. Scopes (**Data Access**): Helpdock asks for `openid email profile`. They are non-sensitive, so nothing needs Google's verification review.
4. Under **Clients → Create client**, choose the application type **Web application**. Under **Authorized redirect URIs** add the Google URL from the table above, exactly.
5. In Helpdock, paste the **Client ID** and **Client secret** into the Google OAuth fields and save.
6. Optional, for a Workspace-only install: under **Allowed Workspace domains** type each domain and press Enter (at most 20). Helpdock then admits only managed Workspace accounts whose `hd` claim is one of them, on every sign-in, so an `@gmail.com` account is refused (`oauth-domain-not-allowed`). Leave it empty to allow every Google account the first-link rules allow ([which account a provider signs in as](authentication.md#which-account-a-provider-signs-in-as)).

Check it: sign out, press **Sign in with Google** with an invited person's Workspace account. A first sign-in links that Google account to the staff account; from then on the button signs that Google account in whatever address Google reports.

## Microsoft

This is for the work accounts of one Microsoft Entra ID tenant.

1. In the [Entra admin center](https://entra.microsoft.com/) open **Entra ID → App registrations → New registration**.
2. Name it, and choose **Accounts in this organizational directory only** (single tenant).
3. Under **Redirect URI** choose platform **Web** and enter the Microsoft URL from the table above.
4. Register, then on the **Overview** page copy the **Application (client) ID** and the **Directory (tenant) ID**. The tenant id is a GUID; `common`, `organizations` and `consumers` are refused.
5. Open **Certificates & secrets → New client secret**. Copy the secret **Value** at once, not its Secret ID: Entra shows the value only on creation. A secret lasts 24 months at most, and Helpdock cannot see the expiry, so put the date in your calendar. When it expires the Microsoft button starts failing; create a new secret, then **Replace** it in Helpdock.
6. Optional, for first links by address: under **Token configuration → Add optional claim → ID** add `email`, `xms_edov` and `acct`. Without them nobody links by address; each person connects Microsoft once from **Your account → Security** instead, which works the same afterwards.
7. In Helpdock, enter **Directory (tenant) ID**, **Application (client) ID** and **Client secret value**, and save.

**Also allow personal Microsoft accounts** is off by default. Turn it on only if staff sign in with Outlook.com or Hotmail addresses. Those accounts can only be connected from **Your account → Security**, never linked by address, and turning it on breaks B2B guests of your tenant. The app registration must then accept "organizational directories and personal Microsoft accounts". Read [Microsoft](authentication.md#microsoft) first.

A token from any other tenant answers `oauth-tenant-mismatch`.

Entra can also be connected as an SSO connection (OIDC preset, with groups and enforcement): see [Microsoft Entra ID (OIDC preset)](sso.md#microsoft-entra-id-oidc-preset). The two do not depend on each other, and they use different app registrations.

## GitHub

1. On GitHub open **Settings → Developer settings → OAuth Apps → New OAuth App** (for an organisation, the organisation's own Settings). Use an **OAuth App**, not a **GitHub App**.
2. Give it a name and your `APP_URL` as the **Homepage URL**. Set **Authorization callback URL** to the GitHub URL from the table above.
3. Register, then copy the **Client ID**. Press **Generate a new client secret** and copy it at once.
4. In Helpdock, paste both into the GitHub OAuth fields and save.

Helpdock asks for `read:user user:email`, to learn which verified address is signing in. GitHub never links by address: everybody connects GitHub once from **Your account → Security → Sign-in methods**, after which the button signs them in. GitHub has no allowed-domains list, and no restriction to an organisation (that would need the `read:org` scope; it is not built).

## When it does not work

| What you see | Cause |
|---|---|
| The button is missing | The client id is empty (for Microsoft also the tenant id or client secret), or SSO enforcement is on, which draws no provider buttons. |
| After the consent screen: "That account cannot sign in here. Ask an administrator to invite you." | For Google and GitHub, usually a missing or wrong client secret, because the token exchange fails after the button was drawn. Re-enter the secret. It is also what a person without an account sees. |
| The provider says the redirect URI does not match | The URL registered there differs from the one in the aside, usually `http` against `https`, a trailing slash, or an old `APP_URL`. |
| "Connect your Google account first" (`oauth-link-required`, named for the provider) | The provider account has not been linked. Sign in with a password or a sign-in link and press **Connect** on the security page. |
| "This Google account can't sign in here" (`oauth-domain-not-allowed`) | The account's Workspace domain is not in **Allowed Workspace domains**. |
| "This Microsoft account can't sign in here" (`oauth-tenant-mismatch`) | The token comes from another tenant than the one configured. |
| Everyone on Microsoft sees "That account cannot sign in here" | The client secret has expired. Create a new one in Entra and **Replace** it. |

Refusals of a recognised provider account (domain not allowed, tenant mismatch, not linked) are written to the audit trail ([audit log](audit-log.md)); other failures (an expired state, a provider not configured, a failed token exchange, a declined consent, `sso-required`) appear only in the api log. Under SSO enforcement the buttons are gone: staff use the SSO button, or a break-glass account ([sso](sso.md#roles-mfa-and-enforcement)); a direct start answers "Use single sign-on to continue." Rate limits for the sign-in routes are in [authentication](authentication.md#rate-limits).
