---
"@helpdock/api": minor
---

A single-use recovery code can now finish a sign-in that began with an SSO assertion while SSO enforcement is on (#387). It was refused before, which locked out an SSO user whose IdP does not vouch for MFA and who lost the phone their authenticator was on. Break-glass (a password first factor) still never takes a recovery code, and trusted browsers stay refused after SSO.
