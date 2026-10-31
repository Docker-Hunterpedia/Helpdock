---
"@helpdock/api": minor
---

Entra ID first links (staff SSO OIDC and the Microsoft sign-in button) now also require the ID token's `idp` claim to be absent or to name the pinned tenant, so a B2B user made a member whose home tenant vouches for the domain can no longer link by email.
