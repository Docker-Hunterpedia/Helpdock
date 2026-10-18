---
"@helpdock/api": patch
---

SSO: email linking no longer hands an account that already has an SSO identity to a different subject or connection (`sso-identity-conflict`), and each account has at most one identity per connection. Enabled connections can no longer share an email domain, OIDC `email_verified` only vouches for the standard `email` claim, and a SAML metadata refresh never trusts an added signing certificate until an administrator saves it.
