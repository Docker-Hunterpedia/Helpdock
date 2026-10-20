---
"@helpdock/api": minor
---

Microsoft sign-in for one organisation's work accounts (M18-08): a third built-in provider next to Google and GitHub, set up under Settings > Authentication or with `HD_OAUTH_MICROSOFT_TENANT_ID`, `HD_OAUTH_MICROSOFT_CLIENT_ID` and `HD_OAUTH_MICROSOFT_CLIENT_SECRET`. Tokens are held to the one tenant (exact issuer and `tid`), accounts are bound by tenant and object id, and an address makes a first link only for a member whose email domain Microsoft has verified (`xms_edov`); anyone else connects Microsoft from the security page. Personal Microsoft accounts can be allowed with `oauth.microsoft.allowConsumers` (off by default, connect-only). Changing the tenant leaves the old Microsoft connections unable to sign in; each person's is replaced when they connect Microsoft again.
