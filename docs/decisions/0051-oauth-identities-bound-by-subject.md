# 0051 OAuth sign-in identities bound by subject, and Microsoft as a third provider

Status: accepted
Date: 2026-10-20

Accepted with the 1.0.1 security fix, which implements the binding for Google
and GitHub (see "Implementation" below). The Microsoft provider, the
allow-lists, passkey step-up and invitation binding are still to be built in
M18 (M18-07, M18-08).

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

## Implementation (2026-10-20, 1.0.1)

Decisions 1, 2 and 6 for Google and GitHub, and decision 3 except the passkey,
the invitation and the security page control:

- `user_oauth_identities` (migration `0056_oauth_identities`): `provider`
  (`google` | `github`), `provider_subject`, `user_id`, `email_at_link`,
  `created_at`; unique `(provider, provider_subject)` and `(user_id, provider)`.
  It has no `issuer` column: each of the two providers has one fixed issuer, so
  the provider names it. Microsoft adds one with its tenant.
- `api/auth/oauth/oauth-linking.ts` decides: the subject first, then a first
  link only for an authoritative address and an account with no identity of
  that provider (`oauth-identity-conflict` otherwise), and
  `oauth-link-required` for every non-authoritative address, held or not.
  GitHub's subject is its numeric user id; it is never authoritative.
- Connect and disconnect are `POST /api/auth/oauth/:provider/connect` and
  `…/disconnect`, behind the current password or a live code and the step-up
  rate limit; the connect flow's state carries the account id. Each writes
  `auth.oauth.linked` / `.unlinked` (`.link_refused` on a conflict) and a
  `securityChange` email through the outbox. A first link at sign-in is audited
  and emailed the same way.
- The second-factor check after OAuth is unchanged.

Left for M18: Microsoft (decision 5), the allow-lists (decision 4), a passkey
as step-up, binding at invitation acceptance (the invitation form has no
provider option yet), and the Security › Sign-in methods control, which needs
its artboard first.
