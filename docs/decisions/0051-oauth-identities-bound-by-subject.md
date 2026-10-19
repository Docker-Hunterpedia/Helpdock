# 0051 OAuth sign-in identities bound by subject, and Microsoft as a third provider

Status: proposed
Date: 2026-10-20

Being implemented ahead of M18 as a 1.0.1 security fix (separate pull request);
this record stays proposed until accepted with that fix or with M18.

## Context

The Google and GitHub sign-in buttons (M0-05) match a provider's verified email
to an existing account on every sign-in; no identity link is stored. That is
the class of weakness #219 fixed for SSO, and it is wider here:

- GitHub keeps an address "verified" after its owner loses the mailbox, and a
  consumer Google account can be registered on a non-Gmail address that was
  verified once. Either can later sign in as whoever holds that address in
  Helpdock.
- If the provider account behind an address changes, the new account signs in
  silently.
- Google's `hd` claim is not checked, so sign-in cannot be limited to a
  Workspace domain.
- Microsoft, if added naively, has the nOAuth problem: in multi-tenant Entra
  apps the `email` claim is admin-editable and unverified.

Teams also ask for a Microsoft button beside Google and GitHub. Entra ID as an
organisation is already an SSO connection (M11).

Planned in [M18 Sign-in options](../in-development/M18-sign-in-options.md)
(M18-07, M18-08).

## Decision

1. **Bind by `(provider, issuer, subject)`** in a new install-scope table
   `user_oauth_identities` (`GLOBAL_TABLES`), one identity per provider per
   account. A bound identity signs in whatever its email currently says.
2. **Email is used once, for a first link,** only when the account has no
   identity for that provider, the provider says the email is verified, and the
   provider is authoritative for the address:
   - Google: `email_verified` and either `hd` equals the email's domain or the
     address is `@gmail.com` / `@googlemail.com`;
   - Microsoft: the pinned tenant and `xms_edov`, or a personal account in the
     consumers tenant if consumers are allowed;
   - GitHub: never; a GitHub identity links only from inside a session or while
     accepting an invitation.
   Otherwise the callback answers `oauth-link-required`, which does not say
   whether an account exists.
3. **Connecting and disconnecting** from the security page needs a step-up
   (password, TOTP or passkey), writes an audit row and emails the holder.
   Invitation acceptance with a provider binds that identity. Buttons never
   create accounts.
4. **Allow-lists:** `oauth.google.allowedDomains` (`hd` values); Microsoft is
   single-tenant with a required `oauth.microsoft.tenantId`; `common` and
   `organizations` are refused.
5. **Microsoft** is a third built-in provider through `openid-client` 6.x
   (already in the stack for SSO) with `customFetch` bound to `safeFetch`,
   exact issuer, `tid` check, PKCE, `nonce`, `state` and the `hd_oauth` cookie.
   The subject is `oid` with `tid`. Google and GitHub stay hand-wired.
6. **Migration:** 1.0 users who sign in with Google by email are bound at their
   first sign-in after the upgrade when Google is authoritative; GitHub users
   re-link once from the security page.

## Consequences

- The stale-email and recycled-address takeovers close; a provider account
  takeover still signs in as its linked user, so the local second factor
  remains the control.
- GitHub users see `oauth-link-required` once; the release notes say so.
- DESIGN.md §5 gains a monochrome Microsoft provider mark.
- Operators register their own OAuth app per provider; a guide walks through
  each.

## Alternatives considered

- **Keep email matching:** leaves the takeover open.
- **Fold the buttons into SSO connections:** GitHub is not OIDC, and small teams
  would get JIT semantics they do not want.
- **Multi-tenant Microsoft:** reopens the templated-issuer and nOAuth questions.
