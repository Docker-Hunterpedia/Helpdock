---
"@helpdock/api": minor
---

SSO presets (M18-09): a new OpenID Connect connection can start from Google Workspace (OIDC) or Microsoft Entra ID (OIDC). The preset fills the issuer (or the Entra `{tenant-id}` template, which the form refuses to save unreplaced), the email, name and groups claims, and hints for the email domains, and links to its section of the SSO guide. Later edits stay; nothing about the preset is saved, and the protocol is unchanged. The break-glass copy on Settings › Single sign-on now names an authenticator app or a passkey; break-glass itself still takes TOTP until passkeys land. **Note:** Entra ID tokens carry no `email_verified`, so an Entra OIDC connection cannot link or create accounts yet; connect Entra over SAML instead (see the SSO guide).
