---
"@helpdock/api": minor
---

SSO presets (M18-09): a new OpenID Connect connection can start from Google Workspace (OIDC) or Microsoft Entra ID (OIDC). The preset fills the issuer (or the Entra `{tenant-id}` template, which the form refuses to save unreplaced), the email, name and groups claims, and hints for the email domains, and links to its section of the SSO guide. Later edits stay; nothing about the preset is saved. Because Entra ID sends no `email_verified`, an OIDC first link now also accepts Entra's `xms_edov: true` on the `email` claim, but only when the connection's issuer names one tenant by GUID (`https://login.microsoftonline.com/<tenant>/v2.0`, never `common`, `organizations`, `consumers` or the personal-account tenant) and the token's `iss` and `tid` match it. **Note for operators:** an Entra app registration used for OIDC must add the `email` and `xms_edov` optional claims under Token configuration.
